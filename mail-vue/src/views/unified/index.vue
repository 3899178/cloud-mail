<template>
  <section class="unified-mailbox" :class="{'show-detail':!!store.detail}">
    <header class="unified-toolbar"><h1>{{selectedAddress || (store.selection.source==='all'?'全部邮箱':'外部邮箱')}}</h1><button data-refresh :disabled="store.loading" @click="refresh">刷新</button><button v-if="hasPerm('email:send')" @click="localCompose">本地写信</button><button :disabled="!store.accounts.length" @click="ui.externalComposerRef?.open()">外部写信</button></header>
    <p v-if="store.incomplete" class="status-banner" role="status">邮件列表不完整：部分邮箱暂不可用，已显示可读取的邮件；恢复后将刷新列表。<button @click="refresh">重新读取</button></p>
    <p v-if="store.error" class="status-banner" role="alert">{{store.error==='LOCAL_INDEX_NOT_READY'?'本地邮件索引正在初始化，请稍候。':`读取失败：${store.error}`}}<button @click="refresh">重试</button><button @click="router.push('/inbox')">打开原收件箱</button></p>
    <p v-if="store.loading" class="status-banner" role="status">正在读取邮件…</p>
    <div class="unified-columns">
      <section class="message-list" aria-label="统一邮件列表">
        <p v-if="!store.loading && !store.error && !store.items.length" class="empty">暂无邮件</p>
        <button v-for="message in store.items" :key="message.ref" :data-message-ref="message.ref" class="message-row" :class="{unread:message.unread,selected:store.detail?.ref===message.ref}" @click="store.open(message.ref)">
          <span class="row-top"><strong>{{message.from || '未知发件人'}}</strong><time>{{date(message.receivedAt)}}</time></span>
          <span>{{message.subject || '（无主题）'}}</span>
          <small>{{message.source==='cloud-mail'?'Cloud Mail':sourceAccount(message)?.provider || '外部'}} · {{sourceAccount(message)?.address || (message.source==='cloud-mail'?'本地邮箱':'外部邮箱')}} · {{folderName(message.folder)}}</small>
          <small v-if="message.source==='external' && sourceAccount(message)">{{accountStatus(sourceAccount(message))}} {{sourceAccount(message).errorCode}}</small>
        </button>
        <button v-if="store.nextCursor && !store.resetRequired" class="load-more" :disabled="store.loading" @click="store.load({append:true})">读取更多</button>
      </section>
      <section class="message-detail" aria-label="邮件正文">
        <p v-if="store.detailError" role="alert">正文读取失败：{{store.detailError}}</p>
        <template v-if="store.detail">
          <div class="detail-actions"><button @click="backToList">← 列表</button><button data-mark-read :disabled="operationBusy" @click="store.mutate('read',store.detail.ref,{unread:!store.detail.unread})">{{store.detail.unread?'标为已读':'标为未读'}}</button><button v-if="store.detail.source==='external' || hasPerm('email:delete')" data-trash :disabled="operationBusy" @click="confirmTrash=true">删除</button><button v-if="store.detail.source==='external' || hasPerm('email:send')" @click="compose('reply')">回复</button><button v-if="store.detail.source==='external' || hasPerm('email:send')" @click="compose('forward')">转发</button></div>
          <p v-if="confirmTrash" class="status-banner">{{store.detail.source==='external'?'将移入源邮箱垃圾箱。':'按原 Cloud Mail 规则删除此邮件。'}}<button data-confirm-trash @click="trash">确认删除</button><button @click="confirmTrash=false">取消</button></p>
          <p v-if="store.operation" role="status">{{operationStatus(store.operation)}} {{store.operation.errorCode}} <button v-if="store.operation.id" data-check-operation @click="store.checkOperation()">查询操作结果</button></p>
          <p v-if="store.operationError || actionError" role="alert">{{store.operationError || actionError}}</p>
          <p v-if="importing" role="status">正在读取原附件 {{importProgress?.index||0}} / {{importProgress?.total||0}}：{{importProgress?.filename}} <button data-cancel-import @click="cancelImport(true)">取消转发 / 回复</button></p>
          <h2>{{store.detail.subject || '（无主题）'}}</h2><p class="sender">{{store.detail.from}}</p><p class="message-meta">{{store.detail.source==='cloud-mail'?'Cloud Mail':'外部邮箱'}} · {{sourceAccount(store.detail)?.address || '邮箱'}} · {{folderName(store.detail.folder)}} · {{date(store.detail.receivedAt)}}</p>
          <p v-if="store.detail.html" class="privacy-note">为保护隐私，已屏蔽远程图片、样式和活动内容。</p>
          <SafeBody v-if="store.detail.html" :html="store.detail.html" /><pre v-else class="plain-body">{{store.detail.text}}</pre>
          <div v-if="store.detail.attachments?.length" class="attachments"><h3>原附件</h3><a v-for="attachment in store.detail.attachments" :key="attachment.id" :href="attachmentUrl(store.detail.ref,attachment.id)" download>{{attachment.filename}} · {{attachment.size}} bytes</a></div>
        </template>
        <p v-else-if="!store.detailError" class="empty">选择邮件查看正文</p>
      </section>
    </div>
  </section>
