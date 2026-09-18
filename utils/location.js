// 定位能力：微信定位 + 腾讯位置服务逆地址解析（未配置 key 时按经纬度就近匹配）+ 点击地址调起导航
const { PROVINCES, provinceShortName, nearestCity, matchCity, cityCoords, normalizeCity } = require('./cities')
const config = require('../services/config')
const ui = require('./ui')

/** 集合地点文本上限，与表单 maxlength、services/api.js、云函数 LIMITS.location 同一口径 */
const LOCATION_MAX = 50

/** 地图选点地址上限（不展示，只用于城市匹配与地址检索），与云函数 LIMITS.locationAddress 一致 */
const ADDRESS_MAX = 100

/** 导航时展示给地图软件的位置名上限，超出会被截断 */
const NAV_NAME_MAX = 20

/**
 * 从地图选点的地址里取出「省 + 市」明细（如「四川省成都市」）。
 *
 * 只认省与市：区 / 街道对「这是哪个城市的活动」没有帮助，写进展示文本只会更长。
 * 地址里写成简称（「成都」「广东」）也能认出来，市名取字典里的完整写法。
 * @param {string} address wx.chooseLocation 返回的地址
 * @returns {{ province: string, city: string } | null} 认不出省市时返回 null
 */
function regionOfAddress(address) {
  const text = String(address || '').trim()
  if (!text) return null
  for (let i = 0; i < PROVINCES.length; i += 1) {
    const province = PROVINCES[i]
    const short = provinceShortName(province.name)
    const hit = text.indexOf(province.name) > -1 || (short.length >= 2 && text.indexOf(short) > -1)
    if (!hit) continue
    let key = ''
    province.cities.forEach((item) => {
      const city = normalizeCity(item)
      if (text.indexOf(city) > -1 && city.length > key.length) key = city
    })
    const city = key ? province.cities.filter((item) => normalizeCity(item) === key)[0] || '' : ''
    return { province: province.name, city }
  }
  return null
}

/**
 * 地图选点的地址 -> 「省 + 市」前缀，取不到时返回 ''（如「四川省成都市」）。
 * 直辖市 / 特别行政区的省名与市名相同，只留一个，不拼成「北京市北京市」。
 * @param {string} address wx.chooseLocation 返回的地址
 * @returns {string}
 */
function regionLabel(address) {
  const region = regionOfAddress(address)
  if (!region) return ''
  if (!region.city || normalizeCity(region.city) === normalizeCity(region.province)) return region.province
  return `${region.province}${region.city}`
}

/** 文本里是不是已经写着这个省 / 市，避免拼出「广东省广州市 广州市人民政府」这类重复 */
function hasRegionText(text, region) {
  const value = String(text || '')
  if (!value || !region) return false
  if (value.indexOf(region.province) > -1) return true
  return !!region.city && value.indexOf(region.city) > -1
}

/**
 * 展示中的集合地点去掉自动补上的「省 + 市」前缀，拿回地点名本身。
 * 用户在表单里删掉前缀继续编辑时，靠它判断改的还是不是同一个地点。
 * @param {string} location 展示中的集合地点
 * @returns {string}
 */
function placeNameOf(location) {
  const value = String(location || '').trim()
  if (!value) return ''
  const label = regionLabel(value)
  if (!label || value.indexOf(label) !== 0) return value
  return value.slice(label.length).trim()
}

/**
 * 地图选点结果 -> 集合地点字段
 *
 * wx.chooseLocation 返回的 name 是用户点选的地点名（选点列表里加粗那一行），
 * address 是它所属的行政区地址（列表里的灰色小字）。两者拆开存：
 * - location 放「省 + 市 + 地点名」（如「四川省成都市 华府大道地铁站」），表单 / 广场 / 详情 / 海报都显示它，
 *   既让用户一眼看出活动在哪个城市，也让只有地址文本的老活动点「导航」时凭这串省市提高解析命中率；
 *   地点名里已经带出省市（选中的 poi 本身就叫「广州市人民政府」，或退回的完整地址）时不再重复加；
 * - address 单独交给 locationAddress，不出现在任何展示位，只给城市匹配与地址检索用
 *   （只留地点名会让「华府大道地铁站」匹配不到成都，活动在城市筛选里会查不到）。
 * 经纬度一并带出，写进 locationLat / locationLng，详情页与广场卡片点地址时直接用它调起导航。
 * @param {{ name?: string, address?: string, latitude?: number, longitude?: number }} res wx.chooseLocation 的返回值
 * @returns {{ location: string, address: string, latitude: number, longitude: number }} 展示用的地点文本 + 匹配用的地址 + 坐标
 */
