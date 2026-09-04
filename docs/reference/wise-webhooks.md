# Wise Webhooks Reference

**Status: not implemented — this page documents an external contract the app does not consume.**

**BGScheduler has no Wise webhook receiver.** `grep -rn "wise/webhook" src/` returns nothing, and
the only webhook route in the repository belongs to LINE
([`src/app/api/line/webhook/route.ts`](../../src/app/api/line/webhook/route.ts)). Four independent
checks agree:

| Check | Result |
|---|---|
| `grep -rn "wise/webhook" src/` | no matches |
| `find src -type f -iname "*webhook*"` | `src/lib/line/webhook.ts`, its test, and `src/app/api/line/webhook/route.ts` — nothing Wise |
| `grep -rn "WISE_WEBHOOK" src/ vercel.json` | no matches; no such env var is declared in [`src/lib/env.ts`](../../src/lib/env.ts) |
| Middleware public allowlist ([`middleware.ts:10`-`26`](../../src/middleware.ts)) and `MAINTENANCE_EXEMPT_PREFIXES` ([`maintenance.ts:43`-`48`](../../src/lib/maintenance.ts)) | neither lists any Wise webhook path |

Every byte of Wise data in the system today arrives by **polling** — the 19 Vercel Cron entries in
[`crons.md`](./crons.md) calling the fetchers in [`wise-api.md`](./wise-api.md). Nothing below is
running code.

**Why the page exists.** The webhook contract is the input to a build decision, and the decision
needs the contract written down once, accurately, rather than re-fetched from GitBook each time.
The evaluation that consumes it is
[`docs/proposals/2026-09-02-cron-efficiency-and-wise-webhooks.md`](../proposals/2026-09-02-cron-efficiency-and-wise-webhooks.md);
that document cites this page as its event catalogue.

