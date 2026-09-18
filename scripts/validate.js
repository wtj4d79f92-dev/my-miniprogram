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
      // scripts/ 里放的是本地校验脚本与提审导出物（activities.json 是逐行 JSON，不是标准 JSON），
      // 不参与 usingComponents 引用解析；云函数目录里也没有页面配置
      if (name === 'node_modules' || name === '.git' || name === 'scripts') return
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

/* -------------- 3.6 云调用权限声明检查 --------------
 * 云调用必须在小程序云函数 config.json 的 permissions.openapi 里声明接口名，漏了线上直接调用失败。
 * 这里把「代码里真正用到的 cloud.openapi.* 接口」和声明对一遍，避免加了新接口忘了改配置。
 */
fs.readdirSync(path.join(ROOT, 'cloudfunctions'))
  .filter((name) => fs.existsSync(path.join(ROOT, 'cloudfunctions', name, 'index.js')))
  .forEach((name) => {
    const dir = path.join(ROOT, 'cloudfunctions', name)
    const used = new Set()
    const walk = (target) => {
      fs.readdirSync(target, { withFileTypes: true }).forEach((entry) => {
        const full = path.join(target, entry.name)
        if (entry.isDirectory()) {
          walk(full)
          return
        }
        if (entry.name.slice(-3) !== '.js') return
        const source = fs.readFileSync(full, 'utf8')
        const pattern = /cloud\.openapi\.([A-Za-z]+)\.([A-Za-z]+)/g
        let matched = pattern.exec(source)
        while (matched) {
          used.add(`${matched[1]}.${matched[2]}`)
          matched = pattern.exec(source)
        }
      })
    }
    walk(dir)
    const config = readJSON(path.join(dir, 'config.json')) || {}
    const declared = ((config.permissions || {}).openapi || []).slice()
    const missing = Array.from(used).filter((api) => declared.indexOf(api) === -1)
    log(
      missing.length === 0,
      `云调用权限：${name} 声明的接口覆盖代码用到的${missing.length ? `（缺 ${missing.join('、')}）` : ''}`
    )
  })

/* -------------- 3.8 地理位置接口声明检查 --------------
 * requiredPrivateInfos 里没声明的地理位置接口，线上调用会直接 fail，用户侧只看到「定位未开启」。
 * 这里把「代码里真正用到的接口」和 app.json 的声明对一遍，避免换了定位接口忘了改声明。
 * 只看随包上传的业务代码（scripts/ 是本地校验脚本，里面的桩函数不算），并跳过注释行，
 * 避免说明文字里提到的接口名被当成真实调用。
 */
const declaredPrivateInfos = appJson.requiredPrivateInfos || []
const privateInfoPattern =
  /wx\.(getFuzzyLocation|getLocation|onLocationChange|startLocationUpdate|startLocationUpdateBackground|chooseLocation|choosePoi|chooseAddress)\b/g
const usedPrivateInfos = new Set()
jsFiles
  .filter((file) => path.relative(ROOT, file).indexOf(`scripts${path.sep}`) !== 0)
  .forEach((file) => {
    const source = fs
      .readFileSync(file, 'utf8')
      .split('\n')
      .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
      .join('\n')
    let matched = privateInfoPattern.exec(source)
    while (matched) {
      usedPrivateInfos.add(matched[1])
      matched = privateInfoPattern.exec(source)
    }
  })
const missingPrivateInfos = Array.from(usedPrivateInfos).filter((api) => declaredPrivateInfos.indexOf(api) === -1)
log(
  missingPrivateInfos.length === 0,
  `地理位置接口声明：app.json 覆盖代码用到的${missingPrivateInfos.length ? `（缺 ${missingPrivateInfos.join('、')}）` : ''}`
)

/* -------------- 3.7 前后端镜像文件一致性检查 --------------
 * 云函数打包时只上传自己的目录，require 不到小程序根目录的文件，所以城市字典、机审放行判定
 * 这几处都在云函数里留了一份镜像副本。副本漂移最坏的结果是「前端显示一套、线上判定另一套」
 * （例如 Mock 里自动放行、云端却转人工），而两份文件分处不同目录，评审时很容易漏看。
 * 能直接比文本的就比文本，前端多带能力的城市字典改写一组输入比行为。
 */

/** 去掉整行注释与空行后比较：允许两份副本的注释各说各的，逻辑必须一字不差 */
function logicLines(relative) {
  return fs
    .readFileSync(path.join(ROOT, relative), 'utf8')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && line.slice(0, 2) !== '//' && line.slice(0, 2) !== '/*' && line[0] !== '*')
    .join('\n')
}

;[
  ['机审放行判定', 'cloudfunctions/activity/lib/autoAudit.js', 'cloudfunctions/contentCheck/lib/autoAudit.js'],
  // 文本检测：发布当刻由 activity 送检，图片结论回来时由 contentCheck 补检，两份必须同口径
  ['文本检测', 'cloudfunctions/activity/lib/textCheck.js', 'cloudfunctions/contentCheck/lib/textCheck.js'],
  // 展示期：前端 Mock 与云函数必须同口径，否则本地看着还在招募、线上已经自动关闭
  ['活动展示期', 'utils/expire.js', 'cloudfunctions/activity/lib/expire.js'],
].forEach((pair) => {
  const [name, left, right] = pair
  const bothExist = exists(left) && exists(right)
  log(bothExist && logicLines(left) === logicLines(right), `镜像副本一致：${name}（${left} ↔ ${right}）`)
})

// 机审「没有结论」不能显示成「机器通过」：否则审核台看着全绿、活动却停在待审队列，
// 运营既不知道原因也没法判断该不该放行（这就是「机审全通过却进了人工审核」的现场）
const auditPageJs = fs.readFileSync(path.join(ROOT, 'pages/admin/audit/index.js'), 'utf8')
const auditPageWxml = fs.readFileSync(path.join(ROOT, 'pages/admin/audit/index.wxml'), 'utf8')
log(/failed:\s*'未出结论（转人工）'/.test(auditPageJs), '审核台：机审没结论时有区别于「机器通过」的文案')
log(
  /machineTextFailed/.test(auditPageJs) && /machineTextFailed/.test(auditPageWxml),
  '审核台：待审卡片与详情都标出文本检测失败'
)

// 城市字典：前端比云端多一份经纬度表与就近匹配（定位兜底属于前端），其余函数必须同口径
const citiesFront = require(path.join(ROOT, 'utils/cities'))
const citiesCloud = require(path.join(ROOT, 'cloudfunctions/activity/lib/cities'))
const sharedCityFuncs = [
  'normalizeCity',
  'cityByName',
  'aliasByName',
  'provinceShortName',
  'provinceByName',
  'regionCityKeys',
  'filterCityKeys',
  'singleCityKey',
  'matchCity',
]
const cityInputs = Array.from(
  new Set(
    ['']
      .concat(citiesFront.PROVINCES.map((item) => item.name))
      .concat(citiesFront.PROVINCES.map((item) => citiesFront.provinceShortName(item.name)))
      .concat(citiesFront.ALL_CITIES)
      .concat([
        '吉林',
        '阳朔县',
        '双流区',
        '上海市浦东新区',
        '浙江省杭州市西湖区断桥',
        '辽宁省朝阳市人民公园',
        '香港',
        '台湾',
        '不存在的城市',
      ])
  )
)
const cityDiffs = []
sharedCityFuncs.forEach((fn) => {
  const frontFn = citiesFront[fn]
  const cloudFn = citiesCloud[fn]
  if (typeof frontFn !== 'function' || typeof cloudFn !== 'function') {
    cityDiffs.push(`${fn} 只在一侧导出`)
    return
  }
  cityInputs.forEach((input) => {
    const a = JSON.stringify(frontFn(input))
    const b = JSON.stringify(cloudFn(input))
    if (a !== b) cityDiffs.push(`${fn}(${JSON.stringify(input)}) 前端 ${a} / 云端 ${b}`)
  })
})
log(
  cityDiffs.length === 0,
  `镜像副本行为一致：城市字典（${sharedCityFuncs.length} 个函数 × ${cityInputs.length} 组输入）${
    cityDiffs.length ? `，差异：${cityDiffs.slice(0, 3).join('；')}` : ''
  }`
)

/* -------------- 3.5 Page / Component 配置重复成员名检查 -------------- */
/**
 * 同一对象字面量里重复定义同名成员时，后面的会静默覆盖前面的：
 * 例如分享面板的 bindtap 与页面生命周期同名，点击就会没有任何反应。
 * 这类问题既不报语法错误，也无法被上面的「事件处理函数存在」检查发现。
 */
function stripCommentsAndStrings(source) {
  let out = ''
  for (let i = 0; i < source.length; i++) {
    const char = source[i]
    if (char === '"' || char === "'" || char === '`') {
      out += char + char
      i += 1
      while (i < source.length && source[i] !== char) {
        if (source[i] === '\\') {
          out += source[i]
          i += 1
        }
        if (source[i] === '\n') out += '\n'
        i += 1
      }
      continue
    }
    if (char === '/' && source[i + 1] === '/') {
      while (i < source.length && source[i] !== '\n') i += 1
      out += '\n'
      continue
    }
    if (char === '/' && source[i + 1] === '*') {
      i += 2
      while (i < source.length && !(source[i] === '*' && source[i + 1] === '/')) {
        if (source[i] === '\n') out += '\n'
        i += 1
      }
      i += 1
      continue
    }
    out += char
  }
  return out
}

/** 取 Page({...}) / Component({...}) / Behavior({...}) 的配置对象源码 */
function extractConfigObject(source, callName) {
  const matched = new RegExp(`^\\s*${callName}\\(\\s*\\{`, 'm').exec(source)
  if (!matched) return ''
  let index = source.indexOf('{', matched.index)
  const start = index
  let depth = 0
  for (; index < source.length; index += 1) {
    const char = source[index]
    if (char === '"' || char === "'" || char === '`') {
      index += 1
      while (index < source.length && source[index] !== char) {
        if (source[index] === '\\') index += 1
        index += 1
      }
      continue
    }
    if (char === '/' && source[index + 1] === '/') {
      while (index < source.length && source[index] !== '\n') index += 1
      continue
    }
    if (char === '/' && source[index + 1] === '*') {
      const end = source.indexOf('*/', index + 2)
      index = end === -1 ? source.length : end + 1
      continue
    }
    if (char === '{') depth += 1
    else if (char === '}') {
      depth -= 1
      if (depth === 0) return source.slice(start, index + 1)
    }
  }
  return ''
}

