// 统一服务层：Mock 与云开发模式接口签名完全一致，通过 config.useMock 切换
const config = require('./config')
const { KEYS, getStorage, setStorage, removeStorage } = require('../utils/storage')
const { getType, supportsTags, supportsMetrics, tagName } = require('../utils/dict')
const { matchCity, normalizeCity, singleCityKey } = require('../utils/cities')
const { delay, deepClone, formatCardDate, WEEKDAY_TEXT } = require('../utils/util')
const { LOCATION_MAX, ADDRESS_MAX } = require('../utils/location')
const audit = require('../utils/audit')
// 展示期：发布满 7 天的活动对外按「已关闭」处理（与云函数 lib/expire.js 同一口径）
const expire = require('../utils/expire')
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
    // 费用只做信息说明：AA 制 / 非 AA 制由发起人选择，非 AA 制附一段文字说明，平台不参与任何资金流转
    feeMode: form.feeMode === 'nonAA' || form.feeMode === 'fixed' ? 'nonAA' : 'aa',
    feeNote: form.feeMode === 'nonAA' || form.feeMode === 'fixed' ? form.feeNote || '' : '',
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
/** Mock 里用文件名模拟二维码识别的两种不通过情况（云端用 img.scanQRCode 真实识别） */
const MOCK_QR_NO_CODE = 'noqrcode'
const MOCK_QR_NOT_GROUP = 'notgroup'

/** 举报原因候选：与云端 activity 云函数的 REPORT_REASONS 保持一致 */
const REPORT_REASONS = ['虚假信息或诈骗', '违法违规内容', '侵权或盗用他人内容', '广告骚扰', '其他']

/** Mock 版文本送检：命中违规词视为不通，供昵称这类短文本复用 */
function mockTextRisky(content) {
  const value = String(content || '')
  if (!value) return false
  return MOCK_RISKY_WORDS.some((word) => value.indexOf(word) > -1)
}

/**
 * Mock 版默认昵称，与云端 activity 云函数的 defaultNickName 保持一致：
 * 昵称对外可见，不能用手机号（哪怕是掩码），统一「微信用户 + 用户编号」。
 */
function mockDefaultNickName(userId) {
  const id = Math.floor(Number(userId) || 0)
  return id > 0 ? `微信用户${id}` : '微信用户'
}

/**
 * 群二维码识别：与云端 lib/contentCheck.js 的 checkQrCode 同一套结论。
 * Mock 不做真实识别，默认视为「识别到微信群邀请链接」，只有文件名带关键词时才模拟不通过。
 */
function mockQrCodeCheck(file) {
  const value = String(file || '')
  const base = { typeName: '', content: '', time: Date.now() }
  if (!value) {
    return Object.assign(base, { status: 'failed', ok: false, message: '未上传群二维码' })
  }
  if (value.indexOf(MOCK_QR_NO_CODE) > -1) {
    return Object.assign(base, { status: 'not-qrcode', ok: false, message: '这张图里没有识别到二维码' })
  }
  if (value.indexOf(MOCK_QR_NOT_GROUP) > -1) {
    return Object.assign(base, {
      status: 'not-group',
      ok: false,
      typeName: 'QR_CODE',
      content: 'https://pay.example.com/mock',
      message: '识别到码，但不是微信群邀请链接',
    })
  }
  return Object.assign(base, {
    status: 'ok',
    ok: true,
    typeName: 'QR_CODE',
    content: 'https://weixin.qq.com/g/mockgroup',
    message: '识别到微信群邀请链接',
  })
}

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
    qrcode: mockQrCodeCheck(form.groupQrCode),
    checkedAt: Date.now(),
  }
}

/**
 * 机审放行判定：与云端两个云函数里的 lib/autoAudit.js 同一套规则。
 * Mock 的封面 / 二维码是本机临时路径，没有可送检的图片，所以看文本结论 + 二维码识别结论；
 * 文本疑似（review）留在待审队列交给人工；二维码识别出「不是微信群码」时直接驳回，见 mockQrReject。
 */
function mockAutoAudit(machine) {
  if (machine.text.suggest !== 'pass' || machine.text.failed || !machine.qrcode.ok) {
    return { auditStatus: 'pending', auditRemark: '', auditTime: 0, auditBy: '' }
  }
  return { auditStatus: 'approved', auditRemark: '', auditTime: Date.now(), auditBy: '内容安全检测' }
}

/** 群二维码没识别出微信群邀请链接时的驳回原因，与云端 lib/contentCheck.js 的 QR_REJECT_REMARK 一致 */
const QR_REJECT_REMARK = '活动二维码上传有误，请重新上传微信群二维码'

/**
 * 群二维码识别结论明确「不是微信群邀请二维码」：直接驳回，不进人工队列。
 * 接口异常 / 没结论（failed）不驳回，交给人工复核（与云端 qrRejectPatch 同一套规则）。
 */
