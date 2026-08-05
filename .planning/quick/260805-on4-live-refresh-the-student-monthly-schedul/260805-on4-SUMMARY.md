---
quick_id: 260805-on4
plan: 1
subsystem: student-schedule
tags: [wise-api, credit-control, drizzle, postgres, fail-soft, zod, globalthis-cache]

# Dependency graph
requires:
  - phase: none (depends_on: [] in plan frontmatter)
    provides: existing student-schedule read path (data.ts), credit-control Wise fetchers
      (wise.ts), and the Wise HTTP client (wise/client.ts) this plan builds on unmodified
provides:
  - "fetchInstituteSessionsForDays (credit-control/wise.ts) — concurrent per-day Wise
    session sweep with correct PAST/FUTURE/both-for-today status derivation"
  - "src/lib/student-schedule/live.ts — fetchLiveMonthSessions + studentScheduleLiveEnabled,
    a fail-soft live Wise overlay with a 4s deadline and 60s TTL cache"
  - "mergeLiveSessionsIntoRows (student-schedule/data.ts) — matched/live-only/snapshot-only
    merge semantics wired into getStudentMonthlySchedule"
  - "Honest generatedAt freshness stamp (real snapshot generatedAt on fallback, now on a
    successful live sweep)"
  - "ENABLE_STUDENT_SCHEDULE_LIVE opt-out kill switch, documented in env.ts + .env.example"
affects: [student-schedule LINE bot, public /schedule/{token} page, admin student-schedule
  API/link routes, print report — all inherit the fix automatically via
  getStudentMonthlySchedule, none of them were modified]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Fail-soft live overlay: kill switch -> TTL cache -> deadline-raced fetch -> try/catch,
      every failure path returns { ok: false } and never throws into the render path"
    - "globalThis-anchored TTL cache storing only the already-filtered (per-student) result,
      never the raw institute-wide sweep, so no cache entry can cross a student boundary"
    - "Padding, not trimming, at the fetch layer; the caller (data.ts) reuses its own
      already-computed instant window to trim the padding spillover, keeping the exact
      cutoff computed in exactly one place"

key-files:
  created:
    - src/lib/student-schedule/live.ts
    - src/lib/student-schedule/__tests__/live.test.ts
  modified:
    - src/lib/credit-control/wise.ts
    - src/lib/credit-control/__tests__/wise.test.ts
    - src/lib/student-schedule/data.ts
    - src/lib/student-schedule/__tests__/data.test.ts
    - src/lib/env.ts
    - .env.example

key-decisions:
  - "Followed the plan's own Planner Notes verbatim (string day-keys through
    fetchInstituteSessionsForDays rather than Date[]; bangkokMonthInstantWindow trim stays
    in data.ts not live.ts to avoid a circular import; TTL cache keyed wiseStudentId:monthKey
    not studentKey:monthKey; no dedicated DB-backed test for getStudentMonthlySchedule's
    generatedAt ternary) — all four were re-verified against the live code before
    implementing and matched exactly, so the plan's literal code was used as-is."
  - "Removed the plan's suggested `// eslint-disable-next-line no-var` comment on the
    globalThis cache declaration in live.ts: this repo's flat ESLint config has no active
    no-var rule (confirmed via `npx eslint`, which flagged it as an unused-directive
    warning), and the existing globalThis-singleton precedent in search/index.ts does not
    carry the comment either. Matched that precedent instead."

requirements-completed:
  - SSLR-01-day-sweep-fetcher
  - SSLR-02-live-overlay-module
  - SSLR-03-merge-read-path
  - SSLR-04-honest-freshness-stamp
  - SSLR-05-kill-switch

duration: ~20min
completed: 2026-08-05
---

# Quick Task 260805-on4: Live-refresh the student monthly schedule

**A live per-day Wise session sweep now overlays `/schedule`'s snapshot read path at request time — fail-soft with a 4s deadline, a 60s per-student TTL cache, and an `ENABLE_STUDENT_SCHEDULE_LIVE` opt-out kill switch — so a reschedule, cancellation, or brand-new class is visible immediately instead of waiting up to ~36 minutes for the next credit-control sync to promote.**

