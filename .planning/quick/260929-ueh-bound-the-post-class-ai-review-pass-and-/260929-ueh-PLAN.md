---
phase: quick-260929-ueh
plan: "01"
type: execute
wave: 1
depends_on: [quick-260929-smo, quick-260929-u7c]
files_modified:
  - src/lib/post-class-feedback/ai.ts
  - src/lib/post-class-feedback/__tests__/ai.test.ts
  - src/lib/post-class-feedback/__tests__/ai-review.integration.test.ts
  - src/lib/post-class-feedback/collection-tick.ts
  - src/lib/post-class-feedback/__tests__/collection-tick.test.ts
  - src/lib/data-health/__tests__/run-job.test.ts
  - docs (AI-pass sections + shifted ai.ts / collection-tick.ts citations)
autonomous: true
requirements: [UEH-DEADLINE, UEH-BREAKER, UEH-RETRY, UEH-CLAIM, UEH-TESTS, UEH-DOCS]
quick_id: 260929-ueh
branch: fix/post-class-ai-review-retry
base: fix/post-class-safe-error-logs f4fb0b8 (u7c) → fix/post-class-collection-tick (smo) → #100 → #99
worktree: /Users/kevinhsieh/Developer/Scheduling-post-class-hardening
must_haves:
  truths:
    - "The collection tick passes processPostClassAiReviews a deadline 10 minutes after the tick started; no model call starts unless it can finish (30s timeout) before it"
    - "Three consecutive model failures stop the pass for this tick; unreached candidates keep no run row and stay eligible"
    - "A failed run is retryable only when its failure was transient (timeout/abort, network TypeError, OpenAI 429 or 5xx) and the new code recorded it (metadata.retryable); it is retried no sooner than 1h after it finished, up to 3 model attempts in total"
    - "A run still 'running' 15+ minutes after its last claim (killed mid-call) is retried under the same 3-attempt cap"
    - "Claims are exclusive: a retry claims its row with a conditional update on status and attempts; a first attempt inserts with onConflictDoNothing on request_hash; a lost claim skips without calling the model"
    - "Historical failures without metadata.retryable (7,460 OpenAI HTTP 429 rows before 2026-09-08) are not retried"
    - "The result adds retried and stopped ('deadline' | 'model_failures' | 'not_configured' | null); a stop logs [post-class-ai-review] with counts only"
  artifacts:
    - { path: "src/lib/post-class-feedback/ai.ts", provides: "bounded, retrying processPostClassAiReviews + isTransientQualityModelError" }
    - { path: "src/lib/post-class-feedback/__tests__/ai-review.integration.test.ts", provides: "candidate SQL, cool-down, attempt cap, stale running, exclusive claim against real Postgres" }
---

<objective>
Owner decisions (2026-09-29):
- Retry transient failures after at least 1h, up to 3 attempts.
- Runs killed mid-call are recovered too.
- Other failures stay final.

The AI pass is also bounded, so a model outage cannot run it past the 800s limit or permanently fail up to 40
versions per tick.
</objective>

<context>
Production data, read-only, 2026-09-29:
- **Per-call latency** (`finished_at - created_at`) over 861 model calls: p50 2.7s, p99 5.9s, max 24.4s. The 30s
  timeout stays.
- **Failures:** 7,460 `OpenAI HTTP 429`, all before 2026-09-08 (quota outage), plus 37 generic "AI quality review
  failed".
- **No stale running rows.**
- **Tick duration** (cron): p50 16s, p95 30s, max 69s, and 0 killed ticks in 30 days.

`startedAt` currently records the pass start for every run. It becomes the claim time, so
`finished_at - started_at` measures the call.

Not changed: the 7,460 historical 429 failures. Retrying them would put thousands of old AI concerns in the
reviewers' queue, so that needs its own decision.
</context>

<tasks>
<task type="auto" tdd="true">
  <name>Task 1: Bounded, retrying AI pass (unit tests first)</name>
  <files>ai.ts, ai.test.ts, collection-tick.ts, collection-tick.test.ts, run-job.test.ts</files>
  <action>
    **RED** (ai.test.ts, fake builder recording `values`/`set`):
    - Deadline: stops before the claim.
    - Breaker: 3 consecutive failures stop the pass, and the 4th candidate is never touched.
    - Not configured: stops before any claim, after processing earlier non-suspect versions.
    - Classifier table.
    - Retry claim: attempts go 1 → 2, with no insert and no prior-feedback queries.
    - Retry not yet due, attempts exhausted, and a non-retryable row: each skipped.
    - Stale running row: claimed.
    - Lost claim and insert conflict: each skipped with no model call.
    - Failure metadata: `{attempts, retryable, lastErrorName}`.

    **Tick:** passes `{ deadlineAt }`, which is tick start + 10 min.

    **GREEN:** implement.

    **Parity:** the run-job parity case now expects the AI pass to receive `{ deadlineAt }`, which is the same
    behaviour as the cron.
  </action>
  <verify>ai/collection-tick/run-job suites; typecheck; eslint</verify>
  <done>One commit</done>
</task>
<task type="auto" tdd="true">
  <name>Task 2: Real-Postgres pin of the candidate SQL and claims</name>
  <files>src/lib/post-class-feedback/__tests__/ai-review.integration.test.ts</files>
  <action>
    Seed a session and a suspect latest version, and stub fetch. Cover:
    - A transient failure is not retried within 1h, is retried after it, and stops at 3 attempts.
    - A permanent failure is never retried.
    - A stale running row is recovered to succeeded.
    - Two concurrent passes on one retryable row call the model once.
  </action>
  <verify>npx vitest run --project integration on the new file</verify>
  <done>One commit (may fold into Task 1)</done>
</task>
<task type="auto">
  <name>Task 3: Docs</name>
  <files>docs/features/post-class-feedback.md, docs/reference/crons.md, docs/reference/api/internal-crons.md (+ citation remaps)</files>
  <action>Describe the deadline, breaker, retry policy, the new result fields and the historical-429 exclusion. Remap every ai.ts and collection-tick.ts line citation by diff.</action>
  <verify>citations resolve; git diff --check</verify>
  <done>One commit</done>
</task>
</tasks>
