---
phase: quick-260930-rlr
plan: "01"
status: complete (draft PR against main; nothing deployed, no switch changed)
subsystem: feedback-autowriter (model-call layer, pipeline, job and replay wiring)
tags: [feedback-autowriter, openrouter, rate-limit, retries, vitest, testcontainers]

requires:
  - phase: quick-260930-jtw
    provides: a rate limit read from the body of a 200 response and never counted as the writer's failure (PR #113, merged into main 30 Sep 16:16 Bangkok)
provides:
  - callWithRateLimitRetries — one model call, tried again in the same run while it is rate limited (openrouter.ts)
  - a rate limit read in every in-body form — code as number or text, on the response or on the choice
  - retryAfterMs — the wait OpenRouter asks for, when it says
  - result.rateLimitRetry on the call records of the attempts after a rate limit
---

# Summary — autowriter: a rate-limited model call is tried again in the same run

**Branch:** `feat/autowriter-rate-limit-retries`, from PR #113's head (`1e9c8f8`); merged with `main` once #113 was
merged (`46b95a2`, same tree). **PR:** draft, base `main`.
**Commits:** `cce96c4` plan · `77a664b` the retries and the wider rate-limit reading · `729ca1e` docs · `f504c92`
merge of `main` · `d61c584` test · this summary.

