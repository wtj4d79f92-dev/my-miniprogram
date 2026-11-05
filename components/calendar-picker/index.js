const { startOfDay, formatYearMonth, pad } = require('../../utils/util')

const WEEK_HEAD = ['日', '一', '二', '三', '四', '五', '六']

Component({
  options: {
    styleIsolation: 'apply-shared',
  },

  data: {
    visible: false,
    title: '选择日期',
    year: 2026,
    month: 0,
    monthText: '',
    weekHead: WEEK_HEAD,
    cells: [],
    selectedTs: 0,
    minTs: 0,
    todayTs: 0,
    withTime: false,
    timeValue: '08:00',
    minTimeMessage: '',
    minTimeInclusive: false,
  },

  methods: {
    /**
     * 打开日历
     * @param {number} ts 当前编辑字段的值
     * @param {object} options { title, minTs }
     */
    open(ts, options) {
      const opts = options || {}
      const base = startOfDay(ts || Date.now())
      const d = new Date(base)
      const withTime = !!opts.withTime
      const minTs = withTime ? Number(opts.minTs) || 0 : startOfDay(opts.minTs || 0)
      const source = new Date(ts || base)
      this._minTs = minTs
      this.setData({
        visible: true,
        title: opts.title || '选择日期',
        year: d.getFullYear(),
        month: d.getMonth(),
        selectedTs: base,
        minTs,
        todayTs: startOfDay(Date.now()),
        withTime,
        timeValue: `${pad(source.getHours())}:${pad(source.getMinutes())}`,
        minTimeMessage: opts.minTimeMessage || '',
        minTimeInclusive: !!opts.minTimeInclusive,
      })
      this.build()
      return Promise.resolve()
    },

    build() {
      const year = this.data.year
      const month = this.data.month
      const first = new Date(year, month, 1)
      const gridStart = startOfDay(first.getTime()) - first.getDay() * 86400000
      const selectedTs = this.data.selectedTs
      const todayTs = this.data.todayTs
      const minTs = this.data.minTs
      const cells = []
      for (let i = 0; i < 42; i += 1) {
        const ts = gridStart + i * 86400000
        const d = new Date(ts)
        cells.push({
          ts,
          day: d.getDate(),
          out: d.getMonth() !== month,
          today: ts === todayTs,
          selected: ts === selectedTs,
          disabled: minTs > 0 && ts < startOfDay(minTs),
        })
      }
      this.setData({
        cells,
        monthText: formatYearMonth(new Date(year, month, 1).getTime()),
      })
    },

    prevMonth() {
      let year = this.data.year
      let month = this.data.month - 1
      if (month < 0) {
        month = 11
        year -= 1
      }
      this.setData({ year, month })
      this.build()
    },

    nextMonth() {
      let year = this.data.year
      let month = this.data.month + 1
      if (month > 11) {
        month = 0
        year += 1
      }
      this.setData({ year, month })
      this.build()
    },

    onSelect(e) {
      const ts = e.currentTarget.dataset.ts
      if (e.currentTarget.dataset.disabled) return
      this.setData({ selectedTs: ts })
      this.build()
    },

    onTimeChange(e) {
      this.setData({ timeValue: e.detail.value })
    },

    confirm() {
      let ts = this.data.selectedTs
      if (this.data.withTime) {
        const [hour, minute] = String(this.data.timeValue || '08:00')
          .split(':')
          .map(Number)
        const d = new Date(ts)
        d.setHours(hour || 0, minute || 0, 0, 0)
        ts = d.getTime()
      }
      const tooEarly = this.data.minTimeInclusive
        ? ts < this.data.minTs
        : this.data.withTime
          ? ts <= this.data.minTs
          : ts < this.data.minTs
      if (this.data.minTs > 0 && tooEarly) {
        wx.showToast({
          title: this.data.minTimeMessage || '所选日期不可早于今天',
          icon: 'none',
        })
        return
      }
      this.setData({ visible: false })
      this.triggerEvent('confirm', { timestamp: ts })
    },

    cancel() {
      this.setData({ visible: false })
      this.triggerEvent('cancel')
    },

    noop() {},
  },
})
