# Mail sync foundation contract (Task 1)

This service adds isolated external-mail storage. It does not change Cloud Mail's existing Worker, D1, messages, or APIs. Task 1 does not connect to any provider, authorize an account, send mail, or expose a binding endpoint. `pending` means no provider verification has occurred. A future adapter must establish the post-binding baseline and report real connection state.

## Runtime and configuration

Node **24.18.0+**, built-in `node:sqlite`, Hono 4.13.14 and `@hono/node-server` 1.19.17. Run `npm ci` and `npm test` inside `services/mail-sync`. `npm start` binds **127.0.0.1:3211** by default. `PORT` changes the port. `MAIL_SYNC_DATA_DIR` defaults to `.data` and contains `mail.sqlite` and `attachments/`.

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

## Task 2 provider/synchronization additions

The original foundation API above remains compatible. This section describes implemented internal service behavior; it does **not** establish live support for any named provider. All real mailbox authorization, Google/Microsoft application registration/consent and provider compatibility tests remain pending. No Worker/UI/Android/Proton implementation is included here.

### Service and provider exports

- `createMailService({store,clock=Date.now,clients,registry?,adapters?,limits?})` in `src/sync/service.mjs` returns `{oauth,registry,engine,actions,scheduler,limits,start(),close()}`. One aggregate limits object serves all accounts. `start()` starts scheduling; `close()` aborts sends, stops scheduling and closes pooled transports. `createSyncApp` now accepts the same `clients`, `registry`, `adapters` options and exposes this service as `app.services`. Creating an app alone does not start a timer. The production entry starts it and calls `operations.recover()` once before listening for work. Run only one process against a database; there is no distributed scheduler/operation lease.
- `createSyncEngine({store,registry,limits?})` in `src/sync/engine.mjs` returns `syncAccount({ownerId,accountId,signal?}) -> Promise<Account>` and `stopAccount(ownerId,accountId)`. Same-account overlapping sync calls share a promise. `stopAccount` aborts/waits for that work. Paused accounts remain paused; auth failure becomes `needs-auth/AUTH_REQUIRED`. Capacity, disk exhaustion and ambiguous resynchronization become `paused/CAPACITY_EXCEEDED|STORAGE_FULL|RESYNC_REQUIRED`; other failures become `error` with safe codes. `active` requires an observed authenticated provider connection and a successful complete sweep. Raw errors are never returned or logged.
- `createProviderRegistry({store,oauth,adapters={},onChange?,sessionFactory?})` in `src/providers/registry.mjs` returns `open({ownerId,account,signal?})`, `invalidate(ownerId,accountId)`, `close()`. `open` gives an exclusive per-account lease; `lease.close()` releases it and selects INBOX for idle watching. Aborting the lease closes its pooled transport. Physical sessions reconnect if unusable. `adapters[provider]({ownerId,account,signal})` supplies an injected provider implementation, including the future Proton adapter. No Proton adapter or alternate Proton scheduler is supplied in Task 2.
- `mailConfig(provider,manual?)` and `createImapSession({account,config,auth,signal?,endpointResolver?,tlsOptions?,onChange?})` in `src/providers/imap.mjs`. Presets: Gmail (`imap.gmail.com:993`, `smtp.gmail.com:465`), Outlook (`outlook.office365.com:993`, `smtp-mail.outlook.com:587 STARTTLS`), QQ (`imap.qq.com:993`, `smtp.qq.com:465`), iCloud (`imap.mail.me.com:993`, `smtp.mail.me.com:587 STARTTLS`), 163/126/yeah (matching `imap.*:993`, `smtp.*:465`). Generic IMAP and school accounts require explicit hosts/ports; school server addresses are not guessed. Manual settings are `{imap:{host,port,secure:true},smtp:{host,port,secure:true}|{host,port,requireTLS:true}}`. Arbitrary transport/TLS/proxy/log options from HTTP are discarded. An optional `user` supports a provider-specific login name; SMTP currently uses that same login user. Outlook requires OAuth. Gmail permits approved application passwords or OAuth.
- `resolvePublicEndpoint({host,port},resolver?)` in `src/providers/network.mjs` resolves all answers, rejects nonpublic/special-use IPv4/IPv6 (including mapped addresses), and returns `{host:pinnedIp,port,servername:originalHost}`. IMAP and SMTP connect to that IP with certificate validation of the original hostname, resolving anew on new connections. SMTP STARTTLS is mandatory when implicit TLS is disabled. Dependency injection of resolver/TLS roots is internal test/adapter configuration, never an HTTP field. OAuth endpoints are fixed official HTTPS URLs and redirects are refused.
- `providerCode(error)` in `src/providers/errors.mjs` maps exceptions to the safe persisted enum; messages/stacks/provider responses are not copied into DTOs.

All physical provider sessions must implement this common protocol:

