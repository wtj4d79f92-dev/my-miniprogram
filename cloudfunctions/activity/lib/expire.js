// 活动自动关闭的两条口径：展示期届满（发布满 7 天）、集合时间已过。
//
// 1) 展示期：发布后 7 天内在首页 / 广场展示，届满自动关闭。
//    为什么有展示期：主要是不让广场长期堆着没人跟进的活动。另外活动二维码（选填）以微信群邀请
//    二维码为主，扫码进群的有效期通常只有 7 天，活动长期挂着，后来报名的人扫到的就是一张过期二维码；
//    个人微信二维码长期有效，但两类二维码共用同一条展示期，不做区分处理。
//    口径：到期时间由 createTime 推导（createTime + 7 天），不单独落一个到期字段 ——
//    只有一个来源，历史数据（没有该字段）同样生效，也不需要数据迁移；
//    编辑重提不改 createTime，所以编辑不会重置展示期。
//
// 2) 集合时间已过：集合时间早于今天 00:00 的活动不再招募（按「天」判定，集合时间在今天的活动
//    当天仍可报名，次日才关）。关闭时刻取「集合那天的次日 00:00」，与定时任务同一口径 ——
//    两者都落在「关闭当天」，广场据此还会沉底展示一天，次日消失。
//
// 两条规则都同时做两件事：定时任务把库里的 status 收敛成 closed；读接口不依赖它 ——
// 查询侧过滤 + 对外输出前归一（applyAutoClose）。所以定时任务没跑（或定时触发器还没部署）时，
// 列表、详情、我的活动拿到的仍然是同一套结论，不会出现「看着还在招募、一点就报错」。
//
// 本文件与 utils/expire.js 内容一致（云函数打包时只上传自己的目录，
// require 不到小程序根目录的文件，所以两边各留一份，改动时必须同时改）。
const TTL_DAYS = 7
const TTL_MS = TTL_DAYS * 24 * 60 * 60 * 1000
const DAY_MS = 24 * 60 * 60 * 1000

/** 当天 00:00 的时间戳（传时间戳则取那一天，不传取现在） */
function startOfDay(now) {
  const d = new Date(now === undefined ? Date.now() : now)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

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

/** 集合时间已过的关闭时刻（集合那天的次日 00:00）；取不到集合时间时返回 0，表示「不关闭」 */
function pastStartTimeOf(item) {
  const start = Number((item || {}).startTime) || 0
  return start > 0 ? startOfDay(start) + DAY_MS : 0
}

/** 活动是否已过集合时间（集合时间早于今天 00:00 才算过，今天集合的活动当天仍可报名） */
function isPastStart(item, now) {
  const at = pastStartTimeOf(item)
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

/**
 * 对外输出前的状态归一：过了集合时间的活动同样按「已关闭」处理。
 * startPassed 让前端能把「集合时间已过自动关闭」与发起人主动关闭区分开（前者不能重新打开）。
 */
function applyPastStart(item, now) {
  if (!item || !isPastStart(item, now)) return item
  item.startPassed = true
  if (item.status !== 'closed') {
    item.status = 'closed'
    item.closeTime = pastStartTimeOf(item)
  }
  return item
}

/** 对外输出前的统一归一：两条自动关闭规则都按「已关闭」下发 */
function applyAutoClose(item, now) {
  applyExpiry(item, now)
  applyPastStart(item, now)
  return item
}

module.exports = {
  TTL_DAYS,
  TTL_MS,
  DAY_MS,
  startOfDay,
  expireTimeOf,
  isExpired,
  pastStartTimeOf,
  isPastStart,
  applyExpiry,
  applyPastStart,
  applyAutoClose,
}
