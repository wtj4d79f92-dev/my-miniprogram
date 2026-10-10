/**
 * 线路词库生成脚本：从《成都周边徒步登山线路表.xlsx》提取
 * 线路名称 / 星级 / 全长km / 爬升m，生成前端与云函数共用的词库文件。
 *
 * 用法：
 *   node scripts/extract-lines.js
 *   node scripts/extract-lines.js --xlsx=/path/to/成都周边徒步登山线路表.xlsx
 *   node scripts/extract-lines.js --print        # 顺带把每条线路的匹配中心词打到控制台
 *
 * 产出（都是生成物，改数据请改 xlsx 后重跑本脚本，不要手改）：
 *   utils/lines.js                        前端词库（发布页标题匹配用）
 *   cloudfunctions/activity/lib/lines.js  云函数词库（lines 集合为空时的兜底，也是导入源）
 *   scripts/seed/lines.json               JSON Lines：云开发控制台 → lines 集合 → 导入
 *
 * 表结构：《线路表》每 5 列是一组「级别 / 线路名称 / 全长km / 爬升m / 完成时间」，
 * 一共 8 组（低强度 / 中强度 / 高强度 / 超高难度各两组），级别就是星级（1–10 星）。
 * 解析 xlsx 用的是系统自带的 unzip + 最小 XML 解析，不引第三方依赖。
 */
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const { execFileSync } = require('child_process')

const ROOT = path.resolve(__dirname, '..')
const DEFAULT_XLSX = '/Users/a1-6/Downloads/成都周边徒步登山线路表.xlsx'

/* ------------------------------ 参数 ------------------------------ */

function parseArgs(argv) {
  const args = { xlsx: DEFAULT_XLSX, print: false }
  argv.slice(2).forEach((item) => {
    if (item === '--print') args.print = true
    const matched = /^--([^=]+)=(.*)$/.exec(item)
    if (matched && matched[1] === 'xlsx') args.xlsx = matched[2]
  })
  return args
}

/* --------------------------- xlsx 解析 --------------------------- */

/** 取 zip 里的一个成员（xlsx 就是 zip），交给系统 unzip，避免引依赖 */
function unzipEntry(xlsx, entry) {
  return execFileSync('unzip', ['-p', xlsx, entry], { maxBuffer: 64 * 1024 * 1024 }).toString('utf8')
}

function decodeEntities(value) {
  return String(value)
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (m, code) => String.fromCharCode(Number(code)))
    .replace(/&amp;/g, '&')
}

/** sharedStrings.xml：每个 <si> 里的所有 <t> 拼起来才是完整字符串（富文本会被拆成多个 <t>） */
function parseSharedStrings(xml) {
  const list = []
  const blocks = String(xml || '').match(/<si>[\s\S]*?<\/si>/g) || []
  blocks.forEach((block) => {
    const parts = block.match(/<t[^>]*>[\s\S]*?<\/t>/g) || []
    list.push(parts.map((part) => decodeEntities(part.replace(/^<t[^>]*>/, '').replace(/<\/t>$/, ''))).join(''))
  })
  return list
}

/** 列号 A→0、B→1、AA→26（线路表用不到那么远，但顺手写全） */
function columnIndex(ref) {
  const letters = String(ref || '').replace(/[^A-Z]/g, '')
  let index = 0
  for (let i = 0; i < letters.length; i += 1) {
    index = index * 26 + (letters.charCodeAt(i) - 64)
  }
  return index - 1
}