**Provenance.** Everything in [§2](#2-subscription), [§3](#3-auth-and-delivery-semantics) and
[§4](#4-event-catalogue-19-events) was read from Wise's own documentation at
<https://wise-app.gitbook.io/wise-app/wise-api-integration/webhooks-integration> and its
`webhook-retry-mechanism` / `webhook-event-samples/*` sub-pages on **2026-09-02**. Field lists are
transcriptions of the published samples, not inferences: a field absent from a sample is absent
here. [§5](#5-what-each-event-could-trigger-in-this-repo), [§6](#6-name-mismatch-against-the-polled-events-feed)
and [§7](#7-the-fail-closed-constraint) are derived from this repository and carry `file:line`
citations.

> **Two "Wise" products.** As in [`wise-api.md`](./wise-api.md), "Wise" here is the scheduling
> platform `api.wiseapp.live`. It is unrelated to the money-transfer company of the same name.

---

## 1. TL;DR

- **Subscription is UI-only.** Institute Settings → Developer options → Webhooks. No registration
  API, so subscriptions cannot be created, listed, or diffed from code or from a test.
- **Auth is a shared secret in an undocumented header.** Wise sends "an authorisation key in the
  header"; the header *name* is not published and is learned by test-firing after enabling. There
  is **no HMAC signature**, so a receiver cannot verify that a body was not tampered with — only
  that the caller knew the key.
- **Delivery is HTTP 200 within 5 seconds**, then 8 retries over ≈ 4 h 15 min.
- **19 events**, none of which carries an event id, a delivery id, or an ordering guarantee.
- **The heaviest polling has no event at all**: teacher working hours, leaves, tags, session
  credits, feedback submissions, payout invoices and locations are all invisible to webhooks.
- **Session payloads are too thin to write a snapshot row** and, under
  [§7](#7-the-fail-closed-constraint), must never be allowed to.

---

## 2. Subscription

Webhooks are configured entirely in the Wise UI: **Institute Settings → Developer options →
Webhooks**. An institute administrator selects which of the 19 events to emit and supplies **one
POST URL** to receive all of them.

Consequences worth stating, because they shape any receiver design:

- **There is no registration API.** The subscription cannot be created, read back, or asserted from
  code, so it can never be covered by a test the way [`vercel.json`](../../vercel.json) is by
  [`vercel-crons.test.ts`](../../src/__tests__/vercel-crons.test.ts). Whether webhooks are enabled
  in production is a runtime fact the repository cannot attest.
- **One URL for all events.** Routing by event type is the receiver's job; there is no per-event
  endpoint.
- **Enabling is the only way to learn the auth header name** — see below.

---

## 3. Auth and delivery semantics

### Authentication

Wise's documentation states that it sends "an authorisation key in the header". The header **name
is not documented**; per the same page it is revealed by **test-firing** the webhook after enabling
it. There is **no HMAC signature scheme** — nothing equivalent to the `x-line-signature` HMAC that
[`src/lib/line/webhook.ts`](../../src/lib/line/webhook.ts) verifies for the LINE receiver.

Practically: a receiver can authenticate the *caller* (constant-time comparison against a stored
secret, the shape used by [`src/lib/internal/cron-auth.ts`](../../src/lib/internal/cron-auth.ts))
but cannot authenticate the *body*. Any design must therefore treat the payload as an untrusted
hint that something changed, never as evidence of what it changed to.

The IP-allowlist section of the upstream page is **truncated at the source** — no address ranges
are published — so an IP allowlist cannot be built from the documentation as it stands.

### Delivery and retry

A delivery **succeeds** when the receiver answers **HTTP 200 within a 5-second timeout**. Anything
else — non-200, timeout, connection failure — is a failed delivery.

A failed delivery is retried **8 times**, at these offsets **from the event** (not from the
previous attempt):

| Attempt | Seconds after the event | Elapsed |
|---:|---:|---|
| retry 1 | 60 | 1 min |
| retry 2 | 180 | 3 min |
| retry 3 | 420 | 7 min |
| retry 4 | 900 | 15 min |
| retry 5 | 1,860 | 31 min |
| retry 6 | 3,780 | 1 h 03 min |
| retry 7 | 7,620 | 2 h 07 min |
| retry 8 | 15,300 | 4 h 15 min |

The gaps double each time (120 → 240 → 480 → 960 → 1,920 → 3,840 → 7,680 s), so the ladder is a
pure exponential backoff anchored on the event timestamp. A receiver that is down for under
~4 hours loses nothing, provided it answers 200 on some attempt.

**Not documented, and therefore unavailable:**

- **No event id and no delivery id.** Deduplication cannot key on an identifier Wise supplies. This
  is the sharpest contrast with the polled audit feed, whose events *do* carry an id that the app
  already uses as a uniqueness key — `wise_activity_events.event_id` has a unique index
  ([`schema.ts:520`, `:543`](../../src/lib/db/schema.ts)) populated from the feed's `eventId`
  ([`wise-activity/sync.ts:100`-`106`](../../src/lib/wise-activity/sync.ts)), which is what makes
  the `onConflictDoNothing` incremental crawl correct
  ([`sync.ts:225`-`228`](../../src/lib/wise-activity/sync.ts)). A webhook receiver would have to
  synthesise its own key from the body.
- **No ordering guarantee.** Two updates to the same session may arrive in either order, and a
  retry of an old delivery may arrive after a newer one. See
  [§7](#7-the-fail-closed-constraint) for why this is decisive.
- **No documented replay or backfill API** for deliveries missed beyond the retry ladder.

The 5-second budget is the same shape of constraint the LINE receiver already works under: it does
auth, parse and one write before responding, and defers everything expensive to `after()` with a
lazy `import()` ([`api/line/webhook/route.ts:8`-`46`](../../src/app/api/line/webhook/route.ts)).

---

## 4. Event catalogue (19 events)

Grouped as Wise's own sample pages group them. Field lists are exactly what the published samples
contain.

### 4.1 Session scheduling (3)

| Event | Payload shape |
|---|---|
| `SessionsCreatedEvent` | `payload.sessions[]`, each with `_id`, `classId`, `userId`, `createdAt`, `meetingStatus` (e.g. `UPCOMING`), `type` (`SCHEDULED`), `title`, `scheduledStartTime`, `scheduledEndTime` |
| `SessionsUpdatedEvent` | **Sparse delta — only the changed fields.** The cancellation sample carries just `_id`, `classId`, `createdAt`, `meetingStatus: CANCELLED`; the rename sample carries just `_id`, `classId`, `createdAt`, `title` |
| `SessionsDeletedEvent` | The full session object, with `meetingStatus: CANCELLED` and `title` suffixed `"(Cancelled)"` |

The sparseness of `SessionsUpdatedEvent` is the single most important property in this section: the
**absence** of `meetingStatus` from an update carries no information — it means "this field did not
change", not "the status is still what you think it is".

### 4.2 In-meeting (8)

These are Zoom-shaped. The object is nested at **`payload.payload.object`**, alongside
`payload.sessionId` and `payload.event_ts`.

| Event | Type string / payload |
|---|---|
| `MeetingStartedEvent` | `meeting.started`; `object` has `duration`, `start_time`, `timezone`, `topic`, `id`, `type`, `uuid`, `host_id` |
| `MeetingEndedEvent` | as above **plus** `end_time` |
| `ParticipantJoinedMeetingEvent` | `object.participant`: `user_id`, `user_name`, `participant_user_id`, `id`, `join_time`, `email`, `participant_uuid` |
| `ParticipantLeftMeetingEvent` | as above **plus** `leave_time`, `leave_reason`, `registrant_id` |
| `SharingStaredInMeetingEvent` | *(name spelled thus upstream — "Stared", not "Started")* `object.participant.sharing_details`: `link_source`, `date_time`, `file_link`, `source`, `content` |
| `SharingEndedInMeetingEvent` | same `sharing_details` shape |
| `RecordingCompletedEvent` | `payload`: `userId`, `sessionId`, `recordings[]` of `{ type, url, duration, partIndex }` |
| `AttendanceComputedEvent` | `payload.session` with **only** `_id`, `classId`, `userId` — ids, no attendance values |

`AttendanceComputedEvent` is a pointer, not a result: it says attendance for a session was computed
and gives no number.

### 4.3 User ↔ classroom access (5)

| Event | Payload |
|---|---|
| `StudentAddedToClassroomEvent` | `classroom { _id, name }`, `student { _id, name, email }` |
| `TeacherAddedToClassroomEvent` | `classroom { _id, name, subject, classNumber }`, `teacher { _id, name, email }` |
| `StudentRemovedFromClassroomEvent` | as *added*, plus `remove: true` |
| `TeacherRemovedFromClassroomEvent` | as *added*, plus `remove: true` |
| `StudentSuspensionUpdatedEvent` | `reason` (`FEE_DELAY` or `SUSPEND`), `suspended` (boolean), optional `overDue { value, currency }`, `classroom`, `student`, optional `teacher` |

`TeacherAddedToClassroomEvent` carries **no tags**, which is why it cannot substitute for the
teacher roster fetch — see [§5](#5-what-each-event-could-trigger-in-this-repo).

### 4.4 Fees (2)

| Event | Payload |
|---|---|
| `FeePaymentCompletedEvent` | `type: OFFLINE`, `classroom`, `student`, `transaction { _id, amount { value, currency } }` |
| `FeeInvoiceChargedEvent` | `classroom`, `student`, `transaction { status: CHARGED, type: INVOICE, senderId, receiverId, chargedAt, amount, note, metadata { classId, dueOn, dueAfterDays, paid, index, paymentOptionId, installmentId, feeType, feeAssignedManually } }` |

Wise's own note on `FeeInvoiceChargedEvent`: adding a single instalment **re-emits an event for
every instalment**, so this event is not one-per-change and a consumer must expect fan-out.

### 4.5 Certificate (1)

| Event | Payload |
|---|---|
| `CertificateIssuedEvent` | `classroom`, `student`, `certificate { _id, certificateNumber, url, issuedOn }` |

### 4.6 What has no event at all

Wise publishes **no webhook** for any of the following. This list is the reason webhooks cannot
replace the current crons:

| Domain with no event | What polls it today |
|---|---|
| Teacher **working hours / availability** | `fetchTeacherFullAvailability` inside `runFullSync` ([`orchestrator.ts:176`-`180`](../../src/lib/sync/orchestrator.ts)) |
| Teacher **leaves** | same call — 26 stitched seven-day windows ([`wise-api.md`](./wise-api.md)) |
| Teacher **tags** (qualifications, tier, modality) | `fetchAllTeachers` + `normalizeTeacherTags` ([`orchestrator.ts:84`, `:220`](../../src/lib/sync/orchestrator.ts)) |
| **Session credits** | one `sessionCredits` GET per (class × student) pair ([`credit-control/wise.ts:263`-`270`](../../src/lib/credit-control/wise.ts)) |
| **Teacher feedback submissions** | the polled audit feed's `SessionFeedbackSubmittedEvent` ([`post-class-feedback/repository.ts:931`](../../src/lib/post-class-feedback/repository.ts)) |
| **Tutor payout invoices** | the polled feed's `TutorPayoutInvoiceCreatedEvent` ([`payroll/sync.ts:20`](../../src/lib/payroll/sync.ts), [`payroll/domain.ts:168`](../../src/lib/payroll/domain.ts)) |
| **Institute locations** | `fetchInstituteLocations` ([`wise-api.md`](./wise-api.md)) |

---

## 5. What each event could trigger in this repo

The three polling paths this table maps onto:

| Path | Entry point | What it fetches from Wise |
|---|---|---|
| **Tutor snapshot ETL** | `runFullSync` ([`orchestrator.ts:50`](../../src/lib/sync/orchestrator.ts)), wrapped by `runWiseSyncRequest` ([`run-wise-sync.ts:142`](../../src/lib/sync/run-wise-sync.ts)) | teachers, per-teacher availability + leaves, all FUTURE sessions ([`orchestrator.ts:84`, `:176`, `:263`](../../src/lib/sync/orchestrator.ts)) |
| **Credit control** | `runCreditControlSync` ([`credit-control/sync.ts:641`](../../src/lib/credit-control/sync.ts)), wrapped by `runCreditControlSyncRequest` ([`run-sync-request.ts:138`](../../src/lib/credit-control/run-sync-request.ts)) | students, PAST 120 d and FUTURE 180 d sessions ([`sync.ts:61`-`63`, `:658`-`663`](../../src/lib/credit-control/sync.ts)), then one `sessionCredits` GET per pair ([`sync.ts:666`](../../src/lib/credit-control/sync.ts)) and one detail GET per uncredited ended session ([`credit-control/wise.ts:276`-`282`](../../src/lib/credit-control/wise.ts)) |
| **Post-class feedback** | `syncPostClassFeedback` ([`post-class-feedback/sync.ts:566`](../../src/lib/post-class-feedback/sync.ts)), wrapped by `runPostClassFeedbackSync` ([`sync.ts:1050`](../../src/lib/post-class-feedback/sync.ts)) | a rolling 4-day PAST window by Bangkok date ([`fetchers.ts:153`](../../src/lib/wise/fetchers.ts), window at [`sync.ts:139`-`145`](../../src/lib/post-class-feedback/sync.ts)) plus a capped set of session details ([`fetchers.ts:189`-`200`](../../src/lib/wise/fetchers.ts)) |

Mapping each event onto them:

| Webhook event | Polling path it could trigger or narrow | What still needs periodic reconciliation |
|---|---|---|
| `SessionsCreatedEvent`, `SessionsDeletedEvent` | Tutor snapshot ETL (a real run, not a patch); credit-control FUTURE window; student schedule | The payload has no `location`, no `studentCount`, no `metadata.recurrenceId` — all three are columns `normalizeSessions` writes into `future_session_blocks` ([`normalization/sessions.ts:25`, `:27`, `:30`, `:84`-`89`](../../src/lib/normalization/sessions.ts); insert at [`orchestrator.ts:282`-`304`](../../src/lib/sync/orchestrator.ts)). The event can only say *fetch now*. |
| `SessionsUpdatedEvent` | Cancellation and title-change detection; a hint for the PAST-01 diff hook ([`past-sessions-diff-hook.ts`](../../src/lib/sync/past-sessions-diff-hook.ts)) | Sparse delta: a missing `meetingStatus` is not "unchanged status", and an unknown status stays **blocking** by `isBlockingStatus` ([`normalization/sessions.ts:46`-`51`](../../src/lib/normalization/sessions.ts)). Full session state still comes from the FUTURE feed. |
| `AttendanceComputedEvent`, `MeetingEndedEvent` | Post-class-feedback candidate discovery; a credit-control refresh scoped to that class | The event carries only ids ([§4.2](#42-in-meeting-8)). Attendance values, credits and **feedback content** still require `GET /user/classes/{classId}/sessions/{sessionId}` ([`fetchers.ts:189`](../../src/lib/wise/fetchers.ts), [`credit-control/wise.ts:276`](../../src/lib/credit-control/wise.ts)). Onsite sessions emit no meeting events at all, so this lane is online-only. |
| `MeetingStartedEvent`, `ParticipantJoined/LeftMeetingEvent`, `SharingStared/EndedInMeetingEvent`, `RecordingCompletedEvent` | Nothing today — these are a **new capability** (real attendance duration, screen-share evidence, recording links), not a replacement for a fetch | n/a — no current code consumes them |
| `FeePaymentCompletedEvent`, `FeeInvoiceChargedEvent` | Wise-activity package-sales reconciliation ([`wise-activity/reconciliation.ts`](../../src/lib/wise-activity/reconciliation.ts)) | No event for refunds, disbursals, or a `PENDING → CHARGED` transition; instalment fan-out ([§4.4](#44-fees-2)) means the count of events is not the count of changes. Whether these fire for credit **packages** is unverified. |
| `StudentAdded/RemovedFromClassroomEvent`, `StudentSuspensionUpdatedEvent` | Credit-control pair discovery and churn signals | No credit balance in any payload — the per-pair `sessionCredits` GET ([`credit-control/wise.ts:263`](../../src/lib/credit-control/wise.ts)) is unavoidable |
| `TeacherAdded/RemovedFromClassroomEvent` | A partial roster signal for the tutor snapshot | Carries **no tags**, so qualifications, tier and modality still need `fetchAllTeachers` ([`orchestrator.ts:84`](../../src/lib/sync/orchestrator.ts)); and no event exists for a tag *edit* |
| `CertificateIssuedEvent` | Nothing today | n/a |
| **— (no event exists)** | — | Working hours, leaves, tags, session credits, feedback submissions, payout invoices, locations — i.e. the majority of Wise traffic — must keep polling on a schedule ([§4.6](#46-what-has-no-event-at-all)) |

**Net reading.** Webhooks could reduce *latency* on session changes and could *narrow* which class
or pair a job re-reads. They cannot reduce the set of things that must be polled, because the four
heaviest fetches — availability windows, teacher tags, per-pair credits, feedback submissions —
have no event behind them.

---

## 6. Name mismatch against the polled `/events` feed

The app already persists Wise events, but from a **different source with different names**: the
polled audit feed `GET /institutes/{instituteId}/events`
([`fetchers.ts:498`-`517`](../../src/lib/wise/fetchers.ts)), crawled every 15 minutes by
`syncWiseActivityEvents` ([`wise-activity/sync.ts:152`](../../src/lib/wise-activity/sync.ts)) into
`wise_activity_events` ([`schema.ts:518`](../../src/lib/db/schema.ts)). The event names that feed
emits are enumerated in
[`wise-activity/format.ts:3`-`32`](../../src/lib/wise-activity/format.ts).

They are **not the webhook names**:

| Concept | Webhook name (this page) | Polled feed name ([`format.ts`](../../src/lib/wise-activity/format.ts)) |
|---|---|---|
| Session created | `SessionsCreatedEvent` | `SessionCreatedEvent` (`format.ts:21`) — singular |
| Session updated | `SessionsUpdatedEvent` | `SessionUpdatedEvent` (`format.ts:24`) — singular |
| Session deleted | `SessionsDeletedEvent` | `SessionDeletedEvent` (`format.ts:22`) — singular |
| Attendance | `AttendanceComputedEvent` | `AttendanceCalculatedEvent` (`format.ts:13`) — *Computed* vs *Calculated* |
| Invoice charged | `FeeInvoiceChargedEvent` | `InvoiceChargedEvent` (`format.ts:15`) |
| Offline payment | `FeePaymentCompletedEvent` | `OfflinePaymentChargedEvent` (`format.ts:17`) |
| Student suspension | `StudentSuspensionUpdatedEvent` (one event, `suspended` boolean) | `StudentSuspendedEvent` / `StudentUnsuspendedEvent` (`format.ts:25`-`26`) — two events |

Two names exist **only in the polled feed and have no webhook counterpart**, and both are
load-bearing:

- **`SessionFeedbackSubmittedEvent`** is the highest-priority candidate lane in Post-Class
  Feedback: the sync reads unlinked rows of exactly this name to decide which sessions to fetch
  details for ([`repository.ts:931`-`953`](../../src/lib/post-class-feedback/repository.ts)), and
  `reason: "feedback_event"` sorts ahead of recheck and rolling-window candidates
  ([`sync.ts:205`-`208`](../../src/lib/post-class-feedback/sync.ts)). No webhook can supply it.
- **`TutorPayoutInvoiceCreatedEvent`** is how Payroll finds payout invoices
  ([`payroll/sync.ts:20`](../../src/lib/payroll/sync.ts),
  [`payroll/domain.ts:168`](../../src/lib/payroll/domain.ts)). No webhook can supply it either.

Also note `SESSION_MUTATION_EVENTS` ([`format.ts:3`-`8`](../../src/lib/wise-activity/format.ts))
contains a fourth name, `SessionCancelledEvent`, with no webhook equivalent at all — a webhook
expresses cancellation as `SessionsUpdatedEvent` with `meetingStatus: CANCELLED`.

**Consequence for any future receiver.** Writing webhook deliveries into `wise_activity_events`
would double-count against the polled crawl unless the receiver carries (a) a name map webhook →
feed and (b) a `source` discriminator column. And because webhooks have no event id
([§3](#3-auth-and-delivery-semantics)) while the table's uniqueness key *is* `event_id`
([`schema.ts:543`](../../src/lib/db/schema.ts)), the receiver would additionally have to synthesise
a stable key of its own; the `onConflictDoNothing` that makes the polled crawl idempotent
([`wise-activity/sync.ts:227`](../../src/lib/wise-activity/sync.ts)) has nothing to bite on
otherwise.

---

## 7. The fail-closed constraint

**A webhook must never free a slot.** This is not a preference; it follows from how availability is
stored and served.

Availability is answered from **snapshot-scoped tables that are rewritten wholesale per run and
promoted atomically**. `runFullSync` writes every row of a candidate snapshot, then flips it live in
one statement whose bounded `WHERE` touches only the previous active row and the candidate
([`orchestrator.ts:481`-`500`](../../src/lib/sync/orchestrator.ts) — decision REL-01; credit control
mirrors it at [`credit-control/sync.ts:709`-`719`](../../src/lib/credit-control/sync.ts)). The
in-memory `SearchIndex` is keyed to that snapshot id and rebuilds when it changes
([`search/index.ts:354`-`384`](../../src/lib/search/index.ts)).

Applying a webhook delta to the active snapshot breaks that in three distinct ways:

1. **It breaks snapshot immutability.** A snapshot is a point-in-time set of rows produced by one
   normalized run. An out-of-band `UPDATE` makes the active snapshot no longer correspond to any
   run, so staleness detection and the "which sync produced this?" audit trail both stop meaning
   anything.
2. **It poisons the PAST-01 diff hook.** `runPastSessionsDiffHook`
   ([`past-sessions-diff-hook.ts`](../../src/lib/sync/past-sessions-diff-hook.ts), invoked from
   [`orchestrator.ts`](../../src/lib/sync/orchestrator.ts)) compares prior-active blocks against
   what Wise now returns. Rows mutated by a webhook were never fetched from Wise, so the comparison
   is against a fiction.
3. **No ordering guarantee makes un-cancellation possible.** Wise documents no ordering
   ([§3](#3-auth-and-delivery-semantics)). A retried `SessionsUpdatedEvent(CANCELLED)` arriving
   *after* a later `SessionsUpdatedEvent(UPCOMING)` would leave a live session marked cancelled —
   or, in the reverse direction, mark a tutor **Available** for an hour they are actually teaching.
   That violates the non-negotiable rule that the system never returns a tutor as available without
   proof from normalized Wise data, and it does so silently.

The sparse-payload property compounds all three: an update that omits `meetingStatus` means "this
field did not change", and code that reads the omission as "not cancelled" would be guessing.
`isBlockingStatus` deliberately treats an unknown or missing status as **blocking**
([`normalization/sessions.ts:46`-`51`](../../src/lib/normalization/sessions.ts)); a webhook path
that inverted that default would invert the safety property of the whole search engine.

**The safe shape, therefore, is trigger-only.** A webhook may *schedule* a real sync — one that
fetches from Wise, runs the same normalizers, builds a new snapshot and promotes it atomically —
and may narrow *what* that sync re-reads. It may never write a snapshot row, and no webhook payload
may be read by the search or compare engines. Freshness improves; the proof obligation does not
move. The proposal's WH-06 states the same rule as a decision id, and its §7 works through the
dispatcher design that satisfies it:
[`docs/proposals/2026-09-02-cron-efficiency-and-wise-webhooks.md`](../proposals/2026-09-02-cron-efficiency-and-wise-webhooks.md).

---

## 8. Open items

- **The auth header name is unknown** and unknowable without enabling webhooks in the production
  Wise institute and test-firing. Any receiver must make the header name configurable rather than
  hard-coded.
- **The IP-allowlist section is truncated upstream**, so no network-level restriction can be
  specified from the documentation.
- **Whether fee events fire for credit *packages*** (as opposed to classroom fees) is not stated in
  the samples and would have to be measured.
- **`userId` semantics** in `SessionsCreatedEvent` (teacher? creator? both?) are not defined by the
  sample, which matters because the ETL resolves sessions to teachers through the Wise *user* id
  ([`orchestrator.ts:264`-`275`](../../src/lib/sync/orchestrator.ts)).
- **No documented replay API** for deliveries lost beyond the 4 h 15 min retry ladder, so a
  reconciling poll remains mandatory regardless of webhook coverage.

## See also

- [`docs/proposals/2026-09-02-cron-efficiency-and-wise-webhooks.md`](../proposals/2026-09-02-cron-efficiency-and-wise-webhooks.md)
  — the evaluation that cites this page: cost baseline, fit matrix, proposed receiver/dispatcher
  architecture, and rollout gates.
- [`docs/reference/wise-api.md`](./wise-api.md) — the polling contract that exists today: transport
  client, every fetcher, the writeback allowlist, and the `WISE_*` environment variables.
- [`docs/reference/crons.md`](./crons.md) — the 19 scheduled jobs that do the polling.
- [`docs/features/wise-activity-audit.md`](../features/wise-activity-audit.md) — how the *polled*
  event feed is stored and read.
- [`docs/features/post-class-feedback.md`](../features/post-class-feedback.md) — the subsystem most
  dependent on `SessionFeedbackSubmittedEvent`, which has no webhook.

_Verified against main@0cd1e81 (clean tree) on 2026-09-02._
