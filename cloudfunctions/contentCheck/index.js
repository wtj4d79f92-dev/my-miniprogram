// 旷行吖 · 内容安全异步检测结果回调
//
// mediaCheckAsync（图片审核）是异步接口：发起时只拿到 trace_id，
// 判定结果由微信通过「消息推送」回调到这里。所以这个云函数必须在
// mp 后台 → 开发管理 → 消息推送里配置为接收方（云开发消息推送），否则图片检测永远没有结论。
//
// 消息推送全小程序只能配一个接收方：以后要接客服消息等其他事件，
// 在这里按 MsgType / Event 分发即可，不要再另配一个接收地址。
//
// 除了写回图片结论，这里还负责：
// - 推送里没有结论（带错误码 / 没有 result）时记成「没结论」交给人工，绝不写成 pass；
// - 图片结论都回来、而文本在发布当刻没拿到结论时补检一次文本（见 recheckText），
//   否则「发布当刻一次超时」会让活动永远停在待审队列，而审核台上文本那行还写着「机器通过」。
//
// 返回约定：必须返回 { errcode: 0 }，否则微信会认为失败并重复推送。
const cloud = require('wx-server-sdk')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

const db = cloud.database()

const { AUTO_AUDIT_BY, checkableImageCount, canAutoApprove } = require('./lib/autoAudit')
// 文本补检用的是与发布当刻同一套检测：这份 textCheck 与 activity 云函数的副本保持一字不差
const { textOf, checkText } = require('./lib/textCheck')

const activities = db.collection('activities')
const auditLogs = db.collection('activity_audits')

// 审核状态与图片的「结论未回」用的是同一组字面值：pending 都表示「还没有结论」
const PENDING = 'pending'
const APPROVED = 'approved'
const REJECTED = 'rejected'
const PASS = 'pass'
const REVIEW = 'review'
const RISKY = 'risky'
/**
 * 图片检测「没有结论」：推送里带错误码，或压根没带结果字段。
 * 它既不是通过也不是违规，所以单独记一个结论值 —— 活动留在待审队列交给人工，
 * 审核台上显示「未出结论（转人工）」。以前这里会当成 pass，
 * 于是审核台看着「机审全绿」，活动却卡在待审队列，运营根本看不出为什么没放行。
 */
const NO_CONCLUSION = 'failed'

/** 图片违规导致的下架原因，发起人会在「我的发布」里看到 */
const REJECT_REMARK = '图片经内容安全检测判定违规，活动已下架'

function ack() {
  return { errcode: 0, errmsg: 'ok' }
}

async function writeLog(data) {
  try {
    await auditLogs.add({ data: Object.assign({ createTime: Date.now() }, data) })
  } catch (e) {
    console.error('[contentCheck] 审核日志写入失败', e)
  }
}

/** 消息推送里可能缺少 Event（不同接入方式的字段略有差异），有 trace_id 就按检测结果处理 */
function isMediaCheckEvent(event) {
  if (event.Event === 'wxa_media_check') return true
  return !event.Event && !!(event.trace_id || event.traceId)
}

/**
 * 推送里的图片检测结论。
 * - result.suggest 有值：直接用（v2 推送）；
 * - 只有 isrisky 字段：旧版推送，带了这个字段才认它是结论；
 * - 其余（带 errcode、字段缺失）都是「没有结论」：既不放行也不驳回，留给人工。
 */
function suggestOf(event) {
  const result = event.result || {}
  if (result.suggest === RISKY || result.suggest === REVIEW || result.suggest === PASS) return result.suggest
  if (event.isrisky !== undefined && event.isrisky !== null && event.isrisky !== '') {
    return Number(event.isrisky) === 1 ? RISKY : PASS
  }
  return NO_CONCLUSION
}

/** 「没有结论」的原因：把推送里的错误码带进审核日志，方便排查接口问题 */
function noConclusionMessage(event) {
  const errcode = Number(event.errcode)
  if (Number.isFinite(errcode) && errcode !== 0) {
    return `图片检测接口没有返回结论（errcode=${errcode}），已转人工审核`
  }
  return '图片检测没有返回结论，已转人工审核'
}

/** 自动放行的日志说明：文本是补检出来的要写清楚，运营才知道这条为什么不是发布当刻放行的 */
function autoApproveRemark(freshText) {
  return freshText && freshText.failed === false
    ? '机审通过（文本补检通过、图片与二维码识别均无异常），自动放行'
    : '机审通过（文本、图片与二维码识别均无异常），自动放行'
}

/** 按 trace_id 找活动：一个 trace_id 只对应一次图片检测 */
async function findActivityByTrace(traceId) {
  const res = await activities.where({ 'machineCheck.images.traceId': traceId }).limit(1).get()
  return (res.data && res.data[0]) || null
}

/**
 * 图片结论都回来、而文本当时没拿到可信结论时，补检一次文本。
 *
 * 发布当刻的文本检测是同步的：接口超时 / 异常只会留下 text.failed = true，
 * 这一条会让活动永远停在待审队列，而审核台上文本那行还写着「机器通过」——
 * 运营看到的「机审全绿却没自动放行」多半就是这里。
 * 图片结论回来时补检一次：拿到结论就写回活动（机审全过照常自动放行），
 * 仍然没结论就照旧交给人工，不做任何「当成通过」的妥协。
 *
 * @returns {Promise<Object|null>} 补检结论；不需要补检或补检失败时返回 null
 */
