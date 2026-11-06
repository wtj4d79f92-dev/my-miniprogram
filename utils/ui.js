// 统一交互反馈：Toast / 确认弹窗
function toast(title, icon) {
  wx.showToast({
    title: title || '',
    icon: icon || 'none',
    duration: 1800,
  })
}

function loading(title) {
  wx.showLoading({ title: title || '加载中', mask: true })
}

function hideLoading() {
  try {
    wx.hideLoading()
  } catch (e) {
    // 忽略未展示的 loading
  }
}

/** Promise 化的确认弹窗 */
function confirm(options) {
  const opts = options || {}
  return new Promise((resolve) => {
    wx.showModal({
      title: opts.title || '提示',
      content: opts.content || '',
      showCancel: opts.showCancel !== false,
      cancelText: opts.cancelText || '取消',
      confirmText: opts.confirmText || '确定',
      confirmColor: opts.confirmColor || '#00B578',
      success: (res) => resolve(!!res.confirm),
      fail: () => resolve(false),
    })
  })
}

/** 校验失败提示 */
function tips(content) {
  return confirm({ title: '提示', content, showCancel: false, confirmText: '知道了' })
}

function positiveNumber(value, fallback) {
  const number = Number(value)
  return Number.isFinite(number) && number > 0 ? number : fallback
}

/** 顶部内容与微信胶囊按钮之间保留的空隙。 */
const TOP_BAR_MENU_GAP = 8

/**
 * 页面首行与微信右上角胶囊按钮共用一条导航行。
 * padding-top 定位到胶囊顶部，剩余高度等于胶囊高度，子元素在其中垂直居中；
 * padding-right 为右上角胶囊按钮留位，顶部内容可以铺满定位与胶囊之间的空间。
 */
function buildTopBarStyle(menuRect, windowInfo) {
  const info = windowInfo || {}
  const safeArea = info.safeArea || {}
  const statusBarHeight = positiveNumber(info.statusBarHeight || safeArea.top, 20)
  const rect = menuRect || {}
  const top = positiveNumber(rect.top, statusBarHeight)
  const height = positiveNumber(rect.height, 32)
  const windowWidth = positiveNumber(info.windowWidth || info.screenWidth, 375)
  // 极端情况下拿不到 left 时，按常见胶囊宽度和右边距估算，避免中间内容压到系统按钮下方。
  const menuLeft = positiveNumber(rect.left, windowWidth - 7 - 87)
  const menuRightInset = Math.max(0, windowWidth - menuLeft) + TOP_BAR_MENU_GAP
  return `height: ${top + height}px; padding-top: ${top}px; padding-right: ${Math.ceil(menuRightInset)}px;`
}

/** 读取当前设备的胶囊按钮坐标，异常时退回状态栏与标准导航行高度。 */
function getTopBarStyle() {
  let menuRect = {}
  let windowInfo = {}
  try {
    if (typeof wx !== 'undefined' && typeof wx.getMenuButtonBoundingClientRect === 'function') {
      menuRect = wx.getMenuButtonBoundingClientRect() || {}
    }
  } catch (e) {
    menuRect = {}
  }
  try {
    if (typeof wx !== 'undefined' && typeof wx.getWindowInfo === 'function') {
      windowInfo = wx.getWindowInfo() || {}
    } else if (typeof wx !== 'undefined' && typeof wx.getSystemInfoSync === 'function') {
      windowInfo = wx.getSystemInfoSync() || {}
    }
  } catch (e) {
    windowInfo = {}
  }
  if (!windowInfo.statusBarHeight && typeof getApp === 'function') {
    const app = getApp()
    windowInfo.statusBarHeight =
      app && app.globalData && app.globalData.statusBarHeight
  }
  return buildTopBarStyle(menuRect, windowInfo)
}

/**
 * 设置页面标题。
 *
 * 全站用的是自定义导航栏（app.json navigationStyle: custom），标题不会显示在界面上，
 * 但系统和微信搜一搜会记录它，用来理解页面内容——官方「小程序搜索优化指南」明确建议
 * 通过 wx.setNavigationBarTitle 设置清晰的页面标题，对搜索收录和曝光转化都有帮助。
 * 同一个标题重复设置没有意义，这里做个去重，避免 onShow 频繁调用。
 */
let lastPageTitle = ''
function setPageTitle(title) {
  const text = String(title || '').trim()
  if (!text || text === lastPageTitle) return
  if (typeof wx === 'undefined' || typeof wx.setNavigationBarTitle !== 'function') return
  lastPageTitle = text
  wx.setNavigationBarTitle({
    title: text,
    fail: () => {
      // 标题只是搜索优化的辅助信息，设置失败不影响页面功能
      lastPageTitle = ''
    },
  })
}

module.exports = {
  toast,
  loading,
  hideLoading,
  confirm,
  tips,
  buildTopBarStyle,
  getTopBarStyle,
  setPageTitle,
}
