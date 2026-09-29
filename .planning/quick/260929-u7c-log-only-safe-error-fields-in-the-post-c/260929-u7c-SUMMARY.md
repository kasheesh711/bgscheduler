---
phase: quick-260929-u7c
plan: "01"
status: complete
subsystem: post-class-feedback
tags: [post-class-feedback, logging, security, money-path, vitest]

requires:
  - phase: quick-260929-smo
    provides: "shared collection tick (fix/post-class-collection-tick @ 884bcda, unpushed)"
provides:
  - "safeErrorFields(error): errorName + SQLSTATE/network code + message only for typed PostClass errors"
  - "The auto-approve, ineligible-waive and auto-reopen sweeps and reassess log { id, ...safeErrorFields } instead of the raw error"
affects: [post-class-feedback, docs/features/post-class-feedback.md, docs/operations/runbook.md]

key-files:
  created:
    - src/lib/post-class-feedback/safe-error.ts
    - src/lib/post-class-feedback/__tests__/safe-error.test.ts
  modified:
    - src/lib/post-class-feedback/auto-approval.ts
    - src/lib/post-class-feedback/__tests__/auto-approval.test.ts
    - src/lib/post-class-feedback/reassess.ts
    - src/lib/post-class-feedback/__tests__/reassess.test.ts
    - docs/features/post-class-feedback.md
    - docs/features/post-class-payout.md
    - docs/operations/runbook.md
    - docs/reference/api/internal-crons.md
    - docs/reference/api/post-class-feedback.md
    - docs/reference/crons.md
    - docs/reference/database/erd-post-class-feedback.md

key-decisions:
  - "Owner (2026-09-29): keep the class, the code, the ids and app-written messages; drop every driver or unknown message"
  - "Allowlist by instanceof (PostClassValidationError, PostClassConflictError, PostClassNotFoundError), never by error.name"
  - "code = error.code, else cause.code (drizzle 0.45 wraps the driver error), only if it matches /^[A-Z0-9_]{2,40}$/"
  - "collection-tick.ts keeps its class-only { pass, errorName } lines, as the owner specified for the tick"

requirements-completed: [U7C-SAFE-FIELDS, U7C-SWEEP-SITES, U7C-TESTS, U7C-DOCS]
completed: 2026-09-29
---

# Quick 260929-u7c: Safe error fields in the post-class deduction sweeps — Summary

**The four catches that logged whole error objects where deductions move now log
`[tag] { deductionId | wiseSessionId, errorName, code?, message? }`:**
- `auto-approval.ts`: the auto-approve, ineligible-waive and auto-reopen sweeps.
- `reassess.ts`: the per-session catch.

`code` is the SQLSTATE or network code. `message` appears only for the domain's typed errors, whose text the
code writes. A drizzle `DrizzleQueryError` message (SQL plus parameters) or a `pg` detail (row values) is never
logged.

Branch `fix/post-class-safe-error-logs` in worktree `/Users/kevinhsieh/Developer/Scheduling-post-class-hardening`,
stacked on `fix/post-class-collection-tick` (884bcda) → #100 → #99. Not pushed.

## Commits

1. `31c9a26` fix: `safe-error.ts` and its test (14 cases), plus the 4 call sites and their tests (3 sweep cases,
   1 reassess case).
2. `ee1c88d` docs:
   - The log shape is described in the feature doc and the runbook.
   - The new import lines moved `auto-approval.ts` and `reassess.ts` down by one line, so every doc citation into
     them shifts +1.
   - Two relative ranges on edited lines were already stale; they are now fixed (the waiver actor's comment, the
     per-tick sweep order, the hygiene sweep).

## RED → GREEN

- **RED:** `safe-error.test.ts` could not import the module, and the 4 site cases failed on the raw-object
  logging. Reassess logged 3 arguments.
- **GREEN:** 40/40 across the 3 files.
- **Mutations** (each reverted): message for every Error (11 fail), cause code ignored (6), any string accepted as
  a code (3), approve sweep logs the raw error (1), reassess drops the id (1).

## Verification

- typecheck 0.
- eslint: changed files clean; repo 0 errors / 18 pre-existing warnings.
- `npm test`: **488 files / 5674 tests**.
- Integration (Docker) `auto-approval` + `payout-accrual`: **2 files / 31 tests**.
- Every shifted citation checked against the line it names; `git diff --check` clean.

## Decisions

- **Sweep path:** `applyPostClassReviewAction` throws only the three typed classes (50 sites); anything else is
  the database driver. Their interpolations on the sweep path are codes, labels and months, so keeping typed
  messages loses no operator diagnostic.
- **Recovery work:** the 2026-09 payout-stall recovery relied on audit digests and SQL, not on these lines.

## Not changed (noted for the owner)

- **Six payout-side logs.** `payout-accrual.ts:103,172` (raw objects) and `payout-retirement.ts:221,261` (raw
  objects), plus two `error.message` lines for typed retryable conflicts, which are already safe. Some useful app
  messages there are plain `Error`s: `requirePayoutGoogleTarget` names the missing env vars, and
  `DuplicatePayoutSignatureError` names the duplicate signature. A typed-only allowlist would drop both, so that
  change needs its own decision.
- **`api.ts` and `collection-tick.ts` logging** is unchanged.
