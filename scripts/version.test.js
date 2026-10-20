const assert = require('assert')
const fs = require('fs')
const path = require('path')

const ROOT = path.resolve(__dirname, '..')
const versionPath = path.join(ROOT, 'utils/version.js')
const pageWxmlPath = path.join(ROOT, 'pages/usercenter/index.wxml')
const pageJsPath = path.join(ROOT, 'pages/usercenter/index.js')

assert.ok(fs.existsSync(versionPath), '版本信息应集中在 utils/version.js，方便开发者随代码包维护')

const { APP_VERSION, VERSION_TEXT, formatVersion } = require(versionPath)
assert.match(APP_VERSION.number, /^\d+\.\d+\.\d+$/, '版本号应使用 x.y.z 格式')
assert.strictEqual(
  formatVersion({ name: '示例小程序', number: '2.3.4' }),
  '示例小程序 v2.3.4',
  '版本信息应统一格式化为「应用名 v版本号」'
)
assert.strictEqual(
  formatVersion({ name: '示例小程序', number: 'v2.3.4' }),
  '示例小程序 v2.3.4',
  '手工填写时带不带前缀 v 都应得到同一展示结果'
)
assert.strictEqual(VERSION_TEXT, `旷行吖 v${APP_VERSION.number}`, '页面展示应来自唯一的版本配置')

const pageOptions = []
const originBehavior = global.Behavior
const originPage = global.Page
global.Behavior = (options) => options
global.Page = (options) => pageOptions.push(options)
delete require.cache[pageJsPath]
require(pageJsPath)
global.Behavior = originBehavior
global.Page = originPage

assert.strictEqual(pageOptions.length, 1, '应能读取「我的」页面配置')
assert.strictEqual(
  pageOptions[0].data.versionText,
  VERSION_TEXT,
  '「我的」页面数据应直接复用版本配置，而不是另维护一份文案'
)

const pageWxml = fs.readFileSync(pageWxmlPath, 'utf8')
assert.strictEqual(
  (pageWxml.match(/\{\{versionText\}\}/g) || []).length,
  2,
  '「我的」页面底部与设置页应展示同一份版本信息'
)

console.log('版本信息测试通过')
