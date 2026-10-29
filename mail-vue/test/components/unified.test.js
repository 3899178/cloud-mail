import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import SafeBody from '@/components/unified-mail/SafeBody.vue'
import Sidebar from '@/layout/mail-sidebar/index.vue'
import Unified from '@/views/unified/index.vue'
import Binding from '@/components/unified-mail/ExternalBinding.vue'
import Composer from '@/components/unified-mail/ExternalComposer.vue'
import History from '@/components/unified-mail/OperationHistory.vue'
import {useUiStore} from '@/store/ui.js'
import { session } from '@/auth/session.js'
import { useUnifiedStore } from '@/store/unified.js'

const api = vi.hoisted(() => ({ request: vi.fn(), attachmentUrl: (ref,id) => `/api/unified/messages/${encodeURIComponent(ref)}/attachments/${encodeURIComponent(id)}` }))
const owner=vi.hoisted(()=>({store:null}))
vi.mock('@/request/unified.js', () => api)
vi.mock('@/layout/account/index.vue', () => ({ default: { template: '<div>Local operations</div>' } }))
vi.mock('@/layout/aside/index.vue', () => ({ default: { template: '<div>Legacy navigation</div>' } }))
vi.mock('vue-router', () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn() }), useRoute: () => ({ query: {}, meta: {} }) }))
vi.mock('@/perm/perm.js', () => ({ hasPerm: () => true }))
vi.mock('@/store/user.js', async () => {const {reactive}=await import('vue');owner.store=reactive({user:{email:'owner@test',account:{accountId:1,email:'owner@test'}}});return {useUserStore:()=>owner.store}})
vi.mock('@/store/setting.js', () => ({ useSettingStore: () => ({lang:'zh',settings:{}}) }))

const wrappers = []
beforeEach(()=>{api.request.mockReset();owner.store.user.email='owner@test'})
function render(component, options = {}) {
  const pinia = createPinia(); setActivePinia(pinia)
  session.advance(); session.authenticated = true
  const w = mount(component, {global:{plugins:[pinia]}, ...options}); wrappers.push(w); return w
}
afterEach(() => { wrappers.splice(0).forEach(w => w.unmount()); vi.useRealTimers() })
const message = (ref, source='external') => ({ref,source,accountId:'1',receivedAt:10,subject:'Test mail',from:'sender@test',unread:true,folder:'Archive'})
const page = items => ({items,nextCursor:null,incomplete:false,resetRequired:false,sources:{local:'ready',external:'ready'}})
const account = {id:'1',provider:'qq',address:'qq@test',status:'needs-auth',errorCode:'AUTH_REQUIRED'}