```js
{
  folders: async () => [{ id: 'folder-id', kind: 'inbox' /* normal|archive|rule|spam|trash|drafts|sent|skip */ }],
  snapshot: async (folderId, { checkpoint, baselineAt, signal } = {}) => ({
    uidValidity: 'provider-identity-epoch', cursor: 'durable-provider-cursor',
    messages: [{ id: 'remote-location-id', receivedAt: 0, unread: true,
      stableId: 'optional-provider-stable-message-id',
      fingerprint: 'bounded-reconciliation-fingerprint', messageId: '<optional-rfc822-id>' }]
  }),
  fetch: async (folderId, metadataWithUidValidity) => readableOriginalMime,
  validateSnapshot: async (folderId, snapshot) => true, // Must verify complete unchanged inventory.
  flags: async (location, unread) => { /* throw unless source confirms mutation */ },
  trash: async location => { /* move into source Trash; throw on failure */ },
  send: async (message, { signal } = {}) => ({ accepted: true }), // Throw safe-classifiable failure/uncertainty.
  close: async () => {},
  usable: () => true, // Optional: reusable authenticated transport is usable.
  acquire: () => {}, // Optional: suspend idle event scheduling while leased.
  idle: async () => {} // Optional: select watched folder; physical close occurs on invalidate/shutdown.
}
```

`snapshot` is a **complete** normal-folder metadata inventory, not only changed messages. A provider may use its durable event cursor internally but must return a complete reconciled inventory. Task 2 passes the last committed checkpoint and account binding cutoff to `snapshot`; the engine owns checkpoint commits. `validateSnapshot` must not bless a partial/disconnected inventory. The IMAP adapter re-fetches metadata and compares inventory signatures, then the engine rechecks folder membership. Production adapters must not rely on the optional-check omission used by small in-memory algorithm fixtures.

`location = {folder,uidValidity,remoteId,sourceId,fingerprint,stableId?,messageId?,admitted,receivedAt,unread}`. Task 3 should use the Proton stable MessageID as `stableId` and `id`, an adapter identity epoch as `uidValidity`, and the real event token as `cursor`. Never use Proton bridge UID as stable identity. The adapter factory can obtain encrypted credentials from its service-owned store; browser owners or credentials never enter the protocol as trusted identities.

### Binding, reconciliation, resources and limits

The account's server `createdAt` is the binding cutoff. The first **complete** inventory catalogs all normal mail metadata, including excluded history; only messages with provider INTERNALDATE at or after this cutoff get bodies. Inbox, archive/all-mail and normal rule folders are included. Special-use sent/trash/junk/drafts and message draft/Gmail excluded labels are omitted. After a folder baseline exists, a newly observed location is admitted even with an old INTERNALDATE (post-binding APPEND/import). A known post-binding message moved to a new folder retains its admitted identity and original list timestamp. New folders containing unmatched old-date items after the initial baseline, or UID resets with unmatched old-date items, pause with `RESYNC_REQUIRED`: the service cannot safely distinguish old history from a new import that preserved an old date.

Prefer provider `EMAILID`/Gmail `X-GM-MSGID` whenever advertised. Generic IMAP uses persisted UID/UIDVALIDITY/folder locations and one-to-one reconciliation of vanished locations by Message-ID/INTERNALDATE (or envelope/size fallback without Message-ID). Identical deliveries have distinct source IDs; copies where the original still exists retain multiplicity. UUID-like opaque source strings are deterministic hashes of the provider location epoch, not global raw-MIME hashes. A move/reset match preserves the original source reference and attachments despite MIME reserialization. Mixed historical/admitted indistinguishable candidates pause instead of silently choosing. Generic IMAP cannot guarantee identity when a server destroys all identifying metadata or makes a new identical delivery indistinguishable from a move; this is a real protocol limitation and requires live provider review. The service does not claim perfect generic identity recovery.

MIME parsing is globally serial. Raw MIME <=36MiB, decoded attachment <=25MiB, <=100 attachments/message, text/html <=2MiB each, incoming store batch <=100 (engine currently uses one message per batch). Attachments spool original decoded bytes into confined generated stage files and stream into the permanent store in <=64KiB disk chunks; partial stages are removed on errors. The next account scan removes stale generated stages after a process interruption. Forward/reply attachments stream verified original stored bytes rather than loading multiple files into memory. Source deletes target only previously cataloged admitted refs absent after a complete sweep; explicit persisted sweep capabilities bind deletion to owner/account and exact refs. Missing/incomplete sweep markers cannot authorize cleanup. Filesystem cleanup failures retain the durable sweep for retry; no blanket account-message deletion is used.

Metadata FETCH pages contain at most 100 records. Each account/sweep is bounded to 200 folders, 20,000 locations and 8MiB serialized catalog/metadata; exceeding a cap pauses with `CAPACITY_EXCEEDED`, retaining existing content/catalog/checkpoints. At most two sweeps run at once, and no 50-account array of inventories is retained. Metadata bodies are never downloaded for known/excluded history. The 50-live-account, aggregate 320MiB deployment/memory envelope remains unverified and belongs to resource acceptance; these bounds are not a claim of measured production capacity.

`createScheduler({store,engine,clock=Date.now,intervalMs=30000})` in `src/sync/scheduler.mjs` returns `tick()`, `wake({ownerId,accountId})`, `start()`, `close()`. It rotates the first account for fairness, runs at most two accounts concurrently, and excludes paused/pending/needs-auth accounts. One-second dispatch checks make each active/error account due about every 30 seconds; transport/provider timeouts can delay this. IMAP sessions are retained; INBOX is selected on lease release, imapflow auto-IDLE begins after its 15-second inactivity threshold and renews at 25 seconds. INBOX changes wake the shared scheduler with a five-second debounce. Archives/rule folders still use full 30-second polling. Servers without IDLE use library/poll fallback. This is not an assertion of continuous IDLE on every folder.

