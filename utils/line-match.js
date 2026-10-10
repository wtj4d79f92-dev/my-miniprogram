// 标题 → 线路词库的模糊匹配：发布活动时按标题里的地名 / 中心词自动填难度、全程长度、累计爬升
//
// 词库来自 utils/lines.js（由 scripts/extract-lines.js 从《成都周边徒步登山线路表.xlsx》生成），
// 线上以数据库 lines 集合为准，云函数 / 前端都拿同一份数据（见 services/api.js 的 lines()）。
const { LINE_LIBRARY } = require('./lines')

/** 中心词最少 2 个字：「沟」「山」这种单字太泛，标题里随便出现一个就会误匹配 */
const MIN_KEY_LENGTH = 2

/**
 * 参与匹配的文本只留中文：数字（「15号」的 15）、字母、标点、空格都是噪音，
 * 词库里的中心词也都是中文，去掉之后两边口径一致。
 */
function normalizeText(value) {
  return String(value === undefined || value === null ? '' : value).replace(/[^\u4e00-\u9fa5]/g, '')
}

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

module.exports = {
  MIN_KEY_LENGTH,
  normalizeText,
  matchLine,
}
