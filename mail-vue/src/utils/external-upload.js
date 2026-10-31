import { sha256 } from '@noble/hashes/sha256'
import { bytesToHex } from '@noble/hashes/utils'
import { request } from '@/request/unified.js'
export async function stageFile(file,accountId,{signal,check,onProgress,onHandle}) {
  if(file.size>25*1024*1024)throw Object.assign(new Error(),{code:'PAYLOAD_TOO_LARGE'})
  const hash=sha256.create()
  const guard=()=>{check();signal.throwIfAborted()}
  for(let offset=0;offset<file.size;offset+=65536){guard();const chunk=await file.slice(offset,offset+65536).arrayBuffer();guard();hash.update(new Uint8Array(chunk));onProgress({phase:'hashing',percent:Math.round(Math.min(file.size,offset+65536)/Math.max(1,file.size)*100)})}
  guard()
  const {upload}=await request('/external/uploads',{method:'POST',body:{accountId,filename:file.name,contentType:file.type||'application/octet-stream',size:file.size,sha256:bytesToHex(hash.digest())},signal})
  // Remember the handle before checking cancellation so a cancelled metadata
  // request that nevertheless completed can still revoke its idle stage.
  check();onHandle(upload.id);guard()
  // Axios XHR sends the File/Blob with native browser backpressure; no FileReader,
  // arrayBuffer of the whole file, base64, arbitrary URL or fetch duplex requirement.
  const result=await request(`/external/uploads/${encodeURIComponent(upload.id)}`,{method:'PUT',body:file,signal,headers:{'Content-Type':'application/octet-stream','X-Upload-Capability':upload.capability},onUploadProgress:event=>{if(!signal.aborted){check();onProgress({phase:'uploading',percent:Math.min(99,Math.round(event.loaded/Math.max(1,file.size)*100))})}}})
  guard();if(result.upload.state!=='ready')throw Object.assign(new Error(),{code:'UPLOAD_CORRUPT'})
  onProgress({phase:'ready',percent:100});return result.upload
}
