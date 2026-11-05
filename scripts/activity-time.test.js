const assert = require('assert')
const path = require('path')

const ROOT = path.resolve(__dirname, '..')
const pagePath = path.join(ROOT, 'pages/activity/publish/index.js')
const calendarPath = path.join(ROOT, 'components/calendar-picker/index.js')
const util = require(path.join(ROOT, 'utils/util'))

const pageOptions = []
let calendarOptions = null
const originalBehavior = global.Behavior
const originalPage = global.Page
const originalComponent = global.Component
const originalWx = global.wx
const originalDateNow = Date.now

global.wx = { showToast() {} }
global.Behavior = (options) => options
global.Page = (options) => pageOptions.push(options)
delete require.cache[pagePath]
require(pagePath)
global.Behavior = originalBehavior
global.Page = originalPage
global.wx = originalWx

global.Component = (options) => {
  calendarOptions = options
}
delete require.cache[calendarPath]
require(calendarPath)
global.Component = originalComponent

function setNestedData(target, patch) {
  Object.keys(patch).forEach((key) => {
    const parts = key.split('.')
    let value = target.data
    for (let i = 0; i < parts.length - 1; i += 1) value = value[parts[i]]
    value[parts[parts.length - 1]] = patch[key]
  })
}

function createPageContext(options) {
  const data = JSON.parse(JSON.stringify(options.data))
  return Object.assign({}, options, {
    data,
    setData(patch) {
      Object.keys(patch).forEach((key) => {
        const parts = key.split('.')
        let target = this.data
        for (let i = 0; i < parts.length - 1; i += 1) target = target[parts[i]]
        target[parts[parts.length - 1]] = patch[key]
      })
    },
  })
}

function validForm(startTime, endTime) {
  return {
    cover: '',
    type: 'hiking',
    types: ['hiking'],
    tags: [],
    title: '周末徒步',
    startTime,
    endTime,
    location: '人民公园',
    locationAddress: '',
    locationLat: 0,
    locationLng: 0,
    difficulty: 3,
    distance: '',
    elevationGain: '',
    feeMode: 'aa',
    feeNote: '',
    maxPeople: 10,
    groupQrCode: '',
    desc: '',
  }
}

function testRejectsPastCollectionTimeToday() {
  const now = new Date(2026, 10, 5, 10, 0, 0, 0).getTime()
  const startTime = new Date(2026, 10, 5, 9, 30, 0, 0).getTime()
  const endTime = new Date(2026, 10, 5, 12, 0, 0, 0).getTime()
  Date.now = () => now

  const context = createPageContext(pageOptions[0])
  context.data.agreed = true
  context.data.showMetrics = false
  context.data.form = validForm(startTime, endTime)

  const result = context.validate()
  assert.strictEqual(
    result.errors.startTime,
    '集合时间必须晚于当前时间',
    '发布当天的集合时间早于当前时间时，应提示时间无效'
  )
  assert.strictEqual(result.key, 'startTime', '无效集合时间应定位到该字段')
}

function testCollectionTimeMustBeStrictlyAfterNow() {
  const now = new Date(2026, 10, 5, 10, 0, 0, 0).getTime()
  const endTime = new Date(2026, 10, 5, 12, 0, 0, 0).getTime()
  Date.now = () => now
  const context = createPageContext(pageOptions[0])
  context.data.agreed = true
  context.data.showMetrics = false
  context.data.form = validForm(now, endTime)

  assert.strictEqual(
    context.validate().errors.startTime,
    '集合时间必须晚于当前时间',
    '集合时间等于当前时刻时也不满足“必须大于现在”'
  )

  context.data.form.startTime = now + 60000
  assert.strictEqual(context.validate().errors.startTime, undefined, '晚于当前一分钟的集合时间应允许发布')
}

function createCalendarContext() {
  return Object.assign({}, calendarOptions.methods, {
    data: JSON.parse(JSON.stringify(calendarOptions.data)),
    setData(patch) {
      setNestedData(this, patch)
    },
    triggerEvent(name, detail) {
      this.lastEvent = { name, detail }
    },
  })
}

