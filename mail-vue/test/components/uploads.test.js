import {describe,it,expect,vi,afterEach} from 'vitest'
import {mount,flushPromises} from '@vue/test-utils'
import {createPinia,setActivePinia} from 'pinia'
import {File as NodeFile} from 'node:buffer'
import Composer from '@/components/unified-mail/ExternalComposer.vue'
import {stageFile} from '@/utils/external-upload.js'
import {useUnifiedStore} from '@/store/unified.js'
import {session} from '@/auth/session.js'
const api=vi.hoisted(()=>({request:vi.fn()}))
vi.mock('@/request/unified.js',()=>api)
afterEach(()=>{vi.clearAllMocks()})
function setup(){const pinia=createPinia();setActivePinia(pinia);session.advance();session.authenticated=true;const w=mount(Composer,{global:{plugins:[pinia]}});useUnifiedStore().accounts=[{id:'account-1',address:'sender@test',provider:'qq',status:'active'}];w.vm.open();return w}
describe('streamed external attachments',()=>{
  it('hashes selected bytes incrementally and uploads a File without base64, then sends the one-use handle',async()=>{
    api.request.mockImplementation(async(path,options)=>path==='/external/uploads'?{upload:{id:'staged-1',capability:'private-capability',size:3,sha256:options.body.sha256,expiresAt:100}}:path==='/external/uploads/staged-1'?{upload:{id:'staged-1',state:'ready'}}:{operation:{state:'succeeded'}})
    const w=setup();await flushPromises()
    const file=new NodeFile(['abc'],'letter.txt',{type:'text/plain'})
    const input=w.get('input[type="file"]');Object.defineProperty(input.element,'files',{value:[file],configurable:true})
    await input.trigger('change');await flushPromises()
    expect(w.text()).toContain('附件就绪')
    const metadata=api.request.mock.calls.find(([p])=>p==='/external/uploads')[1].body
    expect(metadata).toEqual({accountId:'account-1',filename:'letter.txt',contentType:'text/plain',size:3,sha256:'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'})
    expect(api.request.mock.calls.find(([p,o])=>p==='/external/uploads/staged-1'&&o.method==='PUT')[1].body).toBe(file)
    expect(w.html()).not.toContain('private-capability');expect(localStorage.getItem('private-capability')).toBeNull()
    await w.get('input[placeholder]').setValue('recipient@test');await w.get('form').trigger('submit');await flushPromises()
    expect(api.request.mock.calls.find(([p])=>p==='/unified/messages/send')[1].body.message.uploadIds).toEqual(['staged-1'])
    w.unmount()
  })
  it('releases a ready handle when the user removes its attachment',async()=>{
    api.request.mockImplementation(async(path,options)=>path==='/external/uploads'?{upload:{id:'cancel-1',capability:'secret'}}:options.method==='PUT'?{upload:{id:'cancel-1',state:'ready'}}:{removed:true})
    const w=setup();await flushPromises();const input=w.get('input[type="file"]');Object.defineProperty(input.element,'files',{value:[new NodeFile(['bytes'],'file.bin')]})
    await input.trigger('change');await flushPromises();await w.findAll('button').find(b=>b.text()==='移除').trigger('click');await flushPromises()
    expect(w.text()).not.toContain('file.bin')
    expect(api.request).toHaveBeenCalledWith('/external/uploads/cancel-1',expect.objectContaining({method:'DELETE'}));w.unmount()
  })
  it('bounds hash reads to 64 KiB and rejects oversized files before staging',async()=>{
    const file=new NodeFile([new Uint8Array(150000)],'large.bin'),slice=vi.spyOn(file,'slice'),controller=new AbortController()
    api.request.mockImplementation(async(path,options)=>options.method==='POST'?{upload:{id:'bounded',capability:'secret'}}:{upload:{state:'ready'}})
    await stageFile(file,'account',{signal:controller.signal,check:()=>{},onProgress:()=>{},onHandle:()=>{}})
    expect(slice.mock.calls.map(([start,end])=>end-start)).toEqual([65536,65536,65536])
    const before=api.request.mock.calls.length
    await expect(stageFile({size:25*1024*1024+1},'account',{signal:controller.signal,check:()=>{},onProgress:()=>{},onHandle:()=>{}})).rejects.toMatchObject({code:'PAYLOAD_TOO_LARGE'})
    expect(api.request.mock.calls).toHaveLength(before)
  })
  it('cancels a handle even when its creation response arrives after the user cancelled',async()=>{
    let resolve
    api.request.mockImplementation((path,options)=>options.method==='POST'?new Promise(r=>resolve=r):Promise.resolve({removed:true}))
    const w=setup();await flushPromises();const input=w.get('input[type="file"]');Object.defineProperty(input.element,'files',{value:[new NodeFile(['cancel me'],'late.bin')]})
    await input.trigger('change');await flushPromises();await w.findAll('button').find(b=>b.text()==='取消').trigger('click');await flushPromises()
    resolve({upload:{id:'late-handle',capability:'secret'}});await flushPromises()
    expect(api.request).toHaveBeenCalledWith('/external/uploads/late-handle',expect.objectContaining({method:'DELETE'}))
    expect(api.request.mock.calls.some(([,options])=>options.method==='PUT')).toBe(false);w.unmount()
  })
})
