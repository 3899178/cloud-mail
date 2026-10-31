import { fail } from '../../../../shared/unified-mail/index.mjs';

export function createDownloads({ store, lifecycle }) {
  let active = 0;
  return {
    async response({ ownerId, ref, attachment, signal, headers }) {
      const message = store.messages.get(ownerId, ref);
      if (active >= 2) fail('BUSY');
      const lease = lifecycle.enter(ownerId, message.accountId, { signal, allowPaused: true }); active++;
      let source; let iterator; let controller; let closing;
      const cleanup = () => {
        if (!closing) closing = (async () => {
          lease.signal.removeEventListener('abort', abort);
          try { source?.destroy(); await iterator?.return?.().catch(() => {}); }
          finally { active--; lease.release(); }
        })();
        return closing;
      };
      const abort = () => { controller?.error(lease.signal.reason); cleanup().catch(() => {}); };
      lease.signal.addEventListener('abort', abort, { once: true });
      try {
        lease.check();
        source = store.attachments.stream(ownerId, ref, attachment.id, { signal: lease.signal }); source.on('error', () => {}); iterator = source[Symbol.asyncIterator]();
        // Verify integrity before HTTP headers, retaining only the first bounded chunk.
        let first = await iterator.next(); lease.check();
        const body = new ReadableStream({
          start(value) { controller = value; },
          async pull(value) {
            try {
              lease.check(); const next = first || await iterator.next(); first = null;
              if (next.done) { await cleanup(); value.close(); return; }
              if (!(next.value instanceof Uint8Array) || next.value.byteLength > 65536) fail('INVALID_INPUT');
              value.enqueue(next.value);
            } catch (error) { await cleanup(); value.error(error); }
          },
          cancel: cleanup,
        }, { highWaterMark: 0 });
        return new Response(body, { headers });
      } catch (error) { await cleanup(); throw error; }
    },
  };
}
