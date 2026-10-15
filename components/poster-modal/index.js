// 分享海报：750 x 1280 竖版离屏画布，生成后可保存相册 / 长按转发
const ui = require('../../utils/ui')
const api = require('../../services/api')
const { TEXTS, getType } = require('../../utils/dict')
const posters = require('../../utils/posters')

const WIDTH = 750
const HEIGHT = 1360
/** 顶部方形海报的高度：运营给的是 1:1 方图，正好占满 750 宽、不裁不拉伸 */
const BANNER_HEIGHT = 750
/** 顶部海报以下各段的基线：改这里就等于改版面，预览框比例见 index.wxss（要与 WIDTH/HEIGHT 一致） */
const TITLE_Y = 802
const INFO_Y = 902
const INFO_GAP = 36
/** 两张二维码的白卡：220 的卡 + 190 的码，卡与卡之间留 60 */
const QR_CARD = 220
const QR_IMAGE = 190
const QR_CARD_Y = 1016
const QR_LEFT_X = 125
const QR_RIGHT_X = 405
const QR_LABEL_Y = 1262
const FOOTER_Y = 1306

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

    /** 海报所需的素材：小程序码（云函数懒生成）+ 活动二维码 + 该活动类型的方形海报 */
    loadAssets(activity) {
      const act = activity || {}
      return Promise.all([
        this.loadMiniQr(act),
        this.toLocalPath(act.groupQrCode),
        // 类型海报是包内图片，探测不到就返回空串，版面回落到渐变底（见 utils/posters.js）
        posters.posterFor(act.type).catch(() => ''),
      ]).then((res) => ({
        miniQr: res[0],
        groupQr: res[1],
        poster: res[2],
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
      // 两张二维码图片（小程序码 / 活动二维码）先备齐，再整体绘制并导出图片
      this.loadAssets(activity)
        .then((assets) => this.paint(ctx, canvas, activity, assets))
        .then(() => this.toTempFile(canvas))
        .then((path) => {
          this._tempFilePath = path || ''
          this.setData({ generating: false, posterPath: path || '' })
          if (!path) ui.toast('海报生成失败，请重试')
        })
        .catch((err) => {
          // 画布异常原来只弹一句「生成失败」，排查时看不到原因，这里补一条日志
          console.error('[poster] 海报生成失败', err)
          this.setData({ generating: false })
          ui.toast('海报生成失败，请重试')
        })
    },

    paint(ctx, canvas, activity, assets) {
      const act = activity || {}
      const codes = assets || {}
      // 1. 浅绿到浅蓝白渐变背景：顶部有类型海报时它只露在信息区，没有海报时就是整张底
      const background = ctx.createLinearGradient(0, 0, WIDTH, HEIGHT)
      background.addColorStop(0, '#EAFBF3')
      background.addColorStop(1, '#E8F3FB')
      ctx.fillStyle = background
      ctx.fillRect(0, 0, WIDTH, HEIGHT)

      // 2. 顶部方形海报：活动类型对应的固定图，等比裁切铺满 750×750。
      //    该类型还没出图时改画一块类型主题色的 hero（见 paintHeroPlaceholder），下面的信息照常排
      return this.drawBanner(ctx, canvas, codes.poster)
        .then((bannerDrawn) => {
          // 海报取不到（该类型还没出图）时，用类型主题色补一块 hero，避免顶部一片空渐变
          if (!bannerDrawn) this.paintHeroPlaceholder(ctx, act)

          // 3. 活动标题（最多两行）。海报上那句是平台 slogan，这里说的是这一场具体活动，不重复
          ctx.textAlign = 'left'
          ctx.textBaseline = 'alphabetic'
          ctx.fillStyle = '#2D3748'
          ctx.font = 'bold 36px sans-serif'
          this.wrapText(ctx, act.title || '活动组队', 48, TITLE_Y, 654, 44, 2)

          // 4. 集合时间 / 集合地点 / 费用与人数 —— 只在有值时占一行，避免空标签占版面
          const rows = [
            ['集合时间', `${act.dateText || ''}`],
            ['集合地点', `${act.location || ''}`],
            ['费用与人数', `${act.feeText || 'AA制'} · ${act.peopleText || ''}`],
          ].filter((row) => String(row[1] || '').replace(/[·\s]/g, ''))
          rows.forEach((row, index) => {
            const y = INFO_Y + index * INFO_GAP
            ctx.fillStyle = '#718096'
            ctx.font = '22px sans-serif'
            ctx.fillText(row[0], 48, y)
            ctx.fillStyle = '#2D3748'
            ctx.font = '24px sans-serif'
            this.wrapText(ctx, row[1], 200, y, 502, 32, 1)
          })

          // 5. 两张二维码并排：左边小程序码（扫码 / 长按进入这场活动），右边活动二维码（进群）
          ;[QR_LEFT_X, QR_RIGHT_X].forEach((x) => {
            this.roundRect(ctx, x, QR_CARD_Y, QR_CARD, QR_CARD, 28)
            ctx.fillStyle = '#FFFFFF'
            ctx.fill()
          })

          return this.drawMiniQr(ctx, canvas, codes.miniQr, {
            x: QR_LEFT_X + (QR_CARD - QR_IMAGE) / 2,
            y: QR_CARD_Y + (QR_CARD - QR_IMAGE) / 2,
            w: QR_IMAGE,
            h: QR_IMAGE,
          })
            .then(() =>
              this.drawGroupQr(
                ctx,
                canvas,
                codes.groupQr,
                {
                  x: QR_RIGHT_X + (QR_CARD - QR_IMAGE) / 2,
                  y: QR_CARD_Y + (QR_CARD - QR_IMAGE) / 2,
                  w: QR_IMAGE,
                  h: QR_IMAGE,
                },
                this.groupQrLabel(act)
              )
            )
            .then(() => {
              // 6. 二维码说明 + 底部品牌行
              ctx.textAlign = 'center'
              ctx.textBaseline = 'alphabetic'
              ctx.fillStyle = '#718096'
              ctx.font = '22px sans-serif'
              ctx.fillText('扫码查看活动', QR_LEFT_X + QR_CARD / 2, QR_LABEL_Y)
              ctx.fillText(this.groupQrLabel(act), QR_RIGHT_X + QR_CARD / 2, QR_LABEL_Y)

              // 顶部没有海报时，hero 区块里已经写过品牌名了，这里不再重复一遍
              if (!bannerDrawn) return
              ctx.fillStyle = '#9AA5B1'
              ctx.font = '22px sans-serif'
              ctx.fillText(`${TEXTS.appName} · ${TEXTS.slogan}`, WIDTH / 2, FOOTER_Y)
            })
        })
    },

    /** 活动二维码的说明文案：个人码写成「扫码进群」会让人以为扫出来是个群 */
    groupQrLabel(activity) {
      const kind = (activity && activity.machineCheck && activity.machineCheck.qrcode
        && activity.machineCheck.qrcode.kind) || 'group'
      return kind === 'personal' ? '扫码加好友' : '扫码进群'
    },

    /** 顶部方形海报：等比裁切铺满整条横带，没有海报时保持渐变底 */
    drawBanner(ctx, canvas, src) {
      if (!src) return Promise.resolve(false)
      return this.drawImageCover(ctx, canvas, src, { x: 0, y: 0, w: WIDTH, h: BANNER_HEIGHT })
    },

    /**
     * 该类型还没出海报时，顶部这块不能就留一片空渐变（十个类型里现在只有徒步 / 爬山有图）。
     * 用这个类型自己的主题色铺一层 + 品牌名 + 玩法名填满，至少与类型对得上：
     * 露营是橙的、骑行是青的，和广场里那张卡片的配色一致。
     */
    paintHeroPlaceholder(ctx, activity) {
      const act = activity || {}
      const type = getType(act.type)
      const hero = ctx.createLinearGradient(0, 0, WIDTH, BANNER_HEIGHT)
      hero.addColorStop(0, type.from)
      hero.addColorStop(1, type.to)
      ctx.fillStyle = hero
      ctx.fillRect(0, 0, WIDTH, BANNER_HEIGHT)

      ctx.textAlign = 'center'
      ctx.textBaseline = 'alphabetic'
      ctx.fillStyle = '#FFFFFF'
      ctx.font = 'bold 56px sans-serif'
      ctx.fillText(TEXTS.appName, WIDTH / 2, 330)
      ctx.fillStyle = 'rgba(255, 255, 255, 0.92)'
      ctx.font = '26px sans-serif'
      ctx.fillText(TEXTS.slogan, WIDTH / 2, 382)

      // 玩法名放一颗半透明白胶囊里，和品牌名拉开层次
      const name = type.name || '活动'
      ctx.font = 'bold 30px sans-serif'
      const pillWidth = ctx.measureText(name).width + 72
      const pillHeight = 68
      const pillY = 428
      this.roundRect(ctx, (WIDTH - pillWidth) / 2, pillY, pillWidth, pillHeight, pillHeight / 2)
      ctx.fillStyle = 'rgba(255, 255, 255, 0.28)'
      ctx.fill()
      ctx.fillStyle = '#FFFFFF'
      ctx.font = 'bold 30px sans-serif'
      ctx.fillText(name, WIDTH / 2, pillY + 45)
    },

    /** 小程序码：白色圆角框内绘制码图，缺失时保留占位文案 */
    drawMiniQr(ctx, canvas, src, box) {
      return this.drawImageFit(ctx, canvas, src, box).then((drawn) => {
        if (drawn) return
        this.drawQrPlaceholder(ctx, box, '小程序码', '')
      })
    },

    /** 活动二维码：有图则绘制，否则绘制占位文案 */
    drawGroupQr(ctx, canvas, src, box, label) {
      return this.drawImageFit(ctx, canvas, src, box).then((drawn) => {
        if (drawn) return
        this.drawQrPlaceholder(ctx, box, label || '活动二维码', '发起人未上传')
      })
    },

    /** 二维码缺失时的占位文案，居中画在二维码框里 */
    drawQrPlaceholder(ctx, box, title, sub) {
      const centerX = box.x + box.w / 2
      const centerY = box.y + box.h / 2
      ctx.textAlign = 'center'
      ctx.textBaseline = 'alphabetic'
      ctx.fillStyle = '#C4CFCF'
      ctx.font = '22px sans-serif'
      ctx.fillText(title, centerX, centerY)
      if (!sub) return
      ctx.font = '20px sans-serif'
      ctx.fillText(sub, centerX, centerY + 30)
    },

    /**
     * 等比裁切（cover）：短边贴合区域、长边溢出裁掉，用于顶部海报这类要铺满的图。
     * 与 drawImageFit 的差别只在缩放系数取大值 —— 那个是「完整不出框」，这个是「铺满不留白」。
     */
    drawImageCover(ctx, canvas, src, box) {
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
          const scale = Math.max(box.w / width, box.h / height)
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
        // 兜底超时：图片迟迟不回调时按失败处理，版面掉回渐变底而不是停在「生成中」
        setTimeout(() => finish(false), 5000)
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
