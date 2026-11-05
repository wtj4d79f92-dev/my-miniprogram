const assert = require('assert')
const path = require('path')

const ROOT = path.resolve(__dirname, '..')
const originalWx = global.wx

function makeStorage(initial) {
  const data = Object.assign({}, initial || {})
  return {
    data,
    wx: {
      getStorageSync(key) {
        return data[key]
      },
      setStorageSync(key, value) {
        data[key] = value
      },
      removeStorageSync(key) {
        delete data[key]
      },
    },
  }
}

function captureDefinition(globalName, pathName) {
  let captured = null
  const original = global[globalName]
  global[globalName] = (options) => {
    captured = options
  }
  delete require.cache[require.resolve(pathName)]
  require(pathName)
  global[globalName] = original
  assert.ok(captured, `应能读取 ${pathName} 定义`)
  return captured
}

async function run() {
  const storage = makeStorage()
  global.wx = storage.wx

  let privacyNotice = null
  try {
    privacyNotice = require(path.join(ROOT, 'utils/privacy-notice'))
  } catch (e) {
    privacyNotice = null
  }

  assert.ok(privacyNotice, '应提供隐私政策版本确认工具')
  const userA = { openid: 'wx_a', userId: 101, phone: '13800000001' }
  const userB = { openid: 'wx_b', userId: 102, phone: '13800000002' }

  assert.strictEqual(privacyNotice.needsPrivacyUpdate(null), false, '未登录用户不展示政策更新提示')
  assert.strictEqual(privacyNotice.needsPrivacyUpdate(userA), true, '首次遇到当前政策版本的老用户需要提示')

  privacyNotice.acknowledgePrivacy(userA)
  assert.strictEqual(privacyNotice.needsPrivacyUpdate(userA), false, '确认后同一用户不再提示')
  assert.strictEqual(privacyNotice.needsPrivacyUpdate(userB), true, '一个用户的确认不能覆盖另一个用户')

  const stored = storage.data.my_privacy_ack
  stored[String(userA.userId)] = '2000-01-01'
  assert.strictEqual(privacyNotice.needsPrivacyUpdate(userA), true, '旧版本确认在新政策发布后应重新提示')

  privacyNotice.forgetPrivacyAcknowledgement(userA)
  assert.strictEqual(privacyNotice.needsPrivacyUpdate(userA), true, '忘记确认记录后老用户应重新提示')

  const userF = { openid: 'wx_f', userId: 106, phone: '13800000006' }
  let privacyBehavior = null
  try {
    privacyBehavior = captureDefinition(
      'Behavior',
      path.join(ROOT, 'behaviors/privacy-update-behavior.js')
    )
  } catch (e) {
    privacyBehavior = null
  }
  assert.ok(privacyBehavior, '应提供当前页面打开隐私政策的共享 behavior')
  const originalGetApp = global.getApp
  const appForBehavior = {
    globalData: { user: userF, privacyUpdatePending: true },
  }
  const openedPrivacy = []
  global.getApp = () => appForBehavior
  try {
    const context = Object.assign({}, privacyBehavior.methods, {
      data: { user: userF },
      selectComponent(selector) {
        if (selector !== '#privacy-update-modal') return null
        return {
          open() {
            openedPrivacy.push('privacy')
            return true
          },
        }
      },
    })
    assert.strictEqual(
      context.openPrivacyUpdateFromNotice(),
      true,
      '启动提示应在当前页面打开半屏隐私政策'
    )
    assert.strictEqual(openedPrivacy.join(','), 'privacy', '当前页应打开隐私政策正文')

    appForBehavior.globalData.privacyUpdatePending = true
    context.onPrivacyUpdateClose()
    assert.strictEqual(
      appForBehavior.globalData.privacyUpdatePending,
      false,
      '关闭半屏弹窗后应清理待处理状态'
    )
    assert.strictEqual(
      privacyNotice.needsPrivacyUpdate(userF),
      true,
      '关闭弹窗不等于同意政策'
    )

    appForBehavior.globalData.privacyUpdatePending = true
    context.onPrivacyUpdateAgree()
    assert.strictEqual(
      privacyNotice.needsPrivacyUpdate(userF),
      false,
      '当前页确认后应记录当前政策版本'
    )
    assert.strictEqual(
      appForBehavior.globalData.privacyUpdatePending,
      false,
      '当前页确认后应清理待处理状态'
    )
  } finally {
    global.getApp = originalGetApp
  }

  let privacyModal = null
  try {
    privacyModal = captureDefinition(
      'Component',
      path.join(ROOT, 'components/privacy-update-modal/index.js')
    )
  } catch (e) {
    privacyModal = null
  }
  assert.ok(privacyModal, '应提供可挂在任意页面的隐私政策半屏组件')
  const currentModalCalls = []
  const modalContext = Object.assign({}, privacyModal.methods, {
    selectComponent(selector) {
      if (selector !== '#agreement-modal') return null
      return {
        open(key) {
          currentModalCalls.push(`open:${key}`)
        },
      }
    },
    triggerEvent(name, detail) {
      currentModalCalls.push(`${name}:${detail && detail.key}`)
    },
  })
  assert.strictEqual(
    modalContext.open(),
    true,
    '半屏组件应在当前页面直接打开，而不是依赖页面跳转'
  )
  modalContext.onAgree({ detail: { key: 'privacy' } })
  modalContext.onClose()
  assert.deepStrictEqual(
    currentModalCalls,
    ['open:privacy', 'agree:privacy', 'close:undefined'],
    '半屏组件应转发协议确认与关闭事件'
  )

  let modalOptions = null
  let navigatedPage = 0
  const originalGetCurrentPages = global.getCurrentPages
  const switchedTabs = []
  global.wx = Object.assign({}, storage.wx, {
    showModal(options) {
      modalOptions = options
    },
    showToast() {},
    switchTab(options) {
      switchedTabs.push(options.url)
    },
  })
  global.getCurrentPages = () => [
    {
      openPrivacyUpdateFromNotice() {
        navigatedPage += 1
      },
    },
  ]

  try {
    const app = captureDefinition('App', path.join(ROOT, 'app.js'))
    assert.strictEqual(typeof app.maybeShowPrivacyUpdate, 'function', '启动流程应提供政策更新提示入口')
    app.globalData = { user: userB }
    app._privacyPrompted = false

    assert.strictEqual(app.maybeShowPrivacyUpdate(), true, '未确认当前政策的老用户应看到提示')
    assert.strictEqual(
      modalOptions && modalOptions.title,
      '隐私政策更新',
      '提示标题应明确说明这是隐私政策更新'
    )
    assert.strictEqual(app.maybeShowPrivacyUpdate(), false, '同一次启动不能重复弹出政策提示')

    modalOptions.success({ confirm: true })
    assert.strictEqual(navigatedPage, 1, '点击查看政策后应打开完整隐私政策')

    navigatedPage = 0
    modalOptions = null
    app._privacyPrompted = false
    global.getCurrentPages = () => []
    assert.strictEqual(app.maybeShowPrivacyUpdate(), true, '没有页面弹窗方法时也应展示摘要')
    modalOptions.success({ confirm: true })
    assert.strictEqual(
      switchedTabs.length,
      0,
      '点击查看政策不能跳转到其他页面，必须继续停留在当前页面'
    )
  } finally {
    global.getCurrentPages = originalGetCurrentPages
  }

  const originalBehavior = global.Behavior
  global.Behavior = (options) => options
  const page = captureDefinition('Page', path.join(ROOT, 'pages/usercenter/index.js'))
  global.Behavior = originalBehavior
  const appForPage = {
    globalData: { user: userA, privacyUpdatePending: true },
  }
  global.getApp = () => appForPage
  try {
    const context = Object.assign({}, page, {
      data: { user: userA },
    })
    assert.strictEqual(
      typeof context.onAgreementAgree,
      'function',
      '隐私政策弹窗确认应接入版本记录'
    )
    context.onAgreementAgree({ detail: { key: 'privacy' } })
    assert.strictEqual(
      privacyNotice.needsPrivacyUpdate(userA),
      false,
      '老用户点击同意并继续后应记录当前政策版本'
    )
    assert.strictEqual(
      appForPage.globalData.privacyUpdatePending,
      false,
      '确认政策后应清除待打开状态'
    )
  } finally {
    global.getApp = originalGetApp
  }

  const userE = { openid: 'wx_e', userId: 105, phone: '13800000005' }
  privacyNotice.acknowledgePrivacy(userE)
  let clearedUser = null
  const appForDelete = {
    globalData: { user: userE, privacyUpdatePending: false },
    applyUser(user) {
      clearedUser = user
      this.globalData.user = user
    },
    setUnreadCount() {},
  }
  global.getApp = () => appForDelete
  try {
    const context = Object.assign({}, page, {
      data: { user: userE },
      setData() {},
    })
    context.afterDeleteAccount()
    assert.strictEqual(clearedUser, null, '注销后应清除页面登录态')
    assert.strictEqual(
      privacyNotice.needsPrivacyUpdate(userE),
      true,
      '注销后应删除该用户的隐私政策确认记录'
    )
  } finally {
    global.getApp = originalGetApp
  }

  const userC = { openid: 'wx_c', userId: 103, phone: '13800000003' }
  assert.strictEqual(privacyNotice.needsPrivacyUpdate(userC), true, '新登录用户尚未记录政策版本')
  const apiPath = require.resolve(path.join(ROOT, 'services/api'))
  const originalApiCache = require.cache[apiPath]
  require.cache[apiPath] = {
    id: apiPath,
    filename: apiPath,
    loaded: true,
    exports: {
      login() {
        return Promise.resolve(
          Object.assign({}, userC, {
            nickName: '山野阿狼',
            avatarText: '山',
            avatarColor: '#4ECDC4',
            createTime: 1577836800000,
          })
        )
      },
    },
  }
  global.wx = Object.assign({}, storage.wx, {
    showLoading() {},
    hideLoading() {},
    showToast() {},
  })

  try {
    const loginModal = captureDefinition(
      'Component',
      path.join(ROOT, 'components/login-modal/index.js')
    )
    let finishLogin = null
    const context = Object.assign({}, loginModal.methods, {
      data: Object.assign({}, loginModal.data),
      setData(patch) {
        Object.assign(this.data, patch)
      },
      finish(user) {
        finishLogin(user)
      },
    })
    const finished = new Promise((resolve) => {
      finishLogin = resolve
    })
    context.doLogin({ phoneCode: 'phone_code' })
    const loggedIn = await finished
    assert.strictEqual(loggedIn.openid, userC.openid, '登录仍应把服务端用户返回给调用方')
    assert.strictEqual(
      privacyNotice.needsPrivacyUpdate(loggedIn),
      false,
      '登录页已勾选协议的用户登录成功后应记录当前政策版本'
    )
  } finally {
    require.cache[apiPath] = originalApiCache
  }

  console.log('隐私政策更新提示测试通过')
}

run()
  .catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
  .finally(() => {
    global.wx = originalWx
  })
