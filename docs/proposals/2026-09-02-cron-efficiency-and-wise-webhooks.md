# Cron efficiency and Wise webhooks — evaluation and proposal

**Status:** proposal (evaluation complete; Tier 1 fixes shipped alongside this document; Tier 2/3 designed, not built).
**Verified against:** `origin/main` `fed828d` on 2026-09-02, plus the Wise webhook documentation at
<https://wise-app.gitbook.io/wise-app/wise-api-integration/webhooks-integration> (and its `webhook-retry-mechanism` /
`webhook-event-samples/*` sub-pages) fetched the same day.
**Companion reference:** [`docs/reference/wise-webhooks.md`](../reference/wise-webhooks.md) (event catalogue),
[`docs/reference/crons.md`](../reference/crons.md) (schedule registry).

---

## 1. Summary

BGScheduler runs **17 Vercel crons ≈ 512 invocations/day (≈ 15.4k/month)**. Invocation count is the *cheapest* of the
three costs the schedule creates. In order of real impact:

| Cost | Today | Dominant cause |
|---|---|---|
| Wise API calls | **≈ 240k/day** | `sync-wise` re-fetches every teacher's availability as **26 seven-day windows** (180-day leave horizon) every 30 minutes: 1 + 26 × 159 ≈ **4,135 calls/run**, ≈ 198k/day, **≈ 82 % of all Wise traffic** — with no change detection. (159 teachers measured by the probe on 2026-09-02; earlier docs said 131.) |
| Heavy function-minutes | **≈ 750/day** | `sync-wise` 48 × 4–6 min; `sync-credit-control` 48 × 6.5 min (372–390 s per healthy run); PCF, progress-tests, backfill 48 × 1–2 min each. |
| Cron invocations | 512/day | 8 half-hourly jobs + one 15-minute job; **28.7 % fire between 00:00 and 07:00 Bangkok** when nothing changes upstream. |

Three conclusions:

1. **The obvious lever is closed; the next one needs no webhooks either.** The EFF-09 probe (`scripts/probe-wise-availability-range.ts`,
   run 2026-09-02 against five teachers) showed that Wise **rejects any availability span longer than seven days** with
   HTTP 400 *"Difference between end date and start date should not be more then a week"*, so the 26-window stitch is
   mandatory, not incidental. The replacement lever is **EFF-12, a tiered leave horizon**: fetch the next 28 days (4
   windows) every run and the remaining 22 far-future windows only every 2 hours from a bounded-age cache. Because leaves
   only ever *add* unavailability and sessions are still fetched every run, the only exposure is a far-future leave
   entered less than two hours ago — a product decision, not a safety change. Expected: 4,135 → ≈ 1,510 calls per
   30-minute run (−≈ 125k/day).
2. **Wise webhooks can *trigger* and *narrow* our syncs, never replace them.** The 19 documented events cover sessions
   (create/update/delete), attendance computed, meeting lifecycle, classroom membership, fees and certificates. There is
   **no event** for teacher working hours, leaves, tags, session credits, teacher feedback submissions or payout invoices —
   exactly the data the heaviest jobs poll for. Payloads are sparse (an update may carry only `_id`, `classId`,
   `meetingStatus`), there is no event id, no ordering guarantee, and delivery must be acknowledged within **5 s**.
3. **Fail-closed forbids applying webhook deltas to the active snapshot.** Availability is served from snapshot-scoped
   tables rewritten wholesale per run and promoted atomically. A webhook may schedule a real sync; it must never free a slot.

Recommended order: **Tier 1** (this PR: false-alarm fix, bounded audit table, cheaper credit-control writes, collision-free
schedule, call-count telemetry, EFF-09 probe — result: negative) → **EFF-12 tiered horizon + EFF-01 availability cache**
(the two share one cache table) → **Phase 0** shadow webhook receiver (store only, measure coverage) → **Phase 1**
trigger-only dispatcher → **Phase 2** cadence reduction gated on measured coverage.

A trade-off to state plainly: the dispatcher design in §7 *raises* invocation count (512 → ≈ 681/day with a 5-minute
tick, ≈ 537 with a 10-minute tick) while cutting Wise calls by 55–92 %, heavy minutes by ≈ 45 %, and improving session
freshness from ≤ 45 min to ≈ 7–10 min. If invocation count is the metric that matters, §9 gives a webhook-free path
that lands at ≈ 353/day.

---

## 2. Baseline — the 17 crons

Schedules are UTC (`vercel.json`); Bangkok = UTC+7. Wise call counts are derived from code, not measured
(EFF-00 in Tier 1 adds the measurement).

