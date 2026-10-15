// 标题 → 线路强度的匹配：发布活动时按标题里的地名 / 中心词自动填难度、全程长度、累计爬升
//
// 数据源有两个，按优先级：
//   1. 官方线路词库（utils/lines.js）——《成都周边徒步登山线路表》整理出来的权威数据，命中就用它；
//   2. 用户沉淀（utils/line-stat.js 抽出中心词后落库的那份数据）——只补词库覆盖不到的地点，
//      发布时由 activity 云函数按同样的标题口径写库，页面从 api.lineStats() 取。
// 词库来自 utils/lines.js（由 scripts/extract-lines.js 从《成都周边徒步登山线路表.xlsx》生成），
// 线上以数据库 lines 集合为准，云函数 / 前端都拿同一份数据（见 services/api.js 的 lines()）。
const { LINE_LIBRARY } = require('./lines')
const { MIN_KEY_LENGTH, normalizeText } = require('./line-stat')

/**
 * 两条候选谁更该被选上：
 *   1. 命中的中心词更长（「万佛顶」比「金顶」更具体）；
 *   2. 难度更低（星级小的优先）——用户定的规则：同时匹配到多条就选难度低的；
 *   3. 全长更短；
 *   4. 再相同就按线路名短的、id 小的定序，保证结果可复现。
 */
function betterMatch(candidate, best) {
  if (!best) return true
  if (candidate.score !== best.score) return candidate.score > best.score
  if (candidate.entry.stars !== best.entry.stars) return candidate.entry.stars < best.entry.stars
  const left = Number(candidate.entry.distance) || Infinity
  const right = Number(best.entry.distance) || Infinity
  if (left !== right) return left < right
  const leftName = String(candidate.entry.name || '').length
  const rightName = String(best.entry.name || '').length
  if (leftName !== rightName) return leftName < rightName
  return String(candidate.entry.id) < String(best.entry.id)
}

/**
 * 标题模糊匹配：
 *   标题里包含词库里的某个中心词就算命中（「15号夜爬峨眉山」→ 中心词「峨眉山」），
 *   命中多条时按上面的规则取一条。返回 null 表示没匹配上，页面就什么都不填。
 */
function matchLine(title, library) {
  const list = (library && library.length ? library : LINE_LIBRARY) || []
  const text = normalizeText(title)
  if (text.length < MIN_KEY_LENGTH) return null

  let best = null
  list.forEach((entry) => {
    if (!entry || !entry.name) return
    const keys = entry.keys && entry.keys.length ? entry.keys : [entry.name]
    let hit = ''
    keys.forEach((key) => {
      const word = normalizeText(key)
      if (word.length < MIN_KEY_LENGTH) return
      if (word.length > hit.length && text.indexOf(word) > -1) hit = word
    })
    if (!hit) return
    const candidate = { entry, key: hit, score: hit.length }
    if (betterMatch(candidate, best)) best = candidate
  })

  if (!best) return null
  const entry = best.entry
  return {
    id: entry.id,
    name: entry.name,
    stars: Number(entry.stars) || 0,
    // 词库里这四项是完整的（字段缺失的线路在生成词库时就被剔除了），直接原样给出
    distance: Number(entry.distance) || 0,
    elevation: Number(entry.elevation) || 0,
    key: best.key,
  }
}

/**
 * 两条沉淀候选谁更该被选上：
 *   1. 命中的中心词更长（「峨眉山金顶」比「峨眉山」更具体）；
 *   2. 沉淀次数更多的优先（同一个中心词下，被更多人填过的值更可信）；
 *   3. 再相同就按中心词定序，保证结果可复现。
 */
function betterStat(candidate, best) {
  if (!best) return true
  if (candidate.key.length !== best.key.length) return candidate.key.length > best.key.length
  const left = Number(candidate.entry.learnCount) || 0
  const right = Number(best.entry.learnCount) || 0
  if (left !== right) return left > right
  return candidate.key < best.key
}

/**
 * 用户沉淀的词条匹配：标题里包含某个中心词就算命中（「15号夜爬峨眉山」→ 「峨眉山」）。
 * 这一路只补词库覆盖不到的地点：调用方先按词库匹配，词库没命中再看这里。
 * 返回结构和 matchLine 一致，页面拿到的都是「填哪几项、填多少」，不关心数据来自哪一路。
 */
function matchStat(title, stats) {
  const list = stats || []
  if (!list.length) return null
  const text = normalizeText(title)
  if (text.length < MIN_KEY_LENGTH) return null

  let best = null
  list.forEach((entry) => {
    if (!entry) return
    const key = normalizeText(entry.key)
    // 只有星级没有另外两项的沉淀属于脏数据（正常写入时三项齐全），不拿来填
    if (key.length < MIN_KEY_LENGTH || !(Number(entry.stars) > 0)) return
    if (text.indexOf(key) === -1) return
    const candidate = { entry, key }
    if (betterStat(candidate, best)) best = candidate
  })

  if (!best) return null
  const entry = best.entry
  return {
    id: `learned_${best.key}`,
    name: best.key,
    key: best.key,
    stars: Number(entry.stars) || 0,
    distance: Number(entry.distance) || 0,
    elevation: Number(entry.elevation) || 0,
    sampleCount: Number(entry.sampleCount) || 0,
    // 标记数据来源：页面行为完全一致，留着方便排查「这个值是词库填的还是用户沉淀填的」
    learned: true,
  }
}

module.exports = {
  MIN_KEY_LENGTH,
  matchLine,
  matchStat,
}
