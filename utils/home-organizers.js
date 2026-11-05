const HOME_ORGANIZER_LIMIT = 10
const HOME_ORGANIZER_ROW_SIZE = 5
const EMPTY_ORGANIZER_TEXT = '待入驻'
const EMPTY_ORGANIZER_COLOR = '#D8DEE5'

function emptySlot(index) {
  return {
    slot: index + 1,
    hostSlot: 0,
    occupied: false,
    nickName: EMPTY_ORGANIZER_TEXT,
    avatarUrl: '',
    avatarColor: EMPTY_ORGANIZER_COLOR,
    avatarText: '待',
  }
}

/**
 * 首页主办方坑位：后台按顺序配置用户 ID，接口补好公开头像昵称后交给这里排版。
 * 有效用户前移，避免后台中间留空导致某个已配置主办方被第二排隐藏规则吞掉。
 */
function buildHomeOrganizerSlots(organizers) {
  const occupied = (Array.isArray(organizers) ? organizers : [])
    .filter((item) => item && item.nickName)
    .slice(0, HOME_ORGANIZER_LIMIT)
    .map((item, index) => {
      const nickName = String(item.nickName || EMPTY_ORGANIZER_TEXT)
      return {
        slot: index + 1,
        hostSlot: Math.max(0, Number(item.slot) || index + 1),
        occupied: true,
        nickName,
        avatarUrl: String(item.avatarUrl || ''),
        avatarColor: String(item.avatarColor || '#4ECDC4'),
        avatarText: String(item.avatarText || nickName.slice(0, 1)),
      }
    })

  const visibleCount =
    occupied.length >= HOME_ORGANIZER_ROW_SIZE ? HOME_ORGANIZER_LIMIT : HOME_ORGANIZER_ROW_SIZE
  const slots = occupied.slice()
  for (let i = slots.length; i < visibleCount; i += 1) slots.push(emptySlot(i))
  return slots
}

module.exports = {
  HOME_ORGANIZER_LIMIT,
  HOME_ORGANIZER_ROW_SIZE,
  EMPTY_ORGANIZER_TEXT,
  EMPTY_ORGANIZER_COLOR,
  buildHomeOrganizerSlots,
}