| Cron | Schedule | /day | Wise calls per run (source) | Notes |
|---|---|---:|---|---|
| `sync-wise` | `*/30 * * * *` | 48 | 1 teachers + 26 × 159 availability windows (`src/lib/wise/fetchers.ts:63-105`) + 1–2 FUTURE session pages ≈ 4,135 | Full refresh, new snapshot every run, sequential per-teacher loop (`src/lib/sync/orchestrator.ts:156-260`), no early exit |
| `sync-wise-activity` | `2,17,32,47 * * * *` | 96 | 1–2 pages of 50 (`src/lib/wise-activity/sync.ts`) | Incremental (3-day lookback, stop-on-known); 15-min cadence is load-bearing for the PCF 23:59:59 deadline evidence |
| `sync-sales-dashboard` | `10,40 * * * *` | 48 | 0 (Google Sheets, 6–8 calls) | Only current/previous month re-imported |
| `sync-credit-control` | `20,50 * * * *` | 48 | students pages + PAST 120 d / FUTURE 180 d sessions in 31-day windows + **one `sessionCredits` GET per (class × student) pair** + one detail GET per ended-uncredited session (`src/lib/credit-control/wise.ts`) | Full refresh; healthy run 372–390 s; registry declared 300 s → every run flagged `failing` (fixed in Tier 1) |
| `sync-progress-tests` | `25,55 * * * *` | 48 | 1 teachers + PAST sessions from 2026-03-01 in 85-day windows (`src/lib/progress-tests/sync.ts:124-157`) | Growing window (185 days today); reads the credit-control snapshot promoted 5 min earlier |
| `sync-post-class-feedback` | `13,43 * * * *` | 48 | 1–3 window pages + ≤ 50 session details | Bounded; rolling 4-day window |
| `post-class-feedback-backfill` | `23,53 * * * *` | 48 | 0 once drained, else ≤ 50 details | Only cron with a real "nothing to do" early exit |
| `payout-accrual` | `33 * * * *` | 24 | 0 (Sheets/Drive) | Armed hourly; unattended charging |
| `sync-leave-requests` | `15,45 * * * *` | 48 | 0 (1 Sheets read) | Full sheet re-read each tick |
| `cron-watchdog` | `7,37 * * * *` | 48 | 0 | Full scan of `cron_invocations` each sweep |
| `progress-tests/admin-digest` | `35 0 * * *` | 1 | 0 | |
| `class-assignments/morning` | `45 23 * * *` → **`41 23`** (Tier 1) | 1 | may trigger a nested full `sync-wise` + FUTURE sessions + location PUTs | Collided with `sync-leave-requests` at 23:45 |
| `class-assignments/admin-email` | `0,10,20,30 0 * * *` → **`4,14,24,36 0`** (Tier 1) | 4 | 0 | Collided with sync-wise / sales / credit-control at 00:00/00:10/00:20/00:30 |
| `admissions-notifications` | `12 1 * * *` | 1 | 0 (Resend) | |
| `line-credit-digest` | `3 2 * * *` | 1 | 0 (LINE push) | |
| `sync-competitor-intelligence` | `25 18 * * 0` → **`28 18 * * 0`** (Tier 1) | 0.14 | 0 (Apify, DataForSEO, OpenAI) | Collided with `sync-progress-tests` |
| `student-promotions/july-1` | `5 17 30 6 *` | ~0 | Wise writes | Hard date guard → 409 forever after 2026-07-01 (open question) |

**Total ≈ 512 invocations/day.** Overnight (Bangkok 00:00–07:00 = UTC 17:00–00:00) the sub-hourly jobs fire 21×/hour ×
7 h = **147 invocations/night (28.7 %)** with no classes, no staff, and no new Wise state.

Five registry entries are manual-only (`schedule: null`): the three parked post-class reminder/digest routes,
`sync-room-utilization` (POST-only; nothing refreshes `room_utilization_sessions` automatically) and
`line-backlog-recovery`.

---

## 3. Where the load actually goes

### 3.1 Redundant Wise fetching

The same Wise resources are pulled independently by several jobs every half hour:

| Wise endpoint | Pulled by | Overlap |
|---|---|---|
| `GET /institutes/{id}/sessions?status=PAST` | progress-tests (185 days), credit-control (120 days), post-class-feedback (4 days), payroll (month, manual), student-schedule live sweep (per parent page view) | three nested windows, three times per half hour, 5–10 min apart |
| `GET /institutes/{id}/sessions?status=FUTURE` | sync-wise (whole institute), credit-control (180 days), classroom runs (**on the request path** of `POST /api/class-assignments/run`), room-utilization (manual), student-promotions | twice per half hour + every classroom run |
| `GET /institutes/{id}/teachers` | sync-wise at :00/:30, progress-tests at :25/:55 | identical roster + tags, 5 minutes apart; progress-tests then re-derives identity from the snapshot sync-wise just wrote |
| `GET /user/classes/{cid}/sessions/{sid}` | post-class-feedback (`fetchWiseSessionDetail`) and credit-control (`fetchSessionTeacherFeedback`) | same URL, two parsers, no shared cache |
| `GET /institutes/{id}/events` | wise-activity every 15 min; payroll re-crawls the same feed filtered to `TutorPayoutInvoiceCreatedEvent` | payroll re-reads events already persisted in `wise_activity_events` |

