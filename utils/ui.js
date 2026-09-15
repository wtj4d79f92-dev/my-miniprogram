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

module.exports = { toast, loading, hideLoading, confirm, tips }
