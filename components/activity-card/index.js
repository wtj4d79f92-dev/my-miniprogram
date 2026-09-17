const { TEXTS } = require('../../utils/dict')
const api = require('../../services/api')
const location = require('../../utils/location')
const ui = require('../../utils/ui')

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
    // 默认封面文案与 utils/dict.js 保持同一份来源
    poster: {
      title: TEXTS.defaultPosterTitle,
      sub: TEXTS.defaultPosterSubtitle,
    },
    // 实际渲染的封面地址：优先用云函数换好的临时链接（见下），拿不到时退回原始 cover
    coverSrc: '',
  },

  /**
   * 卡片拿到的是别人上传的封面，客户端直接渲染 cloud:// 文件 ID 会受云存储读取权限限制，
   * 所以列表接口已经下发了 https 临时链接 coverUrl，这里优先用它。
   */
  observers: {
    act(act) {
      const src = (act && (act.coverUrl || act.cover)) || ''
      if (src !== this.data.coverSrc) this.setData({ coverSrc: src })
    },
  },

  methods: {
    /**
     * 临时链接有有效期（默认 2 小时），页面停留过久或链接失效时按 fileID 重取一次，
     * 仍然拿不到就退回默认海报，不给用户留一块空白。
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
