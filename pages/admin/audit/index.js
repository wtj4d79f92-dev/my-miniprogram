// 活动审核台（运营侧）：
// 页面入口只对审核人展示，真正的权限判断在 cloudfunctions/admin 里按 openid 校验，
// 所以即使有人手动拼出这个页面路径，也拿不到任何数据、做不了任何审核动作。
const api = require('../../../services/api')
const { formatCardDate } = require('../../../utils/util')
const ui = require('../../../utils/ui')

const PAGE_SIZE = 20

/** 常用驳回原因：点一下填入输入框，可继续修改 */
const REJECT_PRESETS = [
  '活动信息不完整，请补充路线与集合说明',
  '活动介绍含广告或推广内容',
  '活动内容涉嫌违规，请修改后重试',
  '存在安全风险，请补充安全说明',
  '图片或文字不符合社区规范',
  '封面或群二维码已失效，请重新上传',
]

/** 机器初审结论的展示文案 */
const MACHINE_LABEL = {
  pass: '机器通过',
  review: '机器需复核',
  risky: '机器判定违规',
  pending: '图片检测中',
  // 检测接口异常 / 没返回结论：既不是通过也不是违规，一律转人工。
  // 文案必须和「机器通过」区分开，否则运营看到「全绿」却进人工队列会莫名其妙。
  failed: '未出结论（转人工）',
  unknown: '未检测',
}

/**
 * 群二维码识别结论：只有识别出微信群邀请链接才算通过，
 * 识别不出、识别到的不是群链接、接口异常都会转人工，所以审核台要把原因摆出来。
 */
const QR_VERDICT = {
  ok: { label: '微信群邀请码', className: 'pass' },
  'not-qrcode': { label: '未识别到二维码', className: 'review' },
  'not-group': { label: '不是微信群邀请码', className: 'review' },
  failed: { label: '二维码识别失败', className: 'review' },
  unknown: { label: '未识别', className: 'pending' },
}

/**
 * 封面 / 二维码的展示地址分三类，审核台对每一类都要给出能对得上的解释，而不是留一块空白灰块：
 * - https 图片：任何账号都能直接加载；
 * - cloud:// 文件 ID：审核人和发起人往往不是同一个微信号，客户端能否渲染取决于云存储权限设置，
 *   所以优先用 admin 云函数换好的临时链接（响应里的 media 字段），拿不到时退回原始 fileID 让客户端再试一次；
 * - 发起人用 chooseMedia 选出来的本机临时路径（wxfile://、http://tmp/）：换台设备必然加载不出来。
 */
function isHttpsImage(src) {
  const value = String(src || '')
  return value.indexOf('https://') === 0
}

function isCloudFile(src) {
  return String(src || '').indexOf('cloud://') === 0
}

function isStableImage(src) {
  return isHttpsImage(src) || isCloudFile(src)
}

/** 取某个 fileID 的服务端解析结果 { url, ok, reason } */
function mediaOf(media, fileID) {
  const key = String(fileID || '')
  return (key && media && media[key]) || null
}

/** 一个媒体字段（封面 / 二维码）的完整展示态 */
function mediaState(value, media) {
  const fileID = String(value || '')
  const entry = mediaOf(media, fileID)
  return {
    fileID,
    broken: !!fileID && !isStableImage(fileID),
    // 服务端已经明确换不到链接：文件不存在或当前环境读不到
    unreachable: !!fileID && !!entry && !entry.ok,
    reason: (entry && entry.reason) || '',
    // 展示地址：优先临时链接，其次原始 cloud:// / https 地址（客户端可能自己就能读到）
    src: (entry && entry.url) || (isStableImage(fileID) ? fileID : ''),
  }
}

