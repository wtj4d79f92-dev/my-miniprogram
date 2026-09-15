const { AGREEMENTS } = require('../../utils/agreements')
const { parseBold } = require('../../utils/util')

Component({
  options: {
    styleIsolation: 'apply-shared',
  },

  data: {
    visible: false,
    title: '',
    updatedAt: '',
    blocks: [],
  },

  methods: {
    /** 打开协议半屏弹窗，key: publish | join */
    open(key) {
      const agreement = AGREEMENTS[key]
      if (!agreement) return Promise.resolve()
      const blocks = agreement.paragraphs.map((text, index) => ({
        key: `${key}_${index}`,
        segments: parseBold(text).map((seg, i) => ({ text: seg.text, strong: seg.strong, i })),
      }))
      this.setData({
        visible: true,
        title: agreement.title,
        updatedAt: agreement.updatedAt,
        blocks,
      })
      this._key = key
      return Promise.resolve()
    },

    close() {
      this.setData({ visible: false })
      this.triggerEvent('close', { key: this._key })
    },

    agree() {
      this.setData({ visible: false })
      this.triggerEvent('agree', { key: this._key })
    },

    noop() {},
  },
})
