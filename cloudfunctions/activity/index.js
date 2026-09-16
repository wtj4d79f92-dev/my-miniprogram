// 旷行吖 · 活动云函数
// 统一 action 路由，与前端 services/api.js 的 cloudApi 一一对应。
// 约定：失败返回 { code, message }，成功直接返回业务数据（成功结构里不能出现 code 字段，
// 否则前端 callCloud 会当成失败）。
const cloud = require('wx-server-sdk')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

const db = cloud.database()
const _ = db.command

const { getType, typeGradient, supportsTags, supportsMetrics, sanitizeTags, DEFAULT_BANNERS } = require('./lib/dict')
const { normalizeCity, matchCity } = require('./lib/cities')
const {
  LIMITS,
  AVATAR_COLORS,
  fail,
  text,
  num,
  limitRange,
  escapeRegExp,
  memberOf,
  withId,
  txDoc,
} = require('./lib/helper')

const activities = db.collection('activities')
const users = db.collection('users')
const banners = db.collection('banners')
const feedbacks = db.collection('feedback')

const RECRUITING = 'recruiting'
const CLOSED = 'closed'
const DEFAULT_PAGE_SIZE = 10
const MAX_PAGE_SIZE = 100
/** 我的活动一次最多返回的条数（云函数端单次查询上限 100） */
const MY_LIST_LIMIT = 100

/* ------------------------------ 基础工具 ------------------------------ */

/** 集合为空时按 id 取不到会抛错，统一收敛成 null */
async function getActivity(id) {
  if (!id) return null
  try {
    const res = await activities.doc(String(id)).get()
    return res.data || null
  } catch (e) {
    return null
  }
}

async function findUser(openid) {
  if (!openid) return null
  const res = await users.where({ openid }).limit(1).get()
  return (res.data && res.data[0]) || null
}

/** 组装列表查询条件：等值条件走索引，关键字走正则 */
function buildWhere(query) {
  const conditions = []
  const city = normalizeCity(query.city)
  if (city) conditions.push({ city })
  if (query.type && query.type !== 'all') conditions.push({ type: String(query.type) })
  const weekday = num(query.weekday, -1)
  if (weekday >= 0 && weekday <= 6) conditions.push({ startWeekday: weekday })
  const keyword = text(query.keyword)
  if (keyword) {
    const reg = db.RegExp({ regexp: escapeRegExp(keyword), options: 'i' })
    conditions.push(_.or([{ title: reg }, { location: reg }]))
  }
  if (!conditions.length) return {}
  if (conditions.length === 1) return conditions[0]
  return _.and(conditions)
}

function whereToQuery(where) {
  return Object.keys(where).length ? activities.where(where) : activities
}

/** time -> 集合时间升序 / hot -> 报名数降序 / latest -> 发布时间降序 */
function applySort(query, sort) {
  if (sort === 'hot') return query.orderBy('joinedCount', 'desc')
  if (sort === 'latest') return query.orderBy('createTime', 'desc')
  return query.orderBy('startTime', 'asc')
}

/** 首页 / 广场只按城市过滤，不再叠加其它条件 */
function cityWhere(city) {
  const normalized = normalizeCity(city)
  return normalized ? { city: normalized } : {}
}

/* ------------------------------ 首页 / 列表 ------------------------------ */

/** banners 集合为空时写入默认 3 条（固定 _id，重复写入会失败，忽略即可） */
async function ensureBanners() {
  const res = await banners.count()
  if (res.total > 0) return
  for (let i = 0; i < DEFAULT_BANNERS.length; i += 1) {
    try {
      await banners.add({ data: Object.assign({}, DEFAULT_BANNERS[i]) })
    } catch (e) {
      // 并发写入时另一路已经插进去了，无需处理
    }
  }
}

async function home(event) {
  await ensureBanners()
  const where = cityWhere(event.city)

  const [bannerRes, hotRes, newestRes, countRes] = await Promise.all([
    banners.orderBy('sort', 'asc').limit(20).get(),
    whereToQuery(where).orderBy('joinedCount', 'desc').limit(6).get(),
    whereToQuery(where).orderBy('createTime', 'desc').limit(3).get(),
    whereToQuery(where).count(),
  ])

  return {
    banners: bannerRes.data.map(withId),
    hotList: hotRes.data.map(withId),
    newestList: newestRes.data.map(withId),
    empty: countRes.total === 0,
  }
}

