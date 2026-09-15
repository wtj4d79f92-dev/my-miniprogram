// app.js
const { KEYS, getStorage, setStorage, removeStorage } = require('./utils/storage')
const { locate } = require('./utils/location')

App({
  globalData: {
    statusBarHeight: 20,
    safeAreaBottom: 0,
    windowWidth: 375,
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
    this.initSystemInfo()
    this.restoreState()
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
