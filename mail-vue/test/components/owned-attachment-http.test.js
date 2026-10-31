// @vitest-environment node
import {describe,it,expect,vi,beforeAll,beforeEach,afterAll} from 'vitest'
const boundary=vi.hoisted(()=>({fetch:vi.fn(),replace:vi.fn()}))
vi.mock('@/router/index.js',()=>({default:{replace:boundary.replace}}))
vi.mock('@/i18n/index.js',()=>({default:{global:{t:key=>key}}}))
vi.mock('@/store/setting.js',()=>({useSettingStore:()=>({lang:'en'})}))
let downloadAttachment,session
beforeAll(async()=>{
  vi.stubGlobal('fetch',boundary.fetch)
  vi.stubGlobal('localStorage',{getItem:()=>null,setItem:()=>{},removeItem:()=>{}})
  const http=(await import('@/axios/index.js')).default;http.defaults.baseURL='https://fixture.example.test/api'
  downloadAttachment=(await import('@/request/unified.js')).downloadAttachment
  session=(await import('@/auth/session.js')).session
})
beforeEach(()=>{boundary.fetch.mockReset();boundary.replace.mockReset();session.advance();session.authenticated=true})
afterAll(()=>vi.unstubAllGlobals())
describe('owned binary HTTP consumer',()=>{
  it('uses the same cookie/session-fenced Axios boundary and returns original streamed bytes without JSON decoding',async()=>{
    boundary.fetch.mockResolvedValue(new Response(Uint8Array.from([0,255,128,1,13,10,42]),{headers:{'Content-Type':'application/octet-stream'}}))
    const stream=await downloadAttachment('local-ref','9',{signal:new AbortController().signal}),reader=stream.getReader()
    expect([...(await reader.read()).value]).toEqual([0,255,128,1,13,10,42])
    expect((await reader.read()).done).toBe(true)
    expect(boundary.fetch.mock.calls[0][0].url).toBe('https://fixture.example.test/api/unified/messages/local-ref/attachments/9')
    expect(boundary.fetch.mock.calls[0][0].credentials).toBe('include')
  })
  it('rejects a delayed old-owner binary 401 before it can reset the next owner session',async()=>{
    let resolve;boundary.fetch.mockImplementation(()=>new Promise(r=>resolve=r))
    const old=downloadAttachment('old-owner-ref','9');old.catch(()=>{});await new Promise(r=>setTimeout(r,0))
    session.advance();session.authenticated=true;session.csrfToken='new-session'
    resolve(new Response('{"error":{"code":"UNAUTHORIZED"}}',{status:401}))
    await expect(old).rejects.toMatchObject({code:'STALE_SESSION'})
    expect(session.authenticated).toBe(true);expect(session.csrfToken).toBe('new-session');expect(boundary.replace).not.toHaveBeenCalled()
  })
  it('cancels a failed owned response stream and surfaces a safe status code',async()=>{
    const cancel=vi.fn();boundary.fetch.mockResolvedValue(new Response(new ReadableStream({cancel}),{status:404}))
    await expect(downloadAttachment('missing-source','9')).rejects.toMatchObject({code:'NOT_FOUND'})
    expect(cancel).toHaveBeenCalled()
  })
})
