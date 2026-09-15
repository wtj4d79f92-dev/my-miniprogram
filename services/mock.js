// Mock 数据模型：活动生成器 + 本地缓存读写，操作结果落到本地存储
const { KEYS, getStorage, setStorage } = require('../utils/storage')
const { getType, DEFAULT_BANNERS, tagName } = require('../utils/dict')
const { createRandom, pickInt, deepClone, startOfDay } = require('../utils/util')

const MOCK_JOIN_MAP = 'mock_join_map'
const MOCK_STATUS_MAP = 'mock_status_map'

/** 活动种子数据：覆盖多城市、多类型、多星期、招募中 / 已关闭 */
const SEEDS = [
  { city: '北京', type: 'hiking', title: '香山轻装徒步 · 看层林尽染', location: '北京市海淀区 香山公园东门', difficulty: 3, distance: 12, climb: 420, fee: 0, max: 12, tags: [], day: 2, hour: 8, joined: 7 },
  { city: '北京', type: 'cycling', title: '环青海湖？不，先环雁栖湖', location: '北京市怀柔区 雁栖湖环湖路', difficulty: 0, distance: 0, climb: 0, fee: 0, max: 15, tags: [], day: 4, hour: 7, joined: 9 },
  { city: '北京', type: 'climbing', title: '箭扣长城野线穿越（有难度）', location: '北京市怀柔区 箭扣长城', difficulty: 7, distance: 15, climb: 900, fee: 0, max: 10, tags: ['needPassenger'], day: 6, hour: 6, joined: 8 },
  { city: '北京', type: 'ball', title: '周三晚 篮球 5v5 缺 2 人', location: '北京市朝阳区 望京体育公园', difficulty: 0, distance: 0, climb: 0, fee: 30, max: 10, tags: [], day: 1, hour: 20, joined: 8 },
  { city: '北京', type: 'camping', title: '灵山露营看日出 · 自带装备', location: '北京市门头沟区 灵山风景区', difficulty: 0, distance: 0, climb: 0, fee: 120, max: 8, tags: [], day: 3, hour: 15, joined: 4 },
  { city: '上海', type: 'running', title: '滨江夜跑 8 公里 · 配速 6 分', location: '上海市徐汇区 龙腾大道滨江步道', difficulty: 0, distance: 0, climb: 0, fee: 0, max: 20, tags: [], day: 1, hour: 19, joined: 12 },
  { city: '上海', type: 'hiking', title: '佘山轻徒步 + 天马山雷达站', location: '上海市松江区 佘山国家森林公园', difficulty: 2, distance: 10, climb: 260, fee: 0, max: 14, tags: [], day: 5, hour: 9, joined: 6 },
  { city: '上海', type: 'driving', title: '周末莫干山自驾拼车', location: '上海市闵行区 沪闵路集合点', difficulty: 0, distance: 0, climb: 0, fee: 150, max: 8, tags: ['needPassenger'], day: 6, hour: 7, joined: 5 },
  { city: '上海', type: 'swimming', title: '游泳打卡 · 自由泳 1500 米', location: '上海市浦东新区 源深游泳馆', difficulty: 0, distance: 0, climb: 0, fee: 45, max: 6, tags: [], day: 2, hour: 20, joined: 3 },
  { city: '广州', type: 'hiking', title: '火炉山穿越 · 新手友好', location: '广东省广州市 火炉山森林公园', difficulty: 2, distance: 9, climb: 300, fee: 0, max: 16, tags: [], day: 3, hour: 9, joined: 11 },
  { city: '广州', type: 'ball', title: '周六下午 羽毛球双打约战', location: '广东省广州市 天河体育中心', difficulty: 0, distance: 0, climb: 0, fee: 25, max: 8, tags: [], day: 5, hour: 14, joined: 7 },
  { city: '深圳', type: 'hiking', title: '东西涌海岸线穿越（需体力）', location: '广东省深圳市 南澳东涌码头', difficulty: 6, distance: 13, climb: 520, fee: 0, max: 12, tags: ['needOwner'], day: 7, hour: 7, joined: 10 },
  { city: '深圳', type: 'cycling', title: '深圳湾夜骑 30 公里', location: '广东省深圳市 深圳湾公园日出剧场', difficulty: 0, distance: 0, climb: 0, fee: 0, max: 20, tags: [], day: 2, hour: 19, joined: 15 },
  { city: '深圳', type: 'fitness', title: '健身房搭子 · 练背一起卷', location: '广东省深圳市 南山区海岸城健身工作室', difficulty: 0, distance: 0, climb: 0, fee: 60, max: 6, tags: [], day: 1, hour: 19, joined: 4 },
  { city: '杭州', type: 'hiking', title: '九溪—龙井—满觉陇 慢走团', location: '浙江省杭州市 九溪公交站', difficulty: 2, distance: 11, climb: 380, fee: 0, max: 18, tags: [], day: 4, hour: 9, joined: 14 },
  { city: '杭州', type: 'camping', title: '青山湖草坪露营 · 天幕已备', location: '浙江省杭州市 青山湖国家森林公园', difficulty: 0, distance: 0, climb: 0, fee: 80, max: 10, tags: [], day: 6, hour: 14, joined: 6 },
  { city: '杭州', type: 'running', title: '西湖晨跑 10 公里', location: '浙江省杭州市 断桥残雪', difficulty: 0, distance: 0, climb: 0, fee: 0, max: 20, tags: [], day: 0, hour: 6, joined: 9 },
  { city: '成都', type: 'climbing', title: '赵公山穿越 · 云海日出', location: '四川省成都市 都江堰赵公山', difficulty: 5, distance: 14, climb: 1100, fee: 0, max: 10, tags: ['needPassenger'], day: 5, hour: 5, joined: 8 },
  { city: '成都', type: 'driving', title: '川西小环线拼车 3 天', location: '四川省成都市 天府广场集合', difficulty: 0, distance: 0, climb: 0, fee: 380, max: 8, tags: ['needPassenger', 'needOwner'], day: 8, hour: 7, joined: 6 },
  { city: '成都', type: 'ball', title: '周五晚 足球 7 人制', location: '四川省成都市 锦江区体育公园', difficulty: 0, distance: 0, climb: 0, fee: 40, max: 14, tags: [], day: 2, hour: 20, joined: 12 },
  { city: '武汉', type: 'hiking', title: '东湖绿道徒步 18 公里', location: '湖北省武汉市 东湖磨山北门', difficulty: 3, distance: 18, climb: 150, fee: 0, max: 20, tags: [], day: 3, hour: 8, joined: 13 },
  { city: '武汉', type: 'swimming', title: '泳池拉练 · 蛙泳技术交流', location: '湖北省武汉市 洪山体育馆游泳馆', difficulty: 0, distance: 0, climb: 0, fee: 35, max: 8, tags: [], day: 4, hour: 19, joined: 5 },
  { city: '西安', type: 'climbing', title: '华山北峰夜爬 · 看日出', location: '陕西省西安市 华山游客中心', difficulty: 8, distance: 16, climb: 1500, fee: 0, max: 10, tags: ['needOwner'], day: 6, hour: 18, joined: 9 },
  { city: '西安', type: 'cycling', title: '秦岭分水岭骑行挑战', location: '陕西省西安市 沣峪口', difficulty: 0, distance: 0, climb: 0, fee: 0, max: 12, tags: [], day: 7, hour: 6, joined: 7 },
  { city: '重庆', type: 'hiking', title: '缙云山狮子峰徒步', location: '重庆市北碚区 缙云山健身梯道', difficulty: 4, distance: 12, climb: 700, fee: 0, max: 14, tags: [], day: 4, hour: 8, joined: 10 },
  { city: '南京', type: 'hiking', title: '紫金山环线 · 头陀岭登顶', location: '江苏省南京市 紫金山索道口', difficulty: 3, distance: 13, climb: 480, fee: 0, max: 16, tags: [], day: 2, hour: 7, joined: 11 },
  { city: '南京', type: 'other', title: '周末桌游局 · 狼人杀开黑', location: '江苏省南京市 新街口桌游吧', difficulty: 0, distance: 0, climb: 0, fee: 50, max: 10, tags: [], day: 5, hour: 14, joined: 6 },
  { city: '长沙', type: 'hiking', title: '岳麓山—桃花岭连穿', location: '湖南省长沙市 岳麓山东门', difficulty: 3, distance: 12, climb: 520, fee: 0, max: 15, tags: [], day: 3, hour: 8, joined: 9 },
  { city: '厦门', type: 'cycling', title: '环岛路骑行 + 看日落', location: '福建省厦门市 环岛路音乐广场', difficulty: 0, distance: 0, climb: 0, fee: 0, max: 18, tags: [], day: 1, hour: 16, joined: 12 },
  { city: '厦门', type: 'camping', title: '鼓浪屿对岸沙滩露营', location: '福建省厦门市 观音山沙滩', difficulty: 0, distance: 0, climb: 0, fee: 100, max: 8, tags: [], day: 6, hour: 15, joined: 5 },
]

