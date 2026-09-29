// 登录页：全屏登录界面，顶部返回 + 品牌区 + 协议勾选 + 主次登录按钮 + 底部「暂不登录」
// - 协议勾选后才允许登录，未勾选点击登录会提示并抖动协议行
// - 登录过的手机号展示为「登录此账号 + 脱敏手机号」，可一键复用
// - 「手机号快捷登录」「切换手机号」进入手机号输入；「暂不登录」取消并返回原操作
// - 新用户登录成功后进「完善头像昵称」步骤：微信不允许静默获取昵称头像，这里用官方
//   chooseAvatar / nickname 能力让用户点两下带上微信资料，也可「暂不完善」直接进小程序
const api = require('../../services/api')
const config = require('../../services/config')
const { AGREEMENTS } = require('../../utils/agreements')
const { KEYS, getStorage, setStorage } = require('../../utils/storage')
const { parseBold } = require('../../utils/util')
const { needProfileSetup, uploadAvatar, isFreshUser, usableAvatar } = require('../../utils/profile')

const DEFAULT_APP_NAME = '旷行吖'
const PHONE_REG = /^1\d{10}$/

function maskPhone(phone) {
  const value = String(phone || '')
  if (!PHONE_REG.test(value)) return ''
  return `${value.slice(0, 3)}****${value.slice(-4)}`
}

/** 页面传入的 reason 形如「报名活动需要先登录，是否立即登录？」，这里去掉追问语气 */
function cleanReason(reason) {
  return String(reason || '')
    .replace(/，?是否立即登录？?$/, '')
    .trim()
}

