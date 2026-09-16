// 服务端字典副本：与前端 utils/dict.js 保持一致
// 云函数打包时只会上传本目录，无法 require 小程序根目录的文件，因此这里保留一份镜像。
// 修改类型 / 标签 / 默认横幅时，两处都要改。

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

/** 带标签能力的类型 */
const TAG_TYPES = ['driving', 'hiking', 'climbing']
/** 带难度 / 全程 / 爬升的类型 */
const METRIC_TYPES = ['hiking', 'climbing']
/** 合法标签 key */
const TAG_KEYS = ['needOwner', 'needPassenger']

/** 默认横幅：banners 集合为空时由 home 接口写入 */
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

const TYPE_MAP = ACTIVITY_TYPES.reduce((acc, item) => {
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

function supportsTags(key) {
  return TAG_TYPES.indexOf(key) > -1
}

function supportsMetrics(key) {
  return METRIC_TYPES.indexOf(key) > -1
}

/** 过滤掉字典外的标签，避免前端传入任意值 */
function sanitizeTags(tags) {
  if (!Array.isArray(tags)) return []
  return tags.filter((key) => TAG_KEYS.indexOf(key) > -1)
}

module.exports = {
  ACTIVITY_TYPES,
  TAG_TYPES,
  METRIC_TYPES,
  TAG_KEYS,
  DEFAULT_BANNERS,
  getType,
  typeGradient,
  supportsTags,
  supportsMetrics,
  sanitizeTags,
}
