// 服务端城市字典副本：与前端 utils/cities.js 的 PROVINCES / normalizeCity / matchCity 保持一致
// 云函数打包时只会上传本目录，无法 require 小程序根目录的文件，因此这里保留一份镜像。
// 只保留「地址文本 -> 城市」需要的部分，经纬度就近匹配（nearestCity）属于定位兜底，留在前端。
//
// 行政区划口径与民政部《中华人民共和国行政区划代码》一致：
// - 省级以下列到地级行政区：地级市 / 地区 / 自治州 / 盟；
// - 直辖市、特别行政区没有地级层级，只列本级；
// - 河南济源、湖北仙桃等省直辖县级行政区不隶属任何地级市，直接挂在所属省份下；
// - 台湾省沿用岛内主要县市。
// 县级热门目的地（阳朔、义乌等）不进选择器，只在 CITY_ALIASES 里做地址文本归属。

const PROVINCES = [
  { name: '北京市', cities: ['北京市'] },
  { name: '天津市', cities: ['天津市'] },
  { name: '上海市', cities: ['上海市'] },
  { name: '重庆市', cities: ['重庆市'] },
  {
    name: '河北省',
    cities: [
      '石家庄市', '唐山市', '秦皇岛市', '邯郸市', '邢台市', '保定市', '张家口市', '承德市', '沧州市', '廊坊市',
      '衡水市',
      // 省直辖县级行政区
      '辛集市', '定州市',
    ],
  },
  {
    name: '山西省',
    cities: [
      '太原市', '大同市', '阳泉市', '长治市', '晋城市', '朔州市', '晋中市', '运城市', '忻州市', '临汾市',
      '吕梁市',
    ],
  },
  {
    name: '内蒙古自治区',
    cities: [
      '呼和浩特市', '包头市', '乌海市', '赤峰市', '通辽市', '鄂尔多斯市', '呼伦贝尔市', '巴彦淖尔市',
      '乌兰察布市',
      '兴安盟', '锡林郭勒盟', '阿拉善盟',
    ],
  },
  {
    name: '辽宁省',
    cities: [
      '沈阳市', '大连市', '鞍山市', '抚顺市', '本溪市', '丹东市', '锦州市', '营口市', '阜新市', '辽阳市',
      '盘锦市', '铁岭市', '朝阳市', '葫芦岛市',
    ],
  },
  {
    name: '吉林省',
    cities: ['长春市', '吉林市', '四平市', '辽源市', '通化市', '白山市', '松原市', '白城市', '延边朝鲜族自治州'],
  },
  {
    name: '黑龙江省',
    cities: [
      '哈尔滨市', '齐齐哈尔市', '鸡西市', '鹤岗市', '双鸭山市', '大庆市', '伊春市', '佳木斯市', '七台河市',
      '牡丹江市', '黑河市', '绥化市', '大兴安岭地区',
    ],
  },
  {
    name: '江苏省',
    cities: [
      '南京市', '无锡市', '徐州市', '常州市', '苏州市', '南通市', '连云港市', '淮安市', '盐城市', '扬州市',
      '镇江市', '泰州市', '宿迁市',
    ],
  },
  {
    name: '浙江省',
    cities: ['杭州市', '宁波市', '温州市', '嘉兴市', '湖州市', '绍兴市', '金华市', '衢州市', '舟山市', '台州市', '丽水市'],
  },
  {
    name: '安徽省',
    cities: [
      '合肥市', '芜湖市', '蚌埠市', '淮南市', '马鞍山市', '淮北市', '铜陵市', '安庆市', '黄山市', '滁州市',
      '阜阳市', '宿州市', '六安市', '亳州市', '池州市', '宣城市',
    ],
  },
  { name: '福建省', cities: ['福州市', '厦门市', '莆田市', '三明市', '泉州市', '漳州市', '南平市', '龙岩市', '宁德市'] },
  {
    name: '江西省',
    cities: ['南昌市', '景德镇市', '萍乡市', '九江市', '新余市', '鹰潭市', '赣州市', '吉安市', '宜春市', '抚州市', '上饶市'],
  },
  {
    name: '山东省',
    cities: [
      '济南市', '青岛市', '淄博市', '枣庄市', '东营市', '烟台市', '潍坊市', '济宁市', '泰安市', '威海市',
      '日照市', '临沂市', '德州市', '聊城市', '滨州市', '菏泽市',
    ],
  },
  {
    name: '河南省',
    cities: [
      '郑州市', '开封市', '洛阳市', '平顶山市', '安阳市', '鹤壁市', '新乡市', '焦作市', '濮阳市', '许昌市',
      '漯河市', '三门峡市', '南阳市', '商丘市', '信阳市', '周口市', '驻马店市',
      // 省直辖县级行政区
      '济源市',
    ],
  },
  {
    name: '湖北省',
    cities: [
      '武汉市', '黄石市', '十堰市', '宜昌市', '襄阳市', '鄂州市', '荆门市', '孝感市', '荆州市', '黄冈市',
      '咸宁市', '随州市', '恩施土家族苗族自治州',
      // 省直辖县级行政区
      '仙桃市', '潜江市', '天门市', '神农架林区',
    ],
  },
  {
    name: '湖南省',
    cities: [
      '长沙市', '株洲市', '湘潭市', '衡阳市', '邵阳市', '岳阳市', '常德市', '张家界市', '益阳市', '郴州市',
      '永州市', '怀化市', '娄底市', '湘西土家族苗族自治州',
    ],
  },
  {
    name: '广东省',
    cities: [
      '广州市', '韶关市', '深圳市', '珠海市', '汕头市', '佛山市', '江门市', '湛江市', '茂名市', '肇庆市',
      '惠州市', '梅州市', '汕尾市', '河源市', '阳江市', '清远市', '东莞市', '中山市', '潮州市', '揭阳市',
      '云浮市',
    ],
  },
  {
    name: '广西壮族自治区',
    cities: [
      '南宁市', '柳州市', '桂林市', '梧州市', '北海市', '防城港市', '钦州市', '贵港市', '玉林市', '百色市',
      '贺州市', '河池市', '来宾市', '崇左市',
    ],
  },
  {
    name: '海南省',
    cities: [
      '海口市', '三亚市', '三沙市', '儋州市',
      // 省直辖县级行政区
      '五指山市', '琼海市', '文昌市', '万宁市', '东方市', '定安县', '屯昌县', '澄迈县', '临高县',
      '白沙黎族自治县', '昌江黎族自治县', '乐东黎族自治县', '陵水黎族自治县', '保亭黎族苗族自治县',
      '琼中黎族苗族自治县',
    ],
  },
  {
    name: '四川省',
    cities: [
      '成都市', '自贡市', '攀枝花市', '泸州市', '德阳市', '绵阳市', '广元市', '遂宁市', '内江市', '乐山市',
      '南充市', '眉山市', '宜宾市', '广安市', '达州市', '雅安市', '巴中市', '资阳市',
      '阿坝藏族羌族自治州', '甘孜藏族自治州', '凉山彝族自治州',
    ],
  },
  {
    name: '贵州省',
    cities: ['贵阳市', '六盘水市', '遵义市', '安顺市', '毕节市', '铜仁市', '黔西南布依族苗族自治州', '黔东南苗族侗族自治州', '黔南布依族苗族自治州'],
  },
  {
    name: '云南省',
    cities: [
      '昆明市', '曲靖市', '玉溪市', '保山市', '昭通市', '丽江市', '普洱市', '临沧市', '楚雄彝族自治州',
      '红河哈尼族彝族自治州', '文山壮族苗族自治州', '西双版纳傣族自治州', '大理白族自治州',
      '德宏傣族景颇族自治州', '怒江傈僳族自治州', '迪庆藏族自治州',
    ],
  },
  { name: '西藏自治区', cities: ['拉萨市', '日喀则市', '昌都市', '林芝市', '山南市', '那曲市', '阿里地区'] },
  {
    name: '陕西省',
    cities: ['西安市', '铜川市', '宝鸡市', '咸阳市', '渭南市', '延安市', '汉中市', '榆林市', '安康市', '商洛市'],
  },
  {
    name: '甘肃省',
    cities: [
      '兰州市', '嘉峪关市', '金昌市', '白银市', '天水市', '武威市', '张掖市', '平凉市', '酒泉市', '庆阳市',
      '定西市', '陇南市', '临夏回族自治州', '甘南藏族自治州',
    ],
  },
  {
    name: '青海省',
    cities: [
      '西宁市', '海东市', '海北藏族自治州', '黄南藏族自治州', '海南藏族自治州', '果洛藏族自治州',
      '玉树藏族自治州', '海西蒙古族藏族自治州',
    ],
  },
  { name: '宁夏回族自治区', cities: ['银川市', '石嘴山市', '吴忠市', '固原市', '中卫市'] },
  {
    name: '新疆维吾尔自治区',
    cities: [
      '乌鲁木齐市', '克拉玛依市', '吐鲁番市', '哈密市', '昌吉回族自治州', '博尔塔拉蒙古自治州',
      '巴音郭楞蒙古自治州', '阿克苏地区', '克孜勒苏柯尔克孜自治州', '喀什地区', '和田地区',
      '伊犁哈萨克自治州', '塔城地区', '阿勒泰地区',
      // 自治区直辖县级行政区
      '石河子市', '阿拉尔市', '图木舒克市', '五家渠市', '北屯市', '铁门关市', '双河市', '可克达拉市',
      '昆玉市', '胡杨河市', '新星市', '白杨市',
    ],
  },
  {
    name: '台湾省',
    cities: [
      '台北市', '新北市', '桃园市', '台中市', '台南市', '高雄市', '基隆市', '新竹市', '嘉义市', '新竹县',
      '苗栗县', '彰化县', '南投县', '云林县', '嘉义县', '屏东县', '宜兰县', '花莲县', '台东县', '澎湖县',
    ],
  },
  { name: '香港特别行政区', cities: ['香港特别行政区'] },
  { name: '澳门特别行政区', cities: ['澳门特别行政区'] },
]

