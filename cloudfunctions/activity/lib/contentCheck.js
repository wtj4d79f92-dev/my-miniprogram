// 内容安全检测：文本走同步的 msgSecCheck，图片走异步的 mediaCheckAsync
//
// 设计原则：检测接口本身出错（未开通 / 超额度 / 用户 openid 不满足条件 / 网络抖动）时
// 一律降级为「纯人工审核」，绝不能让内容安全把用户发布卡死。
// 图片检测只有 traceId，最终结论由消息推送回调（cloudfunctions/contentCheck）补写。
const cloud = require('wx-server-sdk')

/** msgSecCheck v2 单次送检的文本长度上限 */
const MAX_TEXT = 2500
/** 场景值：1 资料 / 2 评论 / 3 论坛 / 4 社交日志，活动发布用社交日志 */
const SCENE = 4
/** mediaCheckAsync 媒体类型：1 音频 / 2 图片 */
const MEDIA_IMAGE = 2

const PASS = 'pass'
const REVIEW = 'review'
const RISKY = 'risky'
/** 图片检测已发起、结果未回 */
const PENDING = 'pending'

/**
 * 单个检测步骤的时间预算。
 * 云函数本身也有超时（控制台里配的秒数），内容安全接口变慢时不能拖着用户发布失败，
 * 超过预算就按「降级为人工审核」处理。
 */
const TEXT_BUDGET_MS = 1200
const IMAGE_BUDGET_MS = 1200

function now() {
  return Date.now()
}

/** 给异步步骤套时间预算：超时或抛错都回落到 fallback，不阻塞主流程 */
function withBudget(task, ms, fallback) {
  return new Promise((resolve) => {
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      console.error(`[contentCheck] 检测步骤超过 ${ms}ms 预算，降级为人工审核`)
      resolve(fallback())
    }, ms)
    task()
      .then((value) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve(value)
      })
      .catch((e) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        console.error('[contentCheck] 检测步骤失败，降级为人工审核', e)
        resolve(fallback())
      })
  })
}

/** 接口返回统一收敛：拿不到字段时按「通过」处理，避免误拦 */
function normalizeResult(res) {
  const result = (res && res.result) || {}
  const suggest = result.suggest === RISKY || result.suggest === REVIEW ? result.suggest : PASS
  return {
    suggest,
    label: Number(result.label) || 0,
    traceId: (res && (res.traceId || res.trace_id)) || '',
    time: now(),
  }
}

/**
 * 文本检测（同步）。
 * @returns { suggest, label, traceId, time, failed } failed=true 表示接口没跑通、结果不可信
 */
async function checkText(content, openid) {
  const value = String(content || '').trim()
  if (!value) return { suggest: PASS, label: 0, traceId: '', time: now(), failed: false }
  const fallback = () => ({ suggest: PASS, label: 0, traceId: '', time: now(), failed: true })
  return withBudget(async () => {
    const res = await cloud.openapi.security.msgSecCheck({
      content: value.slice(0, MAX_TEXT),
      version: 2,
      scene: SCENE,
      openid,
    })
    return Object.assign(normalizeResult(res), { failed: false })
  }, TEXT_BUDGET_MS, fallback)
}

/** 取云存储文件的临时可访问地址：mediaCheckAsync 只接受 http(s) 链接，不接受 cloud:// */
async function tempUrlOf(fileID) {
  const res = await cloud.getTempFileURL({ fileList: [fileID] })
  const first = ((res && res.fileList) || [])[0] || {}
  return first.tempFileURL || first.tempFileUrl || first.download_url || ''
}

/**
 * 图片检测（异步发起）。
 * 串行发起，避免一次发布把接口并发打满；单张失败只跳过这张，不影响发布。
 * @returns [{ fileID, traceId, suggest: 'pending', label, time }]
 */
async function dispatchImages(fileIDs, openid) {
  const targets = (fileIDs || []).filter(
    (item) => typeof item === 'string' && item.indexOf('cloud://') === 0
  )
  if (!targets.length) return []
  return withBudget(() => dispatchEach(targets, openid), IMAGE_BUDGET_MS, () => [])
}

async function dispatchEach(targets, openid) {
  const results = []
  for (let i = 0; i < targets.length; i += 1) {
    try {
      const mediaUrl = await tempUrlOf(targets[i])
      if (!mediaUrl) continue
      const res = await cloud.openapi.security.mediaCheckAsync({
        mediaUrl,
        mediaType: MEDIA_IMAGE,
        version: 2,
        scene: SCENE,
        openid,
      })
      const traceId = (res && (res.traceId || res.trace_id)) || ''
      if (!traceId) continue
      results.push({ fileID: targets[i], traceId, suggest: PENDING, label: 0, time: now() })
    } catch (e) {
      console.error('[contentCheck] 图片检测发起失败，该图转为人工审核', e)
    }
  }
  return results
}

/**
 * 汇总机器结论，供待审队列做优先级排序：
 * machineReview 需要人工重点看，machinePending 表示图片结论还没回来。
 */
function summarize(text, images) {
  const list = images || []
  return {
    machineReview: (text && text.suggest === REVIEW) || list.some((item) => item.suggest === REVIEW),
    machinePending: list.some((item) => item.suggest === PENDING),
  }
}

module.exports = {
  MAX_TEXT,
  SCENE,
  PASS,
  REVIEW,
  RISKY,
  PENDING,
  checkText,
  dispatchImages,
  summarize,
}
