Component({
  options: {
    styleIsolation: 'apply-shared',
  },

  methods: {
    /** 在当前页面打开已复用的半屏协议组件。 */
    open() {
      const modal = this.selectComponent('#agreement-modal')
      if (!modal || typeof modal.open !== 'function') return false
      modal.open('privacy')
      return true
    },

    onAgree(e) {
      this.triggerEvent('agree', (e && e.detail) || {})
    },

    onClose() {
      this.triggerEvent('close')
    },
  },
})
