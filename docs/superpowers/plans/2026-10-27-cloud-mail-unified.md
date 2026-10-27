# Cloud Mail Unified Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Execute task-by-task; checkbox steps track completion.

**Goal:** Extend the existing Cloud Mail without losing any behavior or data, add multi-provider mail sync and a signed Android APK, and publish/verify the approved deployment.

**Architecture:** Keep Vue/Hono/Cloudflare as the existing application and compatibility boundary. Add a tenant-scoped Node 24/SQLite sync service on AWS and a private Go Proton helper. Kotlin WebView reuses the site, while WorkManager implements explicitly delayed background notifications.

**Tech Stack:** Existing Vue3/Element Plus/Hono/Drizzle; Node 24, node:sqlite WAL, node:test, streaming MIME, IMAP/SMTP/OAuth2; isolated Go client; Kotlin/WorkManager; Docker/Caddy/GitHub Actions.

**Spec:** ../specs/2026-10-27-cloud-mail-unified-design.md (approved by the user, including subsequent sidebar/publication/folder choices).

## Delivery priority update — 2026-10-28

The owner explicitly directed: prioritize making the web application ready for normal use, then start mobile development. This supersedes the original task numbering as an execution order; it does not remove the Android deliverable.

Execute Tasks 1–5 first. Then execute the web/service portions of Task 7 (Linux CI, bounded service/helper image, protected preview, backup/rollback tooling) and the web portions of Task 8 (original-feature regression, tenant/invite/security tests, resource acceptance and authorized real-mailbox tests). Roll out the web application after its own acceptance gates pass. Android installation/notification checks are not prerequisites for the web rollout.

Only after the web application is verified usable, start Task 6 Android implementation, complete Task 7 APK signing/release workflows and Task 8 Android/physical Honor acceptance. Existing SDK/signing preparation is retained; no further mobile development runs during the web delivery phase. Real-provider support remains individually verified or explicitly pending; neither a partial provider test nor a placeholder UI establishes broad compatibility.

In Tasks 4–5, defer Android-specific device enrollment/notification endpoints, native-binding components and their tests to the post-web Task 6 integration phase. Their interfaces remain planned, but they do not block usable web delivery. Responsive web behavior on phone browsers remains part of Task 5. Deferred mobile controls must not appear as functional placeholders in the web application.

## Global Constraints

- Preserve every existing function, account, mail, setting and deployed customization; production backup/version comparison precedes deployment.
- 5 users, 50 accounts, about 100 incoming messages/day; invite-only self-registration; users own their external mail.
- No additional paid service; public repository/APK; no production or mailbox credential in git, logs, localStorage, exports or APK.
- Only post-binding normal incoming mail, including archive/rule folders; exclude spam/trash/drafts/sent. Keep original historical content and features.
- Desktop fixed full sidebar; phone fixed approximately 56px rail; body panes scroll separately.
- New-service memory cap 320MiB; parse concurrency 1; reconnect concurrency 2; builds in CI; do not stop other server apps.
- Android >=8, Android16 target testing; 15-minute inexact WorkManager cycle; no vendor registration and no permanent foreground notification.
- SSH only via AWS alias with strict host checking; never export/upload the existing private SSH key.
- Never run upstream mail-worker npm test blindly: it invokes deployment. Test commands must be made local and deployment separately named.
- Web usability and rollout have priority over Android implementation; follow the delivery-priority update above.
- Real provider and phone tests remain incomplete until observed; no fake connected states or fabricated coverage.

## Review Focus

1. Identical message IDs in different accounts/tenants must never cross-read or cross-delete (Tasks 1/4).
2. Reconnect, UIDVALIDITY reset and archive/rule moves must neither import history nor lose post-binding mail (Tasks 2/3).
3. SMTP ambiguous acceptance and failed source mutations must not report success or resend automatically (Tasks 2/4).
4. Malicious HTML, filenames, private-network hosts and OAuth/secret errors must not leak credentials or cross the gateway (Tasks 1/2/4/6).
5. APK logout/account switch and delayed/retried background work must not notify for the prior owner or duplicate notifications (Task 6).

## Shared interfaces and ownership

New pure contracts live in shared/unified-mail/. Gateway identity is `{ ownerId, sessionId, issuedAt, nonce }`, verified server-side. Message references are opaque and source-qualified. The sync service receives authenticated identity, never a client-supplied owner override. New paths in the spec are additive; old APIs remain compatible.

The implementation ledger records exact exported store/adapter methods before consumers are dispatched. Tasks run serially; later tasks may change shared integration points only with compatible contract tests. The controller owns deployment operations and ledger, workers own their assigned product code. No worker spawns subagents.

