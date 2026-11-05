const assert = require('assert')
const path = require('path')
const fs = require('fs')

const ROOT = path.resolve(__dirname, '..')
const {
  HOME_ORGANIZER_LIMIT,
  HOME_ORGANIZER_ROW_SIZE,
  EMPTY_ORGANIZER_TEXT,
  buildHomeOrganizerSlots,
} = require(path.join(ROOT, 'utils/home-organizers'))

function host(slot, nickName) {
  return {
    slot,
    userId: 1000 + slot,
    nickName,
    avatarUrl: `https://tmp.test/avatar-${slot}`,
    avatarColor: '#4ECDC4',
    avatarText: nickName.slice(0, 1),
  }
}

assert.strictEqual(HOME_ORGANIZER_LIMIT, 10, '首页最多保留 10 个主办方坑位')
assert.strictEqual(HOME_ORGANIZER_ROW_SIZE, 5, '主办方坑位每排固定 5 个')

const firstRowPartial = buildHomeOrganizerSlots([
  host(1, '山野阿宽'),
  host(2, '小满去爬山'),
  host(3, '阿哲不卷了'),
  host(4, '柠檬骑行记'),
])
assert.strictEqual(firstRowPartial.length, 5, '第一排没占满时只展示第一排 5 个坑位')
assert.strictEqual(firstRowPartial[0].nickName, '山野阿宽', '已配置坑位展示昵称')
assert.strictEqual(firstRowPartial[0].avatarUrl, 'https://tmp.test/avatar-1', '已配置坑位展示头像')
assert.strictEqual(firstRowPartial[4].occupied, false, '未配置的坑位保持为空')
assert.strictEqual(firstRowPartial[4].nickName, EMPTY_ORGANIZER_TEXT, '未配置坑位显示待入驻')
assert.ok(
  firstRowPartial.every((item) => item.openid === undefined && item.userId === undefined),
  '展示数据不能把 openid 或后台用户 ID 下发给页面'
)

const firstRowFull = buildHomeOrganizerSlots([
  host(1, '一'),
  host(2, '二'),
  host(3, '三'),
  host(4, '四'),
  host(5, '五'),
])
assert.strictEqual(firstRowFull.length, 10, '第一排占满后展示第二排')
assert.strictEqual(firstRowFull[5].occupied, false, '第二排未配置坑位保持为空')
assert.strictEqual(firstRowFull[9].nickName, EMPTY_ORGANIZER_TEXT, '第二排空坑位显示待入驻')

const compacted = buildHomeOrganizerSlots([
  null,
  host(6, '第六坑'),
])
assert.strictEqual(compacted[0].nickName, '第六坑', '有效主办方按顺序前移，不留下不可见空坑')
assert.strictEqual(compacted[0].hostSlot, 6, '前移后仍保留原始坑位号用于筛选')

const capped = buildHomeOrganizerSlots(
  Array.from({ length: 12 }, (_, index) => host(index + 1, `主办方${index + 1}`))
)
assert.strictEqual(capped.length, 10, '超过 10 个配置时只保留前 10 个')
assert.strictEqual(capped[9].nickName, '主办方10', '截断后保留前 10 个主办方')

const memory = {}
let switchedUrl = ''
let navigatedUrl = ''
const toasts = []
global.wx = {
  getStorageSync(key) {
    return Object.prototype.hasOwnProperty.call(memory, key) ? memory[key] : ''
  },
  setStorageSync(key, value) {
    memory[key] = value
  },
  removeStorageSync(key) {
    delete memory[key]
  },
  setStorage({ key, data }) {
    memory[key] = data
  },
  switchTab({ url }) {
    switchedUrl = url
  },
  navigateTo({ url }) {
    navigatedUrl = url
  },
  showToast({ title }) {
    toasts.push(title)
  },
}
global.getApp = () => ({ globalData: {} })
global.Behavior = (options) => options