/** 把 sheet1.xml 解析成二维数组（行 / 列都是 0 基，空格子为 ''） */
function parseSheet(xml, shared) {
  const rows = []
  const rowBlocks = String(xml || '').match(/<row[^>]*>[\s\S]*?<\/row>/g) || []
  rowBlocks.forEach((rowBlock) => {
    const rowIndex = Number((/ r="(\d+)"/.exec(rowBlock) || [])[1] || 0) - 1
    const cells = []
    // 属性部分用惰性匹配：`<c r="E4" s="18"/>` 里的 `/` 不能被 [^>]* 吃掉，否则会和下一个格子粘成一个块
    const cellBlocks = rowBlock.match(/<c[^>]*?(?:\/>|>[\s\S]*?<\/c>)/g) || []
    cellBlocks.forEach((cellBlock) => {
      const ref = (/ r="([A-Z]+\d+)"/.exec(cellBlock) || [])[1] || ''
      const type = (/ t="([^"]+)"/.exec(cellBlock) || [])[1] || ''
      let value = ''
      if (type === 's') {
        const idx = Number((/<v>([\s\S]*?)<\/v>/.exec(cellBlock) || [])[1] || -1)
        value = shared[idx] === undefined ? '' : shared[idx]
      } else if (type === 'inlineStr') {
        const parts = cellBlock.match(/<t[^>]*>[\s\S]*?<\/t>/g) || []
        value = parts.map((part) => decodeEntities(part.replace(/^<t[^>]*>/, '').replace(/<\/t>$/, ''))).join('')
      } else {
        value = decodeEntities((/<v>([\s\S]*?)<\/v>/.exec(cellBlock) || [])[1] || '')
      }
      cells[columnIndex(ref)] = String(value).trim()
    })
    rows[rowIndex] = cells
  })
  return rows
}

/** 表头有 3 行（标题 / 强度分类 / 列名），数据从第 4 行开始 */
const HEADER_ROWS = 3
/** 每组 5 列：级别 / 线路名称 / 全长km / 爬升m / 完成时间 */
const GROUP_COLUMNS = 5
/** 一共 8 组 */
const GROUP_COUNT = 8

function parseLines(xlsx) {
  const shared = parseSharedStrings(unzipEntry(xlsx, 'xl/sharedStrings.xml'))
  const rows = parseSheet(unzipEntry(xlsx, 'xl/worksheets/sheet1.xml'), shared)
  const records = []
  rows.slice(HEADER_ROWS).forEach((row, rowOffset) => {
    const cells = row || []
    for (let group = 0; group < GROUP_COUNT; group += 1) {
      const base = group * GROUP_COLUMNS
      const starText = cells[base] || ''
      const name = cells[base + 1] || ''
      const distanceText = cells[base + 2] || ''
      const elevationText = cells[base + 3] || ''
      if (!name) continue
      records.push({
        sheetRow: rowOffset + HEADER_ROWS + 1,
        group: group + 1,
        starText,
        name,
        distanceText,
        elevationText,
      })
    }
  })
  return records
}

/* --------------------------- 字段清洗 --------------------------- */

/**
 * 取数字：「2300+」→ 2300，小数照收。
 * 「未知」「」这类原表里就没填的取值返回 null —— 提取不到就是空值，不用 0 占位
 * （0 公里、0 爬升在现实里不存在，拿它当哨兵会和真值混在一起）。
 */
function numberOf(text) {
  const matched = /(\d+(?:\.\d+)?)/.exec(String(text || ''))
  return matched ? Number(matched[1]) : null
}

/** 「7星」→ 7；认不出星级的行（脏数据）按 0 记，后续不再当难度用 */
function starsOf(text) {
  const matched = /(\d+)/.exec(String(text || ''))
  return matched ? Number(matched[1]) : 0
}

/** 只留中文：数字 / 字母 / 标点都是标题里的噪音，匹配时一律不看 */
function cleanText(value) {
  return String(value || '')
    .replace(/[^\u4e00-\u9fa5]/g, '')
}

/* --------------------------- 中心词提取 --------------------------- */

/** 出现在线路名开头的行政区 / 山名：去掉它之后剩下的才是这条线路的核心词 */
const REGION_WORDS = [
  '都江堰',
  '龙泉驿',
  '峨眉山',
  '四姑娘山',
  '汶川',
  '理县',
  '彭州',
  '崇州',
  '大邑',
  '邛崃',
  '小金',
  '茂县',
  '康定',
  '泸定',
  '松潘',
  '什邡',
  '绵阳',
  '金堂',
  '黑水',
  '乐山',
  '江油',
  '犍为',
  '布拖县',
  '昭觉县',
  '喜德',
  '冕宁',
  '凉经',
]

