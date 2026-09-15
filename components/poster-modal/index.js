// 分享海报：750 x 1280 竖版画布，生成后可保存相册 / 长按转发
const ui = require('../../utils/ui')

const WIDTH = 750
const HEIGHT = 1280

Component({
  options: {
    styleIsolation: 'apply-shared',
  },

  data: {
    visible: false,
    generating: true,
    activity: null,
  },

  methods: {
    open(activity) {
      this._activity = activity
      this._tempFilePath = ''
      this.setData({
        visible: true,
        generating: true,
        activity: Object.assign({}, activity, {
          dateText: activity.dateText || '',
          feeText: activity.feeText || '',
        }),
      }, () => {
        // 等待 canvas 节点渲染完成后再绘制
        this.draw(activity)
      })
      return Promise.resolve()
    },

    close() {
      this.setData({ visible: false })
    },

    noop() {},

    getCanvas() {
      return new Promise((resolve) => {
        this.createSelectorQuery()
          .select('#poster-canvas')
          .fields({ node: true, size: true })
          .exec((res) => {
            const node = res && res[0] && res[0].node
            resolve(node || null)
          })
      })
    },

    draw(activity) {
      this.getCanvas()
        .then((canvas) => {
          if (!canvas) {
            this.setData({ generating: false })
            ui.toast('海报生成失败，请重试')
            return null
          }
          const ctx = canvas.getContext('2d')
          canvas.width = WIDTH
          canvas.height = HEIGHT
          return this.paint(ctx, canvas, activity).then(() => canvas)
        })
        .then((canvas) => {
          if (!canvas) return null
          return this.toTempFile(canvas)
        })
        .then((path) => {
          this._tempFilePath = path || ''
          this.setData({ generating: false })
        })
        .catch(() => {
          this.setData({ generating: false })
          ui.toast('海报生成失败，请重试')
        })
    },

    paint(ctx, canvas, activity) {
      const act = activity || {}
      // 1. 浅绿到浅蓝白渐变背景
      const background = ctx.createLinearGradient(0, 0, WIDTH, HEIGHT)
      background.addColorStop(0, '#EAFBF3')
      background.addColorStop(1, '#E8F3FB')
      ctx.fillStyle = background
      ctx.fillRect(0, 0, WIDTH, HEIGHT)

      // 2. 左上角白色圆角框：小程序码（云端生成，缺失时占位）
      this.roundRect(ctx, 48, 48, 200, 200, 28)
      ctx.fillStyle = '#FFFFFF'
      ctx.fill()
      ctx.fillStyle = '#9AA5B1'
      ctx.font = '24px sans-serif'
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      ctx.fillText('小程序码', 148, 148)

      // 3. 右上角品牌名与口号
      ctx.textAlign = 'right'
      ctx.textBaseline = 'alphabetic'
      ctx.fillStyle = '#2D3748'
      ctx.font = 'bold 42px sans-serif'
      ctx.fillText('AA搭伙人', 702, 116)
      ctx.fillStyle = '#718096'
      ctx.font = '24px sans-serif'
      ctx.fillText('和喜欢的人一起出发', 702, 158)

      // 4. 中部标题（最多两行）
      ctx.textAlign = 'left'
      ctx.fillStyle = '#2D3748'
      ctx.font = 'bold 44px sans-serif'
      this.wrapText(ctx, act.title || '活动组队', 48, 340, 654, 60, 2)

      // 5. 活动二维码
      ctx.fillStyle = '#718096'
      ctx.font = '28px sans-serif'
      ctx.fillText('活动二维码', 48, 486)

      this.roundRect(ctx, 48, 512, 654, 424, 32)
      ctx.fillStyle = '#FFFFFF'
      ctx.fill()

      return this.drawGroupQr(ctx, canvas, act).then(() => {
        ctx.textAlign = 'center'
        ctx.fillStyle = '#718096'
        ctx.font = '26px sans-serif'
        ctx.fillText('扫码报名 加入活动', 375, 976)

        // 6. 底部白卡：活动要求
        this.roundRect(ctx, 48, 1004, 654, 240, 32)
        ctx.fillStyle = '#FFFFFF'
        ctx.fill()

        const rows = [
          ['集合时间', `${act.dateText || ''}`],
          ['集合地点', `${act.location || ''}`],
          ['费用与人数', `${act.feeText || 'AA制'} · ${act.peopleText || ''}`],
        ]
        ctx.textAlign = 'left'
        rows.forEach((row, index) => {
          const y = 1052 + index * 42
          ctx.fillStyle = '#718096'
          ctx.font = '24px sans-serif'
          ctx.fillText(row[0], 80, y)
          ctx.fillStyle = '#2D3748'
          ctx.font = '26px sans-serif'
          this.wrapText(ctx, row[1], 220, y, 450, 36, 1)
        })

        ctx.fillStyle = '#718096'
        ctx.font = '24px sans-serif'
        ctx.fillText('活动介绍', 80, 1178)
        ctx.fillStyle = '#2D3748'
        ctx.font = '26px sans-serif'
        this.wrapText(ctx, act.desc || '暂无活动介绍，报名前可与发起人沟通确认。', 220, 1178, 450, 36, 2)
      })
    },

    /** 群二维码：有本地图片则绘制，否则绘制占位文案 */
    drawGroupQr(ctx, canvas, act) {
      const src = act.groupQrCode
      if (!src || src.indexOf('mock://') === 0) {
        ctx.textAlign = 'center'
        ctx.fillStyle = '#C4CFCF'
        ctx.font = '28px sans-serif'
        ctx.fillText('活动群二维码', 375, 706)
        ctx.font = '24px sans-serif'
        ctx.fillText('发布活动时可上传', 375, 750)
        return Promise.resolve()
      }
      return new Promise((resolve) => {
        const image = canvas.createImage()
        image.onload = () => {
          ctx.drawImage(image, 225, 566, 300, 300)
          resolve()
        }
        image.onerror = () => {
          ctx.textAlign = 'center'
          ctx.fillStyle = '#C4CFCF'
          ctx.font = '28px sans-serif'
          ctx.fillText('活动群二维码', 375, 706)
          resolve()
        }
        image.src = src
      })
    },

    roundRect(ctx, x, y, w, h, r) {
      ctx.beginPath()
      ctx.moveTo(x + r, y)
      ctx.lineTo(x + w - r, y)
      ctx.arcTo(x + w, y, x + w, y + r, r)
      ctx.lineTo(x + w, y + h - r)
      ctx.arcTo(x + w, y + h, x + w - r, y + h, r)
      ctx.lineTo(x + r, y + h)
      ctx.arcTo(x, y + h, x, y + h - r, r)
      ctx.lineTo(x, y + r)
      ctx.arcTo(x, y, x + r, y, r)
      ctx.closePath()
    },

    /** 文本换行，最多 maxLines 行，超长以省略号结尾 */
    wrapText(ctx, text, x, y, maxWidth, lineHeight, maxLines) {
      const content = String(text || '')
      let line = ''
      let lines = 0
      for (let i = 0; i < content.length; i += 1) {
        const next = line + content[i]
        if (ctx.measureText(next).width > maxWidth) {
          lines += 1
          if (lines >= maxLines) {
            let clipped = line
            while (clipped.length > 1 && ctx.measureText(`${clipped}…`).width > maxWidth) {
              clipped = clipped.slice(0, -1)
            }
            ctx.fillText(`${clipped}…`, x, y + (lines - 1) * lineHeight)
            return
          }
          ctx.fillText(line, x, y + (lines - 1) * lineHeight)
          line = content[i]
        } else {
          line = next
        }
      }
      ctx.fillText(line, x, y + lines * lineHeight)
    },

    toTempFile(canvas) {
      return new Promise((resolve) => {
        wx.canvasToTempFilePath(
          {
            canvas,
            x: 0,
            y: 0,
            width: WIDTH,
            height: HEIGHT,
            destWidth: WIDTH,
            destHeight: HEIGHT,
            fileType: 'png',
            success: (res) => resolve(res.tempFilePath),
            fail: () => resolve(''),
          },
          this
        )
      })
    },

    save() {
      const path = this._tempFilePath
      if (!path) {
        ui.toast('海报还在生成中，请稍候')
        return
      }
      wx.saveImageToPhotosAlbum({
        filePath: path,
        success: () => ui.toast('已保存到相册', 'success'),
        fail: (err) => {
          const message = (err && err.errMsg) || ''
          if (message.indexOf('auth deny') > -1 || message.indexOf('authorize') > -1) {
            ui.confirm({
              title: '需要相册权限',
              content: '保存海报需要相册权限，是否前往设置开启？',
              confirmText: '去设置',
            }).then((ok) => {
              if (ok) wx.openSetting({})
            })
            return
          }
          ui.toast('保存失败，请重试')
        },
      })
    },

    forward() {
      const path = this._tempFilePath
      if (!path) {
        ui.toast('海报还在生成中，请稍候')
        return
      }
      if (wx.showShareImageMenu) {
        wx.showShareImageMenu({ path })
      } else {
        ui.toast('请长按海报保存后转发')
      }
    },
  },
})
