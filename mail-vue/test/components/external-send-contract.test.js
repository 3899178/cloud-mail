import {it,expect,vi,afterEach} from 'vitest'
import {mount,flushPromises} from '@vue/test-utils'
import {createPinia,setActivePinia} from 'pinia'
import {File as NodeFile} from 'node:buffer'
import {Readable} from 'node:stream'
import Composer from '@/components/unified-mail/ExternalComposer.vue'
import {useUnifiedStore} from '@/store/unified.js'
import {session} from '@/auth/session.js'
import {createActions} from '../../../services/mail-sync/src/send/actions.mjs'

const boundary=vi.hoisted(()=>({request:vi.fn()}))
vi.mock('@/request/unified.js',()=>boundary)
vi.mock('@/store/user.js',()=>({useUserStore:()=>({user:{email:'owner@example.test'}})}))
let wrapper
afterEach(()=>{wrapper?.unmount();wrapper=null;vi.clearAllMocks()})

it.each([false,true])('delivers a new composer message through actual backend validation (uploaded attachment=%s)',async withUpload=>{
 const sender={id:'owned-account',address:'sender@example.test',provider:'school',status:'active'}
 const deliveries=[],handles=[],records=new Map(),validationErrors=[]
 const actions=createActions({
  store:{accounts:{get:(owner,id)=>{expect([owner,id]).toEqual(['owner',sender.id]);return sender}},operations:{
   create:(_owner,value)=>{const result={id:'one-send',...value};records.set(result.id,result);return result},
   update:(_owner,id,value)=>{const result={...records.get(id),...value};records.set(id,result);return result}
  }},
  lifecycle:{run:(_owner,_account,task)=>task({check(){},current:()=>true})},
  uploads:{take:async(_owner,_account,ids)=>{handles.push(...ids);return ids.map(()=>({filename:'new.bin',contentType:'application/octet-stream',content:Readable.from([Buffer.from([0,255,42])])}))}},
  registry:{open:async()=>({send:async message=>{const attachments=[];for(const item of message.attachments){const chunks=[];for await(const chunk of item.content)chunks.push(chunk);attachments.push([...Buffer.concat(chunks)])}deliveries.push({...message,attachments})},close:async()=>{}})}
 })
 boundary.request.mockImplementation(async(path,options)=>{
  if(path==='/external/uploads')return {upload:{id:'owned-upload',capability:'synthetic-only-capability'}}
  if(path==='/external/uploads/owned-upload')return {upload:{id:'owned-upload',state:'ready'}}
  if(path!=='/unified/messages/send')throw Error('UNEXPECTED_TEST_ROUTE')
  // Exercise the real action validator. Only repositories and final transport
  // are synthetic; a permissive HTTP mock must not hide contract rejection.
  try{return {operation:await actions.execute({ownerId:'owner',...options.body})}}
  catch(error){validationErrors.push(error.code||error.name);throw error}
 })
 const pinia=createPinia();setActivePinia(pinia);session.advance();session.authenticated=true
 wrapper=mount(Composer,{global:{plugins:[pinia]}});useUnifiedStore().accounts=[sender];wrapper.vm.open();await flushPromises()
 await wrapper.get('input[placeholder]').setValue('recipient@example.test');await wrapper.get('textarea').setValue('A new controlled message')
 if(withUpload){const input=wrapper.get('input[type=file]');Object.defineProperty(input.element,'files',{value:[new NodeFile([Uint8Array.from([0,255,42])],'new.bin',{type:'application/octet-stream'})]});await input.trigger('change');await flushPromises();expect(wrapper.text()).toContain('附件就绪')}
 await wrapper.get('form').trigger('submit');await flushPromises()
 expect(validationErrors).toEqual([])
 expect(deliveries).toHaveLength(1)
 expect(deliveries[0]).toMatchObject({from:sender.address,to:['recipient@example.test'],text:'A new controlled message',attachments:withUpload?[[0,255,42]]:[]})
 expect(handles).toEqual(withUpload?['owned-upload']:[])
 expect(wrapper.text()).toContain('操作成功')
 await wrapper.get('form').trigger('submit');await flushPromises();expect(deliveries).toHaveLength(1)
})
