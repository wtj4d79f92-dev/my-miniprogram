const { findQrCrop, mapQrCrop } = require('./poster-layout')

/** 二维码定位前先缩到小画布，避免对原图逐像素扫描 */
const SCAN_SIZE = 320
/** 导出图的长边上限：二维码本身不需要原截图那么大的像素量 */
const MAX_OUTPUT_SIZE = 1200
const IMAGE_TIMEOUT = 5000
const EXPORT_TIMEOUT = 8000

function loadImage(canvas, src) {
  return new Promise((resolve, reject) => {
    const image = canvas.createImage()
    let settled = false
    let timer = null
    const finish = (error) => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      if (error) reject(error)
      else resolve(image)
    }
    timer = setTimeout(() => finish(new Error('二维码图片加载超时')), IMAGE_TIMEOUT)
    image.onload = () => finish(null)
    image.onerror = () => finish(new Error('二维码图片加载失败'))
    image.src = src
  })
}

function exportCanvas(canvas, size, pageContext) {
  return new Promise((resolve, reject) => {
    let settled = false
    let timer = null
    const finish = (path, error) => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      if (path) resolve(path)
      else reject(error || new Error('二维码图片导出失败'))
    }
    timer = setTimeout(() => finish('', new Error('二维码图片导出超时')), EXPORT_TIMEOUT)
    wx.canvasToTempFilePath(
      {
        canvas,
        x: 0,
        y: 0,
        width: size,
        height: size,
        destWidth: size,
        destHeight: size,
        fileType: 'png',
        quality: 1,
        success: (res) => finish((res && res.tempFilePath) || ''),
        fail: () => finish(''),
      },
      pageContext
    )
  })
}

/**
 * 从二维码截图里裁出码区，导出为正方形 PNG。
 * @param {string} src 相册选中的本地临时路径
 * @param {Object} pageContext 页面实例，供 canvasToTempFilePath 使用
 * @returns {Promise<string>} 裁切后的本地临时路径
 */
function cropQrImage(src, pageContext) {
  return Promise.resolve().then(() => {
    const source = String(src || '')
    if (!source) throw new Error('没有可裁切的二维码图片')

    const scanCanvas = wx.createOffscreenCanvas({
      type: '2d',
      width: SCAN_SIZE,
      height: SCAN_SIZE,
    })
    const scanCtx = scanCanvas.getContext('2d')
    if (!scanCtx) throw new Error('当前微信版本不支持图片裁切')

    return loadImage(scanCanvas, source).then((image) => {
      const width = Number(image.width) || 0
      const height = Number(image.height) || 0
      scanCtx.fillStyle = '#FFFFFF'
      scanCtx.fillRect(0, 0, SCAN_SIZE, SCAN_SIZE)
      const scale = Math.min(SCAN_SIZE / width, SCAN_SIZE / height)
      const drawWidth = width * scale
      const drawHeight = height * scale
      scanCtx.drawImage(
        image,
        (SCAN_SIZE - drawWidth) / 2,
        (SCAN_SIZE - drawHeight) / 2,
        drawWidth,
        drawHeight
      )
      const pixels = scanCtx.getImageData(0, 0, SCAN_SIZE, SCAN_SIZE).data
      const scanCrop = findQrCrop(pixels, SCAN_SIZE, SCAN_SIZE)
      const crop = mapQrCrop(scanCrop, width, height, SCAN_SIZE, SCAN_SIZE)
      if (!crop) throw new Error('没有识别到可裁切的二维码区域')

      const size = Math.min(MAX_OUTPUT_SIZE, Math.max(crop.w, crop.h))
      const outputCanvas = wx.createOffscreenCanvas({ type: '2d', width: size, height: size })
      const outputCtx = outputCanvas.getContext('2d')
      if (!outputCtx) throw new Error('当前微信版本不支持图片裁切')
      outputCtx.fillStyle = '#FFFFFF'
      outputCtx.fillRect(0, 0, size, size)
      return loadImage(outputCanvas, source).then((outputImage) => {
        const fit = Math.min(size / crop.w, size / crop.h)
        const fittedWidth = crop.w * fit
        const fittedHeight = crop.h * fit
        outputCtx.drawImage(
          outputImage,
          crop.x,
          crop.y,
          crop.w,
          crop.h,
          (size - fittedWidth) / 2,
          (size - fittedHeight) / 2,
          fittedWidth,
          fittedHeight
        )
        return exportCanvas(outputCanvas, size, pageContext)
      })
    })
  })
}

module.exports = { cropQrImage }