### Task 1: Tenant-safe sync foundation and local test safety

**Files:** shared/unified-mail/*; services/mail-sync/{package.json,src/core/*,src/app.mjs,src/index.mjs,tests/core/*}; local test script safety in mail-worker/package.json.

**Interfaces:** Produce `openStore({dbPath,dataDir,masterKey,clock})`, `createSyncApp({store,gatewayKey,clock})`, source-ref/cursor helpers, and documented account/message/checkpoint/operation/device repositories. HTTP errors contain safe codes, not raw secrets.

- [ ] Write failing node:test cases for tenant isolation, encryption AAD swapping, signed assertion expiry/replay, refs/cursors, credential-free DTOs, atomic checkpoints, attachment path confinement and the dangerous upstream test script.
- [ ] Run focused tests and record expected RED failures.
- [ ] Implement SQLite WAL, AES-GCM per-field encryption, write-only credential handling, authenticated Hono application foundation and bounded parsing. Rename deployment test script to deploy:test and make test local.
- [ ] Run all Task 1 tests plus existing applicable local baseline checks; record interface contract and evidence in the report.
- [ ] Commit; obtain independent spec+quality review before Task 2.

### Task 2: IMAP/SMTP, OAuth and durable account synchronization

**Files:** services/mail-sync/src/{providers,sync,send,routes}/*; services/mail-sync/tests/{protocol,sync}/*; integrate app.mjs and dependency lock.

**Interfaces:** Consume Task 1 repositories/contracts; produce provider registry, `syncAccount({ownerId,accountId,signal})`, source actions and account/message routes. Provider sessions expose folder inventory, stable checkpoints, changes, MIME fetch, flags, move-to-trash, send and close.

- [ ] Write RED tests using deterministic local protocol fixtures for auth failures, reconnect, rule/archive folders, first-binding cutoff, UID reset, deleted source, duplicate events, token refresh, private-IP rejection, streamed attachments and ambiguous SMTP acceptance.
- [ ] Run and record RED; implement IMAP/SMTP presets and manual config, Google/Microsoft OAuth PKCE/state/refresh, explicit pending/reauth/error statuses and fair bounded scheduling.
- [ ] Implement persistent mutation status, source-identity send/reply/forward and no automatic resend on uncertainty. Preserve original attachment bytes; never store credentials client-side.
- [ ] Run entire sync-service suite and local SMTP/IMAP integration tests; record real-provider tests as pending until secure owner authorization.
- [ ] Commit; independent task review.

### Task 3: Isolated Proton adapter

**Files:** services/proton-helper/* including tests, pinned third-party source/license; services/mail-sync/src/providers/proton.mjs and protocol tests.

**Interfaces:** Produce a private Unix-socket JSON protocol consumed by the Node provider registry; records use Proton stable MessageID/event cursor, not volatile IMAP UID. Authentication/MFA is an expiring interaction, with encrypted persisted session material.

- [ ] Write RED helper/protocol tests for event cursor recovery, post-binding boundary, stable message IDs across resync, read/unread, move-to-trash, MIME/attachments, interrupted auth and source errors.
- [ ] Vendor/pin the approved hydroxide client revision and MIT attribution; implement helper operations, bounded streams and safe log/error output. No public bridge listeners and no plaintext secrets in arguments/logs.
- [ ] Run Go suite, Node integration suite and Linux socket checks; verify free and paid accounts separately only when authorized.
- [ ] Commit; independent task review.

### Task 4: Cloudflare gateway, unified API, cookies and devices

**Web-first execution override:** Complete gateway/unified mail, cookie/Bearer migration, CSRF, invitation enforcement, safe attachment upload and web tests first. Implement the device enrollment/notification-only API subsection together with Task 6 after web rollout; keep those original requirements and tests pending until then.

**Files:** mail-worker/src/{api,service,security,utils} new unified/external/device modules and necessary existing auth/registration integrations; mail-worker tests; mail-vue/src/axios/index.js and login/bootstrap migration only.

**Interfaces:** Implement spec routes /api/external/accounts, /api/unified/messages and /api/devices. Cookie session is primary for browser; legacy Bearer remains accepted. Device binding uses one-time PKCE-bound code; exchanged device token has notification-only permission. Sync forwarding derives owner from existing authentication.

- [ ] RED tests: every tenant boundary, legacy API compatibility, valid/invalid invite across all account-creation paths, cookie flags, legacy-session migration, CSRF, opaque same-ID refs, stable merged pagination, sync outage with local mail still working and device token scope/revocation.
- [ ] Implement gateway and normalized feed, source-aware content/actions/attachments, cookie migration and stateful OAuth callbacks. Do not forward arbitrary owner headers or expose sync credentials.
- [ ] Enforce no false success for pending mutations; source service failure is explicit without disabling original Cloud Mail functions.
- [ ] Run full local worker and service suites, never deploy through a test command. Commit and independent review.

### Task 5: Fixed sidebar and external/unified UI

**Web-first execution override:** Deliver desktop and responsive phone-browser mail UI first. Native Android binding components are deferred to Task 6 and must not be shown as working controls before implementation.

**Files:** mail-vue/src/layout/* and account/email stores/views; new external-binding/unified/native-binding components and frontend tests.

**Interfaces:** Consume Task 4 APIs and its browser session. Preserve all original routes and feature entries. Add source-aware selection and status without altering legacy account IDs.

- [ ] RED component tests for fixed desktop sidebar, persistent phone rail/expansion, all-account selection, correct source actions, auth recovery, original feature reachability, attachment links and no secret persistence.
- [ ] Implement approved layout using existing UI system; add provider binding/status/re-auth flows, normal-folder unified view, safe HTML/error display and source-correct compose/reply/forward.
- [ ] Keep original mail, drafts, stars, search, management, optional AI and push functionality. New code never fabricates supported or connected state.
- [ ] Run frontend component suite/build plus worker/service suites covering integration changes; browser/manual QA only with evidence.
- [ ] Commit and independent review.

### Task 6: Android APK and delayed background notifications

**Files:** android/*; frontend native binding component/helper only; native tests and documentation.

**Interfaces:** Kotlin trusted-origin WebView plus native downloads/Keystore/WorkManager. Application ID top.m3899178.cloudmail; minSdk 26, compile/target API36. Consume Task 4 one-time device exchange and notification-only endpoints.

- [ ] RED tests for trusted-origin/main-frame restrictions, one-time exchange, secure storage, scoped token, logout/account switch, denied permission, notification dedupe and retries.
- [ ] Implement WebView navigation allowlist, secure device binding, original attachment download, 15-minute periodic work and generic unread-count notifications. No vendor SDK or permanent foreground service.
- [ ] Add reproducible Gradle wrapper and signing configuration using private CI Secrets; no signing material in git. Keep stable signing identity for upgrades.
- [ ] Run JVM tests/build and Android16 instrumented checks in CI; explicitly retain Honor physical installation/background acceptance as pending until observed.
- [ ] Commit and independent review.

### Task 7: CI, bounded containers and preview deployment tooling

**Files:** .github/workflows/* reviewed activation; deploy/*; Dockerfiles; safe backup/rollout/verification scripts and operator docs.

**Interfaces:** Build public Linux amd64 image containing service/helper in CI; bind only intended internal listeners. Reuse current Caddy with separate mail-sync HTTPS host. Resource cap 320MiB, parse concurrency 1, reconnect 2. Production requires baseline/backup receipt.

- [ ] RED/static integration tests for no deploy-on-test, no secrets in build context/image/artifacts, resource limits, gateway protection, backup-before-rollout and non-destructive Caddy updates.
- [ ] Implement local/preview/production configurations with placeholder-only checked-in config; private deployment files stay outside repository. SSH private key is never a CI secret.
- [ ] Enable only reviewed workflows. PR tests do not access release/production secrets; public standard Linux jobs and public images only. Publish signed APK/checksums only on approved release workflow.
- [ ] Verify image/smoke/rollback scripts and CI; commit and task review.

### Task 8: End-to-end regression, release and observed acceptance

**Files:** integration tests, original-feature regression matrix, operator/user manual, release evidence; minimal fixes as reviewed.

**Interfaces:** Integrate all prior tasks and controller-operated baseline/backup/authenticated deployment. A live verification matrix tracks each provider separately, including Proton free/paid and school mailbox.

- [ ] Add/run full scenarios: 5 tenants/50 accounts, 100-mail/day workload plus bursts, source ID collisions, normal folders, first-bound cutoff, reconnect, UID/event reset, attachments, mutation failure, source deletes and preserved original feature inventory.
- [ ] Verify container memory/load inside the approved cap and no impact on other server apps. Do not deploy if this fails.
- [ ] Perform authorized provider tests using safe configuration UI and controlled mail only; never send to other people without explicit instruction. Check real source read/delete and attachment hashes.
- [ ] Perform Android install/upgrade/signature, permission, delayed-work and real Honor background checks. Unobserved checks remain incomplete.
- [ ] Obtain broad final review, fix through one reviewed wave, then controller rolls out only after protected backups and preview/regression gates. Publish source, image, signed APK and SHA256; record URLs/commit/digests.
- [ ] Keep the goal active for remaining real-account/device evidence. No partial test set or demo can establish complete delivery.
