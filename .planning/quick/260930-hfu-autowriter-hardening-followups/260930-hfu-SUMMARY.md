---
phase: quick-260930-hfu
plan: "01"
status: complete (draft PR #115 against main; nothing deployed, no switch changed)
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
  - review fixes: a sweep starts the rows close to their deadline first, and a running Soniox job is a writer's row
  - review fixes: judge_failing counts the judge's own failures (3) apart from the runs in which it could not be asked (6 together)
  - review fixes: one "retries off" switch per stage; a guarded attemptAt cast; a relay key per run of judge failures
---

# Summary — autowriter: hardening follow-ups to #113 and #114

**Branch:** `fix/autowriter-hardening-followups`, from `main` at `1096f33` (#113 and #114 merged). **PR:** #115 (draft, base `main`).
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

## Review fixes (30 Sep, late evening)

The independent review of this PR at `7f60461` came back CLEAR with two MEDIUM design points and six LOW findings.
All are closed here. **Commits:** `a1473a4` code and tests · `c4f3d87` docs · `41be66a` a test's date format · this
section. No prompt text changed (`PROMPT_VERSION` and `JUDGE_PROMPT_VERSION` stay 5). No migration, no schema or env
change. Fakes only: no live OpenRouter or Soniox call, nothing written to Wise or to the production database. The PR
stays a draft. The reviewer's "judge block complexity" refactor is not done, as instructed.

These fixes replace parts of what is written above: item A's order and its "retries off" rule, item B's single
count, deviations 1–4 and 8, and the third point of "Open for the owner" (closed by fix 2). The PR description
still has the earlier wording.

### 1. [MEDIUM] The order a sweep starts its rows in
- `job.ts:1306` `worksWithoutModel`: a row whose last reason is `transcription_in_progress` is no longer a "row
  without a model call". Its Soniox job may have finished, and it then calls the writer and both judges in the same
  run. Left in the group: a stored judged transcript draft (post only), and a transcript row with no Soniox job yet.
- `job.ts:1323` `sweepOrder(due, now)`, used at `:1402`: (1) the rows whose `deadline_at` is no more than 3 hours
  after the sweep's `now`, soonest deadline first, whatever they need; (2) the rows that call no model; (3) the rows
  that may need the writer. Groups 2 and 3 keep `listDueRows`' order, and so do rows of group 1 with the same
  deadline. `config.ts:227` `AUTOWRITER_SWEEP_NEAR_DEADLINE_MS = 3 h`.
- Tests, `job.integration.test.ts`: `:696` six rows beyond the 3 hours — the running job now among the writer rows,
  a stored draft still ahead of them (c); `:727` a `transcription_in_progress` row whose job has finished starts
  after an earlier-deadline summary row and is written and judged in that sweep (a); `:750` three rows within 3
  hours (one failed last time, one a ready transcript exactly at the mark) start before the rows that call no model,
  and a row at 3 h 36 s does not (b); `:779` rows close to the same deadline keep the usual order.

### 2. [MEDIUM] `judge_failing`: two counts, two marks
- `job.ts:308-365` (`judgeFailed` at `:345`): a run that ends at the judge stage counts in `metadata.judgeErrors`
  when the judge itself failed (the pipeline's `modelFailure`: a time-out, no verdict in two tries, the wrong route
  or model, a provider error) and in `metadata.judgeUnreached` when it could not be asked (rate limited after its
  retries, no time left in our function to start it, our account or connection: no credit, a bad key, the network).
  `metadata.judgeUnreachedCause` keeps the last such cause (`rate_limited`, `out_of_time`,
  `account_or_connection`). The alert is raised by the run that takes the counts to a mark (`:317`):
  `judgeErrors ≥ 3` (`AUTOWRITER_JUDGE_ERRORS_ALERT`, `config.ts:296`) or `judgeErrors + judgeUnreached ≥ 6`
  (`AUTOWRITER_JUDGE_STAGE_ERRORS_ALERT`, `config.ts:304`). `job.ts:372` `judgeAnswered` resets both.
- `store.ts:671-723` `listPendingAlerts`: the same two marks in SQL (each count read only when it is a JSON
  number), and a `judge_failing` alert carries `judge {errors, unreached, unreachedCause, since}` (`:668`).
  `store.ts:573-574`: an owner retry clears the new keys too.
- `alerts.ts:17-41`: the text is built from the counts. It blames the judge model only for its own failures and
  names the cause otherwise: "not a failure of the judge model: OpenRouter rate limited the judge's route", "… our
  own function ran out of time before the judge could start", "… our OpenRouter account or connection refused the
  call (no credit, a bad key or a network error)"; for a mix, "failures of the judge model: 2; not its failure: 4 —
  the last time, …".
- Tests: `job.integration.test.ts:2186` (three rate-limited runs raise nothing; an out-of-time and a no-credit run
  are counted with their cause; the sixth alerts with a text that does not blame the judge; a seventh raises
  nothing; both counts are zero after an answer), `:2227` (the judge's third failure alerts at five runs in all;
  two failures plus four other runs alert; no second alert in the same run of failures), `:304` (the summary path);
  `store.integration.test.ts:403` (both marks, counts that are not numbers, what the digest is given), `:454` (the
  retry); `alerts.test.ts:48-84` (every text).

### 3. [LOW] An alert recorded in shadow is sent once live
`job.ts:362-364`: with the counts already at a mark, a failure in `live` mode whose `alerts_sent.judge_failing`
starts with `suppressed:` arms the alert again. Test `job.integration.test.ts:2304`: recorded in shadow; a fourth
failure in shadow changes nothing; the fifth, live, sends one email; the sixth none.

### 4. [LOW] "In a row" never spans an answer of the judge
- `pipeline.ts:89`, `:256-258`, `:393`: an infra result says `judgeAnswered: true` when the judges had decided a
  draft earlier in the run (no level stopped) — they rejected Sol's draft and the run went on to Luna.
- `job.ts:350-351`: such a run resets both counts, whether it then ended at the writer stage (Luna failed) or at
  the judge stage (Luna's draft could not be checked: that failure is the first of a new run of them).
  `job.ts:1137-1143`: also on the way to a `writer_failed` fallback.
- Tests: `pipeline.test.ts:977` (which results carry the flag), `job.integration.test.ts:2260` (two failures, then
  an answer followed by a Luna time-out, then a failure: no alert; the same when Luna's judge fails).

### 5. [LOW] One "retries off" switch per stage
`pipeline.ts:95` `RateLimitRetries = Record<"writer" | "judge", boolean>`, `:225` `retries:
input.rateLimitRetries?.[role]`; `job.ts:158` `ProcessOutcome.rateLimited` is the stage; `job.ts:1401`, `:1416` the
sweep keeps one flag per stage. Tests: `job.integration.test.ts:798` (a judge-route limit leaves the next class's
writer retry on), `:824` (a writer-route limit leaves a later class's judge retry on), `pipeline.test.ts:937`,
`:953`.

### 6. [LOW] `abandon` asked again after the wait; a repeated `Retry-After`
- `openrouter.ts:325-330`: asked before the wait and again after it, before the retry is sent. An attempt given up
  after its wait stays the last one, and the result carries that wait (`waitedMs`), which `pipeline.ts:247-250`
  puts on its call record.
- `openrouter.ts:93-105` `retryAfterValues`, `:125-130`: a header sent more than once (`60, 120`) gives the longest
  wait it names; an HTTP date keeps its own comma. The header listed with the error is read the same way.
- Tests: `openrouter.test.ts:202`, `:481`, and `:458` changed (`abandon` is now asked three times around one retry);
  `pipeline.test.ts:1195` (the other level decides during the wait: no retry is sent, the record keeps `waitedMs`).

### 7. [LOW] A malformed `attemptAt` cannot fail the daily metrics
`quality.ts:276-285` `ATTEMPT_AT_PATTERN`: the ISO form our records write, with a real day and time of this century,
so a value that matches always casts. `review-job.ts:605-606` casts `attemptAt` only when it matches; otherwise the
call is dated by `created_at`. Tests: `quality.test.ts:386-412` (every day of four years matches; 26 malformed
values do not), `review.integration.test.ts:837` (13 unreadable values, among them 30 February and `24:00`: the
query runs and dates those calls by their rows; a readable one still counts).

### 8. [LOW, open question] The relay key of a re-armed alert
`job.ts:361`: the run that reaches a mark stores `metadata.judgeFailingSince`. `alerts.ts:68-73`: a
`judge_failing` alert's part of the digest key is `id:kind:since`; every other kind's is `id:kind`, as before.
Tests: `alerts.test.ts:85-109`, `job.integration.test.ts:2285` (two runs of failures on one class: two emails,
two keys).

### 9. Docs
Feature page, "Hardening follow-ups": the three groups of the order and what it does not promise, one switch per
stage, the two counts and marks, the alert's text, `judgeAnswered`, the episode in the relay key, the shadow alert
sent once live, the repeated `Retry-After`, `abandon` after the wait, the guarded cast. Runbook: §6 and §7
(`judge_failing`: both marks, what each text means, what to do, the query), §8 (the sentence that a rate limit
"never holds those up" is gone; the order is described with what it does not guarantee, and a query for the rows of
the first group).

### Verification (fresh, Node 22, on `41be66a`, clean tree)
- `npm run typecheck`: pass. `npx eslint src/lib/feedback-autowriter src/components/feedback-autowriter`: clean.
  `git diff --check origin/main...HEAD`: clean.
- `npx vitest run --project unit`: 493 files, 5905 tests pass (16 more than at `443058b`: 9 in the new
  `alerts.test.ts`, 3 in `pipeline.test.ts`, 2 each in `openrouter.test.ts` and `quality.test.ts`). An earlier full
  run of the same code timed out two classroom tests (`assignment-repair`, `continuity`: 30 s) while other agents'
  test runs held the machine at a load of 40; both files passed alone at once, and the run counted here is clean.
- `npx vitest run --project integration src/lib/feedback-autowriter` (OrbStack): 4 files, 185 tests pass (13 more:
  11 in `job.integration.test.ts`, 1 each in `store.integration.test.ts` and `review.integration.test.ts`).

### Mutation checks
26 mutations, one at a time, each file restored afterwards (`src` clean at the end). A test fails every time; the
lines are the tests that failed (`job.integration.test.ts` unless named).
- **1, the order (5):** a running job back among the no-model rows (`:727`, `:696`); no near-deadline group
  (`:750`, `:779`); near-deadline rows not by deadline (`:750`); near-deadline rows without the no-model rows first
  (`:779`); a window of 30 minutes instead of 3 hours (`:750`, `:779`).
- **2, the counts and marks (6):** one count for every judge-stage run (`:2186`, `:2227`, `:304`); no second mark
  when the alert is raised (`:2186`, `:2227`); none when it is listed, in SQL (`store.integration.test.ts:403`,
  `:2186`, `:2227`); an answer that resets the judge's own count only (`:2186`, `:2260`); a text that blames the
  judge for a rate limit (`alerts.test.ts`, two tests); the second mark at 3, which is the rule before these fixes
  (`:2186`, `:2227`, `store.integration.test.ts:403`).
- **3, the shadow alert (2):** never armed again; armed again in any mode (`:2304` both times).
- **4, the answer (3):** the pipeline never saying the judges answered (`pipeline.test.ts:977`, `:2260`, `:2285`);
  the job ignoring it before a writer-stage failure (`:2260`, `:2285`) and before a judge-stage failure (`:2260`).
- **5, per stage (3):** one rate limit switching both stages off (`:798`, `:824`); the pipeline reading the
  writers' switch for every call (`pipeline.test.ts:953` and one more); the outcome always naming the writer stage
  (`:798`, `:2186`, `:304`).
- **6 (3):** `abandon` not asked again (`openrouter.test.ts:458`, `:481`, `pipeline.test.ts:1195`); the first wait
  of a repeated header (`openrouter.test.ts:202`); no `waitedMs` on the record (`pipeline.test.ts:1195`).
- **7 (2):** the cast without its guard (`review.integration.test.ts:837`); a pattern that checks the form only
  (`quality.test.ts:401`, and `review.integration.test.ts:837`: the cast fails on a day that does not exist).
- **8 (2):** no episode in the relay key (`alerts.test.ts:97`, `:2285`); no time recorded when a mark is reached
  (`:2285` and three more).

### Judgement calls
1. **"Within 3 hours" is measured to the feedback deadline** (`deadline_at ≤ now + 3 h`, with the `now` the expiry
   step uses), as the finding words it. The expiry takes a class 30 minutes before that, so the window is the last
   2.5 hours in which a class can still be written. Measuring to the expiry instead is a change of one constant.
2. **Rows close to the same deadline keep the old order**: the rows that call no model first, a failed row last.
   Every class's deadline is 23:59:59.999 Bangkok, so the rows of one night always have the same deadline;
   "soonest deadline first" alone would leave their order to the database. Between different deadlines the sooner
   one goes first, also when it failed last time.
3. **What is "the judge's own failure"** is the pipeline's existing `modelFailure`. So a provider error (HTTP 5xx,
   `finish_reason: error`) counts toward 3, and a bad key (401) or a network error counts toward 6, with the rate
   limit, no credit and out of time. The text has three causes for the second kind: rate limited, out of time,
   account or connection. "No credit" is named inside the third, and the row's reason in brackets carries
   OpenRouter's own message.
4. **The judge's count is not reset by a run in which it could not be asked.** Both counts run until the judge
   answers, as asked. So failure, rate limit, failure, rate limit, failure alerts at the fifth run.
5. **One alert per run of failures**, raised by the run that first reaches either mark. A run of failures that
   reached 6 and later holds three failures of the judge itself does not alert a second time.
6. **`judgeAnswered` means the judges decided a draft**: no level stopped. One level passing a draft while the
   other fails is not an answer (the draft was not checked). One level rejecting it while the other left off is.
7. **A suppressed alert is armed again by the next judge-stage failure in live mode**, not at the moment of the
   switch to live: a class that stops failing after the switch never sends it.
8. **The record of an attempt given up after its wait keeps `waitedMs`**: the wait was made, so it is on record.
9. **The ISO pattern checks the day of the month and leap years** (years 2000–2099). A pattern of digits alone
   lets `2026-02-30` through, and the cast still fails (the second mutation under 7). It lives in `quality.ts`,
   where a unit test checks it against every day of a year.
10. **Types changed**: `rateLimitRetries` is `{ writer, judge }`, and `ProcessOutcome.rateLimited` is a stage.
    Existing tests changed with them, and the six-row order test now uses deadlines beyond the 3 hours.
11. **The PR description is not edited.** Its sections A and B, judgement calls 2–4 and 8, the test counts and the
    third open point describe the code before these fixes.

### Open for the owner
- **Tonight's rows come first, so a slow one can use a sweep's start window.** A sweep starts classes in its first
  180 s, and a judge time-out on a transcript takes 240 s. Among the rows of one night a row that failed last time
  still comes after the others, so they are tried first; the rows with later deadlines wait for the next sweep.
  Webhook runs are not affected.
- The two points left open above still stand: a deferred POST waits at least 10 minutes, and a deferred summary
  draft is written again.
