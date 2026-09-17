// 统一服务层：Mock 与云开发模式接口签名完全一致，通过 config.useMock 切换
const config = require('./config')
const { KEYS, getStorage, setStorage } = require('../utils/storage')
const { getType, supportsTags, supportsMetrics, tagName } = require('../utils/dict')
const { matchCity, normalizeCity, singleCityKey } = require('../utils/cities')
const { delay, deepClone, formatCardDate, WEEKDAY_TEXT } = require('../utils/util')
const { LOCATION_MAX, ADDRESS_MAX } = require('../utils/location')
const audit = require('../utils/audit')
const mock = require('./mock')

const AVATAR_COLORS = ['#4ECDC4', '#45B7D1', '#FF8E72', '#F6D365', '#00CDAC', '#FA709A', '#44A08D', '#A8DADC', '#FF7D00']

function fail(code, message) {
  return Promise.reject(mock.error(code, message))
}

function withDelay(data) {
  return delay(config.mockDelay).then(() => data)
}

/** Mock 模式的坐标清洗：与云函数 helper 的 coord、前端 usableCoord 同一口径 */
function mockCoord(value, kind) {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return 0
  const min = kind === 'lat' ? 3 : 73
  const max = kind === 'lat' ? 54 : 136
  return parsed >= min && parsed <= max ? parsed : 0
}

/** Mock 模式：表单 -> 活动字段，发布与编辑共用（云模式对应云函数的 normalizeForm） */
function mockFormFields(form) {
  const type = getType(form.type)
  return {
    type: type.key,
    typeName: type.name,
    emoji: type.emoji,
    color: type.color,
    bg: `linear-gradient(135deg, ${type.from} 0%, ${type.to} 100%)`,
    title: String(form.title || '').slice(0, 30),
    cover: form.cover || '',
    groupQrCode: form.groupQrCode || '',
    desc: String(form.desc || '').slice(0, 500),
    location: String(form.location || '').slice(0, LOCATION_MAX),
    // 地图选点带上来的完整地址不展示，只参与城市匹配（手输时退回地点文本本身）
    locationAddress: String(form.locationAddress || '').slice(0, ADDRESS_MAX),
    // 地图选点带上来的坐标不展示，详情页 / 广场卡片点地址时用它调起导航（手输时是 0）
    locationLat: mockCoord(form.locationLat, 'lat'),
    locationLng: mockCoord(form.locationLng, 'lng'),
    // 地址里认不出城市（手输「双流区润和路附近」这类缺省市的短地址）时退回发布者当前城市，
    // 否则 city 为空，按城市筛选时这条活动永远查不到；省份 / 全国这种落不到单城的提示不采用
    city: matchCity(form.locationAddress || form.location) || singleCityKey(form.cityHint),
    startTime: form.startTime,
    endTime: form.endTime,
    startWeekday: new Date(form.startTime).getDay(),
    difficulty: supportsMetrics(type.key) ? form.difficulty || 0 : 0,
    distance: supportsMetrics(type.key) ? form.distance || 0 : 0,
    elevationGain: supportsMetrics(type.key) ? form.elevationGain || 0 : 0,
    fee: form.feeMode === 'fixed' ? form.fee || 0 : 0,
    feeMode: form.feeMode || 'aa',
    maxPeople: form.maxPeople || 10,
    tags: supportsTags(type.key) ? form.tags || [] : [],
  }
}

/**
 * Mock 模式的内容安全模拟：命中关键词即视为违规 / 疑似，方便本地验证拦截与审核台标记。
 * 云端这一段的真实实现在 cloudfunctions/activity/lib/contentCheck.js。
 */
const MOCK_RISKY_WORDS = ['违规', '赌博', '代刷', '外挂']
const MOCK_REVIEW_WORDS = ['疑似', '兼职']

function mockMachineCheck(form) {
  const content = [form.title, form.location, form.desc].filter(Boolean).join('\n')
  const risky = MOCK_RISKY_WORDS.some((word) => content.indexOf(word) > -1)
  const review = MOCK_REVIEW_WORDS.some((word) => content.indexOf(word) > -1)
  const suggest = risky ? 'risky' : review ? 'review' : 'pass'
  return {
    blocked: risky,
    text: { suggest, label: risky ? 20001 : 0, traceId: '', time: Date.now(), failed: false },
    // Mock 模式没有云存储文件，图片检测恒为空
    images: [],
    checkedAt: Date.now(),
  }
}

