// 登录守卫：需要登录的操作统一走「弹窗说明 → 一键登录 → 继续原操作」
const { KEYS, getStorage } = require('../utils/storage')
const ui = require('../utils/ui')

module.exports = Behavior({
  methods: {
    /** 当前登录用户（不触发登录流程） */
    currentUser() {
      return this.data.user || getStorage(KEYS.user, null)
    },

    /** 打开登录弹窗（Mock 为手机号模拟登录，云模式为手机号授权） */
    openLoginModal() {
      const modal = this.selectComponent('#login-modal')
      if (!modal) return Promise.resolve(null)
      return modal.open()
    },

    /**
     * 登录守卫
     * @param {string} reason 弹窗说明文案
     * @returns {Promise<object|null>} 登录后的用户，取消返回 null
     */
    ensureLogin(reason) {
      const user = this.currentUser()
      if (user && user.openid) return Promise.resolve(user)
      return ui
        .confirm({
          title: '需要登录',
          content: reason || '该操作需要登录，是否立即登录？',
          // 注意：showModal 的按钮文案最多 4 个字符
          confirmText: '一键登录',
          cancelText: '暂不登录',
        })
        .then((confirmed) => {
          if (!confirmed) return null
          return this.openLoginModal()
        })
    },

    /** 登录成功后的统一回调：同步 globalData 与页面数据 */
    handleLoginSuccess(user) {
      if (!user) return
      const app = getApp()
      if (app) app.setUser(user)
      this.setData({ user })
      if (typeof this.onUserChanged === 'function') {
        this.onUserChanged(user)
      }
    },
  },
})
