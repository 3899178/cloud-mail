import {describe,it,expect,vi,beforeEach,afterEach} from 'vitest'
import {mount,flushPromises} from '@vue/test-utils'
import {createPinia,setActivePinia} from 'pinia'
import {createI18n} from 'vue-i18n'
import {defineComponent} from 'vue'
import {getActivePinia} from 'pinia'
import {routerKey} from 'vue-router'
import Writer from '@/layout/write/index.vue'
import Unified from '@/views/unified/index.vue'
import {openLocalComposer} from '@/utils/local-compose.js'
import {useUiStore} from '@/store/ui.js'
import {session} from '@/auth/session.js'
import {encodeSourceRef} from '../../../shared/unified-mail/index.mjs'

const boundary=vi.hoisted(()=>({request:vi.fn(),download:vi.fn(),send:vi.fn(),payloads:[],owner:null}))
vi.mock('@/router/index.js',()=>({default:{replace:vi.fn()}}))
vi.mock('@/db/db.js',()=>({default:{value:{}}}))
vi.mock('@/request/email.js',()=>({emailSend:(...args)=>boundary.send(...args)}))
vi.mock('@/request/unified.js',()=>({request:(...args)=>boundary.request(...args),downloadAttachment:(...args)=>boundary.download(...args),attachmentUrl:(ref,id)=>'/api/unified/messages/'+ref+'/attachments/'+id}))
vi.mock('@/store/user.js',async()=>{const{reactive}=await import('vue');boundary.owner=reactive({user:{email:'owned@test',name:'Owner',account:{accountId:1},permKeys:['*']},refreshUserInfo:vi.fn()});return {useUserStore:()=>boundary.owner}})
vi.mock('@/store/setting.js',()=>({useSettingStore:()=>({lang:'en',settings:{r2Domain:''}})}))
const Recipient=defineComponent({inheritAttrs:false,props:['modelValue'],emits:['update:modelValue'],template:'<input data-recipient :value="modelValue.join(\',\')" @input="$emit(\'update:modelValue\',$event.target.value.split(\',\'))" />'})
const Input=defineComponent({props:['modelValue'],emits:['update:modelValue'],template:'<input data-subject :value="modelValue" @input="$emit(\'update:modelValue\',$event.target.value)" />'})
const Send=defineComponent({emits:['click'],template:'<button data-send @click="$emit(\'click\')"><slot /></button>'})
let w,editor,content,writes,feed
const source=(extra={})=>({ref:encodeSourceRef({source:'cloud-mail',accountId:'1',id:'7'}),source:'cloud-mail',accountId:'1',receivedAt:1,from:'sender@test',subject:'Source',text:'',html:'',attachments:[],...extra})
beforeEach(()=>{
  vi.useFakeTimers();boundary.request.mockReset();boundary.download.mockReset();boundary.send.mockReset();boundary.payloads=[];boundary.owner.user.email='owned@test'
  session.advance();session.authenticated=true;const pinia=createPinia();setActivePinia(pinia)
  boundary.request.mockResolvedValue([{accountId:1,email:'owned@test',name:'Owned'}])
  boundary.send.mockImplementation(async form=>{boundary.payloads.push(JSON.parse(JSON.stringify(form)));return [{emailId:8,subject:form.subject}]})
  writes=[];content='';const events=new Map()
  editor={on:(event,callback)=>events.set(event,callback),setContent:value=>{content=value;writes.push(value)},getContent:()=>content,focus:vi.fn(),destroy:vi.fn()}
  window.tinymce={init:config=>{config.setup(editor);events.get('init')?.()}}
  vi.stubGlobal('ElMessage',vi.fn(()=>({close:vi.fn()})));vi.stubGlobal('ElNotification',vi.fn())
  w=mount(Writer,{global:{plugins:[pinia,createI18n({legacy:false,locale:'en',messages:{en:{}},missingWarn:false,fallbackWarn:false})],components:{ElInputTag:Recipient,ElInput:Input,ElDropdown:Send},stubs:{Icon:true,ElDialog:true,ElSelect:true,ElOption:true,ElTable:true,ElTableColumn:true,ElButton:true,ElDropdownMenu:true,ElDropdownItem:true}}})
  useUiStore().writerRef=w.vm
})
afterEach(()=>{feed?.unmount();feed=null;w.unmount();delete window.tinymce;vi.unstubAllGlobals();vi.useRealTimers()})
async function quote(kind,message,check,options){const result=openLocalComposer(kind,message,check,options);result.catch(()=>{});await flushPromises();await vi.runOnlyPendingTimersAsync();await result;await flushPromises();return content}
function rendered(html){const node=document.createElement('template');node.innerHTML=html;return node.content}
const attachment={id:'9',filename:'original.bin',contentType:'application/octet-stream',size:7}
function originalStream(){return new ReadableStream({start(controller){controller.enqueue(Uint8Array.from([0,255,128,1,13,10,42]));controller.close()}})}
async function startFeed(){
  const mail=source({text:'Body',attachments:[attachment]})
  boundary.request.mockImplementation(async path=>path==='/unified/messages'?{items:[mail],nextCursor:null,sources:{local:'ready',external:'excluded'}}:path==='/account/list'?[{accountId:1,email:'owned@test',name:'Owned'}]:{message:mail})
  feed=mount(Unified,{global:{plugins:[getActivePinia()],provide:{[routerKey]:{push:vi.fn()}}}})
  await flushPromises();await feed.get('[data-message-ref]').trigger('click');await flushPromises()
  await feed.findAll('button').find(button=>button.text()==='转发').trigger('click');await flushPromises()
}

