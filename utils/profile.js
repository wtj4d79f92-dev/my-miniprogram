// 用户资料相关的小工具：默认昵称判定 + 是否需要引导完善 + 头像临时文件上传
//
// 背景：微信自 2021-04-13 起不再通过 wx.getUserInfo 返回真实昵称头像，2022-10-25 起
// wx.getUserProfile 也一并回收，统一只给「微信用户」+ 灰色默认头像。现在唯一能拿到真实
// 昵称头像的官方能力是「头像昵称填写能力」（<button open-type="chooseAvatar"> +
// <input type="nickname">），必须由用户点一次，小程序无法静默获取。
// 所以这里的口径是：新用户注册后立刻引导一次，点两下即可带上微信头像与昵称。
const config = require('../services/config')
// 默认昵称判定与默认头像配色统一在 utils/nickname.js（与云端 lib/nickname.js 同一份口径）
const { isDefaultNick } = require('./nickname')

/**
 * 本机临时头像路径。
 *
 * 历史版本把 `chooseAvatar` / `chooseMedia` 给到的 `wxfile://...`、`http://tmp/...` 直接落库了，
 * 这类地址只在当前这台设备本次会话里有效：别人打开活动看到的是空白头像，自己换设备 / 重装后
 * 也不显示（详见 README 硬约束第 11 条）。落库前必须先换成云文件 ID。
 */
const TEMP_AVATAR = /^(wxfile:\/\/|https?:\/\/tmp\/)/i

function isTempAvatar(url) {
  return TEMP_AVATAR.test(String(url || '').trim())
}

/**
 * 能落库、能展示的头像地址：本机临时路径一律当作「没有头像」。
 *
 * 兜底的是历史脏数据 —— 之前用临时路径存过头像的账号，头像本身是坏的，这里按空值处理，
 * 于是会重新出现「完善头像昵称」提示，用户重选一次就自动修好了。
 */
function usableAvatar(url) {
  const value = String(url || '').trim()
  return isTempAvatar(value) ? '' : value
}

/**
 * 是否需要引导完善头像昵称（未登录返回 false）。
 *
 * 现在注册时就会随机生成昵称（如「山野阿狼」），所以判定口径是「还没选过微信头像」，
 * 外加历史遗留的「微信用户 / 微信用户 + 编号」——那种昵称在报名名单里分不出谁是谁，仍要引导。
 */
function needProfileSetup(user) {
  if (!user || !user.openid) return false
  return !usableAvatar(user.avatarUrl) || isDefaultNick(user.nickName)
}

/**
 * 头像临时文件上传云存储。
 *
 * chooseAvatar 给到的是本机临时路径（真机 wxfile://，开发者工具 http://tmp/...），直接落库
 * 别人打开活动看到的是空白头像，自己换设备 / 重进也不显示，所以云模式先换成云文件 ID。
 * 与发布页 uploadFiles 对封面 / 二维码的处理同一口径：本机临时路径不能按 http 前缀放过。
 * Mock 模式、没选图、已经是云文件时原样返回。
 *
 * @param {string} source chooseAvatar 拿到的路径或已保存的头像地址
 * @returns {Promise<string>} 云文件 ID（上传失败时 reject）
 */
function uploadAvatar(source) {
  const path = String(source || '')
  if (!path || config.useMock || path.indexOf('cloud://') === 0) return Promise.resolve(path)
  if (typeof wx === 'undefined' || !wx.cloud || !wx.cloud.uploadFile) return Promise.resolve(path)
  const ext = (path.match(/\.([a-zA-Z0-9]+)(?:\?|$)/) || [])[1] || 'png'
  return new Promise((resolve, reject) => {
    wx.cloud.uploadFile({
      cloudPath: `avatar/${Date.now()}-${Math.floor(Math.random() * 100000)}.${ext}`,
      filePath: path,
      success: (res) => resolve((res && res.fileID) || ''),
      fail: () => reject(new Error('头像上传失败，请检查网络后重试')),
    })
  })
}

/**
 * 是不是本次登录刚建档的新用户。
 * 只在刚注册时弹一次完善引导，老用户（已完善或主动跳过过）不用每次登录都被拦一下，
 * 他们仍然可以从「我的 → 完善头像昵称」入口主动改。
 */
const NEW_USER_WINDOW = 5 * 60 * 1000
function isFreshUser(user) {
  const created = Number((user && user.createTime) || 0)
  return created > 0 && Date.now() - created < NEW_USER_WINDOW
}

module.exports = { isDefaultNick, isTempAvatar, usableAvatar, needProfileSetup, uploadAvatar, isFreshUser }
