// 二维码截图文字 → 发布表单字段。
//
// 群名里常带地点 / 日期，截图正文里常带集合时间、全程长度、累计爬升。这里只做"解析建议"：
// 页面按字段是否被用户改过决定填不填，解析不出来就返回 0 / 空串，不影响发布。
//
// 日期口径：
// - 带月份（10月18日 / 10/18）：没有年份时用当前年；只有「明年的这一天在 60 天内」才算明年
//   （12 月看到 1 月 5 日合理，10 月看到 8 月 1 日按旧截图处理，不自动填）；
// - 只有日（18日 / 18号）：没有月份时默认当月，已经过了就顺延到下个月；
// - 只有星期（周六 / 下周六）：取下一个对应的星期几，今天就是周六且时刻已过则取下周；
// - 只有时刻（7:30 集合）：今天该时刻还没到就用今天，否则用明天。
const { extractCenterWord } = require('./line-stat')
const { ALL_CITIES } = require('./cities')

/** 群名里不是地点 / 标题的界面词 */
const GROUP_WORDS = [
  '微信群',
  '群聊名称',
  '群聊',
  '活动群',
  '徒步群',
  '登山群',
  '爬山群',
  '户外群',
  '约伴群',
  '组队群',
  '交流群',
  '报名群',
  '临时群',
  '群',
]

/** 抽地点前再去掉一层泛称：这些词留在标题里可以，拿去当地点没有区分度 */
const LOCATION_GENERIC = [
  '户外',
  '驴友',
  '结伴',
  '同行',
  '爱好者',
  '俱乐部',
  '社群',
  '徒步',
  '爬山',
  '登山',
  '旅行',
  '旅游',
  '运动',
  '健身',
  '活动',
  '组队',
  '约伴',
  '周末',
  '成都',
  '公里',
]

/** 只剩这些词时不算有效标题（城市名单独判断，见 CITY_KEYS） */
const TITLE_GENERIC = [
  '户外',
  '驴友',
  '结伴',
  '同行',
  '爱好者',
  '俱乐部',
  '社群',
  '徒步',
  '爬山',
  '登山',
  '旅行',
  '旅游',
  '运动',
  '健身',
  '活动',
  '组队',
  '约伴',
  '周末',
]
const CITY_KEYS = ALL_CITIES.map((item) => item.key)

/** 这些界面文案不是群名，也不是活动时间 */
const UI_LINE = /(?:进群|入群|扫码|二维码|群公告|群成员|群主|管理员|该群|邀请|有效期|扫一扫|长按|保存|返回|关闭)/i
/** 时间候选里要跳过的片段：二维码有效期、报名截止、返程 / 解散时间都不是集合时间 */
const TIME_SKIP = /(?:二维码|有效期|失效|有效|到期|截止|返程|解散|结束|保存|扫一扫|长按|进群验证)/i
/** 明确指向集合时间的片段优先 */
const TIME_PREFERRED = /(?:集合|出发|活动时间|签到|开始|时间|日期)/i

const WEEKDAY = { 日: 0, 天: 0, 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6 }
const CN_DIGITS = {
  零: 0,
  〇: 0,
  一: 1,
  二: 2,
  两: 2,
  三: 3,
  四: 4,
  五: 5,
  六: 6,
  七: 7,
  八: 8,
  九: 9,
}
const CN_NUMBER = '[零〇一二两三四五六七八九十]{1,3}'
const NUM = `(\\d{1,2}|${CN_NUMBER})`
const PERIOD = '(凌晨|早上|早晨|上午|中午|午后|下午|傍晚|晚上|夜里|夜间|晚)?'

function pad2(value) {
  return value < 10 ? `0${value}` : String(value)
}

function startOfDay(ts) {
  const d = new Date(ts)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

/** 全角数字 / 冒号 / 斜杠先归一，OCR 经常混着输出 */
function normalizeSource(value) {
  return String(value === undefined || value === null ? '' : value)
    .replace(/[０-９]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0))
    .replace(/[：]/g, ':')
    .replace(/[／]/g, '/')
    .replace(/\u00a0/g, ' ')
}

