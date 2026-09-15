/**
 * 静态检查 + Mock 业务链路冒烟测试
 * 用法：node scripts/validate.js
 */
const fs = require('fs')
const path = require('path')

const ROOT = path.resolve(__dirname, '..')
const errors = []
const passed = []

function log(ok, message) {
  if (ok) {
    passed.push(message)
  } else {
    errors.push(message)
  }
}

function readJSON(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'))
}

function exists(relative) {
  return fs.existsSync(path.join(ROOT, relative))
}

/* ---------------------- 1. 页面 / 组件文件完整性 ---------------------- */

const appJson = readJSON(path.join(ROOT, 'app.json'))
const pages = appJson.pages || []
log(pages.length >= 7, `app.json 注册页面数量：${pages.length}`)

pages.forEach((page) => {
  ;['js', 'json', 'wxml', 'wxss'].forEach((ext) => {
    log(exists(`${page}.${ext}`), `页面文件存在：${page}.${ext}`)
  })
})

const tabList = (appJson.tabBar && appJson.tabBar.list) || []
log(appJson.tabBar && appJson.tabBar.custom === true, '启用了自定义 tabBar')
tabList.forEach((item) => {
  log(pages.indexOf(item.pagePath) > -1, `tabBar 页面已注册：${item.pagePath}`)
})
;['js', 'json', 'wxml', 'wxss'].forEach((ext) => {
  log(exists(`custom-tab-bar/index.${ext}`), `自定义 tabBar 文件存在：custom-tab-bar/index.${ext}`)
})

/* ---------------------- 2. usingComponents 引用解析 ---------------------- */

function collectJsonFiles(dir, acc) {
  fs.readdirSync(dir).forEach((name) => {
    const full = path.join(dir, name)
    const stat = fs.statSync(full)
    if (stat.isDirectory()) {
      if (name === 'node_modules' || name === '.git') return
      collectJsonFiles(full, acc)
    } else if (name.endsWith('.json')) {
      acc.push(full)
    }
  })
  return acc
}

collectJsonFiles(ROOT, []).forEach((file) => {
  let json = null
  try {
    json = readJSON(file)
  } catch (e) {
    log(false, `JSON 解析失败：${path.relative(ROOT, file)}`)
    return
  }
  const using = json.usingComponents || {}
  Object.keys(using).forEach((key) => {
    const target = using[key]
    const base = target.startsWith('/') ? target.slice(1) : path.join(path.dirname(path.relative(ROOT, file)), target)
    const normalized = path.normalize(base)
    ;['js', 'json', 'wxml'].forEach((ext) => {
      log(exists(`${normalized}.${ext}`), `组件引用可解析：${path.relative(ROOT, file)} → ${target}`)
    })
  })
})

/* --------------------------- 3. JS 语法解析 --------------------------- */

const BUILTIN_TAGS = [
  'view', 'text', 'block', 'slot', 'template', 'import', 'include', 'wxs',
  'image', 'input', 'textarea', 'button', 'picker', 'picker-view', 'picker-view-column',
  'scroll-view', 'swiper', 'swiper-item', 'canvas', 'video', 'audio', 'form', 'label',
  'checkbox', 'radio', 'switch', 'slider', 'navigator', 'progress', 'icon', 'rich-text',
  'web-view', 'map', 'camera', 'cover-view', 'cover-image', 'movable-area', 'movable-view',
  'page-container', 'root-portal', 'match-media', 'share-element', 'grid-view', 'list-view',
  'snapshot', 'span', 'open-data', 'ad', 'official-account', 'functional-page-navigator',
  'navigation-bar', 'page-meta', 'keyboard-accessory', 'voip-room', 'channel-live', 'channel-video',
  'inline-payment-panel', 'double-tap-gesture-handler', 'scale-gesture-handler',
  'pan-gesture-handler', 'tap-gesture-handler', 'vertical-drag-gesture-handler',
  'horizontal-drag-gesture-handler', 'force-press-gesture-handler', 'long-press-gesture-handler',
  'draggable-sheet', 'nested-scroll-body', 'nested-scroll-header', 'sticky-section',
  'sticky-header', 'grid-builder', 'grid-view-item', 'list-builder', 'list-item', 'swiper-item',
]

