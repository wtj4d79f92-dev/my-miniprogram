/**
 * 云函数离线校验：用内存数据库替代 wx-server-sdk，直接调用 activity / admin 云函数
 * 的 action 路由，验证审核链路的真实逻辑（查询条件、权限、状态流转、日志）。
 *
 * 用法：node scripts/cloud-validate.js
 *
 * 说明：这只是把「云数据库查询语义」用最小实现模拟出来，用于本地回归；
 * 真机联调仍以微信开发者工具 + 云开发环境为准。
 */
const path = require('path')
const Module = require('module')

/* ------------------------------ 内存版 wx-server-sdk ------------------------------ */

const store = {
  activities: [],
  users: [],
  banners: [],
  feedback: [],
  admins: [],
  activity_audits: [],
}

let currentOpenid = ''
let autoId = 0

const OP = '__op'
const REGEX = '__regex'

const command = {
  and: (list) => ({ [OP]: 'and', value: list }),
  or: (list) => ({ [OP]: 'or', value: list }),
  nin: (list) => ({ [OP]: 'nin', value: list }),
  in: (list) => ({ [OP]: 'in', value: list }),
  exists: (value) => ({ [OP]: 'exists', value }),
}

/** 比较指令：真实 SDK 支持 _.gte(x).and(_.lt(y))，这里按同一语义把 and 串成同一字段上的组合条件 */
;['gt', 'gte', 'lt', 'lte'].forEach((op) => {
  command[op] = (value) => {
    const self = { [OP]: op, value }
    self.and = (other) => ({ [OP]: 'and', value: [self, other] })
    return self
  }
})

function isCommand(value) {
  return !!value && typeof value === 'object' && value[OP]
}

/** 取嵌套字段值：'organizer.openid' -> doc.organizer.openid */
function pick(doc, field) {
  return String(field)
    .split('.')
    .reduce((acc, key) => (acc === undefined || acc === null ? undefined : acc[key]), doc)
}

/**
 * 取嵌套字段的全部候选值：路径中间遇到数组时展开成元素，
 * 对应 MongoDB 里 'machineCheck.images.traceId' 命中数组内任一元素的语义。
 */
function candidates(doc, field) {
  const parts = String(field).split('.')
  let current = [doc]
  for (let i = 0; i < parts.length; i += 1) {
    const next = []
    current.forEach((node) => {
      if (node === null || node === undefined) return
      const value = node[parts[i]]
      next.push(value)
      if (Array.isArray(value)) value.forEach((item) => next.push(item))
    })
    current = next
  }
  return current
}

/** 字段级比较：值可能是指令，也可能是普通值 / 正则 */
function matchCommand(actual, cmd) {
  switch (cmd[OP]) {
    case 'nin':
      return cmd.value.indexOf(actual) === -1
    case 'in':
      return cmd.value.indexOf(actual) > -1
    case 'exists':
      return (actual !== undefined) === !!cmd.value
    case 'gt':
      return actual > cmd.value
    case 'gte':
      return actual >= cmd.value
    case 'lt':
      return actual < cmd.value
    case 'lte':
      return actual <= cmd.value
    // 字段级 and / or：成员都是针对同一个字段值的比较条件
    case 'and':
      return cmd.value.every((item) => matchField(actual, item))
    case 'or':
      return cmd.value.some((item) => matchField(actual, item))
    default:
      throw new Error(`未实现的条件指令：${cmd[OP]}`)
  }
}

function matchField(actual, expected) {
  if (isCommand(expected)) return matchCommand(actual, expected)
  if (expected && typeof expected === 'object' && expected[REGEX]) {
    return new RegExp(expected[REGEX], expected.options).test(String(actual === undefined ? '' : actual))
  }
  return actual === expected
}

function matchWhere(doc, where) {
  if (!where) return true
  if (isCommand(where)) {
    // 顶层逻辑指令：and / or 的成员都是完整的文档条件
    if (where[OP] === 'and') return where.value.every((item) => matchWhere(doc, item))
    if (where[OP] === 'or') return where.value.some((item) => matchWhere(doc, item))
    throw new Error(`顶层不支持的条件指令：${where[OP]}`)
  }
  return Object.keys(where).every((field) =>
    candidates(doc, field).some((value) => matchField(value, where[field]))
  )
}

function deepCopy(value) {
  return JSON.parse(JSON.stringify(value === undefined ? null : value))
}

class DocRef {
  constructor(name, id) {
    this.name = name
    this.id = id
  }

  find() {
    return store[this.name].filter((item) => item._id === this.id)[0] || null
  }

  async get() {
    const doc = this.find()
    if (!doc) {
      // 与云端一致：文档不存在时抛错，业务层用 try/catch 收敛成 null
      const err = new Error('document.get:fail document not exists')
      err.errCode = -1
      throw err
    }
    return { data: deepCopy(doc) }
  }

  async update({ data }) {
    const doc = this.find()
    if (!doc) {
      const err = new Error('document.update:fail document not exists')
      err.errCode = -1
      throw err
    }
    Object.assign(doc, deepCopy(data))
    return { stats: { updated: 1 } }
  }
}

class Query {
  constructor(name, filter, options) {
    this.name = name
    this.filter = filter || null
    this.sort = (options && options.sort) || null
    this.offset = (options && options.offset) || 0
    this.max = (options && options.max) || 100
    this.projection = (options && options.projection) || null
  }

  next(extra) {
    const options = {
      sort: this.sort,
      offset: this.offset,
      max: this.max,
      projection: this.projection,
    }
    Object.assign(options, extra || {})
    return new Query(this.name, this.filter, options)
  }

  matched() {
    return store[this.name].filter((doc) => matchWhere(doc, this.filter))
  }

  where(filter) {
    const merged = this.filter ? command.and([this.filter, filter]) : filter
    return this.next({})._withFilter(merged)
  }

  _withFilter(filter) {
    const query = new Query(this.name, filter, {
      sort: this.sort,
      offset: this.offset,
      max: this.max,
      projection: this.projection,
    })
    return query
  }

  orderBy(field, direction) {
    return this.next({ sort: { field, direction } })
  }

  skip(count) {
    return this.next({ offset: count })
  }

  limit(count) {
    return this.next({ max: count })
  }

  field(projection) {
    return this.next({ projection })
  }

  doc(id) {
    return new DocRef(this.name, id)
  }

  async get() {
    let rows = this.matched()
    if (this.sort) {
      const { field, direction } = this.sort
      const sign = direction === 'desc' ? -1 : 1
      rows = rows.slice().sort((a, b) => {
        const left = pick(a, field)
        const right = pick(b, field)
        // 缺失字段排在末尾，与 MongoDB 对 null 的排序一致
        if (left === undefined) return 1
        if (right === undefined) return -1
        if (left === right) return 0
        return left > right ? sign : -sign
      })
    }
    const sliced = rows.slice(this.offset, this.offset + this.max)
    const data = sliced.map((doc) => {
      const copy = deepCopy(doc)
      if (!this.projection) return copy
      const out = { _id: copy._id }
      Object.keys(this.projection).forEach((field) => {
        if (this.projection[field] && copy[field] !== undefined) out[field] = copy[field]
      })
      return out
    })
    return { data }
  }

  async count() {
    return { total: this.matched().length }
  }

  async update({ data }) {
    const rows = this.matched()
    rows.forEach((doc) => Object.assign(doc, deepCopy(data)))
    return { stats: { updated: rows.length } }
  }

  async add({ data }) {
    const doc = deepCopy(data)
    if (!doc._id) {
      autoId += 1
      doc._id = `doc_${autoId}`
    } else if (store[this.name].some((item) => item._id === doc._id)) {
      throw new Error('duplicate key')
    }
    store[this.name].push(doc)
    return { _id: doc._id }
  }
}

class Transaction {
  collection(name) {
    return {
      doc: (id) => new DocRef(name, id),
    }
  }
}

const db = {
  command,
  collection(name) {
    if (!store[name]) store[name] = []
    return new Query(name)
  },
  RegExp({ regexp, options }) {
    return { [REGEX]: regexp, options }
  },
  async runTransaction(handler) {
    return handler(new Transaction())
  },
}

