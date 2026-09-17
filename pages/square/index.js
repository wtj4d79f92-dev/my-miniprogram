const api = require('../../services/api')
const { TEXTS, TYPE_GRID, SORT_OPTIONS, WEEKDAY_OPTIONS } = require('../../utils/dict')
const { KEYS, getStorage, removeStorage } = require('../../utils/storage')
const { formatMonthDayShort } = require('../../utils/util')
const loginBehavior = require('../../behaviors/login-behavior')
const ui = require('../../utils/ui')

const PAGE_SIZE = 10
/** 日期筛选未选中时的占位文案 */
const DATE_PLACEHOLDER = '选择日期'
/** 活动类型筛选未选中时的占位文案 */
const TYPE_PLACEHOLDER = '全部类型'

/** 活动类型筛选项：全部类型 + 10 个玩法 */
const TYPE_OPTIONS = [{ key: 'all', name: TYPE_PLACEHOLDER, emoji: '' }].concat(TYPE_GRID)

/** 类型 key -> 展示名，未知类型回退「全部类型」 */
function typeLabelOf(key) {
  const option = TYPE_OPTIONS.filter((item) => item.key === key)[0]
  return option ? option.name : TYPE_PLACEHOLDER
}

Page({
  behaviors: [loginBehavior],

  data: {
    texts: TEXTS,
    typeOptions: TYPE_OPTIONS,
    typeLabel: TYPE_PLACEHOLDER,
    typeOpen: false,
    sortOptions: SORT_OPTIONS,
    weekdayOptions: WEEKDAY_OPTIONS,
    city: '',
    cityLabel: '全部',
    locationDenied: false,
    keyword: '',
    type: 'all',
    sort: 'latest',
    weekday: -1,
    weekdayLabel: '不限周几',
    weekdayOpen: false,
    date: 0,
    dateLabel: DATE_PLACEHOLDER,
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
    this.applyPendingType()
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
    this.applyPendingType()
    if (this._loadedOnce) {
      this.loadList(true)
    }
    this._loadedOnce = true
  },

  /** 首页玩法 / 横幅带参进入：读取待选类型并同步筛选胶囊文案 */
  applyPendingType() {
    const pendingType = getStorage(KEYS.pendingType, '')
    if (!pendingType) return
    removeStorage(KEYS.pendingType)
    this.setData({ type: pendingType, typeLabel: typeLabelOf(pendingType) })
  },

  buildQuery() {
    return {
      city: this.data.city,
      type: this.data.type,
      keyword: this.data.keyword,
      weekday: this.data.weekday,
      date: this.data.date,
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
    const hasCondition = !!query.city || query.type !== 'all' || query.weekday >= 0 || query.date > 0 || !!query.keyword
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
    this.setData({ city: '', cityLabel: '全部', type: 'all', typeLabel: TYPE_PLACEHOLDER })
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

  /** 活动类型筛选：下拉面板与星期下拉同时只展开一个 */
  toggleType() {
    this.setData({ typeOpen: !this.data.typeOpen, weekdayOpen: false })
  },

  onTypeSelect(e) {
    const type = e.currentTarget.dataset.type || 'all'
    this.setData({ type, typeLabel: typeLabelOf(type), typeOpen: false })
    this.loadList(true)
  },

  onSortTap(e) {
    const sort = e.currentTarget.dataset.sort
    if (sort === this.data.sort) return
    this.setData({ sort, weekdayOpen: false, typeOpen: false })
    this.loadList(true)
  },

  toggleWeekday() {
    this.setData({ weekdayOpen: !this.data.weekdayOpen, typeOpen: false })
  },

  onWeekdayTap(e) {
    const value = Number(e.currentTarget.dataset.value)
    const option = WEEKDAY_OPTIONS.find((item) => item.value === value)
    // 具体日期与星期是同一个维度（集合时间），选了星期就把具体日期收起来
    const resetDate = value >= 0
    this.setData({
      weekday: value,
      weekdayLabel: option ? option.label : '不限周几',
      weekdayOpen: false,
      date: resetDate ? 0 : this.data.date,
      dateLabel: resetDate ? DATE_PLACEHOLDER : this.data.dateLabel,
    })
    this.loadList(true)
  },

  /** 日期筛选：复用发布页的自研日历，最早只能选今天 */
  openDatePicker() {
    this.setData({ typeOpen: false, weekdayOpen: false })
    const picker = this.selectComponent('#calendar-picker')
    if (!picker) return
    picker.open(this.data.date || Date.now(), { title: '选择日期', minTs: Date.now() })
  },

  onDateConfirm(e) {
    const date = e.detail.timestamp
    // 选到具体某天后收起星期条件，避免两个时间条件互相打架查不出结果
    this.setData({
      date,
      dateLabel: formatMonthDayShort(date),
      weekday: -1,
      weekdayLabel: '不限周几',
      weekdayOpen: false,
    })
    this.loadList(true)
  },

  onDateClear() {
    if (!this.data.date) return
    this.setData({ date: 0, dateLabel: DATE_PLACEHOLDER })
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
