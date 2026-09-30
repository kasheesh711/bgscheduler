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

Which switch in an incident: `--pause` (or mode `off`) stops all drafting and posting at once and **keeps
reconciling** POSTs already made, emailing their alerts. `FEEDBACK_AUTOWRITER_ENABLED=false` stops everything,
reconciliation included — rows in `posting`/`awaiting_event` then wait, visible on the dashboard, until it is
turned back on. Prefer `--pause` unless the code itself must not run.

The owner has the same mode, pause/resume and per-tutor switches on the dashboard at `/feedback-autowriter`. A tutor's
switch there covers both of their Wise accounts; "Partly on" means the CLI switched only one of them.

## 3. Rollout checklist

1. Shadow for 2–3 days. Exit criteria:
   - every `would_submit` draft reviewed next to what the tutor wrote themselves;
   - `feedback_autowriter_calls`: 100% of judge calls (`arm = 'glm'`) with `provider = 'Together'`, and writer calls
     resolved to `openai/gpt-6.1-sol` (or `openai/gpt-6-luna` for a fallback draft);
   - gate reasons per tutor look right (`select wise_teacher_user_id, state, reason, count(*) from feedback_autowriter_sessions group by 1,2,3`);
   - webhook deliveries arriving (`select event_name, count(*) from wise_webhook_events group by 1`) and their
     session ids parsed (`wise_session_id is not null`).
2. Same hour: `--mode=live` and message the tutors:
   Tutors on the roster: Kevin, Gift, Ek, Peat, Mimi.
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
transcript pass switched off, or the writer or its judge failing three times in a row on the transcript draft
(time-outs, replies that are not JSON — not our OpenRouter account's or the network's errors, which keep retrying),
the class goes back to the summary once: the dashboard shows the cause under its state
("No recording after 3 h — from summary", …) and counts them in "Back to the summary". A class still waiting for its
recording raises no `no_recording` alert (it falls back instead); one still being transcribed 3 h after class
does. What still needs a person is `held` with its alert as before, including
`thai_summary_no_transcript` (a mostly-Thai summary after a fallback). Evening classes are driven mostly by the
`RecordingCompletedEvent` webhook; if the sweep queues up, the lever is a 5-minute cron. Soniox runs for every class:
about $22 a month.

**For 48 h after.** Class end → posted "From the transcript" about an hour; fallbacks by cause (several
"Writer or judge failed 3 times on the transcript" in a day means the model route is failing: look at
`metadata.writerFailure` and the calls); no `no_recording` alerts; cost per draft about $0.11.

**Retrying.** `--retry=<wiseSessionId>` clears the fallback and the error counts, so a retried class goes to the
transcript again.

**Rollback.** Unset `FEEDBACK_AUTOWRITER_TRANSCRIPT_FIRST` and redeploy: new classes take the summary path again,
and classes already waiting finish from the transcript or fall back as above. No SQL is needed. (To turn the whole
second pass off, see §5: a transcript-first class waiting then falls back to the summary instead of being held.)

## 7. Alerts

One digest per sweep to `FEEDBACK_AUTOWRITER_ALERT_EMAILS` for classes that need a person: held (draft failed
checks, absence, form/billing drift), expired, no summary 3 h after class, and any halt-causing outcome.
In `shadow` (and `off`) only the halt-causing outcomes are emailed; draft alerts stay on the dashboard.
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

Writer rows should be `sol` / `openai/gpt-6.1-sol` at about $0.04 each. A `sol:model_mismatch:…` reason means
OpenRouter answered Sol's request with another model id: the run reports an infrastructure error and the class
retries, so that answer is never posted. Only the primary writer has this check; a Luna fallback answer is not
checked for its model (its `resolved_model` is in the query above).

**Rollback to the GLM writer:** revert the PR that made the switch and redeploy. That restores GLM on Together
(reasoning `max`) as the writer, Luna as a summary-only fallback on its old route, and transcripts written by GLM
alone. Keep migration 0100: every existing row passes the wider checks, and the older code still writes `sol`. A
judged transcript draft of Sol's that is still waiting to post is posted as it is (the switch changed neither the
prompt nor the judge version, so the older code reuses it), and its row keeps `arm = 'sol'`, which the old checks
would reject. Rows Sol already wrote keep `arm = 'sol'` (the older dashboard shows no model name for them); anything
else is written again by GLM. No data change is needed.
