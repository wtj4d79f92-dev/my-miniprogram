// 启动场景：朋友圈「单页模式」的识别
//
// 用户在朋友圈点开分享卡片时，微信不会打开完整小程序，而是进入「单页模式」（场景值 1154）：
// 页面没有登录态（wx.login 等登录相关接口不可用），跳转、分享、报名这类交互也被禁用，
// 云开发资源还必须在控制台开启「允许未登录访问」并配好安全规则才能读取。
// 微信官方建议用「场景值等于 1154」来判断并做页面适配，首页与活动详情共用这里的判定。

const SINGLE_PAGE_SCENE = 1154

/** 本次启动参数：单页模式判断、以及 onLoad 没拿到参数时的兜底都从这里取 */
function launchEntry() {
  try {
    const info =
      (typeof wx.getEnterOptionsSync === 'function' && wx.getEnterOptionsSync()) ||
      (typeof wx.getLaunchOptionsSync === 'function' && wx.getLaunchOptionsSync()) ||
      {}
    return info || {}
  } catch (e) {
    return {}
  }
}

/** 当前是否运行在朋友圈「单页模式」 */
function isSinglePageMode() {
  return Number(launchEntry().scene) === SINGLE_PAGE_SCENE
}

module.exports = { SINGLE_PAGE_SCENE, launchEntry, isSinglePageMode }