/** 云开发模式：统一 action 路由 */
function callCloud(action, payload) {
  return new Promise((resolve, reject) => {
    wx.cloud.callFunction({
      name: 'activity',
      data: Object.assign({ action }, payload || {}),
      success: (res) => {
        const result = res && res.result
        if (result && result.code) {
          const err = new Error(result.message || '操作失败')
          err.code = result.code
          reject(err)
          return
        }
        resolve(result)
      },
      fail: () => {
        const err = new Error('网络异常，请稍后重试')
        err.code = 'NETWORK_ERROR'
        reject(err)
      },
    })
  })
}

/** 审核云函数：失败结构与 activity 云函数保持一致 */
function callAdmin(action, payload) {
  return new Promise((resolve, reject) => {
    wx.cloud.callFunction({
      name: 'admin',
      data: Object.assign({ action }, payload || {}),
      success: (res) => {
        const result = res && res.result
        if (result && result.code) {
          const err = new Error(result.message || '操作失败')
          err.code = result.code
          reject(err)
          return
        }
        resolve(result)
      },
      fail: () => {
        const err = new Error('网络异常，请稍后重试')
        err.code = 'NETWORK_ERROR'
        reject(err)
      },
    })
  })
}

/* ------------------------------ Mock 实现 ------------------------------ */