async function recheckText(doc, traceId, suggest) {
  if (doc.auditStatus !== PENDING) return null
  const machine = doc.machineCheck || {}
  // 只有「文本没有可信结论」才补检：正常拿到结论的发布不需要多打一次接口
  if (!machine.text || machine.text.failed !== true) return null
  // 还有图片没出结论时先不补检，等最后一张图的推送，避免每条推送都送检一次
  const images = (machine.images || []).map((item) =>
    item.traceId === traceId ? Object.assign({}, item, { suggest }) : item
  )
  const imagesDone = images.length > 0 && images.every((item) => item.suggest && item.suggest !== PENDING)
  if (!imagesDone) return null
  const content = textOf(doc)
  if (!content) return null
  try {
    return await checkText(content, (doc.organizer && doc.organizer.openid) || '')
  } catch (e) {
    console.error('[contentCheck] 文本补检失败，仍按人工审核处理', e)
    return null
  }
}

/**
 * 写入检测结论。
 * 用事务包住「读 - 算 - 写」，避免两张图的回调几乎同时到达时互相覆盖 images 数组。
 * freshText 是文本补检结果（没有补检时为 null），有值时一并写回，机审判定用补检后的结论。
 */
async function applyResult(activityId, traceId, suggest, label, message, freshText) {
  return db.runTransaction(async (transaction) => {
    let doc = null
    try {
      const res = await transaction.collection('activities').doc(activityId).get()
      doc = (res && res.data) || null
    } catch (e) {
      doc = null
    }
    if (!doc) return null

    const machine = doc.machineCheck || {}
    // 该送检的图片数量按文档里的封面 / 二维码算：送检时跳过的图不会被记进 images，
    // 只比对 images 自己的长度会把「有图没送出去」误判成机审通过
    const checkable = checkableImageCount([doc.cover, doc.groupQrCode])
    const images = (machine.images || []).map((item) =>
      item.traceId === traceId
        ? Object.assign({}, item, { suggest, label, time: Date.now(), message: message || '' })
        : item
    )
    const machineCheck = Object.assign({}, machine, { images })
    if (freshText) machineCheck.text = freshText
    const text = machineCheck.text || {}
    const patch = {
      machineCheck,
      machineReview: text.suggest === REVIEW || images.some((item) => item.suggest === REVIEW),
      machinePending: images.some((item) => item.suggest === PENDING),
    }

    const wasRejected = doc.auditStatus === REJECTED
    if (suggest === RISKY && !wasRejected) {
      // 违规图片：活动无论处于什么状态都不能继续展示，直接驳回（审核中就是打回，已上线就是下架）
      patch.auditStatus = REJECTED
      patch.auditRemark = REJECT_REMARK
      patch.auditTime = Date.now()
      patch.auditBy = AUTO_AUDIT_BY
    } else if (doc.auditStatus === PENDING && canAutoApprove(patch.machineCheck, checkable)) {
      // 机审全部通过：不用等人工，直接放行（每张图的结论都回来了才可能走到这里）
      patch.auditStatus = APPROVED
      patch.auditRemark = ''
      patch.auditTime = Date.now()
      patch.auditBy = AUTO_AUDIT_BY
    }

    await transaction.collection('activities').doc(activityId).update({ data: patch })
    return Object.assign({}, doc, patch, { _id: activityId, wasApproved: doc.auditStatus === APPROVED })
  })
}

exports.main = async (event) => {
  const payload = event || {}
  if (!isMediaCheckEvent(payload)) return ack()

  const traceId = payload.trace_id || payload.traceId || ''
  if (!traceId) return ack()

  const suggest = suggestOf(payload)
  const label = Number((payload.result && payload.result.label) || payload.label || 0)
  const message = suggest === NO_CONCLUSION ? noConclusionMessage(payload) : ''

  try {
    const target = await findActivityByTrace(traceId)
    // 活动已删除或结论过期：确认收到即可，不需要重试
    if (!target) return ack()

    // 文本检测在发布当刻超时 / 接口异常时只有「没有结论」的标记，活动会一直停在待审，
    // 而审核台上文本那行看起来还是「机器通过」——图片结论回来了，就借这次回调补检一次文本。
    // 补检在事务外做，接口调用不占着数据库事务。
    const freshText = await recheckText(target, traceId, suggest)

    const updated = await applyResult(target._id, traceId, suggest, label, message, freshText)
    if (!updated) return ack()

    // 自动放行是一种「没有人工参与」的审核结论，单独记一种动作，运营在日志里能一眼看出区别
    const autoApproved = updated.auditStatus === APPROVED && target.auditStatus !== APPROVED
    await writeLog({
      activityId: target._id,
      title: updated.title || '',
      action: autoApproved
        ? 'auto-approve'
        : suggest === RISKY
          ? 'image-risky'
          : suggest === REVIEW
            ? 'image-review'
            : suggest === NO_CONCLUSION
              ? 'image-failed'
              : 'image-pass',
      from: target.auditStatus || '',
      to: updated.auditStatus || '',
      remark: autoApproved
        ? autoApproveRemark(freshText)
        : suggest === RISKY
          ? `${REJECT_REMARK}（label=${label}）`
          : suggest === NO_CONCLUSION
            ? message
            : `图片检测结果：${suggest}`,
      adminOpenid: '',
      adminName: AUTO_AUDIT_BY,
    })
    // 补检也没拿到结论：留一条日志，运营排查「明明机审全绿却没放行」时有据可查
    if (freshText && freshText.failed === true) {
      await writeLog({
        activityId: target._id,
        title: updated.title || '',
        action: 'text-recheck',
        from: target.auditStatus || '',
        to: updated.auditStatus || '',
        remark: '文本检测补检仍未拿到结论（检测接口异常），继续人工审核',
        adminOpenid: '',
        adminName: AUTO_AUDIT_BY,
      })
    }
  } catch (e) {
    console.error('[contentCheck] 处理图片检测结果失败', e)
  }

  // 无论处理成功与否都要确认，避免微信反复重推
  return ack()
}
