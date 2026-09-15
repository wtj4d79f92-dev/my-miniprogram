// 通用工具方法：日期、星期、深拷贝、文本处理
const WEEKDAY_TEXT = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']

function pad(n) {
  return n < 10 ? `0${n}` : `${n}`
}

/** 时间戳 -> 2026-09-15 */
function formatDate(ts) {
  const d = new Date(ts)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

/** 时间戳 -> 09月15日 */
function formatMonthDay(ts) {
  const d = new Date(ts)
  return `${pad(d.getMonth() + 1)}月${pad(d.getDate())}日`
}

/** 时间戳 -> 周二 */
function weekdayText(ts) {
  return WEEKDAY_TEXT[new Date(ts).getDay()]
}

/** 时间戳 -> 09月15日 周二（卡片 / 详情统一格式） */
function formatCardDate(ts) {
  if (!ts) return ''
  return `${formatMonthDay(ts)} ${weekdayText(ts)}`
}

/** 时间戳 -> 2026年09月 */
function formatYearMonth(ts) {
  const d = new Date(ts)
  return `${d.getFullYear()}年${pad(d.getMonth() + 1)}月`
}

/** 当天 00:00 的时间戳 */
function startOfDay(ts) {
  const d = new Date(ts)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

function addDays(ts, days) {
  return startOfDay(ts) + days * 24 * 3600 * 1000
}

function deepClone(value) {
  if (value === null || typeof value !== 'object') return value
  if (Array.isArray(value)) return value.map(deepClone)
  const result = {}
  Object.keys(value).forEach((key) => {
    result[key] = deepClone(value[key])
  })
  return result
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * 把带 **加粗** 标记的文案解析成片段数组，供 wxml 渲染高亮粗体
 * @returns {Array<{text: string, strong: boolean}>}
 */
function parseBold(text) {
  const segments = []
  const source = String(text || '')
  let cursor = 0
  const reg = /\*\*([^*]+)\*\*/g
  let match = reg.exec(source)
  while (match) {
    if (match.index > cursor) {
      segments.push({ text: source.slice(cursor, match.index), strong: false })
    }
    segments.push({ text: match[1], strong: true })
    cursor = match.index + match[0].length
    match = reg.exec(source)
  }
  if (cursor < source.length) {
    segments.push({ text: source.slice(cursor), strong: false })
  }
  return segments
}

/** 生成一个稳定可复现的伪随机数（同一 seed 始终返回同一序列） */
function createRandom(seed) {
  let state = seed % 2147483647
  if (state <= 0) state += 2147483646
  return function random() {
    state = (state * 16807) % 2147483647
    return (state - 1) / 2147483646
  }
}

function pick(list, random) {
  return list[Math.floor(random() * list.length) % list.length]
}

function pickInt(min, max, random) {
  return min + Math.floor(random() * (max - min + 1))
}

module.exports = {
  WEEKDAY_TEXT,
  pad,
  formatDate,
  formatMonthDay,
  weekdayText,
  formatCardDate,
  formatYearMonth,
  startOfDay,
  addDays,
  deepClone,
  delay,
  parseBold,
  createRandom,
  pick,
  pickInt,
}
