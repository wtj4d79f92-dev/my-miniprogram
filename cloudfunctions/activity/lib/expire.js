// 活动展示期：发布后 7 天内在首页 / 广场展示，届满自动关闭。
//
// 为什么有展示期：活动群二维码是发起人上传的微信群邀请二维码，有效期通常只有 7 天，
// 活动长期挂着，后来报名的人扫到的就是一张过期二维码。展示期与二维码有效期对齐，
// 也让广场不会长期堆着已经没人跟进的活动。
//
// 口径：到期时间由 createTime 推导（createTime + 7 天），不单独落一个到期字段 ——
// 只有一个来源，历史数据（没有该字段）同样生效，也不需要数据迁移；
// 编辑重提不改 createTime，所以编辑不会重置展示期。
//
// 本文件与 utils/expire.js 内容一致（云函数打包时只上传自己的目录，
// require 不到小程序根目录的文件，所以两边各留一份，改动时必须同时改）。
const TTL_DAYS = 7
const TTL_MS = TTL_DAYS * 24 * 60 * 60 * 1000

/** 活动到期时间（毫秒时间戳）；取不到发布时间时返回 0，表示「不到期」 */
function expireTimeOf(item) {
  const created = Number((item || {}).createTime) || 0
  return created > 0 ? created + TTL_MS : 0
}

/** 活动是否已过展示期 */
function isExpired(item, now) {
  const at = expireTimeOf(item)
  if (!at) return false
  return (now === undefined ? Date.now() : now) >= at
}

/**
 * 对外输出前的状态归一：过了展示期的活动一律按「已关闭」处理。
 * 库里的 status 由定时任务改成 closed，但读接口不依赖它 —— 定时器没跑（或还没部署）时，
 * 列表、详情、我的活动拿到的仍然是同一套结论，不会出现「看着还在招募、一点就报错」。
 */
function applyExpiry(item, now) {
  if (!item || !isExpired(item, now)) return item
  item.expired = true
  if (item.status !== 'closed') {
    item.status = 'closed'
    item.closeTime = expireTimeOf(item)
  }
  return item
}

module.exports = { TTL_DAYS, TTL_MS, expireTimeOf, isExpired, applyExpiry }
