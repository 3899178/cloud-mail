# Task7a pinned-client change provenance

Source remains emersion/hydroxide commit `02b3b6c8aff726d2404b6ed5f6ba1b7937e1f30e`, MIT Copyright2017 emersion. Existing LICENSE, module pin and prior safety patches remain intact. No new upstream features or bridge/auth-disk code were copied.

The exact incremental patch against this repository's reviewed base `3e0b409042099828fc1772fd4dec2d245aba2bf4` is `task7a-client.patch`:

- `events.go`: expose `More *int` (nil detects a missing pagination field) and `Labels []json.RawMessage` (any label-definition change forces a safe full snapshot).
- `messages.go`: serialize the already-declared `MessageFilter.ID` values as repeated `IDs[]` query parameters. Responses must cover exactly those IDs; filtering ignored by a provider therefore fails closed.

These five added lines were authored for this adapter, not imported from a different upstream revision. Identical files are mirrored at `vendor/github.com/emersion/hydroxide/protonmail/`; compare raw SHA256 or regenerate the normal vendor tree when changing dependencies. Tests in helper `incremental_test.go` use the pinned client over actual HTTP JSON to exercise field decoding, IDs[] serialization, pagination, refresh/label/expiry fallback, deletion/movement, missing pagination fields, incomplete filtering and cancellation. Existing nested `go test ./protonmail` still passes.

Protocol field support and code18001 are fixture assumptions requiring real-provider verification; any mismatch must remain a sync failure, never an empty successful inventory. Missing More does not silently mean no further pages.