### 3.2 The sync-wise fan-out

`fetchTeacherFullAvailability` issues `Math.ceil(180 / 7) = 26` availability calls per teacher because the leave horizon is
stitched from seven-day windows; only window 1's working hours are kept, windows 2–26 exist purely to collect leaves.
**Wise enforces the seven-day ceiling server-side** — the EFF-09 probe received HTTP 400 for 30- and 180-day spans on
every teacher tried, so the stitch cannot be collapsed. The outer loop over 159 teachers is sequential (`for … await`)
while the client limiter allows 15 in flight, so a run pays ≈ 477 serial round-trips where ≈ 280 would do (already
flagged as AMB-12 in `docs/OPEN-QUESTIONS.md`). `SyncResult.durationMs` and the new `wiseCallCount` are now persisted in
`sync_runs.metadata` (Tier 1), so the next revision can replace these derived figures with measured ones.

### 3.3 Database write patterns worth fixing

- credit-control inserted 22.8k session rows in **228 sequential chunks of 100** over neon-http (Tier 1: chunk 500), and its
  promotion `UPDATE … SET active = (id = $new)` had **no `WHERE`**, rewriting all 3,367+ snapshot rows every run
  (Tier 1: bounded like `orchestrator.ts:488-498`).
- `credit_control_*` snapshot tables have **no retention** anywhere: ≈ 1.09M session rows/day are inserted and never
  deleted (67.8M rows / 39 GB / 3,367 snapshots per the schema comment). EFF-10.
- progress-tests does an N+1 `upsertCycleState` loop plus two unbounded full-table `SELECT`s every 30 min. EFF-04.
- post-class-feedback opens one `pg` transaction per session plus 8–15 uncached reads per session (≤ 50 sessions × 48
  runs/day); the per-session transaction is the fail-closed unit and must stay, but the pre-reads can be bulk-loaded.
- wise-activity ran a redundant existence `SELECT` before an `onConflictDoNothing().returning()` that already reports the
  insert count (Tier 1 removes it).

### 3.4 Observability overhead

`cron_invocations` is never pruned (≈ 15.6k rows/month) and stores the full response body as JSONB. The read side ranks
**every row ever written** with `row_number() over (partition by job_key …)` on every `/data-health` load, every
`/api/home/summary` call (i.e. every hard page load, uncached, fanning out to 8 loaders) and every watchdog sweep.
Tier 1 bounds the window to 45 days, prunes rows older than 90 days (keeping the newest 8 per job) and stores a
size-capped digest instead of the body.

### 3.5 Request-path Wise calls

The documented invariant "Wise is never queried on the request path" is violated twice: `POST /api/class-assignments/run`
paginates the institute FUTURE feed synchronously (`src/lib/classrooms/data.ts:889`), and the public `/schedule/[token]`
page fires ≈ 33 concurrent day-requests per uncached load when `ENABLE_STUDENT_SCHEDULE_LIVE` is on (default), memoised
only per serverless instance for 60 s. Neither is a cron cost, but both belong in any load conversation (EFF-S7/S9).

### 3.6 Same-minute collisions (fixed in Tier 1)

Six exact collisions existed: `admin-email` 00:00/00:10/00:20/00:30 with `sync-wise`/`sales`/`credit-control`;
`classroom-morning` 23:45 with `sync-leave-requests` (worst: morning automation can trigger a nested 3,400-call Wise sync
in the same minute); `competitor-intelligence` Sun 18:25 with `sync-progress-tests`. The calendar jobs moved to free
minutes (`41 23`, `4,14,24,36 0`, `28 18 * * 0`); a test now asserts no two crons share a UTC minute.

---

## 4. Ranked changes (EFF-00 … EFF-11)

Fail-closed risk means risk of ever showing a tutor as Available without proof, or of missing a blocking session.

