---
status: partial
phase: 11-ident-01-webhook-side-line-identity-resolution
source: [11-VERIFICATION.md]
started: 2026-06-07T00:00:00Z
updated: 2026-06-07T00:00:00Z
---

## Current Test

[HALTED — UAT did not close. Infra works, but the matching STRATEGY does not reliably map parents->students on real data (goal-gap). Investigation captured in 11-IDENTITY-FINDINGS.md; needs a matching-redesign follow-up phase.]


## Tests

### 1. Verify-link + badge flip (IDENT-06)
expected: In the Mapping Validation panel, verify a real `suggested` link on a messaging contact that has a `pending_review`. The contact's LINE Review badge immediately flips to "Verified student" on next fetch, with no manual recompute click.
result: issue
reported: "Worklist now populates after the run-default fix (IDENT-04 ok), but the suggestions themselves are unreliable noise (one contact -> 9 unrelated students). Could not proceed to verify. Matching strategy needs redesign. See 11-IDENTITY-FINDINGS.md."
severity: blocker

### 2. Re-anchor followers button (IDENT-03)
expected: Click "Re-anchor followers" in the Mapping Validation workspace. It returns a non-zero `upsertedContacts` count (seeds correct-namespace contacts from `GET /v2/bot/followers/ids`). Clicking a second time reports 0 new upserts (idempotent). Requires the live LINE access token. (Route + idempotency covered by tests; live LINE API call needs production.)
result: [pending]

### 3. Phantom archive scope tab (IDENT-04/05)
expected: Select the "Legacy / needs re-match" scope tab in the link-validation panel. It renders the 696 quarantined phantom rows (HTTP 200, not 400 — WR-01 fixed). Default scope still shows real contacts first. (Route now accepts `scope=phantom`, confirmed by route test; live render not walked through.)
result: [pending]

## Summary

total: 3
passed: 0
issues: 1
pending: 2
skipped: 0
blocked: 0

## Gaps

- truth: "The widened worklist shows real messaging-contact suggestions by default (IDENT-04)"
  status: resolved
  reason: "UAT: active worklist appeared empty (only the Legacy/phantom scope had rows), despite 9 real message_content suggestions existing in production. Root cause: mapping-validation-workspace defaulted selectedRunId to the most recent OA-resolver run (runs[0].id), and listLineLinkValidationTasks filters sourceRunId = runId; the new real-contact suggestions have NO resolver run, so they were excluded. Plan 05 widened the query but the UI default re-narrowed it to a resolver run."
  severity: major
  test: 1
  fix: "Default selectedRunId to null (All resolver runs) in mapping-validation-workspace.tsx loadRuns; the run dropdown still narrows to a legacy run on demand."
  verified: "tsc 0, eslint clean, suite 1119/1119; pending live re-test after deploy."

- truth: "Suggestions reliably map the parents who message onto the correct students (phase goal / IDENT-01)"
  status: failed
  reason: "Production matcher produces noisy, mostly-wrong suggestions (fuzzy tier floods short Thai nicknames; one contact -> 9 unrelated students) and low recall (no historical backfill). The human-verified mappings cannot be reused by ID (OA-Manager vs Messaging-API namespaces, 0 overlap, confirmed against @begifted). Bridge is name-only. Requires a matching-strategy redesign."
  severity: blocker
  artifacts: ["11-IDENTITY-FINDINGS.md"]
  resolution: "Follow-up phase: verified-ground-truth anchor + 1962-follower name cross-walk + per-contact aggregate + parent-identity-first + drop fuzzy + historical backfill."
