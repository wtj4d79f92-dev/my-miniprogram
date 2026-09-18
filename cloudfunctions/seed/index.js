// 提审演示数据云函数（只在提审 / 演示期间使用，上线后可以删除或停用）
//
// 用途：小程序提交微信审核前，往 activities 集合写一批「审核已通过」的演示活动，
// 让审核员打开首页 / 广场 / 详情 / 报名名单时看到的是有内容的界面，而不是空状态。
//
// 调用方式（微信开发者工具 → 云开发控制台 → 云函数 → seed → 云端测试）：
//   { "action": "seed",    "token": "<SEED_TOKEN>" }  写入 / 覆盖全部演示活动（时间字段重置为当前时间）
//   { "action": "refresh", "token": "<SEED_TOKEN>" }  只平移时间字段，内容与封面 / 二维码保持不变
//   { "action": "status",  "token": "<SEED_TOKEN>" }  查看演示数据与真实数据的条数
//   { "action": "clear",   "token": "<SEED_TOKEN>", "confirm": "DELETE_DEMO" }  删除全部演示活动
//
// 说明：
// - 演示数据带 isDemo: true 与 demo_act_* 的 _id，清理只删这一批，不碰真实用户发布的活动；
// - 活动有 7 天展示期（见 activity/lib/expire.js），审核拖久了就再跑一次 refresh 把展示期往后推；
// - SEED_REFRESH=1 时，定时触发器会每天自动跑一次 refresh，审核期间数据不会中途「消失」。

const cloud = require('wx-server-sdk')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

const db = cloud.database()
const activities = db.collection('activities')

const { buildDocs, summarize, DEMO_PREFIX } = require('./lib/data')

/** 调用口令：云函数环境变量里的 SEED_TOKEN，没配置就直接拒绝，避免被外部随便触发 */
const TOKEN_ENV = 'SEED_TOKEN'
/** 定时自动续期开关：环境变量 SEED_REFRESH=1 时才生效，默认关闭 */
const REFRESH_ENV = 'SEED_REFRESH'
/** 删除演示数据的二次确认口令，避免误触把数据清了 */
const CONFIRM_TEXT = 'DELETE_DEMO'
/** 写库并发度：30 条演示数据分 3 批写完，避免串行写超时 */
const BATCH = 10
/** 单次查询上限（云数据库默认 100） */
const QUERY_LIMIT = 100

function fail(code, message) {
  return { code, message }
}

function tokenOf(payload) {
  return String((payload && payload.token) || '')
}

/** 口令校验：环境变量没配 = 功能未启用，配置了才比对 */
function checkToken(payload) {
  const expected = String(process.env[TOKEN_ENV] || '')
  if (!expected) {
    return {
      error: fail('SEED_TOKEN_MISSING', `请先在云函数环境变量里配置 ${TOKEN_ENV}，再调用本函数`),
    }
  }
  if (tokenOf(payload) !== expected) {
    return { error: fail('FORBIDDEN', '口令不正确') }
  }
  return { error: null }
}

/** 读取全部演示活动：只按 isDemo 标记过滤，不按 _id 前缀，避免人工改过 id 的漏掉 */
async function listDemoDocs() {
  const res = await activities.where({ isDemo: true }).limit(QUERY_LIMIT).get()
  return (res && res.data) || []
}

/**
 * 写入演示活动：doc(_id).set() 是「不存在则创建、存在则整份覆盖」，
 * 所以重复执行不会产生重复数据，也不会残留上一次的旧字段。
 */
async function saveDocs(docs) {
  let saved = 0
  const errors = []
  for (let i = 0; i < docs.length; i += BATCH) {
    const chunk = docs.slice(i, i + BATCH)
    const results = await Promise.all(
      chunk.map((doc) => {
        const data = Object.assign({}, doc)
        delete data._id
        return activities
          .doc(doc._id)
          .set({ data })
          .then(() => ({ ok: true }))
          .catch((err) => ({ ok: false, id: doc._id, message: (err && err.message) || '写入失败' }))
      })
    )
    results.forEach((item) => {
      if (item.ok) {
        saved += 1
      } else {
        errors.push(`${item.id}：${item.message}`)
      }
    })
  }
  return { saved, failed: errors.length, errors: errors.slice(0, 5) }
}