async function testDateSelectionKeepsChosenClock() {
  const context = createCalendarContext()
  const selected = new Date(2026, 10, 6, 8, 30, 0, 0).getTime()

  await context.open(selected, {
    title: '选择集合时间',
    minTs: new Date(2026, 10, 5, 0, 0, 0, 0).getTime(),
    withTime: true,
  })
  context.confirm()

  assert.strictEqual(context.lastEvent.name, 'confirm', '确认日期和时间后应关闭并回传结果')
  assert.strictEqual(
    context.lastEvent.detail.timestamp,
    selected,
    '日期确认后应保留用户选择的具体钟点'
  )
}

async function testCalendarRejectsCollectionTimeNotAfterNow() {
  const now = new Date(2026, 10, 5, 10, 0, 0, 0).getTime()
  const selected = new Date(2026, 10, 5, 9, 30, 0, 0).getTime()
  const toasts = []
  const context = createCalendarContext()
  const previousWx = global.wx
  global.wx = {
    showToast(options) {
      toasts.push(options.title)
    },
  }

  try {
    await context.open(selected, {
      title: '选择集合时间',
      minTs: now,
      minTimeMessage: '集合时间必须晚于当前时间',
      withTime: true,
    })
    context.confirm()
  } finally {
    global.wx = previousWx
  }

  assert.strictEqual(context.lastEvent, undefined, '集合时间不晚于当前时间时不应确认关闭弹层')
  assert.deepStrictEqual(toasts, ['集合时间必须晚于当前时间'], '应明确提示用户所选时间无效')
  assert.strictEqual(context.data.visible, true, '时间无效时应保留弹层让用户重新选择')
}

function testPublishOpensCalendarWithTimeAndCurrentThreshold() {
  const now = new Date(2026, 10, 5, 10, 0, 0, 0).getTime()
  const startTime = new Date(2026, 10, 6, 8, 30, 0, 0).getTime()
  let openArgs = null
  Date.now = () => now
  const context = createPageContext(pageOptions[0])
  context.data.form.startTime = startTime
  context.selectComponent = () => ({
    open(ts, options) {
      openArgs = { ts, options }
    },
  })

  context.openCalendar({
    currentTarget: { dataset: { field: 'startTime' } },
  })

  assert.strictEqual(openArgs.ts, startTime, '打开集合时间时应保留当前选择')
  assert.strictEqual(openArgs.options.withTime, true, '发布页日期选择后应继续选择具体钟点')
  assert.strictEqual(openArgs.options.minTs, now, '发布当天的集合时间应以当前时刻为下限')
  assert.strictEqual(
    openArgs.options.minTimeMessage,
    '集合时间必须晚于当前时间',
    '选择无效集合时间时应提示原因'
  )
}

async function testReturnTimeMayEqualCollectionTime() {
  const timestamp = new Date(2026, 10, 6, 8, 30, 0, 0).getTime()
  const context = createCalendarContext()

  await context.open(timestamp, {
    title: '选择返程时间',
    minTs: timestamp,
    minTimeMessage: '返程时间不能早于集合时间',
    minTimeInclusive: true,
    withTime: true,
  })
  context.confirm()

  assert.strictEqual(
    context.lastEvent.detail.timestamp,
    timestamp,
    '返程时间与集合时间相同属于当天往返，不应被钟点选择器拦截'
  )
}

function testActivityDateTimeFormatIncludesClock() {
  const timestamp = new Date(2026, 10, 5, 8, 5, 0, 0).getTime()
  assert.strictEqual(
    util.formatCardDateTime(timestamp),
    '11月05日 周四 08:05',
    '活动时间展示应包含具体到分钟的钟点'
  )
}

function testPublishLabelsShowSelectedClock() {
  const timestamp = new Date(2026, 10, 6, 8, 30, 0, 0).getTime()
  const context = createPageContext(pageOptions[0])
  context._dateField = 'startTime'
  context.onDateConfirm({ detail: { timestamp } })

  assert.strictEqual(
    context.data.startLabel,
    '11月06日 周五 08:30',
    '发布页集合时间应展示用户选择的具体钟点'
  )
  assert.strictEqual(
    context.data.endLabel,
    '11月06日 周五 18:00',
    '默认返程时间应显示当天 18:00'
  )
}

