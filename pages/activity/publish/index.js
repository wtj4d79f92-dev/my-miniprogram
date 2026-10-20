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
// 标题 → 线路强度：命中词库（官方线路表）或用户沉淀的中心词后自动填难度、全程长度、累计爬升
const { matchLine, matchStat } = require('../../../utils/line-match')
const { LINE_LIBRARY, LINE_LIBRARY_VERSION } = require('../../../utils/lines')
const { parseQrFields, stripGroupName, stripQrHints } = require('../../../utils/qr-text')
const { KEYS, getStorage, setStorage } = require('../../../utils/storage')

const LOGIN_REASON = '发布活动需要先登录，是否立即登录？'
/** 标题输入的防抖时长：边打字边匹配，等手停下来再算，避免每个字都跑一遍词库 */
const LINE_MATCH_DELAY = 400
/** 提交时最多等 OCR 这么久：识别慢不能拖着发布按钮一直转圈 */
const QR_OCR_WAIT = 2500

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * 上传单张图片到云存储。
 * 没选图、已经是云存储文件、或本来就是 https 远程图时直接返回原值。
 * 注意：chooseMedia 选出来的本机临时路径是 http://tmp/xxx 这种形式，
 * 不能按 http 前缀放过，否则落库的是本机路径，别人打开活动只能看到空白图。
 */
