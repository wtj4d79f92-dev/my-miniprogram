// 线路强度沉淀：从活动标题里抽中心词，把用户填的「星级 / 全程长度 / 累计爬升」记到该中心词名下
//
// 用途：用户在发布页填的三项强度指标是「同一地点、同一线路」的重复输入。发布时按标题里的中心词
// 沉淀下来（如「15号夜爬峨眉山」→ 峨眉山），下次有人发布同一地点的活动，发布页就能自动填上
// （见 utils/line-match.js 的 matchStat 与 pages/activity/publish/index.js）。
//
// 本文件在 cloudfunctions/activity/lib/line-stat.js 有一份逐字一致的镜像副本：沉淀发生在发布
// 那一刻，只能由云函数写库（Mock 模式在 services/mock.js 里用同一套函数模拟），而云函数不能 require
// 小程序的 utils/。两份必须一起改，scripts/validate.js 会比对两份文件是否逐字一致。

/** 中心词最少 2 个字：「沟」「山」这种单字太泛，标题里随便出现一个就会误匹配 */
const MIN_KEY_LENGTH = 2
/** 中心词最长 8 个字：再长多半是把描述词一起抽进来了，宁可不沉淀，也不要记一个下次匹配不上的词 */
const MAX_KEY_LENGTH = 8
/** 后缀锚点往前最多带 4 个字（「四姑娘山」带得住，「阿坝州小金县四姑娘山」只留后半截） */
const SUFFIX_PREFIX_MAX = 4
/** 每个中心词只留最近 20 条样本：样本本身很小，留一窗口够算中位数就行 */
const MAX_SAMPLES = 20
/** 样本的合理区间：超出区间的按「填错了」处理，不作为样本沉淀 */
const SAMPLE_LIMITS = {
  starsMin: 1,
  starsMax: 10,
  distanceMax: 500,
  elevationMax: 10000,
}

/**
 * 噪音词：活动标题里高频出现的动作 / 形式 / 时间词，抽中心词前整段去掉。
 * 只收 2 个字以上的词：单字（「线」「团」）很可能本身就是地名的一部分，
 * 削掉反而把「赵公山」变成「赵公」。
 */
const NOISE_WORDS = [
  '夜爬', '夜徒', '夜跑', '晨跑', '徒步', '登山', '爬山', '穿越', '速穿', '连穿', '反穿', '轻装', '重装',
  '拉练', '环线', '单日', '一日', '两日', '三日', '半日', '多日', '往返', '来回', '出发', '前往', '集合', '集合点',
  '周末', '周中', '周一', '周二', '周三', '周四', '周五', '周六', '周日', '周天',
  '活动', '组队', '约伴', '约起', '拼车', '自驾', '露营', '打卡', '报名', '招募', '挑战', '全程', '周边', '附近',
  '看日出', '看日落', '看云海', '日出', '日落', '云海', '赏花',
  '登顶', '上山', '下山', '环穿', '穿行',
]

/** 长的先替换，避免「看日出」被「日出」拆成「看」 */
const NOISE_SORTED = NOISE_WORDS.slice().sort((a, b) => b.length - a.length)

/**
 * 地名后缀：中文地名几乎都以这些字结尾，抽中心词时拿它当锚点。
 * 长的优先（「海子」不该被当成「子」），所以按长度排一遍。
 */
const SUFFIX_WORDS = [
  '海子', '牧场', '营地', '公园', '广场', '古镇', '古村', '遗址', '峡谷', '瀑布', '温泉', '水库', '长城', '雪峰', '草甸',
  '山', '沟', '峰', '顶', '湖', '岭', '坡', '台', '岩', '峡', '谷', '洞', '桥', '坪', '坝', '溪', '河', '寺', '庙',
  '城', '岛', '村', '镇', '寨', '关', '口', '道', '林', '园', '场', '川', '源', '滩', '泉', '池', '塘',
]

const SUFFIX_SORTED = SUFFIX_WORDS.slice().sort((a, b) => b.length - a.length)