| ID | Change | Impact | Effort | Fail-closed risk | Freshness / usability | Status |
|---|---|---|---|---|---|---|
| EFF-00 | Wise request counter on `WiseClient`, recorded into every `*_sync_runs.metadata.wiseCallCount` | Makes every number below measurable | S | none | none | **Tier 1** |
| EFF-08 | Registry `credit_control.maxDurationSeconds` 300 → 800 + test asserting registry vs each route's `maxDuration` | Stops 48 false `failing` classifications/day and watchdog churn | S | none | Data Health accuracy | **Tier 1** |
| — | `cron_invocations` 45-day window, 90-day retention, digest instead of body | Removes a growing full-table scan from every page load | S | none | faster `/data-health`, home badges | **Tier 1** |
| — | credit-control chunk 100 → 500, pair concurrency 8 → 15, bounded promotion `UPDATE` | Fewer round-trips; shorter 372–390 s runs | S | none | none | **Tier 1** |
| — | Collision-free calendar minutes + full schedule test | Removes 6 same-minute overlaps, incl. the 23:45 nested-sync hazard | S | none | admin summary final retry moves 07:30 → 07:36 | **Tier 1** |
| EFF-09 | Probe wide availability ranges (26 × 7-day vs 1 × 180-day vs 6 × 30-day) | **Closed — negative result.** Wise returns HTTP 400 for any span > 7 days ("should not be more then a week"); 0/5 teachers matched because the wide calls never succeed. No window-width optimisation exists. | S | — | — | **probe run 2026-09-02** (`scripts/probe-wise-availability-range.ts`) |
| **EFF-12** | **Tiered leave horizon**: windows 1–4 (next 28 days) fetched every run; windows 5–26 refreshed from `wise_teacher_availability_cache` when older than `WISE_FAR_HORIZON_MAX_AGE_MINUTES` (proposed 120), else fetched live; a cache miss is always a live fetch | 4,135 → ≈ 1,510 calls per 30-min run (**−≈ 125k/day, −63 %** of sync-wise traffic); with an hourly full lane (EFF-01/03) ≈ 36k/day (−82 %) | M (shares the EFF-01 cache table; horizon split is a constant in `fetchTeacherFullAvailability`) | Low: leaves only add unavailability; sessions and working hours are still fetched every run; exposure = a leave more than 28 days out entered < 2 h ago; the age is a product decision | none for the next 28 days; far-future leaves ≤ 2 h late | Tier 3 (first) |
| EFF-01/03 | Two-lane sync-wise: `sessions` lane (fresh teachers + FUTURE sessions ≈ 6 calls, availability/leaves/tags from a bounded-age cache ≤ 70 min, miss/stale → live fetch) + hourly `full` lane | Sessions lane is what webhooks trigger; full lane hourly halves the fan-out if EFF-09 fails | M | Low: cache is raw Wise JSON with explicit age; never defaulted open; stays inside the 90-min staleness contract (`src/lib/ops/stale.ts`) | sessions ≈ 7–10 min via webhooks; hours/leaves ≤ 60 min | Tier 3 |
| EFF-04 | Progress-tests: teacher identity from `credit_control_sessions` (already stored) instead of `fetchAllTeachers` + 185-day PAST sweep; run chained after each credit-control promotion + one daily safety run | −0.5–1k Wise calls/day, −47 invocations/day, removes a growing fetch | M | none — null teacher stays "Needs Review" | cycle state updates minutes after CC promotion | Tier 3 |
| EFF-05 | Credit-control dirty-pair narrowing with `credits_observed_at`; clean pairs reuse prior-snapshot credits < 3 h old; full refresh hourly | −60–80 % of the per-pair `sessionCredits` GETs | M/L | none in the availability domain; balances copied with explicit observed-at, never inferred | worst case 3 h for an unchanged pair (product decision) | Tier 3 |
| EFF-02 | Skip-if-unchanged via content hash of the normalized row set; unchanged run writes no rows, re-stamps `promotedSnapshotId`, skips `revalidateTag`, keeps the warm `SearchIndex` | Removes most Neon writes and index rebuilds on quiet half-hours | M (orchestrator restructure: app-generated group ids → 72 sequential inserts become 1) | low | faster first request after each sync | Tier 3 |
| EFF-06 | Fold the PCF backfill drain into the PCF cron (sequential, budgeted); backfill route becomes manual-only | −48 invocations/day | S | none | unchanged throughput | Tier 3 |
| EFF-07 | Hour-aware `intervalExpectation` in Data Health (`src/lib/data-health/status.ts:57-92`) | Enabler for overnight cadence cuts without watchdog false alarms | M | none | none | Tier 3 |
| EFF-10 | Credit-control snapshot retention mirroring `pruneOldSnapshots` (FK guard on `source_snapshot_id`) | Stops ≈ 33M rows/month of unbounded growth; shorter CC runs | M | verify FK consumers first | none | Tier 3 |
| EFF-11 | Watchdog `7,37` → hourly | −24 invocations/day | S | none | alert latency +30 min worst case | Tier 3 |

