const api = require('../../../services/api')
const { formatCardDate } = require('../../../utils/util')
const loginBehavior = require('../../../behaviors/login-behavior')
const ui = require('../../../utils/ui')

Page({
  behaviors: [loginBehavior],

  data: {
    id: '',
    activity: null,
    loading: true,
    notFound: false,
    agreed: false,
    user: null,
    showSharePanel: false,
    showQrModal: false,
    qrPlaceholder: false,
    statusText: '招募中',
    mainBtn: { text: '我要报名', disabled: false, mode: 'join' },
  },

  onLoad(options) {
    const id = (options && options.id) || ''
    const app = getApp()
    this.setData({ id, user: app.globalData.user })
    this.loadDetail()
  },

  onShow() {
    const app = getApp()
    this.setData({ user: app.globalData.user })
  },

  loadDetail() {
    this.setData({ loading: true })
    return api
      .detail(this.data.id)
      .then((activity) => {
        if (!activity) {
          this.setData({ notFound: true, loading: false, activity: null })
          return null
        }
        this.applyActivity(activity)
        return null
      })
      .catch(() => {
        this.setData({ loading: false, notFound: true })
      })
  },

  applyActivity(raw) {
    const activity = api.decorate(raw)
    activity.startLabel = formatCardDate(activity.startTime)
    activity.endLabel = activity.endTime ? formatCardDate(activity.endTime) : '待定'
    activity.coverGradient = activity.bg
    activity.joinedPeople = raw.joinedPeople || []
    activity.avatarList = raw.joinedPeople || []
    activity.isClosed = raw.status === 'closed'
    activity.isFull = raw.joinedCount >= raw.maxPeople
    activity.descText = raw.desc || '暂无活动介绍，报名前可与发起人沟通确认细节。'

    let statusText = '招募中'
    if (activity.isClosed) {
      statusText = '已关闭'
    } else if (activity.isFull) {
      statusText = '已满'
    }

    // 登录后 globalData 已同步，优先取最新登录态
    const app = getApp()
    const user = (app && app.globalData.user) || this.data.user
    const joined = !!user && (raw.joinedPeople || []).some((item) => item.openid === user.openid)
    let mainBtn = { text: '我要报名', disabled: false, mode: 'join' }
    if (activity.isClosed) {
      mainBtn = { text: '已关闭', disabled: true, mode: 'closed' }
    } else if (activity.isFull && !joined) {
      mainBtn = { text: '已满员', disabled: true, mode: 'full' }
    } else if (joined) {
      mainBtn = { text: '退出活动', disabled: false, mode: 'quit' }
    }

    this.setData({
      activity,
      statusText,
      mainBtn,
      loading: false,
      notFound: false,
    })
  },

  toggleAgree() {
    this.setData({ agreed: !this.data.agreed })
  },

  openJoinAgreement() {
    const modal = this.selectComponent('#agreement-modal')
    if (modal) modal.open('join')
  },

  onAgreementAgree() {
    this.setData({ agreed: true })
  },

  onMainTap() {
    const mode = this.data.mainBtn.mode
    if (mode === 'closed' || mode === 'full') return
    if (mode === 'quit') {
      this.quitActivity()
      return
    }
    this.joinActivity()
  },

  joinActivity() {
    const activity = this.data.activity
    this.ensureLogin('报名活动需要先登录，是否立即登录？').then((user) => {
      if (!user) return
      this.handleLoginSuccess(user)
      if (!this.data.agreed) {
        ui.confirm({
          title: '提示',
          content: '请先阅读并勾选《活动风险告知与免责协议》',
          confirmText: '去阅读',
          cancelText: '稍后',
        }).then((ok) => {
          if (ok) this.openJoinAgreement()
        })
        return
      }
      ui.confirm({ title: '确认报名', content: '确认报名参加本次活动？' }).then((ok) => {
        if (!ok) return
        wx.showLoading({ title: '报名中', mask: true })
        api
          .join(this.data.id)
          .then((updated) => {
            wx.hideLoading()
            this.applyActivity(updated)
            if (updated.groupQrCode) {
              this.setData({
                showQrModal: true,
                qrPlaceholder: String(updated.groupQrCode).indexOf('mock://') === 0,
              })
            } else {
              ui.toast('报名成功', 'success')
            }
          })
          .catch((err) => {
            wx.hideLoading()
            ui.toast((err && err.message) || '报名失败，请重试')
            if (err && err.code === 'ACTIVITY_CLOSED') {
              this.loadDetail()
            }
          })
      })
    })
  },

  quitActivity() {
    ui.confirm({ title: '退出活动', content: '确定要退出本次活动吗？' }).then((ok) => {
      if (!ok) return
      wx.showLoading({ title: '处理中', mask: true })
      api
        .quit(this.data.id)
        .then((updated) => {
          wx.hideLoading()
          this.setData({ agreed: false })
          this.applyActivity(updated)
          ui.toast('已退出', 'success')
        })
        .catch((err) => {
          wx.hideLoading()
          ui.toast((err && err.message) || '退出失败，请重试')
        })
    })
  },

  closeQrModal() {
    this.setData({ showQrModal: false })
    ui.toast('报名成功', 'success')
  },

  /* ------------------------------ 分享 ------------------------------ */

  openSharePanel() {
    this.setData({ showSharePanel: true })
  },

  closeSharePanel() {
    this.setData({ showSharePanel: false })
  },

  onShareTimeline() {
    this.setData({ showSharePanel: false })
    ui.tips('朋友圈分享：点击右上角「···」→「分享到朋友圈」')
  },

  onSharePoster() {
    this.setData({ showSharePanel: false })
    const modal = this.selectComponent('#poster-modal')
    if (modal) modal.open(this.data.activity)
  },

  onShareAppMessage() {
    const activity = this.data.activity
    if (!activity) {
      return { title: '旷行吖 · 和志同道合的人一起出发', path: '/pages/home/home' }
    }
    return {
      title: `${activity.title}，一起来组队吧！`,
      path: `/pages/activity/detail/index?id=${activity.id}`,
      imageUrl: activity.cover || '',
    }
  },

  onShareTimeline() {
    const activity = this.data.activity
    if (!activity) return { title: '旷行吖 · 和志同道合的人一起出发' }
    return {
      title: `${activity.title}，一起来组队吧！`,
      query: `id=${activity.id}`,
    }
  },

  goBack() {
    const pages = getCurrentPages()
    if (pages.length > 1) {
      wx.navigateBack({ delta: 1 })
    } else {
      wx.switchTab({ url: '/pages/square/index' })
    }
  },

  onLogin(e) {
    this.handleLoginSuccess(e.detail)
    this.loadDetail()
  },
})