### Compatible store additions (privileged internals only)

- `messages.ingest(...,{...,advanceCheckpoint=true})`: false ingests a bounded message batch without touching the existing checkpoint. Normal foundation default still atomically ingests and advances its checkpoint. Engine hydration uses false, then atomically commits the completed whole catalog, folder checkpoints and initial-baseline marker together. A failed MIME/attachment scan cannot establish a baseline or advance cursors.
- `accounts.scheduled() -> [{ownerId,accountId,status}]`: internal cross-owner enumeration for the scheduler, never an HTTP DTO.
- `sources.catalog(owner,accountId) -> location[]`; `sources.baseline(owner,accountId) -> {baselineAt}|null`; `sources.ready(owner,ref) -> boolean`; `sources.complete(owner,ref)`; `sources.clearContent(owner,ref)` (clears partial permanent attachments before a hydration retry).
- `sources.commit(owner,accountId,{catalog,checkpoints,expectedFolders}) -> sweepId`: validates complete exact folder coverage and all bounded metadata; atomically replaces catalog, updates flags/folders, commits all checkpoints/baseline and writes exact prior-source deletion candidates. Each checkpoint has `{folder,cursor,uidValidity,baselineAt}`. Call only after all hydration and provider snapshot validation succeeded.
- `sources.pendingSweeps(owner,accountId) -> sweepId[]`; `sources.prune(owner,accountId,sweepId)` consumes that owner/account-bound persisted completed-sweep capability and deletes only its captured absent source refs/attachments; currently present refs are protected. `sources.update(owner,ref,{unread})` updates a confirmed source flag.
- `attachments.stage(owner,accountId,chunks) -> Promise<{chunks(),cleanup()}>`: confined, bounded staging; `chunks()` opens a <=64KiB stream. `attachments.cleanupStages(owner,accountId)` removes only verified generated `.stage-<uuid>` regular files in that account directory. `attachments.stream(owner,ref,id) -> Readable` verifies size/SHA256 on the opened confined file before yielding <=64KiB chunks. Internal `removeMessageFiles(owner,ref)` removes that owned message's generated permanent files and attachment metadata.
- `oauthStates.create(owner,accountId,value,ttlMs=600000) -> randomState`; `resolve(state) -> {ownerId,accountId}`; `consume(owner,state) -> {ownerId,accountId,value}`. Stored state is SHA256-addressed; secret verifier payload uses the same account-bound AES-GCM vault, expires after <=10 minutes and is consumed transactionally once. A new start invalidates previous pending state for that account. Cross-owner consume fails without consuming the rightful state.
- `operations.recover()` changes interrupted queued/running send/reply/forward operations to `uncertain/SEND_UNCERTAIN` and other interrupted mutations to `failed/SYNC_FAILED`. It never resends. The entry point calls it once on process start.

Safe persisted error codes now additionally admit `RESYNC_REQUIRED` and `CAPACITY_EXCEEDED`. Unknown raw provider failures still become existing safe codes. Additive schema tables are created idempotently alongside schema version 1; existing foundation rows remain intact.

### OAuth ownership and callback contract

`createOAuth({store,clients={},clock=Date.now,fetcher=fetch})` in `src/providers/oauth.mjs` returns `start(ownerId,accountId)`, `resolve(state)`, `complete(ownerId,{state,code})`, `auth(ownerId,accountId)`. `clients.gmail/outlook = {clientId,clientSecret,redirectUri}` must be the operator's own registered applications. Only the production entry reads `MAIL_SYNC_GOOGLE_CLIENT_ID|CLIENT_SECRET|REDIRECT_URI` and `MAIL_SYNC_MICROSOFT_CLIENT_ID|CLIENT_SECRET|REDIRECT_URI`. Redirect URI must be operator-configured HTTPS; it is not accepted from the browser. Official Google/Microsoft authorization-code and refresh endpoints use S256 PKCE, random server-held state, a 15-second timeout and <=32KiB token response. Tokens/refresh rotations are vault-encrypted. Parallel refreshes for the same account coalesce. `complete` stores tokens but does not declare an account active; the account must authenticate and synchronize afterward. OAuth registration, Gmail restricted-scope verification and Microsoft tenant permissions remain operator/live prerequisites.

The future Worker callback may have **no same-browser session cookie**. It must follow this precise server-to-server flow:

1. Normal authenticated/CSRF-protected Worker bind/start requests sign the real authenticated Cloud Mail owner and forward to `/v1/accounts/:id/oauth/start`. Browser receives only the authorization URL and expiry, never the PKCE verifier or any token.
2. On the configured public callback, Worker validates the expected provider callback shape and forwards `{state}` to `POST /v1/oauth/resolve`, signed with reserved owner **`oauth-callback`**, fresh nonce, exact path/body. That reserved service identity must never be minted from a browser owner/session/user record, and `/resolve` must never be browser-proxied. Only a trusted holder of the gateway key may call it. No HTTP service endpoint is unauthenticated apart from `/health`.
3. `/resolve` verifies unexpired server-held state and returns `{ownerId,accountId,provider}` **only to the Worker**. Worker checks the callback provider matches the resolved provider, signs the resolved owner from this server response (not a browser `ownerId`), and forwards `{state,code}` to `POST /v1/oauth/complete` with a new assertion. `/complete` independently checks the server-held owner and consumes state once before token exchange. Cookie absence cannot authorize arbitrary account selection. Browser-supplied owner/account values have no authority.
4. Worker must not log callback codes/state/tokens or leak resolved owner in redirects; use fixed same-site success/failure pages. Do not retry a consumed authorization code or an uncertain send. On authorization denial show a safe error and restart authorization when requested. Expired/used/mismatched state is `UNAUTHORIZED`.

