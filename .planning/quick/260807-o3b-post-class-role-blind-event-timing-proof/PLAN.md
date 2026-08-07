# Post-Class Feedback: accept non-auto Wise events as on-time proof, + timing-evidence visibility

## Context

Session `6a6b1450b03fafaaa1851041` (Jake (Jake.Ev) Evans, tutor **Kevin**) was marked `late` with a `pending_review` ฿100 deduction despite the feedback being submitted **17m54s before the deadline**.

Diagnosed against production:

| Fact | Value |
|---|---|
| Class ended | 2026-08-03 16:00 BKK |
| Deadline (`deadline_at`) | 2026-08-05 **23:59:59.999** BKK |
| `SessionFeedbackSubmittedEvent` | 2026-08-05 **23:42:05.728** BKK — before the deadline |
| Event `actor_wise_user_id` | `695369c028118f629edcb986` |
| Session `wise_teacher_user_id` | `695369c028118f629edcb986` — **same person** |
| Event `actor_role` | `ADMIN` |
| Verdict | `timing_status = late`, `timing_evidence = wise_activity_event_no_tutor_submission`, `submitterRoles: ["ADMIN","AUTO"]` |

`deriveEventTimingEvidence` ([policy.ts:341-342](src/lib/post-class-feedback/policy.ts:341)) only accepts events where `feedbackSubmitterRole(event) === "TEACHER"`. Kevin's Wise account carries the admin role, so Wise stamped his own submission `ADMIN`, the event was discarded, and rule 3 ("no qualifying event, deadline inside coverage → proves late") fired.

**Neither idea in the original request would have fixed this.** Timing is derived from Wise's immutable `event_timestamp`, never from our observation time (`policy.ts:463` `trustedVersionTime()`, `policy.ts:623-625`). A 30-minute grace window or a 23:5x cron burst cannot change a verdict that never consulted the cron clock.

### Blast radius (prod, sessions currently `late` + `eligible` + `source_status='ready'`)

Earliest pre-deadline **non-auto** feedback event, by actor class:

| Actor class | Sessions | With live deduction |
|---|---:|---:|
| Same Wise user id as the session's tutor | 539 | 3 |
| A different admin (on-behalf) | 314 | 1 |
| A student actor | 49 | 0 |
| **Total flipping to `on_time` under the chosen rule** | **902** | **4** |

Open deductions overall: 13 `pending_review`, 1 `approved`, 1 `waived`.

### Decision recorded

The qualifying rule becomes **role-blind**: any non-auto `SessionFeedbackSubmittedEvent` at or before the deadline proves `on_time`, whatever `actor_role` says. This was chosen deliberately after the table above was presented.

Stated consequence, carried forward so it is not rediscovered later: this removes the guard the subsystem was designed around — feedback written by a *different* admin on a tutor's behalf (314 sessions) and by a *student* actor (49 sessions) will now count as the tutor's own on-time proof. `AUTO` (Wise auto-submission) remains excluded, and the content bar is untouched, so weak or blank feedback still fails independently of timing.

---

## Work

### 1. Role-blind qualifying rule — `src/lib/post-class-feedback/policy.ts`

In `deriveEventTimingEvidence` (`:333`), replace the role filter at `:341-342`:

```ts
const qualifying = events
  .filter((event) => feedbackSubmitterRole(event) !== "AUTO")
  .toSorted((left, right) => left.eventTimestamp.getTime() - right.eventTimestamp.getTime());
```

Everything downstream is unchanged: `provenOnTime` (`:345`), the coverage-floor gate D-EVT-01 (`:357-358`), and `submitterRoles` (which still reports every observed role and stays the audit trail for *who* actually submitted).

Keep `feedbackSubmitterRole` (`:311`) exactly as-is — it is still how `AUTO` is detected and how `submitterRoles` is populated. Only its use as a *gate* goes away.

