import DOMPurify from 'dompurify'
const options={
  ALLOWED_TAGS:['p','br','div','span','blockquote','pre','code','strong','b','i','em','u','s','ul','ol','li','table','thead','tbody','tr','td','th','h1','h2','h3','h4','hr','a'],
  ALLOWED_ATTR:['href','title','colspan','rowspan'],
  ALLOWED_URI_REGEXP:/^(?:https?:\/\/|mailto:)/i,
  ALLOW_DATA_ATTR:false,
  FORBID_CONTENTS:['script','style','svg','math','iframe','object','template']
}
export const safeBody=html=>DOMPurify.sanitize(html||'',options)
export const escapeText=value=>String(value??'').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]))
export function plainBody(html){
  const fragment=DOMPurify.sanitize(html||'',{...options,RETURN_DOM_FRAGMENT:true})
  for(const node of fragment.querySelectorAll('br'))node.replaceWith('\n')
  for(const node of fragment.querySelectorAll('p,div,blockquote,pre,li,tr,h1,h2,h3,h4'))node.append('\n')
  return fragment.textContent.trim()
}
export function replyAddress(value){
  const raw=String(value||'').trim()
  if(/[\r\n]/.test(raw))return ''
  const candidate=raw.match(/<([^<>]+)>/)?.[1]||raw
  return /^[^\s<>@,;]+@[^\s<>@,;]+$/.test(candidate)?candidate:''
}