Not recommended: throttling `sync-wise-activity` (15-minute cadence is PCF deadline evidence), reducing PCF collection
(deadline semantics), widening the per-invocation Wise limiter past 15, batching PCF per-session transactions, loosening
`isBlockingStatus`, or removing the two-phase snapshot promote.

---

## 5. Wise webhooks — what actually exists

- **Subscription is UI-only**: Institute Settings → Developer options → Webhooks; pick events, give one POST URL. No API.
- **Auth**: Wise sends "an authorisation key in the header". The header **name is not documented** — it is revealed by
  test-firing after enabling. No HMAC signature.
- **Delivery**: success = HTTP 200 within **5 s**; otherwise failed. Failed deliveries retry **8 times** at 60, 180, 420,
  900, 1,860, 3,780, 7,620 and 15,300 s after the event (~4 h 15 min). **No event id, no delivery id, no ordering
  guarantee** documented. The IP-allowlist section is truncated upstream.
- **19 events**:
  - *Session scheduling*: `SessionsCreatedEvent` (`payload.sessions[]`: `_id`, `classId`, `userId`, `createdAt`,
    `meetingStatus`, `type`, `title`, `scheduledStartTime`, `scheduledEndTime`), `SessionsUpdatedEvent` (**sparse delta** —
    only changed fields, e.g. `_id`, `classId`, `createdAt`, `meetingStatus: CANCELLED`), `SessionsDeletedEvent`.
  - *In-meeting* (Zoom-shaped, `payload.payload.object` + `payload.sessionId` + `event_ts`): `MeetingStartedEvent`,
    `MeetingEndedEvent`, `ParticipantJoinedMeetingEvent`, `ParticipantLeftMeetingEvent`, `SharingStaredInMeetingEvent`
    [sic], `SharingEndedInMeetingEvent`, `RecordingCompletedEvent`, `AttendanceComputedEvent` (ids only).
  - *Classroom access*: `StudentAddedToClassroomEvent`, `TeacherAddedToClassroomEvent`,
    `StudentRemovedFromClassroomEvent`, `TeacherRemovedFromClassroomEvent`, `StudentSuspensionUpdatedEvent`.
  - *Fees*: `FeePaymentCompletedEvent`, `FeeInvoiceChargedEvent` (all instalments re-emit when one is added).
  - *Certificate*: `CertificateIssuedEvent`.
- **No event for**: teacher working hours / availability, leaves, teacher tags (qualifications, tier, modality), session
  credits, teacher feedback submissions (`SessionFeedbackSubmittedEvent` exists only in the polled audit feed), tutor
  payout invoices, institute locations.
- **Names differ** from the polled `/institutes/{id}/events` feed the app already stores (`SessionsCreatedEvent` vs
  `SessionCreatedEvent`, `AttendanceComputedEvent` vs `AttendanceCalculatedEvent`), so a receiver writing into
  `wise_activity_events` needs a name map and a `source` column to avoid double counting.

Full catalogue with payload fields: [`docs/reference/wise-webhooks.md`](../reference/wise-webhooks.md).

---

## 6. Fit matrix — what each event can do for us

| Webhook event | Could trigger / narrow | What still needs polling or reconciliation |
|---|---|---|
| `SessionsCreated` / `SessionsDeleted` | a `sessions`-lane sync-wise run; credit-control FUTURE window; classroom runs; student-schedule | payload lacks `location`, `students[]`, `duration`, `recurrenceId` → cannot populate `future_session_blocks`; must trigger a fetch |
| `SessionsUpdated` | cancellation / title change detection; augments the PAST-01 diff hook | sparse payload; absence of `meetingStatus` carries no information; unknown status stays **blocking** (`normalization/sessions.ts:44-50`) |
| `AttendanceComputed` / `MeetingEnded` | PCF candidate discovery (detail fetch on demand); credit-control refresh for that class | attendance values, credits and **feedback content still require `GET /user/classes/{cid}/sessions/{sid}`**; onsite sessions emit no meeting events |
| `FeePaymentCompleted` / `FeeInvoiceCharged` | package-sales reconciliation (`fetchWiseReceiptTransactions`, `fetchWiseFeesPaidTrends` — today fetched **on every page load** of `/api/wise-activity/reconciliation` and the home badge) | refunds / `DISBURSAL` / `PENDING_CONFIRMATION → CHARGED` have no event; whether these fire for credit *packages* is unknown |
| `StudentAdded/RemovedFromClassroom`, `StudentSuspensionUpdated` | credit-control pair discovery and churn signals | no credit balance in the payload; `sessionCredits` per pair is unavoidable |
| `TeacherAdded/RemovedFromClassroom` | partial signal for the teacher roster | no tags → qualifications/tier/modality still need `/teachers`; no event for tag edits |
| Meeting start, participant, sharing, recording, certificate | new capability (real attendance duration), not a replacement | — |
| **nothing** | — | working hours, leaves, tags, session credits, feedback submissions, payout invoices, locations — the heaviest polling stays |

