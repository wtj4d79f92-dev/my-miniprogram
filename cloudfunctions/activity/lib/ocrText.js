// 活动二维码图片文字识别（OCR）。
//
// 二维码本身只解出一条邀请链接，群公告 / 进群要求这类信息都在二维码旁边的文字里。
// 这里把图片上的文字提出来，供发布页填入「活动介绍」；识别只做建议：
// 没识别到文字、接口异常都返回结构化结论，发布照旧可以手动填写，不参与审核放行。
const cloud = require('wx-server-sdk')
const { withBudget } = require('./textCheck')
const { resolveMedia } = require('./media')

/** OCR 比解一个二维码慢，给一个稍宽的预算；超时按「没识别到」降级，不阻塞发布 */
const OCR_BUDGET_MS = 4000
/** OCR 原文回传上限：给页面解析群名 / 时间 / 强度留余量，活动介绍回填时再截到 500 字 */
const OCR_TEXT_LIMIT = 1200
/** 一张二维码截图上的文本块不会太多，防止异常返回把内存和回包撑大 */
const OCR_ITEM_LIMIT = 200
/** 同一行的判定容差（像素）：OCR 的 pos 会有几像素抖动 */
const ROW_TOLERANCE = 12

/**
 * 截图里一眼能认出的界面文案，不是活动内容。
 * 只过滤 UI 元素，像「该群已开启进群验证」「仅可通过邀请进入」这类群要求必须保留。
 */
const NOISE_PATTERNS = [
  /^(?:微信)?扫一扫$/,
  /^长按(?:识别|扫码)(?:二维码|图中二维码)?$/,
  /^识别图中二维码$/,
  /^识别二维码$/,
  /^保存(?:图片|到相册)$/,
  /^已保存(?:到相册|至相册)?$/,
  /^该二维码.*有效.*重新进入将更新$/,
  /^该二维码.*有效[，,。\s]*$/,
  // OCR 把「重新进入将更新」拆成两行时，上一行会停在「更」，整段过滤见 stripQrBoilerplate
  /^该二维码.*有效/,
  /^重新进入将更新$/,
  /^二维码已失效$/,
  /^(?:取消|关闭|返回|更多|分享)$/,
  /^[·•\-—_=]{2,}$/,
  /^[.。，,、；;：:！!？?…\s]+$/,
  /^(?:https?:\/\/|www\.)\S+$/i,
]

function now() {
  return Date.now()
}

/**
 * 二维码图片自带的模板文案：「该二维码 N 天内（某日前）有效，重新进入将更新」。
 * OCR 经常把它拆成两行（最后停在「更」、下一行「新」），所以先在整段文本上按跨行匹配删掉。
 */
function stripQrBoilerplate(value) {
  return String(value || '').replace(/该二维码[\s\S]{0,160}?重新进入将更\s*新/g, '')
}

/** 同一行被 OCR 拆成多块时拼回去：英文 / 数字之间补空格，中文直接相连 */
function joinPiece(prev, next) {
  if (!prev) return next
  if (/[A-Za-z0-9]$/.test(prev) && /^[A-Za-z0-9]/.test(next)) return `${prev} ${next}`
  return prev + next
}

/**
 * 按 pos 把 OCR 的文本块排成阅读顺序（从上到下、从左到右）。
 * 返回的是「行」而不是单个文本块，避免把一行字拆成好几行回填。
 */
function layout(items) {
  const list = (items || [])
    .slice(0, OCR_ITEM_LIMIT)
    .map((item) => {
      const pos = (item && item.pos) || {}
      const top = Number(pos.top)
      const left = Number(pos.left)
      return {
        text: String((item && item.text) || '').replace(/\s+/g, ' ').trim(),
        top,
        left,
        hasPos: Number.isFinite(top) && Number.isFinite(left),
      }
    })
    .filter((item) => item.text)

  if (!list.length) return []
  // 没有坐标时沿用接口顺序：排序反而可能把文字打乱
  if (!list.every((item) => item.hasPos)) return list.map((item) => item.text)

  list.sort((a, b) => (a.top === b.top ? a.left - b.left : a.top - b.top))
  const rows = []
  list.forEach((item) => {
    const row = rows[rows.length - 1]
    if (row && Math.abs(item.top - row.top) <= ROW_TOLERANCE) {
      row.text = joinPiece(row.text, item.text)
      return
    }
    rows.push({ top: item.top, text: item.text })
  })
  return rows.map((row) => row.text)
}

