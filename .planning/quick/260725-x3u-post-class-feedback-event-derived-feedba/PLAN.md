---
quick_id: 260725-x3u
slug: post-class-feedback-event-derived-feedba
date: 2026-07-25
status: in-progress
source: plan-mode (user-approved)
---

# Leverage Wise Activity events for feedback timeliness + backfill; park the email subsystem

## Context

Two asks:

1. **Use the Wise Analytics → Logs (activity events) feed to validate whether tutors submit post-class feedback on time.**
2. **Remove the email-relay and tutor-email-coverage gates**, and make a full backfill of `/post-class-feedback` possible.

I verified the premise against the live Wise tenant and the production Neon database. Three findings drive the whole plan:

**Finding 1 — the timing dimension is currently 100% non-functional.**

```
post_class_sessions (eligible=true, n=1648):
  timing_status = 'unknown'   1360
  timing_status = 'not_due'    288
  timing_status = 'on_time'      0
  timing_status = 'late'         0

post_class_feedback_versions (n=2728):
  provenance = 'unknown'      2728   (100%)
```

`evaluateSessionCompliance` only trusts a version's time when `sourceTimestampTrustworthy` is set, which requires Wise to return `submission.updatedAt`. It effectively never does. No session has ever been resolved on-time or late.

**Finding 2 — a live bug makes provenance unresolvable.** [repository.ts:827](src/lib/post-class-feedback/repository.ts:827) reads `autoSubmitted` from `payload.autoSubmitted` / `payload.feedback.autoSubmitted` / `payload.feedbackSubmission.autoSubmitted`. Wise actually puts it at **`payload.session.autoSubmitted`**:

```
wise_activity_events WHERE event_name='SessionFeedbackSubmittedEvent':
  payload->'session' ? 'autoSubmitted'   3427 rows
  payload ? 'autoSubmitted'                 0 rows
```

**Finding 3 — activity events carry the exact signal that's missing, and most feedback isn't written by the tutor.** 9,583 feedback events are already stored (2026-05-27 → 2026-07-25), covering 5,987 distinct sessions:

| `actor_role` | events | meaning |
|---|---|---|
| `(null)` + `payload.session.autoSubmitted:true` | 3,427 | Wise auto-filled; nobody wrote it |
| `ADMIN` | 3,075 | an admin filled it in for the tutor |
| `TEACHER` | 2,978 | the tutor actually did it |
| `STUDENT` | 103 | student-profile submission |

Joined against tracked eligible sessions, event timestamps vs. `deadline_at`:

| basis | on-time | of 1,648 eligible |
|---|---|---|
| any submitter | 1,622 | 98.4% |
| **`TEACHER` only** (your chosen policy) | **1,254** | **76.1%** |
| tutor never submitted at all | 325 | 19.7% |

So the activity event is not a marginal improvement — it is the **only** working source of timing truth, and it is the only place the tutor-vs-admin-vs-auto distinction exists at all. The session-detail path can't see it: an admin submitting on a tutor's behalf still writes a submission with `profile: "teacher"`.

**Decisions taken (from your answers):**
- Only `TEACHER`-authored submissions prove tutor compliance; `ADMIN` and auto do not.
- Backfilled history is **observation + analytics only** — nothing before `policyEffectiveAt` may generate a deduction. The existing non-negotiable boundary stands.
- Email: remove the activation gates now, park the subsystem (crons off, code retained).

---

## Verified API contract (live tenant, read-only GETs)

`GET /institutes/{id}/events?eventName=SessionFeedbackSubmittedEvent&page_number=N&page_size=50`

- The **`eventName` server-side filter works** — returns only feedback events. Already supported by [fetchWiseActivityEvents](src/lib/wise/fetchers.ts:498) via `WiseActivityEventsParams.eventName`; the activity sync just never passes it.
- **Full history = ~340 pages ≈ 17,000 events, oldest ≈ 2026-03-31.** Page 340 returns 43 rows; pages ≥350 return `{"events":[]}` with HTTP 200. No server-side page ceiling was hit.
- Payload shape is narrower than `normalizeWiseActivityEvent` assumes:
  ```
  event.{eventId, eventName, eventTimestamp, type:"SESSION"}
  event.payload.session.{id, autoSubmitted?}      ← NO scheduledStartTime/EndTime, NO submissionId
  event.payload.class.id, event.payload.user.id?
  user.{_id, name, role}                          ← ABSENT entirely when autoSubmitted
  classroom.{_id, name, subject}
  ```
  Consequences: `session_start_time`/`session_end_time` are always NULL for these rows, and `submissionId` is never present — so [eventForSubmission](src/lib/post-class-feedback/wise.ts:274) always falls through to its "exactly one event within ±5 min" heuristic, which breaks on edits (~10% of sessions have >1 event).

