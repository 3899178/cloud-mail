import {describe,it,expect} from 'vitest'
import {legacyJsonBytes,sourceAttachmentAdmission,assertLegacyPayload,LEGACY_REQUEST_BUDGET} from '@/utils/local-source-attachments.js'
const meta=size=>({id:'9',filename:'original.bin',contentType:'application/octet-stream',size})
describe('original local encoded request budget',()=>{
  it('counts exactly like UTF8 JSON including escaped controls, Unicode and unpaired surrogates without serializing large bodies',()=>{
    const payload={subject:'猫🙂 "quote" \\ \n\u0000\ud800',list:[undefined,null,true,false,0,1e21,-0],holes:Array(2),attachments:[{filename:'原件.bin',content:'AP+AAQ0KKg==',size:7}]}
    expect(legacyJsonBytes(payload)).toBe(new TextEncoder().encode(JSON.stringify(payload)).byteLength)
  })
  it('admits a valid original attachment larger than 25MiB under the same zone request limit',()=>{
    const actual=sourceAttachmentAdmission({subject:'Source',attachments:[]},[meta(26*1024*1024)])
    expect(actual[0].size).toBe(27_262_976)
  })
  it('accounts for exact base64 expansion and JSON envelope at the 100MB boundary',()=>{
    const size=74_999_850,attachment=meta(size),payload={subject:'',attachments:[]}
    const empty={subject:'',attachments:[{filename:'original.bin',contentType:'application/octet-stream',size,content:''}]}
    const overhead=new TextEncoder().encode(JSON.stringify(empty)).byteLength
    const padding=100_000_000-overhead-4*Math.ceil(size/3)
    expect(padding).toBeGreaterThan(0)
    expect(()=>sourceAttachmentAdmission({...payload,subject:'x'.repeat(padding)},[attachment])).not.toThrow()
    expect(()=>sourceAttachmentAdmission({...payload,subject:'x'.repeat(padding+1)},[attachment])).toThrow('PAYLOAD_TOO_LARGE')
    expect(LEGACY_REQUEST_BUDGET).toBe(100_000_000)
  })
  it('rejects metadata overflow and excessive later attachments before the transport is called',()=>{
    expect(()=>sourceAttachmentAdmission({attachments:[]},[meta(75_000_000)])).toThrow('PAYLOAD_TOO_LARGE')
    expect(()=>assertLegacyPayload({attachments:Array(11).fill({content:'AA=='})})).toThrow('ATTACHMENT_LIMIT')
  })
})
