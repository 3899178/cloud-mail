# NetEase missing UIDNEXT compatibility — candidate evidence

Status: candidate implemented and locally verified; production still runs the previous image. This is not a claim of completed NetEase receive/send acceptance.

## Observed failure

Bounded diagnostics against the owner's existing 163, 126 and yeah bindings authenticated, listed six folders, and opened INBOX successfully. SELECT/EXAMINE omitted UIDNEXT; STATUS also omitted it in the subsequent checks. FETCH returned the two existing message metadata records and populated ImapFlow's local UIDNEXT estimate. The original adapter rejected this estimate change at its final snapshot consistency check. Credentials did not need replacing.

The diagnostic temporarily paused only the tested account through the existing lifecycle API and resumed it afterward. All three probes preserved the ten accounts and the credential ciphertext hash. They fetched metadata only, sent no mail, and did not write source checkpoints. Original production synchronization still reported SYNC_FAILED afterward, as expected before deployment.

## Change

Keep a missing server UIDNEXT distinct from the client's estimate. Without a server boundary, retain full UID/flag inventory verification and a separately persisted, monotonic observed UID boundary for historical exclusion. Never lower that boundary when the largest UID disappears. Servers that report UIDNEXT retain their existing CONDSTORE optimization. No schema or credential migration is required.

## Evidence before deployment

- Three new real TLS protocol tests first failed against the original adapter at the actual snapshot check, then passed after the change. The first sandbox attempt was invalid evidence because loopback access was denied; the subsequent authorized local run reproduced SYNC_FAILED.
- `node --test --test-timeout=15000 tests/protocol/missing-uidnext.test.mjs tests/protocol/incremental.test.mjs tests/protocol/gmail-received.test.mjs`: 16 passed, zero failed. Coverage includes restart, initially empty folders, historical body exclusion, old-date new UID admission, partial-scan refusal, unchanged checkpoints, read state, deletion, same-count replacement, and high-water preservation.
- Full service suite: 133 tests, 132 passed, zero failed, one Windows platform skip. Linux acceptance remains required.
- A separate scoped review found no actionable defect and independently reran the 16 protocol tests successfully.
- The candidate adapter, loaded into a separate diagnostic process without replacing application files, scanned INBOX and the empty normal folder on all three real bindings. 126 and yeah also passed candidate snapshot revalidation. Production was left on its original image.

## Remaining release gates

Build and test this immutable source on the existing free Linux publication workflow; verify the exact published image; take a fresh backup compatible with the current runtime; update with rollback protection; verify actual synchronization and owner-operated new mail, attachment and state reconciliation. Do not mark these three providers fully accepted based on metadata probes alone.
