<template><div class="safe-mail-body" v-html="safeHtml"></div></template>
<script setup>
import { computed } from 'vue'
import {safeBody} from './safe-content.js'
const props=defineProps({html:{type:String,default:''}})
// Final render boundary: no CSS, SVG, forms, embedded resources or remote images.
const safeHtml=computed(()=>safeBody(props.html))
</script>
<style scoped>.safe-mail-body{overflow-wrap:anywhere;line-height:1.6}.safe-mail-body :deep(pre){white-space:pre-wrap}.safe-mail-body :deep(table){max-width:100%;border-collapse:collapse}.safe-mail-body :deep(td),.safe-mail-body :deep(th){border:1px solid var(--el-border-color);padding:4px}</style>
