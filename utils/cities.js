// 城市字典：全国 34 个省级行政区 + 主要地级行政区，以及主要城市经纬度表
// 用于省市两级选择器、地点文本城市匹配、定位失败时的就近匹配

const PROVINCES = [
  { name: '北京市', cities: ['北京市'] },
  { name: '天津市', cities: ['天津市'] },
  { name: '上海市', cities: ['上海市'] },
  { name: '重庆市', cities: ['重庆市'] },
  { name: '河北省', cities: ['石家庄市', '唐山市', '保定市', '邯郸市', '秦皇岛市', '廊坊市', '张家口市', '承德市', '沧州市'] },
  { name: '山西省', cities: ['太原市', '大同市', '临汾市', '运城市', '晋中市', '长治市'] },
  { name: '内蒙古自治区', cities: ['呼和浩特市', '包头市', '鄂尔多斯市', '赤峰市', '呼伦贝尔市'] },
  { name: '辽宁省', cities: ['沈阳市', '大连市', '鞍山市', '抚顺市', '丹东市', '锦州市', '营口市', '朝阳市', '葫芦岛市'] },
  { name: '吉林省', cities: ['长春市', '吉林市', '延边朝鲜族自治州', '通化市'] },
  { name: '黑龙江省', cities: ['哈尔滨市', '齐齐哈尔市', '大庆市', '牡丹江市', '佳木斯市'] },
  { name: '江苏省', cities: ['南京市', '苏州市', '无锡市', '常州市', '徐州市', '南通市', '扬州市', '盐城市'] },
  { name: '浙江省', cities: ['杭州市', '宁波市', '温州市', '嘉兴市', '绍兴市', '金华市', '台州市', '湖州市'] },
  { name: '安徽省', cities: ['合肥市', '芜湖市', '黄山市', '马鞍山市', '安庆市'] },
  { name: '福建省', cities: ['福州市', '厦门市', '泉州市', '漳州市', '莆田市'] },
  { name: '江西省', cities: ['南昌市', '九江市', '赣州市', '景德镇市', '上饶市'] },
  { name: '山东省', cities: ['济南市', '青岛市', '烟台市', '潍坊市', '威海市', '泰安市', '临沂市'] },
  { name: '河南省', cities: ['郑州市', '洛阳市', '开封市', '南阳市', '新乡市'] },
  { name: '湖北省', cities: ['武汉市', '宜昌市', '襄阳市', '十堰市', '恩施土家族苗族自治州'] },
  { name: '湖南省', cities: ['长沙市', '株洲市', '张家界市', '衡阳市', '岳阳市'] },
  { name: '广东省', cities: ['广州市', '深圳市', '珠海市', '佛山市', '东莞市', '惠州市', '汕头市', '中山市'] },
  { name: '广西壮族自治区', cities: ['南宁市', '桂林市', '柳州市', '北海市', '阳朔县'] },
  { name: '海南省', cities: ['海口市', '三亚市', '万宁市'] },
  { name: '四川省', cities: ['成都市', '绵阳市', '乐山市', '阿坝藏族羌族自治州', '甘孜藏族自治州', '凉山彝族自治州'] },
  { name: '贵州省', cities: ['贵阳市', '遵义市', '黔东南苗族侗族自治州', '安顺市'] },
  { name: '云南省', cities: ['昆明市', '大理白族自治州', '丽江市', '西双版纳傣族自治州', '香格里拉市'] },
  { name: '西藏自治区', cities: ['拉萨市', '林芝市', '日喀则市'] },
  { name: '陕西省', cities: ['西安市', '咸阳市', '宝鸡市', '延安市', '渭南市'] },
  { name: '甘肃省', cities: ['兰州市', '天水市', '酒泉市', '嘉峪关市'] },
  { name: '青海省', cities: ['西宁市', '海东市', '海西蒙古族藏族自治州'] },
  { name: '宁夏回族自治区', cities: ['银川市', '中卫市', '吴忠市'] },
  { name: '新疆维吾尔自治区', cities: ['乌鲁木齐市', '喀什地区', '伊犁哈萨克自治州', '吐鲁番市'] },
  { name: '台湾省', cities: ['台北市', '高雄市', '台中市', '花莲县'] },
  { name: '香港特别行政区', cities: ['香港特别行政区'] },
  { name: '澳门特别行政区', cities: ['澳门特别行政区'] },
]