const mockApi = {
  home(payload) {
    const city = (payload && payload.city) || ''
    const list = mock.cityFilter(mock.visibleActivities(), city)
    const hotList = list
      .slice()
      .sort((a, b) => b.joinedCount - a.joinedCount)
      .slice(0, 6)
    const newestList = list
      .slice()
      .sort((a, b) => b.createTime - a.createTime)
      .slice(0, 3)
    return withDelay({
      banners: deepClone(mock.DEFAULT_BANNERS),
      hotList,
      newestList,
      empty: list.length === 0,
    })
  },

  list(params) {
    const query = params || {}
    const pageIndex = query.pageIndex || 0
    const pageSize = query.pageSize || 10
    const sort = query.sort || 'time'
    const keyword = String(query.keyword || '').trim().toLowerCase()

    // 公开列表：审核中 / 未通过的活动不出现在广场
    let list = mock.visibleActivities()
    if (query.city) {
      list = mock.cityFilter(list, query.city)
    }
    if (query.type && query.type !== 'all') {
      list = list.filter((item) => item.type === query.type)
    }
    if (typeof query.weekday === 'number' && query.weekday >= 0) {
      list = list.filter((item) => item.startWeekday === query.weekday)
    }
    if (keyword) {
      list = list.filter(
        (item) =>
          String(item.title).toLowerCase().indexOf(keyword) > -1 ||
          String(item.location).toLowerCase().indexOf(keyword) > -1 ||
          // 地址不展示，但要能被搜到，用户按「双流」这类关键词也能找到活动
          String(item.locationAddress || '').toLowerCase().indexOf(keyword) > -1
      )
    }

    if (sort === 'hot') {
      list.sort((a, b) => b.joinedCount - a.joinedCount)
    } else if (sort === 'latest') {
      list.sort((a, b) => b.createTime - a.createTime)
    } else {
      list.sort((a, b) => a.startTime - b.startTime)
    }

    const total = list.length
    const start = pageIndex * pageSize
    const pageList = list.slice(start, start + pageSize)
    return withDelay({
      list: pageList,
      hasMore: start + pageSize < total,
      total,
    })
  },

  detail(id) {
    const activity = mock.findActivity(id)
    if (!activity) return withDelay(null)
    const user = mock.currentUser()
    const isOrganizer = !!user && activity.organizer.openid === user.openid
    // 审核中 / 未通过的活动只有发起人自己能预览，其他人按「不存在」处理
    if (!audit.isApproved(activity) && !isOrganizer) return withDelay(null)
    const result = deepClone(activity)
    result.joined = !!user && result.joinedPeople.some((item) => item.openid === user.openid)
    result.isOrganizer = isOrganizer
    result.full = result.joinedCount >= result.maxPeople
    return withDelay(result)
  },

  create(payload) {
    const user = mock.currentUser()
    if (!user) return fail('UNAUTHORIZED', '请先登录')
    const form = (payload && payload.form) || {}
    const machine = mockMachineCheck(form)
    if (machine.blocked) return fail('CONTENT_RISKY', '内容未通过安全检测，请修改后重新提交')
    const id = `mock_act_${Date.now()}`
    const activity = Object.assign(mockFormFields(form), {
      id,
      _id: id,
      joinedPeople: [],
      joinedCount: 0,
      organizer: mock.memberOf(user),
      createTime: Date.now(),
      status: 'recruiting',
      // 新发布的活动一律先进审核队列
      auditStatus: 'pending',
      auditRemark: '',
      auditTime: 0,
      auditBy: '',
      submitTime: Date.now(),
      machineCheck: { text: machine.text, images: machine.images, checkedAt: machine.checkedAt },
      machineReview: machine.text.suggest === 'review',
      machinePending: false,
      miniQrCode: '',
    })
    const published = getStorage(KEYS.published, []) || []
    published.unshift(activity)
    setStorage(KEYS.published, published)
    return withDelay(activity)
  },

  /** 编辑：仅发起人可改，改动后重新进入审核（与云端 update 行为一致） */
  update(payload) {
    const params = payload || {}
    const id = params.id || ''
    const user = mock.currentUser()
    if (!user) return fail('UNAUTHORIZED', '请先登录')
    const activity = mock.findActivity(id)
    if (!activity) return fail('NOT_FOUND', '活动不存在或已下架')
    if (activity.organizer.openid !== user.openid) return fail('FORBIDDEN', '仅发起人可修改')

    const machine = mockMachineCheck(params.form || {})
    if (machine.blocked) return fail('CONTENT_RISKY', '内容未通过安全检测，请修改后重新提交')

    const patch = Object.assign(mockFormFields(params.form || {}), {
      auditStatus: 'pending',
      auditRemark: '',
      auditTime: 0,
      auditBy: '',
      submitTime: Date.now(),
      machineCheck: { text: machine.text, images: machine.images, checkedAt: machine.checkedAt },
      machineReview: machine.text.suggest === 'review',
      machinePending: false,
    })
    const published = getStorage(KEYS.published, []) || []
    const index = published.findIndex((item) => item.id === id)
    if (index > -1) {
      published[index] = Object.assign({}, published[index], patch)
      setStorage(KEYS.published, published)
    }
    // 审核结果存在独立的覆盖表里，重提时同步清掉上一次的驳回结论
    mock.saveAudit(id, {
      auditStatus: 'pending',
      auditRemark: '',
      auditTime: 0,
      auditBy: '',
      submitTime: Date.now(),
    })
    return withDelay(deepClone(mock.findActivity(id)))
  },

  join(id) {
    const user = mock.currentUser()
    if (!user) return fail('UNAUTHORIZED', '请先登录')
    const activity = mock.findActivity(id)
    if (!activity) return fail('NOT_FOUND', '活动不存在或已下架')
    if (!audit.isApproved(activity)) return fail('AUDIT_PENDING', '活动审核通过后才能报名')
    if (activity.status === 'closed') return fail('ACTIVITY_CLOSED', '活动已关闭，无法报名')
    const already = activity.joinedPeople.some((item) => item.openid === user.openid)
    if (already) return withDelay(deepClone(activity))
    if (activity.joinedCount >= activity.maxPeople) return fail('ACTIVITY_FULL', '活动已满员')

    const joinMap = getStorage(mock.MOCK_JOIN_MAP, {}) || {}
    const members = (joinMap[id] || []).concat([mock.memberOf(user)])
    joinMap[id] = members
    setStorage(mock.MOCK_JOIN_MAP, joinMap)

    const joined = getStorage(KEYS.joined, []) || []
    if (joined.indexOf(id) === -1) {
      joined.push(id)
      setStorage(KEYS.joined, joined)
    }
    const updated = mock.findActivity(id)
    updated.joined = true
    return withDelay(deepClone(updated))
  },

  quit(id) {
    const user = mock.currentUser()
    if (!user) return fail('UNAUTHORIZED', '请先登录')
    const joinMap = getStorage(mock.MOCK_JOIN_MAP, {}) || {}
    const members = joinMap[id] || []
    joinMap[id] = members.filter((item) => item.openid !== user.openid)
    setStorage(mock.MOCK_JOIN_MAP, joinMap)

    const joined = (getStorage(KEYS.joined, []) || []).filter((item) => item !== id)
    setStorage(KEYS.joined, joined)

    // 发起人自己报名后退出，同样需要清理基础数据里的记录
    const published = getStorage(KEYS.published, []) || []
    const index = published.findIndex((item) => item.id === id)
    if (index > -1) {
      published[index].joinedPeople = (published[index].joinedPeople || []).filter(
        (item) => item.openid !== user.openid
      )
      published[index].joinedCount = published[index].joinedPeople.length
      setStorage(KEYS.published, published)
    }
    const updated = mock.findActivity(id)
    if (updated) updated.joined = false
    return withDelay(deepClone(updated))
  },

  toggle(id) {
    const user = mock.currentUser()
    if (!user) return fail('UNAUTHORIZED', '请先登录')
    const activity = mock.findActivity(id)
    if (!activity) return fail('NOT_FOUND', '活动不存在或已下架')
    if (activity.organizer.openid !== user.openid) return fail('FORBIDDEN', '仅发起人可操作')
    if (!audit.isApproved(activity)) return fail('AUDIT_PENDING', '活动审核通过后才能开启或关闭')
    const nextStatus = activity.status === 'closed' ? 'recruiting' : 'closed'

    const published = getStorage(KEYS.published, []) || []
    const index = published.findIndex((item) => item.id === id)
    if (index > -1) {
      published[index].status = nextStatus
      setStorage(KEYS.published, published)
    }
    mock.saveStatus(id, nextStatus)

    const updated = mock.findActivity(id)
    updated.status = nextStatus
    return withDelay(deepClone(updated))
  },

  mine(kind) {
    const user = mock.currentUser()
    if (!user) return fail('UNAUTHORIZED', '请先登录')
    if (kind === 'published') {
      const list = mock
        .allActivities()
        .filter((item) => item.organizer.openid === user.openid)
        .sort((a, b) => b.createTime - a.createTime)
      return withDelay(list)
    }
    const joinedIds = getStorage(KEYS.joined, []) || []
    const list = mock
      .allActivities()
      .filter((item) => joinedIds.indexOf(item.id) > -1)
      .sort((a, b) => a.startTime - b.startTime)
    return withDelay(list)
  },

  user() {
    return withDelay(mock.currentUser())
  },

  login(payload) {
    const params = payload || {}
    const existed = getStorage(KEYS.user, null)
    if (existed && existed.openid) {
      const merged = Object.assign({}, existed, {
        phone: params.phone || existed.phone || '',
      })
      setStorage(KEYS.user, merged)
      return withDelay(merged)
    }
    const counter = (getStorage(KEYS.userCounter, 0) || 0) + 1
    setStorage(KEYS.userCounter, counter)
    const phone = params.phone || ''
    const guest = !phone
    const nickName = guest ? '微信用户' : `${phone.slice(0, 3)}****${phone.slice(-4)}`
    const user = {
      openid: `mock_openid_${counter}`,
      userId: counter,
      nickName,
      avatarUrl: '',
      avatarColor: AVATAR_COLORS[counter % AVATAR_COLORS.length],
      avatarText: nickName.slice(0, 1),
      phone,
      bio: '',
      isGuest: guest,
      createTime: Date.now(),
    }
    setStorage(KEYS.user, user)
    return withDelay(user)
  },

  updateUser(payload) {
    const userInfo = (payload && payload.userInfo) || {}
    const existed = getStorage(KEYS.user, null)
    if (!existed) return fail('UNAUTHORIZED', '请先登录')
    const merged = Object.assign({}, existed, userInfo)
    if (merged.nickName) {
      merged.avatarText = merged.avatarText || merged.nickName.slice(0, 1)
    }
    setStorage(KEYS.user, merged)

    // 同步已发布活动的发起人快照
    const published = getStorage(KEYS.published, []) || []
    let changed = false
    published.forEach((item) => {
      if (item.organizer && item.organizer.openid === merged.openid) {
        item.organizer = mock.memberOf(merged)
        changed = true
      }
    })
    if (changed) setStorage(KEYS.published, published)

    // 同步我已报名活动中的成员快照
    const joinMap = getStorage(mock.MOCK_JOIN_MAP, {}) || {}
    let joinChanged = false
    Object.keys(joinMap).forEach((key) => {
      joinMap[key] = (joinMap[key] || []).map((member) => {
        if (member.openid === merged.openid) {
          joinChanged = true
          return mock.memberOf(merged)
        }
        return member
      })
    })
    if (joinChanged) setStorage(mock.MOCK_JOIN_MAP, joinMap)
    return withDelay(merged)
  },

  qrcode(id) {
    const activity = mock.findActivity(id)
    if (!activity) return fail('NOT_FOUND', '活动不存在或已下架')
    return withDelay({ fileID: activity.miniQrCode || '' })
  },

  feedback(payload) {
    const content = String((payload && payload.content) || '').slice(0, 1000)
    const user = mock.currentUser()
    const record = {
      id: `mock_fb_${Date.now()}`,
      openid: (user && user.openid) || '',
      nickName: (user && user.nickName) || '未登录用户',
      avatarUrl: (user && user.avatarUrl) || '',
      content,
      createTime: Date.now(),
      status: 'pending',
    }
    const list = getStorage(KEYS.feedback, []) || []
    list.unshift(record)
    setStorage(KEYS.feedback, list)
    return withDelay({ id: record.id, createTime: record.createTime })
  },

  /** Mock 的封面 / 二维码是本机临时路径，没有云存储文件需要换临时链接 */
  media() {
    return withDelay({})
  },

  /* ------------------------- 本地审核（仅 Mock 模式） ------------------------- */
  // Mock 模式下把当前登录用户当作审核人，方便本地把审核链路完整跑通。
  // 云端权限判断在 cloudfunctions/admin 里，与这里互不影响。

  adminWhoami() {
    const user = mock.currentUser()
    return withDelay({ openid: (user && user.openid) || '', isAdmin: !!user, name: '本地调试管理员' })
  },

  adminList(params) {
    const query = params || {}
    const status = query.status || 'pending'
    const pageIndex = Math.max(0, query.pageIndex || 0)
    const pageSize = Math.max(1, query.pageSize || 20)
    const keyword = String(query.keyword || '').trim().toLowerCase()
    const all = mock.allActivities()

    let list = all.filter((item) => status === 'all' || audit.auditStatusOf(item) === status)
    if (keyword) {
      list = list.filter((item) => {
        const organizer = item.organizer || {}
        return (
          String(item.title || '').toLowerCase().indexOf(keyword) > -1 ||
          String(item.location || '').toLowerCase().indexOf(keyword) > -1 ||
          String(item.locationAddress || '').toLowerCase().indexOf(keyword) > -1 ||
          String(organizer.nickName || '').toLowerCase().indexOf(keyword) > -1
        )
      })
    }
    // 与云端一致：待审队列按提交审核时间倒序，编辑重提会重新排到最前
    list = list.slice().sort((a, b) => (b.submitTime || b.createTime) - (a.submitTime || a.createTime))

    const countOf = (value) => all.filter((item) => audit.auditStatusOf(item) === value).length
    const total = list.length
    const start = pageIndex * pageSize
    return withDelay({
      list: list.slice(start, start + pageSize),
      total,
      hasMore: start + pageSize < total,
      stats: {
        pending: countOf('pending'),
        approved: countOf('approved'),
        rejected: countOf('rejected'),
        total: all.length,
      },
      // Mock 的封面是本机临时路径，没有云存储文件需要换临时链接，保持与云端同结构
      media: {},
    })
  },

  adminDetail(id) {
    const activity = mock.findActivity(id)
    if (!activity) return withDelay(null)
    return withDelay(Object.assign(deepClone(activity), { media: {} }))
  },

  adminApprove(id) {
    const user = mock.currentUser()
    if (!user) return fail('UNAUTHORIZED', '请先登录')
    const activity = mock.findActivity(id)
    if (!activity) return fail('NOT_FOUND', '活动不存在')
    const auditTime = Date.now()
    mock.saveAudit(id, { auditStatus: 'approved', auditRemark: '', auditTime, auditBy: '本地调试管理员' })
    return withDelay({ id, auditStatus: 'approved', auditTime })
  },

  adminReject(id, remark) {
    const user = mock.currentUser()
    if (!user) return fail('UNAUTHORIZED', '请先登录')
    const reason = String(remark || '').trim()
    if (!reason) return fail('INVALID_PARAM', '请填写驳回原因')
    const activity = mock.findActivity(id)
    if (!activity) return fail('NOT_FOUND', '活动不存在')
    const auditTime = Date.now()
    mock.saveAudit(id, {
      auditStatus: 'rejected',
      auditRemark: reason.slice(0, 200),
      auditTime,
      auditBy: '本地调试管理员',
    })
    return withDelay({ id, auditStatus: 'rejected', auditRemark: reason.slice(0, 200), auditTime })
  },
}

