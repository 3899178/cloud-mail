<template>
  <section class="external-binding">
    <div class="section-heading"><h2>外部邮箱</h2><button @click="begin()">＋ 绑定邮箱</button><button :disabled="store.accountsLoading" @click="store.loadAccounts()">刷新状态</button></div>
    <p class="hint">绑定后仅同步新到达的正常邮件（含归档及规则分流）。服务商实际授权、连接和同步成功后才显示“已同步”。</p>
    <p v-if="store.accountsError" role="alert">外部服务暂不可用：{{store.accountsError}}。本地邮箱仍可使用。</p>
    <p v-if="!store.accounts.length && !store.accountsError && !store.accountsLoading">尚未绑定外部邮箱。</p>
    <article v-for="account in store.accounts" :key="account.id" class="bound-account">
      <strong>{{account.address}}</strong><span>{{account.provider}} · {{accountStatus(account)}}</span>
      <span v-if="account.errorCode" role="status">{{account.errorCode}}</span>
      <div class="actions">
        <button :data-reauth="account.id" @click="begin(account)">重新授权 / 更新凭据</button>
        <button :disabled="busy" @click="act(account,account.status==='paused'?'resume':'connect')">{{account.status==='paused'?'恢复并验证':'连接 / 重试同步'}}</button>
        <button :disabled="busy || account.status==='paused'" @click="act(account,'pause')">暂停</button>
        <button :disabled="busy" @click="removing=account.id">解绑</button>
        <span v-if="removing===account.id">保留源邮箱邮件，删除本站副本及凭据。<button @click="act(account,'delete')">确认解绑</button><button @click="removing=null">取消</button></span>
      </div>
    </article>
    <p v-if="error" role="alert">{{error}}</p><p v-if="notice" role="status">{{notice}}</p>
    <form v-if="opened" class="binding-form" @submit.prevent="submit" autocomplete="off">
      <h3>{{editing?'更新授权':'绑定外部邮箱'}}</h3>
      <label>服务商<select v-model="form.provider" :disabled="!!editing" @change="clearSecrets"><option v-for="p in providers" :key="p[0]" :value="p[0]">{{p[1]}}</option></select></label>
      <label>邮箱地址<input v-model.trim="form.address" :disabled="!!editing" type="email" required maxlength="320" /></label>
      <p v-if="form.provider==='school'" class="hint">学校邮箱请使用学校公布的 IMAP/SMTP 主机和授权方式，不猜测服务器地址。</p>
      <label v-if="['gmail','outlook'].includes(form.provider)">授权方式<select v-model="form.authType"><option value="oauth">官方 OAuth</option><option v-if="form.provider==='gmail'" value="password">应用专用密码</option></select></label>
      <template v-if="form.provider!=='proton' && form.authType!=='oauth'">
        <label>登录用户名（可选）<input v-model.trim="form.user" autocomplete="off" /></label>
        <label>授权码 / 应用专用密码<input v-model="form.password" type="password" autocomplete="new-password" required /></label>
        <label><input type="checkbox" v-model="form.manual" :disabled="['imap','school'].includes(form.provider)" />手动配置 IMAP / SMTP</label>
        <fieldset v-if="form.manual"><legend>TLS 加密连接</legend>
          <label>IMAP 主机<input v-model.trim="form.imapHost" required /></label><label>IMAP TLS 端口<input v-model.number="form.imapPort" type="number" min="1" max="65535" required /></label>
          <label>SMTP 主机<input v-model.trim="form.smtpHost" required /></label><label>SMTP 端口<input v-model.number="form.smtpPort" type="number" min="1" max="65535" required /></label>
          <label>SMTP 加密<select v-model="form.smtpTLS"><option value="implicit">TLS</option><option value="starttls">强制 STARTTLS</option></select></label>
        </fieldset>
      </template>
      <template v-if="form.provider==='proton'">
        <p class="hint">Proton 免费和付费账号均需实际验证。验证码与密码仅在当前表单内存中使用。</p>
        <label v-if="!challenge">Proton 登录密码<input v-model="form.password" type="password" autocomplete="new-password" required /></label>
        <label v-if="!challenge">独立邮箱密码（双密码账号可填）<input v-model="form.mailboxPassword" type="password" autocomplete="new-password" /></label>
        <label v-if="challenge?.step==='totp'">两步验证码<input v-model="form.code" inputmode="numeric" autocomplete="one-time-code" required /></label>
        <label v-if="challenge?.step==='mailbox-password'">邮箱解密密码<input v-model="form.mailboxPassword" type="password" autocomplete="new-password" required /></label>
      </template>
      <div class="actions"><button type="submit" :disabled="busy">{{busy?'处理中…':challenge?'继续验证':form.authType==='oauth'?'保存并前往官方授权':'保存并验证连接'}}</button><button type="button" @click="close">关闭并清除输入</button></div>
    </form>
  </section>
