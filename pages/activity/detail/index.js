const api = require('../../../services/api')
const { TEXTS } = require('../../../utils/dict')
const { formatCardDate } = require('../../../utils/util')
const loginBehavior = require('../../../behaviors/login-behavior')
const ui = require('../../../utils/ui')
const location = require('../../../utils/location')
const scene = require('../../../utils/scene')

/** 举报原因候选：与云端 activity 云函数的 REPORT_REASONS 保持一致 */
const REPORT_REASONS = ['虚假信息或诈骗', '违法违规内容', '侵权或盗用他人内容', '广告骚扰', '其他']

/**
 * 朋友圈单页模式的判定与启动参数都在 utils/scene.js（首页分享同样要用），
 * 这里的注释「页面没有登录态、跳转/分享/报名被禁用、云资源要开未登录访问」保持同一份口径。
 */
const launchEntry = scene.launchEntry
const isSinglePageMode = scene.isSinglePageMode

/**
 * 活动 id 的来源：
 * - 分享卡片 / 页面跳转带的是 query，即 options.id；
 * - 扫小程序码（海报上那张）进来时，云端把活动 id 写在 scene 里并且做了 URL 编码，
 *   只能从 options.scene 取。漏了这条，扫码打开的永远是「活动不存在或已下架」。
 * - 朋友圈单页模式下微信可能不下发 onLoad 参数，此时用启动参数里的 query 兜底，
 *   别让参数缺失被显示成「活动不存在」。
 * 另外 options.scene 同时也是「启动场景值」（如单页模式是 1154），场景值是纯数字，
 * 不能当成活动 id 去查，否则朋友圈分享页会稳定落到兜底态。
 */
function resolveActivityId(options) {
  const opts = options || {}
  if (opts.id) return String(opts.id)
  const entry = launchEntry()
  const entryQuery = entry.query || {}
  if (isSinglePageMode() && entryQuery.id) return String(entryQuery.id)
  const raw = opts.scene === undefined || opts.scene === null || opts.scene === '' ? entryQuery.scene : opts.scene
  const scene = raw === undefined || raw === null ? '' : String(raw)
  if (!scene) return ''
  if (scene === String(entry.scene || '')) return ''
  try {
    return decodeURIComponent(scene)
  } catch (e) {
    return scene
  }
}