function mockQrReject(machine) {
  const status = (machine && machine.qrcode && machine.qrcode.status) || ''
  if (status !== 'not-qrcode' && status !== 'not-group') return {}
  return { auditStatus: 'rejected', auditRemark: QR_REJECT_REMARK, auditTime: Date.now(), auditBy: '内容安全检测' }
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
      fail: (error) => {
        const err = new Error('网络异常，请稍后重试')
        err.code = 'NETWORK_ERROR'
        // 原始错误（errCode / errMsg）留着排查：能区分「网络不通」和「云开发不允许未登录访问」
        // 这类被云函数安全规则拦下的调用（见 README「分享到朋友圈（单页模式）」）
        err.raw = error
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
      fail: (error) => {
        const err = new Error('网络异常，请稍后重试')
        err.code = 'NETWORK_ERROR'
        err.raw = error
        reject(err)
      },
    })
  })
}

/* ------------------------------ Mock 实现 ------------------------------ */

const mockApi = {
  home(payload) {
    const city = (payload && payload.city) || ''
    // 首页只推荐未关闭的活动：已关闭的活动只在广场保留关闭当天
    const list = mock.cityFilter(mock.homeVisibleActivities(), city)
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

    // 公开列表：审核中 / 未通过的活动不出现在广场；
    // 已关闭的活动只在关闭当天展示，第二天起从广场消失
    let list = mock.visibleActivities().filter((item) => mock.squareVisible(item))
    if (query.city) {
      list = mock.cityFilter(list, query.city)
    }
    if (query.type && query.type !== 'all') {
      list = list.filter((item) => item.type === query.type)
    }
    if (typeof query.weekday === 'number' && query.weekday >= 0) {
      list = list.filter((item) => item.startWeekday === query.weekday)
    }
    // date 传的是当天 00:00 的时间戳，云函数用同一口径做了范围查询
    if (query.date > 0) {
      const dayStart = Number(query.date)
      const dayEnd = dayStart + 86400000
      list = list.filter((item) => item.startTime >= dayStart && item.startTime < dayEnd)
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

    // 已关闭的活动沉底：无论按哪个维度排序，都排在未关闭活动之后
    const closedLast = (a, b) => (a.status === 'closed' ? 1 : 0) - (b.status === 'closed' ? 1 : 0)
    if (sort === 'hot') {
      list.sort((a, b) => closedLast(a, b) || b.joinedCount - a.joinedCount)
    } else if (sort === 'latest') {
      list.sort((a, b) => closedLast(a, b) || b.createTime - a.createTime)
    } else {
      list.sort((a, b) => closedLast(a, b) || a.startTime - b.startTime)
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
    // 展示期届满的活动对外按「已关闭」下发（与云函数 publicActivity 同口径）
    expire.applyExpiry(result)
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
    const audit = mockAutoAudit(machine)
    const reject = mockQrReject(machine)
    const id = `mock_act_${Date.now()}`
    const activity = Object.assign(mockFormFields(form), {
      id,
      _id: id,
      joinedPeople: [],
      joinedCount: 0,
      organizer: mock.memberOf(user),
      createTime: Date.now(),
      status: 'recruiting',
      closeTime: 0,
      submitTime: Date.now(),
      machineCheck: { text: machine.text, images: machine.images, qrcode: machine.qrcode, checkedAt: machine.checkedAt },
      machineReview: machine.text.suggest === 'review',
      machinePending: false,
      miniQrCode: '',
      // 审核结论：二维码不通过直接驳回，其次机审通过直接放行，其余进人工队列（与云端同一套规则）
    }, audit, reject)
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
    if (expire.isExpired(activity)) {
      return fail('ACTIVITY_EXPIRED', '活动发布已超过 7 天，已自动关闭，无法修改，请重新发布')
    }

    const machine = mockMachineCheck(params.form || {})
    if (machine.blocked) return fail('CONTENT_RISKY', '内容未通过安全检测，请修改后重新提交')

    const audit = mockAutoAudit(machine)
    const reject = mockQrReject(machine)
    const patch = Object.assign(mockFormFields(params.form || {}), {
      submitTime: Date.now(),
      machineCheck: { text: machine.text, images: machine.images, qrcode: machine.qrcode, checkedAt: machine.checkedAt },
      machineReview: machine.text.suggest === 'review',
      machinePending: false,
    }, audit, reject)
    const published = getStorage(KEYS.published, []) || []
    const index = published.findIndex((item) => item.id === id)
    if (index > -1) {
      published[index] = Object.assign({}, published[index], patch)
      setStorage(KEYS.published, published)
    }
    // 审核结果存在独立的覆盖表里，重提时同步覆盖掉上一次的审核结论（机审通过则直接放行）
    mock.saveAudit(id, Object.assign({ submitTime: Date.now() }, audit, reject))
    return withDelay(deepClone(mock.findActivity(id)))
  },

  join(id) {
    const user = mock.currentUser()
    if (!user) return fail('UNAUTHORIZED', '请先登录')
    const activity = mock.findActivity(id)
    if (!activity) return fail('NOT_FOUND', '活动不存在或已下架')
    if (!audit.isApproved(activity)) return fail('AUDIT_PENDING', '活动审核通过后才能报名')
    if (expire.isExpired(activity)) {
      return fail('ACTIVITY_EXPIRED', '活动发布已超过 7 天，已自动关闭，无法报名')
    }
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
    if (expire.isExpired(activity)) {
      return fail('ACTIVITY_EXPIRED', '活动发布已超过 7 天，已自动关闭，无法重新打开')
    }
    const nextStatus = activity.status === 'closed' ? 'recruiting' : 'closed'
    // 关闭时记录关闭时间，广场据此只保留关闭当天；重新打开时归零
    const nextCloseTime = nextStatus === 'closed' ? Date.now() : 0

    const published = getStorage(KEYS.published, []) || []
    const index = published.findIndex((item) => item.id === id)
    if (index > -1) {
      published[index].status = nextStatus
      published[index].closeTime = nextCloseTime
      setStorage(KEYS.published, published)
    }
    mock.saveStatus(id, { status: nextStatus, closeTime: nextCloseTime })

    const updated = mock.findActivity(id)
    updated.status = nextStatus
    updated.closeTime = nextCloseTime
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
      return withDelay(list.map((item) => expire.applyExpiry(item)))
    }
    const joinedIds = getStorage(KEYS.joined, []) || []
    const list = mock
      .allActivities()
      .filter((item) => joinedIds.indexOf(item.id) > -1)
      .sort((a, b) => a.startTime - b.startTime)
    return withDelay(list.map((item) => expire.applyExpiry(item)))
  },

  user() {
    return withDelay(mock.currentUser())
  },

  login(payload) {
    const params = payload || {}
    const existed = getStorage(KEYS.user, null)
    if (existed && existed.openid) {
      // 历史版本用手机号掩码当默认昵称，等于把手机号前后各 4 位公开给其他用户，这里就地纠正
      const legacyNick = !existed.nickName || /^\d{3}\*{4}\d{4}$/.test(existed.nickName)
      const merged = Object.assign({}, existed, {
        phone: params.phone || existed.phone || '',
      })
      if (legacyNick) {
        merged.nickName = mockDefaultNickName(merged.userId)
        merged.avatarText = merged.nickName.slice(0, 1)
      }
      setStorage(KEYS.user, merged)
      return withDelay(merged)
    }
    const counter = (getStorage(KEYS.userCounter, 0) || 0) + 1
    setStorage(KEYS.userCounter, counter)
    const phone = params.phone || ''
    const guest = !phone
    // 昵称对外可见（活动卡片、报名名单），不能放手机号（哪怕是掩码），统一「微信用户 + 编号」
    const nickName = mockDefaultNickName(counter)
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
    // 昵称会展示在活动卡片与报名名单里（对外可见的 UGC），云端同样先过内容安全再写库
    if (mockTextRisky(userInfo.nickName)) return fail('CONTENT_RISKY', '昵称包含违规内容，请修改后重试')
    // 手机号只能由手机号授权登录写入，资料编辑不接受该字段（与云端 updateUser 一致）
    const safeInfo = Object.assign({}, userInfo)
    delete safeInfo.phone
    const merged = Object.assign({}, existed, safeInfo)
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
    // 反馈不公开展示，但仍是用户提交的文本；与云端 feedback 一致先过内容安全
    if (mockTextRisky(content)) return fail('CONTENT_RISKY', '反馈内容包含违规内容，请修改后重试')
    const user = mock.currentUser()
    const record = {
      id: `mock_fb_${Date.now()}`,
      kind: 'feedback',
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

  /**
   * 举报活动：Mock 与云端一样把记录写进反馈列表（`kind: 'report'`），
   * 本地也能看到入口产出的内容；注销账号时会随反馈一起清掉。
   */
  report(activityId, reason) {
    const user = mock.currentUser()
    if (!user) return fail('UNAUTHORIZED', '请先登录')
    const id = String(activityId || '')
    if (!id) return fail('NOT_FOUND', '活动不存在或已下架')
    if (REPORT_REASONS.indexOf(String(reason || '')) === -1) return fail('INVALID_PARAM', '请选择举报原因')
    const activity = mock.findActivity(id)
    if (!activity) return fail('NOT_FOUND', '活动不存在或已下架')
    const record = {
      id: `mock_report_${Date.now()}`,
      kind: 'report',
      activityId: id,
      title: activity.title || '',
      organizerOpenid: (activity.organizer && activity.organizer.openid) || '',
      reason: String(reason),
      openid: user.openid,
      nickName: user.nickName || '',
      status: 'pending',
      createTime: Date.now(),
    }
    const list = getStorage(KEYS.feedback, []) || []
    list.unshift(record)
    setStorage(KEYS.feedback, list)
    return withDelay({ id: record.id, status: record.status, createTime: record.createTime })
  },

  /** Mock 的封面 / 二维码是本机临时路径，没有云存储文件需要换临时链接 */
  media() {
    return withDelay({})
  },

  /**
   * 注销账号（Mock）：本地数据就是全部数据，一次性清空。
   * 与云端同一套口径：账号、我发布的、我报名的、我提交的反馈全部删除，
   * 别人活动报名名单里的自己也要摘掉，否则会留下一个点不进去的成员。
   */
  deleteAccount() {
    const user = getStorage(KEYS.user, null)
    if (!user || !user.openid) return fail('UNAUTHORIZED', '请先登录')

    const published = getStorage(KEYS.published, []) || []
    const publishedIds = published.map((item) => item.id)

    removeStorage(KEYS.user)
    removeStorage(KEYS.published)
    removeStorage(KEYS.joined)
    removeStorage(KEYS.feedback)
    removeStorage(KEYS.lastPhone)

    // 我发布活动的本地状态 / 审核覆盖一起清掉，避免残留数据覆盖到同 id 的活动
    const statusMap = getStorage(mock.MOCK_STATUS_MAP, {}) || {}
    const auditMap = getStorage(mock.MOCK_AUDIT_MAP, {}) || {}
    publishedIds.forEach((id) => {
      delete statusMap[id]
      delete auditMap[id]
    })
    setStorage(mock.MOCK_STATUS_MAP, statusMap)
    setStorage(mock.MOCK_AUDIT_MAP, auditMap)

    const joinMap = getStorage(mock.MOCK_JOIN_MAP, {}) || {}
    let joins = 0
    Object.keys(joinMap).forEach((id) => {
      const before = joinMap[id] || []
      const after = before.filter((member) => member.openid !== user.openid)
      if (after.length === before.length) return
      joinMap[id] = after
      joins += 1
    })
    setStorage(mock.MOCK_JOIN_MAP, joinMap)

    return withDelay({ ok: true, activities: published.length, joins })
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
  /** 举报活动：云端与意见反馈同集合（kind: 'report'），供运营复核 */
  report(id, reason) {
    return callCloud('report', { id, reason })
  },
  /** 注销账号：云端会删除账号、其发布的活动（含云存储文件）、报名记录与反馈 */
  deleteAccount() {
    return callCloud('deleteAccount', {})
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

/**
 * 费用展示文案。平台不参与任何资金流转，这里只把发起人选择的费用方式与说明原样展示：
 * - 'aa'    → 「AA制」
 * - 'nonAA' → 发起人填写的费用说明，缺失时给一句兜底文案
 * 兼容历史数据：旧版本用 feeMode 'fixed' + 数字 fee（如 30）表示「非 AA 制」。
 */
function feeTextOf(activity) {
  const item = activity || {}
  const isNonAA = item.feeMode === 'nonAA' || item.feeMode === 'fixed'
  if (!isNonAA) return 'AA制'
  const note = String(item.feeNote || '').trim()
  if (note) return note
  const legacy = Number(item.fee) || 0
  return legacy > 0 ? `人均约 ${legacy} 元，自行协商` : '费用由发起人说明'
}

/** 活动卡片展示所需的派生字段 */
function decorate(activity) {
  if (!activity) return null
  const item = deepClone(activity)
  item.dateText = item.startTime ? formatCardDate(item.startTime) : ''
  item.feeText = feeTextOf(item)
  item.peopleText = `${item.joinedCount}/${item.maxPeople}人`
  item.tagNames = (item.tags || []).map(tagName).filter(Boolean)
  item.periodText = item.endTime ? formatCardDate(item.endTime) : '待定'
  item.weekdayName = WEEKDAY_TEXT[item.startWeekday] || ''
  item.difficultyText = item.difficulty ? `${item.difficulty}★` : ''
  // 云端下发的成员快照已抹掉 openid，列表渲染改用下标生成的 key（wx:key 不能为空）
  item.avatarList = (item.joinedPeople || [])
    .slice(0, 5)
    .map((member, index) => Object.assign({}, member, { key: `avatar_${index}` }))
  // 展示期届满（发布满 7 天）的活动按已关闭展示；expired 让文案能区分「已到期」与发起人主动关闭
  item.expired = !!item.expired || expire.isExpired(item)
  item.isClosed = item.status === 'closed' || item.expired
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