---

## 7. Proposed architecture (Tier 2)

```
Wise ──POST──▶ /api/wise/webhook[/<path-token>]       public (middleware allowlist; MAINT-06 exempt); own auth
                 WH-01 auth → body ≤ 1 MiB → JSON → envelope zod
                 INSERT wise_webhook_events ON CONFLICT (dedupe_key) DO NOTHING            (WH-04)
                 200 {ok, duplicate?} in < 1 s                                             (WH-03)
                 after(): classify → UPSERT sync_triggers (debounce, dirty keys)           (DISP-01)

Vercel cron 4,9,…,59 * * * * ──▶ /api/internal/sync-dispatcher (CRON_SECRET, audited)
                 claim due triggers atomically (DISP-02) → run ≤ 2 heavy jobs by priority within 600 s (DISP-03)
                 via the EXISTING run functions and their single-flight guards (DISP-04); chain CC → PT (DISP-05)
```

Decision IDs (new; load-bearing once implemented):

- **WH-01 Fail-closed auth.** `WISE_WEBHOOK_SECRET` compared with `timingSafeEqual` after a length pre-check (same shape as
  `src/lib/internal/cron-auth.ts`), header name from `WISE_WEBHOOK_AUTH_HEADER` (default `authorization`; bare or
  `Bearer`). Secret unset → 401 for everything. Optional `WISE_WEBHOOK_PATH_TOKEN` makes the bare path 404.
- **WH-02 Kill switches.** `WISE_WEBHOOKS_ENABLED` must be exactly `"true"` (else 503 — Wise's retries make a short
  outage lossless); `WISE_WEBHOOKS_DISPATCH_ENABLED` gates trigger marking; `SYNC_DISPATCHER_ENABLED` gates the dispatcher.
- **WH-03 Ack budget.** Only auth, size check, `JSON.parse`, envelope `safeParse` and one INSERT before the response;
  everything else in `after()` with lazy `import()` — the pattern `src/app/api/line/webhook/route.ts` already uses.
- **WH-04 Idempotency without an event id.** `dedupe_key = sha256(event + canonicalJson(payload))`; retries carry an
  identical body → duplicate → 200 `{duplicate: true}`, no triggers. Switch to a delivery id if Phase 0 reveals one.
- **WH-05 Store what authenticates.** Valid JSON with an unknown envelope is stored `quarantined` and acked 200 so Phase 0
  can learn real shapes; non-JSON → 400.
- **WH-06 Triggers only.** No webhook payload is ever written into a snapshot table or read by search/compare. Every
  trigger terminates in `runWiseSyncRequest`, `runCreditControlSyncRequest`, `runPostClassFeedbackSync`,
  `runProgressTestSyncRequest` or `syncWiseActivityEvents`, each behind its existing guard.
- **WH-07 Redaction.** Persist only an allowlist of headers; never the auth value.
- **WH-08 / MAINT-06.** Register the route in `isPublicRoute` (`src/middleware.ts`) and in
  `MAINTENANCE_EXEMPT_PREFIXES` (`src/lib/maintenance.ts`) — webhooks are data-plane like `/api/internal/`.
- **WH-09 Replay.** Admin-only `POST /api/wise/webhooks/replay` re-classifies stored rows; never re-inserts.
- **WH-10 (deferred).** A cross-snapshot, blocking-only `wise_session_overlay` for sub-5-minute blocking; an overlay row
  may add or move a block, never remove one. Needs explicit approval.
- **DISP-01…05.** One `sync_triggers` row per subsystem (`pending`, first/last requested, coalesced count, capped
  dirty-key array with an overflow flag meaning "full refresh"); atomic claim via a single `UPDATE … RETURNING`; at most
  two heavy jobs per tick in priority order within a 600 s budget; a `202 skipped` from a guard re-arms the trigger;
  credit-control success arms progress-tests, a full sync-wise success clears older `wise_sessions` requests.

**Why not apply session deltas to the active snapshot?** It would break snapshot immutability and the single atomic
promote (REL-01, `src/lib/sync/orchestrator.ts:480-501`) that the in-memory `SearchIndex` relies on for stale detection,
poison the PAST-01 diff hook (`src/lib/sync/past-sessions-diff-hook.ts`) that compares prior-active blocks with Wise, and —
because Wise guarantees no ordering — a reversed `UPDATED(CANCELLED)` / `UPDATED(UPCOMING)` pair could mark a tutor
Available without proof. The safe alternative is a webhook-triggered **sessions lane** that builds a *real* snapshot
through the same normalizers (EFF-01).

