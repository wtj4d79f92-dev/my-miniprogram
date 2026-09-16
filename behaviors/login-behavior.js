// 登录守卫：需要登录的操作统一走「全屏登录页 → 登录成功 → 继续原操作」
const { KEYS, getStorage } = require('../utils/storage')

module.exports = Behavior({
  methods: {
    /**
     * 当前登录用户（不触发登录流程）
     * 以 globalData / 本地缓存为准：页面 data.user 可能在启动校验前就已经赋值，是旧值
     */
    currentUser() {
      const app = getApp()
      const user = (app && app.globalData && app.globalData.user) || getStorage(KEYS.user, null)
      return user && user.openid ? user : null
    },

    /** 等待 App 启动时的登录态校验，避免拿失效的本地缓存放行 */
    whenUserReady() {
      const app = getApp()
      const ready = app && app.userReady
      return ready && typeof ready.then === 'function' ? ready : Promise.resolve(null)
    },

    /**
     * 打开登录页（Mock 为手机号模拟登录，云模式为微信一键登录 / 手机号授权）
     * @param {string} reason 触发登录的原因，登录页会简要展示
     */
    openLoginModal(reason) {
      const modal = this.selectComponent('#login-modal')
      if (!modal) return Promise.resolve(null)
      return modal.open(reason)
    },

    /**
     * 登录守卫
     * @param {string} reason 触发登录的原因，登录页会简要展示
     * @returns {Promise<object|null>} 登录后的用户，取消返回 null
     */
    ensureLogin(reason) {
      return this.whenUserReady().then(() => {
        const user = this.currentUser()
        if (user) return user
        // 登录页自带「暂不登录」取消入口，不再额外弹一次系统确认框
        return this.openLoginModal(reason || '该操作需要登录')
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
