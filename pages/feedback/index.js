const api = require('../../services/api')
const ui = require('../../utils/ui')

Page({
  data: {
    content: '',
    count: 0,
    submitting: false,
  },

  onInput(e) {
    const value = String(e.detail.value || '').slice(0, 500)
    this.setData({ content: value, count: value.length })
  },

  submit() {
    if (this.data.submitting) return
    const content = String(this.data.content || '').trim()
    if (!content) {
      ui.toast('请先填写反馈内容')
      return
    }
    if (content.length < 5) {
      ui.toast('反馈内容至少 5 个字')
      return
    }
    this.setData({ submitting: true })
    wx.showLoading({ title: '提交中', mask: true })
    api
      .feedback({ content })
      .then(() => {
        wx.hideLoading()
        this.setData({ submitting: false, content: '', count: 0 })
        ui.toast('提交成功，感谢反馈', 'success')
        setTimeout(() => {
          const pages = getCurrentPages()
          if (pages.length > 1) {
            wx.navigateBack({ delta: 1 })
          } else {
            wx.switchTab({ url: '/pages/usercenter/index' })
          }
        }, 1200)
      })
      .catch(() => {
        wx.hideLoading()
        this.setData({ submitting: false })
        ui.toast('提交失败，请重试')
      })
  },
})
