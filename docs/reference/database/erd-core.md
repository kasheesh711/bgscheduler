# Database Reference — Core (Snapshots, Sync, Tutors, Normalization)

> Mechanical reference for the **31 core tables** that hold the snapshot/sync spine, the Wise activity audit, auth, student promotion, the normalized tutor model, and the Progress Tests subsystem. Column-level detail for the whole schema lives in [docs/reference/database/index.md](./index.md); this page covers grain, keys, and relationships for the core domain only.
>
> All definitions are in [`src/lib/db/schema.ts`](../../../src/lib/db/schema.ts) (Drizzle ORM). Line numbers below are HEAD-relative and may drift; the variable name is the stable handle.

## Scope

This document covers exactly these tables (Drizzle export → SQL table → `schema.ts` line range):

| # | Drizzle export | SQL table | Lines |
|---|---|---|---|
| 1 | `snapshots` | `snapshots` | 198–203 |
| 2 | `syncRuns` | `sync_runs` | 204–220 |
| 3 | `cronInvocations` | `cron_invocations` | 221–244 |
| 4 | `wiseActivityEvents` | `wise_activity_events` | 245–279 |
| 5 | `wiseActivitySyncRuns` | `wise_activity_sync_runs` | 280–301 |
| 6 | `adminUsers` | `admin_users` | 302–313 |
| 7 | `googleOAuthTokens` | `google_oauth_tokens` | 314–327 |
| 8 | `studentPromotionRuns` | `student_promotion_runs` | 669–701 |
| 9 | `studentPromotionGradeActions` | `student_promotion_grade_actions` | 702–725 |
| 10 | `studentPromotionCourseActions` | `student_promotion_course_actions` | 726–750 |
| 11 | `tutorIdentityGroups` | `tutor_identity_groups` | 751–761 |
| 12 | `tutorIdentityGroupMembers` | `tutor_identity_group_members` | 762–774 |
| 13 | `tutorAliases` | `tutor_aliases` | 775–783 |
| 14 | `tutors` | `tutors` | 784–796 |
| 15 | `rawTeacherTags` | `raw_teacher_tags` | 797–807 |
| 16 | `subjectLevelQualifications` | `subject_level_qualifications` | 808–823 |
| 17 | `recurringAvailabilityWindows` | `recurring_availability_windows` | 824–837 |
| 18 | `datedLeaves` | `dated_leaves` | 838–849 |
| 19 | `futureSessionBlocks` | `future_session_blocks` | 850–880 |
| 20 | `roomUtilizationSessions` | `room_utilization_sessions` | 971–994 |
| 21 | `pastSessionBlocks` | `past_session_blocks` | 1487–1531 |
| 22 | `dataIssues` | `data_issues` | 1895–1912 |
| 23 | `snapshotStats` | `snapshot_stats` | 1913–1935 |
| 24 | `progressTestAttendanceLedger` | `progress_test_attendance_ledger` | 2022–2047 |
| 25 | `progressTestCycleState` | `progress_test_cycle_state` | 2048–2083 |
| 26 | `progressTestBookings` | `progress_test_bookings` | 2084–2106 |
| 27 | `progressTestEmailRuns` | `progress_test_email_runs` | 2107–2127 |
| 28 | `progressTestNotifications` | `progress_test_notifications` | 2128–2146 |
| 29 | `progressTestAdminDigestRuns` | `progress_test_admin_digest_runs` | 2147–2168 |
| 30 | `progressTestAdminDigestRecipients` | `progress_test_admin_digest_recipients` | 2169–2184 |
| 31 | `progressTestSyncRuns` | `progress_test_sync_runs` | 2185–2205 |

## ER Diagram

The diagram shows each entity with its primary key, foreign keys, and one or two identifying columns only. The `snapshots` table is the spine: most tutor/normalization tables carry a `snapshot_id` FK to it. `tutorIdentityGroups` is the per-snapshot identity hub that the tutor satellite tables hang off. Cross-snapshot tables (`pastSessionBlocks`, `progressTest*`, `roomUtilizationSessions`, `tutorAliases`, `adminUsers`, `googleOAuthTokens`, `wiseActivity*`, `cronInvocations`) are not snapshot-scoped and join to the snapshot model only by soft reference (text keys / nullable, non-FK `snapshot_id`). `creditControlSnapshots` appears as a stub node only because `studentPromotionRuns.sourceSnapshotId` references it; its columns are documented with the Credit Control domain.

