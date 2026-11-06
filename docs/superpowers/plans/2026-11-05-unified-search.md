# Unified mailbox search implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Search all collected, owned mail by subject, sender or body from the existing unified mailbox, including selected-account scope and pagination.

**Architecture:** Add a shared bounded literal-search contract, apply parameterized SQLite/D1 predicates before pagination, and carry the same search through the unified store's load/append/refresh requests. Retain the existing source-aware references, ownership checks, authentication and provider integrations.

**Tech stack:** Existing Vue3/Pinia, Hono, Node24/SQLite and Cloudflare D1. No new dependencies, schema changes or paid services.

**Spec:** Owner's 2026-11-05 explicit request “跨邮箱搜索主题、发件人和正文”, plus `docs/superpowers/specs/2026-10-27-cloud-mail-unified-design.md` for privacy, ownership and release invariants.

## Global constraints

- Keep all original Cloud Mail functions and data. Only collected mail is searched; never silently import old provider mail.
- Search is literal substring matching: `%`, `_` and the escape character are ordinary input. SQL uses bound parameters and fixed column allowlists.
- Optional `search` and `searchField` query parameters. Fields: `all` (default), `subject`, `sender`, `body`. Trim surrounding whitespace, maximum 200 UTF-16 code units, reject control characters and invalid types/fields. Empty search preserves the original list behavior.
- Subject/sender and text/HTML body fields participate. SQLite's default ASCII case-insensitive matching applies; Chinese substrings remain supported. Attachments are not searched.
- Query state stays in memory; no URL history, localStorage, logs or exports. Existing signed gateway requests bind the encoded query path.
- Filter on the server before ordering/limit; retain time/reference ordering and account/user predicates. Changing search invalidates stale requests, selected body and old cursors. Append, refresh, source switching and outage recovery retain the applied query.
- Release to the approved personal pilot only after tests, immutable image validation, protected backup and rollback checks. Full 50-account and unverified provider/Android requirements remain open.

## Review focus

1. Same text and source IDs across tenants/accounts must never escape current ownership or selection.
2. SQL metacharacters, Chinese text and HTML-only body content must produce literal, bounded search.
3. Results beyond the first 50 rows must be found, with no skipped ties or mixed-query cursors in normal UI use.
4. Slow previous search replies must not overwrite newer searches or survive logout/account switching.
5. External outage must preserve explicitly incomplete local search results; no misleading complete result or skipping cursor.

## Task 1: Server search contract and both data sources

**Files:** `shared/unified-mail/search.mjs`; `services/mail-sync/src/{core/store,app}.mjs`; `mail-worker/src/service/unified-feed.js`; matching service core and Worker feed tests.

- [x] Write and observe failing real SQLite/service/Worker tests for literal fields, tenant/account exclusion, pagination, bounded invalid inputs and forwarding the normalized query.
- [x] Implement shared parsing/escaping and source-specific fixed predicates before pagination. Keep existing empty-query behavior.
- [x] Run targeted tests and complete relevant suites; commit.

## Task 2: Unified search form and request lifecycle

**Files:** `mail-vue/src/{store/unified.js,views/unified/index.vue}` and `mail-vue/test/components/unified.test.js`.

- [x] Write and observe failing tests for submit/clear, account scope, append/refresh and delayed old replies; search whole server collection rather than filtering loaded rows.
- [x] Implement accessible search form, explicit submit/clear, memory-only applied search and generation resets.
- [x] Run frontend and integration regressions, production build; commit.

## Task 3: Review and guarded personal rollout

- [x] One scoped review of this feature; one consolidated fix wave with regression tests for important findings.
- [x] Build/test/publish the immutable Linux image through the existing protected workflow; independently verify the published image.
- [x] Capture current data/config backup and roll out using current runtime identity and personal-owner restriction. Reconcile actual Worker/runtime state, test owned existing mail through read-only searches, preserve previous versions and recover on failure.
- [x] Publish source and accurate acceptance evidence. Keep unobserved browser/provider/50-account/Android checks explicitly open.
