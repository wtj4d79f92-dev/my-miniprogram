const api = require('../../services/api')
const { TEXTS, TYPE_GRID, SORT_OPTIONS, WEEKDAY_OPTIONS } = require('../../utils/dict')
const { KEYS, getStorage, removeStorage } = require('../../utils/storage')
const loginBehavior = require('../../behaviors/login-behavior')
const ui = require('../../utils/ui')

const PAGE_SIZE = 10

Page({
  behaviors: [loginBehavior],

  data: {
    texts: TEXTS,
    typeTabs: [{ key: 'all', name: '全部', emoji: '' }].concat(TYPE_GRID),
    sortOptions: SORT_OPTIONS,
    weekdayOptions: WEEKDAY_OPTIONS,
    city: '',
    cityLabel: '全部',
    locationDenied: false,
    keyword: '',
    type: 'all',
    sort: 'time',
    weekday: -1,
    weekdayLabel: '不限日期',
    weekdayOpen: false,
    tabScrollId: 'tab-all',
    list: [],
    pageIndex: 0,
    hasMore: false,
    loading: true,
    loadingMore: false,
    refreshing: false,
    fallbackTip: '',
    user: null,
    empty: false,
  },

  onLoad() {
    const app = getApp()
    const pendingType = getStorage(KEYS.pendingType, '')
    if (pendingType) {
      removeStorage(KEYS.pendingType)
      this.setData({ type: pendingType, tabScrollId: `tab-${pendingType}` })
    }
    this.setData({
      user: app.globalData.user,
      city: app.globalData.city,
      cityLabel: app.globalData.city || '全部',
      locationDenied: app.globalData.locationDenied,
    })
    this.loadList(true)
  },

  onShow() {
    if (this.getTabBar && this.getTabBar()) {
      this.getTabBar().setData({ selected: 1 })
    }
    const app = getApp()
    this.setData({
      user: app.globalData.user,
      city: app.globalData.city,
      cityLabel: app.globalData.city || '全部',
      locationDenied: app.globalData.locationDenied,
    })
    // 首页玩法 / 横幅带参进入
    const pendingType = getStorage(KEYS.pendingType, '')
    if (pendingType) {
      removeStorage(KEYS.pendingType)
      this.setData({ type: pendingType, tabScrollId: `tab-${pendingType}` })
    }
    if (this._loadedOnce) {
      this.loadList(true)
    }
    this._loadedOnce = true
  },

  buildQuery() {
    return {
      city: this.data.city,
      type: this.data.type,
      keyword: this.data.keyword,
      weekday: this.data.weekday,
      sort: this.data.sort,
      pageSize: PAGE_SIZE,
    }
  },

  /** 拉取列表；reset 为 true 时重置到第 1 页 */
  loadList(reset) {
    const pageIndex = reset ? 0 : this.data.pageIndex + 1
    if (reset) {
      this.setData({ loading: true })
    } else {
      this.setData({ loadingMore: true })
    }
    const query = Object.assign(this.buildQuery(), { pageIndex })
    return api
      .list(query)
      .then((res) => {
        const raw = res.list || []
        if (!raw.length) {
          if (reset) {
            return this.handleEmpty(query, res)
          }
          this.setData({ hasMore: false, loadingMore: false, refreshing: false })
          return null
        }
        const decorated = raw.map(api.decorate)
        this.setData({
          list: reset ? decorated : this.data.list.concat(decorated),
          pageIndex,
          hasMore: !!res.hasMore,
          loading: false,
          loadingMore: false,
          refreshing: false,
          empty: false,
          fallbackTip: reset ? '' : this.data.fallbackTip,
        })
        return null
      })
      .catch(() => {
        this.setData({ loading: false, loadingMore: false, refreshing: false })
      })
  },

  /** 空结果：带条件时先 Toast，再清空城市与类型回退展示推荐 */
  handleEmpty(query, res) {
    const hasCondition = !!query.city || query.type !== 'all' || query.weekday >= 0 || !!query.keyword
    if (!hasCondition) {
      this.setData({
        list: [],
        empty: true,
        hasMore: false,
        loading: false,
        loadingMore: false,
        refreshing: false,
      })
      return null
    }
    ui.toast('暂无符合要求的活动')
    const app = getApp()
    app.setCity('')
    this.setData({ city: '', cityLabel: '全部', type: 'all', tabScrollId: 'tab-all' })
    const fallbackQuery = Object.assign({}, query, { city: '', type: 'all', pageIndex: 0 })
    return api.list(fallbackQuery).then((fallback) => {
      const decorated = (fallback.list || []).map(api.decorate)
      this.setData({
        list: decorated,
        pageIndex: 0,
        hasMore: !!fallback.hasMore,
        loading: false,
        loadingMore: false,
        refreshing: false,
        empty: decorated.length === 0,
        fallbackTip: decorated.length ? '暂无符合要求的活动，为你推荐以下活动' : '',
      })
      return null
    })
  },

  onRefresh() {
    this.setData({ refreshing: true })
    this.loadList(true)
  },

  onScrollToLower() {
    if (!this.data.hasMore || this.data.loadingMore || this.data.loading) return
    this.loadList(false)
  },

  onLoadMoreTap() {
    if (!this.data.hasMore) return
    if (this.data.loadingMore) return
    this.loadList(false)
  },

  onKeywordInput(e) {
    this.setData({ keyword: e.detail.value })
  },

  onKeywordConfirm() {
    this.loadList(true)
  },

  onKeywordClear() {
    this.setData({ keyword: '' })
    this.loadList(true)
  },

  onTypeTap(e) {
    const type = e.currentTarget.dataset.type
    if (type === this.data.type) return
    this.setData({ type, tabScrollId: `tab-${type}` })
    this.loadList(true)
  },

  onSortTap(e) {
    const sort = e.currentTarget.dataset.sort
    if (sort === this.data.sort) return
    this.setData({ sort, weekdayOpen: false })
    this.loadList(true)
  },

  toggleWeekday() {
    this.setData({ weekdayOpen: !this.data.weekdayOpen })
  },

  onWeekdayTap(e) {
    const value = Number(e.currentTarget.dataset.value)
    const option = WEEKDAY_OPTIONS.find((item) => item.value === value)
    this.setData({
      weekday: value,
      weekdayLabel: option ? option.label : '不限日期',
      weekdayOpen: false,
    })
    this.loadList(true)
  },

  onLocateTap() {
    const app = getApp()
    if (this.data.locationDenied) {
      wx.openSetting({
        success: () => {
          app.relocate().then((city) => {
            this.setData({ city: city || '', cityLabel: city || '全部', locationDenied: !city })
            this.loadList(true)
          })
        },
      })
      return
    }
    wx.showLoading({ title: '定位中', mask: true })
    app.relocate().then((city) => {
      wx.hideLoading()
      this.setData({ city: city || '', cityLabel: city || '全部', locationDenied: !city })
      this.loadList(true)
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
    this.loadList(true)
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
    this.loadList(true)
  },
})
