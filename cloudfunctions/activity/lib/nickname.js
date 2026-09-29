// 新用户的默认昵称与默认头像配色（随机生成）。
//
// 为什么不用微信默认的「微信用户」+ 灰色头像：微信自 2021-04-13 / 2022-10-25 起只下发
// 「微信用户」+ 灰色默认头像，用户不点「完善头像昵称」前，报名名单与活动卡片上全是一模一样的
// 「微信用户」和灰头像，同行的人根本认不出谁是谁。所以这里在注册时就随机生成一个户外调性的
// 昵称（如「山野阿狼」「云边小鹿」），头像用昵称首字 + 随机配色画色块，既有区分度也不含个人信息。
//
// 三条口径：
// 1) 词库都是中性、户外组队调性的词，不落真实姓名、不落手机号（昵称对外可见）；
// 2) 生成的昵称只是默认值，用户可以在「完善头像昵称」里改成微信昵称或任意昵称；
// 3) 本文件与 utils/nickname.js 内容一致（云函数打包时只上传自己的目录，
//    require 不到小程序根目录的文件，所以两边各留一份，改动时必须同时改）。

/** 无头像时的色块备选（与 lib/helper.js 的兜底色一致） */
const AVATAR_COLORS = [
  '#4ECDC4',
  '#45B7D1',
  '#FF8E72',
  '#F6D365',
  '#00CDAC',
  '#FA709A',
  '#44A08D',
  '#A8DADC',
  '#FF7D00',
]

/** 默认昵称前缀：意境词 */
const NICK_PREFIX = [
  '山野',
  '云边',
  '溪谷',
  '松林',
  '向阳',
  '星野',
  '落日',
  '雨后',
  '远方',
  '麦田',
  '萤火',
  '野径',
  '晨雾',
  '竹影',
  '晴川',
  '海风',
]

/** 默认昵称后缀：拟人或拟物的称呼词 */
const NICK_SUFFIX = [
  '阿狼',
  '小鹿',
  '松鼠',
  '山雀',
  '阿柚',
  '小满',
  '阿哲',
  '大鹏',
  '麦子',
  '阿岩',
  '小舟',
  '青鸟',
  '团子',
  '阿岚',
  '阿宽',
  '小野',
  '山客',
  '阿澄',
]

/** 历史遗留的默认昵称：老版本固定「微信用户」，后来是「微信用户 + 编号」 */
const DEFAULT_NICK = /^微信用户\d*$/

function isDefaultNick(nickName) {
  const value = String(nickName || '').trim()
  return !value || DEFAULT_NICK.test(value)
}

function pick(list) {
  return list[Math.floor(Math.random() * list.length)]
}

/** 随机默认昵称，如「山野阿狼」；16 × 18 = 288 种组合 */
function randomNickName() {
  return `${pick(NICK_PREFIX)}${pick(NICK_SUFFIX)}`
}

/**
 * 默认头像配色。
 * 按用户编号轮转而不是纯随机：相邻注册的用户颜色一定不同，报名名单里一眼能分开。
 */
function avatarColorOf(userId) {
  const id = Math.abs(Math.floor(Number(userId) || 0))
  return AVATAR_COLORS[id % AVATAR_COLORS.length]
}

module.exports = {
  AVATAR_COLORS,
  NICK_PREFIX,
  NICK_SUFFIX,
  DEFAULT_NICK,
  isDefaultNick,
  randomNickName,
  avatarColorOf,
}