function testNewActivityDefaultsToMorningClock() {
  const now = new Date(2026, 10, 5, 10, 0, 0, 0).getTime()
  const originalGetApp = global.getApp
  Date.now = () => now
  global.getApp = () => ({ globalData: { user: null } })
  const context = createPageContext(pageOptions[0])
  context.loadLineSources = () => {}

  try {
    context.onLoad({})
  } finally {
    global.getApp = originalGetApp
  }

  const d = new Date(context.data.form.startTime)
  assert.strictEqual(d.getDate(), 6, '新建活动默认选择次日')
  assert.strictEqual(d.getHours(), 8, '新建活动默认集合钟点应为早上八点')
  assert.strictEqual(d.getMinutes(), 0, '新建活动默认集合时间应落在整点')
}

function testNewActivityDefaultsReturnToEveningClock() {
  const now = new Date(2026, 10, 5, 10, 0, 0, 0).getTime()
  const originalGetApp = global.getApp
  Date.now = () => now
  global.getApp = () => ({ globalData: { user: null } })
  const context = createPageContext(pageOptions[0])
  context.loadLineSources = () => {}

  try {
    context.onLoad({})
  } finally {
    global.getApp = originalGetApp
  }

  const d = new Date(context.data.form.endTime)
  assert.strictEqual(d.getDate(), 6, '新建活动返程日期应与集合日期相同')
  assert.strictEqual(d.getHours(), 18, '新建活动返程钟点默认应为十八点')
  assert.strictEqual(d.getMinutes(), 0, '新建活动返程默认时间应落在整点')
}

function testUntouchedReturnClockFollowsChangedCollectionDate() {
  const timestamp = new Date(2026, 10, 8, 9, 15, 0, 0).getTime()
  const expectedEnd = new Date(2026, 10, 8, 18, 0, 0, 0).getTime()
  const context = createPageContext(pageOptions[0])
  context._dateField = 'startTime'
  context._endTouched = false

  context.onDateConfirm({ detail: { timestamp } })

  assert.strictEqual(
    context.data.form.endTime,
    expectedEnd,
    '返程时间未手动修改时，改变集合日期后应保持当天 18:00'
  )
}

function testQrCollectionTimeDefaultsUntouchedReturnToEighteen() {
  const startTime = new Date(2026, 10, 8, 7, 30, 0, 0).getTime()
  const expectedEnd = new Date(2026, 10, 8, 18, 0, 0, 0).getTime()
  const context = createPageContext(pageOptions[0])
  context.data.showMetrics = false
  context._startTouched = false
  context._endTouched = false

  context.applyQrFields({ startTime })

  assert.strictEqual(
    context.data.form.endTime,
    expectedEnd,
    '二维码填入集合时间时，未修改过的返程时间应默认为当天 18:00'
  )
}

function testActivityCardUsesCollectionClock() {
  const api = require(path.join(ROOT, 'services/api'))
  const startTime = new Date(2026, 10, 6, 8, 30, 0, 0).getTime()
  const endTime = new Date(2026, 10, 6, 18, 0, 0, 0).getTime()
  const activity = api.decorate({
    id: 'activity_time',
    type: 'hiking',
    types: ['hiking'],
    title: '周末徒步',
    startTime,
    endTime,
    joinedCount: 0,
    maxPeople: 10,
    difficulty: 3,
    distance: 8,
    elevationGain: 300,
    feeMode: 'aa',
    status: 'recruiting',
    auditStatus: 'approved',
    createTime: startTime - 86400000,
  })

  assert.strictEqual(
    activity.dateText,
    '11月06日 周五 08:30',
    '活动卡片应展示集合钟点，避免参与者只知道日期'
  )
  assert.strictEqual(
    activity.periodText,
    '11月06日 周五 18:00',
    '活动返程展示也应包含钟点'
  )
}

async function run() {
  testRejectsPastCollectionTimeToday()
  testCollectionTimeMustBeStrictlyAfterNow()
  await testDateSelectionKeepsChosenClock()
  await testCalendarRejectsCollectionTimeNotAfterNow()
  await testReturnTimeMayEqualCollectionTime()
  testPublishOpensCalendarWithTimeAndCurrentThreshold()
  testActivityDateTimeFormatIncludesClock()
  testPublishLabelsShowSelectedClock()
  testNewActivityDefaultsToMorningClock()
  testNewActivityDefaultsReturnToEveningClock()
  testUntouchedReturnClockFollowsChangedCollectionDate()
  testQrCollectionTimeDefaultsUntouchedReturnToEighteen()
  testActivityCardUsesCollectionClock()
  console.log('活动时间选择测试通过')
}

run()
  .catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
  .finally(() => {
    Date.now = originalDateNow
  })
