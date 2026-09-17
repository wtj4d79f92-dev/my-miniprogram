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
const config = require('../../../services/config')
const { parsePickedPlace, placeNameOf, LOCATION_MAX } = require('../../../utils/location')
const { matchCity } = require('../../../utils/cities')

const LOGIN_REASON = '发布活动需要先登录，是否立即登录？'

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
    published: false,
    // 编辑模式：带上活动 id 进入时回填原内容，提交后重新送审
    editId: '',
    pageTitle: '发起活动',
    submitText: '发布活动',
    descCount: 0,
    startLabel: '',
    endLabel: '',
    // 集合地点里认不出城市时的提示（服务端会按发布者当前城市归属）
    cityTip: '',
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
      // 地图选点反查出的完整地址：不展示，只随表单上送给服务端做城市匹配与地址检索
      locationAddress: '',
      // 地图选点带出来的坐标：不展示，详情页 / 广场卡片点地址时用它直接调起地图导航
      locationLat: 0,
      locationLng: 0,
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

  onLoad(options) {
    const app = getApp()
    const today = startOfDay(Date.now())
    const startTime = addDays(today, 1)
    const endTime = addDays(today, 2)
    const editId = (options && options.id) || ''
    this.setData({
      user: app.globalData.user,
      'form.startTime': startTime,
      'form.endTime': endTime,
      startLabel: formatCardDate(startTime),
      endLabel: formatCardDate(endTime),
    })
    if (editId) {
      this.setData({ editId, pageTitle: '编辑活动', submitText: '重新提交审核' })
      this.loadActivity(editId)
    }
  },

  /** 编辑模式：拉取原活动回填表单，仅发起人可进入（服务端 update 也会再校验一次） */
  loadActivity(id) {
    api
      .detail(id)
      .then((raw) => {
        const app = getApp()
        const user = app.globalData.user
        if (!raw) {
          ui.toast('活动不存在或已下架')
          wx.navigateBack({ fail: () => wx.reLaunch({ url: '/pages/home/home' }) })
          return
        }
        if (!user || !raw.organizer || raw.organizer.openid !== user.openid) {
          ui.toast('仅发起人可修改活动')
          wx.navigateBack({ fail: () => wx.reLaunch({ url: '/pages/home/home' }) })
          return
        }
        const tags = raw.tags || []
        const difficulty = Number(raw.difficulty) || 0
        const difficultyIndex = Math.max(
          0,
          DIFFICULTY_OPTIONS.findIndex((item) => item.value === difficulty)
        )
        const desc = raw.desc || ''
        this.setData({
          form: {
            cover: raw.cover || '',
            type: raw.type,
            tags,
            title: raw.title || '',
            startTime: raw.startTime,
            endTime: raw.endTime,
            location: raw.location || '',
            locationAddress: raw.locationAddress || '',
            locationLat: raw.locationLat || 0,
            locationLng: raw.locationLng || 0,
            difficulty,
            distance: raw.distance ? String(raw.distance) : '',
            elevationGain: raw.elevationGain ? String(raw.elevationGain) : '',
            feeMode: raw.feeMode === 'fixed' ? 'fixed' : 'aa',
            fee: raw.fee ? String(raw.fee) : '',
            maxPeople: raw.maxPeople || 10,
            groupQrCode: raw.groupQrCode || '',
            desc,
          },
          difficultyIndex,
          difficultyLabel: (DIFFICULTY_OPTIONS[difficultyIndex] || DIFFICULTY_OPTIONS[2]).label,
          showTags: supportsTags(raw.type),
          showMetrics: supportsMetrics(raw.type),
          tagOptions: ACTIVITY_TAGS.map((item) => ({
            key: item.key,
            name: item.name,
            active: tags.indexOf(item.key) > -1,
          })),
          descCount: desc.length,
          startLabel: formatCardDate(raw.startTime),
          endLabel: raw.endTime ? formatCardDate(raw.endTime) : '',
          // 首发时已勾选过免责协议，同一份内容的修改重提不再重复要求勾选
          agreed: true,
        })
        this.updateCityTip()
      })
      .catch(() => {
        ui.toast('活动信息加载失败，请重试')
      })
  },

  onShow() {
    const app = getApp()
    this.setData({ user: app.globalData.user })
    // 定位可能在上一步才拿到城市，回到本页时刷新归属提示
    this.updateCityTip()
  },

  /**
   * 集合地点缺省市时的归属提示。
   *
   * 手输「双流区润和路附近」这类短地址匹配不出城市，服务端会按发布者当前城市归属；
   * 这里提前告诉用户，避免发布后「按城市筛选找不到自己的活动」。
   */
  updateCityTip() {
    const form = this.data.form || {}
    const location = String(form.location || '').trim()
    if (!location) {
      if (this.data.cityTip) this.setData({ cityTip: '' })
      return
    }
    const matched = matchCity(form.locationAddress || form.location)
    const city = getApp().globalData.city || ''
    let tip = ''
    if (!matched && city) {
      tip = `集合地点里没有城市信息，活动将按当前城市「${city}」展示；想换城市可以补上省市或在地图上选点`
    } else if (!matched) {
      tip = '集合地点里没有城市信息，建议补上省市或在地图上选点，否则按城市筛选时可能找不到'
    }
    if (tip !== this.data.cityTip) this.setData({ cityTip: tip })
  },

  onReady() {
    // 进入发布页先确认登录态：未登录直接拉起全屏登录页，避免填完表单才发现要登录
    this.ensureLogin(LOGIN_REASON).then((user) => {
      if (user) return
      // 用户选择「暂不登录」：没有登录态发布不了，直接退回来源页，别让表单白填
      wx.navigateBack({
        fail: () => wx.reLaunch({ url: '/pages/home/home' }),
      })
    })
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
        // 表单只显示用户点中的地点名；地址与坐标单独存下来（不展示），
        // 前者供城市匹配与地址检索，后者供详情页 / 卡片点地址时调起导航
        const place = parsePickedPlace(res)
        this.setData({
          'form.location': place.location,
          'form.locationAddress': place.address,
          'form.locationLat': place.latitude,
          'form.locationLng': place.longitude,
        })
        this.updateCityTip()
        this.clearError('location')
      },
      fail: () => {
        ui.toast('地图选点不可用，请手动输入集合地点')
      },
    })
  },

  onLocationInput(e) {
    const form = this.data.form
    const value = String(e.detail.value || '').slice(0, LOCATION_MAX)
    const patch = { 'form.location': value }
    // 手输内容已经和上次地图选点无关（例如整个换了个地方）时丢掉旧地址与坐标，
    // 避免城市还按旧地址算、导航还跳到上一个点；只是删掉自动补上的省市前缀仍算同一个地点
    const fromMap = form.locationAddress || form.locationLat || form.locationLng
    const picked = placeNameOf(form.location)
    const related = !!value && (value.indexOf(picked) > -1 || picked.indexOf(value) > -1)
    if (fromMap && !related) {
      patch['form.locationAddress'] = ''
      patch['form.locationLat'] = 0
      patch['form.locationLng'] = 0
    }
    this.setData(patch)
    this.updateCityTip()
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
      // 全程长度 / 累计爬升为非必填：留空跳过，填写了才校验格式
      if (String(form.distance).trim() && !(Number(form.distance) > 0)) {
        errors.distance = '全程长度请填写大于 0 的数字（km），或留空'
      }
      if (String(form.elevationGain).trim() && !(Number(form.elevationGain) > 0)) {
        errors.elevationGain = '累计爬升请填写大于 0 的数字（m），或留空'
      }
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
    // 发布中或已发布（等待跳转详情）时不再响应，避免重复创建
    if (this.data.submitting || this.data.published) return
    this.ensureLogin(LOGIN_REASON).then((user) => {
      if (!user) return
      this.handleLoginSuccess(user)
      this.doSubmit()
    })
  },

  /** 登录态确认后的真正提交：校验 → 上传图片 → 创建活动 */
  doSubmit() {
    if (this.data.submitting || this.data.published) return
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
      // 发布者当前城市：地址里认不出城市时服务端用它兜底归属（省份 / 全国不生效）
      cityHint: getApp().globalData.city || '',
    })
    this.setData({ submitting: true })
    wx.showLoading({ title: this.data.editId ? '提交中' : '发布中', mask: true })
    this.uploadFiles(payload)
      // 编辑模式走 update：服务端会重新置为待审核，驳回意见同时清空
      .then((form) => (this.data.editId ? api.update({ id: this.data.editId, form }) : api.create({ form })))
      .then((activity) => {
        wx.hideLoading()
        // 保持按钮锁定，直到自动跳转到新活动详情页
        this.setData({ published: true })
        ui.toast('已提交审核', 'success')
        setTimeout(() => {
          const url = `/pages/activity/detail/index?id=${activity.id}`
          wx.redirectTo({
            url,
            fail: () => {
              // 极端情况下（例如页面栈异常）退化为普通跳转
              wx.navigateTo({ url })
            },
          })
        }, 1000)
      })
      .catch((err) => {
        wx.hideLoading()
        this.setData({ submitting: false })
        // 服务端登录态失效（例如本地缓存与云环境不一致）：清掉本地登录态并拉起登录页，登录后继续发布
        if (err && err.code === 'UNAUTHORIZED') {
          const app = getApp()
          if (app && app.applyUser) app.applyUser(null)
          else if (app) app.setUser(null)
          ui.toast('登录已过期，请重新登录')
          this.openLoginModal(LOGIN_REASON).then((user) => {
            if (!user) return
            this.handleLoginSuccess(user)
            this.doSubmit()
          })
          return
        }
        // 内容安全拦截：明确告诉用户是内容问题而不是网络问题，留在表单页改完重发
        if (err && err.code === 'CONTENT_RISKY') {
          ui.confirm({
            title: '内容未通过安全检测',
            content: '活动标题、集合地点或活动介绍里包含平台不允许的内容，请修改后重新提交。',
            showCancel: false,
            confirmText: '去修改',
          })
          return
        }
        ui.toast((err && err.message) || '发布失败，请重试')
      })
  },

  /**
   * 云模式：封面 / 群二维码此时还是本机临时路径，先上传到云存储换成 fileID 再提交
   * Mock 模式直接透传，保持本地流程不变
   */
  uploadFiles(payload) {
    if (config.useMock) return Promise.resolve(payload)
    const upload = (path, name) => {
      const source = String(path || '')
      // 没选图、已经是云存储文件、或本来就是 https 远程图，直接返回
      // 注意：chooseMedia 选出来的本机临时路径是 http://tmp/xxx 这种形式，
      // 不能按 http 前缀放过，否则落库的是本机路径，别人打开活动只能看到空白封面
      if (!source || source.indexOf('cloud://') === 0 || source.indexOf('https://') === 0) {
        return Promise.resolve(source)
      }
      const ext = (source.match(/\.([a-zA-Z0-9]+)$/) || [])[1] || 'png'
      return new Promise((resolve, reject) => {
        wx.cloud.uploadFile({
          cloudPath: `activity/${name}/${Date.now()}-${Math.floor(Math.random() * 100000)}.${ext}`,
          filePath: source,
          success: (res) => resolve(res.fileID),
          fail: () => reject(new Error('图片上传失败，请检查网络后重试')),
        })
      })
    }
    return Promise.all([upload(payload.cover, 'cover'), upload(payload.groupQrCode, 'qrcode')]).then(
      (res) => Object.assign({}, payload, { cover: res[0], groupQrCode: res[1] })
    )
  },

  onLogin(e) {
    this.handleLoginSuccess(e.detail)
  },
})
