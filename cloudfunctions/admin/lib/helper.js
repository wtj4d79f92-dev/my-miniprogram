// admin 云函数通用工具：字段清洗与错误结构，约定与 activity 云函数保持一致

/** 失败结构：前端 callAdmin 见到 code 字段即判定为失败 */
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

/** 对外输出：补 id，隐藏运行期字段 */
function withId(doc) {
  if (!doc) return null
  const out = Object.assign({}, doc)
  out.id = doc._id
  delete out._openid
  return out
}

module.exports = { fail, text, num, limitRange, withId }