/** 这些地名本身就是徒步目的地，可以单独成一个匹配中心词（如「峨眉山」） */
const REGION_IS_PLACE = ['峨眉山']

/** 名字尾部的形态词：先去掉，剩下的才是地名 / 山峰名 */
const TRAILING_WORDS = [
  '单日加强版',
  '单日速穿',
  '两日连登',
  '加强版',
  '中位瀑布线',
  '高位线',
  '瀑布线',
  '速穿',
  '反穿',
  '穿越',
  '往返',
  '大环线',
  '小环线',
  '环线',
  '连登',
  '连穿',
  '单日',
  '多日',
  '两日',
  '三日',
  '全程',
  '公里',
  '东线',
  '西线',
  '南线',
  '北线',
  '中线',
]

/**
 * 连接词：把「峨眉山大沟穿万佛顶至金顶」拆成 峨眉山大沟 / 万佛顶 / 金顶 三段中心词。
 * 连字符也算连接词（原表里写过「万佛顶-金顶」），所以按原始文本拆、再逐段清洗。
 */
const CONNECT_RE = /穿越|连穿|速穿|反穿|连登|穿|至|到|[-—–~]/g
/** 坡向前缀：「南坡太子城」→ 太子城 */
const SLOPE_RE = /^(南坡|北坡|东坡|西坡)/
/** 山体 / 水系后缀：核心词里出现这些字时，把前面的部分也当成一个中心词（玉匹沟未央峰 → 玉匹沟） */
const CORE_SUFFIXES = ['沟', '山', '海子', '峰', '锅']
/** 核心词截出来的前缀至少 3 个字才收：「中山峰冰塔林」截出的「中山」太泛，宁可不要 */
const MIN_CORE_PREFIX = 3
/** 括号里只是说明性质的内容，不当中心词 */
const PAREN_STOP = ['多日', '两日', '三日', '单日', '非雪季', '近路', '非中转', '主峰', '加强版', '重装', '轻装']
/** 单独出现没有信息量的词，不能进词库 */
const STOP_KEYS = [
  '环线',
  '大环线',
  '小环线',
  '穿越',
  '速穿',
  '反穿',
  '连穿',
  '连登',
  '往返',
  '公里',
  '全程',
  '单日',
  '多日',
  '两日',
  '三日',
  '主峰',
  '加强版',
  '高位线',
  '瀑布线',
  '重装',
  '轻装',
  '近路',
  '非雪季',
  '非中转',
  // 「山洞」「大沟」这类通用词单拎出来会误伤（标题里写「探秘山洞」不该匹配到山里的穿越线），
  // 带前缀的「峨眉山大沟」还留着，够用
  '山洞',
  '大沟',
]

/** 反复剥掉尾部的形态词：「峨眉山环线公里」→「峨眉山」 */
function stripTrailing(text) {
  let value = String(text || '')
  let changed = true
  while (changed) {
    changed = false
    for (let i = 0; i < TRAILING_WORDS.length; i += 1) {
      const word = TRAILING_WORDS[i]
      if (value.length > word.length && value.slice(-word.length) === word) {
        value = value.slice(0, -word.length)
        changed = true
        break
      }
    }
  }
  return value
}

/** 「大邑大邑千佛山」这类重复前缀（原始表里手误）压成一次 */
function collapseRegion(text) {
  let value = String(text || '')
  for (let i = 0; i < REGION_WORDS.length; i += 1) {
    const region = REGION_WORDS[i]
    if (value.indexOf(region + region) === 0) {
      value = region + value.slice(region.length * 2)
    }
  }
  return value
}

function leadingRegion(text) {
  const value = String(text || '')
  const hit = REGION_WORDS.filter((word) => value.indexOf(word) === 0).sort((a, b) => b.length - a.length)[0]
  return hit || ''
}

