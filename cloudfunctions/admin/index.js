// 旷行吖 · 活动审核云函数
// 统一 action 路由，与前端 services/api.js 的 adminApi 一一对应。
// 约定：失败返回 { code, message }，成功直接返回业务数据。
//
// 权限模型：审核人白名单有两处来源，优先级从高到低
//   1. 云函数环境变量 ADMIN_OPENIDS（逗号分隔）——用于在还没有任何审核人时引导第一位管理员
//   2. 数据库 admins 集合（每行一个 { openid, name }）——日常增删审核人只改这里
// 小程序端的入口显隐只影响体验，真正的权限判断全部在这里用云函数上下文的 OPENID 完成。
const cloud = require('wx-server-sdk')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

const db = cloud.database()
const _ = db.command

const { fail, text, num, limitRange, withId } = require('./lib/helper')
const { PENDING, APPROVED, REJECTED, approvedWhere, auditStatusOf } = require('./lib/audit')
const { collectFileIDs, resolveMedia } = require('./lib/media')

const activities = db.collection('activities')
const auditLogs = db.collection('activity_audits')
const admins = db.collection('admins')

const DEFAULT_PAGE_SIZE = 20
const MAX_PAGE_SIZE = 50
const MAX_REMARK = 200
const LOG_LIMIT = 30

/** 管理端列表只展示审核需要的字段：joinedPeople 这类大数组不带出来，避免响应体过大 */
const LIST_FIELDS = {
  title: true,
  type: true,
  typeName: true,
  emoji: true,
  color: true,
  bg: true,
  cover: true,
  // 审核时要核对群二维码，列表里也带上，弹层先展示、详情接口再补齐完整字段
  groupQrCode: true,
  desc: true,
  location: true,
  city: true,
  startTime: true,
  endTime: true,
  feeMode: true,
  fee: true,
  maxPeople: true,
  joinedCount: true,
  tags: true,
  status: true,
  organizer: true,
  createTime: true,
  auditStatus: true,
  auditRemark: true,
  auditTime: true,
  auditBy: true,
  submitTime: true,
  machineCheck: true,
  machineReview: true,
  machinePending: true,
}

/* ------------------------------ 权限 ------------------------------ */

