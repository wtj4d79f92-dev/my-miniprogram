// 活动审核状态：取值与云函数 cloudfunctions/activity/lib/audit.js 保持一致
// pending 审核中 / approved 已通过 / rejected 未通过
const AUDIT_STATUS = {
  PENDING: 'pending',
  APPROVED: 'approved',
  REJECTED: 'rejected',
}

const AUDIT_TEXT = {
  pending: '审核中',
  approved: '已通过',
  rejected: '未通过',
}

/** 驳回但审核意见为空时的兜底文案（正常流程下必填） */
const DEFAULT_REJECT_REASON = '内容不符合社区规范，请修改后重新提交'

/**
 * 历史数据没有 auditStatus 字段（审核能力上线前发布的活动）按「已通过」处理，
 * 与云函数端 nin 的查询口径保持一致。
 */
function auditStatusOf(item) {
  const status = (item && item.auditStatus) || ''
  return status === AUDIT_STATUS.PENDING || status === AUDIT_STATUS.REJECTED
    ? status
    : AUDIT_STATUS.APPROVED
}

function isApproved(item) {
  return auditStatusOf(item) === AUDIT_STATUS.APPROVED
}

function isPending(item) {
  return auditStatusOf(item) === AUDIT_STATUS.PENDING
}

function isRejected(item) {
  return auditStatusOf(item) === AUDIT_STATUS.REJECTED
}

/** 列表与详情页顶部的状态文案；已通过时返回空串（由业务状态「招募中 / 已关闭」接管） */
function auditTextOf(item) {
  const status = auditStatusOf(item)
  return status === AUDIT_STATUS.APPROVED ? '' : AUDIT_TEXT[status]
}

/** 驳回原因，空值兜底成通用文案 */
function auditReasonOf(item) {
  if (!isRejected(item)) return ''
  return String((item && item.auditRemark) || '').trim() || DEFAULT_REJECT_REASON
}

module.exports = {
  AUDIT_STATUS,
  AUDIT_TEXT,
  DEFAULT_REJECT_REASON,
  auditStatusOf,
  isApproved,
  isPending,
  isRejected,
  auditTextOf,
  auditReasonOf,
}
