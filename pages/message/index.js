const api = require('../../services/api')
const loginBehavior = require('../../behaviors/login-behavior')
const ui = require('../../utils/ui')

/**
 * 站内通知的两个来源（与云端 NOTIFY_COMMENT / NOTIFY_REPLY 对应）：
 * - comment：有人在我发起的活动里留言 → 通知发起人；
 * - reply：有人回复了我的留言 → 通知被回复的人。
 */
const ACTION_TEXT = {
  comment: '在你发起的活动里留言了',
  reply: '回复了你的留言',
}

/** 通知时间：当天只显示时分，更早显示「月-日 时:分」（与详情页留言同一口径） */
function formatTime(ts) {
  if (!ts) return ''
  const d = new Date(ts)
  const pad = (n) => (n < 10 ? `0${n}` : `${n}`)
  const time = `${pad(d.getHours())}:${pad(d.getMinutes())}`
  const now = new Date()
  const sameDay =
    d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate()
  return sameDay ? time : `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${time}`
}

function decorate(list) {
  return (list || []).map((item) =>
    Object.assign({}, item, {
      actionText: ACTION_TEXT[item.type] || ACTION_TEXT.comment,
      timeLabel: formatTime(item.createTime),
    })
  )
}

Page({
  behaviors: [loginBehavior],

  data: {
    list: [],
    loading: true,
    refreshing: false,
    unreadCount: 0,
    // 未登录时列表拉不到（服务端返回 UNAUTHORIZED），页面改成登录引导
    needLogin: false,
  },

  onLoad() {
    // 标题不显示（自定义导航栏），但微信搜一搜据此理解页面内容
    ui.setPageTitle('消息 · 旷行吖')
    this.load()
  },

  onShow() {
    // 从活动详情返回后重新拉一次：点开消息时已把对应那条标为已读
    if (this._hasShown) this.load()
    this._hasShown = true
  },

  load() {
    this.setData({ loading: !this.data.list.length })
    return api
      .notifications()
      .then((res) => {
        const unreadCount = (res && res.unreadCount) || 0
        this.setData({
          list: decorate(res && res.list),
          unreadCount,
          loading: false,
          refreshing: false,
          needLogin: false,
        })
        // 页面自己拉到的未读数就是权威值，顺手同步给 app，tab 小红点不会滞后
        getApp().setUnreadCount(unreadCount)
        return null
      })
      .catch((err) => {
        this.setData({ loading: false, refreshing: false })
        // 未登录是正常路径（从「我的」进来时理论上已登录），不弹报错，直接给登录入口
        if ((err && err.code) === 'UNAUTHORIZED') {
          this.setData({ list: [], unreadCount: 0, needLogin: true })
          getApp().setUnreadCount(0)
          return null
        }
        ui.toast((err && err.message) || '消息加载失败，请稍后重试')
        return null
      })
  },

  onRefresh() {
    this.setData({ refreshing: true })
    this.load()
  },

  onLoginTap() {
    this.openLoginModal('查看消息需要先登录，是否立即登录？').then((user) => {
      if (!user) return
      this.handleLoginSuccess(user)
      this.load()
    })
  },

  findItem(id) {
    return (this.data.list || []).filter((item) => item.id === id)[0] || null
  },

  /** 点一条消息：先本地标已读（接口失败不回滚，下次进来会重新校正），再跳到对应活动 */
  onItemTap(e) {
    const id = e.currentTarget.dataset.id
    const item = this.findItem(id)
    if (!item) return
    if (!item.read) {
      this.setData({
        list: this.data.list.map((row) => (row.id === id ? Object.assign({}, row, { read: true }) : row)),
        unreadCount: Math.max(0, this.data.unreadCount - 1),
      })
      // 同步给 app：返回 tab 页时底部小红点已经是新值，不用等接口回来才灭
      getApp().setUnreadCount(this.data.unreadCount)
      api.notificationRead(id).catch(() => {})
    }
    if (item.activityId) {
      wx.navigateTo({ url: `/pages/activity/detail/index?id=${item.activityId}` })
    }
  },

  onReadAll() {
    if (!this.data.unreadCount) return
    return api
      .notificationReadAll()
      .then(() => {
        this.setData({
          list: this.data.list.map((row) => Object.assign({}, row, { read: true })),
          unreadCount: 0,
        })
        getApp().setUnreadCount(0)
        ui.toast('已全部标为已读', 'success')
        return null
      })
      .catch((err) => ui.toast((err && err.message) || '操作失败，请稍后重试'))
  },

  goSquare() {
    wx.switchTab({ url: '/pages/square/index' })
  },
})