describe('mailbox sidebar', () => {
  it('keeps a phone rail present while full mailbox names can expand', async () => {
    api.request.mockResolvedValue({accounts:[account]})
    const w=render(Sidebar)
    expect(w.find('[aria-label="邮箱导航"]').exists()).toBe(true)
    expect(w.find('[data-mailbox-panel]').exists()).toBe(true)
    await w.get('[aria-label="展开邮箱列表"]').trigger('click')
    expect(w.get('[aria-label="展开邮箱列表"]').attributes('aria-expanded')).toBe('true')
    await flushPromises()
    expect(w.text()).toContain('qq@test')
    await w.get('[data-select-all]').trigger('click')
    expect(useUnifiedStore().selection).toEqual({source:'all',accountId:null})
  })
})
describe('unified mailbox', () => {
  it('routes read/delete/download using the exact opaque source ref and waits for confirmation', async () => {
    const ref='external-opaque-1'
    api.request.mockImplementation(async (path,options) => {
      if(path==='/unified/messages') return page([message(ref),message('local-opaque-1','cloud-mail')])
      if(path.endsWith('/read')) return {operation:{id:'op',state:'queued',kind:'mark-read'}}
      if(path==='/external/operations/op') return {operation:{id:'op',state:'succeeded'}}
      if(path.endsWith('/trash')) return {operation:{state:'failed',errorCode:'PROVIDER_UNAVAILABLE'}}
      return {message:{...message(ref),text:'Body',attachments:[{id:'1',filename:'original.bin',size:9}]}}
    })
    const w=render(Unified); await flushPromises()
    await w.get('[data-message-ref="external-opaque-1"]').trigger('click'); await flushPromises()
    expect(w.get('a[download]').attributes('href')).toBe('/api/unified/messages/external-opaque-1/attachments/1')
    await w.get('[data-mark-read]').trigger('click'); await flushPromises()
    expect(useUnifiedStore().detail.unread).toBe(true)
    await w.get('[data-check-operation]').trigger('click'); await flushPromises()
    expect(useUnifiedStore().detail.unread).toBe(false)
    await w.get('[data-trash]').trigger('click'); await w.get('[data-confirm-trash]').trigger('click'); await flushPromises()
    expect(w.text()).toContain('PROVIDER_UNAVAILABLE')
    expect(useUnifiedStore().items).toHaveLength(2)
    expect(api.request).toHaveBeenCalledWith('/unified/messages/external-opaque-1/trash',expect.anything())
  })
  it('shows incomplete source recovery and discards the unusable cursor', async () => {
    api.request.mockResolvedValueOnce({...page([message('partial')]),incomplete:true,resetRequired:true,nextCursor:null,sources:{local:'ready',external:'unavailable'}}).mockResolvedValue(page([message('recovered')]))
    const w=render(Unified); await flushPromises()
    expect(w.text()).toContain('不完整')
    await w.get('[data-refresh]').trigger('click'); await flushPromises()
    expect(w.text()).toContain('Test mail')
    expect(w.find('[data-message-ref="partial"]').exists()).toBe(false)
    expect(api.request.mock.calls[1][1].query.cursor).toBeUndefined()
  })
  it('shows local index initialization instead of an empty success and retries with a bound', async () => {
    vi.useFakeTimers()
    api.request.mockRejectedValue(Object.assign(new Error(),{code:'LOCAL_INDEX_NOT_READY'}))
    const w=render(Unified); await flushPromises()
    expect(w.text()).toContain('初始化')
    await vi.advanceTimersByTimeAsync(31000); await flushPromises()
    expect(api.request.mock.calls.length).toBeLessThanOrEqual(5)
    expect(w.text()).not.toContain('暂无邮件')
  })
  it('does not restore old owner mail after a session change', async () => {
    let resolve; api.request.mockReturnValue(new Promise(r=>resolve=r))
    const w=render(Unified); session.advance()
    resolve(page([message('old-owner')])); await flushPromises()
    expect(w.find('[data-message-ref="old-owner"]').exists()).toBe(false)
  })
  it('keeps same numeric IDs in different sources separate and uses the selected source sender', async()=>{
    const local=message('local-1','cloud-mail'),external=message('external-1')
    api.request.mockImplementation(async path=>path==='/unified/messages'?page([local,external]):path.endsWith('/read')?{operation:{state:'succeeded'}}:{message:{...external,text:'External body',attachments:[]}})
    const w=render(Unified);await flushPromises()
    useUnifiedStore().localAccounts=[{accountId:1,address:'local-alias@test'}];useUnifiedStore().accounts=[{...account,address:'external-alias@test'}];await flushPromises()
    expect(w.findAll('[data-message-ref]')).toHaveLength(2)
    expect(w.get('[data-message-ref="local-1"]').text()).toContain('local-alias@test')
    expect(w.get('[data-message-ref="external-1"]').text()).toContain('external-alias@test')
    expect(w.get('[data-message-ref="local-1"]').text()).not.toContain('本地邮箱 1')
    await w.get('[data-message-ref="external-1"]').trigger('click');await flushPromises()
    useUiStore().externalComposerRef={open:vi.fn()}
    const reply=w.findAll('button').find(b=>b.text()==='回复')
    await reply.trigger('click')
    expect(useUiStore().externalComposerRef.open).toHaveBeenCalledWith(expect.objectContaining({ref:'external-1',source:'external',accountId:'1'}),'reply')
    await w.get('[data-mark-read]').trigger('click');await flushPromises()
    expect(api.request).toHaveBeenCalledWith('/unified/messages/external-1/read',expect.objectContaining({body:{unread:false}}))
    expect(storeRow('local-1').unread).toBe(true);expect(storeRow('external-1').unread).toBe(false)
  })
  it('discards a late body after source selection changes even when the owner did not change',async()=>{
    let resolve
    api.request.mockImplementation(path=>path==='/unified/messages'?Promise.resolve(page([message('external-old')])):new Promise(r=>resolve=r))
    const w=render(Unified);await flushPromises();await w.get('[data-message-ref="external-old"]').trigger('click')
    useUnifiedStore().select('external','other-account');await flushPromises()
    resolve({message:{...message('external-old'),text:'Private old body',attachments:[]}});await flushPromises()
    expect(w.text()).not.toContain('Private old body')
    expect(useUnifiedStore().detail).toBeNull()
  })
  it('rejects old owner account and operation results before they write real state',async()=>{
    let resolveAccounts,resolveOperation
    api.request.mockImplementation(path=>path==='/unified/messages'?Promise.resolve(page([message('owned')])):path==='/external/accounts'?new Promise(r=>resolveAccounts=r):path.endsWith('/read')?new Promise(r=>resolveOperation=r):Promise.resolve({message:{...message('owned'),text:'body'}}))
    const w=render(Unified);await flushPromises();const store=useUnifiedStore();store.loadAccounts()
    await w.get('[data-message-ref="owned"]').trigger('click');await flushPromises()
    await w.get('[data-mark-read]').trigger('click')
    session.advance();store.$reset()
    resolveAccounts({accounts:[account]});resolveOperation({operation:{id:'old-op',state:'succeeded'}});await flushPromises()
    expect(store.accounts).toEqual([]);expect(store.operation).toBeNull();expect(store.detail).toBeNull()
  })
})
describe('external binding', () => {
  it('binds a manual school mailbox with explicit encrypted IMAP and mandatory STARTTLS SMTP settings',async()=>{
    const school={id:'school-1',provider:'school',address:'student@school.test',status:'pending',errorCode:null}
    api.request.mockImplementation(async path=>path==='/external/accounts'?{accounts:[]}:{account:school})
    const w=render(Binding);await flushPromises();await w.findAll('button').find(b=>b.text().includes('绑定邮箱')).trigger('click')
    await w.findAll('select')[0].setValue('school');await w.get('input[type="email"]').setValue('student@school.test');await w.get('input[type="password"]').setValue('app-pass')
    const fields=w.get('fieldset').findAll('input');await fields[0].setValue('imap.school.test');await fields[2].setValue('smtp.school.test');await fields[3].setValue('587');await w.get('fieldset select').setValue('starttls')
    api.request.mockImplementation(async(path,options)=>path==='/external/accounts'&&options?.method!=='POST'?{accounts:[school]}:{account:school})
    await w.get('form').trigger('submit');await flushPromises()
    expect(api.request).toHaveBeenCalledWith('/external/accounts',expect.objectContaining({method:'POST',body:{provider:'school',address:'student@school.test',credentials:{authType:'password',password:'app-pass',config:{imap:{host:'imap.school.test',port:993,secure:true},smtp:{host:'smtp.school.test',port:587,requireTLS:true}}}}}))
    expect(w.get('.bound-account').text()).toContain('等待验证')
  })
  it('refuses an off-provider OAuth consent URL and keeps the account unverified',async()=>{
    const gmail={...account,provider:'gmail',status:'pending',errorCode:null}
    api.request.mockResolvedValue({accounts:[gmail]});const w=render(Binding);await flushPromises();await w.get('[data-reauth="1"]').trigger('click')
    api.request.mockImplementation(async path=>path.endsWith('/oauth/start')?{authorizationUrl:'https://evil.test/steal'}:{account:gmail})
    await w.get('form').trigger('submit');await flushPromises()
    expect(w.get('[role="alert"]').text()).toBe('INVALID_AUTHORIZATION_URL')
    expect(api.request.mock.calls.some(([path])=>path.endsWith('/connect'))).toBe(false)
    expect(w.get('.bound-account').text()).toContain('等待验证')
  })
  it('clears credentials and closes the active form when the owner changes without remounting',async()=>{
    api.request.mockResolvedValue({accounts:[account]});const w=render(Binding);await flushPromises()
    await w.get('[data-reauth="1"]').trigger('click');await w.get('input[type="password"]').setValue('old-owner-secret')
    owner.store.user.email='next-owner@test';await flushPromises()
    expect(w.find('input[type="password"]').exists()).toBe(false)
  })
  it('offers password re-auth without persisting credentials or declaring pending connected', async () => {
    api.request.mockResolvedValue({accounts:[account]})
    const storage=vi.spyOn(Storage.prototype,'setItem')
    const w=render(Binding); await flushPromises()
    await w.get('[data-reauth="1"]').trigger('click')
    await w.get('input[type="password"]').setValue('private-app-password')
    api.request.mockImplementation(async path=>path==='/external/accounts'?{accounts:[{...account,status:'pending',errorCode:null}]}:{account:{...account,status:'pending',errorCode:null}})
    await w.get('form').trigger('submit'); await flushPromises()
    expect(w.text()).toContain('等待验证')
    expect(w.find('input[type="password"]').exists()).toBe(false)
    expect(storage.mock.calls.flat().join()).not.toContain('private-app-password')
    expect(api.request).toHaveBeenCalledWith('/external/accounts/1/credentials',expect.objectContaining({method:'PUT',body:expect.objectContaining({password:'private-app-password'})}))
    storage.mockRestore()
  })
  it('keeps Proton ready pending until actual connection and supports successive MFA challenges',async()=>{
    const proton={...account,provider:'proton',status:'pending'}
    api.request.mockResolvedValue({accounts:[proton]})
    const w=render(Binding);await flushPromises();await w.get('[data-reauth="1"]').trigger('click')
    await w.findAll('input[type="password"]')[0].setValue('proton-private')
    api.request.mockImplementation(async path=>path==='/external/accounts'?{accounts:[proton]}:path.endsWith('/start')?{step:'totp',state:'one-use-state',expiresIn:300}:path.endsWith('/complete')?{step:'ready'}:{account:proton})
    await w.get('form').trigger('submit');await flushPromises()
    expect(w.find('input[type="password"]').exists()).toBe(false)
    await w.get('input[autocomplete="one-time-code"]').setValue('123456')
    await w.get('form').trigger('submit');await flushPromises()
    expect(w.get('.bound-account').text()).toContain('等待验证');expect(w.get('.bound-account').text()).not.toContain('已同步')
    expect(api.request).toHaveBeenCalledWith('/external/accounts/1/proton/complete',expect.objectContaining({body:{state:'one-use-state',code:'123456'}}))
    expect(w.html()).not.toContain('one-use-state')
  })
  it('does not restore old owner form notices or provider status after reauthentication finishes late',async()=>{
    let resolve
    api.request.mockResolvedValue({accounts:[account]})
    const w=render(Binding);await flushPromises();await w.get('[data-reauth="1"]').trigger('click');await w.get('input[type="password"]').setValue('private')
    api.request.mockImplementation(()=>new Promise(r=>resolve=r))
    await w.get('form').trigger('submit');session.advance();useUnifiedStore().$reset();w.unmount();wrappers.splice(wrappers.indexOf(w),1)
    resolve({account:{...account,status:'active'}});await flushPromises()
    expect(useUnifiedStore().accounts).toEqual([])
    expect(api.request.mock.calls.filter(([p])=>p.endsWith('/connect'))).toHaveLength(0)
  })
})
describe('external composer',()=>{
  it('replies to the actual mailbox address when From contains a display name and quotes',async()=>{
    api.request.mockResolvedValue({operation:{state:'succeeded'}})
    const w=render(Composer);useUnifiedStore().accounts=[account];w.vm.open({...message('reply-source'),from:'"Smith, Alice" <alice@example.test>',text:'original'},'reply');await flushPromises()
    expect(w.get('input[placeholder]').element.value).toBe('alice@example.test')
    await w.get('textarea').setValue('Reply body');await w.get('form').trigger('submit');await flushPromises()
    expect(api.request.mock.calls.find(([path])=>path==='/unified/messages/send')[1].body).toMatchObject({source:'external',accountId:'1',kind:'reply',ref:'reply-source',message:{to:['alice@example.test']}})
  })
  it('preserves visible HTML-only source text when forwarding',async()=>{
    const w=render(Composer);useUnifiedStore().accounts=[account];w.vm.open({...message('html-source'),text:'',html:'<p>Original HTML body</p><script>evil()</script>'},'forward');await flushPromises()
    expect(w.get('textarea').element.value).toContain('Original HTML body')
    expect(w.get('textarea').element.value).not.toContain('evil()')
  })
  it('polls queued sends to a real terminal result without resubmitting the message',async()=>{
    vi.useFakeTimers();api.request.mockImplementation(async path=>path==='/unified/messages/send'?{operation:{id:'queued-send',state:'queued'}}:{operation:{id:'queued-send',state:'succeeded'}})
    const w=render(Composer);useUnifiedStore().accounts=[account];w.vm.open();await flushPromises();await w.get('input[placeholder]').setValue('recipient@test');await w.get('form').trigger('submit');await flushPromises()
    expect(w.text()).toContain('尚未完成');await vi.advanceTimersByTimeAsync(2100);await flushPromises();expect(w.text()).toContain('操作成功')
    expect(api.request.mock.calls.filter(([path])=>path==='/unified/messages/send')).toHaveLength(1)
  })
  it('clears an old owner active external draft on owner switch without a remount',async()=>{
    const w=render(Composer);useUnifiedStore().accounts=[account];w.vm.open();await flushPromises()
    await w.get('textarea').setValue('Old owner draft')
    owner.store.user.email='next-owner@test';await flushPromises()
    expect(w.find('[role="dialog"]').exists()).toBe(false)
  })
  it('sends from the selected external account/ref with source attachment IDs and never retries uncertainty',async()=>{
    api.request.mockResolvedValue({operation:{id:'send-op',state:'uncertain',errorCode:'SEND_UNCERTAIN'}})
    const w=render(Composer),store=useUnifiedStore();store.accounts=[{...account,status:'active'}]
    w.vm.open({...message('actual-ref'),text:'Original text',attachments:[{id:'original-att',filename:'original.bin',size:7}]},'forward');await flushPromises()
    await w.get('input[placeholder]').setValue('recipient@example.test')
    await w.get('form').trigger('submit');await flushPromises()
    expect(w.text()).toContain('发送状态不确定')
    await w.get('form').trigger('submit');await flushPromises()
    const sends=api.request.mock.calls.filter(([path])=>path==='/unified/messages/send')
    expect(sends).toHaveLength(1)
    expect(sends[0][1].body).toMatchObject({source:'external',accountId:'1',kind:'forward',ref:'actual-ref',message:{attachmentIds:['original-att'],uploadIds:[],to:['recipient@example.test']}})
  })
  it('ignores delayed send completion after owner changes',async()=>{
    let resolve;api.request.mockImplementation(()=>new Promise(r=>resolve=r))
    const w=render(Composer);useUnifiedStore().accounts=[account];w.vm.open();await flushPromises()
    await w.get('input[placeholder]').setValue('recipient@example.test');await w.get('form').trigger('submit')
    session.advance();w.unmount();wrappers.splice(wrappers.indexOf(w),1)
    resolve({operation:{state:'succeeded'}});await flushPromises()
    expect(useUnifiedStore().operation).toBeNull()
  })
})
describe('external operation recovery',()=>{
  it('shows the original uncertain ledger outcome without a resend action',async()=>{
    api.request.mockResolvedValue({operations:[{id:'lost-response',accountId:'1',kind:'send',state:'uncertain',errorCode:'SEND_UNCERTAIN',createdAt:1}]})
    const w=render(History);await flushPromises();expect(w.text()).toContain('发送状态不确定');expect(w.text()).toContain('SEND_UNCERTAIN')
    expect(w.findAll('button')).toHaveLength(1);expect(w.get('button').text()).toBe('查询最新结果')
  })
  it('ignores a late history response after the owner changes',async()=>{
    let resolve;api.request.mockImplementation(()=>new Promise(r=>resolve=r));const w=render(History);session.advance();owner.store.user.email='next-owner@test'
    resolve({operations:[{id:'old',accountId:'private-old-account',kind:'send',state:'succeeded',createdAt:1}]});await flushPromises()
    expect(w.text()).not.toContain('private-old-account')
  })
})
function storeRow(ref){return useUnifiedStore().items.find(row=>row.ref===ref)}
describe('safe external body', () => {
  it('blocks executable markup, styles and remote requests at the final rendered boundary', () => {
    const w=render(SafeBody,{props:{html:'<style>body{background:url(https://tracker.test)}</style><script>alert(1)</script><svg onload="alert(1)"></svg><img src="https://tracker.test/a" onerror="alert(1)"><a href="javascript:alert(1)">unsafe</a><p style="background:url(https://tracker.test)">Hello</p>'}})
    expect(w.html()).toContain('Hello')
    expect(w.find('script,style,svg,img,[style],[onerror],[onload]').exists()).toBe(false)
    expect(w.html()).not.toContain('javascript:')
    expect(w.html()).not.toContain('tracker.test')
  })
  it('blocks entity-obfuscated JavaScript, CSS escapes, SVG foreign content and data URLs',()=>{
    const w=render(SafeBody,{props:{html:'<a href="jav&#x61;script:alert(1)">bad</a><p style="background-image:u\\72l(https://escaped-tracker.test)">Visible</p><svg><foreignObject><iframe srcdoc="script"></iframe></foreignObject></svg><math href="javascript:alert(1)"></math><img src="data:image/svg+xml,attack"><a href="https://safe.example.test/path">good</a>'}})
    expect(w.text()).toContain('Visible');expect(w.find('svg,math,iframe,img,[style]').exists()).toBe(false)
    expect(w.html()).not.toContain('javascript:');expect(w.html()).not.toContain('escaped-tracker.test');expect(w.find('a[href="https://safe.example.test/path"]').exists()).toBe(true)
  })
})
