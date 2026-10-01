// app.js
const { KEYS, getStorage, setStorage, removeStorage } = require('./utils/storage')
const { locate } = require('./utils/location')
const config = require('./services/config')
const api = require('./services/api')

/**
 * 启动后多久去校验本地登录态。
 *
 * 校验要打一次 activity 云函数，而首页的活动请求也在启动瞬间发出：两个调用同时打过去，
 * 云函数会一下子冷启动两个实例（默认单实例单并发），首屏要等的那一次反而更慢。
 * 延后这一会儿，首页请求先把实例占热，校验再发就能复用同一个实例。
 * 延后期间任何需要登录态的操作都会通过 app.userReady 等这次校验（见 behaviors/login-behavior.js），
 * 所以本地那份可能已失效的登录态不会被放行。
 */
const USER_VERIFY_DELAY = 1500

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
    // 未读消息数：底部 tab 的小红点与「我的 → 消息」入口上的数字共用这一份
    unreadCount: 0,
  },

  onLaunch() {
    this.initCloud()
    this.initSystemInfo()
    this.restoreState()
    // 本地缓存只是登录态的快照，真伪以服务端为准；页面侧用 userReady 等待这次校验
    this.userReady = new Promise((resolve) => {
      setTimeout(() => {
        let ready = null
        try {
          ready = this.verifyUser()
        } catch (e) {
          ready = null
        }
        resolve(ready)
      }, USER_VERIFY_DELAY)
    })
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
    // 登录态失效 / 注销后未读数要跟着归零，否则底部 tab 的小红点会一直亮着
    if (!this.globalData.user) this.setUnreadCount(0)
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

  /**
   * 未读消息数：底部 tab 的小红点与「我的 → 消息」入口共用同一份数据。
   *
   * 三个 tab 页的 onShow 都可能触发这次刷新，同一时刻只发一次请求 ——
   * 首屏那次 home 请求本来就紧张，不该被三个并发的未读查询挤掉。
   * 未登录或接口失败一律按 0 处理：红点是锦上添花，不能因为一次失败一直亮着。
   * @param {object} [page] 需要同步小红点的页面（通常是调用方自己）
   * @returns {Promise<number>} 未读条数
   */
  refreshUnread(page) {
    // 先把本地那份推给 tabBar：切 tab 时能立刻画对，不用等接口回来
    this.syncUnread(page)
    if (!this.globalData.user) {
      this.globalData.unreadCount = 0
      this.syncUnread(page)
      return Promise.resolve(0)
    }
    if (this._unreadPending) {
      return this._unreadPending.then((count) => {
        this.syncUnread(page)
        return count
      })
    }
    this._unreadPending = api
      .notificationUnread()
      .then((res) => (res && res.count) || 0)
      .catch(() => 0)
      .then((count) => {
        this._unreadPending = null
        this.globalData.unreadCount = count
        this.syncUnread(page)
        return count
      })
    return this._unreadPending
  },

  /**
   * 把 globalData 里的未读数推给自定义 tabBar。
   * 页面还没挂上 tabBar（首帧）或不是 tab 页时静默跳过，不影响业务。
   */
  syncUnread(page) {
    let target = page
    if (!target && getCurrentPages) {
      const pages = getCurrentPages()
      target = pages[pages.length - 1]
    }
    const bar = target && target.getTabBar && target.getTabBar()
    if (bar) bar.setData({ unread: this.globalData.unreadCount || 0 })
  },

  /** 本地直接改未读数（消息中心读掉一条时用），tab 小红点立刻跟着变 */
  setUnreadCount(count) {
    const value = Number(count)
    this.globalData.unreadCount = !Number.isFinite(value) || value < 0 ? 0 : value
    this.syncUnread()
    return this.globalData.unreadCount
  },
})
