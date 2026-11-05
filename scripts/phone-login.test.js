const assert = require('assert')
const path = require('path')

const ROOT = path.resolve(__dirname, '..')
const behaviorPath = path.join(ROOT, 'behaviors/login-behavior')
const appPath = path.join(ROOT, 'app')
const configPath = path.join(ROOT, 'services/config')
const apiPath = path.join(ROOT, 'services/api')
const loginModalPath = path.join(ROOT, 'components/login-modal/index')

const originalBehavior = global.Behavior
const originalComponent = global.Component
const originalApp = global.App
const originalGetApp = global.getApp
const originalWx = global.wx

function setData(target, patch) {
  Object.keys(patch).forEach((key) => {
    const parts = key.split('.')
    let value = target.data
    for (let i = 0; i < parts.length - 1; i += 1) value = value[parts[i]]
    value[parts[parts.length - 1]] = patch[key]
  })
}

function captureDefinition(globalName, pathName) {
  let captured = null
  global[globalName] = (options) => {
    captured = options
  }
  delete require.cache[require.resolve(pathName)]
  require(pathName)
  global[globalName] = undefined
  assert.ok(captured, `应能读取 ${pathName} 定义`)
  return captured
}

async function testLoginGuardRequiresPhone() {
  const behavior = captureDefinition('Behavior', behaviorPath)
  const boundUser = { openid: 'openid_bound', phone: '13800001111' }
  const unboundUser = { openid: 'openid_unbound', phone: '' }
  const storage = { my_user: unboundUser }
  let openedReason = ''

  global.wx = {
    getStorageSync(key) {
      return storage[key]
    },
  }

  const context = Object.assign({}, behavior.methods, {
    data: {},
    selectComponent() {
      return {
        open(reason) {
          openedReason = reason
          return Promise.resolve(null)
        },
      }
    },
  })
  context.whenUserReady = () => Promise.resolve(null)

  global.getApp = () => ({ globalData: { user: unboundUser } })
  assert.strictEqual(context.currentUser(), null, '只有 openid、没有手机号的缓存用户不能视为已登录')
  await context.ensureLogin('发布活动需要先登录')
  assert.strictEqual(openedReason, '发布活动需要先登录', '无手机号的缓存用户继续操作时必须重新打开登录页')

  global.getApp = () => ({
    globalData: { user: boundUser },
    setUser() {},
  })
  assert.strictEqual(context.currentUser(), boundUser, '已绑定手机号的用户可以继续原操作')

  let pageUser = null
  context.setData = (patch) => {
    pageUser = patch.user
  }
  context.handleLoginSuccess(unboundUser)
  assert.strictEqual(pageUser, null, '登录成功回调也不能把没有手机号的账号写进页面登录态')
}

async function testAppDropsCachedUnboundUser() {
  const unboundUser = { openid: 'openid_unbound', phone: '' }
  let app = null
  global.wx = {
    getStorageSync(key) {
      return key === 'my_user' ? unboundUser : ''
    },
  }
  global.App = (options) => {
    app = options
  }
  delete require.cache[require.resolve(appPath)]
  require(appPath)
  app.restoreState()
  assert.strictEqual(app.globalData.user, null, '启动恢复登录态时不能放行没有手机号的旧账号')
}

async function testMockLoginRequiresPhone() {
  const config = require(configPath)
  const originalUseMock = config.useMock
  const storage = {}
  global.wx = {
    getStorageSync(key) {
      return storage[key]
    },
    setStorageSync(key, value) {
      storage[key] = value
    },
    removeStorageSync(key) {
      delete storage[key]
    },
  }

  config.useMock = true
  delete require.cache[require.resolve(apiPath)]
  const api = require(apiPath)
  try {
    await assert.rejects(() => api.login({}), (err) => err && err.code === 'PHONE_REQUIRED')
  } finally {
    config.useMock = originalUseMock
    delete require.cache[require.resolve(apiPath)]
  }
}

async function testCloudLoginHasNoOpenidShortcut() {
  let definition = null
  global.Component = (options) => {
    definition = options
  }
  global.wx = { showToast() {} }
  delete require.cache[require.resolve(loginModalPath)]
  require(loginModalPath)

  let loginPayload = null
  const context = Object.assign({}, definition.methods, {
    data: Object.assign({}, definition.data, {
      agreed: true,
      useMock: false,
      visible: true,
    }),
    setData(patch) {
      setData(this, patch)
    },
    doLogin(payload) {
      loginPayload = payload
    },
  })

  context.onPrimaryTap()
  assert.strictEqual(loginPayload, null, '云模式不能绕过手机号授权直接使用 openid 登录')
}

async function run() {
  await testLoginGuardRequiresPhone()
  await testAppDropsCachedUnboundUser()
  await testMockLoginRequiresPhone()
  await testCloudLoginHasNoOpenidShortcut()
  console.log('手机号登录测试通过')
}

run()
  .catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
  .finally(() => {
    global.Behavior = originalBehavior
    global.Component = originalComponent
    global.App = originalApp
    global.getApp = originalGetApp
    global.wx = originalWx
  })
