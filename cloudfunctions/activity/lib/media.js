// 云存储媒体处理：发布前的文件校验 + 列表展示用的临时链接解析。
//
// 客户端上传封面 / 群二维码后，落库的是 cloud:// 文件 ID。如果这个文件在云函数所在环境里
// 并不存在（上传到了别的环境、上传中断、文件已被删除），活动照样能提交成功，但审核人和
// 其他用户永远看不到图，只能等到人工审核时才发现。这里在写库前用管理员身份换一次临时链接：
// 明确「文件不存在」就拦下发布并提示重新上传，接口本身异常一律放行 —— 不能因为云存储抖动
// 让用户发不出活动（与内容安全检测的处理原则一致）。
//
// 客户端渲染 cloud:// 文件受云存储读取权限 / 安全规则约束；活动卡片、详情、海报对「别人发的
// 活动」都可能读不到图，所以列表接口同样用管理员身份把封面换成 https 临时链接再下发。
const cloud = require('wx-server-sdk')

const OK = 'ok'
const MISSING = 'missing'
const UNKNOWN = 'unknown'

/** getTempFileURL 单次最多 50 个文件，一页列表的封面绰绰有余 */
const BATCH_LIMIT = 50

/** 判定「文件不存在」的返回文案特征，其余情况按未知处理 */
const MISSING_PATTERN = /not\s*exist|no\s*such|不存在|invalid file|文件错误|-50100[0-9]/i

/** 上传刚落库就换链接，偶发的一致性延迟用一次重试兜住 */
const RETRY_DELAY_MS = 400

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** 把一次 getTempFileURL 的结果折算成 ok / missing / unknown */
function judge(entry) {
  if (!entry) return UNKNOWN
  const url = entry.tempFileURL || entry.tempFileUrl || entry.download_url || ''
  if (url) return OK
  const message = String(entry.errMsg || entry.errmsg || '')
  if (MISSING_PATTERN.test(message)) return MISSING
  const status = Number(entry.status)
  if (Number.isFinite(status) && status !== 0) return MISSING
  return UNKNOWN
}

/** 查询一批文件的可读性，返回 { [fileID]: 'ok' | 'missing' | 'unknown' } */
async function inspectFiles(fileIDs) {
  const targets = (fileIDs || []).filter((value) => String(value || '').indexOf('cloud://') === 0)
  const states = {}
  if (!targets.length) return states

  const query = async (ids) => {
    try {
      const res = await cloud.getTempFileURL({ fileList: ids })
      const byFileID = {}
      ;((res && res.fileList) || []).forEach((entry) => {
        if (entry && entry.fileID) byFileID[entry.fileID] = entry
      })
      ids.forEach((fileID) => {
        states[fileID] = judge(byFileID[fileID])
      })
    } catch (e) {
      console.error('[activity] 云存储文件校验失败，按未知处理不阻塞发布', e)
      ids.forEach((fileID) => {
        if (!states[fileID]) states[fileID] = UNKNOWN
      })
    }
  }

  await query(targets)
  const missing = targets.filter((fileID) => states[fileID] === MISSING)
  if (missing.length) {
    await delay(RETRY_DELAY_MS)
    await query(missing)
  }
  return states
}

/**
 * 收集一批活动文档里需要在列表 / 详情展示的云存储文件：封面与群二维码。
 * 按出现顺序去重并截断，返回真正要解析的 fileID 列表。
 */
function collectFileIDs(items, fields) {
  const keys = fields || ['cover']
  const ids = []
  ;(items || []).forEach((item) => {
    if (!item) return
    keys.forEach((key) => {
      const fileID = String(item[key] || '')
      if (fileID.indexOf('cloud://') !== 0) return
      if (ids.indexOf(fileID) > -1) return
      if (ids.length >= BATCH_LIMIT) return
      ids.push(fileID)
    })
  })
  return ids
}

/**
 * 批量换成临时链接（管理员身份，不受客户端存储权限限制）。
 * @returns {Promise<Object>} { [fileID]: { url, ok, reason } }
 *   接口整体异常时全部返回 ok=false，前端退回原始 fileID 渲染，不阻断列表展示。
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
    console.error('[activity] 云存储临时链接获取失败，前端将退回原始 fileID 渲染', e)
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
      : { url: '', ok: false, reason: String((entry && (entry.errMsg || entry.errmsg)) || '文件不存在或无权读取') }
  })
  return map
}

module.exports = { OK, MISSING, UNKNOWN, BATCH_LIMIT, inspectFiles, collectFileIDs, resolveMedia }
