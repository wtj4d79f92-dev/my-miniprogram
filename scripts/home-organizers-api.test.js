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
  setStorage({ key, data }) {
    memory[key] = data
  },
}

const config = require(path.join(ROOT, 'services/config'))
config.useMock = true
const api = require(path.join(ROOT, 'services/api'))

async function run() {
  await api.login({ phone: '13800001111' })

  const saved = await api.adminSaveHomeOrganizers([1001, 1002])
  assert.strictEqual(saved.slots.length, 10, 'Mock 后台保存后返回固定 10 个坑位')
  assert.strictEqual(saved.slots[0].userId, 1001, 'Mock 后台回显数字用户 ID')
  assert.strictEqual(saved.slots[0].nickName, '山野阿宽', 'Mock 后台按用户 ID 自动补昵称')

  const home = await api.home({ city: '' })
  assert.strictEqual(home.organizerSlots.length, 2, 'Mock 首页只返回已配置的有效主办方')
  assert.strictEqual(home.organizerSlots[0].nickName, '山野阿宽', 'Mock 首页下发主办方昵称')
  assert.ok(
    home.organizerSlots.every((item) => item.openid === undefined && item.userId === undefined),
    'Mock 首页不下发 openid 或后台用户 ID'
  )

  const firstHost = await api.list({ pageIndex: 0, pageSize: 100, hostSlot: 1 })
  assert.ok(firstHost.list.length > 0, 'Mock 主办方列表应能筛出活动')
  assert.ok(
    firstHost.list.every((item) => item.organizer && item.organizer.nickName === '山野阿宽'),
    'Mock 主办方列表只返回该主办方的活动'
  )

  const organizer = await api.organizer(1)
  assert.strictEqual(organizer.nickName, '山野阿宽', 'Mock 主办方主页接口返回公开昵称')
  assert.strictEqual(organizer.avatarText, '山', 'Mock 主办方主页接口返回头像兜底文字')
  assert.ok(
    organizer.openid === undefined && organizer.userId === undefined,
    'Mock 主办方主页接口不下发身份字段'
  )

  console.log('首页主办方 Mock API 测试通过')
}

run().catch((err) => {
  console.error(err)
  process.exit(1)
})