**Design consequence:** stop trying to bind an event to a specific submission for timing. Timing and authorship come from the event stream at **session** grain; content stays canonical from session detail. This matches the doc's existing rule that source / content / timing / deduction are independent dimensions.

---

## Part 1 — Event-derived timing and authorship

### 1a. Fix the payload path and capture actor role

[`src/lib/post-class-feedback/repository.ts:804-835`](src/lib/post-class-feedback/repository.ts:804) — `loadFeedbackEvents`:
- Add `["session","autoSubmitted"]` as the **first** entry in the `nestedBoolean` path list (keep the existing paths as fallbacks).
- Add `actorRole: schema.wiseActivityEvents.actorRole` to the select and to the mapped result.

[`src/lib/post-class-feedback/types.ts:186`](src/lib/post-class-feedback/types.ts:186) — `FeedbackEventEvidence` gains `actorRole: string | null`.

This alone makes `provenance` (`manual` / `auto` / `unknown`) resolve for the first time on all 2,728 stored versions.

### 1b. Derive session-grain timing from the event stream

New exported function in [`src/lib/post-class-feedback/policy.ts`](src/lib/post-class-feedback/policy.ts), sitting beside `calculateFeedbackDeadline`:

```ts
deriveEventTimingEvidence(input: {
  events: FeedbackEventEvidence[];
  deadlineAt: Date;
  eventCoverageFrom: Date | null;
}): {
  status: TimingStatus;              // on_time | late | unknown
  provenAt: Date | null;             // earliest qualifying TEACHER event
  submitterRoles: string[];          // distinct roles seen, for display
  source: "activity_event" | "none";
}
```

Rules, fail-closed and consistent with the existing non-negotiables:

1. A **qualifying event** is `eventName = SessionFeedbackSubmittedEvent` **and** `actorRole === "TEACHER"` **and** `autoSubmitted !== true`. `ADMIN`, `STUDENT`, and auto events never prove tutor compliance.
2. Earliest qualifying event `<= deadlineAt` ⇒ `on_time`, `provenAt` = that timestamp.
3. No qualifying event, and the deadline is **inside** event coverage ⇒ `late`.
4. **Coverage floor (critical).** If `deadlineAt < eventCoverageFrom`, the absence of an event proves nothing ⇒ `unknown`. Without this, a full backfill would manufacture 100% non-compliance for every session predating the event store. `eventCoverageFrom` = `MIN(event_timestamp)` over `SessionFeedbackSubmittedEvent` rows, read once per sync run via a new repository method `loadFeedbackEventCoverageFloor(): Promise<Date | null>`.
5. No events and no coverage ⇒ `unknown`, `source: "none"`.

### 1c. Wire it into compliance

[`src/lib/post-class-feedback/policy.ts:403`](src/lib/post-class-feedback/policy.ts:403) — `evaluateSessionCompliance` takes `eventTiming` (the 1b result) on its input and consults it **before** the existing `trustedVersionTime` / `versionProvesLate` version path:

- `eventTiming.status === "on_time"` ⇒ `timing_status = "on_time"`, and lock via the existing `onTimeComplianceLocked` / `onTimeVersionKey` mechanism against the governing version. Preserves the "a later edit can never erase proven on-time" invariant.
- `eventTiming.status === "late"` ⇒ `late`, unless a *version* independently proves on-time (belt and braces — never downgrade proven compliance).
- `eventTiming.status === "unknown"` ⇒ fall through to today's version-timestamp logic unchanged.

The content dimension (`assessFeedbackContent`, 300 code points, three required fields) is untouched. A tutor can be on-time and still content-noncompliant, exactly as now.