Update the JSDoc steps at `:326-331` and the `EventTimingEvidence` comment block to state the new rule and why (Wise's `actor_role` reflects the account's role, not who authored the text; a tutor who is also an admin is stamped `ADMIN`).

**Do not bump `post_class_settings.policy_version`.** The event `on_time` branch (`policy.ts:570`) is evaluated *before* the previous-violation-lock branch (`:652`) by design (D-EVT-02), so newly qualifying evidence clears an existing violation lock without invalidating the 5,923 already-`on_time` sessions' locks. Bumping would strand every existing lock for no gain.

### 2. Reassess history from stored evidence

902 sessions span months, and the routine collector is capped at 50 details/run — replaying them through Wise is wrong. Every input needed is already persisted: `post_class_feedback_versions` (immutable, `observed_at` excluded from upsert) and `wise_activity_events`.

Add a **reassess-from-stored-evidence** path that reuses the existing pure functions and the existing writer, with zero Wise traffic:

- `src/lib/post-class-feedback/reassess.ts` (new). For each affected session: `loadHistoricalFeedbackVersions` ([repository.ts:1125](src/lib/post-class-feedback/repository.ts:1125)), `loadFeedbackEvents` (`:1100`), `loadFeedbackEventCoverageFloor` (`:1116`), `loadPreviousComplianceLock` (`:1123`) → `calculateFeedbackDeadline` → `deriveEventTimingEvidence` → `evaluateSessionCompliance` → `repository.saveObservation(...)` with the persisted versions passed straight back through.
- Reuse `saveObservation` rather than hand-writing rows: it already owns the assessment insert, the `post_class_sessions` projection update, and the deduction reverse/reopen path at [repository.ts:1760-1769](src/lib/post-class-feedback/repository.ts:1760) that turns the 4 live deductions into reversals. It is idempotent — the version upsert is keyed on `(session_id, version_key)` and deliberately does not touch `observed_at` / `source_created_at`.
- Selection: sessions with `timing_status = 'late'`, `eligible`, `source_status = 'ready'`. Batch and log a per-session before/after so the run is auditable.

Expose it as a `mode: "reassess"` branch on the existing access-manager-gated `POST /api/post-class-feedback/sync` route (`src/app/api/post-class-feedback/sync/route.ts`), taking an optional date range — so it is re-runnable without a deploy and inherits the existing capability check.

Record the run in `post_class_sync_runs` with a distinguishable `trigger_type` so Data Health does not read it as a collector run.

### 3. Visibility — see exactly when the comment first appeared

The evidence already exists in the DB but is not surfaced, and the one place that shows an event timestamp shows no actor.

**a. Lookup by Wise session id** — `src/lib/post-class-feedback/detail.ts:55-57`. Resolve the path param as either the internal UUID or a Wise session id, then use the resolved `session.id` for every child query:

```ts
.where(or(eq(schema.postClassSessions.id, ...), eq(schema.postClassSessions.wiseSessionId, sessionId)))
```

Guard the UUID branch so a Wise id like `6a6b1450b03fafaaa1851041` does not throw a Postgres uuid cast error. No route change needed — `sessions/[sessionId]/route.ts` passes the param straight through.

**b. Actor identity on event associations** — `detail.ts:192-200`. The `post_class_feedback_event_links` row carries no actor, so join `wise_activity_events` (on `wiseActivityEventId`, falling back to `wiseEventId`) and add `actorName`, `actorRole`, `actorWiseUserId`, plus a derived `countedAsProof: boolean` and, when false, the reason (`auto_submitted` / `after_deadline` / `outside_coverage`). Reuse `feedbackSubmitterRole` so the UI and the policy cannot drift.

**c. Timing evidence timeline** — `src/components/post-class-feedback/session-detail-dialog.tsx`. Today `:386` renders a bare `{eventTimestamp} · version …`, and `:218-222` shows "No tutor-authored submission observed" with no explanation. Add one chronological timeline merging, against a deadline marker:

