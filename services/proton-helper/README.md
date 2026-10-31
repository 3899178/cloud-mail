# Private Proton helper

This is a private Linux Go helper consumed by `services/mail-sync`. It is not an IMAP/SMTP bridge and has no TCP listener, separate scheduler, credential file, or provider password command-line option. Source fixtures do not establish live Proton free/paid compatibility; both live account matrices remain pending owner authorization.

Build with Go >=1.26 using `go build -mod=vendor -o proton-helper .`; test with `go test -mod=vendor ./...`. The nested dependency patch tests also run with `cd third_party/hydroxide && go test ./protonmail`. Linux socket execution is a required later CI gate. Windows can compile/test pure logic and cross-compile Linux but deliberately refuses production transport/listening.

The service and helper run as the same unprivileged Unix user. Set `PROTON_HELPER_SOCKET` for both processes (default `/run/cloud-mail-proton/helper.sock`). The directory must belong to that user with mode 0700; the helper creates its socket mode 0600. An existing path is never overwritten. The deployment supervisor must distinguish a stopped stale socket from an active helper before removing a leftover socket. The helper uses only the official fixed HTTPS API origin, certificate verification, no redirects, a 60-second upstream timeout and request cancellation. It globally admits two operations and one MIME fetch/send stream. Node's existing scheduler/reconnect/parse limits remain authoritative. The aggregate 320MiB production/load measurement remains a later acceptance gate.

## Protocol v1

HTTP/1.1 over the private Unix socket only. Each POST starts with one UTF-8 JSON line <=65,536 bytes. Control `/rpc` has no trailing bytes. `/fetch` returns streamed reconstructed RFC822 MIME. `/send` accepts MIME bytes after the JSON line and returns JSON after the whole request completes. MIME is limited to 36MiB; decoded attachments to 25MiB each, at most 20; writes/copies use <=64KiB buffers. HTTP flow control provides backpressure; aborting the Node request closes the stream and cancels upstream work. A MIME error after headers aborts the response instead of returning truncated success. JSON control responses are <=8MiB at Node. Helper API responses are capped before JSON decode (64KiB auth, 2MiB metadata/keys, 40MiB full encrypted message; attachment payload 36MiB), with separate plaintext/PGP expansion caps. Source API failures expose safe codes only. The binary suppresses upstream library logging.

Every operation includes `owner` and `account`, taken from Node's asserted owner/account context. Session/challenge handles are random, owner/account bound, memory-only and never browser DTOs. `/rpc` operations:

| op | Additional request | Response |
| --- | --- | --- |
| `auth.start` | `username,password,mailboxPassword?` | `{material}` or `{step:'totp'|'mailbox-password',challenge}` or explicit manual/unsupported step |
| `auth.complete` | `challenge,code?` or `mailboxPassword` | same auth result; challenge consumed once |
| `open` | `material` | `{session,material,expiresAt}`; refreshed material returned for encrypted Node persistence |
| `folders` | `session` | `{folders:[{id,kind}]}` for inbox/archive/custom exclusive rule folders |
| `snapshot` | `session,folder,cursor,baselineAt` | `{uidValidity:'proton-message-id-v1',cursor,messages}` |
| `validate` | `session,folder,cursor` | `{valid}` only if real event token remains unchanged without events/reset |
| `flags` | `session,id,unread` | `{ok:true}` only after confirmed nested API mutation responses |
| `trash` | `session,id` | `{ok:true}` after trash labeling and normal-folder removal |
| `close` | `session` | closes only that bound helper session |
| `cancel` | none | removes account's pending challenges/helper sessions |

`/fetch` uses `{op:'fetch',owner,account,session,id,folder}`. `/send` uses `{op:'send',owner,account,session,recipients}` followed by MIME. Send encrypts the draft/body/attachments using the pinned client, streams original decoded attachment bytes into encrypted upload, constructs internal/external recipient packages and submits exactly once. A draft can remain on failed upload/submission. Node's durable ledger conservatively records ambiguous sends as uncertain and never retries automatically.

Records use the API's stable Proton `Message.ID` as both `id` and `stableId`, not RFC Message-ID or IMAP UID. Checkpoints are actual nonempty API EventID tokens. Snapshots return complete normal-folder metadata, including pre-binding history, within the existing bounds (100/page, <=20,000 messages and <=8MiB metadata); expired/reset cursors recover by a full inventory. The helper does not filter by the binding cutoff. The existing Node engine excludes historical bodies on the first complete baseline, admits newly observed stable IDs in an established folder even when their API timestamp is old, retains known identities across moves, and pauses ambiguous unmatched old-date records in new folders/resets. The helper maps API `Time` to milliseconds; its live received-time versus preserved/sender-time semantics remain unverified. Excluded labels/types are spam/trash/drafts/sent. Empty cursors and incomplete/changed inventories cannot establish successful synchronization. The Node engine alone atomically commits complete sweeps/prunes previously known refs.

