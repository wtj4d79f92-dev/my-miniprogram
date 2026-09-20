// 机审三类检测：文本走同步的 msgSecCheck，图片走异步的 mediaCheckAsync，活动二维码走同步的二维码识别
//
// 设计原则：检测接口本身出错（未开通 / 超额度 / 用户 openid 不满足条件 / 网络抖动）时
// 一律降级为「纯人工审核」，绝不能让内容安全把用户发布卡死；
// 二维码同理：识别不出码、识别到的不是微信二维码、识别接口异常，都不算机审通过。
// 图片检测只有 traceId，最终结论由消息推送回调（cloudfunctions/contentCheck）补写。
const cloud = require('wx-server-sdk')

// 文本检测与检测步骤的时间预算工具放在 lib/textCheck.js：那份文件同时是
// cloudfunctions/contentCheck 云函数的镜像副本，图片结论回来时会用它补检文本。
const { SCENE, PASS, REVIEW, RISKY, now, withBudget, checkText } = require('./textCheck')

/** mediaCheckAsync 媒体类型：1 音频 / 2 图片 */
const MEDIA_IMAGE = 2

/** 图片检测已发起、结果未回 */
const PENDING = 'pending'

/**
 * 活动二维码识别结论：
 * ok 识别到微信二维码 / not-qrcode 没识别到码 / not-wechat 不是微信二维码 / failed 没结论。
 */
const QR_OK = 'ok'
const QR_NOT_QRCODE = 'not-qrcode'
const QR_NOT_WECHAT = 'not-wechat'
const QR_FAILED = 'failed'
/** 识别到的不是微信二维码时的驳回原因：发起人在详情页与「我的发布」里都会看到 */
const QR_REJECT_REMARK = '活动二维码上传有误，请重新上传微信群二维码或个人微信二维码'

/**
 * 允许上传的两类微信二维码，按扫码解出的链接前缀区分：
 * - group 微信群邀请码：https://weixin.qq.com/g/xxxxx
 * - personal 个人微信二维码（加好友名片码）：https://u.wechat.com/xxxxx，
 *   旧版微信导出的个人码是 https://weixin.qq.com/r/xxxxx
 *
 * 其余一律判为「不是微信二维码」：收款码（wxp://）、企业微信 / QQ 群码、商品码、普通网页码等。
 * 数组顺序即优先级：一张图里同时有群码与个人名片码时按群码算，避免发起人想拉群却把名片码当结果。
 */
const QR_KINDS = [
  { kind: 'group', name: '微信群邀请码', pattern: /^https?:\/\/weixin\.qq\.com\/g\/\S+/i },
  {
    kind: 'personal',
    name: '个人微信二维码',
    pattern: /^https?:\/\/(?:u\.wechat\.com|weixin\.qq\.com\/r)\/\S+/i,
  },
]
/** 识别到的码内容只留一段用于审核台核对，不整条存库 */
const QR_CONTENT_LIMIT = 200

/**
 * 二维码识别结论明确「这张图不是微信二维码」时才直接驳回：
 * - not-qrcode：图里没识别到任何码（风景照、糊到认不出的截图等）；
 * - not-wechat：识别到了码，但既不是群邀请码也不是个人微信二维码（收款码、企业微信 / QQ 群码等）。
 *
 * 识别接口异常 / 超时（failed）拿不到结论，不能据此驳回用户，仍留在待审队列交给人工。
 * 判定逻辑与前端 services/api.js 的 mockQrReject 保持一致。
 */
function isQrRejected(qrcode) {
  const status = (qrcode && qrcode.status) || ''
  return status === QR_NOT_QRCODE || status === QR_NOT_WECHAT
}

/**
 * 在一批识别结果里找第一个微信二维码，并带上它是哪一类。
 * 不按识别结果的先后、而按 QR_KINDS 的优先级找：群码优先于个人名片码。
 */
function findWechatCode(codes) {
  const list = codes || []
  const datas = list.map((item) => String((item && item.data) || ''))
  for (let i = 0; i < QR_KINDS.length; i += 1) {
    const entry = QR_KINDS[i]
    const index = datas.map((data) => entry.pattern.test(data)).indexOf(true)
    if (index > -1) return { kind: entry.kind, name: entry.name, code: list[index] }
  }
  return null
}

/**
 * 图片 / 二维码检测的时间预算。
 * 云函数本身也有超时（控制台里配的秒数），内容安全接口变慢时不能拖着用户发布失败，
 * 超过预算就按「降级为人工审核」处理。文本检测的预算在 lib/textCheck.js 里。
 */
const IMAGE_BUDGET_MS = 1200
const QR_BUDGET_MS = 1500

/** 取云存储文件的临时可访问地址：mediaCheckAsync 只接受 http(s) 链接，不接受 cloud:// */
async function tempUrlOf(fileID) {
  const res = await cloud.getTempFileURL({ fileList: [fileID] })
  const first = ((res && res.fileList) || [])[0] || {}
  return first.tempFileURL || first.tempFileUrl || first.download_url || ''
}

/**
 * 图片检测（异步发起）。
 * 串行发起，避免一次发布把接口并发打满；单张失败只跳过这张，不影响发布。
 * @returns [{ fileID, traceId, suggest: 'pending', label, time }]
 */
