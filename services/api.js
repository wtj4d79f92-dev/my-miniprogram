// 统一服务层：Mock 与云开发模式接口签名完全一致，通过 config.useMock 切换
const config = require('./config')
const { KEYS, getStorage, setStorage } = require('../utils/storage')
const { getType, supportsTags, supportsMetrics, tagName } = require('../utils/dict')
const { matchCity, normalizeCity } = require('../utils/cities')
const { delay, deepClone, formatCardDate, WEEKDAY_TEXT } = require('../utils/util')
const mock = require('./mock')

const AVATAR_COLORS = ['#4ECDC4', '#45B7D1', '#FF8E72', '#F6D365', '#00CDAC', '#FA709A', '#44A08D', '#A8DADC', '#FF7D00']

function fail(code, message) {
  return Promise.reject(mock.error(code, message))
}

function withDelay(data) {
  return delay(config.mockDelay).then(() => data)
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

/* ------------------------------ Mock 实现 ------------------------------ */

const mockApi = {
  home(payload) {
    const city = (payload && payload.city) || ''
    const list = mock.cityFilter(mock.allActivities(), city)
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

    let list = mock.allActivities()
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
          String(item.location).toLowerCase().indexOf(keyword) > -1
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
    const result = deepClone(activity)
    const user = mock.currentUser()
    result.joined = !!user && result.joinedPeople.some((item) => item.openid === user.openid)
    result.isOrganizer = !!user && result.organizer.openid === user.openid
    result.full = result.joinedCount >= result.maxPeople
    return withDelay(result)
  },

  create(payload) {
    const form = (payload && payload.form) || {}
    const user = mock.currentUser()
    if (!user) return fail('UNAUTHORIZED', '请先登录')
    const type = getType(form.type)
    const city = matchCity(form.location)
    const id = `mock_act_${Date.now()}`
    const activity = {
      id,
      _id: id,
      type: type.key,
      typeName: type.name,
      emoji: type.emoji,
      color: type.color,
      bg: `linear-gradient(135deg, ${type.from} 0%, ${type.to} 100%)`,
      title: String(form.title || '').slice(0, 30),
      cover: form.cover || '',
      groupQrCode: form.groupQrCode || '',
      desc: String(form.desc || '').slice(0, 500),
      location: String(form.location || '').slice(0, 50),
      city,
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
      joinedPeople: [],
      joinedCount: 0,
      organizer: mock.memberOf(user),
      createTime: Date.now(),
      status: 'recruiting',
      miniQrCode: '',
    }
    const published = getStorage(KEYS.published, []) || []
    published.unshift(activity)
    setStorage(KEYS.published, published)
    return withDelay(activity)
  },

  join(id) {
    const user = mock.currentUser()
    if (!user) return fail('UNAUTHORIZED', '请先登录')
    const activity = mock.findActivity(id)
    if (!activity) return fail('NOT_FOUND', '活动不存在或已下架')
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
  return item
}

module.exports = Object.assign({}, api, { decorate, normalizeCity })
