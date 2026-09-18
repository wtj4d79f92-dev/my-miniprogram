// 旷行吖 · 活动云函数
// 统一 action 路由，与前端 services/api.js 的 cloudApi 一一对应。
// 约定：失败返回 { code, message }，成功直接返回业务数据（成功结构里不能出现 code 字段，
// 否则前端 callCloud 会当成失败）。
const cloud = require('wx-server-sdk')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

const db = cloud.database()
const _ = db.command

const { getType, typeGradient, supportsTags, supportsMetrics, sanitizeTags, DEFAULT_BANNERS } = require('./lib/dict')
const { matchCity, filterCityKeys, singleCityKey } = require('./lib/cities')
const {
  PENDING: AUDIT_PENDING,
  APPROVED: AUDIT_APPROVED,
  REJECTED: AUDIT_REJECTED,
  auditStatusOf,
  isApproved,
  publicAuditWhere,
} = require('./lib/audit')
const { AUTO_AUDIT_BY, checkableImageCount, canAutoApprove } = require('./lib/autoAudit')
// 送检文本的拼法只有一份：发布当刻与图片回调时的文本补检必须送同一段内容
const { textOf } = require('./lib/textCheck')
const {
  RISKY,
  QR_REJECT_REMARK,
  checkText,
  dispatchImages,
  checkQrCode,
  isQrRejected,
  summarize,
} = require('./lib/contentCheck')
const { MISSING, inspectFiles, collectFileIDs, resolveMedia } = require('./lib/media')
// 展示期：发布满 7 天的活动自动关闭，首页 / 广场不再展示（见 lib/expire.js）
const { TTL_MS, isExpired, expireTimeOf } = require('./lib/expire')
const {
  LIMITS,
  AVATAR_COLORS,
  fail,
  text,
  num,
  limitRange,
  coord,
  escapeRegExp,
  memberOf,
  publicActivity,
  withId,
  txDoc,
} = require('./lib/helper')

const activities = db.collection('activities')
const users = db.collection('users')
const banners = db.collection('banners')
const feedbacks = db.collection('feedback')
const auditLogs = db.collection('activity_audits')

const RECRUITING = 'recruiting'
const CLOSED = 'closed'
/** 展示期届满（发布后 7 天）后的统一提示，见 lib/expire.js */
const EXPIRE_JOIN_TEXT = '活动发布已超过 7 天，已自动关闭，无法报名'
const EXPIRE_TOGGLE_TEXT = '活动发布已超过 7 天，已自动关闭，无法重新打开'
const EXPIRE_EDIT_TEXT = '活动发布已超过 7 天，已自动关闭，无法修改，请重新发布'
const DEFAULT_PAGE_SIZE = 10
const MAX_PAGE_SIZE = 100
/** 一天的毫秒数：广场按「具体日期」筛选时用来把当天 00:00 换算成次日 00:00 */
const DAY_MS = 86400000
/** 我的活动一次最多返回的条数（云函数端单次查询上限 100） */
const MY_LIST_LIMIT = 100
/** 到期自动关闭一次处理的活动条数（定时任务分批处理，与云数据库单次查询上限一致） */
const EXPIRE_BATCH = 100
/** 默认横幅的历史动作：仅当后台仍保持该动作时，才按最新默认值升级 */
const LEGACY_BANNER_ACTIONS = [{ _id: 'banner_default_3', action: { type: 'publish' } }]
/**
 * 公开可见条件（审核中 / 未通过不可见）。
 * 每次调用都返回新的指令对象，避免同一个 db.command 实例在多条查询之间复用。
 */
function auditVisibleWhere() {
  return { auditStatus: publicAuditWhere(_) }
}

/** 未关闭条件：`nin` 同时命中缺 status 字段的历史数据，存量活动不会因此消失 */
function notClosedWhere() {
  return { status: _.nin([CLOSED]) }
}

/**
 * 未过展示期的条件：展示期 = 发布后 7 天（见 lib/expire.js）。
 * 首页与广场都带上它，所以即便「到期自动关闭」的定时任务还没跑，过期活动也不会露出来。
 * 反向条件（createTime < 到期线）就是定时任务要关闭的那批活动。
 */
function notExpiredWhere() {
  return { createTime: _.gt(Date.now() - TTL_MS) }
}