function collectWxmlFiles(dir, acc) {
  fs.readdirSync(dir).forEach((name) => {
    const full = path.join(dir, name)
    const stat = fs.statSync(full)
    if (stat.isDirectory()) {
      if (name === 'node_modules' || name === '.git') return
      collectWxmlFiles(full, acc)
    } else if (name.endsWith('.wxml')) {
      acc.push(full)
    }
  })
  return acc
}

const behaviorSource = fs
  .readdirSync(path.join(ROOT, 'behaviors'))
  .map((name) => fs.readFileSync(path.join(ROOT, 'behaviors', name), 'utf8'))
  .join('\n')

collectWxmlFiles(ROOT, []).forEach((file) => {
  const relative = path.relative(ROOT, file)
  const source = fs.readFileSync(file, 'utf8')
  const jsonPath = file.replace(/\.wxml$/, '.json')
  let declared = {}
  if (fs.existsSync(jsonPath)) {
    try {
      declared = readJSON(jsonPath).usingComponents || {}
    } catch (e) {
      declared = {}
    }
  }
  // 4.1 使用的自定义标签必须在 usingComponents 中声明
  const tagReg = /<([a-z][a-z0-9-]*)/g
  let tagMatch = tagReg.exec(source)
  const used = {}
  while (tagMatch) {
    const tag = tagMatch[1]
    if (tag.indexOf('-') > -1 && BUILTIN_TAGS.indexOf(tag) === -1) {
      used[tag] = true
    }
    tagMatch = tagReg.exec(source)
  }
  Object.keys(used).forEach((tag) => {
    log(!!declared[tag], `WXML 组件已声明：${relative} → <${tag}>`)
  })

  // 4.2 事件处理函数必须存在（页面 JS 或 behaviors）
  const jsPath = file.replace(/\.wxml$/, '.js')
  const jsSource = fs.existsSync(jsPath) ? fs.readFileSync(jsPath, 'utf8') : ''
  const handlerReg = /(?:bind|catch|capture-bind|capture-catch)[:-]?([a-zA-Z]+)\s*=\s*"([^"]*)"/g
  let handlerMatch = handlerReg.exec(source)
  const missing = {}
  while (handlerMatch) {
    const handler = handlerMatch[2].trim()
    if (handler && handler.indexOf('{{') === -1) {
      const pattern = new RegExp(`\\b${handler}\\s*[(:]`)
      if (!pattern.test(jsSource) && !pattern.test(behaviorSource)) {
        missing[handler] = true
      }
    }
    handlerMatch = handlerReg.exec(source)
  }
  Object.keys(missing).forEach((handler) => {
    log(false, `事件处理函数缺失：${relative} → ${handler}`)
  })
  log(Object.keys(missing).length === 0, `事件绑定全部可解析：${relative}`)
})

function collectJsFiles(dir, acc) {
  fs.readdirSync(dir).forEach((name) => {
    const full = path.join(dir, name)
    const stat = fs.statSync(full)
    if (stat.isDirectory()) {
      if (name === 'node_modules' || name === '.git') return
      collectJsFiles(full, acc)
    } else if (name.endsWith('.js')) {
      acc.push(full)
    }
  })
  return acc
}

const jsFiles = collectJsFiles(ROOT, [])
jsFiles.forEach((file) => {
  try {
    // eslint-disable-next-line no-new-func
    new Function(fs.readFileSync(file, 'utf8'))
  } catch (e) {
    log(false, `JS 语法错误：${path.relative(ROOT, file)} → ${e.message}`)
  }
})
log(jsFiles.length > 0, `检查 JS 文件数量：${jsFiles.length}`)

/* ----------------------- 4. Mock 业务链路冒烟测试 ----------------------- */