function parsePickedPlace(res) {
  const name = String((res && res.name) || '').trim()
  const address = String((res && res.address) || '').trim()
  // 拖动地图选到没有名称的点位时，退回地址当展示文本
  const base = name || address
  const region = regionOfAddress(address)
  const label = regionLabel(address)
  const display = label && !hasRegionText(base, region) ? `${label} ${base}` : base
  return {
    location: display.slice(0, LOCATION_MAX),
    address: address.slice(0, ADDRESS_MAX),
    latitude: Number(res && res.latitude) || 0,
    longitude: Number(res && res.longitude) || 0,
  }
}

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
 * 用户主动拒绝授权（或系统里关掉了微信定位）：换坐标系重试也拿不到，直接按「定位未开启」处理。
 * @param {object} err 定位接口的 fail 回调参数
 * @returns {boolean}
 */
function isAuthDeny(err) {
  return /auth deny|auth denied|authorize/i.test(String((err && err.errMsg) || err || ''))
}

/**
 * 模糊定位：判「在哪个城市」只要城市级精度，用 wx.getFuzzyLocation 就够了。
 *
 * 原来的 wx.getLocation 需要在小程序后台单独申请开通：接口权限页显示「暂无权限」时调用直接 fail，
 * 用户永远拿不到城市，而且未开通的接口在代码提审环节会被拦截；wx.getFuzzyLocation 是默认开通的，
 * 拿到的模糊坐标判「在哪个城市」完全够用，所以主路径只走它。
 *
 * type 先按 gcj02 要（与地图选点、导航的坐标系一致），个别环境不认这个值时报错，
 * 再按默认坐标系要一次 —— 判城市用不上米级精度，坐标系偏移不影响结果。
 * 基础库低于 2.25.0 没有这个接口，返回 unsupported，由调用方降级成手动选城市。
 * @returns {Promise<{ coords?: object, denied?: boolean, unsupported?: boolean }>}
 */
function fuzzyPosition() {
  const queue = ['gcj02', '']
  return new Promise((resolve) => {
    if (!wx.getFuzzyLocation) {
      resolve({ unsupported: true })
      return
    }
    const attempt = (index) => {
      if (index >= queue.length) {
        resolve({})
        return
      }
      const options = {
        success: (res) => resolve({ coords: res }),
        fail: (err) => {
          if (isAuthDeny(err)) {
            resolve({ denied: true })
            return
          }
          attempt(index + 1)
        },
      }
      if (queue[index]) options.type = queue[index]
      wx.getFuzzyLocation(options)
    }
    attempt(0)
  })
}

/**
 * 获取当前城市：拿不到模糊坐标（拒绝授权 / 基础库不支持）时按「定位未开启」处理，
 * 交由页面引导用户去设置里开权限，或手动选城市。
 * @returns {Promise<string>} 归一化城市名，失败返回 ''
 */
function locate() {
  const app = getApp()
  return fuzzyPosition().then((pos) => {
    const coords = pos && pos.coords
    if (!coords) {
      if (app) {
        app.globalData.locationDenied = true
        app.globalData.cityLocated = false
      }
      return ''
    }
    if (app) {
      app.globalData.locationDenied = false
    }
    return reverseGeocode(coords.longitude, coords.latitude).then(
      // 未配置地图 key / 逆地址解析失败时，按模糊坐标就近匹配城市
      (city) => city || nearestCity(coords.longitude, coords.latitude)
    )
  })
}

/* ---------------------------- 点击地址调起导航 ---------------------------- */

