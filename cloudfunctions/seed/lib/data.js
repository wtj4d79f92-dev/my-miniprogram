// 提审演示数据：活动目录 + 文档装配，云函数与本地导出脚本共用的唯一数据源。
//
// 为什么需要它：小程序提审时，审核员看到的是线上云数据库里的真实数据。activities 集合是空的，
// 首页 / 广场就只剩空状态，容易被判成「功能不完整」。这里造一批「审核已通过」的活动，
// 覆盖多城市 / 多类型 / 未来 7 天，让首页热门、广场筛选、详情、报名名单都有内容可看。
//
// 消费方：
// - cloudfunctions/seed/index.js：云端写入 / 刷新 / 清理这批演示数据；
// - scripts/seed-data.js：离线导出 scripts/seed/activities.json，走云开发控制台「导入」。
//
// 字段口径与 cloudfunctions/activity/index.js 的 normalizeForm + create 对齐
// （scripts/validate.js 里有对账断言），改活动字段时这里要一起改。

/** 演示活动的 _id 前缀：清理时只删 demo_act_* 这批，不碰真实用户发布的活动 */
const DEMO_PREFIX = 'demo_act_'
const HOUR_MS = 3600000
const DAY_MS = 86400000
/** 单条演示活动的报名人数上限（受演示用户池容量约束），保证每条都还留得出可报名名额 */
const MAX_JOINED = 14

/** 活动类型字典副本：与 utils/dict.js、cloudfunctions/activity/lib/dict.js 保持一致 */
const TYPES = {
  hiking: { name: '徒步', emoji: '🌿', color: '#4ECDC4', from: '#84fab0', to: '#8fd3f4' },
  climbing: { name: '爬山', emoji: '🥾', color: '#43cea2', from: '#43cea2', to: '#185a9d' },
  driving: { name: '自驾游', emoji: '🚗', color: '#45B7D1', from: '#89F7FE', to: '#66A6FF' },
  camping: { name: '露营', emoji: '⛺', color: '#F6D365', from: '#f6d365', to: '#fda085' },
  cycling: { name: '骑行', emoji: '🚴', color: '#44A08D', from: '#a8edea', to: '#fed6e3' },
  ball: { name: '打球', emoji: '🏀', color: '#FF8E72', from: '#FFB88C', to: '#FF8E72' },
  fitness: { name: '健身', emoji: '💪', color: '#FA709A', from: '#ffecd2', to: '#fcb69f' },
  running: { name: '跑步', emoji: '🏃', color: '#FFD93D', from: '#ffecd2', to: '#fcb69f' },
  swimming: { name: '游泳', emoji: '🏊', color: '#00CDAC', from: '#74ebd5', to: '#9face6' },
  other: { name: '其他', emoji: '🎉', color: '#A8DADC', from: '#E0EAFC', to: '#CFDEF3' },
}
/** 带难度 / 全程 / 爬升的类型 */
const METRIC_TYPES = ['hiking', 'climbing']
/** 带标签能力的类型 */
const TAG_TYPES = ['driving', 'hiking', 'climbing']

/**
 * 演示用户池：充当发起人与报名成员。
 * 容量必须大于 MAX_JOINED，报名名单才能凑够 joinedCount 条，不会出现「18 人报名、名单只有 9 个」。
 */
