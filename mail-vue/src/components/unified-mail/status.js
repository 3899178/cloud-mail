export const accountStatus = account => ({pending:'等待验证',connecting:'正在连接',active:'已同步',paused:'已暂停','needs-auth':'需要重新授权',error:'同步异常'}[account.status] || '状态未知')
export const operationStatus = operation => ({queued:'已排队，尚未完成',running:'正在处理，尚未完成',succeeded:'操作成功',failed:'操作失败',uncertain:'发送状态不确定，请先检查源邮箱；不会自动重发'}[operation?.state] || '状态未知')
export const safeCode = error => error?.response?.data?.error?.code || error?.error?.code || error?.code || 'REQUEST_FAILED'
export const stale = error => ['STALE_SESSION','ERR_CANCELED','AbortError'].includes(safeCode(error))