## What changed
1. **The retry layer** (`openrouter.ts` `callWithRateLimitRetries`). A call that ends as a rate limit is sent again —
   the same request, the same time-out — up to three more times, after about 4 s, 10 s and 25 s, each ±30% at random
   (2.8–5.2 s, 7–13 s, 17.5–32.5 s). When OpenRouter says how long to wait (`Retry-After` in seconds or as a date,
   or `X-RateLimit-Reset`, as a response header or under the error's `metadata.headers`), that wait is used: never
   less (the spread only adds), at most 30 s. One call's waits never total more than 45 s (the last is cut to fit).
   The wait function and the random source are injectable. `callOpenRouter` itself stays one request. Only a rate
   limit is retried: a time-out, a 5xx, a reply that is not JSON, no credit, an answer from another model are not.
2. **Time.** A retry is made only when `wait + the request's time-out ≤ remainingMs() − 45 s` — the rule every model
   call starts under. Otherwise the rate limit is returned at once, as before.
3. **Every model call of the pipeline** (`pipeline.ts` `run`): writer, fallback writer, both judge levels. The replay
   gets it through the pipeline, and its own judge calls on posted drafts go through the same function.
4. **Call records.** One per attempt. Each attempt after the first carries `result.rateLimitRetry` (1–3). A
   rate-limited attempt has no usage, so no cost.
5. **What counts as a rate limit** (#113's reviewer, via the coordinator): inside a 200 response, the code 429 as a
   number or as text (`"429"`), on the response (`error.code`) or carried on the choice (`choices[0].error.code`, as
   with `finish_reason: "error"`). Only 429: any other error on a choice stays `finish_reason_error` (the model's
   own), any other code given as text keeps the response's status, an error of the whole response comes before one
   on a choice, and an HTTP error keeps its status.
6. **Unchanged:** a rate limit is never the writer's failure (`modelFailure: false`, no `writer_failed` count), never
   a reason for the fallback writer, and — still rate limited after the retries — ends the run with the same
   `infra:<arm>:<message>` reason; the class retries in 10 minutes.

## Time budget: the worst case
- **One call:** up to 45 s of waiting (39 s at the middle of the spread, 27.3 s at its low end), plus the time of the
  rate-limited replies themselves. That time is not assumed: the rule reads the real time left before every wait.
- **One run:** the steps follow one another — the writer; the two judge levels (they wait at the same time); a
  level's second try after a reply it cannot use; and for a rejected draft the fallback writer, its judges and
  their second try. Each can add up to 45 s: 270 s if every step were rate limited three times and then answered.
  The case seen on 30 Sep is the writer's route: up to 45 s, once.
- **The function limit:** every attempt, first or retried, is sent only when its whole time-out ends by the deadline
  − 45 s, i.e. 695 s into a function that Vercel stops at 800 s. A wait is started only when the wait and that
  time-out fit under it. So no call outlives the function, and a judge never starts without its full time-out.
- **The POST:** `submitFeedbackGuarded` claims a POST only with 240 s of function time left, checked after the
  pipeline and the pre-POST reads, immediately before the claim (`submit.ts:285`); the POST phase is bounded at about
  220 s. So whatever the retries used, a POST starts with its 240 s or does not start: the judged draft is then
  kept and the next run posts it (a transcript draft without a model call) — #113's worst case, unchanged. The
  waits can turn "fits" into "next run" only when less than 240 s plus the waits are left after the models: from a
  class's 560 s that takes models that ran over about 275 s themselves. Without the retries that run had no draft.
- **A sweep** runs its classes one after another and starts one only while 560 s of its 740 s remain. One class's
  waits are time the next do not get: if every class were rate limited through all its retries, a sweep would get
  through about four of them instead of failing through all in seconds. The rest wait for the next sweep, as all
  of them would have. A webhook run is one class per function.

## Verification (fresh, Node 22, on `d61c584`, clean tree)
- `npm run typecheck`: pass. `npx eslint src/lib/feedback-autowriter`: clean. `git diff --check origin/main...HEAD`: clean.
- `npx vitest run --project unit`: 492 files, 5868 tests pass (25 more than `main`: 13 in `openrouter.test.ts`, 11
  in `pipeline.test.ts`, 1 in `replay.test.ts`).
- `npx vitest run --project integration src/lib/feedback-autowriter` (OrbStack): 4 files, 160 tests pass (1 more,
  and the transcript-first `writer_failed` test extended).
- No live OpenRouter or Soniox call was made: fakes only.
- Mutation checks — each change undone in turn, a test fails every time (18 mutations): no retry at all; no budget
  check; no spread; no 45 s total; the asked wait ignored; not capped at 30 s; retried before the asked wait; every
  failure retried; the text code not read; the choice's rate limit not read; any choice error read as the
  response's; the asked wait not parsed; retries not marked; rate-limited attempts not recorded; the pipeline's
  wait not injectable; the replay's posted-draft judge not retried; `job.ts` not passing the wait on the summary
  path; nor on the transcript path.

## Deviations and judgement calls
1. **Where it lives.** `callWithRateLimitRetries` wraps any call function, so test fakes and the replay's recording
   wrapper sit below it and see every attempt. Not changed: `generateDraft` (`run.ts`), the offline arm comparison of
   the pilot — one call per draft, no run budget.
2. **The same request, the same time-out.** So a retried judge always has its full time-out, and a writer call whose
   time-out was already cut to what is left is not tried again (that time-out no longer fits after any wait).
3. **45 s in all** is a hard limit, not an estimate: at the top of the spread the third wait is 26.8 s instead of up
   to 32.5 s; when OpenRouter asks for 30 s or more there are two retries (30 s, then 15 s), not three.
4. **A wait OpenRouter asks for** is spread upwards only (0 to +30%) — sooner would be rate limited again — and cut
   at 30 s as decided, so a longer ask is tried at 30 s although it may well be limited still. A wait of zero or in
   the past is ignored (the schedule applies). The header forms are the documented ones, not seen live: the 30 Sep
   upstream error names no wait, so production will most likely use the schedule.
5. **When the records are written.** A call's rate-limited attempts are recorded when the call ends, in order,
   rather than as each comes back: nothing (no database write) then stands between the time check and the wait, so
   the time rule is exact. Their `created_at` is a few seconds late.
6. **The mark** is on every attempt after the first, also one that ended another way (a time-out after a rate
   limit is `rateLimitRetry: 1` and counts as the writer's time-out — it was a real attempt).
7. **Cost** is recorded as returned (no usage → `cost_usd` null → $0 on the dashboard), not forced to 0.
8. **A failure without a message** inside a 200 response is now named by the status it is classified by
   (`HTTP 429` instead of `HTTP 200`).
9. **Existing tests changed** because the behaviour did: the pipeline's 429 case now scripts four replies, the
   `df5acfe` test expects four requests, and the replay's rate-limit test shows the draft written in the first try.
10. `STATE.md` is not touched, like the other 30 Sep autowriter quick tasks.

## Open for the owner
- **Whether OpenRouter names a wait** on the writer's route is not known (no live call was allowed). After tonight,
  the call records show how the retries went (`result ->> 'rateLimitRetry'`, runbook §8): if most third retries
  still fail, the limit lasts longer than 39 s and the lever is the own provider key, not more retries.
- The pre-POST Wise reads are still not budget-checked (#113's note, unchanged).