/** Mock 用户池：作为活动发起人 / 报名成员 */
const MOCK_USERS = [
  { openid: 'mock_u_1', nickName: '山野阿宽', avatarColor: '#4ECDC4', avatarText: '山' },
  { openid: 'mock_u_2', nickName: '小满去爬山', avatarColor: '#FF8E72', avatarText: '满' },
  { openid: 'mock_u_3', nickName: '阿哲不卷了', avatarColor: '#45B7D1', avatarText: '哲' },
  { openid: 'mock_u_4', nickName: '柠檬骑行记', avatarColor: '#F6D365', avatarText: '柠' },
  { openid: 'mock_u_5', nickName: '周末不宅家', avatarColor: '#00CDAC', avatarText: '周' },
  { openid: 'mock_u_6', nickName: '老K的球局', avatarColor: '#FF7D00', avatarText: 'K' },
  { openid: 'mock_u_7', nickName: '一只露营猫', avatarColor: '#A8DADC', avatarText: '猫' },
  { openid: 'mock_u_8', nickName: '跑者小鹿', avatarColor: '#FA709A', avatarText: '鹿' },
  { openid: 'mock_u_9', nickName: '徒步的菜菜', avatarColor: '#44A08D', avatarText: '菜' },
]

const DESCS = [
  '路线成熟，节奏以能聊天为准，新人也跟得上。中途有补给点，记得带 1L 以上的水和一点能量零食。',
  'AA 组队，不收费。请自备装备与保险意识，全程听领队安排，不擅自离队。',
  '集合后先做 10 分钟热身和路线说明，视天气情况可能微调线路，出发前会在群里同步。',
  '轻松路线，主打拍照和聊天。穿运动鞋即可，欢迎带上会拍照的朋友一起。',
  '强度中等偏低，适合第一次尝试的朋友。结束后可以一起吃个饭，自愿参加。',
]

