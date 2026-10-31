// Synthetic upstream only. Describe the old 36 MiB MIME wire image without
// retaining a giant Buffer/base64 string/line array outside the measured app.
const header = Buffer.from('From: fixture@example.test\r\nDate: Thu, 01 Jan 2020 00:00:00 +0000\r\nSubject: largest\r\nMIME-Version: 1.0\r\nContent-Type: multipart/mixed; boundary=large\r\n\r\n--large\r\nContent-Type: text/plain\r\n\r\nfixture\r\n--large\r\nContent-Type: application/octet-stream\r\nContent-Disposition: attachment; filename=largest.bin\r\nContent-Transfer-Encoding: base64\r\n\r\n');
const line = Buffer.from('A'.repeat(76) + '\r\n');
const footer = Buffer.from('\r\n--large--\r\n');

export function createZeroMime({ bodyBytes = 25 * 1024 * 1024, totalBytes = 36 * 1024 * 1024 } = {}) {
 if (!Number.isSafeInteger(bodyBytes) || bodyBytes < 0 || bodyBytes > 25 * 1024 * 1024 || !Number.isSafeInteger(totalBytes) || totalBytes < 0 || totalBytes > 36 * 1024 * 1024) throw new RangeError('MIME_SIZE');
 const encoded = Math.ceil(bodyBytes / 3) * 4;
 const fullLines = encoded ? Math.floor((encoded - 1) / 76) : 0;
 const tailLength = encoded - fullLines * 76;
 const padding = bodyBytes % 3 ? 3 - bodyBytes % 3 : 0;
 const tail = Buffer.from('A'.repeat(tailLength - padding) + '='.repeat(padding));
 const size = header.length + fullLines * 78 + tail.length + footer.length;
 if (size > totalBytes) throw new RangeError('MIME_SIZE');
 const segments = [
  { bytes: header, length: header.length }, { pattern: line, length: fullLines * 78 },
  { bytes: tail, length: tail.length }, { bytes: footer, length: footer.length },
  { pattern: Buffer.from(' '), length: totalBytes - size }
 ];
 return Object.freeze({
  length: totalBytes,
  subarray(start = 0, end = totalBytes) {
   if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start) throw new RangeError('MIME_RANGE');
   start = Math.min(start, totalBytes); end = Math.min(end, totalBytes);
   if (end - start > 65536) throw new RangeError('SLICE_LIMIT');
   const result = Buffer.alloc(end - start); let offset = 0;
   for (const segment of segments) {
    const from = Math.max(start, offset), to = Math.min(end, offset + segment.length);
    if (to > from) {
     const relative = from - offset, target = from - start;
     if (segment.bytes) segment.bytes.copy(result, target, relative, relative + to - from);
     else {
      const phase = relative % segment.pattern.length;
      const pattern = phase ? Buffer.concat([segment.pattern.subarray(phase), segment.pattern.subarray(0, phase)]) : segment.pattern;
      result.fill(pattern, target, target + to - from);
     }
    }
    offset += segment.length;
   }
   return result;
  }
 });
}