/** 主要城市经纬度表：用于未配置地图 key 时的就近匹配 */
const CITY_COORDS = [
  { name: '北京', lng: 116.4074, lat: 39.9042 },
  { name: '上海', lng: 121.4737, lat: 31.2304 },
  { name: '天津', lng: 117.201, lat: 39.0842 },
  { name: '重庆', lng: 106.5516, lat: 29.563 },
  { name: '石家庄', lng: 114.5149, lat: 38.0428 },
  { name: '太原', lng: 112.5489, lat: 37.8706 },
  { name: '呼和浩特', lng: 111.7519, lat: 40.8414 },
  { name: '沈阳', lng: 123.4315, lat: 41.8057 },
  { name: '大连', lng: 121.6186, lat: 38.914 },
  { name: '长春', lng: 125.3235, lat: 43.8171 },
  { name: '哈尔滨', lng: 126.5349, lat: 45.8038 },
  { name: '南京', lng: 118.7969, lat: 32.0603 },
  { name: '苏州', lng: 120.5853, lat: 31.2989 },
  { name: '杭州', lng: 120.1551, lat: 30.2741 },
  { name: '宁波', lng: 121.544, lat: 29.8683 },
  { name: '温州', lng: 120.6994, lat: 27.9944 },
  { name: '合肥', lng: 117.2272, lat: 31.8206 },
  { name: '福州', lng: 119.2965, lat: 26.0745 },
  { name: '厦门', lng: 118.0894, lat: 24.4798 },
  { name: '南昌', lng: 115.8581, lat: 28.682 },
  { name: '济南', lng: 117.1205, lat: 36.6519 },
  { name: '青岛', lng: 120.3826, lat: 36.0671 },
  { name: '郑州', lng: 113.6254, lat: 34.7466 },
  { name: '武汉', lng: 114.3055, lat: 30.5928 },
  { name: '长沙', lng: 112.9388, lat: 28.2282 },
  { name: '广州', lng: 113.2644, lat: 23.1292 },
  { name: '深圳', lng: 114.0579, lat: 22.5431 },
  { name: '珠海', lng: 113.5767, lat: 22.2707 },
  { name: '南宁', lng: 108.3665, lat: 22.817 },
  { name: '桂林', lng: 110.2993, lat: 25.2742 },
  { name: '海口', lng: 110.1983, lat: 20.0444 },
  { name: '三亚', lng: 109.5082, lat: 18.2528 },
  { name: '成都', lng: 104.0657, lat: 30.6595 },
  { name: '贵阳', lng: 106.6302, lat: 26.6477 },
  { name: '昆明', lng: 102.8329, lat: 24.8801 },
  { name: '大理', lng: 100.2677, lat: 25.6065 },
  { name: '丽江', lng: 100.2273, lat: 26.855 },
  { name: '拉萨', lng: 91.1409, lat: 29.6456 },
  { name: '西安', lng: 108.954, lat: 34.2655 },
  { name: '兰州', lng: 103.8343, lat: 36.0611 },
  { name: '西宁', lng: 101.7782, lat: 36.6171 },
  { name: '银川', lng: 106.2309, lat: 38.4872 },
  { name: '乌鲁木齐', lng: 87.6168, lat: 43.8256 },
  { name: '台北', lng: 121.5654, lat: 25.033 },
  { name: '香港', lng: 114.1694, lat: 22.3193 },
  { name: '澳门', lng: 113.5439, lat: 22.1987 },
]

/** 去掉“市”后缀，作为统一的城市标识 */
function normalizeCity(name) {
  const value = String(name || '').trim()
  if (!value) return ''
  return value.replace(/市$/, '')
}

/** 反向：根据归一化城市名找到完整城市名 */
function cityByName(name) {
  const target = normalizeCity(name)
  if (!target) return null
  for (let i = 0; i < PROVINCES.length; i += 1) {
    const province = PROVINCES[i]
    for (let j = 0; j < province.cities.length; j += 1) {
      if (normalizeCity(province.cities[j]) === target) {
        return { province: province.name, city: province.cities[j], key: target }
      }
    }
  }
  return null
}

function provinceOfCity(name) {
  const found = cityByName(name)
  return found ? found.province : ''
}

/** 省份简称：去掉「省 / 市 / 自治区 / 特别行政区」与民族名称，用于省名模糊匹配 */
function provinceShortName(name) {
  return String(name || '').replace(
    /(省|市|自治区|特别行政区|维吾尔|壮族|回族|蒙古|藏族|苗族|侗族|土家族|彝族|白族|傣族|哈萨克|朝鲜族|羌族)/g,
    ''
  )
}

/** 按省名 / 省简称找到省份，不是省份时返回 null（选择器回填与省级筛选用它） */
function provinceByName(name) {
  const value = String(name || '').trim()
  if (!value) return null
  for (let i = 0; i < PROVINCES.length; i += 1) {
    if (PROVINCES[i].name === value) return PROVINCES[i]
  }
  const short = provinceShortName(value)
  if (short.length < 2) return null
  for (let i = 0; i < PROVINCES.length; i += 1) {
    if (provinceShortName(PROVINCES[i].name) === short) return PROVINCES[i]
  }
  return null
}

