const api = require('../../services/api')
const { TEXTS } = require('../../utils/dict')
const config = require('../../services/config')
const loginBehavior = require('../../behaviors/login-behavior')
const ui = require('../../utils/ui')

Page({
  behaviors: [loginBehavior],

  data: {
    texts: TEXTS,
    aboutText: TEXTS.about,
    useMock: config.useMock,
    user: null,
    joinedCount: 0,
    publishedCount: 0,
    needProfile: false,
    // 用户量少，暂时不在「我的」展示用户 ID，需要时改回 true 即可
    showUserId: false,
    // 是否是审核人：决定「活动审核」入口是否展示
    isAdmin: false,
    // 资料编辑弹窗
    showProfile: false,
    editAvatar: '',
    editNickName: '',
    saving: false,
    // 手机号绑定弹窗
    showPhone: false,
    phoneInput: '',
    phoneAgreed: false,
    binding: false,
    // 注销进行中：防重复提交，也用来禁用入口
    deleting: false,
  },

  onShow() {
    if (this.getTabBar && this.getTabBar()) {
      this.getTabBar().setData({ selected: 2 })
    }
    this.syncUser()
    this.loadStats()
    this.checkAdmin()
  },

  /**
   * 审核入口显隐：一次会话只问一次，避免每次切回「我的」都打一次云函数。
   * 权限本身以 admin 云函数按 openid 的判断为准，这里只影响入口是否出现。
   */
  checkAdmin() {
    if (this._adminChecked) return
    api
      .adminWhoami()
      .then((res) => {
        this._adminChecked = true
        this.setData({ isAdmin: !!(res && res.isAdmin) })
        return null
      })
      .catch(() => {
        this.setData({ isAdmin: false })
      })
  },

  goAdminAudit() {
    wx.navigateTo({ url: '/pages/admin/audit/index' })
  },

  syncUser() {
    const app = getApp()
    const user = app.globalData.user
    this.setData({
      user,
      needProfile: this.needProfileOf(user),
    })
  },

  /** 头像或昵称未完善时需要引导（已登录、但缺少头像或仍是默认昵称） */
  needProfileOf(user) {
    if (!user) return false
    return !user.avatarUrl || !user.nickName || user.nickName === '微信用户'
  },

  loadStats() {
    const user = this.data.user
    if (!user) {
      this.setData({ joinedCount: 0, publishedCount: 0 })
      return
    }
    Promise.all([api.mine('joined'), api.mine('published')])
      .then((res) => {
        this.setData({
          joinedCount: (res[0] || []).length,
          publishedCount: (res[1] || []).length,
        })
      })
      .catch(() => {
        this.setData({ joinedCount: 0, publishedCount: 0 })
      })
  },

  onLoginTap() {
    this.openLoginModal().then((user) => {
      if (user) this.handleLoginSuccess(user)
    })
  },

  onUserCardTap() {
    if (!this.data.user) {
      this.onLoginTap()
      return
    }
    this.openProfile()
  },

  onUserChanged(user) {
    // 资料保存 / 登录后 user 已更新，需同步重算引导提示，否则会一直显示
    this.setData({ needProfile: this.needProfileOf(user || this.data.user) })
    this.loadStats()
  },

  /* ---------------------------- 资料编辑 ---------------------------- */

  openProfile() {
    const user = this.data.user
    if (!user) return
    this.setData({
      showProfile: true,
      editAvatar: user.avatarUrl || '',
      editNickName: user.nickName || '',
    })
  },

  closeProfile() {
    this.setData({ showProfile: false })
  },

  onChooseAvatar(e) {
    const url = e.detail && e.detail.avatarUrl
    if (url) this.setData({ editAvatar: url })
  },

  onNickInput(e) {
    this.setData({ editNickName: String(e.detail.value || '').slice(0, 20) })
  },

  saveProfile() {
    if (this.data.saving) return
    const nickName = String(this.data.editNickName || '').trim()
    if (!nickName) {
      ui.toast('请填写昵称')
      return
    }
    this.setData({ saving: true })
    api
      .updateUser({
        userInfo: {
          nickName,
          avatarUrl: this.data.editAvatar,
          avatarText: nickName.slice(0, 1),
        },
      })
      .then((user) => {
        this.setData({ saving: false, showProfile: false })
        this.handleLoginSuccess(user)
        ui.toast('保存成功', 'success')
      })
      .catch(() => {
        this.setData({ saving: false })
        ui.toast('保存失败，请重试')
      })
  },

  /* --------------------------- 手机号绑定 --------------------------- */

  openPhone() {
    if (!this.data.user) {
      this.onLoginTap()
      return
    }
    this.setData({ showPhone: true, phoneInput: '', phoneAgreed: false })
  },

  closePhone() {
    this.setData({ showPhone: false })
  },

  togglePhoneAgree() {
    this.setData({ phoneAgreed: !this.data.phoneAgreed })
  },

  openService() {
    const modal = this.selectComponent('#agreement-modal')
    if (modal) modal.open('service')
  },

  openPrivacy() {
    const modal = this.selectComponent('#agreement-modal')
    if (modal) modal.open('privacy')
  },

  onPhoneInput(e) {
    this.setData({ phoneInput: e.detail.value })
  },

  /** 协议未勾选时的联动提示 */
  guardAgreement() {
    if (this.data.phoneAgreed) return true
    ui.confirm({
      title: '提示',
      content: '请先阅读并同意《用户服务协议》和《隐私政策》',
      confirmText: '去同意',
      cancelText: '稍后',
    }).then((ok) => {
      if (ok) this.setData({ phoneAgreed: true })
    })
    return false
  },

  submitPhoneMock() {
    if (!this.guardAgreement()) return
    const phone = String(this.data.phoneInput || '').trim()
    if (!/^1\d{10}$/.test(phone)) {
      ui.toast('请输入正确的11位手机号')
      return
    }
    this.setData({ binding: true })
    api
      .login({ phone })
      .then((user) => {
        this.setData({ binding: false, showPhone: false })
        this.handleLoginSuccess(user)
        ui.toast('绑定成功', 'success')
      })
      .catch(() => {
        this.setData({ binding: false })
        ui.toast('绑定失败，请重试')
      })
  },

  onGetPhoneNumber(e) {
    if (!this.guardAgreement()) return
    if (!e.detail || !e.detail.code) {
      ui.toast('手机号授权不可用，不影响登录使用')
      return
    }
    this.setData({ binding: true })
    api
      .login({ phoneCode: e.detail.code })
      .then((user) => {
        this.setData({ binding: false, showPhone: false })
        this.handleLoginSuccess(user)
        ui.toast('绑定成功', 'success')
      })
      .catch(() => {
        this.setData({ binding: false })
        ui.toast('绑定失败，请重试')
      })
  },

  /* ------------------------------ 入口 ------------------------------ */

  goActivityList(e) {
    const tab = e.currentTarget.dataset.tab || 'joined'
    if (!this.data.user) {
      this.ensureLogin('查看我的活动需要先登录，是否立即登录？').then((user) => {
        if (!user) return
        this.handleLoginSuccess(user)
        wx.navigateTo({ url: `/pages/user/activity-list/index?tab=${tab}` })
      })
      return
    }
    wx.navigateTo({ url: `/pages/user/activity-list/index?tab=${tab}` })
  },

  goPublish() {
    this.ensureLogin('发布活动需要先登录，是否立即登录？').then((user) => {
      if (!user) return
      this.handleLoginSuccess(user)
      wx.navigateTo({ url: '/pages/activity/publish/index' })
    })
  },

  goSquare() {
    wx.switchTab({ url: '/pages/square/index' })
  },

  goFeedback() {
    wx.navigateTo({ url: '/pages/feedback/index' })
  },

  /* ------------------------------ 注销账号 ------------------------------ */

  /**
   * 注销账号：两次确认后才真正提交。
   * 删除不可撤销（账号、报名记录、我发布的活动都会消失），所以第一次说明后果，第二次才动手；
   * 中途取消不留任何痕迹，也不调用接口。
   */
  deleteAccount() {
    if (this.data.deleting) return
    if (!this.data.user) {
      this.onLoginTap()
      return
    }
    ui.confirm({
      title: '注销账号',
      content:
        '注销后，你的账号信息、报名记录以及你发布的活动都会被永久删除，且无法恢复。同一微信再次登录会重新注册为新账号。',
      confirmText: '继续注销',
      cancelText: '再想想',
      confirmColor: '#E5484D',
    })
      .then((ok) => {
        if (!ok) return false
        return ui.confirm({
          title: '确认注销',
          content: '最后确认：账号与全部相关数据都会被删除，无法恢复。确定要注销吗？',
          confirmText: '确认注销',
          cancelText: '取消',
          confirmColor: '#E5484D',
        })
      })
      .then((ok) => {
        if (!ok) return null
        this.setData({ deleting: true })
        ui.loading('正在注销')
        return api.deleteAccount().then(
          () => {
            ui.hideLoading()
            this.setData({ deleting: false })
            this.afterDeleteAccount()
            return null
          },
          (err) => {
            ui.hideLoading()
            this.setData({ deleting: false })
            ui.toast((err && err.message) || '注销失败，请重试')
            return null
          }
        )
      })
  },

  /** 注销成功：本地登录态与页面数据一起复位，回到未登录的「我的」 */
  afterDeleteAccount() {
    const app = getApp()
    if (app && app.applyUser) {
      app.applyUser(null)
    } else if (app && app.setUser) {
      app.setUser(null)
    }
    // 审核入口按 openid 判断，换账号后要重新问一次
    this._adminChecked = false
    this.setData({
      user: null,
      needProfile: false,
      joinedCount: 0,
      publishedCount: 0,
      isAdmin: false,
      showProfile: false,
      showPhone: false,
    })
    ui.toast('账号已注销', 'success')
  },

  showAbout() {
    ui.tips(this.data.aboutText)
  },

  onLogin(e) {
    this.handleLoginSuccess(e.detail)
    this.loadStats()
  },
})
