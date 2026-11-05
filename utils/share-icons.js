/**
 * 活动详情分享面板图标。
 *
 * 分享入口原来直接使用 emoji，和「我的」入口、功能操作用 icon 的线性风格不一致。
 * 这里继续复用 utils/line-icons.js 的统一外壳，页面只消费生成好的 data URI。
 */

const { lineIcon } = require('./line-icons')

const ICON_BODIES = {
  // 微信好友：一大一小两个人像，表达把活动发给朋友
  friend:
    '<circle cx="9" cy="8" r="3.1"/>' +
    '<path d="M3.7 19.1 C4 15.7 6.1 13.7 9 13.7 C11.9 13.7 14 15.7 14.3 19.1"/>' +
    '<circle cx="17" cy="9.2" r="2.3"/>' +
    '<path d="M15.4 14.1 C17.8 13.9 19.6 15.7 20 18.6"/>',

  // 朋友圈：三个节点连成社交圈，和单个人像的「好友」入口区分开
  timeline:
    '<circle cx="7" cy="8" r="2.1"/>' +
    '<circle cx="17" cy="8" r="2.1"/>' +
    '<circle cx="12" cy="16.8" r="2.1"/>' +
    '<path d="M9.1 8 L14.9 8"/>' +
    '<path d="M8.2 9.9 L10.8 14.8"/>' +
    '<path d="M15.8 9.9 L13.2 14.8"/>',

  // 生成分享图片：相框 + 山景 + 右上角闪光
  poster:
    '<rect x="3.8" y="5" width="16.4" height="15" rx="2.2"/>' +
    '<circle cx="8.3" cy="9.3" r="1.3"/>' +
    '<path d="M5.4 16.8 L9.6 12.8 L12.1 15.1 L14.6 12.7 L18.6 16.8"/>' +
    '<path d="M18.7 2.7 L19.1 3.9 L20.3 4.3 L19.1 4.7 L18.7 5.9 L18.3 4.7 L17.1 4.3 L18.3 3.9 Z"/>',
}

const SHARE_ICONS = {}
Object.keys(ICON_BODIES).forEach((key) => {
  SHARE_ICONS[key] = lineIcon(ICON_BODIES[key])
})

module.exports = {
  SHARE_ICONS,
}