/** 生成一条线路的所有匹配中心词：地名、山峰名、沟名，以及它们的组合 */
function buildKeys(name) {
  const keys = []
  const push = (value) => {
    const key = cleanText(value)
    if (key.length < 2) return
    if (STOP_KEYS.indexOf(key) > -1) return
    if (keys.indexOf(key) > -1) return
    keys.push(key)
  }

  /** 一段文本里能当中心词的部分：整段、去地名前缀后的核心词、核心词里的沟 / 山峰名 */
  const pushNames = (text) => {
    const base = collapseRegion(stripTrailing(cleanText(text)))
    if (!base) return
    const region = leadingRegion(base)
    const core = stripTrailing((region ? base.slice(region.length) : base).replace(SLOPE_RE, ''))

    push(base)
    push(core)
    // 只有本身是目的地（峨眉山）或整条线路就只有一个地名的，才把地名单独当中心词，
    // 否则「汶川」这类县名会把全县几十条线路都匹配出来，自动填的数据反而更不准
    if (region && (!core || REGION_IS_PLACE.indexOf(region) > -1)) push(region)

    CORE_SUFFIXES.forEach((word) => {
      for (let from = 0; from < core.length; from += 1) {
        const index = core.indexOf(word, from)
        if (index === -1) break
        const prefix = core.slice(0, index + word.length)
        if (prefix.length >= MIN_CORE_PREFIX && prefix.length < core.length) push(prefix)
        from = index
      }
    })
  }

  const variants = String(name || '')
    .split(/[/、]/)
    .map((item) => item.trim())
    .filter(Boolean)

  variants.forEach((variant) => {
    // 「彭州/都江堰赵九铁」里的「彭州」只是出发地选项，不是线路名，整段丢掉；
    // 留着的话标题里写个「彭州」就会把这几十条线路都匹配出来
    if (variants.length > 1 && REGION_WORDS.indexOf(cleanText(variant)) > -1) return

    const parens = []
    const trimmed = variant.replace(/[（(]([^（()）]*)[)）]/g, (match, inner) => {
      parens.push(inner)
      return ''
    })

    // 先按连接词拆段，每段各自取中心词：「万佛顶-金顶」是两段，不是「万佛顶金顶」一个词
    trimmed
      .split(CONNECT_RE)
      .map((part) => part.trim())
      .filter(Boolean)
      .forEach(pushNames)
    // 括号里的「仙人峰」「黄龙峰」「九海子」是真地名，单独收进来；「多日」「近路」这类说明丢掉
    parens.forEach((inner) => {
      const text = cleanText(inner)
      if (text && PAREN_STOP.indexOf(text) === -1) push(text)
    })
  })

  return keys
}

/* --------------------------- 组装词库 --------------------------- */

/**
 * 组装词库：线路名称 / 星级 / 全长 / 爬升 四项，任一提取不到的整条丢掉。
 *
 * 这四项就是自动填表单要用的数据，缺一项这条线路就没法用（原表里写「未知」的 4 条），
 * 留着要么填空值、要么补一个默认值，两种都是在替用户编数据，所以直接不入库。
 * id 按在原表里的序号给（丢掉的会留空号），线路增删不会让其余记录的 id 整体平移。
 */
function buildLibrary(records) {
  const dropped = []
  const library = []
  records.forEach((record, index) => {
    const stars = starsOf(record.starText)
    const distance = numberOf(record.distanceText)
    const elevation = numberOf(record.elevationText)
    const missing = []
    if (!record.name) missing.push('线路名称')
    if (!stars) missing.push('星级')
    if (distance === null) missing.push('全长')
    if (elevation === null) missing.push('爬升')
    if (missing.length) {
      dropped.push({ name: record.name || '（无名称）', row: record.sheetRow, missing })
      return
    }
    library.push({
      id: `line_${String(index + 1).padStart(3, '0')}`,
      name: record.name,
      stars,
      distance,
      elevation,
      keys: buildKeys(record.name),
    })
  })
  return { library, dropped }
}

/** 词库版本：内容哈希，数据一改就变，用来判断本地缓存 / 库里数据是否过期 */
function versionOf(library) {
  return crypto.createHash('sha1').update(JSON.stringify(library)).digest('hex').slice(0, 8)
}

/* --------------------------- 输出 --------------------------- */