/* ---------------------------- 云开发实现（M5） ---------------------------- */

const cloudApi = {
  home(payload) {
    return callCloud('home', payload)
  },
  list(params) {
    return callCloud('list', params)
  },
  detail(id) {
    return callCloud('detail', { id })
  },
  create(payload) {
    return callCloud('create', payload)
  },
  update(payload) {
    return callCloud('update', payload)
  },
  join(id) {
    return callCloud('join', { id })
  },
  quit(id) {
    return callCloud('quit', { id })
  },
  toggle(id) {
    return callCloud('toggle', { id })
  },
  mine(kind) {
    return callCloud('mine', { kind })
  },
  user() {
    return callCloud('user', {})
  },
  login(payload) {
    return callCloud('login', payload)
  },
  updateUser(payload) {
    return callCloud('updateUser', payload)
  },
  qrcode(id) {
    return callCloud('qrcode', { id })
  },
  feedback(payload) {
    return callCloud('feedback', payload)
  },
  /**
   * fileID -> 临时 https 地址。临时链接默认 2 小时过期，
   * 前台图片加载失败时用它按 fileID 重取一次。
   */
  media(fileIDs) {
    return callCloud('media', { fileIDs: fileIDs || [] }).then((res) => (res && res.media) || {})
  },
  adminWhoami() {
    return callAdmin('whoami', {})
  },
  adminList(params) {
    return callAdmin('list', params)
  },
  adminDetail(id) {
    return callAdmin('detail', { id })
  },
  adminApprove(id) {
    return callAdmin('approve', { id })
  },
  adminReject(id, remark) {
    return callAdmin('reject', { id, remark })
  },
  adminLogs(params) {
    return callAdmin('logs', params)
  },
  adminMigrate() {
    return callAdmin('migrate', {})
  },
}

