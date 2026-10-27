# Mail sync foundation contract (Task 1)

This service adds isolated external-mail storage. It does not change Cloud Mail's existing Worker, D1, messages, or APIs. Task 1 does not connect to any provider, authorize an account, send mail, or expose a binding endpoint. `pending` means no provider verification has occurred. A future adapter must establish the post-binding baseline and report real connection state.

## Runtime and configuration

Node **24.18.0+**, built-in `node:sqlite`, Hono 4.12.16 and the locked Node server adapter. Run `npm ci` and `npm test` inside `services/mail-sync`. `npm start` binds **127.0.0.1:3211** by default. `PORT` changes the port. `MAIL_SYNC_DATA_DIR` defaults to `.data` and contains `mail.sqlite` and `attachments/`.

`MAIL_SYNC_MASTER_KEY` and `MAIL_SYNC_GATEWAY_KEY` are separate 32-byte keys encoded as 64 hex characters, supplied through private deployment configuration. No default keys exist. Never publish these variables, provider credentials, device tokens, plaintext exports or database backups. Only the entry point reads environment configuration. SIGINT/SIGTERM close the HTTP listener and SQLite store. Deployment must supply the approved aggregate 320 MiB limit; Task 1 does **not** validate 50 live connections or the final memory envelope.

## Pure shared module

Worker consumers import **only** `shared/unified-mail/index.mjs`; it has no Node or storage imports. APIs:

- `encodeSourceRef({source,accountId,id}) -> string`, `decodeSourceRef(ref) -> {source,accountId,id}`. Sources are `external` and `cloud-mail`. The versioned canonical base64url ref is an opaque identifier, **not authorization or encryption**. Account identifiers match `[A-Za-z0-9_-]{1,128}`. Source IDs are nonempty, <=512 UTF-8 bytes and contain no control characters. Prefix `mr1_`; malformed/noncanonical/oversized refs throw `INVALID_REF`.
- `encodeCursor({receivedAt,ref}) -> string`, `decodeCursor(cursor) -> {receivedAt,ref}`. Nonnegative integer UTC milliseconds plus source ref; prefix `mc1_`. Malformed cursors throw `INVALID_CURSOR`. The keyset order is `receivedAt DESC, ref DESC` using SQLite BINARY string order. A cursor is opaque but unsigned; it grants no access. Future Worker merging must use this same order and apply tenant checks to each source.
- `await signGatewayAssertion({key,ownerId,method,path,body='',now=Date.now(),nonce=random}) -> token`. `key` is a 32-byte Uint8Array, owner is the **already authenticated** Cloud Mail owner converted to a string identifier, method uppercase, and path is the exact upstream pathname plus raw query string. Body is the exact transmitted string/Uint8Array/ArrayBuffer, empty for GET. Never sign a browser-supplied owner ID. Header: `X-Gateway-Assertion: <token>`.
- `await verifyGatewayAssertion({key,token,method,path,body=emptyBytes,now=Date.now(),consumeNonce}) -> {ownerId}`. HMAC-SHA256 covers canonical claims `{v:1,ownerId,iat,exp,nonce,method,path,bodyHash}`; bodyHash is base64url SHA-256 of the body. Lifetime exactly 60,000ms; expiry is exclusive, future clock skew <=5,000ms. Nonces are >=16 characters. `consumeNonce(ownerId,nonce,expiresAt)` must atomically persist freshness and return **true** (or a Promise of true); all other outcomes fail closed. Consume only after signature/scope/time/body verification. Do not retry a request with its old assertion; sign a fresh nonce. Verification failures all throw `UNAUTHORIZED`.
- `MailError` has only the safe `code` as its message; `fail(code)` throws it. `identifier(value,code='INVALID_INPUT')` validates an identifier and returns it. These are shared validation helpers, not a source of trusted owner identity.

## SQLite store

`openStore({dbPath,dataDir,masterKey,clock=Date.now}) -> store` from `src/core/store.mjs` is Node-only. `dbPath` is a filesystem path, `dataDir` is the dedicated attachment root, `masterKey` is a 32-byte Uint8Array, and `clock()` returns UTC milliseconds. The service copies its key. SQLite uses WAL, FULL synchronous commits, foreign keys, a 5-second busy timeout and an 8MiB page cache. Schema version is 1; newer databases are rejected. `store.close()` is idempotent and closes owned SQLite/key resources. No raw database handle is exported.

All repository methods below are **synchronous** except attachment `put/read`. Owners are explicit mandatory first arguments. Missing or foreign-owned resources both throw `NOT_FOUND`; invalid input throws `INVALID_INPUT` unless a ref/cursor code is specified. Every ID lookup/mutation includes the owner predicate. Repositories are privileged **service internals**, not objects to serialize to clients. Never accept HTTP input as a trusted owner.

### Accounts and credentials