const fakeCloud = {
  DYNAMIC_CURRENT_ENV: 'test-env',
  init() {},
  database() {
    return db
  },
  getWXContext() {
    return { OPENID: currentOpenid, APPID: 'test-appid' }
  },
  async getTempFileURL({ fileList }) {
    if (!tempUrlEnabled) throw new Error('getTempFileURL:fail mock disabled')
    return {
      fileList: (fileList || []).map((fileID) => {
        // 文件不存在时云存储返回的是错误项（status 非 0 + errMsg），而不是抛异常
        if (missingFileIDs.has(fileID)) {
          return { fileID, tempFileURL: '', status: -1, errMsg: 'file not exist' }
        }
        return { fileID, tempFileURL: `https://tmp.test/${encodeURIComponent(fileID)}`, status: 0, errMsg: 'ok' }
      }),
    }
  },
  openapi: {
    phonenumber: { getPhoneNumber: async () => ({ phoneInfo: {} }) },
    wxacode: { getUnlimited: async () => ({ buffer: '' }) },
    security: {
      // 文本检测：由 securityBehavior.text 决定返回什么，null 表示抛错（模拟接口未开通 / 超额度）
      async msgSecCheck() {
        securityCalls.push('text')
        if (securityBehavior.textDelay) {
          await new Promise((resolve) => setTimeout(resolve, securityBehavior.textDelay))
        }
        if (!securityBehavior.text) {
          const err = new Error('api unauthorized')
          err.errCode = 48001
          throw err
        }
        // textEmpty：接口通了但没带回结论（没有 result），同样不能算「通过」
        if (securityBehavior.textEmpty) return { errcode: 0, errmsg: 'ok' }
        return {
          errcode: 0,
          result: { suggest: securityBehavior.text, label: securityBehavior.label || 0 },
          traceId: `text_trace_${securityCalls.length}`,
        }
      },
      async mediaCheckAsync() {
        securityCalls.push('image')
        imageCallSeq += 1
        if (securityBehavior.imageDelay) {
          await new Promise((resolve) => setTimeout(resolve, securityBehavior.imageDelay))
        }
        // imageFailOnce：只让第一张图送检失败，用来验证「有图片没能送出去时转人工」
        if (!securityBehavior.image || (securityBehavior.imageFailOnce && imageCallSeq === 1)) {
          const err = new Error('api unauthorized')
          err.errCode = 48001
          throw err
        }
        // traceId 必须全局唯一：真实环境里它就是回调查找活动的唯一线索
        mediaSeq += 1
        const traceId = `media_trace_${mediaSeq}`
        mediaTraceIds.push(traceId)
        return { errcode: 0, traceId }
      },
    },
    img: {
      // 二维码/条码识别：由 securityBehavior.qrcode 决定识别出什么，null 表示接口调用失败
      async scanQRCode(params) {
        qrCalls.push({ imgUrl: (params && params.imgUrl) || '' })
        if (!securityBehavior.qrcode) {
          const err = new Error('api unauthorized')
          err.errCode = 48001
          throw err
        }
        if (securityBehavior.qrcode === 'notqr') return { errcode: 0, code_results: [] }
        if (securityBehavior.qrcode === 'barcode') {
          return { errcode: 0, code_results: [{ type_name: 'EAN_13', data: '6901234567892' }] }
        }
        if (securityBehavior.qrcode === 'notgroup') {
          return { errcode: 0, code_results: [{ type_name: 'QR_CODE', data: 'https://pay.example.com/abc' }] }
        }
        return {
          errcode: 0,
          code_results: [{ type_name: 'QR_CODE', data: 'https://weixin.qq.com/g/AaBbCcDd' }],
        }
      },
    },
  },
}

// 内容安全接口的行为开关：text/image 取值 pass | review | risky | null（null 表示调用失败）
// imageFailOnce：仅第一次图片送检失败，用于验证「部分图片没结论」的降级路径
// qrcode：group 识别到微信群邀请链接 | notqr 没识别到码 | notgroup 识别到的不是群链接 |
//         barcode 只有一维码 | null 接口调用失败
const securityBehavior = {
  text: 'pass',
  image: 'pass',
  imageFailOnce: false,
  textEmpty: false,
  qrcode: 'group',
  label: 0,
  textDelay: 0,
  imageDelay: 0,
}
const securityCalls = []
const qrCalls = []
const mediaTraceIds = []
let mediaSeq = 0
let imageCallSeq = 0
let tempUrlEnabled = true

function resetSecurity(behavior) {
  securityBehavior.text = 'pass'
  securityBehavior.image = 'pass'
  securityBehavior.imageFailOnce = false
  securityBehavior.textEmpty = false
  securityBehavior.qrcode = 'group'
  securityBehavior.label = 0
  securityBehavior.textDelay = 0
  securityBehavior.imageDelay = 0
  Object.assign(securityBehavior, behavior || {})
  securityCalls.length = 0
  qrCalls.length = 0
  imageCallSeq = 0
}

// 拦截 require('wx-server-sdk')，让云函数在不装依赖的情况下也能跑
const originalLoad = Module._load
Module._load = function load(request, parent, isMain) {
  if (request === 'wx-server-sdk') return fakeCloud
  return originalLoad.apply(this, arguments)
}

/* ------------------------------ 断言工具 ------------------------------ */

const passed = []
const errors = []

function log(ok, message) {
  if (ok) passed.push(message)
  else errors.push(message)
}

/** 模拟「云存储里没有这个文件」的 fileID，用于验证上传校验与审核台的失败提示 */
const missingFileIDs = new Set()

function resetStore() {
  Object.keys(store).forEach((name) => {
    store[name] = []
  })
  autoId = 0
  missingFileIDs.clear()
}

/** 预期内的降级路径会打 console.error，跑测试时静音掉，保持输出可读 */
async function silenceErrors(task) {
  const original = console.error
  console.error = () => {}
  try {
    return await task()
  } finally {
    console.error = original
  }
}

const ROOT = path.resolve(__dirname, '..')
const activityFn = require(path.join(ROOT, 'cloudfunctions/activity/index.js'))
const adminFn = require(path.join(ROOT, 'cloudfunctions/admin/index.js'))
const contentCheckFn = require(path.join(ROOT, 'cloudfunctions/contentCheck/index.js'))

async function callActivity(action, payload, openid) {
  currentOpenid = openid || ''
  return activityFn.main(Object.assign({ action }, payload || {}))
}

async function callAdmin(action, payload, openid) {
  currentOpenid = openid || ''
  return adminFn.main(Object.assign({ action }, payload || {}))
}

/** 模拟微信推送过来的多媒体内容安全检测结果 */
async function pushMediaResult(traceId, suggest, label) {
  return contentCheckFn.main({
    ToUserName: 'gh_test',
    FromUserName: 'o_test',
    CreateTime: String(Math.floor(Date.now() / 1000)),
    MsgType: 'event',
    Event: 'wxa_media_check',
    appid: 'test-appid',
    trace_id: traceId,
    version: 2,
    errcode: 0,
    result: { suggest, label: label || 0 },
  })
}

/** 推送一条「没有结论」的图片检测事件：带错误码、不带 result（接口异常时微信推的就是这种） */
async function pushMediaNoConclusion(traceId, errcode) {
  return contentCheckFn.main({
    ToUserName: 'gh_test',
    FromUserName: 'o_test',
    CreateTime: String(Math.floor(Date.now() / 1000)),
    MsgType: 'event',
    Event: 'wxa_media_check',
    appid: 'test-appid',
    trace_id: traceId,
    version: 2,
    errcode: errcode || 40001,
    errmsg: 'invalid credential',
  })
}

const ORGANIZER = 'openid_organizer'
const OTHER = 'openid_other'
const ADMIN = 'openid_admin'

function seedUser(openid, nickName) {
  store.users.push({
    _id: `u_${openid}`,
    openid,
    userId: store.users.length + 1,
    nickName,
    avatarColor: '#4ECDC4',
    avatarUrl: '',
    avatarText: nickName.slice(0, 1),
    phone: '',
    bio: '',
    createTime: Date.now(),
  })
}

function seedActivity(overrides) {
  const doc = Object.assign(
    {
      _id: `act_${store.activities.length + 1}`,
      type: 'hiking',
      typeName: '徒步',
      emoji: '🥾',
      color: '#00B578',
      bg: 'linear-gradient(135deg, #00B578 0%, #00CDAC 100%)',
      title: '测试活动',
      cover: '',
      groupQrCode: 'cloud://qr.png',
      desc: '描述',
      location: '浙江省杭州市 西湖断桥',
      city: '杭州',
      startTime: Date.now() + 86400000,
      endTime: Date.now() + 2 * 86400000,
      startWeekday: 3,
      difficulty: 3,
      distance: 10,
      elevationGain: 200,
      fee: 0,
      feeMode: 'aa',
      maxPeople: 8,
      tags: [],
      joinedPeople: [],
      joinedCount: 0,
      organizer: { openid: ORGANIZER, nickName: '发起人', avatarColor: '#4ECDC4', avatarUrl: '', avatarText: '发' },
      createTime: Date.now(),
      status: 'recruiting',
      miniQrCode: '',
    },
    overrides || {}
  )
  store.activities.push(doc)
  return doc
}

/* ------------------------------ 用例 ------------------------------ */

