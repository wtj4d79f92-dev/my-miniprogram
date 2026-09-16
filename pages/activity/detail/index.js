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
    isOrganizer: false,
    mainBtn: { text: '我要报名', disabled: false, mode: 'join', style: '' },
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
    const myOpenid = (user && user.openid) || ''
    const organizer = raw.organizer || {}
    // 自己发布的活动：用「关闭 / 打开活动」替代报名按钮，且不展示报名协议
    const isOrganizer = !!myOpenid && organizer.openid === myOpenid
    const joined = !!myOpenid && (raw.joinedPeople || []).some((item) => item.openid === myOpenid)
    // style 为空使用主色按钮，outline / manage 为次要按钮样式
    let mainBtn = { text: '我要报名', disabled: false, mode: 'join', style: '' }
    if (isOrganizer) {
      mainBtn = activity.isClosed
        ? { text: '重新打开活动', disabled: false, mode: 'toggle', style: '' }
        : { text: '关闭活动', disabled: false, mode: 'toggle', style: 'manage' }
    } else if (activity.isClosed) {
      mainBtn = { text: '已关闭', disabled: true, mode: 'closed', style: '' }
    } else if (activity.isFull && !joined) {
      mainBtn = { text: '已满员', disabled: true, mode: 'full', style: '' }
    } else if (joined) {
      mainBtn = { text: '退出活动', disabled: false, mode: 'quit', style: 'outline' }
    }

    this.setData({
      activity,
      statusText,
      isOrganizer,
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
    // 由报名提醒进入协议并点击「同意并继续」时，视为已完成勾选，直接继续报名
    if (!this.pendingJoin) return
    this.pendingJoin = false
    this.submitJoin()
  },

  onAgreementClose() {
    // 协议弹窗未同意关闭后，不再自动延续报名
    this.pendingJoin = false
  },

  onMainTap() {
    const mode = this.data.mainBtn.mode
    if (mode === 'closed' || mode === 'full') return
    if (mode === 'toggle') {
      this.toggleActivity()
      return
    }
    if (mode === 'quit') {
      this.quitActivity()
      return
    }
    this.joinActivity()
  },

  /** 发起人关闭 / 重新打开自己发布的活动 */
  toggleActivity() {
    const activity = this.data.activity
    if (!activity) return
    const isClosed = activity.isClosed
    ui.confirm({
      title: isClosed ? '重新打开活动' : '关闭活动',
      content: isClosed
        ? '确定重新打开该活动，恢复报名吗？'
        : '关闭后，活动仍会在广场展示，但其他用户将无法报名。确定关闭吗？',
      confirmText: isClosed ? '重新打开' : '关闭活动',
    }).then((ok) => {
      if (!ok) return
      wx.showLoading({ title: '处理中', mask: true })
      api
        .toggle(this.data.id)
        .then((updated) => {
          wx.hideLoading()
          this.applyActivity(updated)
          ui.toast(updated.status === 'closed' ? '已关闭' : '已打开', 'success')
        })
        .catch((err) => {
          wx.hideLoading()
          ui.toast((err && err.message) || '操作失败，请重试')
          if (err && (err.code === 'FORBIDDEN' || err.code === 'NOT_FOUND')) this.loadDetail()
        })
    })
  },

  joinActivity() {
    this.ensureLogin('报名活动需要先登录，是否立即登录？').then((user) => {
      if (!user) return
      this.handleLoginSuccess(user)
      if (!this.data.agreed) {
        this.remindAgreement()
        return
      }
      // 已勾选免责协议即视为完成报名确认，直接提交，不再二次弹窗
      this.submitJoin()
    })
  },

  /** 未勾选免责协议：弹窗提醒，可直接跳转协议正文 */
  remindAgreement() {
    ui.confirm({
      title: '请先阅读并同意免责协议',
      content: '报名前需勾选《活动风险告知与免责协议》。阅读并同意后将直接完成报名，无需再次确认。',
      confirmText: '去阅读',
      cancelText: '稍后再说',
    }).then((ok) => {
      if (!ok) return
      // 标记本次协议确认来自报名入口，同意后直接继续报名
      this.pendingJoin = true
      this.openJoinAgreement()
    })
  },

  /** 提交报名：成功后有活动群二维码则直接展示 */
  submitJoin() {
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

  /** 分享面板 →「朋友圈」：小程序内无法直接调起朋友圈，仅作引导 */
  onTapShareTimeline() {
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

  /** 页面右上角菜单「分享到朋友圈」的转发内容 */
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
