---
phase: quick-260929-gvd
plan: "01"
status: complete
subsystem: feedback-autowriter (new) / post-class feedback / Wise webhooks
tags: [feedback-autowriter, openrouter, wise-webhooks, cron, drizzle, postgres, vitest, testcontainers, dashboard]

requires:
  - phase: origin/main 37cee1b
    provides: nightly feedback reminders (#90), migration 0096
provides:
  - src/lib/feedback-autowriter domain (roster, config, session gates, billing, prompt/redaction, OpenRouter client, validation, GLM judge, pipeline, guarded submit, DB store, alerts, job, webhook, dispatch, dashboard)
  - migration 0097 (feedback_autowriter_control / _sessions / _calls, wise_webhook_events)
  - POST /api/wise/webhook, GET /api/internal/feedback-autowriter (cron 8,22,38,52 * * * *), GET /api/feedback-autowriter, POST /api/feedback-autowriter/control
  - /feedback-autowriter dashboard page + nav entry
  - scripts/autowrite-online-feedback.ts (status / mode / pause / resume / tutor switches / sweep / eval)
---

# Summary — feedback autowriter (pilot → constrained rollout)

## Pilot (2026-09-29, local CLI)
- 4 of Kevin's online classes filled over Wise's blank auto-submissions; every POST verified (same submission id,
  auto flag cleared, one credit entry, non-auto Wise event by the API owner). Class Feedback: substantive + on_time,
  no deductions.
- A/B (blind Opus grading on the deep-dive rubric): GLM Flash 4.60, GPT-6 Luna 4.05, Kevin's own feedback 3.00.
  Cost per class: GLM ≈ $0.0024, Luna ≈ $0.0012.
- Decision: GLM `z-ai/glm-5.3-flash` pinned to Together with ZDR, Luna fallback, GLM judge.

## Rollout build
- DB-backed exactly-once state machine: conditional generation lease, POST claim only while the lease is held,
  the mode is live, the run is not halted and the tutor is on; `posting` is never re-claimed (reads-only reconcile).
- Global halt on rejected / unknown outcome / verify failure / foreign feedback event; Wise 429 read back and re-queued.
- Wise webhook fast path (MeetingEnded, AttendanceComputed, RecordingCompleted): readiness re-checked every 20 s for
  up to 3 minutes, bypasses the 10-minute retry wait; 15-minute backstop cron.
- Roster: Kevin, Gift, Ek, Peat, Mimi (201 of 841 online classes in the sample month = 23.9%, target ≥ 20%).
- Dashboard `/feedback-autowriter`: totals by state, class-end-to-post latency, cost by model/day, per-tutor table with
  owner switches, recent classes with the written text and judge flags, webhook deliveries; 60 s polling.

## Independent review (2026-09-29)
REQUEST CHANGES (0 critical, 1 high, 6 medium, 5 low); no double-POST path found. Fixed:
- dead-worker `generating` rows now recovered by the sweep (lease 14 min > maxDuration; 45 s Wise read time-outs);
- POST claim bound to the fresh-read teacher; teacher changes followed;
- one POST in flight institution-wide (partial unique index + NOT EXISTS, 23505 → post_in_flight, bounded wait);
  halt written before the read-back of a rejected/unknown POST;
- reconciliation re-verifies stale `posting` rows fully, reports read failures as infra errors, gives up after 2 h;
- no drafting while halted; preview deployments never touch state;
- pre-POST gate failures mapped like any gate; 60-minute attendance settle window;
- provider-side errors and judge non-verdicts retry instead of falling back to Luna; moderation/context-length
  failures may fall back;
- halt reasons accumulate; draft alerts suppressed outside live; switched-off tutors' overdue rows handed back.

## Verification
- Unit suites for session gates, billing, prompt/redaction, validation, OpenRouter parsing, judge, pipeline, submit,
  webhook config, dashboard, routes and component; Testcontainers integration `store.integration.test.ts` (14) and
  `job.integration.test.ts` (12) — 26/26.
- Typecheck, lint and `next build` clean; dashboard checked in a local dev server with sample data (scroll container
  bug found and fixed).

## Owner steps still open
1. Apply migration 0097 to production Neon.
2. Vercel env: rotated `OPENROUTER_API_KEY` (credit limit), `FEEDBACK_AUTOWRITER_ENABLED`, `FEEDBACK_AUTOWRITER_ALERT_EMAILS`,
   `WISE_WEBHOOKS_ENABLED`, `WISE_WEBHOOK_SECRET`, optional `WISE_WEBHOOK_AUTH_HEADER`.
3. Add a second Wise webhook subscription (leave the Apps Script one untouched).
4. Shadow 2–3 days against the runbook exit criteria, then go live and message the tutors in the same hour.