const DEMO_USERS = [
  { openid: 'demo_u_1', nickName: '山野阿宽', avatarColor: '#4ECDC4', avatarText: '山' },
  { openid: 'demo_u_2', nickName: '小满去爬山', avatarColor: '#FF8E72', avatarText: '满' },
  { openid: 'demo_u_3', nickName: '阿哲不卷了', avatarColor: '#45B7D1', avatarText: '哲' },
  { openid: 'demo_u_4', nickName: '柠檬骑行记', avatarColor: '#F6D365', avatarText: '柠' },
  { openid: 'demo_u_5', nickName: '周末不宅家', avatarColor: '#00CDAC', avatarText: '周' },
  { openid: 'demo_u_6', nickName: '老K的球局', avatarColor: '#FF7D00', avatarText: 'K' },
  { openid: 'demo_u_7', nickName: '一只露营猫', avatarColor: '#A8DADC', avatarText: '猫' },
  { openid: 'demo_u_8', nickName: '跑者小鹿', avatarColor: '#FA709A', avatarText: '鹿' },
  { openid: 'demo_u_9', nickName: '徒步的菜菜', avatarColor: '#44A08D', avatarText: '菜' },
  { openid: 'demo_u_10', nickName: '城南老吴', avatarColor: '#4ECDC4', avatarText: '吴' },
  { openid: 'demo_u_11', nickName: '早八点的风', avatarColor: '#45B7D1', avatarText: '风' },
  { openid: 'demo_u_12', nickName: '半个橙子', avatarColor: '#F6D365', avatarText: '橙' },
  { openid: 'demo_u_13', nickName: '慢慢走就好', avatarColor: '#00CDAC', avatarText: '慢' },
  { openid: 'demo_u_14', nickName: '铁人小张', avatarColor: '#FA709A', avatarText: '张' },
  { openid: 'demo_u_15', nickName: '晚八点球场见', avatarColor: '#FF7D00', avatarText: '球' },
  { openid: 'demo_u_16', nickName: '带娃遛弯儿', avatarColor: '#A8DADC', avatarText: '娃' },
]

/** 活动介绍候选：与 services/mock.js 的 DESCS 同一风格，按顺序循环使用 */
const DEMO_DESCS = [
  '路线成熟，节奏以能聊天为准，新人也跟得上。中途有补给点，记得带 1L 以上的水和一点能量零食。',
  'AA 组队，不额外收费。请自备装备与保险意识，全程听领队安排，不擅自离队。',
  '集合后先做 10 分钟热身和路线说明，视天气情况可能微调线路，出发前会在群里同步。',
  '轻松路线，主打拍照和聊天。穿运动鞋即可，欢迎带上会拍照的朋友一起。',
  '强度中等偏低，适合第一次尝试的朋友。结束后可以一起吃饭，自愿参加。',
  '活动以互相照应为主，不追求速度。遇到体能不支的情况随时说，收队一起走完。',
]

/**
 * 演示活动目录。字段含义：
 * - city / location / address：city 是库里的城市 key（归一化去掉「市」），address 只参与城市匹配与检索、不展示；
 * - lat / lng：集合地点坐标，详情页点地址直接调起导航（为 0 会退化成「在地图上点选位置」）；
 * - day / hour：开始时间 = 今天 00:00 + day 天 + hour 小时，取值 1~7 保证覆盖未来一周与每个星期几；
 * - hours：活动时长（小时），用来算结束时间；
 * - feeNote：非 AA 制的费用说明（纯文字，平台不参与任何资金流转）；留空表示 AA 制；
 * - joined：演示报名人数（上限取 min(joined, maxPeople - 2)，保证列表里的活动都还报得上名）。
 */
