// 分享海报：750 x 1280 竖版离屏画布，生成后可保存相册 / 长按转发
const ui = require('../../utils/ui')
const api = require('../../services/api')
const { TEXTS } = require('../../utils/dict')

const WIDTH = 750
const HEIGHT = 1280

Component({
  options: {
    styleIsolation: 'apply-shared',
  },

  data: {
    visible: false,
    generating: true,
    posterPath: '',
    activity: null,
  },

  methods: {
    open(activity) {
      this._activity = activity
      this._tempFilePath = ''
      this.setData({
        visible: true,
        generating: true,
        posterPath: '',
        activity: Object.assign({}, activity, {
          dateText: activity.dateText || '',
          feeText: activity.feeText || '',
        }),
      })
      this.draw(activity)
      return Promise.resolve()
    },

    close() {
      this.setData({ visible: false })
    },

    noop() {},

    /** 离屏画布：不受页面节点渲染时机影响，生成结果以图片形式预览 */
    createCanvas() {
      if (typeof wx.createOffscreenCanvas !== 'function') return null
      try {
        return wx.createOffscreenCanvas({ type: '2d', width: WIDTH, height: HEIGHT })
      } catch (err) {
        return null
      }
    },

    /** 海报所需的两张二维码图片来源：小程序码（云函数懒生成）+ 活动群二维码 */
    loadAssets(activity) {
      const act = activity || {}
      return Promise.all([this.loadMiniQr(act), this.toLocalPath(act.groupQrCode)]).then((res) => ({
        miniQr: res[0],
        groupQr: res[1],
      }))
    },

    /** 云端懒生成活动小程序码并缓存，失败返回空串（海报回落到占位文案） */
    loadMiniQr(activity) {
      const id = (activity && activity.id) || ''
      if (!id) return Promise.resolve('')
      // 同一活动的小程序码本地路径复用，避免重复调用云函数与下载
      this._miniQrCache = this._miniQrCache || {}
      if (this._miniQrCache[id] !== undefined) return Promise.resolve(this._miniQrCache[id])
      return Promise.resolve()
        .then(() => api.qrcode(id))
        .then((res) => this.toLocalPath(res && res.fileID))
        .catch(() => '')
        .then((path) => {
          // 仅在成功取到码图时缓存，失败下次仍可重试
          if (path) this._miniQrCache[id] = path
          return path
        })
    },

    /** 云存储 fileID / 本地临时路径 → 可直接绘制到 canvas 的本地路径 */
    toLocalPath(src) {
      const source = String(src || '')
      if (!source || source.indexOf('mock://') === 0) return Promise.resolve('')
      if (source.indexOf('cloud://') !== 0 || !wx.cloud || !wx.cloud.downloadFile) {
        return Promise.resolve(source)
      }
      this._fileCache = this._fileCache || {}
      if (this._fileCache[source]) return Promise.resolve(this._fileCache[source])
      return new Promise((resolve) => {
        wx.cloud.downloadFile({
          fileID: source,
          success: (res) => {
            const path = (res && res.tempFilePath) || ''
            if (path) this._fileCache[source] = path
            resolve(path)
          },
          fail: () => resolve(''),
        })
      })
    },

    /** 在指定区域内等比缩放并居中绘制本地图片，返回是否绘制成功 */
    drawImageFit(ctx, canvas, src, box) {
      if (!src) return Promise.resolve(false)
      return new Promise((resolve) => {
        let settled = false
        const finish = (ok) => {
          if (settled) return
          settled = true
          resolve(ok)
        }
        const image = canvas.createImage()
        image.onload = () => {
          if (settled) return
          const width = image.width || box.w
          const height = image.height || box.h
          // 等比缩放，长边贴合区域
          const scale = Math.min(box.w / width, box.h / height)
          const drawWidth = width * scale
          const drawHeight = height * scale
          ctx.drawImage(
            image,
            box.x + (box.w - drawWidth) / 2,
            box.y + (box.h - drawHeight) / 2,
            drawWidth,
            drawHeight
          )
          finish(true)
        }
        image.onerror = () => finish(false)
        image.src = src
        // 兜底超时：图片迟迟不回调时按失败处理，避免海报一直停在「生成中」
        setTimeout(() => finish(false), 5000)
      })
    },

    draw(activity) {
      const canvas = this.createCanvas()
      if (!canvas) {
        this.setData({ generating: false })
        ui.toast('当前微信版本不支持生成海报')
        return
      }
      const ctx = canvas.getContext('2d')
      // 两张二维码图片（小程序码 / 群二维码）先备齐，再整体绘制并导出图片
      this.loadAssets(activity)
        .then((assets) => this.paint(ctx, canvas, activity, assets))
        .then(() => this.toTempFile(canvas))
        .then((path) => {
          this._tempFilePath = path || ''
          this.setData({ generating: false, posterPath: path || '' })
          if (!path) ui.toast('海报生成失败，请重试')
        })
        .catch(() => {
          this.setData({ generating: false })
          ui.toast('海报生成失败，请重试')
        })
    },

    paint(ctx, canvas, activity, assets) {
      const act = activity || {}
      const codes = assets || {}
      // 1. 浅绿到浅蓝白渐变背景
      const background = ctx.createLinearGradient(0, 0, WIDTH, HEIGHT)
      background.addColorStop(0, '#EAFBF3')
      background.addColorStop(1, '#E8F3FB')
      ctx.fillStyle = background
      ctx.fillRect(0, 0, WIDTH, HEIGHT)

      // 2. 左上角白色圆角框：小程序码（云端生成并缓存，取不到时占位）
      this.roundRect(ctx, 48, 48, 200, 200, 28)
      ctx.fillStyle = '#FFFFFF'
      ctx.fill()

      // 3. 右上角品牌名与口号
      ctx.textAlign = 'right'
      ctx.textBaseline = 'alphabetic'
      ctx.fillStyle = '#2D3748'
      ctx.font = 'bold 42px sans-serif'
      ctx.fillText(TEXTS.appName, 702, 116)
      ctx.fillStyle = '#718096'
      ctx.font = '24px sans-serif'
      ctx.fillText(TEXTS.slogan, 702, 158)

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

      return this.drawMiniQr(ctx, canvas, codes.miniQr)
        .then(() => this.drawGroupQr(ctx, canvas, codes.groupQr))
        .then(() => {
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

    /** 小程序码：白色圆角框内绘制码图，缺失时保留占位文案 */
    drawMiniQr(ctx, canvas, src) {
      return this.drawImageFit(ctx, canvas, src, { x: 60, y: 60, w: 176, h: 176 }).then((drawn) => {
        if (drawn) return
        ctx.textAlign = 'center'
        ctx.textBaseline = 'middle'
        ctx.fillStyle = '#9AA5B1'
        ctx.font = '24px sans-serif'
        ctx.fillText('小程序码', 148, 148)
        // 还原基线，避免影响后续文案排版
        ctx.textBaseline = 'alphabetic'
      })
    },

    /** 活动群二维码：有图则绘制，否则绘制占位文案 */
    drawGroupQr(ctx, canvas, src) {
      return this.drawImageFit(ctx, canvas, src, { x: 75, y: 545, w: 600, h: 340 }).then((drawn) => {
        if (drawn) return
        ctx.textAlign = 'center'
        ctx.textBaseline = 'alphabetic'
        ctx.fillStyle = '#C4CFCF'
        ctx.font = '28px sans-serif'
        ctx.fillText('活动群二维码', 375, 706)
        ctx.font = '24px sans-serif'
        ctx.fillText('发布活动时可上传', 375, 750)
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
        let settled = false
        const finish = (path) => {
          if (settled) return
          settled = true
          resolve(path)
        }
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
            success: (res) => finish(res.tempFilePath),
            fail: () => finish(''),
          },
          this
        )
        // 兜底超时：导出迟迟不回调时结束等待，避免海报一直停在「生成中」
        setTimeout(() => finish(''), 8000)
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