### HTTP additions (all require fresh gateway assertions)

All request JSON is parsed from the exact already-verified bounded body; existing 65,536-byte request limit remains. These are internal upstream `/v1` routes, not new public Worker authentication semantics.

| Method/path | Request | Success |
| --- | --- | --- |
| POST `/v1/accounts` | `{provider,address,credentials?}` | 201 `{account}` pending |
| PUT `/v1/accounts/:id/credentials` | `{authType?:'password'|'oauth',user?,password?,config?}` | `{account}` pending |
| POST `/v1/accounts/:id/connect` | empty body allowed | `{account}` observed sync status |
| POST `/v1/accounts/:id/pause` | empty body allowed | `{account}` paused; abort/wait work, close session |
| POST `/v1/accounts/:id/resume` | empty body allowed | `{account}` observed sync status |
| DELETE `/v1/accounts/:id` | empty body | `{removed:true}` after owned work/session/files cleanup |
| POST `/v1/accounts/:id/oauth/start` | empty body allowed | `{authorizationUrl,expiresIn:600}` |
| POST `/v1/oauth/resolve` | `{state}`; reserved callback service owner only | `{ownerId,accountId,provider}` internal callback identity |
| POST `/v1/oauth/complete` | `{state,code}`; resolved real owner assertion | `{account}` observed sync status |
| GET `/v1/messages/:ref/attachments/:id` | empty body | original bytes; octet-stream, nosniff, encoded attachment filename |
| POST `/v1/messages/:ref/read` | `{unread:boolean}` | `{operation}` actual source result |
| POST `/v1/messages/:ref/trash` | empty body allowed | `{operation}` actual source result; copy removed after complete reconciliation |
| POST `/v1/send` | `{accountId,kind:'send'|'reply'|'forward',ref?,message:{to:[],cc?:[],bcc?:[],subject?,text?,html?,attachmentIds?:[]}}` | `{operation}` terminal succeeded/failed/uncertain |
| GET `/v1/operations` | empty body | `{operations}` last 100, owned |

The account `credentials` object has the same shape as PUT credentials and is write-only. Provider configuration and credential values never appear in returned DTOs. `ownerId` in any browser JSON has no effect. Existing source refs, exact query/body-bound assertions and BINARY cursors are unchanged.

`createActions({store,registry,limits?})` in `src/send/actions.mjs` exposes `execute(...)`, `stopAccount(ownerId,accountId)`, `close()`, and `resume({ownerId,operationId})` (always refuses `INVALID_TRANSITION` after owned lookup; never resends). Execution creates the durable ledger before source work. Sender identity is forced to the owned account address. Reply uses preserved source Message-ID when valid; reply/forward require an owned source ref. Recipients are validated arrays (<=20 each); optional attachment IDs must exist on that same owned source message and are streamed as original bytes. Provider errors after possible SMTP submission become `uncertain/SEND_UNCERTAIN` unless a definitive rejection is known. A source mutation succeeds only after its adapter confirms; flags update locally afterward. Interrupting a possibly submitted send is uncertain.

**Fresh compose attachment gap for Task 4:** Task 2 supports forwarding/replying/sending existing owned source attachments by `attachmentIds`; it does not add a new attachment-upload/staging HTTP route for newly selected local files. The existing Worker upload path has not been changed. Task 4 must inspect that existing path and add a bounded authenticated bridge/staging transport for external fresh-compose attachments; arbitrary URL fetch and huge inline base64 bodies are not permitted. This remains an integration requirement, not a permanent feature exclusion.

HTTP additionally returns safe `AUTH_REQUIRED`=401, `PROVIDER_UNAVAILABLE`=503, `SYNC_FAILED`=502, `RATE_LIMITED`=429, `RESYNC_REQUIRED|INCOMPLETE_SWEEP`=409 when those service operations throw directly; observed sync failures normally return `{account}` with truthful status/errorCode. Do not infer that HTTP 200 means a source operation succeeded: inspect `account.status` or `operation.state`. Never automatically retry `/v1/send` after uncertainty or a lost response.

