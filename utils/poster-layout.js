/** 活动海报标题：费用方式是标题的第一眼信息 */
function posterTitle(activity) {
  const act = activity || {}
  const title = String(act.title || '活动组队')
  const prefix = act.feeMode === 'nonAA' || act.feeMode === 'fixed' ? '非AA制' : 'AA制'
  return `${prefix}·${title}`
}

/** 海报信息区只展示集合时间，地点与费用人数留在详情页 */
function posterInfoRows(activity) {
  const act = activity || {}
  const dateText = String(act.dateText || '')
  return dateText ? [{ label: '集合时间', value: dateText }] : []
}

/**
 * 从活动二维码截图里找二维码主体的暗色边界。
 *
 * 微信二维码截图常见“上方说明文字 + 中间码图”的结构。二维码在纵向上是一段连续的、
 * 暗色占比很高的方形区域；说明文字虽然单行也可能很黑，但高度很短。这里先按行投影找
 * 足够高的连续暗带，再在暗带内取横向边界，避免把说明文字一起缩进海报。
 */
function findQrCrop(imageData, width, height) {
  const pixels = imageData || []
  if (!pixels.length || width <= 0 || height <= 0) return null

  const rowCounts = new Array(height).fill(0)
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = (y * width + x) * 4
      const alpha = pixels[offset + 3]
      const luminance =
        pixels[offset] * 0.299 + pixels[offset + 1] * 0.587 + pixels[offset + 2] * 0.114
      if (alpha > 20 && luminance < 110) rowCounts[y] += 1
    }
  }

  const minBandHeight = Math.max(24, Math.floor(Math.min(width, height) * 0.2))
  const minRowInk = Math.max(8, Math.floor(width * 0.05))
  // 截图缩放后，二维码模块间常留下 1–2px 的浅色扫描线；允许小空隙，但文字行之间的大空白仍会切开
  const rowGapTolerance = Math.max(2, Math.floor(Math.min(width, height) * 0.02))
  let best = null

  let runStart = -1
  const considerRun = (start, end) => {
    const runHeight = end - start
    if (runHeight < minBandHeight) return

    const colCounts = new Array(width).fill(0)
    for (let y = start; y < end; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const offset = (y * width + x) * 4
        const alpha = pixels[offset + 3]
        const luminance =
          pixels[offset] * 0.299 + pixels[offset + 1] * 0.587 + pixels[offset + 2] * 0.114
        if (alpha > 20 && luminance < 110) colCounts[x] += 1
      }
    }

    const minColInk = Math.max(3, Math.floor(runHeight * 0.05))
    let left = -1
    let right = -1
    for (let x = 0; x < width; x += 1) {
      if (colCounts[x] < minColInk) continue
      if (left === -1) left = x
      right = x
    }
    if (left === -1) return

    const boxWidth = right - left + 1
    const ratio = boxWidth / runHeight
    if (ratio < 0.75 || ratio > 1.3) return
    const area = boxWidth * runHeight
    if (!best || area > best.w * best.h) {
      best = { x: left, y: start, w: boxWidth, h: runHeight }
    }
  }

  let lastDenseRow = -1
  for (let y = 0; y < height; y += 1) {
    if (rowCounts[y] >= minRowInk) {
      if (runStart === -1) runStart = y
      lastDenseRow = y
    } else if (runStart !== -1 && y - lastDenseRow > rowGapTolerance) {
      considerRun(runStart, lastDenseRow + 1)
      runStart = -1
      lastDenseRow = -1
    }
  }
  if (runStart !== -1) considerRun(runStart, lastDenseRow + 1)
  return best
}

/** 把分析画布上的码区映射回原图坐标，并留出可扫描的白色静区 */
function mapQrCrop(crop, imageWidth, imageHeight, scanWidth, scanHeight) {
  if (!crop || imageWidth <= 0 || imageHeight <= 0 || scanWidth <= 0 || scanHeight <= 0) return null
  const scale = Math.min(scanWidth / imageWidth, scanHeight / imageHeight)
  const offsetX = (scanWidth - imageWidth * scale) / 2
  const offsetY = (scanHeight - imageHeight * scale) / 2
  const sourceX = (crop.x - offsetX) / scale
  const sourceY = (crop.y - offsetY) / scale
  const sourceW = crop.w / scale
  const sourceH = crop.h / scale
  const padding = Math.max(2, Math.round(Math.max(sourceW, sourceH) * 0.08))
  const left = Math.max(0, Math.floor(sourceX - padding))
  const top = Math.max(0, Math.floor(sourceY - padding))
  const right = Math.min(imageWidth, Math.ceil(sourceX + sourceW + padding))
  const bottom = Math.min(imageHeight, Math.ceil(sourceY + sourceH + padding))
  if (right <= left || bottom <= top) return null
  return { x: left, y: top, w: right - left, h: bottom - top }
}

/** canvas 读取像素前，把云文件与 http(s) 图片先落到本地，避免跨域污染画布 */
function needsDownloadForCanvas(src) {
  const source = String(src || '')
  return source.indexOf('cloud://') === 0 || /^https?:\/\//i.test(source)
}

/** 二维码区域的海报几何：左上角小码贴边，活动码与说明共用海报中线 */
function posterQrLayout(posterWidth) {
  const width = Number(posterWidth) > 0 ? Number(posterWidth) : 750
  return {
    miniCardX: 0,
    miniCardY: 0,
    miniCardSize: 104,
    miniImageSize: 90,
    groupCenterX: width / 2,
    groupLabelCenterX: width / 2,
  }
}

module.exports = {
  findQrCrop,
  mapQrCrop,
  needsDownloadForCanvas,
  posterInfoRows,
  posterQrLayout,
  posterTitle,
}
