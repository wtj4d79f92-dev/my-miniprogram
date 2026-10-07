/**
 * 线性图标的公共外壳。
 *
 * 金刚区（utils/type-icons.js）与「我的」功能入口（utils/user-icons.js）共用这一份规格：
 * 统一 24×24 视窗、统一线宽、统一圆角端点、不填充。
 * 规格只留一处 —— 各画各的 buildIcon，两处的线宽迟早会分家，那正是「图标风格不统一」的来源。
 */

/** 描边色：与 --brand 一致。SVG 里读不到 CSS 变量，只能写死同一个值 */
const BRAND = '#00B578'
/** 破坏性操作（注销账号）的描边色，与 .entry-danger 的警示色一致 */
const DANGER = '#e5484d'
/** 统一线宽：所有图标共用 */
const STROKE_WIDTH = 1.6

/** 给形状套上统一的 svg 外壳，再转成可直接塞进 <image src> 的 data URI */
function lineIcon(body, color) {
  const svg =
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none"' +
    ` stroke="${color || BRAND}" stroke-width="${STROKE_WIDTH}" stroke-linecap="round" stroke-linejoin="round">` +
    body +
    '</svg>'
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`
}

module.exports = {
  lineIcon,
  LINE_ICON_BRAND: BRAND,
  LINE_ICON_DANGER: DANGER,
  LINE_ICON_STROKE_WIDTH: STROKE_WIDTH,
}
