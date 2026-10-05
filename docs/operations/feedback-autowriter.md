# Feedback Autowriter — runbook

Feature page: [`features/feedback-autowriter.md`](../features/feedback-autowriter.md). CLI:
`npx tsx --tsconfig scripts/tsconfig.json scripts/autowrite-online-feedback.ts …` (run from the repo root with a
`.env.local` holding `DATABASE_URL`, `WISE_*`, `OPENROUTER_API_KEY`).

## 1. One-time setup

1. **Migration 0097** on production Neon (`DATABASE_URL=… npm run db:migrate`). It seeds the control row in
   `shadow` mode.
2. **Vercel production env** (redeploy after changing):
   | Variable | Value |
   |---|---|
   | `OPENROUTER_API_KEY` | a dedicated key with a credit limit |
   | `FEEDBACK_AUTOWRITER_ENABLED` | `true` (anything else: cron and webhook do nothing) |
   | `FEEDBACK_AUTOWRITER_ALERT_EMAILS` | comma-separated recipients of the held-class digest |
   | `WISE_WEBHOOKS_ENABLED` | `true` (otherwise the receiver acknowledges and ignores) |
   | `WISE_WEBHOOK_SECRET` | the auth key of the BGScheduler webhook in Wise (step 3) — same value on both sides |
   | `WISE_WEBHOOK_AUTH_HEADER` | optional: pin the header named in the first delivery's log line |
   | `FEEDBACK_AUTOWRITER_TRANSCRIPTS_ENABLED` | `true` to hand held / summary-less / Thai-summary classes to the Soniox second pass |
   | `SONIOX_API_KEY` | Soniox project key (set a spend limit in the Soniox Console) |
   | `FEEDBACK_AUTOWRITER_TRANSCRIPT_FIRST` | `true` to write every class from the transcript, the summary only as the fallback (§6); needs the two above |
   Migration **0098** must be applied before deploying code that knows the second pass (it adds the `evidence` column),
   and **0100** before deploying the Sol writer (it lets `arm` be `sol`; see [section 8](#8-writer-model-gpt-61-sol-since-2026-09-30)).
3. **Wise → Institute Settings → Developer options → Webhooks → Add Webhook.** Never edit the existing
   subscription (it feeds a Google Apps Script). URL `https://bgscheduler.vercel.app/api/wise/webhook`,
   events `MeetingEndedEvent`, `AttendanceComputedEvent` and `RecordingCompletedEvent`; its auth key (shown or chosen
   in Wise) is `WISE_WEBHOOK_SECRET`. Deliveries before the deploy fail harmlessly (Wise retries for ~4 h; the
   backstop cron covers every class anyway).
   Send a test: Vercel logs `[wise-webhook] key arrived in header "<name>"` (optionally pin it with
   `WISE_WEBHOOK_AUTH_HEADER`); a refused delivery logs `unauthorized delivery; header names: …` instead.
   Confirm read-only with `GET /institutes/{id}/webhooks` that both subscriptions exist and the original is unchanged.

### Operating loop, Phase 1 (migration 0101) — in this order

1. **Apply migration 0101** on production Neon (`DATABASE_URL=… npm run db:migrate`). It adds tables, and one AFTER
   trigger on `feedback_autowriter_control` that logs mode and tutor-switch changes (lease and halt writes do not fire
   it); the history is seeded with the row's state as of its last change. The autowriter keeps running meanwhile.
   **Numbering.** 0101 comes after main's `0099_staff_feedback_timing` and the Sol arm-check migration, both already
   applied in production. The Sol migration is `0100_feedback_autowriter_sol` (PR #108; journal idx 100, `when`
   1790735838903): it was applied in production as "0099", so its `when` stays deliberately below idx 99's
   1790738705641. Drizzle's migrator applies only the journal entries whose `when` is later than the newest
   `created_at` it has recorded; 0101 keeps `when` 1790740000000, later than every applied entry, so a production
   `db:migrate` applies only 0101. `db:generate` numbers the next migration from the **last** journal entry's `idx`, so
   the journal must stay sorted by `idx`: its last entries read 99, 100, 101, in that order.
2. **Day-one backfill — dry run, then the go/no-go check** (reads only, never writes to Wise, prints metadata only):
   `npx tsx --tsconfig scripts/tsconfig.json scripts/feedback-autowriter-backfill-review.ts`
   Expect every posted class `first shot PROVEN` and one row per one-time re-post the rows record: the six nickname
   fixes of 29 Sep (`metadata.nicknameFix`) as `policy` posts (never a fix, owner decision D-01) and the two
   owner-approved corrections of 30 Sep (`metadata.corrections`) as `correction` posts (fixes), none "TEXT NOT FOUND".
   The script refuses to run without `WISE_USER_ID`. It also prints the coverage of every day of the gate window and
   the owner verdicts it will record (`scripts/feedback-autowriter-owner-verdicts.json`), each pinned to its first shot.
   **Go/no-go:** the line "API saves no post explains" must list **no critical one** (a save after the autowriter
   went live at 2026-09-29 08:07:30 UTC). Each info one must be a known pre-launch save — on 29 Sep the owner's four
   pilot posts at 05:06–05:07 UTC on his own classes, confirmed by the owner on 30 Sep (GO). A critical one means someone
   wrote to Wise with the API key outside the lock: find out who before continuing (it will page the owner on the
   review job's first run whatever the order). The preview uses the job's own code over the same classes, so it can be
   re-run at any time (also after `--apply`) and still says exactly what the job stores.
3. **`--apply`**, then **deploy**. Either order is safe: until the backfill records them, the job explains our first
   posts from the rows themselves and the one-time re-posts from the `metadata` the scripts wrote, so none of them is
   reported as an unmatched API save; an edited class only shows an info `first_shot_unverified` incident until the
   backfill proves its first shot. Applying twice, or twice at once, records each post once (`dedupe_key`). It records
   the owner's committed verdicts once each through the dashboard's path (reviewer `kevhsh7@gmail.com (owner interview
   2026-09-30)`); one whose class meanwhile got another verdict, or a flag raised after the decision, is reported and
   left for the dashboard. The critical verdict keeps the gate `blocked_critical` through the critical class's Bangkok
   date + 13 days (the dry run prints the date); daily gate rows recorded before `--apply` stay as written: not a pass
   (unrecorded posts / required pending) rather than `blocked_critical`. The critical verdict's incident is pushed to
   the owner like any other.
4. Optional: `FEEDBACK_AUTOWRITER_LINE_TO` (a LINE user or group id) to receive critical incidents on LINE as well
   as by email; set `FEEDBACK_AUTOWRITER_ALERT_EMAILS` if it is still empty — with no channel a critical incident
   stays pending and the review job reports `ok:false` (Data Health shows it). `WISE_USER_ID` must be set on the
   deployment: without it the job derives no fix events and reports `ok:false`.

## 2. Modes and switches (take effect immediately — no redeploy)

| Command | Effect |
|---|---|
| `--status` | show mode, halt, disabled tutors, roster |
| `--mode=shadow --actor=<email>` | draft and judge, never POST (drafts land in `would_submit`) |
| `--mode=live --actor=<email>` | POST allowed; shadow drafts still before their deadline are re-queued |
| `--mode=off --actor=<email>` | do nothing |
| `--pause --reason="…" --actor=<email>` | global halt: no POSTs until resumed |
| `--resume --actor=<email>` | clear the halt (check why it halted first) |
| `--tutor-off=<wiseUserId>` / `--tutor-on=…` | per-account switch (a tutor has two accounts; the dashboard switches both together) |
| `--retry=<wiseSessionId> --actor=<email>` | send a `held`/`expired`/`skipped_scope` class back to `pending` (e.g. after a prompt or scope fix); never a class a person wrote; refused inside the 30-min deadline margin; its alert is re-armed |
| `--sweep` / `--process=<wiseSessionId>` | run the same guarded path by hand |

Outer gates needing a redeploy: `FEEDBACK_AUTOWRITER_ENABLED`, `WISE_WEBHOOKS_ENABLED`. Preview deployments never POST.

`FEEDBACK_AUTOWRITER_HOLD_SUMMARY_ONLY=true` (needs a redeploy; owner, 5 Oct 2026) holds every class that would be
written from Wise's AI summary alone, before any model call: reason `summary_only_held`, a normal hold alert, a person
writes it. With transcript first on, that is only a class that fell back from the transcript (no recording in 3 h,
speakers unclear, several parts, Soniox or writer failures). Why: audited summary-only posts had a real error 5 times
in 7, even with left-out homework not counted, and the nightly correction cannot repair them (its judges read the same
summary). Each held class is a coverage miss. Turn it off once Zoom captions reach the writer and the judges. The
system line shows "Summary-only drafts: held" while it is on.

Which switch in an incident: `--pause` (or mode `off`) stops all drafting and posting at once and **keeps
reconciling** POSTs already made, emailing their alerts. `FEEDBACK_AUTOWRITER_ENABLED=false` stops everything,
reconciliation included — rows in `posting`/`awaiting_event` then wait, visible on the dashboard, until it is
turned back on. Prefer `--pause` unless the code itself must not run.

The owner has the same mode, pause/resume and per-tutor switches on the dashboard at `/feedback-autowriter`. A tutor's
switch there covers both of their Wise accounts; "Partly on" means the CLI switched only one of them.

## 3. Rollout checklist

1. Shadow for 2–3 days. Exit criteria:
   - every `would_submit` draft reviewed next to what the tutor wrote themselves;
   - `feedback_autowriter_calls`: 100% of judge calls (`arm = 'glm'`) with `provider = 'Together'` — two per draft
     since v5, `result ->> 'effort'` = `medium` and `high` — and writer calls resolved to `openai/gpt-6.1-sol` (or
     `openai/gpt-6-luna` for a fallback draft);
   - gate reasons per tutor look right (`select wise_teacher_user_id, state, reason, count(*) from feedback_autowriter_sessions group by 1,2,3`);
   - webhook deliveries arriving (`select event_name, count(*) from wise_webhook_events group by 1`) and their
     session ids parsed (`wise_session_id is not null`).
2. Same hour: `--mode=live` and message the tutors:
   Tutors on the roster: Kevin, Gift, Ek, Peat, Mimi (29 Sep); Ras, Celeste, Taki, Dome, Mandy, Grace, Mint, Fluke
   (Chettaporn), Calvin, Lukas, A (Anavat), Ohm, Mookie, then Aey, Mikki, Sagotty, Buzz, Linn, Eng, Kavin, Copter, Amy
   (2 Oct), then every remaining online tutor: Tito, Petch-Than, Praew, Shop, Tai, Menika, Fay, Pat, Punlee, Pech, Jennie, Mek-Sila, Pakgad, Glai, Rew, Win, Sunday, Nithit, Key, Ayush, Art (5 Oct). All live on deploy — a new
   roster tutor is on unless their accounts are in `disabled_tutors`.
   > From today BGScheduler writes the Wise feedback for your **online one-to-one** classes from the Zoom
   > summary, in English. Offline and group classes are still yours. You can't edit it in Wise afterwards — ask an
   > admin. If an online class still shows blank feedback 3 hours after it ends, tell an admin.
3. First live POST per tutor: state `verified`, Wise shows the text, Class Feedback shows it `on_time`, the
   student's credit history has one entry for the class.

## 4. When it halts

`--status` (or the dashboard banner) shows `haltReason`; several reasons are joined with `| then:` — read all of
them, resuming clears every one. The class named there may have: a POST whose outcome is unclear, a read-back that
did not match, a second credit entry, a tutor/admin save between the fresh read and the POST (possible overwrite),
or a POST that could not be verified for 2 hours. Open the class in Wise (link in the alert email), fix it by hand
if needed (feedback text, credits), then `--resume`.
While halted nothing is drafted (no model calls); rows still expire with alerts so a person can write them.
The cron reports `ok:false` (503) while halted, so the cron watchdog emails admins.

A POST whose read-back failed stays `posting`, and one whose Wise submit event has not appeared yet sits in
`awaiting_event`; either blocks every other POST (one unsettled POST at a time) until the sweep reconciles it,
6+ minutes later; meanwhile no session is drafted (no model calls). If Wise reads keep
failing, Data Health shows the sweep's infrastructure errors; after 2 hours the row becomes `verify_failed` and the
autowriter halts.

## 5. Second pass (Soniox)

Dashboard state "Waiting for the recording" / "Transcribing" = the class was handed over (`reason` says why:
`transcript_first` (§6), `summary_draft_held`, `no_usable_summary`, `thai_summary`). Nothing to do: Wise's `RecordingCompletedEvent` (or the
30-minute backstop) continues it. It ends posted, `held` (+ alert) after 3 Soniox failures (a job still running an
hour after it was submitted counts as one), a multi-part recording, a recording shorter than 70% of the class (still
short 30 minutes after first seen), a transcript that is too short or speakers it cannot tell apart, or `expired`
(+ alert) if
the recording never comes before the deadline margin. A second-pass class shown as `pending` has its transcript
draft or is waiting for Wise (attendance, status, the POST slot), not for the recording. "Transcribing" with
`zoom_transcript_pending` is normal: the Soniox transcript is ready and the class waits for Zoom's name-labelled
transcript, which confirms who is the tutor — until 20 minutes after the Soniox job was submitted (the last look is
the next sweep after that, so at most ~35 minutes). No `no_recording` alert is raised for it.
To turn the second pass off: `FEEDBACK_AUTOWRITER_TRANSCRIPTS_ENABLED=false` + redeploy — classes already waiting are
then held with an alert (`transcript_pass_unavailable`) so a person writes them; a transcript-first class falls back
to the summary instead (§6).

Alerts from the second pass: `no_recording` (recording or transcript still not ready 3 h after class — Wise may never
publish a recording for it; not for a transcript-first class, which falls back to the summary at that point), `speakers_unclear`, `transcript_too_short`, `recording_too_short`,
`recording_multiple_parts`, or three Soniox failures. The `reason` says which.

Rolling back to code without the second pass (migration 0098 can stay — it is additive). Older code does not know
the two waiting states, so those classes would never be picked up or expire:

1. **Pause** on the dashboard, so nothing new is handed over. A worker already running can still hand a class over
   until it finishes: wait 15 minutes (longer than any run), or until no row is `generating`.
2. Hand every class of the second pass to people (a worker mid-transcript loses its lease and cannot POST):

   ```sql
   UPDATE feedback_autowriter_sessions
   SET state = 'held', reason = 'second_pass_rolled_back', lease_token = NULL, lease_until = NULL,
       metadata = metadata || '{"alertKind":"held"}'::jsonb, updated_at = now()
   WHERE state IN ('awaiting_recording', 'transcribing')
      OR (evidence = 'transcript' AND state IN ('pending', 'generating'));
   ```
3. Deploy the older code, remove `FEEDBACK_AUTOWRITER_TRANSCRIPTS_ENABLED`, run the UPDATE once more (it is
   idempotent), then **Resume**.
4. Delete any leftover jobs in the Soniox Console (they also expire there after 30 days).

## 6. Transcript first

`FEEDBACK_AUTOWRITER_TRANSCRIPT_FIRST=true` (exact string; only together with the second pass) hands every class that
passes the gates to the transcript, and uses Wise's summary only as the fallback. What it does and why:
[feature page](../features/feedback-autowriter.md#transcript-first-switch-30-sep).

**Before switching on — replay (read-only).** Shows what it would do with recent classes; it never posts or writes
to the database (Wise session-detail GETs, SELECTs, Soniox jobs deleted right after each transcript, ≈ $0.10 of
Soniox per class):

```bash
npx tsx --tsconfig scripts/tsconfig.json scripts/autowrite-online-feedback.ts --replay [--sessions=<id>,<id>] [--per-tutor=4] [--days=7]
```

Read `.feedback-autowriter/replay/<ts>/summary.md` (drafts and verdicts are in `records.json` next to it; both 0600,
gitignored). Go ahead when transcript holds are ≤ 15% and fallbacks ≤ 20% of the classes decided, no judge reply
fails to parse, the judge's 90th-percentile latency is ≤ 90 s, and Soniox is about $0.10 a class. Replay recent
classes: Wise drops a recording about a day after class, and such a class is skipped (`skip:recording_gone`). Use
the production Soniox project's key. Each job is deleted right after its transcript, and Ctrl-C deletes the jobs
still in flight; a line "SONIOX JOB NOT DELETED" means a job to delete in the Soniox Console (the sweep's reaper
also removes jobs of the production project that no row references, after 2 h).

**Switching on.** Set the variable in Vercel production on a Bangkok morning (before the afternoon classes) and
redeploy, then message the tutors:
> From today the feedback for your online one-to-one classes is written from the lesson recording, so it appears
> about an hour after class instead of a few minutes. If it is still blank 4 hours after class, tell an admin.

**What to expect.** A class shows "Waiting for the recording" from its end until Wise publishes the recording
(measured over 14 days: median 34 minutes after the scheduled end, 95% within about 70 minutes), then
"Transcribing", then posted — about an hour after class, up to about 4 h if the recording is late. With no recording
3 h after class, a recording in several parts, speakers that cannot be told apart, three Soniox failures, the
transcript pass switched off, or the writer failing three times in a row on the transcript draft (time-outs, replies
that are not JSON — not a judge failure, nor our OpenRouter account's or the network's errors, which all keep
retrying every 10 minutes), the class goes back to the summary once: the dashboard shows the cause under its state
("No recording after 3 h — from summary", …) and counts them in "Back to the summary". A class still waiting for its
recording raises no `no_recording` alert (it falls back instead); one still being transcribed 3 h after class
does. What still needs a person is `held` with its alert as before, including
`thai_summary_no_transcript` (a mostly-Thai summary after a fallback). Evening classes are driven mostly by the
`RecordingCompletedEvent` webhook; if the sweep queues up, the lever is a 5-minute cron. Soniox runs for every class:
about $22 a month.

**For 48 h after.** Class end → posted "From the transcript" about an hour; fallbacks by cause (several
"Writer failed 3 times on the transcript" in a day means the writer's route is failing: look at
`metadata.writerFailure` and the calls); no `no_recording` alerts; cost per draft about $0.11. A class that keeps
showing "Transcribing" with a reason `infra:judge:medium:…` or `infra:judge:high:…` has a transcript draft whose
judge keeps failing at that level: it retries every 10 minutes until its deadline (then expires with an alert) and
never falls back for that. After the judge's third failure — or six runs in a row that end at the judge
stage when it is not the judge that fails (a rate limit, our function's time, our account) — the digest carries one
`judge_failing` alert for the class (§7); if several classes show it, the judge's route (GLM on Together) is the
problem.

**Retrying.** `--retry=<wiseSessionId>` clears the fallback and the error counts, so a retried class goes to the
transcript again.

**Rollback.** Unset `FEEDBACK_AUTOWRITER_TRANSCRIPT_FIRST` and redeploy: new classes take the summary path again,
and classes already waiting finish from the transcript or fall back as above. No SQL is needed. (To turn the whole
second pass off, see §5: a transcript-first class waiting then falls back to the summary instead of being held.)

## 7. Alerts

One digest per sweep to `FEEDBACK_AUTOWRITER_ALERT_EMAILS` for classes that need a person: held (draft failed
checks, absence, form/billing drift), expired, no summary 3 h after class, no recording 3 h after class (§5), a
judge that keeps failing, and any halt-causing outcome.
In `shadow` (and `off`) only the halt-causing outcomes are emailed; draft alerts stay on the dashboard.

**`judge_failing`** ("The draft could not be checked N runs in a row (…) …"): the class's draft was written, but
it could not be checked, run after run — runs that ended at the judge stage with no answer of the judge in between.
Two counts, two marks:

- **3 failures of the judge itself** (`metadata.judgeErrors`): GLM on Together timed out, gave no verdict
  in two tries, answered from another host or model, or its provider failed. The alert says "the judge model
  failed: …".
- **6 such runs of any kind** (`judgeErrors` + `metadata.judgeUnreached`): this
  mark is for the runs in which the judge could not be asked — its route rate limited (after the in-run retries),
  our own function out of time before the judge could start, or our OpenRouter account or connection refusing the
  call (no credit, a bad key, the network). The alert then says which it was and does not blame the judge: "not a
  failure of the judge model: OpenRouter rate limited the judge's route" (or "our own function ran out of time
  before the judge could start", or "our OpenRouter account or connection refused the call …"). For a mix it gives
  both numbers. `metadata.judgeUnreachedCause` holds the last such cause.

The reason in brackets is the row's last one (`infra:judge:high:timeout`, `infra:function_budget_exhausted`, …).
Nothing is wrong with the class itself and nothing has been posted: it keeps retrying every 10 minutes until its
deadline and never falls back to the summary for this. One alert per run of failures — none for the runs after the
one that reached a mark; both counts start again when the judge answers (also when it rejected one draft and the
run then failed another way), and a new run of failures that reaches a mark alerts again
(`metadata.judgeFailingSince` is when it did; the relay key of the digest carries it, so a second alert on the same
class is not dropped as a repeat). An alert raised in `shadow` is only recorded (`alerts_sent.judge_failing` =
`suppressed:shadow`); if the class still fails after the switch to `live`, its next failure sends it.
What to do: if it is one class, wait or write it yourself before the deadline. If several classes alert together
with "the judge model failed", the judge's route is down — check OpenRouter's status for the model, and pause (§2)
if the tutors should write their own meanwhile. With "rate limited", see §8 (an own provider key); with "no
credit", top up the OpenRouter account; with "ran out of time", look at what ran before the judge in those runs
(a slow writer call, slow Wise reads). To see which classes are in it now:

```sql
select wise_session_id, state, reason, deadline_at,
       metadata ->> 'judgeErrors' as judge_failures, metadata ->> 'judgeUnreached' as judge_not_asked,
       metadata ->> 'judgeUnreachedCause' as last_cause, metadata ->> 'judgeFailingSince' as at_its_mark_since
from feedback_autowriter_sessions
where state in ('pending', 'awaiting_recording', 'transcribing', 'generating')
  and (coalesce((metadata ->> 'judgeErrors')::int, 0) >= 3
    or coalesce((metadata ->> 'judgeErrors')::int, 0) + coalesce((metadata ->> 'judgeUnreached')::int, 0) >= 6)
order by deadline_at;
```
A switched-off tutor's classes are handed back to them silently when they reach the deadline window.
Nightly tutor reminders are separate (Class Feedback).

## 8. Writer model (GPT-6.1 Sol since 2026-09-30)

Sol writes (reasoning `low`), Luna is the fallback writer and GLM the judge, all on zero-data-retention routes, for
summaries and transcripts alike ([feature page](../features/feedback-autowriter.md#models)). Deploy order: apply
migration **0100** first (applied in production on 2026-09-30 under the number 0099, before Codex's
`0099_staff_feedback_timing` took that number; the journal keeps its original `when`, so it never runs again). It
only widens the two `arm` checks to allow `sol`; code that writes `sol` against the old
checks cannot record its model calls, so every class would retry until its deadline.

After the deploy, look at the first drafts:

```sql
select role, arm, resolved_model, provider, ok, error, count(*), round(avg(cost_usd), 4) as avg_cost_usd
from feedback_autowriter_calls
where created_at > now() - interval '1 day' and role <> 'transcriber'
group by 1, 2, 3, 4, 5, 6
order by 1, 2;
```

Writer rows should be `sol` / `openai/gpt-6.1-sol` at about $0.04 each. Judge rows come in pairs since v5 (30 Sep):
every draft is judged at `medium` and at `high` on the same messages and passes only when both do
([feature page](../features/feedback-autowriter.md#judge-v5-and-writer-v5-30-sep-afternoon)). To see each level:

```sql
select result ->> 'effort' as effort, ok, error, count(*),
       count(*) filter (where result ->> 'faithful' = 'false') as flagged,
       round(percentile_cont(0.9) within group (order by latency_ms)::numeric / 1000, 1) as p90_seconds
from feedback_autowriter_calls
where created_at > now() - interval '1 day' and role = 'judge' and prompt_version >= 5
group by 1, 2, 3
order by 1, 2;
```

A judge call has 240 s on a transcript and 120 s on a summary; `timeout` rows near those numbers mean the level
could not finish, and the class retried 10 minutes later.

Writer rows with the error `… is temporarily rate-limited upstream` are OpenRouter's rate limit on the writer's
zero-retention route, not a failure of the draft (30 Sep afternoon: 6 of 10 writer calls while three classes were
replayed at once, 7 of 8 one-word requests sent together). The error never counts toward `writer_failed`.

**On a rate limit** (30 Sep evening, [feature page](../features/feedback-autowriter.md#rate-limits-tried-again-in-the-same-run-30-sep-evening)):
the same request is sent again in the same run — up to three more times, after about 4 s, 10 s and 25 s (each ±30%)
— for the writer, the fallback writer and both judge levels. When OpenRouter says how long to wait, that wait is
kept: never a retry before it, never a wait shorter than the schedule's; if it asks for more than 30 s (or more
than is left of the call's 45 s of waiting), the call is not tried again in that run. It
never waits past the run's time: with too little left for the wait and the call's time-out, the rate limit stands at
once. Only when the call is still rate limited after that does the class go back to retrying every 10 minutes, with
the same `infra:…` reason as before. In a sweep, the first class to end still rate limited switches the in-run
retries off for the classes after it **at that stage** — the writers' route (Sol, Luna) or the judge's, each has a
limit of its own, and the other stage keeps its retries — so they are asked once each there and retried in 10
minutes. A webhook run always retries.

**The order a sweep starts its rows in** (it starts a class only in its first 180 s, so what comes first is what
gets done):

1. the rows close to their deadline — `deadline_at` no more than 3 hours away — whatever they need, soonest
   deadline first. A class is expired 30 minutes before its deadline, so these have at most 2.5 hours of tries left;
2. the rows that call no model: a stored judged draft to post, a recording to wait for or to submit to Soniox;
3. the rows that may need the writer: a summary to write, a transcript whose Soniox job exists (ready, or still
   running at the last look: it may have finished, and the row then calls the writer and both judges), a draft
   whose model call failed.

Within 2 and 3 (and among rows of 1 with the same deadline, where the rows that call no model still come first) the
most urgent deadline comes first and a row whose last attempt failed (`infra:…`) comes last. Under a rate limit this
keeps a stored draft and a waiting recording ahead of the writer's rows, but it does not make them immune: whatever
the rows in front of them take — a class close to its deadline spending its retries on the limit, or a slow call —
is time out of the same 180 s. If group 2 is kept waiting sweep after sweep, look at the rows in group 1:

```sql
select wise_session_id, state, evidence, reason, deadline_at, retry_count
from feedback_autowriter_sessions
where state in ('pending', 'awaiting_recording', 'transcribing') and deadline_at < now() + interval '3 hours'
order by deadline_at;
```

**What the retries leave on record.** Each attempt is its own row, a rate-limited one at no cost, and every attempt
after the first carries `result.rateLimitRetry` (1–3). To see what the retries did:

```sql
select role, arm, result ->> 'rateLimitRetry' as retry, ok, count(*)
from feedback_autowriter_calls
where created_at > now() - interval '1 day' and result ? 'rateLimitRetry'
group by 1, 2, 3, 4
order by 1, 2, 3, 4;
```

These rows are retries only: a call's first attempt never carries the mark. So `retry = 1` rows count the calls
that were tried again at least once — not every rate-limited call. One that was not tried again (no time left for
the wait and the time-out, a sweep with its retries off, a wait OpenRouter asked for that did not fit) has a single
row without the mark; every rate-limited attempt, tried again or not, carries `result.attemptAt` (the second query
below lists them all). `ok = true` is a retry that was answered: that call went through
in the same run (whether the class then posted depends on the rest of the run). `ok = false` on a call's last row is
a call that still failed — look at its `error`: still rate limited, or failed another way (a time-out after a rate
limit is `retry = 1`, `error = timeout`); its class waited for its next run. A call can end before `retry = 3`:
the next wait no longer fitted the run's time or the call's 45 s. The rows of one call are written together when the
call ends, so a rate-limited attempt carries its own times: `result.attemptAt` (when its request was sent),
`retryAfterMs` (the wait OpenRouter asked for, when it named one — the longest, when its `Retry-After` header came
more than once) and `waitedMs` (the wait that followed):

```sql
select wise_session_id, role, result ->> 'rateLimitRetry' as retry, result ->> 'attemptAt' as sent_at,
       result ->> 'retryAfterMs' as asked_ms, result ->> 'waitedMs' as waited_ms, error
from feedback_autowriter_calls
where created_at > now() - interval '1 day' and result ? 'attemptAt'
order by wise_session_id, sent_at;
```

If rate limits keep classes from posting all the same, the error text itself points to adding an own
provider key for that model in OpenRouter (Settings → Integrations); before doing so, check that the key's endpoint
keeps zero data retention, as every autowriter route must. A `sol:model_mismatch:…` reason means
OpenRouter answered Sol's request with another model id: the run reports an infrastructure error and the class
retries, so that answer is never posted. Only the primary writer has this check; a Luna fallback answer is not
checked for its model (its `resolved_model` is in the query above).

**Rollback of the two judge levels (v5):** revert that PR and redeploy. The older code judges once at `high`; a
transcript draft waiting to post that v5 stamped is written and judged again by it (its versions and its stored
verdict differ), so nothing is posted on a verdict the running code does not recognise. No data change is needed.

**Rollback to the GLM writer:** revert the PR that made the switch and redeploy. That restores GLM on Together
(reasoning `max`) as the writer, Luna as a summary-only fallback on its old route, and transcripts written by GLM
alone. Keep migration 0100: every existing row passes the wider checks, and the older code still writes `sol`. A
judged transcript draft of Sol's that is still waiting to post is posted as it is only if the older code's prompt
and judge versions wrote it (the switch itself changed neither; v5 since changed both, so a v5 draft is written
again), and its row keeps `arm = 'sol'`, which the old checks would reject. Rows Sol already wrote keep `arm = 'sol'` (the older dashboard shows no model name for them); anything
else is written again by GLM. No data change is needed.

## 8a. Luna first for the tutors added on 2026-10-02 and 2026-10-05

The 43 tutors added on 2 Oct (cohorts of 13 and 9) and 5 Oct (cohort 5, 21 tutors), all roster entries with
`writer: "luna"`, are written by Luna (reasoning `max`) first, with
Sol as their fallback; the GLM judges are unchanged and everyone else keeps Sol then Luna (`writersFor` in
`config.ts`). No migration: `luna` and `sol` are both allowed arms. In the section 8 query, these tutors' writer rows
are mostly `luna`; a `sol` row for one of them is a fallback draft. The dashboard's "Written by the fallback writer"
counts Sol drafts for them and Luna drafts for everyone else.

**Turning one tutor off:** the dashboard switch (`disabled_tutors`), no deploy. **Moving them to Sol first:** remove
`writer: "luna"` from their roster entries and deploy.

**Adding a new online tutor:** the dashboard ("The gate in full", Roster line) lists every Wise account with an
online class in the last 14 days that the roster lacks. Append a roster entry for each of the tutor's two accounts
(from `tutor_identity_group_members` on the active snapshot) with `writer: "luna"`. Name variants are redacted word by
word and case-insensitively, so leave out any nickname or name part that is an ordinary English word (see the cohort 5
comment in `roster.ts`).

## 9. Reviewing posts (operating loop)

`/feedback-autowriter` → **What needs you → To review** → Review. The group lists every flagged post, then every
required post without a verdict (every post while the tutor's cohort has not passed a gate); posts already reviewed
are under Details → All classes, where the "Needs review" and "Flagged" counts are exact. The post opens in a drawer.
Judge the **first shot** (left), not the current text: Approve, or Needs fix with a severity you must pick —
cosmetic still counts as accurate; **major** is a real fix; critical needs a category, blocks the gate and pushes an
alert. A verdict can be replaced by recording a new one (the log keeps both). A verdict judges the first shot as
posted: replacing a harsher judgement with a milder one (critical → anything else, major → cosmetic or Approve) is a
downgrade — confirm it and write why in the note. After a fix on a class you judged major, answer its new flag by
recording major again, not Approve. If the page says "New activity since you loaded this class", a verdict or a flag
arrived meanwhile — the class reloads; look again before recording.

A class flagged by a measured fix (someone saved it in Wise after our post, before your Approve) stays in "To review",
marked Flagged, until a verdict answers it; the gate cannot pass while one waits, nor while a required post is unreviewed. A save
after your Approve is listed ("after approval — not counted") and raises no flag. A first shot that landed without
verifying (credits or status changed, text mismatch, unknown outcome) is flagged critical: open the class in Wise and
judge what is there. An Approve or a cosmetic fix ends the class's Soniox review window; a major or critical verdict
keeps the transcript (and re-opens a window an earlier Approve ended, if the sweep has not deleted it yet) until the
72 h window closes.

**Pilot health** (the rail on the right) shows the gate as one sentence, computed exactly as the nightly row, with the
criteria that are not met; every criterion is under Details → The gate in full. The review job runs hourly at :27
(Data Health → Feedback Autowriter Review; manual run owner-only). The daily gate row is written from 22:00 Bangkok by
the first run in which every step succeeded and the Wise activity sync is fresh (≤ 30 min, and not stopped at its page
cap); otherwise Details → Incidents and the review job says why ("nightly gate not recorded yet") and a later run
writes it. An unexplained API
write (`api_actor_unmatched`, critical) blocks the gate until you acknowledge it — find out who wrote to Wise with
the API key first. Incidents: `critical_verdict`, `critical_flag` /
`credit_entries_changed` (a post landed without verifying) and `api_actor_unmatched` (an API save no recorded post
explains — check who wrote to Wise with the API key) are pushed; `first_shot_unverified` is shown only (critical when
the post did not verify) — run the backfill script to prove it, or confirm by hand what was posted.
`atom_collection_failed` (an Atom collector run failed; lesson-only feedback carries on) and
`style_review_source_missing` (a guided post has no retained evidence or both factual verdicts) are critical and
pushed. Style review results are dashboard-only, never pushed (owner, 2 Oct 2026): `style_review_flagged` (the post
needs a style fix — listed in What needs you, not red, until acknowledged) and `style_review_unavailable` (the
reviewer returned no verdict; it retries after 6 hours, shown under Details only). `scan_failed` is kept for the
forward scan; before migration 0110 the Atom collector and the style review recorded under it. A critical
incident that was not delivered keeps the review job red (Data Health) until you **Acknowledge** it (What needs you →
Incidents → Open; its pushes stop too).

**Failure log.** Every failure a review finds — a post with a major or critical error, a draft the judges had to
stop, a hold that missed or nearly missed its deadline, an operational fault — is appended to
[feedback-autowriter-failure-log.md](feedback-autowriter-failure-log.md) with its code, root cause and status (no
names: this repository is public). The long-term improvement plan at the end of that page says what stops each code
from recurring; update it when a review finds a new pattern.


## Mimi style guide review and activation

Keep `FEEDBACK_AUTOWRITER_MIMI_STYLE_ENABLED=false` until the owner has approved ten successful comparison drafts.
The new read-only replay is separate from the production CLI: it issues only database SELECTs and Wise GETs, makes
model calls, and writes local files with private permissions. It never posts feedback, changes modes or writes any
production table. Examples and guide are passed explicitly to replay; production's switch stays disabled.

```sh
npx tsx --tsconfig scripts/tsconfig.json scripts/replay-mimi-feedback-style.ts \
  --out=.feedback-autowriter/mimi-style-review-v1 \
  --source-manifest=/absolute/private/path/source-provenance.json \
  --transcript-dir=/absolute/path/to/archived-soniox-pilot
```

`--env-dir=/absolute/path/to/checkout` optionally loads the operator's existing environment from another checkout.
`--source-manifest` names the private provenance receipt prepared when freezing the examples; it defaults to
`source-provenance.json` in the output directory. It carries guide id/version and each example's anonymous SHA-256
plus source version id, Wise session/event ids and original content hash. The replay checks this against the
public guide and rechecks the source rows. Keep this file and review outputs private; do not commit them.
Archived transcript filenames are `Mimi-<sessionId>.soniox.txt` and matching `.zoom.txt`; speaker labels are inferred
from the saved time-aligned text and never represented as freshly verified diarization. Unclear/too-short archived
transcripts use the session's Wise summary. The replay seeks ten distinct accepted drafts, with transcript evidence
where usable. Missing summaries, unavailable reads and scope failures are skipped. Drafts held by the pipeline
remain visible as additional attempts; the replay never weakens a guard to fill the sample. Raw lesson records and
participant names are not written to the report; it retains anonymous feedback, hashes, model costs and verdicts.
Historical events must precede Mimi's earliest recorded autowriter first-shot attempt; `historical-cutoff.json`
records that timestamp. This uses the actual rollout time, including human submissions made after midnight on
rollout day. Frozen source version/event/hash pairs are rechecked and preferred if current feedback was later
edited. Missing frozen source evidence fails the replay rather than silently replacing the guide's examples.

The replay checkpoints each comparison and resumes in the same directory. `--retry-failed` retries infrastructure
failures while retaining the earlier failed attempt; held drafts are never retried by that option. Use a new output
directory after a prompt/guide or evidence-processing change. Report-only presentation changes may reuse the saved
drafts. `summary.json` must show `total:10`, `passed:10`, and both evidence modes when archived transcripts were
available; `attempted` includes the held comparisons. `comparison.html` shows each draft beside prior human
feedback. An insufficient accepted sample makes the script exit nonzero. Do not interpret a successful model
verdict as owner approval.

After the owner approves layout, voice and length on all ten drafts, record approval against the report and guide
version, set the production environment switch to exact `true`, and redeploy the reviewed implementation through
the normal release process. Review the first ten new Mimi posts for format drift on the dashboard (What needs you →
To review; a post that was not sampled opens from Details → All classes) and retain their session ids/verdicts in the
rollout receipt. Any guide-format failure stays held after the fallback;
factual failures follow the existing checks. If drift requires rollback, set the switch to `false` and redeploy;
pending guided drafts will be regenerated under the shared prompt. Previously posted human or generated feedback
is not rewritten by this release. No first-ten live review is claimed until activation and those posts exist.

The first-shot ledger copies the guide stamp from the draft. This read-only query identifies the first ten recorded
Mimi v1 posts for review, including uncertain outcomes (which must be resolved, never treated as verified posts):

```sql
select wise_session_id, post_started_at, outcome, fields_sha256, pipeline
from feedback_autowriter_posts
where kind = 'first_shot'
  and pipeline -> 'styleGuide' = '{"id":"mimi","version":1}'::jsonb
  and outcome <> 'not_sent'
order by coalesce(post_started_at, recorded_at), id
limit 10;
```

Freeze the approved guide text and examples with their reviewed commit and `summary.json` instruction hash.
Every later guide/example change requires a new guide version and a new comparison; the production writer never
updates examples from its own posts.