const DEMO_SEEDS = [
  { city: '北京', type: 'hiking', title: '香山轻装徒步 · 看层林尽染', location: '香山公园东门', address: '北京市海淀区香山公园东门', lat: 39.9926, lng: 116.195, difficulty: 3, distance: 12, climb: 420, max: 12, day: 2, hour: 8, joined: 7 },
  { city: '北京', type: 'cycling', title: '先环雁栖湖，再去吃虹鳟鱼', location: '雁栖湖环湖路', address: '北京市怀柔区雁栖湖环湖路', lat: 40.397, lng: 116.66, max: 15, day: 4, hour: 7, hours: 5, joined: 9 },
  { city: '北京', type: 'climbing', title: '慕田峪长城徒步 · 错峰出发', location: '慕田峪长城景区', address: '北京市怀柔区慕田峪长城景区', lat: 40.4319, lng: 116.5704, difficulty: 4, distance: 8, climb: 600, max: 10, day: 6, hour: 6, hours: 6, tags: ['needPassenger'], joined: 8 },
  { city: '北京', type: 'ball', title: '周三晚篮球 5v5 缺 2 人', location: '望京体育公园', address: '北京市朝阳区望京体育公园', lat: 39.996, lng: 116.478, max: 10, day: 1, hour: 20, hours: 2, feeNote: '场地费 AA 均摊，人均约 30 元', joined: 8 },
  { city: '北京', type: 'camping', title: '玉渡山露营看日出 · 自带装备', location: '玉渡山风景区', address: '北京市延庆区玉渡山风景区', lat: 40.5122, lng: 115.9003, max: 8, day: 3, hour: 15, hours: 18, feeNote: '营地与装备自理，人均约 120 元', joined: 4 },
  { city: '上海', type: 'running', title: '滨江夜跑 8 公里 · 配速 6 分', location: '龙腾大道滨江步道', address: '上海市徐汇区龙腾大道滨江步道', lat: 31.1811, lng: 121.4596, max: 20, day: 1, hour: 19, hours: 1.5, joined: 12 },
  { city: '上海', type: 'hiking', title: '佘山轻徒步 + 天马山雷达站', location: '佘山国家森林公园', address: '上海市松江区佘山国家森林公园', lat: 31.1008, lng: 121.1868, difficulty: 2, distance: 10, climb: 260, max: 14, day: 5, hour: 9, hours: 5, joined: 6 },
  { city: '上海', type: 'driving', title: '周末莫干山自驾拼车', location: '沪闵路集合点', address: '上海市闵行区沪闵路集合点', lat: 31.11, lng: 121.39, max: 8, day: 6, hour: 7, hours: 10, tags: ['needPassenger'], feeNote: '油费与过路费 AA 均摊，人均约 150 元', joined: 5 },
  { city: '上海', type: 'swimming', title: '游泳打卡 · 自由泳 1500 米', location: '源深游泳馆', address: '上海市浦东新区源深游泳馆', lat: 31.236, lng: 121.529, max: 6, day: 2, hour: 20, hours: 2, feeNote: '场馆门票自理，人均约 45 元', joined: 3 },
  { city: '广州', type: 'hiking', title: '火炉山穿越 · 新手友好', location: '火炉山森林公园', address: '广东省广州市火炉山森林公园', lat: 23.1706, lng: 113.3926, difficulty: 2, distance: 9, climb: 300, max: 16, day: 3, hour: 9, hours: 4, joined: 11 },
  { city: '广州', type: 'ball', title: '周六下午羽毛球双打约战', location: '天河体育中心', address: '广东省广州市天河体育中心', lat: 23.1355, lng: 113.3224, max: 9, day: 5, hour: 14, hours: 3, feeNote: '场地费 AA 均摊，人均约 25 元', joined: 6 },
  { city: '深圳', type: 'hiking', title: '梧桐山登顶（需要体力）', location: '梧桐山北门', address: '广东省深圳市梧桐山北门', lat: 22.5942, lng: 114.2026, difficulty: 5, distance: 12, climb: 700, max: 12, day: 7, hour: 7, hours: 6, tags: ['needOwner'], joined: 10 },
  { city: '深圳', type: 'cycling', title: '深圳湾夜骑 30 公里', location: '深圳湾公园日出剧场', address: '广东省深圳市深圳湾公园日出剧场', lat: 22.4806, lng: 113.9477, max: 20, day: 2, hour: 19, hours: 2.5, joined: 14 },
  { city: '深圳', type: 'fitness', title: '健身房搭子 · 练背一起卷', location: '海岸城健身工作室', address: '广东省深圳市南山区海岸城健身工作室', lat: 22.5198, lng: 113.93, max: 6, day: 1, hour: 19, hours: 2, feeNote: '私教课费用自理，人均约 60 元', joined: 4 },
  { city: '杭州', type: 'hiking', title: '九溪—龙井—满觉陇慢走团', location: '九溪公交站', address: '浙江省杭州市九溪公交站', lat: 30.2076, lng: 120.1178, difficulty: 2, distance: 11, climb: 380, max: 18, day: 4, hour: 9, hours: 5, joined: 14 },
  { city: '杭州', type: 'camping', title: '青山湖草坪露营 · 天幕已备', location: '青山湖国家森林公园', address: '浙江省杭州市青山湖国家森林公园', lat: 30.25, lng: 119.75, max: 10, day: 6, hour: 14, hours: 20, feeNote: '营地费自理，人均约 80 元', joined: 6 },
  { city: '杭州', type: 'running', title: '西湖晨跑 10 公里', location: '断桥残雪', address: '浙江省杭州市断桥残雪', lat: 30.259, lng: 120.149, max: 20, day: 3, hour: 6, hours: 1.5, joined: 9 },
  { city: '成都', type: 'climbing', title: '青城后山徒步 · 溪谷清凉', location: '青城后山泰安古镇', address: '四川省成都市青城后山泰安古镇', lat: 30.9, lng: 103.57, difficulty: 4, distance: 10, climb: 600, max: 10, day: 5, hour: 5, hours: 7, tags: ['needPassenger'], joined: 8 },
  { city: '成都', type: 'driving', title: '川西小环线拼车 3 天', location: '天府广场集合', address: '四川省成都市天府广场', lat: 30.657, lng: 104.066, max: 8, day: 6, hour: 7, hours: 12, tags: ['needPassenger', 'needOwner'], feeNote: '油费 AA 均摊，人均约 380 元', joined: 6 },
  { city: '成都', type: 'ball', title: '周五晚足球 7 人制', location: '锦江区体育公园', address: '四川省成都市锦江区体育公园', lat: 30.63, lng: 104.1, max: 14, day: 2, hour: 20, hours: 2, feeNote: '场地费 AA 均摊，人均约 40 元', joined: 12 },
  { city: '武汉', type: 'hiking', title: '东湖绿道徒步 18 公里', location: '东湖磨山北门', address: '湖北省武汉市东湖磨山北门', lat: 30.572, lng: 114.42, difficulty: 3, distance: 18, climb: 150, max: 20, day: 3, hour: 8, hours: 6, joined: 13 },
  { city: '武汉', type: 'swimming', title: '泳池拉练 · 蛙泳技术交流', location: '洪山体育馆游泳馆', address: '湖北省武汉市洪山体育馆游泳馆', lat: 30.545, lng: 114.37, max: 8, day: 4, hour: 19, hours: 2, feeNote: '门票自理，人均约 35 元', joined: 5 },
  { city: '西安', type: 'climbing', title: '华山北峰夜爬 · 看日出', location: '华山游客中心', address: '陕西省西安市华山游客中心', lat: 34.49, lng: 110.08, difficulty: 8, distance: 16, climb: 1500, max: 10, day: 6, hour: 18, hours: 12, tags: ['needOwner'], joined: 8 },
  { city: '西安', type: 'cycling', title: '秦岭分水岭骑行挑战', location: '沣峪口', address: '陕西省西安市沣峪口', lat: 34.03, lng: 108.86, max: 12, day: 7, hour: 6, hours: 7, joined: 7 },
  { city: '重庆', type: 'hiking', title: '缙云山狮子峰徒步', location: '缙云山健身梯道', address: '重庆市北碚区缙云山健身梯道', lat: 29.84, lng: 106.4, difficulty: 4, distance: 12, climb: 700, max: 14, day: 4, hour: 8, hours: 6, joined: 10 },
  { city: '南京', type: 'hiking', title: '紫金山环线 · 头陀岭登顶', location: '紫金山索道口', address: '江苏省南京市紫金山索道口', lat: 32.07, lng: 118.83, difficulty: 3, distance: 13, climb: 480, max: 16, day: 2, hour: 7, hours: 5, joined: 11 },
  { city: '南京', type: 'other', title: '周末桌游局 · 狼人杀开黑', location: '新街口桌游吧', address: '江苏省南京市新街口桌游吧', lat: 32.043, lng: 118.784, max: 10, day: 5, hour: 14, hours: 4, feeNote: '场地与桌游费 AA 均摊，人均约 50 元', joined: 6 },
  { city: '长沙', type: 'hiking', title: '岳麓山—桃花岭连穿', location: '岳麓山东门', address: '湖南省长沙市岳麓山东门', lat: 28.183, lng: 112.938, difficulty: 3, distance: 12, climb: 520, max: 15, day: 3, hour: 8, hours: 5, joined: 9 },
  { city: '厦门', type: 'cycling', title: '环岛路骑行 + 看日落', location: '环岛路音乐广场', address: '福建省厦门市环岛路音乐广场', lat: 24.47, lng: 118.15, max: 18, day: 1, hour: 16, hours: 3, joined: 12 },
  { city: '厦门', type: 'camping', title: '五缘湾湿地公园野餐 · 天幕已备', location: '五缘湾湿地公园', address: '福建省厦门市五缘湾湿地公园', lat: 24.536, lng: 118.172, max: 8, day: 6, hour: 15, hours: 6, feeNote: '营地费自理，人均约 100 元', joined: 5 },
  { city: '上海', type: 'fitness', title: '晚上撸铁搭子 · 练腿不孤单', location: '静安体育中心健身房', address: '上海市静安区体育中心健身房', lat: 31.2456, lng: 121.4499, max: 6, day: 5, hour: 19, hours: 2, feeNote: '健身卡与私教费自理，人均约 50 元', joined: 4 },
  { city: '广州', type: 'other', title: '珠江边野餐 + 桌游一下午', location: '二沙岛公园', address: '广东省广州市二沙岛公园', lat: 23.1166, lng: 113.3253, max: 12, day: 4, hour: 15, hours: 4, joined: 7 },
]

