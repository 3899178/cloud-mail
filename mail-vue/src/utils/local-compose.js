import {decodeSourceRef} from '../../../shared/unified-mail/index.mjs'
import {request,downloadAttachment} from '@/request/unified.js'
import {session} from '@/auth/session.js'
import {useAccountStore} from '@/store/account.js'
import {useUiStore} from '@/store/ui.js'
import {safeBody,replyAddress} from '@/components/unified-mail/safe-content.js'
import {sourceAttachmentAdmission,sourceAttachmentBase64,assertLegacyPayload} from './local-source-attachments.js'
let importGeneration=0,previousImport
// Only the legacy local writer receives local numeric IDs. External refs never enter
// emailStore.detailMap/contentData or the legacy attachment API.
export async function openLocalComposer(kind,message,check=()=>{},{signal,onProgress=()=>{}}={}) {
  previousImport?.abort()
  const controller=new AbortController();previousImport=controller
  const generation=++importGeneration,lease=session.lease(), parsed=decodeSourceRef(message.ref)
  if(parsed.source!=='cloud-mail')throw Object.assign(new Error(),{code:'INVALID_REF'})
  if(!['reply','forward'].includes(kind))throw Object.assign(new Error(),{code:'INVALID_INPUT'})
  const writer=useUiStore().writerRef,writerLease=writer.sourceLease()
  const contextSignal=AbortSignal.any([lease.signal,controller.signal,...(signal?[signal]:[])])
  const combined=AbortSignal.any([contextSignal,writerLease.signal])
  const guard=()=>{lease.assertCurrent();contextSignal.throwIfAborted();check();if(generation!==importGeneration)throw Object.assign(new Error(),{code:'STALE_SESSION'})}
  const admissionGuard=()=>{guard();writerLease.assertCurrent();combined.throwIfAborted()}
  let cursor=0,lastSort,account
  for(let page=0;page<100&&!account;page++){
    admissionGuard();const rows=await request('/account/list',{query:{accountId:cursor,size:30,lastSort},signal:combined});admissionGuard()
    account=rows.find(row=>String(row.accountId)===parsed.accountId)
    if(account||rows.length<30)break
    cursor=rows.at(-1).accountId;lastSort=rows.at(-1).sort
  }
  admissionGuard();if(!account)throw Object.assign(new Error(),{code:'NOT_FOUND'})
  const legacy={emailId:Number(parsed.id),accountId:account.accountId,sendEmail:replyAddress(message.from),name:message.from,subject:message.subject,content:safeBody(message.html),text:message.text,createTime:new Date(message.receivedAt).toISOString(),attList:[]}
  const preparedForm=writer.prepareSource(kind,legacy,account)
  const metadata=sourceAttachmentAdmission(preparedForm,kind==='forward'?(message.attachments||[]):[])
  let attachments=[]
  try{
    for(const [index,att] of metadata.entries()){
      admissionGuard();onProgress({filename:att.filename,index:index+1,total:metadata.length,loaded:0,size:att.size})
      const stream=await downloadAttachment(message.ref,att.id,{signal:combined})
      try{admissionGuard()}catch(error){await stream.cancel().catch(()=>{});throw error}
      const content=await sourceAttachmentBase64(stream,att.size,{signal:combined,check:admissionGuard,onBytes:loaded=>{admissionGuard();onProgress({filename:att.filename,index:index+1,total:metadata.length,loaded,size:att.size})}})
      admissionGuard();const {id,...attachment}=att;attachments.push({...attachment,content})
    }
    admissionGuard();assertLegacyPayload({...preparedForm,attachments})
    const store=useAccountStore();store.currentAccountId=account.accountId;store.currentAccount=account
    const options={sourceImport:true,check:guard,preparedForm,attachments}
    if(kind==='reply')await writer.openReply(legacy,options);else await writer.openForward(legacy,options)
  }catch(error){lease.assertCurrent();if(!writerLease.current())throw Object.assign(new Error(),{code:'STALE_SESSION'});throw error}
  finally{attachments=[];if(previousImport===controller)previousImport=null}
}
