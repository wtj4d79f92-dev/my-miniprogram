/**
 * 导出提审用的演示活动数据（云开发控制台「导入」格式）。
 *
 * 用法：
 *   node scripts/seed-data.js
 *   node scripts/seed-data.js --qr=cloud://xxx --cover=cloud://xxx
 *   node scripts/seed-data.js --out=scripts/seed/activities.json
 *   （--qr / --cover 传云存储 fileID，可省略；--out 用来改输出路径）
 *
 * 产出：scripts/seed/activities.json —— JSON Lines（一个对象一行），
 * 打开云开发控制台 → 数据库 → activities 集合 → 导入 → 选这个文件即可。
 *
 * 数据口径来自 cloudfunctions/seed/lib/data.js，与 cloudfunctions/seed 云函数、
 * 以及 cloudfunctions/activity 的 normalizeForm 保持同一份字段定义（scripts/validate.js 有对账断言）。
 *
 * 注意：activities 有 7 天展示期（发布满 7 天自动关闭），导出的是「当前时间」的活动，
 * 建议提审前一两天导出并导入；审核拖得久就重新导出导入一次，或用 seed 云函数的 refresh。
 */
const fs = require('fs')
const path = require('path')

const ROOT = path.resolve(__dirname, '..')
const { buildDocs, summarize } = require(path.join(ROOT, 'cloudfunctions/seed/lib/data'))

/** 解析 --key=value 形式的参数 */
function parseArgs(argv) {
  const args = {}
  argv.slice(2).forEach((item) => {
    const matched = /^--([^=]+)=(.*)$/.exec(item)
    if (matched) args[matched[1]] = matched[2]
  })
  return args
}

function countText(map) {
  return Object.keys(map)
    .map((key) => `${key} ${map[key]}`)
    .join(' / ')
}

const args = parseArgs(process.argv)
const outFile = path.resolve(ROOT, args.out || 'scripts/seed/activities.json')
const docs = buildDocs(Date.now(), { cover: args.cover || '', qr: args.qr || '' })
const summary = summarize(docs)

fs.mkdirSync(path.dirname(outFile), { recursive: true })
fs.writeFileSync(outFile, `${docs.map((doc) => JSON.stringify(doc)).join('\n')}\n`, 'utf8')

console.log(`已导出 ${summary.total} 条演示活动 → ${path.relative(ROOT, outFile)}`)
console.log(`  城市：${countText(summary.byCity)}`)
console.log(`  类型：${countText(summary.byType)}`)
console.log(`  日期：${countText(summary.byDay)}`)
if (!args.qr) {
  console.log('  提示：未传 --qr，演示活动没有群二维码，详情页不会出现「查看二维码」入口')
}
console.log('')
console.log('下一步：')
console.log('  1. 云开发控制台 → 数据库 → activities 集合 → 导入 → 选上面这个文件（JSON Lines）')
console.log('  2. 导入时若有冲突处理选项就选「覆盖」；没有该选项就先删掉 demo_act_* 再导入')
console.log('  3. 导入完在首页 / 广场下拉刷新一次，确认能看到活动')
console.log('  4. 审核通过后清掉演示数据：seed 云函数的 {"action":"clear","confirm":"DELETE_DEMO"}')
