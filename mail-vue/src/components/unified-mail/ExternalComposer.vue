<template>
  <div v-if="opened" class="composer-shade"><section class="external-composer" role="dialog" aria-label="外部邮箱写信" aria-modal="true">
    <header><h2>{{kind==='reply'?'回复':kind==='forward'?'转发':'写信'}} · 外部邮箱</h2><button @click="close">关闭 ×</button></header>
    <p class="hint">外部草稿仅保留在本次打开的页面内存中。发送状态不确定时请检查源邮箱，不会自动重发。</p>
    <form @submit.prevent="send">
      <label>发件邮箱<select v-model="form.accountId" :disabled="locked || !!sourceMessage" @change="changeSender"><option v-for="account in store.accounts" :key="account.id" :value="account.id">{{account.address}} · {{accountStatus(account)}}</option></select></label>
      <label>收件人<input v-model="form.to" required placeholder="多个地址以逗号分隔" :disabled="locked" /></label>
      <label>抄送<input v-model="form.cc" :disabled="locked" /></label><label>密送<input v-model="form.bcc" :disabled="locked" /></label>
      <label>主题<input v-model="form.subject" :disabled="locked" /></label>
      <label>正文<textarea v-model="form.text" rows="10" :disabled="locked"></textarea></label>
      <fieldset v-if="sourceMessage?.attachments?.length"><legend>源邮件原附件</legend><label v-for="att in sourceMessage.attachments" :key="att.id"><input v-model="form.attachmentIds" :value="att.id" type="checkbox" :disabled="locked" />{{att.filename}} · {{att.size}} bytes</label></fieldset>
      <label>添加文件（每个 ≤25 MiB，合计最多 10 个）<input type="file" multiple :disabled="locked" @change="chooseFiles" /></label>
      <div v-for="upload in uploads" :key="upload.key" class="upload-row"><span>{{upload.filename}} · {{phaseLabel(upload.phase)}} {{upload.percent}}% {{upload.error}}</span><button type="button" :disabled="locked" @click="cancelUpload(upload)">{{upload.phase==='ready'?'移除':'取消'}}</button></div>
      <p v-if="error" role="alert">{{error}}</p>
      <p v-if="operation" role="status">{{operationStatus(operation)}} {{operation.errorCode}}</p>
      <div class="actions"><button type="submit" :disabled="locked || uploading || operation?.state==='succeeded'">发送</button><button v-if="operation?.id" type="button" @click="checkOperation">查询原发送结果</button><button v-if="operation?.state==='failed'" type="button" @click="newAttempt">开始新的发送尝试</button></div>
    </form>
    <div v-if="confirmClose" class="discard-confirm">关闭将丢弃当前外部草稿并取消未使用的附件。<button @click="discard">确认关闭</button><button @click="confirmClose=false">继续编辑</button></div>
  </section></div>
