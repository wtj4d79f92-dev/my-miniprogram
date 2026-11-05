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
let ownerAccount = null

async function testOwnerCanUpdateOwnCover() {
  const owner = await api.login({ phone: '13800002222' })
  ownerAccount = owner
  mock.MOCK_USERS.push(owner)
  await api.adminSaveHomeOrganizers([owner.userId])

  await api.updateOrganizerCover(1, 'cloud://env.test/organizer-cover/owner.jpg')
  const profile = await api.organizer(1)

  assert.strictEqual(
    profile.coverUrl,
    'cloud://env.test/organizer-cover/owner.jpg',
    '主办方应能读取自己保存的主页背景图'
  )
}

async function testOrganizerProfileMarksOnlyOwnerAsEditable() {
  wx.setStorageSync('my_user', ownerAccount)
  const ownerProfile = await api.organizer(1)
  assert.strictEqual(ownerProfile.isOwner, true, '主办方本人进入主页时应获得编辑权限')

  wx.removeStorageSync('my_user')
  await api.login({ phone: '13800004444' })
  const visitorProfile = await api.organizer(1)
  assert.strictEqual(visitorProfile.isOwner, false, '其他用户进入主页时不应获得编辑权限')
}

async function testOtherCannotUpdateCover() {
  wx.removeStorageSync('my_user')
  await api.login({ phone: '13800003333' })

  await assert.rejects(
    () => api.updateOrganizerCover(1, 'cloud://env.test/organizer-cover/other.jpg'),
    (err) => err && err.code === 'FORBIDDEN',
    '非主办方不应能修改该主办方主页的背景图'
  )
}

testOwnerCanUpdateOwnCover()
  .then(testOrganizerProfileMarksOnlyOwnerAsEditable)
  .then(testOtherCannotUpdateCover)
  .then(() => console.log('主办方主页背景图测试通过'))
  .catch((err) => {
    console.error(err)
    process.exit(1)
  })
