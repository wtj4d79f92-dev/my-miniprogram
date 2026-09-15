const api = require('../../../services/api')
const {
  TYPE_GRID,
  ACTIVITY_TAGS,
  DIFFICULTY_OPTIONS,
  supportsTags,
  supportsMetrics,
} = require('../../../utils/dict')
const { formatCardDate, startOfDay, addDays } = require('../../../utils/util')
const loginBehavior = require('../../../behaviors/login-behavior')
const ui = require('../../../utils/ui')

Page({
  behaviors: [loginBehavior],

  data: {
    typeGrid: TYPE_GRID,
    // 标签的选中态在 js 里算好：WXML 表达式不支持调用 indexOf 之类的方法
    tagOptions: ACTIVITY_TAGS.map((item) => ({ key: item.key, name: item.name, active: false })),
    difficultyOptions: DIFFICULTY_OPTIONS,
    difficultyIndex: 2,
    difficultyLabel: DIFFICULTY_OPTIONS[2].label,
    showTags: true,
    showMetrics: true,
    agreed: false,
    submitting: false,
    descCount: 0,
    startLabel: '',
    endLabel: '',
    // 校验未通过的字段提示：{ title: '请填写活动标题' }
    errors: {},
    user: null,
    form: {
      cover: '',
      type: 'hiking',
      tags: [],
      title: '',
      startTime: 0,
      endTime: 0,
      location: '',
      difficulty: 3,
      distance: '',
      elevationGain: '',
      feeMode: 'aa',
      fee: '',
      maxPeople: 10,
      groupQrCode: '',
      desc: '',
    },
  },

  onLoad() {
    const app = getApp()
    const today = startOfDay(Date.now())
    const startTime = addDays(today, 1)
    const endTime = addDays(today, 2)
    this.setData({
      user: app.globalData.user,
      'form.startTime': startTime,
      'form.endTime': endTime,
      startLabel: formatCardDate(startTime),
      endLabel: formatCardDate(endTime),
    })
  },

  onShow() {
    const app = getApp()
    this.setData({ user: app.globalData.user })
  },

  /* ---------------------------- 基础字段 ---------------------------- */

  chooseCover() {
    wx.chooseMedia({
      count: 1,
      mediaType: ['image'],
      sourceType: ['album', 'camera'],
      sizeType: ['compressed'],
      success: (res) => {
        const file = res.tempFiles && res.tempFiles[0]
        if (file) this.setData({ 'form.cover': file.tempFilePath })
      },
    })
  },

  removeCover() {
    this.setData({ 'form.cover': '' })
  },

  onTypeTap(e) {
    const type = e.currentTarget.dataset.type
    if (type === this.data.form.type) return
    const patch = { 'form.type': type }
    // 切换类型时清理不适用字段
    if (!supportsTags(type)) {
      patch['form.tags'] = []
      patch.tagOptions = this.data.tagOptions.map((item) => ({ key: item.key, name: item.name, active: false }))
    }
    if (!supportsMetrics(type)) {
      patch['form.distance'] = ''
      patch['form.elevationGain'] = ''
      patch['errors.distance'] = ''
      patch['errors.elevationGain'] = ''
    }
    patch.showTags = supportsTags(type)
    patch.showMetrics = supportsMetrics(type)
    this.setData(patch)
  },

  toggleTag(e) {
    const key = e.currentTarget.dataset.key
    const tags = this.data.form.tags.slice()
    const index = tags.indexOf(key)
    if (index > -1) {
      tags.splice(index, 1)
    } else {
      tags.push(key)
    }
    this.setData({
      'form.tags': tags,
      tagOptions: this.data.tagOptions.map((item) => ({
        key: item.key,
        name: item.name,
        active: tags.indexOf(item.key) > -1,
      })),
    })
  },

  onTitleInput(e) {
    this.setData({ 'form.title': String(e.detail.value || '').slice(0, 30) })
    this.clearError('title')
  },

  /** 用户重新填写后清掉对应字段的报错提示 */
  clearError(key) {
    if (!key || !this.data.errors || !this.data.errors[key]) return
    this.setData({ [`errors.${key}`]: '' })
  },

  openCalendar(e) {
    const field = e.currentTarget.dataset.field
    const modal = this.selectComponent('#calendar-picker')
    if (!modal) return
    const form = this.data.form
    const isStart = field === 'startTime'
    this._dateField = field
    modal.open(isStart ? form.startTime : form.endTime, {
      title: isStart ? '选择集合时间' : '选择返程时间',
      minTs: isStart ? startOfDay(Date.now()) : form.startTime,
    })
  },

  onDateConfirm(e) {
    const timestamp = e.detail.timestamp
    const form = this.data.form
    if (this._dateField === 'startTime') {
      // 返程时间不得早于集合时间，集合时间后移时自动顺延返程
      const endTime = form.endTime && form.endTime >= timestamp ? form.endTime : timestamp
      this.setData({
        'form.startTime': timestamp,
        startLabel: formatCardDate(timestamp),
        'form.endTime': endTime,
        endLabel: formatCardDate(endTime),
        'errors.startTime': '',
        'errors.endTime': '',
      })
      return
    }
    this.setData({
      'form.endTime': timestamp,
      endLabel: formatCardDate(timestamp),
      'errors.endTime': '',
    })
  },

  chooseLocation() {
    wx.chooseLocation({
      success: (res) => {
        const address = res.address || res.name || ''
        this.setData({ 'form.location': address.slice(0, 50) })
        this.clearError('location')
      },
      fail: () => {
        ui.toast('地图选点不可用，请手动输入集合地点')
      },
    })
  },

  onLocationInput(e) {
    this.setData({ 'form.location': String(e.detail.value || '').slice(0, 50) })
    this.clearError('location')
  },

  onDifficultyChange(e) {
    const index = Number(e.detail.value)
    const option = DIFFICULTY_OPTIONS[index] || DIFFICULTY_OPTIONS[2]
    this.setData({
      difficultyIndex: index,
      difficultyLabel: option.label,
      'form.difficulty': option.value,
    })
  },

  onDistanceInput(e) {
    this.setData({ 'form.distance': e.detail.value })
    this.clearError('distance')
  },

  onElevationInput(e) {
    this.setData({ 'form.elevationGain': e.detail.value })
    this.clearError('elevationGain')
  },

  setFeeMode(e) {
    const mode = e.currentTarget.dataset.mode
    this.setData({ 'form.feeMode': mode })
    if (mode === 'aa') this.clearError('fee')
  },

  onFeeInput(e) {
    this.setData({ 'form.fee': e.detail.value })
    this.clearError('fee')
  },

  minusPeople() {
    const next = Math.max(2, Number(this.data.form.maxPeople) - 1)
    this.setData({ 'form.maxPeople': next })
  },

  plusPeople() {
    const next = Math.min(100, Number(this.data.form.maxPeople) + 1)
    this.setData({ 'form.maxPeople': next })
  },

  chooseGroupQr() {
    wx.chooseMedia({
      count: 1,
      mediaType: ['image'],
      sourceType: ['album'],
      sizeType: ['compressed'],
      success: (res) => {
        const file = res.tempFiles && res.tempFiles[0]
        if (file) {
          this.setData({ 'form.groupQrCode': file.tempFilePath })
          this.clearError('groupQrCode')
        }
      },
    })
  },

  removeGroupQr() {
    ui.confirm({ title: '删除二维码', content: '确定删除已上传的活动群二维码吗？' }).then((ok) => {
      if (ok) this.setData({ 'form.groupQrCode': '' })
    })
  },

  onDescInput(e) {
    const value = String(e.detail.value || '').slice(0, 500)
    this.setData({ 'form.desc': value, descCount: value.length })
  },

  toggleAgree() {
    const agreed = !this.data.agreed
    this.setData({ agreed })
    if (agreed) this.clearError('agreement')
  },

  openPublishAgreement() {
    const modal = this.selectComponent('#agreement-modal')
    if (modal) modal.open('publish')
  },

  onAgreementAgree() {
    this.setData({ agreed: true, 'errors.agreement': '' })
  },

  /* ---------------------------- 提交 ---------------------------- */

  /** 按文档顺序逐项校验，返回 { key, first, errors }，全部通过时 first 为 '' */
  validate() {
    const form = this.data.form
    const errors = {}
    if (!this.data.agreed) errors.agreement = '请先阅读并勾选《活动发布免责协议》'
    if (!String(form.title).trim()) errors.title = '请填写活动标题'
    if (!form.startTime) errors.startTime = '请选择集合时间'
    if (!form.endTime) errors.endTime = '请选择返程时间'
    if (form.startTime && form.endTime && form.endTime < form.startTime) errors.endTime = '返程时间不能早于集合时间'
    if (!String(form.location).trim()) errors.location = '请填写集合地点'
    if (this.data.showMetrics) {
      if (!(Number(form.distance) > 0)) errors.distance = '请填写大于 0 的全程长度（km）'
      if (!(Number(form.elevationGain) > 0)) errors.elevationGain = '请填写大于 0 的累计爬升（m）'
    }
    if (form.feeMode === 'fixed' && !(Number(form.fee) > 0)) errors.fee = '非 AA 制需填写大于 0 的人均费用'
    if (!form.groupQrCode) errors.groupQrCode = '请上传活动群二维码'
    // 与表单从上到下的顺序保持一致，提示第一条
    const order = [
      'agreement',
      'title',
      'startTime',
      'endTime',
      'location',
      'distance',
      'elevationGain',
      'fee',
      'groupQrCode',
    ]
    const key = order.find((name) => errors[name]) || ''
    return { key, first: key ? errors[key] : '', errors }
  },

  submit() {
    if (this.data.submitting) return
    const result = this.validate()
    this.setData({ errors: result.errors })
    if (result.first) {
      if (result.key === 'agreement') {
        ui.confirm({
          title: '提示',
          content: result.first,
          confirmText: '去阅读',
          cancelText: '稍后',
        }).then((ok) => {
          if (ok) this.openPublishAgreement()
        })
        return
      }
      ui.toast(result.first)
      return
    }
    const form = this.data.form
    const payload = Object.assign({}, form, {
      distance: Number(form.distance) || 0,
      elevationGain: Number(form.elevationGain) || 0,
      fee: form.feeMode === 'fixed' ? Number(form.fee) || 0 : 0,
    })
    this.setData({ submitting: true })
    wx.showLoading({ title: '发布中', mask: true })
    api
      .create({ form: payload })
      .then((activity) => {
        wx.hideLoading()
        this.setData({ submitting: false })
        ui.toast('发布成功', 'success')
        setTimeout(() => {
          wx.redirectTo({ url: `/pages/activity/detail/index?id=${activity.id}` })
        }, 1200)
      })
      .catch((err) => {
        wx.hideLoading()
        this.setData({ submitting: false })
        ui.toast((err && err.message) || '发布失败，请重试')
      })
  },

  onLogin(e) {
    this.handleLoginSuccess(e.detail)
  },
})
