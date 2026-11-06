const assert = require('assert')
const path = require('path')

const ROOT = path.resolve(__dirname, '..')
const pagePath = path.join(ROOT, 'pages/activity/publish/index.js')
const detailPagePath = path.join(ROOT, 'pages/activity/detail/index.js')
const calendarPath = path.join(ROOT, 'components/calendar-picker/index.js')
const util = require(path.join(ROOT, 'utils/util'))

const pageOptions = []
const detailPageOptions = []
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

global.Page = (options) => detailPageOptions.push(options)
delete require.cache[detailPagePath]
require(detailPagePath)
global.Page = originalPage

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

function testDateOnlyCollectionTimeDefaultsToEight() {
  const { parseQrFields } = require(path.join(ROOT, 'utils/qr-text'))
  const now = new Date(2026, 10, 5, 10, 0, 0, 0).getTime()
  const parsed = parseQrFields('集合时间：11月8日\n全程8公里', now)
  const start = new Date(parsed.startTime)

  assert.strictEqual(
    parsed.clockText,
    '',
    '只识别到日期时，不应把系统补的钟点当成截图里明确写出的时间'
  )
  assert.strictEqual(start.getDate(), 8, '应保留识别出的集合日期')
  assert.strictEqual(start.getHours(), 8, '非当天集合时间应默认上午八点')
  assert.strictEqual(start.getMinutes(), 0, '默认集合时间应落在整点')
}