Page({
  data: {
    tabs: [
      { key: 'pending', label: '待审' },
      { key: 'approved', label: '已通过' },
      { key: 'rejected', label: '已驳回' },
      { key: 'all', label: '全部' },
    ],
    status: 'pending',
    keyword: '',
    list: [],
    total: 0,
    hasMore: false,
    pageIndex: 0,
    loading: true,
    refreshing: false,
    loadingMore: false,
    acting: false,
    stats: { pending: 0, approved: 0, rejected: 0, total: 0 },
    // 权限：null 未确认 / true 审核人 / false 无权限
    isAdmin: null,
    myOpenid: '',
    adminName: '',
    // 详情与驳回弹层
    detail: null,
    detailLoading: false,
    showReject: false,
    rejectRemark: '',
    rejectPresets: REJECT_PRESETS,
  },

  onLoad() {
    this.checkAdmin()
  },

  onShow() {
    // 从小程序其他入口切回来时刷新，避免刚提交的活动要手动下拉才出现
    if (this.data.isAdmin) this.loadList(true)
  },

  /** 确认当前用户是不是审核人；不是则整页只展示无权限提示 */
  checkAdmin() {
    api
      .adminWhoami()
      .then((res) => {
        const isAdmin = !!(res && res.isAdmin)
        this.setData({
          isAdmin,
          myOpenid: (res && res.openid) || '',
          adminName: (res && res.name) || '',
          loading: isAdmin,
        })
        if (isAdmin) this.loadList(true)
        return null
      })
      .catch((err) => {
        this.setData({ isAdmin: false, loading: false })
        ui.toast((err && err.message) || '权限校验失败，请重试')
      })
  },

  /** 审核字段在列表里是原始值，这里统一补成可展示的派生字段；media 是云函数换好的临时链接表 */
  decorateItem(raw, media) {
    const item = api.decorate(raw)
    item.auditStatus = raw.auditStatus || 'approved'
    item.statusText = item.auditPending ? '待审核' : item.auditRejected ? '已驳回' : '已通过'
    item.startLabel = raw.startTime ? formatCardDate(raw.startTime) : ''
    item.createLabel = raw.createTime ? formatCardDate(raw.createTime) : ''
    item.auditTimeLabel = raw.auditTime ? formatCardDate(raw.auditTime) : ''
    item.organizerName = (raw.organizer && raw.organizer.nickName) || '未知用户'
    // WXML 表达式不能调方法，审核信息文案在这里先算好
    item.auditMetaText = item.auditTimeLabel
      ? `${item.auditTimeLabel}${raw.auditBy ? ` · ${raw.auditBy}` : ''}`
      : ''

    // 封面 / 二维码：区分「本机图片没同步到云端」「云端文件读不到」「只是这一屏加载失败」三种情况
    const cover = mediaState(raw.cover, media)
    item.coverFileID = cover.fileID
    item.coverSrc = cover.src
    item.coverBroken = cover.broken
    item.coverUnreachable = cover.unreachable
    item.coverFailed = false
    item.coverRetried = false
    item.coverFailText = !cover.fileID
      ? '未上传封面'
      : cover.broken
        ? '封面地址已失效：发起人上传的是本机图片，没有同步到云端，建议驳回让其重新上传'
        : cover.unreachable
          ? `封面在云存储里读不到（${cover.reason || '文件不存在或无权读取'}），建议驳回让其重新上传`
          : '封面加载失败，建议让发起人重新上传'

    const qr = mediaState(raw.groupQrCode, media)
    item.qrFileID = qr.fileID
    item.qrSrc = qr.src
    item.qrBroken = qr.broken
    item.qrUnreachable = qr.unreachable
    item.qrPreview = !!qr.fileID && qr.fileID.indexOf('mock://') !== 0
    item.qrFailed = false
    item.qrRetried = false
    item.qrFailText = !qr.fileID
      ? '未上传或不可预览'
      : qr.broken
        ? '二维码地址已失效：发起人上传的是本机图片，没有同步到云端，建议驳回让其重新上传'
        : qr.unreachable
          ? `二维码在云存储里读不到（${qr.reason || '文件不存在或无权读取'}），建议驳回让其重新上传`
          : '二维码加载失败，建议让发起人重新上传'

    // 机器初审：文本同步出结论，图片要等消息推送回调，可能还是 pending。
    // text.failed = 检测接口没跑通、这次送检没有结论，机审不会放行（转人工），
    // 这里不能显示成「机器通过」——否则机审看着全绿、活动却在待审队列，运营无从下手。
    const machine = raw.machineCheck || null
    const textCheck = (machine && machine.text) || null
    const textFailed = !!(textCheck && textCheck.failed)
    const textSuggest = (textCheck && textCheck.suggest) || 'unknown'
    item.machineTextStatus = textFailed ? 'failed' : textSuggest
    item.machineTextLabel = textFailed
      ? '文本检测失败（转人工）'
      : MACHINE_LABEL[textSuggest] || MACHINE_LABEL.unknown
    item.machineTextFailed = textFailed
    item.machineImages = ((machine && machine.images) || []).map((image) => {
      const suggest = image.suggest || 'pending'
      const entry = mediaOf(media, image.fileID)
      return {
        fileID: image.fileID,
        // 送检缩略图同样是发起人的云存储文件，按服务端换好的地址渲染
        src: (entry && entry.url) || image.fileID,
        className: suggest,
        labelText: MACHINE_LABEL[suggest] || MACHINE_LABEL.unknown,
        message: image.message || '',
      }
    })
    // 图片检测没出结论（不是 pass / review / risky）同样要摆到台面上：这条也是转人工的原因
    item.machineImageFailed = item.machineImages.some((image) => image.className === 'failed')
    // 该送检的云存储图片没送出去（发起送检时接口异常）：结论不完整，机审同样不会放行
    const checkableImages = [raw.cover, raw.groupQrCode].filter(
      (source) => String(source || '').indexOf('cloud://') === 0
    ).length
    item.machineImagesMissing = checkableImages > item.machineImages.length
    item.machineReview = !!raw.machineReview
    item.machinePending = !!raw.machinePending

    // 群二维码识别：识别出的群邀请链接一并带出来，审核人不用长按二维码也能核对
    const qrcode = (machine && machine.qrcode) || null
    const verdict = QR_VERDICT[(qrcode && qrcode.status) || 'unknown'] || QR_VERDICT.unknown
    item.machineQrcodeOk = !!(qrcode && qrcode.ok)
    item.machineQrcodeFailed = !!(qrcode && qrcode.ok === false)
    item.machineQrcodeLabel = verdict.label
    item.machineQrcodeClass = verdict.className
    item.machineQrcodeContent = (qrcode && qrcode.content) || ''
    item.machineQrcodeMessage = (qrcode && qrcode.message) || ''
    return item
  },

  loadList(reset) {
    if (this.data.isAdmin !== true) return Promise.resolve()
    const pageIndex = reset ? 0 : this.data.pageIndex
    if (!reset) this.setData({ loadingMore: true })
    return api
      .adminList({
        status: this.data.status,
        keyword: this.data.keyword,
        pageIndex,
        pageSize: PAGE_SIZE,
      })
      .then((res) => {
        // 云函数已经用管理员身份把 cloud:// 换成了临时链接，审核端直接渲染这些 https 地址
        const media = (res && res.media) || {}
        const rows = ((res && res.list) || []).map((item) => this.decorateItem(item, media))
        this.setData({
          list: reset ? rows : this.data.list.concat(rows),
          total: (res && res.total) || 0,
          hasMore: !!(res && res.hasMore),
          stats: (res && res.stats) || this.data.stats,
          pageIndex: pageIndex + 1,
          loading: false,
          refreshing: false,
          loadingMore: false,
        })
        return null
      })
      .catch((err) => {
        this.setData({ loading: false, refreshing: false, loadingMore: false })
        ui.toast((err && err.message) || '加载失败，请重试')
      })
  },

  switchTab(e) {
    const status = e.currentTarget.dataset.status
    if (!status || status === this.data.status) return
    this.setData({ status, list: [], pageIndex: 0, loading: true })
    this.loadList(true)
  },

  onSearchInput(e) {
    this.setData({ keyword: String(e.detail.value || '') })
  },

  onSearchConfirm() {
    this.setData({ list: [], pageIndex: 0, loading: true })
    this.loadList(true)
  },

  onRefresh() {
    this.setData({ refreshing: true })
    this.loadList(true)
  },

  loadMore() {
    if (!this.data.hasMore || this.data.loadingMore) return
    this.loadList(false)
  },

  goBack() {
    wx.navigateBack({ fail: () => wx.switchTab({ url: '/pages/usercenter/index' }) })
  },

  /* ------------------------------ 图片兜底 ------------------------------ */

  /** 云存储 fileID -> 临时 https 地址（<image> 直连 cloud:// 失败时再试一次）；不支持时返回空串 */
  cloudTempUrl(fileID) {
    const src = String(fileID || '')
    if (src.indexOf('cloud://') !== 0 || !wx.cloud || !wx.cloud.getTempFileURL) {
      return Promise.resolve('')
    }
    return new Promise((resolve) => {
      wx.cloud.getTempFileURL({
        fileList: [src],
        success: (res) => {
          const first = ((res && res.fileList) || [])[0] || {}
          resolve(first.tempFileURL || first.tempFileUrl || first.download_url || '')
        },
        fail: () => resolve(''),
      })
    })
  },

  patchItem(id, patch) {
    this.setData({
      list: this.data.list.map((row) => (row.id === id ? Object.assign({}, row, patch) : row)),
    })
  },

  /** 卡片封面加载失败：再用当前账号换一次临时链接，仍失败退化成类型占位图 */
  onCardImageError(e) {
    const id = (e.currentTarget.dataset || {}).id
    const row = this.findItem(id)
    if (!row) return
    if (row.coverRetried) {
      this.patchItem(id, { coverFailed: true })
      return
    }
    this.patchItem(id, { coverRetried: true })
    this.cloudTempUrl(row.coverFileID).then((url) => {
      if (!this.findItem(id)) return
      this.patchItem(id, url ? { coverSrc: url } : { coverFailed: true })
    })
  },

  /** 弹层封面 / 二维码加载失败：处理方式同上 */
  onDetailImageError(e) {
    const field = (e.currentTarget.dataset || {}).field === 'qr' ? 'qr' : 'cover'
    const detail = this.data.detail
    if (!detail) return
    const fileKey = field === 'qr' ? 'qrFileID' : 'coverFileID'
    const srcKey = field === 'qr' ? 'qrSrc' : 'coverSrc'
    const retriedKey = field === 'qr' ? 'qrRetried' : 'coverRetried'
    const failedKey = field === 'qr' ? 'qrFailed' : 'coverFailed'
    if (detail[retriedKey]) {
      this.setData({ detail: Object.assign({}, detail, { [failedKey]: true }) })
      return
    }
    const patch = { [retriedKey]: true }
    this.setData({ detail: Object.assign({}, detail, patch) })
    this.cloudTempUrl(detail[fileKey]).then((url) => {
      const current = this.data.detail
      if (!current || current.id !== detail.id) return
      const next = url ? { [srcKey]: url } : { [failedKey]: true }
      this.setData({ detail: Object.assign({}, current, next) })
    })
  },

  /* ------------------------------ 详情与审核 ------------------------------ */

  openDetail(e) {
    const id = e.currentTarget.dataset.id
    const item = this.findItem(id)
    if (!item) return
    // 先用列表内容把弹层撑开，避免点一下等半天；列表少带 joinedPeople 等字段，
    // 群二维码、完整介绍要再取一次详情补齐，否则审核时会漏看关键信息
    this.setData({ detail: item, detailLoading: true })
    api
      .adminDetail(id)
      .then((raw) => {
        // 期间可能已经关掉弹层或切到别的活动，过期的响应直接丢弃
        const current = this.data.detail
        if (!raw || !current || current.id !== id) return null
        this.setData({ detail: this.decorateItem(raw, raw.media || {}), detailLoading: false })
        return null
      })
      .catch(() => {
        this.setData({ detailLoading: false })
      })
  },

  closeDetail() {
    this.setData({ detail: null, detailLoading: false, showReject: false, rejectRemark: '' })
  },

  onApproveTap(e) {
    const id = (e.currentTarget.dataset.id || (this.data.detail && this.data.detail.id) || '')
    if (!id || this.data.acting) return
    ui.confirm({
      title: '通过审核',
      content: '通过后活动会立即展示在首页与广场，用户可以报名。',
      confirmText: '通过',
    }).then((ok) => {
      if (!ok) return
      this.submitApprove(id)
    })
  },

  submitApprove(id) {
    this.setData({ acting: true })
    wx.showLoading({ title: '处理中', mask: true })
    api
      .adminApprove(id)
      .then(() => {
        wx.hideLoading()
        this.setData({ acting: false })
        this.closeDetail()
        ui.toast('已通过审核', 'success')
        this.loadList(true)
        return null
      })
      .catch((err) => {
        wx.hideLoading()
        this.setData({ acting: false })
        ui.toast((err && err.message) || '操作失败，请重试')
      })
  },

  onRejectTap(e) {
    const id = e.currentTarget.dataset.id || (this.data.detail && this.data.detail.id) || ''
    if (!id) return
    this.setData({ showReject: true, rejectRemark: '', detail: this.data.detail || this.findItem(id) })
  },

  findItem(id) {
    return this.data.list.filter((row) => row.id === id)[0] || null
  },

  pickRejectReason(e) {
    this.setData({ rejectRemark: String(e.currentTarget.dataset.reason || '') })
  },

  onRejectInput(e) {
    this.setData({ rejectRemark: String(e.detail.value || '').slice(0, 200) })
  },

  closeReject() {
    this.setData({ showReject: false, rejectRemark: '' })
  },

  submitReject() {
    const remark = String(this.data.rejectRemark || '').trim()
    const detail = this.data.detail
    if (!detail || this.data.acting) return
    if (!remark) {
      ui.toast('请填写驳回原因')
      return
    }
    this.setData({ acting: true })
    wx.showLoading({ title: '处理中', mask: true })
    api
      .adminReject(detail.id, remark)
      .then(() => {
        wx.hideLoading()
        this.setData({ acting: false })
        this.closeDetail()
        ui.toast('已驳回', 'success')
        this.loadList(true)
        return null
      })
      .catch((err) => {
        wx.hideLoading()
        this.setData({ acting: false })
        ui.toast((err && err.message) || '操作失败，请重试')
      })
  },

  /** 一次性运维动作：给审核能力上线前发布的历史活动补审核状态（可重复执行） */
  migrateHistory() {
    ui.confirm({
      title: '补齐历史数据',
      content: '给审核上线前发布的活动补「已通过」状态，不影响前台展示范围。可重复执行。',
      confirmText: '开始补齐',
    }).then((ok) => {
      if (!ok) return
      wx.showLoading({ title: '处理中', mask: true })
      api
        .adminMigrate()
        .then((res) => {
          wx.hideLoading()
          ui.toast(`已补齐 ${((res && res.updated) || 0)} 条`, 'success')
          this.loadList(true)
          return null
        })
        .catch((err) => {
          wx.hideLoading()
          ui.toast((err && err.message) || '操作失败，请重试')
        })
    })
  },
})