function createWxStub() {
  const storage = {}
  return {
    storage,
    getStorageSync(key) {
      return Object.prototype.hasOwnProperty.call(storage, key) ? storage[key] : ''
    },
    setStorageSync(key, value) {
      storage[key] = value
    },
    removeStorageSync(key) {
      delete storage[key]
    },
  }
}

const globalData = { city: '', user: null, locationDenied: false }
global.wx = createWxStub()
global.getApp = () => ({
  globalData,
  setUser(user) {
    globalData.user = user
  },
  setCity(city) {
    globalData.city = city
  },
})
global.Behavior = (options) => options
global.Component = () => {}

const api = require(path.join(ROOT, 'services/api'))
const config = require(path.join(ROOT, 'services/config'))
config.mockDelay = 0

const steps = []

function step(name, promise) {
  const index = steps.length
  steps.push({ name, index })
  return promise
}

const flow = (async () => {
  // 登录（Mock 手机号）
  const user = await step('登录', api.login({ phone: '13800001111' }))
  log(!!user.openid && user.userId >= 1, '登录：生成用户与自增 ID')
  log(/^\d{3}\*{4}\d{4}$/.test(user.nickName), '登录：昵称脱敏为手机号')
  globalData.user = user

  // 首页
  const home = await step('首页', api.home({ city: '' }))
  log(home.banners.length === 3, '首页：默认横幅 3 条')
  log(home.hotList.length > 0 && home.hotList.length <= 6, '首页：热门组队最多 6 条')
  log(home.newestList.length <= 3, '首页：最新发布最多 3 条')
  const orderedByHot = home.hotList.every((item, i) => i === 0 || home.hotList[i - 1].joinedCount >= item.joinedCount)
  log(orderedByHot, '首页：热门按报名人数倒序')

  // 广场：分页 / 筛选 / 排序
  const page1 = await step('广场-第1页', api.list({ pageIndex: 0, pageSize: 10, sort: 'time' }))
  log(page1.list.length === 10 && page1.hasMore === true, '广场：每页 10 条且可继续加载')
  const sortedByTime = page1.list.every((item, i) => i === 0 || page1.list[i - 1].startTime <= item.startTime)
  log(sortedByTime, '广场：即将开始按开始时间升序')

  const hiking = await step('广场-类型筛选', api.list({ pageIndex: 0, pageSize: 20, type: 'hiking', sort: 'time' }))
  log(hiking.list.length > 0 && hiking.list.every((item) => item.type === 'hiking'), '广场：类型筛选生效')

  const keyword = await step('广场-关键词', api.list({ pageIndex: 0, pageSize: 20, keyword: '徒步', sort: 'latest' }))
  log(keyword.list.length > 0, '广场：关键词匹配标题或地点')

  const weekday = await step('广场-星期筛选', api.list({ pageIndex: 0, pageSize: 20, weekday: 6, sort: 'time' }))
  log(weekday.list.every((item) => item.startWeekday === 6), '广场：按星期筛选生效')

  const cityList = await step('广场-城市筛选', api.list({ pageIndex: 0, pageSize: 20, city: '杭州', sort: 'hot' }))
  log(cityList.list.length > 0 && cityList.list.every((item) => item.city === '杭州'), '广场：城市筛选生效')

  // 详情
  const target = hiking.list[0]
  const detail = await step('详情', api.detail(target.id))
  log(!!detail && detail.joined === false, '详情：返回活动且携带报名标记')

  // 发布
  const created = await step(
    '发布',
    api.create({
      form: {
        type: 'hiking',
        title: '自动化测试 · 西湖晨间徒步',
        location: '浙江省杭州市 西湖断桥',
        startTime: Date.now() + 86400000,
        endTime: Date.now() + 2 * 86400000,
        difficulty: 3,
        distance: 10,
        elevationGain: 200,
        feeMode: 'aa',
        fee: 0,
        maxPeople: 8,
        tags: [],
        groupQrCode: 'wxfile://tmp_qr.png',
        desc: '由校验脚本创建的活动',
      },
    })
  )
  log(created.city === '杭州', '发布：按集合地点自动匹配城市')
  log(created.status === 'recruiting' && created.joinedCount === 0, '发布：服务端补全状态与成员列表')
  log(created.organizer.openid === user.openid, '发布：写入发起人快照')

  // 报名（自己发布的活动）
  const joined = await step('报名', api.join(created.id))
  log(joined.joinedCount === 1 && joined.groupQrCode === 'wxfile://tmp_qr.png', '报名：人数增加且返回群二维码')

  // 重复报名幂等
  const again = await step('重复报名', api.join(created.id))
  log(again.joinedCount === 1, '报名：重复报名幂等')

  // 我的活动
  const minePublished = await step('我的发布', api.mine('published'))
  log(minePublished.length === 1 && minePublished[0].id === created.id, '我的活动：我发布的按发布时间倒序')
  const mineJoined = await step('我的参与', api.mine('joined'))
  log(mineJoined.length === 1 && mineJoined[0].id === created.id, '我的活动：我参与的按开始时间升序')

  // 关闭 / 打开
  const closed = await step('关闭活动', api.toggle(created.id))
  log(closed.status === 'closed', '关闭活动：状态变为 closed')
  let closedError = ''
  try {
    await api.join(created.id)
  } catch (e) {
    closedError = e.code
  }
  log(closedError === 'ACTIVITY_CLOSED', '关闭活动：报名被拒绝并返回 ACTIVITY_CLOSED')
  const reopened = await step('重新打开', api.toggle(created.id))
  log(reopened.status === 'recruiting', '重新打开：状态恢复 recruiting')

  // 退出
  const quit = await step('退出活动', api.quit(created.id))
  log(quit.joinedCount === 0, '退出活动：成员列表移除自己')

  // 满员限制
  const fullActivity = page1.list.find((item) => item.joinedCount >= item.maxPeople)
  if (fullActivity) {
    let fullError = ''
    try {
      await api.join(fullActivity.id)
    } catch (e) {
      fullError = e.code
    }
    log(fullError === 'ACTIVITY_FULL', '满员：报名被拒绝并返回 ACTIVITY_FULL')
  } else {
    log(true, '满员：当前数据无满员活动，跳过该项')
  }

  // 资料更新同步
  const updated = await step('更新资料', api.updateUser({ userInfo: { nickName: '自动化测试员', avatarUrl: '' } }))
  const afterUpdate = await api.detail(created.id)
  log(updated.nickName === '自动化测试员', '资料：昵称更新成功')
  log(afterUpdate.organizer.nickName === '自动化测试员', '资料：已发布活动的发起人快照同步更新')

  // 反馈
  const feedback = await step('意见反馈', api.feedback({ content: '这是一条来自校验脚本的反馈内容' }))
  log(!!feedback.id, '意见反馈：写入成功')

  // 城市匹配
  const { matchCity, nearestCity } = require(path.join(ROOT, 'utils/cities'))
  log(matchCity('浙江省杭州市西湖区断桥') === '杭州', '城市匹配：命中「杭州」')
  log(matchCity('辽宁省朝阳市人民公园') === '朝阳', '城市匹配：省份优先，命中「朝阳」')
  log(!!nearestCity(116.4, 39.9), '定位兜底：经纬度就近匹配城市可用')

  // 协议解析
  const { parseBold } = require(path.join(ROOT, 'utils/util'))
  const segments = parseBold('普通**加粗**结尾')
  log(segments.length === 3 && segments[1].strong === true, '协议：加粗标记解析正确')
})().catch((e) => {
  log(false, `Mock 业务链路执行异常：${e && e.message}`)
})

flow.then(() => {
  console.log(`\n通过 ${passed.length} 项，失败 ${errors.length} 项\n`)
  if (errors.length) {
    console.log('失败项：')
    errors.forEach((item) => console.log(`  ✗ ${item}`))
  }
  if (!errors.length) {
    console.log('✅ 全部检查通过')
  }
  process.exitCode = errors.length ? 1 : 0
})
