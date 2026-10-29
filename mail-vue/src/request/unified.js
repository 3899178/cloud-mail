import http from '@/axios/index.js'
// Existing session/CSRF/stale HTTP fence, including HTTP 201 envelopes.
export function request(path, {method='GET',body,query,signal,headers,onUploadProgress} = {}) {
  return http.request({url:path,method,data:body,params:query,signal,headers,onUploadProgress,noMsg:true})
}
export function attachmentUrl(ref,id) {
  return `${(import.meta.env.VITE_BASE_URL || '/api').replace(/\/$/,'')}/unified/messages/${encodeURIComponent(ref)}/attachments/${encodeURIComponent(id)}`
}
export const errorCode = error => error?.response?.data?.error?.code || error?.error?.code || error?.code || 'REQUEST_FAILED'