/**
 * 首尾残留的单字：噪音词按整词去掉后，「周末去峨眉山」会剩下一个领头的「去」，
 * 「15号夜爬峨眉山」剩下一个领头的「号」，「峨眉山看日出」剩下一个收尾的「看」。
 * 行政区划字也算：以「省 / 市 / 县 / 区 / 州」开头的那一截是从长地名里截断留下的
 * （「阿坝州小金县四姑娘山」→「县四姑娘山」），接着往下削只会更不像地名。
 * 只削首尾、并连着削（「随便走走」两个「走」一起去掉），中间的字符一律不动。
 */
const EDGE_JUNK = /^[去到往从和与及号期届第省县市区州乡镇村]+|[看赏逛游爬走跑骑行摄拍日期届号点分秒]+$/g

/**
 * 太泛的中心词：整词就是后缀本身（「公园」），或整词泛指一类场地、没有区分度
 * （「XX国家森林公园」这种中心词会把所有带同一句的标题都匹配到同一份数据上）。
 * 与线路词库「县名这类太泛的词不进词库」同一个道理：宁可这条不沉淀，也不要记一个会串地方的词。
 */
const GENERIC_WORDS = [
  '公园', '森林公园', '国家森林公园', '湿地公园', '人民公园', '体育公园', '广场', '古镇', '古村', '遗址',
  '营地', '牧场', '水库', '长城', '瀑布', '温泉', '峡谷', '草甸', '海子', '雪峰',
]

/**
 * 参与匹配的文本只留中文：数字（「15号」的 15）、字母、标点、空格都是噪音，
 * 词库 / 中心词都是中文，去掉之后两边口径一致。
 */
function normalizeText(value) {
  return String(value === undefined || value === null ? '' : value).replace(/[^\u4e00-\u9fa5]/g, '')
}

/** 去掉噪音词 */
function stripNoiseWords(text) {
  let next = text
  NOISE_SORTED.forEach((word) => {
    next = next.split(word).join('')
  })
  return next
}

/** 位置 index 上的地名后缀长度（0 = 这里没有后缀） */
function suffixLengthAt(text, index) {
  const rest = text.slice(index)
  for (let i = 0; i < SUFFIX_SORTED.length; i += 1) {
    if (rest.indexOf(SUFFIX_SORTED[i]) === 0) return SUFFIX_SORTED[i].length
  }
  return 0
}

/**
 * 最后一个地名后缀（没有后缀时返回 null）。
 * 按「结束位置最靠后」挑，同一结束位置上取更长的那个 —— 「云中牧场」的结束位置 4
 * 同时对应「牧场」与「场」，要的是前者，否则会被削成光秃秃一个「场」。
 */
function lastSuffix(text) {
  let best = null
  for (let i = 0; i < text.length; i += 1) {
    const length = suffixLengthAt(text, i)
    if (!length) continue
    const end = i + length
    const bestEnd = best ? best.index + best.length : -1
    if (end > bestEnd || (end === bestEnd && length > best.length)) best = { index: i, length }
  }
  return best
}

/**
 * 以后缀为锚点收口：取最后一个地名后缀，再往前带最多 4 个字
 * （「阿坝州小金县四姑娘山」→「小金县四姑娘山」），后缀后面的描述（「巴朗山下雪了」的「下雪了」）自然被丢掉。
 */
function anchorToSuffix(text) {
  const last = lastSuffix(text)
  if (!last) return text
  const start = Math.max(0, last.index - SUFFIX_PREFIX_MAX)
  return text.slice(start, last.index + last.length)
}

/**
 * 标题 → 中心词：只留下「地点」这一截。
 * 例：「15号夜爬峨眉山」→ 峨眉山；「周六云中牧场一日徒步」→ 云中牧场；「都江堰赵九铁拉练」→ 都江堰赵九铁。
 * 抽不出来（标题里全是描述词、剩下的那截太长、或抽出来太泛）时返回 ''，这一条就不沉淀。
 */
