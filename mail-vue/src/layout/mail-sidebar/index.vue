<template>
  <aside class="mailbox-sidebar" :class="{'is-expanded':expanded}" aria-label="邮箱侧栏">
    <nav class="mailbox-rail" aria-label="邮箱导航">
      <button aria-label="展开邮箱列表" :aria-expanded="expanded" @click="expanded=!expanded">☰</button>
      <button title="全部邮箱" aria-label="全部邮箱" @click="expandOrSelect('all')">▦</button>
      <button title="本地邮箱" aria-label="本地邮箱" @click="expandOrLocal">✉</button>
      <button v-for="account in store.accounts" :key="account.id" :title="account.address+' · '+accountStatus(account)" :aria-label="account.address" @click="expandOrSelect('external',account.id)">{{account.provider.slice(0,1).toUpperCase()}}</button>
      <button aria-label="绑定外部邮箱" title="绑定外部邮箱" @click="manage">＋</button>
      <button aria-label="原有功能菜单" title="原有功能菜单" @click="ui.asideShow=!ui.asideShow">⋯</button>
      <button aria-label="写信" title="写信" @click="compose">✎</button>
    </nav>
    <section data-mailbox-panel class="mailbox-panel">
      <div class="mailbox-heading"><strong>邮箱</strong><button aria-label="收起邮箱列表" @click="expanded=false">‹</button></div>
      <button data-select-all class="all-mailboxes" :class="{selected:route.name==='unified' && store.selection.source==='all'}" @click="choose('all')">▦ 全部邮箱 <small>正常邮件 · 含归档</small></button>
      <div class="local-heading"><span>Cloud Mail 本地邮箱</span><button @click="localInbox">原收件箱</button></div>
      <Account v-if="hasPerm('account:query')" class="local-accounts" @select="localChosen" @accounts="store.localAccounts=$event" />
      <button v-else class="primary-account" @click="localInbox">{{user.user.email}}</button>
      <section class="external-accounts" aria-label="外部邮箱列表">
        <div class="local-heading"><strong>外部邮箱</strong><button @click="manage">＋ 绑定 / 管理</button></div>
        <p v-if="store.accountsLoading && !store.accounts.length" role="status">正在读取状态…</p>
        <p v-if="store.accountsError" role="alert">外部服务不可用：{{store.accountsError}}<button @click="store.loadAccounts()">重试</button></p>
        <p v-if="!store.accounts.length && !store.accountsError && !store.accountsLoading" class="muted">尚未绑定外部邮箱</p>
        <button v-for="account in store.accounts" :key="account.id" class="external-account" :class="{selected:route.name==='unified' && store.selection.source==='external' && store.selection.accountId===account.id}" @click="choose('external',account.id)">
          <span class="address">{{account.address}}</span><small>{{account.provider}} · {{accountStatus(account)}}{{account.errorCode?' · '+account.errorCode:''}}</small>
        </button>
      </section>
      <button class="features" @click="ui.asideShow=!ui.asideShow">⋯ 原有功能与管理菜单</button>
    </section>
    <button v-if="expanded" class="phone-backdrop" aria-label="关闭邮箱展开层" @click="expanded=false"></button>
    <section v-if="ui.asideShow" class="feature-drawer" aria-label="原有功能菜单"><button class="close-features" @click="ui.asideShow=false">关闭菜单 ×</button><Aside /></section>
  </aside>