**Dispatcher options considered.** (a) Run the sync inside the webhook's `after()`: zero extra invocations but couples
the 5-second ack path to 6.5-minute credit-control runs and relies on unverified self-invocation semantics on Vercel.
(b) A 5-minute dispatcher cron: simple, audited per tick, idle tick ≈ one `SELECT`, guards already exist. (c) Hybrid.
**Recommendation: (b)**, with (a) revisited for the sessions lane only if measured latency is insufficient.

Event → trigger map: session events → `wise_sessions` (P1), `credit_control` (P2), `post_class_feedback` (P3, ended or
cancelled only); `AttendanceComputed` → PCF + CC; `MeetingEnded` → PCF; fee events → CC + wise-activity; classroom
membership / suspension → CC; everything else stored `ignored`. Debounce (quiet / min-interval / max-wait): sessions
120 / 300 / 600 s; CC and PCF 600 / 900 / 1,800 s; activity 300 / 600 / 1,800 s; progress-tests chained only.

New tables (one migration): `wise_webhook_events` (unique `dedupe_key`, jsonb payload, status, entity refs, replay
counters), `sync_triggers`, `wise_teacher_availability_cache` (EFF-01), plus `content_hash` on the two snapshot tables
(EFF-02) and `credits_observed_at` on `credit_control_packages` (EFF-05). New env: `WISE_WEBHOOKS_ENABLED`,
`WISE_WEBHOOK_SECRET`, `WISE_WEBHOOK_AUTH_HEADER`, `WISE_WEBHOOK_PATH_TOKEN`, `WISE_WEBHOOK_ALLOWED_IPS`,
`WISE_WEBHOOKS_DISPATCH_ENABLED`, `SYNC_DISPATCHER_ENABLED`, `WISE_AVAILABILITY_MAX_AGE_MINUTES`,
`WISE_AVAILABILITY_WINDOW_DAYS`, `SYNC_SKIP_UNCHANGED`.

---

## 8. Rollout

| Phase | What ships | What changes for users | Gate to next |
|---|---|---|---|
| **0 — shadow** | receiver + `wise_webhook_events` + Data Health card; configure all 19 events in Wise; test-fire to learn the header name | nothing (store only) | measured "% of session changes seen by webhook first" and median lead time from `entity_refs` vs snapshot deltas; `userId` semantics and fee-event coverage confirmed |
| **1 — trigger-only** | `sync_triggers`, dispatcher cron (`4,9,…,59`), `sessions` lane + availability cache, EFF-00/EFF-08/EFF-09 param; existing crons unchanged as the safety net | sessions refresh ≈ 7–10 min after a Wise change | ≥ 2 weeks with coverage ≥ 95 % and dispatcher `late/failing` = 0 |
| **2 — cadence reduction** | `sync-wise` → hourly full lane + `sync-wise-sessions` at :30; `sync-credit-control` → hourly; `sync-progress-tests` → daily + chained; backfill cron removed (EFF-06); optional watchdog hourly | none visible; freshness SLAs in §9 hold | — |
| **3 — separate approval** | WH-10 overlay; EFF-07 overnight cadences | — | — |

Every schedule change moves `vercel.json`, `src/lib/data-health/cron-registry.ts` (`schedule`, `cadenceMinutes`,
`lateAfterMinutes`, `expectedBangkokMinute`), `src/__tests__/vercel-crons.test.ts`, `cron-registry.test.ts` and
`docs/reference/crons.md` together, or the watchdog pages.

Kill-switch matrix: `WISE_WEBHOOKS_ENABLED=false` → Wise gets 503 and retries; `WISE_WEBHOOKS_DISPATCH_ENABLED=false` →
store only; `SYNC_DISPATCHER_ENABLED=false` → tick audits `skipped`; restoring the old `vercel.json` lines restores the old
cadences with no code change; `SYNC_SKIP_UNCHANGED=false` forces snapshot writes; `WISE_AVAILABILITY_MAX_AGE_MINUTES=0`
forces live availability in every lane.

---

## 9. Two paths, with numbers

