Component({
  data: {
    // 整屏登录页需要独占屏幕时置为 true
    hidden: false,
    selected: 0,
    list: [
      { pagePath: '/pages/home/home', text: '首页', icon: 'home' },
      { pagePath: '/pages/square/index', text: '广场', icon: 'square' },
      { pagePath: '/pages/usercenter/index', text: '我的', icon: 'user' },
    ],
  },

  methods: {
    switchTab(e) {
      const index = e.currentTarget.dataset.index
      const item = this.data.list[index]
      if (!item) return
      const current = this.data.list[this.data.selected]
      if (current && current.pagePath === item.pagePath) return
      this.setData({ selected: index })
      wx.switchTab({
        url: item.pagePath,
        // 极端情况下 switchTab 静默失败会让底部导航"点了没反应"，兜底回到目标页
        fail: () => wx.reLaunch({ url: item.pagePath }),
      })
    },
  },
})
