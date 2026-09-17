// 文本内容安全检测（msgSecCheck v2）：同步接口，一次调用就出结论，同时提供检测步骤的时间预算工具。
//
// 机审三类检测里，文本走这里（同步），图片走 mediaCheckAsync（异步，结论靠消息推送回调），
// 群二维码走 img.scanQRCode（同步）。
//
// 本文件与 cloudfunctions/contentCheck/lib/textCheck.js 内容保持一致（两份镜像必须同时改）：
// - activity 云函数在发布 / 编辑当刻送检文本；
// - contentCheck 云函数在图片结论回来、而文本当时没拿到可信结论时补检一次，
//   否则「发布当刻一次超时」会让活动永远停在待审队列，而审核台上文本那行还显示「机器通过」。
//
// 设计原则：接口本身出错（未开通 / 超额度 / 用户 openid 不满足条件 / 网络抖动）时一律返回
// failed: true 表示「没有可信结论」，调用方据此降级为人工审核 —— 绝不能把「没结论」当成通过。
const cloud = require('wx-server-sdk')

/** msgSecCheck v2 单次送检的文本长度上限 */
const MAX_TEXT = 2500
/** 场景值：1 资料 / 2 评论 / 3 论坛 / 4 社交日志，活动发布用社交日志 */
const SCENE = 4
/** 文本检测的时间预算：接口变慢时不能拖着用户发布，超过就按「降级为人工审核」处理 */
const TEXT_BUDGET_MS = 1500

const PASS = 'pass'
const REVIEW = 'review'
const RISKY = 'risky'

function now() {
  return Date.now()
}

/** 送检文本：标题、集合地点、活动介绍拼一段（补检时也用它，保证两次送检的文本一致） */
function textOf(source) {
  const fields = source || {}
  return [fields.title, fields.location, fields.desc].filter(Boolean).join('\n')
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

/**
 * 接口返回统一收敛。
 * 只有真的带回 suggest 才算拿到结论；没有 suggest 说明这次调用没给出结论，
 * 按 failed 处理交给人工，不能当成通过（否则接口异常会悄悄把内容放上线）。
 */
function normalizeResult(res) {
  const result = (res && res.result) || {}
  const suggested =
    result.suggest === RISKY || result.suggest === REVIEW || result.suggest === PASS ? result.suggest : ''
  return {
    suggest: suggested || PASS,
    label: Number(result.label) || 0,
    traceId: (res && (res.traceId || res.trace_id)) || '',
    time: now(),
    failed: !suggested,
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
  return withBudget(
    async () => {
      const res = await cloud.openapi.security.msgSecCheck({
        content: value.slice(0, MAX_TEXT),
        version: 2,
        scene: SCENE,
        openid,
      })
      return normalizeResult(res)
    },
    TEXT_BUDGET_MS,
    fallback
  )
}

module.exports = {
  MAX_TEXT,
  SCENE,
  TEXT_BUDGET_MS,
  PASS,
  REVIEW,
  RISKY,
  now,
  textOf,
  withBudget,
  checkText,
}