| | Today | Path (i): invocation-minimising, no webhooks | Path (ii): webhook dispatcher (5-min / 10-min tick) |
|---|---|---|---|
| Cron invocations/day | 512 | **≈ 353** (EFF-06 −48, EFF-04 −47, EFF-11 −24, EFF-07 overnight hourly −≈ 40) | ≈ 681 / ≈ 537 (−24 sync-wise, −24 CC, −47 PT, −48 backfill, +24 sessions lane, +288 / +144 dispatcher) |
| Wise calls/day | ≈ 240k | ≈ 115k with EFF-12 (tiered horizon at 30-min cadence); ≈ 240k without | ≈ 75k with EFF-12 + hourly full lane (EFF-01/03) + EFF-05; ≈ 140k with the hourly full lane alone |
| Heavy function-minutes/day | ≈ 750 | ≈ 500 | ≈ 400 |
| Session freshness (tutor search / compare) | ≤ 45 min | ≤ 45 min | ≈ 7–10 min typical, ≤ 30 min worst |
| Working hours / near-term leaves (≤ 28 days) | ≤ 45 min | ≤ 45 min | ≤ 60 min |
| Far-future leaves (> 28 days) | ≤ 45 min | ≤ 2 h 15 min (EFF-12) | ≤ 2 h 15 min (EFF-12) |
| Credit control | ≤ 45 min | ≤ 45 min (hourly overnight) | ≤ 15 min after an event, ≤ 60 min otherwise |
| Post-class feedback, wise-activity | unchanged | unchanged | unchanged |
| New moving parts | none | none | receiver, inbox, dispatcher, cache |

Both paths keep every page's data within the existing 90-minute staleness contract and change nothing in the
fail-closed normalization. EFF-12 is the right first step regardless (it is where most of the Wise traffic is);
path (i) then minimises invocations, and path (ii) is worth it if session freshness for admin staff matters more than
raw invocation count.

**Probe evidence (EFF-09, 2026-09-02, 5 of 159 teachers, 141 GETs):** `0/5 match on 1x180, 0/5 match on 6x30` — every
wide window failed with HTTP 400; the 141-call tally (1 + 5 × (26 + 1 + 1)) also validated the new `wiseCallCount`
counter. Sample output is kept with the session scratchpad; re-run with
`npx tsx --tsconfig scripts/tsconfig.json scripts/probe-wise-availability-range.ts --limit 5`.

---

## 10. Do not do

- Widen `WiseClient.maxConcurrency` past 15 or remove `mapLimit` throttles — the limiter is per invocation; with up to four
  Wise-facing crons in flight the institute-wide ceiling is already ≈ 60.
- Batch the PCF `saveObservation` across sessions into one transaction — the per-session transaction is the atomicity
  boundary for participant delete + re-insert and the source-status demotion/restore contract.
- Remove the two-phase snapshot promote or the bounded `UPDATE`.
- Loosen `isBlockingStatus` (unknown status blocks) or the `unresolvedRatio < 0.5` promotion gate.
- Throttle `sync-wise-activity` around Bangkok midnight.
- Write any webhook payload into snapshot-scoped tables.

---

## 11. Open questions

For Wise (only a test delivery or Wise support can answer):

1. Exact auth header name and value format (bare key or `Bearer`)?
2. Do `FeePaymentCompletedEvent` / `FeeInvoiceChargedEvent` fire for credit-package purchases and per-session credit
   consumption, or only for invoices?
3. In session events, is `payload.sessions[].userId` the teacher (as in the sessions feed), and are `students[]` ever
   included?
4. Is there any delivery id, attempt counter or timestamp header?
5. Source IP range (the docs section is truncated)?
6. One URL per institute, or several URLs / event subsets (would allow a staging endpoint)?
7. ~~Does `/institutes/{id}/teachers/{userId}/availability` accept spans longer than 7 days?~~ **Answered 2026-09-02: no.**
   Wise returns HTTP 400 *"Difference between end date and start date should not be more then a week"* for 30- and
   180-day spans. Follow-up for Wise: is there any bulk or institute-wide leave endpoint we are missing?

For the product owner:

8. Acceptable maximum age for reused credit balances (EFF-05, proposed 3 h), for cached availability in the sessions
   lane (EFF-01, proposed 70 min), and for far-future leaves beyond 28 days (EFF-12, proposed 2 h)?
9. Should maintenance mode exempt Wise webhooks (MAINT-06, proposed) or block them like LINE?
10. `student-promotions/july-1` now returns 409 on every future firing — retire the cron, or parameterise the target date?

---

## 12. Sources

All counts above were re-derived from code on 2026-09-02: `vercel.json`, `src/lib/data-health/cron-registry.ts`,
`src/lib/sync/orchestrator.ts`, `src/lib/wise/fetchers.ts`, `src/lib/wise/client.ts`, `src/lib/credit-control/{sync,wise}.ts`,
`src/lib/progress-tests/sync.ts`, `src/lib/post-class-feedback/sync.ts`, `src/lib/wise-activity/sync.ts`,
`src/lib/data-health/{dashboard,status,cron-audit}.ts`, `src/lib/internal/cron-watchdog.ts`, `src/lib/db/schema.ts`, and
the Wise webhook documentation pages listed at the top. Wise call volumes are derived, not measured; EFF-00 (Tier 1)
adds the measurement so the next revision of this document can replace every "≈".

_Verified against origin/main fed828d on 2026-09-02._
