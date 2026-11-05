const assert = require('assert')
const fs = require('fs')
const path = require('path')

const ROOT = path.resolve(__dirname, '..')

let shareIcons = null
try {
  shareIcons = require(path.join(ROOT, 'utils/share-icons'))
} catch (err) {
  shareIcons = null
}

assert.ok(shareIcons && shareIcons.SHARE_ICONS, '分享面板应提供独立的三枚线性图标')

const iconKeys = ['friend', 'timeline', 'poster']
assert.deepStrictEqual(
  Object.keys(shareIcons.SHARE_ICONS),
  iconKeys,
  '分享面板应按微信好友、朋友圈、生成分享图片的顺序提供图标'
)

iconKeys.forEach((key) => {
  const source = shareIcons.SHARE_ICONS[key]
  assert.match(source, /^data:image\/svg\+xml;charset=utf-8,/, `${key} 图标应是可直接渲染的 SVG data URI`)
  const svg = decodeURIComponent(source)
  assert.match(svg, /viewBox="0 0 24 24"/, `${key} 图标应使用统一的 24×24 视窗`)
  assert.match(svg, /fill="none"/, `${key} 图标应沿用线性图标的无填充样式`)
  assert.match(svg, /stroke="#00B578"/, `${key} 图标应沿用品牌绿描边`)
  assert.match(svg, /stroke-width="1\.6"/, `${key} 图标应与其它入口保持相同线宽`)
  assert.match(svg, /stroke-linecap="round"/, `${key} 图标应使用圆角端点`)
  assert.match(svg, /stroke-linejoin="round"/, `${key} 图标应使用圆角连接`)
})

const detailPagePath = path.join(ROOT, 'pages/activity/detail/index.js')
const pageOptions = []
const originalPage = global.Page
const originalBehavior = global.Behavior
const originalGetApp = global.getApp

global.Behavior = (options) => options
global.getApp = () => ({ globalData: {} })
global.Page = (options) => pageOptions.push(options)
delete require.cache[detailPagePath]
require(detailPagePath)

global.Page = originalPage
global.Behavior = originalBehavior
global.getApp = originalGetApp

const detailPage = pageOptions[0]
assert.deepStrictEqual(
  detailPage.data.shareIcons,
  shareIcons.SHARE_ICONS,
  '活动详情页应把三枚分享图标下发给分享面板'
)

const context = {
  data: { shareIconErrors: {} },
  setData(patch) {
    Object.assign(this.data, patch)
  },
}
detailPage.onShareIconError.call(context, {
  currentTarget: { dataset: { key: 'timeline' } },
})
assert.deepStrictEqual(
  context.data.shareIconErrors,
  { timeline: true },
  '单个分享图标加载失败时应只标记对应入口，不影响另外两个图标'
)

const detailWxml = fs.readFileSync(path.join(ROOT, 'pages/activity/detail/index.wxml'), 'utf8')
iconKeys.forEach((key) => {
  assert.match(
    detailWxml,
    new RegExp(`<image[^>]*src="\\{\\{shareIcons\\.${key}\\}\\}"[^>]*binderror="onShareIconError"`),
    `分享面板应以图片渲染 ${key} 线性图标`
  )
})
assert.doesNotMatch(detailWxml, /class="share-emoji"/, '分享面板不应继续直接摆 emoji')

console.log('分享图标测试通过')