async function dispatchImages(fileIDs, openid) {
  const targets = (fileIDs || []).filter(
    (item) => typeof item === 'string' && item.indexOf('cloud://') === 0
  )
  if (!targets.length) return []
  return withBudget(() => dispatchEach(targets, openid), IMAGE_BUDGET_MS, () => [])
}

async function dispatchEach(targets, openid) {
  const results = []
  for (let i = 0; i < targets.length; i += 1) {
    try {
      const mediaUrl = await tempUrlOf(targets[i])
      if (!mediaUrl) continue
      const res = await cloud.openapi.security.mediaCheckAsync({
        mediaUrl,
        mediaType: MEDIA_IMAGE,
        version: 2,
        scene: SCENE,
        openid,
      })
      const traceId = (res && (res.traceId || res.trace_id)) || ''
      if (!traceId) continue
      results.push({ fileID: targets[i], traceId, suggest: PENDING, label: 0, time: now() })
    } catch (e) {
      console.error('[contentCheck] 图片检测发起失败，该图转为人工审核', e)
    }
  }
  return results
}

/**
 * 活动二维码识别（同步）。
 *
 * 机审自动放行以后，随手传一张风景照当二维码也会被直接放上线，报名的人拿到一张没用的图，
 * 所以这里把二维码内容解出来，只认两类微信二维码（见 QR_KINDS）：
 * 微信群邀请码（https://weixin.qq.com/g/xxxxx）与个人微信二维码（https://u.wechat.com/xxxxx）。
 *
 * 判定结果写进 machineCheck.qrcode，并作为自动放行的必要条件；以下情况一律不算机审通过：
 * 没识别到码、识别到的码内容不是微信二维码、临时链接取不到、识别接口报错或超时。
 * 其中「没识别到码」「识别到的不是微信二维码」这两种有明确结论的，调用方（cloudfunctions/activity）
 * 会直接驳回发布（见 isQrRejected）；拿不到结论的异常情况留在待审队列交给人工。
 *
 * @param {string} fileID 活动二维码（cloud:// 文件 ID 或 https 地址）
 * @returns {Promise<Object>} { status, ok, kind, kindName, typeName, content, message, time }
 */
async function checkQrCode(fileID) {
  const source = String(fileID || '')
  const failed = (message) => ({
    status: QR_FAILED,
    ok: false,
    kind: '',
    kindName: '',
    typeName: '',
    content: '',
    message,
    time: now(),
  })
  if (!source) return failed('未上传活动二维码')

  return withBudget(
    async () => {
      // 云调用只接受 http(s) 链接：云存储文件先换临时链接，本来就是 https 的图直接用
      const mediaUrl = source.indexOf('https://') === 0 ? source : await tempUrlOf(source)
      if (!mediaUrl) return failed('活动二维码临时链接获取失败，未能识别')

      const res = await cloud.openapi.img.scanQRCode({ imgUrl: mediaUrl })
      const errcode = Number(res && res.errcode)
      if (Number.isFinite(errcode) && errcode !== 0) {
        return failed(`二维码识别接口返回错误 ${errcode}`)
      }

      const codes = ((res && (res.code_results || res.codeResults)) || []).filter(Boolean)
      if (!codes.length) {
        return {
          status: QR_NOT_QRCODE,
          ok: false,
          kind: '',
          kindName: '',
          typeName: '',
          content: '',
          message: '这张图里没有识别到二维码',
          time: now(),
        }
      }

      const hit = findWechatCode(codes)
      if (!hit) {
        const first = codes[0]
        return {
          status: QR_NOT_WECHAT,
          ok: false,
          kind: '',
          kindName: '',
          typeName: String(first.type_name || first.typeName || ''),
          content: String(first.data || '').slice(0, QR_CONTENT_LIMIT),
          message: '识别到码，但不是微信群邀请码或个人微信二维码',
          time: now(),
        }
      }

      return {
        status: QR_OK,
        ok: true,
        kind: hit.kind,
        kindName: hit.name,
        typeName: String(hit.code.type_name || hit.code.typeName || ''),
        content: String(hit.code.data || '').slice(0, QR_CONTENT_LIMIT),
        message: hit.kind === 'group' ? '识别到微信群邀请链接' : '识别到个人微信二维码',
        time: now(),
      }
    },
    QR_BUDGET_MS,
    () => failed('活动二维码识别超时，未能识别')
  )
}

/**
 * 汇总机器结论，供待审队列做优先级排序：
 * machineReview 需要人工重点看，machinePending 表示图片结论还没回来。
 */
function summarize(text, images) {
  const list = images || []
  return {
    machineReview: (text && text.suggest === REVIEW) || list.some((item) => item.suggest === REVIEW),
    machinePending: list.some((item) => item.suggest === PENDING),
  }
}

module.exports = {
  PASS,
  REVIEW,
  RISKY,
  PENDING,
  QR_OK,
  QR_NOT_QRCODE,
  QR_NOT_WECHAT,
  QR_FAILED,
  QR_REJECT_REMARK,
  QR_KINDS,
  checkText,
  dispatchImages,
  checkQrCode,
  isQrRejected,
  summarize,
}