/** 写入 / 覆盖演示活动；cover 与 qr 可传云存储 fileID */
async function seed(payload) {
  const docs = buildDocs(Date.now(), { cover: payload.cover || '', qr: payload.qr || '' })
  const result = await saveDocs(docs)
  return Object.assign({ action: 'seed', summary: summarize(docs) }, result)
}

/**
 * 只平移时间字段：内容、封面、群二维码都沿用库里已有的一份，
 * 用于展示期（发布后 7 天）快到时把演示活动往后推，避免审核期间首页 / 广场突然空掉。
 */
async function refresh() {
  const existing = await listDemoDocs()
  if (!existing.length) return { action: 'refresh', saved: 0, failed: 0, errors: [], note: '还没有演示数据，先执行 seed' }
  const sample = existing[0]
  const docs = buildDocs(Date.now(), { cover: sample.cover || '', qr: sample.groupQrCode || '' })
  const result = await saveDocs(docs)
  return Object.assign({ action: 'refresh', summary: summarize(docs) }, result)
}

/** 查看演示数据与真实数据的条数 */
async function status() {
  const [demoRes, totalRes] = await Promise.all([listDemoDocs(), activities.count()])
  const demo = demoRes.length
  const total = (totalRes && totalRes.total) || 0
  return {
    action: 'status',
    demo,
    others: Math.max(0, total - demo),
    total,
    prefix: DEMO_PREFIX,
    demoIds: demoRes.map((item) => item._id).slice(0, 5),
    autoRefresh: String(process.env[REFRESH_ENV] || '') === '1',
  }
}

/** 删除全部演示活动：需要 confirm 口令，逐条删除并汇总失败原因 */
async function clear(payload) {
  if (String((payload && payload.confirm) || '') !== CONFIRM_TEXT) {
    return fail('CONFIRM_REQUIRED', `删除演示数据需要传 confirm: "${CONFIRM_TEXT}"`)
  }
  const docs = await listDemoDocs()
  let removed = 0
  const errors = []
  for (let i = 0; i < docs.length; i += BATCH) {
    const chunk = docs.slice(i, i + BATCH)
    const results = await Promise.all(
      chunk.map((doc) =>
        activities
          .doc(doc._id)
          .remove()
          .then(() => ({ ok: true }))
          .catch((err) => ({ ok: false, id: doc._id, message: (err && err.message) || '删除失败' }))
      )
    )
    results.forEach((item) => {
      if (item.ok) {
        removed += 1
      } else {
        errors.push(`${item.id}：${item.message}`)
      }
    })
  }
  return { action: 'clear', removed, failed: errors.length, errors: errors.slice(0, 5) }
}

/** 定时触发器：只有 SEED_REFRESH=1 时才续期，默认什么都不做 */
async function onTimer() {
  if (String(process.env[REFRESH_ENV] || '') !== '1') {
    return { action: 'timer', skipped: `${REFRESH_ENV} 未开启，本次不续期` }
  }
  await refresh()
  return { action: 'timer', refreshed: true }
}

const ACTIONS = { seed, refresh, status, clear }

exports.main = async (event) => {
  const payload = event || {}
  try {
    // 定时触发器的入参是 { Type: 'Timer', TriggerName: ... }，没有 action
    if (payload.Type === 'Timer' || payload.TriggerName) return await onTimer()

    const action = payload.action || ''
    const handler = ACTIONS[action]
    if (!handler) return fail('UNKNOWN_ACTION', `未知操作：${action}`)

    const checked = checkToken(payload)
    if (checked.error) return checked.error
    return await handler(payload)
  } catch (err) {
    console.error('[seed] 执行失败', err)
    return fail('SERVER_ERROR', (err && err.message) || '服务异常，请稍后重试')
  }
}