/**
 * 县级热门目的地 -> 所属地级行政区。
 * 只参与地址文本匹配（「广西阳朔县」也能归到桂林），不出现在选择器里，
 * 免得城市列表混进与行政级别不一致的县级条目。
 * legacy 是旧版本字典里作为城市存过的值，筛选时要一并带上，避免老活动筛不出来。
 */
const CITY_ALIASES = [
  { name: '阳朔', city: '桂林市', legacy: ['阳朔县'] },
  { name: '义乌', city: '金华市' },
  { name: '昆山', city: '苏州市' },
  { name: '都江堰', city: '成都市' },
  { name: '峨眉山', city: '乐山市' },
  { name: '九寨沟', city: '阿坝藏族羌族自治州' },
  { name: '稻城', city: '甘孜藏族自治州' },
  { name: '香格里拉', city: '迪庆藏族自治州', legacy: ['香格里拉市'] },
  { name: '平遥', city: '晋中市' },
  { name: '婺源', city: '上饶市' },
  { name: '敦煌', city: '酒泉市' },
  { name: '曲阜', city: '济宁市' },
]

/** 去掉「市」后缀，作为统一的城市标识 */
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

/** 县级热门地名反查所属地级行政区：「阳朔 / 阳朔县」都能认出来 */
function aliasByName(name) {
  const value = String(name || '').trim()
  if (!value) return null
  const bare = value.replace(/[县市区]$/, '')
  for (let i = 0; i < CITY_ALIASES.length; i += 1) {
    const item = CITY_ALIASES[i]
    if (value !== item.name && bare !== item.name) continue
    const target = cityByName(item.city)
    if (target) return { province: target.province, city: target.city, key: target.key }
  }
  return null
}

