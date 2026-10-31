import test from 'node:test';
import assert from 'node:assert/strict';
import { createZeroMime } from '../fixtures/lazy-mime.mjs';

const header = 'From: fixture@example.test\r\nDate: Thu, 01 Jan 2020 00:00:00 +0000\r\nSubject: largest\r\nMIME-Version: 1.0\r\nContent-Type: multipart/mixed; boundary=large\r\n\r\n--large\r\nContent-Type: text/plain\r\n\r\nfixture\r\n--large\r\nContent-Type: application/octet-stream\r\nContent-Disposition: attachment; filename=largest.bin\r\nContent-Transfer-Encoding: base64\r\n\r\n';
function reference(bodyBytes, totalBytes) {
 const encoded = Buffer.alloc(bodyBytes).toString('base64');
 const wrapped = (encoded.match(/.{1,76}/g) || []).join('\r\n');
 const mime = Buffer.from(header + wrapped + '\r\n--large--\r\n');
 return Buffer.concat([mime, Buffer.alloc(totalBytes - mime.length, 0x20)]);
}

test('virtual MIME windows equal original zero attachment encoding across line and padding boundaries', () => {
 for (const bytes of [0, 1, 2, 3, 56, 57, 58, 113, 114, 115, 4097]) {
  const actual = createZeroMime({ bodyBytes: bytes, totalBytes: 8192 });
  const expected = reference(bytes, 8192);
  assert.equal(actual.length, 8192);
  for (let offset = 0; offset < expected.length; offset += 37) {
   assert.deepEqual(actual.subarray(offset, offset + 37), expected.subarray(offset, offset + 37));
  }
 }
});

test('36 MiB fixture exposes only bounded slices and clamps reads at EOF', () => {
 const fixture = createZeroMime();
 assert.equal(fixture.length, 36 * 1024 * 1024);
 assert.equal(Buffer.isBuffer(fixture), false);
 assert.throws(() => fixture.subarray(0, 65537), /SLICE_LIMIT/);
 assert.equal(fixture.subarray(fixture.length - 5, fixture.length + 65536).toString(), '     ');
 assert.equal(fixture.subarray(fixture.length, fixture.length + 10).length, 0);
 assert.deepEqual(fixture.subarray(0, 64), Buffer.from(header).subarray(0, 64));
 assert.equal(fixture.subarray(fixture.length - 65536, fixture.length).length, 65536);
});

test('invalid size/ranges fail before requesting or allocating an unbounded body', () => {
 for (const input of [{ bodyBytes: -1 }, { bodyBytes: 25 * 1024 * 1024 + 1 }, { bodyBytes: 5, totalBytes: 1 }, { totalBytes: Infinity }]) {
  assert.throws(() => createZeroMime(input), /MIME_SIZE/);
 }
 const fixture = createZeroMime();
 for (const range of [[-1, 1], [2, 1], [0, Infinity], [0.5, 3]]) assert.throws(() => fixture.subarray(...range), /MIME_RANGE/);
});