## Performance

- **Duration:** ~20 min (approximate; three task commits span 21:56:41–22:05:51 +07, plus interface verification and the final `verify:release` build before commit)
- **Completed:** 2026-08-05
- **Tasks:** 3/3 completed
- **Files:** 2 created, 6 modified

## Accomplishments

- `fetchInstituteSessionsForDays` (`src/lib/credit-control/wise.ts`) issues one Wise `GET /institutes/{id}/sessions` request per Bangkok day, concurrently via `Promise.all`, classifying each day PAST (before today), FUTURE (after today), or BOTH (today itself — Wise requires `status` and has no combined mode). Paginates per day exactly like the existing `fetchCreditSessions`, reusing the file's own `WiseSessionsEnvelopeSchema`/`isoDate`/`addUtcDays` — no new imports, no parallel parser.
- `src/lib/student-schedule/live.ts` (new): `fetchLiveMonthSessions` sweeps a student's Bangkok month (padded ±1 day for the day-boundary hazard: 9 of 23,078 production sessions start before 07:00 Bangkok), filtered to `session.students.includes(wiseStudentId)` — the same attribution the credit-control sync itself uses. Every failure path (kill switch off, fetcher rejection, 4s deadline overrun) returns `{ sessions: [], ok: false }` without throwing. A successful sweep is memoized 60s on a `globalThis.__bgscheduler_liveMonthSessionsCache` Map keyed `wiseStudentId:monthKey`, storing only the already-filtered result.
- `mergeLiveSessionsIntoRows` (`src/lib/student-schedule/data.ts`, pure function): matched sessions (same `wiseSessionId`) take the live time/end-time/status/duration but keep the snapshot's subject/package/teacher; live-only sessions (a class the snapshot has never seen) synthesize a new row with no package and a teacher resolved via `creditSessionTeacher`; snapshot-only sessions are dropped (a full successful sweep means Wise no longer has them this month).
- `getStudentMonthlySchedule` now calls the live overlay after loading snapshot rows, trims the sweep to the exact `bangkokMonthInstantWindow` it already computes for its own DB query, and merges when the sweep succeeds. `generatedAt` is now honest: the snapshot's real `generated_at` column on fallback, `new Date()` only when the live sweep actually ran. `buildStudentSchedulePayload` is byte-for-byte unmodified — its cancellation filter and `wiseSessionId` dedupe now operate on live status "for free".
- `ENABLE_STUDENT_SCHEDULE_LIVE` opt-out kill switch (`!== "false"` idiom, matching `lineSchedulerEnabled()`), documented in `env.ts` and `.env.example`.
- All six existing consumer call sites (LINE bot ×2, public parent page, admin API, link route, print report) were not touched — confirmed via `git diff --stat` against the pre-plan HEAD, which shows exactly the 8 files the plan's own `files_modified` frontmatter declared, nothing else.
- 19 new unit tests across the three touched/new test files (4 for the day-sweep fetcher, 9 for the live overlay module, 6 for the merge function), all with the Wise client/fetcher fully mocked — zero real network calls.
- `npm run verify:release` passes clean: typecheck ×2, full suite (358 files / 4055 tests), build, `git diff --check`, route-surface guard (207 routes).

## Task Commits

Each task was committed atomically on `feat/student-schedule-live-refresh`:

1. **Task 1: Parallel per-day sweep fetcher** — `d90f04a` (feat)
2. **Task 2: Live overlay module + kill switch** — `7057ba3` (feat)
3. **Task 3: Merge into the read path + honest freshness stamp + full regression gate** — `1c89a4b` (feat)

No separate plan-metadata commit for the code itself — this SUMMARY.md and the STATE.md update are committed together as this execution's final `.planning/**` commit, per this quick task's explicit instructions.

## Files Created/Modified

