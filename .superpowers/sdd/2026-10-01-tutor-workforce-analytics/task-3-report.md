# Task 3 Report — History Backfill and Reviewed Subject Mappings

## Implementation

- Added a monthly, serial Wise history backfill with required request/page caps, atomic private checkpoint files (`0600`), resumable complete windows, dry-run default, and explicit `--apply` writes.
- Added reviewed exact-label subject mappings. Class ID + exact session title wins; a reviewed global exact alias is the fallback. Unreviewed, changed, ambiguous, and unmapped labels stay unknown. Create operations serialize duplicate checks; updates use expected revisions and return conflict on stale writes.
- Added admin-only no-store mapping GET/POST routes. The unmapped list retains exact Wise session titles and class IDs with booked-hour totals.
- Retained raw booking classification fields (`classType`, `purpose`, `title`) in normalized workforce sessions and added post-promotion Credit Control capture. Classification capture uses original observation time and is best-effort so it cannot undo a successful source sync.

## RED / GREEN and checks

- RED: source-sync test initially failed because the backfill module did not exist. Route tests also caught an invalid test UUID, and a stale assertion expected private raw facts inside the public checkpoint result.
- GREEN: focused unit suites pass: 4 files, 20 tests (`source-sync`, `subject-mappings`, Wise adapter, mappings route).
- `npm run typecheck` reports no errors in Task 3-owned files. Remaining errors are concurrent Task 4 work: missing `workforce/service` and `aggregate` modules, plus one fixture missing `sourceCoverage.issueCodes`.
- A bounded live GET on 2026-09-30 used 2 requests / 2-page cap and returned 80 sessions. The returned date page was complete; the probe reports request-cap exhaustion overall. Participant membership remains partial because the source does not prove historical roster completeness.

## Source classification findings

- Among those 80 sessions, `classType` was `ONE_TO_ONE` (79) and `LIVE` (1); no `purpose` values were present. Titles were present for all 80; none contained a trial or pretest marker. The existing March/September probes predate raw classification retention.
- Do not infer regular/trial/pretest from `classType`. The current sample needs reviewed academic mappings or explicit title markers before it can support booking classification.
- Existing credit-history evidence verifies some net `SESSION` movements; unrelated `CREDIT` rows are not summed. Refund semantics remain unverified. The owner-confirmed one-credit-per-scheduled-hour policy supplies the normal denominator independently of net-credit verification.

Private raw probe output is retained under ignored `.tutor-offboarding/capacity-redesign/`; it is not committed.
