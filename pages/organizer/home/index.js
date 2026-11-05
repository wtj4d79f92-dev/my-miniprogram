const api = require('../../../services/api')
const config = require('../../../services/config')
const ui = require('../../../utils/ui')
const privacyUpdateBehavior = require('../../../behaviors/privacy-update-behavior')

const PAGE_SIZE = 10

/** 本机图片先转存云存储；Mock 模式与已是远程地址的图片原样返回 */
function uploadCover(source) {
  const path = String(source || '')
  if (!path || config.useMock || path.indexOf('cloud://') === 0 || path.indexOf('https://') === 0) {
    return Promise.resolve(path)
  }
  const ext = (path.match(/\.([a-zA-Z0-9]+)(?:\?|$)/) || [])[1] || 'jpg'
  return new Promise((resolve, reject) => {
    wx.cloud.uploadFile({
      cloudPath: `organizer-cover/${Date.now()}-${Math.floor(Math.random() * 100000)}.${ext}`,
      filePath: path,
      success: (res) => resolve((res && res.fileID) || ''),
      fail: () => reject(new Error('背景图上传失败，请检查网络后重试')),
    })
  })
}

Page({
  behaviors: [privacyUpdateBehavior],

  data: {
    hostSlot: 0,
    organizer: null,
    list: [],
    total: 0,
    pageIndex: 0,
    hasMore: false,
    loading: true,
    refreshing: false,
    loadingMore: false,
    notFound: false,
    coverSaving: false,
  },

  onLoad(options) {
    const hostSlot = Math.max(0, Math.floor(Number(options && options.hostSlot) || 0))
    this.setData({ hostSlot })
    if (!hostSlot) {
      this.setData({ loading: false, notFound: true })
      return Promise.resolve()
    }
    this.syncPageTitle()
    return Promise.all([this.loadOrganizer(), this.loadList(true)])
  },

  syncPageTitle() {
    if (wx.setNavigationBarTitle) {
      wx.setNavigationBarTitle({ title: '主办方活动集合' })
    }
  },

  loadOrganizer() {
    return api
      .organizer(this.data.hostSlot)
      .then((organizer) => {
        this.setData({ organizer: organizer || null, notFound: !organizer })
        if (organizer && organizer.nickName) {
          this.setData({ loading: false })
        }
        return organizer
      })
      .catch(() => {
        this.setData({ organizer: null, notFound: true, loading: false })
        return null
      })
  },

  loadList(reset) {
    const pageIndex = reset ? 0 : this.data.pageIndex + 1
    this.setData(reset ? { loading: true } : { loadingMore: true })
    return api
      .list({
        hostSlot: this.data.hostSlot,
        pageIndex,
        pageSize: PAGE_SIZE,
        sort: 'latest',
      })
      .then((res) => {
        const rows = ((res && res.list) || []).map(api.decorate)
        this.setData({
          list: reset ? rows : this.data.list.concat(rows),
          total: Math.max(0, Number(res && res.total) || rows.length),
          pageIndex,
          hasMore: !!(res && res.hasMore),
          loading: false,
          refreshing: false,
          loadingMore: false,
        })
        return rows
      })
      .catch(() => {
        this.setData({ loading: false, refreshing: false, loadingMore: false })
        return []
      })
  },

  onRefresh() {
    if (this.data.loading || this.data.refreshing) return Promise.resolve()
    this.setData({ refreshing: true })
    return Promise.all([this.loadOrganizer(), this.loadList(true)])
  },

  onScrollToLower() {
    if (!this.data.hasMore || this.data.loadingMore || this.data.loading) return
    this.loadList(false)
  },

  onCardTap(e) {
    wx.navigateTo({ url: `/pages/activity/detail/index?id=${e.detail.id}` })
  },

  /** 只有主办方本人的主页会渲染入口，服务端保存时还会再次校验归属 */
  changeCover() {
    const organizer = this.data.organizer
    if (!organizer || !organizer.isOwner || this.data.coverSaving) return Promise.resolve(false)
    return new Promise((resolve) => {
      wx.chooseMedia({
        count: 1,
        mediaType: ['image'],
        sourceType: ['album', 'camera'],
        sizeType: ['compressed'],
        success: (res) => {
          const file = res && res.tempFiles && res.tempFiles[0]
          const path = file && file.tempFilePath
          if (!path) {
            resolve(false)
            return
          }
          this.setData({ coverSaving: true })
          uploadCover(path)
            .then((cover) => api.updateOrganizerCover(this.data.hostSlot, cover))
            .then((saved) => {
              const coverUrl = (saved && saved.coverUrl) || path
              this.setData({
                'organizer.coverUrl': coverUrl,
                coverSaving: false,
              })
              ui.toast('背景已更新', 'success')
              resolve(true)
            })
            .catch((err) => {
              this.setData({ coverSaving: false })
              ui.toast((err && err.message) || '背景保存失败，请重试')
              resolve(false)
            })
        },
        fail: () => resolve(false),
      })
    })
  },
})