- `accounts.create(owner,{id=randomUUID(),provider,address}) -> Account`. Provider: `imap|gmail|outlook|proton|qq|icloud|163|126|yeah|school`. Address <=320 bytes, ID is owner-local. Duplicate ID throws `CONFLICT`. Initial status is `pending`.
- `accounts.get(owner,id) -> Account`; `accounts.list(owner) -> Account[]` in creation/ID order.
- `accounts.setStatus(owner,id,status,errorCode=null) -> Account`. Status: `pending|connecting|active|paused|needs-auth|error`. Only an adapter with observed evidence may report `active`.
- `accounts.remove(owner,id) -> undefined`. Removes the account's confined attachment directory, then cascades SQLite account data. Devices are owner-level and remain. Filesystem failure prevents database removal. Filesystem and SQLite are not a cross-resource transaction; a database failure after filesystem removal requires adapter reconciliation.
- `credentials.set(owner,accountId,kind,value) -> undefined`; `credentials.get(owner,accountId,kind) -> plaintextString`. Kind is an identifier, plaintext is 1..16,384 UTF-8 bytes. These two methods are **adapter-only**: credentials are write-only at the HTTP/DTO boundary. AES-256-GCM uses random 12-byte IVs, 128-bit tags, AAD `JSON.stringify(['mail-sync-v1',owner,accountId,kind])`. Wrong key/tampered/swapped ciphertext throws `CREDENTIAL_UNAVAILABLE`. Ciphertext never appears in account, message or other public DTOs.

`Account = {id,provider,address,status,errorCode,createdAt}`. Safe persisted error codes: `AUTH_REQUIRED|PROVIDER_TIMEOUT|PROVIDER_UNAVAILABLE|RATE_LIMITED|STORAGE_FULL|SYNC_FAILED|SEND_UNCERTAIN`, or null. Raw provider errors are never stored as error DTOs. Adapters must not put credentials in display addresses, message metadata or checkpoints.

### Messages and checkpoints

- `messages.ingest(owner,accountId,{folder,folderKind='normal',checkpoint,messages}) -> {inserted,checkpoint}`. A **single SQLite transaction** inserts a batch and advances the folder checkpoint, including an empty batch. Any validation/write failure rolls everything back. Source ID uniqueness is per owner/account and duplicates preserve the first ingested content. The adapter must choose stable provider source IDs, perform later state reconciliation separately, and never use Proton bridge UIDs as stable IDs.
- Folder <=1,024 bytes, admitted folder kinds: `normal|inbox|archive|rule`; spam/trash/drafts/sent fail validation. Providers must resolve special-use folders correctly. A default normal kind does not detect provider special-use flags by itself.
- Message input: `{sourceId,receivedAt,subject='',from='',text='',html='',unread}`; `receivedAt` nonnegative integer ms and `unread` boolean. Subject/from <=8,192 bytes each, text/html <=2MiB each, combined batch bodies <=8MiB, <=100 messages per batch. The batch's `folder` controls stored folder; caller message `folder` is ignored. Input is normalized by explicit field selection.
- Checkpoint: `{cursor,uidValidity?,baselineAt?}`. Cursor may be empty and <=8,192 bytes; uidValidity is a nonempty string <=128 bytes; baselineAt is integer ms. Unknown fields are discarded. Provider adapters own baseline/no-history and UIDVALIDITY recovery semantics; no provider cursor is invented here.
- `checkpoints.get(owner,accountId,folder) -> checkpoint|null`. There is deliberately no independent checkpoint setter; use atomic ingestion, including an empty batch.
- `messages.list(owner,{limit=50,cursor?,accountId?}={}) -> {items:MessageSummary[],nextCursor:string|null}`. Limit integer 1..100; optional account filter is checked for ownership. No body bytes are loaded for list queries.
- `messages.get(owner,ref) -> MessageDetail`. This store accepts `external` refs only; original Cloud Mail refs remain for the existing source adapter.

`MessageSummary = {ref,accountId,source:'external',receivedAt,subject,from,unread,folder}`. `MessageDetail` additionally contains `{text,html,attachments:Attachment[]}`. HTML is **untrusted provider content**; future rendering must sanitize it and isolate remote content. Task 1 neither renders nor claims to sanitize email HTML.

### Operations

- `operations.create(owner,{accountId,ref=null,kind}) -> Operation`. Kind: `mark-read|mark-unread|delete|send|reply|forward`; ref, if present, must belong to the owner and account. Initial state `queued`.
- `operations.get(owner,id) -> Operation`; `operations.list(owner) -> Operation[]` (latest 100).
- `operations.update(owner,id,{state,errorCode=null}) -> Operation`. Queued/running may transition to `running|succeeded|failed|uncertain`; terminal states cannot transition, and requeueing throws `INVALID_TRANSITION`. No automatic retry exists, especially for uncertain sends. This is the durable outcome ledger, not an implemented provider operation/outbox.

`Operation = {id,accountId,ref,kind,state,errorCode,createdAt,updatedAt}`. Never report success until the provider confirms the requested operation.

### Devices and gateway nonces

