import {decodeSourceRef} from '../../../shared/unified-mail/index.mjs'
import {request} from '@/request/unified.js'
import {session} from '@/auth/session.js'
import {useAccountStore} from '@/store/account.js'
import {useUiStore} from '@/store/ui.js'
import {sanitizeEmailHtml} from '@/utils/email-html.js'
// Only the legacy local writer receives local numeric IDs. External refs never enter
// emailStore.detailMap/contentData or the legacy attachment API.
export async function openLocalComposer(kind,message,check=()=>{}) {
  const lease=session.lease(), parsed=decodeSourceRef(message.ref)
  if(parsed.source!=='cloud-mail')throw Object.assign(new Error(),{code:'INVALID_REF'})
  let cursor=0,lastSort,account
  for(let page=0;page<100&&!account;page++){
    const rows=await request('/account/list',{query:{accountId:cursor,size:30,lastSort},signal:lease.signal});lease.assertCurrent();check()
    account=rows.find(row=>String(row.accountId)===parsed.accountId)
    if(account||rows.length<30)break
    cursor=rows.at(-1).accountId;lastSort=rows.at(-1).sort
  }
  lease.assertCurrent();check();if(!account)throw Object.assign(new Error(),{code:'NOT_FOUND'})
  const store=useAccountStore();store.currentAccountId=account.accountId;store.currentAccount=account
  const legacy={emailId:Number(parsed.id),accountId:account.accountId,sendEmail:message.from,name:message.from,subject:message.subject,content:sanitizeEmailHtml(message.html),text:message.text,createTime:new Date(message.receivedAt).toISOString(),attList:[]}
  const writer=useUiStore().writerRef
  if(kind==='reply')writer.openReply(legacy);else writer.openForward(legacy)
}
