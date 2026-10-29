// Current no-new-paid deployment targets a Cloudflare Free/Pro zone. Its HTTP
// request-body ceiling is 100 MB (decimal), including JSON and base64 expansion.
// This is a zone/operator budget, not a historical per-file application limit.
export const LEGACY_REQUEST_BUDGET=100_000_000
const fail=code=>{throw Object.assign(new Error(code),{code})}

function stringBytes(text){
  if(!/[\u0000-\u001f"\\\u0080-\uffff]/.test(text))return text.length+2
  let bytes=2
  for(let i=0;i<text.length;i++){
    const code=text.charCodeAt(i)
    if(code===34||code===92||[8,9,10,12,13].includes(code)){bytes+=2;continue}
    if(code<32){bytes+=6;continue}
    if(code>=0xd800&&code<=0xdbff){const next=text.charCodeAt(i+1);if(next>=0xdc00&&next<=0xdfff){bytes+=4;i++}else bytes+=6;continue}
    if(code>=0xdc00&&code<=0xdfff){bytes+=6;continue}
    bytes+=code<128?1:code<2048?2:3
  }
  return bytes
}

// Count exactly what JSON.stringify sends, without serializing/re-encoding a
// second potentially 100MB body. Form values are ordinary JSON data.
export function legacyJsonBytes(value){
  if(value===null)return 4
  if(typeof value==='string')return stringBytes(value)
  if(typeof value==='number')return Number.isFinite(value)?String(value).length:4
  if(typeof value==='boolean')return value?4:5
  if(Array.isArray(value)){let bytes=2+Math.max(0,value.length-1);for(let i=0;i<value.length;i++)bytes+=legacyJsonBytes(value[i])??4;return bytes}
  if(typeof value==='object'){
    let bytes=2,count=0
    for(const key of Object.keys(value)){const size=legacyJsonBytes(value[key]);if(size===undefined)continue;bytes+=stringBytes(key)+1+size+(count++?1:0)}
    return bytes
  }
  if(typeof value==='bigint')fail('INVALID_INPUT')
  return undefined
}
export function assertLegacyPayload(payload){
  if(payload.attachments.length>10)fail('ATTACHMENT_LIMIT')
  if(legacyJsonBytes(payload)>LEGACY_REQUEST_BUDGET)fail('PAYLOAD_TOO_LARGE')
}
export function sourceAttachmentAdmission(payload,attachments){
  if(!Array.isArray(attachments))fail('INVALID_ATTACHMENT')
  if(attachments.length>10)fail('ATTACHMENT_LIMIT')
  const ids=new Set()
  const normalized=attachments.map(att=>{
    if(!att||typeof att.id!=='string'||!/^[1-9]\d*$/.test(att.id)||ids.has(att.id)||!Number.isSafeInteger(att.size)||att.size<0||(att.filename!=null&&typeof att.filename!=='string')||(att.contentType!=null&&typeof att.contentType!=='string'))fail('INVALID_ATTACHMENT')
    ids.add(att.id)
    return {id:att.id,filename:String(att.filename||'attachment'),contentType:att.contentType||'application/octet-stream',size:att.size}
  })
  const envelope={...payload,attachments:normalized.map(({id,...att})=>({...att,content:''}))}
  const bytes=legacyJsonBytes(envelope)+normalized.reduce((sum,att)=>sum+4*Math.ceil(att.size/3),0)
  if(!Number.isSafeInteger(bytes)||bytes>LEGACY_REQUEST_BUDGET)fail('PAYLOAD_TOO_LARGE')
  return normalized
}

export async function sourceAttachmentBase64(stream,size,{signal,check,onBytes=()=>{}}){
  const reader=stream.getReader(),parts=[]
  let count=0,carry=new Uint8Array(0),complete=false
  const guard=()=>{signal.throwIfAborted();check()}
  const abort=()=>{reader.cancel().catch(()=>{})}
  signal.addEventListener('abort',abort,{once:true})
  const encode=bytes=>parts.push(btoa(String.fromCharCode(...bytes)))
  try{
    while(true){
      guard();const {done,value}=await reader.read();guard()
      if(done)break
      if(!(value instanceof Uint8Array)||count+value.byteLength>size)fail('ATTACHMENT_SIZE_MISMATCH')
      count+=value.byteLength;let offset=0
      if(carry.length){const needed=Math.min(3-carry.length,value.length),joined=new Uint8Array(carry.length+needed);joined.set(carry);joined.set(value.subarray(0,needed),carry.length);offset=needed;if(joined.length===3){encode(joined);carry=new Uint8Array(0)}else carry=joined}
      const end=value.length-(value.length-offset)%3
      while(offset<end){const next=Math.min(end,offset+49152);encode(value.subarray(offset,next));offset=next}
      if(offset<value.length)carry=value.slice(offset)
      onBytes(count)
    }
    if(count!==size)fail('ATTACHMENT_SIZE_MISMATCH')
    if(carry.length)encode(carry)
    guard();complete=true;return parts.join('')
  }finally{
    signal.removeEventListener('abort',abort)
    if(!complete)await reader.cancel().catch(()=>{})
    reader.releaseLock();parts.length=0
  }
}
