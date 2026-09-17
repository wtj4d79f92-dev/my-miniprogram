// 机审三类检测：文本走同步的 msgSecCheck，图片走异步的 mediaCheckAsync，群二维码走同步的二维码识别
//
// 设计原则：检测接口本身出错（未开通 / 超额度 / 用户 openid 不满足条件 / 网络抖动）时
// 一律降级为「纯人工审核」，绝不能让内容安全把用户发布卡死；
// 二维码同理：识别不出码、识别到的不是微信群邀请链接、识别接口异常，都不算机审通过。
// 图片检测只有 traceId，最终结论由消息推送回调（cloudfunctions/contentCheck）补写。
const cloud = require('wx-server-sdk')

// 文本检测与检测步骤的时间预算工具放在 lib/textCheck.js：那份文件同时是
// cloudfunctions/contentCheck 云函数的镜像副本，图片结论回来时会用它补检文本。
const { SCENE, PASS, REVIEW, RISKY, now, withBudget, checkText } = require('./textCheck')

/** mediaCheckAsync 媒体类型：1 音频 / 2 图片 */
const MEDIA_IMAGE = 2

/** 图片检测已发起、结果未回 */
const PENDING = 'pending'

/** 群二维码识别结论：ok 通过 / not-qrcode 没识别到码 / not-group 不是微信群邀请链接 / failed 没结论 */
const QR_OK = 'ok'
const QR_NOT_QRCODE = 'not-qrcode'
const QR_NOT_GROUP = 'not-group'
const QR_FAILED = 'failed'
/** 群二维码没识别出微信群邀请链接时的驳回原因：发起人在详情页与「我的发布」里都会看到 */
const QR_REJECT_REMARK = '活动二维码上传有误，请重新上传微信群二维码'
/** 微信群邀请二维码扫出来就是这个形态：https://weixin.qq.com/g/xxxxx */
const GROUP_LINK_PATTERN = /^https?:\/\/weixin\.qq\.com\/g\/\S+/i
/** 识别到的码内容只留一段用于审核台核对，不整条存库 */
const QR_CONTENT_LIMIT = 200

/**
 * 二维码识别结论明确「这张图不是微信群邀请二维码」时才直接驳回：
 * - not-qrcode：图里没识别到任何码（风景照、糊到认不出的截图等）；
 * - not-group：识别到了码，但不是微信群邀请链接（收款码、个人码、企业微信 / QQ 群码等）。
 *
 * 识别接口异常 / 超时（failed）拿不到结论，不能据此驳回用户，仍留在待审队列交给人工。
 * 判定逻辑与前端 services/api.js 的 mockQrReject 保持一致。
 */
function isQrRejected(qrcode) {
  const status = (qrcode && qrcode.status) || ''
  return status === QR_NOT_QRCODE || status === QR_NOT_GROUP
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
 * 群二维码识别（同步）。
 *
 * 机审自动放行以后，随手传一张风景照当群二维码也会被直接放上线，报名的人拿到一张没用的图，
 * 所以这里把二维码内容解出来，只认微信群邀请链接（https://weixin.qq.com/g/xxxxx）。
 *
 * 判定结果写进 machineCheck.qrcode，并作为自动放行的必要条件；以下情况一律不算机审通过：
 * 没识别到码、识别到的码内容不是群邀请链接、临时链接取不到、识别接口报错或超时。
 * 其中「没识别到码」「识别到的不是群邀请链接」这两种有明确结论的，调用方（cloudfunctions/activity）
 * 会直接驳回发布（见 isQrRejected）；拿不到结论的异常情况留在待审队列交给人工。
 *
 * @param {string} fileID 群二维码（cloud:// 文件 ID 或 https 地址）
 * @returns {Promise<Object>} { status, ok, typeName, content, message, time }
 */
async function checkQrCode(fileID) {
  const source = String(fileID || '')
  const failed = (message) => ({
    status: QR_FAILED,
    ok: false,
    typeName: '',
    content: '',
    message,
    time: now(),
  })
  if (!source) return failed('未上传群二维码')

  return withBudget(
    async () => {
      // 云调用只接受 http(s) 链接：云存储文件先换临时链接，本来就是 https 的图直接用
      const mediaUrl = source.indexOf('https://') === 0 ? source : await tempUrlOf(source)
      if (!mediaUrl) return failed('群二维码临时链接获取失败，未能识别')

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
          typeName: '',
          content: '',
          message: '这张图里没有识别到二维码',
          time: now(),
        }
      }

      const hit = codes.filter((item) => GROUP_LINK_PATTERN.test(String(item.data || '')))[0]
      if (!hit) {
        const first = codes[0]
        return {
          status: QR_NOT_GROUP,
          ok: false,
          typeName: String(first.type_name || first.typeName || ''),
          content: String(first.data || '').slice(0, QR_CONTENT_LIMIT),
          message: '识别到码，但不是微信群邀请链接',
          time: now(),
        }
      }

      return {
        status: QR_OK,
        ok: true,
        typeName: String(hit.type_name || hit.typeName || ''),
        content: String(hit.data || '').slice(0, QR_CONTENT_LIMIT),
        message: '识别到微信群邀请链接',
        time: now(),
      }
    },
    QR_BUDGET_MS,
    () => failed('二维码识别超时，未能识别')
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
  QR_NOT_GROUP,
  QR_FAILED,
  QR_REJECT_REMARK,
  checkText,
  dispatchImages,
  checkQrCode,
  isQrRejected,
  summarize,
}
