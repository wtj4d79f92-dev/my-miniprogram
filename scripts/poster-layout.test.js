const assert = require('assert')

const {
  findQrCrop,
  mapQrCrop,
  needsDownloadForCanvas,
  posterInfoRows,
  posterQrLayout,
  posterTitle,
} = require('../utils/poster-layout')

assert.strictEqual(
  posterTitle({ feeMode: 'aa', title: '黑虎岗徒步8公里' }),
  'AA制·黑虎岗徒步8公里',
  'AA 制活动的海报标题应带固定费用前缀'
)
assert.strictEqual(
  posterTitle({ feeMode: 'nonAA', title: '青城山徒步' }),
  '非AA制·青城山徒步',
  '非 AA 制活动的海报标题应带对应费用前缀'
)
assert.deepStrictEqual(
  posterInfoRows({
    dateText: '11月07日 周六 00:00',
    location: '成都',
    feeText: 'AA制',
    peopleText: '2/10人',
  }),
  [{ label: '集合时间', value: '11月07日 周六 00:00' }],
  '海报信息区只保留集合时间，不展示集合地点和费用与人数'
)

function makeQrScreenshot(scanlineGap) {
  const width = 200
  const height = 260
  const pixels = new Uint8ClampedArray(width * height * 4)
  pixels.fill(255)
  const ink = (left, top, boxWidth, boxHeight) => {
    for (let y = top; y < top + boxHeight; y += 1) {
      for (let x = left; x < left + boxWidth; x += 1) {
        const offset = (y * width + x) * 4
        pixels[offset] = 0
        pixels[offset + 1] = 0
        pixels[offset + 2] = 0
      }
    }
  }

  // 顶部的说明文字：每行都不短，但纵向间隔明显，不能被当成二维码裁出来
  ink(38, 28, 118, 5)
  ink(54, 52, 92, 5)
  ink(40, 78, 120, 5)

  // 二维码模块区：保留四方定位样式和交替黑块，模拟真实码图的暗色分布
  const qr = { x: 52, y: 112, size: 96, cell: 6 }
  ink(qr.x, qr.y, 24, 24)
  ink(qr.x + qr.size - 24, qr.y, 24, 24)
  ink(qr.x, qr.y + qr.size - 24, 24, 24)
  for (let row = 0; row < qr.size / qr.cell; row += 1) {
    for (let col = 0; col < qr.size / qr.cell; col += 1) {
      if ((row + col) % 2 === 0) {
        ink(qr.x + col * qr.cell, qr.y + row * qr.cell, qr.cell, qr.cell)
      }
    }
  }
  if (scanlineGap) {
    for (let y = qr.y; y < qr.y + qr.size; y += 7) {
      for (let x = qr.x; x < qr.x + qr.size; x += 1) {
        const offset = ((y + 6) * width + x) * 4
        pixels[offset] = 255
        pixels[offset + 1] = 255
        pixels[offset + 2] = 255
      }
    }
  }
  return { width, height, pixels }
}

const screenshot = makeQrScreenshot(false)
assert.deepStrictEqual(
  findQrCrop(screenshot.pixels, screenshot.width, screenshot.height),
  { x: 52, y: 112, w: 96, h: 96 },
  '活动二维码应从带说明文字的截图中裁出码区，不能把说明文字一起裁入'
)
const scanlineScreenshot = makeQrScreenshot(true)
assert.deepStrictEqual(
  findQrCrop(scanlineScreenshot.pixels, scanlineScreenshot.width, scanlineScreenshot.height),
  { x: 52, y: 112, w: 96, h: 96 },
  '二维码内部存在横向扫描线间隙时，仍应识别为同一块码区'
)
assert.deepStrictEqual(
  mapQrCrop({ x: 100, y: 90, w: 100, h: 100 }, 400, 600, 300, 300),
  { x: 84, y: 164, w: 232, h: 232 },
  '缩放分析图里的码区应映射回原图坐标，并留出二维码静区'
)
assert.strictEqual(
  needsDownloadForCanvas('https://example.com/activity-qr.png'),
  true,
  '远程二维码应先下载成本地文件，避免 canvas 取像素时触发跨域限制'
)
assert.strictEqual(needsDownloadForCanvas('wxfile://tmp/activity-qr.png'), false)

const qrLayout = posterQrLayout(750)
assert.strictEqual(qrLayout.miniCardX, 0, '左上角小程序码应贴齐海报左边界')
assert.strictEqual(qrLayout.miniCardY, 0, '左上角小程序码应贴齐海报顶部边界')
assert.ok(qrLayout.miniImageSize >= 88, '左上角小程序码应保留足够尺寸供扫码识别')
assert.strictEqual(qrLayout.groupCenterX, 375, '活动二维码应在海报水平方向居中')
assert.strictEqual(qrLayout.groupLabelCenterX, 375, '扫码说明应与活动二维码使用同一中心线')

console.log('海报布局测试通过')
