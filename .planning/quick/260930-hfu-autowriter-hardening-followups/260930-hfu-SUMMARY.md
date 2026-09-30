---
phase: quick-260930-hfu
plan: "01"
status: complete (draft PR against main; nothing deployed, no switch changed)
subsystem: feedback-autowriter (model-call layer, pipeline, job state machine, store, submit, review job)
tags: [feedback-autowriter, openrouter, rate-limit, judge, alerts, sweep, vitest, testcontainers]

requires:
  - phase: quick-260930-jtw
    provides: judge v5, the 240 s transcript judge, writer-only writer_failed (PR #113, merged 30 Sep)
  - phase: quick-260930-rlr
    provides: in-run retries of a rate-limited model call (PR #114, merged 30 Sep)
provides:
  - a sweep that survives a lasting rate limit (no-model rows first, in-run retries off once a class ends rate limited)
  - the judge_failing alert (metadata.judgeErrors, releaseGeneration rearmAlert, listPendingAlerts filter)
  - listDueRows ordered with `infra:` rows last
  - Retry-After kept as asked (never a retry before it, never less than the schedule's wait)
  - result.attemptAt / retryAfterMs / waitedMs on rate-limited call records; coverage reads attemptAt first
  - the POST budget checked before the pre-POST reads
  - a judge level that leaves off once the other level has decided
---

# Summary — autowriter: hardening follow-ups to #113 and #114

**Branch:** `fix/autowriter-hardening-followups`, from `main` at `1096f33` (#113 and #114 merged). **PR:** draft, base `main`.
**Commits:** `f028076` plan · `f6452b2` code and tests (items A–F) · `7bb2951` docs · `79ee3f0` test (the sweep rule on
the transcript path) · `e3dca9c` the judges' combination type-checked · `443058b` test comment · this summary.

No prompt text changed (`PROMPT_VERSION` and `JUDGE_PROMPT_VERSION` stay 5). No migration. No live OpenRouter or Soniox
call was made: fakes only. Nothing was written to Wise or to the production database.

## What changed, item by item

### A. A sweep under a lasting rate limit
- `job.ts:1257` `worksWithoutModel(row)`: a due row that calls no model as far as the row shows — evidence
  `transcript` and (a stored judged draft that may be reused, or no Soniox job yet, or a last reason
  `transcription_in_progress`).
- `job.ts:1329-1345` `runSweep`: these rows are started first, then the rest; each group keeps `listDueRows`' order.
  The first class whose run ends still rate limited (`ProcessOutcome.rateLimited`, `job.ts:152`) sets
  `rateLimitRetries = false` for the classes after it in that sweep.
- `job.ts:197`, `:255`, `:634`, `:1074`: `processSession({ rateLimitRetries })` → both pipeline calls.
  `pipeline.ts:167`, `:215`: `runWritingPipeline({ rateLimitRetries })` → `callWithRateLimitRetries({ retries })`
  (`openrouter.ts:275`): `false` = one request, a rate limit returned at once, as before #114.
- `pipeline.ts:86`, `:128`: an infra result says `rateLimited: true` when its last call was still rate limited.
- A webhook run (and the CLI) passes nothing: retries on.
- Tests: `job.integration.test.ts:599-703` (three classes, one of them on the transcript path at each end: 4 + 1 + 1
  requests, one set of waits, then a webhook run for each of two with all four requests; a limit that clears keeps
  the retries; the start order of six rows); `pipeline.test.ts:937-963`; `openrouter.test.ts:423`.

### B. A judge that keeps failing on one class
- `job.ts:299-329` `judgeFailed` / `judgeAnswered`: runs in a row that end at the judge stage are counted in
  `metadata.judgeErrors`, on the summary path (`job.ts:640`) and the transcript path (`job.ts:1096`). The third
  releases the row with `alertKind: "judge_failing"` and `rearmAlert`. The count goes back to 0 when a run ends with
  a judged draft (`job.ts:654`, `:1112`) or hands a held summary draft over (`job.ts:647`).
- `store.ts:21` the alert kind; `:160`, `:178` `rearmAlert` (forgets that the kind was sent, so a new run of failures
  alerts again); `:675-682` `listPendingAlerts` lists a `judge_failing` alert only while the class is still waiting
  or being worked on and its count is at the mark; `:566` an owner retry clears the count. `alerts.ts:13` the text.
  `config.ts:289` `AUTOWRITER_JUDGE_ERRORS_ALERT = 3`.
- `store.ts:358` `listDueRows`: `order by (reason like 'infra:%'), deadline_at` — failed rows after the others.
- The class retries exactly as before (state, reason, 10 minutes, never a fallback).
- Tests: `job.integration.test.ts:1938` (2 failures: nothing; 3rd: one email with the reason; 4th: none; a writer
  failure leaves the count; the judge answers: posted, count 0), `:1988` (an unsent alert is dropped once the judge
  answers), `:279` (the summary path; writer failures never count); `store.integration.test.ts:265`, `:353`, `:401`.

### C. `Retry-After`
- `openrouter.ts:240-250` `retryWaitMs`: with a wait OpenRouter asked for, the wait is the longer of the schedule's
  wait and the asked one (spread on top, up to 30 s); an asked wait over 30 s, or over what is left of the call's
  45 s, returns `null` — no retry, the rate limit is returned.
- `openrouter.ts:98-114` `retryAfterMs`: `Retry-After` from the response header, then from the error's own list — a
  header that names no time ahead (empty, `0`, a past date, unreadable) no longer hides the error's;
  `X-RateLimit-Reset` only from `error.metadata.headers`.
- `openrouter.ts:183-190`: an HTTP 429 whose body is not JSON still carries its `Retry-After`.
- Tests: `openrouter.test.ts:188-225`, `:292`, `:350-398`; `pipeline.test.ts:743-775`, `:305`.

### D. Call records
- `openrouter.ts:253`, `:293-304`: `callWithRateLimitRetries` times every request (`startedAt`) and returns each
  rate-limited attempt with the wait that followed (`RateLimitedAttempt`).
- `pipeline.ts:220-240`: a rate-limited attempt's record carries `result.attemptAt` (ISO), `retryAfterMs` when
  OpenRouter named one, and `waitedMs` when a wait followed. The recorded `call` is still the reply as returned.
- `review-job.ts:597-606`: "our first writer call" = `min(coalesce((result ->> 'attemptAt')::timestamptz, created_at))`;
  `quality.ts:276-284` says so.
- Tests: `pipeline.test.ts:966` (three records written at 21.05 s, sent at 0 s and 9.05 s);
  `openrouter.test.ts:399`; `review.integration.test.ts:813` (a tutor's save during the waits is a miss, a save
  before the request is theirs, an unmarked call is dated by its row as before).

### E. Robustness
- `openrouter.ts:176-190`: a reply that is JSON but no object (`null`, a string, an array, a number) is
  `invalid_json_response`. Test `openrouter.test.ts:121`.
- `submit.ts:239-242`, `:289`: the 240 s POST budget is checked before the three pre-POST Wise reads and again before
  the claim; a dry run is exempt. Tests `submit.test.ts:165-196`; end to end `job.integration.test.ts:1272` (the
  judges end with 200 s left → `retry: function_budget_too_small_for_post`, one Wise read in all, no credit read,
  the draft kept `pending` with verdict and stamp → the next run posts once with no model and no Soniox call).
- `pipeline.ts:313-315`: `judgedGeneration` = the writer's generation id, or `draft:<uuid>` when the reply has none.
  `dashboard.ts:254-258` unchanged but for its comment. Test `pipeline.test.ts:1006` (four rejecting calls, two
  drafts on the dashboard).
- `pipeline.ts:316-362`: `decided` — once a level has returned an unfaithful verdict or stopped, the other makes no
  second try (`:328`) and no further in-run retry (`abandon`, `openrouter.ts:277`, `:300`). `pipeline.ts:374-384`: the
  two verdicts are combined only when both exist (no cast). Tests `pipeline.test.ts:1033-1134`,
  `openrouter.test.ts:432`.
- `openrouter.ts:269`: the type parameter is `ModelRequest`.

### F. Docs and comments
- `config.ts:202-221` the worst-case arithmetic; `:180-187` the POST budget's two checks; `:153-158` the asked wait;
  `:273-282` the `writer_failed` count (owner decision, 30 Sep 17:00); `:65-78`, `:120-124` `AutowriterModelRoute`:
  the judge entry has no `effort` (`routeMismatch` takes a route, `pipeline.ts:134`).
- `job.ts:1076-1084`, `replay.ts:493-497`: the same wording. The counting itself is unchanged, and now pinned by a
  test (`job.integration.test.ts:1914`: a judge rejects Sol's draft, Luna times out → the count goes up; the third
  such run falls back).
- Feature page: a section "Hardening follow-ups (30 Sep, night)"; corrected in place: the summary's worst case, the
  `writer_failed` count (two places), the `Retry-After` sentence, the call records, the POST budget, "versions became
  4", the alert list. Runbook: §6 and §7 (`judge_failing`, what to do, a query), §8 (the sweep under a rate limit,
  what `rateLimitRetry` rows count, a query for the attempts' times).

### G. Rate-limit detection
Nothing added but tests: an HTTP 429 whose body is not JSON is retried (`openrouter.test.ts:292`) and is never the
writer's failure (`pipeline.test.ts:305`).

## Time budget after the changes
- **One call:** up to 45 s of waiting, as before. With a wait OpenRouter asks for: at most 30 s at a time, never more
  than the 45 s in all — and less waiting than before when it asks for more than fits (no retry instead of a cut one).
- **One run:** unchanged ceiling — each step (writer; both judge levels together; a level's second try; for a
  rejected draft the fallback writer, its judges, their second try) can add up to 45 s: 270 s if every step were
  rate limited three times and then answered. Less in practice now: a level that has been overtaken by the other's
  verdict or stop makes no second try (up to 240 s saved on a transcript) and no retry.
- **Every model call** still ends by the deadline − 45 s (695 s into a function Vercel stops at 800 s), and a judge
  still never starts without its full time-out.
- **The POST:** needs 240 s, checked before the pre-POST reads and before the claim. Transcript worst case:
  560 − 180 − 240 = 140 s → deferred, the next run posts the stored draft with no model call. Summary worst case:
  560 − 180 − 120 = 260 s → posts with 20 s to spare; once rate-limit waits pass 20 s (one call that used all three
  retries waits 27–45 s) it is deferred too: 215 s left after one such call, 170 s after two. A deferred summary
  draft is kept on the row, but the summary path writes it again (only a transcript draft is posted as stored).
- **What the earlier check closes:** a run with less than 240 s left used to make the three reads anyway (up to
  135 s). After a call that ended at the deadline − 45 s that could run to 830 s — past Vercel's 800 s — and a
  function killed there leaves the row `generating` for its 14-minute lease with the judged draft lost. Now no read
  is made and the draft is stored at once.
- **A sweep** starts a class only in its first 180 s. Under a lasting rate limit the first writer class spends up to
  45 s per step on it; every class after it is asked once (seconds each), and the rows that call no model have
  already run. Before, about four classes fitted into a sweep, and a stored draft could wait behind them.

## Verification (fresh, Node 22, on `443058b`, clean tree)
- `npm run typecheck`: pass. `npx eslint src/lib/feedback-autowriter src/components/feedback-autowriter`: clean.
  `git diff --check origin/main...HEAD`: clean.
- `npx vitest run --project unit`: 492 files, 5889 tests pass (21 more than `main`: 9 in `openrouter.test.ts`, 10 in
  `pipeline.test.ts`, 2 in `submit.test.ts`).
- `npx vitest run --project integration src/lib/feedback-autowriter` (OrbStack): 4 files, 172 tests pass (12 more:
  8 in `job.integration.test.ts`, 3 in `store.integration.test.ts`, 1 in `review.integration.test.ts`).
- Mutation checks — each change undone in turn: 57 mutations, a test fails every time (A 12, B 14, C 8, D 7, E 15,
  F 1); one more (combining the judges without both verdicts) no longer compiles. Among them: the sweep keeps its
  retries; no order; either path not passing the switch or not reporting the rate limit; no alert, an alert on every
  failure, no re-arm, a re-arm of every alert, an alert that outlives the judge's answer or the class; failed rows
  not sorted last; an asked wait cut short; a short asked wait replacing the schedule's; `Retry-After` not read on a
  429 page; `X-RateLimit-Reset` from the response; an empty header hiding the error's; no `attemptAt`, no
  `waitedMs`, attempts timed after their reply, coverage by `created_at`; a `null` body read as an object; no budget
  check before the reads (unit and end to end), none before the claim; no draft key, a key per call; a second try
  or a retry made though the other level decided; a rate limit left off counted as a stop.

## Deviations and judgement calls
1. **A — what "needs no model call" means.** Read from the row, so it is a guess about the next step: a Soniox job
   that has finished meanwhile goes on to the writer in the same run. A transcript-first *handover* of a new summary
   row (one Wise read, no model) is not in the first group: it is ordered with the writer rows that have not failed.
   Kept to the three cases of the brief.
2. **A — "ends still rate limited"** is any run whose last call was a rate limit when the pipeline gave up: after its
   three retries, or at once when no retry could be made (no time for the wait, a wait asked for that did not fit).
   It switches the retries off for every model of the classes after it (writer and judge alike, not per route), for
   that sweep only.
3. **B — what counts.** Every run that ends at the judge stage: a time-out, no verdict in two tries, the wrong route,
   a rate limit after its retries, no credit, and no time left to start the judge. All leave a written draft
   unchecked. A writer-stage failure leaves the count as it is — also a run in which a judge rejected Sol's draft and
   Luna then failed (the result does not say the judge answered), so the alert can come one run early in that case.
4. **B — once per episode.** The alert is raised on the run that takes the count to exactly 3, and that release
   re-arms the kind; the fourth and later failures raise nothing. The count restarts when a run ends with a judged
   draft. An alert not sent yet is dropped at listing time when the class is no longer waiting or its count is under
   3 — one filter instead of a clear on every exit path. `metadata.alertKind` keeps the value afterwards, inert,
   like the other kinds. Both paths count (the summary path had the same silent retry). Like every draft alert it is
   emailed in `live` only. `metadata.judgeErrors` needs no migration.
5. **B — the order** uses the reason prefix `infra:` only, as asked: `wise_read_failed`, `error:…` and Soniox retries
   are not "failed" for it.
6. **C — the remaining per-call cap** is the smaller of 30 s (one wait) and what is left of the 45 s. The schedule's
   own last wait is still cut to the 45 s, as before; only a wait OpenRouter asked for is never cut. Any HTTP
   `Retry-After` that names no time ahead falls through to the error's, not only an empty or `0` one.
7. **D — which records.** Every rate-limited attempt carries `attemptAt`, tried again or not. Other calls do not:
   their row is written when the call ends and is dated by `created_at` as before, so a tutor's save during an
   ordinary call (about 6 s for Sol) is still dated by the row. The test pins that.
8. **E — the judge leave-off changes one rare outcome.** A level is "left off" only for work it did not do: a second
   try not made, a rate-limit retry not made. Then the other level's verdict rejects the draft and the fallback
   writer goes on. Before, that second try or retry was made, and if it failed the run stopped and the class retried
   in 10 minutes. A call already in flight is not cut off, and a level that fails on its own after the other's
   verdict (a time-out; a rate limit in a sweep whose retries are off) is still a stop, as before. The check is made
   before each wait, not after it: a level already waiting sends its one request.
9. **E — fail closed by type.** A level without a verdict cannot be combined into a pass: `combineJudgeVerdicts` is
   called only with both verdicts, and the cast that allowed otherwise is gone (`e3dca9c`).
10. **E — the draft key** is stored in the existing `result.judgedGeneration` (`draft:<uuid>`), so the dashboard
    code and old records are untouched.
11. **F — `AUTOWRITER_MODELS.judge.effort` removed**, not renamed: `AutowriterModelConfig` is now
    `AutowriterModelRoute` plus an effort, and the judge entry is a route.
12. **Existing tests changed** because the behaviour did: the rate-limited results carry `rateLimited: true`, their
    records `attemptAt` and `waitedMs`; "two minutes asked" now ends the retries; `X-RateLimit-Reset` as a response
    header names no wait; the judge config has no effort; the event-wait test lets both budget checks pass.
13. **Docker.** After a restart of the machine `/var/run/docker.sock` was gone; the integration tests ran with
    `DOCKER_HOST=unix://$HOME/.orbstack/run/docker.sock` and `TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE=/var/run/docker.sock`.
    The same restart interrupted a mutation run and left one mutation in `job.ts`; it was restored with
    `git checkout` and every mutation was run again. The verification above is from after that.
14. `STATE.md` is not touched, like the other 30 Sep autowriter quick tasks.

## Open for the owner
- **A deferred POST waits for the first sweep at least 10 minutes later** (the retry delay is unchanged). Making the
  row due at once would post it at the next sweep, about 10 minutes sooner on average. Not changed here.
- **A summary draft deferred for lack of POST time is written again** by the next run: only transcript drafts are
  reused. With transcript first on, that is the fallback classes only.
- **`judge_failing` also fires for three rate-limited or out-of-time judge runs in a row**, not only for model
  failures. Say so if it should be narrower.
