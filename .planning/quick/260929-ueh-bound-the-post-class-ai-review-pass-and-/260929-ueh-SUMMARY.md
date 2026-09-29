---
phase: quick-260929-ueh
plan: "01"
status: complete
subsystem: post-class-feedback
tags: [post-class-feedback, ai-review, retries, collection-tick, testcontainers, vitest]

requires:
  - phase: quick-260929-smo
    provides: "shared collection tick + 30s model timeout (fix/post-class-collection-tick @ 884bcda)"
  - phase: quick-260929-u7c
    provides: "safeErrorFields (fix/post-class-safe-error-logs @ f4fb0b8)"
provides:
  - "processPostClassAiReviews is bounded: a tick deadline, a stop after 3 consecutive failures, and a stop when OPENAI_API_KEY is unset"
  - "Transient model failures and runs killed mid-call are retried after at least 1h, up to 3 model attempts in all"
  - "Exclusive claims (conditional update or insert on conflict do nothing)"
  - "The result adds `retried` and `stopped`"
affects: [post-class-feedback, collection-tick, docs/features/post-class-feedback.md, docs/reference/crons.md, docs/reference/api/internal-crons.md]

key-files:
  created:
    - src/lib/post-class-feedback/__tests__/ai-review.integration.test.ts
  modified:
    - src/lib/post-class-feedback/ai.ts
    - src/lib/post-class-feedback/__tests__/ai.test.ts
    - src/lib/post-class-feedback/collection-tick.ts
    - src/lib/post-class-feedback/__tests__/collection-tick.test.ts
    - src/lib/data-health/__tests__/run-job.test.ts
    - "docs/*: AI sections + remapped ai.ts / collection-tick.ts citations"

key-decisions:
  - "Owner (2026-09-29): retry transient failures (timeouts, network, OpenAI 429/5xx, runs killed mid-call) after at least 1h, up to 3 attempts; other failures stay final"
  - "Failures recorded before this change carry no metadata.retryable and are not retried (7,460 OpenAI 429s before 2026-09-08). Recorded as open question 14 in the feature doc"
  - "Tick deadline = tick start + 10 min (callers have maxDuration 800s; prod tick p95 30s, max 69s)"
  - "30s timeout kept: prod per-call p99 5.9s, max 24.4s (n=861)"
  - "startedAt is the claim time, so finished_at - started_at measures one call"

requirements-completed: [UEH-DEADLINE, UEH-BREAKER, UEH-RETRY, UEH-CLAIM, UEH-TESTS, UEH-DOCS]
completed: 2026-09-29
---

# Quick 260929-ueh: Bound the AI review pass and retry transient failures — Summary

**The post-class AI review pass is now bounded.**
- The collection tick gives it a deadline 10 minutes after the tick started, and it starts no model call that
  could not finish (30s) before then.
- Three consecutive model failures end the pass for the tick.
- An unset `OPENAI_API_KEY` stops it before any claim.

**Failures are no longer always permanent.**
- A timeout, abort, network `TypeError`, or OpenAI 429/5xx is retried on the same row no sooner than an hour
  later.
- A run still `running` 15 minutes after its claim, which means its function was killed mid-call, is recovered.
- Both are capped at three model attempts in total. Every other failure stays final.

**Claims are exclusive.** A retry claims with a conditional update on status and attempts. A first attempt
inserts with `onConflictDoNothing` on `request_hash`; before this, a lost race rejected the whole pass with 23505.

Branch `fix/post-class-ai-review-retry` in `/Users/kevinhsieh/Developer/Scheduling-post-class-hardening`, stacked
on `fix/post-class-safe-error-logs` → `fix/post-class-collection-tick` → #100 → #99. Not pushed.

## Evidence (production, read-only, 2026-09-29)

| Measure | Value |
|---|---|
| Per-call latency (`finished_at - created_at`, model-invoked successes, n=861) | p50 2.7s · p90 4.0s · p99 5.9s · max 24.4s |
| Failed AI runs | 7,460 × `OpenAI HTTP 429` (last 2026-09-08 02:43 UTC) + 37 × "AI quality review failed" (about 1–4 a day recently) |
| Stale `running` rows | 0 |
| Collection tick (cron, 30 days) | success p50 16.2s · p95 29.9s · max 69.3s; 0 ticks left `running` |

## Commits

