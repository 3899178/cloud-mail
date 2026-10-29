import http from '@/axios/index.js'
import {session} from '@/auth/session.js'
// Existing session/CSRF/stale HTTP fence, including HTTP 201 envelopes.
export function request(path, {method='GET',body,query,signal,headers,onUploadProgress} = {}) {
  return http.request({url:path,method,data:body,params:query,signal,headers,onUploadProgress,noMsg:true})
}
export function attachmentUrl(ref,id) {
  return `${(import.meta.env.VITE_BASE_URL || '/api').replace(/\/$/,'')}/unified/messages/${encodeURIComponent(ref)}/attachments/${encodeURIComponent(id)}`
}
export function downloadAttachment(ref,id,{signal}={}){
  const lease=session.lease()
  return http.get(`/unified/messages/${encodeURIComponent(ref)}/attachments/${encodeURIComponent(id)}`,{
    adapter:'fetch',responseType:'stream',ownedAttachmentStream:true,noMsg:true,signal,
    // Cancel before Axios wraps the body in its progress iterator. Cancelling
    // that wrapper can otherwise wait on an already pending source read.
    env:{fetch:async (...args)=>{const response=await fetch(...args);if(!response.ok)await response.body?.cancel();return response}}
  }).catch(async error=>{try{await error.response?.data?.cancel?.()}catch{/* The original transport error remains authoritative. */}lease.assertCurrent();const status=error.response?.status;if(status)throw Object.assign(new Error(),{code:({401:'UNAUTHORIZED',403:'FORBIDDEN',404:'NOT_FOUND',413:'PAYLOAD_TOO_LARGE'}[status]||'ATTACHMENT_DOWNLOAD_FAILED')});throw error})
}
export const errorCode = error => error?.response?.data?.error?.code || error?.error?.code || error?.code || 'REQUEST_FAILED'
