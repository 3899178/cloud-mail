import { MailParser } from 'mailparser';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fail } from '../../../../shared/unified-mail/index.mjs';

export async function parseMime(source, { stage, signal }) {
  const parser = new MailParser({ skipHtmlToText: true, skipTextToHtml: true, skipImageLinks: true });
  let rawBytes = 0; let headers; let text = ''; let html = ''; const attachments = [];
  parser.on('headers', value => { headers = value; });
  const bounded = new Transform({ transform(chunk, encoding, done) {
    rawBytes += chunk.length;
    if (rawBytes > 36 * 1024 * 1024) { try { fail('PAYLOAD_TOO_LARGE'); } catch (e) { done(e); } }
    else done(null, chunk);
  } });
  const input = pipeline(source, bounded, parser, { signal });
  // Attach rejection handler immediately while attachment substreams are consumed.
  input.catch(() => {});
  try {
    for await (const part of parser) {
      if (part.type === 'attachment') {
        if (attachments.length >= 100) fail('PAYLOAD_TOO_LARGE');
        try { attachments.push({ filename: part.filename || 'attachment', contentType: part.contentType || 'application/octet-stream', staged: await stage(part.content) }); }
        finally { part.release(); }
      } else if (part.type === 'text') {
        text = part.text || ''; html = part.html || '';
        if (Buffer.byteLength(text) > 2 * 1024 * 1024 || Buffer.byteLength(html) > 2 * 1024 * 1024) fail('PAYLOAD_TOO_LARGE');
      }
    }
    await input;
    return { subject: headers?.get('subject') || '', from: headers?.get('from')?.text || '', text, html, attachments,
      async cleanup() { for (const attachment of attachments) await attachment.staged.cleanup(); } };
  } catch (error) { parser.destroy(); source.destroy?.(); await input.catch(() => {}); for (const attachment of attachments) await attachment.staged.cleanup(); throw error; }
}
