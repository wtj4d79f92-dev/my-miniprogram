const assert = require('assert')
const path = require('path')

const ROOT = path.resolve(__dirname, '..')
const PUBLISH_PAGE = path.join(ROOT, 'pages/activity/publish/index.js')

const originalBehavior = global.Behavior
const originalPage = global.Page
const originalGetApp = global.getApp
const originalWx = global.wx

function setData(target, patch) {
  Object.keys(patch).forEach((key) => {
    const parts = key.split('.')
    let value = target.data
    for (let i = 0; i < parts.length - 1; i += 1) value = value[parts[i]]
    value[parts[parts.length - 1]] = patch[key]
  })
}

function waitFor(promise) {
  return new Promise((resolve) => setTimeout(resolve, 0)).then(() => promise)
}

/** 构造一张 320 方分析画布：二维码位于 (100, 120)，尺寸 80，周围是截图文字与留白。 */
function makeScanPixels() {
  const size = 320
  const pixels = new Uint8ClampedArray(size * size * 4)
  pixels.fill(255)

  const ink = (left, top, width, height) => {
    for (let y = top; y < top + height; y += 1) {
      for (let x = left; x < left + width; x += 1) {
        const offset = (y * size + x) * 4
        pixels[offset] = 0
        pixels[offset + 1] = 0
        pixels[offset + 2] = 0
      }
    }
  }

  ink(72, 42, 176, 6)
  ink(104, 68, 112, 6)
  const qrX = 100
  const qrY = 120
  const qrSize = 80
  const cell = 5
  for (let row = 0; row < qrSize / cell; row += 1) {
    for (let col = 0; col < qrSize / cell; col += 1) {
      if ((row + col) % 2 === 0) ink(qrX + col * cell, qrY + row * cell, cell, cell)
    }
  }
  return pixels
}

function makeCanvas(options, drawCalls, pixelsFactory) {
  const width = options.width
  const height = options.height
  return {
    width,
    height,
    createImage() {
      const image = { width: 800, height: 1000, onload: null, onerror: null }
      Object.defineProperty(image, 'src', {
        set() {
          setTimeout(() => {
            if (image.onload) image.onload()
          }, 0)
        },
      })
      return image
    },
    getContext() {
      return {
        fillStyle: '',
        fillRect() {},
        drawImage(image, sx, sy, sw, sh, dx, dy, dw, dh) {
          drawCalls.push({ sx, sy, sw, sh, dx, dy, dw, dh })
        },
        getImageData() {
          return { data: pixelsFactory ? pixelsFactory() : makeScanPixels() }
        },
      }
    },
  }
}

function capturePublishPage(wx) {
  let definition = null
  global.Behavior = (options) => options
  global.Page = (options) => {
    definition = options
  }
  global.getApp = () => ({ globalData: { user: null, city: '成都' } })
  global.wx = wx
  delete require.cache[require.resolve(PUBLISH_PAGE)]
  require(PUBLISH_PAGE)
  assert.ok(definition, '应能读取发布页定义')
  return definition
}

async function testChooseGroupQrUsesCroppedImage() {
  const drawCalls = []
  let cropExported = false
  const wx = {
    showLoading() {},
    hideLoading() {},
    chooseMedia(options) {
      options.success({ tempFiles: [{ tempFilePath: 'wxfile://original.png' }] })
    },
    createOffscreenCanvas(options) {
      return makeCanvas(options, drawCalls)
    },
    canvasToTempFilePath(options) {
      cropExported = true
      options.success({ tempFilePath: 'wxfile://cropped.png' })
    },
  }
  const definition = capturePublishPage(wx)
  let recognizedPath = ''
  const context = Object.assign({}, definition, {
    data: { form: { groupQrCode: '' } },
    setData(patch) {
      setData(this, patch)
    },
    discardQrDraft() {},
    clearError() {},
    readQrText(value) {
      recognizedPath = value
    },
  })

  context.chooseGroupQr()
  await waitFor(new Promise((resolve) => setTimeout(resolve, 30)))

  assert.strictEqual(cropExported, true, '发布页选图后应导出裁切图片')
  const cropDraw = drawCalls.filter((call) => call.sw === 291 && call.sh === 290)[0]
  assert.deepStrictEqual(
    cropDraw,
    { sx: 192, sy: 355, sw: 291, sh: 290, dx: 0, dy: 0.5, dw: 291, dh: 290 },
    '发布页应绘制二维码区域及周边静区，而不是整张原图'
  )
  assert.strictEqual(context.data.form.groupQrCode, 'wxfile://cropped.png', '预览和后续上传应使用裁切图')
  assert.strictEqual(recognizedPath, 'wxfile://cropped.png', '二维码 OCR 应读取裁切图')
}

async function testChooseGroupQrFallsBackWhenQrCannotBeLocated() {
  const drawCalls = []
  const wx = {
    showLoading() {},
    hideLoading() {},
    chooseMedia(options) {
      options.success({ tempFiles: [{ tempFilePath: 'wxfile://original.png' }] })
    },
    createOffscreenCanvas(options) {
      return makeCanvas(options, drawCalls, () => new Uint8ClampedArray(320 * 320 * 4).fill(255))
    },
    canvasToTempFilePath() {
      throw new Error('定位失败时不应该导出裁切图')
    },
  }
  const definition = capturePublishPage(wx)
  let recognizedPath = ''
  const context = Object.assign({}, definition, {
    data: { form: { groupQrCode: '' } },
    setData(patch) {
      setData(this, patch)
    },
    discardQrDraft() {},
    clearError() {},
    readQrText(value) {
      recognizedPath = value
    },
  })

  context.chooseGroupQr()
  await waitFor(new Promise((resolve) => setTimeout(resolve, 30)))

  assert.strictEqual(
    context.data.form.groupQrCode,
    'wxfile://original.png',
    '定位不到二维码时应保留原图，不能把上传入口置空'
  )
  assert.strictEqual(recognizedPath, 'wxfile://original.png', '降级后仍应对原图执行 OCR')
}

async function run() {
  await testChooseGroupQrUsesCroppedImage()
  await testChooseGroupQrFallsBackWhenQrCannotBeLocated()
  console.log('发布二维码裁切测试通过')
}

run()
  .catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
  .finally(() => {
    global.Behavior = originalBehavior
    global.Page = originalPage
    global.getApp = originalGetApp
    global.wx = originalWx
  })
