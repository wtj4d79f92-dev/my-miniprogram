const api = require('../../services/api')
const { TEXTS, TYPE_GRID, normalizeBanners } = require('../../utils/dict')
const { KEYS, setStorage } = require('../../utils/storage')
const loginBehavior = require('../../behaviors/login-behavior')
const ui = require('../../utils/ui')

Page({
  behaviors: [loginBehavior],

  data: {
    texts: TEXTS,
    typeGrid: TYPE_GRID,
    city: '',
    cityLabel: '全部',
    locationDenied: false,
    banners: [],
    hotList: [],
    newestList: [],
    fallbackTip: '',
    loading: true,
    refreshing: false,
    user: null,
  },

  onLoad() {
    const app = getApp()
    this.setData({
      user: app.globalData.user,
      city: app.globalData.city,
      cityLabel: app.globalData.city || '全部',
      locationDenied: app.globalData.locationDenied,
    })
    this.initCity()
  },

  onShow() {
    const app = getApp()
    if (this.getTabBar && this.getTabBar()) {
      this.getTabBar().setData({ selected: 0 })
    }
    this.setData({
      user: app.globalData.user,
      city: app.globalData.city,
      cityLabel: app.globalData.city || '全部',
    })
    this.loadData()
  },

  onPullDownRefresh() {
    this.loadData().then(() => wx.stopPullDownRefresh())
  },

  /** 首次进入且用户未手动选过城市时自动定位 */
  initCity() {
    const app = getApp()
    if (app.globalData.city) return
    app.relocate().then((city) => {
      this.setData({
        city: city || '',
        cityLabel: city || '全部',
        locationDenied: !city,
      })
      this.loadData()
    })
  },

  loadData() {
    const city = this.data.city
    return api
      .home({ city })
      .then((res) => {
        const hasData = (res.hotList && res.hotList.length) || (res.newestList && res.newestList.length)
        if (!hasData && city) {
          ui.toast('暂无符合要求的活动')
          return api.home({ city: '' }).then((fallback) => {
            const hotList = (fallback.hotList || []).map(api.decorate)
            const newestList = (fallback.newestList || []).map(api.decorate)
            this.setData({
              banners: normalizeBanners(fallback.banners),
              hotList,
              newestList,
              // 全库都没有活动时只说「暂无活动」，别再提示「为你推荐其他活动」而下面空着
              fallbackTip: hotList.length || newestList.length ? '暂无符合要求的活动，为你推荐其他活动' : '',
              loading: false,
              refreshing: false,
            })
          })
        }
        this.setData({
          // 老环境的默认横幅还写着「去发布」，进入页面时按最新默认动作升级
          banners: normalizeBanners(res.banners),
          hotList: (res.hotList || []).map(api.decorate),
          newestList: (res.newestList || []).map(api.decorate),
          fallbackTip: '',
          loading: false,
          refreshing: false,
        })
        return null
      })
      .catch(() => {
        // 接口失败静默降级为空数据，不阻塞浏览
        this.setData({ loading: false, refreshing: false })
      })
  },

  onRefresh() {
    this.setData({ refreshing: true })
    this.loadData()
  },

  /** 点击定位栏：未授权引导设置，已授权重新定位 */
  onLocateTap() {
    const app = getApp()
    if (this.data.locationDenied) {
      ui.confirm({
        title: '定位未开启',
        content: '开启定位权限后即可自动匹配同城活动，是否前往设置？',
        confirmText: '去设置',
      }).then((ok) => {
        if (!ok) return
        wx.openSetting({
          success: () => {
            app.relocate().then((city) => {
              this.setData({ city: city || '', cityLabel: city || '全部', locationDenied: !city })
              this.loadData()
            })
          },
        })
      })
      return
    }
    wx.showLoading({ title: '定位中', mask: true })
    app.relocate().then((city) => {
      wx.hideLoading()
      this.setData({ city: city || '', cityLabel: city || '全部', locationDenied: !city })
      if (!city) ui.toast('定位未开启，可手动选择城市')
      this.loadData()
    })
  },

  openCityPicker() {
    const picker = this.selectComponent('#city-picker')
    if (picker) picker.open(this.data.city)
  },

  onCityChange(e) {
    const app = getApp()
    const city = e.detail.city || ''
    app.setCity(city)
    this.setData({ city, cityLabel: city || '全部', locationDenied: false })
    this.loadData()
  },

  goSquare(e) {
    const type = (e && e.currentTarget && e.currentTarget.dataset.type) || ''
    if (type) {
      setStorage(KEYS.pendingType, type)
    }
    wx.switchTab({ url: '/pages/square/index' })
  },

  /**
   * 带类型进广场：横幅 / 玩法入口点击时，除预选活动类型外还要带上「当前定位城市」，
   * 避免定位还没回来就跳转，广场落到「全部城市」而筛不出同城活动。
   */
  openSquare(type) {
    if (type) setStorage(KEYS.pendingType, type)
    const app = getApp()
    const jump = () => wx.switchTab({ url: '/pages/square/index' })
    if (app.globalData.city || app.globalData.locationDenied) {
      jump()
      return
    }
    app.relocate().then((city) => {
      this.setData({ city: city || '', cityLabel: city || '全部', locationDenied: !city })
      jump()
    })
  },

  onBannerTap(e) {
    const action = e.currentTarget.dataset.action || {}
    if (action.type === 'publish') {
      this.goPublish()
      return
    }
    this.openSquare(action.value)
  },

  onTypeTap(e) {
    this.openSquare(e.currentTarget.dataset.type)
  },

  onCardTap(e) {
    wx.navigateTo({ url: `/pages/activity/detail/index?id=${e.detail.id}` })
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
    this.loadData()
  },
})
