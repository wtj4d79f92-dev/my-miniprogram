Component({
  options: {
    multipleSlots: true,
    styleIsolation: 'apply-shared',
  },

  properties: {
    act: { type: Object, value: null },
    showToolbar: { type: Boolean, value: false },
  },

  methods: {
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
  },
})
