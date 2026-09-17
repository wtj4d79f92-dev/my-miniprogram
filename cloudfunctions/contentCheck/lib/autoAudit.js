// 机审自动放行判定：图片检测结果回调回来时判断「能不能不等人工直接上线」。
//
// 只有「所有送检项都明确通过」才算机审没问题：
// - 文本必须 pass，且接口真的跑通了（failed 表示结论不可信，不能当成通过）；
// - 群二维码必须识别出微信群邀请链接（识别不出、不是群链接、识别接口异常都不算通过）；
// - 有可送检图片时，每张图都要有结论且都是 pass —— 送检失败、结论没回来都算「没结论」，
//   一律留给人工，不能因为检测本身出问题就把内容放上线；
// - 没有可送检图片（封面 / 二维码都是 https 远程图或本机历史路径）时，只看文本结论。
//
// 本文件与 cloudfunctions/activity/lib/autoAudit.js 内容保持一致：
// 该文件负责发布当刻（没有可送检图片时）的判定，这里负责图片结论回来后的判定。

const PASS = 'pass'
/** 机审放行时写进审核人字段的来源，发起人与运营在「我的发布」/ 审核日志里能看到 */
const AUTO_AUDIT_BY = '内容安全检测'

/** 可送检的图片数量：mediaCheckAsync 只接受 cloud:// 换出来的临时链接 */
function checkableImageCount(files) {
  return (files || []).filter((item) => String(item || '').indexOf('cloud://') === 0).length
}

/**
 * @param {Object} machineCheck 活动文档里的 machineCheck 字段（含 text / images）
 * @param {number} checkable 可送检的图片数量，见 checkableImageCount
 * @returns {boolean} true 表示机审没问题，可以自动通过
 */
function canAutoApprove(machineCheck, checkable) {
  const text = (machineCheck && machineCheck.text) || {}
  if (text.suggest !== PASS || text.failed) return false
  // 群二维码：只有明确识别到微信群邀请链接才算通过（ok 为 true 只有这一种情况）
  const qrcode = (machineCheck && machineCheck.qrcode) || null
  if (!qrcode || qrcode.ok !== true) return false

  const total = Number(checkable) || 0
  if (!total) return true

  const images = (machineCheck && machineCheck.images) || []
  // 送检的图片比该送检的少：有图片没能送出去，结论不完整
  if (images.length < total) return false
  return images.every((item) => !!item && item.suggest === PASS)
}

module.exports = { PASS, AUTO_AUDIT_BY, checkableImageCount, canAutoApprove }
