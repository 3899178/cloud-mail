<template>
  <div class="layout">
    <MailSidebar />
    <div class="mail-workspace"><header class="workspace-header"><Header /></header><Main /></div>
  </div>
  <writer ref="writerRef" />
  <ExternalComposer ref="externalComposerRef" />
</template>
<script setup>
import MailSidebar from '@/layout/mail-sidebar/index.vue'
import Header from '@/layout/header/index.vue'
import Main from '@/layout/main/index.vue'
import writer from '@/layout/write/index.vue'
import ExternalComposer from '@/components/unified-mail/ExternalComposer.vue'
import {ref,onMounted,onBeforeUnmount} from 'vue'
import {useUiStore} from '@/store/ui.js'
const ui=useUiStore(),writerRef=ref(null),externalComposerRef=ref(null)
onMounted(()=>{ui.writerRef=writerRef.value;ui.externalComposerRef=externalComposerRef.value})
onBeforeUnmount(()=>{ui.writerRef=null;ui.externalComposerRef=null})
</script>
<style scoped>
.layout{position:fixed;inset:0;display:flex;overflow:hidden;height:100dvh;width:100%;background:var(--el-bg-color)}
.mail-workspace{flex:1;min-width:0;min-height:0;display:flex;flex-direction:column;overflow:hidden}
.workspace-header{height:60px;flex-shrink:0;border-bottom:1px solid var(--el-border-color);background:var(--el-bg-color)}
.mail-workspace :deep(.main-content){flex:1;min-height:0;min-width:0;overflow:hidden}
@media(max-width:767px){.workspace-header{height:50px}}
</style>
