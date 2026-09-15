const { PROVINCES, normalizeCity, cityByName } = require('../../utils/cities')

Component({
  options: {
    styleIsolation: 'apply-shared',
  },

  properties: {
    city: { type: String, value: '' },
  },

  data: {
    visible: false,
    provinceNames: ['全部'],
    cityLabels: ['全部'],
    cityKeys: [''],
    value: [0, 0],
    provinceIndex: 0,
    cityIndex: 0,
  },

  lifetimes: {
    attached() {
      this.setData({
        provinceNames: ['全部'].concat(PROVINCES.map((item) => item.name)),
      })
    },
  },

  methods: {
    /** 打开选择器，按当前城市定位到对应省 / 市 */
    open(city) {
      const target = normalizeCity(city || this.data.city)
      let provinceIndex = 0
      let cityIndex = 0
      if (target) {
        const found = cityByName(target)
        if (found) {
          const pIndex = PROVINCES.findIndex((item) => item.name === found.province)
          if (pIndex > -1) {
            provinceIndex = pIndex + 1
            const cities = PROVINCES[pIndex].cities
            const cIndex = cities.findIndex((item) => normalizeCity(item) === target)
            cityIndex = cIndex > -1 ? cIndex + 1 : 0
          }
        }
      }
      this.setData({ visible: true })
      this.applyProvince(provinceIndex, cityIndex)
      return Promise.resolve()
    },

    applyProvince(provinceIndex, cityIndex) {
      const labels = ['全部']
      const keys = ['']
      if (provinceIndex > 0 && PROVINCES[provinceIndex - 1]) {
        PROVINCES[provinceIndex - 1].cities.forEach((item) => {
          labels.push(item)
          keys.push(normalizeCity(item))
        })
      }
      const safeCityIndex = cityIndex >= 0 && cityIndex < labels.length ? cityIndex : 0
      this.setData({
        provinceIndex,
        cityIndex: safeCityIndex,
        cityLabels: labels,
        cityKeys: keys,
        value: [provinceIndex, safeCityIndex],
      })
    },

    onPickerChange(e) {
      const value = e.detail.value || [0, 0]
      const provinceIndex = value[0] || 0
      const cityIndex = value[1] || 0
      if (provinceIndex !== this.data.provinceIndex) {
        // 切换省份后城市列重置为「全部」
        this.applyProvince(provinceIndex, 0)
        return
      }
      this.setData({ cityIndex, value: [provinceIndex, cityIndex] })
    },

    confirm() {
      const key = this.data.cityKeys[this.data.cityIndex] || ''
      const label = this.data.cityLabels[this.data.cityIndex] || '全部'
      this.setData({ visible: false })
      this.triggerEvent('change', { city: key, label: label === '全部' ? '全部' : label })
    },

    close() {
      this.setData({ visible: false })
    },

    noop() {},
  },
})