Component({
  options: {
    styleIsolation: 'apply-shared',
  },

  data: {
    visible: false,
    // main：登录首页 | phone：输入手机号 | profile：完善头像昵称 | agreement：协议正文
    step: 'main',
    appName: DEFAULT_APP_NAME,
    navTitle: DEFAULT_APP_NAME,
    navStyle: '',
    navButtonStyle: '',
    reason: '',
    agreed: false,
    agreeShake: false,
    phone: '',
    phoneValid: false,
    knownPhone: '',
    maskedPhone: '',
    submitting: false,
    // 完善头像昵称（新用户登录成功后的一步）：待补资料的账号 + 编辑中的头像昵称
    profileUser: null,
    profileAvatar: '',
    profileNick: '',
    profileSaving: false,
    useMock: config.useMock,
    agreement: { title: '', updatedAt: '', blocks: [] },
  },

  lifetimes: {
    attached() {
      const app = getApp()
      const texts = (app && app.globalData && app.globalData.texts) || {}
      this.initNav(texts.appName || DEFAULT_APP_NAME)
    },
    detached() {
      this.clearShakeTimer()
      this.setTabBarHidden(false)
    },
  },

  methods: {
    /** 导航栏高度跟随状态栏与胶囊位置，右侧天然为系统胶囊留白 */
    initNav(appName) {
      let statusBarHeight = 20
      let navHeight = 44
      try {
        const info = (wx.getWindowInfo && wx.getWindowInfo()) || wx.getSystemInfoSync()
        const rect = wx.getMenuButtonBoundingClientRect()
        statusBarHeight = info.statusBarHeight || 20
        navHeight = (rect.top - statusBarHeight) * 2 + rect.height
      } catch (e) {
        // 取不到胶囊信息时退回默认高度
      }
      this.setData({
        appName,
        navTitle: appName,
        navStyle: `padding-top: ${statusBarHeight}px; height: ${navHeight}px;`,
        navButtonStyle: `height: ${navHeight}px;`,
      })
    },

    /**
     * 打开登录页
     * @param {string} reason 触发登录的原因
     * @returns {Promise<object|null>} 登录用户，取消返回 null
     */
    open(reason) {
      const lastPhone = getStorage(KEYS.lastPhone, '') || ''
      return new Promise((resolve) => {
        this._resolve = resolve
        this.clearShakeTimer()
        this.setData({
          visible: true,
          step: 'main',
          navTitle: this.data.appName,
          reason: cleanReason(reason),
          agreed: false,
          agreeShake: false,
          phone: '',
          phoneValid: false,
          submitting: false,
          profileUser: null,
          profileAvatar: '',
          profileNick: '',
          profileSaving: false,
          knownPhone: lastPhone,
          maskedPhone: maskPhone(lastPhone),
        })
        this.setTabBarHidden(true)
      })
    },

    /** 整屏登录页会盖住整个屏幕，需要同时收起自定义 tabBar */
    setTabBarHidden(hidden) {
      const pages = getCurrentPages()
      const page = pages[pages.length - 1]
      if (!page || typeof page.getTabBar !== 'function') return
      const tabBar = page.getTabBar()
      if (tabBar && tabBar.data.hidden !== hidden) {
        tabBar.setData({ hidden })
      }
    },

    /** 关闭登录页并返回结果 */
    finish(user) {
      const resolve = this._resolve
      this._resolve = null
      this.clearShakeTimer()
      this.setData({
        visible: false,
        step: 'main',
        navTitle: this.data.appName,
        submitting: false,
        phone: '',
        phoneValid: false,
        profileUser: null,
        profileAvatar: '',
        profileNick: '',
        profileSaving: false,
        agreement: { title: '', updatedAt: '', blocks: [] },
      })
      if (resolve) resolve(user || null)
      if (user) this.triggerEvent('login', user)
      this.setTabBarHidden(false)
    },

    /** 暂不登录 / 返回：取消登录并回到原操作 */
    cancel() {
      if (this.data.submitting) return
      this.finish(null)
    },

    close() {
      this.cancel()
    },

    onNavBack() {
      // 已经登录成功、停在完善资料这一步：返回等同于「暂不完善」，不能再退回登录首页
      if (this.data.step === 'profile') {
        this.skipProfile()
        return
      }
      if (this.data.step !== 'main') {
        this.backToMain()
        return
      }
      this.cancel()
    },

    backToMain() {
      this.setData({
        step: 'main',
        navTitle: this.data.appName,
        phone: '',
        phoneValid: false,
      })
    },

    toggleAgree() {
      this.setData({ agreed: !this.data.agreed, agreeShake: false })
    },

    /** 协议正文在登录页内打开，保证层级在整屏登录页之上 */
    openAgreement(e) {
      const key = (e.currentTarget.dataset || {}).key
      const agreement = AGREEMENTS[key]
      if (!agreement) return
      const blocks = agreement.paragraphs.map((text, index) => ({
        key: `${key}_${index}`,
        segments: parseBold(text).map((seg, i) => ({ text: seg.text, strong: seg.strong, i })),
      }))
      this.setData({
        step: 'agreement',
        navTitle: agreement.title,
        agreement: {
          title: agreement.title,
          updatedAt: agreement.updatedAt,
          blocks,
        },
      })
    },

    /** 协议未勾选时拦截登录，并抖动协议行做提示 */
    ensureAgreed() {
      if (this.data.agreed) return true
      wx.showToast({ title: '请先阅读并同意协议', icon: 'none' })
      this.clearShakeTimer()
      this.setData({ agreeShake: true })
      this._shakeTimer = setTimeout(() => {
        this._shakeTimer = null
        this.setData({ agreeShake: false })
      }, 600)
      return false
    },

    clearShakeTimer() {
      if (this._shakeTimer) {
        clearTimeout(this._shakeTimer)
        this._shakeTimer = null
      }
    },

    onPrimaryTap() {
      if (!this.ensureAgreed()) return
      if (!this.data.useMock) {
        this.doLogin({})
        return
      }
      if (this.data.knownPhone) {
        this.doLogin({ phone: this.data.knownPhone }, this.data.knownPhone)
        return
      }
      this.gotoPhoneStep()
    },

    onSwitchPhone() {
      if (!this.ensureAgreed()) return
      this.gotoPhoneStep()
    },

    gotoPhoneStep() {
      this.setData({ step: 'phone', navTitle: '手机号登录', phone: '', phoneValid: false })
    },

    onPhoneInput(e) {
      const phone = String(e.detail.value || '').replace(/\D/g, '')
      this.setData({ phone, phoneValid: PHONE_REG.test(phone) })
    },

    /** Mock 模式：手机号模拟登录 */
    submitPhone() {
      if (this.data.submitting) return
      const phone = String(this.data.phone || '').trim()
      if (!PHONE_REG.test(phone)) {
        wx.showToast({ title: '请输入正确的11位手机号', icon: 'none' })
        return
      }
      this.doLogin({ phone }, phone)
    },

    /** 云模式：openid 一键登录，不强制手机号 */
    onWechatLogin() {
      if (!this.ensureAgreed()) return
      this.doLogin({})
    },

    /** 云模式：微信手机号授权登录 */
    onGetPhoneNumber(e) {
      if (!this.ensureAgreed()) return
      const code = e && e.detail && e.detail.code
      if (!code) {
        wx.showToast({ title: '未完成手机号授权，可改用微信一键登录', icon: 'none' })
        return
      }
      this.doLogin({ phoneCode: code })
    },

    doLogin(payload, phone) {
      if (this.data.submitting) return
      this.setData({ submitting: true })
      wx.showLoading({ title: '登录中', mask: true })
      api
        .login(payload)
        .then((user) => {
          wx.hideLoading()
          // 记住本次登录手机号，下次可「登录此账号」一键复用
          if (phone) setStorage(KEYS.lastPhone, phone)
          this.setData({ submitting: false })
          // 新用户头像昵称还是默认值：先引导一次，拿到微信头像昵称再进小程序
          if (isFreshUser(user) && needProfileSetup(user)) {
            this.gotoProfileStep(user)
            return
          }
          this.finish(user)
        })
        .catch(() => {
          wx.hideLoading()
          this.setData({ submitting: false })
          wx.showToast({ title: '登录失败，请重试', icon: 'none' })
        })
    },

    /* ------------------------ 完善头像昵称（新用户） ------------------------ */

    /**
     * 进入完善资料步骤
     *
     * 微信自 2022-10-25 起回收了 wx.getUserProfile 的真实昵称头像，小程序没有静默获取的
     * 接口，只能由用户点一下（头像走 chooseAvatar，昵称走 nickname 输入框的微信昵称提示）。
     * 所以这里不做「跳过就登录不了」的硬拦截，两个入口都允许「暂不完善」。
     */
    gotoProfileStep(user) {
      this.setData({
        step: 'profile',
        // 导航标题短一些，避免和正文大标题完全重复
        navTitle: '完善资料',
        profileUser: user,
        // 历史脏数据（本机临时路径）不预填，同上
        profileAvatar: usableAvatar(user && user.avatarUrl),
        // 随机生成的默认昵称不预填：预填了反而要用户先删掉才能选微信昵称
        profileNick: '',
        profileSaving: false,
      })
    },

    onProfileAvatar(e) {
      const url = e.detail && e.detail.avatarUrl
      if (url) this.setData({ profileAvatar: url })
    },

    onProfileNick(e) {
      this.setData({ profileNick: String(e.detail.value || '').slice(0, 20) })
    },

    /** 暂不完善：保留默认昵称头像，按登录成功继续原操作 */
    skipProfile() {
      if (this.data.profileSaving) return
      this.finish(this.data.profileUser)
    },

    saveProfile() {
      if (this.data.profileSaving) return
      const user = this.data.profileUser
      if (!user) return
      const nickName = String(this.data.profileNick || '').trim()
      if (!nickName) {
        wx.showToast({ title: '请填写昵称', icon: 'none' })
        return
      }
      this.setData({ profileSaving: true })
      wx.showLoading({ title: '保存中', mask: true })
      uploadAvatar(this.data.profileAvatar)
        .then((avatarUrl) =>
          api.updateUser({
            userInfo: {
              nickName,
              avatarUrl,
              avatarText: nickName.slice(0, 1),
            },
          })
        )
        .then((updated) => {
          wx.hideLoading()
          this.setData({ profileSaving: false })
          this.finish(updated || user)
        })
        .catch((err) => {
          wx.hideLoading()
          this.setData({ profileSaving: false })
          // 资料没保存成功不算登录失败：停在当前步骤，用户可重试或「暂不完善」
          wx.showToast({ title: (err && err.message) || '保存失败，请重试', icon: 'none' })
        })
    },

    noop() {},
  },
})