```mermaid
erDiagram
  snapshots {
    uuid id PK
    boolean active
  }
  syncRuns {
    uuid id PK
    uuid snapshotId FK
    uuid promotedSnapshotId FK
    enum status
  }
  cronInvocations {
    uuid id PK
    text jobKey
    text outcome
  }
  wiseActivityEvents {
    uuid id PK
    text eventId UK
    timestamptz eventTimestamp
  }
  wiseActivitySyncRuns {
    uuid id PK
    enum status
    text triggerType
  }
  adminUsers {
    uuid id PK
    text email UK
    json allowedPages
  }
  googleOAuthTokens {
    text email PK
    text scope
  }
  studentPromotionRuns {
    uuid id PK
    uuid sourceSnapshotId FK
    date targetDate
    enum status
  }
  studentPromotionGradeActions {
    uuid id PK
    uuid runId FK
    text wiseStudentId
  }
  studentPromotionCourseActions {
    uuid id PK
    uuid runId FK
    text wiseClassId
  }
  creditControlSnapshots {
    uuid id PK
  }
  tutorIdentityGroups {
    uuid id PK
    uuid snapshotId FK
    text canonicalKey
    text displayName
  }
  tutorIdentityGroupMembers {
    uuid id PK
    uuid groupId FK
    uuid snapshotId FK
    text wiseTeacherId
  }
  tutorAliases {
    uuid id PK
    text fromKey UK
    text toKey
  }
  tutors {
    uuid id PK
    uuid snapshotId FK
    uuid groupId FK
    text displayName
  }
  rawTeacherTags {
    uuid id PK
    uuid snapshotId FK
    uuid groupId FK
    text tagValue
  }
  subjectLevelQualifications {
    uuid id PK
    uuid snapshotId FK
    uuid groupId FK
    text subject
  }
  recurringAvailabilityWindows {
    uuid id PK
    uuid snapshotId FK
    uuid groupId FK
    int weekday
  }
  datedLeaves {
    uuid id PK
    uuid snapshotId FK
    uuid groupId FK
    timestamptz startTime
  }
  futureSessionBlocks {
    uuid id PK
    uuid snapshotId FK
    uuid groupId FK
    text wiseSessionId
  }
  roomUtilizationSessions {
    uuid id PK
    text wiseSessionId UK
    date utilizationDate
  }
  pastSessionBlocks {
    uuid id PK
    text groupCanonicalKey
    text wiseSessionId UK
  }
  dataIssues {
    uuid id PK
    uuid snapshotId FK
    enum type
  }
  snapshotStats {
    uuid id PK
    uuid snapshotId FK_UK
  }
  progressTestAttendanceLedger {
    uuid id PK
    text enrollmentKey
    text wiseSessionId
  }
  progressTestCycleState {
    text enrollmentKey PK
    text studentKey
    enum status
  }
  progressTestBookings {
    uuid id PK
    text enrollmentKey
    enum status
  }
  progressTestEmailRuns {
    uuid id PK
    text enrollmentKey
    text idempotencyKey UK
  }
  progressTestNotifications {
    uuid id PK
    uuid emailRunId FK
    text idempotencyKey UK
  }
  progressTestAdminDigestRuns {
    uuid id PK
    date digestDate UK
    text idempotencyKey UK
  }
  progressTestAdminDigestRecipients {
    uuid id PK
    uuid digestRunId FK
    text recipientEmail
  }
  progressTestSyncRuns {
    uuid id PK
    enum status
    text triggerType
  }

  snapshots ||--o{ syncRuns : "snapshotId / promotedSnapshotId"
  snapshots ||--o{ tutorIdentityGroups : snapshotId
  snapshots ||--o{ tutorIdentityGroupMembers : snapshotId
  snapshots ||--o{ tutors : snapshotId
  snapshots ||--o{ rawTeacherTags : snapshotId
  snapshots ||--o{ subjectLevelQualifications : snapshotId
  snapshots ||--o{ recurringAvailabilityWindows : snapshotId
  snapshots ||--o{ datedLeaves : snapshotId
  snapshots ||--o{ futureSessionBlocks : snapshotId
  snapshots ||--o{ dataIssues : snapshotId
  snapshots ||--|| snapshotStats : snapshotId

  tutorIdentityGroups ||--o{ tutorIdentityGroupMembers : groupId
  tutorIdentityGroups ||--o{ tutors : groupId
  tutorIdentityGroups ||--o{ rawTeacherTags : groupId
  tutorIdentityGroups ||--o{ subjectLevelQualifications : groupId
  tutorIdentityGroups ||--o{ recurringAvailabilityWindows : groupId
  tutorIdentityGroups ||--o{ datedLeaves : groupId
  tutorIdentityGroups ||--o{ futureSessionBlocks : groupId

  creditControlSnapshots ||--o{ studentPromotionRuns : sourceSnapshotId
  studentPromotionRuns ||--o{ studentPromotionGradeActions : runId
  studentPromotionRuns ||--o{ studentPromotionCourseActions : runId

  progressTestEmailRuns ||--o{ progressTestNotifications : emailRunId
  progressTestAdminDigestRuns ||--o{ progressTestAdminDigestRecipients : digestRunId
```