describe('real unified local bridge and rich writer',()=>{
  it('keeps imported HTML conservative through the actual TinyEditor setContent boundary',async()=>{
    const html='<p><strong>Kept formatting</strong></p><img src="https://tracker.test/pixel"><p style="background:u\\72l(https://tracker.test/css)">Visible</p><a href="jav&#x61;script:alert(1)">Bad link</a><svg onload="alert(1)"><foreignObject>bad</foreignObject></svg>'
    const result=await quote('forward',source({html}))
    expect(result).toContain('<strong>Kept formatting</strong>')
    const dom=rendered(result)
    expect(dom.querySelector('img,style,svg,iframe,[style],[onload]')).toBeNull()
    expect(result).not.toContain('tracker.test');expect(result).not.toContain('javascript:')
    expect(w.find('.send').isVisible()).toBe(true)
  })
  it('quotes literal text and hostile sender headers as visible text instead of HTML',async()=>{
    const text='Literal <img src="https://tracker.test/plain"> & <script>literal()</script>'
    const sender='Sender <sender@test><img src="https://tracker.test/header">'
    const result=await quote('reply',source({from:sender,text}))
    const dom=rendered(result)
    expect(dom.querySelector('img,script,svg')).toBeNull()
    expect(dom.textContent).toContain(text)
    expect(dom.textContent).toContain(sender)
  })
  it('forwards exact original binary bytes through the real rich writer into the legacy send payload',async()=>{
    const bytes=Uint8Array.from([0,255,128,1,13,10,42])
    boundary.download.mockResolvedValue(new ReadableStream({start(controller){controller.enqueue(bytes.slice(0,2));controller.enqueue(bytes.slice(2,5));controller.enqueue(bytes.slice(5));controller.close()}}))
    await quote('forward',source({text:'Body',attachments:[{id:'9',filename:'original.bin',contentType:'application/octet-stream',size:7}]}))
    expect(w.text()).toContain('original.bin')
    await w.get('[data-recipient]').setValue('recipient@test');await w.get('[data-send]').trigger('click');await flushPromises()
    expect(boundary.payloads).toHaveLength(1)
    expect(boundary.payloads[0]).toMatchObject({accountId:1,sendEmail:'owned@test',emailId:7,sendType:'forward',receiveEmail:['recipient@test'],attachments:[{filename:'original.bin',size:7,contentType:'application/octet-stream'}]})
    expect([...Buffer.from(boundary.payloads[0].attachments[0].content,'base64')]).toEqual([0,255,128,1,13,10,42])
    expect(boundary.download).toHaveBeenCalledWith(source().ref,'9',expect.objectContaining({signal:expect.any(AbortSignal)}))
  })
  it('retains the owned reply account/id and later intentional rich edits in the eventual original send',async()=>{
    await quote('reply',source({from:'Sender <sender@test>',html:'<p>Source</p>',attachments:[attachment]}))
    editor.setContent(content+'<p><em>User addition</em><img src="data:image/png;base64,AA=="></p>')
    await w.get('[data-send]').trigger('click');await flushPromises()
    expect(boundary.download).not.toHaveBeenCalled()
    expect(boundary.payloads[0]).toMatchObject({accountId:1,sendEmail:'owned@test',sendType:'reply',emailId:7,receiveEmail:['sender@test']})
    expect(boundary.payloads[0].content).toContain('<em>User addition</em>')
    expect(boundary.payloads[0].content).toContain('data:image/png;base64,AA==')
  })
  it('allows original plus newly selected local file bytes in the same legacy forward payload',async()=>{
    boundary.download.mockResolvedValue(originalStream());await quote('forward',source({text:'Body',attachments:[attachment]}))
    vi.useRealTimers()
    const create=document.createElement.bind(document);let picker
    const spy=vi.spyOn(document,'createElement').mockImplementation((tag,...args)=>{const node=create(tag,...args);if(tag==='input')picker=node;return node})
    await w.get('.att-add').trigger('click');spy.mockRestore()
    const adding=picker.onchange({target:{files:[new File([Uint8Array.from([11,0,254])],'new.bin',{type:'application/x-test'})]}})
    await adding;await flushPromises()
    expect(w.text()).toContain('new.bin')
    await w.get('[data-recipient]').setValue('recipient@test');await w.get('[data-send]').trigger('click');await flushPromises()
    expect(boundary.payloads[0].attachments.map(att=>[att.filename,[...Buffer.from(att.content,'base64')]])).toEqual([['original.bin',[0,255,128,1,13,10,42]],['new.bin',[11,0,254]]])
  })
  it('keeps the writer closed and reports a failed owned download instead of offering a body-only forward',async()=>{
    boundary.download.mockRejectedValue(Object.assign(new Error(),{code:'NOT_FOUND'}));await startFeed()
    expect(feed.get('[role="alert"]').text()).toContain('原附件或邮件读取失败')
    expect(feed.get('[role="alert"]').text()).toContain('NOT_FOUND')
    expect(w.find('.send').isVisible()).toBe(false);expect(boundary.send).not.toHaveBeenCalled()
  })
  it('offers visible cancellation and cancels the actual pending stream without opening a forward',async()=>{
    const cancel=vi.fn();boundary.download.mockResolvedValue(new ReadableStream({cancel}));await startFeed()
    await feed.get('[data-cancel-import]').trigger('click');await flushPromises()
    expect(cancel).toHaveBeenCalled();expect(feed.get('[role="alert"]').text()).toContain('已取消读取')
    expect(w.find('.send').isVisible()).toBe(false)
  })
  it('cancels a byte overrun and a truncated source before opening the real writer',async()=>{
    const cancel=vi.fn();boundary.download.mockResolvedValue(new ReadableStream({start(controller){controller.enqueue(Uint8Array.from([1,2,3,4]))},cancel}))
    await expect(quote('forward',source({text:'Body',attachments:[{...attachment,size:3}]}))).rejects.toMatchObject({code:'ATTACHMENT_SIZE_MISMATCH'})
    expect(cancel).toHaveBeenCalled();expect(w.find('.send').isVisible()).toBe(false)
    boundary.download.mockResolvedValue(new ReadableStream({start(controller){controller.enqueue(Uint8Array.from([1,2]));controller.close()}}))
    await expect(quote('forward',source({text:'Body',attachments:[attachment]}))).rejects.toMatchObject({code:'ATTACHMENT_SIZE_MISMATCH'})
    expect(w.find('.send').isVisible()).toBe(false)
  })
  it('rejects malformed metadata and the existing max-ten constraint before any download',async()=>{
    await expect(quote('forward',source({text:'Body',attachments:[{...attachment,size:'7'}]}))).rejects.toMatchObject({code:'INVALID_ATTACHMENT'})
    await expect(quote('forward',source({text:'Body',attachments:Array.from({length:11},(_,i)=>({...attachment,id:String(i+1)}))}))).rejects.toMatchObject({code:'ATTACHMENT_LIMIT'})
    expect(boundary.download).not.toHaveBeenCalled();expect(w.find('.send').isVisible()).toBe(false)
  })
  it('ignores old-owner bytes with the same numeric IDs and leaves a newly opened owner draft intact',async()=>{
    const cancel=vi.fn();boundary.download.mockResolvedValue(new ReadableStream({cancel}))
    const pending=openLocalComposer('forward',source({text:'Old private source',attachments:[attachment]}));pending.catch(()=>{})
    await flushPromises();session.advance();boundary.owner.user.email='new-owner@test'
    w.vm.openDraft({accountId:1,sendEmail:'new-owner@test',name:'New owner',subject:'New owner draft',content:'<p>New private draft</p>',receiveEmail:[],attachments:[]})
    await vi.runOnlyPendingTimersAsync();await flushPromises()
    await expect(pending).rejects.toMatchObject({code:'STALE_SESSION'})
    expect(cancel).toHaveBeenCalled();expect(content).toContain('New private draft');expect(w.text()).not.toContain('original.bin')
    expect(boundary.send).not.toHaveBeenCalled()
  })
  it('cancels obsolete source downloads when the selected message changes',async()=>{
    const cancel=vi.fn();boundary.download.mockResolvedValue(new ReadableStream({cancel}));await startFeed()
    const {useUnifiedStore}=await import('@/store/unified.js');useUnifiedStore().select('external','1');await flushPromises()
    expect(cancel).toHaveBeenCalled();expect(w.find('.send').isVisible()).toBe(false);expect(content).not.toContain('Body')
  })
  it('does not mix a same-number external reference into local forwarding',async()=>{
    await expect(quote('forward',source({ref:encodeSourceRef({source:'external',accountId:'1',id:'7'}),attachments:[attachment]}))).rejects.toMatchObject({code:'INVALID_REF'})
    expect(boundary.request).not.toHaveBeenCalled();expect(boundary.download).not.toHaveBeenCalled()
  })
  it('cancels a pending source import when the user opens another local draft',async()=>{
    const cancel=vi.fn();boundary.download.mockResolvedValue(new ReadableStream({cancel}));const pending=openLocalComposer('forward',source({text:'Obsolete body',attachments:[attachment]}));pending.catch(()=>{})
    await flushPromises();w.vm.openDraft({accountId:1,sendEmail:'owned@test',name:'Owner',subject:'New draft',content:'<strong>Keep new draft</strong>',receiveEmail:[],attachments:[]})
    await vi.runOnlyPendingTimersAsync();await flushPromises();await expect(pending).rejects.toMatchObject({code:'STALE_SESSION'})
    expect(cancel).toHaveBeenCalled();expect(content).toContain('Keep new draft')
  })
  it('rechecks exact encoded send size after later rich edits without submitting an oversized payload',async()=>{
    await quote('reply',source({text:'Small source'}));editor.setContent('x'.repeat(100_000_000))
    await w.get('[data-send]').trigger('click');await flushPromises()
    expect(boundary.send).not.toHaveBeenCalled();expect(w.get('[role="alert"]').text()).toContain('100MB');expect(w.find('.send').isVisible()).toBe(true)
  })
  it('does not offer partially transferred source attachments when a later attachment fails',async()=>{
    boundary.download.mockResolvedValueOnce(originalStream()).mockRejectedValueOnce(Object.assign(new Error(),{code:'NOT_FOUND'}))
    await expect(quote('forward',source({text:'Body',attachments:[attachment,{...attachment,id:'10',filename:'second.bin'}]}))).rejects.toMatchObject({code:'NOT_FOUND'})
    expect(boundary.download).toHaveBeenCalledTimes(2);expect(w.find('.send').isVisible()).toBe(false);expect(boundary.send).not.toHaveBeenCalled()
  })
  it('cancels a late owned download response before reading or opening a now-obsolete source',async()=>{
    let resolve;const cancel=vi.fn();boundary.download.mockImplementation(()=>new Promise(r=>resolve=r))
    const controller=new AbortController(),pending=openLocalComposer('forward',source({text:'Obsolete',attachments:[attachment]}),()=>{},{signal:controller.signal});pending.catch(()=>{})
    await flushPromises();controller.abort();resolve(new ReadableStream({cancel}));await flushPromises()
    await expect(pending).rejects.toThrow();expect(cancel).toHaveBeenCalled();expect(w.find('.send').isVisible()).toBe(false)
  })
  it('does not let a delayed imported send result reopen or reset a newer owner draft',async()=>{
    await quote('reply',source({text:'Old source'}));let resolve
    boundary.send.mockImplementation(form=>{boundary.payloads.push(JSON.parse(JSON.stringify(form)));return new Promise(r=>resolve=r)})
    await w.get('[data-send]').trigger('click');await flushPromises();session.advance();boundary.owner.user.email='new-owner@test'
    w.vm.openDraft({accountId:1,sendEmail:'new-owner@test',name:'New owner',subject:'New draft',content:'<p>Keep new owner</p>',receiveEmail:[],attachments:[]})
    await vi.runOnlyPendingTimersAsync();await flushPromises();resolve([{emailId:8,subject:'Old sent'}]);await flushPromises()
    expect(content).toContain('Keep new owner');expect(boundary.send).toHaveBeenCalledTimes(1);expect(w.find('.send').isVisible()).toBe(true)
  })
  it('keeps a zero-byte original attachment in the actual legacy forward payload',async()=>{
    boundary.download.mockResolvedValue(new ReadableStream({start(controller){controller.close()}}));await quote('forward',source({text:'Body',attachments:[{...attachment,size:0}]}))
    await w.get('[data-recipient]').setValue('recipient@test');await w.get('[data-send]').trigger('click');await flushPromises()
    expect(boundary.payloads[0].attachments).toEqual([{filename:'original.bin',contentType:'application/octet-stream',size:0,content:''}])
  })
})
