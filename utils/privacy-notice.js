const { PRIVACY_AGREEMENT } = require('./agreements')
const { KEYS, getStorage, setStorage } = require('./storage')

const PRIVACY_POLICY_VERSION = PRIVACY_AGREEMENT.updatedAt

function userKey(user) {
  if (!user || !user.openid || !user.phone) return ''
  return String(user.userId || user.openid)
}

function readAcknowledgements() {
  const stored = getStorage(KEYS.privacyAck, {})
  return stored && typeof stored === 'object' && !Array.isArray(stored) ? stored : {}
}

/** 已登录且尚未确认当前政策版本时返回 true。 */
function needsPrivacyUpdate(user) {
  const key = userKey(user)
  return !!key && readAcknowledgements()[key] !== PRIVACY_POLICY_VERSION
}

/** 登录页勾选或老用户点“同意并继续”后，记录该用户已确认当前版本。 */
function acknowledgePrivacy(user) {
  const key = userKey(user)
  if (!key) return false
  const next = Object.assign({}, readAcknowledgements(), {
    [key]: PRIVACY_POLICY_VERSION,
  })
  return setStorage(KEYS.privacyAck, next)
}

/** 注销账号时清理该用户的版本记录，避免同一设备留下无用确认数据。 */
function forgetPrivacyAcknowledgement(user) {
  const key = userKey(user)
  if (!key) return false
  const current = readAcknowledgements()
  if (!Object.prototype.hasOwnProperty.call(current, key)) return true
  const next = Object.assign({}, current)
  delete next[key]
  return setStorage(KEYS.privacyAck, next)
}

module.exports = {
  PRIVACY_POLICY_VERSION,
  needsPrivacyUpdate,
  acknowledgePrivacy,
  forgetPrivacyAcknowledgement,
}