/** 当前定位 / 用户手动选择的城市（'' 表示「全部 / 全国」） */
function currentCity() {
  const app = getApp()
  return normalizeCity((app && app.globalData && app.globalData.city) || '')
}

/**
 * 地址解析用的城市上下文：活动自己的城市 -> 地址文本里认出的城市 -> 用户当前城市。
 *
 * 集合地点常被写成「双流区润和路附近」这类缺省市的短地址：腾讯地理编码缺了区域线索命中率很低，
 * 这里统一给它找一个参考城市，既当地理编码参数，也用于补全地址文本。
 * @param {{ name?: string, address?: string, city?: string }} item 导航目标
 * @returns {string} 归一化城市名，找不到时返回 ''
 */
function regionOf(item) {
  const target = item || {}
  const name = String(target.name || '').trim()
  const address = String(target.address || '').trim()
  return normalizeCity(target.city) || matchCity(address || name) || currentCity()
}

/**
 * 经纬度可用性校验。
 *
 * wx.openLocation 的经纬度是必填项，传 0 或脏数据会直接报错；
 * 历史活动（手输地址发布的）没有坐标，统一按「不可用」处理，走地址解析兜底。
 * 中国大致范围之外的值一律当作没有，避免地图打开到地球另一端。
 * @param {number|string} latitude 纬度
 * @param {number|string} longitude 经度
 * @returns {{ latitude: number, longitude: number } | null}
 */
function usableCoord(latitude, longitude) {
  const lat = Number(latitude)
  const lng = Number(longitude)
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null
  if (lat < 3 || lat > 54 || lng < 73 || lng > 136) return null
  return { latitude: lat, longitude: lng }
}

/**
 * 地址文本 -> 经纬度（腾讯位置服务地理编码）。
 *
 * 只在配置了 config.mapKey 时可用：没配 key 的老环境（历史活动只有地址文本）
 * 直接返回 null，由调用方走「地图选点 + 复制地址」的兜底，不会卡住用户。
 * 需要在小程序后台把 apis.map.qq.com 加进 request 合法域名。
 *
 * 缺省市的短地址（如「双流区润和路附近」）先按城市参数查一次，仍解析不出来就把城市补到地址前面再查一次，
 * 这样「只写了区 / 街道」的历史活动也能解析出坐标。
 * @param {string} keyword 地址 / 地点关键词
 * @param {string} city 活动城市，作为解析的参考区域，能明显提升命中率
 * @returns {Promise<{ latitude: number, longitude: number } | null>}
 */
function geocode(keyword, city) {
  const address = String(keyword || '').trim()
  if (!config.mapKey || !address) return Promise.resolve(null)

  const region = normalizeCity(city)
  const queries = [{ address, region: region || '' }]
  // 地址里没有任何省市线索时，把城市补到前面再问一次，「成都双流区润和路附近」比「双流区润和路附近」好命中得多
  if (region && address.indexOf(region) === -1 && !/(省|市|自治区|特别行政区)/.test(address)) {
    queries.push({ address: `${region}${address}`, region: '' })
  }

  const request = (index) => {
    if (index >= queries.length) return Promise.resolve(null)
    const query = queries[index]
    return new Promise((resolve) => {
      wx.request({
        url: 'https://apis.map.qq.com/ws/geocoder/v1/',
        data: { address: query.address, region: query.region, key: config.mapKey, policy: 1 },
        method: 'GET',
        success: (res) => {
          const data = res && res.data
          const result = data && data.result
          const location = result && result.location
          const coords =
            data && data.status === 0 ? usableCoord(location && location.lat, location && location.lng) : null
          resolve(coords || request(index + 1))
        },
        fail: () => resolve(request(index + 1)),
      })
    })
  }

  return request(0)
}

/** 打开微信内置地图：用户在地图页点「导航」后，坐标与地址一起交给高德 / 百度 / 腾讯 / 苹果地图 */
function openLocation(coords, name, address) {
  return new Promise((resolve) => {
    wx.openLocation({
      latitude: coords.latitude,
      longitude: coords.longitude,
      name: String(name || address || '').slice(0, NAV_NAME_MAX),
      // 只有地点名时把地点名当详细地址，地图卡片上不会空着
      address: String(address || name || '').slice(0, ADDRESS_MAX),
      scale: 16,
      success: () => resolve('opened'),
      fail: () => resolve('failed'),
    })
  })
}

