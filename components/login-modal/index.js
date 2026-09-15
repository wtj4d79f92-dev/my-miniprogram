const api = require('../../services/api')
const config = require('../../services/config')

Component({
  options: {
    styleIsolation: 'apply-shared',
  },

  data: {
    visible: false,
    phone: '',
    submitting: false,
    useMock: config.useMock,
  },

  methods: {
    /** 打开弹窗，返回登录结果 */
    open() {
      return new Promise((resolve) => {
        this._resolve = resolve
        this.setData({ visible: true, phone: '', submitting: false })
      })
    },

    finish(user) {
      this.setData({ visible: false })
      const resolve = this._resolve
      this._resolve = null
      if (resolve) resolve(user || null)
      if (user) {
        this.triggerEvent('login', user)
      }
    },

    close() {
      this.finish(null)
    },

    noop() {},

    onPhoneInput(e) {
      this.setData({ phone: e.detail.value })
    },

    /** Mock 模式：手机号模拟登录 */
    submitPhone() {
      if (this.data.submitting) return
      const phone = String(this.data.phone || '').trim()
      if (!/^1\d{10}$/.test(phone)) {
        wx.showToast({ title: '请输入正确的11位手机号', icon: 'none' })
        return
      }
      this.setData({ submitting: true })
      wx.showLoading({ title: '登录中', mask: true })
      api
        .login({ phone })
        .then((user) => {
          wx.hideLoading()
          this.setData({ submitting: false })
          this.finish(user)
        })
        .catch(() => {
          wx.hideLoading()
          this.setData({ submitting: false })
          wx.showToast({ title: '登录失败，请重试', icon: 'none' })
        })
    },

    /** 跳过，体验浏览：以默认用户身份进入 */
    skip() {
      if (this.data.submitting) return
      this.setData({ submitting: true })
      api
        .login({})
        .then((user) => {
          this.setData({ submitting: false })
          this.finish(user)
        })
        .catch(() => {
          this.setData({ submitting: false })
          wx.showToast({ title: '登录失败，请重试', icon: 'none' })
        })
    },

    /** 云模式：微信手机号授权登录 */
    onGetPhoneNumber(e) {
      if (!e.detail || !e.detail.code) {
        wx.showToast({ title: '手机号授权不可用，不影响登录使用', icon: 'none' })
        return
      }
      if (this.data.submitting) return
      this.setData({ submitting: true })
      wx.showLoading({ title: '登录中', mask: true })
      api
        .login({ phoneCode: e.detail.code })
        .then((user) => {
          wx.hideLoading()
          this.setData({ submitting: false })
          this.finish(user)
        })
        .catch(() => {
          wx.hideLoading()
          this.setData({ submitting: false })
          wx.showToast({ title: '登录失败，请重试', icon: 'none' })
        })
    },
  },
})