</template>
<script setup>
import {computed,onBeforeUnmount,reactive,ref,markRaw,watch} from 'vue'
import {useUnifiedStore} from '@/store/unified.js'
import {useUserStore} from '@/store/user.js'
import {session} from '@/auth/session.js'
import {request} from '@/request/unified.js'
import {stageFile} from '@/utils/external-upload.js'
import {accountStatus,operationStatus,safeCode,stale} from './status.js'
import {plainBody,replyAddress} from './safe-content.js'
const store=useUnifiedStore(),opened=ref(false),kind=ref('send'),sourceMessage=ref(null),operation=ref(null),error=ref(''),sending=ref(false),confirmClose=ref(false)
const owner=useUserStore()
const form=reactive({accountId:'',to:'',cc:'',bcc:'',subject:'',text:'',attachmentIds:[]}),uploads=ref([])
let generation=0,sendController,pollTimer,polls=0
const locked=computed(()=>sending.value || ['queued','running','uncertain','failed'].includes(operation.value?.state))
const uploading=computed(()=>uploads.value.some(u=>u.phase!=='ready'))
const phaseLabel=phase=>({hashing:'计算完整性哈希',uploading:'上传中',ready:'附件就绪',cancelled:'已取消',error:'失败'}[phase]||phase)
const recipients=value=>value.split(/[,;，；\n]/).map(s=>s.trim()).filter(Boolean)
function open(message=null,action='send'){
  if(opened.value){error.value='请先关闭或发送当前外部草稿';return}
  generation++;kind.value=action;sourceMessage.value=message;operation.value=null;error.value='';confirmClose.value=false
  Object.assign(form,{accountId:message?.accountId||store.selection.accountId||store.accounts[0]?.id||'',to:action==='reply'?replyAddress(message.from):'',cc:'',bcc:'',subject:message?(action==='reply'?'Re: ':'Fwd: ')+message.subject:'',text:action==='forward'?message.text||plainBody(message.html):'',attachmentIds:action==='forward'?(message.attachments||[]).map(a=>a.id):[]})
  opened.value=true
}
function close(){if(sending.value||locked.value){confirmClose.value=true;return}if(form.text||form.subject||form.to||uploads.value.length){confirmClose.value=true;return}discard()}
function discard(){generation++;clearTimeout(pollTimer);polls=0;sendController?.abort();for(const u of uploads.value){u.controller.abort();cleanup(u)}uploads.value=[];opened.value=false;sourceMessage.value=null;Object.assign(form,{accountId:'',to:'',cc:'',bcc:'',subject:'',text:'',attachmentIds:[]});operation.value=null;error.value='';confirmClose.value=false;sending.value=false}
async function cleanup(upload){if(upload.id&&upload.lease.current()){try{await request(`/external/uploads/${encodeURIComponent(upload.id)}`,{method:'DELETE',signal:upload.lease.signal});return null}catch(e){return safeCode(e)}}return null}
async function cancelUpload(upload){upload.controller.abort();const failure=await cleanup(upload);if(upload.lease.current()&&uploads.value.includes(upload)){if(failure){upload.phase='error';upload.error=`取消待清理：${failure}；可再次取消，过期后服务器会回收。`}else uploads.value=uploads.value.filter(u=>u!==upload)}}
async function changeSender(){generation++;for(const u of uploads.value){u.controller.abort();cleanup(u)}uploads.value=[];operation.value=null;error.value=''}
async function chooseFiles(event){
  const files=[...event.target.files];event.target.value=''
  if(uploads.value.length+form.attachmentIds.length+files.length>10){error.value='附件最多 10 个';return}
  for(const file of files){
    const lease=session.lease(),run=generation,controller=new AbortController()
    const upload=reactive({key:crypto.randomUUID(),filename:file.name,phase:'hashing',percent:0,id:null,error:'',controller:markRaw(controller),lease:markRaw(lease)})
    uploads.value.push(upload)
    const check=()=>{lease.assertCurrent();if(run!==generation||!opened.value)throw Object.assign(new Error(),{code:'STALE_SESSION'})}
    try{await stageFile(file,form.accountId,{signal:AbortSignal.any([controller.signal,lease.signal]),check,onProgress:state=>{check();Object.assign(upload,state)},onHandle:id=>{check();upload.id=id}})}
    catch(e){if(lease.current()&&run===generation){upload.phase=controller.signal.aborted?'cancelled':'error';upload.error=stale(e)?'':safeCode(e);await cleanup(upload)}}
    if(!lease.current()||run!==generation)return
  }
}
async function send(){
  if(locked.value||uploading.value||operation.value?.state==='succeeded')return
  const lease=session.lease(),run=generation
  if(!form.accountId){error.value='请先绑定并选择发件邮箱';return}
  sendController=new AbortController();sending.value=true;error.value=''
  try{
    const data=await request('/unified/messages/send',{method:'POST',body:{source:'external',accountId:form.accountId,kind:kind.value,...(sourceMessage.value?{ref:sourceMessage.value.ref}:{}),message:{to:recipients(form.to),cc:recipients(form.cc),bcc:recipients(form.bcc),subject:form.subject,text:form.text,attachmentIds:[...form.attachmentIds],uploadIds:uploads.value.map(u=>u.id)}},signal:AbortSignal.any([lease.signal,sendController.signal])})
    lease.assertCurrent();if(run!==generation)return
    operation.value=data.operation;uploads.value=[]
  }catch(e){if(lease.current()&&run===generation&&!stale(e)){
    const definite=!!e.response && [400,401,403,404,409,410,413,429].includes(e.response.status)
    operation.value={state:definite?'failed':'uncertain',errorCode:definite?safeCode(e):'SEND_UNCERTAIN'}
    error.value=definite?safeCode(e):'连接中断，服务器可能已经提交邮件；请检查源邮箱或操作记录。'
    // A handle may have been consumed even after a lost response. Never reuse it.
    for(const upload of uploads.value)cleanup(upload);uploads.value=[]
  }}finally{if(lease.current()&&run===generation)sending.value=false}
}
async function checkOperation(){
  if(!operation.value?.id)return
  const lease=session.lease(),run=generation,id=operation.value.id
  try{const data=await request(`/external/operations/${encodeURIComponent(id)}`,{signal:lease.signal});lease.assertCurrent();if(run===generation)operation.value=data.operation}
  catch(e){if(lease.current()&&run===generation&&!stale(e))error.value=safeCode(e)}
}
function newAttempt(){if(operation.value?.state==='failed'){operation.value=null;error.value='附件已失效，请重新选择需要的文件。'}}
watch(operation,op=>{clearTimeout(pollTimer);const lease=session.lease(),run=generation;if(op?.id&&['queued','running'].includes(op.state)&&polls++<30)pollTimer=setTimeout(()=>{if(lease.current()&&run===generation&&opened.value&&!document.hidden)checkOperation()},2000);else if(!op||!['queued','running'].includes(op.state))polls=0})
watch(()=>owner.user.email,discard,{flush:'sync'})
onBeforeUnmount(discard)
defineExpose({open})
</script>
<style scoped>
.composer-shade{position:fixed;inset:0;background:#0006;z-index:200;display:flex;align-items:center;justify-content:center}.external-composer{background:var(--el-bg-color);color:var(--el-text-color-primary);width:min(820px,calc(100vw - 40px));max-height:calc(100dvh - 40px);overflow:auto;padding:20px;border-radius:10px;box-shadow:var(--el-box-shadow)}header,.actions{display:flex;justify-content:space-between;gap:8px;align-items:center}h2{font-size:18px}form{display:grid;gap:12px}label{display:flex;gap:10px;align-items:center;flex-wrap:wrap}input:not([type=checkbox]),textarea,select{flex:1;min-width:100px;max-width:100%;padding:8px;border:1px solid var(--el-border-color);border-radius:5px;color:inherit;background:var(--el-bg-color)}textarea{width:100%}button{padding:8px 12px;background:var(--el-fill-color-light);color:inherit;border:1px solid var(--el-border-color);border-radius:5px;cursor:pointer}button:disabled{opacity:.5;cursor:default}.hint{font-size:12px;color:var(--el-text-color-secondary)}.upload-row{display:flex;gap:8px;justify-content:space-between;font-size:12px;overflow-wrap:anywhere}[role=alert]{color:var(--el-color-danger)}.discard-confirm{padding:14px;border:1px solid var(--el-color-warning);margin-top:10px}@media(max-width:767px){.external-composer{width:100%;max-height:100dvh;height:100dvh;border-radius:0;padding:15px}}
</style>
