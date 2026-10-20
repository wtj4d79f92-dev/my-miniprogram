const { TEXTS } = require('./dict')

/**
 * 小程序版本信息：随代码包发布，由开发者在上线新版本时手动维护。
 * 只需修改 APP_VERSION.number；应用名继续复用全局文案，避免两处不一致。
 */
const APP_VERSION = Object.freeze({
  name: TEXTS.appName,
  number: '1.6.0',
})

/** 统一版本展示格式，兼容版本号是否手工填写了前缀 v */
function formatVersion(version) {
  const item = version || {}
  const name = String(item.name || '').trim()
  const number = String(item.number || '')
    .trim()
    .replace(/^v/i, '')
  const numberText = number ? `v${number}` : ''
  return [name, numberText].filter(Boolean).join(' ')
}

const VERSION_TEXT = formatVersion(APP_VERSION)

module.exports = {
  APP_VERSION,
  VERSION_TEXT,
  formatVersion,
}