Proton stores body/attachment objects. Downloaded MIME is **reconstructed**, not original raw wire RFC822. The helper preserves envelope, subject, dates, external Message-ID, decoded body and original decoded attachment bytes, including filenames/content type/content ID. Multipart/alternative wire layout and arbitrary original transport headers are not promised. PGP bodies are consumed to EOF, including integrity errors surfaced by the reader; no additional signature-authenticity claim is made.

## Authentication and secret storage

Only Node's account-bound AES-GCM vault persists `{auth,keySalts,mailboxPassword}` under credential kind `proton`. There is no separate persisted login-password field. In single-password mode the encrypted mailbox-unlock secret has the same value as the login password; it is never persisted in plaintext or returned to the browser. Session material larger than the existing 16KiB field fails closed; it is never truncated. Decrypted material crosses only the private socket. The helper keeps <=16 unauthenticated challenges for <=5 minutes and <=50 unlocked sessions for <=10 minutes or auth-token expiry, whichever is sooner. TOTP and optional second mailbox password have challenge-specific one-use steps. Unsupported U2F and Proton human verification are surfaced explicitly; there is no verification bypass. New starts invalidate earlier Node interaction state even if the provider fails. Pausing/unbinding closes the shared lifecycle admission first, aborts/drains work and cancels helper state. Old auth/MFA/refresh results check the same service generation before any vault/status write. Every cached-session fetch inherits the current operation's shared lifecycle lease, including the wait before response headers and the streamed body. A standalone fetch holds admission until its stream ends/closes; abort destroys the source and releases its lease.

## Pinned source / licenses

Approved source: [emersion/hydroxide](https://codeberg.org/emersion/hydroxide) commit `02b3b6c8aff726d2404b6ed5f6ba1b7937e1f30e`, MIT Copyright 2017 emersion. `third_party/hydroxide/protonmail` contains that client source; `LICENSE`, `go.mod`, `go.sum` preserve provenance. `vendor/` contains reproducible module dependencies and their license files. No upstream bridge/auth-disk/scheduler packages are imported.

Local safety patches (also reflected in vendor): `protonmail/auth.go` limits decrypted private-key-token expansion/read to 64KiB before allocation; `protonmail/messages.go` validates every nested batch mutation result and exact ID coverage. The patch tests are kept alongside that source. Regenerate with `go mod vendor` from the helper root; review the vendor diff whenever changing the pin. No source-version/API compatibility beyond fixture-observed behavior is implied.

## Task7a incremental snapshot extension

A nonempty saved cursor now requests a bounded event delta. Response adds `incremental:true` and `removed:[ID...]`; `messages` contains current metadata only for changed normal messages belonging to the requested folder. Node reconstructs complete inventory from its committed SQLite catalog and atomically persists it with the terminal cursor. An empty cursor, mail refresh, label-definition events or expiry code18001 requests the existing full snapshot. Node forces a full audit every five minutes. Missing/invalid `More`, repeated continuation tokens, unknown actions and incomplete exact-ID responses fail closed. Maximum201 event pages/20,000 changed IDs; exact metadata batches100. Unchanged events perform no `ListMessages` call. Changed metadata uses `IDs[]` queries, never encrypted message-body reads.

`validate` additionally requires present `More:0` and no label events. Upgrade/rollback Node and helper as one unit: older Node treats deltas as whole inventories and is incompatible with the new helper. Existing database JSON fields are additive; no schema migration or table deletion is needed.

Message event `Action` must be present, non-null and one of 0/1/2/3 at the pinned JSON decoder boundary. Missing/null values cannot default to delete; explicit `Action:0` still deletes. `event_action_persistence_test.go` exercises actual provider HTTP JSON and feeds production response envelopes to the Node adapter/engine/store through a test transport, checking that each refused delta retains the committed cursor, catalog, admitted body and attachment bytes and that valid retry works. Set `CLOUD_MAIL_TEST_NODE` to Node24+ (or install `node` on PATH); without it this cross-language check explicitly skips. This test does not replace Unix socket process integration.

The upstream pin/license remain unchanged. [TASK7A-PROVENANCE.md](TASK7A-PROVENANCE.md) and [task7a-client.patch](task7a-client.patch) record the exact authored additions to the existing pinned client; matching vendor files are byte-identical. Live compatibility for More presence, event expiry and IDs[] filtering is still a release gate; fixtures do not prove free/paid account support.
