const assert = require('assert')
const path = require('path')

const ROOT = path.resolve(__dirname, '..')
const memory = {}

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
  showToast() {},
}

const api = require(path.join(ROOT, 'services/api'))
const slots = Array.from({ length: 10 }, (_, index) => ({
  slot: index + 1,
  userId: index === 0 ? 1001 : 0,
  nickName: index === 0 ? '山野阿宽' : '',
  found: index === 0,
  linkedUserIds: index === 0 ? [1002, 1003, 1004, 1005, 1006] : [],
  linkedAccounts:
    index === 0
      ? [1002, 1003, 1004, 1005, 1006].map((userId) => ({
          userId,
          nickName: `关联账号${userId}`,
          found: true,
        }))
      : [],
}))

api.adminHomeOrganizers = () => Promise.resolve({ slots })
let savePayload = null
api.adminSaveHomeOrganizers = (payload) => {
  savePayload = payload
  return Promise.resolve({ slots })
}

const pages = []
const originPage = global.Page
global.Page = (options) => pages.push(options)
const pageFile = path.join(ROOT, 'pages/admin/audit/index.js')
delete require.cache[pageFile]
require(pageFile)
global.Page = originPage
const page = pages[0]
assert.ok(page, '审核台页面应能加载')

function makeCtx() {
  const ctx = Object.assign({}, page)
  ctx.data = JSON.parse(JSON.stringify(page.data))
  ctx.setData = function setData(patch) {
    Object.keys(patch).forEach((key) => {
      const parts = key
        .replace(/\[(\d+)\]/g, '.$1')
        .split('.')
        .filter(Boolean)
      let target = this.data
      for (let i = 0; i < parts.length - 1; i += 1) {
        const part = parts[i]
        if (!target[part]) target[part] = {}
        target = target[part]
      }
      target[parts[parts.length - 1]] = patch[key]
    })
  }
  return ctx
}

async function run() {
  const ctx = makeCtx()
  await page.openOrganizers.call(ctx)

  const firstSlot = ctx.data.organizerUserIds[0]
  assert.strictEqual(firstSlot.linked.length, 5, '每个主办方应展示 5 个关联账号输入位')
  assert.deepStrictEqual(
    firstSlot.linked.map((item) => item.value),
    ['1002', '1003', '1004', '1005', '1006'],
    '后台应回显已保存的关联账号'
  )
  assert.strictEqual(
    firstSlot.linked[0].nickName,
    '关联账号1002',
    '后台应展示关联账号昵称便于运营核对'
  )

  page.onOrganizerLinkedIdInput.call(ctx, {
    currentTarget: { dataset: { slotIndex: 0, linkIndex: 4 } },
    detail: { value: '1007' },
  })
  assert.strictEqual(
    ctx.data.organizerUserIds[0].linked[4].value,
    '1007',
    '运营修改关联账号后应立即更新本地输入状态'
  )

  await page.saveOrganizers.call(ctx)
  assert.deepStrictEqual(
    savePayload.userIds.slice(0, 2),
    ['1001', ''],
    '保存主办方配置时仍按坑位提交主账号'
  )
  assert.deepStrictEqual(
    savePayload.linkedUserIds[0],
    ['1002', '1003', '1004', '1005', '1007'],
    '保存主办方配置时应一并提交关联账号'
  )

  console.log('主办方关联账号审核台测试通过')
}

run().catch((err) => {
  console.error(err)
  process.exit(1)
})