**Auto-submission policy change.** The doc currently says *"substantive auto-submissions may count."* Under "only `TEACHER` counts" that is no longer true for timing. Update [docs/features/post-class-feedback.md:48](docs/features/post-class-feedback.md) accordingly — auto-submissions remain retained evidence and still populate content, but never prove tutor timing.

### 1d. Persist the basis — no migration required

`post_class_assessments` already has `timing_evidence text` and `details jsonb`, and is append-only. Record:
- `timing_evidence` ← `"activity_event"` | `"source_timestamp"` | `"none"`
- `details` ← `{ eventTiming: { provenAt, submitterRoles, coverageFrom } }`

Write site: `saveObservation` in [repository.ts:1436](src/lib/post-class-feedback/repository.ts) (assessment insert). No schema or Drizzle change, no new migration — this avoids touching `post_class_protect_feedback_evidence()` and the immutability triggers.

### 1e. Surface it

- [`dashboard.ts`](src/lib/post-class-feedback/dashboard.ts) — add a `submittedBy` field per session row (`tutor` / `admin` / `auto` / `none`) derived from the event join, and a per-tutor `adminRescuedCount` + `autoFilledCount` on `FeedbackTutorMetric`.
- [`operations-tab.tsx`](src/components/post-class-feedback/operations-tab.tsx) — new "Submitted by" column + a filter option alongside the existing Outcome / Reminder / Source selects (`OperationsFilters` gains `submitter`).
- [`analytics-tab.tsx`](src/components/post-class-feedback/analytics-tab.tsx) — add "Tutor-authored on-time" vs "Admin-rescued" vs "Auto-filled" to the tutor scorecard table. This is the report that answers the original question.
- [`session-detail-dialog.tsx`](src/components/post-class-feedback/session-detail-dialog.tsx) — the existing "Wise event associations" section already lists events; add actor role + auto flag per row.
- New badge in [`feedback-ui.tsx`](src/components/post-class-feedback/feedback-ui.tsx), matching the existing `TimingBadge` / `SourceBadge` pattern.

### 1f. Tests

- `policy.test.ts` — `deriveEventTimingEvidence`: TEACHER on-time; TEACHER late; ADMIN-only ⇒ not proven; auto-only ⇒ not proven; deadline before coverage floor ⇒ `unknown`; multi-event session takes the earliest qualifying.
- `sync.test.ts` — event timing flows into the persisted assessment and `timing_evidence`.
- New case asserting `payload.session.autoSubmitted` is read (regression guard for Finding 2), using a fixture matching the real payload shape above.
- `dashboard`/component tests for the `submittedBy` projection and filter.

---

## Part 2 — Backfill

### 2a. Backfill the feedback event history (~340 pages)

[`src/lib/wise-activity/sync.ts`](src/lib/wise-activity/sync.ts) — extend `WiseActivitySyncOptions` with:

```ts
eventName?: string;          // pass through to fetchWiseActivityEvents
startPage?: number;          // default 1 — resumable chunking
stopOnKnownEvents?: boolean; // default true
```

- Pass `eventName` into the [fetcher call at :179](src/lib/wise-activity/sync.ts:179) (the fetcher already accepts it; the sync just never sets it).
- When `stopOnKnownEvents === false`, skip the `known_events` break at [:226](src/lib/wise-activity/sync.ts:226). Required: a re-run would otherwise stop on page 1 because every event is already stored.
- Start the loop at `startPage`; keep `maxPages` relative to it.
- `lookbackDays` must be set high enough (e.g. 400) that `lookback_reached` doesn't truncate; the natural stop is `empty_page` / `short_page` at ~page 340.

Everything else is reused as-is: the `onConflictDoNothing({ target: eventId })` dedupe, the single-flight partial unique index, and the `wise_activity_sync_runs` ledger.

Expose via the existing [`POST /api/wise-activity/sync`](src/app/api/wise-activity/route.ts) — add `eventName`, `startPage`, `stopOnKnownEvents` to its body schema. `maxDuration` is already 800; 340 sequential pages fit comfortably, and `startPage` gives resumability if not.

**Note the trade-off:** a long backfill holds the single-running lock and will 409 the `5,35 * * * *` activity cron for its duration. That path already handles 409 and self-heals on the next tick.