/** 复制地址：给用户一条不依赖定位也能走通的路 */
function copyAddress(address) {
  return new Promise((resolve) => {
    wx.setClipboardData({
      data: address,
      success: () => resolve('copied'),
      fail: () => resolve('failed'),
    })
  })
}

/**
 * 在地图上点选具体位置（地图页搜索框里预填地址，用户点一下结果即可）。
 * 拿不到坐标时用它替代「只能复制地址」：微信内置地图只能按坐标打开，
 * 有了用户点选的坐标就能照常调起地图软件。
 */
function chooseOnMap(address, region) {
  return new Promise((resolve) => {
    const center = cityCoords(region)
    const options = {
      success: (res) => resolve(parsePickedPlace(res)),
      // 用户取消选点 / 选点不可用都按「没选」处理
      fail: () => resolve(null),
    }
    if (address) options.keyword = address
    if (center) {
      options.latitude = center.latitude
      options.longitude = center.longitude
    }
    wx.chooseLocation(options)
  })
}

/** 解析不出坐标时：先让用户在地图上点一次（点完直接导航），不想选点也可以只复制地址 */
function guideNavigation(address, region) {
  return new Promise((resolve) => {
    wx.showActionSheet({
      alertText: `「${address}」暂时解析不出坐标，可以在地图上点选一下具体位置，选中后直接开始导航。`,
      itemList: ['在地图上点选位置后导航', '仅复制地址'],
      success: (res) => {
        if (res.tapIndex === 0) {
          chooseOnMap(address, region).then((place) => {
            const coords = place && usableCoord(place.latitude, place.longitude)
            if (!coords) {
              resolve('cancelled')
              return
            }
            openLocation(coords, place.location || address, place.address || address).then(resolve)
          })
          return
        }
        copyAddress(address).then(resolve)
      },
      fail: () => resolve('cancelled'),
    })
  })
}

/**
 * 点击地址调起地图导航。
 *
 * 有坐标（地图选点发布的活动）直接打开微信内置地图；只有地址文本时先做地理编码再打开，
 * 解析不出来（未配置 mapKey / 地址太短）就请用户在地图上点一次，选中后同样直接打开导航。
 * 内置地图页底部点「导航」，微信会把该坐标与地点名交给用户选中的地图软件
 * （高德 / 百度 / 腾讯 / 苹果地图），地址随导航一起带过去，无需用户再输入。
 * @param {{ name?: string, address?: string, city?: string, latitude?: number, longitude?: number }} target
 * @returns {Promise<'opened' | 'copied' | 'cancelled' | 'failed' | 'empty'>} 结果仅用于调用方补提示
 */
function openNavigation(target) {
  const item = target || {}
  const name = String(item.name || '').trim()
  const address = String(item.address || '').trim()
  // 解析与提示都以完整地址为准，没有地址时退回地点名本身
  const keyword = address || name
  if (!keyword) return Promise.resolve('empty')

  const open = (coords) => openLocation(coords, name || address, address || name)

  const direct = usableCoord(item.latitude, item.longitude)
  if (direct) return open(direct)

  // 没有坐标：先按地址文本解析一次（城市作为参考区域），解析不出来再引导用户在地图上点选
  const region = regionOf(item)
  wx.showLoading({ title: '正在定位', mask: true })
  return geocode(keyword, region)
    .then((coords) => {
      ui.hideLoading()
      return coords ? open(coords) : guideNavigation(keyword, region)
    })
    .catch(() => {
      ui.hideLoading()
      return 'failed'
    })
}

module.exports = {
  locate,
  reverseGeocode,
  parsePickedPlace,
  regionLabel,
  placeNameOf,
  openNavigation,
  regionOf,
  usableCoord,
  geocode,
  LOCATION_MAX,
  ADDRESS_MAX,
}
