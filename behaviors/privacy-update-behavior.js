const {
  needsPrivacyUpdate,
  acknowledgePrivacy,
} = require('../utils/privacy-notice')

/**
 * 隐私政策更新提示：由当前页面挂载的半屏组件展示，避免跳离用户正在浏览的页面。
 * 页面 WXML 需提供 id="privacy-update-modal" 的组件。
 */
module.exports = Behavior({
  methods: {
    openPrivacyUpdateFromNotice() {
      const app = getApp()
      if (!app || !app.globalData || !app.globalData.privacyUpdatePending) return false
      const user = this.data.user || app.globalData.user
      if (!needsPrivacyUpdate(user)) {
        app.globalData.privacyUpdatePending = false
        return false
      }
      const modal = this.selectComponent('#privacy-update-modal')
      if (!modal || typeof modal.open !== 'function') return false
      app.globalData.privacyUpdatePending = false
      modal.open()
      return true
    },

    /** 关闭不等于同意：只清理本次待打开状态，下次启动仍会提醒。 */
    onPrivacyUpdateClose() {
      const app = getApp()
      if (app && app.globalData) app.globalData.privacyUpdatePending = false
    },

    /** 当前页阅读完并确认后记录版本，弹窗关闭但页面与滚动位置不变。 */
    onPrivacyUpdateAgree() {
      const app = getApp()
      const user = this.data.user || (app && app.globalData && app.globalData.user)
      acknowledgePrivacy(user)
      if (app && app.globalData) app.globalData.privacyUpdatePending = false
    },
  },
})
