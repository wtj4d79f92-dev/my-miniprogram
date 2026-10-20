const assert = require('assert')
const fs = require('fs')
const path = require('path')

const ROOT = path.resolve(__dirname, '..')
const { TEXTS } = require(path.join(ROOT, 'utils/dict'))
const { normalizeMarqueeTexts, MARQUEE_ICON } = require(path.join(ROOT, 'utils/marquee'))
const wxml = fs.readFileSync(path.join(ROOT, 'pages/home/home.wxml'), 'utf8')
const wxss = fs.readFileSync(path.join(ROOT, 'pages/home/home.wxss'), 'utf8')
const pageJs = fs.readFileSync(path.join(ROOT, 'pages/home/home.js'), 'utf8')

assert.ok(Array.isArray(TEXTS.homeMarqueeTexts), '首页跑马灯文案应使用可增删的数组配置')
assert.ok(TEXTS.homeMarqueeTexts.length > 1, '首页应提供多条跑马灯示例文案')
assert.deepStrictEqual(
  normalizeMarqueeTexts([' 第一条 ', '', null, ' 第二条  ']),
  ['第一条', '第二条'],
  '多条跑马灯应过滤空项并去除首尾空白'
)
assert.deepStrictEqual(
  normalizeMarqueeTexts(' 单条文案 '),
  ['单条文案'],
  '单条字符串配置也应兼容'
)
const iconSvg = decodeURIComponent(MARQUEE_ICON.split(',')[1])
assert.match(iconSvg, /viewBox="0 0 24 24"/, '跑马灯图标应使用统一的 24×24 线性图标规格')
assert.match(iconSvg, /stroke="#00B578"/, '跑马灯图标应使用“我的”页同一品牌绿')
assert.match(iconSvg, /stroke-width="1.6"/, '跑马灯图标应使用“我的”页同一线宽')
assert.match(wxml, /class="home-marquee"/, '首页应渲染跑马灯')
assert.match(wxml, /src="\{\{marqueeIcon\}\}"/, '首页跑马灯应渲染线性图标')
assert.match(wxml, /homeMarqueeHasMultiple/, '首页应根据文案条数切换滚动方向')
assert.match(wxml, /class="home-marquee-swiper"/, '多条文案应使用上下轮播')
assert.match(wxml, /vertical="\{\{true\}\}"/, '多条文案轮播方向应为上下')
assert.doesNotMatch(wxml, />\s*发现\s*</, '跑马灯图标后不应保留“发现”文案')
assert.doesNotMatch(wxml, /home-marquee-divider/, '跑马灯图标后不应保留分隔线')
assert.doesNotMatch(wxml, /class="search-entry"/, '首页应删除搜索入口')
assert.doesNotMatch(pageJs, /onSearchTap/, '首页应删除搜索跳转逻辑')
assert.match(wxss, /@keyframes home-marquee-scroll/, '跑马灯应有横向滚动动画')
assert.match(wxss, /height:\s*44rpx/, '跑马灯应使用紧凑高度')
assert.match(wxss, /border-radius:\s*var\(--radius-pill\)/, '跑马灯应使用紧凑胶囊外形')
assert.match(
  wxss,
  /\.home-marquee\s*\{[^}]*(?:^|[;\s])width:\s*100%/sm,
  '跑马灯应与横幅和下方玩法板块保持同宽'
)
assert.match(
  wxss,
  /\.home-marquee-window\s*\{[^}]*flex:\s*1/s,
  '跑马灯文字窗口应自适应内容区剩余宽度'
)

console.log('首页跑马灯测试通过')
