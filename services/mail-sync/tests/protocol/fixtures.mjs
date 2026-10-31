import { createServer, createSecureContext, TLSSocket } from 'node:tls';
import { createServer as createTcpServer } from 'node:net';
import { generate } from 'selfsigned';

let certificate;
async function tlsFixture(t, handler) {
  certificate ||= generate([{ name: 'commonName', value: 'fixture.test' }], { keyType: 'ec', curve: 'P-256', algorithm: 'sha256', extensions: [{ name: 'basicConstraints', cA: true }, { name: 'subjectAltName', altNames: [{ type: 2, value: 'fixture.test' }] }] });
  const pems = await certificate; const sockets = new Set();
  const server = createServer({ key: pems.private, cert: pems.cert }, socket => { sockets.add(socket); socket.on('error', () => {}); socket.on('close', () => sockets.delete(socket)); handler(socket); });
  await new Promise(resolve => server.listen(0, t.listenHost || '127.0.0.1', resolve));
  t.after(() => { for (const socket of sockets) socket.destroy(); server.close(); });
  return { port: server.address().port, ca: pems.cert };
}
const quote = value => JSON.stringify(String(value));
export const wireMime = (id, text = 'Original body') => Buffer.from(`Message-ID: <${id}@example.test>\r\nFrom: sender@example.test\r\nTo: user@example.test\r\nSubject: ${id}\r\nMIME-Version: 1.0\r\nContent-Type: multipart/mixed; boundary="wire"\r\n\r\n--wire\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${text}\r\n--wire\r\nContent-Type: application/octet-stream\r\nContent-Disposition: attachment; filename="test.bin"\r\nContent-Transfer-Encoding: base64\r\n\r\nAAEC/w==\r\n--wire--\r\n`);
export async function imapFixture(t) {
  const state = { validity: '100', uidNext: new Map(), condstore: false, modseq: 1, metadataRows: 0, egressBytes: 0, metadataEgressBytes: 0, authFailure: false, folders: new Map([['INBOX', []], ['Archive', []], ['Rules', []], ['Junk', []], ['Trash', []], ['Sent', []], ['Drafts', []]]), commands: [], connections: 0 };
  const endpoint = await tlsFixture(t, socket => {
    state.connections++; let buffer = ''; let selected = 'INBOX';
    const write = socket.write.bind(socket);
    socket.write = (bytes, ...args) => { state.egressBytes += Buffer.byteLength(bytes); return write(bytes, ...args); };
    socket.write('* OK fixture ready\r\n');
    socket.on('data', data => {
      buffer += data.toString();
      while (buffer.includes('\r\n')) {
        const end = buffer.indexOf('\r\n'); const line = buffer.slice(0, end); buffer = buffer.slice(end + 2);
        state.commands.push(line.replace(/LOGIN .*/, 'LOGIN [redacted]'));
        const [tag, rawCommand] = line.split(' '); const command = rawCommand?.toUpperCase();
        if (state.maxCommandBytes && Buffer.byteLength(line + '\r\n') > state.maxCommandBytes) {
          socket.write(`${tag} BAD command exceeds fixture limit\r\n`);
          continue;
        }
        const ok = () => socket.write(`${tag} OK completed\r\n`);
        if (command === 'CAPABILITY') { socket.write(`* CAPABILITY IMAP4rev1 UIDPLUS MOVE${state.condstore ? ' ENABLE CONDSTORE' : ''}${state.gmail ? ' X-GM-EXT-1' : ''}\r\n`); ok(); }
        else if (command === 'ENABLE') { socket.write('* ENABLED CONDSTORE\r\n'); ok(); }
        else if (command === 'LOGIN') socket.write(`${tag} ${state.authFailure ? 'NO [AUTHENTICATIONFAILED] rejected' : 'OK authenticated'}\r\n`);
        else if (command === 'LIST' || command === 'LSUB') {
          if (/LIST "" ""$/.test(line)) { socket.write('* LIST (\\Noselect) "/" ""\r\n'); ok(); continue; }
          for (const folder of state.folders.keys()) {
            const special = ({ Archive: '\\Archive', AllMail: '\\All', Junk: '\\Junk', Trash: '\\Trash', Sent: '\\Sent', Drafts: '\\Drafts' })[folder] || '';
            socket.write(`* ${command} (${special}) "/" ${quote(folder)}\r\n`);
          }
          ok();
        } else if (command === 'SELECT' || command === 'EXAMINE') {
          const match = line.match(/(?:SELECT|EXAMINE) ("(?:[^"\\]|\\.)*"|[^ ]+)/i); selected = match[1].startsWith('"') ? JSON.parse(match[1]) : match[1];
          const messages = state.folders.get(selected) || [];
          const mailboxKey = JSON.stringify([state.validity, selected]);
          const uidNext = Math.max(state.uidNext.get(mailboxKey) || 1, Math.max(0, ...messages.map(m => Number(m.uid))) + 1);
          state.uidNext.set(mailboxKey, uidNext);
          if (state.condstore) socket.write(`* OK [HIGHESTMODSEQ ${state.modseq}] modseq\r\n`);
          socket.write(`* FLAGS (\\Seen \\Draft)\r\n* ${messages.length} EXISTS\r\n* OK [UIDVALIDITY ${state.validity}] validity\r\n* OK [UIDNEXT ${uidNext}] next\r\n${tag} OK [READ-WRITE] selected\r\n`);
        } else if (command === 'UID' && / SEARCH /i.test(line)) {
          socket.write(`* SEARCH ${(state.folders.get(selected) || []).filter(m => m.uid !== state.omitSearchUid).map(m => m.uid).join(' ')}\r\n`); ok();
        } else if (command === 'FETCH' || (command === 'UID' && / UID FETCH |^\S+ UID FETCH /i.test(line))) {
          const isUid = command === 'UID'; const range = line.split(' ')[isUid ? 3 : 2];
          const messages = state.folders.get(selected) || [];
          for (const [index, m] of messages.entries()) {
            if (m.uid === state.omitFetchUid || (m.uid === state.omitEnvelopeUid && /ENVELOPE/i.test(line))) continue;
            const number = isUid ? Number(m.uid) : index + 1;
            const max = isUid ? Math.max(0, ...messages.map(m => Number(m.uid))) : messages.length;
            if (!range.split(',').some(part => { const [a, b = a] = part.split(':').map(v => v === '*' ? max : Number(v)); return number >= Math.min(a, b) && number <= Math.max(a, b); })) continue;
            const since = line.match(/CHANGEDSINCE (\d+)/); if (since && (m.modseq || 1) <= Number(since[1])) continue;
            if (/ENVELOPE/i.test(line)) state.metadataRows++;
            const flags = m.unread ? '' : '\\Seen';
            const parts = [`UID ${m.uid}`, `FLAGS (${flags})`, `INTERNALDATE "${m.internalDate || '27-Oct-2026 12:00:00 +0000'}"`, `RFC822.SIZE ${m.raw.length}`, `ENVELOPE (NIL ${quote(m.subject)} ((NIL NIL "sender" "example.test")) NIL NIL NIL NIL NIL NIL ${quote(`<${m.key}@example.test>`)})`];
            if (!/ENVELOPE/i.test(line)) parts.splice(2);
            if (state.gmail && /X-GM-MSGID/i.test(line)) parts.push(`X-GM-MSGID ${m.emailId || m.uid}`);
            if (state.gmail && /X-GM-LABELS/i.test(line)) {
              // Gmail omits the selected mailbox's own label from FETCH.
              const selectedLabel = selected === 'INBOX' ? '\\Inbox' : null;
              parts.push(`X-GM-LABELS (${(m.labels || []).filter(label => label !== selectedLabel).map(quote).join(' ')})`);
            }
            const partial = line.match(/BODY\.PEEK\[\](?:<(\d+)\.(\d+)>)?/i);
            if (partial) {
              const start = Number(partial[1] || 0); const chunk = m.raw.subarray(start, start + Number(partial[2] || m.raw.length));
              socket.write(`* ${index + 1} FETCH (${parts.join(' ')} BODY[]<${start}> {${chunk.length}}\r\n`); socket.write(chunk); socket.write(')\r\n');
            } else { const response = `* ${index + 1} FETCH (${parts.join(' ')})\r\n`; if (/ENVELOPE/i.test(line)) state.metadataEgressBytes += Buffer.byteLength(response); socket.write(response); }
          }
          ok();
        } else if (command === 'UID' && / STORE /i.test(line)) {
          const uid = Number(line.split(' ')[3]); const unread = /-FLAGS/.test(line); const messages = state.folders.get(selected) || [];
          const m = messages.find(m => Number(m.uid) === uid); if (m) m.unread = unread; ok();
        } else if (command === 'UID' && / MOVE /i.test(line)) {
          const uid = Number(line.split(' ')[3]); const raw = line.split(' ').slice(4).join(' '); const destination = raw.startsWith('"') ? JSON.parse(raw) : raw;
          const messages = state.folders.get(selected) || []; const index = messages.findIndex(m => Number(m.uid) === uid);
          if (!state.folders.has(destination)) throw new Error(`Unknown fixture mailbox: ${line}`);
          if (index >= 0) { const [m] = messages.splice(index, 1); state.folders.get(destination).push(m); socket.write(`* ${index + 1} EXPUNGE\r\n`); } ok();
        } else if (command === 'LOGOUT') { socket.end(`* BYE closing\r\n${tag} OK logout\r\n`); }
        else if (['NOOP', 'CLOSE', 'ID', 'NAMESPACE'].includes(command)) ok();
        else socket.write(`${tag} BAD unsupported\r\n`);
      }
    });
  });
  return { ...endpoint, state };
}
export async function smtpFixture(t) {
  const state = { uncertain: false, received: [], authFailure: false };
  const endpoint = await tlsFixture(t, socket => {
    let buffer = ''; let dataMode = false; let message = [];
    socket.write('220 fixture ESMTP\r\n');
    socket.on('data', data => {
      buffer += data.toString();
      while (buffer.includes('\r\n')) {
        const end = buffer.indexOf('\r\n'); const line = buffer.slice(0, end); buffer = buffer.slice(end + 2);
        if (dataMode) {
          if (line === '.') { state.received.push(message.join('\r\n')); message = []; dataMode = false; if (state.uncertain) socket.destroy(); else socket.write('250 accepted\r\n'); }
          else message.push(line.startsWith('..') ? line.slice(1) : line);
        } else if (/^EHLO /.test(line)) socket.write('250-fixture\r\n250 AUTH PLAIN LOGIN\r\n');
        else if (/^AUTH /.test(line)) socket.write(state.authFailure ? '535 auth rejected\r\n' : '235 authenticated\r\n');
        else if (/^(MAIL FROM|RCPT TO)/.test(line)) socket.write('250 ok\r\n');
        else if (line === 'DATA') { dataMode = true; socket.write('354 send data\r\n'); }
        else if (line === 'QUIT') socket.end('221 goodbye\r\n');
        else socket.write('250 ok\r\n');
      }
    });
  });
  return { ...endpoint, state };
}
export async function starttlsFixture(t, { advertise = true, refuse = false } = {}) {
  // Share only ephemeral certificate material with implicit-TLS fixtures, never a real key.
  certificate ||= generate([{ name: 'commonName', value: 'fixture.test' }], { keyType: 'ec', curve: 'P-256', algorithm: 'sha256', extensions: [{ name: 'basicConstraints', cA: true }, { name: 'subjectAltName', altNames: [{ type: 2, value: 'fixture.test' }] }] });
  const pems = await certificate; const secureContext = createSecureContext({ key: pems.private, cert: pems.cert });
  const sockets = new Set(); const state = { plaintextAuth: 0, tlsAuth: 0, starttls: 0, received: [] };
  function dialogue(socket, secure) {
    sockets.add(socket); socket.on('error', () => {}); socket.on('close', () => sockets.delete(socket));
    let buffer = ''; let dataMode = false; const message = [];
    const data = chunk => {
      buffer += chunk.toString();
      while (buffer.includes('\r\n')) {
        const end = buffer.indexOf('\r\n'); const line = buffer.slice(0, end); buffer = buffer.slice(end + 2);
        if (dataMode) { if (line === '.') { state.received.push(message.join('\r\n')); dataMode = false; socket.write('250 accepted\r\n'); } else message.push(line); }
        else if (/^EHLO /.test(line)) socket.write(`250-fixture\r\n${!secure && advertise ? '250-STARTTLS\r\n' : ''}250 AUTH PLAIN LOGIN\r\n`);
        else if (line === 'STARTTLS') {
          state.starttls++;
          if (refuse) socket.write('454 TLS unavailable\r\n');
          else {
            socket.removeListener('data', data); buffer = '';
            socket.write('220 Begin TLS\r\n', () => dialogue(new TLSSocket(socket, { isServer: true, secureContext }), true));
          }
        } else if (/^AUTH /.test(line)) { if (secure) state.tlsAuth++; else state.plaintextAuth++; socket.write(secure ? '235 authenticated\r\n' : '530 TLS required\r\n'); }
        else if (/^(MAIL FROM|RCPT TO)/.test(line)) socket.write('250 ok\r\n');
        else if (line === 'DATA') { dataMode = true; socket.write('354 send data\r\n'); }
        else if (line === 'QUIT') socket.end('221 goodbye\r\n');
        else socket.write('250 ok\r\n');
      }
    };
    socket.on('data', data); if (!secure) socket.write('220 fixture ESMTP\r\n');
  }
  const server = createTcpServer(socket => dialogue(socket, false));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { for (const socket of sockets) socket.destroy(); server.close(); });
  return { port: server.address().port, ca: pems.cert, state };
}
