const assert = require('assert')
const fs = require('fs')
const path = require('path')

const ROOT = path.resolve(__dirname, '..')
const pageFile = path.join(ROOT, 'pages/organizer/home/index.js')
assert.ok(fs.existsSync(pageFile), '应新增独立的主办方主页')

const memory = {}
let navigatedUrl = ''
let chooseMediaOptions = null
let pageTitles = []
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
  navigateTo({ url }) {
    navigatedUrl = url
  },
  setNavigationBarTitle({ title }) {
    pageTitles.push(title)
  },
  chooseMedia(options) {
    chooseMediaOptions = options
  },
  showToast() {},
  stopPullDownRefresh() {},
}
global.Behavior = (options) => options
global.getApp = () => ({ globalData: { user: null } })

const config = require(path.join(ROOT, 'services/config'))
config.useMock = true
const api = require(path.join(ROOT, 'services/api'))
api.organizer = (hostSlot) =>
  Promise.resolve({
    slot: hostSlot,
    nickName: '山野阿宽',
    avatarUrl: 'https://tmp.test/host.png',
    coverUrl: 'https://tmp.test/cover.jpg',
    isOwner: true,
    avatarColor: '#4ECDC4',
    avatarText: '山',
  })
let coverUpdate = null
api.updateOrganizerCover = (hostSlot, cover) => {
  coverUpdate = { hostSlot, cover }
  return Promise.resolve({ coverUrl: cover })
}
api.list = (query) =>
  Promise.resolve({
    list: [
      {
        id: 'act_host',
        title: '阿宽的主办活动',
        organizer: {
          nickName: '山野阿宽',
          avatarColor: '#4ECDC4',
          avatarUrl: '',
          avatarText: '山',
        },
        joinedPeople: [],
      },
    ],
    hasMore: false,
    total: 1,
    query,
  })

const pages = []
const originPage = global.Page
global.Page = (options) => pages.push(options)
delete require.cache[pageFile]
require(pageFile)
global.Page = originPage
const page = pages[0]
assert.ok(page && typeof page.onLoad === 'function', '主办方主页应提供加载逻辑')

function makeCtx() {
  const ctx = Object.assign({}, page)
  ctx.data = JSON.parse(JSON.stringify(page.data))
  ctx.setData = function setData(patch) {
    Object.keys(patch).forEach((key) => {
      const parts = key.split('.')
      let target = this.data
      for (let i = 0; i < parts.length - 1; i += 1) {
        if (!target[parts[i]]) target[parts[i]] = {}
        target = target[parts[i]]
      }
      target[parts[parts.length - 1]] = patch[key]
    })
  }
  return ctx
}