Protocol references used for presets/OAuth: [Gmail IMAP/SMTP](https://developers.google.com/workspace/gmail/imap/imap-smtp), [Google OAuth web-server flow](https://developers.google.com/identity/protocols/oauth2/web-server), [Microsoft IMAP/SMTP OAuth scopes](https://learn.microsoft.com/en-us/exchange/client-developer/legacy-protocols/how-to-authenticate-an-imap-pop-smtp-application-by-using-oauth/), [Microsoft authorization-code flow](https://learn.microsoft.com/en-us/entra/identity-platform/v2-oauth2-auth-code-flow), [Outlook settings](https://support.microsoft.com/en-us/outlook/pop-imap-and-smtp-settings-for-outlook-com), [iCloud server settings](https://support.apple.com/en-ie/102525), [NetEase client help](https://help.mail.yeah.net/faqDetail.do?code=d7a5dc8471cd0c0e8b4b8f4f8e49998b374173cfe9171305fa1ce630d7f67ac25c12dcb3d46222b6). QQ presets still require live authorization and compatibility validation; school remains explicitly manual.

### Task 2 review fix 1: durable partial identities, lifecycle barrier, streamed downloads

This section supersedes the earlier partial-sweep/download/lifecycle descriptions where more specific.

- `sources.journal(owner,accountId,location)` persists an admitted source identity **before** its message/attachment rows are written, without advancing a baseline or checkpoint. `sources.identities(owner,accountId)` returns committed catalog identities plus unique partial identities from the new `hydration_journal` table. The engine uses this union for matching moves/UID resets after failures/restarts and for recognizing already hydrated original attachments. Distinct identical deliveries retain separate source IDs. `sources.commit` derives exact absent-source deletion candidates from this union and clears the journal in the same completed catalog/checkpoint/baseline transaction. `sources.prune` still requires the same persisted completed-sweep capability, exact captured refs, current absence and owner/account checks; no uncataloged-account blanket cleanup is introduced. Partial journal metadata is separately bounded to 20,000 source IDs/8MiB. A failed/incomplete sweep never advances baseline/checkpoints.
- `createAccountLifecycle({store})` in `src/core/lifecycle.mjs` supplies the single process-local account admission barrier. `run(owner,accountId,async lease=>result,{signal?,allowPaused=false}?)` tracks work until completion; nested same-account calls inherit their lease through async context. `enter(...) -> lease` manually holds admission until `lease.release()` (used for streaming response lifetime). Each lease has `signal`, `check()`, `current()`, `release()`. `transition(owner,accountId,{begin?,commit})` closes admission and increments the generation **synchronously before awaiting anything**, calls optional synchronous begin (pause sets its truthful status there), aborts/drains all admitted leases, then performs exclusive commit. New account work during a transition fails `BUSY` (503); actions/OAuth on an already paused account fail `INVALID_TRANSITION` (409). `close()` blocks/aborts/drains all account work on shutdown. One Node process remains required.
- `createMailService` now returns `lifecycle` and `downloads` and passes the **same** lifecycle instance to `createSyncEngine`, `createActions` and `createOAuth` via their optional `lifecycle` argument. Integrations that construct these modules separately **must pass one shared lifecycle object**; standalone default lifecycle instances are for isolated consumers/tests. Task 3 adapter authentication/session/token writes must inherit the service lease or call `service.lifecycle.run`, checking `lease.check()` after asynchronous work before persisting credentials/status. Do not add a parallel account scheduler or mutation path that bypasses this boundary.
- Sync/source actions, OAuth starts/completions/refreshes and route credential/configuration updates all participate. Pause/unbind/credential replacement establish a transition before draining. Old-generation OAuth exchanges (even a transport that ignores abort) cannot persist late tokens or reset paused status. Already possibly submitted sends still persist their definite/uncertain operation result **before** their lease releases; account/ledger cascade deletion waits for that release. These result writes are intentionally allowed while draining; they are not new source submissions. OAuth callback state resolution remains a read-only gateway operation; completion independently enters the real account barrier before consuming/exchanging state.
- Download route no longer calls whole-file `attachments.read`. `createDownloads({store,lifecycle})` in `src/routes/downloads.mjs` provides `response({ownerId,ref,attachment,signal,headers}) -> Promise<Response>`, used internally by the unchanged GET attachment route. It permits **2 active downloads service-wide**, with **no waiting queue**; an excess request fails `BUSY` before opening a file. Active lifetime includes the integrity pass and slow response consumption. Each response uses confined SHA256/size-checked `attachments.stream(owner,ref,id,{signal?})`, <=65,536-byte chunks and a Web ReadableStream with highWaterMark 0. Original bytes are verified before headers while retaining only the first bounded chunk; no <=25MiB whole-file Buffer is allocated. Node stream highWaterMark is 65,536 bytes. At most the first chunk, one bounded Node buffer and an in-flight bounded chunk are retained per transfer. Backpressure pauses further file reads. Response cancel, client request abort, lifecycle transition or stream failure destroys the source, closes the file and releases both capacity and lifecycle lease. Account deletion cannot race an admitted open download. Integrity/path/owner checks and safe filename headers remain required; errors after response start terminate the stream. Paused-account retained mail remains downloadable.
- Local pinned-nodemailer tests now exercise actual TCP→STARTTLS upgrade, original-host certificate validation, withheld STARTTLS and refused STARTTLS. No case allows plaintext AUTH fallback. These remain loopback fixtures, not live-provider acceptance.

## Local Worker test safety

`mail-worker` `npm test` now runs `vitest run`. The previous explicit test deployment command remains `npm run deploy:test`. The script-safety test executes copied npm scripts in an isolated directory with fake executables and proves test invokes the local runner without invoking deployment. Existing upstream Worker tests/config remain untouched; known baseline problems belong to the later integration harness.

## Task 3: private Proton integration

`createMailService({...,proton?:{socketPath?,transport?}})` creates `service.proton` and installs `adapters.proton` by default. It passes the exact same `service.lifecycle` to Proton, OAuth, sync/actions/downloads. A supplied adapter can still override Proton for fixtures. `createSyncApp` forwards the compatible optional `proton` configuration; only `src/index.mjs` reads `PROTON_HELPER_SOCKET`. There is no additional scheduler. `createProton({store,lifecycle,transport,clock})` exports `start(owner,accountId,input)`, `complete(owner,accountId,input)`, `adapter({ownerId,account,signal})`, and internal `cancel(owner,accountId)`. `createProtonTransport({socketPath})` permits only a same-UID private Linux Unix socket, and exposes `rpc`, streaming `fetch`, and streaming `send`.

All Proton HTTP steps require the existing fresh, exact-body gateway assertion from the authenticated real owner; Task 4 must enforce normal browser auth/CSRF and must never proxy a browser owner override:

1. `POST /v1/accounts` with `{provider:'proton',address}` and **no** generic `credentials`. Account remains `pending`.
2. `POST /v1/accounts/:id/proton/start` with `{password,mailboxPassword?}`. Response is `{step:'totp'|'mailbox-password',state,expiresIn:300}`, `{step:'ready'}`, `{step:'manual-verification'}`, or `{step:'unsupported-challenge'}`. Never persist passwords/state in localStorage or log request bodies. Manual verification/unsupported challenges are explicit incomplete authorization; do not display connected or attempt bypasses.
3. For TOTP call `POST /v1/accounts/:id/proton/complete` with `{state,code}`; for a second mailbox-password step send `{state,mailboxPassword}`. A response can request the next challenge with a fresh state. State is owner/account-bound, encrypted server-side, expires in <=5 minutes and is consumed once. Failed/expired/used state requires a new start. Browser never sees a helper challenge/token/session material. A new start invalidates the old interaction even when provider auth fails.
4. `{step:'ready'}` means encrypted session material was stored, with account still `pending`. Call existing `/connect` and inspect actual `account.status/errorCode` for observed sync. A 200 auth/connection HTTP response alone is not proof of connection. No Proton free/paid live account is verified by this implementation.

Pausing/unbinding aborts/drains shared lifecycle work before clearing helper challenges/sessions; late auth/MFA/token refresh cannot persist or recreate an account. Refreshed session material is written only after generation checks to existing vault kind `proton` and stays within the existing 16KiB field (oversize fails explicitly). No plaintext password is persisted. The encrypted mailbox-unlock secret equals the login password in single-password mode. The helper serializes operations per account, caps two admitted operations/one MIME transfer globally, 16 expiring pending challenges and 50 expiring sessions. MIME/attachments retain the existing 36MiB/25MiB and <=64KiB streaming limits. Source read/trash and send/reply/forward use the existing action ledger/attachment streams.

The helper protocol, full limits, stable MessageID/event recovery semantics and pinned-source attribution/patches are documented in `services/proton-helper/README.md`. RFC822 is reconstructed from decrypted Proton body/envelope/attachment objects; original decoded attachment bytes are preserved, not original transport-wire MIME layout. Windows refuses production socket use. Actual Linux permission/cancellation/socket checks, aggregate memory/load acceptance and authorized Proton free/paid provider matrices remain explicit later gates.

Proton snapshots follow the complete-inventory contract above: they include pre-cutoff normal-message metadata on every scan and never apply their own timestamp-admission filter. The existing engine owns first-baseline body exclusion, later old-date admission, stable-ID move retention and new-folder/reset ambiguity guards. API `Time` is mapped to `receivedAt` milliseconds; its live timestamp semantics remain unverified. Cached Proton MIME fetches resolve the **current** shared lifecycle lease for each operation. That signal covers transport waits before headers and streaming-body completion; a standalone fetch retains admission until end/close, and cancellation destroys the source. No separate lifecycle, scheduler or metadata cache is introduced.

## Task 4: browser gateway and unified feed (Task 5 consumer contract)

This section supersedes the earlier fresh-compose gap and future-Worker wording. It describes implemented local contracts; live-provider, Linux, resource and complete web acceptance remain separate rollout gates. The web-first scope defers public `/api/devices`, native enrollment and notification tokens until Task 6. Existing internal foundation device storage is unchanged.

### Browser authentication and invitation migration

All public paths below include `/api`; the Worker entry strips that prefix before Hono routing. `POST /api/login` and existing site OAuth login still return their legacy token DTO. Keep that token only in memory, immediately exchange it using `POST /api/session/exchange` with raw JWT or `Bearer <JWT>` in `Authorization`, same-origin `Origin`, and normal browser credentials. A successful exchange returns `{code:200,message:'success',data:{csrfToken}}` and sets `__Host-cloud-mail` with `Secure; HttpOnly; SameSite=Lax; Path=/` and the existing session expiry. No external account credential, upload capability, OAuth state or auth token belongs in localStorage/logs/exports.

`GET /api/session` uses the cookie and returns `{code:200,message:'success',data:{userId,csrfToken}}`. On a cookie-only hard reload, call it before route guards, load `/api/my/loginUserInfo`, then install the actual user's permission routes. On legacy browser migration, exchange `localStorage.token` and remove it **only after** a successful exchange; an exchange failure retains the legacy value for recovery. New logins do not write it. Non-browser callers may continue sending raw JWT or proper Bearer tokens. An explicitly supplied invalid Authorization header fails even if a valid cookie exists. The KV UUID allowlist remains authoritative, including logout revocation.

Cookie-authenticated writes require an exact same-origin `Origin` and `X-CSRF-Token` equal to the session token. Cross-site fetch metadata also fails. Header-authenticated legacy API writes do not require cookie CSRF. Login/register/site-OAuth reject an explicitly hostile Origin; the two external OAuth callback GET paths below are the only new cookie-free exemptions. `DELETE /api/logout` revokes the current UUID and expires the cookie. Vue resets the user, selected account, body/list/search/recipient caches and dynamic permission routes on logout, failed current-user load or owner switch. Email-keyed Dexie drafts and saved draft attachments are preserved for their original owner.

Every **new user** path now requires a valid unexpired invitation with remaining uses: `/api/register`, permissioned `/api/user/add`, public-key `/api/public/addUser` (each list row carries `code`) and site OAuth `/api/oauth/bindUser`. Existing public-key/role permissions still apply. User/account creation, invite decrement and optional OAuth assignment share one D1 transaction; failed account insertion rolls back all of them. Site OAuth bind additionally requires the server-issued five-minute `bindingProof` from the verified provider login, bound to provider + provider user + stored OAuth row. A client-supplied provider user ID alone grants no authority. This intentional invitation restriction applies even if the old optional-invite setting was disabled.

### Gateway responses, routing and failures

Worker configuration needs a private 64-hex `MAIL_SYNC_GATEWAY_KEY` and an operator HTTPS origin `MAIL_SYNC_URL` with no path/query/userinfo. Normal upstream fetches use that origin; a supplied `MAIL_SYNC` service binding is also supported. The gateway signs the authenticated Cloud Mail `userId`, exact upstream method/path/query/body with a fresh nonce. Browser owner headers/JSON cannot select a tenant. Normal request JSON is limited to **65,536 bytes** and must be an object. Successful JSON is wrapped as `{code:200,message:'success',data:<upstream JSON>}`; account creation retains HTTP 201, otherwise normally 200. Binary downloads are unwrapped streams.

New session/external/unified failures use non-2xx HTTP plus `{code:<HTTP status>,message:<safe code>,error:{code:<safe code>}}`. Safe statuses include `INVALID_INPUT|INVALID_REF|INVALID_CURSOR|UPLOAD_CORRUPT` 400, `UNAUTHORIZED|AUTH_REQUIRED` 401, `CSRF_REJECTED|FORBIDDEN` 403, `NOT_FOUND` 404, `CONFLICT|INVALID_TRANSITION|RESYNC_REQUIRED|INCOMPLETE_SWEEP` 409, `UPLOAD_EXPIRED` 410, `PAYLOAD_TOO_LARGE` 413, `RATE_LIMITED` 429, `SYNC_FAILED` 502, `SYNC_UNAVAILABLE|BUSY|PROVIDER_UNAVAILABLE|LOCAL_INDEX_NOT_READY` 503 and `STORAGE_FULL` 507. Unexpected raw errors become `REQUEST_FAILED`; they are neither returned nor logged at the new credential/session boundary. Legacy login/register/logout/user/public/site-OAuth preserve HTTP 200 business-error envelopes, with safe error text on these paths. Inspect both HTTP and `code`; a successful transport still requires checking `operation.state` and `account.status/errorCode`.

| Public Worker method/path | Internal service path / result |
| --- | --- |
| GET/POST `/api/external/accounts` | `/v1/accounts`; `{accounts}` / `{account}` |
| GET/DELETE `/api/external/accounts/:id` | same owned `/v1/accounts/:id`; `{account}` / `{removed:true}` |
| PUT `/api/external/accounts/:id/credentials` | same suffix; write-only credentials, `{account}` |
| POST `/api/external/accounts/:id/{connect,pause,resume}` | same suffix; observed `{account}` |
| POST `/api/external/accounts/:id/oauth/start` | same suffix; `{authorizationUrl,expiresIn}` |
| POST `/api/external/accounts/:id/proton/{start,complete}` | same suffix; Task 3 challenge DTOs |
| GET `/api/external/operations` or `/:id` | `/v1/operations` or `/:id`; `{operations}` / `{operation}` |
| GET `/api/unified/messages` | merged page described below |
| GET `/api/unified/messages/:ref` | selected source; `{message}` |
| GET `/api/unified/messages/:ref/attachments/:id` | owned original bytes, attachment disposition, octet-stream/nosniff/no-store |
| POST `/api/unified/messages/:ref/read` | `{unread:boolean}`; `{operation}` |
| POST `/api/unified/messages/:ref/trash` | selected source's original deletion semantics; `{operation}` |
| POST `/api/unified/messages/send` | `{source:'external'|'cloud-mail',accountId,kind,ref?,message}`; `{operation}` |

All `:ref` values are opaque shared source refs. Decode only to route; the selected source independently checks ownership. Identical numeric account/message/attachment IDs across sources do not identify the same object. External send/reply/forward uses the Task 2 message DTO plus `message.uploadIds?:string[]` below. Local unified send delegates to existing Cloud Mail delivery, uses its send/delete permissions, and currently admits `message.to`, subject/text/html with **no cc/bcc/new-upload/source-attachment arrays**; use the existing original local compose API for that richer legacy behavior. This bridge does not replace the legacy composer or local attachment APIs. An external `failed`, `queued`, `running` or `uncertain` operation must never display as succeeded. Never retry a possibly submitted send automatically.

### Unified page, index and outage behavior

Query: `limit` integer 1–100 (default 50), `source=all|cloud-mail|external` (default all), optional `cursor`, optional `accountId` only with an explicit single source. Data is `{items,nextCursor,incomplete,resetRequired,sources:{local,external}}`. Each item has `{ref,source,accountId,receivedAt,subject,from,unread,folder}`; local `receivedAt` is UTC milliseconds parsed from SQLite UTC text. Sorting and keyset comparison are **receivedAt DESC, opaque ref DESC in ASCII/SQLite BINARY order**, including ties. Treat cursors as opaque; keep filters unchanged through a page sequence. New unified incoming feed excludes local sent/soft-deleted messages and checks both message and account owner/visibility. Existing privileged all-mail routes retain their original permission behavior without granting external owner overrides.

`mail-worker/migrations/0001_unified_feed.sql` is an additive, idempotent, **operator-applied** D1 migration, never DDL in a request. Its state/dirty/index tables copy only IDs/ref/time; triggers catch existing writers. Each feed read advances at most 200 historical IDs and processes at most 200 dirty IDs; the final D1 snapshot checks readiness and authoritative tenant joins. Incomplete backfill/dirty work returns `503 LOCAL_INDEX_NOT_READY`, never a false empty mailbox. Random dirty generations prevent a concurrent stale reader from erasing a new change. See the migration README for repeat-until-ready and rollback. Legacy local APIs keep working without migration or sync service. No production migration has been applied by tests.

For `source=all`, a sync outage returns available local items with `incomplete:true`, `resetRequired:true`, `nextCursor:null`, `sources.external='unavailable'`. Show incompleteness and restart from the first page once the external source recovers; continuing the old cursor could skip mail. `source=external` fails explicitly during outage; `source=cloud-mail` never calls sync. Ready/excluded source states are explicit. Legacy original local APIs remain available independently.

### External OAuth callback and fresh-compose uploads

Configure the owner's own provider applications with these exact callback URIs:

- Google: `https://mail.3899178.top/api/external/oauth/google/callback`
- Microsoft: `https://mail.3899178.top/api/external/oauth/microsoft/callback`

Callback GET requires state/code and rejects denial/missing values. It can work without a cookie by signing reserved `oauth-callback` for `/v1/oauth/resolve`, validating the resolved provider, then signing the resolved real owner for one-use `/v1/oauth/complete`. Owner/account query parameters have no authority. Successful processing redirects 303 only to `/settings?externalOAuth=active|attention`, with no state/code/owner/token; UI must reload actual status. Failures use safe JSON errors. Do not blindly retry a consumed code. Provider authorization, callback configuration and live sync remain unverified gates.

Fresh selected-file flow (normal browser cookie/CSRF applies to all three Worker endpoints):

1. Hash the selected file incrementally and call `POST /api/external/uploads` with `{accountId,filename,contentType?,size,sha256}`. SHA256 is 64 lowercase hex. A fresh exact-body assertion forwards to `POST /v1/uploads`. HTTP 201 data is `{upload:{id,capability,expiresAt,size,sha256}}`. Account must belong to the authenticated owner and accept shared lifecycle admission.
2. `PUT /api/external/uploads/:id` streams original bytes with `X-Upload-Capability`. The Worker signs owner/method/exact upstream path with the empty ordinary assertion body; the separate process-secret HMAC capability binds random one-shot id, owner/account, name/type, exact size/hash, expiry and path. The Node receiver verifies both, one-use state, account generation and streaming integrity. No arbitrary fetch URL or base64 JSON exists. Success data is `{upload:{id,state:'ready',filename,size,sha256}}`.
3. Include up to ten unique `message.uploadIds` on the same owned external account in send/reply/forward. Handles are reserved before integrity awaits, then streamed with <=64KiB reads into the provider. They are consumed once and cleaned after the source action, including failure/uncertainty. A different owner/account cannot use them. Do not treat retrying a used handle as a successful send.
4. `DELETE /api/external/uploads/:id` cancels an idle pending/ready handle and returns `{removed:true}`. Uploading/consuming returns `BUSY`. Capabilities stay in transient memory and expire after ten minutes; service restart invalidates them and removes confined generated compose stage files.

Limits: 25MiB per file, 100MiB total reserved staging, at most 16 admitted handles and 2 active upload streams globally, with a 64MiB free-disk reserve. Input chunks above 256KiB are rejected, accepted chunks are split into <=64KiB writes; no whole 25MiB Worker buffer is allocated. Upload body lifetime is capped at two minutes and at capability expiry; abort, integrity/space error or shared lifecycle transition cleans partial state. Credential replacement/unbind clear stages after admission closes/drains. Pause increments the shared generation immediately, aborts active streams and makes prior idle handles unusable (timer sweeps them within 30 seconds). Expiry cleanup runs every 30 seconds. Service close drains the single shared lifecycle before deleting stages. These bounds are locally tested behavior, not proof of the aggregate Linux 320MiB resource gate.

Development uses `mail-vue/.env.dev` relative `/api`, strict loopback port 3001 and a proxy to loopback Worker 8787 with `changeOrigin:false`, preserving browser Host and Origin for CSRF. Local tests verify the real proxy forwards both original and hostile Origins unchanged. Secure cookie acceptance and actual browser reload/logout require the later in-app-browser preview; do not weaken production cookie flags for an HTTP development workaround.