/** 当天 00:00 的时间戳：广场据此判断已关闭的活动是否还在「关闭当天」 */
function startOfToday() {
  const d = new Date()
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

/** 已关闭且仍在「关闭当天」的条件：广场只保留关闭当天，次日不再展示 */
function closedTodayWhere() {
  return { status: CLOSED, closeTime: _.gte(startOfToday()) }
}

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

/**
 * 城市条件：省份用 in 命中全省城市，城市（含直辖市）用等值命中单城。
 * 「全部」传空值，返回 null 表示不加城市条件。
 */
function cityCondition(city) {
  const keys = filterCityKeys(city)
  if (!keys.length) return null
  return keys.length === 1 ? { city: keys[0] } : { city: _.in(keys) }
}

/** 组装列表查询条件数组：等值条件走索引，关键字走正则 */
function buildConditions(query) {
  // 审核条件恒为第一个：非公开状态的活动不能出现在列表里
  // 展示期条件恒为第二个：发布满 7 天的活动从广场消失（见 notExpiredWhere）
  const conditions = [auditVisibleWhere(), notExpiredWhere()]
  const city = cityCondition(query.city)
  if (city) conditions.push(city)
  if (query.type && query.type !== 'all') conditions.push({ type: String(query.type) })
  const weekday = num(query.weekday, -1)
  if (weekday >= 0 && weekday <= 6) conditions.push({ startWeekday: weekday })
  // 广场的「具体日期」筛选：date 是客户端算好的当天 00:00 时间戳，这里换算成 [当天, 次日) 区间
  const dayStart = num(query.date, 0)
  if (dayStart > 0) {
    // 同一个字段上前闭后开两条条件，交给外层 _.and 组合（与 city / type 等条件写法一致）
    conditions.push({ startTime: _.gte(dayStart) })
    conditions.push({ startTime: _.lt(dayStart + DAY_MS) })
  }
  const keyword = text(query.keyword)
  if (keyword) {
    const reg = db.RegExp({ regexp: escapeRegExp(keyword), options: 'i' })
    // locationAddress 不展示，但要能被搜到：用户按「双流」这类地址关键词也能找到活动
    conditions.push(_.or([{ title: reg }, { location: reg }, { locationAddress: reg }]))
  }
  return conditions
}

/** 条件数组 -> 查询条件：只有一个条件时直接用，避免多包一层 _.and */
function whereFrom(conditions) {
  return conditions.length === 1 ? conditions[0] : _.and(conditions)
}

function whereToQuery(where) {
  // buildConditions / cityWhere 始终返回非空条件（含审核可见性），这里不再做空条件兜底
  return activities.where(where)
}

/** time -> 集合时间升序 / hot -> 报名数降序 / latest -> 发布时间降序 */
function applySort(query, sort) {
  if (sort === 'hot') return query.orderBy('joinedCount', 'desc')
  if (sort === 'latest') return query.orderBy('createTime', 'desc')
  return query.orderBy('startTime', 'asc')
}

/**
 * 首页只按城市过滤，不再叠加其它条件。
 * 首页是推荐位，已关闭的活动不进热门 / 最新（关闭后只在广场保留关闭当天）。
 */
function cityWhere(city) {
  const conditions = [auditVisibleWhere(), notClosedWhere(), notExpiredWhere()]
  const target = cityCondition(city)
  if (target) conditions.push(target)
  return whereFrom(conditions)
}

/**
 * 给活动补上云存储临时链接。
 *
 * 封面 / 群二维码以 cloud:// 文件 ID 落库，客户端能不能直接渲染取决于云存储读取权限 /
 * 安全规则；首页、广场、详情展示的往往是别人上传的文件，一旦被拦就只能看到默认海报。
 * 这里用云函数的管理员身份统一换成 https 临时链接，换不到时不下发该字段，前端退回原始值。
 *
 * @param {Object} item 单个活动对象（原地写入 coverUrl / qrUrl）
 * @param {string[]} fields 需要解析的字段，默认只解析封面
 */
async function attachMediaUrls(item, fields) {
  if (!item) return item
  const keys = fields || ['cover']
  const media = await resolveMedia(collectFileIDs([item], keys))
  const mapping = { cover: 'coverUrl', groupQrCode: 'qrUrl' }
  keys.forEach((key) => {
    const entry = media[item[key]]
    if (entry && entry.url) item[mapping[key] || `${key}Url`] = entry.url
  })
  return item
}

/** 列表版：一次拿齐整页的封面，避免逐条调用云存储接口 */
function attachCoverUrls(rows) {
  const list = rows || []
  if (!list.length) return Promise.resolve(list)
  return resolveMedia(collectFileIDs(list, ['cover'])).then((media) => {
    list.forEach((item) => {
      const entry = media[item.cover]
      if (entry && entry.url) item.coverUrl = entry.url
    })
    return list
  })
}

/* ------------------------------ 首页 / 列表 ------------------------------ */

/** banners 集合为空时写入默认 3 条（固定 _id，重复写入会失败，忽略即可） */
async function ensureBanners() {
  const res = await banners.count()
  if (res.total > 0) {
    await upgradeDefaultBannerActions()
    return
  }
  for (let i = 0; i < DEFAULT_BANNERS.length; i += 1) {
    try {
      await banners.add({ data: Object.assign({}, DEFAULT_BANNERS[i]) })
    } catch (e) {
      // 并发写入时另一路已经插进去了，无需处理
    }
  }
}

/**
 * 默认横幅历史动作纠正：老环境里「想去看海呀」写的是「去发布」，
 * 后台没改过 action 时按最新默认值纠成「广场 + 自驾游」，避免点了落错页面。
 * 只处理固定 _id、标题与动作都还是默认值的文档，后台自定义过的配置不受影响。
 */
async function upgradeDefaultBannerActions() {
  for (let i = 0; i < LEGACY_BANNER_ACTIONS.length; i += 1) {
    const legacy = LEGACY_BANNER_ACTIONS[i]
    const target = DEFAULT_BANNERS.filter((item) => item._id === legacy._id)[0]
    if (!target) continue
    if (sameAction(legacy.action, target.action)) continue
    try {
      const res = await banners.doc(legacy._id).get()
      const doc = res && res.data
      if (!doc || doc.title !== target.title || !sameAction(doc.action, legacy.action)) continue
      await banners.doc(legacy._id).update({ data: { action: target.action } })
    } catch (e) {
      // 文档不存在 / 已被后台删除时忽略
    }
  }
}

function sameAction(a, b) {
  const left = a || {}
  const right = b || {}
  return (left.type || '') === (right.type || '') && (left.value || '') === (right.value || '')
}

async function home(event, openid) {
  await ensureBanners()
  const where = cityWhere(event.city)

  const [bannerRes, hotRes, newestRes, countRes] = await Promise.all([
    banners.orderBy('sort', 'asc').limit(20).get(),
    whereToQuery(where).orderBy('joinedCount', 'desc').limit(6).get(),
    whereToQuery(where).orderBy('createTime', 'desc').limit(3).get(),
    whereToQuery(where).count(),
  ])

  const hotList = hotRes.data.map((doc) => publicActivity(doc, openid))
  const newestList = newestRes.data.map((doc) => publicActivity(doc, openid))
  await Promise.all([attachCoverUrls(hotList), attachCoverUrls(newestList)])

  return {
    banners: bannerRes.data.map(withId),
    hotList,
    newestList,
    empty: countRes.total === 0,
  }
}

/**
 * 广场列表：未关闭的活动在前、已关闭的在后，两种状态各查一次再拼成一页。
 * 已关闭的活动只在关闭当天可见（closeTime 落在今天），第二天起从广场消失；
 * 拆成两条查询而不是加 `orderBy('status')`，既不用为多字段排序建复合索引，
 * 分页也不会把已关闭的活动混到未关闭的前面。
 */
async function list(event, openid) {
  const query = event || {}
  const pageIndex = Math.max(0, Math.floor(num(query.pageIndex, 0)))
  const pageSize = limitRange(Math.floor(num(query.pageSize, DEFAULT_PAGE_SIZE)), 1, MAX_PAGE_SIZE)
  const start = pageIndex * pageSize
  const conditions = buildConditions(query)

  const openedWhere = whereFrom(conditions.concat([notClosedWhere()]))
  const closedWhere = whereFrom(conditions.concat([closedTodayWhere()]))

  const [openedCountRes, closedCountRes] = await Promise.all([
    whereToQuery(openedWhere).count(),
    whereToQuery(closedWhere).count(),
  ])
  const openedCount = openedCountRes.total
  const closedCount = closedCountRes.total
  const total = openedCount + closedCount

  // 已关闭的全部排在未关闭之后：先取完这页里未关闭的剩余部分，再用已关闭的补齐
  const openedStart = Math.min(start, openedCount)
  const openedLimit = Math.max(0, Math.min(pageSize, openedCount - openedStart))
  const closedStart = Math.max(0, start - openedCount)
  const closedLimit = pageSize - openedLimit

  const [openedRes, closedRes] = await Promise.all([
    openedLimit > 0
      ? applySort(whereToQuery(openedWhere), query.sort).skip(openedStart).limit(openedLimit).get()
      : Promise.resolve({ data: [] }),
    closedLimit > 0
      ? applySort(whereToQuery(closedWhere), query.sort).skip(closedStart).limit(closedLimit).get()
      : Promise.resolve({ data: [] }),
  ])

  const rows = openedRes.data.concat(closedRes.data).map((doc) => publicActivity(doc, openid))
  await attachCoverUrls(rows)

  return {
    list: rows,
    hasMore: start + pageSize < total,
    total,
  }
}

async function detail(event, openid) {
  const doc = await getActivity(event.id)
  if (!doc) return null
  const organizer = doc.organizer || {}
  // 审核中 / 未通过的活动只有发起人自己能预览，其他人一律按「不存在」处理
  if (!isApproved(doc) && organizer.openid !== openid) return null
  // 对外输出统一脱敏：joined / isOrganizer 已由 publicActivity 按当前用户算好
  const item = publicActivity(doc, openid)
  item.full = item.joinedCount >= item.maxPeople
  await attachMediaUrls(item, ['cover', 'groupQrCode'])
  return item
}

/* ------------------------------ 发布 / 报名 ------------------------------ */

/**
 * 表单 -> 活动字段，发布（create）与编辑（update）共用同一套校验，
 * 避免两条路径的规则慢慢跑偏。校验失败返回 { error }，成功返回 { data }。
 */
function normalizeForm(form) {
  const type = getType(form.type)
  const title = text(form.title, LIMITS.title)
  const location = text(form.location, LIMITS.location)
  const locationAddress = text(form.locationAddress, LIMITS.locationAddress)
  const groupQrCode = text(form.groupQrCode, LIMITS.url)
  const startTime = num(form.startTime, 0)
  const endTime = num(form.endTime, 0)

  if (!title) return { error: fail('INVALID_PARAM', '请填写活动标题') }
  if (!location) return { error: fail('INVALID_PARAM', '请填写集合地点') }
  if (!startTime || !endTime) return { error: fail('INVALID_PARAM', '请选择活动时间') }
  if (endTime < startTime) return { error: fail('INVALID_PARAM', '返程时间不能早于集合时间') }
  if (!groupQrCode) return { error: fail('INVALID_PARAM', '请上传活动群二维码') }

  // 费用方式必须由发起人主动选择：AA 制 / 非 AA 制。
  // 平台不收取任何资金，非 AA 制只接受一段文字说明（如「门票自理」「人均约 80 元现场分摊」），
  // 不收金额数字，也不产生任何支付行为。历史数据里的 feeMode: 'fixed' 视为非 AA 制。
  const rawFeeMode = form.feeMode === 'nonAA' || form.feeMode === 'fixed' ? 'nonAA' : form.feeMode === 'aa' ? 'aa' : ''
  if (!rawFeeMode) return { error: fail('INVALID_PARAM', '请选择费用方式（AA 制 / 非 AA 制）') }
  const feeNote = text(form.feeNote, LIMITS.feeNote)
  if (rawFeeMode === 'nonAA' && !feeNote) {
    return { error: fail('INVALID_PARAM', '非 AA 制活动需填写费用说明（平台不收取任何资金）') }
  }
  const feeMode = rawFeeMode
  return {
    data: {
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
      // 地图选点带上来的完整地址（不展示）：城市优先按它匹配，手输时退回地点文本；city 一律由服务端算，不信前端传值
      locationAddress,
      // 地图选点带出来的坐标（不展示）：详情页 / 广场卡片点地址时直接用它调起地图导航；
      // 手输地址的活动没有坐标，存 0，前端按地址文本解析后再开地图
      locationLat: coord(form.locationLat, 'lat'),
      locationLng: coord(form.locationLng, 'lng'),
      // 地址里认不出城市（手输「双流区润和路附近」这类缺省市的短地址）时，退回发布者当前城市
      // （前端随表单上送的 cityHint，只认唯一城市，省份 / 全国一律不采用），
      // 否则 city 为空，这条活动按城市筛选时永远查不到
      city: matchCity(locationAddress || location) || singleCityKey(form.cityHint),
      startTime,
      endTime,
      startWeekday: new Date(startTime).getDay(),
      difficulty: supportsMetrics(type.key) ? limitRange(Math.floor(num(form.difficulty, 0)), 0, 10) : 0,
      distance: supportsMetrics(type.key) ? num(form.distance, 0) : 0,
      elevationGain: supportsMetrics(type.key) ? num(form.elevationGain, 0) : 0,
      feeMode,
      feeNote: feeMode === 'nonAA' ? feeNote : '',
      maxPeople: limitRange(Math.floor(num(form.maxPeople, 10)), 2, 100),
      tags: supportsTags(type.key) ? sanitizeTags(form.tags) : [],
    },
  }
}

/** 提交审核：清掉上一次的审核结论与意见 */
function auditPatch() {
  return {
    auditStatus: AUDIT_PENDING,
    auditRemark: '',
    auditTime: 0,
    auditBy: '',
    // 待审队列按提交时间排序，编辑重提的活动会重新排到最前面
    submitTime: Date.now(),
  }
}

/** 上传失败时按字段给不同的提示，用户在发布页能直接对上要重传哪一张 */
const UPLOAD_FAIL_TEXT = {
  cover: '封面图片上传失败，请重新选择图片后再提交',
  groupQrCode: '活动群二维码上传失败，请重新上传后再提交',
}

/**
 * 写库前的云存储校验：封面 / 二维码都是本机图片先转存云存储换来的 fileID，
 * 只有「云函数也读不到这个文件」才拦下发布，其余情况（接口抖动、无法判定）放行。
 */
async function checkUploads(data) {
  const entries = [
    ['cover', data.cover],
    ['groupQrCode', data.groupQrCode],
  ].filter((entry) => String(entry[1] || '').indexOf('cloud://') === 0)
  if (!entries.length) return null

  const states = await inspectFiles(entries.map((entry) => entry[1]))
  const bad = entries.filter((entry) => states[entry[1]] === MISSING)[0]
  if (!bad) return null
  console.error('[activity] 云存储文件不存在，拦截发布', bad[0], bad[1])
  return fail('UPLOAD_FAILED', UPLOAD_FAIL_TEXT[bad[0]] || '图片上传失败，请重新上传后再提交')
}

/** 审核日志属于辅助信息，写失败不能影响业务结果 */
async function writeLog(data) {
  try {
    await auditLogs.add({ data: Object.assign({ createTime: Date.now() }, data) })
  } catch (e) {
    console.error('[activity] 审核日志写入失败', e)
  }
}

/**
 * 机器初审：文本同步检测 + 图片异步发起 + 群二维码同步识别。
 * - 文本命中违规：直接拦下，不写库（避免违规内容进库），由发起人改完重发；
 * - 图片只有 traceId，结果由消息推送回调补写，这里先记 pending；
 * - 群二维码识别只认微信群邀请链接，识别不出 / 不是群链接直接驳回（详见 qrRejectPatch 与 lib/contentCheck.js）；
 * - 检测接口本身失败：降级为纯人工审核（待审队列），既不阻塞发布也不误驳。
 */
async function runMachineCheck(fields, openid) {
  const textResult = await checkText(textOf(fields), openid)
  if (textResult.suggest === RISKY) {
    await writeLog({
      activityId: '',
      title: fields.title || '',
      action: 'blocked-text',
      remark: `文本内容安全检测判定违规（label=${textResult.label}）`,
      adminOpenid: '',
      adminName: '内容安全检测',
    })
    return { blocked: true, reason: '内容未通过安全检测，请修改后重新提交' }
  }

  // 图片送检与二维码识别互不依赖，并行跑省掉一次往返
  const [images, qrcode] = await Promise.all([
    dispatchImages([fields.cover, fields.groupQrCode], openid),
    checkQrCode(fields.groupQrCode),
  ])
  const machineCheck = { text: textResult, images, qrcode, checkedAt: Date.now() }
  return Object.assign({ machineCheck }, summarize(textResult, images))
}

/**
 * 机审直接放行：文本检测与群二维码识别都是同步的，发布当刻就有结论；
 * 只有封面 / 群二维码的图片内容安全结论要等 mediaCheckAsync 的回调，
 * 有可送检图片时不置「已通过」——否则没检完的图片就直接上线了；那一步由 contentCheck 云函数用同一套规则判定。
 * 机审没通过时返回空对象，沿用 auditPatch() 的待审状态交给人工。
 */
function autoAuditPatch(machine, data) {
  const checkable = checkableImageCount([data.cover, data.groupQrCode])
  if (!canAutoApprove(machine && machine.machineCheck, checkable)) return {}
  return {
    auditStatus: AUDIT_APPROVED,
    auditRemark: '',
    auditTime: Date.now(),
    auditBy: AUTO_AUDIT_BY,
  }
}

/**
 * 群二维码没识别出微信群邀请链接：直接驳回，不进人工队列。
 * 发起人在详情页与「我的发布」看到「未通过原因：活动二维码上传有误，请重新上传微信群二维码」，
 * 改好二维码重新提交即可（重提会重新走一遍检测）。
 *
 * 识别接口异常 / 超时（failed）属于「没有结论」，返回空对象沿用待审状态，绝不因为检测本身出问题驳回用户。
 */
function qrRejectPatch(machine) {
  if (!isQrRejected(machine && machine.machineCheck && machine.machineCheck.qrcode)) return {}
  return {
    auditStatus: AUDIT_REJECTED,
    auditRemark: QR_REJECT_REMARK,
    auditTime: Date.now(),
    auditBy: AUTO_AUDIT_BY,
  }
}

/** 机审放行同样要留痕：审核日志里能看出这条活动不是人工放行的 */
async function writeAutoApproveLog(activityId, title, patch, from) {
  if (!patch || patch.auditStatus !== AUDIT_APPROVED) return
  await writeLog({
    activityId,
    title: title || '',
    action: 'auto-approve',
    from: from || '',
    to: AUDIT_APPROVED,
    remark: '机审通过（文本检测与二维码识别均无异常，且没有可送检图片），自动放行',
    adminOpenid: '',
    adminName: AUTO_AUDIT_BY,
  })
}

/** 二维码驳回同样要留痕：审核日志里能看出这条活动不是人工驳回的 */
async function writeQrRejectLog(activityId, title, patch, from) {
  if (!patch || patch.auditStatus !== AUDIT_REJECTED) return
  await writeLog({
    activityId,
    title: title || '',
    action: 'auto-reject',
    from: from || '',
    to: AUDIT_REJECTED,
    remark: `机审驳回：${QR_REJECT_REMARK}（群二维码未识别出微信群邀请链接）`,
    adminOpenid: '',
    adminName: AUTO_AUDIT_BY,
  })
}

async function create(event, openid) {
  const user = await findUser(openid)
  if (!user) return fail('UNAUTHORIZED', '请先登录')

  const normalized = normalizeForm((event && event.form) || {})
  if (normalized.error) return normalized.error

  const uploadError = await checkUploads(normalized.data)
  if (uploadError) return uploadError

  const machine = await runMachineCheck(normalized.data, openid)
  if (machine.blocked) return fail('CONTENT_RISKY', machine.reason)

  const auto = autoAuditPatch(machine, normalized.data)
  const reject = qrRejectPatch(machine)
  // reject 写在 auto 之后：二维码有明确结论时覆盖待审状态，不留「审核中」的可能
  const doc = Object.assign({}, normalized.data, auditPatch(), machine, auto, reject, {
    joinedPeople: [],
    joinedCount: 0,
    organizer: memberOf(user),
    createTime: Date.now(),
    status: RECRUITING,
    // 关闭时间：未关闭恒为 0，广场据此判断已关闭的活动是否还在关闭当天
    closeTime: 0,
    miniQrCode: '',
  })

  const res = await activities.add({ data: doc })
  await writeAutoApproveLog(res._id, doc.title, auto, '')
  await writeQrRejectLog(res._id, doc.title, reject, AUDIT_PENDING)
  return publicActivity(Object.assign({}, doc, { _id: res._id }), openid)
}

/**
 * 编辑已发布活动：仅发起人可操作。
 * 任何改动都会重新进入审核队列 —— 否则先发一条合规活动过审、再改成违规内容就绕过了审核。
 */
async function update(event, openid) {
  if (!openid) return fail('UNAUTHORIZED', '请先登录')
  const id = String((event && event.id) || '')
  if (!id) return fail('NOT_FOUND', '活动不存在或已下架')

  const doc = await getActivity(id)
  if (!doc) return fail('NOT_FOUND', '活动不存在或已下架')
  if (!doc.organizer || doc.organizer.openid !== openid) return fail('FORBIDDEN', '仅发起人可修改')
  // 展示期届满的活动已自动关闭，改完也不会再展示，直接拒绝（免得用户改完才发现白改）
  if (isExpired(doc)) return fail('ACTIVITY_EXPIRED', EXPIRE_EDIT_TEXT)

  const normalized = normalizeForm((event && event.form) || {})
  if (normalized.error) return normalized.error

  const uploadError = await checkUploads(normalized.data)
  if (uploadError) return uploadError

  const machine = await runMachineCheck(normalized.data, openid)
  if (machine.blocked) return fail('CONTENT_RISKY', machine.reason)

  // 报名成员、发起人快照、创建时间保持不变，只覆盖表单字段
  const auto = autoAuditPatch(machine, normalized.data)
  const reject = qrRejectPatch(machine)
  const patch = Object.assign({}, normalized.data, auditPatch(), machine, auto, reject)
  await activities.doc(id).update({ data: patch })
  await writeAutoApproveLog(id, patch.title, auto, auditStatusOf(doc))
  await writeQrRejectLog(id, patch.title, reject, auditStatusOf(doc))
  return publicActivity(Object.assign({}, doc, patch), openid)
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
    if (!isApproved(doc)) return fail('AUDIT_PENDING', '活动审核通过后才能报名')
    if (isExpired(doc)) return fail('ACTIVITY_EXPIRED', EXPIRE_JOIN_TEXT)
    if (doc.status === CLOSED) return fail('ACTIVITY_CLOSED', '活动已关闭，无法报名')

    const joinedPeople = doc.joinedPeople || []
    if (joinedPeople.some((item) => item.openid === openid)) {
      // 重复报名按幂等处理，直接返回当前状态
      return publicActivity(doc, openid)
    }
    if (doc.joinedCount >= doc.maxPeople) return fail('ACTIVITY_FULL', '活动已满员')

    const next = joinedPeople.concat([member])
    await transaction.collection('activities').doc(id).update({
      data: { joinedPeople: next, joinedCount: next.length },
    })
    return publicActivity(Object.assign({}, doc, { joinedPeople: next, joinedCount: next.length }), openid)
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
    return publicActivity(Object.assign({}, doc, { joinedPeople: next, joinedCount: next.length }), openid)
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
  if (!isApproved(doc)) return fail('AUDIT_PENDING', '活动审核通过后才能开启或关闭')
  // 过了展示期的活动不能重新打开：展示期是按发布时间算的，重开也不会再出现在广场
  if (isExpired(doc)) return fail('ACTIVITY_EXPIRED', EXPIRE_TOGGLE_TEXT)

  const closing = doc.status !== CLOSED
  const status = closing ? CLOSED : RECRUITING
  // 关闭时记录关闭时间（广场只保留关闭当天），重新打开时归零
  const closeTime = closing ? Date.now() : 0
  await activities.doc(id).update({ data: { status, closeTime } })
  return publicActivity(Object.assign({}, doc, { status, closeTime }), openid)
}

/* ------------------------------ 我的活动 ------------------------------ */

async function mine(event, openid) {
  if (!openid) return fail('UNAUTHORIZED', '请先登录')
  const kind = (event && event.kind) || 'joined'

  if (kind === 'published') {
    // 我发布的：不做审核过滤，发起人要看得到自己审核中 / 未通过的活动
    const res = await activities
      .where({ 'organizer.openid': openid })
      .orderBy('createTime', 'desc')
      .limit(MY_LIST_LIMIT)
      .get()
    const rows = res.data.map((doc) => publicActivity(doc, openid))
    await attachCoverUrls(rows)
    return rows
  }

  const res = await activities
    // 我参与的：同样不过滤审核状态，报名后活动被发起人改动重新送审时不能凭空消失
    .where({ 'joinedPeople.openid': openid })
    .orderBy('startTime', 'asc')
    .limit(MY_LIST_LIMIT)
    .get()
  const rows = res.data.map((doc) => publicActivity(doc, openid))
  await attachCoverUrls(rows)
  return rows
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

/** 历史版本用手机号掩码（138****8888）当默认昵称，等于把手机号前后各 4 位公开给其他用户 */
const MASKED_PHONE_NICK = /^\d{3}\*{4}\d{4}$/

/**
 * 默认昵称：昵称会展示在活动卡片、详情页与本活动的报名名单里（对外可见），
 * 因此不能使用手机号（哪怕是掩码），统一用「微信用户 + 用户编号」，既能区分又不含个人信息。
 */
function defaultNickName(userId) {
  const id = Math.floor(num(userId, 0))
  return id > 0 ? `微信用户${id}` : '微信用户'
}

async function login(event, openid) {
  if (!openid) return fail('UNAUTHORIZED', '登录失败，请重试')
  const payload = event || {}
  const profile = payload.profile || {}
  const profileNick = text(profile.nickName, LIMITS.nickName)
  // 手机号只能由微信手机号授权 code 在服务端兑换，不接受前端直接传入的号码
  // （前端传值等于任何人拿到 AppID 就能给自己的账号写任意手机号）
  const phone = await phoneFromCode(payload.phoneCode)
  // 昵称对外可见：前端直接带上来的昵称同样要过一遍内容安全，不能因为叫「登录」就跳过
  if (profileNick) {
    const checked = await checkText(profileNick, openid)
    if (checked.suggest === RISKY) return fail('CONTENT_RISKY', '昵称包含违规内容，请修改后重试')
  }

  const existed = await findUser(openid)
  if (existed) {
    const patch = {}
    if (phone && phone !== existed.phone) patch.phone = phone
    // 没填昵称、或昵称还是历史遗留的手机号掩码时，就地改成默认昵称
    if (!existed.nickName || MASKED_PHONE_NICK.test(existed.nickName)) {
      patch.nickName = defaultNickName(existed.userId)
      patch.avatarText = patch.nickName.slice(0, 1)
    }
    if (!Object.keys(patch).length) return withId(existed)
    await users.doc(existed._id).update({ data: patch })
    const merged = Object.assign({}, existed, patch)
    // 昵称变了要连带刷新已发布 / 已报名活动里的快照，否则手机号掩码还留在公开列表上
    if (patch.nickName) await syncSnapshots(merged)
    return withId(merged)
  }

  // 注册序号：openid 唯一索引才是真正的唯一约束，这里只用于展示，重复由并发概率决定
  const countRes = await users.count()
  const userId = countRes.total + 1
  const nickName = profileNick || defaultNickName(userId)
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
  if (info.nickName !== undefined) {
    const nickName = text(info.nickName, LIMITS.nickName)
    // 昵称是公开可见的 UGC（活动卡片、报名名单都会展示），和活动文案一样必须先过内容安全
    const checked = await checkText(nickName, openid)
    if (checked.suggest === RISKY) return fail('CONTENT_RISKY', '昵称包含违规内容，请修改后重试')
    patch.nickName = nickName
  }
  if (info.avatarUrl !== undefined) patch.avatarUrl = text(info.avatarUrl, LIMITS.url)
  if (info.avatarColor !== undefined) patch.avatarColor = text(info.avatarColor, 20)
  if (info.bio !== undefined) patch.bio = text(info.bio, LIMITS.bio)
  // 手机号只能由「手机号快捷登录」在服务端用微信下发的 code 兑换后写入，
  // 资料编辑不接受手机号字段，避免绕过微信校验写入未经核实的号码
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
      // 小程序码指向哪个版本：正式版 release（默认）。首审 / 内测阶段小程序还没发布，
      // release 会生成失败（海报退化成占位文案），可在云函数环境变量里把 WXACODE_ENV 设成 trial。
      envVersion: process.env.WXACODE_ENV || 'release',
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
  // 反馈内容不对外展示，但同样是用户提交的文本，和活动文案 / 昵称一样先过一遍内容安全
  const checked = await checkText(content, openid)
  if (checked.suggest === RISKY) return fail('CONTENT_RISKY', '反馈内容包含违规内容，请修改后重试')

  const userDoc = await findUser(openid)
  const doc = {
    kind: 'feedback',
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

/* ------------------------------ 举报 ------------------------------ */

/**
 * 举报原因候选：只接受固定选项。
 * 自由文本要额外送内容安全，而举报本身是给运营的人工线索，固定选项足够，也避免被当成发广告的入口。
 */
const REPORT_REASONS = ['虚假信息或诈骗', '违法违规内容', '侵权或盗用他人内容', '广告骚扰', '其他']
/** 举报记录状态：待运营复核 */
const REPORT_PENDING = 'pending'

/**
 * 举报活动：登录用户可提交，记录落在 feedback 集合里（`kind: 'report'`）供运营复核。
 *
 * 刻意不另开集合：feedback 已经是必建集合，权限由运营按「仅云函数读写」配置好了，
 * 举报记录跟反馈一样带着 openid 与昵称，复用同一个集合既能天然继承权限，
 * 也能在注销账号时跟着 feedback 一起清掉，不会留下孤儿个人信息。
 * 举报不参与机审放行，也不改活动状态 —— 是否下架由运营判断，避免被恶意举报当成下架工具。
 */
async function report(event, openid) {
  if (!openid) return fail('UNAUTHORIZED', '请先登录')
  const id = String((event && event.id) || '')
  if (!id) return fail('NOT_FOUND', '活动不存在或已下架')
  const reason = text(event && event.reason, 30)
  if (REPORT_REASONS.indexOf(reason) === -1) return fail('INVALID_PARAM', '请选择举报原因')

  const doc = await getActivity(id)
  if (!doc) return fail('NOT_FOUND', '活动不存在或已下架')

  const userDoc = await findUser(openid)
  const record = {
    kind: 'report',
    activityId: id,
    title: doc.title || '',
    organizerOpenid: (doc.organizer && doc.organizer.openid) || '',
    reason,
    openid,
    nickName: (userDoc && userDoc.nickName) || '',
    status: REPORT_PENDING,
    createTime: Date.now(),
  }
  try {
    const res = await feedbacks.add({ data: record })
    return { id: res._id, status: record.status, createTime: record.createTime }
  } catch (e) {
    console.error('[activity] 举报写入失败', e)
    return fail('SERVER_ERROR', '举报提交失败，请稍后重试')
  }
}

/* ------------------------------ 注销账号 ------------------------------ */

/** 单批处理条数：与云数据库单次查询上限一致，避免一次把全表拉进内存 */
const DELETE_BATCH = 100
/** cloud.deleteFile 单次最多 50 个文件 */
const FILE_BATCH = 50
/** 活动文档里需要跟随活动一起清理的云存储文件 */
const ACTIVITY_FILES = ['cover', 'groupQrCode', 'miniQrCode']

/**
 * 删除该用户发布的所有活动，并把它们的云存储文件（封面、群二维码、小程序码）收集出来。
 * 活动删掉后这些文件不再有入口引用，留着只会占空间，也违背「删除个人信息」的承诺。
 */
async function removeOwnActivities(openid) {
  const fileIDs = []
  let removed = 0
  for (;;) {
    const res = await activities.where({ 'organizer.openid': openid }).limit(DELETE_BATCH).get()
    const rows = res.data || []
    if (!rows.length) break
    for (let i = 0; i < rows.length; i += 1) {
      const doc = rows[i]
      ACTIVITY_FILES.forEach((key) => {
        const fileID = String(doc[key] || '')
        if (fileID.indexOf('cloud://') === 0 && fileIDs.indexOf(fileID) === -1) fileIDs.push(fileID)
      })
      await activities.doc(doc._id).remove()
      removed += 1
    }
    if (rows.length < DELETE_BATCH) break
  }
  return { removed, fileIDs }
}

/**
 * 删除云存储文件。
 * 删不掉不阻塞注销：活动已经删除，残留文件不会再被任何入口引用，日志留痕即可。
 * @returns {Promise<number>} 实际删除的文件数
 */
async function removeCloudFiles(fileIDs) {
  let removed = 0
  for (let i = 0; i < fileIDs.length; i += FILE_BATCH) {
    const batch = fileIDs.slice(i, i + FILE_BATCH)
    try {
      const res = await cloud.deleteFile({ fileList: batch })
      const list = (res && res.fileList) || []
      removed += list.length ? list.filter((item) => item && Number(item.status) === 0).length : batch.length
    } catch (e) {
      console.error('[activity] 注销时删除云存储文件失败，文件已无入口引用', e)
    }
  }
  return removed
}

/**
 * 移除该用户在别人活动里的报名记录。
 * 数组内元素无法定位删除，读出成员数组过滤后写回，joinedCount 跟着一起修正。
 * @returns {Promise<number>} 受影响的活动数
 */
async function removeJoinRecords(openid) {
  let removed = 0
  for (;;) {
    const res = await activities.where({ 'joinedPeople.openid': openid }).limit(DELETE_BATCH).get()
    const rows = res.data || []
    if (!rows.length) break
    let changed = 0
    for (let i = 0; i < rows.length; i += 1) {
      const doc = rows[i]
      const before = doc.joinedPeople || []
      const next = before.filter((member) => member.openid !== openid)
      // 条件命中了却没改动属于异常数据，跳过即可，不能让循环永远转下去
      if (next.length === before.length) continue
      await activities.doc(doc._id).update({ data: { joinedPeople: next, joinedCount: next.length } })
      changed += 1
    }
    removed += changed
    if (!changed || rows.length < DELETE_BATCH) break
  }
  return removed
}

/**
 * 注销账号：删除账号本身，以及由它产生的内容与痕迹。
 *
 * 顺序是先删活动（内容）、再删报名、最后删账号：中途失败时账号还在，用户可以重新发起注销；
 * 反过来先删账号，就会留下再也关联不到人的孤儿数据。
 *
 * activity_audits 里的审核日志不删：那是平台内容审核的留存记录，只含活动 id、标题与审核人信息，
 * 不含注销用户的昵称 / 头像 / 手机号，属于合规取证材料，不随账号注销消失。
 */
async function deleteAccount(event, openid) {
  if (!openid) return fail('UNAUTHORIZED', '请先登录')
  const userDoc = await findUser(openid)
  if (!userDoc) return fail('UNAUTHORIZED', '请先登录')

  const published = await removeOwnActivities(openid)
  const files = await removeCloudFiles(published.fileIDs)
  const joins = await removeJoinRecords(openid)
  // 反馈与举报（kind: 'report'）存在同一个集合里，按 openid 一次清掉
  const fb = await feedbacks.where({ openid }).remove()
  const feedbacksRemoved = (fb && fb.stats && fb.stats.removed) || 0
  await users.doc(userDoc._id).remove()

  return {
    ok: true,
    activities: published.removed,
    files,
    joins,
    feedbacks: feedbacksRemoved,
  }
}

/**
 * 换取云存储临时链接：换来的地址有有效期（默认 2 小时），前台图片加载失败时
 * （列表停留太久、链接过期）用它按 fileID 重取一次，属于只读操作，不限制登录态。
 */
async function media(event) {
  const fileIDs = (event && event.fileIDs) || []
  const list = (Array.isArray(fileIDs) ? fileIDs : []).slice(0, 20).map((value) => text(value, LIMITS.url))
  return { media: await resolveMedia(list) }
}

/* ---------------------------- 到期自动关闭 ---------------------------- */

/**
 * 把「已过展示期、还没关闭」的活动改成已关闭（发布后 7 天，见 lib/expire.js）。
 *
 * 关闭时间写的是到期那一刻而不是「现在」：广场对已关闭的活动只保留关闭当天，
 * 用到期时间才不会让一批过期活动在任务跑完的那天集体冒出来。
 *
 * 读接口自己带着 notExpiredWhere，任务没跑（或定时触发器还没部署）时过期活动也不会被展示；
 * 这里做的是把库里的状态一并收敛成 closed，让「我的发布」、报名守卫与列表口径完全一致。
 */
async function closeExpiredActivities(now) {
  const deadline = now - TTL_MS
  let closed = 0
  for (;;) {
    // 条件对象每轮新建：同一条 db.command 指令不在多条查询之间复用
    const res = await activities
      .where({ status: _.nin([CLOSED]), createTime: _.lt(deadline) })
      .limit(EXPIRE_BATCH)
      .get()
    const rows = res.data || []
    if (!rows.length) break
    for (let i = 0; i < rows.length; i += 1) {
      const doc = rows[i]
      await activities.doc(doc._id).update({
        data: { status: CLOSED, closeTime: expireTimeOf(doc) },
      })
      closed += 1
    }
    // 这一批已经不再是「未关闭」，下一轮不会重复取到；不足一批说明处理完了
    if (rows.length < EXPIRE_BATCH) break
  }
  return closed
}

/** 定时触发器入口：返回值只用于云函数日志 */
async function runExpireJob() {
  try {
    const closed = await closeExpiredActivities(Date.now())
    console.log(`[activity] 到期自动关闭：本次关闭 ${closed} 条活动`)
    return { ok: true, closed }
  } catch (e) {
    console.error('[activity] 到期自动关闭失败', e)
    return { ok: false, closed: 0 }
  }
}

/* ------------------------------ 路由 ------------------------------ */

const ACTIONS = {
  home,
  list,
  detail,
  media,
  create,
  update,
  join,
  quit,
  toggle,
  mine,
  user,
  login,
  updateUser,
  qrcode,
  feedback,
  report,
  deleteAccount,
}

exports.main = async (event) => {
  const payload = event || {}
  // 定时触发器（cloudfunctions/activity/config.json 的 triggers）不带 action，先于业务路由处理
  if (payload.Type === 'Timer' || payload.type === 'timer') return runExpireJob()
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