## Tables

### Snapshot & sync spine

#### `snapshots` (lines 198–203)
One row per immutable point-in-time capture of all normalized Wise tutor data. Columns: `id` (PK, random uuid), `active` (boolean, default false), `createdAt`. Exactly one row is `active = true` at a time — promotion is a single atomic `UPDATE` that flips a freshly-written candidate to active (`schema.ts:200`). Almost every tutor/normalization table in this domain carries a `snapshot_id` FK back to here.

#### `syncRuns` (lines 204–220)
One row per Wise snapshot-sync attempt. `status` is the `syncStatusEnum` (default `running`); `snapshotId` is the candidate snapshot being written and `promotedSnapshotId` is the snapshot that was promoted on success — both FK to `snapshots` (`schema.ts:209–210`). `teacherCount`, `errorSummary`, and free-form `metadata` (jsonb) record the outcome. A partial unique index `sync_runs_single_running_idx` enforces at most one `running` row at a time (the single-flight guard, `schema.ts:215–217`), backed by a `(status, startedAt)` index.

#### `cronInvocations` (lines 221–244)
One row per cron/internal job invocation across all subsystems (not just Wise sync). Keyed by `jobKey` + `path`; records `schedule`, `triggerSource` (default `cron`), `actorEmail`, `requestMethod`, timing (`receivedAt`/`finishedAt`/`durationMs`), `responseStatus`, `outcome` (default `running`), `errorSummary`, plus `linkedRunIds` and `metadata` jsonb (both non-null, default `{}`). Three indexes cover lookups by job, outcome, and trigger source, each paired with `receivedAt` (`schema.ts:238–240`). No FK to `snapshots`.

### Wise Activity Audit

#### `wiseActivityEvents` (lines 245–279)
One row per normalized Wise activity event, deduped by the source `eventId` (unique index `wise_activity_events_event_id_idx`, `schema.ts:270`). Denormalizes actor (`actorWiseUserId`/`actorName`/`actorRole`), classroom (`classroomId`/`classroomName`/`classroomSubject`), session (`sessionId` + start/end times), and transaction (`transactionId`/`transactionType`/`transactionStatus`/`transactionAmount`/`transactionCurrency`) attributes for filtering, with the full `payload` and `raw` jsonb retained. `eventType` defaults to `unknown`. Snapshot-independent (survives snapshot rotation); seven secondary indexes support timestamp, type, name, actor, classroom, session, and transaction queries.

#### `wiseActivitySyncRuns` (lines 280–301)
One row per Wise-activity audit sync run. `status` (`syncStatusEnum`, default `running`) + `triggerType`; counters `pagesFetched`/`eventsFetched`/`insertedCount` (all default 0); `oldestEventTimestamp`/`newestEventTimestamp` bound the fetched window; `errorSummary` + `metadata` jsonb. Has its own single-running partial unique index (`schema.ts:294–296`) — the same single-flight discipline as `syncRuns` but on a separate lineage.

