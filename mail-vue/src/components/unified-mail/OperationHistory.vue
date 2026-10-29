<template><section class="operation-history"><div class="heading"><h3>外部操作记录</h3><button :disabled="loading" @click="load">查询最新结果</button></div><p class="hint">连接中断后可核对服务器已记录的操作；不确定的发送不会自动重试。</p><p v-if="error" role="alert">{{error}}</p><p v-if="!operations.length && !error && !loading">暂无操作记录</p><article v-for="op in operations" :key="op.id"><strong>{{accountAddress(op.accountId)}}</strong> · {{op.kind}} · {{operationStatus(op)}} {{op.errorCode}}<small>{{new Date(op.createdAt).toLocaleString()}}</small></article></section></template>
<script setup>
import {ref,onMounted,onBeforeUnmount,watch} from 'vue'
import {session} from '@/auth/session.js'
import {request} from '@/request/unified.js'
import {useUnifiedStore} from '@/store/unified.js'
import {useUserStore} from '@/store/user.js'
import {operationStatus,safeCode,stale} from './status.js'
const store=useUnifiedStore(),operations=ref([]),error=ref(''),loading=ref(false)
let generation=0,alive=true
const owner=useUserStore()
watch(()=>owner.user.email,()=>{generation++;operations.value=[];error.value='';loading.value=false},{flush:'sync'})
const accountAddress=id=>store.accounts.find(a=>a.id===id)?.address||id
async function load(){const lease=session.lease(),run=++generation;loading.value=true;try{const data=await request('/external/operations',{signal:lease.signal});lease.assertCurrent();if(!alive||run!==generation)return;operations.value=data.operations;error.value=''}catch(e){if(alive&&lease.current()&&run===generation&&!stale(e))error.value=safeCode(e)}finally{if(alive&&lease.current()&&run===generation)loading.value=false}}
onMounted(load);onBeforeUnmount(()=>{alive=false;generation++})
</script>
<style scoped>.operation-history{margin:24px 0 40px}.heading{display:flex;gap:12px;align-items:center}.heading h3{font-size:16px}article{padding:12px 0;border-bottom:1px solid var(--el-border-color);overflow-wrap:anywhere;line-height:1.6}small{display:block;color:var(--el-text-color-secondary)}.hint{font-size:12px;color:var(--el-text-color-secondary)}button{cursor:pointer;padding:7px 10px;border:1px solid var(--el-border-color);border-radius:5px;background:var(--el-bg-color);color:inherit}[role=alert]{color:var(--el-color-danger)}</style>
