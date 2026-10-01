---
quick_id: 260930-rlr
status: approved
source_plan: "add quick in-run retries on a rate limit so posts don't wait a whole sweep" — owner decision (Kevin), 2026-09-30 16:20 Bangkok
base: feat/autowriter-judge-tweaks (PR #113, `1e9c8f8`)
branch: feat/autowriter-rate-limit-retries
---

# Autowriter: in-run retries of a rate-limited model call

Follow-up to PR #113. The writer's zero-retention route (Sol through OpenRouter, served by Azure) is rate-limited
upstream on and off: OpenRouter answers HTTP 200 with `error.code` 429 in the body, or a plain HTTP 429. #113
(`df5acfe`) already reads that as a rate limit — never the writer's failure — but the class then waits for the next
sweep (about 15 minutes), although a second request a few seconds later usually goes through.

## Hard rules
- Work only in `.claude/worktrees/slot-a`; Node 22; no `npm ci`, no build, no stash, no force push.
- No writes to Wise or to the production database, no Vercel env changes, none of the CLI's write modes.
- **No live OpenRouter or Soniox calls at all** (no replay, no probes): production shares the key and the route is
  already rate-limited. Fakes only.
- Public repo: synthetic names only. Draft PR only.

## Owner decision
A model call that ends as a rate limit is tried again in the same run: up to 3 retries after about 4 s, 10 s and
25 s, each ±30% at random (classes that end together must not retry together). A `Retry-After` header or OpenRouter's
reset time replaces the wait when given, up to 30 s. Never past the run's time: a retry is made only when its wait
plus the call's time-out still end before the deadline − 45 s. What a rate limit means stays as #113 has it: never a
writer failure, never a reason for the fallback writer, and — still rate limited after the retries — the same
retry-later outcome as today.

## Tasks
1. `config.ts`: the wait schedule, the jitter, the 30 s cap on a wait OpenRouter asks for, the 45 s total per call;
   the budget note on `AUTOWRITER_SWEEP_MIN_REMAINING_MS`.
2. `openrouter.ts` (the layer where one model call is made): `retryAfterMs` on a rate-limited result (from the
   response), `isRateLimited`, and `callWithRateLimitRetries` — one model call, tried again while rate limited; the
   wait function and the random source injectable.
3. `pipeline.ts`: every model call (writer, fallback writer, both judge levels) goes through it; one call record per
   attempt, the attempts after a rate limit marked `result.rateLimitRetry: n`.
4. `job.ts`, `replay.ts`: pass the injectable wait and random source; the replay's own judge calls (posted drafts)
   get the same retries.
5. Tests (fakes only): once / twice then success; four times → today's outcome, no `writer_failed`, no fallback
   writer; budget too small → no wait; a judge level rate limited then answered → both levels still required; HTTP
   200 body-429 and HTTP 429 retried, other errors not; `Retry-After` honoured and capped. Mutation check.
6. Docs: feature page and runbook (what happens on a rate limit, how to see it in the call records).
7. Verify (typecheck, eslint, unit, integration on OrbStack, `git diff --check`), summary, push, draft PR (base
   `main` if #113 has merged — merge `origin/main` first — otherwise `feat/autowriter-judge-tweaks`).