async function list(event) {
  const query = event || {}
  const where = buildWhere(query)
  const pageIndex = Math.max(0, Math.floor(num(query.pageIndex, 0)))
  const pageSize = limitRange(Math.floor(num(query.pageSize, DEFAULT_PAGE_SIZE)), 1, MAX_PAGE_SIZE)
  const start = pageIndex * pageSize

  const [listRes, countRes] = await Promise.all([
    applySort(whereToQuery(where), query.sort).skip(start).limit(pageSize).get(),
    whereToQuery(where).count(),
  ])

  const total = countRes.total
  return {
    list: listRes.data.map(withId),
    hasMore: start + pageSize < total,
    total,
  }
}

async function detail(event, openid) {
  const doc = await getActivity(event.id)
  if (!doc) return null
  const item = withId(doc)
  const joinedPeople = item.joinedPeople || []
  item.joined = !!openid && joinedPeople.some((member) => member.openid === openid)
  item.isOrganizer = !!openid && !!item.organizer && item.organizer.openid === openid
  item.full = item.joinedCount >= item.maxPeople
  return item
}

/* ------------------------------ 发布 / 报名 ------------------------------ */

async function create(event, openid) {
  const user = await findUser(openid)
  if (!user) return fail('UNAUTHORIZED', '请先登录')

  const form = (event && event.form) || {}
  const type = getType(form.type)
  const title = text(form.title, LIMITS.title)
  const location = text(form.location, LIMITS.location)
  const groupQrCode = text(form.groupQrCode, LIMITS.url)
  const startTime = num(form.startTime, 0)
  const endTime = num(form.endTime, 0)

  if (!title) return fail('INVALID_PARAM', '请填写活动标题')
  if (!location) return fail('INVALID_PARAM', '请填写集合地点')
  if (!startTime || !endTime) return fail('INVALID_PARAM', '请选择活动时间')
  if (endTime < startTime) return fail('INVALID_PARAM', '返程时间不能早于集合时间')
  if (!groupQrCode) return fail('INVALID_PARAM', '请上传活动群二维码')

  const feeMode = form.feeMode === 'fixed' ? 'fixed' : 'aa'
  const doc = {
    type: type.key,
    typeName: type.name,
    emoji: type.emoji,
    color: type.color,
    bg: typeGradient(type.key),
    title,
    cover: text(form.cover, LIMITS.url),
    groupQrCode,
    desc: text(form.desc, LIMITS.desc),
    location,
    // 城市由服务端从集合地点文本匹配，不信前端传值
    city: matchCity(location),
    startTime,
    endTime,
    startWeekday: new Date(startTime).getDay(),
    difficulty: supportsMetrics(type.key) ? limitRange(Math.floor(num(form.difficulty, 0)), 0, 10) : 0,
    distance: supportsMetrics(type.key) ? num(form.distance, 0) : 0,
    elevationGain: supportsMetrics(type.key) ? num(form.elevationGain, 0) : 0,
    fee: feeMode === 'fixed' ? num(form.fee, 0) : 0,
    feeMode,
    maxPeople: limitRange(Math.floor(num(form.maxPeople, 10)), 2, 100),
    tags: supportsTags(type.key) ? sanitizeTags(form.tags) : [],
    joinedPeople: [],
    joinedCount: 0,
    organizer: memberOf(user),
    createTime: Date.now(),
    status: RECRUITING,
    miniQrCode: '',
  }

  const res = await activities.add({ data: doc })
  return withId(Object.assign({}, doc, { _id: res._id }))
}

async function join(event, openid) {
  if (!openid) return fail('UNAUTHORIZED', '请先登录')
  const user = await findUser(openid)
  if (!user) return fail('UNAUTHORIZED', '请先登录')

  const id = String((event && event.id) || '')
  if (!id) return fail('NOT_FOUND', '活动不存在或已下架')
  const member = memberOf(user)

  // 人数上限校验和写入必须在一个事务里，否则并发报名会把人数冲爆
  return db.runTransaction(async (transaction) => {
    const doc = await txDoc(transaction, 'activities', id)
    if (!doc) return fail('NOT_FOUND', '活动不存在或已下架')
    if (doc.status === CLOSED) return fail('ACTIVITY_CLOSED', '活动已关闭，无法报名')

    const joinedPeople = doc.joinedPeople || []
    if (joinedPeople.some((item) => item.openid === openid)) {
      // 重复报名按幂等处理，直接返回当前状态
      return Object.assign(withId(doc), { joined: true })
    }
    if (doc.joinedCount >= doc.maxPeople) return fail('ACTIVITY_FULL', '活动已满员')

    const next = joinedPeople.concat([member])
    await transaction.collection('activities').doc(id).update({
      data: { joinedPeople: next, joinedCount: next.length },
    })
    return Object.assign(withId(doc), {
      joinedPeople: next,
      joinedCount: next.length,
      joined: true,
    })
  })
}

