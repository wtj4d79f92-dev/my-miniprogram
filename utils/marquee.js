const { lineIcon } = require('./line-icons')

/**
 * 首页跑马灯支持单个字符串或字符串数组：
 * - 便于只放一条文案时直接写字符串；
 * - 多条时按配置顺序上下轮播；
 * - 空值会被过滤，避免出现空白跑马灯。
 */
function normalizeMarqueeTexts(input) {
  const items = Array.isArray(input) ? input : [input]
  return items
    .map((item) => (typeof item === 'string' ? item.trim() : ''))
    .filter(Boolean)
}

/** 长文案滚动速度约 31px/s，完整露出后再停留 1 秒才切换下一条。 */
const MARQUEE_SCROLL_MS_PER_PX = 32
const MARQUEE_MIN_SCROLL_MS = 2200
const MARQUEE_SCROLL_HOLD_MS = 1000
const MARQUEE_STATIC_MS = 2600
const MARQUEE_END_GAP_PX = 16

/** 默认宽度只用于首帧，onReady 测量真实宽度后会立即覆盖。 */
function estimateMarqueeTextWidth(text) {
  return Array.from(text).reduce(
    (width, char) => width + (/[\u0000-\u00ff]/.test(char) ? 7 : 14),
    0
  )
}

/**
 * 根据文字窗口和每条文案的实际宽度，生成适合 swiper 的展示状态。
 * 短文案停留；长文案先横向滚过超出部分，再留一小段间隔后切换。
 */
function buildMarqueeItems(texts, viewportWidth, textWidths) {
  const safeViewportWidth = Number.isFinite(viewportWidth) && viewportWidth > 0 ? viewportWidth : 180
  const measuredWidths = Array.isArray(textWidths) ? textWidths : []
  return (texts || []).map((text, index) => {
    const measuredWidth = Number(measuredWidths[index])
    const textWidth =
      Number.isFinite(measuredWidth) && measuredWidth > 0
        ? measuredWidth
        : estimateMarqueeTextWidth(text)
    const scrollDistance = Math.ceil(textWidth + MARQUEE_END_GAP_PX - safeViewportWidth)
    if (scrollDistance <= 0) {
      return {
        text,
        scrolling: false,
        durationMs: MARQUEE_STATIC_MS,
        style: '',
      }
    }
    const scrollDurationMs = Math.max(
      MARQUEE_MIN_SCROLL_MS,
      Math.ceil(scrollDistance * MARQUEE_SCROLL_MS_PER_PX)
    )
    return {
      text,
      scrolling: true,
      durationMs: scrollDurationMs + MARQUEE_SCROLL_HOLD_MS,
      style: `--home-marquee-distance: -${scrollDistance}px; animation-duration: ${scrollDurationMs}ms;`,
    }
  })
}

/**
 * 与「我的」功能入口共用 lineIcon 的 24×24 视窗、1.6 线宽与品牌绿，
 * 只是图形换成首页公告使用的喇叭。
 */
const MARQUEE_ICON = lineIcon(
  '<path d="M8.3 8.7 L17.8 4.8 L17.8 19.2 L8.3 15.3 Z"/>' +
    '<path d="M8.3 8.7 L5.8 8.7 C4.8 8.7 4 9.5 4 10.5 L4 13.5 C4 14.5 4.8 15.3 5.8 15.3 L8.3 15.3"/>' +
    '<path d="M9.4 15.7 L10.2 20.1"/>' +
    '<path d="M19.5 9.5 C20.4 10.9 20.4 13.1 19.5 14.5"/>'
)

module.exports = {
  normalizeMarqueeTexts,
  buildMarqueeItems,
  MARQUEE_ICON,
}