/** 环境变量里的审核人，用于冷启动引导 */
function envAdminIds() {
  return String(process.env.ADMIN_OPENIDS || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
}

/** 返回审核人记录（环境变量命中时合成一条）；非审核人返回 null */
async function findAdmin(openid) {
  if (!openid) return null
  if (envAdminIds().indexOf(openid) > -1) return { openid, name: '环境变量管理员' }
  try {
    const res = await admins.where({ openid }).limit(1).get()
    return (res.data && res.data[0]) || null
  } catch (e) {
    // admins 集合不存在时按「无权限」处理，而不是抛错
    return null
  }
}

function adminName(admin) {
  return text((admin && admin.name) || '', 30) || '审核管理员'
}

/**
 * 当前身份：小程序端用它决定是否展示「活动审核」入口。
 * 无论有没有权限都返回自己的 openid —— 第一位管理员就是靠它填进 ADMIN_OPENIDS 的。
 */
async function whoami(event, openid) {
  const admin = await findAdmin(openid)
  return { openid: openid || '', isAdmin: !!admin, name: admin ? adminName(admin) : '' }
}

/* ------------------------------ 审核列表 ------------------------------ */

/** 按审核状态组装查询条件：all 不加条件，approved 兼容没有 auditStatus 字段的历史数据 */
function statusWhere(status) {
  if (status === PENDING) return { auditStatus: PENDING }
  if (status === REJECTED) return { auditStatus: REJECTED }
  if (status === APPROVED) return { auditStatus: approvedWhere(_) }
  return {}
}

async function stats() {
  const [pending, approved, rejected, total] = await Promise.all([
    activities.where(statusWhere(PENDING)).count(),
    activities.where(statusWhere(APPROVED)).count(),
    activities.where(statusWhere(REJECTED)).count(),
    activities.count(),
  ])
  return {
    pending: pending.total,
    approved: approved.total,
    rejected: rejected.total,
    total: total.total,
  }
}

/**
 * 待审 / 已审列表：按提交审核时间倒序，历史数据没有 auditTime 时退化成发布时间。
 * 支持 status（all/pending/approved/rejected）与 keyword（标题、地点、发起人昵称）。
 */
async function list(event) {
  const query = event || {}
  const status = ['all', PENDING, APPROVED, REJECTED].indexOf(query.status) > -1 ? query.status : PENDING
  const pageIndex = Math.max(0, Math.floor(num(query.pageIndex, 0)))
  const pageSize = limitRange(Math.floor(num(query.pageSize, DEFAULT_PAGE_SIZE)), 1, MAX_PAGE_SIZE)
  const start = pageIndex * pageSize

  const conditions = []
  const base = statusWhere(status)
  if (Object.keys(base).length) conditions.push(base)
  const keyword = text(query.keyword, 30)
  if (keyword) {
    const reg = db.RegExp({ regexp: keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), options: 'i' })
    // 地点地址不展示在审核台，但审核人按地址关键词（如「双流」）也要能搜到
    conditions.push(
      _.or([{ title: reg }, { location: reg }, { locationAddress: reg }, { 'organizer.nickName': reg }])
    )
  }
  // 条件为空（全部页签且无关键字）时直接查整个集合
  let target = activities
  if (conditions.length === 1) target = activities.where(conditions[0])
  else if (conditions.length > 1) target = activities.where(_.and(conditions))

  const [listRes, countRes, statsRes] = await Promise.all([
    // 按提交审核时间倒序：编辑重提的活动会重新排到待审队列最前
    target.orderBy('submitTime', 'desc').skip(start).limit(pageSize).field(LIST_FIELDS).get(),
    target.count(),
    stats(),
  ])

  const rows = listRes.data.map((doc) => {
    const item = withId(doc)
    item.auditStatus = auditStatusOf(doc)
    return item
  })

  return {
    list: rows,
    total: countRes.total,
    hasMore: start + pageSize < countRes.total,
    stats: statsRes,
    // 封面 / 二维码的临时链接：审核人和发起人往往不是同一个微信号，
    // 客户端直接渲染 cloud:// 会被云存储权限拦下，这里用管理员身份统一换好
    media: await resolveMedia(collectFileIDs(listRes.data)),
  }
}

/** 单条活动详情：审核时需要看到完整介绍与群二维码 */
async function detail(event) {
  const id = text(event && event.id, 64)
  if (!id) return fail('INVALID_PARAM', '缺少活动 id')
  try {
    const res = await activities.doc(id).get()
    const item = withId(res.data)
    if (item) item.auditStatus = auditStatusOf(res.data)
    if (item) item.media = await resolveMedia(collectFileIDs([res.data]))
    return item || fail('NOT_FOUND', '活动不存在')
  } catch (e) {
    return fail('NOT_FOUND', '活动不存在')
  }
}

/* ------------------------------ 审核动作 ------------------------------ */

/** 审核日志写入失败不影响审核结果本身，单独兜住异常 */
async function writeLog(data) {
  try {
    await auditLogs.add({ data })
  } catch (e) {
    console.error('[admin] 审核日志写入失败', e)
  }
}

async function getActivity(id) {
  if (!id) return null
  try {
    const res = await activities.doc(id).get()
    return res.data || null
  } catch (e) {
    return null
  }
}