1. `07eb93c` fix (rebased from `60ecfd7` onto u7c's review fix): `ai.ts`, `collection-tick.ts`, the unit tests, the new integration suite, and the parity update.
2. `b0b95ff` docs (rebased from `e3de2f4`):
   - The AI sections are rewritten.
   - The tick's `ai` shape gains `retried` and `stopped`.
   - Open question 14 covers the historical 429s.
   - All 40+ doc citations into `ai.ts` and `collection-tick.ts` were remapped by diff and each was checked
     against its target line.

## RED → GREEN

- **RED:** `ai.test.ts` failed 29 cases (no `isTransientQualityModelError`, old result shape, no deadline, retry
  or claim logic). The collection-tick and run-job pass-argument cases failed 2.
- **GREEN:** `ai.test.ts` 32/32. Across ai, collection-tick and run-job, 103 pass.
- **Unit mutations** (each reverted): no deadline check (1 fail), no breaker (1), no cool-down (1), no attempt
  cap (1), every error transient (8), breaker not reset on success (1), a retry re-assessing instead of using its
  stored triggers (1), tick passes no deadline (1).
- **Integration mutations:**
  - An unguarded retry claim fails. A plain insert without `onConflictDoNothing` also fails, but only after the
    `racingDb` gate forced both passes to reach their claims before either wrote. Without the gate the race was
    not reproducible.
  - The SQL ignoring `retryable` fails 2; the SQL ignoring the cool-down fails 1.

## Verification

- typecheck 0.
- eslint: changed files clean; repo 0 errors / 18 pre-existing warnings.
- `npm test`: **488 files / 5702 tests**.
- `ai-review.integration.test.ts`: **6/6**, 3 runs (**10/10** after the review round).
- Full `npm run test:integration` (Docker): **38 files / 513 tests** (the earlier 37 / 507, plus this suite).

## Why a live original pass cannot collide with a recovery

A `running` row is recovered only after 15 minutes. Every caller's function dies at 800s (13.3 minutes), and a
single call is capped at 30s. So by the time another pass may reclaim the row, the original claimant can no
longer write its final by-id update.

## Not changed

- The 7,460 historical 429 failures. Retrying them would put their old AI concerns into the reviewers' queue;
  this is open question 14 in the feature doc.
- `failed` still counts calls, not versions. A retried version that fails again counts again in its tick.

## Review and follow-ups (orchestrator, after execution)

Independent code review by code-reviewer (opus, read-only, joint with 260929-u7c): **APPROVE WITH NITS**
(0 critical, 0 high). The reviewer re-ran tsc, the unit suites and this integration file, and ran its own
mutations in a `git archive` copy.

**Applied in `8f51b30` (code and tests) and `d7d6e31` (docs):**
- **MEDIUM, stale-claim race was untested.** A reclaim goes `running → running`, so the attempts condition is
  the only guard. A new racing case in real Postgres fails if that condition is removed.
- **MEDIUM (open), late writes.** Success and failure writes now settle only while the claim is held (status
  `running` and the same attempts). A success is saved in one `withPostClassTransaction`: a conditional status
  update, then the concerns insert. A pass that outlived its claim writes nothing and cannot duplicate concerns.
- **LOW, killed run on its last attempt.** It stayed `running` forever; it is now selected and closed as failed
  without a model call.
- **LOW, `TypeError` too broad.** Only undici's `fetch failed` and `terminated` are transient. A failed save
  after a successful model call is recorded as a retryable failure and no longer counts toward the stop.
- **LOW, no key starved deterministic versions.** Suspect versions are now left unclaimed while deterministic
  ones keep settling; `stopped: "not_configured"` is reported once.
- **LOW, latent perpetual candidate.** Only a run of the current prompt and redaction version can be retried.
- **NIT, `attempts` cast.** It is guarded by `jsonb_typeof`, and a claim strips the stale
  `retryable`/`lastErrorName`.
- **Tests:**
  - The recorded-triggers line is asserted exactly.
  - A 5-minute fake sync proves the tick budget starts before the sync.
  - Four new integration cases: stale race, killed last attempt, older prompt, non-number attempts.
  - Mutations: each claim/SQL guard (4) and the budget start (1) now fail a test.
- **Docs:**
  - `env.md` has 12 read sites and describes the `not_configured` behaviour.
  - The ERD says one row can carry up to 3 billed attempts and names the new metadata keys.
  - The runbook describes the `[post-class-ai-review]` line.
  - `crons.md` shows the deadline argument and the corrected span `:81-92`.
  - The `ai.ts:654,691` pair is fixed, and all `ai.ts` citations were remapped again and content-checked.

**Not applied (owner decisions or noted):**
- **Early stops are invisible to Data Health.** The `ai` object is nested, so an outage keeps the job green.
  This matches the owner's log-only decision for failed passes; the log line is the signal.
- **A rejected key (401/403) is final** under the owner's "other 4xx stay final" rule. With the 3-failure stop,
  a revoked key permanently fails about 3 suspect versions per tick until it is fixed. That is offered as a
  follow-up question.
- **Stack frames and the pg `constraint` in the safe logs:** outside the owner's field set.

**Final:**
- typecheck 0; lint 0 errors / 18 pre-existing warnings.
- `npm test`: **488 files / 5707 tests**.
- `ai-review.integration.test.ts` 10/10.
- Full `npm run test:integration` (Docker): **38 files / 517 tests**.