function linesOf(value) {
  return normalizeSource(value)
    .split(/\r?\n/)
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
}

/** 按中文标点切小段：一条「报名截止 10月20日，集合 10月25日」不能只看第一个日期 */
function clausesOf(value) {
  return normalizeSource(value)
    .split(/[\r\n，,；;。]+/)
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
}

function isMeaningfulCandidate(value) {
  const text = String(value || '').trim()
  if (!text) return false
  if (/^[\d\s()（）[\]【】]+$/.test(text)) return false
  return !UI_LINE.test(text)
}

/** 群聊名称：优先「群聊名称 / 群名称」标签，其次找一条以「群 / 群聊」结尾的短行 */
function extractGroupName(value) {
  const lines = linesOf(value)
  const label = /(?:群聊名称|群名称|群聊名|群名|群聊)\s*[:：]?\s*(.*)$/
  for (let i = 0; i < lines.length; i += 1) {
    const matched = lines[i].match(label)
    if (!matched) continue
    const same = String(matched[1] || '').trim()
    if (isMeaningfulCandidate(same)) return same
    for (let j = i + 1; j < Math.min(lines.length, i + 4); j += 1) {
      if (isMeaningfulCandidate(lines[j])) return lines[j]
    }
  }
  const fallback = lines.filter(
    (line) =>
      isMeaningfulCandidate(line) &&
      /(?:群|群聊)(?:\s*[（(][^）)]*[)）])?\s*\d*\s*人?$/.test(line) &&
      line.length <= 40
  )
  return fallback[0] || ''
}

/**
 * 活动介绍正文：去掉群聊名称标签行与群名本身。
 * 群名仍然参与标题解析，但不应该出现在对外的活动介绍里。
 */
function stripGroupName(value, groupName) {
  const name = String(groupName || '').replace(/\s+/g, ' ').trim()
  const label = /^(?:群聊名称|群名称|群聊名|群名|群聊)\s*[:：]?\s*/i
  return linesOf(value)
    .filter((line) => {
      if (label.test(line)) return false
      if (name && line === name) return false
      return true
    })
    .join('\n')
}

/**
 * 去掉群二维码自带的模板文案：
 * 「该二维码 N 天内（某日前）有效，重新进入将更新」。
 * OCR 可能把「更新」拆成两行，先按跨行整段删，再兜底删掉不完整的单行。
 */
function stripQrHints(value) {
  return String(value || '')
    .replace(/该二维码[\s\S]{0,160}?重新进入将更\s*新/g, '')
    .replace(/(?:^|\n)\s*该二维码[^\n]*有效[^\n]*(?=\n|$)/g, '')
    .trim()
}