/** 按顶层逗号切分，取出配置对象的成员名 */
function topLevelMemberNames(objectText) {
  const text = stripCommentsAndStrings(objectText)
  const names = []
  let depth = 0
  let memberStart = 1
  const collect = (segment) => {
    const matched =
      /^\s*(?:async\s+)?([A-Za-z_$][\w$]*)\s*\(/.exec(segment) ||
      /^\s*['"]?([A-Za-z_$][\w$]*)['"]?\s*:/.exec(segment)
    if (matched) names.push(matched[1])
  }
  for (let i = 1; i < text.length - 1; i += 1) {
    const char = text[i]
    if (char === '[' || char === '(' || char === '{') depth += 1
    else if (char === ']' || char === ')' || char === '}') depth -= 1
    else if (char === ',' && depth === 0) {
      collect(text.slice(memberStart, i))
      memberStart = i + 1
    }
  }
  collect(text.slice(memberStart, text.length - 1))
  return names
}

let duplicatedMemberFiles = 0
jsFiles.forEach((file) => {
  const source = fs.readFileSync(file, 'utf8')
  ;['Page', 'Component', 'Behavior'].forEach((callName) => {
    const objectText = extractConfigObject(source, callName)
    if (!objectText) return
    const names = topLevelMemberNames(objectText)
    const duplicated = names.filter((name, index) => names.indexOf(name) !== index)
    if (duplicated.length) {
      duplicatedMemberFiles += 1
      log(
        false,
        `配置成员重复定义（后者会覆盖前者）：${path.relative(ROOT, file)} → ${[...new Set(duplicated)].join('、')}`
      )
    }
  })
})
log(duplicatedMemberFiles === 0, '页面 / 组件配置无重复成员名')

/* ----------------------- 4. Mock 业务链路冒烟测试 ----------------------- */

function createWxStub() {
  const storage = {}
  return {
    storage,
    // 页面标题：搜索优化用，这里记录最后一次设置的值供断言
    navigationBarTitle: '',
    setNavigationBarTitle(options) {
      this.navigationBarTitle = (options && options.title) || ''
    },
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

const config = require(path.join(ROOT, 'services/config'))
// 冒烟测试覆盖的是 Mock 数据层，强制走本地模型，不受 config.useMock 开关影响
config.useMock = true
config.mockDelay = 0

const api = require(path.join(ROOT, 'services/api'))
const steps = []

function step(name, promise) {
  const index = steps.length
  steps.push({ name, index })
  return promise
}

const flow = (async () => {
  // 举报接口：Mock 与云端同一签名，未实现时按「未登录」以外的错误暴露出来
  const reportApi =
    typeof api.report === 'function'
      ? api.report
      : () => Promise.reject(Object.assign(new Error('提交举报失败'), { code: 'NOT_IMPLEMENTED' }))

  // 举报：未登录一律拒绝，与云端口径一致（登录用例在后面）
  const guestReport = await reportApi('mock_act_1', '广告骚扰').then(() => null, (err) => err)
  log(!!guestReport && guestReport.code === 'UNAUTHORIZED', '举报：未登录拒绝提交')

  // 登录（Mock 手机号）
  const user = await step('登录', api.login({ phone: '13800001111' }))
  log(!!user.openid && user.userId >= 1, '登录：生成用户与自增 ID')
  // 昵称对外可见（活动卡片、报名名单），不能用手机号（哪怕是掩码）
  log(
    !/^\d{3}\*{4}\d{4}$/.test(user.nickName) && user.nickName.indexOf('138') === -1,
    '登录：默认昵称不含手机号，改用「微信用户 + 编号」'
  )
  log(user.nickName === `微信用户${user.userId}`, '登录：默认昵称带用户编号，报名名单里仍可区分')
  globalData.user = user

  // 首页
  const home = await step('首页', api.home({ city: '' }))
  log(home.banners.length === 3, '首页：默认横幅 3 条')
  log(home.hotList.length > 0 && home.hotList.length <= 6, '首页：热门组队最多 6 条')
  log(home.newestList.length <= 3, '首页：最新发布最多 3 条')
  const orderedByHot = home.hotList.every((item, i) => i === 0 || home.hotList[i - 1].joinedCount >= item.joinedCount)
  log(orderedByHot, '首页：热门按报名人数倒序')

  // 广场：分页 / 筛选 / 排序（页面默认排序为「最新发布」）
  const page1 = await step('广场-第1页', api.list({ pageIndex: 0, pageSize: 10, sort: 'latest' }))
  log(page1.list.length === 10 && page1.hasMore === true, '广场：每页 10 条且可继续加载')
  const sortedByCreate = page1.list.every((item, i) => i === 0 || page1.list[i - 1].createTime >= item.createTime)
  log(sortedByCreate, '广场：默认按最新发布（发布时间倒序）排列')

  const hiking = await step('广场-类型筛选', api.list({ pageIndex: 0, pageSize: 20, type: 'hiking', sort: 'latest' }))
  log(hiking.list.length > 0 && hiking.list.every((item) => item.type === 'hiking'), '广场：类型筛选生效')

  const keyword = await step('广场-关键词', api.list({ pageIndex: 0, pageSize: 20, keyword: '徒步', sort: 'latest' }))
  log(keyword.list.length > 0, '广场：关键词匹配标题或地点')

  const weekday = await step('广场-星期筛选', api.list({ pageIndex: 0, pageSize: 20, weekday: 6, sort: 'latest' }))
  log(weekday.list.every((item) => item.startWeekday === 6), '广场：按星期筛选生效')

  // 具体日期筛选：date 传当天 00:00 的时间戳（与广场日期选择器同一口径）
  const tomorrow = new Date()
  tomorrow.setHours(0, 0, 0, 0)
  const dateStart = tomorrow.getTime() + 86400000
  const dateList = await step('广场-日期筛选', api.list({ pageIndex: 0, pageSize: 20, date: dateStart, sort: 'latest' }))
  log(
    dateList.list.length > 0 && dateList.list.every((item) => item.startTime >= dateStart && item.startTime < dateStart + 86400000),
    '广场：按具体日期筛选生效'
  )

  const cityList = await step('广场-城市筛选', api.list({ pageIndex: 0, pageSize: 20, city: '杭州', sort: 'hot' }))
  log(cityList.list.length > 0 && cityList.list.every((item) => item.city === '杭州'), '广场：城市筛选生效')

  // 省份筛选：省 + 全部要看全省，省份与城市都选「全部」才是全国
  const { provinceOfCity } = require(path.join(ROOT, 'utils/cities'))
  const provinceList = await step('广场-省份筛选', api.list({ pageIndex: 0, pageSize: 50, city: '广东省', sort: 'hot' }))
  log(
    provinceList.list.length > 0 && provinceList.list.every((item) => provinceOfCity(item.city) === '广东省'),
    '广场：省 + 全部筛选出广东范围内的活动'
  )
  const nationList = await step('广场-全部地区', api.list({ pageIndex: 0, pageSize: 100, city: '', sort: 'hot' }))
  log(nationList.total > provinceList.total, '广场：全部 + 全部展示全国活动')

  const homeProvince = await step('首页-省份筛选', api.home({ city: '广东省' }))
  const homeProvinceList = homeProvince.hotList.concat(homeProvince.newestList)
  log(
    homeProvinceList.length > 0 && homeProvinceList.every((item) => provinceOfCity(item.city) === '广东省'),
    '首页：省 + 全部筛选出广东范围内的活动'
  )

  // 详情
  const target = hiking.list[0]
  const detail = await step('详情', api.detail(target.id))
  log(!!detail && detail.joined === false, '详情：返回活动且携带报名标记')

  // 举报：登录后写入本地举报列表，运营侧可复核
  const report = await step('举报', reportApi(target.id, '广告骚扰').catch((err) => err))
  log(!!report && !!report.id && report.status === 'pending', '举报：提交成功返回记录')
  const reportKeys = require(path.join(ROOT, 'utils/storage')).KEYS
  const reportList = (global.wx.storage[reportKeys.feedback] || []).filter((item) => item.kind === 'report')
  log(
    reportList.length === 1 && reportList[0].activityId === target.id && reportList[0].reason === '广告骚扰',
    '举报：本地记录写在反馈列表里且带 kind=report（Mock）'
  )

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
        maxPeople: 8,
        tags: [],
        groupQrCode: 'wxfile://tmp_qr.png',
        // 命中 Mock 的「疑似」关键词：机审判定为需复核，走人工审核链路（自动放行的用例在末尾）
        desc: '由校验脚本创建的活动，疑似需要人工确认集合时间',
      },
    })
  )
  log(created.city === '杭州', '发布：按集合地点自动匹配城市')
  log(created.status === 'recruiting' && created.joinedCount === 0, '发布：服务端补全状态与成员列表')
  log(created.organizer.openid === user.openid, '发布：写入发起人快照')
  log(created.auditStatus === 'pending', '发布：新活动进入待审核队列')
  log(created.machineCheck.text.suggest === 'review', '内容安全：疑似内容记录机器复核结论并留在人工队列')

  // 内容安全（Mock 用关键词模拟云端 msgSecCheck）
  let riskyError = ''
  try {
    await api.create({
      form: {
        type: 'hiking',
        title: '违规测试活动',
        location: '浙江省杭州市 西湖',
        startTime: Date.now() + 86400000,
        endTime: Date.now() + 2 * 86400000,
        groupQrCode: 'mock://qr',
      },
    })
  } catch (e) {
    riskyError = e.code
  }
  log(riskyError === 'CONTENT_RISKY', '内容安全：命中违规关键词直接拦截')

  // 审核前：活动不能出现在广场 / 首页，也不能被别人报名
  const afterCreate = await step('审核前广场', api.list({ pageIndex: 0, pageSize: 100, sort: 'latest' }))
  log(afterCreate.list.every((item) => item.id !== created.id), '审核中：活动不出现在广场列表')
  const homeAfterCreate = await step('审核前首页', api.home({ city: '杭州' }))
  const homeVisible = homeAfterCreate.hotList.concat(homeAfterCreate.newestList)
  log(homeVisible.every((item) => item.id !== created.id), '审核中：活动不出现在首页')
  let pendingJoinError = ''
  try {
    await api.join(created.id)
  } catch (e) {
    pendingJoinError = e.code
  }
  log(pendingJoinError === 'AUDIT_PENDING', '审核中：报名被拒绝并返回 AUDIT_PENDING')
  const ownerPreview = await step('审核中我的发布', api.mine('published'))
  log(ownerPreview.some((item) => item.id === created.id), '审核中：发起人仍能在「我发布的」看到自己的活动')

  // 审核后台：待审列表 → 驳回 → 修改重提 → 通过
  const whoami = await step('管理员身份', api.adminWhoami())
  log(whoami.isAdmin === true, '审核台：识别审核人身份')
  const pendingList = await step('待审列表', api.adminList({ status: 'pending' }))
  log(pendingList.list.some((item) => item.id === created.id), '审核台：待审列表包含新活动')
  log(pendingList.stats.pending >= 1, '审核台：待审数量统计可用')

  const rejected = await step('审核驳回', api.adminReject(created.id, '活动介绍过于简略，请补充路线与装备说明'))
  log(rejected.auditStatus === 'rejected', '审核台：驳回写入审核状态')
  const rejectedDetail = await step('驳回后详情', api.detail(created.id))
  log(rejectedDetail.auditStatus === 'rejected' && !!rejectedDetail.auditRemark, '审核台：发起人能看到驳回原因')
  let emptyRemarkError = ''
  try {
    await api.adminReject(created.id, '   ')
  } catch (e) {
    emptyRemarkError = e.code
  }
  log(emptyRemarkError === 'INVALID_PARAM', '审核台：驳回必须填写原因')

  const edited = await step(
    '编辑重提',
    api.update({
      id: created.id,
      form: {
        type: 'hiking',
        title: '自动化测试 · 西湖晨间徒步（已补充说明）',
        location: '浙江省杭州市 西湖断桥',
        startTime: created.startTime,
        endTime: created.endTime,
        difficulty: 3,
        distance: 10,
        elevationGain: 200,
        feeMode: 'aa',
        maxPeople: 8,
        tags: [],
        groupQrCode: 'wxfile://tmp_qr.png',
        // 编辑重提同样要过机审：疑似内容仍然留给人工，不会因为改动而被自动放行
        desc: '补充：全程 10 公里，需要运动鞋与 1L 饮水。疑似需人工确认难度。',
      },
    })
  )
  log(edited.auditStatus === 'pending' && edited.auditRemark === '', '编辑重提：回到待审核并清空上一条驳回意见')
  log(edited.id === created.id && edited.joinedCount === 0, '编辑重提：沿用原活动，报名数据不受影响')

  const approved = await step('审核通过', api.adminApprove(created.id))
  log(approved.auditStatus === 'approved', '审核台：通过写入审核状态')
  const afterApprove = await step('审核后广场', api.list({ pageIndex: 0, pageSize: 100, sort: 'latest' }))
  log(afterApprove.list.some((item) => item.id === created.id), '审核通过：活动出现在广场列表')

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
  log(closed.status === 'closed' && closed.closeTime > 0, '关闭活动：状态变为 closed 并记录关闭时间')
  let closedError = ''
  try {
    await api.join(created.id)
  } catch (e) {
    closedError = e.code
  }
  log(closedError === 'ACTIVITY_CLOSED', '关闭活动：报名被拒绝并返回 ACTIVITY_CLOSED')

  // 关闭当天：仍留在广场但沉底，首页推荐位不再展示
  const closedSquare = await step('关闭后广场', api.list({ pageIndex: 0, pageSize: 100, sort: 'latest' }))
  const closedIndex = closedSquare.list.findIndex((item) => item.id === created.id)
  log(closedIndex > -1, '关闭活动：关闭当天仍留在广场')
  log(
    closedIndex > -1 && closedSquare.list.slice(0, closedIndex).every((item) => item.status !== 'closed'),
    '关闭活动：已关闭的活动沉底，排在未关闭活动之后'
  )
  const closedHotSquare = await step('关闭后广场-最热门', api.list({ pageIndex: 0, pageSize: 100, sort: 'hot' }))
  log(
    closedHotSquare.list.findIndex((item) => item.status === 'closed') >=
      closedHotSquare.list.filter((item) => item.status !== 'closed').length,
    '关闭活动：按最热门排序时同样沉底'
  )
  const closedHome = await step('关闭后首页', api.home({ city: '' }))
  log(
    closedHome.hotList.concat(closedHome.newestList).every((item) => item.status !== 'closed'),
    '关闭活动：首页热门 / 最新不展示已关闭的活动'
  )

  // 第二天：把关闭时间改到昨天，广场不再展示，但详情与我的活动照旧
  const mockModel = require(path.join(ROOT, 'services/mock'))
  const statusMap = Object.assign({}, global.wx.storage[mockModel.MOCK_STATUS_MAP])
  statusMap[created.id] = { status: 'closed', closeTime: new Date().setHours(0, 0, 0, 0) - 86400000 }
  global.wx.storage[mockModel.MOCK_STATUS_MAP] = statusMap
  const nextDaySquare = await step('次日广场', api.list({ pageIndex: 0, pageSize: 100, sort: 'latest' }))
  log(!nextDaySquare.list.some((item) => item.id === created.id), '关闭活动：第二天起不再在广场展示')
  const nextDayDetail = await step('次日详情', api.detail(created.id))
  log(!!nextDayDetail && nextDayDetail.status === 'closed', '关闭活动：详情仍可访问，分享链接不失效')
  const nextDayMine = await step('次日我的发布', api.mine('published'))
  log(
    nextDayMine.some((item) => item.id === created.id && item.status === 'closed'),
    '关闭活动：我的发布里仍能看到已关闭的活动'
  )

  const reopened = await step('重新打开', api.toggle(created.id))
  log(
    reopened.status === 'recruiting' && reopened.closeTime === 0,
    '重新打开：状态恢复 recruiting 且清空关闭时间'
  )
  const reopenedSquare = await step('重新打开后广场', api.list({ pageIndex: 0, pageSize: 100, sort: 'latest' }))
  log(reopenedSquare.list.some((item) => item.id === created.id), '重新打开：活动立即回到广场')

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

  // 昵称是对外可见的 UGC，Mock 与云端一样按关键词拦截
  const riskyNick = await api
    .updateUser({ userInfo: { nickName: '违规昵称' } })
    .then(() => null, (err) => err)
  log(!!riskyNick && riskyNick.code === 'CONTENT_RISKY', '昵称：命中违规关键词被拒绝保存')
  log(
    global.wx.storage[require(path.join(ROOT, 'utils/storage')).KEYS.user].nickName === '自动化测试员',
    '昵称：被拒绝的昵称不写本地缓存'
  )

  // 反馈
  const feedback = await step('意见反馈', api.feedback({ content: '这是一条来自校验脚本的反馈内容' }))
  log(!!feedback.id, '意见反馈：写入成功')

  // 城市匹配
  const { matchCity, nearestCity, PROVINCES } = require(path.join(ROOT, 'utils/cities'))
  log(matchCity('浙江省杭州市西湖区断桥') === '杭州', '城市匹配：命中「杭州」')
  log(matchCity('辽宁省朝阳市人民公园') === '朝阳', '城市匹配：省份优先，命中「朝阳」')
  log(!!nearestCity(116.4, 39.9), '定位兜底：经纬度就近匹配城市可用')

  // 城市字典：省级行政区齐全，省级以下列到完整的地级行政区
  log(PROVINCES.length === 34, '城市字典：覆盖 34 个省级行政区')
  log(PROVINCES.every((item) => item.cities.length > 0), '城市字典：每个省份都有下级行政区')
  const hebeiCities = (PROVINCES.find((item) => item.name === '河北省') || {}).cities || []
  log(
    hebeiCities.indexOf('邢台市') > -1 && hebeiCities.indexOf('衡水市') > -1 && hebeiCities.length === 13,
    '城市字典：河北省补齐 11 个地级市 + 2 个省直辖县级市'
  )
  const xizangCities = (PROVINCES.find((item) => item.name === '西藏自治区') || {}).cities || []
  log(xizangCities.length === 7, '城市字典：西藏补齐 6 个地级市 + 阿里地区')
  const xinjiangCities = (PROVINCES.find((item) => item.name === '新疆维吾尔自治区') || {}).cities || []
  log(
    xinjiangCities.indexOf('石河子市') > -1 && xinjiangCities.indexOf('和田地区') > -1,
    '城市字典：新疆补齐自治州 / 地区与自治区直辖县级市'
  )
  const seenCityKeys = {}
  let duplicatedCityKey = ''
  PROVINCES.forEach((province) => {
    province.cities.forEach((city) => {
      const key = city.replace(/市$/, '')
      if (seenCityKeys[key]) duplicatedCityKey = key
      seenCityKeys[key] = true
    })
  })
  log(!duplicatedCityKey, '城市字典：不存在跨省重名城市（cityByName 反查唯一）')
  log(matchCity('河北省邢台市桥西区') === '邢台', '城市匹配：补齐的地级市能匹配')
  log(matchCity('青海省海南藏族自治州共和县') === '海南藏族自治州', '城市匹配：同名省简称不会吃掉省内自治州')
  log(matchCity('广西壮族自治区阳朔县') === '桂林', '城市匹配：县级热门地名归到所属地级市')
  log(matchCity('云南省香格里拉市') === '迪庆藏族自治州', '城市匹配：县级市归到所属自治州')

  // 县级值统一归到地级行政区，同时兼容老数据里存过的县级 city 值
  const { regionCityKeys, filterCityKeys, singleCityKey } = require(path.join(ROOT, 'utils/cities'))
  log(JSON.stringify(regionCityKeys('阳朔县')) === '["桂林"]', '地区归一：阳朔县按桂林存值')
  log(singleCityKey('桂林') === '桂林', '地区归一：桂林仍能唯一确定城市')
  log(singleCityKey('阳朔县') === '桂林', '地区归一：阳朔县能唯一确定城市')
  log(filterCityKeys('桂林').indexOf('阳朔县') > -1, '城市筛选：按桂林能筛到老数据里的阳朔县')
  log(
    filterCityKeys('广西壮族自治区').indexOf('阳朔县') > -1 &&
      regionCityKeys('广西壮族自治区').indexOf('阳朔县') === -1,
    '城市筛选：按省份能筛到老数据，但省份展开本身不带县级值'
  )

  // 协议解析
  const { parseBold } = require(path.join(ROOT, 'utils/util'))
  const segments = parseBold('普通**加粗**结尾')
  log(segments.length === 3 && segments[1].strong === true, '协议：加粗标记解析正确')

  /* ---------- 机审自动放行：Mock 与云端同一套规则 ---------- */
  const autoApproved = await step(
    '机审自动放行',
    api.create({
      form: {
        type: 'hiking',
        title: '自动化测试 · 机审自动放行',
        location: '浙江省杭州市 九溪',
        startTime: Date.now() + 86400000,
        endTime: Date.now() + 2 * 86400000,
        difficulty: 2,
        distance: 8,
        elevationGain: 150,
        feeMode: 'aa',
        maxPeople: 6,
        tags: [],
        groupQrCode: 'wxfile://tmp_qr2.png',
        desc: '内容正常，机器审核通过后直接放行',
      },
    })
  )
  log(autoApproved.auditStatus === 'approved', '机审放行：内容正常的活动发布后自动通过')
  log(autoApproved.auditBy === '内容安全检测' && autoApproved.auditTime > 0, '机审放行：记录放行来源与时间')
  log(autoApproved.auditRemark === '', '机审放行：自动通过的活动没有驳回原因')
  const autoApprovedList = await step('机审放行后广场', api.list({ pageIndex: 0, pageSize: 100, sort: 'latest' }))
  log(autoApprovedList.list.some((item) => item.id === autoApproved.id), '机审放行：活动不经人工就能出现在广场')

  // 群二维码没识别出微信群邀请链接：内容再干净也直接驳回
  const qrForm = (groupQrCode) => ({
    type: 'hiking',
    title: '自动化测试 · 群二维码校验',
    location: '浙江省杭州市 九溪',
    startTime: Date.now() + 86400000,
    endTime: Date.now() + 2 * 86400000,
    feeMode: 'aa',
    maxPeople: 6,
    groupQrCode,
    desc: '内容正常，仅二维码有问题',
  })
  const notGroupQr = await step('二维码非群链接', api.create({ form: qrForm('wxfile://notgroup_qr.png') }))
  log(notGroupQr.auditStatus === 'rejected', '二维码识别：不是微信群邀请链接时直接驳回')
  log(notGroupQr.auditRemark === '活动二维码上传有误，请重新上传微信群二维码', '二维码识别：驳回原因写明重新上传微信群二维码')
  log(notGroupQr.machineCheck.qrcode.status === 'not-group', '二维码识别：记录「不是群邀请链接」的识别结论')

  const noQrCode = await step('二维码识别不出', api.create({ form: qrForm('wxfile://noqrcode_poster.png') }))
  log(noQrCode.auditStatus === 'rejected', '二维码识别：图里没识别到二维码时直接驳回')
  log(noQrCode.machineCheck.qrcode.status === 'not-qrcode', '二维码识别：记录「没识别到二维码」的识别结论')
  // 发起人在详情页看到的是「审核未通过 + 原因」，不是「审核中 + 二维码识别提示」
  const qrRejectedCard = api.decorate(await step('二维码驳回详情', api.detail(notGroupQr.id)))
  log(qrRejectedCard.auditRejected && !qrRejectedCard.auditPending, '二维码识别：发起人看到的是「未通过」而不是「审核中」')
  log(
    qrRejectedCard.auditReason === '活动二维码上传有误，请重新上传微信群二维码',
    '二维码识别：详情页「未通过原因」用的是二维码驳回文案'
  )
  // 驳回的活动不出现在广场，只有发起人自己能预览
  const qrRejectedList = await step('二维码驳回后广场', api.list({ pageIndex: 0, pageSize: 100, sort: 'latest' }))
  log(
    !qrRejectedList.list.some((item) => item.id === notGroupQr.id || item.id === noQrCode.id),
    '二维码识别：被驳回的活动不出现在广场'
  )
  // 换一张对的二维码重新提交：驳回结论被覆盖，重新走一遍检测
  const fixedQr = await step('改好二维码重提', api.update({ id: notGroupQr.id, form: qrForm('wxfile://tmp_qr.png') }))
  log(fixedQr.auditStatus === 'approved', '二维码识别：重新上传微信群二维码后重新送审（机审通过即放行）')
  log(String(fixedQr.groupQrCode).indexOf('tmp_qr') > -1, '二维码识别：重提后二维码换成新的那张')
})().catch((e) => {
  log(false, `Mock 业务链路执行异常：${e && e.message}`)
})

