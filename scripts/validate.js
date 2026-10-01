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
  // 默认昵称词库与默认头像配色：随机生成的昵称必须两边一致，否则本地演示与线上长相不同
  ['默认昵称与头像配色', 'utils/nickname.js', 'cloudfunctions/activity/lib/nickname.js'],
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

const globalData = { city: '', user: null, locationDenied: false, unreadCount: 0 }
global.wx = createWxStub()
global.getApp = () => ({
  globalData,
  setUser(user) {
    globalData.user = user
  },
  setCity(city) {
    globalData.city = city
  },
  // 未读数在 app 里是一份全局状态（底部 tab 小红点与「我的」入口共用），
  // 这里按真实实现给一个等价的轻量替身，页面用例不必关心它怎么来的
  refreshUnread() {
    return Promise.resolve(globalData.unreadCount || 0)
  },
  syncUnread() {},
  setUnreadCount(count) {
    globalData.unreadCount = Number(count) || 0
    return globalData.unreadCount
  },
})
global.Behavior = (options) => options
global.Component = () => {}

const config = require(path.join(ROOT, 'services/config'))
// 冒烟测试覆盖的是 Mock 数据层，强制走本地模型，不受 config.useMock 开关影响
config.useMock = true
config.mockDelay = 0

const api = require(path.join(ROOT, 'services/api'))
// 默认昵称词库：与云端 lib/nickname.js 同一份，断言生成结果确实来自词库
const { NICK_PREFIX, NICK_SUFFIX } = require(path.join(ROOT, 'utils/nickname'))
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
    '登录：默认昵称不含手机号'
  )
  log(
    NICK_PREFIX.indexOf(user.nickName.slice(0, 2)) > -1 && NICK_SUFFIX.indexOf(user.nickName.slice(2)) > -1,
    `登录：默认昵称从词库随机生成（本次：${user.nickName}）`
  )
  log(
    !/^微信用户\d*$/.test(user.nickName),
    '登录：不再用微信默认的「微信用户」当默认昵称'
  )
  log(
    /^#[0-9A-Fa-f]{6}$/.test(user.avatarColor || '') && user.avatarText === user.nickName.slice(0, 1),
    '登录：默认头像给随机配色 + 昵称首字，不是灰色默认图'
  )
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
  log(joined.joinedCount === 1 && joined.groupQrCode === 'wxfile://tmp_qr.png', '报名：人数增加且返回活动二维码')

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

  /* ---------- 活动留言：仅参与者可见的站内沟通 ---------- */
  // 站内留言是「不跳去微信群也能约上事」的那条闭环，同时它本身是 UGC：
  // 机审要拦违规词、没参加活动的人看不到、只有作者本人与发起人能删
  const storageModule = require(path.join(ROOT, 'utils/storage'))
  const outsiderActivity = page1.list.filter(
    (item) => item.id !== created.id && item.status === 'recruiting' && item.joinedCount < item.maxPeople
  )[0]
  let commentOutsiderError = ''
  try {
    await api.comments(outsiderActivity.id)
  } catch (e) {
    commentOutsiderError = e.code
  }
  log(commentOutsiderError === 'FORBIDDEN', '留言：没参加活动的人看不到留言')

  const myComment = await step('发留言', api.comment(created.id, '九点在地铁口集合，我带一个急救包'))
  log(
    myComment.content === '九点在地铁口集合，我带一个急救包' &&
      myComment.nickName === user.nickName &&
      myComment.openid === undefined,
    '留言：参与者能发言，返回内容脱敏到只剩昵称'
  )
  log(myComment.isMine === true && myComment.canRemove === true, '留言：自己发的留言带删除标记')

  let riskyCommentError = ''
  try {
    await api.comment(created.id, '违规内容测试')
  } catch (e) {
    riskyCommentError = e.code
  }
  log(riskyCommentError === 'CONTENT_RISKY', '留言：命中违规关键词直接拦截')

  let emptyCommentError = ''
  try {
    await api.comment(created.id, '   ')
  } catch (e) {
    emptyCommentError = e.code
  }
  log(emptyCommentError === 'INVALID_PARAM', '留言：空内容不能提交')

  const commentList = await step('留言列表', api.comments(created.id))
  log(
    commentList.list.length === 1 && commentList.list[0].id === myComment.id,
    '留言：参与者能看到本活动的留言，违规与空内容没有写进去'
  )
  log(
    commentList.list.every((item) => item.openid === undefined),
    '留言：列表不下发任何 openid'
  )

  // 换一个本地用户：既不是作者也不是发起人，删不掉别人的留言
  const ownerSnapshot = storageModule.getStorage(storageModule.KEYS.user, null)
  storageModule.setStorage(storageModule.KEYS.user, {
    openid: 'mock_openid_stranger',
    userId: 999,
    nickName: '围观群众',
    avatarColor: '#4ECDC4',
    avatarText: '围',
  })
  let strangerRemoveError = ''
  try {
    await api.commentRemove(created.id, myComment.id)
  } catch (e) {
    strangerRemoveError = e.code
  }
  log(strangerRemoveError === 'FORBIDDEN', '留言：非作者、非发起人不能删除别人的留言')
  storageModule.setStorage(storageModule.KEYS.user, ownerSnapshot)

  // 作者删除自己的留言：软删除，列表里不再出现
  const removedComment = await step('删除留言', api.commentRemove(created.id, myComment.id))
  log(removedComment.removed === true && removedComment.id === myComment.id, '留言：作者可以删除自己的留言')
  const afterRemoveComments = await step('删除后留言列表', api.comments(created.id))
  log(afterRemoveComments.list.length === 0, '留言：删除后不再出现在列表里')

  // 退出活动后失去留言访问：报名是留言区的门槛
  await step('加入别人的活动', api.join(outsiderActivity.id))
  const joinedComments = await step('退出前留言列表', api.comments(outsiderActivity.id))
  log(Array.isArray(joinedComments.list), '留言：报名后能进入活动留言区')
  await step('退出别人的活动', api.quit(outsiderActivity.id))
  let commentAfterQuitError = ''
  try {
    await api.comments(outsiderActivity.id)
  } catch (e) {
    commentAfterQuitError = e.code
  }
  log(commentAfterQuitError === 'FORBIDDEN', '留言：退出活动后不再能查看留言')

  /* ---------- 站内通知：新留言通知发起人，回复通知被回复人 ---------- */
  // 通知是留言的附属产物：一级留言通知活动发起人，回复通知被回复那条留言的作者；
  // 自己给自己留言不产生通知，通知里不带任何 openid。
  const notifyList = () => storageModule.getStorage(mockModel.MOCK_NOTIFY_LIST, []) || []
  // 用一条独立的活动做通知用例：详情页用例的目标活动就是广场最新的那条（种子数据的
  // createTime 排在最前），在这条上留痕会把「刚报名时留言为空」的断言带偏
  const notifyActivity = page1.list.filter(
    (item) =>
      item.id !== created.id &&
      item.id !== outsiderActivity.id &&
      item.status === 'recruiting' &&
      item.joinedCount < item.maxPeople
  )[0]
  const notifyOwner = (notifyActivity.organizer || {}).openid
  await step('加入通知用例的活动', api.join(notifyActivity.id))

  const notifyBeforeTop = notifyList().length
  const topComment = await step('在别人活动里留言', api.comment(notifyActivity.id, '周六九点在地铁口集合'))
  const notifyAfterTop = notifyList()
  log(
    notifyAfterTop.length === notifyBeforeTop + 1 &&
      notifyAfterTop[notifyAfterTop.length - 1].toOpenid === notifyOwner &&
      notifyAfterTop[notifyAfterTop.length - 1].type === 'comment' &&
      notifyAfterTop[notifyAfterTop.length - 1].commentId === topComment.id,
    '通知：一级留言通知活动发起人，带上留言 id 与活动 id'
  )

  // 发起人回复这条留言：换成发起人的身份发送，再切回来查自己收到的通知
  const mySnapshot = storageModule.getStorage(storageModule.KEYS.user, null)
  storageModule.setStorage(storageModule.KEYS.user, {
    openid: notifyOwner,
    userId: 1001,
    nickName: (notifyActivity.organizer || {}).nickName,
    avatarColor: (notifyActivity.organizer || {}).avatarColor,
    avatarText: (notifyActivity.organizer || {}).avatarText,
  })
  const ownerReply = await step('发起人回复留言', api.comment(notifyActivity.id, '收到，我带路', topComment.id))
  storageModule.setStorage(storageModule.KEYS.user, mySnapshot)
  log(
    ownerReply.parentId === topComment.id &&
      ownerReply.replyToId === topComment.id &&
      ownerReply.replyToName === topComment.nickName,
    '回复：挂在一级留言下，并带上被回复人的昵称快照'
  )

  const myNotices = await step('我的通知列表', api.notifications())
  log(
    myNotices.list.length === 1 &&
      myNotices.list[0].type === 'reply' &&
      myNotices.list[0].commentId === ownerReply.id &&
      myNotices.list[0].content === '收到，我带路' &&
      myNotices.list[0].activityId === notifyActivity.id,
    '通知：收到回复通知；自己发的一级留言不给自己发通知'
  )
  log(
    myNotices.list.every((item) => item.toOpenid === undefined && item.fromOpenid === undefined) &&
      !!myNotices.list[0].from &&
      !!myNotices.list[0].from.nickName,
    '通知列表：不下发任何 openid，只给发送者快照'
  )
  log(myNotices.unreadCount === 1, '通知列表：未读数与未读条数一致')

  // 已读：只能操作自己的那条，全部已读后未读数归零
  const ownerNotice = notifyList().filter((item) => item.toOpenid === notifyOwner)[0]
  let strangerReadError = ''
  try {
    await api.notificationRead(ownerNotice.id)
  } catch (e) {
    strangerReadError = e.code
  }
  log(strangerReadError === 'FORBIDDEN', '通知已读：不能标记别人的通知')
  await step('标记自己的通知已读', api.notificationRead(myNotices.list[0].id))
  const afterRead = await step('已读后的通知', api.notifications())
  log(afterRead.unreadCount === 0 && afterRead.list[0].read === true, '通知已读：读过的通知不再计入未读数')
  const unreadCount = await step('未读数', api.notificationUnread())
  log(unreadCount.count === 0, '通知未读数：与列表里的未读数同一口径')
  await step('全部标记已读', api.notificationReadAll())
  log((await step('全部已读后的通知', api.notifications())).unreadCount === 0, '通知已读：支持一次全部标记已读')

  let notifyGuestError = ''
  const guestSnapshot = storageModule.getStorage(storageModule.KEYS.user, null)
  storageModule.setStorage(storageModule.KEYS.user, null)
  try {
    await api.notifications()
  } catch (e) {
    notifyGuestError = e.code
  }
  storageModule.setStorage(storageModule.KEYS.user, guestSnapshot)
  log(notifyGuestError === 'UNAUTHORIZED', '通知列表：未登录不能拉取')

  await step('退出通知用例的活动', api.quit(notifyActivity.id))

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

  // 活动二维码是选填：不建群、不传码的活动同样能发布并机审放行（报名后在小程序内看行前信息）
  const noQrActivity = await step(
    '不上传二维码',
    api.create({
      form: {
        type: 'hiking',
        title: '自动化测试 · 没有活动群',
        location: '浙江省杭州市 九溪',
        startTime: Date.now() + 86400000,
        endTime: Date.now() + 2 * 86400000,
        difficulty: 1,
        distance: 5,
        elevationGain: 80,
        feeMode: 'aa',
        maxPeople: 6,
        tags: [],
        groupQrCode: '',
        desc: '没有建群的活动，信息都在小程序内看',
      },
    })
  )
  log(!!noQrActivity.id, '二维码选填：不上传活动二维码也能发布')
  log(
    noQrActivity.machineCheck.qrcode.status === 'skipped' && noQrActivity.auditStatus === 'approved',
    '二维码选填：没上传记为 skipped 且不阻断机审放行'
  )
  const noQrDetail = api.decorate(await step('没有活动群的活动详情', api.detail(noQrActivity.id)))
  log(!noQrDetail.groupQrCode && noQrDetail.joined === false, '二维码选填：活动详情照常可看、可报名')

  // 活动二维码不是微信群邀请码也不是个人微信二维码：内容再干净也直接驳回
  const qrForm = (groupQrCode) => ({
    type: 'hiking',
    title: '自动化测试 · 活动二维码校验',
    location: '浙江省杭州市 九溪',
    startTime: Date.now() + 86400000,
    endTime: Date.now() + 2 * 86400000,
    feeMode: 'aa',
    maxPeople: 6,
    groupQrCode,
    desc: '内容正常，仅二维码有问题',
  })
  const notGroupQr = await step('二维码非微信码', api.create({ form: qrForm('wxfile://notwechat_qr.png') }))
  log(notGroupQr.auditStatus === 'rejected', '二维码识别：不是微信二维码时直接驳回')
  log(
    notGroupQr.auditRemark === '活动二维码上传有误，请重新上传微信群二维码或个人微信二维码',
    '二维码识别：驳回原因写明重新上传微信群二维码或个人微信二维码'
  )
  log(notGroupQr.machineCheck.qrcode.status === 'not-wechat', '二维码识别：记录「不是微信二维码」的识别结论')

  // 个人微信二维码同样允许上传：识别结论带上 kind，机审照常放行
  const personalQr = await step('个人微信二维码', api.create({ form: qrForm('wxfile://personqr_card.png') }))
  log(personalQr.auditStatus === 'approved', '二维码识别：个人微信二维码同样机审放行')
  log(
    personalQr.machineCheck.qrcode.status === 'ok' && personalQr.machineCheck.qrcode.kind === 'personal',
    '二维码识别：个人微信二维码记录 kind=personal'
  )

  const noQrCode = await step('二维码识别不出', api.create({ form: qrForm('wxfile://noqrcode_poster.png') }))
  log(noQrCode.auditStatus === 'rejected', '二维码识别：图里没识别到二维码时直接驳回')
  log(noQrCode.machineCheck.qrcode.status === 'not-qrcode', '二维码识别：记录「没识别到二维码」的识别结论')
  // 发起人在详情页看到的是「审核未通过 + 原因」，不是「审核中 + 二维码识别提示」
  const qrRejectedCard = api.decorate(await step('二维码驳回详情', api.detail(notGroupQr.id)))
  log(qrRejectedCard.auditRejected && !qrRejectedCard.auditPending, '二维码识别：发起人看到的是「未通过」而不是「审核中」')
  log(
    qrRejectedCard.auditReason === '活动二维码上传有误，请重新上传微信群二维码或个人微信二维码',
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
/* ---------- 5.1 头像：登录页 / 资料弹窗选的头像同样必须先转存云存储 ---------- */
/**
 * chooseAvatar 给到的是本机临时路径（真机 wxfile://、开发者工具 http://tmp/...），
 * 直接落库别人看到的是空白头像，所以云模式必须先 uploadFile 换云文件 ID。
 * 顺带钉住「微信不提供静默获取昵称头像，只能用户点选」这条口径的落地方式。
 */
function checkAvatarUpload() {
  const profile = require(path.join(ROOT, 'utils/profile.js'))
  const uploaded = []
  const setCloud = (fail) => {
    global.wx.cloud = {
      uploadFile({ cloudPath, filePath, success, fail: onFail }) {
        if (fail) {
          onFail({ errMsg: 'uploadFile:fail' })
          return
        }
        uploaded.push({ cloudPath, filePath })
        success({ fileID: `cloud://test-env.${cloudPath}` })
      },
    }
  }

  // 默认昵称判定：老版本「微信用户」与新版本「微信用户 + 编号」都算没填
  log(
    profile.needProfileSetup({ openid: 'o1', userId: 1, nickName: '微信用户1', avatarUrl: '' }) === true,
    '头像昵称：默认昵称（微信用户1）算未完善'
  )
  log(
    profile.needProfileSetup({ openid: 'o1', nickName: '微信用户' }) === true,
    '头像昵称：老默认昵称（微信用户）算未完善'
  )
  log(
    profile.needProfileSetup({ openid: 'o1', nickName: '山野阿宽', avatarUrl: 'cloud://x/a.png' }) === false,
    '头像昵称：已填昵称与头像不再算未完善'
  )
  log(profile.needProfileSetup(null) === false, '头像昵称：未登录不引导完善')

  // 历史脏数据兜底：早期版本把本机临时路径直接落了库，那些头像别人根本看不到
  log(
    profile.isTempAvatar('wxfile://tmp_a.jpg') && profile.isTempAvatar('http://tmp/a.jpg'),
    '头像兜底：本机临时路径（wxfile:// / http://tmp/）能被识别出来'
  )
  log(
    profile.usableAvatar('wxfile://tmp_a.jpg') === '' &&
      profile.usableAvatar('cloud://x/avatar/a.png') === 'cloud://x/avatar/a.png' &&
      profile.usableAvatar('') === '',
    '头像兜底：临时路径按「没有头像」处理，云文件原样保留'
  )
  log(
    profile.needProfileSetup({ openid: 'o1', nickName: 'Rise.ZX', avatarUrl: 'wxfile://tmp_a.jpg' }) === true,
    '头像兜底：头像存的是本机临时路径时重新引导完善（用户重选一次即可修好）'
  )
  log(
    profile.needProfileSetup({ openid: 'o1', nickName: 'Rise.ZX', avatarUrl: 'cloud://x/avatar/a.png' }) === false,
    '头像兜底：正常的云文件头像不会误报成未完善'
  )

  // 只有刚注册的新用户才自动进「完善头像昵称」步骤，老用户登录不再打扰
  log(profile.isFreshUser({ createTime: Date.now() }) === true, '头像昵称：刚注册的新用户会进完善步骤')
  log(
    profile.isFreshUser({ createTime: Date.now() - 10 * 60 * 1000 }) === false,
    '头像昵称：老用户登录不再自动进完善步骤'
  )

  setCloud(false)
  config.useMock = false
  return profile
    .uploadAvatar('http://tmp/tmp_avatar.png')
    .then((url) => {
      log(String(url).indexOf('cloud://test-env.avatar/') === 0, '头像上传：本机临时头像转存云存储后才落库')
      log(uploaded.length === 1, `头像上传：临时头像触发一次上传（实际 ${uploaded.length} 次）`)
      return profile.uploadAvatar('cloud://test-env/avatar/old.png')
    })
    .then((url) => {
      log(url === 'cloud://test-env/avatar/old.png' && uploaded.length === 1, '头像上传：已是云文件时不重复上传')
      return profile.uploadAvatar('')
    })
    .then((url) => {
      log(url === '' && uploaded.length === 1, '头像上传：没选头像时保持空串')
      setCloud(true)
      return profile.uploadAvatar('wxfile://tmp_avatar.png').then(
        () => {
          log(false, '头像上传：上传失败时应 reject，而不是把本机路径写进资料')
        },
        (err) => {
          log(!!(err && err.message), `头像上传：上传失败给出可读原因 → ${err && err.message}`)
        }
      )
    })
    .then(() => {
      // Mock 模式没有云存储，保持本机路径（演示用，不做转存）
      config.useMock = true
      return profile.uploadAvatar('http://tmp/tmp_avatar.png')
    })
    .then((url) => {
      log(url === 'http://tmp/tmp_avatar.png', '头像上传：Mock 模式原样透传，不调云存储')
      config.useMock = false
      return null
    })
    .catch((e) => {
      config.useMock = true
      log(false, `头像上传：执行异常 → ${e && e.message}`)
    })
}

/* ---------- 5.2 登录页的完善头像昵称步骤（静态口径） ---------- */
function checkLoginProfileStep() {
  const loginJs = fs.readFileSync(path.join(ROOT, 'components/login-modal/index.js'), 'utf8')
  const loginWxml = fs.readFileSync(path.join(ROOT, 'components/login-modal/index.wxml'), 'utf8')
  const usercenterJs = fs.readFileSync(path.join(ROOT, 'pages/usercenter/index.js'), 'utf8')
  const avatarJson = readJSON(path.join(ROOT, 'components/login-modal/index.json'))

  log(
    !!(avatarJson.usingComponents && avatarJson.usingComponents.avatar),
    '登录页完善资料：头像组件已注册（否则步骤渲染不出来）'
  )
  log(
    loginWxml.indexOf('open-type="chooseAvatar"') > -1 && loginWxml.indexOf('type="nickname"') > -1,
    '登录页完善资料：头像走 chooseAvatar、昵称走 nickname 输入（微信唯一可用的官方能力）'
  )
  log(
    loginWxml.indexOf('bindtap="skipProfile"') > -1,
    '登录页完善资料：保留「暂不完善」，不阻断登录'
  )
  log(
    loginJs.indexOf('isFreshUser(user) && needProfileSetup(user)') > -1,
    '登录页完善资料：仅新注册且昵称头像没填时自动进入该步骤'
  )
  log(
    loginJs.indexOf('uploadAvatar(this.data.profileAvatar)') > -1,
    '登录页完善资料：保存前先上传头像'
  )
  log(
    usercenterJs.indexOf('uploadAvatar(this.data.editAvatar)') > -1,
    '资料编辑弹窗：保存前先上传头像'
  )
  log(
    usercenterJs.indexOf('usableAvatar(user.avatarUrl)') > -1 &&
      fs.readFileSync(path.join(ROOT, 'components/login-modal/index.js'), 'utf8').indexOf('usableAvatar(user && user.avatarUrl)') > -1,
    '头像兜底：两个资料弹窗都不预填历史临时头像，保存时顺手冲掉脏数据'
  )
  log(
    loginJs.indexOf('wx.getUserProfile(') === -1 && usercenterJs.indexOf('wx.getUserProfile(') === -1,
    '头像昵称：不再调用已被微信回收的 wx.getUserProfile'
  )
}

  return checkAvatarUpload()
    .then(() => {
      checkLoginProfileStep()
      config.useMock = true
      return null
    })
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
  log(!!activity && activity.qrSrc === 'https://cdn.test/detail-qr.jpg', '活动详情：活动二维码优先用临时链接渲染')
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
    // 首页 onShow 会顺带刷新未读小红点，这里给同名的空实现即可
    refreshUnread() {
      return Promise.resolve(0)
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
  const { KEYS, getStorage, setStorage } = require(path.join(ROOT, 'utils/storage'))
  const mockModel = require(path.join(ROOT, 'services/mock'))
  const api = require(path.join(ROOT, 'services/api'))

  let account = null
  let own = null
  let target = null
  // 上面的用例已经在本地留了通知，这里记一个基线，只断言本次新增的条数
  let notifyBaseline = 0
  let notifyAfterSeed = []

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
      notifyBaseline = (getStorage(mockModel.MOCK_NOTIFY_LIST, []) || []).length
      return api.comment(target.id, '注销前在别人活动里留的言')
    })
    .then(() => {
      // 造齐三类通知：发给我的、我自己发出的（上面那条留言已经产生一条）、被删活动下的
      const seeded = (getStorage(mockModel.MOCK_NOTIFY_LIST, []) || []).slice()
      seeded.push(
        {
          id: 'mock_notify_to_me',
          toOpenid: account.openid,
          fromOpenid: 'mock_u_1',
          type: 'reply',
          activityId: target.id,
          commentId: 'cm_x',
          content: '别人回复我的通知',
          read: false,
          createTime: Date.now(),
        },
        {
          id: 'mock_notify_on_own',
          toOpenid: 'mock_u_1',
          fromOpenid: 'mock_u_2',
          type: 'comment',
          activityId: own.id,
          commentId: 'cm_y',
          content: '我发布的活动下的通知',
          read: false,
          createTime: Date.now(),
        },
        {
          id: 'mock_notify_other',
          toOpenid: 'mock_u_1',
          fromOpenid: 'mock_u_2',
          type: 'comment',
          activityId: target.id,
          commentId: 'cm_z',
          content: '与我无关的通知',
          read: false,
          createTime: Date.now(),
        }
      )
      setStorage(mockModel.MOCK_NOTIFY_LIST, seeded)
      notifyAfterSeed = seeded
      return null
    })
    .then(() => {
      const joinMap = getStorage(mockModel.MOCK_JOIN_MAP, {}) || {}
      const commentMap = getStorage(mockModel.MOCK_COMMENT_MAP, {}) || {}
      log(
        !!getStorage(KEYS.user, null) &&
          (getStorage(KEYS.published, []) || []).some((item) => item.id === own.id) &&
          (joinMap[target.id] || []).some((member) => member.openid === account.openid) &&
          (commentMap[target.id] || []).some((item) => item.openid === account.openid) &&
          (getStorage(KEYS.feedback, []) || []).length > 0 &&
          notifyAfterSeed.length === notifyBaseline + 4,
        '注销：注销前账号、发布、报名、留言、通知与反馈几类数据都在'
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
      const commentMap = getStorage(mockModel.MOCK_COMMENT_MAP, {}) || {}
      const leftComments = Object.keys(commentMap).reduce(
        (acc, id) => acc.concat(commentMap[id] || []),
        []
      )
      log(
        leftComments.every((item) => item.openid !== account.openid),
        '注销：自己发过的留言一并删除，别人活动里不留痕'
      )
      const leftNotices = getStorage(mockModel.MOCK_NOTIFY_LIST, []) || []
      log(
        leftNotices.every((item) => item.toOpenid !== account.openid && item.fromOpenid !== account.openid) &&
          leftNotices.every((item) => item.activityId !== own.id) &&
          leftNotices.some((item) => item.id === 'mock_notify_other'),
        '注销：发给自己的、自己发出的、被删活动下的通知一并清理，别人的通知保持不动'
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
      log(
        policy.indexOf('封面图') > -1 && policy.indexOf('活动二维码') > -1 && policy.indexOf('不传二维码也可以发布活动') > -1,
        '隐私政策：写明发布时选择的图片用途，并标明活动二维码为选填'
      )
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

  /** 把本地缓存里某条活动的集合时间改成指定时刻，模拟「集合时间已过 / 今天集合」 */
  const setStart = (id, timestamp) => {
    const list = global.wx.storage[KEYS.published] || []
    list.forEach((item) => {
      if (item.id === id) {
        item.startTime = timestamp
        item.endTime = timestamp + 3 * 3600 * 1000
      }
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
  let started = null
  let todayStart = null

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
      // Mock 的 id 只是时间戳时，同一毫秒内连着建两条会撞成同一个 id，
      // 之后按 id 改期 / 报名 / 编辑就串到另一条记录上（这条用例以前就会偶发红）
      log(aged.id !== fresh.id, 'Mock：连续创建的活动 id 不重复')
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
    .then(() => {
      // 集合时间已过：与展示期同一套兜底（查询过滤 + 输出归一 + 写操作守卫），
      // 所以定时任务不跑（Mock 里本来也没有定时任务）也不会把过期活动当成还在招募
      const dayStart = new Date().setHours(0, 0, 0, 0)
      return api
        .create({ form: formOf('集合时间已过用例') })
        .then((created) => {
          started = created
          // 昨天中午集合：已过集合时间，但发布时间在 7 天展示期内
          setStart(started.id, dayStart - 12 * 3600 * 1000)
          return api.create({ form: formOf('今天集合用例') })
        })
        .then((created) => {
          todayStart = created
          // 今天中午集合：当天仍算可报名（边界），次日才关
          setStart(todayStart.id, dayStart + 12 * 3600 * 1000)
          return Promise.all([
            api.list({ pageIndex: 0, pageSize: 100, sort: 'latest' }),
            api.home({ city: '' }),
            api.detail(started.id),
            api.mine('published'),
          ])
        })
        .then((res) => {
          const square = res[0]
          const home = res[1]
          const detail = res[2]
          const mine = res[3]
          const startedIndex = square.list.findIndex((item) => item.id === started.id)
          const startedDecorated = api.decorate(square.list[startedIndex] || null)
          const todayDecorated = api.decorate(
            square.list.filter((item) => item.id === todayStart.id)[0] || null
          )
          const detailDecorated = detail ? api.decorate(detail) : null
          const mineDecorated = api.decorate(
            (mine || []).filter((item) => item.id === started.id)[0] || null
          )

          log(expire.isPastStart({ startTime: dayStart }, dayStart) === false, '集合时间：今天 00:00 集合不算过')
          log(expire.isPastStart({ startTime: dayStart - 1 }, dayStart) === true, '集合时间：早于今天 00:00 即算过')
          log(expire.isPastStart({}, dayStart) === false, '集合时间：取不到集合时间时不算过，不会误关历史数据')

          log(
            !!startedDecorated && startedDecorated.isClosed === true && startedDecorated.startPassed === true,
            '集合时间：过了集合时间的活动卡片按已关闭展示'
          )
          log(
            startedIndex > -1 &&
              square.list.slice(0, startedIndex).every((item) => item.status !== 'closed'),
            '集合时间：这类活动排在未关闭活动之后（沉底）'
          )
          log(
            !!todayDecorated && todayDecorated.isClosed === false,
            '集合时间：今天集合的活动当天照常展示（边界）'
          )
          log(
            visibleIn((home.hotList || []).concat(home.newestList || []), started.id) === false,
            '集合时间：过集合时间的活动不进首页推荐'
          )
          log(
            !!detail && detail.status === 'closed' && detail.startPassed === true && !!detailDecorated,
            '集合时间：详情按「已关闭 + 已过集合时间」下发，分享链接仍可打开'
          )
          log(
            !!mineDecorated && mineDecorated.isClosed === true && mineDecorated.startPassed === true,
            '集合时间：我的发布里按已关闭展示'
          )

          return Promise.all([
            api.join(started.id).then(() => null, (err) => err),
            api.toggle(started.id).then(() => null, (err) => err),
            // 改期是正常诉求：编辑把集合时间改到未来后不拦（改完重新送审）
            api.update({ id: started.id, form: formOf('集合时间已过用例（改期）') }),
            api.join(todayStart.id).then(() => 'joined', (err) => err),
          ])
        })
        .then((res) => {
          const rescheduled = res[2]
          log(!!res[0] && res[0].code === 'ACTIVITY_STARTED', '集合时间：过了集合时间拒绝报名')
          log(!!res[1] && res[1].code === 'ACTIVITY_STARTED', '集合时间：过了集合时间不能重新打开')
          log(
            !!rescheduled && expire.isPastStart(rescheduled) === false,
            '集合时间：改期（把集合时间改到未来）不被拦截'
          )
          log(res[3] === 'joined', '集合时间：今天集合的活动当天仍可报名（边界）')
        })
    })
}

/* ---------- 14. 活动修改：发起人改完必须重新进入审核 ---------- */
/**
 * 「修改活动」不只服务于驳回重提：已通过的活动同样可以改（改期、改人数、换封面都是正常诉求）。
 * 但任何改动都要重新走一遍审核 —— 否则先发一条合规活动过审、再改成违规内容，审核就被绕过了。
 * 这里把数据层结论（回到待审核、期间从广场下架、通过后带新内容恢复展示）与页面入口一起钉住。
 */
function checkActivityEdit() {
  const api = require(path.join(ROOT, 'services/api'))
  const DAY = 86400000
  const readSource = (relative) => fs.readFileSync(path.join(ROOT, relative), 'utf8')
  const visible = (list, id) => (list || []).some((item) => item.id === id)
  const formOf = (title) => ({
    type: 'hiking',
    title,
    location: '四川省成都市 天府广场',
    locationAddress: '四川省成都市锦江区人民南路',
    startTime: Date.now() + DAY,
    endTime: Date.now() + 2 * DAY,
    difficulty: 3,
    distance: 8,
    elevationGain: 150,
    feeMode: 'aa',
    maxPeople: 8,
    groupQrCode: 'wxfile://tmp_edit_qr.png',
    desc: '修改功能校验',
    cityHint: '成都',
  })

  // 入口得先存在，否则功能在页面上没有落点：
  // 详情页发起人操作条、我发布的卡片工具条、驳回卡片的「修改后重新提交」三条路都指向同一个编辑页
  const detailWxml = readSource('pages/activity/detail/index.wxml')
  const detailJs = readSource('pages/activity/detail/index.js')
  const cardWxml = readSource('components/activity-card/index.wxml')
  const cardJs = readSource('components/activity-card/index.js')
  const listWxml = readSource('pages/user/activity-list/index.wxml')
  const publishWxml = readSource('pages/activity/publish/index.wxml')
  const publishJs = readSource('pages/activity/publish/index.js')

  log(
    detailWxml.indexOf('bindtap="onEditTap"') > -1 && detailJs.indexOf('onEditTap()') > -1,
    '修改活动：详情页给发起人「修改」入口'
  )
  log(
    detailJs.indexOf('!this.data.singlePage && isOrganizer && !activity.expired && !activity.auditPending') > -1,
    '修改活动：单页模式 / 已到期 / 审核中的活动不给修改入口（服务端同样会拒绝）'
  )
  log(
    cardWxml.indexOf('catchtap="onEdit"') > -1 && cardJs.indexOf("triggerEvent('editcard'") > -1,
    '修改活动：「我发布的」卡片工具条上的修改入口已连到组件事件'
  )
  log(
    // 自定义事件必须用 bind:xxx 这种带冒号的写法：连写形式（bindeditcard）在本项目里
    // 不会把组件 triggerEvent 的事件送到页面，点了没反应，排查成本很高
    listWxml.indexOf('bind:editcard="onEdit"') > -1 &&
      cardJs.indexOf("triggerEvent('editcard'") > -1 &&
      listWxml.indexOf('修改后重新提交') > -1,
    '修改活动：列表同时接住卡片「修改」与驳回后的「修改后重新提交」'
  )
  log(
    publishWxml.indexOf('保存修改后活动会重新进入审核') > -1 &&
      publishJs.indexOf('this.data.editId ? api.update(') > -1,
    '修改活动：编辑态提交走 update，并在页面上写明改完要重新审核'
  )

  // Mock 的登录是幂等的（同一个本地会话只会有一个用户），
  // 要造出「发起人 / 路人」两个身份，得按留言用例那套做法直接换本地登录态
  const storageModule = require(path.join(ROOT, 'utils/storage'))
  const switchUser = (openid, nickName, userId) => {
    storageModule.setStorage(storageModule.KEYS.user, {
      openid,
      userId,
      nickName,
      avatarUrl: '',
      avatarColor: '#4ECDC4',
      avatarText: nickName.slice(0, 1),
    })
  }
  const ownerOpenid = 'mock_openid_edit_owner'
  const strangerOpenid = 'mock_openid_edit_stranger'
  const originalUser = storageModule.getStorage(storageModule.KEYS.user, null)
  const originalGlobalUser = globalData.user

  let activity = null

  switchUser(ownerOpenid, '改活动的发起人', 3101)
  return api
    .create({ form: formOf('修改功能用例（初版）') })
    .then((created) => {
      activity = created
      // 不带违禁词的正常内容在 Mock 里机审直接放行，模拟「已经通过审核、正在招募」的活动
      log(created.auditStatus === 'approved', '修改活动：先发一条已通过审核的活动做基线')
      switchUser(strangerOpenid, '围观群众', 3102)
      return Promise.all([
        // 别人不能改：服务端按发起人 openid 校验，不是自己的活动一律 FORBIDDEN
        api.update({ id: activity.id, form: formOf('修改功能用例（冒名）') }).then(() => null, (err) => err),
        api.join(activity.id),
      ])
    })
    .then((res) => {
      log(!!res[0] && res[0].code === 'FORBIDDEN', '修改活动：非发起人改不了别人的活动')
      log(res[1].joinedCount === 1, '修改活动：先让一个人报名，供后面验证编辑不影响报名数据')
      switchUser(ownerOpenid, '改活动的发起人', 3101)
      // 改后的文案里带上「疑似」：机审只会给出「疑似」，必须重新过一遍人工，
      // 这样才看得出「改完真的重新送审了」，而不是拿上一次的审核结论继续用
      return api.update({
        id: activity.id,
        form: Object.assign(formOf('修改功能用例（改后）'), {
          desc: '改后的说明：路线难度疑似偏大，请以现场情况为准',
        }),
      })
    })
    .then((edited) => {
      log(
        edited.auditStatus === 'pending' && edited.auditRemark === '',
        '修改活动：保存后重新回到待审核并清空旧审核意见'
      )
      log(edited.title === '修改功能用例（改后）' && edited.id === activity.id, '修改活动：内容更新，活动还是原来那一条')
      log(edited.joinedCount === 1, '修改活动：报名名单与人数不受修改影响')
      return Promise.all([
        api.list({ pageIndex: 0, pageSize: 100, sort: 'latest' }),
        api.mine('published'),
      ])
    })
    .then((res) => {
      const square = res[0]
      const mine = api.decorate((res[1] || []).filter((item) => item.id === activity.id)[0] || null)
      log(visible(square.list, activity.id) === false, '修改活动：审核期间从广场下架，不再对外招募')
      log(!!mine && mine.auditPending === true, '修改活动：发起人在「我发布的」能看到「审核中」')
      return Promise.all([
        // 审核中：非发起人连详情都看不到，发起人自己仍能预览等待审核
        api.detail(activity.id).then((detail) => detail && detail.id, () => null),
        api.adminApprove(activity.id),
      ])
    })
    .then((res) => {
      log(res[0] === activity.id, '修改活动：审核期间发起人仍能预览自己的活动')
      return api.list({ pageIndex: 0, pageSize: 100, sort: 'latest' })
    })
    .then((square) => {
      const back = (square.list || []).filter((item) => item.id === activity.id)[0]
      log(!!back && back.title === '修改功能用例（改后）', '修改活动：审核通过后带新内容恢复广场展示')
      switchUser(strangerOpenid, '围观群众', 3102)
      return api.detail(activity.id).then((detail) => (detail && detail.title) || '')
    })
    .then((title) => {
      log(title === '修改功能用例（改后）', '修改活动：重新过审后其他人也能看到改后的内容')
      storageModule.setStorage(storageModule.KEYS.user, originalUser)
      globalData.user = originalGlobalUser
      return null
    })
    .catch((e) => {
      storageModule.setStorage(storageModule.KEYS.user, originalUser)
      globalData.user = originalGlobalUser
      log(false, `修改活动：执行异常 → ${e && e.message}`)
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

/* -------------- 朋友圈分享：单页模式适配 -------------- */
/**
 * 用户在朋友圈点开分享卡片，微信不会打开完整小程序，而是进入「单页模式」：
 * 页面没有登录态（wx.login 等登录接口不可用），跳转、分享、报名这类交互被禁用，
 * 云开发资源还必须在控制台开启「允许未登录访问」并配好安全规则才能读到。
 * 老实现把「接口失败」和「活动不存在」混成同一句「活动不存在或已下架」，
 * 于是审核通过、正常招募中的活动在朋友圈里也被显示成已下架。
 * 这里把入口判断、失败态与单页模式的交互降级钉住。
 */
function checkSinglePageShare() {
  const api = require(path.join(ROOT, 'services/api'))
  const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8')

  /* ① 页面配置：自定义导航栏页面在单页模式下默认是 float（微信导航栏压住页面内容），要显式改成 squeezed */
  const detailJson = readJSON(path.join(ROOT, 'pages/activity/detail/index.json'))
  log(
    !!detailJson.singlePage && detailJson.singlePage.navigationBarFit === 'squeezed',
    '朋友圈单页模式：详情页配置 singlePage.navigationBarFit=squeezed，内容不被微信导航栏压住'
  )

  /* ② 页面结构：禁用能力对应的入口在单页模式下不渲染，加载失败要有独立的重试态 */
  const wxml = read('pages/activity/detail/index.wxml')
  log(
    /<navigation-bar[\s\S]*?wx:if="\{\{!singlePage\}\}"/.test(wxml),
    '朋友圈单页模式：不再渲染被禁用的 navigation-bar 组件'
  )
  log(
    /wx:elif="\{\{loadError && !loading\}\}"/.test(wxml) && /bindtap="retryLoad"/.test(wxml),
    '活动详情：加载失败单独成态并可重试，不再和「活动不存在」混在一起'
  )
  log(
    /wx:if="\{\{!singlePage\}\}" class="share-btn"/.test(wxml),
    '朋友圈单页模式：隐藏分享入口（单页模式不支持页内发起分享）'
  )
  log(
    /wx:if="\{\{!isOrganizer && !singlePage\}\}" class="report-entry"/.test(wxml),
    '朋友圈单页模式：隐藏需要登录态的举报入口'
  )
  log(/single-page-tip/.test(wxml), '朋友圈单页模式：底部如实说明「仅展示活动信息，报名操作不可用」')

  /* ③ 页面逻辑：入口判定、失败态、单页模式下的按钮 */
  const originalDetail = api.detail
  const originalEnter = global.wx.getEnterOptionsSync
  let entry = { scene: 1154, query: { id: 'act_from_launch_query' } }
  global.wx.getEnterOptionsSync = () => entry

  const pageOptions = []
  global.Page = (options) => pageOptions.push(options)
  delete require.cache[path.join(ROOT, 'pages/activity/detail/index.js')]
  api.detail = () => Promise.resolve(null)
  require(path.join(ROOT, 'pages/activity/detail/index.js'))
  const detailPage = pageOptions[0]

  const makeCtx = (initial) =>
    Object.assign({}, detailPage, {
      data: Object.assign({}, detailPage.data, { id: '', singlePage: false, user: null }, initial || {}),
      setData(patch) {
        Object.assign(this.data, patch)
      },
      selectComponent() {
        return null
      },
    })

  const restore = () => {
    api.detail = originalDetail
    if (originalEnter === undefined) delete global.wx.getEnterOptionsSync
    else global.wx.getEnterOptionsSync = originalEnter
  }

  // 单页模式下 onLoad 只带场景值：1154 是场景值不是活动 id，不能拿去查活动
  entry = { scene: 1154, query: {} }
  const sceneCtx = makeCtx()
  sceneCtx.loadDetail = () => {
    sceneCtx.loadedId = sceneCtx.data.id
  }
  detailPage.onLoad.call(sceneCtx, { scene: '1154' })
  log(sceneCtx.data.singlePage === true, '朋友圈单页模式：场景值 1154 被识别为单页模式')
  log(sceneCtx.loadedId === '', '朋友圈单页模式：场景值 1154 不会被当成活动 id')
  entry = { scene: 1154, query: { id: 'act_from_launch_query' } }

  // 微信没下发 onLoad 参数时，用启动参数里的 query 兜底，别直接落到「活动不存在」
  const fallbackCtx = makeCtx()
  fallbackCtx.loadDetail = () => {
    fallbackCtx.loadedId = fallbackCtx.data.id
  }
  detailPage.onLoad.call(fallbackCtx, {})
  log(
    fallbackCtx.loadedId === 'act_from_launch_query',
    '朋友圈单页模式：onLoad 拿不到参数时用启动参数里的 query 兜底'
  )

  // 非单页模式：启动场景值同样不能冒充活动 id（历史上扫码进来的 scene 才是 id）
  entry = { scene: 1008, query: {} }
  const chatCtx = makeCtx()
  chatCtx.loadDetail = () => {
    chatCtx.loadedId = chatCtx.data.id
  }
  detailPage.onLoad.call(chatCtx, { scene: '1008' })
  log(chatCtx.loadedId === '' && chatCtx.data.singlePage === false, '活动详情：会话场景值不会被当成活动 id')
  entry = { scene: 1154, query: { id: 'act_from_launch_query' } }

  // 单页模式没有登录态：主按钮只做说明，不再引导点击
  const actCtx = makeCtx({ id: 'act_single_page', singlePage: true })
  detailPage.applyActivity.call(actCtx, {
    id: 'act_single_page',
    title: '朋友圈里的活动',
    type: 'hiking',
    tags: [],
    startTime: Date.now() + 86400000,
    endTime: Date.now() + 2 * 86400000,
    location: '浙江省杭州市 九溪',
    maxPeople: 10,
    joinedPeople: [],
    joinedCount: 0,
    status: 'recruiting',
    auditStatus: 'approved',
    organizer: { nickName: '发起人', avatarColor: '#4ECDC4', avatarUrl: '', avatarText: '发' },
  })
  log(
    actCtx.data.mainBtn.disabled === true && actCtx.data.mainBtn.mode === 'singlepage',
    `朋友圈单页模式：主按钮降级为不可点（${actCtx.data.mainBtn.text}）`
  )
  detailPage.openSharePanel.call(actCtx)
  log(actCtx.data.showSharePanel === false, '朋友圈单页模式：点不到被禁用的分享面板')

  // 集合时间已过：服务端下发 status: closed + startPassed，页面不能再引导发起人「重新打开活动」
  const originalComments = api.comments
  api.comments = () => Promise.resolve({ list: [] })
  const startedCtx = makeCtx({ id: 'act_started' })
  detailPage.applyActivity.call(startedCtx, {
    id: 'act_started',
    title: '集合时间已过的活动',
    type: 'hiking',
    tags: [],
    startTime: Date.now() - 2 * 86400000,
    endTime: Date.now() - 86400000,
    location: '浙江省杭州市 九溪',
    maxPeople: 10,
    joinedPeople: [],
    joinedCount: 0,
    status: 'closed',
    startPassed: true,
    auditStatus: 'approved',
    isOrganizer: true,
    organizer: { nickName: '发起人', avatarColor: '#4ECDC4', avatarUrl: '', avatarText: '发' },
  })
  log(startedCtx.data.statusText === '已关闭', `集合时间已过：状态位按已关闭展示（${startedCtx.data.statusText}）`)
  log(
    startedCtx.data.mainBtn.disabled === true && startedCtx.data.mainBtn.mode === 'closed',
    `集合时间已过：主按钮不可点，不再引导「重新打开活动」（${startedCtx.data.mainBtn.text}）`
  )
  api.comments = originalComments

  // 接口失败要说「加载失败」并能重试，不能说成「活动不存在或已下架」
  const failCtx = makeCtx({ id: 'act_single_page', singlePage: true })
  const originalWarn = console.warn
  console.warn = () => {}
  api.detail = () => Promise.reject(Object.assign(new Error('网络异常，请稍后重试'), { code: 'NETWORK_ERROR' }))
  return detailPage
    .loadDetail.call(failCtx)
    .then(() => {
      log(
        failCtx.data.notFound === false && /加载|重试/.test(failCtx.data.loadError),
        `活动详情：接口失败显示加载失败与重试，而不是「已下架」（${failCtx.data.loadError}）`
      )
      // 普通模式下接口失败同样不能落到「活动不存在」
      const normalCtx = makeCtx({ id: 'act_normal' })
      return detailPage.loadDetail.call(normalCtx).then(() => {
        log(normalCtx.data.notFound === false, '活动详情：普通模式下接口失败也不会显示成「活动不存在」')
      })
    })
    .catch((e) => {
      log(false, `朋友圈单页模式适配：用例执行异常 → ${e && e.message}`)
    })
    .then(() => {
      console.warn = originalWarn
      restore()
    })
}

/* -------------- 分享 / 小程序码直达详情：入口页没有上一页，返回要能落到广场 -------------- */
/**
 * 从分享卡片（会话 1007 / 群聊 1008 / 朋友圈单页 1154）或海报小程序码直达详情时，
 * 详情页就是页面栈里的第一页：自定义导航栏的返回箭头调 navigateBack 会静默失败，
 * 用户被卡在详情页，只能杀掉小程序重进。
 * 这里钉住组件的判断（按页面栈深度决定返回还是回落）以及详情页约定的落点（广场）。
 */
function checkDetailBackFallback() {
  const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8')
  const wxml = read('pages/activity/detail/index.wxml')
  log(
    /<navigation-bar[\s\S]*?back-fallback="\/pages\/square\/index"/.test(wxml),
    '活动详情：分享 / 扫码直达（入口页）时返回箭头回落到广场'
  )

  const components = []
  const originComponent = global.Component
  global.Component = (options) => components.push(options)
  try {
    delete require.cache[path.join(ROOT, 'components/navigation-bar/navigation-bar.js')]
    require(path.join(ROOT, 'components/navigation-bar/navigation-bar.js'))
  } finally {
    global.Component = originComponent
  }
  const component = components[components.length - 1]
  log(
    !!(component && component.methods && typeof component.methods.back === 'function'),
    '导航栏：能取到组件配置'
  )
  if (!component) return

  const originGetCurrentPages = global.getCurrentPages
  const originNavigateBack = global.wx.navigateBack
  const originSwitchTab = global.wx.switchTab
  const originReLaunch = global.wx.reLaunch
  const calls = []
  global.wx.navigateBack = (options) => calls.push(`navigateBack:${options.delta}`)
  global.wx.switchTab = (options) => calls.push(`switchTab:${options.url}`)
  global.wx.reLaunch = (options) => calls.push(`reLaunch:${options.url}`)

  const restore = () => {
    if (originGetCurrentPages === undefined) delete global.getCurrentPages
    else global.getCurrentPages = originGetCurrentPages
    global.wx.navigateBack = originNavigateBack
    global.wx.switchTab = originSwitchTab
    global.wx.reLaunch = originReLaunch
  }

  /** 造一个「当前页面栈是 routes」的组件上下文，和页面里一样把 delta / backFallback 传进来 */
  const makeCtx = (routes, backFallback) => {
    global.getCurrentPages = () => routes.map((route) => ({ route }))
    return {
      data: Object.assign({}, component.data, { delta: 1, backFallback }),
      setData(patch) {
        Object.assign(this.data, patch)
      },
      triggerEvent() {},
    }
  }

  try {
    // 入口页：栈里只有详情页自己，返回箭头必须落到广场，不能点了没反应
    calls.length = 0
    component.methods.back.call(makeCtx(['pages/activity/detail/index'], '/pages/square/index'))
    log(
      calls.join('|') === 'switchTab:/pages/square/index',
      '导航栏：栈里没有上一页时，返回箭头回落到 backFallback'
    )

    // 从广场 / 首页 / 我的活动点进来的正常返回：栈里有上一页，照旧 navigateBack
    calls.length = 0
    component.methods.back.call(
      makeCtx(['pages/square/index', 'pages/activity/detail/index'], '/pages/square/index')
    )
    log(calls.join('|') === 'navigateBack:1', '导航栏：栈里有上一页时仍走 navigateBack')

    // 落点不是 tabBar 页面时 switchTab 会失败，必须退回 reLaunch，同样不能点了没反应
    calls.length = 0
    global.wx.switchTab = (options) => {
      calls.push(`switchTab:${options.url}`)
      if (options.fail) options.fail()
    }
    component.methods.back.call(makeCtx(['pages/activity/detail/index'], '/pages/home/home'))
    log(
      calls.join('|') === 'switchTab:/pages/home/home|reLaunch:/pages/home/home',
      '导航栏：backFallback 不是 tabBar 页面时回落到 reLaunch'
    )
  } finally {
    restore()
  }
}

/* -------------- 首页分享：发送给朋友 / 分享到朋友圈 -------------- */
/**
 * 首页以前没实现 onShareAppMessage / onShareTimeline，右上角菜单里「转发」和「分享到朋友圈」
 * 都是灰的（当前页面不可转发 / 不可分享），整个小程序没有对外的分享入口。
 * 这里钉住三件事：两个分享回调都有内容、分享图是代码包内可用的 5:4 卡片图、
 * 以及首页被分享到朋友圈后（单页模式）跳转类入口不会点了没反应地硬跳。
 */
function checkHomeShare() {
  const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8')

  /* ① 页面配置：单页模式下自定义导航栏必须 squeezed，否则微信导航栏压住页面内容 */
  const homeJson = readJSON(path.join(ROOT, 'pages/home/home.json'))
  log(
    !!homeJson.singlePage && homeJson.singlePage.navigationBarFit === 'squeezed',
    '首页分享：配置 singlePage.navigationBarFit=squeezed，朋友圈打开时内容不被微信导航栏压住'
  )

  /* ② 页面结构：被禁用的入口（自定义导航栏、发布按钮）在单页模式下不渲染 */
  const wxml = read('pages/home/home.wxml')
  log(
    /<navigation-bar[\s\S]*?wx:if="\{\{!singlePage\}\}"/.test(wxml),
    '首页分享：单页模式下不再渲染自定义 navigation-bar'
  )
  log(/class="fab"[^>]*wx:if="\{\{!singlePage\}\}"/.test(wxml), '首页分享：单页模式下不再渲染「发布」悬浮按钮')
  log(/class="single-page-tip"/.test(wxml), '首页分享：顶部如实说明朋友圈浏览模式的能力范围')

  /* ③ 分享图：代码包里的 PNG，好友卡片 5:4、朋友圈卡片 1:1，两张都别指望微信截页面 */
  const imageSize = (rel) => {
    if (!exists(rel)) return null
    const png = fs.readFileSync(path.join(ROOT, rel))
    const isPng = png.length > 24 && png.slice(1, 4).toString('latin1') === 'PNG'
    if (!isPng) return { width: 0, height: 0 }
    return { width: png.readUInt32BE(16), height: png.readUInt32BE(20) }
  }
  const friendImage = imageSize('assets/share-home.png')
  log(
    !!friendImage && friendImage.height > 0 && Math.abs(friendImage.width / friendImage.height - 1.25) < 0.01,
    `首页分享：好友卡片图 assets/share-home.png ${friendImage ? `${friendImage.width}×${friendImage.height}` : '缺失'}，符合微信 5:4 比例`
  )
  const timelineImage = imageSize('assets/logo.png')
  log(
    !!timelineImage && timelineImage.width === timelineImage.height,
    `首页分享：朋友圈卡片图 assets/logo.png ${timelineImage ? `${timelineImage.width}×${timelineImage.height}` : '缺失'}，符合微信 1:1 比例`
  )

  /* ④ 页面逻辑：分享回调内容 + 单页模式下的跳转降级（普通模式照旧跳转） */
  const calls = []
  const originalEnter = global.wx.getEnterOptionsSync
  const original = {
    switchTab: global.wx.switchTab,
    navigateTo: global.wx.navigateTo,
    showLoading: global.wx.showLoading,
    hideLoading: global.wx.hideLoading,
    showToast: global.wx.showToast,
    showModal: global.wx.showModal,
  }
  const originPage = global.Page
  const pageOptions = []
  global.wx.switchTab = (options) => calls.push(`switchTab:${options.url}`)
  global.wx.navigateTo = (options) => calls.push(`navigateTo:${options.url}`)
  global.wx.showLoading = () => {}
  global.wx.hideLoading = () => {}
  global.wx.showToast = () => {}
  global.wx.showModal = () => {}
  global.Page = (options) => pageOptions.push(options)
  delete require.cache[path.join(ROOT, 'pages/home/home.js')]
  require(path.join(ROOT, 'pages/home/home.js'))
  const homePage = pageOptions[0]

  const makeCtx = () => {
    const ctx = Object.assign({}, homePage, {
      data: Object.assign({}, homePage.data),
      setData(patch) {
        Object.assign(this.data, patch)
      },
      selectComponent() {
        return null
      },
    })
    // behaviors 里的登录守卫由框架合并，单测里补一个「未登录」版本
    ctx.ensureLogin = () => Promise.resolve(null)
    return ctx
  }

  const restore = () => {
    global.Page = originPage
    if (originalEnter === undefined) delete global.wx.getEnterOptionsSync
    else global.wx.getEnterOptionsSync = originalEnter
    Object.keys(original).forEach((key) => {
      if (original[key] === undefined) delete global.wx[key]
      else global.wx[key] = original[key]
    })
  }

  // 分享回调：好友卡片带首页路径，朋友圈卡片带标题与同一张图
  const normalCtx = makeCtx()
  global.wx.getEnterOptionsSync = () => ({ scene: 1001, query: {} })
  homePage.onLoad.call(normalCtx)
  log(normalCtx.data.singlePage === false, '首页分享：普通场景不会被识别成单页模式')

  const friendCard = homePage.onShareAppMessage.call(normalCtx)
  log(
    !!friendCard && friendCard.path === '/pages/home/home' && !!friendCard.title,
    `首页分享：右上角「发送给朋友」有卡片内容（${friendCard && friendCard.title}）`
  )
  const timelineCard = homePage.onShareTimeline.call(normalCtx)
  log(
    !!timelineCard && !!timelineCard.title,
    `首页分享：右上角「分享到朋友圈」有卡片内容（${timelineCard && timelineCard.title}）`
  )
  log(
    friendCard && friendCard.imageUrl === '/assets/share-home.png' && timelineCard.imageUrl === '/assets/logo.png',
    `首页分享：两张卡片分别用 5:4 与 1:1 的代码包内品牌图（${friendCard && friendCard.imageUrl} / ${timelineCard && timelineCard.imageUrl}）`
  )

  // 普通模式：搜索 / 玩法 / 卡片入口照旧跳转
  calls.length = 0
  homePage.goSquare.call(normalCtx, { currentTarget: { dataset: { type: 'hiking' } } })
  homePage.onCardTap.call(normalCtx, { detail: { id: 'act_home' } })
  log(
    calls.join('|') === 'switchTab:/pages/square/index|navigateTo:/pages/activity/detail/index?id=act_home',
    `首页分享：普通模式下搜索与卡片入口照旧跳转（${calls.join('、')}）`
  )

  // 单页模式：跳转 / 定位被微信禁用，不能再点了没反应地硬跳
  global.wx.getEnterOptionsSync = () => ({ scene: 1154, query: {} })
  const singleCtx = makeCtx()
  homePage.onLoad.call(singleCtx)
  log(singleCtx.data.singlePage === true, '首页分享：场景值 1154 被识别为朋友圈单页模式')
  calls.length = 0
  homePage.goSquare.call(singleCtx, { currentTarget: { dataset: { type: 'hiking' } } })
  homePage.onTypeTap.call(singleCtx, { currentTarget: { dataset: { type: 'camping' } } })
  homePage.onCardTap.call(singleCtx, { detail: { id: 'act_home' } })
  homePage.goPublish.call(singleCtx)
  homePage.onLocateTap.call(singleCtx)
  log(calls.length === 0, `首页分享：单页模式下跳转 / 定位入口全部静默（调用：${calls.join('、') || '无'}）`)

  restore()
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
    cloudJs.indexOf('MASKED_PHONE_NICK') > -1 && cloudJs.indexOf('randomNickName()') > -1,
    '昵称：默认昵称随机生成（lib/nickname.js），登录时纠正历史手机号掩码昵称'
  )
  log(
    cloudJs.indexOf("require('./lib/nickname')") > -1,
    '昵称：默认昵称 / 头像配色走 lib/nickname.js，不在云函数里另写一份'
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

  /* 审核口径：活动二维码是选填的补充沟通渠道，不能变成「必须扫码才能体验」 */
  // 这一版就是按「小程序内服务强制引流至其他渠道才能体验」被驳回的：
  // 发布必须传二维码、报名成功当刻强弹二维码弹窗，审核员看到的链路就只剩「去微信群」
  const detailJs = read('pages/activity/detail/index.js')
  const detailWxml = read('pages/activity/detail/index.wxml')
  log(
    publishJs.indexOf('请上传活动二维码') === -1 && cloudJs.indexOf('请上传活动二维码') === -1,
    '二维码选填：发布页与云函数都不再把活动二维码当必填项'
  )
  log(
    publishWxml.indexOf('二维码只是参与者想临时沟通时的补充渠道') > -1 &&
      publishWxss.indexOf('.qr-tip') > -1,
    '二维码选填：发布页写明不上传也能发布（含独立样式，真机上不会被挤掉）'
  )
  log(
    detailJs.indexOf('扫码加入活动群') === -1 && detailJs.indexOf('joinTitle') === -1,
    '详情页：二维码文案不再写「扫码加入活动群」这类把进群当体验前提的说法'
  )
  // submitJoin 到 quitActivity 这两个函数之间就是报名成功后的处理：里面不该再出现弹窗
  const submitJoinStart = detailJs.indexOf('  submitJoin() {')
  const submitJoinBody = detailJs.slice(submitJoinStart, detailJs.indexOf('  quitActivity() {', submitJoinStart))
  log(
    submitJoinBody.indexOf('showQrModal') === -1 && submitJoinBody.indexOf('报名成功') > -1,
    '详情页：报名成功只提示结果，不再自动弹出活动二维码'
  )
  log(
    detailWxml.indexOf('行前信息') > -1 &&
      detailWxml.indexOf('不需要额外渠道') > -1 &&
      detailWxml.indexOf('bindtap="openQrModal"') > -1 &&
      detailWxml.indexOf('class="qr-entry"') > -1,
    '详情页：报名后在小程序内给出行前信息，活动二维码只保留「退出活动」旁的用户主动入口'
  )

  /* 活动留言：仅参与者可见的站内沟通，同时也是 UGC —— 三个口子一个都不能少 */
  // 1. 只有参与者能看能发；2. 内容过机审；3. 可删除 + 可举报
  log(
    cloudJs.indexOf("const comments = db.collection('activity_comments')") > -1 &&
      cloudJs.indexOf('function isParticipant(doc, openid)') > -1 &&
      cloudJs.indexOf("fail('FORBIDDEN', '加入活动后才能查看留言')") > -1 &&
      cloudJs.indexOf("fail('UNAUTHORIZED', '请先登录')") > -1,
    '留言：云端只对参与者开放，非参与者连条数都拿不到'
  )
  log(
    cloudJs.indexOf('const checked = await checkText(content, openid)') > -1 &&
      cloudJs.indexOf("fail('CONTENT_RISKY', '留言包含违规内容，请修改后重试')") > -1,
    '留言：内容与昵称、反馈、活动文案共用同一套文本内容安全'
  )
  log(
    cloudJs.indexOf('COMMENT_REMOVED') > -1 &&
      cloudJs.indexOf('removedBy: openid') > -1 &&
      cloudJs.indexOf('data: { status: COMMENT_REMOVED, removedBy: openid, removeTime: Date.now() }') > -1,
    '留言：删除是软删除，保留原文与操作人供运营复核'
  )
  log(
    cloudJs.indexOf("target: commentDoc ? 'comment' : 'activity'") > -1 &&
      cloudJs.indexOf('commentContent: commentDoc') > -1,
    '举报：可以举报活动里的某条留言，记录带留言 id 与内容快照'
  )
  log(
    detailWxml.indexOf('活动留言') > -1 &&
      detailWxml.indexOf('仅参与本活动的人可见') > -1 &&
      detailWxml.indexOf('bindtap="onCommentReport"') > -1 &&
      detailWxml.indexOf('wx:if="{{canComment}}"') > -1,
    '详情页：留言卡片只对参与者渲染，并带举报入口'
  )
  log(
    detailJs.indexOf('const canComment = !this.data.singlePage && (joined || isOrganizer)') > -1 &&
      detailJs.indexOf('onCommentRemove') > -1,
    '详情页：留言入口与报名状态同源，退出活动后入口随之消失'
  )
  log(
    read('services/api.js').indexOf('mockIsParticipant') > -1 &&
      read('services/mock.js').indexOf('MOCK_COMMENT_MAP') > -1,
    '留言：Mock 数据层与云端同一套权限与字段口径'
  )

  /* 站内通知：新留言通知发起人，回复通知被回复的留言者 */
  log(
    cloudJs.indexOf("const notifications = db.collection('notifications')") > -1 &&
      cloudJs.indexOf('async function notifyForComment(activity, comment, user, target)') > -1 &&
      cloudJs.indexOf('type: target ? NOTIFY_REPLY : NOTIFY_COMMENT') > -1 &&
      cloudJs.indexOf('if (!toOpenid || toOpenid === user.openid) return') > -1,
    '通知：云端按「一级留言通知发起人、回复通知被回复人」写入，自己给自己留言不通知'
  )
  log(
    cloudJs.indexOf("fail('NOT_FOUND', '要回复的留言不存在或已删除')") > -1 &&
      cloudJs.indexOf('parentId: target ? String(target.parentId || target._id)') > -1 &&
      cloudJs.indexOf('replyToName: target ?') > -1,
    '回复：云端只允许回复同活动里未删除的留言，并记下所属一级留言与被回复人快照'
  )
  log(
    cloudJs.indexOf("fail('FORBIDDEN', '只能操作自己的消息')") > -1 &&
      cloudJs.indexOf('async function removeNotifications(openid, activityIds)') > -1 &&
      cloudJs.indexOf('notifications: notificationsRemoved') > -1,
    '通知：只能读自己的，注销时连站内通知一起清理'
  )
  log(
    read('pages/activity/detail/index.wxml').indexOf('bindtap="onCommentReply"') > -1 &&
      read('pages/activity/detail/index.js').indexOf('replyTarget') > -1 &&
      read('services/api.js').indexOf('mockNotifyForComment') > -1 &&
      read('services/mock.js').indexOf('MOCK_NOTIFY_LIST') > -1,
    '回复：详情页带回复入口，Mock 数据层与云端同一套规则'
  )
  log(
    read('pages/usercenter/index.wxml').indexOf('bindtap="goMessage"') > -1 &&
      read('pages/usercenter/index.wxml').indexOf('entry-badge') > -1 &&
      read('pages/usercenter/index.js').indexOf('.refreshUnread(this)') > -1 &&
      read('pages/message/index.js').indexOf('.notifications()') > -1 &&
      appJson.pages.indexOf('pages/message/index') > -1,
    '我的：消息入口与未读红点接到通知接口，消息中心页已注册并展示列表'
  )
  // 未读小红点是全局的：底部 tab 也要能看见，不能只在「我的」页面里红
  log(
    read('app.js').indexOf('unreadCount: 0') > -1 &&
      read('app.js').indexOf('refreshUnread(page)') > -1 &&
      read('app.js').indexOf('.notificationUnread()') > -1 &&
      read('app.js').indexOf('syncUnread(page)') > -1,
    '未读小红点：app 里统一拉取并缓存，底部 tab 与「我的」共用一份'
  )
  log(
    read('custom-tab-bar/index.wxml').indexOf('tab-badge') > -1 &&
      read('custom-tab-bar/index.wxml').indexOf("item.icon === 'user' && unread") > -1 &&
      read('custom-tab-bar/index.js').indexOf('unread: 0') > -1 &&
      read('custom-tab-bar/index.wxss').indexOf('.tab-badge') > -1,
    '未读小红点：底部 tab 的「我的」上按未读数渲染小红点'
  )
  log(
    read('pages/home/home.js').indexOf('app.refreshUnread(this)') > -1 &&
      read('pages/square/index.js').indexOf('app.refreshUnread(this)') > -1 &&
      read('pages/message/index.js').indexOf('setUnreadCount(') > -1,
    '未读小红点：首页 / 广场 / 我的切换时都会刷新，读掉消息后立刻同步给 tab'
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

/* -------------- 首页横幅：后台配图，没配图回退渐变 -------------- */
/**
 * 首页横幅配图：运营直接在云数据库的 banners 集合里填一条 image（云存储 fileID 或 https 直链）。
 * 没配图的横幅必须还是原来的渐变 + emoji + 文案，不能因为加了图片能力把默认横幅渲染成空白。
 */
function checkBannerImage() {
  const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8')
  const homeWxml = read('pages/home/home.wxml')
  const homeWxss = read('pages/home/home.wxss')
  const cloudJs = read('cloudfunctions/activity/index.js')
  const clientDict = require(path.join(ROOT, 'utils/dict'))
  const cloudDict = require(path.join(ROOT, 'cloudfunctions/activity/lib/dict'))

  // ① 数据契约：两端默认横幅都带 image 字段（空串 = 没配图），照抄默认数据时不会漏字段
  log(
    clientDict.DEFAULT_BANNERS.every((item) => typeof item.image === 'string') &&
      cloudDict.DEFAULT_BANNERS.every((item) => typeof item.image === 'string'),
    '横幅：前端与云函数的默认数据都带 image 字段'
  )

  // ② 渲染：有图用图（临时链接优先，退回原始 fileID），标题 / 副标题照旧压在图片上
  log(
    /<image[^>]*class="banner-image"[^>]*src="\{\{item\.imageUrl \|\| item\.image\}\}"/.test(homeWxml),
    '横幅：配图时渲染图片，优先用临时链接、退回原始 fileID'
  )
  log(
    /class="banner-item"[^>]*style="background: \{\{item\.bg\}\};"/.test(homeWxml),
    '横幅：没配图的横幅保留渐变背景兜底，不会渲染成空白'
  )
  log(
    homeWxml.indexOf('banner-title') > -1 && homeWxml.indexOf('banner-sub') > -1,
    '横幅：标题 / 副标题的排版与原来一致'
  )
  // 图片是照片时 emoji 会像贴上去的贴纸，有图就不叠加
  log(
    /class="banner-emoji"[^>]*wx:if="\{\{!\(item\.imageUrl \|\| item\.image\)\}\}"/.test(homeWxml),
    '横幅：有配图时不再叠加 emoji'
  )
  log(
    ['.banner-image', '.banner-mask'].every((name) => homeWxss.indexOf(`${name} {`) > -1),
    '横幅：图片层与压暗蒙层都有独立样式，文字压在照片上也读得清'
  )

  // ③ 云函数：后台填云存储 fileID 时换成 https 临时链接再下发（客户端读别人传的图不受存储权限限制）
  log(
    /function attachBannerImageUrls/.test(cloudJs) && /collectFileIDs\(list, \['image'\]\)/.test(cloudJs),
    '横幅：云函数把横幅图片的云存储 fileID 换成临时链接'
  )

  // ④ 本地快照：横幅图片链接与封面临时链接同样是 2 小时过期。
  // 快照仍在 24 小时缓存窗口内、但已经比临时链接更陈时，首帧必须先摘掉横幅图片（退回渐变），
  // 否则整条横幅要白加载一次失败的图；接口返回后图片自然补上。
  const { KEYS, getStorage, setStorage, removeStorage } = require(path.join(ROOT, 'utils/storage'))
  const originPage = global.Page
  const pageOptions = []
  global.Page = (options) => pageOptions.push(options)
  delete require.cache[path.join(ROOT, 'pages/home/home.js')]
  require(path.join(ROOT, 'pages/home/home.js'))
  global.Page = originPage
  const homePage = pageOptions[0]
  const ctx = Object.assign({}, homePage)
  ctx.data = JSON.parse(JSON.stringify(homePage.data))
  ctx.setData = function setData(patch) {
    Object.assign(this.data, patch)
  }
  const cachedBefore = getStorage(KEYS.homeCache, null)
  setStorage(KEYS.homeCache, {
    city: globalData.city || '',
    // 3 小时前：比 2 小时的图片临时链接更陈，但还在 24 小时的快照窗口里
    time: Date.now() - 3 * 60 * 60 * 1000,
    banners: [
      {
        _id: 'banner_cache',
        title: '缓存里的横幅',
        subtitle: '副标题',
        emoji: '🏕️',
        bg: 'linear-gradient(135deg, #84fab0 0%, #8fd3f4 100%)',
        image: 'cloud://banner-cache.png',
        imageUrl: 'https://tmp.test/cloud%3A%2F%2Fbanner-cache.png',
      },
    ],
    hotList: [],
    newestList: [],
  })
  const usedCache = ctx.renderCache()
  log(
    usedCache === true && ctx.data.banners[0].imageUrl === '' && ctx.data.banners[0].image === '',
    '横幅：过陈快照先摘掉横幅图片（退回渐变），接口返回后再补图'
  )
  if (cachedBefore === null) removeStorage(KEYS.homeCache)
  else setStorage(KEYS.homeCache, cachedBefore)
}

/* -------------- 活动留言：详情页只给参与者渲染，发送 / 删除即时生效 -------------- */
/**
 * 数据层的权限在 Mock 链路与 scripts/cloud-validate.js 里覆盖，这里验证页面这一层的决策：
 * 非参与者不渲染留言卡（canComment=false，并清掉上一次的留言），
 * 参与者能加载、发送后立刻出现在列表里、删除后从列表消失。
 */
function checkDetailComments() {
  const api = require(path.join(ROOT, 'services/api'))
  const { KEYS, getStorage, setStorage } = require(path.join(ROOT, 'utils/storage'))
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

  const pageOptions = []
  global.Page = (options) => pageOptions.push(options)
  const detailPagePath = path.join(ROOT, 'pages/activity/detail/index.js')
  // 前面几组用例已经 require 过这个页面，清掉缓存保证重新拿到一份干净的配置
  delete require.cache[require.resolve(detailPagePath)]
  require(detailPagePath)
  const page = pageOptions[0]

  const originalToast = global.wx.showToast
  const originalModal = global.wx.showModal
  global.wx.showToast = () => {}
  global.wx.showModal = (options) => options.success({ confirm: true })

  const userSnapshot = getStorage(KEYS.user, null)
  // 换一个全新的本地用户：既没参加过活动，也不是任何活动的发起人
  const tester = {
    openid: 'mock_openid_comment_tester',
    userId: 77,
    nickName: '留言测试员',
    avatarColor: '#4ECDC4',
    avatarText: '留',
  }
  setStorage(KEYS.user, tester)
  globalData.user = tester

  const createInstance = (activityId) => {
    const ctx = Object.assign({}, page)
    ctx.data = JSON.parse(JSON.stringify(page.data))
    ctx.data.id = activityId
    ctx.setData = function setData(patch) {
      Object.assign(this.data, patch)
    }
    return ctx
  }

  const restore = () => {
    setStorage(KEYS.user, userSnapshot)
    globalData.user = userSnapshot
    global.wx.showToast = originalToast
    global.wx.showModal = originalModal
  }

  let targetId = ''
  return api
    .list({ pageIndex: 0, pageSize: 20, sort: 'latest' })
    .then((res) => {
      targetId = res.list[0].id
      return api.detail(targetId)
    })
    .then((raw) => {
      const outsider = createInstance(targetId)
      outsider.applyActivity(raw)
      log(
        outsider.data.canComment === false && outsider.data.comments.length === 0,
        '详情页：没参加活动时不渲染留言卡'
      )
      return api.join(targetId)
    })
    .then(() => api.detail(targetId))
    .then((raw) => {
      const ctx = createInstance(targetId)
      ctx.applyActivity(raw)
      log(ctx.data.canComment === true, '详情页：报名后出现留言入口')
      return ctx
        .loadComments()
        .then(() => {
          log(ctx.data.comments.length === 0, '详情页：刚报名时留言列表为空，不是一直卡在加载中')
          return ctx.sendComment('九点在地铁口集合，我带了急救包')
        })
        .then(() => {
          log(
            ctx.data.comments.length === 1 && ctx.data.commentInput === '',
            '详情页：发送后留言立刻出现在列表里并清空输入框'
          )
          log(
            !!ctx.data.comments[0].timeLabel && ctx.data.comments[0].isMine === true,
            '详情页：留言带展示用时间与「我发的」标记'
          )
          const commentId = ctx.data.comments[0].id
          ctx.onCommentRemove({ currentTarget: { dataset: { commentId } } })
          return wait(50).then(() => {
            log(ctx.data.comments.length === 0, '详情页：删除后这条留言从列表里消失')
          })
        })
    })
    .then(() => api.quit(targetId))
    .then(() => {
      restore()
      return null
    })
    .catch((e) => {
      restore()
      log(false, `详情页留言：执行异常 → ${e && e.message}`)
    })
}

/* -------------- 消息中心：只展示自己的通知，点开即已读并跳转 -------------- */
/**
 * 数据层的读写规则在 Mock 链路与 scripts/cloud-validate.js 里覆盖，这里验证页面这一层的决策：
 * 只渲染发给自己的通知、带上动作文案与时间、点开后标已读并跳到对应活动。
 */
function checkMessagePage() {
  const api = require(path.join(ROOT, 'services/api'))
  const { KEYS, getStorage, setStorage } = require(path.join(ROOT, 'utils/storage'))
  const mockModel = require(path.join(ROOT, 'services/mock'))
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

  const pageOptions = []
  global.Page = (options) => pageOptions.push(options)
  const messagePagePath = path.join(ROOT, 'pages/message/index.js')
  delete require.cache[require.resolve(messagePagePath)]
  require(messagePagePath)
  const page = pageOptions[0]

  const originalToast = global.wx.showToast
  const originalNavigate = global.wx.navigateTo
  global.wx.showToast = () => {}
  let navigated = ''
  global.wx.navigateTo = (options) => {
    navigated = (options && options.url) || ''
  }

  const userSnapshot = getStorage(KEYS.user, null)
  const notifySnapshot = getStorage(mockModel.MOCK_NOTIFY_LIST, [])
  const tester = {
    openid: 'mock_openid_msg_tester',
    userId: 88,
    nickName: '消息测试员',
    avatarColor: '#4ECDC4',
    avatarText: '消',
  }
  setStorage(KEYS.user, tester)
  globalData.user = tester
  setStorage(mockModel.MOCK_NOTIFY_LIST, [
    {
      id: 'mock_notify_msg_1',
      toOpenid: tester.openid,
      fromOpenid: 'mock_u_1',
      type: 'comment',
      fromNickName: '山野阿宽',
      fromAvatarColor: '#4ECDC4',
      fromAvatarUrl: '',
      fromAvatarText: '山',
      activityId: 'mock_act_1',
      activityTitle: '香山轻装徒步 · 看层林尽染',
      commentId: 'c_1',
      content: '我带了对讲机，路上联系',
      read: false,
      createTime: Date.now(),
    },
    {
      id: 'mock_notify_msg_2',
      toOpenid: 'mock_u_2',
      fromOpenid: 'mock_u_1',
      type: 'reply',
      fromNickName: '山野阿宽',
      fromAvatarColor: '#4ECDC4',
      fromAvatarUrl: '',
      fromAvatarText: '山',
      activityId: 'mock_act_2',
      activityTitle: '环雁栖湖骑行',
      commentId: 'c_2',
      content: '别人的通知',
      read: false,
      createTime: Date.now(),
    },
  ])

  const ctx = Object.assign({}, page)
  ctx.data = JSON.parse(JSON.stringify(page.data))
  ctx.setData = function setData(patch) {
    Object.assign(this.data, patch)
  }

  const restore = () => {
    setStorage(KEYS.user, userSnapshot)
    setStorage(mockModel.MOCK_NOTIFY_LIST, notifySnapshot)
    globalData.user = userSnapshot
    global.wx.showToast = originalToast
    global.wx.navigateTo = originalNavigate
  }

  return ctx
    .load()
    .then(() => {
      log(
        ctx.data.list.length === 1 && ctx.data.unreadCount === 1,
        '消息中心：只展示发给自己的通知，未读数与之一致'
      )
      log(
        ctx.data.list[0].actionText.indexOf('发起的活动') > -1 &&
          !!ctx.data.list[0].timeLabel &&
          ctx.data.list[0].from.nickName === '山野阿宽',
        '消息中心：按通知类型给出动作文案，带时间与发送者快照'
      )
      ctx.onItemTap({ currentTarget: { dataset: { id: 'mock_notify_msg_1' } } })
      log(
        navigated.indexOf('pages/activity/detail/index') > -1 && navigated.indexOf('id=mock_act_1') > -1,
        '消息中心：点一条消息跳到对应活动'
      )
      return wait(20)
    })
    .then(() => {
      log(ctx.data.unreadCount === 0 && ctx.data.list[0].read === true, '消息中心：点开后这条消息立即标记已读')
      return ctx.onReadAll()
    })
    .then(() => {
      const stored = getStorage(mockModel.MOCK_NOTIFY_LIST, []) || []
      log(
        stored.filter((item) => item.toOpenid === tester.openid).every((item) => item.read === true) &&
          stored.some((item) => item.id === 'mock_notify_msg_2' && item.read === false),
        '消息中心：全部已读只影响自己的通知，别人的保持未读'
      )
      restore()
      return null
    })
    .catch((e) => {
      restore()
      log(false, `消息中心：执行异常 → ${e && e.message}`)
    })
}

return checkDeleteAccount()
  .then(() => checkHardening())
  .then(() => checkActivityEdit())
  .then(() => checkExpireRule())
  .then(() => checkCloudShapeFixes())
  .then(() => checkSinglePageShare())
  .then(() => checkDetailBackFallback())
  .then(() => checkHomeShare())
  .then(() => checkBannerImage())
  .then(() => checkDetailComments())
  .then(() => checkMessagePage())
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
