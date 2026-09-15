// 本地存储统一封装：所有 key 集中管理，读写失败静默降级
const KEYS = {
  selectedCity: 'aa_selected_city',
  pendingType: 'square_pending_type',
  user: 'my_user',
  userCounter: 'my_user_counter',
  published: 'my_published',
  joined: 'my_joined',
  feedback: 'my_feedback',
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

function removeStorage(key) {
  try {
    wx.removeStorageSync(key)
    return true
  } catch (e) {
    return false
  }
}

module.exports = { KEYS, getStorage, setStorage, removeStorage }