flow.then(() => {
/* ---------- 5. 云模式发布上传：本机临时图片必须先转存云存储 ---------- */
/**
 * chooseMedia 选出来的图片在本机是 http://tmp/xxx、wxfile://tmp_xxx 这类临时路径，
 * 直接落库的话别人（以及换会话后的自己）看到的都是空白封面，所以云模式必须先 uploadFile。
 */
function checkPublishUpload() {
  const uploaded = []
  const pageOptions = []
  global.Page = (options) => pageOptions.push(options)
  global.wx.cloud = {
    uploadFile({ cloudPath, filePath, success }) {
      uploaded.push({ cloudPath, filePath })
      success({ fileID: `cloud://test-env.${cloudPath}` })
    },
  }
  config.useMock = false
  require(path.join(ROOT, 'pages/activity/publish/index.js'))
  const page = pageOptions[0]
  log(!!(page && typeof page.uploadFiles === 'function'), '发布上传：能取到发布页的 uploadFiles')
  if (!page || typeof page.uploadFiles !== 'function') return Promise.resolve(null)

  const ctx = { data: {} }
  return page
    .uploadFiles
    .call(ctx, { cover: 'http://tmp/tmp_cover.jpg', groupQrCode: 'wxfile://tmp_qr.png' })
    .then((res) => {
      log(String(res.cover).indexOf('cloud://') === 0, '发布上传：本机临时封面转存云存储后才落库')
      log(String(res.groupQrCode).indexOf('cloud://') === 0, '发布上传：本机临时二维码转存云存储后才落库')
      log(uploaded.length === 2, `发布上传：两张本机图片都上传（实际 ${uploaded.length} 次）`)
      return page.uploadFiles.call(ctx, {
        cover: 'cloud://test-env/activity/cover/a.png',
        groupQrCode: 'https://cdn.example.com/qr.png',
      })
    })
    .then((res) => {
      log(
        res.cover === 'cloud://test-env/activity/cover/a.png' && res.groupQrCode === 'https://cdn.example.com/qr.png',
        '发布上传：已是云文件或 https 图片时不重复上传'
      )
      log(uploaded.length === 2, '发布上传：跳过的图片不再触发上传')
      return page.uploadFiles.call(ctx, { cover: '', groupQrCode: '' })
    })
    .then((res) => {
      log(res.cover === '' && res.groupQrCode === '', '发布上传：未选图时保持空串，走默认海报')
      config.useMock = true
      return null
    })
    .catch((e) => {
      config.useMock = true
      log(false, `发布上传：执行异常 → ${e && e.message}`)
    })
}

return checkPublishUpload()
})
.then(() => {
/* ---------- 6. 审核台封面展示：桌面端审核人读不到发起人的云存储文件时要给出正确结论 ---------- */
/**
 * 审核人和发起人往往不是同一个微信号，客户端直接渲染 cloud:// 会被云存储权限拦下，
 * 所以审核台优先用 admin 云函数换好的临时链接。这里只验证页面的展示决策，
 * 云函数侧的临时链接解析在 scripts/cloud-validate.js 里覆盖。
 */
function checkAuditCoverDecisions() {
  const pageOptions = []
  global.Page = (options) => pageOptions.push(options)
  require(path.join(ROOT, 'pages/admin/audit/index.js'))
  const page = pageOptions[0]

  const raw = {
    id: 'act_1',
    title: '爬树吗',
    type: 'camping',
    typeName: '露营',
    emoji: '⛺',
    groupQrCode: 'cloud://env.bucket/qr.png',
    maxPeople: 10,
    joinedCount: 0,
    startTime: Date.now(),
    auditStatus: 'pending',
  }
  const decorate = (cover, media) => page.decorateItem.call(page, Object.assign({}, raw, { cover }), media || {})

  const withUrl = decorate('cloud://env.bucket/cover.png', {
    'cloud://env.bucket/cover.png': { url: 'https://cdn.test/cover.jpg', ok: true, reason: '' },
  })
  log(withUrl.coverSrc === 'https://cdn.test/cover.jpg', '审核台封面：服务端换到临时链接时用 https 地址渲染')
  log(withUrl.coverUnreachable === false && !!withUrl.coverSrc, '审核台封面：换到链接时不显示失败提示')

  const unreachable = decorate('cloud://env.bucket/cover.png', {
    'cloud://env.bucket/cover.png': { url: '', ok: false, reason: 'file not exist' },
  })
  log(unreachable.coverUnreachable === true, '审核台封面：服务端也取不到时标记为读不到')
  log(/读不到/.test(unreachable.coverFailText), '审核台封面：读不到时提示让发起人重新上传，而不是空白灰块')
  log(unreachable.coverFileID === 'cloud://env.bucket/cover.png', '审核台封面：读不到时保留 fileID 便于排查')

  const localPath = decorate('wxfile://tmp_1234.jpg', {})
  log(localPath.coverSrc === '' && localPath.coverBroken === true, '审核台封面：发起人本机临时路径按地址失效处理')
  log(/本机图片/.test(localPath.coverFailText), '审核台封面：本机临时路径的提示指向「没同步到云端」')

  log(decorate('', {}).coverFailText === '未上传封面', '审核台封面：未上传封面时文案为未上传')
  log(decorate('https://cdn.test/raw.png', {}).coverSrc === 'https://cdn.test/raw.png', '审核台封面：https 封面直接渲染')
}

checkAuditCoverDecisions()
})
.then(() => {
/* ---------- 7. 前台封面：服务端换好的临时链接优先渲染 ---------- */
/**
 * 首页 / 广场 / 我的活动共用活动卡片，详情页自己渲染顶部封面。
 * 客户端直连 cloud:// 可能被云存储读取权限拦下，所以两处都要优先用 coverUrl。
 */
function checkCoverUrlPreference() {
  const api = require(path.join(ROOT, 'services/api'))

  const components = []
  global.Component = (options) => components.push(options)
  require(path.join(ROOT, 'components/activity-card/index.js'))
  const card = components[0]
  log(!!(card && card.observers && typeof card.observers.act === 'function'), '活动卡片：能取到封面处理逻辑')

  const cardCtx = {
    data: { act: null, coverSrc: '' },
    setData(patch) {
      Object.assign(this.data, patch)
    },
  }
  card.observers.act.call(cardCtx, { cover: 'cloud://env.box/cover.png', coverUrl: 'https://cdn.test/cover.jpg' })
  log(cardCtx.data.coverSrc === 'https://cdn.test/cover.jpg', '活动卡片：优先渲染云函数换好的临时链接')
  card.observers.act.call(cardCtx, { cover: 'cloud://env.box/cover.png' })
  log(cardCtx.data.coverSrc === 'cloud://env.box/cover.png', '活动卡片：没有临时链接时退回原始 cover')
  card.observers.act.call(cardCtx, { cover: '' })
  log(cardCtx.data.coverSrc === '', '活动卡片：未上传封面时走默认海报')

  // 临时链接默认 2 小时过期，页面停留过久后要能按 fileID 重取
  const originalMedia = api.media
  api.media = () =>
    Promise.resolve({ 'cloud://env.box/cover.png': { url: 'https://cdn.test/cover-renewed.jpg', ok: true } })
  cardCtx.data.act = { cover: 'cloud://env.box/cover.png' }
  return card.methods
    .onCoverError.call(cardCtx)
    .then(() => {
      log(
        cardCtx.data.coverSrc === 'https://cdn.test/cover-renewed.jpg',
        '活动卡片：临时链接失效时按 fileID 重取一次'
      )
      api.media = originalMedia
      return null
    })
    .catch((e) => {
      api.media = originalMedia
      log(false, `活动卡片：封面重取异常 → ${e && e.message}`)
    })
}

function checkDetailCoverUrl() {
  const pageOptions = []
  global.Page = (options) => pageOptions.push(options)
  require(path.join(ROOT, 'pages/activity/detail/index.js'))
  const page = pageOptions[0]
  const ctx = {
    data: { user: null },
    setData(patch) {
      Object.assign(this.data, patch)
    },
  }
  page.applyActivity.call(ctx, {
    id: 'act_cover',
    type: 'hiking',
    typeName: '徒步',
    emoji: '🥾',
    title: '带封面的活动',
    cover: 'cloud://env.box/cover.png',
    coverUrl: 'https://cdn.test/detail-cover.jpg',
    groupQrCode: 'cloud://env.box/qr.png',
    qrUrl: 'https://cdn.test/detail-qr.jpg',
    location: '浙江省杭州市 九溪',
    city: '杭州',
    startTime: Date.now() + 86400000,
    endTime: Date.now() + 2 * 86400000,
    joinedPeople: [],
    joinedCount: 0,
    maxPeople: 10,
    tags: [],
    auditStatus: 'approved',
  })
  const activity = ctx.data.activity
  log(!!activity && activity.coverSrc === 'https://cdn.test/detail-cover.jpg', '活动详情：封面优先用临时链接渲染')
  log(!!activity && activity.qrSrc === 'https://cdn.test/detail-qr.jpg', '活动详情：群二维码优先用临时链接渲染')
  log(
    global.wx.navigationBarTitle === '带封面的活动 · 旷行吖',
    `活动详情：页面标题用于微信搜索理解页面 → ${global.wx.navigationBarTitle}`
  )
}

return checkCoverUrlPreference().then(() => {
  checkDetailCoverUrl()
  return null
})
})
.then(() => {
/* ---------- 8. 地图选点：显示的地点 = 选点地址的「省 + 市」+ 用户点中的地点名 ---------- */
/**
 * chooseLocation 的 name 是用户点中的地点名（列表里加粗那行），address 是它所在的地址。
 * 展示用的 location = 「省 + 市 + 地点名」（如「四川省成都市 华府大道地铁站」）：
 * 用户一眼看得出在哪个城市，只有地址文本的老活动点「导航」也能凭这串省市提高解析命中率；
 * 地点名本身已经带出省市（「广州市人民政府」）或退回完整地址时不再重复加。
 * 完整地址单独存进 locationAddress（不上展示位），城市匹配与地址检索不丢。
 */
function checkPickedPlaceText() {
  const { parsePickedPlace, placeNameOf } = require(path.join(ROOT, 'utils/location'))
  const { matchCity } = require(path.join(ROOT, 'utils/cities'))

  const picked = parsePickedPlace({
    name: '华府大道地铁站',
    address: '四川省成都市双流区天府大道南段附近',
  })
  log(picked.location === '四川省成都市 华府大道地铁站', '地图选点：地点文本前面补上选点地址的省 + 市')
  log(picked.address === '四川省成都市双流区天府大道南段附近', '地图选点：完整地址单独存放，未落进展示文本')
  log(matchCity(picked.address) === '成都', '地图选点：地址仍能匹配出城市，活动城市归属不受影响')

  // 地址里只写简称（「广东广州」）也要拼成完整省市；换成另一个城市时前缀跟着变
  const shortForm = parsePickedPlace({ name: '天河体育中心', address: '广东广州天河区天河路299号' })
  log(shortForm.location === '广东省广州市 天河体育中心', '地图选点：地址写简称时也能拼出完整的省 + 市')
  const otherCity = parsePickedPlace({ name: '西湖断桥', address: '浙江省杭州市西湖区北山街' })
  log(otherCity.location === '浙江省杭州市 西湖断桥', '地图选点：前缀跟着选中的地址走，不会串城市')

  // 地点名本身已经带省市（选中的 poi 就叫「广州市人民政府」）时不重复加前缀
  const named = parsePickedPlace({ name: '广州市人民政府', address: '广东省广州市越秀区府前路1号' })
  log(named.location === '广州市人民政府', '地图选点：地点名已带省市时不重复加前缀')
  log(named.address === '广东省广州市越秀区府前路1号', '地图选点：重复判断不影响地址落库')

  // 用户拖动地图选点时没有地点名，只有地址，退回地址当展示文本
  const barePoint = parsePickedPlace({ name: '', address: '四川省成都市双流区天府大道南段' })
  log(barePoint.location === '四川省成都市双流区天府大道南段' && barePoint.address === barePoint.location, '地图选点：无地点名时退回地址文本')
  log(parsePickedPlace({ name: '', address: '' }).location === '', '地图选点：两个字段都为空时返回空串')
  log(parsePickedPlace({ name: '某某广场', address: '' }).location === '某某广场', '地图选点：地址为空时只显示地点名')
  log(placeNameOf('四川省成都市 华府大道地铁站') === '华府大道地铁站', '地图选点：能还原出地点名，供编辑时判断是否还是同一个地点')

  const longName = parsePickedPlace({
    name: '一个特别特别长以至于会顶到上限的地点名称示例文字',
    address: '四川省成都市双流区天府大道南段',
  })
  log(longName.location.length <= 50, `地图选点：显示文本不超过 50 字（实际 ${longName.location.length} 字）`)
  log(longName.address.length <= 100, `地图选点：地址字段不超过 100 字（实际 ${longName.address.length} 字）`)

  // 页面接线：点完地图后表单显示「省 + 市 + 地点名」，完整地址进 locationAddress，而不是混在一起显示
  const pageOptions = []
  global.Page = (options) => pageOptions.push(options)
  global.wx.chooseLocation = ({ success }) =>
    success({ name: '华府大道地铁站', address: '四川省成都市双流区天府大道南段附近', latitude: 30.5, longitude: 104.1 })
  delete require.cache[path.join(ROOT, 'pages/activity/publish/index.js')]
  require(path.join(ROOT, 'pages/activity/publish/index.js'))
  const page = pageOptions[0]
  const ctx = {
    data: { form: { location: '' }, errors: {}, cityTip: '' },
    setData(patch) {
      if (patch['form.location'] !== undefined) this.data.form.location = patch['form.location']
      if (patch['form.locationAddress'] !== undefined) this.data.form.locationAddress = patch['form.locationAddress']
      if (patch['form.locationLat'] !== undefined) this.data.form.locationLat = patch['form.locationLat']
      if (patch['form.locationLng'] !== undefined) this.data.form.locationLng = patch['form.locationLng']
      if (patch.cityTip !== undefined) this.data.cityTip = patch.cityTip
    },
    clearError() {},
  }
  ctx.updateCityTip = () => page.updateCityTip.call(ctx)
  globalData.city = '成都'
  page.chooseLocation.call(ctx)
  log(ctx.data.form.location === '四川省成都市 华府大道地铁站', '发布页：地图选点后表单显示「省 + 市 + 地点名」')
  log(ctx.data.form.locationAddress === '四川省成都市双流区天府大道南段附近', '发布页：地址写进 locationAddress，不进展示位')
  log(
    ctx.data.form.locationLat === 30.5 && ctx.data.form.locationLng === 104.1,
    '发布页：地图选点的坐标一起存下来，点地址时用它直接开地图'
  )
  log(ctx.data.cityTip === '', '发布页：地址里带城市时不提示城市归属')

  // 手输到和选点结果无关（整句换掉）时丢掉旧地址，避免城市还按旧地址算
  page.onLocationInput.call(ctx, { detail: { value: '上海人民广场' } })
  log(ctx.data.form.locationAddress === '', '发布页：整句改写成别的地方后清掉旧地址，城市不会停在原地址上')
  log(
    ctx.data.form.locationLat === 0 && ctx.data.form.locationLng === 0,
    '发布页：整句改写后旧坐标一起清掉，导航不会跳到上一个点'
  )

  // 选点后只是微调名称时保留地址，城市归属不会因为补两个字就丢掉
  page.chooseLocation.call(ctx)
  page.onLocationInput.call(ctx, { detail: { value: '华府大道地铁站A口' } })
  log(ctx.data.form.locationAddress === '四川省成都市双流区天府大道南段附近', '发布页：在选点名称上补充说明时保留地址，城市匹配不受影响')

  // 把自动补上的省市前缀删掉继续编辑：还是同一个地点，地址与坐标不该跟着丢
  page.chooseLocation.call(ctx)
  page.onLocationInput.call(ctx, { detail: { value: '华府大道地铁站' } })
  log(
    ctx.data.form.locationAddress === '四川省成都市双流区天府大道南段附近' &&
      ctx.data.form.locationLat === 30.5,
    '发布页：删掉自动补的省市前缀后地址与坐标仍在，导航不会跳到别处'
  )

  // 手输缺省市的短地址：提前告诉用户会按当前城市归属，避免发布后「按城市筛选找不到」
  page.onLocationInput.call(ctx, { detail: { value: '双流区润和路附近' } })
  log(
    ctx.data.cityTip.indexOf('成都') > -1,
    '发布页：集合地点缺省市时提示会按当前城市「成都」归属'
  )
  globalData.city = ''
  page.onLocationInput.call(ctx, { detail: { value: '双流区润和路附近' } })
  log(
    ctx.data.cityTip.indexOf('省市') > -1,
    '发布页：连当前城市都没有时提示补全地址，别让活动掉到城市筛选之外'
  )
  globalData.city = '成都'

  // 服务端：只收到地点名也能靠 locationAddress 归属城市，并且地址可被检索到
  const api = require(path.join(ROOT, 'services/api'))
  return api
    .create({
      form: {
        type: 'hiking',
        title: '地图选点城市归属测试',
        location: '华府大道地铁站',
        locationAddress: '四川省成都市双流区天府大道南段附近',
        startTime: Date.now() + 86400000,
        endTime: Date.now() + 2 * 86400000,
        groupQrCode: 'mock://qr',
      },
    })
    .then((created) => {
      log(created.location === '华府大道地铁站', '发布：库里存的集合地点就是点中的地点名')
      log(created.city === '成都', '发布：城市按不展示的地址匹配出「成都」')
      log(created.locationAddress === '四川省成都市双流区天府大道南段附近', '发布：地址落库备查')
      // 机审通过的活动已经自动上架，不再进待审队列，所以这里在「全部」页签里验证地址可检索
      return api.adminList({ status: 'all', keyword: '双流' }).then((pending) => {
        log(
          pending.list.some((item) => item.id === created.id),
          '审核台：审核人按地址关键词也能搜到活动，地址没有被丢'
        )
        return created
      })
    })
    .then((res) => {
      log(!!res && res.auditStatus === 'approved', '机审放行：地图选点发布的活动机审通过后直接上架')
      return api.list({ pageIndex: 0, pageSize: 100, keyword: '双流' })
    })
    .then((found) => {
      log(
        found.list.some((item) => item.title === '地图选点城市归属测试'),
        '广场：上架后按地址关键词「双流」也能搜到，集合地点只显示地名'
      )
      // 缺省市的短地址：地址里认不出城市时按发布者当前城市兜底归属
      return api.create({
        form: {
          type: 'hiking',
          title: '缺省市地址归属测试',
          location: '双流区润和路附近',
          startTime: Date.now() + 86400000,
          endTime: Date.now() + 2 * 86400000,
          groupQrCode: 'mock://qr',
          // 发布页按当前定位城市上送，只用于地址认不出城市时兜底
          cityHint: '成都',
        },
      })
    })
    .then((created) => {
      log(
        created.city === '成都',
        '发布：手输「双流区润和路附近」也能按发布者当前城市归属到「成都」'
      )
      return api.adminApprove(created.id).then(() => ({ id: created.id, title: created.title }))
    })
    .then((created) => {
      return api.list({ pageIndex: 0, pageSize: 100, city: '成都' }).then((chengdu) => {
        log(
          chengdu.list.some((item) => item.id === created.id),
          '广场：定位成都后能筛出这条缺省市地址的活动，不再「一条都筛不到」'
        )
        // 省份 / 全国这种落不到单个城市的提示不能当归属用
        return api.create({
          form: {
            type: 'hiking',
            title: '无效城市提示测试',
            location: '某某路附近',
            startTime: Date.now() + 86400000,
            endTime: Date.now() + 2 * 86400000,
            groupQrCode: 'mock://qr',
            cityHint: '四川省',
          },
        })
      })
    })
    .then((created) => {
      log(created.city === '', '发布：省份 / 全国这类提示不算城市归属，不会把活动错挂到某个城市')
      return null
    })
}

/* ---------- 9. 点击地址调起导航 ---------- */
/**
 * 详情页地点行与广场卡片地点行都接上了 openNavigation：
 * - 地图选点发布的活动有坐标，直接用坐标打开微信内置地图（用户在地图页选地图软件，
 *   坐标与地址一起带过去开始导航）；
 * - 历史活动只有地址文本，先按地址解析（缺省市的短地址会带上城市再查一次）；
 * - 解析不出来（没配 mapKey / 地址太短）时给两条路：在地图上点选位置后直接导航，或复制地址。
 *   点一下不该只弹一个「无法自动定位」的死胡同，要能走到地图上。
 */
function checkLocationNavigation() {
  const location = require(path.join(ROOT, 'utils/location'))
  const calls = []
  const requests = []
  let geocodeReply = null
  let actionIndex = 1
  let pickedPlace = null
  global.wx.showLoading = () => {}
  global.wx.hideLoading = () => {}
  global.wx.showModal = (options) => options.success({ confirm: true })
  global.wx.openLocation = (options) => {
    calls.push(['openLocation', options])
    options.success()
  }
  global.wx.setClipboardData = (options) => {
    calls.push(['setClipboardData', options.data])
    options.success()
  }
  // 解析不出坐标时的兜底入口：0 = 在地图上点选位置，1 = 仅复制地址
  global.wx.showActionSheet = (options) => {
    calls.push(['showActionSheet', options])
    options.success({ tapIndex: actionIndex })
  }
  global.wx.chooseLocation = (options) => {
    calls.push(['chooseLocation', options])
    if (pickedPlace) options.success(pickedPlace)
    else options.fail({ errMsg: 'chooseLocation:fail cancel' })
  }
  global.wx.request = (options) => {
    requests.push(options.data)
    options.success({
      data: geocodeReply
        ? { status: 0, result: { location: { lat: geocodeReply.lat, lng: geocodeReply.lng } } }
        : { status: 1, message: '解析失败' },
    })
  }
  const firstCall = (name) => calls.filter((item) => item[0] === name)[0] || null

  log(location.usableCoord(30.5, 104.1) !== null, '导航：正常经纬度可用')
  log(location.usableCoord(0, 0) === null, '导航：0,0 视为没有坐标，走地址解析兜底')
  log(location.usableCoord(120, 200) === null, '导航：范围外的经纬度视为没有坐标')

  // 解析用的城市上下文：活动城市 > 地址里认出的城市 > 当前定位城市
  globalData.city = '成都'
  log(location.regionOf({ city: '杭州', address: '西湖断桥' }) === '杭州', '导航：优先用活动自己的城市做解析参考')
  log(location.regionOf({ address: '四川省成都市双流区润和路' }) === '成都', '导航：活动没有城市时从地址文本里认城市')
  log(
    location.regionOf({ address: '双流区润和路附近' }) === '成都',
    '导航：地址缺省市时退回当前定位城市做解析参考'
  )

  return (async () => {
    // 1) 地图选点发布的活动：直接用落库坐标打开内置地图，不再请求解析接口
    const opened = await location.openNavigation({
      name: '华府大道地铁站',
      address: '四川省成都市双流区天府大道南段附近',
      city: '成都',
      latitude: 30.5,
      longitude: 104.1,
    })
    const openedCall = firstCall('openLocation')
    log(opened === 'opened' && !!openedCall, '导航：有坐标的活动直接调起内置地图')
    log(
      !!openedCall && openedCall[1].latitude === 30.5 && openedCall[1].longitude === 104.1,
      '导航：地图打开的坐标就是活动落库的坐标'
    )
    log(requests.length === 0, '导航：有坐标时不走地址解析，省掉一次网络请求')

    // 2) 未配置 mapKey + 只有地址文本：点击导航先给出「地图选点 / 复制地址」两条路
    config.mapKey = ''
    calls.length = 0
    requests.length = 0
    actionIndex = 1
    let result = await location.openNavigation({
      name: '西湖断桥',
      address: '浙江省杭州市西湖区',
      city: '杭州',
    })
    const sheet = firstCall('showActionSheet')
    const copied = firstCall('setClipboardData')
    log(!!sheet && sheet[1].itemList.length === 2, '导航：解析不出坐标时给出「地图点选 / 复制地址」两条路')
    log(result === 'copied' && !!copied, '导航：选「复制地址」后复制完整地址，点了不会没反应')
    log(!!copied && copied[1] === '浙江省杭州市西湖区', '导航：复制的是完整地址，粘到地图软件里能直接搜')

    // 3) 选「在地图上点选位置后导航」：地图页预填地址，选中后直接调起导航
    calls.length = 0
    actionIndex = 0
    pickedPlace = {
      name: '润和路',
      address: '四川省成都市双流区润和路',
      latitude: 30.5742,
      longitude: 103.9231,
    }
    result = await location.openNavigation({ name: '双流区润和路附近', address: '双流区润和路附近' })
    const picker = firstCall('chooseLocation')
    const pickedOpen = firstCall('openLocation')
    log(
      !!picker && picker[1].keyword === '双流区润和路附近' && picker[1].latitude === 30.6595,
      '导航：地图点选页预填地址，并从所属城市（成都）中心打开'
    )
    log(result === 'opened' && !!pickedOpen, '导航：地图上点选的位置能直接调起导航，不是只能复制地址')
    log(
      !!pickedOpen && pickedOpen[1].latitude === 30.5742 && pickedOpen[1].longitude === 103.9231,
      '导航：导航用的就是用户在地图上点中的坐标'
    )

    // 用户在地图点选页取消：按取消处理，不报错也不重复弹窗
    calls.length = 0
    pickedPlace = null
    result = await location.openNavigation({ name: '双流区润和路附近', address: '双流区润和路附近' })
    log(result === 'cancelled' && !firstCall('setClipboardData'), '导航：地图点选被取消时按取消处理，不反复打扰用户')

    // 4) 配置了 mapKey：按地址文本解析出坐标再打开地图（手输的一整条长地址同样能导航）
    config.mapKey = 'TEST_KEY'
    geocodeReply = { lat: 30.4273, lng: 104.0805 }
    calls.length = 0
    requests.length = 0
    result = await location.openNavigation({
      name: '四川省成都市双流区天府新区天府大道南二段与科学城北路东段交汇处',
      address: '',
      city: '成都',
    })
    const geocoded = firstCall('openLocation')
    log(result === 'opened' && requests.length === 1, '导航：只有地址文本时先解析坐标再打开地图')
    log(
      !!geocoded && geocoded[1].latitude === 30.4273 && geocoded[1].longitude === 104.0805,
      '导航：地图打开的坐标来自地址解析结果'
    )
    log(
      !!geocoded && geocoded[1].address === '四川省成都市双流区天府新区天府大道南二段与科学城北路东段交汇处',
      '导航：完整地址一起交给地图软件，导航里不用再手输'
    )

    // 5) 缺省市的短地址：第一次带 region 解析失败后，补上城市再解析一次
    config.mapKey = 'TEST_KEY'
    geocodeReply = null
    calls.length = 0
    requests.length = 0
    actionIndex = 1
    result = await location.openNavigation({ name: '双流区润和路附近', address: '双流区润和路附近', city: '成都' })
    log(requests.length === 2, '导航：缺省市地址先按城市区域查，失败后补上城市名再查一次')
    log(
      requests[0] && requests[0].address === '双流区润和路附近' && requests[0].region === '成都',
      '导航：第一次解析把活动城市当作区域参考'
    )
    log(requests[1] && requests[1].address === '成都双流区润和路附近', '导航：第二次解析把城市补进地址，命中率更高')

    // 补全后解析成功：直接打开地图，不再弹兜底选项
    geocodeReply = { lat: 30.5742, lng: 103.9231 }
    calls.length = 0
    requests.length = 0
    result = await location.openNavigation({ name: '双流区润和路附近', address: '双流区润和路附近', city: '成都' })
    log(
      result === 'opened' && !firstCall('showActionSheet'),
      '导航：补全城市后解析成功，直接调起内置地图，不再走兜底弹窗'
    )

    config.mapKey = ''
    globalData.city = ''
    return null
  })()
}

/* ---------- 10. 定位主路径：只走默认开通的模糊定位，不碰需要单独申请开通的精确接口 ---------- */
/**
 * 精确接口在小程序后台显示「暂无权限」时调用直接 fail，用户侧只看到首页一直「定位未开启」，
 * 而且未开通的接口在提审环节还会被拦截。判城市只要城市级精度，所以主路径改走默认开通的模糊定位：
 * - 模糊定位成功就用它的坐标匹配城市，全程不调用精确接口；
 * - 用户明确拒绝授权时按「定位未开启」处理，页面引导去设置里开权限；
 * - 基础库低于 2.25.0 没有模糊定位接口，降级成手动选城市，同样不去调未开通的接口。
 */
function checkFuzzyLocate() {
  const location = require(path.join(ROOT, 'utils/location'))
  const originalFuzzy = global.wx.getFuzzyLocation
  const originalPrecise = global.wx.getLocation
  const fuzzyCalls = []
  const preciseCalls = []
  let fuzzyReply = null
  let fuzzyFail = 'getFuzzyLocation:fail auth deny'

  config.mapKey = ''
  const fuzzyMock = (options) => {
    fuzzyCalls.push(options.type || '(默认)')
    if (fuzzyReply) options.success(fuzzyReply)
    else options.fail({ errMsg: fuzzyFail })
  }
  global.wx.getFuzzyLocation = fuzzyMock
  // 精确接口的桩只用来计数：被调用一次就说明主路径还挂着未开通的接口
  global.wx.getLocation = (options) => {
    preciseCalls.push(options.type)
    options.fail({ errMsg: 'getLocation:fail api scope is not declared' })
  }
  const chengdu = { longitude: 104.0805, latitude: 30.6673 }

  return (async () => {
    // 1) 模糊定位可用：拿到城市就够了，全程不碰未开通的精确接口
    globalData.locationDenied = true
    fuzzyReply = chengdu
    fuzzyCalls.length = 0
    preciseCalls.length = 0
    let city = await location.locate()
    log(city === '成都', '定位：模糊定位坐标能匹配出当前城市')
    log(fuzzyCalls.length === 1 && fuzzyCalls[0] === 'gcj02', '定位：默认按 gcj02 要模糊坐标，与地图选点坐标系一致')
    log(preciseCalls.length === 0, '定位：拿城市全程不调用未开通的精确接口，提审不会被拦')
    log(globalData.locationDenied === false, '定位：定位成功后清掉「定位未开启」标记')

    // 2) 用户拒绝授权：按「定位未开启」处理，换坐标系也不重试
    fuzzyCalls.length = 0
    preciseCalls.length = 0
    fuzzyReply = null
    fuzzyFail = 'getFuzzyLocation:fail auth deny'
    city = await location.locate()
    log(city === '' && globalData.locationDenied === true, '定位：用户拒绝授权时提示「定位未开启」')
    log(fuzzyCalls.length === 1 && preciseCalls.length === 0, '定位：拒绝授权后不再重复请求，页面走「去设置」引导')

    // 3) 基础库过旧没有模糊定位接口：降级成手动选城市，不误调未开通的接口
    preciseCalls.length = 0
    // 删掉接口本身来模拟低版本基础库，跑完再把桩装回去
    delete global.wx.getFuzzyLocation
    city = await location.locate()
    log(city === '' && globalData.locationDenied === true, '定位：低版本基础库没有模糊定位接口时降级提示「定位未开启」')
    log(preciseCalls.length === 0, '定位：降级时也不会去调未开通的精确接口')
    global.wx.getFuzzyLocation = fuzzyMock

    // 4) 模糊定位报的不是授权问题（如接口未声明）：换默认坐标系再试一次，仍失败才提示未开启
    fuzzyCalls.length = 0
    preciseCalls.length = 0
    fuzzyReply = null
    fuzzyFail = 'getFuzzyLocation:fail api scope is not declared'
    city = await location.locate()
    log(
      city === '' && globalData.locationDenied === true && fuzzyCalls.length === 2 && preciseCalls.length === 0,
      '定位：模糊定位非授权失败时换坐标系再试一次，仍失败才落到「定位未开启」'
    )

    // 5) 环境不认 gcj02：按默认坐标系再要一次模糊定位，别把能拿到的城市丢掉
    const fuzzyTypes = []
    global.wx.getFuzzyLocation = (options) => {
      fuzzyTypes.push(options.type || '(默认)')
      if (options.type) options.fail({ errMsg: 'getFuzzyLocation:fail invalid type' })
      else options.success(chengdu)
    }
    city = await location.locate()
    log(
      city === '成都' && fuzzyTypes.length === 2 && fuzzyTypes[1] === '(默认)',
      '定位：环境不认 gcj02 时按默认坐标系再要一次，城市照样能拿到'
    )

    global.wx.getFuzzyLocation = originalFuzzy
    global.wx.getLocation = originalPrecise
    globalData.locationDenied = false
    return null
  })()
}

/* ---------- 11. 首页不在启动时自动索要位置权限 ---------- */
/**
 * 首页曾在 onLoad 里自动 app.relocate()，用户一进小程序什么都没点就会看到位置授权弹窗
 * （审核口径里「收集地理位置须经用户明确同意」，启动即索权既打断浏览也容易被挑）。
 * 现在改成：启动只读已有状态、按「全部城市」展示，等用户点定位栏再弹。
 * 这里把两条路径都钉住：启动/切回首页不请求定位，点击定位栏才请求。
 */
function checkHomeNoAutoLocate() {
  const pagePath = path.join(ROOT, 'pages/home/home.js')
  const pageOptions = []
  const relocateCalls = []
  const originPage = global.Page
  const originGetApp = global.getApp
  const originShowLoading = global.wx.showLoading
  const originHideLoading = global.wx.hideLoading
  const homeGlobalData = { city: '', user: null, locationDenied: false, cityLocated: false }

  global.Page = (options) => pageOptions.push(options)
  global.getApp = () => ({
    globalData: homeGlobalData,
    relocate() {
      relocateCalls.push('relocate')
      homeGlobalData.city = '成都'
      homeGlobalData.cityLocated = true
      return Promise.resolve('成都')
    },
  })
  global.wx.showLoading = () => {}
  global.wx.hideLoading = () => {}

  delete require.cache[pagePath]
  try {
    require(pagePath)
  } finally {
    global.Page = originPage
  }
  const page = pageOptions[pageOptions.length - 1]
  const ctx = {
    data: {},
    setData(patch) {
      Object.assign(this.data, patch)
    },
    loadData() {
      return Promise.resolve(null)
    },
    getTabBar() {
      return null
    },
  }
  Object.keys(page).forEach((key) => {
    if (typeof page[key] === 'function' && !ctx[key]) {
      ctx[key] = (...args) => page[key].apply(ctx, args)
    }
  })

  return Promise.resolve()
    .then(() => {
      page.onLoad.call(ctx)
      log(relocateCalls.length === 0, '首页：启动时不自动请求定位，位置授权弹窗等用户点击')
      log(
        ctx.data.cityLabel === '全部' && ctx.data.locateTip === '点击定位',
        '首页：首屏未定位时按「全部城市」展示，定位栏提示「点击定位」'
      )
      page.onShow.call(ctx)
      log(relocateCalls.length === 0, '首页：切回首页同样不自动请求定位')
      return null
    })
    .then(() => ctx.onLocateTap())
    .then(() => {
      log(relocateCalls.length === 1, '首页：用户点定位栏才发起定位（主动触发）')
      log(
        ctx.data.cityLabel === '成都' && ctx.data.locationDenied === false && ctx.data.locateTip === '点击重新定位',
        '首页：定位成功后定位栏显示城市，并可再次点击重新定位'
      )
      global.getApp = originGetApp
      global.wx.showLoading = originShowLoading
      global.wx.hideLoading = originHideLoading
      delete require.cache[pagePath]
      return null
    })
}

return checkPickedPlaceText()
  .then(() => checkLocationNavigation())
  .then(() => checkFuzzyLocate())
  .then(() => checkHomeNoAutoLocate())
})
.then(() => {
/* ---------- 8. 城市选择器：省 + 全部按全省筛选 ---------- */
/**
 * 选择器把「省 + 全部」翻译成省名提交（如广东省），城市列有具体城市时提交城市名。
 * 首页 / 广场据此按全省或单城过滤，省与市都选「全部」时提交空串表示全国。
 */
function checkCityPickerProvince() {
  const { PROVINCES } = require(path.join(ROOT, 'utils/cities'))
  const components = []
  const originComponent = global.Component
  global.Component = (options) => components.push(options)
  try {
    require(path.join(ROOT, 'components/city-picker/index.js'))
  } finally {
    global.Component = originComponent
  }
  const component = components[components.length - 1]
  log(!!(component && component.methods && typeof component.methods.confirm === 'function'), '城市选择器：能取到组件配置')
  if (!component) return

  const events = []
  const methods = component.methods
  const ctx = {
    data: Object.assign({}, component.data),
    setData(patch) {
      Object.assign(this.data, patch)
    },
    triggerEvent(name, detail) {
      events.push({ name, detail })
    },
  }
  // 组件方法之间会互相调用（open -> applyProvince），统一挂到同一个上下文上
  Object.keys(methods).forEach((name) => {
    ctx[name] = methods[name].bind(ctx)
  })
  const gdIndex = PROVINCES.findIndex((item) => item.name === '广东省') + 1
  log(gdIndex > 0, '城市选择器：字典里能定位到广东省')
  // 城市列按行政区划代码顺序排列，用名称反查下标，避免新增城市后写死的下标失效
  const szIndex = (PROVINCES[gdIndex - 1].cities.findIndex((item) => item === '深圳市')) + 1
  log(szIndex > 0, '城市选择器：字典里能定位到深圳市')

  // 省 + 全部 -> 全省筛选
  methods.applyProvince.call(ctx, gdIndex, 0)
  methods.confirm.call(ctx)
  log(events[0] && events[0].detail.city === '广东省', '城市选择器：省 + 全部提交省名做全省筛选')
  log(events[0] && events[0].detail.label === '广东省', '城市选择器：省 + 全部在定位栏展示省名')

  // 省 + 市 -> 单城筛选
  methods.applyProvince.call(ctx, gdIndex, szIndex)
  methods.confirm.call(ctx)
  log(events[1] && events[1].detail.city === '深圳', '城市选择器：选到具体城市时提交城市名')

  // 全部 + 全部 -> 全国
  methods.applyProvince.call(ctx, 0, 0)
  methods.confirm.call(ctx)
  log(
    events[2] && events[2].detail.city === '' && events[2].detail.label === '全部',
    '城市选择器：全部 + 全部提交空值做全国展示'
  )

  // 城市列的候选就是字典里的完整地级行政区
  const hebeiIndex = PROVINCES.findIndex((item) => item.name === '河北省') + 1
  methods.applyProvince.call(ctx, hebeiIndex, 0)
  const hebeiLabels = ctx.data.cityLabels
  log(
    hebeiLabels.length === 14 && hebeiLabels.indexOf('邢台市') > -1 && hebeiLabels.indexOf('衡水市') > -1,
    '城市选择器：河北省城市列含 11 个地级市 + 2 个省直辖县级市（另有「全部」）'
  )
  const xinjiangIndex = PROVINCES.findIndex((item) => item.name === '新疆维吾尔自治区') + 1
  methods.applyProvince.call(ctx, xinjiangIndex, 0)
  log(
    ctx.data.cityLabels.indexOf('和田地区') > -1 && ctx.data.cityLabels.indexOf('石河子市') > -1,
    '城市选择器：新疆城市列含地区与自治区直辖县级市'
  )

  // 重开选择器要回到当前选区，省级筛选不能被显示成「全部」
  methods.open.call(ctx, '广东省')
  log(
    ctx.data.provinceIndex === gdIndex && ctx.data.cityIndex === 0 && ctx.data.visible === true,
    '城市选择器：重开时回填「广东省 + 全部」'
  )
  methods.open.call(ctx, '深圳')
  log(
    ctx.data.provinceIndex === gdIndex && ctx.data.cityLabels[ctx.data.cityIndex] === '深圳市',
    '城市选择器：重开时回填具体城市'
  )
}

checkCityPickerProvince()
})
.then(() => {
/* ---------- 9. 广场：活动类型筛选胶囊 + 默认排序 ----------
 * 类型从「吸顶横向 Tab」改成与日期 / 星期并列的筛选胶囊，
 * 排序栏去掉「即将开始」，列表默认按最新发布排列。
 */
function checkSquareFilters() {
  const { SORT_OPTIONS } = require(path.join(ROOT, 'utils/dict'))
  const { KEYS } = require(path.join(ROOT, 'utils/storage'))
  log(
    SORT_OPTIONS.every((item) => item.value !== 'time'),
    '广场排序：不再提供「即将开始」，只留最新发布 / 最热门'
  )
  log(SORT_OPTIONS[0].value === 'latest', '广场排序：默认第一项是「最新发布」')

  const pageOptions = []
  global.Page = (options) => pageOptions.push(options)
  delete require.cache[path.join(ROOT, 'pages/square/index.js')]
  require(path.join(ROOT, 'pages/square/index.js'))
  const page = pageOptions[0]
  log(page.data.sort === 'latest', '广场：默认排序取「最新发布」')
  log(page.data.typeLabel === '全部类型', '广场：活动类型筛选未选中时显示「全部类型」')

  const ctx = {
    data: Object.assign({}, page.data),
    setData(patch) {
      Object.assign(this.data, patch)
    },
    // 面板开关 / 选类型只为断言 UI 状态，这里不真的请求列表
    loadList() {},
  }
  ;['applyPendingType', 'toggleType', 'toggleWeekday', 'onTypeSelect'].forEach((name) => {
    ctx[name] = page[name].bind(ctx)
  })

  // 首页「发现户外玩法」点徒步进来：胶囊要预选徒步，且待选值读完即清
  global.wx.storage[KEYS.pendingType] = 'hiking'
  ctx.applyPendingType()
  log(
    ctx.data.type === 'hiking' && ctx.data.typeLabel === '徒步',
    '广场：首页点「徒步」进来时活动类型筛选预选「徒步」'
  )
  log(
    Object.prototype.hasOwnProperty.call(global.wx.storage, KEYS.pendingType) === false,
    '广场：带入的类型读一次就清掉，返回广场不会反复套用'
  )

  // 类型面板与星期面板互斥，避免两块面板同时展开
  ctx.toggleType()
  log(ctx.data.typeOpen === true && ctx.data.weekdayOpen === false, '广场：展开活动类型面板')
  ctx.toggleWeekday()
  log(ctx.data.weekdayOpen === true && ctx.data.typeOpen === false, '广场：类型面板与星期面板互斥')

  ctx.toggleType()
  ctx.onTypeSelect({ currentTarget: { dataset: { type: 'swimming' } } })
  log(
    ctx.data.type === 'swimming' && ctx.data.typeLabel === '游泳' && ctx.data.typeOpen === false,
    '广场：选中类型后收起面板并展示「游泳」'
  )
  ctx.onTypeSelect({ currentTarget: { dataset: { type: 'all' } } })
  log(ctx.data.type === 'all' && ctx.data.typeLabel === '全部类型', '广场：选回「全部类型」清空类型条件')

  // 静态回归：首页不再有「全部」入口，广场不再渲染类型 Tab 与「即将开始」
  const homeWxml = fs.readFileSync(path.join(ROOT, 'pages/home/home.wxml'), 'utf8')
  const squareWxml = fs.readFileSync(path.join(ROOT, 'pages/square/index.wxml'), 'utf8')
  log(homeWxml.indexOf('全部 ›') === -1, '首页：户外玩法区块不再提供「全部」入口')
  log(
    squareWxml.indexOf('即将开始') === -1 && squareWxml.indexOf('type-tabs') === -1,
    '广场：页面不再渲染「即将开始」与横向类型 Tab'
  )
}

checkSquareFilters()
})
.then(() => {
/* ---------- 13. 注销账号：本地账号、发布、报名与反馈一起清干净 ---------- */
/**
 * 注销不可撤销：本地缓存的账号信息、我发布的活动、我报名的活动、提交过的反馈都要清空，
 * 别人活动报名名单里的自己也要移除，否则会留下一个点不进去的「已注销用户」。
 * 入口放在个人中心，且要两次确认才真的执行。
 */
function checkDeleteAccount() {
  const { KEYS, getStorage } = require(path.join(ROOT, 'utils/storage'))
  const mockModel = require(path.join(ROOT, 'services/mock'))
  const api = require(path.join(ROOT, 'services/api'))

  let account = null
  let own = null
  let target = null

  return api
    .login({ phone: '13800003333' })
    .then((user) => {
      account = user
      globalData.user = user
      return api.create({
        form: {
          type: 'hiking',
          title: '注销账号测试活动',
          location: '浙江省杭州市 断桥残雪',
          startTime: Date.now() + 86400000,
          endTime: Date.now() + 2 * 86400000,
          groupQrCode: 'mock://qr',
        },
      })
    })
    .then((created) => {
      own = created
      // 报名一条别人的活动，注销时要连报名名单里的自己一起清掉
      const others = mockModel
        .visibleActivities()
        .filter((item) => item.organizer.openid !== account.openid && item.status === 'recruiting')
      target = others[0]
      return target ? api.join(target.id) : null
    })
    .then(() => api.feedback({ content: '注销前的反馈内容' }))
    .then(() => {
      const joinMap = getStorage(mockModel.MOCK_JOIN_MAP, {}) || {}
      log(
        !!getStorage(KEYS.user, null) &&
          (getStorage(KEYS.published, []) || []).some((item) => item.id === own.id) &&
          (joinMap[target.id] || []).some((member) => member.openid === account.openid) &&
          (getStorage(KEYS.feedback, []) || []).length > 0,
        '注销：注销前账号、发布、报名与反馈四类数据都在'
      )
      return api.deleteAccount()
    })
    .then(() => {
      log(getStorage(KEYS.user, null) === null, '注销：本地账号缓存被清空，回到未登录')
      log((getStorage(KEYS.published, []) || []).length === 0, '注销：我发布的活动一并删除')
      log((getStorage(KEYS.joined, []) || []).length === 0, '注销：我报名的活动记录一并清空')
      log((getStorage(KEYS.feedback, []) || []).length === 0, '注销：我提交的反馈一并删除')
      log(getStorage(KEYS.lastPhone, '') === '', '注销：本地缓存的手机号也清掉')
      const joinMap = getStorage(mockModel.MOCK_JOIN_MAP, {}) || {}
      log(
        (joinMap[target.id] || []).every((member) => member.openid !== account.openid),
        '注销：别人活动的报名名单里不再有自己'
      )
      log(
        !mockModel.visibleActivities().some((item) => item.organizer.openid === account.openid),
        '注销：广场上不再展示他发布的活动'
      )
      return api.user()
    })
    .then((user) => {
      log(!user || !user.openid, '注销：注销后接口层按未登录处理')
      return api
        .deleteAccount()
        .then(() => false)
        .catch((err) => (err && err.code) === 'UNAUTHORIZED')
    })
    .then((guarded) => {
      log(guarded === true, '注销：未登录时拒绝注销请求')
      const wxml = fs.readFileSync(path.join(ROOT, 'pages/usercenter/index.wxml'), 'utf8')
      const js = fs.readFileSync(path.join(ROOT, 'pages/usercenter/index.js'), 'utf8')
      log(
        wxml.indexOf('bindtap="deleteAccount"') > -1 && wxml.indexOf('注销账号') > -1,
        '注销：个人中心提供「注销账号」入口'
      )
      const start = js.indexOf('  deleteAccount() {')
      const body = start === -1 ? '' : js.slice(start, js.indexOf('\n  },', start))
      log((body.match(/ui\.confirm\(/g) || []).length === 2, '注销：入口要两次确认后才真正执行')
      log(
        body.indexOf('api.deleteAccount') > -1 && body.indexOf('deleting') > -1,
        '注销：确认后调用注销接口并做重复点击保护'
      )
    })
    .then(() => {
      // 站内《隐私政策》要与后台指引、实际收集行为三方一致：
      // 图片上传、相册（仅写入）、设备信息、剪切板（仅写入）四项之前漏写，注销途径也要指向自助入口
      const { PRIVACY_AGREEMENT } = require(path.join(ROOT, 'utils/agreements'))
      const policy = PRIVACY_AGREEMENT.paragraphs.join('\n')
      log(policy.indexOf('封面图与活动群二维码') > -1, '隐私政策：写明发布时选择的图片用途')
      log(policy.indexOf('相册（仅写入）权限') > -1, '隐私政策：写明相册仅写入权限')
      log(policy.indexOf('设备信息') > -1, '隐私政策：写明设备信息用途')
      log(policy.indexOf('剪切板（仅写入）') > -1, '隐私政策：写明剪切板仅写入且不读取')
      log(
        policy.indexOf('注销账号') > -1 && policy.indexOf('个人中心底部') > -1,
        '隐私政策：注销途径指向个人中心的自助入口'
      )
      log(policy.indexOf('不会读取') > -1, '隐私政策：明确不会读取相册与剪切板内容')
    })
}

/* -------------- 展示期：发布满 7 天的活动自动关闭（Mock 侧同口径） -------------- */
/**
 * 规则见 utils/expire.js：活动在首页 / 广场展示 7 天，到期自动关闭。
 * 这里把本地缓存里的发布时间改到 8 天前，验证列表不再展示、详情按已关闭下发、
 * 报名 / 重开 / 编辑被拒；再用 6 天前发布的活动验证边界（未满 7 天照常展示）。
 */
function checkExpireRule() {
  const api = require(path.join(ROOT, 'services/api'))
  const { KEYS } = require(path.join(ROOT, 'utils/storage'))
  const expire = require(path.join(ROOT, 'utils/expire'))
  const DAY = 86400000
  const T0 = 1700000000000

  log(expire.TTL_DAYS === 7, '展示期：规则为发布后 7 天')
  log(expire.isExpired({ createTime: T0 }, T0 + expire.TTL_MS - 1) === false, '展示期：未满 7 天不算到期')
  log(expire.isExpired({ createTime: T0 }, T0 + expire.TTL_MS) === true, '展示期：满 7 天即到期')
  log(expire.isExpired({}, T0) === false, '展示期：取不到发布时间时不到期，不会误关历史数据')

  /** 把本地缓存里某条活动的发布时间改成 N 天前，模拟「发布了一段时间」 */
  const backdate = (id, days) => {
    const list = global.wx.storage[KEYS.published] || []
    list.forEach((item) => {
      if (item.id === id) item.createTime = Date.now() - days * DAY
    })
    global.wx.storage[KEYS.published] = list
  }
  const formOf = (title) => ({
    type: 'hiking',
    title,
    location: '四川省成都市 天府广场',
    locationAddress: '四川省成都市锦江区人民南路',
    startTime: Date.now() + DAY,
    endTime: Date.now() + 2 * DAY,
    feeMode: 'aa',
    maxPeople: 8,
    groupQrCode: 'mock://expire-qr',
    desc: '展示期校验',
    cityHint: '成都',
  })
  const visibleIn = (list, id) => (list || []).some((item) => item.id === id)

  let aged = null
  let fresh = null

  return api
    .login({ phone: '13800005555' })
    .then((user) => {
      globalData.user = user
      return api.create({ form: formOf('展示期到期用例') })
    })
    .then((created) => {
      aged = created
      log(expire.isExpired(created) === false, '展示期：刚发布的活动不到期')
      return api.create({ form: formOf('展示期边界用例') })
    })
    .then((created) => {
      fresh = created
      // 一条改到 8 天前（已过展示期），一条改到 6 天前（仍在展示期内）
      backdate(aged.id, 8)
      backdate(fresh.id, 6)
      return Promise.all([
        api.list({ pageIndex: 0, pageSize: 100, sort: 'latest' }),
        api.home({ city: '' }),
        api.detail(aged.id),
        api.mine('published'),
      ])
    })
    .then((res) => {
      const square = res[0]
      const home = res[1]
      const detail = res[2]
      const mine = res[3]
      const mineItem = (mine || []).filter((item) => item.id === aged.id)[0]
      const mineDecorated = mineItem ? api.decorate(mineItem) : null
      const detailDecorated = detail ? api.decorate(detail) : null

      log(visibleIn(square.list, aged.id) === false, '展示期：发布满 7 天的活动从广场消失')
      log(
        visibleIn((home.hotList || []).concat(home.newestList || []), aged.id) === false,
        '展示期：发布满 7 天的活动不进首页推荐'
      )
      log(visibleIn(square.list, fresh.id) === true, '展示期：发布 6 天的活动照常展示（边界）')
      log(
        !!detail && detail.expired === true && detail.status === 'closed' && !!detailDecorated && detailDecorated.isClosed === true,
        '展示期：详情按「已到期 + 已关闭」下发，分享链接仍可打开'
      )
      log(
        !!mineDecorated && mineDecorated.expired === true && mineDecorated.isClosed === true,
        '展示期：我的发布里标记为已到期，卡片按已关闭展示'
      )

      return Promise.all([
        api.join(aged.id).then(() => null, (err) => err),
        api.toggle(aged.id).then(() => null, (err) => err),
        api.update({ id: aged.id, form: formOf('展示期到期用例') }).then(() => null, (err) => err),
        api.join(fresh.id).then(() => 'joined', (err) => err),
      ])
    })
    .then((res) => {
      log(!!res[0] && res[0].code === 'ACTIVITY_EXPIRED', '展示期：到期后拒绝报名')
      log(!!res[1] && res[1].code === 'ACTIVITY_EXPIRED', '展示期：到期后不能重新打开')
      log(!!res[2] && res[2].code === 'ACTIVITY_EXPIRED', '展示期：到期后不能编辑重提')
      log(res[3] === 'joined', '展示期：展示期内的活动仍可正常报名')
    })
}

/* -------------- 云模式入口守卫：编辑页的发起人判断、小程序码的 scene -------------- */
/**
 * 两处都是「云端按隐私要求脱敏了，页面还在按本地数据形状取值」的坑：
 * - 编辑页曾用 raw.organizer.openid 判断发起人，而云端不下发 openid，编辑、驳回重提会全废；
 * - 海报上的小程序码把活动 id 放在 scene 里（URL 编码），详情页只读 query 的 id，扫码进来落到「活动不存在」。
 * 这里直接用云端形状的数据喂给页面，把行为钉住。
 */
function checkCloudShapeFixes() {
  const api = require(path.join(ROOT, 'services/api'))
  const originalToast = global.wx.showToast
  const originalNavigateBack = global.wx.navigateBack
  const originalDetail = api.detail
  const toasts = []
  global.wx.showToast = (options) => toasts.push((options && options.title) || '')
  global.wx.navigateBack = () => {}

  const restore = () => {
    global.wx.showToast = originalToast
    global.wx.navigateBack = originalNavigateBack
    api.detail = originalDetail
  }

  /* ① 编辑页：云端的发起人快照没有 openid，只有 isOrganizer */
  const pageOptions = []
  global.Page = (options) => pageOptions.push(options)
  delete require.cache[path.join(ROOT, 'pages/activity/publish/index.js')]
  api.detail = () =>
    Promise.resolve({
      id: 'act_cloud_shape',
      title: '云端形状的活动',
      type: 'hiking',
      tags: [],
      startTime: Date.now() + 86400000,
      endTime: Date.now() + 2 * 86400000,
      location: '浙江省杭州市 九溪',
      difficulty: 3,
      feeMode: 'aa',
      maxPeople: 10,
      groupQrCode: 'cloud://qr.png',
      desc: '说明',
      auditStatus: 'rejected',
      organizer: { nickName: '发起人', avatarColor: '#4ECDC4', avatarUrl: '', avatarText: '发' },
      isOrganizer: true,
    })
  require(path.join(ROOT, 'pages/activity/publish/index.js'))
  const publishPage = pageOptions[0]
  const publishCtx = {
    data: { user: null, cityTip: '', form: {} },
    setData(patch) {
      Object.assign(this.data, patch)
    },
  }
  publishCtx.updateCityTip = () => publishPage.updateCityTip.call(publishCtx)
  globalData.city = '杭州'
  globalData.user = { openid: 'openid_me', nickName: '我' }

  publishPage.loadActivity.call(publishCtx, 'act_cloud_shape')

  return Promise.resolve()
    .then(() => null)
    .then(() => null)
    .then(() => {
      log(
        toasts.indexOf('仅发起人可修改活动') === -1,
        '编辑页：云端只下发 isOrganizer 时不再误判「仅发起人可修改」'
      )
      log(
        publishCtx.data.form.title === '云端形状的活动',
        '编辑页：发起人能正常回填表单（编辑 / 驳回重提可用）'
      )

      /* ② 详情页：扫小程序码进来时活动 id 在 scene 里（URL 编码） */
      const detailOptions = []
      global.Page = (options) => detailOptions.push(options)
      delete require.cache[path.join(ROOT, 'pages/activity/detail/index.js')]
      require(path.join(ROOT, 'pages/activity/detail/index.js'))
      const detailPage = detailOptions[0]
      const detailCtx = {
        data: { user: null },
        loadedId: '',
        setData(patch) {
          Object.assign(this.data, patch)
        },
      }
      detailCtx.loadDetail = () => {
        detailCtx.loadedId = detailCtx.data.id
      }
      detailPage.onLoad.call(detailCtx, { scene: 'act_scene_plain' })
      log(detailCtx.loadedId === 'act_scene_plain', '活动详情：扫小程序码进入时用 scene 拿到活动 id')
      detailPage.onLoad.call(detailCtx, { scene: encodeURIComponent('act_scene_encoded') })
      log(detailCtx.loadedId === 'act_scene_encoded', '活动详情：scene 做 URL 解码，编码过的 id 也能命中')
      detailPage.onLoad.call(detailCtx, { id: 'act_by_query' })
      log(detailCtx.loadedId === 'act_by_query', '活动详情：分享卡片 / 页面跳转仍按 query 的 id 进入')
      detailPage.onLoad.call(detailCtx, {})
      log(
        detailCtx.loadedId === '',
        '活动详情：既没有 id 也没有 scene 时按空 id 处理，落到「活动不存在」兜底'
      )
      restore()
    })
    .catch((e) => {
      restore()
      log(false, `云模式入口守卫：用例执行异常 → ${e && e.message}`)
    })
}

/**
 * 本轮合规加固的断言集合：
 * - 手机号只走微信授权 code，默认昵称不含手机号；
 * - 费用只做信息说明（AA / 非 AA + 文字说明），平台不参与任何资金流转；
 * - 反馈内容同样送内容安全；
 * - 审核台不进搜索索引、客服入口可达、发版包排除无关文件。
 */
function checkHardening() {
  const api = require(path.join(ROOT, 'services/api'))
  const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8')
  const cloudJs = read('cloudfunctions/activity/index.js')
  const publishJs = read('pages/activity/publish/index.js')
  const publishWxml = read('pages/activity/publish/index.wxml')
  const publishWxss = read('pages/activity/publish/index.wxss')
  const usercenterWxml = read('pages/usercenter/index.wxml')
  const usercenterWxss = read('pages/usercenter/index.wxss')
  const sitemap = read('sitemap.json')
  const projectConfig = read('project.config.json')
  const { PUBLISH_AGREEMENT, SERVICE_AGREEMENT, JOIN_AGREEMENT, PRIVACY_AGREEMENT } = require(
    path.join(ROOT, 'utils/agreements')
  )

  /* 手机号与昵称 */
  log(
    cloudJs.indexOf('await phoneFromCode(payload.phoneCode)') > -1 && cloudJs.indexOf('text(payload.phone') === -1,
    '手机号：云函数只认微信手机号授权 code，不再接受前端传入的号码'
  )
  log(
    cloudJs.indexOf("if (info.phone !== undefined)") === -1,
    '手机号：updateUser 不接受 phone 字段，无法绕过微信校验写号'
  )
  log(
    cloudJs.indexOf('MASKED_PHONE_NICK') > -1 && cloudJs.indexOf('function defaultNickName') > -1,
    '昵称：默认昵称用「微信用户 + 编号」，登录时纠正历史手机号掩码昵称'
  )
  log(
    PRIVACY_AGREEMENT.paragraphs.join('\n').indexOf('不会展示给其他用户') > -1,
    '隐私政策：写明手机号不展示给其他用户、也不作为对外昵称'
  )

  /* 费用：只做信息说明，平台不参与资金流转 */
  log(
    publishWxml.indexOf('费用说明') > -1 &&
      publishWxml.indexOf('平台不收取任何资金') > -1 &&
      publishWxml.indexOf('人均费用') === -1,
    '发布页：费用方式是 AA / 非 AA 二选一，非 AA 只填文字说明并常驻「平台不收取任何资金」'
  )
  log(
    publishJs.indexOf("errors.fee = '请选择费用方式") > -1 && publishJs.indexOf('feeNote') > -1,
    '发布页：费用方式必选、非 AA 制必须填费用说明'
  )
  log(
    publishWxml.indexOf('onFeeInput"') === -1 && publishJs.indexOf('onFeeInput(') === -1,
    '发布页：费用不再收集金额数字（旧的 onFeeInput / form.fee 已移除）'
  )
  log(
    publishWxss.indexOf('.fee-tip') > -1,
    '发布页：费用说明的免责提示有独立样式，不会在真机上被挤掉'
  )
  log(
    read('pages/activity/detail/index.wxml').indexOf('平台不收取任何资金') > -1,
    '详情页：费用行同样标注「平台不收取任何资金」'
  )
  log(
    cloudJs.indexOf("fail('INVALID_PARAM', '请选择费用方式") > -1 &&
      cloudJs.indexOf("fail('INVALID_PARAM', '非 AA 制活动需填写费用说明") > -1,
    '云函数：服务端同样强制费用方式与费用说明，前端绕不过去'
  )
  const publishText = PUBLISH_AGREEMENT.paragraphs.join('\n')
  log(
    publishText.indexOf('不收取、不代收、不托管任何活动费用') > -1,
    '发布协议：写明平台不收取 / 不代收 / 不托管活动费用，也不提供收款结算通道'
  )

  /* 管辖条款：平台与发布方约定住所地法院，消费者侧不指定具体法院 */
  log(
    publishText.indexOf('平台方住所地有管辖权的人民法院') > -1 && publishText.indexOf('成都市') === -1,
    '发布协议：管辖条款落到「平台方住所地」，不再留占位信息'
  )
  log(
    JOIN_AGREEMENT.paragraphs.join('\n').indexOf('可依法向**有管辖权的人民法院**提起诉讼') > -1 &&
      SERVICE_AGREEMENT.paragraphs.join('\n').indexOf('依法向有管辖权的人民法院提起诉讼') > -1,
    '参与 / 服务协议：不指定平台所在地法院，避免格式条款管辖被认定无效'
  )

  /* 反馈内容安全 */
  log(
    cloudJs.indexOf('async function feedback') > -1 &&
      cloudJs.slice(cloudJs.indexOf('async function feedback')).indexOf('checkText(content') > -1,
    '反馈：云函数对反馈文本送内容安全检测'
  )

  /* 审核台索引与客服入口 */
  log(
    sitemap.indexOf('"disallow"') > -1 && sitemap.indexOf('pages/admin/audit/index') > -1,
    'sitemap：审核台页面不进入微信搜索索引'
  )
  log(
    usercenterWxml.indexOf('open-type="contact"') > -1,
    '个人中心：提供「联系客服」入口'
  )
  // button 自带内容宽度与居中定位，width:100% 压不住，实测会比其他入口窄并按内容居中；
  // 必须把 button 放进普通 entry 行里用 flex:1 撑满，才能与其它入口对齐
  log(
    usercenterWxml.indexOf('<button class="contact-btn" open-type="contact"') > -1 &&
      /\.contact-btn\s*\{[^}]*flex:\s*1/.test(usercenterWxss),
    '个人中心：客服按钮用 flex:1 撑满 entry 行，不依赖 button 自身宽度'
  )

  /* 发版包排除无关文件 */
  log(
    projectConfig.indexOf('".DS_Store"') > -1 &&
      projectConfig.indexOf('".gitignore"') > -1 &&
      projectConfig.indexOf('".git"') > -1,
    '发版包：.DS_Store / .gitignore / .git 已加入 packOptions.ignore'
  )

  /* 费用展示：AA / 非 AA / 历史数据三种都要有可读文案 */
  const aa = api.decorate({ feeMode: 'aa', feeNote: '' })
  const nonAA = api.decorate({ feeMode: 'nonAA', feeNote: '门票自理，人均约 80 元现场分摊' })
  const legacy = api.decorate({ feeMode: 'fixed', fee: 30 })
  const empty = api.decorate({ feeMode: 'nonAA', feeNote: '' })
  log(aa.feeText === 'AA制', '展示：AA 制活动显示「AA制」')
  log(nonAA.feeText === '门票自理，人均约 80 元现场分摊', '展示：非 AA 制原样展示发起人填写的费用说明')
  log(legacy.feeText.indexOf('30') > -1, '展示：历史「fee 数字」数据仍能读出费用说明')
  log(empty.feeText === '费用由发起人说明', '展示：费用说明缺失时给兜底文案，不出现空白')

  /* 行为：反馈违规内容被拦、正常内容可提交 */
  return api
    .feedback({ content: '这是一条违规反馈内容' })
    .then(() => false, (err) => (err && err.code) === 'CONTENT_RISKY')
    .then((blocked) => {
      log(blocked === true, '反馈：命中违规词时拒绝提交')
      return api.feedback({ content: '希望增加周末早场活动' })
    })
    .then((res) => {
      log(!!res && !!res.id, '反馈：正常内容可以正常提交')
    })
}

/* ---------------------- 提审演示数据（cloudfunctions/seed） ----------------------
 * 演示数据是提审时的门面：审核员打开首页 / 广场 / 详情看到的就是这批活动。
 * 它绕过发布表单直接写库，没有 normalizeForm 的校验兜底，字段漏一个线上就是空白或报错；
 * 而且只有 auditStatus: approved 的活动才对外可见，所以「造了数据却看不见」也是这里的错。
 */
function checkSeedData() {
  const seedData = require(path.join(ROOT, 'cloudfunctions/seed/lib/data'))
  const dict = require(path.join(ROOT, 'utils/dict'))
  const citiesCloud = require(path.join(ROOT, 'cloudfunctions/activity/lib/cities'))
  const activitySource = fs.readFileSync(path.join(ROOT, 'cloudfunctions/activity/index.js'), 'utf8')
  const now = Date.now()
  const docs = seedData.buildDocs(now, {})

  log(docs.length >= 20, `演示数据：活动条数 ${docs.length} 条`)

  // ① 类型素材（名称 / emoji / 配色）必须与字典同源，否则卡片配色与类型名对不上
  const typeMismatch = Object.keys(seedData.TYPES).filter((key) => {
    const type = dict.ACTIVITY_TYPES.filter((item) => item.key === key)[0]
    const seed = seedData.TYPES[key]
    return !type || type.name !== seed.name || type.emoji !== seed.emoji || type.color !== seed.color
  })
  log(
    typeMismatch.length === 0 && Object.keys(seedData.TYPES).length === dict.ACTIVITY_TYPES.length,
    `演示数据：类型字典与 utils/dict.js 一致${typeMismatch.length ? `（不一致：${typeMismatch.join('、')}）` : ''}`
  )

  // ② 字段清单：normalizeForm 组装的表单字段 + create 补的运行期字段，演示数据一条都不能少。
  // 直接从云函数源码里抽字段名（含 `title,` 这种简写属性），改了活动字段却忘了改演示数据时会在这里报出来
  const sliceOf = (start, end) => activitySource.slice(activitySource.indexOf(start), activitySource.indexOf(end))
  const fieldNamesIn = (source, indent) =>
    (source.match(new RegExp(`^ {${indent}}([A-Za-z][A-Za-z0-9]*)\\s*[:,]`, 'gm')) || []).map((line) =>
      line.trim().replace(/\s*[:,]$/, '')
    )
  const formFields = fieldNamesIn(sliceOf('function normalizeForm', 'function auditPatch'), 6)
  const runtimeFields = fieldNamesIn(sliceOf('async function create(', 'async function update('), 4)
  const missingFields = formFields.concat(runtimeFields).filter((field) => docs.some((doc) => doc[field] === undefined))
  log(
    formFields.length > 20 && runtimeFields.length >= 5 && missingFields.length === 0,
    `演示数据：字段覆盖 normalizeForm + create 的全部 ${formFields.length + runtimeFields.length} 个字段${
      missingFields.length ? `（缺 ${missingFields.join('、')}）` : ''
    }`
  )

  // ③ 审核状态：pending / rejected 的活动只有发起人自己看得到，演示数据必须直接是已通过
  log(docs.every((doc) => doc.auditStatus === 'approved'), '演示数据：全部为「审核已通过」，审核员打开就能看到')

  // ④ 时间：开始时间在未来、结束不早于开始，且发布时间落在 7 天展示期内（见 utils/expire.js）
  log(
    docs.every((doc) => doc.startTime > now && doc.endTime >= doc.startTime),
    '演示数据：开始时间都在未来，结束时间不早于开始时间'
  )
  log(
    docs.every((doc) => doc.createTime > now - 7 * 86400000),
    '演示数据：发布时间都在 7 天展示期内（不会一导入就被当成过期活动）'
  )

  // ⑤ 报名：人数与名单一致，且每条都还留得出名额 —— 审核员点进任意一条都能走完报名流程
  log(
    docs.every(
      (doc) =>
        doc.joinedCount === doc.joinedPeople.length && doc.joinedCount >= 0 && doc.joinedCount <= doc.maxPeople - 2
    ),
    '演示数据：报名人数与名单一致，且每条都留有不少于 2 个空位'
  )
  log(
    docs.every((doc) => doc.organizer && doc.organizer.openid && doc.joinedPeople.every((m) => m.openid)),
    '演示数据：发起人与报名成员都带快照字段（昵称 / 配色 / 头像文字）'
  )

  // ⑥ 城市：必须是广场 / 首页城市筛选认得的 key，否则按城市筛选时永远查不到
  const unknownCity = docs.filter((doc) => !doc.city || citiesCloud.filterCityKeys(doc.city).indexOf(doc.city) === -1)
  log(
    unknownCity.length === 0,
    `演示数据：城市都是筛选认得的 key${unknownCity.length ? `（可疑：${unknownCity.map((doc) => doc.city).join('、')}）` : ''}`
  )

  // ⑦ 覆盖面：广场能按类型 / 日期 / 星期几筛选，任一维度都不能筛出空列表
  const byType = {}
  const byDay = {}
  const byWeekday = {}
  docs.forEach((doc) => {
    byType[doc.type] = (byType[doc.type] || 0) + 1
    const day = new Date(doc.startTime).toDateString()
    byDay[day] = (byDay[day] || 0) + 1
    byWeekday[doc.startWeekday] = (byWeekday[doc.startWeekday] || 0) + 1
  })
  const dayCounts = Object.keys(byDay).map((key) => byDay[key])
  const thinTypes = Object.keys(byType).filter((key) => byType[key] < 2)
  const minPerDay = Math.min.apply(null, dayCounts)
  log(
    Object.keys(byType).length === dict.ACTIVITY_TYPES.length,
    `演示数据：覆盖全部 ${Object.keys(byType).length} 种活动类型`
  )
  log(thinTypes.length === 0, `演示数据：每种类型至少 2 条${thinTypes.length ? `（偏少：${thinTypes.join('、')}）` : ''}`)
  log(
    dayCounts.length === 7 && minPerDay >= 2,
    `演示数据：未来 7 天每天都有活动（按具体日期筛选不会空，单日最少 ${minPerDay} 条）`
  )
  log(Object.keys(byWeekday).length === 7, '演示数据：7 个星期几都有活动（按星期筛选不会空）')

  // ⑧ 字段长度：与 cloudfunctions/activity/lib/helper.js 的 LIMITS 同一口径
  const limits = { title: 30, desc: 500, location: 50, locationAddress: 100, feeNote: 60 }
  const tooLong = docs.filter((doc) =>
    Object.keys(limits).some((field) => String(doc[field] || '').length > limits[field])
  )
  log(tooLong.length === 0, '演示数据：标题 / 介绍 / 地点 / 费用说明都没超过字段长度上限')

  // ⑨ 费用：平台不参与资金流转，非 AA 制必须是一段文字说明，AA 制不带说明
  log(
    docs.every((doc) => (doc.feeMode === 'nonAA' ? !!doc.feeNote : doc.feeMode === 'aa' && !doc.feeNote)),
    '演示数据：AA 制不带费用说明，非 AA 制带文字说明'
  )

  // ⑩ id 唯一且带演示标记：清理演示数据时只删这一批，不碰真实用户发布的活动
  const ids = docs.map((doc) => doc._id)
  log(
    new Set(ids).size === ids.length &&
      docs.every((doc) => doc.isDemo === true && doc._id.indexOf(seedData.DEMO_PREFIX) === 0),
    '演示数据：id 唯一且都带 isDemo 标记'
  )
}

return checkDeleteAccount()
  .then(() => checkHardening())
  .then(() => checkExpireRule())
  .then(() => checkCloudShapeFixes())
  .then(() => checkSeedData())
})
.then(() => {
  console.log(`\n通过 ${passed.length} 项，失败 ${errors.length} 项\n`)
  // 默认只列失败项；加 VALIDATE_VERBOSE=1 可以把逐条结论也打出来
  if (process.env.VALIDATE_VERBOSE) {
    console.log('通过项：')
    passed.forEach((item) => console.log(`  ✓ ${item}`))
  }
  if (errors.length) {
    console.log('失败项：')
    errors.forEach((item) => console.log(`  ✗ ${item}`))
  }
  if (!errors.length) {
    console.log('✅ 全部检查通过')
  }
  process.exitCode = errors.length ? 1 : 0
})