async function quit(event, openid) {
  if (!openid) return fail('UNAUTHORIZED', '请先登录')
  const id = String((event && event.id) || '')
  if (!id) return fail('NOT_FOUND', '活动不存在或已下架')

  return db.runTransaction(async (transaction) => {
    const doc = await txDoc(transaction, 'activities', id)
    if (!doc) return fail('NOT_FOUND', '活动不存在或已下架')

    const joinedPeople = doc.joinedPeople || []
    const next = joinedPeople.filter((item) => item.openid !== openid)
    if (next.length !== joinedPeople.length) {
      await transaction.collection('activities').doc(id).update({
        data: { joinedPeople: next, joinedCount: next.length },
      })
    }
    return Object.assign(withId(doc), {
      joinedPeople: next,
      joinedCount: next.length,
      joined: false,
    })
  })
}

async function toggle(event, openid) {
  if (!openid) return fail('UNAUTHORIZED', '请先登录')
  const id = String((event && event.id) || '')
  const doc = await getActivity(id)
  if (!doc) return fail('NOT_FOUND', '活动不存在或已下架')
  // 关闭 / 打开只能由发起人操作：身份只认云函数上下文里的 openid
  if (!doc.organizer || doc.organizer.openid !== openid) {
    return fail('FORBIDDEN', '仅发起人可操作')
  }

  const status = doc.status === CLOSED ? RECRUITING : CLOSED
  await activities.doc(id).update({ data: { status } })
  return withId(Object.assign({}, doc, { status }))
}

/* ------------------------------ 我的活动 ------------------------------ */

async function mine(event, openid) {
  if (!openid) return fail('UNAUTHORIZED', '请先登录')
  const kind = (event && event.kind) || 'joined'

  if (kind === 'published') {
    const res = await activities
      .where({ 'organizer.openid': openid })
      .orderBy('createTime', 'desc')
      .limit(MY_LIST_LIMIT)
      .get()
    return res.data.map(withId)
  }

  const res = await activities
    .where({ 'joinedPeople.openid': openid })
    .orderBy('startTime', 'asc')
    .limit(MY_LIST_LIMIT)
    .get()
  return res.data.map(withId)
}

/* ------------------------------ 用户 ------------------------------ */

async function user(event, openid) {
  const doc = await findUser(openid)
  return withId(doc)
}

/** 云调用换取手机号：未配置权限或授权码失效时降级为空 */
async function phoneFromCode(code) {
  if (!code) return ''
  try {
    const res = await cloud.openapi.phonenumber.getPhoneNumber({ code })
    const info = (res && res.phoneInfo) || {}
    return info.purePhoneNumber || info.phoneNumber || ''
  } catch (e) {
    return ''
  }
}

async function login(event, openid) {
  if (!openid) return fail('UNAUTHORIZED', '登录失败，请重试')
  const payload = event || {}
  const profile = payload.profile || {}
  const phone = text(payload.phone, 20) || (await phoneFromCode(payload.phoneCode))

  const existed = await findUser(openid)
  if (existed) {
    const patch = {}
    if (phone && phone !== existed.phone) patch.phone = phone
    if (!existed.nickName) patch.nickName = phone ? `${phone.slice(0, 3)}****${phone.slice(-4)}` : '微信用户'
    if (!Object.keys(patch).length) return withId(existed)
    await users.doc(existed._id).update({ data: patch })
    return withId(Object.assign({}, existed, patch))
  }

  // 注册序号：openid 唯一索引才是真正的唯一约束，这里只用于展示，重复由并发概率决定
  const countRes = await users.count()
  const userId = countRes.total + 1
  const nickName = text(profile.nickName, LIMITS.nickName) || (phone ? `${phone.slice(0, 3)}****${phone.slice(-4)}` : '微信用户')
  const doc = {
    openid,
    userId,
    nickName,
    avatarUrl: text(profile.avatarUrl, LIMITS.url),
    avatarColor: AVATAR_COLORS[userId % AVATAR_COLORS.length],
    avatarText: nickName.slice(0, 1),
    phone,
    bio: '',
    createTime: Date.now(),
  }
  const res = await users.add({ data: doc })
  return withId(Object.assign({}, doc, { _id: res._id }))
}