</template>
<script setup>
import {computed,onMounted,onBeforeUnmount,ref,watch} from 'vue'
import {useRouter} from 'vue-router'
import {useUnifiedStore} from '@/store/unified.js'
import {useUiStore} from '@/store/ui.js'
import {useAccountStore} from '@/store/account.js'
import {useUserStore} from '@/store/user.js'
import {session} from '@/auth/session.js'
import {attachmentUrl} from '@/request/unified.js'
import {hasPerm} from '@/perm/perm.js'
import {openLocalComposer} from '@/utils/local-compose.js'
import SafeBody from '@/components/unified-mail/SafeBody.vue'
import {accountStatus,operationStatus,safeCode,stale} from '@/components/unified-mail/status.js'
const store=useUnifiedStore(),ui=useUiStore(),router=useRouter(),confirmTrash=ref(false),actionError=ref('')
const localStore=useAccountStore(),owner=useUserStore()
const selectedAddress=computed(()=>store.selection.source==='external'?store.accounts.find(a=>a.id===store.selection.accountId)?.address:'')
const operationBusy=computed(()=>['queued','running'].includes(store.operation?.state))
const sourceAccount=message=>{
  if(message.source==='external')return store.accounts.find(a=>a.id===message.accountId)
  const known=store.localAccounts.find(a=>String(a.accountId)===String(message.accountId));if(known)return known
  const account=[localStore.currentAccount,owner.user.account].find(a=>a&&String(a.accountId)===String(message.accountId))
  return account?{address:account.email||owner.user.email,name:account.name}:null
}
const folderName=folder=>({Inbox:'收件箱',INBOX:'收件箱',Archive:'归档',archive:'归档'}[folder]||folder)
const date=value=>new Date(value).toLocaleString()
let alive=true,retryTimer,refreshTimer,pollTimer,indexAttempts=0,polls=0
const importing=ref(false),importProgress=ref(null)
let importController,importRevision=0
function cancelImport(notice=false){importRevision++;importController?.abort();importing.value=false;importProgress.value=null;if(notice)actionError.value='已取消读取，未打开转发 / 回复窗口。'}
const viewLease=session.lease()
function backToList(){store.detailGeneration++;store.operationGeneration++;store.detail=null;store.operation=null;confirmTrash.value=false}
function refresh(){indexAttempts=0;clearTimeout(retryTimer);store.load()}
function localCompose(){ui.writerRef?.open()}
async function compose(kind){
  cancelImport()
  actionError.value='';const detail=store.detail,lease=session.lease()
  if(detail.source==='external'){ui.externalComposerRef?.open(detail,kind);return}
  const revision=importRevision;importController=new AbortController();importing.value=true
  const check=()=>{lease.assertCurrent();if(store.detail?.ref!==detail.ref||!alive||revision!==importRevision)throw Object.assign(new Error(),{code:'STALE_SESSION'})}
  try{await openLocalComposer(kind,detail,check,{signal:importController.signal,onProgress:progress=>{check();importProgress.value=progress}})}
  catch(e){if(lease.current()&&alive&&revision===importRevision&&!stale(e))actionError.value=`原附件或邮件读取失败，未打开转发 / 回复窗口：${safeCode(e)}`}
  finally{if(lease.current()&&alive&&revision===importRevision)importing.value=false}
}
function trash(){confirmTrash.value=false;store.mutate('trash',store.detail.ref)}
watch(()=>store.detail?.ref,()=>{cancelImport();confirmTrash.value=false;actionError.value=''})
watch(()=>[store.selection.source,store.selection.accountId],()=>{indexAttempts=0;if(viewLease.current())store.load()})
watch(()=>store.error,error=>{
  clearTimeout(retryTimer)
  if(error==='LOCAL_INDEX_NOT_READY' && indexAttempts<4){const delay=1000*2**indexAttempts++;retryTimer=setTimeout(()=>{if(alive&&viewLease.current()&&!document.hidden)store.load()},delay)}
})
watch(()=>store.operation,operation=>{
  clearTimeout(pollTimer)
  if(operation?.id && ['queued','running'].includes(operation.state) && polls++<30)pollTimer=setTimeout(()=>{if(alive&&viewLease.current()&&!document.hidden)store.checkOperation()},2000)
  else if(!operation||!['queued','running'].includes(operation.state))polls=0
})
function visible(){if(!document.hidden&&viewLease.current()&&store.error!=='LOCAL_INDEX_NOT_READY')store.load()}
onMounted(()=>{store.load();refreshTimer=setInterval(()=>{if(viewLease.current()&&!document.hidden&&!store.loading&&store.error!=='LOCAL_INDEX_NOT_READY')store.load()},10000);document.addEventListener('visibilitychange',visible)})
onBeforeUnmount(()=>{alive=false;cancelImport();store.listGeneration++;store.detailGeneration++;store.operationGeneration++;store.loading=false;clearTimeout(retryTimer);clearTimeout(pollTimer);clearInterval(refreshTimer);document.removeEventListener('visibilitychange',visible)})
</script>
<style scoped>
.unified-mailbox{display:flex;flex-direction:column;min-height:0;height:100%;min-width:0;overflow:hidden;color:var(--el-text-color-primary)}.unified-toolbar{display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:12px 16px;border-bottom:1px solid var(--el-border-color);flex-shrink:0}.unified-toolbar h1{font-size:18px;margin:0 auto 0 0;overflow-wrap:anywhere}.unified-columns{display:grid;grid-template-columns:minmax(240px,38%) minmax(0,1fr);flex:1;min-height:0}.message-list,.message-detail{overflow-y:auto;min-width:0;min-height:0;overscroll-behavior:contain}.message-list{border-right:1px solid var(--el-border-color)}.message-row{width:100%;border:0;border-radius:0;border-bottom:1px solid var(--el-border-color);padding:14px 16px;text-align:left;display:grid;gap:8px;line-height:1.45;overflow-wrap:anywhere}.message-row.unread{box-shadow:inset 3px 0 var(--el-color-primary)}.message-row.selected{background:var(--el-color-primary-light-9)}.message-row small,.message-meta,.privacy-note{font-size:12px;color:var(--el-text-color-secondary)}.row-top{display:flex;gap:10px;justify-content:space-between;align-items:start}.row-top time{font-size:11px;flex-shrink:0;font-weight:normal}.row-top strong{font-weight:inherit}.unread .row-top strong{font-weight:700}.message-detail{padding:16px 22px}.message-detail h2{font-size:22px;overflow-wrap:anywhere}.sender{overflow-wrap:anywhere}.detail-actions{display:flex;gap:8px;flex-wrap:wrap}.plain-body{white-space:pre-wrap;font:inherit;overflow-wrap:anywhere;line-height:1.6}.attachments{display:grid;gap:12px;margin-top:28px}.attachments a{color:var(--el-color-primary);overflow-wrap:anywhere}.empty{padding:20px;color:var(--el-text-color-secondary)}button{background:var(--el-bg-color);color:inherit;border:1px solid var(--el-border-color);border-radius:5px;padding:7px 10px;cursor:pointer}button:disabled{opacity:.5;cursor:default}.status-banner{margin:0;padding:10px 16px;background:var(--el-fill-color-light);font-size:13px;line-height:1.5}.status-banner button{margin-left:8px}.load-more{margin:15px}.message-row:hover{background:var(--el-fill-color-light)}[role=alert]{color:var(--el-color-danger)}
@media(max-width:1000px){.unified-columns{grid-template-columns:minmax(220px,43%) minmax(0,1fr)}.row-top{flex-wrap:wrap}}
@media(max-width:767px){.unified-toolbar{padding:10px}.unified-toolbar h1{font-size:16px;width:100%}.unified-columns{display:block;position:relative}.message-list,.message-detail{height:100%;width:100%}.message-detail{display:none;padding:12px}.show-detail .message-detail{display:block}.show-detail .message-list{display:none}.message-detail h2{font-size:18px}}
</style>