- each `SessionFeedbackSubmittedEvent` — timestamp, actor name + role, auto flag, counted / not-counted + reason;
- each feedback version — `observed_at` (labelled "first seen by us"), `source_created_at` + trust kind, combined character count, compliant flag;
- the resulting verdict with its `timing_evidence` code spelled out in plain words.

This is the artifact that resolves cases like this one without a psql session.

**d. Operations list `submittedAt`** — [dashboard.ts:295-302](src/lib/post-class-feedback/dashboard.ts:295) filters the `min(event_timestamp)` aggregate on `actorRole = 'TEACHER'`. Drop that predicate (keep the `autoSubmitted <> 'true'` guard) so the list column matches the new policy. Update the `session-detail-dialog.tsx:218-222` subtitle away from "Earliest tutor-authored Wise event".

### 4. Activity-mirror cadence — `vercel.json`

`sync-wise-activity` runs `5,35`, so a 23:42 event is not mirrored until 00:05. Move it to `2,17,32,47 * * * *` — an even 15-minute cadence on four currently-free minutes (no collision with `0,30` wise, `7,37` watchdog, `10,40` sales, `13,43` pcf, `15,45` leave, `20,50` credit, `23,53` backfill, `25,55` progress; minute 12 stays free for the admissions-stagger assertion).

Update the pinned expectation in [src/\_\_tests\_\_/vercel-crons.test.ts:18](src/__tests__/vercel-crons.test.ts:18).

Honest scope note: this halves worst-case event-visibility lag (30 min → 15 min) but does **not** produce pre-deadline *detection* end-to-end, because the collector itself still only runs at `13,43` — the next collector run after a 23:47 mirror is 00:13. Correctness is unaffected either way, since the verdict uses the event's own immutable timestamp. This is a dashboard-freshness improvement only.

### 5. Tests

- `src/lib/post-class-feedback/__tests__/policy.test.ts` — the existing cases at `:576-583`, `:597-607`, `:621-636`, `:644` assert ADMIN events are rejected; invert them. Add: ADMIN-role event by the session's own tutor proves `on_time`; STUDENT-role event proves `on_time` (records the accepted consequence); `AUTO` still never qualifies; `submitterRoles` still reports every role; the coverage floor still wins over a qualifying event below it.
- New `__tests__/reassess.test.ts` — a `late` session with a pre-deadline ADMIN event flips to `on_time` and its `pending_review` deduction reverses; re-running is a no-op; a session with only a post-deadline event stays `late`.
- `src/__tests__/vercel-crons.test.ts` — new activity-mirror schedule, and the existing "no minute collision" assertion must still pass.
- Detail projection test covering Wise-session-id lookup and the actor fields on `eventAssociations`.
- `src/components/post-class-feedback/__tests__/` — timeline renders events, versions, deadline, and the not-counted reason.

---

## Verification

1. `npm test` — full unit suite (369 files) green.
2. `npx tsc --noEmit`.
3. Targeted policy check:
   ```bash
   npx vitest run src/lib/post-class-feedback/__tests__/policy.test.ts
   ```
4. Dry-run the reassess against prod **read-only first** — run the selection query and confirm it returns 902 sessions and the 4 deductions before writing anything.
5. Run reassess scoped to the single session, then confirm in psql:
   ```bash
   psql "$DATABASE_URL" -c "SELECT timing_status, deduction_status FROM post_class_sessions WHERE wise_session_id='6a6b1450b03fafaaa1851041'"
   ```
   Expect `on_time` / a reversed (not `pending_review`) deduction.
6. Load `/post-class-feedback`, open that session's detail dialog, confirm the timeline shows the **2026-08-05 23:42:05.728** event with actor `Kevin (Kev) Y. Hsieh`, role `ADMIN`, marked counted, against the 23:59:59.999 deadline.
7. Then run the full reassess and re-check the `timing_status` distribution (expect `late` ≈ 1621 → ≈ 719, `on_time` ≈ 5923 → ≈ 6825).
8. After deploy, confirm `sync-wise-activity` fires on the new minutes in Data Health.