</template>
<script setup>
import { reactive, ref, watch, onMounted, onBeforeUnmount } from 'vue'
import { useUnifiedStore } from '@/store/unified.js'
import { useUserStore } from '@/store/user.js'
import { session } from '@/auth/session.js'
import { request } from '@/request/unified.js'
import { accountStatus, safeCode, stale } from './status.js'
const store=useUnifiedStore()
const owner=useUserStore()
const opened=ref(false), editing=ref(null), challenge=ref(null), busy=ref(false), error=ref(''), notice=ref(''), removing=ref(null)
const providers=[['gmail','Gmail'],['qq','QQ'],['outlook','Outlook'],['proton','Proton'],['icloud','iCloud'],['163','163'],['126','126'],['yeah','yeah'],['school','学校邮箱'],['imap','其他 IMAP']]
const defaults=()=>({provider:'gmail',address:'',authType:'oauth',password:'',mailboxPassword:'',code:'',user:'',manual:false,imapHost:'',imapPort:993,smtpHost:'',smtpPort:465,smtpTLS:'implicit'})
const form=reactive(defaults()); let generation=0, disposed=false
function clearSecrets(){form.password='';form.mailboxPassword='';form.code='';challenge.value=null;form.authType=['gmail','outlook'].includes(form.provider)?'oauth':'password';form.manual=['imap','school'].includes(form.provider)}
function close(){generation++;opened.value=false;editing.value=null;challenge.value=null;Object.assign(form,defaults());busy.value=false}
function begin(account){close();error.value='';notice.value='';opened.value=true;if(account){editing.value=account;form.provider=account.provider;form.address=account.address;clearSecrets()}}
watch(()=>owner.user.email,()=>{close();error.value='';notice.value='';removing.value=null},{flush:'sync'})
watch(()=>form.authType,()=>{form.password='';form.mailboxPassword='';form.code=''})
function credentials(){const result={authType:form.authType};if(form.user)result.user=form.user;if(form.authType==='password')result.password=form.password;if(form.manual)result.config={imap:{host:form.imapHost,port:form.imapPort,secure:true},smtp:{host:form.smtpHost,port:form.smtpPort,...(form.smtpTLS==='starttls'?{requireTLS:true}:{secure:true})}};return result}
async function submit(){
  if(busy.value)return
  const lease=session.lease(), run=generation
  const current=()=>lease.current()&&run===generation&&!disposed
  const check=()=>{lease.assertCurrent();if(!current())throw Object.assign(new Error(),{code:'STALE_SESSION'})}
  busy.value=true;error.value='';notice.value=''
  try{
    let account=editing.value
    if(!account){const data=await request('/external/accounts',{method:'POST',body:{provider:form.provider,address:form.address,...(form.provider==='proton'?{}:{credentials:credentials()})},signal:lease.signal});check();account=data.account;editing.value=account}
    else if(form.provider!=='proton'){await request(`/external/accounts/${encodeURIComponent(account.id)}/credentials`,{method:'PUT',body:credentials(),signal:lease.signal});check()}
    if(form.provider==='proton'){
      const body=challenge.value?{state:challenge.value.state,...(challenge.value.step==='totp'?{code:form.code}:{mailboxPassword:form.mailboxPassword})}:{password:form.password,...(form.mailboxPassword?{mailboxPassword:form.mailboxPassword}:{})}
      const result=await request(`/external/accounts/${encodeURIComponent(account.id)}/proton/${challenge.value?'complete':'start'}`,{method:'POST',body,signal:lease.signal});check();form.password='';form.mailboxPassword='';form.code=''
      if(['totp','mailbox-password'].includes(result.step)){challenge.value=result;notice.value='请完成下一步验证（五分钟内有效）';await store.loadAccounts();return}
      challenge.value=null
      if(result.step!=='ready'){notice.value=result.step==='manual-verification'?'需要在 Proton 官方完成手动验证，再重新开始授权。':'服务商要求的验证方式尚不支持，授权未完成。';close();await store.loadAccounts();return}
    }
    if(form.authType==='oauth' && form.provider!=='proton'){
      const result=await request(`/external/accounts/${encodeURIComponent(account.id)}/oauth/start`,{method:'POST',signal:lease.signal});check()
      const url=new URL(result.authorizationUrl)
      const origin=form.provider==='gmail'?'https://accounts.google.com':'https://login.microsoftonline.com'
      if(url.origin!==origin||url.username||url.password)throw Object.assign(new Error(),{code:'INVALID_AUTHORIZATION_URL'})
      close();window.location.assign(url.href);return
    }
    form.password='';form.mailboxPassword='';form.code=''
    const data=await request(`/external/accounts/${encodeURIComponent(account.id)}/connect`,{method:'POST',signal:lease.signal});check()
    notice.value=`${accountStatus(data.account)}${data.account.errorCode?' · '+data.account.errorCode:''}`
    close();await store.loadAccounts()
  }catch(e){if(current()&&!stale(e)){error.value=safeCode(e);clearSecrets()}}
  finally{if(current())busy.value=false}
}
async function act(account,action){
  if(busy.value)return
  const lease=session.lease(),run=generation;busy.value=true;error.value=''
  try{const data=await request(`/external/accounts/${encodeURIComponent(account.id)}${action==='delete'?'':'/'+action}`,{method:action==='delete'?'DELETE':'POST',signal:lease.signal});lease.assertCurrent();if(run!==generation||disposed)return;notice.value=action==='delete'?'已解绑':accountStatus(data.account);removing.value=null;if(action==='delete'&&store.selection.source==='external'&&store.selection.accountId===account.id)store.select('all');await store.loadAccounts()}
  catch(e){if(lease.current()&&run===generation&&!disposed&&!stale(e))error.value=safeCode(e)}
  finally{if(lease.current()&&run===generation&&!disposed)busy.value=false}
}
onMounted(()=>store.loadAccounts())
onBeforeUnmount(()=>{disposed=true;close()})
defineExpose({begin})
</script>
<style scoped>
.external-binding{min-width:0}.section-heading,.actions{display:flex;gap:8px;align-items:center;flex-wrap:wrap}.section-heading h2{font-size:18px;margin-right:auto}.bound-account{border:1px solid var(--el-border-color);padding:12px;border-radius:8px;display:grid;gap:8px;margin:10px 0;overflow-wrap:anywhere}.hint{font-size:13px;color:var(--el-text-color-secondary);line-height:1.6}.binding-form{display:grid;gap:14px;border:1px solid var(--el-border-color);border-radius:8px;padding:16px}.binding-form label{display:flex;gap:8px;align-items:center;flex-wrap:wrap}.binding-form input:not([type=checkbox]),select{flex:1;min-width:100px;max-width:100%;padding:8px;background:var(--el-bg-color);color:var(--el-text-color-primary);border:1px solid var(--el-border-color);border-radius:5px}fieldset{display:grid;gap:10px;min-width:0}button{padding:7px 10px;cursor:pointer;background:var(--el-fill-color-light);color:var(--el-text-color-primary);border:1px solid var(--el-border-color);border-radius:5px}button:disabled{opacity:.5;cursor:wait}[role=alert]{color:var(--el-color-danger)}
</style>
