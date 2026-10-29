# Unified web mailbox

The existing `/inbox`, `/sent`, `/drafts`, `/starred`, search, settings and permissioned administration routes remain in Cloud Mail. The left rail's `⋯` button (or the header menu button) opens their original navigation. Local aliases retain their original add/Turnstile, copy, rename, pin, all-receive and permissioned-delete controls.

The desktop sidebar contains the full mailbox list independently of the mail area's scroll. On phone browsers, a persistent 56px rail expands to show names. `全部邮箱` opens `/unified`; selecting an external mailbox filters the same incoming normal-folder feed. Selecting a local alias returns to the original local inbox. Unified source state uses opaque refs in a separate, nonpersisted Pinia store and never replaces local numeric account/message IDs.

## Binding and recovery

Open Settings → 外部邮箱, or use `＋` in the mailbox rail. Gmail supports official OAuth or an account-permitted application password; Outlook uses official OAuth. QQ, iCloud, 163/126/yeah and other IMAP accounts use the provider's authorized password or application code. School and generic IMAP accounts require explicit TLS IMAP and TLS/mandatory-STARTTLS SMTP hosts and ports. Proton handles TOTP, separate mailbox passwords and explicit unsupported/manual-verification states.

`等待验证` is pending, not connected. Only the service's observed `active` state displays `已同步`. Authentication failures offer reauthorization; paused accounts offer resume. Capacity, resync, rate-limit and service errors show their safe code. Credentials/challenge states remain in current form memory and are cleared on close or owner changes. OAuth accepts only the server-issued URL on the matching official provider origin. The fixed callback returns to Settings and actual account status is reloaded.

An unavailable external service does not prevent the original local routes. An incomplete merged page shows both source states, drops the unusable cursor and restarts the first page on recovery. `LOCAL_INDEX_NOT_READY` displays initialization with four bounded exponential retries, followed by manual retry; it never displays a successful empty mailbox. No migration is run by the UI.

## Messages and sending

Unified read/delete/download operations retain the exact opaque message ref. Queued/running operations remain unfinished and are polled with a bound; their original result can also be queried. Provider failures are displayed without optimistic local success. External deletion moves the original message to the provider's Trash; local deletion retains existing semantics.

Local compose/reply/forward opens the original rich composer using the owning local account, preserving its original API, local attachment flow and email-keyed Dexie drafts. External compose has its own explicitly selected sender, to/cc/bcc, text, original source attachment selection and fresh uploads. External drafts remain in current-page memory and are not silently persisted to local drafts. Closing asks before discarding them. External sends, replies and forwards use the selected owned source/account; uncertain or lost-response sends are never automatically replayed. Check the source mailbox and Settings → 外部操作记录 after uncertainty.

Fresh external files are SHA256-hashed using incremental `@noble/hashes` updates over 64KiB Blob slices. The metadata call returns an in-memory one-use capability. Axios/XHR transmits the native File/Blob to the documented authenticated streaming PUT without base64 or whole-file JavaScript buffering; upload progress and cancel are visible. Removing an idle handle calls DELETE; failed cleanup stays visible for retry, and expired server stages are reclaimed by the service. Handles are discarded after a send attempt and cannot be reused for a retry. Each file is limited to 25MiB. No arbitrary attachment URL fetch is accepted.

The final unified HTML renderer allows only conservative semantic tags and safe HTTP(S)/mailto links. It excludes styles, scripts, SVG/MathML, embedded content, forms, remote images, event handlers and arbitrary attributes. Original attachment bytes remain available through owned download links.

## Verification and remaining acceptance

Run `pnpm test` for the existing frontend Node session/proxy tests plus mounted Vue components, and `pnpm run build` for the existing release build. Component tests use artificial fixtures and do not prove live provider support, production migrations, aggregate Linux resources, real browser viewport geometry or full original-feature acceptance. The controller performs isolated in-app-browser desktop/phone visual QA. Provider OAuth configuration, authorized real mailbox matrices, Linux/Proton socket and total resource gates, full legacy acceptance and production rollout remain separate required gates. There are no native Android/device controls in this web implementation.
