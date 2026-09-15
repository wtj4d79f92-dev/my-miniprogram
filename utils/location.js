// 定位能力：微信定位 + 腾讯位置服务逆地址解析（未配置 key 时按经纬度就近匹配）
const { nearestCity } = require('./cities')
const config = require('../services/config')

/** 逆地址解析：需要在小程序后台配置 request 合法域名 */
function reverseGeocode(lng, lat) {
  return new Promise((resolve) => {
    if (!config.mapKey) {
      resolve('')
      return
    }
    wx.request({
      url: 'https://apis.map.qq.com/ws/geocoder/v1/',
      data: { location: `${lat},${lng}`, key: config.mapKey, get_poi: 0 },
      method: 'GET',
      success: (res) => {
        const data = res && res.data
        const city =
          (data && data.result && data.result.address_component && data.result.address_component.city) ||
          (data && data.result && data.result.address_component && data.result.address_component.province) ||
          ''
        resolve(city)
      },
      fail: () => resolve(''),
    })
  })
}

/**
 * 获取当前城市
 * @returns {Promise<string>} 归一化城市名，失败返回 ''
 */
function locate() {
  const app = getApp()
  return new Promise((resolve) => {
    wx.getLocation({
      type: 'gcj02',
      success: (res) => {
        if (app) {
          app.globalData.locationDenied = false
        }
        reverseGeocode(res.longitude, res.latitude).then((city) => {
          if (city) {
            resolve(city)
            return
          }
          resolve(nearestCity(res.longitude, res.latitude))
        })
      },
      fail: () => {
        if (app) {
          app.globalData.locationDenied = true
          app.globalData.cityLocated = false
        }
        resolve('')
      },
    })
  })
}

module.exports = { locate, reverseGeocode }