function renderModule(library, version, sourceName) {
  const rows = library.map((item) => {
    const keys = item.keys.map((key) => `'${key}'`).join(', ')
    return (
      `  { id: '${item.id}', name: '${item.name}', stars: ${item.stars}, ` +
      `distance: ${item.distance}, elevation: ${item.elevation}, keys: [${keys}] },`
    )
  })
  return (
    '/**\n' +
    ' * 成都周边徒步登山线路词库（生成物，请勿手改）。\n' +
    ' *\n' +
    ` * 数据源：${sourceName}，共 ${library.length} 条线路。\n` +
    ' * 每条的 keys 是可用于标题模糊匹配的地名 / 山峰名中心词，由 scripts/extract-lines.js 提取。\n' +
    ' * 线路名称 / 星级 / 全长 / 爬升四项缺任何一项的线路（原表写「未知」的那几条）不入词库，\n' +
    ' * 所以这里的四项字段都是完整的，页面按它自动填，不需要空值兜底。\n' +
    ' *\n' +
    ' * 重新生成：node scripts/extract-lines.js\n' +
    ' */\n' +
    'const LINE_LIBRARY = [\n' +
    `${rows.join('\n')}\n` +
    ']\n\n' +
    '/** 词库版本（内容哈希）：数据改了版本就变，用于判断本地缓存是否要刷新 */\n' +
    `const LINE_LIBRARY_VERSION = '${version}'\n\n` +
    'module.exports = { LINE_LIBRARY, LINE_LIBRARY_VERSION }\n'
  )
}

function main() {
  const args = parseArgs(process.argv)
  if (!fs.existsSync(args.xlsx)) {
    console.error(`找不到线路表：${args.xlsx}`)
    console.error('用 --xlsx=/path/to/成都周边徒步登山线路表.xlsx 指定路径后重试')
    process.exitCode = 1
    return
  }

  const records = parseLines(args.xlsx)
  const { library, dropped } = buildLibrary(records)
  const noKeys = library.filter((item) => !item.keys.length)
  const version = versionOf(library)
  const sourceName = path.basename(args.xlsx)
  const moduleText = renderModule(library, version, sourceName)

  const targets = [
    path.join(ROOT, 'utils/lines.js'),
    path.join(ROOT, 'cloudfunctions/activity/lib/lines.js'),
    path.join(ROOT, 'cloudfunctions/admin/lib/lines.js'),
  ]
  targets.forEach((file) => fs.writeFileSync(file, moduleText, 'utf8'))
  fs.writeFileSync(
    path.join(ROOT, 'scripts/seed/lines.json'),
    `${library.map((item) => JSON.stringify(Object.assign({ _id: item.id }, item))).join('\n')}\n`,
    'utf8'
  )

  console.log(`已从 ${sourceName} 提取 ${library.length} 条线路 → 词库版本 ${version}`)
  console.log(`  星级：1–${Math.max.apply(null, library.map((item) => item.stars))} 星`)
  console.log(`  中心词：平均 ${(library.reduce((sum, item) => sum + item.keys.length, 0) / library.length).toFixed(1)} 个/条`)
  targets.forEach((file) => console.log(`  写入 ${path.relative(ROOT, file)}`))
  console.log(`  写入 ${path.relative(ROOT, path.join(ROOT, 'scripts/seed/lines.json'))}（云开发控制台导入 lines 集合用）`)
  if (dropped.length) {
    console.log(`  剔除字段缺失的线路 ${dropped.length} 条（原表第几行 / 缺什么）：`)
    dropped.forEach((item) => {
      console.log(`    - 原表第 ${item.row} 行「${item.name}」缺 ${item.missing.join('、')}`)
    })
  }
  if (noKeys.length) {
    console.log(`  ⚠️ 有 ${noKeys.length} 条线路没提出中心词，标题匹配不到：${noKeys.map((item) => item.name).join('、')}`)
  }

  if (args.print) {
    console.log('')
    library.forEach((item) => {
      console.log(`${item.stars}星 ${item.name}（${item.distance}km / ${item.elevation}m）→ ${item.keys.join(' / ')}`)
    })
  }
}

main()
