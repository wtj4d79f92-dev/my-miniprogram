const assert = require('assert')
const path = require('path')

const ROOT = path.resolve(__dirname, '..')
const pagePath = path.join(ROOT, 'pages/activity/publish/index.js')
const {
  normalizeActivityTypes,
  activityTypeLabel,
  activityTypeFields,
  activityHasType,
} = require(path.join(ROOT, 'utils/dict'))

const pageOptions = []
const originalBehavior = global.Behavior
const originalPage = global.Page
const originalWx = global.wx

global.wx = { showToast() {} }
global.Behavior = (options) => options
global.Page = (options) => pageOptions.push(options)
delete require.cache[pagePath]
require(pagePath)
global.Behavior = originalBehavior
global.Page = originalPage
global.wx = originalWx

assert.strictEqual(pageOptions.length, 1, '应能读取活动发布页配置')
assert.deepStrictEqual(
  pageOptions[0].data.form.types,
  ['hiking'],
  '新建活动时活动类型应以数组保存'
)

function createPageContext(options) {
  const data = JSON.parse(JSON.stringify(options.data))
  return {
    ...options,
    data,
    setData(patch) {
      Object.keys(patch).forEach((key) => {
        const parts = key.split('.')
        let target = this.data
        for (let i = 0; i < parts.length - 1; i += 1) {
          target = target[parts[i]]
        }
        target[parts[parts.length - 1]] = patch[key]
      })
    },
  }
}

const context = createPageContext(pageOptions[0])
context.onTypeTap({ currentTarget: { dataset: { type: 'camping' } } })
assert.deepStrictEqual(
  context.data.form.types,
  ['hiking', 'camping'],
  '再次点击其他活动类型时应追加到已选列表'
)

const toasts = []
global.wx = {
  showToast(options) {
    toasts.push(options.title)
  },
}
context.data.form.types = ['hiking']
context.data.form.type = 'hiking'
context.onTypeTap({ currentTarget: { dataset: { type: 'hiking' } } })
assert.deepStrictEqual(context.data.form.types, ['hiking'], '不能取消最后一个活动类型')
assert.deepStrictEqual(toasts, ['请至少保留一个活动类型'], '取消最后一个类型时应提示原因')
global.wx = originalWx

assert.deepStrictEqual(
  normalizeActivityTypes({ type: 'driving', types: ['hiking', 'camping', 'hiking', 'unknown'] }),
  ['hiking', 'camping'],
  '活动类型去重后只保留字典内的类型'
)
assert.deepStrictEqual(
  normalizeActivityTypes({ type: 'driving' }),
  ['driving'],
  '旧活动只有单个 type 时应归一为数组'
)
assert.strictEqual(
  activityTypeLabel(['hiking', 'camping']),
  '徒步 / 露营',
  '多个活动类型应合并成便于展示的名称'
)
assert.deepStrictEqual(
  activityTypeFields({ types: ['camping', 'hiking'] }),
  {
    types: ['camping', 'hiking'],
    typeNames: ['露营', '徒步'],
    type: 'camping',
    typeName: '露营 / 徒步',
    emoji: '⛺',
    color: '#F6D365',
    bg: 'linear-gradient(135deg, #f6d365 0%, #fda085 100%)',
  },
  '活动类型快照应保留已选顺序，并用第一个类型提供旧字段与主题素材'
)
assert.strictEqual(activityHasType({ type: 'hiking' }, 'hiking'), true, '旧活动应能命中其单类型')
assert.strictEqual(
  activityHasType({ type: 'camping', types: ['camping', 'hiking'] }, 'hiking'),
  true,
  '新活动应能命中任意已选类型'
)
assert.strictEqual(
  activityHasType({ type: 'camping', types: ['camping'] }, 'ball'),
  false,
  '未选择的类型不应命中'
)

const gridContext = createPageContext(pageOptions[0])
gridContext.onTypeTap({ currentTarget: { dataset: { type: 'camping' } } })
assert.deepStrictEqual(
  gridContext.data.typeGrid
    .filter((item) => item.active)
    .map((item) => item.key),
  ['hiking', 'camping'],
  '所有已选类型都应保持高亮'
)

const validationContext = createPageContext(pageOptions[0])
validationContext.data.form.types = []
validationContext.data.form.type = ''
assert.strictEqual(
  validationContext.validate().errors.type,
  '请至少选择一个活动类型',
  '类型为空时应给出明确的表单错误'
)

async function testLegacyActivityEdit() {
  const api = require(path.join(ROOT, 'services/api'))
  const originalDetail = api.detail
  const originalGetApp = global.getApp
  api.detail = () =>
    Promise.resolve({
      isOrganizer: true,
      type: 'driving',
      tags: [],
      title: '周末自驾',
      startTime: Date.now() + 86400000,
      endTime: Date.now() + 90000000,
      location: '北京市朝阳区',
      difficulty: 0,
      distance: 0,
      elevationGain: 0,
      feeMode: 'aa',
      maxPeople: 10,
      desc: '',
    })
  global.getApp = () => ({
    globalData: {
      user: { openid: 'organizer' },
      city: '北京',
    },
  })

  const editContext = createPageContext(pageOptions[0])
  editContext.loadActivity('legacy_activity')
  await new Promise((resolve) => setImmediate(resolve))

  assert.deepStrictEqual(editContext.data.form.types, ['driving'], '编辑旧活动时应兼容为单类型数组')
  assert.deepStrictEqual(
    editContext.data.typeGrid
      .filter((item) => item.active)
      .map((item) => item.key),
    ['driving'],
    '编辑旧活动时应高亮其原类型'
  )

  api.detail = originalDetail
  global.getApp = originalGetApp
}

testLegacyActivityEdit()
  .then(() => {
    console.log('活动类型多选测试通过')
  })
  .catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
