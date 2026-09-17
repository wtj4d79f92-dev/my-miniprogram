const { PROVINCES, normalizeCity, cityByName, provinceByName } = require('../../utils/cities')

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
    /**
     * 打开选择器，按当前选区定位：
     * - 城市：定位到「省 + 市」；
     * - 省份（省 + 全部）：定位到「省 + 全部」，重开时能看出当前是全省筛选。
     */
    open(city) {
      const value = String(city || this.data.city || '').trim()
      const found = value ? cityByName(value) : null
      let provinceIndex = 0
      let cityIndex = 0
      if (found) {
        const pIndex = PROVINCES.findIndex((item) => item.name === found.province)
        if (pIndex > -1) {
          provinceIndex = pIndex + 1
          const cities = PROVINCES[pIndex].cities
          const cIndex = cities.findIndex((item) => normalizeCity(item) === found.key)
          cityIndex = cIndex > -1 ? cIndex + 1 : 0
        }
      } else {
        const province = provinceByName(value)
        if (province) {
          const pIndex = PROVINCES.findIndex((item) => item.name === province.name)
          provinceIndex = pIndex > -1 ? pIndex + 1 : 0
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
      const { provinceIndex, cityIndex } = this.data
      // 选了省但城市列还是「全部」时，按全省筛选；省也选「全部」才是全国
      const province = provinceIndex > 0 ? PROVINCES[provinceIndex - 1] : null
      let key = ''
      let label = '全部'
      if (cityIndex > 0) {
        key = this.data.cityKeys[cityIndex] || ''
        label = this.data.cityLabels[cityIndex] || '全部'
      } else if (province) {
        key = province.name
        label = province.name
      }
      this.setData({ visible: false })
      this.triggerEvent('change', { city: key, label: label || '全部' })
    },

    close() {
      this.setData({ visible: false })
    },

    noop() {},
  },
})
