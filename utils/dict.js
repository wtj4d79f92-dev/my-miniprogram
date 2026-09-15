// 全局字典：活动类型、标签、难度、星期筛选、默认横幅、默认文案

/** 活动类型字典（key / 名称 / emoji / 主题色 / 渐变） */
const ACTIVITY_TYPES = [
  { key: 'hiking', name: '徒步', emoji: '🌿', color: '#4ECDC4', from: '#84fab0', to: '#8fd3f4' },
  { key: 'climbing', name: '爬山', emoji: '🥾', color: '#43cea2', from: '#43cea2', to: '#185a9d' },
  { key: 'driving', name: '自驾游', emoji: '🚗', color: '#45B7D1', from: '#89F7FE', to: '#66A6FF' },
  { key: 'camping', name: '露营', emoji: '⛺', color: '#F6D365', from: '#f6d365', to: '#fda085' },
  { key: 'cycling', name: '骑行', emoji: '🚴', color: '#44A08D', from: '#a8edea', to: '#fed6e3' },
  { key: 'ball', name: '打球', emoji: '🏀', color: '#FF8E72', from: '#FFB88C', to: '#FF8E72' },
  { key: 'fitness', name: '健身', emoji: '💪', color: '#FA709A', from: '#ffecd2', to: '#fcb69f' },
  { key: 'running', name: '跑步', emoji: '🏃', color: '#FFD93D', from: '#ffecd2', to: '#fcb69f' },
  { key: 'swimming', name: '游泳', emoji: '🏊', color: '#00CDAC', from: '#74ebd5', to: '#9face6' },
  { key: 'other', name: '其他', emoji: '🎉', color: '#A8DADC', from: '#E0EAFC', to: '#CFDEF3' },
]

/** 活动标签（仅自驾游 / 徒步 / 爬山可选） */
const ACTIVITY_TAGS = [
  { key: 'needOwner', name: '缺车主' },
  { key: 'needPassenger', name: '缺乘客' },
]

/** 带标签能力的类型 */
const TAG_TYPES = ['driving', 'hiking', 'climbing']
/** 带难度 / 全程 / 爬升的类型 */
const METRIC_TYPES = ['hiking', 'climbing']

/** 难度 1-10 星 */
const DIFFICULTY_OPTIONS = Array.from({ length: 10 }, (_, i) => {
  const star = i + 1
  return { value: star, label: `${star}星`, short: `${star}★` }
})

/** 集合时间（星期）筛选 */
const WEEKDAY_OPTIONS = [
  { value: -1, label: '不限日期' },
  { value: 1, label: '周一' },
  { value: 2, label: '周二' },
  { value: 3, label: '周三' },
  { value: 4, label: '周四' },
  { value: 5, label: '周五' },
  { value: 6, label: '周六' },
  { value: 0, label: '周日' },
]

/** 广场排序 */
const SORT_OPTIONS = [
  { value: 'time', label: '即将开始' },
  { value: 'latest', label: '最新发布' },
  { value: 'hot', label: '最热门' },
]

/** 默认横幅（后台无数据时使用，与云函数默认数据保持一致） */
const DEFAULT_BANNERS = [
  {
    _id: 'banner_default_1',
    title: '周末去山里走走吧',
    subtitle: '徒步 / 爬山 / 露营 一起出发',
    emoji: '🏕️',
    bg: 'linear-gradient(135deg, #84fab0 0%, #8fd3f4 100%)',
    action: { type: 'square', value: 'hiking' },
    sort: 1,
  },
  {
    _id: 'banner_default_2',
    title: '组局打球不孤单',
    subtitle: '篮球 / 足球 / 羽毛球 在线约战',
    emoji: '🏀',
    bg: 'linear-gradient(135deg, #FFB88C 0%, #FF8E72 100%)',
    action: { type: 'square', value: 'ball' },
    sort: 2,
  },
  {
    _id: 'banner_default_3',
    title: '想去看海呀',
    subtitle: '自驾拼车 说走就走',
    emoji: '🌊',
    bg: 'linear-gradient(135deg, #89F7FE 0%, #66A6FF 100%)',
    action: { type: 'publish' },
    sort: 3,
  },
]

/** 默认文案 */
const TEXTS = {
  appName: '旷行吖',
  slogan: '和志同道合的人一起出发',
  searchPlaceholderHome: '搜活动、地点，加入AA搭伙人',
  searchPlaceholderSquare: '搜索活动、地点',
  footer: '— 和志同道合的人一起出发 —',
  version: '旷行吖 v1.0.0',
  about:
    '旷行吖是一款户外运动组队小程序，支持自驾游、徒步、打球、骑行、健身、游泳、露营等玩法，一键发起活动、快速摇人组队。',
  coastSlogan: '和喜欢的人一起出发',
  defaultPosterTitle: 'AA组队',
  defaultPosterSubtitle: '和志同道合的人一起出发',
}

const TYPE_MAP = ACTIVITY_TYPES.reduce((acc, item) => {
  acc[item.key] = item
  return acc
}, {})

const TAG_MAP = ACTIVITY_TAGS.reduce((acc, item) => {
  acc[item.key] = item
  return acc
}, {})

/** 根据 key 取类型素材，未知类型回退到「其他」 */
function getType(key) {
  return TYPE_MAP[key] || TYPE_MAP.other
}

/** 组装出可直接绑定到 style 的渐变背景 */
function typeGradient(key) {
  const type = getType(key)
  return `linear-gradient(135deg, ${type.from} 0%, ${type.to} 100%)`
}

/** 类型是否支持标签 */
function supportsTags(key) {
  return TAG_TYPES.indexOf(key) > -1
}

/** 类型是否支持难度 / 全程 / 爬升 */
function supportsMetrics(key) {
  return METRIC_TYPES.indexOf(key) > -1
}

function tagName(key) {
  return (TAG_MAP[key] && TAG_MAP[key].name) || ''
}

/** 类型网格：9 个玩法 + 其他 */
const TYPE_GRID = ACTIVITY_TYPES

module.exports = {
  ACTIVITY_TYPES,
  TYPE_GRID,
  TYPE_MAP,
  ACTIVITY_TAGS,
  TAG_MAP,
  TAG_TYPES,
  METRIC_TYPES,
  DIFFICULTY_OPTIONS,
  WEEKDAY_OPTIONS,
  SORT_OPTIONS,
  DEFAULT_BANNERS,
  TEXTS,
  getType,
  typeGradient,
  supportsTags,
  supportsMetrics,
  tagName,
}
