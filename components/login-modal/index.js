// 登录页：全屏登录界面，顶部返回 + 品牌区 + 协议勾选 + 主次登录按钮 + 底部「暂不登录」
// - 协议勾选后才允许登录，未勾选点击登录会提示并抖动协议行
// - 登录过的手机号展示为「登录此账号 + 脱敏手机号」，可一键复用
// - 「手机号快捷登录」「切换手机号」进入手机号输入；「暂不登录」取消并返回原操作
const api = require('../../services/api')
const config = require('../../services/config')
const { AGREEMENTS } = require('../../utils/agreements')
const { KEYS, getStorage, setStorage } = require('../../utils/storage')
const { parseBold } = require('../../utils/util')

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
    // main：登录首页 | phone：输入手机号 | agreement：协议正文
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
          this.finish(user)
        })
        .catch(() => {
          wx.hideLoading()
          this.setData({ submitting: false })
          wx.showToast({ title: '登录失败，请重试', icon: 'none' })
        })
    },

    noop() {},
  },
})
