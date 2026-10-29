import {describe,it,expect} from 'vitest';
import emailService from '../src/service/email-service';

describe('original local attachment conversion',()=>{
 it('preserves valid empty base64, buffers and typed arrays in each original send adapter',async()=>{
  for(const content of ['',new ArrayBuffer(0),new Uint8Array(0)]){
   const input=[{filename:'empty.bin',contentType:'application/octet-stream',content}];
   expect(await emailService.toResendAttachments(input)).toEqual([{...input[0],content:''}]);
   const converted=await emailService.toArrayBufferAttachments(input);
   expect(converted).toHaveLength(1);
   expect(converted[0].filename).toBe('empty.bin');
   expect(converted[0].content).toBeInstanceOf(ArrayBuffer);
   expect(converted[0].content.byteLength).toBe(0);
  }
 });
 it('omits absent and unsupported content rather than interpreting it as an empty file',async()=>{
  const input=[undefined,null,false,0,{},[]].map(content=>({filename:'invalid.bin',content}));
  expect(await emailService.toResendAttachments(input)).toEqual([]);
  expect(await emailService.toArrayBufferAttachments(input)).toEqual([]);
 });
 it('retains original nonempty binary bytes and rejects malformed base64',async()=>{
  const input=[{filename:'original.bin',content:'AP+AAQ0KKg=='}];
  expect((await emailService.toResendAttachments(input))[0].content).toBe(input[0].content);
  expect([...new Uint8Array((await emailService.toArrayBufferAttachments(input))[0].content)]).toEqual([0,255,128,1,13,10,42]);
  await expect(emailService.toArrayBufferAttachments([{content:'%%%'}])).rejects.toThrow();
 });
});