### Auth

#### `adminUsers` (lines 302–313)
One row per allowlisted admin, unique on `email` (`admin_users_email_idx`, `schema.ts:311`). `name` is optional. `allowedPages` is a nullable jsonb `string[] | null`: **null means full access** (the default for existing admins), while a non-null array restricts the user to those route prefixes — page-level access control for restricted users (`schema.ts:306–308`). Snapshot-independent.

#### `googleOAuthTokens` (lines 314–327)
One row per Google account that has connected OAuth, keyed by `email` (text PK, `schema.ts:315`). Stores encrypted `accessTokenCiphertext`/`refreshTokenCiphertext`, `expiresAt`, granted `scope`, `tokenType`, and `lastError`. Used by cron/read/writeback flows that need Google Sheets access (e.g. leave-request import). Snapshot-independent.

### Student promotion

#### `studentPromotionRuns` (lines 669–701)
One row per student grade-promotion run for a `targetDate`. `status` is `studentPromotionRunStatusEnum` (default `draft`). `sourceSnapshotId` FK references `creditControlSnapshots` (`schema.ts:673`) — the credit-control snapshot the run reads from, **not** the Wise tutor snapshot. Carries counts of the work (Wise-accepted vs website-snapshot student counts, grade-only / year-8 / year-11 course-move counts, skipped/pending counts), a two-phase audit trail (`verifiedAt`/`verifiedBy*`/`endpointVerificationNote`, then `applyStartedAt`/`applyFinishedAt`/`appliedBy*`), `createdBy*`, `errorSummary`, and `metadata`. Indexed by `(targetDate, status)`, `createdAt`, and `verifiedAt`.

#### `studentPromotionGradeActions` (lines 702–725)
One row per per-student grade action within a promotion run. `runId` FK → `studentPromotionRuns` (`schema.ts:704`); identified by `wiseStudentId` (unique per run via `sp_grade_actions_run_student_idx`, `schema.ts:721`). Records `studentName`/`studentKey`, `currentGradeRaw`, `parsedCurrentYear`, `targetGrade`, `actionType`, `status` (`studentPromotionActionStatusEnum`, default `pending`), optional `skipReason`, Wise `requestPayload`/`responsePayload` jsonb, `errorMessage`, and `appliedAt`. Indexed by `(runId, status)` and `wiseStudentId`.

#### `studentPromotionCourseActions` (lines 726–750)
One row per per-class course-transition action within a promotion run. `runId` FK → `studentPromotionRuns` (`schema.ts:728`); identified by `wiseClassId` (unique per run via `sp_course_actions_run_class_idx`, `schema.ts:744`). Captures `currentSubject`/`targetSubject`, `transitionType`, the affected `studentIds` and `qualifyingStudentIds` (jsonb `string[]`), `status` (same action-status enum), `skipReason`, Wise request/response payloads, `errorMessage`, and `appliedAt`. Indexed by `(runId, status)` and `wiseClassId`.

### Tutor identity

#### `tutorIdentityGroups` (lines 751–761)
One row per resolved tutor identity within a snapshot — the hub the normalized tutor model hangs off. `snapshotId` FK → `snapshots` (`schema.ts:753`). `canonicalKey` is the stable cross-snapshot identity anchor; `displayName` is the resolved name; `supportedModality` is `modalityEnum` (default `unresolved`, fail-closed). Indexed by `snapshotId`.

#### `tutorIdentityGroupMembers` (lines 762–774)
One row per underlying Wise teacher record merged into an identity group (the output of the 5-step identity cascade). `groupId` FK → `tutorIdentityGroups` and `snapshotId` FK → `snapshots` (`schema.ts:764–765`). Holds `wiseTeacherId`, optional `wiseUserId`, `wiseDisplayName`, and `isOnlineVariant` (the online/offline pair flag, default false). Indexed by `snapshotId` and `groupId`.

#### `tutorAliases` (lines 775–783)
One row per manual identity-alias mapping (`fromKey` → `toKey`), used during identity resolution to fold one canonical key into another. Unique on `fromKey` (`tutor_aliases_from_idx`, `schema.ts:781`). **Snapshot-independent** — survives snapshot rotation, so alias decisions persist across syncs.