### 2b. Enumerate the denominator

Events give the numerator only. Sessions with *no* feedback have no event, so the eligible-session universe must come from `fetchWisePastSessionsByBangkokDate` — which the existing manual backfill already drives via `startDate`/`endDate` in [`resolvePostClassSyncWindow`](src/lib/post-class-feedback/sync.ts:137). No new code; just run it across the history in date chunks.

### 2c. Raise the detail cap and add a drain loop

Today `DEFAULT_DETAIL_CAP = 50` is clamped in **two** places — [sync.ts:189](src/lib/post-class-feedback/sync.ts:189) and [sync.ts:517](src/lib/post-class-feedback/sync.ts:517) — plus the route Zod `.max(50)`. At 50/run, ~6,000 untracked sessions (5,987 with events vs 2,517 tracked) needs 120+ manual runs.

- Add `BACKFILL_DETAIL_CAP = 400`, used **only** when `triggerType === "manual"` with an explicit backfill window. Cron stays at 50.
- Relax both clamps to `Math.min(cap, triggerType === "manual" ? BACKFILL_DETAIL_CAP : DEFAULT_DETAIL_CAP)`.
- Raise the route schema to `.max(400)`.
- New `src/lib/post-class-feedback/backfill-job.ts`, modelled directly on [`reminder-job.ts`](src/lib/post-class-feedback/reminder-job.ts) — same `DEFAULT_MAX_BATCHES` / `DEFAULT_MAX_ELAPSED_MS` time-budget drain loop, looping `syncPostClassFeedback` over a date range until the candidate pool is empty or the budget expires, returning `{ processed, remaining, blockedReason }`. Driven from the existing Settings → "Backfill range" dialog.

`DETAIL_CONCURRENCY = 4` stays — it is the Wise rate-limit guard.

### 2d. Enforcement stays prospective

No change to `policyEffectiveAt` handling. Backfilled sessions ending before the effective instant are assessed, scored, and displayed, but [`evaluateSessionCompliance`](src/lib/post-class-feedback/policy.ts:403) continues to produce no deduction candidate for them. This is what makes a full-history backfill safe to run before activation.

---

## Part 3 — Remove the email gates, park the subsystem

**Removed (activation no longer blocked on email):**

- [`settings.ts:120-127`](src/lib/post-class-feedback/settings.ts:120) — delete `emailRelaysConfigured()`.
- [`settings.ts:214-233`](src/lib/post-class-feedback/settings.ts:214) — delete the blockers for test-email, primary/backup relays, digest recipients, and tutor emails. **Keep** the reviewer/finance/access-manager role-coverage blocker.
- [`dashboard.ts:634-646`](src/lib/post-class-feedback/dashboard.ts:634) — delete `relayConfigured`, `tutorEmailCoverage`, and the `email_relay` / `tutor_emails` / `digest_recipients` setup items.
- [`types/post-class-feedback.ts:336-344`](src/types/post-class-feedback.ts:336) — drop those three keys from `FeedbackSetupItem["key"]`. Remaining checklist: `mapping`, `roles`, `shadow_review`, `activation`.
- `vercel.json` — remove the three email cron entries (`admin-digest`, `reminder-day-after`, `reminder-deadline`). **Keep** `sync-post-class-feedback` at `12,42 * * * *`.
- [`cron-registry.ts:168,184,200`](src/lib/data-health/cron-registry.ts) — remove the three matching entries so Data Health stops reporting them late.

I'm also dropping the `digest_recipients` gate, which you didn't name explicitly: with the digest cron removed it would block activation on configuring a digest that can no longer send. Say the word if you want it kept.

**Retained, dormant (code compiles, nothing fires):** `notifications.ts`, `reminder-job.ts`, the three internal route files, `POST /test-email`, `PATCH /tutor-emails`, Settings cards 3 (Tutor reminder emails) and 5 (Admin digest recipients), `postClassTutorEmailCoverageReady` and its tests, and all five notification tables + `tutor_contacts.primary_email`.