/** 资料变更后同步已发布活动的发起人快照、已报名活动的成员快照 */
async function syncSnapshots(userDoc) {
  const snapshot = memberOf(userDoc)

  await activities.where({ 'organizer.openid': userDoc.openid }).update({
    data: { organizer: snapshot },
  })

  // 数组内元素无法定位替换，读出来改完写回；按 100 条分批，避免一次拉全表
  let skip = 0
  for (;;) {
    const res = await activities
      .where({ 'joinedPeople.openid': userDoc.openid })
      .skip(skip)
      .limit(100)
      .get()
    if (!res.data.length) break
    for (let i = 0; i < res.data.length; i += 1) {
      const doc = res.data[i]
      const joinedPeople = (doc.joinedPeople || []).map((member) =>
        member.openid === userDoc.openid ? snapshot : member
      )
      await activities.doc(doc._id).update({ data: { joinedPeople } })
    }
    if (res.data.length < 100) break
    skip += res.data.length
  }
}

async function updateUser(event, openid) {
  const existed = await findUser(openid)
  if (!existed) return fail('UNAUTHORIZED', '请先登录')

  const info = (event && event.userInfo) || {}
  const patch = {}
  if (info.nickName !== undefined) patch.nickName = text(info.nickName, LIMITS.nickName)
  if (info.avatarUrl !== undefined) patch.avatarUrl = text(info.avatarUrl, LIMITS.url)
  if (info.avatarColor !== undefined) patch.avatarColor = text(info.avatarColor, 20)
  if (info.bio !== undefined) patch.bio = text(info.bio, LIMITS.bio)
  if (info.phone !== undefined) patch.phone = text(info.phone, 20)
  if (!Object.keys(patch).length) return withId(existed)
  if (patch.nickName) patch.avatarText = patch.nickName.slice(0, 1)

  await users.doc(existed._id).update({ data: patch })
  const merged = Object.assign({}, existed, patch)
  await syncSnapshots(merged)
  return withId(merged)
}

/* ------------------------------ 小程序码 / 反馈 ------------------------------ */

async function qrcode(event) {
  const doc = await getActivity(event && event.id)
  if (!doc) return fail('NOT_FOUND', '活动不存在或已下架')
  if (doc.miniQrCode) return { fileID: doc.miniQrCode }

  try {
    const res = await cloud.openapi.wxacode.getUnlimited({
      scene: String(doc._id).slice(0, 32),
      page: 'pages/activity/detail/index',
      checkPath: false,
      envVersion: 'release',
      width: 430,
    })
    const uploaded = await cloud.uploadFile({
      cloudPath: `mini-qrcode/${doc._id}.png`,
      fileContent: res.buffer,
    })
    await activities.doc(doc._id).update({ data: { miniQrCode: uploaded.fileID } })
    return { fileID: uploaded.fileID }
  } catch (e) {
    return fail('QRCODE_FAILED', '小程序码生成失败')
  }
}

async function feedback(event, openid) {
  const content = text(event && event.content, LIMITS.feedback)
  if (!content) return fail('INVALID_PARAM', '请填写反馈内容')

  const userDoc = await findUser(openid)
  const doc = {
    openid: openid || '',
    content,
    nickName: (userDoc && userDoc.nickName) || '未登录用户',
    avatarUrl: (userDoc && userDoc.avatarUrl) || '',
    createTime: Date.now(),
    status: 'pending',
  }
  const res = await feedbacks.add({ data: doc })
  return { id: res._id, createTime: doc.createTime }
}

/* ------------------------------ 路由 ------------------------------ */

const ACTIONS = {
  home,
  list,
  detail,
  create,
  join,
  quit,
  toggle,
  mine,
  user,
  login,
  updateUser,
  qrcode,
  feedback,
}

exports.main = async (event) => {
  const payload = event || {}
  const action = payload.action || ''
  // 用户身份一律取自云函数上下文，不信任前端传入的 openid
  const { OPENID } = cloud.getWXContext()
  const handler = ACTIONS[action]
  if (!handler) return fail('UNKNOWN_ACTION', `未知操作：${action}`)

  try {
    return await handler(payload, OPENID)
  } catch (err) {
    console.error(`[activity] ${action} 执行失败`, err)
    return fail('SERVER_ERROR', '服务异常，请稍后重试')
  }
}