function currentUser() {
  return getStorage(KEYS.user, null)
}

function normalizeCityName(value) {
  return String(value || '').replace(/市$/, '')
}

/** 生成基础活动列表（稳定的伪随机，保证每次进入数据一致） */
function buildBaseActivities() {
  const random = createRandom(20260906)
  const today = startOfDay(Date.now())
  return SEEDS.map((seed, index) => {
    const type = getType(seed.type)
    const organizer = MOCK_USERS[index % MOCK_USERS.length]
    const startTime = today + seed.day * 86400000 + seed.hour * 3600000
    const endTime = startTime + 86400000
    const members = []
    const memberCount = Math.min(seed.joined, seed.max - 1)
    const offset = pickInt(0, MOCK_USERS.length - 1, random)
    for (let i = 0; i < memberCount; i += 1) {
      const user = MOCK_USERS[(offset + i) % MOCK_USERS.length]
      members.push({
        openid: user.openid,
        nickName: user.nickName,
        avatarColor: user.avatarColor,
        avatarUrl: '',
        avatarText: user.avatarText,
      })
    }
    return {
      id: `mock_act_${index + 1}`,
      _id: `mock_act_${index + 1}`,
      type: seed.type,
      typeName: type.name,
      emoji: type.emoji,
      color: type.color,
      bg: `linear-gradient(135deg, ${type.from} 0%, ${type.to} 100%)`,
      title: seed.title,
      cover: '',
      // Mock 基础数据中部分活动无群二维码，用于覆盖「无二维码直接 Toast」的分支
      groupQrCode: index % 3 === 0 ? 'mock://placeholder' : '',
      desc: DESCS[index % DESCS.length],
      location: seed.location,
      city: seed.city,
      startTime,
      endTime,
      startWeekday: new Date(startTime).getDay(),
      difficulty: seed.difficulty,
      distance: seed.distance,
      elevationGain: seed.climb,
      fee: seed.fee,
      feeMode: seed.fee > 0 ? 'fixed' : 'aa',
      maxPeople: seed.max,
      tags: seed.tags.slice(),
      joinedPeople: members,
      joinedCount: members.length,
      organizer: {
        openid: organizer.openid,
        nickName: organizer.nickName,
        avatarColor: organizer.avatarColor,
        avatarUrl: '',
        avatarText: organizer.avatarText,
      },
      createTime: today + (index - 6) * 7200000,
      status: 'recruiting',
      miniQrCode: '',
    }
  })
}

