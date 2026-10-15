// 活动分享海报：按活动类型从云存储取图。
//
// 为什么不把海报打进代码包（原来的做法）：
// 1. 开发者工具「代码质量」里那条 IMAGE_AND_AUDIO_LIMIT 是把包内所有图片/音频的大小**加总**
//    再和 200KB 比，不是单张比 —— 十来个类型各一张海报，怎么压都会红；
// 2. 主包还有 2MB 硬上限，海报一张一张加迟早顶到；
// 3. 放云存储后换图不用重新发版：覆盖同名文件即可，fileID 不变。
//
// 取图链路：类型 key → 云存储路径 posters/<key>.jpg → wx.cloud.downloadFile 拿本地临时文件。
// 下载成临时文件而不是直接用 https 链接：分享卡片的 imageUrl 只认本地路径或可访问的网络图，
// 而本地临时路径三个出口都吃 —— 好友卡片、朋友圈卡片、长图 canvas。
//
// 约定优于配置：`posters/<类型key>.jpg` 传上去就生效，加类型不用改这个文件。
// ALIAS 只处理「一份图给多个类型共用」，FALLBACK_KEY 是还没有专属海报的类型用的兜底图。

const { TYPE_MAP } = require('./dict')

/**
 * 海报所在云存储目录的 fileID 前缀（fileID = cloud://<环境>.<存储桶>/<路径>）。
 * 换云环境时这一串要跟着改；路径部分按类型拼，所以同类型换图只要覆盖同名文件。
 */
const POSTER_PREFIX =
  'cloud://cloud1-d2gcrlr5qbe1d05d4.636c-cloud1-d2gcrlr5qbe1d05d4-1489283260/posters/'

/**
 * 类型 → 海报文件名标识；没列在这里的类型用自己的 key 去找同名文件。
 * - 爬山与徒步共用同一张（都是山野徒步主题）
 * - 其他与宠物会共用同一张（「其他」是兜底的杂类，没有专属图，沿用原来那张聚会风的）
 */
const ALIAS = {
  climbing: 'hiking',
  other: 'pet',
}

/**
 * 兜底海报：还没出专属海报的类型先共用这一张（跑步、游泳暂时是它）。
 * 分享卡片是平台门面，不能回落到发起人上传的封面 —— 用户拍的营地照、山景照各不相同。
 */
const FALLBACK_KEY = 'hiking'

/** 解析结果缓存：类型 key → 本地临时路径（空串表示连兜底海报也没取到） */
const resolved = {}
/** 同一个类型并发请求只下载一次 */
const pending = {}

/** 未知类型按「其他」处理，与 utils/dict.js 的 getType 保持一致 */
function normalize(type) {
  const key = String(type || '')
  return TYPE_MAP[key] ? key : 'other'
}

function fileIDOf(key) {
  return `${POSTER_PREFIX}${ALIAS[key] || key}.jpg`
}

/** 下载到本地临时文件；失败按「这张图取不到」处理，不向调用方抛错 */
function download(key) {
  return new Promise((resolve) => {
    // Mock 模式 / 未初始化云开发时没有 wx.cloud，直接按没有海报处理
    if (!wx.cloud || typeof wx.cloud.downloadFile !== 'function') {
      resolve('')
      return
    }
    wx.cloud.downloadFile({
      fileID: fileIDOf(key),
      success: (res) => resolve((res && res.tempFilePath) || ''),
      fail: () => resolve(''),
    })
  })
}

/** 取某个类型的海报：先试它自己的，没有再退到兜底那张 */
function load(key) {
  return download(key).then((path) => {
    if (path) return path
    if (key === FALLBACK_KEY) return ''
    return posterFor(FALLBACK_KEY)
  })
}

/**
 * 解析某个活动类型要用的海报，返回可直接绘制 / 分享的本地临时路径；都没有时返回空串。
 * 结果（含「没有」）会在内存里缓存，页面重复调用不会反复下载。
 */
function posterFor(type) {
  const key = normalize(type)
  if (resolved[key] !== undefined) return Promise.resolve(resolved[key])
  if (pending[key]) return pending[key]
  pending[key] = load(key)
    .then((path) => {
      resolved[key] = path
      delete pending[key]
      return path
    })
    .catch(() => {
      resolved[key] = ''
      delete pending[key]
      return ''
    })
  return pending[key]
}

/**
 * 同步取「已经解析过」的结果，专供 onShareAppMessage / onShareTimeline 这类同步回调用。
 * 详情页拿到活动类型后会先预热一次 posterFor，用户真去点分享时这里就能同步拿到。
 */
function cachedPoster(type) {
  return resolved[normalize(type)] || ''
}

module.exports = {
  posterFor,
  cachedPoster,
  ALIAS,
  FALLBACK_KEY,
  POSTER_PREFIX,
}
