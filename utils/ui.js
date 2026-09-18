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

module.exports = { toast, loading, hideLoading, confirm, tips, setPageTitle }