async function run() {
  /* ---------- activity 云函数：公开可见范围 ---------- */
  resetStore()
  resetSecurity()
  seedUser(ORGANIZER, '发起人')
  seedUser(OTHER, '路人')
  store.admins.push({ _id: 'admin_1', openid: ADMIN, name: '运营小张' })
  // 审核能力上线前的历史数据：没有 auditStatus 字段
  const legacy = seedActivity({ _id: 'act_legacy', title: '历史活动' })
  const pending = seedActivity({ _id: 'act_pending', title: '待审活动', auditStatus: 'pending' })
  const rejected = seedActivity({ _id: 'act_rejected', title: '被驳回活动', auditStatus: 'rejected' })
  const approved = seedActivity({ _id: 'act_approved', title: '已通过活动', auditStatus: 'approved' })

  const home = await callActivity('home', { city: '' }, OTHER)
  const homeIds = home.hotList.concat(home.newestList).map((item) => item.id)
  log(homeIds.indexOf('act_pending') === -1, '首页：审核中的活动不可见')
  log(homeIds.indexOf('act_rejected') === -1, '首页：被驳回的活动不可见')
  log(homeIds.indexOf('act_approved') > -1, '首页：已通过的活动可见')

  const list = await callActivity('list', { pageIndex: 0, pageSize: 50, sort: 'latest' }, OTHER)
  const listIds = list.list.map((item) => item.id)
  log(listIds.indexOf('act_legacy') > -1, '广场：历史数据（无审核字段）继续可见，不会因上线审核而消失')
  log(listIds.indexOf('act_pending') === -1 && listIds.indexOf('act_rejected') === -1, '广场：审核中与已驳回的活动不可见')
  log(list.total === 2, `广场：总数只统计可见活动（实际 ${list.total}）`)

  const cityList = await callActivity('list', { pageIndex: 0, pageSize: 50, city: '杭州' }, OTHER)
  log(cityList.list.every((item) => item.city === '杭州'), '广场：城市筛选与审核条件可叠加')

  /* ---------- activity 云函数：详情可见性 ---------- */
  const otherDetail = await callActivity('detail', { id: 'act_pending' }, OTHER)
  log(otherDetail === null, '详情：他人看不到审核中的活动（按不存在处理）')
  const ownerDetail = await callActivity('detail', { id: 'act_pending' }, ORGANIZER)
  log(!!ownerDetail && ownerDetail.auditStatus === 'pending', '详情：发起人可预览自己的待审活动')
  log(!!ownerDetail && ownerDetail.isOrganizer === true, '详情：发起人标记正确')
  const guestDetail = await callActivity('detail', { id: 'act_pending' }, '')
  log(guestDetail === null, '详情：未登录用户看不到未过审活动')
  const legacyDetail = await callActivity('detail', { id: 'act_legacy' }, OTHER)
  log(!!legacyDetail, '详情：历史数据对所有人可见')

  /* ---------- activity 云函数：发布与编辑 ---------- */
  const form = {
    type: 'hiking',
    title: '新提交的活动',
    location: '浙江省杭州市 九溪',
    startTime: Date.now() + 86400000,
    endTime: Date.now() + 2 * 86400000,
    difficulty: 3,
    distance: 12,
    elevationGain: 300,
    feeMode: 'aa',
    maxPeople: 10,
    groupQrCode: 'cloud://qr2.png',
    desc: '说明',
  }
  const created = await callActivity('create', { form }, ORGANIZER)
  log(created.auditStatus === 'pending', '发布：新活动进入待审核')
  log(created.auditTime === 0 && created.auditBy === '', '发布：审核结论与审核人初始为空')
  log(created.status === 'recruiting' && created.joinedCount === 0, '发布：业务状态与成员列表正常')
  log(created.city === '杭州', '发布：城市由集合地点自动匹配')

  const invalidCreate = await callActivity('create', { form: Object.assign({}, form, { title: '' }) }, ORGANIZER)
  log(invalidCreate.code === 'INVALID_PARAM', '发布：缺少标题被拒绝')

  const pendingJoin = await callActivity('join', { id: created.id }, OTHER)
  log(pendingJoin.code === 'AUDIT_PENDING', '报名：审核中的活动拒绝报名')
  const pendingToggle = await callActivity('toggle', { id: created.id }, ORGANIZER)
  log(pendingToggle.code === 'AUDIT_PENDING', '关闭/打开：审核中的活动不可操作')

  const mineOther = await callActivity('mine', { kind: 'published' }, OTHER)
  log(mineOther.length === 0, '我的发布：只返回自己的活动')
  const mineOwner = await callActivity('mine', { kind: 'published' }, ORGANIZER)
  log(mineOwner.some((item) => item.id === created.id), '我的发布：包含自己审核中的活动')

  const forbiddenUpdate = await callActivity('update', { id: created.id, form }, OTHER)
  log(forbiddenUpdate.code === 'FORBIDDEN', '编辑：非发起人不能修改')

  const beforeEdit = store.activities.filter((item) => item._id === created.id)[0]
  const edited = await callActivity(
    'update',
    { id: created.id, form: Object.assign({}, form, { title: '修改后的标题' }) },
    ORGANIZER
  )
  log(edited.title === '修改后的标题', '编辑：字段被覆盖')
  log(edited.auditStatus === 'pending', '编辑：重新进入待审核')
  log(edited.joinedPeople.length === beforeEdit.joinedPeople.length, '编辑：报名数据不受影响')
  log(edited.submitTime >= beforeEdit.submitTime, '编辑：提交时间被刷新，待审队列会重新排序')

  // 已通过的活动被编辑后同样回到待审
  await callAdmin('approve', { id: created.id }, ADMIN)
  const reopened = await callActivity('update', { id: created.id, form }, ORGANIZER)
  log(reopened.auditStatus === 'pending', '编辑：已通过的活动改动后重新送审')
  const afterReopenJoin = await callActivity('join', { id: created.id }, OTHER)
  log(afterReopenJoin.code === 'AUDIT_PENDING', '编辑：重新送审期间不能报名')

  /* ---------- 云存储上传校验：封面 / 二维码换不到链接时不写库 ---------- */
  missingFileIDs.add('cloud://lost-cover.png')
  const lostCover = await callActivity(
    'create',
    { form: Object.assign({}, form, { title: '封面文件已丢失的活动', cover: 'cloud://lost-cover.png' }) },
    ORGANIZER
  )
  log(lostCover.code === 'UPLOAD_FAILED', '发布：封面文件在云存储里不存在时拦下，而不是落库成永远加载不出的封面')
  log(/封面/.test(lostCover.message || ''), '发布：提示能指明是封面需要重传')
  log(
    store.activities.every((item) => item.title !== '封面文件已丢失的活动'),
    '发布：被拦下的活动不写库'
  )
  missingFileIDs.delete('cloud://lost-cover.png')

  missingFileIDs.add('cloud://lost-qr.png')
  const lostQr = await callActivity(
    'create',
    { form: Object.assign({}, form, { title: '二维码文件已丢失的活动', groupQrCode: 'cloud://lost-qr.png' }) },
    ORGANIZER
  )
  log(lostQr.code === 'UPLOAD_FAILED' && /二维码/.test(lostQr.message || ''), '发布：二维码文件不存在时同样拦下并指明字段')
  missingFileIDs.delete('cloud://lost-qr.png')

  const degradedUpload = await silenceErrors(() => {
    tempUrlEnabled = false
    return callActivity(
      'create',
      { form: Object.assign({}, form, { title: '云存储接口异常时的活动', cover: 'cloud://cover-ok.png' }) },
      ORGANIZER
    )
  })
  tempUrlEnabled = true
  log(!!degradedUpload.id && degradedUpload.auditStatus === 'pending', '发布：云存储接口异常时放行，不因为校验本身失败卡住用户')

  /* ---------- admin 云函数：权限 ---------- */
  const whoamiGuest = await callAdmin('whoami', {}, OTHER)
  log(whoamiGuest.isAdmin === false && whoamiGuest.openid === OTHER, '审核台：普通用户拿到自己的 openid 但没有权限')
  const whoamiAdmin = await callAdmin('whoami', {}, ADMIN)
  log(whoamiAdmin.isAdmin === true && whoamiAdmin.name === '运营小张', '审核台：识别审核人身份')
  const denied = await callAdmin('list', {}, OTHER)
  log(denied.code === 'FORBIDDEN', '审核台：非审核人调用列表被拒绝')
  const deniedApprove = await callAdmin('approve', { id: created.id }, OTHER)
  log(deniedApprove.code === 'FORBIDDEN', '审核台：非审核人不能审核')
  const unknown = await callAdmin('not-exist', {}, ADMIN)
  log(unknown.code === 'UNKNOWN_ACTION', '审核台：未知 action 返回 UNKNOWN_ACTION')

  /* ---------- admin 云函数：列表与统计 ---------- */
  const pendingList = await callAdmin('list', { status: 'pending' }, ADMIN)
  log(pendingList.list.every((item) => item.auditStatus === 'pending'), '审核台：待审列表只含待审活动')
  log(pendingList.stats.pending === pendingList.total, '审核台：待审统计与列表总数一致')
  log(pendingList.stats.approved >= 1 && pendingList.stats.rejected >= 1, '审核台：各状态统计可用')
  log(pendingList.list[0].auditStatus === 'pending' && pendingList.list[0].joinedPeople === undefined, '审核台：列表不带报名成员等大字段')
  log(
    pendingList.list.every((item) => typeof item.groupQrCode === 'string'),
    '审核台：列表带出群二维码，弹层不用等详情接口就能看到'
  )

  const allList = await callAdmin('list', { status: 'all' }, ADMIN)
  log(allList.total === store.activities.length, '审核台：全部页签返回所有活动')

  const keywordList = await callAdmin('list', { status: 'all', keyword: '被驳回' }, ADMIN)
  log(keywordList.list.length === 1 && keywordList.list[0].id === 'act_rejected', '审核台：关键字可搜索标题')

  const approvedList = await callAdmin('list', { status: 'approved' }, ADMIN)
  log(approvedList.total === 2, `审核台：已通过页签包含历史数据（实际 ${approvedList.total}）`)

  /* ---------- 集合地点：展示文本（省 + 市 + 地点名）与匹配用的地址分开存 ---------- */
  // 地图选点后表单显示的是「省 + 市 + 地点名」（前端 utils/location.js 拼好），
  // 它对应的完整地址另有字段兜住，否则「华府大道地铁站」匹配不出城市，活动会归错城市 / 搜不到。
  const poi = await callActivity(
    'create',
    {
      form: Object.assign({}, form, {
        title: '地图选点的活动',
        location: '四川省成都市 华府大道地铁站',
        locationAddress: '四川省成都市双流区天府大道南段附近',
      }),
    },
    ORGANIZER
  )
  log(poi.location === '四川省成都市 华府大道地铁站', '发布：集合地点原样落库，展示文本带省市前缀')
  log(poi.locationAddress === '四川省成都市双流区天府大道南段附近', '发布：完整地址单独落库，供城市匹配与检索')
  log(poi.city === '成都', '发布：城市按不展示的地址匹配，不因为地点名没带省市就归错城市')

  const poiOnly = await callActivity(
    'create',
    { form: Object.assign({}, form, { title: '只填地名没选点的活动', location: '华府大道地铁站', locationAddress: '' }) },
    ORGANIZER
  )
  log(poiOnly.locationAddress === '', '发布：手输地点没有地址时该字段为空串，不影响发布')

  // 手输缺省市的短地址（「双流区润和路附近」）：地址里认不出城市时按发布者当前城市兜底，
  // 否则 city 为空，用户定位成都后按城市筛选一条都查不到。
  const shortAddress = await callActivity(
    'create',
    {
      form: Object.assign({}, form, {
        title: '手输短地址的活动',
        location: '双流区润和路附近',
        locationAddress: '',
        cityHint: '成都',
      }),
    },
    ORGANIZER
  )
  log(shortAddress.city === '成都', '发布：手输「双流区润和路附近」按发布者当前城市归属到成都')
  await callAdmin('approve', { id: shortAddress.id }, ADMIN)
  const chengduList = await callActivity('list', { pageIndex: 0, pageSize: 50, city: '成都' }, OTHER)
  log(
    chengduList.list.some((item) => item.id === shortAddress.id),
    '广场：定位成都后能筛出缺省市地址的活动'
  )

  // 省份 / 全国这类落不到单城的提示不能当归属，避免把活动错挂到某个城市
  const provinceHint = await callActivity(
    'create',
    {
      form: Object.assign({}, form, {
        title: '省份提示的活动',
        location: '某某路附近',
        locationAddress: '',
        cityHint: '四川省',
      }),
    },
    ORGANIZER
  )
  log(provinceHint.city === '', '发布：cityHint 只认唯一城市，省份提示不会被当成归属')

  await callAdmin('approve', { id: poi.id }, ADMIN)
  const addressSearch = await callActivity('list', { pageIndex: 0, pageSize: 50, keyword: '双流' }, OTHER)
  log(
    addressSearch.list.some((item) => item.id === poi.id),
    '广场：按地址关键词「双流」也能搜到活动，地址没有因为不展示而丢掉'
  )
  const adminAddressSearch = await callAdmin('list', { status: 'approved', keyword: '双流' }, ADMIN)
  log(
    adminAddressSearch.list.some((item) => item.id === poi.id),
    '审核台：审核人按地址关键词同样能搜到'
  )

  /* ---------- 省份筛选：省 + 全部只返回省内活动 ---------- */
  const provinceSichuan = await callActivity('list', { pageIndex: 0, pageSize: 50, city: '四川省' }, OTHER)
  log(
    provinceSichuan.list.length > 0 && provinceSichuan.list.every((item) => item.city === '成都'),
    '广场：省 + 全部按全省过滤，只返回省内的活动'
  )
  const provinceEmpty = await callActivity('list', { pageIndex: 0, pageSize: 50, city: '广东省' }, OTHER)
  const nationList = await callActivity('list', { pageIndex: 0, pageSize: 50, city: '' }, OTHER)
  log(
    provinceEmpty.total === 0 && nationList.total > 0,
    '广场：没有活动的省份返回空，全部 + 全部仍展示全国活动'
  )
  const homeSichuan = await callActivity('home', { city: '四川省' }, OTHER)
  const homeSichuanList = homeSichuan.hotList.concat(homeSichuan.newestList)
  log(
    homeSichuanList.length > 0 && homeSichuanList.every((item) => item.city === '成都'),
    '首页：省 + 全部按全省过滤'
  )

  /* ---------- 活动类型筛选：广场胶囊传 type，服务端按类型过滤 ---------- */
  const climbing = seedActivity({
    _id: 'act_climbing',
    type: 'climbing',
    typeName: '爬山',
    emoji: '🥾',
    title: '周末爬山',
    auditStatus: 'approved',
  })
  const typeList = await callActivity('list', { pageIndex: 0, pageSize: 50, type: 'climbing' }, OTHER)
  log(
    typeList.list.length === 1 && typeList.list[0].id === climbing._id,
    '广场：活动类型筛选只返回该类型的活动'
  )
  const typedAll = await callActivity('list', { pageIndex: 0, pageSize: 50, type: 'all' }, OTHER)
  log(typedAll.total > typeList.total, '广场：全部类型不做过滤，其他玩法一起返回')
  const latestList = await callActivity('list', { pageIndex: 0, pageSize: 50, sort: 'latest' }, OTHER)
  log(
    latestList.list.every((item, i) => i === 0 || latestList.list[i - 1].createTime >= item.createTime),
    '广场：默认排序「最新发布」按发布时间倒序'
  )

  /* ---------- 日期筛选：date 是客户端算好的当天 00:00 时间戳 ---------- */
  const todayStart = new Date()
  todayStart.setHours(0, 0, 0, 0)
  const tomorrowStart = todayStart.getTime() + 86400000
  const dateList = await callActivity('list', { pageIndex: 0, pageSize: 50, date: tomorrowStart }, OTHER)
  log(
    dateList.total > 0 &&
      dateList.list.every((item) => item.startTime >= tomorrowStart && item.startTime < tomorrowStart + 86400000),
    '广场：按具体日期筛选只返回当天的活动'
  )
  const emptyDay = await callActivity('list', { pageIndex: 0, pageSize: 50, date: tomorrowStart + 30 * 86400000 }, OTHER)
  log(emptyDay.total === 0, '广场：没有活动的日期返回空，不会退回全量')

  const detailRes = await callAdmin('detail', { id: 'act_approved' }, ADMIN)
  log(detailRes.id === 'act_approved' && !!detailRes.desc, '审核台：详情返回完整活动信息')
  const detailMissing = await callAdmin('detail', { id: 'not_exist' }, ADMIN)
  log(detailMissing.code === 'NOT_FOUND', '审核台：活动不存在返回 NOT_FOUND')

  /* ---------- admin 云函数：封面 / 二维码的云存储临时链接 ---------- */
  // 审核人和发起人不是同一个微信号时，客户端直接渲染 cloud:// 会被云存储权限拦下，
  // 所以列表 / 详情都要带上服务端换好的临时链接
  const coverMedia = pendingList.media['cloud://qr2.png']
  log(
    !!coverMedia && coverMedia.ok === true && /^https:\/\//.test(coverMedia.url),
    '审核台：列表用管理员身份把发起人上传的云存储文件换成临时链接'
  )
  const qrDetail = await callAdmin('detail', { id: created.id }, ADMIN)
  log(
    !!qrDetail.media && qrDetail.media['cloud://qr2.png'] && qrDetail.media['cloud://qr2.png'].ok === true,
    '审核台：详情同样返回临时链接'
  )

  // 历史脏数据：文件在云存储里已经不存在，服务端也换不到链接，要给出可解释的原因
  missingFileIDs.add('cloud://cover-gone.png')
  seedActivity({ _id: 'act_cover_gone', title: '封面读不到的活动', cover: 'cloud://cover-gone.png', auditStatus: 'pending' })
  const goneList = await callAdmin('list', { status: 'pending', keyword: '封面读不到' }, ADMIN)
  const goneMedia = goneList.media['cloud://cover-gone.png']
  log(
    !!goneMedia && goneMedia.ok === false && !!goneMedia.reason,
    '审核台：服务端也取不到时返回失败原因，前端据此提示重新上传而不是空白灰块'
  )
  log(
    goneList.list[0].cover === 'cloud://cover-gone.png',
    '审核台：解析失败时仍返回原始 fileID，便于运营贴给开发排查'
  )
  missingFileIDs.delete('cloud://cover-gone.png')

  /* ---------- activity 云函数：前台列表 / 详情的封面临时链接 ---------- */
  // 广场 / 首页展示的多数是别人发的活动，客户端直连 cloud:// 可能被存储权限拦下，
  // 所以列表与详情同样要下发服务端换好的 https 地址
  seedActivity({
    _id: 'act_cover_ok',
    title: '带封面的活动',
    cover: 'cloud://cover-ok.png',
    groupQrCode: 'cloud://qr-cover.png',
    auditStatus: 'approved',
  })

  const coverList = await callActivity('list', { pageIndex: 0, pageSize: 50, keyword: '带封面' }, OTHER)
  log(
    coverList.list.length === 1 && /^https:\/\//.test(coverList.list[0].coverUrl || ''),
    '广场：列表下发封面的 https 临时链接'
  )
  log(
    coverList.list[0].cover === 'cloud://cover-ok.png',
    '广场：原始 fileID 仍然保留，临时链接失效时可以重取'
  )

  const coverDetail = await callActivity('detail', { id: 'act_cover_ok' }, OTHER)
  log(/^https:\/\//.test(coverDetail.coverUrl || ''), '详情：封面下发临时链接')
  log(/^https:\/\//.test(coverDetail.qrUrl || ''), '详情：群二维码下发临时链接')

  const homeWithCover = await callActivity('home', { city: '' }, OTHER)
  const homeAll = homeWithCover.hotList.concat(homeWithCover.newestList)
  log(
    homeAll.every((item) => item.cover === '' || /^https:\/\//.test(item.coverUrl || '')),
    '首页：所有带封面的卡片都换成 https 临时链接'
  )

  const mediaRes = await callActivity('media', { fileIDs: ['cloud://cover-ok.png', 'wxfile://tmp_1.jpg', ''] }, OTHER)
  log(
    !!mediaRes.media['cloud://cover-ok.png'] && /^https:\/\//.test(mediaRes.media['cloud://cover-ok.png'].url),
    '媒体接口：按 fileID 重取临时链接（图片加载失败时的兜底）'
  )
  log(Object.keys(mediaRes.media).length === 1, '媒体接口：忽略本机临时路径等非云存储值')

  missingFileIDs.add('cloud://gone-again.png')
  const mediaGone = await callActivity('media', { fileIDs: ['cloud://gone-again.png'] }, OTHER)
  log(mediaGone.media['cloud://gone-again.png'].ok === false, '媒体接口：文件不存在时返回 ok=false，不抛错')
  missingFileIDs.delete('cloud://gone-again.png')

  /* ---------- admin 云函数：审核动作 ---------- */
  const emptyRemark = await callAdmin('reject', { id: 'act_pending', remark: '   ' }, ADMIN)
  log(emptyRemark.code === 'INVALID_PARAM', '审核台：驳回必须填写原因')

  const rejectRes = await callAdmin('reject', { id: 'act_pending', remark: '活动信息不完整' }, ADMIN)
  log(rejectRes.auditStatus === 'rejected', '审核台：驳回写入状态')
  const rejectedDoc = store.activities.filter((item) => item._id === 'act_pending')[0]
  log(rejectedDoc.auditRemark === '活动信息不完整' && rejectedDoc.auditBy === '运营小张', '审核台：驳回原因与审核人落库')
  log(rejectedDoc.auditTime > 0, '审核台：驳回时间落库')

  const approveRes = await callAdmin('approve', { id: 'act_pending' }, ADMIN)
  log(approveRes.auditStatus === 'approved', '审核台：通过写入状态')
  const reApprove = await callAdmin('approve', { id: 'act_pending' }, ADMIN)
  log(reApprove.code === 'AUDIT_DONE', '审核台：重复通过被拒绝')

  const visibleAfterApprove = await callActivity('list', { pageIndex: 0, pageSize: 50 }, OTHER)
  log(visibleAfterApprove.list.some((item) => item.id === 'act_pending'), '审核通过：活动随即在广场可见')
  const joinAfterApprove = await callActivity('join', { id: 'act_pending' }, OTHER)
  log(joinAfterApprove.joinedCount === 1, '审核通过：可以正常报名')

  log(store.activity_audits.length >= 3, `审核台：审核日志已记录（${store.activity_audits.length} 条）`)
  const lastLog = store.activity_audits[store.activity_audits.length - 1]
  log(lastLog.adminOpenid === ADMIN && lastLog.action === 'approved', '审核台：日志记录审核人与动作')
  const logsRes = await callAdmin('logs', { activityId: 'act_pending' }, ADMIN)
  log(logsRes.list.length >= 2, '审核台：可按活动查询审核记录')

  /* ---------- admin 云函数：历史数据迁移 ---------- */
  const legacyBefore = store.activities.filter((item) => item.auditStatus === undefined).length
  log(legacyBefore === 1, `迁移前存在 ${legacyBefore} 条无审核状态的历史数据`)
  const migrateRes = await callAdmin('migrate', {}, ADMIN)
  log(migrateRes.updated === 1, '迁移：补齐历史数据的审核状态')
  const migrated = store.activities.filter((item) => item._id === legacy._id)[0]
  log(migrated.auditStatus === 'approved', '迁移：历史数据标记为已通过')
  const migrateAgain = await callAdmin('migrate', {}, ADMIN)
  log(migrateAgain.updated === 0, '迁移：可重复执行，不会重复改动')
  const legacyStillVisible = await callActivity('list', { pageIndex: 0, pageSize: 50 }, OTHER)
  log(legacyStillVisible.list.some((item) => item.id === legacy._id), '迁移：历史活动迁移后依然可见')

  /* ---------- 错误兜底 ---------- */
  const badAction = await callActivity('not-exist', {}, OTHER)
  log(badAction.code === 'UNKNOWN_ACTION', '云函数：未知 action 返回 UNKNOWN_ACTION')
  const noLoginCreate = await callActivity('create', { form }, '')
  log(noLoginCreate.code === 'UNAUTHORIZED', '云函数：未登录不能发布活动')

  /* ---------- 内容安全：文本同步检测 ---------- */
  resetSecurity({ text: 'pass', image: 'pass' })
  const checked = await callActivity(
    'create',
    { form: Object.assign({}, form, { title: '内容安全正常活动' }) },
    ORGANIZER
  )
  log(checked.auditStatus === 'pending', '内容安全：正常内容照常进待审')
  log(checked.machineCheck.text.suggest === 'pass' && checked.machineCheck.text.failed === false, '内容安全：文本检测结论写入活动')
  log(securityCalls.indexOf('text') > -1, '内容安全：发布时调用了文本检测接口')
  log(checked.machinePending === true && checked.machineReview === false, '内容安全：图片结论未回来时标记检测中')

  const countBefore = store.activities.length
  resetSecurity({ text: 'risky', label: 20001 })
  const riskyCreate = await callActivity(
    'create',
    { form: Object.assign({}, form, { title: '含违规词的活动' }) },
    ORGANIZER
  )
  log(riskyCreate.code === 'CONTENT_RISKY', '内容安全：文本判定违规时直接拦下')
  log(store.activities.length === countBefore, '内容安全：违规内容不写库')
  log(store.activity_audits.filter((item) => item.action === 'blocked-text').length === 1, '内容安全：违规拦截写入审核日志')

  resetSecurity({ text: 'review' })
  const reviewCreate = await callActivity(
    'create',
    { form: Object.assign({}, form, { title: '需人工复核的活动' }) },
    ORGANIZER
  )
  log(reviewCreate.auditStatus === 'pending' && reviewCreate.machineReview === true, '内容安全：疑似内容进人工队列并标记需复核')

  resetSecurity({ text: null })
  const degradeCreate = await silenceErrors(() =>
    callActivity('create', { form: Object.assign({}, form, { title: '文本接口异常时的活动' }) }, ORGANIZER)
  )
  log(!!degradeCreate.id && degradeCreate.auditStatus === 'pending', '内容安全：文本接口异常不阻塞发布')
  log(degradeCreate.machineCheck.text.failed === true, '内容安全：降级时留下检测失败标记')

  resetSecurity({ image: null })
  const imageFailCreate = await silenceErrors(() => callActivity('create', { form }, ORGANIZER))
  log(!!imageFailCreate.id && imageFailCreate.machineCheck.images.length === 0, '内容安全：图片接口异常不影响发布')

  tempUrlEnabled = false
  resetSecurity()
  const noUrlCreate = await silenceErrors(() => callActivity('create', { form }, ORGANIZER))
  log(!!noUrlCreate.id && noUrlCreate.machineCheck.images.length === 0, '内容安全：云存储临时链接失败不影响发布')
  tempUrlEnabled = true

  /* ---------- 内容安全：图片异步回调 ---------- */
  // 自动放行要求「所有送检项都有结论且都通过」，所以这一组用带云存储封面的表单（封面 + 二维码两张图）
  const formWithCover = Object.assign({}, form, { cover: 'cloud://cover.png' })
  resetSecurity()
  const withImage = await callActivity(
    'create',
    { form: Object.assign({}, formWithCover, { title: '含图片的活动' }) },
    ORGANIZER
  )
  const imgTraces = withImage.machineCheck.images.map((item) => item.traceId)
  log(imgTraces.length === 2 && imgTraces.every(Boolean), '内容安全：封面与二维码各拿到一个 traceId')

  const ackPass = await pushMediaResult(imgTraces[0], 'pass', 100)
  log(ackPass.errcode === 0, '内容安全：回调返回 errcode 0，避免微信重推')
  let afterPush = store.activities.filter((item) => item._id === withImage.id)[0]
  log(afterPush.machineCheck.images[0].suggest === 'pass', '内容安全：图片结论写回活动')
  log(afterPush.machinePending === true, '内容安全：还有图片没结论时依然标记检测中')
  log(afterPush.auditStatus === 'pending', '内容安全：只回来一张图片的结论时不会提前放行')

  await pushMediaResult(imgTraces[1], 'pass', 100)
  afterPush = store.activities.filter((item) => item._id === withImage.id)[0]
  log(afterPush.machinePending === false, '内容安全：结论回来后清除检测中标记')
  log(
    afterPush.auditStatus === 'approved' && afterPush.auditBy === '内容安全检测',
    '内容安全：机审全部通过后自动放行'
  )
  log(
    afterPush.auditRemark === '' && afterPush.auditTime > 0,
    '内容安全：自动放行记录审核时间且不带驳回原因'
  )
  log(
    store.activity_audits.filter((item) => item.action === 'auto-approve').length === 1,
    '内容安全：自动放行写入审核日志'
  )
  const autoApprovedList = await callActivity('list', { pageIndex: 0, pageSize: 100, sort: 'latest' }, OTHER)
  log(autoApprovedList.list.some((item) => item.id === withImage.id), '内容安全：自动放行的活动随即出现在广场')

  /* ---------- 内容安全：没结论不能当成通过 ---------- */
  /* 文本检测在发布当刻超时 / 接口异常时只留下 failed 标记，审核台上文字那行仍写着「机器通过」，
     活动却永远停在待审队列 —— 图片结论回来时补检一次，补到结论就照常自动放行 */
  resetSecurity({ text: null })
  const textDegraded = await silenceErrors(() =>
    callActivity(
      'create',
      { form: Object.assign({}, formWithCover, { title: '文本检测降级的活动' }) },
      ORGANIZER
    )
  )
  log(
    textDegraded.auditStatus === 'pending' && textDegraded.machineCheck.text.failed === true,
    '内容安全：文本检测降级时活动先留在待审队列'
  )

  resetSecurity()
  const degradedTraces = textDegraded.machineCheck.images.map((item) => item.traceId)
  securityCalls.length = 0
  await pushMediaResult(degradedTraces[0], 'pass', 100)
  let degradedDoc = store.activities.filter((item) => item._id === textDegraded.id)[0]
  log(degradedDoc.auditStatus === 'pending', '内容安全：还有图片没结论时不补检文本')
  log(securityCalls.indexOf('text') === -1, '内容安全：文本补检等最后一张图片的结论')

  await pushMediaResult(degradedTraces[1], 'pass', 100)
  degradedDoc = store.activities.filter((item) => item._id === textDegraded.id)[0]
  log(securityCalls.indexOf('text') > -1, '内容安全：图片结论回来后补检文本')
  log(degradedDoc.machineCheck.text.failed === false, '内容安全：补检结论写回活动')
  log(
    degradedDoc.auditStatus === 'approved' && degradedDoc.auditBy === '内容安全检测',
    '内容安全：文本补检通过后机审照样自动放行'
  )
  log(
    store.activity_audits.some(
      (item) => item.activityId === textDegraded.id && item.action === 'auto-approve' && /补检/.test(item.remark)
    ),
    '内容安全：补检放行的审核日志写明是补检通过的'
  )

  // 补检也拿不到结论：留在待审队列交给人工，绝不放行，并留一条日志备查
  resetSecurity({ text: null })
  const recheckFail = await silenceErrors(() =>
    callActivity(
      'create',
      { form: Object.assign({}, formWithCover, { title: '文本始终没有结论的活动' }) },
      ORGANIZER
    )
  )
  securityCalls.length = 0
  await silenceErrors(async () => {
    await pushMediaResult(recheckFail.machineCheck.images[0].traceId, 'pass', 100)
    await pushMediaResult(recheckFail.machineCheck.images[1].traceId, 'pass', 100)
  })
  const recheckFailDoc = store.activities.filter((item) => item._id === recheckFail.id)[0]
  log(securityCalls.indexOf('text') > -1, '内容安全：补检同样会调用文本检测接口')
  log(
    recheckFailDoc.auditStatus === 'pending' && recheckFailDoc.machineCheck.text.failed === true,
    '内容安全：文本补检仍没结论时继续人工审核'
  )
  log(
    store.activity_audits.some((item) => item.activityId === recheckFail.id && item.action === 'text-recheck'),
    '内容安全：文本补检失败写入审核日志'
  )

  // 接口通了却没有 result：这次送检同样没有结论，不能悄悄按「通过」处理
  resetSecurity({ textEmpty: true })
  const emptyText = await callActivity(
    'create',
    { form: Object.assign({}, form, { title: '文本接口没带结论的活动' }) },
    ORGANIZER
  )
  log(
    emptyText.auditStatus === 'pending' && emptyText.machineCheck.text.failed === true,
    '内容安全：文本接口没带结论时按「没结论」转人工'
  )

  // 图片推送带错误码 / 没有 result：既不是通过也不是违规，留待人工，且不能在审核台显示成通过
  resetSecurity()
  const noConclusion = await callActivity('create', { form }, ORGANIZER)
  await pushMediaNoConclusion(noConclusion.machineCheck.images[0].traceId, 40001)
  const noConclusionDoc = store.activities.filter((item) => item._id === noConclusion.id)[0]
  log(noConclusionDoc.machineCheck.images[0].suggest === 'failed', '内容安全：图片推送没结论时不写 pass')
  log(
    noConclusionDoc.auditStatus === 'pending' && noConclusionDoc.machinePending === false,
    '内容安全：图片没结论的活动不放行，也不停在「图片检测中」'
  )
  log(
    store.activity_audits.some((item) => item.activityId === noConclusion.id && item.action === 'image-failed'),
    '内容安全：图片没结论写入审核日志'
  )

  // 旧版推送只带 isrisky 字段：带了字段仍然按结论处理，不能一律当成「没结论」
  resetSecurity()
  const legacyPush = await callActivity('create', { form }, ORGANIZER)
  await contentCheckFn.main({
    Event: 'wxa_media_check',
    trace_id: legacyPush.machineCheck.images[0].traceId,
    errcode: 0,
    isrisky: 0,
  })
  log(
    store.activities.filter((item) => item._id === legacyPush.id)[0].machineCheck.images[0].suggest === 'pass',
    '内容安全：旧版推送只带 isrisky 时仍按结论处理'
  )

  const ackUnknown = await pushMediaResult('trace_not_exist', 'risky', 0)
  log(ackUnknown.errcode === 0, '内容安全：未知 traceId 只确认不报错')
  const ackOther = await contentCheckFn.main({ MsgType: 'text', Content: '你好' })
  log(ackOther.errcode === 0, '内容安全：非检测事件同样确认（接收方需兼容多事件）')

  resetSecurity()
  const riskyImageActivity = await callActivity('create', { form }, ORGANIZER)
  await pushMediaResult(riskyImageActivity.machineCheck.images[0].traceId, 'risky', 20001)
  afterPush = store.activities.filter((item) => item._id === riskyImageActivity.id)[0]
  log(afterPush.auditStatus === 'rejected' && afterPush.machineCheck.images[0].suggest === 'risky', '内容安全：图片违规直接把审核中的活动驳回')
  log(/图片/.test(afterPush.auditRemark) && afterPush.auditBy === '内容安全检测', '内容安全：自动驳回写入原因与来源')
  log(store.activity_audits.filter((item) => item.action === 'image-risky').length >= 1, '内容安全：图片违规写入审核日志')

  resetSecurity()
  const liveActivity = await callActivity('create', { form }, ORGANIZER)
  await callAdmin('approve', { id: liveActivity.id }, ADMIN)
  await pushMediaResult(liveActivity.machineCheck.images[0].traceId, 'risky', 20002)
  const liveDoc = store.activities.filter((item) => item._id === liveActivity.id)[0]
  log(liveDoc.auditStatus === 'rejected', '内容安全：已上线的活动事后被判违规立即下架')
  const publicList = await callActivity('list', { pageIndex: 0, pageSize: 100 }, OTHER)
  log(publicList.list.every((item) => item.id !== liveActivity.id), '内容安全：下架后不再出现在广场')

  resetSecurity()
  const reviewImageActivity = await callActivity('create', { form }, ORGANIZER)
  await pushMediaResult(reviewImageActivity.machineCheck.images[0].traceId, 'review', 100)
  const reviewDoc = store.activities.filter((item) => item._id === reviewImageActivity.id)[0]
  log(reviewDoc.machineReview === true && reviewDoc.auditStatus === 'pending', '内容安全：图片疑似违规标记为需人工复核')

  /* ---------- 内容安全：机审只要有一项不确定，就留给人工 ---------- */
  resetSecurity({ text: 'review' })
  const reviewWithImage = await callActivity(
    'create',
    { form: Object.assign({}, formWithCover, { title: '文本疑似需复核的活动' }) },
    ORGANIZER
  )
  await pushMediaResult(reviewWithImage.machineCheck.images[0].traceId, 'pass', 100)
  await pushMediaResult(reviewWithImage.machineCheck.images[1].traceId, 'pass', 100)
  const reviewWithImageDoc = store.activities.filter((item) => item._id === reviewWithImage.id)[0]
  log(reviewWithImageDoc.auditStatus === 'pending', '内容安全：文本疑似时图片全通过也不自动放行')

  resetSecurity({ text: null })
  const textFailCreate = await silenceErrors(() =>
    callActivity('create', { form: Object.assign({}, formWithCover, { title: '文本接口异常的活动' }) }, ORGANIZER)
  )
  // 图片结论回来时会补检一次文本（这里接口仍然异常，补检同样拿不到结论）
  await silenceErrors(async () => {
    await pushMediaResult(textFailCreate.machineCheck.images[0].traceId, 'pass', 100)
    await pushMediaResult(textFailCreate.machineCheck.images[1].traceId, 'pass', 100)
  })
  const textFailDoc = store.activities.filter((item) => item._id === textFailCreate.id)[0]
  log(textFailDoc.auditStatus === 'pending', '内容安全：文本检测没结论时图片全通过也转人工')

  resetSecurity({ imageFailOnce: true })
  const partialImage = await silenceErrors(() =>
    callActivity(
      'create',
      { form: Object.assign({}, formWithCover, { title: '有图片没送检成功的活动' }) },
      ORGANIZER
    )
  )
  log(partialImage.machineCheck.images.length === 1, '内容安全：单张图片送检失败只跳过这一张')
  await pushMediaResult(partialImage.machineCheck.images[0].traceId, 'pass', 100)
  const partialImageDoc = store.activities.filter((item) => item._id === partialImage.id)[0]
  log(partialImageDoc.auditStatus === 'pending', '内容安全：有图片没能送检时转人工审核')

  resetSecurity()
  const rejectedByAdmin = await callActivity(
    'create',
    { form: Object.assign({}, formWithCover, { title: '人工驳回后回调通过的活动' }) },
    ORGANIZER
  )
  await callAdmin('reject', { id: rejectedByAdmin.id, remark: '信息不完整' }, ADMIN)
  await pushMediaResult(rejectedByAdmin.machineCheck.images[0].traceId, 'pass', 100)
  await pushMediaResult(rejectedByAdmin.machineCheck.images[1].traceId, 'pass', 100)
  const rejectedByAdminDoc = store.activities.filter((item) => item._id === rejectedByAdmin.id)[0]
  log(rejectedByAdminDoc.auditStatus === 'rejected', '内容安全：人工驳回后机审通过不会把活动放上线')

  /* ---------- 内容安全：没有可送检图片时发布当刻判定 ---------- */
  resetSecurity()
  // 封面 / 二维码都不是云存储文件（https 远程图、本机历史路径）时没有可送检的图片，只看文本结论
  const noCheckableForm = Object.assign({}, form, { groupQrCode: 'https://cdn.test/qr.png' })
  const noCheckable = await callActivity('create', { form: noCheckableForm }, ORGANIZER)
  log(
    noCheckable.auditStatus === 'approved' && noCheckable.auditBy === '内容安全检测',
    '内容安全：没有可送检图片时文本与二维码都通过即直接放行'
  )
  const noCheckableEdit = await callActivity(
    'update',
    { id: noCheckable.id, form: Object.assign({}, noCheckableForm, { title: '没有可送检图片的编辑' }) },
    ORGANIZER
  )
  log(noCheckableEdit.auditStatus === 'approved', '内容安全：编辑重提没有可送检图片时同样直接放行')

  resetSecurity({ text: 'review' })
  const noCheckableReview = await callActivity('create', { form: noCheckableForm }, ORGANIZER)
  log(noCheckableReview.auditStatus === 'pending', '内容安全：没有可送检图片但文本疑似时仍留给人工')

  /* ---------- 机审：群二维码识别（只认微信群邀请链接） ---------- */
  resetSecurity()
  const groupQr = await callActivity(
    'create',
    { form: Object.assign({}, form, { title: '群二维码正常的活动' }) },
    ORGANIZER
  )
  log(
    qrCalls.length >= 1 && /^https:\/\//.test(qrCalls[0].imgUrl),
    '二维码识别：发布时把群二维码换成 https 临时链接送识别'
  )
  log(
    groupQr.machineCheck.qrcode.ok === true && groupQr.machineCheck.qrcode.status === 'ok',
    '二维码识别：识别到微信群邀请链接算通过'
  )
  log(
    groupQr.machineCheck.qrcode.content === 'https://weixin.qq.com/g/AaBbCcDd',
    '二维码识别：留存解出的群邀请链接，审核台与发起人都能看到'
  )

  resetSecurity({ qrcode: 'notqr' })
  const noQrCode = await callActivity(
    'create',
    { form: Object.assign({}, form, { title: '上传的不是二维码的活动' }) },
    ORGANIZER
  )
  log(!!noQrCode.id && noQrCode.auditStatus === 'rejected', '二维码识别：没识别到码时直接驳回')
  log(
    noQrCode.auditRemark === '活动二维码上传有误，请重新上传微信群二维码',
    '二维码识别：驳回原因写明重新上传微信群二维码'
  )
  log(noQrCode.auditBy === '内容安全检测', '二维码识别：驳回来源记为内容安全检测')
  log(
    noQrCode.machineCheck.qrcode.status === 'not-qrcode' && noQrCode.machineCheck.qrcode.ok === false,
    '二维码识别：记录「没识别到二维码」的结论'
  )

  resetSecurity({ qrcode: 'notgroup' })
  const notGroupQr = await callActivity(
    'create',
    { form: Object.assign({}, form, { title: '上传了收款码的活动' }) },
    ORGANIZER
  )
  log(
    notGroupQr.auditStatus === 'rejected' &&
      notGroupQr.auditRemark === '活动二维码上传有误，请重新上传微信群二维码' &&
      notGroupQr.machineCheck.qrcode.status === 'not-group',
    '二维码识别：识别到的不是微信群邀请链接时直接驳回，原因写明重新上传微信群二维码'
  )
  // 驳回的活动不进人工待审队列，也不出现在发起人以外的任何列表里
  const pendingAfterQrReject = await callAdmin('list', { status: 'pending' }, ADMIN)
  log(
    !(pendingAfterQrReject.list || []).some((item) => item.id === notGroupQr.id || item.id === noQrCode.id),
    '二维码识别：被驳回的活动不进人工待审队列'
  )
  const qrRejectPublicList = await callActivity('list', { pageIndex: 0, pageSize: 50, sort: 'latest' }, OTHER)
  log(
    !(qrRejectPublicList.list || []).some((item) => item.id === notGroupQr.id || item.id === noQrCode.id),
    '二维码识别：被驳回的活动不出现在广场'
  )

  resetSecurity({ qrcode: null })
  const qrFail = await silenceErrors(() =>
    callActivity('create', { form: Object.assign({}, form, { title: '二维码识别接口异常的活动' }) }, ORGANIZER)
  )
  log(!!qrFail.id && qrFail.auditStatus === 'pending', '二维码识别：接口异常不阻塞发布')
  log(
    qrFail.machineCheck.qrcode.status === 'failed' && qrFail.machineCheck.qrcode.ok === false,
    '二维码识别：接口异常按「没有结论」处理'
  )

  // 二维码识别不通过被驳回后，图片结论全回来且全是 pass 也不能自动放行（不能覆盖驳回结论）
  resetSecurity({ qrcode: 'notgroup' })
  const notGroupWithImages = await callActivity(
    'create',
    { form: Object.assign({}, formWithCover, { title: '二维码不是群码的图片活动' }) },
    ORGANIZER
  )
  await pushMediaResult(notGroupWithImages.machineCheck.images[0].traceId, 'pass', 100)
  await pushMediaResult(notGroupWithImages.machineCheck.images[1].traceId, 'pass', 100)
  const notGroupDoc = store.activities.filter((item) => item._id === notGroupWithImages.id)[0]
  log(
    notGroupDoc.auditStatus === 'rejected' && notGroupDoc.auditRemark === '活动二维码上传有误，请重新上传微信群二维码',
    '二维码识别：被驳回后图片全通过也不会被机审放行'
  )

  resetSecurity({ text: 'risky' })
  const blockedEdit = await callActivity('update', { id: withImage.id, form }, ORGANIZER)
  log(blockedEdit.code === 'CONTENT_RISKY', '内容安全：编辑重提同样做文本检测')

  // 云函数超时很短（控制台默认 3 秒），检测接口变慢时必须在预算内降级，不能拖垮发布
  resetSecurity({ textDelay: 1800 })
  const slowStart = Date.now()
  const slowCreate = await silenceErrors(() =>
    callActivity('create', { form: Object.assign({}, form, { title: '检测接口很慢的活动' }) }, ORGANIZER)
  )
  const slowCost = Date.now() - slowStart
  log(!!slowCreate.id && slowCreate.auditStatus === 'pending', '内容安全：检测接口变慢时依然发布成功')
  log(slowCreate.machineCheck.text.failed === true, '内容安全：超预算的检测按降级处理')
  log(slowCost < 1700, `内容安全：超预算时不会一直等接口（实际 ${slowCost}ms）`)

  /* ---------- 审核台能拿到机器检测结果 ---------- */
  resetSecurity()
  const adminView = await callAdmin('list', { status: 'all', keyword: '需人工复核的活动' }, ADMIN)
  log(adminView.list.length === 1 && adminView.list[0].machineReview === true, '审核台：列表返回机器复核标记')
  log(!!adminView.list[0].machineCheck, '审核台：列表返回机器检测详情')

  /* ---------- 广场：已关闭活动的可见性与沉底排序 ---------- */
  resetStore()
  resetSecurity()
  seedUser(ORGANIZER, '发起人')
  const nowTs = Date.now()
  const closedDayStart = new Date().setHours(0, 0, 0, 0)
  const openIds = ['act_open_1', 'act_open_2', 'act_open_3']
  openIds.forEach((id, index) => {
    seedActivity({
      _id: id,
      title: `未关闭活动 ${index + 1}`,
      auditStatus: 'approved',
      createTime: nowTs + index,
    })
  })
  seedActivity({
    _id: 'act_closed_today',
    title: '今天关闭的活动',
    auditStatus: 'approved',
    status: 'closed',
    // 发布时间最新：不加沉底规则时它会排在广场第一位
    createTime: nowTs + 100,
    closeTime: nowTs,
  })
  seedActivity({
    _id: 'act_closed_yesterday',
    title: '昨天关闭的活动',
    auditStatus: 'approved',
    status: 'closed',
    closeTime: closedDayStart - 86400000,
  })
  seedActivity({
    _id: 'act_closed_legacy',
    title: '上线前关闭的活动（没有关闭时间）',
    auditStatus: 'approved',
    status: 'closed',
  })

  const closedList = await callActivity('list', { pageIndex: 0, pageSize: 50, sort: 'latest' }, OTHER)
  const closedIds = closedList.list.map((item) => item.id)
  log(closedIds.indexOf('act_closed_today') > -1, '关闭活动：关闭当天的活动仍留在广场')
  log(
    closedIds.indexOf('act_closed_yesterday') === -1 && closedIds.indexOf('act_closed_legacy') === -1,
    '关闭活动：昨天关闭 / 没有关闭时间的活动不再展示'
  )
  log(closedList.total === 4, `关闭活动：总数只算未关闭 + 关闭当天的活动（实际 ${closedList.total}）`)
  log(
    closedList.list[0].id === 'act_open_3' && closedList.list[3].id === 'act_closed_today',
    '关闭活动：已关闭的活动沉底，最新发布也排在未关闭活动之后'
  )

  const openedFirstPage = await callActivity('list', { pageIndex: 0, pageSize: 2, sort: 'latest' }, OTHER)
  log(
    openedFirstPage.list.every((item) => item.status !== 'closed') && openedFirstPage.hasMore === true,
    '关闭活动：第一页先排满未关闭的活动'
  )
  const closedSecondPage = await callActivity('list', { pageIndex: 1, pageSize: 2, sort: 'latest' }, OTHER)
  log(
    closedSecondPage.list.length === 2 &&
      closedSecondPage.list[1].id === 'act_closed_today' &&
      closedSecondPage.hasMore === false,
    '关闭活动：跨页时已关闭的活动仍然沉底，不会插到未关闭活动前面'
  )

  const closedHotList = await callActivity('list', { pageIndex: 0, pageSize: 50, sort: 'hot' }, OTHER)
  log(
    closedHotList.list[closedHotList.list.length - 1].id === 'act_closed_today',
    '关闭活动：按最热门排序时同样沉底'
  )

  const closedFilteredList = await callActivity('list', { pageIndex: 0, pageSize: 50, city: '北京' }, OTHER)
  log(
    closedFilteredList.total === 0 && closedFilteredList.list.length === 0,
    '关闭活动：城市筛选与已关闭活动的可见性条件可叠加'
  )

  const closedHome = await callActivity('home', { city: '' }, OTHER)
  log(
    closedHome.hotList.concat(closedHome.newestList).every((item) => item.status !== 'closed'),
    '关闭活动：首页热门 / 最新不展示已关闭的活动'
  )

  const closedDetail = await callActivity('detail', { id: 'act_closed_yesterday' }, OTHER)
  log(
    !!closedDetail && closedDetail.status === 'closed',
    '关闭活动：不在广场展示后，详情与分享链接依然可访问'
  )
  const closedMine = await callActivity('mine', { kind: 'published' }, ORGANIZER)
  log(
    closedMine.some((item) => item.id === 'act_closed_yesterday'),
    '关闭活动：我的发布里仍能看到已关闭的活动'
  )

  const toggleClosed = await callActivity('toggle', { id: 'act_open_1' }, ORGANIZER)
  log(
    toggleClosed.status === 'closed' && toggleClosed.closeTime > 0,
    '关闭活动：关闭时写入关闭时间'
  )
  const closedAfterToggle = await callActivity('list', { pageIndex: 0, pageSize: 50, sort: 'latest' }, OTHER)
  log(
    closedAfterToggle.list[closedAfterToggle.list.length - 1].id === 'act_open_1' &&
      closedAfterToggle.total === 4,
    '关闭活动：刚关闭的活动留在广场并沉底'
  )

  const toggleOpened = await callActivity('toggle', { id: 'act_open_1' }, ORGANIZER)
  log(
    toggleOpened.status === 'recruiting' && toggleOpened.closeTime === 0,
    '重新打开：状态恢复 recruiting 且清空关闭时间'
  )
  const openedSquare = await callActivity('list', { pageIndex: 0, pageSize: 50, sort: 'latest' }, OTHER)
  log(
    openedSquare.list.some((item) => item.id === 'act_open_1') &&
      openedSquare.list[openedSquare.list.length - 1].id === 'act_closed_today' &&
      openedSquare.total === 4,
    '重新打开：活动立即回到广场的未关闭序列'
  )
}

run()
  .catch((e) => {
    log(false, `云函数链路执行异常：${e && e.stack ? e.stack.split('\n')[0] : e}`)
  })
  .then(() => {
    console.log(`\n通过 ${passed.length} 项，失败 ${errors.length} 项\n`)
    // 默认只列失败项；加 CLOUD_VALIDATE_VERBOSE=1 可以把逐条结论也打出来
    if (process.env.CLOUD_VALIDATE_VERBOSE) {
      console.log('通过项：')
      passed.forEach((item) => console.log(`  ✓ ${item}`))
    }
    if (errors.length) {
      console.log('失败项：')
      errors.forEach((item) => console.log(`  ✗ ${item}`))
    } else {
      console.log('✅ 云函数审核链路全部通过')
    }
    process.exitCode = errors.length ? 1 : 0
  })