/** 当天 00:00 的时间戳 */
function startOfDay(now) {
  const date = new Date(now)
  date.setHours(0, 0, 0, 0)
  return date.getTime()
}

/** 展示用的成员快照：与 cloudfunctions/activity/lib/helper.js 的 memberOf 同一结构（不带 openid 下发） */
function memberOf(user) {
  return {
    openid: user.openid,
    nickName: user.nickName,
    avatarColor: user.avatarColor,
    avatarUrl: '',
    avatarText: user.avatarText || user.nickName.slice(0, 1),
  }
}

/** 取 n 个报名成员：从演示用户池按序取，跳过发起人自己 */
function pickMembers(offset, count, organizerOpenid) {
  const members = []
  for (let i = 0; members.length < count && i < DEMO_USERS.length * 2; i += 1) {
    const user = DEMO_USERS[(offset + i) % DEMO_USERS.length]
    if (user.openid === organizerOpenid) continue
    members.push(memberOf(user))
  }
  return members
}

/** 演示活动 id：demo_act_01 ~ demo_act_30，固定不变，重复写入按同一批覆盖 */
function demoId(index) {
  const serial = index + 1 < 10 ? `0${index + 1}` : String(index + 1)
  return `${DEMO_PREFIX}${serial}`
}

/**
 * 装配演示活动文档。
 *
 * @param {number} now 生成时刻（毫秒时间戳），云函数每次调用传当前时间，刷新时只用它平移时间字段
 * @param {{ cover?: string, qr?: string }} [options] 可选的封面 / 群二维码云存储 fileID
 *   （留空时卡片走渐变海报兜底、详情页不出现「查看二维码」入口，都不会出现加载失败的空图）
 * @returns {Array<Object>} 可直接写库的 activity 文档（含 _id / isDemo 标记）
 */