function testTodayDateOnlyCollectionTimeDefaultsToOneHourLater() {
  const { parseQrFields } = require(path.join(ROOT, 'utils/qr-text'))
  const now = new Date(2026, 10, 5, 10, 23, 45, 0).getTime()
  const parsed = parseQrFields('集合时间：今天\n全程8公里', now)
  const start = new Date(parsed.startTime)

  assert.strictEqual(parsed.clockText, '', '当天只识别到日期时，补出的时间不算截图明确写出的钟点')
  assert.strictEqual(start.getDate(), 5, '当天默认集合时间应保留当天日期')
  assert.strictEqual(start.getHours(), 11, '当天集合时间应在当前时间基础上加一小时')
  assert.strictEqual(start.getMinutes(), 23, '当天默认集合时间应保留当前分钟')
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

async function testCalendarReportsWhetherTimeWasEdited() {
  const dateOnly = createCalendarContext()
  await dateOnly.open(new Date(2026, 10, 6, 8, 0, 0, 0).getTime(), {
    withTime: true,
  })
  dateOnly.onSelect({
    currentTarget: { dataset: { ts: new Date(2026, 10, 7, 0, 0, 0, 0).getTime() } },
  })
  dateOnly.confirm()
  assert.strictEqual(
    dateOnly.lastEvent.detail.timeTouched,
    false,
    '只选择日期时，应明确回传具体时间没有被编辑'
  )

  const withClock = createCalendarContext()
  await withClock.open(new Date(2026, 10, 6, 8, 0, 0, 0).getTime(), {
    withTime: true,
  })
  withClock.onTimeChange({ detail: { value: '09:15' } })
  withClock.confirm()
  assert.strictEqual(
    withClock.lastEvent.detail.timeTouched,
    true,
    '修改具体时间后，应回传具体时间已被用户编辑'
  )
}

async function testDateSelectionUsesRuleBasedDefaultClock() {
  const now = new Date(2026, 10, 5, 10, 23, 45, 0).getTime()
  Date.now = () => now
  const context = createCalendarContext()
  await context.open(new Date(2026, 10, 6, 8, 0, 0, 0).getTime(), {
    withTime: true,
  })

  context.onSelect({
    currentTarget: { dataset: { ts: new Date(2026, 10, 5, 0, 0, 0, 0).getTime() } },
  })
  assert.strictEqual(context.data.timeValue, '11:23', '选择当天日期后，具体时间应默认为当前时间加一小时')

  context.onSelect({
    currentTarget: { dataset: { ts: new Date(2026, 10, 8, 0, 0, 0, 0).getTime() } },
  })
  assert.strictEqual(context.data.timeValue, '08:00', '选择非当天日期后，具体时间应默认为上午八点')
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

function testPublishMarksClockOnlyAfterTimeEdit() {
  const timestamp = new Date(2026, 10, 6, 8, 30, 0, 0).getTime()
  const context = createPageContext(pageOptions[0])
  context._dateField = 'startTime'
  context._endTouched = false

  context.onDateConfirm({ detail: { timestamp, timeTouched: false } })
  assert.strictEqual(
    context.data.form.startTimeHasClock,
    false,
    '只调整日期、不编辑具体时间时，不应把默认钟点标记为已明确'
  )

  context.onDateConfirm({ detail: { timestamp, timeTouched: true } })
  assert.strictEqual(
    context.data.form.startTimeHasClock,
    true,
    '编辑具体时间后，应将集合时间标记为已明确'
  )
}

async function testEditFormRestoresWhetherClockWasExplicit() {
  const api = require(path.join(ROOT, 'services/api'))
  const originalDetail = api.detail
  const originalGetApp = global.getApp
  const startTime = new Date(2026, 10, 6, 8, 0, 0, 0).getTime()
  const context = createPageContext(pageOptions[0])
  context.updateCityTip = () => {}
  global.getApp = () => ({ globalData: { user: { openid: 'mock_owner' } } })
  api.detail = () =>
    Promise.resolve({
      id: 'activity_time_edit',
      title: '周末徒步',
      type: 'hiking',
      types: ['hiking'],
      startTime,
      startTimeHasClock: true,
      endTime: new Date(2026, 10, 6, 18, 0, 0, 0).getTime(),
      location: '人民公园',
      organizer: { openid: 'mock_owner' },
      isOrganizer: true,
      expired: false,
    })

  try {
    await context.loadActivity('activity_time_edit')
  } finally {
    api.detail = originalDetail
    global.getApp = originalGetApp
  }

  assert.strictEqual(
    context.data.form.startTimeHasClock,
    true,
    '编辑活动时应恢复原先是否明确过具体时间的状态'
  )
}

async function testEditFormTreatsMissingClockMarkerAsNotChosen() {
  const api = require(path.join(ROOT, 'services/api'))
  const originalDetail = api.detail
  const originalGetApp = global.getApp
  const context = createPageContext(pageOptions[0])
  context.updateCityTip = () => {}
  global.getApp = () => ({ globalData: { user: { openid: 'mock_owner' } } })
  api.detail = () =>
    Promise.resolve({
      id: 'activity_time_old',
      title: '旧活动',
      type: 'hiking',
      types: ['hiking'],
      startTime: new Date(2026, 10, 6, 8, 0, 0, 0).getTime(),
      endTime: new Date(2026, 10, 6, 18, 0, 0, 0).getTime(),
      location: '人民公园',
      organizer: { openid: 'mock_owner' },
      isOrganizer: true,
      expired: false,
    })

  try {
    await context.loadActivity('activity_time_old')
  } finally {
    api.detail = originalDetail
    global.getApp = originalGetApp
  }

  assert.strictEqual(
    context.data.form.startTimeHasClock,
    false,
    '编辑旧活动时，缺少主动选择标记应按具体时间未明确处理'
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

function testNewActivityDefaultClockIsNotMarkedExplicit() {
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

  assert.strictEqual(
    context.data.form.startTimeHasClock,
    false,
    '系统为新建活动补的默认钟点不应视为用户已经明确具体时间'
  )
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

function testQrCollectionTimeTracksWhetherClockWasRecognized() {
  const { parseQrFields } = require(path.join(ROOT, 'utils/qr-text'))
  const now = new Date(2026, 10, 5, 10, 0, 0, 0).getTime()
  const context = createPageContext(pageOptions[0])
  context.data.showMetrics = false
  context._startTouched = false
  context._endTouched = false

  context.applyQrFields(parseQrFields('集合时间：11月8日', now))
  assert.strictEqual(
    context.data.form.startTimeHasClock,
    false,
    '只识别到日期时，表单应记录具体时间尚未明确'
  )

  context._startTouched = false
  context.applyQrFields(parseQrFields('集合时间：11月8日 07:30', now))
  assert.strictEqual(
    context.data.form.startTimeHasClock,
    true,
    '识别到明确钟点时，表单应记录集合时间已明确'
  )

  const sameTimeContext = createPageContext(pageOptions[0])
  sameTimeContext.data.showMetrics = false
  sameTimeContext._startTouched = false
  sameTimeContext._endTouched = false
  const explicit = parseQrFields('集合时间：11月8日 08:00', now)
  sameTimeContext.data.form.startTime = explicit.startTime
  sameTimeContext.data.form.startTimeHasClock = false
  sameTimeContext.applyQrFields(explicit)
  assert.strictEqual(
    sameTimeContext.data.form.startTimeHasClock,
    true,
    '识别出的明确钟点与系统默认值相同时，也应记录具体时间已明确'
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
    startTimeHasClock: true,
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

function testActivityCardHidesUneditedCollectionClock() {
  const api = require(path.join(ROOT, 'services/api'))
  const startTime = new Date(2026, 10, 6, 8, 0, 0, 0).getTime()
  const endTime = new Date(2026, 10, 6, 18, 0, 0, 0).getTime()
  const activity = api.decorate({
    id: 'activity_time_hidden',
    type: 'hiking',
    types: ['hiking'],
    title: '周末徒步',
    startTime,
    startTimeHasClock: false,
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
    '11月06日 周五',
    '用户未明确具体时间时，活动卡片只展示集合日期'
  )
}

function testActivityCardTreatsMissingClockMarkerAsNotChosen() {
  const api = require(path.join(ROOT, 'services/api'))
  const startTime = new Date(2026, 10, 6, 8, 0, 0, 0).getTime()
  const activity = api.decorate({
    id: 'activity_time_missing_marker',
    type: 'hiking',
    types: ['hiking'],
    title: '旧活动',
    startTime,
    endTime: new Date(2026, 10, 6, 18, 0, 0, 0).getTime(),
    joinedCount: 0,
    maxPeople: 10,
    feeMode: 'aa',
    status: 'recruiting',
    auditStatus: 'approved',
    createTime: startTime - 86400000,
  })

  assert.strictEqual(
    activity.dateText,
    '11月06日 周五',
    '旧数据没有主动选择标记时，活动卡片也应只展示集合日期'
  )
}

function testDetailHidesUneditedCollectionClock() {
  const originalGetApp = global.getApp
  const originalGlobalWx = global.wx
  const startTime = new Date(2026, 10, 6, 8, 0, 0, 0).getTime()
  const context = createPageContext(detailPageOptions[0])
  context.loadComments = () => {}
  global.getApp = () => ({ globalData: { user: null } })
  global.wx = {
    cloud: {},
    setNavigationBarTitle() {},
  }

  try {
    context.applyActivity({
      id: 'activity_time_detail_hidden',
      type: 'hiking',
      types: ['hiking'],
      title: '周末徒步',
      bg: 'linear-gradient(#fff, #eee)',
      startTime,
      startTimeHasClock: false,
      endTime: new Date(2026, 10, 6, 18, 0, 0, 0).getTime(),
      joinedPeople: [],
      joinedCount: 0,
      maxPeople: 10,
      organizer: {
        nickName: '山野阿宽',
        avatarColor: '#4ECDC4',
        avatarText: '山',
      },
      feeMode: 'aa',
      status: 'recruiting',
      auditStatus: 'approved',
      createTime: Date.now(),
    })
  } finally {
    global.getApp = originalGetApp
    global.wx = originalGlobalWx
  }

  assert.strictEqual(
    context.data.activity.startLabel,
    '11月06日 周五',
    '用户未明确具体时间时，活动详情只展示集合日期'
  )
}

async function run() {
  testRejectsPastCollectionTimeToday()
  testCollectionTimeMustBeStrictlyAfterNow()
  testDateOnlyCollectionTimeDefaultsToEight()
  await testDateSelectionKeepsChosenClock()
  await testCalendarReportsWhetherTimeWasEdited()
  await testDateSelectionUsesRuleBasedDefaultClock()
  await testCalendarRejectsCollectionTimeNotAfterNow()
  await testReturnTimeMayEqualCollectionTime()
  testPublishOpensCalendarWithTimeAndCurrentThreshold()
  testActivityDateTimeFormatIncludesClock()
  testPublishLabelsShowSelectedClock()
  testPublishMarksClockOnlyAfterTimeEdit()
  await testEditFormRestoresWhetherClockWasExplicit()
  await testEditFormTreatsMissingClockMarkerAsNotChosen()
  testNewActivityDefaultsToMorningClock()
  testNewActivityDefaultsReturnToEveningClock()
  testNewActivityDefaultClockIsNotMarkedExplicit()
  testUntouchedReturnClockFollowsChangedCollectionDate()
  testQrCollectionTimeDefaultsUntouchedReturnToEighteen()
  testTodayDateOnlyCollectionTimeDefaultsToOneHourLater()
  testQrCollectionTimeTracksWhetherClockWasRecognized()
  testActivityCardUsesCollectionClock()
  testActivityCardHidesUneditedCollectionClock()
  testActivityCardTreatsMissingClockMarkerAsNotChosen()
  testDetailHidesUneditedCollectionClock()
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