- `devices.issue(owner,{label,ttlMs=30days}) -> {...Device,token}`. Label <=128 bytes; TTL 1,000ms..90days. The opaque random 256-bit token is returned **once**. Only its SHA-256 hash is persisted.
- `devices.list(owner) -> Device[]`; `devices.revoke(owner,id) -> undefined`.
- `devices.authenticate(token) -> {ownerId,...Device}` throws `UNAUTHORIZED` for malformed/expired/revoked tokens. Fixed scopes are `['notifications']`; this token cannot authenticate mail routes. Future endpoints must enforce its narrow scope. Raw token belongs in Android Keystore/private transport, never localStorage/logs/APK exports.
- `assertions.consume(owner,nonce,expiresAt) -> boolean` performs atomic SQLite insert-or-conflict and removes expired nonces. Used by the verifier only after cryptographic validation; persists across process/app restarts.

`Device = {id,label,createdAt,expiresAt,revokedAt,scopes:['notifications']}`.

### Attachments

- `await attachments.put(owner,ref,{filename,contentType,chunks}) -> Attachment`. `chunks` is a sync/async iterable of Uint8Array/string chunks. Writes incrementally, <=25MiB, fsyncs before recording metadata; errors remove partial files. Caller must emit bounded chunks. Filename <=1,024 bytes is display-only; content type <=128 bytes is validated `type/subtype`. Generated random IDs, not filenames, form disk paths.
- `attachments.list(owner,ref) -> Attachment[]`.
- `await attachments.read(owner,ref,id) -> Buffer`. Checks owner/message/attachment identity, safe directories, final symlink, regular file, single hardlink, expected size and SHA-256 before returning <=25MiB. A future streaming endpoint may extend this API for larger files; no unbounded read exists.
- `attachments.removeAccountFiles(owner,accountId) -> undefined` is an internal account-cleanup helper; callers should use `accounts.remove`.

`Attachment = {id,filename,contentType,size,sha256}`. Path `<canonical-dataDir>/<owner>/<accountId>/<generated-id>` is never returned. Owner/account IDs cannot contain separators; every directory is checked for symlinks, and final files use exclusive creation/no-follow where the OS supports it. Root/directory/file substitution and traversal are refused. Linux deployment must keep this root exclusively service-owned (`0700` directories/`0600` new files); a malicious OS user with write access to the service's own directories can race path operations and is outside the remote-tenant threat model. Download handlers must encode display filenames and never interpolate them into paths/headers.

## HTTP foundation

`createSyncApp({store,gatewayKey,clock=Date.now}) -> Hono` from `src/app.mjs`; callers can use `app.fetch` or `app.request` for local integration tests. It copies the 32-byte gateway key. The only unauthenticated route is `GET /health -> {status:'ok'}`. All other paths require a fresh assertion; browser query/body `ownerId` has no authority. Request bodies are read incrementally with a 65,536-byte limit, before assertion verification, through a bounded parsing queue. Protected responses use `Cache-Control: no-store`.

| Method/path | Success JSON |
| --- | --- |
| GET `/v1/accounts` | `{accounts:Account[]}` |
| GET `/v1/accounts/:id` | `{account:Account}` |
| GET `/v1/messages?limit=50&cursor=...&accountId=...` | `{items:MessageSummary[],nextCursor}` |
| GET `/v1/messages/:ref` | `{message:MessageDetail}` |
| GET `/v1/operations/:id` | `{operation:Operation}` |
| GET `/v1/devices` | `{devices:Device[]}` |

These internal upstream routes are **not** the public Worker `/api/external`, `/api/unified`, `/api/devices` routes. Task 4 composes public routes with existing authentication. No connection, binding, credential, operation execution, attachment download or device enrollment HTTP route is claimed in Task 1. Unknown methods/routes return a safe 404 after authentication.

All HTTP errors: `{error:{code}}`, never exception stacks or raw provider errors. `UNAUTHORIZED`=401; `NOT_FOUND`=404; `INVALID_INPUT|INVALID_REF|INVALID_CURSOR`=400; `CONFLICT|INVALID_TRANSITION`=409; `PAYLOAD_TOO_LARGE`=413; `BUSY`=503; unexpected internal errors=`INTERNAL_ERROR`=500. No request/credential logging middleware is installed.

`createWorkLimits({maxQueued=50}={}) -> {parse,reconnect}` from `src/core/limits.mjs`; each accepts `asyncTask -> Promise<result>`. Parsing concurrency is **1**, reconnect concurrency **2**. Each queue admits at most maxQueued waiting tasks (0..1000); overflow rejects `BUSY`, and errors release capacity. Adapters must share one limits instance across all their accounts; constructing a queue per account defeats the aggregate concurrency budget.

## Local Worker test safety

`mail-worker` `npm test` now runs `vitest run`. The previous explicit test deployment command remains `npm run deploy:test`. The script-safety test executes copied npm scripts in an isolated directory with fake executables and proves test invokes the local runner without invoking deployment. Existing upstream Worker tests/config remain untouched; known baseline problems belong to the later integration harness.