function buildDocs(now, options) {
  const opts = options || {}
  const base = Number(now) || Date.now()
  const dayStart = startOfDay(base)
  const cover = opts.cover || ''
  const qr = opts.qr || ''

  return DEMO_SEEDS.map((seed, index) => {
    const type = TYPES[seed.type] || TYPES.other
    const startTime = dayStart + seed.day * DAY_MS + Math.round(seed.hour * HOUR_MS)
    const hours = seed.hours || 3
    const endTime = startTime + Math.round(hours * HOUR_MS)
    const organizer = DEMO_USERS[index % DEMO_USERS.length]
    // 留出 2 个空位：审核员点进任意一条都能走完报名流程，不会一进去就是「已满员」
    const joinedCount = Math.max(0, Math.min(seed.joined || 0, (seed.max || 10) - 2, MAX_JOINED))
    // 越靠前的种子发布越新：首页「最新发布」取 createTime 倒序 3 条，时间戳不会全挤在同一秒
    const createTime = base - index * 7 * 60 * 1000
    const submitTime = createTime + 60 * 1000
    const auditTime = submitTime + 30 * 1000

    const doc = {
      _id: demoId(index),
      // 清理 / 统计只认这个标记，不碰真实用户发布的活动
      isDemo: true,
      type: seed.type,
      typeName: type.name,
      emoji: type.emoji,
      color: type.color,
      bg: `linear-gradient(135deg, ${type.from} 0%, ${type.to} 100%)`,
      title: seed.title,
      cover,
      groupQrCode: qr,
      desc: DEMO_DESCS[index % DEMO_DESCS.length],
      location: seed.location,
      locationAddress: seed.address,
      locationLat: seed.lat || 0,
      locationLng: seed.lng || 0,
      city: seed.city,
      startTime,
      endTime,
      startWeekday: new Date(startTime).getDay(),
      difficulty: METRIC_TYPES.indexOf(seed.type) > -1 ? seed.difficulty || 0 : 0,
      distance: METRIC_TYPES.indexOf(seed.type) > -1 ? seed.distance || 0 : 0,
      elevationGain: METRIC_TYPES.indexOf(seed.type) > -1 ? seed.climb || 0 : 0,
      feeMode: seed.feeNote ? 'nonAA' : 'aa',
      feeNote: seed.feeNote || '',
      maxPeople: seed.max || 10,
      tags: TAG_TYPES.indexOf(seed.type) > -1 ? seed.tags || [] : [],
      joinedPeople: pickMembers(index * 3, joinedCount, organizer.openid),
      joinedCount,
      organizer: memberOf(organizer),
      createTime,
      submitTime,
      status: 'recruiting',
      closeTime: 0,
      miniQrCode: '',
      // 演示数据直接落「已通过」：审核中 / 未通过的活动只有发起人自己看得到，
      // 审核员打开首页 / 广场时必须已经可见，否则等于什么都没造。
      auditStatus: 'approved',
      auditRemark: '',
      auditTime,
      auditBy: '内容安全检测',
      machineCheck: {
        text: { suggest: 'pass', label: 0, traceId: '', time: submitTime, failed: false },
        // 演示数据没有可送检的云存储图片（封面为空或远程图），留空数组
        images: [],
        // 只有真的配了群二维码才写识别结论，否则审核台会显示一条「二维码检测失败」
        qrcode: qr
          ? { status: 'ok', ok: true, typeName: 'QR_CODE', content: 'https://weixin.qq.com/g/demo', time: submitTime }
          : null,
        checkedAt: submitTime,
      },
      machineReview: false,
      machinePending: false,
    }
    return doc
  })
}

/** 统计：按城市 / 类型 / 起始日期分组，导出与写库后打印用 */
function summarize(docs) {
  const list = docs || []
  const byCity = {}
  const byType = {}
  const byDay = {}
  list.forEach((doc) => {
    byCity[doc.city] = (byCity[doc.city] || 0) + 1
    byType[doc.typeName] = (byType[doc.typeName] || 0) + 1
    const date = new Date(doc.startTime)
    const key = `${date.getMonth() + 1}月${date.getDate()}日`
    byDay[key] = (byDay[key] || 0) + 1
  })
  return { total: list.length, byCity, byType, byDay }
}

module.exports = {
  DEMO_PREFIX,
  DEMO_USERS,
  DEMO_SEEDS,
  TYPES,
  MAX_JOINED,
  buildDocs,
  summarize,
}