#### `tutors` (lines 784–796)
One row per tutor presentation record within a snapshot. `snapshotId` FK → `snapshots` and `groupId` FK → `tutorIdentityGroups` (`schema.ts:786–787`). `displayName` plus `supportedModes` (jsonb `string[]`, default `[]`). A thin denormalized projection over the identity group; indexed by `snapshotId`.

### Tags & qualifications

#### `rawTeacherTags` (lines 797–807)
One row per raw Wise teacher tag captured before qualification parsing. `snapshotId` + `groupId` FKs (`schema.ts:799–800`); `wiseTeacherId`, the `tagValue` string, and the original `tagRaw` jsonb. The audit input to the qualification parser. Indexed by `snapshotId`.

#### `subjectLevelQualifications` (lines 808–823)
One row per parsed subject/curriculum/level qualification for an identity group. `snapshotId` + `groupId` FKs (`schema.ts:810–811`). `subject`, `curriculum`, `level` (all required), optional `examPrep`, and the `sourceTag` it was derived from. Tags that fail to parse become `dataIssues` rather than rows here (fail-closed). Indexed by `snapshotId` and `groupId`.

### Availability

#### `recurringAvailabilityWindows` (lines 824–837)
One row per recurring weekly availability window for an identity group. `snapshotId` + `groupId` FKs (`schema.ts:826–827`). `weekday` is 0=Sunday..6=Saturday; `startMinute`/`endMinute` are minutes since midnight **Asia/Bangkok** (`schema.ts:829–831`). `modality` is `modalityEnum` (default `unresolved`). Indexed by `snapshotId` and by `(snapshotId, weekday)` for the search grid.

#### `datedLeaves` (lines 838–849)
One row per concrete dated leave interval for an identity group. `snapshotId` + `groupId` FKs (`schema.ts:840–841`); `wiseTeacherId`; `startTime`/`endTime` as timezone-aware timestamps. Leaves block availability in both recurring and one-time search modes. Indexed by `snapshotId` and `groupId`.

#### `futureSessionBlocks` (lines 850–880)
One row per future (booked) Wise session that may block a tutor's availability, scoped to a snapshot. `snapshotId` + `groupId` FKs (`schema.ts:852–853`). Identity columns `wiseTeacherId`/`wiseTeacherUserId`/`wiseSessionId`/`wiseClassId`; time columns `startTime`/`endTime` plus derived `weekday`/`startMinute`/`endMinute`; `wiseStatus` with derived `isBlocking` (default true, fail-closed for unknown status); and descriptive `title`/`sessionType`/`location`/`studentName`/`studentCount`/`subject`/`classType`/`recurrenceId`. Indexed by `snapshotId`, `(snapshotId, weekday)`, and `groupId`.

### Room utilization (Core-grouped, Room Capacity-owned)

#### `roomUtilizationSessions` (lines 971–994)
One row per Wise session captured for room-utilization analysis, deduped by `wiseSessionId` (unique index `rus_wise_session_id_idx`, `schema.ts:988`). **Snapshot-independent** (its own sync lineage, no `snapshot_id`). Stores `startTime`/`endTime`, `utilizationDate`, derived `weekday`/`startMinute`/`endMinute`, `wiseStatus`, `sessionType`, `rawLocation` → `normalizedRoomLabel`, `studentCount`, and `syncedAt`/`updatedAt`. Indexed by `utilizationDate` and `(normalizedRoomLabel, utilizationDate)`. Grouped under Core in the schema file but functionally owned by Room Capacity — see [docs/features/room-capacity.md](../../features/room-capacity.md).

### Past sessions (cross-snapshot)

