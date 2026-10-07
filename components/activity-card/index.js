const api = require('../../services/api')
const location = require('../../utils/location')
const ui = require('../../utils/ui')

/**
 * 卡片上「审核中 / 未通过 / 已到期 / 已关闭」角标的口径，封面上和无封面时的窄标签共用一份。
 * 审核状态比业务状态更该被发起人看到，优先展示；但过了展示期的活动已自动关闭，按已到期展示。
 */
function resolveStatus(act) {
  if (!act) return { text: '', className: '', tone: '' }
  if (!act.auditApproved && !act.expired) {
    return {
      text: act.auditText || '',
      className: `act-audit-${act.auditStatus || ''}`,
      tone: act.auditStatus || '',
    }
  }
  // 展示期届满（发布满 7 天）自动关闭，与发起人主动关闭区分开
  if (act.expired) return { text: '已到期', className: '', tone: 'closed' }
  if (act.isClosed) return { text: '已关闭', className: '', tone: 'closed' }
  return { text: '', className: '', tone: '' }
}

Component({
  options: {
    multipleSlots: true,
    styleIsolation: 'apply-shared',
  },

  properties: {
    act: { type: Object, value: null },
    showToolbar: { type: Boolean, value: false },
  },

  data: {
    // 实际渲染的封面地址：优先用云函数换好的临时链接（见下），拿不到时退回原始 cover
    coverSrc: '',
    // 封面角标 / 无封面时窄标签的文案与状态
    statusText: '',
    statusClass: '',
    statusTone: '',
  },

  /**
   * 卡片拿到的是别人上传的封面，客户端直接渲染 cloud:// 文件 ID 会受云存储读取权限限制，
   * 所以列表接口已经下发了 https 临时链接 coverUrl，这里优先用它。
   * coverSrc 为空表示这条活动没传封面：列表里整块封面都不会渲染，改走窄标签版式。
   */
  observers: {
    act(act) {
      const src = (act && (act.coverUrl || act.cover)) || ''
      const status = resolveStatus(act)
      const patch = {}
      if (src !== this.data.coverSrc) patch.coverSrc = src
      if (status.text !== this.data.statusText) patch.statusText = status.text
      if (status.className !== this.data.statusClass) patch.statusClass = status.className
      if (status.tone !== this.data.statusTone) patch.statusTone = status.tone
      if (Object.keys(patch).length) this.setData(patch)
    },
  },

  methods: {
    /**
     * 临时链接有有效期（默认 2 小时），页面停留过久或链接失效时按 fileID 重取一次，
     * 仍然拿不到就按「无封面」处理（列表里不渲染封面块），不给用户留一块空白。
     */
    onCoverError() {
      const act = this.data.act
      const fileID = String((act && act.cover) || '')
      if (fileID.indexOf('cloud://') !== 0 || this.coverRetried) {
        this.setData({ coverSrc: '' })
        return Promise.resolve()
      }
      this.coverRetried = true
      return api
        .media([fileID])
        .then((media) => {
          const entry = media && media[fileID]
          if (entry && entry.url) {
            this.setData({ coverSrc: entry.url })
            return
          }
          this.setData({ coverSrc: '' })
        })
        .catch(() => {
          this.setData({ coverSrc: '' })
        })
    },

    onTap() {
      const act = this.data.act
      if (!act) return
      this.triggerEvent('tapcard', { id: act.id })
    },

    onToggle(e) {
      const act = this.data.act
      if (!act) return
      this.triggerEvent('toggle', { id: act.id, status: act.status, event: e })
    },

    /** 修改活动：交给页面跳发布页的编辑模式，保存后重新送审 */
    onEdit() {
      const act = this.data.act
      if (!act) return
      this.triggerEvent('editcard', { id: act.id })
    },

    /**
     * 点卡片上的「地点」：直接在广场 / 首页调起地图导航，不跳详情页
     * （wxml 里用的是 catchtap，不会顺带触发卡片的进详情）。
     */
    onLocationTap() {
      const act = this.data.act
      if (!act || !act.location) return
      location
        .openNavigation({
          name: act.location,
          address: act.locationAddress || act.location,
          city: act.city,
          latitude: act.locationLat,
          longitude: act.locationLng,
        })
        .then((result) => {
          if (result === 'failed') ui.toast('打开地图失败，请稍后重试')
        })
    },
  },
})
