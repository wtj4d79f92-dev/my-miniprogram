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
  MARQUEE_ICON,
}