function extractCenterWord(title) {
  let text = stripNoiseWords(normalizeText(title))
  text = text.replace(EDGE_JUNK, '')
  if (text.length < MIN_KEY_LENGTH) return ''
  // 收口之后再削一次首尾：锚点往前带出来的那一截可能以行政区划字开头（「阿坝州小金县四姑娘山」→「县四姑娘山」）
  const word = anchorToSuffix(text).replace(EDGE_JUNK, '')
  if (word.length < MIN_KEY_LENGTH || word.length > MAX_KEY_LENGTH) return ''
  // 整词就是后缀本身（「公园」）时没有区分度，拿去匹配等于把不同地方的数据串在一起
  if (GENERIC_WORDS.indexOf(word) > -1 || suffixLengthAt(word, 0) === word.length) return ''
  return word
}

/** 一位小数：公里数保留到 0.1km 就够用了 */
function round1(value) {
  return Math.round(Number(value) * 10) / 10
}

/**
 * 中位数。用户填的数字里偶尔会有一个明显填错的（把 8km 写成 80km）：
 * 取中位数比取平均值抗这种离群值，也比「最后一次覆盖」稳——单个填错的样本带不偏结果。
 */
function medianOf(values, integer) {
  const list = (values || [])
    .map((item) => Number(item))
    .filter((item) => Number.isFinite(item))
    .sort((a, b) => a - b)
  if (!list.length) return 0
  const middle = Math.floor(list.length / 2)
  const value = list.length % 2 ? list[middle] : (list[middle - 1] + list[middle]) / 2
  return integer ? Math.round(value) : round1(value)
}

/**
 * 活动（表单字段或落库文档都可以）→ 一条强度样本。
 * 三项都填了、且都在合理范围内才算数：缺一项就当作没填全，不沉淀。
 * 返回 null 表示这条活动不产生样本（不写库）。
 */
function sampleOf(activity) {
  const item = activity || {}
  const stars = Math.round(Number(item.difficulty) || 0)
  const distance = round1(Number(item.distance) || 0)
  const elevation = Math.round(Number(item.elevationGain) || 0)
  if (!(stars >= SAMPLE_LIMITS.starsMin && stars <= SAMPLE_LIMITS.starsMax)) return null
  if (!(distance > 0 && distance <= SAMPLE_LIMITS.distanceMax)) return null
  if (!(elevation > 0 && elevation <= SAMPLE_LIMITS.elevationMax)) return null
  return { stars, distance, elevation }
}

/**
 * 把一个样本并进某个中心词的沉淀里，返回整份新文档（读-改-写，落库由调用方负责）。
 * 星级 / 全程 / 爬升取最近 20 条样本的中位数；learnCount 是累计提交次数（窗口滑出去的那些也计数）。
 */
function mergeStat(existing, key, sample, now) {
  const prev = existing && existing.key === key ? existing : null
  const time = now || Date.now()
  const samples = ((prev && prev.samples) || [])
    .slice(-(MAX_SAMPLES - 1))
    .concat([{ stars: sample.stars, distance: sample.distance, elevation: sample.elevation, time }])
  return {
    key,
    stars: medianOf(samples.map((item) => item.stars), true),
    distance: medianOf(samples.map((item) => item.distance), false),
    elevation: medianOf(samples.map((item) => item.elevation), true),
    samples,
    sampleCount: samples.length,
    learnCount: ((prev && prev.learnCount) || 0) + 1,
    createTime: (prev && prev.createTime) || time,
    updateTime: time,
  }
}

module.exports = {
  MIN_KEY_LENGTH,
  MAX_KEY_LENGTH,
  MAX_SAMPLES,
  SAMPLE_LIMITS,
  NOISE_WORDS,
  SUFFIX_WORDS,
  GENERIC_WORDS,
  normalizeText,
  extractCenterWord,
  medianOf,
  sampleOf,
  mergeStat,
}
