// 云函数通用工具：字段清洗、成员快照、事务读取、错误结构

/** 各文本字段长度上限（与前端表单校验保持一致） */
const LIMITS = {
  title: 30,
  desc: 500,
  location: 50,
  // 地图选点反查出的地址：不展示，只用于城市匹配与地址检索
  locationAddress: 100,
  nickName: 30,
  bio: 60,
  url: 500,
  feedback: 1000,
}

/** 无头像时的色块备选，与前端 services/api.js 的 AVATAR_COLORS 保持一致 */
const AVATAR_COLORS = [
  '#4ECDC4',
  '#45B7D1',
  '#FF8E72',
  '#F6D365',
  '#00CDAC',
  '#FA709A',
  '#44A08D',
  '#A8DADC',
  '#FF7D00',
]

/** 失败结构：前端 callCloud 见到 code 字段即判定为失败 */
function fail(code, message) {
  return { code, message }
}

/** 转字符串并去首尾空白、截断长度 */
function text(value, limit) {
  const raw = value === undefined || value === null ? '' : String(value)
  const trimmed = raw.trim()
  return limit ? trimmed.slice(0, limit) : trimmed
}

/** 转数字，非法值回退到默认值 */
function num(value, fallback) {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

function limitRange(value, min, max) {
  return Math.min(max, Math.max(min, value))
}

/**
 * 经纬度清洗：非数字或落在可导航范围之外的值一律存 0。
 *
 * 与前端 utils/location.js 的 usableCoord 同一口径（中国大致范围 lat 3~54 / lng 73~136）：
 * 存 0 表示「这个活动没有坐标」，前端点地址时改走地址文本解析，不会拿脏数据去开地图。
 * @param {*} value 前端表单带上的纬度 / 经度
 * @param {'lat' | 'lng'} kind 纬度还是经度
 */
function coord(value, kind) {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return 0
  const min = kind === 'lat' ? 3 : 73
  const max = kind === 'lat' ? 54 : 136
  return parsed >= min && parsed <= max ? parsed : 0
}

/** 转义正则元字符：关键字搜索走 db.RegExp，不能让用户输入当成正则 */
function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** 报名成员 / 发起人快照：只保留展示需要的字段 */
function memberOf(user) {
  const nickName = text(user.nickName, LIMITS.nickName) || '微信用户'
  return {
    openid: user.openid,
    nickName,
    avatarColor: user.avatarColor || AVATAR_COLORS[0],
    avatarUrl: user.avatarUrl || '',
    avatarText: user.avatarText || nickName.slice(0, 1),
  }
}

/** 对外输出：补 id，隐藏运行期字段 */
function withId(doc) {
  if (!doc) return null
  const out = Object.assign({}, doc)
  out.id = doc._id
  delete out._openid
  return out
}

/** 事务内按 id 取文档：文档不存在时 get 会抛错，统一收敛成 null */
async function txDoc(transaction, collectionName, id) {
  try {
    const res = await transaction.collection(collectionName).doc(id).get()
    return (res && res.data) || null
  } catch (e) {
    return null
  }
}

module.exports = {
  LIMITS,
  AVATAR_COLORS,
  fail,
  text,
  num,
  limitRange,
  coord,
  escapeRegExp,
  memberOf,
  withId,
  txDoc,
}
