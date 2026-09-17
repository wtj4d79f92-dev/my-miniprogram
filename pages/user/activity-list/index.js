const api = require('../../../services/api')
const { KEYS, getStorage } = require('../../../utils/storage')
const loginBehavior = require('../../../behaviors/login-behavior')
const ui = require('../../../utils/ui')

Page({
  behaviors: [loginBehavior],

  data: {
    tab: 'joined',
    list: [],
    loading: true,
    refreshing: false,
    user: null,
  },

  onLoad(options) {
    const tab = (options && options.tab) === 'published' ? 'published' : 'joined'
    const app = getApp()
    this.setData({ tab, user: app.globalData.user || getStorage(KEYS.user, null) })
    this.loadList()
  },

  onShow() {
    // 从详情页返回（例如退出活动）后重新拉取
    if (this._hasShown) {
      this.loadList()
    }
    this._hasShown = true
  },

  switchTab(e) {
    const tab = e.currentTarget.dataset.tab
    if (tab === this.data.tab) return
    this.setData({ tab, list: [], loading: true })
    this.loadList()
  },

  loadList() {
    const app = getApp()
    const user = app.globalData.user
    if (!user) {
      this.setData({ list: [], loading: false, refreshing: false })
      return Promise.resolve()
    }
    return api
      .mine(this.data.tab)
      .then((list) => {
        this.setData({
          list: (list || []).map(api.decorate),
          loading: false,
          refreshing: false,
        })
        return null
      })
      .catch(() => {
        this.setData({ list: [], loading: false, refreshing: false })
      })
  },

  onRefresh() {
    this.setData({ refreshing: true })
    this.loadList()
  },

  onCardTap(e) {
    wx.navigateTo({ url: `/pages/activity/detail/index?id=${e.detail.id}` })
  },

  /** 审核未通过：带着活动 id 进入发布页，表单预填后重新提交审核 */
  onEdit(e) {
    const id = (e.detail && e.detail.id) || e.currentTarget.dataset.id
    if (!id) return
    wx.navigateTo({ url: `/pages/activity/publish/index?id=${id}` })
  },

  onToggle(e) {
    const id = e.detail.id
    const status = e.detail.status
    const isClosed = status === 'closed'
    ui.confirm({
      title: isClosed ? '重新打开活动' : '关闭活动',
      content: isClosed
        ? '确定重新打开该活动，恢复报名吗？'
        : '关闭后，活动仅在广场展示当天，次日起不再展示，其他用户将无法报名。确定关闭吗？',
      confirmText: isClosed ? '重新打开' : '关闭活动',
    }).then((ok) => {
      if (!ok) return
      wx.showLoading({ title: '处理中', mask: true })
      api
        .toggle(id)
        .then((updated) => {
          wx.hideLoading()
          const decorated = api.decorate(updated)
          const list = this.data.list.map((item) => (item.id === id ? decorated : item))
          this.setData({ list })
          ui.toast(updated.status === 'closed' ? '已关闭' : '已打开', 'success')
        })
        .catch((err) => {
          wx.hideLoading()
          ui.toast((err && err.message) || '操作失败，请重试')
        })
    })
  },

  goSquare() {
    wx.switchTab({ url: '/pages/square/index' })
  },

  goPublish() {
    this.ensureLogin('发布活动需要先登录，是否立即登录？').then((user) => {
      if (!user) return
      this.handleLoginSuccess(user)
      wx.navigateTo({ url: '/pages/activity/publish/index' })
    })
  },

  onLogin(e) {
    this.handleLoginSuccess(e.detail)
    this.loadList()
  },
})
