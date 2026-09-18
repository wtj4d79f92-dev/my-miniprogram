const api = require('../../services/api')
const { TEXTS, TYPE_GRID, normalizeBanners } = require('../../utils/dict')
const { KEYS, setStorage } = require('../../utils/storage')
const loginBehavior = require('../../behaviors/login-behavior')
const ui = require('../../utils/ui')
const scene = require('../../utils/scene')

/**
 * 分享卡片用代码包里的品牌图，而不是等微信截页面——首屏还没加载完就转发时，截图可能是空白的。
 * 两个入口的卡片比例不同：发送给朋友是 5:4（assets/share-home.png），
 * 分享到朋友圈是 1:1（assets/logo.png，与小程序 Logo 同一张图）。
 */
const SHARE_IMAGE = '/assets/share-home.png'
const TIMELINE_IMAGE = '/assets/logo.png'
const SHARE_TITLE = `${TEXTS.appName} · 同城找搭子，一起出发`

Page({
  behaviors: [loginBehavior],

  data: {
    texts: TEXTS,
    typeGrid: TYPE_GRID,
    city: '',
    cityLabel: '全部',
    locationDenied: false,
    locateTip: '点击定位',
    banners: [],
    hotList: [],
    newestList: [],
    fallbackTip: '',
    loading: true,
    refreshing: false,
    // 朋友圈单页模式：微信禁用跳转 / 分享，页面只做内容展示，相关入口按需降级
    singlePage: false,
    user: null,
  },

  onLoad() {
    const app = getApp()
    this.setData({ user: app.globalData.user, singlePage: scene.isSinglePageMode() })
    this.syncCityState()
  },

  onShow() {
    const app = getApp()
    if (this.getTabBar && this.getTabBar()) {
      this.getTabBar().setData({ selected: 0 })
    }
    this.setData({ user: app.globalData.user })
    this.syncCityState()
    this.syncPageTitle()
    this.loadData()
  },

  onPullDownRefresh() {
    this.loadData().then(() => wx.stopPullDownRefresh())
  },

  /**
   * 同步城市状态：只读已有状态，不在启动时自动发起定位。
   *
   * 位置授权弹窗要等用户主动点定位栏（或在广场点城市栏）再弹，
   * 一进小程序就索权既打断浏览，也容易被审核判成「未主动触发即索要敏感权限」。
   * 首屏没定位时按「全部城市」展示，用户点一下定位栏即可自动匹配同城。
   */
  syncCityState() {
    const app = getApp()
    const city = app.globalData.city || ''
    this.setData({
      city,
      cityLabel: city || '全部',
      locationDenied: app.globalData.locationDenied,
      locateTip: city ? '点击重新定位' : '点击定位',
    })
  },

  /** 定位结果落到页面：城市 + 定位栏文案（失败按「定位未开启」处理） */
  applyLocateResult(city) {
    this.setData({
      city: city || '',
      cityLabel: city || '全部',
      locationDenied: !city,
      locateTip: city ? '点击重新定位' : '点击定位',
    })
    this.syncPageTitle()
  },

  /**
   * 页面标题带上城市，方便微信理解页面主题（自定义导航栏下用户看不到）。
   * 标题里保留「找搭子 / 同城」这类业务词，关键词入口拿不到时，标题是最直接的相关性来源。
   */
  syncPageTitle() {
    const city = this.data.city
    ui.setPageTitle(city ? `${city}找搭子 · 旷行吖` : '旷行吖 · 同城找搭子')
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
    // 单页模式没有登录态，授权弹窗与 wx.openSetting 都会被微信拦下，定位栏不做响应
    if (this.data.singlePage) return
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
              this.applyLocateResult(city)
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
      this.applyLocateResult(city)
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
    this.setData({ city, cityLabel: city || '全部', locationDenied: false, locateTip: '点击重新定位' })
    this.syncPageTitle()
    this.loadData()
  },

  goSquare(e) {
    // 单页模式下微信禁用页面跳转（switchTab / navigateTo 都在禁用列表里），点了只会弹「请前往小程序」
    if (this.data.singlePage) return
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
    if (this.data.singlePage) return
    if (type) setStorage(KEYS.pendingType, type)
    const app = getApp()
    const jump = () => wx.switchTab({ url: '/pages/square/index' })
    if (app.globalData.city || app.globalData.locationDenied) {
      jump()
      return
    }
    app.relocate().then((city) => {
      this.applyLocateResult(city)
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
    if (this.data.singlePage) return
    wx.navigateTo({ url: `/pages/activity/detail/index?id=${e.detail.id}` })
  },

  goPublish() {
    if (this.data.singlePage) return
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

  /* ------------------------------ 分享 ------------------------------ */

  /** 右上角菜单「发送给朋友」的卡片内容 */
  onShareAppMessage() {
    return {
      title: SHARE_TITLE,
      path: '/pages/home/home',
      imageUrl: SHARE_IMAGE,
    }
  },

  /** 右上角菜单「分享到朋友圈」的卡片内容，朋友圈卡片只有标题与方图 */
  onShareTimeline() {
    return {
      title: SHARE_TITLE,
      imageUrl: TIMELINE_IMAGE,
    }
  },
})
