// 服务端城市字典副本：与前端 utils/cities.js 的 PROVINCES / normalizeCity / matchCity 保持一致
// 云函数打包时只会上传本目录，无法 require 小程序根目录的文件，因此这里保留一份镜像。
// 只保留「地址文本 -> 城市」需要的部分，经纬度就近匹配（nearestCity）属于定位兜底，留在前端。

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

/** 去掉「市」后缀，作为统一的城市标识 */
function normalizeCity(name) {
  const value = String(name || '').trim()
  if (!value) return ''
  return value.replace(/市$/, '')
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

module.exports = {
  PROVINCES,
  ALL_CITIES,
  normalizeCity,
  matchCity,
}
