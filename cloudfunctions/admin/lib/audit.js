// 活动审核状态：与 activity 云函数 lib/audit.js、前端 utils/audit.js 的取值保持一致
const PENDING = 'pending'
const APPROVED = 'approved'
const REJECTED = 'rejected'

const ALL_STATUS = [PENDING, APPROVED, REJECTED]

/**
 * 历史数据没有 auditStatus 字段（审核能力上线前发布的活动），一律按「已通过」处理。
 * 管理端「已通过」页签用同一个条件，保证与小程序里能看到的范围完全一致。
 */
function approvedWhere(command) {
  return command.nin([PENDING, REJECTED])
}

function auditStatusOf(doc) {
  const status = (doc && doc.auditStatus) || ''
  return status === PENDING || status === REJECTED ? status : APPROVED
}

module.exports = { PENDING, APPROVED, REJECTED, ALL_STATUS, approvedWhere, auditStatusOf }
