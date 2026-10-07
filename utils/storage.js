// 本地存储统一封装：所有 key 集中管理，读写失败静默降级
const KEYS = {
  selectedCity: 'aa_selected_city',
  pendingType: 'square_pending_type',
  // 首页点搜索框进广场时置位，广场读取后自动聚焦搜索输入框
  pendingSearch: 'square_pending_search',
  user: 'my_user',
  userCounter: 'my_user_counter',
  lastPhone: 'my_last_phone',
  published: 'my_published',
  joined: 'my_joined',
  feedback: 'my_feedback',
  // 首页列表快照：冷启动时先渲染上一次的结果，接口回来再覆盖（纯公开数据，不含个人信息）
  homeCache: 'aa_home_cache',
}

function getStorage(key, fallback) {
  try {
    const value = wx.getStorageSync(key)
    if (value === '' || value === null || value === undefined) {
      return fallback
    }
    return value
  } catch (e) {
    return fallback
  }
}

function setStorage(key, value) {
  try {
    wx.setStorageSync(key, value)
    return true
  } catch (e) {
    return false
  }
}

/**
 * 异步写入：首页列表有几十 KB，同步写入会占着 JS 线程，
 * 布局渲染就在同一个时机，所以这种「写缓存」的场景走异步，失败同样静默降级。
 */
function setStorageAsync(key, value) {
  try {
    wx.setStorage({
      key,
      data: value,
      fail: () => {},
    })
    return true
  } catch (e) {
    return false
  }
}

function removeStorage(key) {
  try {
    wx.removeStorageSync(key)
    return true
  } catch (e) {
    return false
  }
}

module.exports = { KEYS, getStorage, setStorage, setStorageAsync, removeStorage }