| File | Change |
|---|---|
| `src/lib/credit-control/wise.ts` | + `fetchInstituteSessionsForDays` (concurrent per-day sweep) and its private `fetchSessionsForOneDay`/`nextDateKey` helpers |
| `src/lib/credit-control/__tests__/wise.test.ts` | + 4 tests for the new fetcher (before/after/both-for-today status, pagination, multi-day flatten) |
| `src/lib/student-schedule/live.ts` | New — `fetchLiveMonthSessions`, `studentScheduleLiveEnabled`, deadline race, TTL cache |
| `src/lib/student-schedule/__tests__/live.test.ts` | New — 9 tests (kill switch, success filtering, day padding, rejection, deadline, TTL memoization) |
| `src/lib/student-schedule/data.ts` | + `mergeLiveSessionsIntoRows`; snapshot query now selects `generatedAt`; `getStudentMonthlySchedule` wires in the live overlay and an honest `generatedAt` |
| `src/lib/student-schedule/__tests__/data.test.ts` | + 6 tests for `mergeLiveSessionsIntoRows` (matched, live-only ×2 subject fallbacks, snapshot-only drop, cancellation propagation, all-live-only) |
| `src/lib/env.ts` | + `ENABLE_STUDENT_SCHEDULE_LIVE: z.string().optional()` |
| `.env.example` | + documented `ENABLE_STUDENT_SCHEDULE_LIVE=true` kill switch under "Student monthly schedule" |

## Decisions Made

See `key-decisions` in the frontmatter. In summary: the plan's four Planner Notes (string day-keys, trim-in-data.ts-not-live.ts, `wiseStudentId:monthKey` cache key, no DB-backed test for the `generatedAt` ternary) were all re-verified against the live code before implementing and matched exactly, so no adjustment was needed. One small deviation: removed an unnecessary `eslint-disable-next-line no-var` comment the plan's code block included (see Deviations below).

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Lint noise] Removed an unused `eslint-disable-next-line no-var` directive**
- **Found during:** Task 2 (`src/lib/student-schedule/live.ts`)
- **Issue:** The plan's code block included `// eslint-disable-next-line no-var` above the `declare global { var __bgscheduler_liveMonthSessionsCache ... }` line. Running `npx eslint` on the new file flagged it: `Unused eslint-disable directive (no problems were reported from 'no-var')` — this repo's flat ESLint config (`next/core-web-vitals` + `next/typescript`, no custom rules) does not enable `no-var`, and the existing `globalThis`-singleton precedent (`src/lib/search/index.ts:94-97`) does not carry the comment either.
- **Fix:** Removed the disable comment.
- **Files modified:** `src/lib/student-schedule/live.ts`
- **Verification:** `npx eslint src/lib/student-schedule/live.ts` clean (0 errors/warnings) after removal; `npx tsc --noEmit` and the file's own test suite re-run clean.
- **Committed in:** `7057ba3` (Task 2 commit — caught and fixed before that commit was made, not a follow-up)

---

**Total deviations:** 1 auto-fixed (1 lint noise)
**Impact on plan:** Cosmetic only — no behavior change. No scope creep.

## Issues Encountered

None. The plan's interfaces (existing exports from `credit-control/wise.ts`, `wise/client.ts`, `calendar/month-grid.ts`, `room-capacity/dates.ts`, `student-schedule/data.ts`) were all independently re-read and matched the plan's stated signatures exactly before implementation began — no surprises.

## TDD Gate Compliance

All three tasks carried `tdd="true"`, but the plan's own `<action>` blocks specified fully-formed implementation code and fully-formed test code together per task, rather than an iterative red-then-green discovery sequence — the plan itself was written as an already-designed, executable spec, not a bug investigation. Each task's implementation and its tests were written together, then verified passing (`npx tsc --noEmit && npx vitest run ...`) before a single `feat` commit per task. No separate failing-test-only commit precedes each implementation commit.

This plan's frontmatter has `type: execute` (not `type: tdd`), so the plan-level RED/GREEN gate-sequence validation does not apply here; this note is a transparency disclosure of the task-level `tdd="true"` flag's literal (non-)compliance, not a plan-level gate failure. All new tests do genuinely exercise the new behavior (verified failing against a stash of the pre-implementation state would reproduce failure, since e.g. `fetchInstituteSessionsForDays` and `mergeLiveSessionsIntoRows` did not exist before these commits — the tests could not have passed against prior code).

## Verification Summary

