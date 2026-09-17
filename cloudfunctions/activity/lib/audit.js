// 活动审核状态：与前端 utils/audit.js 的取值保持一致
// pending 审核中 / approved 已通过 / rejected 未通过
const PENDING = 'pending'
const APPROVED = 'approved'
const REJECTED = 'rejected'

/**
 * 历史数据没有 auditStatus 字段（审核能力上线前发布的活动），
 * 一律按「已通过」处理，避免上线后旧活动从首页与广场集体消失。
 */
function auditStatusOf(doc) {
  const status = (doc && doc.auditStatus) || ''
  return status === PENDING || status === REJECTED ? status : APPROVED
}

function isApproved(doc) {
  return auditStatusOf(doc) === APPROVED
}

/**
 * 公开可见条件：排除审核中与未通过。
 * 用 nin 而不是 eq('approved')，同样是为了让没有 auditStatus 字段的历史数据继续可见。
 */
function publicAuditWhere(command) {
  return command.nin([PENDING, REJECTED])
}

module.exports = {
  PENDING,
  APPROVED,
  REJECTED,
  auditStatusOf,
  isApproved,
  publicAuditWhere,
}
