// 审核台媒体地址解析：把活动文档里的 cloud:// 文件 ID 换成可直接渲染的 https 临时链接。
//
// 为什么必须放在云函数里做：审核人是另一个微信号，客户端直接渲染发起人上传的 cloud://
// 文件 ID 时，结果完全取决于云存储的权限设置 / 安全规则。一旦被限制成「仅创建者可读」，
// 审核台就只会看到「封面加载失败」，而云函数用的是环境管理员身份，不受客户端存储权限约束，
// 所以由服务端统一换链接，前端拿到的就是另一个账号也能加载的 https 地址。
const cloud = require('wx-server-sdk')

/** getTempFileURL 单次最多 50 个文件，刚好覆盖一页审核列表 */
const BATCH_LIMIT = 50

/**
 * 收集一批活动文档里需要展示的云存储文件：封面、群二维码、机器初审缩略图。
 * 按出现顺序去重并截断，返回真正要解析的 fileID 列表。
 */
function collectFileIDs(items) {
  const ids = []
  const push = (value) => {
    const fileID = String(value || '')
    if (fileID.indexOf('cloud://') !== 0) return
    if (ids.indexOf(fileID) > -1) return
    if (ids.length >= BATCH_LIMIT) return
    ids.push(fileID)
  }
  ;(items || []).forEach((item) => {
    if (!item) return
    push(item.cover)
    push(item.groupQrCode)
    const images = (item.machineCheck && item.machineCheck.images) || []
    images.forEach((image) => push(image && image.fileID))
  })
  return ids
}

/** 单个文件的失败原因：优先用云存储返回的 errMsg，拿不到时给一句通用说明 */
function describe(entry, fileID) {
  if (!entry) return '云存储没有返回这个文件'
  const message = String(entry.errMsg || entry.errmsg || '').trim()
  if (message) return message.replace(/^cloud\.getTempFileURL:fail\s*/i, '')
  if (Number(entry.status) !== 0) return `云存储拒绝访问或文件不存在（status=${entry.status}）`
  return `未能取到临时链接（${String(fileID).slice(-24)}）`
}

/**
 * 批量换成临时链接。
 * @param {string[]} fileIDs
 * @returns {Promise<Object>} { [fileID]: { url, ok, reason } }
 *   ok=false 只代表「服务端也拿不到」，前端据此给出更准确的提示；
 *   接口整体异常时也走 ok=false，但前端仍会退回原始 fileID 再试一次，不阻断审核。
 */
async function resolveMedia(fileIDs) {
  const targets = []
  ;(fileIDs || []).forEach((value) => {
    const fileID = String(value || '')
    if (fileID.indexOf('cloud://') !== 0) return
    if (targets.indexOf(fileID) > -1) return
    if (targets.length >= BATCH_LIMIT) return
    targets.push(fileID)
  })

  const map = {}
  if (!targets.length) return map

  let fileList = []
  try {
    const res = await cloud.getTempFileURL({ fileList: targets })
    fileList = (res && res.fileList) || []
  } catch (e) {
    console.error('[admin] 云存储临时链接获取失败，前端将退回原始 fileID 渲染', e)
    targets.forEach((fileID) => {
      map[fileID] = { url: '', ok: false, reason: '云存储接口异常，未能换取临时链接' }
    })
    return map
  }

  const byFileID = {}
  fileList.forEach((entry) => {
    if (entry && entry.fileID) byFileID[entry.fileID] = entry
  })
  targets.forEach((fileID) => {
    const entry = byFileID[fileID]
    const url = (entry && (entry.tempFileURL || entry.tempFileUrl || entry.download_url)) || ''
    map[fileID] = url
      ? { url, ok: true, reason: '' }
      : { url: '', ok: false, reason: describe(entry, fileID) }
  })
  return map
}

module.exports = { BATCH_LIMIT, collectFileIDs, resolveMedia }
