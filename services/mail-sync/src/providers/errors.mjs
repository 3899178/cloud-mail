export function providerCode(error) {
  if (error?.code === 'RESYNC_REQUIRED') return 'RESYNC_REQUIRED';
  if (error?.code === 'CAPACITY_EXCEEDED') return 'CAPACITY_EXCEEDED';
  if (error?.authenticationFailed || ['EAUTH', 'AUTH_REQUIRED', 'CREDENTIAL_UNAVAILABLE'].includes(error?.code)) return 'AUTH_REQUIRED';
  if (['ENOSPC', 'EDQUOT', 'SQLITE_FULL', 'STORAGE_FULL'].includes(error?.code) || error?.errcode === 13) return 'STORAGE_FULL';
  if (['ETIMEDOUT', 'ETIMEOUT', 'PROVIDER_TIMEOUT'].includes(error?.code)) return 'PROVIDER_TIMEOUT';
  if (['RATE_LIMITED', 'BUSY'].includes(error?.code)) return 'RATE_LIMITED';
  return 'SYNC_FAILED';
}
