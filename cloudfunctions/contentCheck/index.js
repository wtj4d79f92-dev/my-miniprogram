// 旷行吖 · 内容安全异步检测结果回调
//
// mediaCheckAsync（图片审核）是异步接口：发起时只拿到 trace_id，
// 判定结果由微信通过「消息推送」回调到这里。所以这个云函数必须在
// mp 后台 → 开发管理 → 消息推送里配置为接收方（云开发消息推送），否则图片检测永远没有结论。
//
// 消息推送全小程序只能配一个接收方：以后要接客服消息等其他事件，
// 在这里按 MsgType / Event 分发即可，不要再另配一个接收地址。
//
// 返回约定：必须返回 { errcode: 0 }，否则微信会认为失败并重复推送。
const cloud = require('wx-server-sdk')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

const db = cloud.database()

const activities = db.collection('activities')
const auditLogs = db.collection('activity_audits')

const PENDING = 'pending'
const APPROVED = 'approved'
const REJECTED = 'rejected'
const PASS = 'pass'
const REVIEW = 'review'
const RISKY = 'risky'

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

function suggestOf(event) {
  const result = event.result || {}
  if (result.suggest === RISKY || result.suggest === REVIEW || result.suggest === PASS) return result.suggest
  // 旧版推送只有 isrisky 字段
  return Number(event.isrisky) === 1 ? RISKY : PASS
}

/** 按 trace_id 找活动：一个 trace_id 只对应一次图片检测 */
async function findActivityByTrace(traceId) {
  const res = await activities.where({ 'machineCheck.images.traceId': traceId }).limit(1).get()
  return (res.data && res.data[0]) || null
}

/**
 * 写入检测结论。
 * 用事务包住「读 - 算 - 写」，避免两张图的回调几乎同时到达时互相覆盖 images 数组。
 */
async function applyResult(activityId, traceId, suggest, label) {
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
    const images = (machine.images || []).map((item) =>
      item.traceId === traceId ? Object.assign({}, item, { suggest, label, time: Date.now() }) : item
    )
    const text = machine.text || {}
    const patch = {
      machineCheck: Object.assign({}, machine, { images }),
      machineReview: text.suggest === REVIEW || images.some((item) => item.suggest === REVIEW),
      machinePending: images.some((item) => item.suggest === PENDING),
    }

    // 违规图片：活动无论处于什么状态都不能继续展示，直接驳回（审核中就是打回，已上线就是下架）
    const wasRejected = doc.auditStatus === REJECTED
    if (suggest === RISKY && !wasRejected) {
      patch.auditStatus = REJECTED
      patch.auditRemark = REJECT_REMARK
      patch.auditTime = Date.now()
      patch.auditBy = '内容安全检测'
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

  try {
    const target = await findActivityByTrace(traceId)
    // 活动已删除或结论过期：确认收到即可，不需要重试
    if (!target) return ack()

    const updated = await applyResult(target._id, traceId, suggest, label)
    if (!updated) return ack()

    await writeLog({
      activityId: target._id,
      title: updated.title || '',
      action: suggest === RISKY ? 'image-risky' : suggest === REVIEW ? 'image-review' : 'image-pass',
      from: target.auditStatus || '',
      to: updated.auditStatus || '',
      remark: suggest === RISKY ? `${REJECT_REMARK}（label=${label}）` : `图片检测结果：${suggest}`,
      adminOpenid: '',
      adminName: '内容安全检测',
    })
  } catch (e) {
    console.error('[contentCheck] 处理图片检测结果失败', e)
  }

  // 无论处理成功与否都要确认，避免微信反复重推
  return ack()
}