function uploadImage(path, name) {
  const source = String(path || '')
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

Page({
  behaviors: [loginBehavior],

  data: {
    typeGrid: TYPE_GRID,
    // 类型图标按格子下标记失败状态：data URI 正常不会失败，留一手兜底，格子不至于空着
    iconErrorMap: {},
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
      // 费用方式必须由发起人主动选择：'aa' / 'nonAA'（空串 = 尚未选择）
      feeMode: '',
      // 非 AA 制只填一段文字说明，平台不收取任何资金，因此不收集金额
      feeNote: '',
      maxPeople: 10,
      groupQrCode: '',
      desc: '',
    },
  },

  onLoad(options) {
    const app = getApp()
    const today = startOfDay(Date.now())
    const startTime = addDays(today, 1)
    // 新建活动默认当天往返；返程时间被用户主动修改前，继续跟随集合日期
    const endTime = startTime
    const editId = (options && options.id) || ''
    // 用户是否自己改过这些字段：OCR 只填没被用户动过的，重传二维码时可更新上一次 OCR 的值；
    // 编辑已有活动时一律按「已改过」处理，不让截图改掉原活动的标题 / 日期
    this._titleTouched = !!editId
    this._titleFromOcr = false
    this._startTouched = !!editId
    this._endTouched = !!editId
    this._qrNeedsLogin = false
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
    this.loadLineSources(!!editId)
  },

  /**
   * 强度数据源，两路：
   *   1. 官方线路词库 —— 先用本地缓存 / 内置词库（同步就有，输入标题不用等网络），
   *      再异步拉一次云端 lines 集合覆盖；后台维护过词库后，下次进发布页拿到的就是最新数据；
   *   2. 用户沉淀 —— 别人发布同一地点时填过的星级 / 全程 / 爬升，同样先吃缓存再拉云端。
   * 编辑模式带进来的是原活动的强度指标，不允许被标题匹配覆盖，所以直接标记成「用户填过」，
   * 同时连沉淀数据也不拉了：这一趟根本不会用到它。
   */
  loadLineSources(locked) {
    // 缓存带上内置词库的版本号：小程序更新后词库变了，老缓存直接作废
    const cached = getStorage(KEYS.lineLib, null)
    const usable = cached && cached.version === LINE_LIBRARY_VERSION && cached.list && cached.list.length
    this._library = usable ? cached.list : LINE_LIBRARY
    // 编辑已有活动时不参与自动填充：原活动的强度指标是用户自己填的，不能被标题匹配改掉
    this._lineLocked = !!locked
    this._metricTouched = { difficulty: !!locked, distance: !!locked, elevation: !!locked }
    // OCR 填的强度字段也算「已定值」，但不等于用户手填：下一张二维码可以覆盖它
    this._metricByUser = { difficulty: !!locked, distance: !!locked, elevation: !!locked }
    // 用户沉淀：本地只是一份快照，云端 line_stats 集合才是权威数据，所以下面还要拉一次
    const cachedStats = getStorage(KEYS.lineStats, null)
    this._stats = Array.isArray(cachedStats) ? cachedStats : []
    api
      .lines()
      .then((list) => {
        if (!list || !list.length) return
        this._library = list
        setStorage(KEYS.lineLib, { version: LINE_LIBRARY_VERSION, list })
      })
      .catch(() => {})
    if (locked) return
    api
      .lineStats()
      .then((list) => {
        // 云端明确回空列表（还没人沉淀）时也要覆盖本地快照：别人清过的数据不该继续用；
        // 回 null 表示这一次没拿到（网络异常），那就先用手上的缓存，别把它抹掉
        if (!Array.isArray(list)) return
        this._stats = list
        setStorage(KEYS.lineStats, this._stats)
      })
      .catch(() => {})
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
        // 发起人身份只认服务端算好的 isOrganizer：云函数下发的成员 / 发起人快照按隐私要求
        // 抹掉了 openid，用 raw.organizer.openid 比对会让任何用户都进不来（编辑、驳回重提全废）。
        // Mock 模式返回的是带 openid 的本地数据，保留本地兜底判断。
        const isOrganizer =
          typeof raw.isOrganizer === 'boolean'
            ? raw.isOrganizer
            : !!user && !!raw.organizer && raw.organizer.openid === user.openid
        if (!isOrganizer) {
          ui.toast('仅发起人可修改活动')
          wx.navigateBack({ fail: () => wx.reLaunch({ url: '/pages/home/home' }) })
          return
        }
        // 展示期届满的活动已自动关闭，服务端 update 同样会拒绝，这里提前拦住，别让用户白填一遍表单
        if (raw.expired) {
          ui.toast('活动发布已超过 7 天，已自动关闭，无法修改')
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
        // 编辑已有活动：三项强度指标都是用户原先填过的值，标题匹配不再覆盖它们
        this._metricTouched = { difficulty: true, distance: true, elevation: true }
        // 编辑模式同样不拿二维码截图去改标题 / 集合时间 / 返程时间
        this._titleTouched = true
        this._titleFromOcr = false
        this._startTouched = true
        this._endTouched = true
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
            // 历史数据：feeMode 'fixed' + 数字 fee 视为非 AA 制，数字折成一句费用说明
            feeMode: raw.feeMode === 'nonAA' || raw.feeMode === 'fixed' ? 'nonAA' : 'aa',
            feeNote:
              raw.feeNote || (raw.fee ? `人均约 ${raw.fee} 元，现场自行分摊` : ''),
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

  /** 类型图标解码失败：这一格退回 emoji，其余格子不受影响 */
  onTypeIconError(e) {
    const index = e.currentTarget.dataset.index
    if (index === undefined || this.data.iconErrorMap[index]) return
    this.setData({ [`iconErrorMap[${index}]`]: true })
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
    // 切回徒步 / 爬山时，按标题重新匹配一次（自驾游等类型不填也不提示）
    if (supportsMetrics(type)) this.applyLineMatch(this.data.form.title)
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
    const title = String(e.detail.value || '').slice(0, 30)
    this._titleTouched = true
    this._titleFromOcr = false
    this.setData({ 'form.title': title })
    this.clearError('title')
    this.scheduleLineMatch(title)
  },

  /** 输入结束（失焦）时立刻算一次，不等防抖：用户填完标题就去动别的字段了 */
  onTitleBlur(e) {
    this.cancelLineMatch()
    this.applyLineMatch(String((e.detail && e.detail.value) || this.data.form.title || ''))
  },

  /* -------------------- 标题 → 线路词库自动填充 -------------------- */

  scheduleLineMatch(title) {
    this.cancelLineMatch()
    this._lineTimer = setTimeout(() => {
      this._lineTimer = null
      this.applyLineMatch(title)
    }, LINE_MATCH_DELAY)
  },

  cancelLineMatch() {
    if (!this._lineTimer) return
    clearTimeout(this._lineTimer)
    this._lineTimer = null
  },

  /**
   * 按标题里的地名 / 中心词匹配线路，命中就把难度（星级）、全程长度、累计爬升填上。
   *
   * 先查官方词库，词库没命中再看用户沉淀的数据（别人发布同一地点时填过的值）：
   * 词库是校对过的权威数据，沉淀是用户填的，两者口径不一致时以词库为准。
   *
   * 只填用户没自己动过的字段：填过标题又觉得匹配得不合适、手动改过某一项，
   * 之后无论标题怎么变都不会再把那一项改回去。类型不支持强度指标（自驾游等）时不填也不提示，
   * 切回徒步 / 爬山会按记下的这条匹配重新填一次。
   *
   * 匹配结果只写进表单字段，不在页面上额外提示匹配到了哪条线路：强度指标本身就是给用户确认用的，
   * 再挂一条提示反而在表单里多出一块和发布流程无关的文字。
   */
  applyLineMatch(title) {
    if (this._lineLocked) return
    const match = matchLine(title, this._library) || matchStat(title, this._stats)
    if (!match) {
      this.resetAutoMetrics()
      return
    }
    if (!this.data.showMetrics) return
    const touched = this._metricTouched || {}
    const patch = {}
    if (!touched.difficulty && match.stars > 0) {
      const index = Math.min(Math.max(match.stars - 1, 0), DIFFICULTY_OPTIONS.length - 1)
      const option = DIFFICULTY_OPTIONS[index]
      patch.difficultyIndex = index
      patch.difficultyLabel = option.label
      patch['form.difficulty'] = option.value
    }
    if (!touched.distance) {
      // 词库里这四项都是完整的；万一库里混进脏数据（0 / 空），留空也不填 0
      patch['form.distance'] = match.distance > 0 ? String(match.distance) : ''
      patch['errors.distance'] = ''
    }
    if (!touched.elevation) {
      patch['form.elevationGain'] = match.elevation > 0 ? String(match.elevation) : ''
      patch['errors.elevationGain'] = ''
    }
    // 三项都被用户改过时 patch 是空的，不用白跑一次 setData
    if (Object.keys(patch).length) this.setData(patch)
  },

  /** 标题不再命中任何线路：把上一次自动填进去的值收回去（用户手动改过的不动） */
  resetAutoMetrics() {
    const touched = this._metricTouched || {}
    const patch = {}
    if (!touched.difficulty) {
      patch.difficultyIndex = 2
      patch.difficultyLabel = DIFFICULTY_OPTIONS[2].label
      patch['form.difficulty'] = DIFFICULTY_OPTIONS[2].value
    }
    if (!touched.distance) patch['form.distance'] = ''
    if (!touched.elevation) patch['form.elevationGain'] = ''
    this.setData(patch)
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
      this._startTouched = true
      // 用户尚未单独选择返程日期时默认当天往返；已单独选择时只保证不早于集合时间
      const endTime = this._endTouched && form.endTime && form.endTime >= timestamp ? form.endTime : timestamp
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
    this._endTouched = true
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
    if (this._metricTouched) this._metricTouched.difficulty = true
    if (this._metricByUser) this._metricByUser.difficulty = true
    this.setData({
      difficultyIndex: index,
      difficultyLabel: option.label,
      'form.difficulty': option.value,
    })
  },

  onDistanceInput(e) {
    if (this._metricTouched) this._metricTouched.distance = true
    if (this._metricByUser) this._metricByUser.distance = true
    this.setData({ 'form.distance': e.detail.value })
    this.clearError('distance')
  },

  onElevationInput(e) {
    if (this._metricTouched) this._metricTouched.elevation = true
    if (this._metricByUser) this._metricByUser.elevation = true
    this.setData({ 'form.elevationGain': e.detail.value })
    this.clearError('elevationGain')
  },

  setFeeMode(e) {
    const mode = e.currentTarget.dataset.mode
    this.setData({ 'form.feeMode': mode })
    if (mode === 'aa') this.clearError('fee')
    else if (this.data.form.feeNote) this.clearError('fee')
  },

  onFeeNoteInput(e) {
    this.setData({ 'form.feeNote': e.detail.value })
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
        if (!file) return
        const path = file.tempFilePath
        // 换图时把上一张还没提交的草稿删掉，避免云存储里越堆越多
        this.discardQrDraft()
        this._qrNeedsLogin = false
        this.setData({ 'form.groupQrCode': path })
        this.clearError('groupQrCode')
        this.readQrText(path)
      },
    })
  },

  removeGroupQr() {
    ui.confirm({ title: '删除二维码', content: '确定删除已上传的活动二维码吗？' }).then((ok) => {
      if (!ok) return
      this.discardQrDraft()
      // 让还在路上的识别结果作废，别把已删除二维码的文字填进介绍
      this._qrSeq = (this._qrSeq || 0) + 1
      this._qrNeedsLogin = false
      this.setData({ 'form.groupQrCode': '' })
    })
  },

  /**
   * 选好二维码后：登录 → 上传临时文件 → 云函数 OCR → 回填活动介绍。
   * 二维码图片本来要等到提交才上传；这里先传一份草稿，提交时直接复用同一个 fileID，
   * 不会重复上传，也不会因为 OCR 失败让用户发不出去。
   */
  readQrText(path) {
    const seq = (this._qrSeq = (this._qrSeq || 0) + 1)
    const draft = { path, fileID: '', used: false, task: null }
    this._qrDraft = draft
    draft.task = this.whenUserReady()
      .then(() => {
        if (seq !== this._qrSeq) return null
        if (!this.currentUser()) {
          // 登录后再补跑；选图这一步不打断用户，也不展示任何状态
          this._qrNeedsLogin = true
          return null
        }
        const file = config.useMock ? Promise.resolve(path) : uploadImage(path, 'qrcode-draft')
        return file
          .then((fileID) => {
            // 上传过程中换了图 / 删了图 / 离开页面：这份草稿已经没人引用，顺手删掉
            if (seq !== this._qrSeq || draft !== this._qrDraft) {
              if (!config.useMock && fileID && wx.cloud && wx.cloud.deleteFile) {
                wx.cloud.deleteFile({ fileList: [fileID], fail: () => {} })
              }
              return ''
            }
            draft.fileID = fileID
            return fileID
          })
          .then((fileID) => (fileID ? api.ocrQr(fileID) : null))
      })
      .then((res) => {
        if (!res || seq !== this._qrSeq || this._unloaded) return
        this.applyQrOcr(res)
      })
      .catch(() => {
        // 识别失败静默处理：保留手写入口，不向用户展示失败状态
      })
  },

  /**
   * 从 OCR 文本里解析标题 / 集合时间 / 全程 / 爬升并回填。
   * 只填用户没手动改过的字段；截图里明确写的距离 / 爬升优先于线路词库。
   */
  applyQrFields(parsed) {
    const data = parsed || {}
    const form = this.data.form
    const patch = {}
    const filled = []
    let titleForMatch = ''

    // 标题：空标题直接填；上一次是 OCR 填的、用户没改过时，换图可以更新
    const currentTitle = String(form.title || '').trim()
    const canTitle = !currentTitle || (this._titleFromOcr && !this._titleTouched)
    if (data.title && canTitle) {
      const title = String(data.title).slice(0, 30)
      if (title !== currentTitle) {
        this.cancelLineMatch()
        patch['form.title'] = title
        patch['errors.title'] = ''
        filled.push(`标题「${title}」`)
      }
      this._titleFromOcr = true
      titleForMatch = title
    }

    // 集合时间：用户自己点过日历后保留用户的选择
    if (data.startTime && !this._startTouched) {
      const startTime = Number(data.startTime)
      if (startTime && startTime !== form.startTime) {
        patch['form.startTime'] = startTime
        patch.startLabel = formatCardDate(startTime)
        patch['errors.startTime'] = ''
        if (!this._endTouched) {
          patch['form.endTime'] = startTime
          patch.endLabel = formatCardDate(startTime)
          patch['errors.endTime'] = ''
        }
        const clock = data.clockText ? ` ${data.clockText}` : ''
        filled.push(`集合时间 ${formatCardDate(startTime)}${clock}`)
      }
    }

    // 强度字段：截图里写明的值优先；标成已定值后，线路词库不会再改它
    const metricPatch = {}
    if (this.data.showMetrics) {
      const byUser = this._metricByUser || {}
      if (data.distance > 0 && !byUser.distance) {
        const value = String(data.distance)
        if (String(form.distance || '') !== value) {
          metricPatch['form.distance'] = value
          metricPatch['errors.distance'] = ''
          filled.push(`全程 ${value}km`)
        }
        if (this._metricTouched) this._metricTouched.distance = true
      }
      if (data.elevation > 0 && !byUser.elevation) {
        const value = String(data.elevation)
        if (String(form.elevationGain || '') !== value) {
          metricPatch['form.elevationGain'] = value
          metricPatch['errors.elevationGain'] = ''
          filled.push(`爬升 ${value}m`)
        }
        if (this._metricTouched) this._metricTouched.elevation = true
      }
    }

    // 标题补上后再按词库 / 历史沉淀补剩下的强度字段；截图明确写出的值已经保护起来
    if (titleForMatch) this.applyLineMatch(titleForMatch)
    if (Object.keys(patch).length || Object.keys(metricPatch).length) {
      this.setData(Object.assign(patch, metricPatch))
    }

    return { filled }
  },

  /**
   * OCR 结果落到表单：全程静默。
   * 只填空标题 / 未被用户改过的日期与强度；介绍为空时自动带入，已有内容时保持原样。
   */
  applyQrOcr(res) {
    const raw = String((res && res.text) || '').trim()
    if (!raw) return
    // 字段解析用完整 OCR 原文，活动介绍本身仍按 500 字上限截断
    const parsed = parseQrFields(raw, Date.now())
    this.applyQrFields(parsed)
    const current = String(this.data.form.desc || '').trim()
    // 已经自动填过的介绍里如果残留二维码有效期 / 群名，也一并清掉
    const cleanedCurrent = stripGroupName(stripQrHints(current), parsed.groupName).trim()
    if (!cleanedCurrent) {
      // 群聊名称只用于标题解析，不写进活动介绍
      const text = stripGroupName(stripQrHints(raw), parsed.groupName).slice(0, 500)
      if (text) this.setData({ 'form.desc': text, descCount: text.length })
      return
    }
    if (cleanedCurrent !== current) {
      this.setData({ 'form.desc': cleanedCurrent, descCount: cleanedCurrent.length })
    }
  },

  /** 删除还没提交的二维码草稿；已经提交引用的文件不能删 */
  discardQrDraft() {
    const draft = this._qrDraft
    this._qrDraft = null
    if (!draft || !draft.fileID || draft.used || config.useMock) return
    if (!wx.cloud || typeof wx.cloud.deleteFile !== 'function') return
    wx.cloud.deleteFile({ fileList: [draft.fileID], fail: () => {} })
  },

  onDescInput(e) {
    const value = String(e.detail.value || '').slice(0, 500)
    this.setData({ 'form.desc': value, descCount: value.length })
  },

  /** 登录成功：如果选图时还没登录，这里补跑一次文字识别 */
  onUserChanged() {
    if (!this._qrNeedsLogin) return
    const path = this.data.form.groupQrCode
    if (!path) return
    this._qrNeedsLogin = false
    this.readQrText(path)
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
    // 费用方式必选；非 AA 制只要求一段文字说明，平台不收取也不代收任何资金
    if (!form.feeMode) errors.fee = '请选择费用方式（AA 制 / 非 AA 制）'
    else if (form.feeMode === 'nonAA' && !String(form.feeNote || '').trim()) {
      errors.fee = '非 AA 制请填写费用说明，例如「门票自理」「人均约 80 元现场分摊」'
    }
    // 活动二维码选填：不传也能发布，审核通过的活动在小程序内就能看全信息、报名、看同行成员
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
    // 活动二维码非必传，但没传时代码里参与人看不到联系方式，发布前提醒一次
    // 仅起提示作用：用户点「取消」可以回去补传，点「继续发布」照常提交
    if (!String(this.data.form.groupQrCode || '').trim()) {
      ui.confirm({
        title: '提示',
        content: '还没有上传联系方式（活动二维码），请上传联系方式，避免参与人无法及时与你联系。仍要继续发布吗？',
        cancelText: '取消',
        confirmText: '继续发布',
      }).then((ok) => {
        if (ok) this.publishActivity()
      })
      return
    }
    this.publishActivity()
  },

  /** 校验与联系方式提醒之后的真正提交：组装 payload → 上传图片 → 创建 / 更新活动 */
  publishActivity() {
    if (this.data.submitting || this.data.published) return
    const form = this.data.form
    const payload = Object.assign({}, form, {
      distance: Number(form.distance) || 0,
      elevationGain: Number(form.elevationGain) || 0,
      feeNote: form.feeMode === 'nonAA' ? String(form.feeNote || '').trim() : '',
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
        // 活动二维码不是微信群邀请码也不是个人微信二维码：活动已被驳回，
        // 详情页会写明「未通过原因」与重新提交入口，
        // 这里只提前说一句，用户不用等跳到详情页才发现
        const rejected = String(activity && activity.auditStatus) === 'rejected'
        ui.toast(rejected ? '二维码未识别，活动未通过审核' : '已提交审核', rejected ? 'none' : 'success')
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
   * 云模式：封面 / 活动二维码此时还是本机临时路径，先上传到云存储换成 fileID 再提交
   * Mock 模式直接透传，保持本地流程不变
   */
  uploadFiles(payload) {
    // 提交时 OCR 可能还在跑：最多等一小会儿，让「识别后自动填介绍」赶在落库前生效；
    // 超时就按当前表单提交，识别晚到也不影响发布
    const draft = this._qrDraft
    const pending =
      draft && draft.path === payload.groupQrCode && draft.task
        ? Promise.race([draft.task.catch(() => {}), delay(QR_OCR_WAIT)])
        : Promise.resolve()
    return pending.then(() => {
      // 等待期间 OCR 可能刚把文字填进介绍，所以 payload 里的 desc 取提交这一刻的值
      const live = this.data && this.data.form
      const form = Object.assign({}, payload)
      if (live && live.desc !== undefined) form.desc = String(live.desc || '')
      if (config.useMock) return form
      const latest = this._qrDraft
      const reusable =
        latest && latest.path === form.groupQrCode && latest.fileID ? latest.fileID : ''
      const qrUpload = reusable
        ? Promise.resolve(reusable)
        : uploadImage(form.groupQrCode, 'qrcode')
      return Promise.all([uploadImage(form.cover, 'cover'), qrUpload]).then((res) => {
        if (reusable && latest) latest.used = true
        return Object.assign({}, form, { cover: res[0], groupQrCode: res[1] })
      })
    })
  },

  onLogin(e) {
    this.handleLoginSuccess(e.detail)
  },

  /** 页面退出时清掉标题匹配的防抖定时器与未提交的二维码草稿 */
  onUnload() {
    this._unloaded = true
    this.cancelLineMatch()
    this.discardQrDraft()
  },
})