#### `pastSessionBlocks` (lines 1487–1531)
One row per Wise session ever observed, captured first-observation-wins and **never bound to a single snapshot** — the only cross-snapshot tutor-data table in this domain. Identity is anchored by `groupCanonicalKey` (text, resolved at read time against the active snapshot's `tutor_identity_groups.canonical_key`, design ID **D-04**, `schema.ts:1490–1492`). `capturedInSnapshotId` is a nullable, **non-FK** provenance column — snapshots may be pruned independently (`schema.ts:1494–1496`). Mirrors `futureSessionBlocks`' descriptive columns minus the snapshot-scoped `snapshotId`/`groupId`, plus a `capturedAt` audit timestamp. A unique index on `wiseSessionId` (`psb_wise_session_id_idx`) enforces exactly one row per Wise session for idempotency (**PAST-05 / D-03**, `schema.ts:1520–1521`); read-path index `(groupCanonicalKey, startTime)` serves `buildCompareTutor` (**D-06**), plus a `startTime` index for retention scans.

### Normalization issues & stats

#### `dataIssues` (lines 1895–1912)
One row per normalization problem detected during a sync, scoped to a snapshot. `snapshotId` FK → `snapshots` (`schema.ts:1897`). `type` is `dataIssueTypeEnum`; `severity` is `dataIssueSeverityEnum` (default `high`). Optional `entityType`/`entityId`/`entityName` point at the offending record; `message` is required; `metadata` is free-form jsonb. This is where the fail-closed pipeline routes unresolved identity/modality/qualification cases. Indexed by `snapshotId` and `(snapshotId, type)`.

#### `snapshotStats` (lines 1913–1935)
Exactly one row per snapshot (unique index `ss_snapshot_idx` on `snapshotId`, `schema.ts:1928`) — a 1:1 rollup of the data-health counters for that snapshot. `snapshotId` FK → `snapshots` (`schema.ts:1915`). Counts (all default 0): `totalWiseTeachers`, `totalIdentityGroups`, `resolvedGroups`, `unresolvedGroups`, `totalQualifications`, `totalAvailabilityWindows`, `totalLeaves`, `totalFutureSessions`, `totalDataIssues`, plus an `issuesByType` jsonb map. Backs the Data Health dashboard.

### Progress Tests

> The Progress Tests subsystem tracks each student's attendance toward an every-8-classes progress test, drives parent/teacher notifications, and records bookings. Tables key off a synthetic `enrollmentKey` (student × class) rather than the snapshot model, so they survive snapshot rotation. Feature meaning lives in [docs/features](../../features/) and the project memo `progress-tests-feature.md`; this page documents grain only.

#### `progressTestAttendanceLedger` (lines 2022–2047)
One row per attended Wise session per student (the raw attendance ledger), unique on `(wiseSessionId, wiseStudentId)` (`ptal_session_student_idx`, `schema.ts:2044`). Keyed for rollup by `enrollmentKey`; carries `wiseClassId`/`wiseStudentId`/`studentKey`/`studentName`/`subject`, `scheduledStartTime`, `creditApplied`, `meetingStatus`, tutor attribution (`wiseTeacherUserId`/`wiseTeacherId`/`tutorCanonicalKey`/`tutorDisplayName`), the `isProgressTest` and `countsTowardCycle` flags that drive cycle counting, and `firstObservedSnapshotId` (nullable, non-FK provenance). Indexed by `(enrollmentKey, scheduledStartTime)`.

#### `progressTestCycleState` (lines 2048–2083)
One row per enrollment (student × class), keyed directly by `enrollmentKey` as the text PK (`schema.ts:2049`) — the current cycle position derived from the ledger. Tracks `currentCount`, `currentCycleStart`, `cycleIndex`, and `status` (`progressTestStatusEnum`, default `accumulating`). Holds the booked-test snapshot (`bookedTestWiseSessionId`/`bookedTestDate`/`bookedTestBookingMode`/`scheduleMethod`/`bookedTestLocation`), the at-home option lifecycle (`atHomeSelectedAt` → `atHomeSubmittedAt`, `schema.ts:2066`), teacher-notification bookkeeping (`teacherNotifiedAt`/`teacherNotifiedForCycle`), most-frequent-tutor attribution, a `lastAiSummary` jsonb + timestamp, and `lastClassDate`. Indexed by `status`, `studentKey`, and `updatedAt`.

#### `progressTestBookings` (lines 2084–2106)
One row per progress-test booking attempt for an enrollment+cycle. `status` is `progressTestBookingStatusEnum` (default `recorded`); `dryRun` defaults true (writeback is dry-run by default). Captures `scheduledTestDate`, the Wise targets (`wiseClassId`/`wiseStudentId`/`wiseSessionId`/`wiseTeacherUserId`), `location`, Wise `requestPayload`/`responsePayload` jsonb, `errorMessage`, and `createdBy*`. Indexed by `(enrollmentKey, createdAt)` and `status`. No FK to cycle state — joined by `enrollmentKey`.

#### `progressTestEmailRuns` (lines 2107–2127)
One row per parent-facing email send for an enrollment+cycle, idempotent on `idempotencyKey` (unique index `pt_email_runs_idempotency_idx`, `schema.ts:2124`). `status` defaults `pending`; `subject`; `triggerKind` (default `approaching`); per-run counters `attemptedCount`/`successCount`/`failedCount`; `lastError`; and `sentAt`. Parent of `progressTestNotifications`. Indexed by `enrollmentKey`.

#### `progressTestNotifications` (lines 2128–2146)
One row per individual notification (e.g. a teacher heads-up email) dispatched, idempotent on `idempotencyKey` (`pt_notifications_idempotency_idx`, `schema.ts:2142`). `emailRunId` FK → `progressTestEmailRuns` with `onDelete: "set null"` (`schema.ts:2130`). Carries `enrollmentKey`/`cycleIndex`, `notificationType` (default `teacher_heads_up_email`), `recipientEmail`, `status` (default `pending`), `providerMessageId`, `error`, and `sentAt`. Indexed by `enrollmentKey` and `emailRunId`.

#### `progressTestAdminDigestRuns` (lines 2147–2168)
One row per admin daily-digest send, with two unique indexes: one on `idempotencyKey` and one on `digestDate` (at most one digest per day, `schema.ts:2165–2166`). `status` (default `pending`), `subject`, `triggerKind` (default `daily`), `createdBy`, summary counters (`approachingCount`/`dueCount`/`attemptedCount`/`successCount`/`failedCount`), `lastError`, and `sentAt`. Parent of `progressTestAdminDigestRecipients`.

#### `progressTestAdminDigestRecipients` (lines 2169–2184)
One row per recipient of a given admin digest run. `digestRunId` FK → `progressTestAdminDigestRuns` (`schema.ts:2171`). Carries `digestDate`, `recipientEmail`, `status` (default `pending`), `providerMessageId`, and `error`. Indexed by `digestRunId`, `digestDate`, and `recipientEmail`.

#### `progressTestSyncRuns` (lines 2185–2205)
One row per Progress Tests sync run. `status` (`syncStatusEnum`, default `running`), `triggerType` (default `manual`), `actorEmail`; counters `ledgerRowCount`/`enrollmentCount`/`approachingCount`/`dueCount`/`notificationCount`; `errorSummary` + `metadata` jsonb. Has its own single-running partial unique index (`pt_sync_runs_single_running_idx`, `schema.ts:2202–2204`) — the same single-flight discipline as the other sync lineages, on a separate table. Indexed by `status` and `startedAt`.

## Snapshot-scoping summary

- **Snapshot-scoped** (carry a `snapshot_id` FK to `snapshots`, pruned with their snapshot): `tutorIdentityGroups`, `tutorIdentityGroupMembers`, `tutors`, `rawTeacherTags`, `subjectLevelQualifications`, `recurringAvailabilityWindows`, `datedLeaves`, `futureSessionBlocks`, `dataIssues`, `snapshotStats`. (`syncRuns` references snapshots but is a run log, not snapshot-scoped data.)
- **Snapshot-independent** (survive snapshot rotation): `snapshots` itself, `cronInvocations`, `wiseActivityEvents`, `wiseActivitySyncRuns`, `adminUsers`, `googleOAuthTokens`, `tutorAliases`, `roomUtilizationSessions`, `pastSessionBlocks`, all `studentPromotion*`, and all `progressTest*`. These reference the snapshot model only softly: `studentPromotionRuns.sourceSnapshotId` FKs to `creditControlSnapshots` (not the Wise tutor snapshot), while `pastSessionBlocks.capturedInSnapshotId` and `progressTestAttendanceLedger.firstObservedSnapshotId` are nullable, non-FK provenance columns.

_Verified against HEAD `d4fe6d3` on 2026-06-05._