function loadPage(relative, component) {
  const pages = []
  const originPage = global.Page
  global.Page = (options) => pages.push(options)
  const file = path.join(ROOT, relative)
  delete require.cache[file]
  require(file)
  global.Page = originPage
  return pages[0]
}

const homePage = loadPage('pages/home/home.js')
assert.ok(homePage && typeof homePage.onOrganizerTap === 'function', '首页应提供主办方坑位点击处理')

const homeCtx = {
  data: { singlePage: false },
  setData(patch) {
    Object.assign(this.data, patch)
  },
}
homePage.onOrganizerTap.call(homeCtx, {
  currentTarget: {
    dataset: {
      occupied: true,
      slot: 3,
      name: '山野阿宽',
      avatarUrl: 'https://tmp.test/host-3.png',
      avatarColor: '#45B7D1',
      avatarText: '山',
    },
  },
})
assert.deepStrictEqual(
  memory.square_pending_organizer,
  undefined,
  '点击主办方不再把筛选条件写入广场'
)
assert.strictEqual(
  navigatedUrl,
  '/pages/organizer/home/index?hostSlot=3',
  '点击主办方应进入独立的主办方主页'
)

switchedUrl = ''
navigatedUrl = ''
toasts.length = 0
homePage.onOrganizerTap.call(homeCtx, {
  currentTarget: { dataset: { occupied: false, slot: 4, name: EMPTY_ORGANIZER_TEXT } },
})
assert.strictEqual(switchedUrl, '', '待入驻坑位不可跳转')
assert.strictEqual(navigatedUrl, '', '待入驻坑位不能进入主办方主页')
assert.deepStrictEqual(toasts, ['用户入驻请联系客服'], '点击待入驻坑位应提示联系客服')

const homeWxml = fs.readFileSync(path.join(ROOT, 'pages/home/home.wxml'), 'utf8')
assert.match(homeWxml, /<text class="section-title">活动主办方<\/text>/, '首页板块标题应改为活动主办方')
assert.doesNotMatch(homeWxml, /发现户外玩法/, '首页不应继续展示发现户外玩法卡片')
assert.match(homeWxml, /buildHomeOrganizerSlots|organizerSlots/, '首页应渲染主办方坑位数据')

const avatarOptions = []
global.Component = (options) => avatarOptions.push(options)
delete require.cache[path.join(ROOT, 'components/avatar/index.js')]
require(path.join(ROOT, 'components/avatar/index.js'))
delete global.Component
const avatarComponent = avatarOptions[0]
assert.strictEqual(
  avatarComponent && avatarComponent.properties && avatarComponent.properties.shape
    ? avatarComponent.properties.shape.value
    : undefined,
  'circle',
  '头像组件默认仍应为圆形，避免影响活动卡片里的其他头像'
)
const avatarWxml = fs.readFileSync(path.join(ROOT, 'components/avatar/index.wxml'), 'utf8')
const avatarWxss = fs.readFileSync(path.join(ROOT, 'components/avatar/index.wxss'), 'utf8')
assert.match(
  avatarWxml,
  /avatar-\{\{shape === 'square' \? 'square' : 'circle'\}\}/,
  '头像组件应支持正方形形状'
)
assert.match(avatarWxss, /\.avatar-square\s*\{[^}]*border-radius:\s*12rpx/s, '正方形头像应保留轻微圆角')
assert.match(homeWxml, /<avatar[\s\S]*?class="organizer-avatar"[\s\S]*?shape="square"/, '首页主办方头像应使用正方形')

const homeWxss = fs.readFileSync(path.join(ROOT, 'pages/home/home.wxss'), 'utf8')
assert.match(
  homeWxss,
  /\.organizer-empty-avatar\s*\{[^}]*border-radius:\s*12rpx/s,
  '待入驻占位应与主办方头像同为轻微圆角正方形'
)

console.log('首页主办方坑位测试通过')
