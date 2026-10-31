// Synthetic 3MiB attachment used by the real 2MiB tmpfs exhaustion scenario.
export function* quotaMime() {
  yield 'Content-Type: multipart/mixed; boundary=q\r\n\r\n--q\r\nContent-Type: application/octet-stream\r\nContent-Disposition: attachment; filename=quota.bin\r\nContent-Transfer-Encoding: base64\r\n\r\n';
  // 57 raw bytes encode to a standard 76-character MIME line. Keep each
  // source chunk bounded. Decoder buffering can still coalesce chunks; the
  // production MIME adapter independently bounds decoded staging chunks.
  const block=57*256;
  for(let offset=0;offset<3*1024*1024;offset+=block){
    const encoded=Buffer.alloc(Math.min(block,3*1024*1024-offset)).toString('base64');
    yield encoded.match(/.{1,76}/g).join('\r\n')+'\r\n';
  }
  yield '\r\n--q--\r\n';
}
