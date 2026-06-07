---
status: partial
phase: 11-ident-01-webhook-side-line-identity-resolution
source: [11-VERIFICATION.md]
started: 2026-06-07T00:00:00Z
updated: 2026-06-07T00:00:00Z
---

## Current Test

[awaiting human testing — all automated checks passed; these 3 require live production UI/LINE-API interaction]

## Tests

### 1. Verify-link + badge flip (IDENT-06)
expected: In the Mapping Validation panel, verify a real `suggested` link on a messaging contact that has a `pending_review`. The contact's LINE Review badge immediately flips to "Verified student" on next fetch, with no manual recompute click. (Code path covered by 4 TDD tests; live transition needs a real pending review.)
result: [pending]

### 2. Re-anchor followers button (IDENT-03)
expected: Click "Re-anchor followers" in the Mapping Validation workspace. It returns a non-zero `upsertedContacts` count (seeds correct-namespace contacts from `GET /v2/bot/followers/ids`). Clicking a second time reports 0 new upserts (idempotent). Requires the live LINE access token. (Route + idempotency covered by tests; live LINE API call needs production.)
result: [pending]

### 3. Phantom archive scope tab (IDENT-04/05)
expected: Select the "Legacy / needs re-match" scope tab in the link-validation panel. It renders the 696 quarantined phantom rows (HTTP 200, not 400 — WR-01 fixed). Default scope still shows real contacts first. (Route now accepts `scope=phantom`, confirmed by route test; live render not walked through.)
result: [pending]

## Summary

total: 3
passed: 0
issues: 0
pending: 3
skipped: 0
blocked: 0

## Gaps
