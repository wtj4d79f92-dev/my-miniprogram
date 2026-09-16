// app.js
const { KEYS, getStorage, setStorage, removeStorage } = require('./utils/storage')
const { locate } = require('./utils/location')
const config = require('./services/config')
const api = require('./services/api')

App({
  globalData: {
    statusBarHeight: 20,
    safeAreaBottom: 0,
    windowWidth: 375,
    // 云环境是否初始化成功（Mock 模式下始终为 false，不影响业务流程）
    cloudReady: false,
    // 当前城市，'' 表示「全部 / 全国」
    city: '',
    // 定位是否已授权并成功
    cityLocated: false,
    // 定位是否被拒绝（拒绝后不再重复弹授权）
    locationDenied: false,
    // 已登录用户
    user: null,
  },

  onLaunch() {
    this.initCloud()
    this.initSystemInfo()
    this.restoreState()
    // 本地缓存只是登录态的快照，真伪以服务端为准；页面侧用 userReady 等待这次校验
    this.userReady = this.verifyUser()
  },

  /**
   * 校验本地缓存的登录态
   * 本地存着 user 但服务端查不到（例如之前 Mock 模式登录、之后切到云环境）时清掉本地缓存，
   * 否则会出现「本地守卫放行 → 填完表单提交才报未登录」。
   * 网络异常等无法判断的情况保留原状态，由接口层兜底。
   */
  verifyUser() {
    const stored = this.globalData.user
    if (!stored || !stored.openid) return Promise.resolve(null)
    return api
      .user()
      .then((user) => {
        this.applyUser(user && user.openid ? user : null)
        return this.globalData.user
      })
      .catch(() => stored)
  },

  /** 登录态变化后同步 globalData、本地缓存与已打开页面上的 user 数据 */
  applyUser(user) {
    this.setUser(user)
    const pages = getCurrentPages ? getCurrentPages() : []
    pages.forEach((page) => {
      if (!page || !page.setData || !page.data || !('user' in page.data)) return
      if (page.data.user !== this.globalData.user) page.setData({ user: this.globalData.user })
    })
  },

  /**
   * 云开发模式：初始化云环境，必须在任何 wx.cloud.callFunction 之前完成
   * 未配置 cloudEnv（或基础库不支持）时直接跳过，Mock 模式不受影响
   */
  initCloud() {
    if (!wx.cloud || !config.cloudEnv) return
    try {
      wx.cloud.init({ env: config.cloudEnv, traceUser: true })
      this.globalData.cloudReady = true
    } catch (e) {
      this.globalData.cloudReady = false
    }
  },

  initSystemInfo() {
    let info = {}
    try {
      info = (wx.getWindowInfo && wx.getWindowInfo()) || wx.getSystemInfoSync()
    } catch (e) {
      info = {}
    }
    const safeArea = info.safeArea || {}
    const screenHeight = info.screenHeight || info.windowHeight || 0
    this.globalData.statusBarHeight = info.statusBarHeight || 20
    this.globalData.windowWidth = info.windowWidth || 375
    this.globalData.safeAreaBottom = Math.max(0, screenHeight - (safeArea.bottom || screenHeight))
  },

  restoreState() {
    const savedCity = getStorage(KEYS.selectedCity, '')
    if (savedCity) {
      this.globalData.city = savedCity
      this.globalData.cityLocated = true
    }
    const user = getStorage(KEYS.user, null)
    if (user && user.openid) {
      this.globalData.user = user
    }
  },

  /** 设置当前城市（'' 表示全部）并持久化 */
  setCity(city) {
    const value = city || ''
    this.globalData.city = value
    if (value) {
      setStorage(KEYS.selectedCity, value)
    } else {
      removeStorage(KEYS.selectedCity)
    }
  },

  /** 重新定位：清除手动选择的城市后重新走定位流程 */
  relocate() {
    removeStorage(KEYS.selectedCity)
    return locate().then((city) => {
      if (city) {
        this.globalData.city = city
        this.globalData.cityLocated = true
        setStorage(KEYS.selectedCity, city)
      } else {
        this.globalData.city = ''
        this.globalData.cityLocated = false
      }
      return this.globalData.city
    })
  },

  setUser(user) {
    this.globalData.user = user || null
    if (user) {
      setStorage(KEYS.user, user)
    } else {
      removeStorage(KEYS.user)
    }
  },
})
