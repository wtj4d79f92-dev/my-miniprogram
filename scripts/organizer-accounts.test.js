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
const mock = require(path.join(ROOT, 'services/mock'))

async function run() {
  await api.login({ phone: '13800005555' })

  const linkedUserIds = [1002, 1003, 1004, 1005, 1006]
  const saved = await api.adminSaveHomeOrganizers({
    userIds: [1001],
    linkedUserIds: [linkedUserIds],
  })

  assert.deepStrictEqual(
    saved.slots[0].linkedUserIds,
    linkedUserIds,
    '主办方后台应保存主账号之外最多 5 个关联账号'
  )
  assert.deepStrictEqual(
    saved.slots[0].linkedAccounts.map((item) => item.nickName),
    mock.MOCK_USERS.slice(1, 6).map((user) => user.nickName),
    'Mock 后台应回填关联账号昵称供运营核对'
  )

  const organizerList = await api.list({ pageIndex: 0, pageSize: 100, hostSlot: 1 })
  const expectedNames = mock.MOCK_USERS.slice(0, 6).map((user) => user.nickName)
  const actualNames = Array.from(
    new Set(organizerList.list.map((item) => item.organizer && item.organizer.nickName))
  )
  assert.deepStrictEqual(
    actualNames.slice().sort(),
    expectedNames.slice().sort(),
    '主办方活动列表应合并主账号与 5 个关联账号发布的活动'
  )

  await assert.rejects(
    () =>
      api.adminSaveHomeOrganizers({
        userIds: [1001],
        linkedUserIds: [[1002, 1003, 1004, 1005, 1006, 1007]],
      }),
    (err) => err && err.code === 'INVALID_PARAM',
    '一个主办方超过 5 个关联账号时应拒绝保存'
  )

  await assert.rejects(
    () =>
      api.adminSaveHomeOrganizers({
        userIds: [1001, 1007],
        linkedUserIds: [[1002, 1003], [1002, 1004]],
      }),
    (err) => err && err.code === 'INVALID_PARAM',
    '同一个发布账号不能同时属于多个主办方'
  )

  wx.setStorageSync('my_user', mock.MOCK_USERS[1])
  const linkedProfile = await api.organizer(1)
  assert.strictEqual(
    linkedProfile.isOwner,
    false,
    '关联账号进入主办方主页时不应获得管理权限'
  )
  await assert.rejects(
    () => api.updateOrganizerCover(1, 'https://tmp.test/linked-account.jpg'),
    (err) => err && err.code === 'FORBIDDEN',
    '关联账号不能修改主办方主页背景'
  )

  console.log('主办方关联账号测试通过')
}

run().catch((err) => {
  console.error(err)
  process.exit(1)
})
