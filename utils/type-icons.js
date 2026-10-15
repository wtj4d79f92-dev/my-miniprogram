/**
 * 玩法图标。
 *
 * 十个玩法现在全是位图吉祥物，登记在下面 ICON_IMAGES 里（类型 key → 代码包内路径），
 * 图形本身是 assets/type-icons/<key>.jpg，尺寸与压缩口径见该目录的 README。
 *
 * 页面只认 TYPE_GRID[i].icon 这一个字段（见 utils/dict.js），取图顺序是「有吉祥物位图就用位图，
 * 没有就退回 ICON_BODIES 里的线性图标」，所以下面两套来源都留着接口：
 *
 * 1) 位图吉祥物（现在十个都在用）：自带暖色底（不是透明抠图），所以在页面里是「铺满整格」而不是
 *    「格子中间放一小块」——页面按 TYPE_GRID 里的 iconFill 判断（见 utils/dict.js），格子那层极浅
 *    品牌底正好被图片完全盖住，两套图标混用期间不会出现「底色叠底色」。
 *
 * 2) 线性图标（ICON_BODIES，现在空着）：留着当回退位——某个玩法想改回线性图标，把形状写回去即可，
 *    页面那边不用动。这套线性图标当初是为了收掉 emoji：金刚区原来直接摆 emoji，扁平的和微拟物的
 *    混在一起，还只能靠「每格一个色块」去区分功能，十个格子十种底色，视觉噪声比信息量还大；换成
 *    线性图标后统一 24×24 视窗、统一描边粗细（1.6）、统一圆角端点、统一品牌色描边，区分功能只靠
 *    形状本身，底色交给页面统一给（见 pages/home/home.wxss 的 .type-icon）。SVG 源码写在文件里
 *    （可读、可改、diff 得清楚），运行时拼成 data URI 交给 <image>；不做成代码包里的 .svg 文件：
 *    小程序 <image> 对包内 svg 的支持各家机型不一致，data URI 走的是图片解码那条路，
 *    webview / skyline 都稳。视窗 / 线宽 / 圆角 / 描边这套外壳在 utils/line-icons.js，
 *    与「我的」入口图标共用。
 *
 * 位图放代码包内（assets/type-icons/）而不是云存储：金刚区在首屏就要出来，图标走网络会先空一格再跳出来，
 * 而海报那种「分享时才用到」的图才值得放云存储（见 utils/posters.js）。代价是开发者工具「代码质量」那条
 * IMAGE_AND_AUDIO_LIMIT 判的是**全包图片加总**不超过 200KB，所以每张压到 144×144 / JPEG / 7–9KB，
 * 十个换完 78KB，连同 logo 与分享图合计约 149KB，仍在预算内（scripts/validate.js 有一条把总量钉住的检查）。
 * 尺寸与压缩口径见 assets/type-icons/README.md。
 */

const { lineIcon, LINE_ICON_BRAND } = require('./line-icons')

/**
 * 线性图形的回退位：十个玩法都换成位图后这里是空的，但机制留着——某个类型想改回线性图标，
 * 把形状写回这里就行（原来的形状能在 git 历史里找到），页面与页面样式都不用动。
 * 这里只写形状，外层的 <svg> 标签、视窗与描边属性由 buildIcon 统一补齐，
 * 保证这批图标的视窗与线宽天然一致。
 */
const ICON_BODIES = {}

/**
 * 位图吉祥物：类型 key → 代码包内路径。这里只登记路径，图形本身是 assets/type-icons/<key>.jpg。
 * 换图直接覆盖同名文件，不用动代码；给别的类型也换上时，在这里加一行即可（跟 utils/posters.js 的
 * 「约定优于配置」是同一套思路，区别只是海报在云存储、图标在代码包里）。
 */
const ICON_IMAGES = {
  // 徒步：背着包、拄着登山杖的松鼠（原图 2048×2048，裁掉一圈留白后缩到 144×144）
  hiking: '/assets/type-icons/hiking.jpg',
  // 爬山：同一个吉祥物拄着登山杖踩上岩石坡
  climbing: '/assets/type-icons/climbing.jpg',
  // 自驾游：吉祥物开着小吉普，车斗里挂着背包、脚边是行李箱与地图
  driving: '/assets/type-icons/driving.jpg',
  // 露营：吉祥物坐在折叠椅上端着两只杯子，右边是帐篷，脚边是篝火与营灯
  camping: '/assets/type-icons/camping.jpg',
  // 骑行：吉祥物蹬着自行车，两只手扶着车把
  cycling: '/assets/type-icons/cycling.jpg',
  // 跑步：吉祥物在红色跑道上迈步疾跑
  running: '/assets/type-icons/running.jpg',
  // 打球：吉祥物手里托着网球，站在球场的绿场地上（右后方是球网）
  ball: '/assets/type-icons/ball.jpg',
  // 宠物会：吉祥物牵着一条小狗，右手抬起来打招呼
  pet: '/assets/type-icons/pet.jpg',
  // 游泳：吉祥物泡在水里划水前进，两只前爪划出水面，身后是翘起的大尾巴
  swimming: '/assets/type-icons/swimming.jpg',
  // 其他：吉祥物挥起右手打招呼，左手拄着两支登山杖，站在空旷的暖色底上
  other: '/assets/type-icons/other.jpg',
}

const TYPE_ICONS = {}
Object.keys(ICON_BODIES).forEach((key) => {
  TYPE_ICONS[key] = lineIcon(ICON_BODIES[key])
})

module.exports = {
  TYPE_ICONS,
  TYPE_ICON_IMAGES: ICON_IMAGES,
  TYPE_ICON_STROKE: LINE_ICON_BRAND,
}