/** 去噪、去重、去掉空行，保留 OCR 原本的段落顺序 */
function cleanLines(lines) {
  const result = []
  stripQrBoilerplate((lines || []).join('\n'))
    .split('\n')
    .forEach((line) => {
      const value = String(line || '').replace(/\s+/g, ' ').trim()
      if (!value) return
      if (NOISE_PATTERNS.some((pattern) => pattern.test(value))) return
      if (result.indexOf(value) > -1) return
      result.push(value)
    })
  return result
}

/** 按行截断到活动介绍上限，避免把最后一行切成半句 */
function limitText(lines) {
  let text = ''
  for (let i = 0; i < lines.length; i += 1) {
    const next = text ? `${text}\n${lines[i]}` : lines[i]
    if (next.length > OCR_TEXT_LIMIT) {
      if (!text) text = lines[i].slice(0, OCR_TEXT_LIMIT)
      break
    }
    text = next
  }
  return text
}

function conclusion(status, text, message, reason) {
  return {
    status,
    ok: status === 'ok',
    text: text || '',
    length: (text || '').length,
    message,
    reason: reason || '',
    time: now(),
  }
}

/** 把云调用错误收敛成用户看得懂、且不暴露内部 rid 的提示 */
function failedConclusion(code, rawMessage) {
  const value = String(code || '')
  if (value === '101003') {
    return conclusion(
      'failed',
      '',
      '文字识别服务额度不足，可直接手写活动介绍',
      'quota'
    )
  }
  if (value === '48001') {
    return conclusion(
      'failed',
      '',
      '文字识别服务未授权，可直接手写活动介绍',
      'unauthorized'
    )
  }
  if (/timeout|超时/i.test(String(rawMessage || ''))) {
    return conclusion('failed', '', '文字识别超时，可直接手写活动介绍', 'timeout')
  }
  return conclusion('failed', '', '文字识别暂不可用，可直接手写活动介绍', 'failed')
}

/**
 * 识别二维码图片上的文字。
 * @param {string} fileID 云存储文件 ID（也兼容 https 地址）
 * @returns {Promise<Object>} { status: 'ok' | 'empty' | 'failed', ok, text, length, message, time }
 */
async function recognizeText(fileID) {
  const source = String(fileID || '')
  if (!source) return conclusion('empty', '', '没有可识别的图片')

  // 云调用只接受 http(s) 链接：云存储文件先换临时链接，本来就是 https 的图直接用
  let mediaUrl = source.indexOf('https://') === 0 ? source : ''
  if (!mediaUrl) {
    const media = await resolveMedia([source])
    mediaUrl = (media[source] && media[source].url) || ''
  }
  if (!mediaUrl) {
    return conclusion('failed', '', '图片读取失败，可直接手写活动介绍', 'media')
  }

  const result = await withBudget(
    async () => {
      try {
        const res = await cloud.openapi.ocr.printedText({ imgUrl: mediaUrl })
        const errcode = Number(res && (res.errCode !== undefined ? res.errCode : res.errcode))
        if (Number.isFinite(errcode) && errcode !== 0) {
          return { failed: true, code: String(errcode), message: `文字识别接口返回错误 ${errcode}` }
        }
        return { items: (res && (res.items || res.item_list)) || [] }
      } catch (err) {
        // 云调用失败时保留错误码，便于区分「权限未生效」「图片不可读」「接口超限」；
        // 具体错误只回给发布页做排查提示，不参与审核结论。
        const code = (err && (err.errCode || err.errcode)) || ''
        const message = String((err && (err.errMsg || err.message)) || '未知错误')
        console.error('[activity] 二维码 OCR 云调用失败', code, message, err)
        return { failed: true, code: String(code || ''), message }
      }
    },
    OCR_BUDGET_MS,
    () => ({ failed: true, code: 'timeout', message: '文字识别超时' })
  )

  if (result.failed) {
    console.error('[activity] 二维码文字识别失败', result.message)
    return failedConclusion(result.code, result.message)
  }

  const text = limitText(cleanLines(layout(result.items)))
  if (!text) return conclusion('empty', '', '这张图里没有识别到可用的文字')
  return conclusion('ok', text, '识别到图片文字')
}

module.exports = { recognizeText, cleanLines, layout, limitText, stripQrBoilerplate }