</template>
<script setup>
import {ref,onMounted,onBeforeUnmount} from 'vue'
import {useRoute,useRouter} from 'vue-router'
import Account from '@/layout/account/index.vue'
import Aside from '@/layout/aside/index.vue'
import {useUnifiedStore} from '@/store/unified.js'
import {useUserStore} from '@/store/user.js'
import {useUiStore} from '@/store/ui.js'
import {hasPerm} from '@/perm/perm.js'
import {accountStatus} from '@/components/unified-mail/status.js'
const store=useUnifiedStore(),user=useUserStore(),ui=useUiStore(),router=useRouter(),route=useRoute()
const expanded=ref(false)
function choose(source,id=null){store.select(source,id);expanded.value=false;router.push('/unified')}
function expandOrSelect(source,id=null){if(window.innerWidth<768&&!expanded.value){expanded.value=true;return}choose(source,id)}
function expandOrLocal(){if(window.innerWidth<768&&!expanded.value){expanded.value=true;return}localInbox()}
function localInbox(){store.select('cloud-mail');expanded.value=false;router.push('/inbox')}
function localChosen(){localInbox()}
function manage(){expanded.value=false;router.push('/settings#external-mailboxes')}
function compose(){if(route.name==='unified'&&store.selection.source==='external')ui.externalComposerRef?.open();else ui.writerRef?.open()}
let timer
onMounted(()=>{ui.asideShow=false;store.loadAccounts();timer=setInterval(()=>{if(!document.hidden&&!store.accountsLoading)store.loadAccounts()},10000)})
onBeforeUnmount(()=>clearInterval(timer))
</script>
<style scoped>
.mailbox-sidebar{position:relative;flex:0 0 336px;width:336px;display:flex;height:100%;min-height:0;background:var(--el-bg-color);border-right:1px solid var(--el-border-color);z-index:20}.mailbox-rail{width:56px;flex-shrink:0;display:flex;flex-direction:column;gap:5px;overflow-y:auto;align-items:center;padding:10px 0;background:var(--aside-backgound,#25344d)}.mailbox-rail button{width:40px;min-height:40px;padding:0;border:0;background:transparent;color:#fff;font-size:21px;cursor:pointer;border-radius:8px}.mailbox-rail button:hover{background:#ffffff20}.mailbox-panel{width:280px;min-height:0;display:flex;flex-direction:column;overflow:hidden}.mailbox-heading,.local-heading{display:flex;align-items:center;justify-content:space-between;gap:5px;padding:10px;font-size:13px}.mailbox-heading{font-size:17px}.mailbox-heading>button{display:none}.all-mailboxes{margin:0 10px 8px;text-align:left;padding:12px;display:grid;gap:6px}.all-mailboxes small,.muted{color:var(--el-text-color-secondary);font-size:12px}.local-accounts{flex:1;min-height:140px;height:auto!important}.external-accounts{max-height:38%;overflow-y:auto;flex-shrink:0;border-top:1px solid var(--el-border-color);padding-bottom:5px}.external-accounts p{font-size:12px;margin:10px}.external-account{display:grid;width:calc(100% - 20px);margin:5px 10px;padding:9px;text-align:left;gap:6px}.address{overflow-wrap:anywhere}.external-account small{font-size:11px;line-height:1.5;color:var(--el-text-color-secondary)}button{cursor:pointer;color:var(--el-text-color-primary);border:1px solid var(--el-border-color);border-radius:6px;background:var(--el-bg-color)}.selected{border-color:var(--el-color-primary);background:var(--el-color-primary-light-9)}.features{padding:12px;margin:5px 10px}.phone-backdrop{display:none}.feature-drawer{position:absolute;left:56px;top:0;bottom:0;width:280px;background:var(--aside-backgound,#25344d);z-index:30;display:flex;flex-direction:column;box-shadow:var(--el-box-shadow)}.feature-drawer :deep(.scroll){min-height:0;flex:1}.close-features{margin:10px;padding:8px}.primary-account{padding:12px;margin:10px}
@media(max-width:767px){.mailbox-sidebar{width:56px;flex-basis:56px}.mailbox-panel{position:absolute;left:56px;top:0;bottom:0;background:var(--el-bg-color);width:min(300px,calc(100vw - 76px));visibility:hidden;pointer-events:none;z-index:22;box-shadow:var(--el-box-shadow)}.is-expanded .mailbox-panel{visibility:visible;pointer-events:auto}.mailbox-heading>button{display:block}.phone-backdrop{display:block;position:fixed;top:0;bottom:0;left:56px;right:0;background:#0006;border:0;border-radius:0;z-index:21}.feature-drawer{position:fixed;left:56px;width:min(280px,calc(100vw - 56px))}.local-accounts{min-height:120px}}
</style>