/** 去掉成员数、日期、星期、时刻和「xx群」后缀，留下更像活动标题的一截 */
function cleanGroupTitle(value) {
  let text = normalizeSource(value)
    .replace(/[（(]\s*\d+\s*(?:人|名)?\s*(?:\/\s*\d+\s*)?[)）]/g, ' ')
    .replace(/[\[【]\s*\d+\s*(?:人|名)?\s*[\]】]/g, ' ')
    .replace(/\d+\s*人\s*$/, ' ')
    .replace(/\d{4}\s*[年/.-]\s*\d{1,2}\s*[月/.-]\s*\d{1,2}\s*[日号]?/g, ' ')
    .replace(/\d{1,2}\s*月\s*\d{1,2}\s*[日号]?/g, ' ')
    .replace(/\d{1,2}\s*[日号]/g, ' ')
    .replace(/\d{1,2}\s*月/g, ' ')
    .replace(
      /\d{1,2}\s*[/.-]\s*\d{1,2}(?!\d)(?!\s*(?:km|公里|千米|k(?![a-z])|m|米|小时|h(?![a-z])|天))/gi,
      ' '
    )
    .replace(/(?:周|星期|礼拜)[一二三四五六日天]/g, ' ')
    .replace(/(?:早上|早晨|上午|中午|午后|下午|傍晚|晚上|夜里|夜间|凌晨|晚)?\s*\d{1,2}\s*:\s*\d{1,2}\s*分?/g, ' ')
    .replace(
      /(?:早上|早晨|上午|中午|午后|下午|傍晚|晚上|夜里|夜间|凌晨|晚)?\s*\d{1,2}\s*(?:点|时)\s*(?:半|\d{1,2}\s*分?)?/g,
      ' '
    )
    .replace(
      /(?:早上|早晨|上午|中午|午后|下午|傍晚|晚上|夜里|夜间|凌晨|晚)?\s*[零〇一二两三四五六七八九十]{1,3}\s*(?:点|时)\s*(?:半|[零〇一二两三四五六七八九十]{1,3}\s*分?)?/g,
      ' '
    )
    .replace(/[|｜/\\·•—–_~]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  // 「云中牧场徒步交流群」先去掉「交流群」，再检查「徒步群 / 群」
  let changed = true
  while (changed) {
    changed = false
    for (let i = 0; i < GROUP_WORDS.length; i += 1) {
      const word = GROUP_WORDS[i]
      if (text.length > word.length && text.slice(-word.length) === word) {
        text = text.slice(0, -word.length).trim()
        changed = true
        break
      }
    }
  }
  return text.replace(/^[\s:：,，、/|-]+|[\s:：,，、/|-]+$/g, '')
}

function usableLocation(word) {
  const text = String(word || '').trim()
  if (text.length < 2 || text.length > 8) return false
  if (LOCATION_GENERIC.indexOf(text) > -1) return false
  return true
}

/** 群名 → { title, location }：地点必须抽得出来，抽不出来就不动标题 */
function titleFromGroupName(groupName) {
  const clean = cleanGroupTitle(groupName)
  if (!clean) return { title: '', location: '' }
  // 群名只剩一个城市时没有具体活动信息，不拿它当标题
  if (CITY_KEYS.indexOf(clean) > -1) return { title: '', location: '' }
  const locationSource = LOCATION_GENERIC.reduce(
    (text, word) => text.split(word).join(' '),
    clean
  )
  const location = extractCenterWord(locationSource)
  if (usableLocation(location)) {
    const title = clean.length <= 30 ? clean : location
    return { title, location }
  }
  // 「成都温泉」这类群名：城市 + 场景。extractCenterWord 把「温泉」当泛称剔掉了，
  // 但作为活动标题仍然有价值；只要去掉泛词后不是只剩一个城市，就保留清洗后的标题。
  const remainder = TITLE_GENERIC.reduce(
    (text, word) => text.split(word).join(''),
    clean
  ).replace(/[^\u4e00-\u9fa5]/g, '')
  if (remainder.length >= 2 && CITY_KEYS.indexOf(remainder) === -1 && clean.length <= 30) {
    return { title: clean, location: '' }
  }
  return { title: '', location: '' }
}

function cnNumber(token) {
  const raw = String(token || '')
  if (/^\d+$/.test(raw)) return Number(raw)
  if (raw === '十') return 10
  if (raw.indexOf('十') > -1) {
    const parts = raw.split('十')
    const tens = parts[0] ? CN_DIGITS[parts[0]] : 1
    const ones = parts[1] ? CN_DIGITS[parts[1]] : 0
    if (tens === undefined || ones === undefined) return NaN
    return tens * 10 + ones
  }
  let value = 0
  for (let i = 0; i < raw.length; i += 1) {
    const digit = CN_DIGITS[raw[i]]
    if (digit === undefined) return NaN
    value = value * 10 + digit
  }
  return value
}

function validYmd(year, month, day) {
  const date = new Date(year, month - 1, day)
  return (
    date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day
  )
}

/**
 * 没有年份的月 / 日：先按当前年；如果已经过去，只在「明年这一天在 60 天内」时才按明年算
 * （12 月看到 1 月 5 日合理，10 月看到 8 月 1 日则更像旧截图，宁可提示时间已过）。
 */
function resolveMonthDay(month, day, now) {
  let year = new Date(now).getFullYear()
  if (!validYmd(year, month, day)) {
    year += 1
    if (!validYmd(year, month, day)) return { year: 0 }
  }
  let candidate = new Date(year, month - 1, day)
  if (candidate.getTime() < startOfDay(now)) {
    const nextYear = new Date(year + 1, month - 1, day)
    if (nextYear.getTime() - startOfDay(now) <= 60 * 86400000) {
      year += 1
      candidate = nextYear
    }
  }
  return { year }
}

/** 解析日期部分；返回 { year, month, day, kind }，没有日期返回 null */
function dateInClause(clause, now) {
  const text = normalizeSource(clause)
  const today = new Date(startOfDay(now))
  let matched = text.match(
    /(\d{4})\s*[年/.-]\s*(\d{1,2})\s*[月/.-]\s*(\d{1,2})\s*[日号]?/
  )
  if (matched) {
    const year = Number(matched[1])
    const month = Number(matched[2])
    const day = Number(matched[3])
    if (validYmd(year, month, day)) return { year, month, day, kind: 'date' }
  }

  matched = text.match(/(\d{1,2})\s*月\s*(\d{1,2})\s*[日号]?/)
  if (matched) {
    const month = Number(matched[1])
    const day = Number(matched[2])
    if (month >= 1 && month <= 12 && day >= 1 && day <= 31) {
      const year = resolveMonthDay(month, day, now).year
      if (!year) return null
      return { year, month, day, kind: 'monthDay' }
    }
  }

  matched = text.match(
    /(\d{1,2})\s*[/.-]\s*(\d{1,2})(?!\d)(?!\s*(?:km|公里|千米|k(?![a-z])|m|米|小时|h(?![a-z])|天))/i
  )
  if (matched) {
    const month = Number(matched[1])
    const day = Number(matched[2])
    if (month >= 1 && month <= 12 && day >= 1 && day <= 31) {
      const year = resolveMonthDay(month, day, now).year
      if (!year) return null
      return { year, month, day, kind: 'monthDay' }
    }
  }

  matched = text.match(/(\d{1,2})\s*[日号]/)
  if (matched) {
    const day = Number(matched[1])
    if (day >= 1 && day <= 31) {
      let year = today.getFullYear()
      let month = today.getMonth() + 1
      if (!validYmd(year, month, day)) {
        month += 1
        if (month > 12) {
          month = 1
          year += 1
        }
        if (!validYmd(year, month, day)) return null
      }
      let candidate = new Date(year, month - 1, day)
      // 没有月份默认当月；当月这一天已经过了就顺延到下个月
      if (candidate.getTime() < startOfDay(now)) {
        month += 1
        if (month > 12) {
          month = 1
          year += 1
        }
        if (!validYmd(year, month, day)) return null
      }
      return { year, month, day, kind: 'dayOnly' }
    }
  }

  matched = text.match(/(下周|下星期|下礼拜|本周|这周|周|星期|礼拜)([一二三四五六日天])/)
  if (matched) {
    const target = WEEKDAY[matched[2]]
    let candidate
    if (/下/.test(matched[1])) {
      // 「下周六」按下一个自然周（周一至周日）算：今天是周日时，下周六是 6 天后而不是 13 天后
      const sinceMonday = (today.getDay() + 6) % 7
      const nextMonday = today.getTime() + (7 - sinceMonday) * 86400000
      candidate = new Date(nextMonday + ((target + 6) % 7) * 86400000)
    } else {
      const delta = (target - today.getDay() + 7) % 7
      candidate = new Date(today.getTime() + delta * 86400000)
    }
    return {
      year: candidate.getFullYear(),
      month: candidate.getMonth() + 1,
      day: candidate.getDate(),
      kind: 'weekday',
    }
  }

  if (/大后天/.test(text)) {
    const candidate = new Date(today.getTime() + 3 * 86400000)
    return {
      year: candidate.getFullYear(),
      month: candidate.getMonth() + 1,
      day: candidate.getDate(),
      kind: 'relative',
    }
  }
  if (/后天/.test(text)) {
    const candidate = new Date(today.getTime() + 2 * 86400000)
    return {
      year: candidate.getFullYear(),
      month: candidate.getMonth() + 1,
      day: candidate.getDate(),
      kind: 'relative',
    }
  }
  if (/明天|明日/.test(text)) {
    const candidate = new Date(today.getTime() + 86400000)
    return {
      year: candidate.getFullYear(),
      month: candidate.getMonth() + 1,
      day: candidate.getDate(),
      kind: 'relative',
    }
  }
  if (/今天|今日/.test(text)) {
    return {
      year: today.getFullYear(),
      month: today.getMonth() + 1,
      day: today.getDate(),
      kind: 'relative',
    }
  }
  return null
}

/** 解析时刻；返回 { hour, minute, text }，没有时刻返回 null */
function clockInClause(clause) {
  const text = normalizeSource(clause)
  let matched = text.match(new RegExp(`${PERIOD}\\s*${NUM}\\s*:\\s*(\\d{1,2}|${CN_NUMBER})\\s*分?`))
  let hour = matched ? cnNumber(matched[2]) : NaN
  let minute = matched ? cnNumber(matched[3]) : NaN
  let period = matched ? matched[1] || '' : ''

  if (!matched) {
    const point = new RegExp(
      `${PERIOD}\\s*${NUM}\\s*(?:点|时)\\s*(?:(半)|(\\d{1,2}|${CN_NUMBER})\\s*分?)?`
    )
    matched = text.match(point)
    if (matched) {
      period = matched[1] || ''
      hour = cnNumber(matched[2])
      minute = matched[3] ? 30 : matched[4] ? cnNumber(matched[4]) : 0
    }
  }
  if (!matched || !Number.isFinite(hour) || !Number.isFinite(minute)) return null
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null

  if (/午后|下午|傍晚|晚上|夜里|夜间|晚/.test(period) && hour < 12) hour += 12
  if (/中午/.test(period) && hour < 11) hour += 12
  if (/凌晨/.test(period) && hour === 12) hour = 0
  if (hour > 23) return null
  return { hour, minute, text: `${pad2(hour)}:${pad2(minute)}` }
}

/**
 * 解析集合时间。
 * @returns {{ timestamp:number, clockText:string, past:boolean, matched:string }}
 */
function parseStartTime(value, now) {
  const current = now || Date.now()
  const clauses = clausesOf(value)
  const candidates = []
  clauses.forEach((clause) => {
    if (TIME_SKIP.test(clause) && !TIME_PREFERRED.test(clause)) return
    candidates.push({ clause, preferred: TIME_PREFERRED.test(clause) })
  })
  candidates.sort((a, b) => Number(b.preferred) - Number(a.preferred))

  let dateHit = null
  let clockHit = null
  let pair = null
  candidates.forEach((item) => {
    const date = dateInClause(item.clause, current)
    const clock = clockInClause(item.clause)
    if (date && !dateHit) dateHit = { date, clause: item.clause }
    if (clock && !clockHit) clockHit = { clock, clause: item.clause }
    if (date && clock && !pair) pair = { date, clock, clause: item.clause }
  })

  if (!pair && dateHit && clockHit) pair = { date: dateHit.date, clock: clockHit.clock }
  if (!pair && dateHit) {
    pair = { date: dateHit.date, clock: { hour: 0, minute: 0, text: '' } }
  }
  if (!pair && clockHit) {
    const today = new Date(current)
    const base = new Date(
      today.getFullYear(),
      today.getMonth(),
      today.getDate(),
      clockHit.clock.hour,
      clockHit.clock.minute,
      0,
      0
    )
    if (base.getTime() <= current) base.setDate(base.getDate() + 1)
    pair = {
      date: {
        year: base.getFullYear(),
        month: base.getMonth() + 1,
        day: base.getDate(),
        kind: 'timeOnly',
      },
      clock: clockHit.clock,
    }
  }
  if (!pair) {
    return { timestamp: 0, clockText: '', past: false, matched: '' }
  }

  const stamp = new Date(
    pair.date.year,
    pair.date.month - 1,
    pair.date.day,
    pair.clock.hour,
    pair.clock.minute,
    0,
    0
  )
  // 今天就是周六且集合时刻已经过了：按「下周六」理解
  if (
    pair.date.kind === 'weekday' &&
    startOfDay(stamp.getTime()) === startOfDay(current) &&
    pair.clock.text &&
    stamp.getTime() <= current
  ) {
    stamp.setDate(stamp.getDate() + 7)
  }
  const datePast = startOfDay(stamp.getTime()) < startOfDay(current)
  const clockPast = !!pair.clock.text && stamp.getTime() < current
  if (datePast || clockPast) {
    return {
      timestamp: 0,
      clockText: pair.clock.text,
      past: true,
      matched: (pair && pair.clause) || (dateHit && dateHit.clause) || (clockHit && clockHit.clause) || '',
    }
  }
  return {
    timestamp: stamp.getTime(),
    clockText: pair.clock.text,
    past: false,
    matched: (pair && pair.clause) || (dateHit && dateHit.clause) || (clockHit && clockHit.clause) || '',
  }
}

function round1(value) {
  return Math.round(Number(value) * 10) / 10
}

/** 全程长度：只认带 km / 公里 / 千米 / k 的数字，避免把日期和时刻当成距离 */
function parseDistance(value) {
  const text = normalizeSource(value)
  const pattern =
    /(?:全程|距离|里程|路线全长|单程|往返|徒步|骑行|跑步)?\s*(?:约|大约|大概)?\s*(\d{1,3}(?:\.\d{1,2})?)\s*(?:km|千米|公里|k(?![a-z]))(?!\s*(?:\/|每)\s*(?:h|小时))/i
  const matched = text.match(pattern)
  if (!matched) return 0
  const distance = round1(Number(matched[1]))
  return distance > 0 && distance <= 500 ? distance : 0
}

/** 累计爬升：必须带「爬升 / 上升 / 拔高」等词，海拔高度不算累计爬升 */
function parseElevation(value) {
  const text = normalizeSource(value)
  const patterns = [
    /(?:累计爬升|累计上升|爬升|上升|拔高|提升)\s*[:：]?\s*(?:约|大约|大概)?\s*(\d{1,5}(?:\.\d{1,2})?)\s*(?:m|米)?/i,
    /(\d{1,5}(?:\.\d{1,2})?)\s*(?:m|米)\s*(?:累计)?(?:爬升|上升)/i,
  ]
  for (let i = 0; i < patterns.length; i += 1) {
    const matched = text.match(patterns[i])
    if (!matched) continue
    const elevation = Math.round(Number(matched[1]))
    if (elevation > 0 && elevation <= 10000) return elevation
  }
  // 「8.5km + 700m」这种徒步截图里的紧凑写法，后一个带米的数就是爬升
  const compact = text.match(
    /\d+(?:\.\d+)?\s*(?:km|公里|千米)\s*(?:\+|＋|\/|、|，|,)\s*(\d{1,5})\s*m(?![a-z])/i
  )
  if (compact) {
    const elevation = Math.round(Number(compact[1]))
    if (elevation > 0 && elevation <= 10000) return elevation
  }
  return 0
}

/**
 * 整段 OCR 文本 → 可回填字段。
 * @returns {{ groupName, title, location, startTime, clockText, timePast, distance, elevation }}
 */
function parseQrFields(value, now) {
  const groupName = extractGroupName(value)
  const meta = titleFromGroupName(groupName)
  const time = parseStartTime(value, now || Date.now())
  return {
    groupName,
    title: meta.title,
    location: meta.location,
    startTime: time.timestamp,
    clockText: time.clockText,
    timePast: time.past,
    distance: parseDistance(value),
    elevation: parseElevation(value),
  }
}

module.exports = {
  extractGroupName,
  stripGroupName,
  stripQrHints,
  cleanGroupTitle,
  titleFromGroupName,
  parseStartTime,
  parseDistance,
  parseElevation,
  parseQrFields,
}
