const assert = require('assert')
const fs = require('fs')
const path = require('path')

const ROOT = path.resolve(__dirname, '..')
const { buildTopBarStyle } = require(path.join(ROOT, 'utils/ui'))
const homeWxml = fs.readFileSync(path.join(ROOT, 'pages/home/home.wxml'), 'utf8')
const squareWxml = fs.readFileSync(path.join(ROOT, 'pages/square/index.wxml'), 'utf8')

assert.strictEqual(
  buildTopBarStyle({ top: 59, height: 32, left: 296 }, { statusBarHeight: 47, windowWidth: 393 }),
  'height: 91px; padding-top: 59px; padding-right: 105px;',
  '首行与胶囊按钮等高，并给右上角胶囊按钮留出完整空间'
)

assert.strictEqual(
  buildTopBarStyle({}, { statusBarHeight: 20, windowWidth: 375 }),
  'height: 52px; padding-top: 20px; padding-right: 102px;',
  '胶囊尺寸不可用时，应回退到标准导航行高度与常见胶囊占位'
)

const homeTopbarIndex = homeWxml.indexOf('class="page-topbar"')
const homeCityIndex = homeWxml.indexOf('class="city-pill"')
const homeMarqueeIndex = homeWxml.indexOf('class="home-marquee"')
const homeScrollIndex = homeWxml.indexOf('<scroll-view')
assert.ok(
  homeTopbarIndex >= 0 &&
    homeTopbarIndex < homeCityIndex &&
    homeCityIndex < homeMarqueeIndex &&
    homeMarqueeIndex < homeScrollIndex,
  '首页跑马灯应位于顶部定位栏与系统胶囊按钮之间，而不是内容流中'
)

const squareTopbarIndex = squareWxml.indexOf('class="page-topbar"')
const squareCityIndex = squareWxml.indexOf('class="city-pill"')
const squareSearchIndex = squareWxml.indexOf('class="search-row topbar-search"')
const squareHeadIndex = squareWxml.indexOf('class="square-head"')
assert.ok(
  squareTopbarIndex >= 0 &&
    squareTopbarIndex < squareCityIndex &&
    squareCityIndex < squareSearchIndex &&
    squareSearchIndex < squareHeadIndex,
  '广场搜索框应位于顶部定位栏与系统胶囊按钮之间，而不是下方筛选区中'
)