**Docs:**
- [`docs/reference/env.md:181-182`](docs/reference/env.md) — revert `SCHEDULE_EMAIL_BACKUP_*` to "Optional". The WIP had promoted a **shared** var (used by classrooms, progress-tests, leave-requests, cron-watchdog) to required on post-class-feedback's behalf.
- [`docs/reference/crons.md`](docs/reference/crons.md) — drop rows 9–11 and §5's reminder subsections.
- [`docs/features/post-class-feedback.md`](docs/features/post-class-feedback.md) — mark reminders/digest parked; rewrite the setup checklist (§Production setup) to four items; document event-derived timing, the `TEACHER`-only rule, and the coverage floor.

**Do not touch:** [`src/lib/classrooms/schedule-email.ts`](src/lib/classrooms/schedule-email.ts). It is the shared Apps Script relay behind classroom schedule emails, progress-tests digests, leave-requests, and the cron watchdog.

---

## Build order

1. Part 3 (gates + crons + docs) — smallest, unblocks activation, no dependencies.
2. Part 1a/1b (payload fix, `actorRole`, `deriveEventTimingEvidence` + tests) — pure functions, testable in isolation.
3. Part 1c/1d (wire into `evaluateSessionCompliance` and assessment persistence).
4. Part 2a (event backfill) — then re-run sync; timing resolves across the full history.
5. Part 1e (UI/analytics surfaces) — now has real data to render.
6. Part 2b/2c (denominator + detail drain) — the long tail.

---

## Verification

**Unit** — `npm test`. All 130 existing suites must stay green (the 82-test regression rule in CLAUDE.md). New coverage per §1f.

**Contract check against live Wise** (read-only, the probes used to build this plan):

```bash
set -a; . ./.env.local; set +a
AUTH=$(printf '%s:%s' "$WISE_USER_ID" "$WISE_API_KEY" | base64)
curl -s "https://api.wiseapp.live/institutes/$WISE_INSTITUTE_ID/events?page_number=1&page_size=5&eventName=SessionFeedbackSubmittedEvent" -H "Authorization: Basic $AUTH" -H "x-api-key: $WISE_API_KEY" -H "x-wise-namespace: $WISE_NAMESPACE" -H "user-agent: VendorIntegrations/$WISE_NAMESPACE" | python3 -m json.tool
```
Assert `payload.session.autoSubmitted` still appears and `user.role` is absent exactly when it is `true`.

**Post-backfill DB assertions** — the numbers that must move:

```sql
-- must reach back to ~2026-03-31 (currently 2026-05-27)
SELECT count(*), min(event_timestamp)::date FROM wise_activity_events
 WHERE event_name='SessionFeedbackSubmittedEvent';

-- must no longer be 100% 'unknown'
SELECT provenance, count(*) FROM post_class_feedback_versions GROUP BY 1;

-- must produce on_time/late rows for the first time
SELECT timing_status, count(*) FROM post_class_sessions WHERE eligible GROUP BY 1;

-- every 'late' must sit inside event coverage — zero rows expected
SELECT count(*) FROM post_class_sessions s WHERE s.eligible AND s.timing_status='late'
  AND s.deadline_at < (SELECT min(event_timestamp) FROM wise_activity_events
                        WHERE event_name='SessionFeedbackSubmittedEvent');
```

The last query is the fail-closed guard on the coverage floor and must return **0**.

**Expected shape of the result on today's tracked set** (1,648 eligible): ~1,254 `on_time`, ~325 sessions where the tutor never submitted, and the ~368 currently-"on-time" sessions that were actually admin-rescued or auto-filled reclassified as tutor misses.

**Manual** — run the backfill from Settings → "Backfill range", then confirm Analytics shows a tutor scorecard with non-zero tutor-authored on-time rates and a visible admin-rescued / auto-filled split.

---

## Flags

- **Enforcement stays prospective**, so the backfill cannot retroactively create deductions. If you later want historical enforcement, that changes a documented non-negotiable and needs its own decision.
- **The `TEACHER`-only rule will look alarming on first render.** Adjusted compliance drops from ~98% to ~76%, and 325 sessions flip to "tutor never submitted". That is the true signal, but worth previewing in shadow mode before anyone sees it as a scoreboard.
- **~32% of feedback is admin-authored.** That is an operational finding independent of this build — the current process appears to lean on admins backfilling tutor comments.