/** 全部活动 = 基础数据 + 我发布的 + 本地报名 / 关闭状态覆盖 */
function allActivities() {
  const published = getStorage(KEYS.published, []) || []
  const joinMap = getStorage(MOCK_JOIN_MAP, {}) || {}
  const statusMap = getStorage(MOCK_STATUS_MAP, {}) || {}
  const list = buildBaseActivities().concat(published.map((item) => deepClone(item)))
  return list.map((item) => {
    const activity = item
    const extraMembers = joinMap[activity.id] || []
    if (extraMembers.length) {
      const exists = activity.joinedPeople.map((m) => m.openid)
      extraMembers.forEach((member) => {
        if (exists.indexOf(member.openid) === -1) {
          activity.joinedPeople = activity.joinedPeople.concat([member])
          exists.push(member.openid)
        }
      })
    }
    activity.joinedCount = activity.joinedPeople.length
    if (statusMap[activity.id]) {
      activity.status = statusMap[activity.id]
    }
    return activity
  })
}

function findActivity(id) {
  const list = allActivities()
  for (let i = 0; i < list.length; i += 1) {
    if (list[i].id === id || list[i]._id === id) return list[i]
  }
  return null
}

function saveStatus(id, status) {
  const statusMap = getStorage(MOCK_STATUS_MAP, {}) || {}
  statusMap[id] = status
  setStorage(MOCK_STATUS_MAP, statusMap)
}

function saveJoin(activityId, members) {
  const joinMap = getStorage(MOCK_JOIN_MAP, {}) || {}
  joinMap[activityId] = members
  setStorage(MOCK_JOIN_MAP, joinMap)
}

function memberOf(user) {
  return {
    openid: user.openid,
    nickName: user.nickName,
    avatarColor: user.avatarColor,
    avatarUrl: user.avatarUrl || '',
    avatarText: user.avatarText,
  }
}

function cityFilter(list, city) {
  if (!city) return list
  const target = normalizeCityName(city)
  return list.filter((item) => normalizeCityName(item.city) === target)
}

function error(code, message) {
  const err = new Error(message)
  err.code = code
  err.message = message
  return err
}

module.exports = {
  MOCK_USERS,
  MOCK_JOIN_MAP,
  MOCK_STATUS_MAP,
  DEFAULT_BANNERS,
  buildBaseActivities,
  allActivities,
  findActivity,
  saveStatus,
  saveJoin,
  memberOf,
  cityFilter,
  normalizeCityName,
  currentUser,
  error,
  tagName,
}