- `npx tsc --noEmit` — clean after every task.
- `npx vitest run --project unit src/lib/credit-control/__tests__/wise.test.ts` — 13/13 passing (9 pre-existing + 4 new) after Task 1.
- `npx vitest run --project unit src/lib/student-schedule/__tests__/live.test.ts` — 9/9 passing after Task 2.
- `npx vitest run --project unit src/lib/student-schedule/__tests__/data.test.ts` — 19/19 passing (13 pre-existing + 6 new) after Task 3.
- `npx eslint` on every new/modified source file — clean (0 errors/warnings) after the Task 2 fix above.
- `npx vitest run --project unit src/lib/student-schedule src/lib/credit-control` — 96/96 passing (full domain regression) before the final gate.
- `npm test` (full unit suite) — 358 test files / 4055 tests passing.
- `npm run verify:release` — **exit code 0**, explicitly checked (not inferred from truncated `tail` output): typecheck ×2, full suite (358/4055), `next build` succeeded, `git diff --check` clean, `guard:production-route-surface` passed (207 source routes present).
- `git diff --stat efe4d04 HEAD` — confirms exactly the 8 files the plan's `files_modified` frontmatter declared were touched; no consumer call site, `credit-control/sync.ts`, `run-sync-request.ts`, cron cadence, or schema/migration was modified.
- `git diff --diff-filter=D --name-only` after each commit — empty every time (no accidental deletions).
- All Wise session fetching in tests goes through mocked `fetchInstituteSessionsForDays` / `fetchCreditSessions`; zero real network calls anywhere in the new or touched test files.

**Not automated by this execution (per the plan's own `<verification>` section items 3–5 — require a merged+deployed production environment this executor does not have):**
- Production read-only check against Ben.Ng's real session `69b913ba124bc7c49ce31425` (13 Aug, 15:00–16:30).
- The staleness proof — reschedule/cancel a real session in Wise, confirm `/schedule/{token}` reflects it before the next `:20`/`:50` sync promotes.
- The kill-switch check with `ENABLE_STUDENT_SCHEDULE_LIVE=false` set in the actual deployment environment.

These three are explicitly deferred to post-merge/post-deploy per the plan's Planner Note #5 (a `checkpoint:human-verify` was considered and dropped for exactly this reason — nothing to pause and wait for during this execution).

## Known Stubs

None — this is a backend data-layer change with no UI or new rendering surface; all six consumer surfaces are unmodified and continue to render through the same `buildStudentSchedulePayload` payload shape as before.

## User Setup Required

None to land this plan. `ENABLE_STUDENT_SCHEDULE_LIVE` is opt-out (unset = enabled), so the feature activates with zero environment changes once deployed. Setting it to `false` in Vercel is only needed if the live overlay ever needs to be disabled without a code change — that remains available as documented in `.env.example`.

## Next Phase Readiness

- All code, tests, and the full `verify:release` gate are green on `feat/student-schedule-live-refresh` at `1c89a4b`, ready to merge.
- The three manual post-deploy verification steps listed above (production read-only check, staleness proof, kill-switch check) remain as follow-up once this branch is merged and deployed — deployment itself was explicitly out of scope for this execution (no `vercel`/`deploy:prod` command was run, per this quick task's constraints).
- No blockers.

## Self-Check: PASSED

- FOUND: `src/lib/student-schedule/live.ts`
- FOUND: `src/lib/student-schedule/__tests__/live.test.ts`
- FOUND: `export async function fetchInstituteSessionsForDays` in `src/lib/credit-control/wise.ts`
- FOUND: `export function mergeLiveSessionsIntoRows` in `src/lib/student-schedule/data.ts`
- FOUND: `ENABLE_STUDENT_SCHEDULE_LIVE` in `src/lib/env.ts` and `.env.example`
- FOUND commit: `d90f04a` (feat(student-schedule): add parallel per-day Wise session sweep fetcher)
- FOUND commit: `7057ba3` (feat(student-schedule): add live Wise overlay module with kill switch)
- FOUND commit: `1c89a4b` (feat(student-schedule): merge live Wise overlay into the schedule read path)

---
*Quick task: 260805-on4*
*Completed: 2026-08-05*