async function run() {
  const ctx = makeCtx()
  await page.onLoad.call(ctx, { hostSlot: '3' })
  assert.strictEqual(ctx.data.hostSlot, 3, '主办方主页应读取坑位号')
  assert.deepStrictEqual(
    pageTitles,
    ['主办方活动集合'],
    '页面标题应固定为主办方活动集合，且不被主办方昵称覆盖'
  )
  assert.strictEqual(ctx.data.organizer.nickName, '山野阿宽', '顶部应加载主办方昵称')
  assert.strictEqual(ctx.data.organizer.isOwner, true, '主办方本人应获得编辑权限')
  assert.strictEqual(ctx.data.organizer.coverUrl, 'https://tmp.test/cover.jpg', '应加载主页背景图')
  assert.strictEqual(ctx.data.list.length, 1, '下方应加载主办方活动')
  assert.strictEqual(ctx.data.list[0].id, 'act_host', '列表应保留活动 id 供详情跳转')

  page.onCardTap.call(ctx, { detail: { id: 'act_host' } })
  assert.strictEqual(
    navigatedUrl,
    '/pages/activity/detail/index?id=act_host',
    '点击主办方活动应进入活动详情'
  )

  const savedCover = page.changeCover.call(ctx)
  assert.ok(chooseMediaOptions, '主办方点击换背景入口应打开图片选择器')
  assert.deepStrictEqual(chooseMediaOptions.mediaType, ['image'], '主页背景只能选择图片')
  chooseMediaOptions.success({
    tempFiles: [{ tempFilePath: 'https://tmp.test/new-cover.jpg' }],
  })
  await savedCover
  assert.deepStrictEqual(
    coverUpdate,
    { hostSlot: 3, cover: 'https://tmp.test/new-cover.jpg' },
    '选图后应保存到自己的主办方主页'
  )
  assert.strictEqual(
    ctx.data.organizer.coverUrl,
    'https://tmp.test/new-cover.jpg',
    '保存成功后应立即展示新背景图'
  )

  ctx.data.organizer.isOwner = false
  chooseMediaOptions = null
  const visitorResult = await page.changeCover.call(ctx)
  assert.strictEqual(visitorResult, false, '其他访问者不能执行更换背景')
  assert.strictEqual(chooseMediaOptions, null, '其他访问者不会打开图片选择器')

  const cloudCtx = makeCtx()
  cloudCtx.data.hostSlot = 2
  cloudCtx.data.organizer = Object.assign({}, ctx.data.organizer, {
    isOwner: true,
    coverUrl: '',
  })
  let uploadOptions = null
  global.wx.cloud = {
    uploadFile(options) {
      uploadOptions = options
      options.success({ fileID: 'cloud://env.test/organizer-cover/cloud.jpg' })
    },
  }
  config.useMock = false
  const cloudSaved = page.changeCover.call(cloudCtx)
  chooseMediaOptions.success({
    tempFiles: [{ tempFilePath: 'wxfile://tmp/new-cover.jpg' }],
  })
  await cloudSaved
  config.useMock = true
  assert.ok(uploadOptions, '云模式应先上传本机选中的背景图')
  assert.match(uploadOptions.cloudPath, /^organizer-cover\//, '背景图应上传到独立目录')
  assert.deepStrictEqual(
    coverUpdate,
    { hostSlot: 2, cover: 'cloud://env.test/organizer-cover/cloud.jpg' },
    '云模式应把文件 ID 而不是本机临时路径保存到主页'
  )

  const wxml = fs.readFileSync(path.join(ROOT, 'pages/organizer/home/index.wxml'), 'utf8')
  assert.match(wxml, /<activity-card/, '主办方主页应复用广场的活动卡片组件')
  const fixedStart = wxml.indexOf('<view class="organizer-fixed">')
  const listScrollStart = wxml.indexOf('<scroll-view')
  const activityCardStart = wxml.indexOf('<activity-card')
  assert.ok(fixedStart > -1, '主办方主页应提供固定顶部区域')
  assert.ok(listScrollStart > fixedStart, '活动列表滚动区应位于固定顶部区域之后')
  assert.ok(activityCardStart > listScrollStart, '活动卡片应放在独立滚动列表内')
  const fixedMarkup = wxml.slice(fixedStart, listScrollStart)
  assert.match(fixedMarkup, /class="organizer-hero[^"]*"/, '背景和昵称区域应固定在页面顶部')
  assert.match(
    fixedMarkup,
    /class="section-head organizer-section-head"[\s\S]*?<text class="section-title">主办方活动<\/text>/,
    '列表上方的主办方活动标题应固定在滚动区之外'
  )
  assert.match(wxml, /class="organizer-hero[^"]*"/, '主办方主页顶部应展示头像昵称区域')
  const heroTags = wxml.match(/<view[^>]*class="organizer-hero[^"]*"[^>]*>/g) || []
  assert.ok(heroTags.length > 0, '主办方主页应渲染头像昵称区域')
  assert.ok(
    heroTags.every((tag) => !/\bcard\b/.test(tag)),
    '主办方头像昵称应直接平铺在页面背景上，不使用卡片容器'
  )
  assert.match(
    wxml,
    /class="organizer-hero-image"[^>]*mode="aspectFill"/,
    '主办方头像应以 aspectFill 铺满整个头部区域'
  )
  assert.match(wxml, /class="organizer-hero-shade"/, '昵称下方应有渐变遮罩保证文字可读')
  assert.match(wxml, /class="organizer-hero-name"/, '主办方昵称应叠加在头像底部')
  const wxss = fs.readFileSync(path.join(ROOT, 'pages/organizer/home/index.wxss'), 'utf8')
  const nameStyle = (wxss.match(/\.organizer-hero-name\s*\{([\s\S]*?)\}/) || [])[1] || ''
  assert.match(
    nameStyle,
    /background:\s*rgba\(\s*0,\s*0,\s*0,\s*0?\.\d+\s*\)/,
    '主办方昵称应使用半透明黑色背景提升可读性'
  )
  assert.match(nameStyle, /border-radius:\s*0(?:rpx)?;/, '主办方昵称背景应使用直角')
  assert.match(
    wxml,
    /wx:if="\{\{organizer\.isOwner\}\}"[^>]*class="organizer-cover-edit"|class="organizer-cover-edit"[^>]*wx:if="\{\{organizer\.isOwner\}\}"/,
    '换背景入口只能对主办方本人展示'
  )

  const appJson = JSON.parse(fs.readFileSync(path.join(ROOT, 'app.json'), 'utf8'))
  assert.ok(
    appJson.pages.indexOf('pages/organizer/home/index') > -1,
    '主办方主页应注册为独立页面路由'
  )

  console.log('主办方主页测试通过')
}

run().catch((err) => {
  console.error(err)
  process.exit(1)
})