/**
 * 所选地区 -> 归一化城市列表，前后端筛选统一口径：
 * - 空值：返回 []，表示「全部 / 全国」，不做城市过滤；
 * - 城市名 / 直辖市名：返回单个城市，如「广州」-> ['广州']；
 * - 省 / 自治区 / 特别行政区名或简称：返回全省城市，如「广东省」-> ['广州', '深圳', ...]。
 *
 * 城市优先于省份，避免「吉林」这类与省简称同名的城市把范围放大到全省。
 * @returns {string[]} 归一化城市名列表
 */
function regionCityKeys(region) {
  const value = String(region || '').trim()
  // 「全部 / 全国」是选择器的展示文案，语义等同空值
  if (!value || value === '全部' || value === '全国') return []
  if (cityByName(value)) return [normalizeCity(value)]
  const province = provinceByName(value)
  if (province) return province.cities.map((city) => normalizeCity(city))
  // 表里没有的地区：按原值等值匹配，保持与历史行为一致
  return [normalizeCity(value)]
}

/** 全部城市（归一化名 -> 完整名），按名称长度倒序，避免短名误匹配 */
const ALL_CITIES = PROVINCES.reduce((acc, province) => {
  province.cities.forEach((city) => {
    acc.push({ province: province.name, city, key: normalizeCity(city) })
  })
  return acc
}, []).sort((a, b) => b.key.length - a.key.length)

const PROVINCE_NAMES = PROVINCES.map((item) => item.name)

/**
 * 从地址文本中匹配城市
 * 策略：文本命中省份名则只在省内匹配；否则全局最长城市名匹配
 * @returns {string} 归一化城市名，未命中返回 ''
 */
function matchCity(address) {
  const text = String(address || '')
  if (!text) return ''

  for (let i = 0; i < PROVINCE_NAMES.length; i += 1) {
    const provinceName = PROVINCE_NAMES[i]
    const short = provinceShortName(provinceName)
    const hit = text.indexOf(provinceName) > -1 || (short.length >= 2 && text.indexOf(short) > -1)
    if (!hit) continue
    const province = PROVINCES[i]
    let matched = ''
    province.cities.forEach((city) => {
      const key = normalizeCity(city)
      if (text.indexOf(key) > -1 && key.length > matched.length) {
        matched = key
      }
    })
    return matched
  }

  for (let i = 0; i < ALL_CITIES.length; i += 1) {
    const item = ALL_CITIES[i]
    if (item.key.length >= 2 && text.indexOf(item.key) > -1) {
      return item.key
    }
  }
  return ''
}

/** 经纬度 -> 最近的城市（未配置逆地址解析时的兜底） */
function nearestCity(lng, lat) {
  if (typeof lng !== 'number' || typeof lat !== 'number') return ''
  let best = ''
  let bestDistance = Infinity
  CITY_COORDS.forEach((item) => {
    const dLng = (item.lng - lng) * Math.cos((lat * Math.PI) / 180)
    const dLat = item.lat - lat
    const distance = dLng * dLng + dLat * dLat
    if (distance < bestDistance) {
      bestDistance = distance
      best = item.name
    }
  })
  // 超过约 1.5 个经纬度范围视为无法匹配
  return bestDistance <= 2.25 ? best : ''
}

/**
 * 城市中心坐标（归一化城市名 -> 经纬度）。
 * 未配置地图 key、地址又解析不出坐标时，用它给地图选点一个合理的初始位置。
 * @returns {{ latitude: number, longitude: number } | null}
 */
function cityCoords(name) {
  const target = normalizeCity(name)
  if (!target) return null
  for (let i = 0; i < CITY_COORDS.length; i += 1) {
    if (normalizeCity(CITY_COORDS[i].name) === target) {
      return { latitude: CITY_COORDS[i].lat, longitude: CITY_COORDS[i].lng }
    }
  }
  return null
}

/**
 * 地区值 -> 单个城市，只落到唯一城市时才算数（省份 / 全部 / 未知值返回 ''）。
 *
 * 用于「发布者当前城市」这类兜底：集合地点里写不出城市（如手输「双流区润和路附近」）时，
 * 服务端用它把活动归到发布者所在城市，否则活动城市为空，按城市筛选时永远看不到。
 * @param {string} region 地区值：城市名 / 省名 / 空
 * @returns {string} 归一化城市名，无法唯一确定时返回 ''
 */
function singleCityKey(region) {
  const keys = regionCityKeys(region)
  return keys.length === 1 ? keys[0] : ''
}

module.exports = {
  PROVINCES,
  CITY_COORDS,
  ALL_CITIES,
  normalizeCity,
  cityByName,
  provinceOfCity,
  provinceShortName,
  provinceByName,
  regionCityKeys,
  singleCityKey,
  matchCity,
  nearestCity,
  cityCoords,
}