/** 省份简称：去掉「省 / 市 / 自治区 / 特别行政区」与民族名称，用于省名模糊匹配 */
function provinceShortName(name) {
  return String(name || '').replace(
    /(省|市|自治区|特别行政区|维吾尔|壮族|回族|蒙古|藏族|苗族|侗族|土家族|彝族|白族|傣族|哈萨克|朝鲜族|羌族)/g,
    ''
  )
}

/** 按省名 / 省简称找到省份，不是省份时返回 null */
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
 * 所选地区 -> 归一化城市列表，与前端 utils/cities.js 的 regionCityKeys 保持一致：
 * 空值返回 []（不过滤），城市返回单城，省份返回全省城市。
 * 城市优先于省份，避免「吉林」这类与省简称同名的城市把范围放大到全省。
 * 只做「地区 -> 城市」的规范化，用于存值；筛选请用 filterCityKeys（多带一份老数据里的县级值）。
 * @returns {string[]}
 */
function regionCityKeys(region) {
  const value = String(region || '').trim()
  // 「全部 / 全国」是选择器的展示文案，语义等同空值
  if (!value || value === '全部' || value === '全国') return []
  if (cityByName(value)) return [normalizeCity(value)]
  // 县级热门地名：「阳朔县」按桂林筛选、也按桂林存储
  const alias = aliasByName(value)
  if (alias) return [alias.key]
  const province = provinceByName(value)
  if (province) return province.cities.map((city) => normalizeCity(city))
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

/** 县级别名 -> 地级行政区（按别名长度倒序，避免短名误匹配） */
const ALIAS_ENTRIES = CITY_ALIASES.map((item) => {
  const target = cityByName(item.city)
  return target
    ? {
        name: item.name,
        province: target.province,
        city: target.city,
        key: target.key,
        legacy: item.legacy || [],
      }
    : null
})
  .filter(Boolean)
  .sort((a, b) => b.name.length - a.name.length)

/** 归属城市 -> 旧版字典存过的县级值：按城市 / 省份筛选时要一并带上 */
const LEGACY_KEYS = ALIAS_ENTRIES.reduce((acc, item) => {
  if (!item.legacy.length) return acc
  acc[item.key] = (acc[item.key] || []).concat(item.legacy)
  return acc
}, {})

/** 在筛选城市列表后补上老数据里的县级值，保证历史活动仍能被筛到 */
function withLegacyKeys(keys) {
  const out = keys.slice()
  keys.forEach((key) => {
    const legacyKeys = LEGACY_KEYS[key] || []
    legacyKeys.forEach((legacyKey) => {
      if (out.indexOf(legacyKey) === -1) out.push(legacyKey)
    })
  })
  return out
}

/**
 * 筛选用的城市列表：在 regionCityKeys 基础上补上旧版字典存过的县级值。
 * 例：按「桂林」筛选 -> ['桂林', '阳朔县']，按「广西壮族自治区」筛选会同时带上「阳朔县」。
 * @returns {string[]}
 */
function filterCityKeys(region) {
  return withLegacyKeys(regionCityKeys(region))
}

/** 省内县级别名匹配：「云南香格里拉」在省名命中后落到迪庆藏族自治州 */
function aliasInProvince(provinceName, text) {
  for (let i = 0; i < ALIAS_ENTRIES.length; i += 1) {
    const item = ALIAS_ENTRIES[i]
    if (item.province === provinceName && text.indexOf(item.name) > -1) return item.key
  }
  return ''
}

/**
 * 从地址文本中匹配城市
 * 策略：文本命中省份名则优先在省内匹配；省名在文本里但省内匹配不到时，
 * 继续全局最长城市名匹配，最后再看县级别名。
 * @returns {string} 归一化城市名，未命中返回 ''
 */
function matchCity(address) {
  const text = String(address || '')
  if (!text) return ''

  for (let i = 0; i < PROVINCE_NAMES.length; i += 1) {
    const provinceName = PROVINCE_NAMES[i]
    const short = provinceName.replace(/(省|市|自治区|特别行政区|维吾尔|壮族|回族|蒙古|藏族|苗族|侗族|土家族|彝族|白族|傣族|哈萨克|朝鲜族|羌族|自治州|地区)/g, '')
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
    if (matched) return matched
    // 「青海省海南藏族自治州」会先命中同名省简称「海南」，这里不能就此判定城市为空
    const alias = aliasInProvince(province.name, text)
    if (alias) return alias
  }

  for (let i = 0; i < ALL_CITIES.length; i += 1) {
    const item = ALL_CITIES[i]
    if (item.key.length >= 2 && text.indexOf(item.key) > -1) {
      return item.key
    }
  }

  for (let i = 0; i < ALIAS_ENTRIES.length; i += 1) {
    if (text.indexOf(ALIAS_ENTRIES[i].name) > -1) return ALIAS_ENTRIES[i].key
  }
  return ''
}

/**
 * 地区值 -> 单个城市，只落到唯一城市时才算数（省份 / 全部 / 未知值返回 ''）。
 *
 * 用于「发布者当前城市」兜底：集合地点写不出城市（如手输「双流区润和路附近」）时，
 * 把活动归到发布者所在城市，避免 city 为空、按城市筛选永远查不到。
 * @param {string} region 地区值：城市名 / 省名 / 空
 * @returns {string} 归一化城市名，无法唯一确定时返回 ''
 */
function singleCityKey(region) {
  const keys = regionCityKeys(region)
  return keys.length === 1 ? keys[0] : ''
}

module.exports = {
  PROVINCES,
  CITY_ALIASES,
  ALL_CITIES,
  normalizeCity,
  cityByName,
  aliasByName,
  provinceShortName,
  provinceByName,
  regionCityKeys,
  filterCityKeys,
  singleCityKey,
  matchCity,
}