/** 审核通过：活动随即在首页与广场可见 */
async function approve(event, openid, admin) {
  const id = text(event && event.id, 64)
  if (!id) return fail('INVALID_PARAM', '缺少活动 id')
  const doc = await getActivity(id)
  if (!doc) return fail('NOT_FOUND', '活动不存在')

  const from = auditStatusOf(doc)
  if (from === APPROVED) return fail('AUDIT_DONE', '该活动已通过审核')

  const now = Date.now()
  await activities.doc(id).update({
    data: {
      auditStatus: APPROVED,
      auditRemark: '',
      auditTime: now,
      auditBy: adminName(admin),
    },
  })
  await writeLog({
    activityId: id,
    title: doc.title || '',
    action: APPROVED,
    from,
    to: APPROVED,
    remark: '',
    adminOpenid: openid || '',
    adminName: adminName(admin),
    createTime: now,
  })
  return { id, auditStatus: APPROVED, auditTime: now }
}

/** 审核驳回：必须填写原因，发起人会在「我的发布」里看到它 */
async function reject(event, openid, admin) {
  const id = text(event && event.id, 64)
  if (!id) return fail('INVALID_PARAM', '缺少活动 id')
  const remark = text(event && event.remark, MAX_REMARK)
  if (!remark) return fail('INVALID_PARAM', '请填写驳回原因')

  const doc = await getActivity(id)
  if (!doc) return fail('NOT_FOUND', '活动不存在')

  const from = auditStatusOf(doc)
  const now = Date.now()
  await activities.doc(id).update({
    data: {
      auditStatus: REJECTED,
      auditRemark: remark,
      auditTime: now,
      auditBy: adminName(admin),
    },
  })
  await writeLog({
    activityId: id,
    title: doc.title || '',
    action: REJECTED,
    from,
    to: REJECTED,
    remark,
    adminOpenid: openid || '',
    adminName: adminName(admin),
    createTime: now,
  })
  return { id, auditStatus: REJECTED, auditRemark: remark, auditTime: now }
}

/* ------------------------------ 运维辅助 ------------------------------ */

/** 审核记录：默认最近 30 条，可按活动 id 过滤 */
async function logs(event) {
  const activityId = text(event && event.activityId, 64)
  const query = activityId ? auditLogs.where({ activityId }) : auditLogs
  try {
    const res = await query.orderBy('createTime', 'desc').limit(LOG_LIMIT).get()
    return { list: res.data.map(withId) }
  } catch (e) {
    // 集合不存在（还没产生过审核动作）时返回空列表
    return { list: [] }
  }
}

/**
 * 历史数据迁移：给审核能力上线前发布的活动补 approved。
 * 配合 activity 云函数里 nin 的写法，迁移前后前台可见范围完全一致，属于可重复执行的安全操作。
 */
async function migrate(event, openid, admin) {
  const res = await activities.where({ auditStatus: _.exists(false) }).update({
    data: { auditStatus: APPROVED, auditTime: Date.now(), auditBy: adminName(admin) },
  })
  const updated = (res.stats && res.stats.updated) || 0
  if (updated) {
    await writeLog({
      activityId: '',
      title: '',
      action: 'migrate',
      from: '',
      to: APPROVED,
      remark: `历史数据补审核状态 ${updated} 条`,
      adminOpenid: openid || '',
      adminName: adminName(admin),
      createTime: Date.now(),
    })
  }
  return { updated }
}

/* ------------------------------ 路由 ------------------------------ */

/** whoami 之外的 action 全部要求审核人身份 */
const ACTIONS = {
  whoami,
  list,
  detail,
  approve,
  reject,
  logs,
  migrate,
}

exports.main = async (event) => {
  const payload = event || {}
  const action = payload.action || ''
  const { OPENID } = cloud.getWXContext()
  const handler = ACTIONS[action]
  if (!handler) return fail('UNKNOWN_ACTION', `未知操作：${action}`)

  try {
    if (action === 'whoami') return await handler(payload, OPENID, null)
    const admin = await findAdmin(OPENID)
    if (!admin) return fail('FORBIDDEN', '无审核权限')
    return await handler(payload, OPENID, admin)
  } catch (err) {
    console.error(`[admin] ${action} 执行失败`, err)
    return fail('SERVER_ERROR', '服务异常，请稍后重试')
  }
}