const api = config.useMock ? mockApi : cloudApi

/** 活动卡片展示所需的派生字段 */
function decorate(activity) {
  if (!activity) return null
  const item = deepClone(activity)
  item.dateText = item.startTime ? formatCardDate(item.startTime) : ''
  item.feeText = item.feeMode === 'fixed' ? (item.fee > 0 ? `¥${item.fee}` : '免费') : 'AA制'
  item.peopleText = `${item.joinedCount}/${item.maxPeople}人`
  item.tagNames = (item.tags || []).map(tagName).filter(Boolean)
  item.periodText = item.endTime ? formatCardDate(item.endTime) : '待定'
  item.weekdayName = WEEKDAY_TEXT[item.startWeekday] || ''
  item.difficultyText = item.difficulty ? `${item.difficulty}★` : ''
  item.avatarList = (item.joinedPeople || []).slice(0, 5)
  item.isClosed = item.status === 'closed'
  item.isFull = item.joinedCount >= item.maxPeople
  item.showMetrics = supportsMetrics(item.type)
  // 全程长度 / 累计爬升为非必填，未填写（0）时详情页不展示对应行
  item.hasDistance = item.distance > 0
  item.hasElevationGain = item.elevationGain > 0
  // 审核状态：已通过时 auditText 为空，卡片仍按「招募中 / 已关闭」展示
  item.auditStatus = audit.auditStatusOf(item)
  item.auditText = audit.auditTextOf(item)
  item.auditApproved = item.auditStatus === audit.AUDIT_STATUS.APPROVED
  item.auditPending = item.auditStatus === audit.AUDIT_STATUS.PENDING
  item.auditRejected = item.auditStatus === audit.AUDIT_STATUS.REJECTED
  item.auditReason = audit.auditReasonOf(item)
  return item
}

module.exports = Object.assign({}, api, { decorate, normalizeCity })
