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
   Migration **0098** must be applied before deploying code that knows the second pass (it adds the `evidence` column).
3. **Wise → Institute Settings → Developer options → Webhooks → Add Webhook.** Never edit the existing
   subscription (it feeds a Google Apps Script). URL `https://bgscheduler.vercel.app/api/wise/webhook`,
   events `MeetingEndedEvent`, `AttendanceComputedEvent` and `RecordingCompletedEvent`; its auth key (shown or chosen
   in Wise) is `WISE_WEBHOOK_SECRET`. Deliveries before the deploy fail harmlessly (Wise retries for ~4 h; the
   backstop cron covers every class anyway).
   Send a test: Vercel logs `[wise-webhook] key arrived in header "<name>"` (optionally pin it with
   `WISE_WEBHOOK_AUTH_HEADER`); a refused delivery logs `unauthorized delivery; header names: …` instead.
   Confirm read-only with `GET /institutes/{id}/webhooks` that both subscriptions exist and the original is unchanged.

### Operating loop, Phase 1 (migration 0099) — in this order

1. **Apply migration 0099** on production Neon (`DATABASE_URL=… npm run db:migrate`). It only adds tables; the
   autowriter keeps running meanwhile.
2. **Day-one backfill**, dry run first (reads only, never writes to Wise, prints metadata only):
   `npx tsx --tsconfig scripts/tsconfig.json scripts/feedback-autowriter-backfill-review.ts`
   Expect every posted class `first shot PROVEN` (29 Sep: 2 unchanged, 5 from Class Feedback's first version, Gift's
   by reverse rename) and six nickname correction rows. Then the same command with `--apply`. It writes no verdicts.
3. **Deploy** the code. Doing step 2 first matters: otherwise the review job's first run sees the six nickname
   re-posts as API saves no post explains and raises six critical incidents (re-classified once the backfill runs,
   but the pushes will have gone).
4. Optional: `FEEDBACK_AUTOWRITER_LINE_TO` (a LINE user or group id) to receive critical incidents on LINE as well
   as by email; set `FEEDBACK_AUTOWRITER_ALERT_EMAILS` if it is still empty — with no channel a critical incident
   stays pending and the review job reports `ok:false` (Data Health shows it).

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
   - `feedback_autowriter_calls`: 100% of GLM calls with `provider = 'Together'`;
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

Dashboard state "Waiting for recording" / "Transcribing" = the class was handed over (`reason` says why:
`summary_draft_held`, `no_usable_summary`, `thai_summary`). Nothing to do: Wise's `RecordingCompletedEvent` (or the
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
then held with an alert (`transcript_pass_unavailable`) so a person writes them.

Alerts from the second pass: `no_recording` (recording or transcript still not ready 3 h after class — Wise may never
publish a recording for it), `speakers_unclear`, `transcript_too_short`, `recording_too_short`,
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

## 6. Alerts

One digest per sweep to `FEEDBACK_AUTOWRITER_ALERT_EMAILS` for classes that need a person: held (draft failed
checks, absence, form/billing drift), expired, no summary 3 h after class, and any halt-causing outcome.
In `shadow` (and `off`) only the halt-causing outcomes are emailed; draft alerts stay on the dashboard.
A switched-off tutor's classes are handed back to them silently when they reach the deadline window.
Nightly tutor reminders are separate (Class Feedback).

## 7. Reviewing posts (operating loop)

`/feedback-autowriter` → **Review**. "Needs review" lists every required post without a verdict (every post while
the tutor's cohort has not passed a gate). Judge the **first shot** (left), not the current text: Approve, or Needs
fix with a severity — cosmetic still counts as accurate; factual is a real fix; critical needs a category, blocks
the gate and pushes an alert. A verdict can be replaced by recording a new one (the log keeps both). A class flagged
by a measured fix (someone saved it in Wise after our post) stays in "Flagged" until a verdict answers it; the gate
cannot pass while one waits. Recording the first verdict on a class also ends its Soniox review window.

**Quality** shows the gate. The review job runs hourly at :27 (Data Health → Feedback Autowriter Review; manual run
owner-only); the daily gate row is written from 22:00 Bangkok. Incidents: `critical_verdict` and
`api_actor_unmatched` (an API save no recorded post explains — check who wrote to Wise with the API key) are pushed;
`first_shot_unverified` (a class edited before its first shot was recorded) is shown only — run the backfill script
to prove it, or confirm by hand what was posted.