Page({
  behaviors: [loginBehavior],

  data: {
    id: '',
    activity: null,
    // 默认封面（无封面图时展示）的文案，与 utils/dict.js 同一份来源
    poster: {
      title: TEXTS.defaultPosterTitle,
      sub: TEXTS.defaultPosterSubtitle,
    },
    loading: true,
    notFound: false,
    // 接口 / 权限失败（例如云开发没开「允许未登录访问」）与「活动不存在」是两回事：
    // 前者要能重试，不能谎报成「已下架」
    loadError: '',
    // 朋友圈单页模式：页面无登录态，报名 / 分享 / 跳转都被微信禁用，只做内容展示
    singlePage: false,
    agreed: false,
    user: null,
    showSharePanel: false,
    showQrModal: false,
    // 二维码弹窗文案随入口变化：报名成功时是结果提示，已报名用户主动查看时只是查群入口
    qrFromJoin: false,
    qrTitle: '报名成功，扫码加入活动群',
    qrPlaceholder: false,
    statusText: '招募中',
    isOrganizer: false,
    mainBtn: { text: '我要报名', disabled: false, mode: 'join', style: '' },
  },

  onLoad(options) {
    const id = resolveActivityId(options)
    const app = getApp()
    this.setData({ id, singlePage: isSinglePageMode(), user: app.globalData.user })
    this.loadDetail()
  },

  onShow() {
    const app = getApp()
    this.setData({ user: app.globalData.user })
  },

  loadDetail() {
    this.setData({ loading: true, loadError: '' })
    return api
      .detail(this.data.id)
      .then((activity) => {
        if (!activity) {
          ui.setPageTitle('活动详情 · 旷行吖')
          this.setData({ notFound: true, loading: false, activity: null })
          return null
        }
        this.applyActivity(activity)
        return null
      })
      .catch((err) => {
        // 以前这里直接置 notFound，等于把「接口失败」说成「活动已下架」：
        // 朋友圈单页模式没有登录态、云开发又没开未登录访问时，一切正常活动都会显示成不存在
        console.warn('[activity-detail] 活动详情加载失败', err)
        this.setData({
          loading: false,
          notFound: false,
          loadError: this.data.singlePage
            ? '朋友圈内暂时无法加载该活动，请稍后重试'
            : (err && err.message) || '加载失败，请稍后重试',
        })
      })
  },

  /** 加载失败后的重试：单页模式下的失败多半是网络抖动或云开发权限没配好，让用户能再试一次 */
  retryLoad() {
    return this.loadDetail()
  },

  applyActivity(raw) {
    const activity = api.decorate(raw)
    // 页面标题用活动名，微信搜索会据此理解这个页面在讲什么（自定义导航栏下用户看不到标题）
    ui.setPageTitle(`${activity.title} · 旷行吖`)
    activity.startLabel = formatCardDate(activity.startTime)
    activity.endLabel = activity.endTime ? formatCardDate(activity.endTime) : '待定'
    activity.coverGradient = activity.bg
    // 封面 / 群二维码是发起人上传的云存储文件，客户端直连 cloud:// 可能被存储权限拦下，
    // 云函数已换好 https 临时链接（coverUrl / qrUrl），这里优先用它渲染
    // 报名 / 退出 / 关闭活动等动作的返回体没有带临时链接，缓存住已经换到的地址复用，避免封面闪回占位图
    this._mediaUrl = this._mediaUrl || {}
    if (activity.coverUrl) this._mediaUrl[activity.cover] = activity.coverUrl
    if (activity.qrUrl) this._mediaUrl[activity.groupQrCode] = activity.qrUrl
    activity.coverSrc = activity.coverUrl || this._mediaUrl[activity.cover] || activity.cover
    activity.qrSrc = activity.qrUrl || this._mediaUrl[activity.groupQrCode] || activity.groupQrCode
    // 云端下发的成员快照只留昵称 / 头像（不带 openid），列表 key 用下标生成
    activity.joinedPeople = raw.joinedPeople || []
    activity.avatarList = activity.joinedPeople.map((member, index) =>
      Object.assign({}, member, { key: `member_${index}` })
    )
    // 展示期届满的活动由服务端标记 expired，对外一律按已关闭处理
    activity.isClosed = raw.status === 'closed' || !!activity.expired
    activity.isFull = raw.joinedCount >= raw.maxPeople
    activity.descText = raw.desc || '暂无活动介绍，报名前可与发起人沟通确认细节。'

    let statusText = '招募中'
    if (activity.expired) {
      statusText = '已到期'
    } else if (activity.isClosed) {
      statusText = '已关闭'
    } else if (activity.isFull) {
      statusText = '已满'
    }
    // 未过审的活动只有发起人看得到，状态位直接展示审核结果
    if (!activity.auditApproved && !activity.expired) statusText = activity.auditText

    // 登录后 globalData 已同步，优先取最新登录态
    const app = getApp()
    const user = (app && app.globalData.user) || this.data.user
    const myOpenid = (user && user.openid) || ''
    const organizer = raw.organizer || {}
    // 自己发布的活动：用「关闭 / 打开活动」替代报名按钮，且不展示报名协议
    // 云端已经按当前用户算好这两个标记（脱敏后客户端拿不到 openid，没法自己比对）；
    // Mock 模式返回的是带 openid 的本地数据，保留本地兜底判断
    const isOrganizer =
      typeof raw.isOrganizer === 'boolean' ? raw.isOrganizer : !!myOpenid && organizer.openid === myOpenid
    const joined =
      typeof raw.joined === 'boolean'
        ? raw.joined
        : !!myOpenid && (raw.joinedPeople || []).some((item) => item.openid === myOpenid)
    // style 为空使用主色按钮，outline / manage 为次要按钮样式
    let mainBtn = { text: '我要报名', disabled: false, mode: 'join', style: '' }
    if (this.data.singlePage) {
      // 单页模式没有登录态，登录页、报名、跳转都会被微信拦下（点了才弹「请前往小程序使用完整服务」），
      // 所以按钮只说明情况，不再引导点击
      mainBtn = { text: '浏览模式不可报名', disabled: true, mode: 'singlepage', style: 'manage' }
    } else if (activity.expired) {
      // 展示期届满（发布满 7 天）：已自动关闭，谁都不能再报名，发起人也不能重开或重提
      mainBtn = { text: '活动已到期', disabled: true, mode: 'expired', style: 'manage' }
    } else if (isOrganizer) {
      if (activity.auditPending) {
        mainBtn = { text: '审核中，暂不可操作', disabled: true, mode: 'audit', style: 'manage' }
      } else if (activity.auditRejected) {
        mainBtn = { text: '修改后重新提交', disabled: false, mode: 'edit', style: '' }
      } else {
        mainBtn = activity.isClosed
          ? { text: '重新打开活动', disabled: false, mode: 'toggle', style: '' }
          : { text: '关闭活动', disabled: false, mode: 'toggle', style: 'manage' }
      }
    } else if (activity.isClosed) {
      mainBtn = { text: '已关闭', disabled: true, mode: 'closed', style: '' }
    } else if (activity.isFull && !joined) {
      mainBtn = { text: '已满员', disabled: true, mode: 'full', style: '' }
    } else if (joined) {
      mainBtn = { text: '退出活动', disabled: false, mode: 'quit', style: 'outline' }
    }

    this.setData({
      activity,
      statusText,
      isOrganizer,
      mainBtn,
      loading: false,
      notFound: false,
    })
  },

  toggleAgree() {
    this.setData({ agreed: !this.data.agreed })
  },

  /**
   * 点击「地点」：调起微信内置地图，用户在页面里选地图软件（高德 / 百度 / 腾讯 / 苹果地图）
   * 后，坐标与地址一起带过去直接开始导航。
   * 老活动只有地址文本没有坐标，交给 openNavigation 按地址解析（缺省市的短地址会补上城市再解析），
   * 仍解析不出来就引导用户在地图上点一次，选中后照样直接调起导航。
   */
  onLocationTap() {
    const activity = this.data.activity
    if (!activity || !activity.location) return
    location
      .openNavigation({
        name: activity.location,
        address: activity.locationAddress || activity.location,
        city: activity.city,
        latitude: activity.locationLat,
        longitude: activity.locationLng,
      })
      .then((result) => {
        if (result === 'failed') ui.toast('打开地图失败，请稍后重试')
      })
  },

  openJoinAgreement() {
    const modal = this.selectComponent('#agreement-modal')
    if (modal) modal.open('join')
  },

  onAgreementAgree() {
    this.setData({ agreed: true })
    // 由报名提醒进入协议并点击「同意并继续」时，视为已完成勾选，直接继续报名
    if (!this.pendingJoin) return
    this.pendingJoin = false
    this.submitJoin()
  },

  onAgreementClose() {
    // 协议弹窗未同意关闭后，不再自动延续报名
    this.pendingJoin = false
  },

  onMainTap() {
    const mode = this.data.mainBtn.mode
    if (mode === 'closed' || mode === 'full' || mode === 'audit' || mode === 'expired' || mode === 'singlepage') return
    if (mode === 'edit') {
      // 驳回后回到发布页，表单预填原内容，重新提交审核
      wx.navigateTo({ url: `/pages/activity/publish/index?id=${this.data.id}` })
      return
    }
    if (mode === 'toggle') {
      this.toggleActivity()
      return
    }
    if (mode === 'quit') {
      this.quitActivity()
      return
    }
    this.joinActivity()
  },

  /** 发起人关闭 / 重新打开自己发布的活动 */
  toggleActivity() {
    const activity = this.data.activity
    if (!activity) return
    const isClosed = activity.isClosed
    ui.confirm({
      title: isClosed ? '重新打开活动' : '关闭活动',
      content: isClosed
        ? '确定重新打开该活动，恢复报名吗？'
        : '关闭后，活动仅在广场展示当天，次日起不再展示，其他用户将无法报名。确定关闭吗？',
      confirmText: isClosed ? '重新打开' : '关闭活动',
    }).then((ok) => {
      if (!ok) return
      wx.showLoading({ title: '处理中', mask: true })
      api
        .toggle(this.data.id)
        .then((updated) => {
          wx.hideLoading()
          this.applyActivity(updated)
          ui.toast(updated.status === 'closed' ? '已关闭' : '已打开', 'success')
        })
        .catch((err) => {
          wx.hideLoading()
          ui.toast((err && err.message) || '操作失败，请重试')
          // 活动已到期（展示期届满自动关闭）时，刷新一次拿回服务端的真实状态
          if (err && (err.code === 'FORBIDDEN' || err.code === 'NOT_FOUND' || err.code === 'ACTIVITY_EXPIRED')) {
            this.loadDetail()
          }
        })
    })
  },

  joinActivity() {
    this.ensureLogin('报名活动需要先登录，是否立即登录？').then((user) => {
      if (!user) return
      this.handleLoginSuccess(user)
      if (!this.data.agreed) {
        this.remindAgreement()
        return
      }
      // 已勾选免责协议即视为完成报名确认，直接提交，不再二次弹窗
      this.submitJoin()
    })
  },

  /**
   * 举报活动：UGC 内容需要给用户一个公开的投诉入口。
   * 登录后拉起原因选择，记录与意见反馈同集合（kind: 'report'），由运营复核决定是否下架。
   */
  onReportTap() {
    const activity = this.data.activity
    if (!activity) return
    // 单页模式没有登录态，举报这类需要身份的入口不可用（入口在页面上也已隐藏）
    if (this.data.singlePage) return
    this.ensureLogin('举报活动需要先登录，是否立即登录？').then((user) => {
      if (!user) return
      this.handleLoginSuccess(user)
      wx.showActionSheet({
        itemList: REPORT_REASONS,
        success: (res) => this.submitReport(REPORT_REASONS[res.tapIndex]),
      })
    })
  },

  /** 提交举报：成功只提示「已提交」，是否下架由运营判断，避免被当成下架工具 */
  submitReport(reason) {
    if (!reason) return
    wx.showLoading({ title: '提交中', mask: true })
    api
      .report(this.data.id, reason)
      .then(() => {
        wx.hideLoading()
        ui.toast('举报已提交，我们会尽快核实', 'success')
      })
      .catch((err) => {
        wx.hideLoading()
        ui.toast((err && err.message) || '举报提交失败，请稍后重试')
      })
  },

  /** 封面加载失败：临时链接过期或读取被拦时按 fileID 重取一次，仍失败退回默认海报 */
  onCoverError() {
    this.refreshMedia('cover')
  },

  /** 群二维码加载失败：同上 */
  onQrError() {
    this.refreshMedia('groupQrCode')
  },

  /**
   * 按 fileID 重新换一次临时链接。
   * 临时链接默认 2 小时过期，页面长时间停留后图片会失效，这里做一次兜底刷新。
   */
  refreshMedia(field) {
    const activity = this.data.activity
    if (!activity) return
    const fileID = String(activity[field] || '')
    if (fileID.indexOf('cloud://') !== 0) {
      // 本机临时路径 / https 地址重取也没用，直接退回占位
      if (field === 'cover') this.setData({ activity: Object.assign({}, activity, { coverSrc: '' }) })
      return
    }
    const srcKey = field === 'cover' ? 'coverSrc' : 'qrSrc'
    api
      .media([fileID])
      .then((media) => {
        const current = this.data.activity
        if (!current || current.id !== activity.id) return
        const entry = media && media[fileID]
        this._mediaUrl = this._mediaUrl || {}
        if (entry && entry.url) this._mediaUrl[fileID] = entry.url
        const patch = entry && entry.url ? { [srcKey]: entry.url } : { [srcKey]: '' }
        this.setData({ activity: Object.assign({}, current, patch) })
      })
      .catch(() => {
        const current = this.data.activity
        if (!current || current.id !== activity.id) return
        this.setData({ activity: Object.assign({}, current, { [srcKey]: '' }) })
      })
  },

  /** 未勾选免责协议：弹窗提醒，可直接跳转协议正文 */
  remindAgreement() {
    ui.confirm({
      title: '请先阅读并同意免责协议',
      content: '报名前需勾选《活动风险告知与免责协议》。阅读并同意后将直接完成报名，无需再次确认。',
      confirmText: '去阅读',
      cancelText: '稍后再说',
    }).then((ok) => {
      if (!ok) return
      // 标记本次协议确认来自报名入口，同意后直接继续报名
      this.pendingJoin = true
      this.openJoinAgreement()
    })
  },

  /** 提交报名：成功后有活动群二维码则直接展示 */
  submitJoin() {
    wx.showLoading({ title: '报名中', mask: true })
    api
      .join(this.data.id)
      .then((updated) => {
        wx.hideLoading()
        this.applyActivity(updated)
        if (updated.groupQrCode) {
          this.setData({
            showQrModal: true,
            qrFromJoin: true,
            qrTitle: '报名成功，扫码加入活动群',
            qrPlaceholder: String(updated.groupQrCode).indexOf('mock://') === 0,
          })
        } else {
          ui.toast('报名成功', 'success')
        }
      })
      .catch((err) => {
        wx.hideLoading()
        ui.toast((err && err.message) || '报名失败，请重试')
        // 关闭 / 已到期都刷新一次，把按钮与状态位切到最新
        if (err && (err.code === 'ACTIVITY_CLOSED' || err.code === 'ACTIVITY_EXPIRED')) {
          this.loadDetail()
        }
      })
  },

  quitActivity() {
    ui.confirm({ title: '退出活动', content: '确定要退出本次活动吗？' }).then((ok) => {
      if (!ok) return
      wx.showLoading({ title: '处理中', mask: true })
      api
        .quit(this.data.id)
        .then((updated) => {
          wx.hideLoading()
          this.setData({ agreed: false })
          this.applyActivity(updated)
          ui.toast('已退出', 'success')
        })
        .catch((err) => {
          wx.hideLoading()
          ui.toast((err && err.message) || '退出失败，请重试')
        })
    })
  },

  closeQrModal() {
    const fromJoin = this.data.qrFromJoin
    this.setData({ showQrModal: false, qrFromJoin: false })
    // 只有报名成功那次收起弹窗才提示报名结果，主动查看二维码时不该再提示
    if (fromJoin) ui.toast('报名成功', 'success')
  },

  /** 已报名用户从底部按钮重新查看活动群二维码 */
  openQrModal() {
    const activity = this.data.activity
    if (!activity) return
    if (!activity.groupQrCode) {
      ui.toast('发起人还没有上传活动群二维码')
      return
    }
    this.setData({
      showQrModal: true,
      qrFromJoin: false,
      qrTitle: '扫码加入活动群',
      qrPlaceholder: String(activity.groupQrCode).indexOf('mock://') === 0,
    })
  },

  /* ------------------------------ 分享 ------------------------------ */

  openSharePanel() {
    // 单页模式不支持在小程序页面内发起分享，入口已隐藏，这里只做兜底
    if (this.data.singlePage) return
    this.setData({ showSharePanel: true })
  },

  closeSharePanel() {
    this.setData({ showSharePanel: false })
  },

  /** 分享面板 →「朋友圈」：小程序内无法直接调起朋友圈，仅作引导 */
  onTapShareTimeline() {
    this.setData({ showSharePanel: false })
    ui.tips('朋友圈分享：点击右上角「···」→「分享到朋友圈」')
  },

  onSharePoster() {
    if (this.data.singlePage) return
    this.setData({ showSharePanel: false })
    const modal = this.selectComponent('#poster-modal')
    if (modal) modal.open(this.data.activity)
  },

  onShareAppMessage() {
    const activity = this.data.activity
    if (!activity) {
      return { title: '旷行吖 · 和志同道合的人一起出发', path: '/pages/home/home' }
    }
    return {
      title: `${activity.title}，一起来组队吧！`,
      path: `/pages/activity/detail/index?id=${activity.id}`,
      // 分享卡片只认可访问的图片地址，优先用云函数换好的 https 临时链接
      imageUrl: activity.coverSrc || activity.cover || '',
    }
  },

  /** 页面右上角菜单「分享到朋友圈」的转发内容 */
  onShareTimeline() {
    const activity = this.data.activity
    if (!activity) return { title: '旷行吖 · 和志同道合的人一起出发' }
    return {
      title: `${activity.title}，一起来组队吧！`,
      query: `id=${activity.id}`,
      // 朋友圈卡片的缩略图同样只认可访问的图片地址，优先用云函数换好的 https 临时链接
      imageUrl: activity.coverSrc || activity.cover || '',
    }
  },

  goBack() {
    // 单页模式下微信不允许页面跳转（navigateBack / switchTab 都在禁用列表里）
    if (this.data.singlePage) return
    const pages = getCurrentPages()
    if (pages.length > 1) {
      wx.navigateBack({ delta: 1 })
    } else {
      wx.switchTab({ url: '/pages/square/index' })
    }
  },

  onLogin(e) {
    this.handleLoginSuccess(e.detail)
    this.loadDetail()
  },
})
