# Database Enums Reference

**61 native Postgres enum types**, every one declared as a Drizzle `pgEnum` in the `// ── Enums ──` block at the top of `src/lib/db/schema.ts` (lines 19–452). Each declaration produces a `CREATE TYPE … AS ENUM` type whose SQL name is the first `pgEnum()` argument; the exported TypeScript constant (the `varName`) is what column definitions call. Between them they type **102 columns** across the schema.

This page is the canonical home for the mechanical detail of every enum — allowed values, declaration site, and the table/column bindings with their defaults and nullability. Meaning, workflow rules, and the "why" behind a state machine belong in the owning feature doc under [`docs/features/`](../../features/); this page does not restate them.

## How to read the entries

- **Definition** cites the `export const …Enum = pgEnum(` line in `src/lib/db/schema.ts`.
- **Values** are listed in declaration order. Postgres enum ordering is significant for `ORDER BY` and comparison operators, so the order below is the SQL sort order.
- **Used by** lists only schema-level bindings — a column whose Drizzle type is the `pgEnum` constant. Each entry gives `table.column`, the cited `schema.ts` line, the column default (or "no default"), and `nullable` where `.notNull()` is absent. Values that appear only in application code, JSONB payloads, or `CHECK`-constrained `text` columns are not enum members; the enum-shaped `text` columns are collected in the [appendix](#appendix-enum-shaped-text-columns).
- Adding a value to any of these enums requires a migration (`ALTER TYPE … ADD VALUE`), not just a schema edit — see [`index.md`](index.md).

## Index

| # | SQL type | Drizzle constant | Values | Definition | Bindings |
|---|---|---|---|---|---|
| 1 | `sync_status` | `syncStatusEnum` | 3 | `schema.ts:21` | 15 |
| 2 | `data_issue_type` | `dataIssueTypeEnum` | 6 | `schema.ts:27` | 1 |
| 3 | `data_issue_severity` | `dataIssueSeverityEnum` | 4 | `schema.ts:36` | 1 |
| 4 | `modality` | `modalityEnum` | 4 | `schema.ts:43` | 2 |
| 5 | `classroom_room_category` | `classroomRoomCategoryEnum` | 3 | `schema.ts:50` | 1 |
| 6 | `classroom_assignment_run_status` | `classroomAssignmentRunStatusEnum` | 4 | `schema.ts:56` | 1 |
| 7 | `classroom_assignment_row_status` | `classroomAssignmentRowStatusEnum` | 4 | `schema.ts:63` | 1 |
| 8 | `classroom_publish_status` | `classroomPublishStatusEnum` | 4 | `schema.ts:70` | 1 |
| 9 | `classroom_publish_job_status` | `classroomPublishJobStatusEnum` | 5 | `schema.ts:77` | 1 |
| 10 | `proposal_scope` | `proposalScopeEnum` | 2 | `schema.ts:85` | 1 |
| 11 | `proposal_status` | `proposalStatusEnum` | 5 | `schema.ts:90` | 1 |
| 12 | `ai_scheduler_conversation_status` | `aiSchedulerConversationStatusEnum` | 2 | `schema.ts:98` | 1 |
| 13 | `ai_scheduler_message_role` | `aiSchedulerMessageRoleEnum` | 4 | `schema.ts:103` | 1 |
| 14 | `line_message_direction` | `lineMessageDirectionEnum` | 2 | `schema.ts:110` | 1 |
| 15 | `line_scheduler_classifier_category` | `lineSchedulerClassifierCategoryEnum` | 4 | `schema.ts:115` | 3 |
| 16 | `line_scheduler_review_status` | `lineSchedulerReviewStatusEnum` | 5 | `schema.ts:122` | 1 |
| 17 | `line_contact_student_link_status` | `lineContactStudentLinkStatusEnum` | 3 | `schema.ts:130` | 1 |
| 18 | `student_promotion_run_status` | `studentPromotionRunStatusEnum` | 6 | `schema.ts:136` | 1 |
| 19 | `student_promotion_action_status` | `studentPromotionActionStatusEnum` | 4 | `schema.ts:145` | 3 |
| 20 | `sales_dashboard_source_status` | `salesDashboardSourceStatusEnum` | 5 | `schema.ts:152` | 2 |
| 21 | `payroll_review_status` | `payrollReviewStatusEnum` | 2 | `schema.ts:160` | 1 |
| 22 | `leave_request_workflow_status` | `leaveRequestWorkflowStatusEnum` | 6 | `schema.ts:165` | 1 |
| 23 | `leave_request_sheet_write_status` | `leaveRequestSheetWriteStatusEnum` | 4 | `schema.ts:174` | 1 |
| 24 | `progress_test_status` | `progressTestStatusEnum` | 5 | `schema.ts:181` | 1 |
| 25 | `progress_test_booking_status` | `progressTestBookingStatusEnum` | 6 | `schema.ts:189` | 1 |
| 26 | `competitor_sync_trigger` | `competitorSyncTriggerEnum` | 3 | `schema.ts:198` | 1 |
| 27 | `competitor_entity_kind` | `competitorEntityKindEnum` | 2 | `schema.ts:204` | 1 |
| 28 | `competitor_source_type` | `competitorSourceTypeEnum` | 6 | `schema.ts:209` | 3 |
| 29 | `competitor_source_status` | `competitorSourceStatusEnum` | 4 | `schema.ts:218` | 2 |
| 30 | `competitor_task_status` | `competitorTaskStatusEnum` | 5 | `schema.ts:225` | 1 |
| 31 | `post_class_source_status` | `postClassSourceStatusEnum` | 4 | `schema.ts:233` | 3 |
| 32 | `post_class_content_status` | `postClassContentStatusEnum` | 3 | `schema.ts:240` | 2 |
| 33 | `post_class_timing_status` | `postClassTimingStatusEnum` | 4 | `schema.ts:246` | 2 |
| 34 | `post_class_deduction_status` | `postClassDeductionStatusEnum` | 6 | `schema.ts:253` | 5 |
| 35 | `post_class_enforcement_mode` | `postClassEnforcementModeEnum` | 3 | `schema.ts:262` | 4 |
| 36 | `post_class_capability` | `postClassCapabilityEnum` | 4 | `schema.ts:268` | 1 |
| 37 | `post_class_feedback_provenance` | `postClassFeedbackProvenanceEnum` | 3 | `schema.ts:275` | 1 |
| 38 | `post_class_notification_kind` | `postClassNotificationKindEnum` | 4 | `schema.ts:281` | 1 |
| 39 | `post_class_notification_status` | `postClassNotificationStatusEnum` | 5 | `schema.ts:288` | 3 |
| 40 | `post_class_ai_status` | `postClassAiStatusEnum` | 4 | `schema.ts:296` | 1 |
| 41 | `post_class_concern_decision` | `postClassConcernDecisionEnum` | 3 | `schema.ts:303` | 2 |
| 42 | `post_class_finance_period_status` | `postClassFinancePeriodStatusEnum` | 2 | `schema.ts:309` | 1 |
| 43 | `post_class_payout_run_status` | `postClassPayoutRunStatusEnum` | 5 | `schema.ts:314` | 1 |
| 44 | `post_class_payout_match_status` | `postClassPayoutMatchStatusEnum` | 5 | `schema.ts:322` | 1 |
| 45 | `post_class_payout_write_status` | `postClassPayoutWriteStatusEnum` | 4 | `schema.ts:330` | 1 |
| 46 | `admissions_case_status` | `admissionsCaseStatusEnum` | 5 | `schema.ts:337` | 1 |
| 47 | `admissions_member_role` | `admissionsMemberRoleEnum` | 3 | `schema.ts:345` | 1 |
| 48 | `admissions_member_status` | `admissionsMemberStatusEnum` | 4 | `schema.ts:351` | 1 |
| 49 | `admissions_task_status` | `admissionsTaskStatusEnum` | 3 | `schema.ts:358` | 2 |
| 50 | `admissions_task_owner` | `admissionsTaskOwnerEnum` | 3 | `schema.ts:364` | 3 |
| 51 | `admissions_app_round` | `admissionsAppRoundEnum` | 8 | `schema.ts:370` | 1 |
| 52 | `admissions_app_status` | `admissionsAppStatusEnum` | 4 | `schema.ts:381` | 1 |
| 53 | `admissions_decision_event` | `admissionsDecisionEventEnum` | 7 | `schema.ts:388` | 1 |
| 54 | `admissions_essay_status` | `admissionsEssayStatusEnum` | 5 | `schema.ts:398` | 2 |
| 55 | `admissions_test_type` | `admissionsTestTypeEnum` | 7 | `schema.ts:406` | 1 |
| 56 | `admissions_test_sitting_status` | `admissionsTestSittingStatusEnum` | 5 | `schema.ts:416` | 1 |
| 57 | `admissions_notification_outbox_status` | `admissionsNotificationOutboxStatusEnum` | 4 | `schema.ts:424` | 1 |
| 58 | `admissions_note_visibility` | `admissionsNoteVisibilityEnum` | 2 | `schema.ts:429` | 1 |
| 59 | `admissions_rec_status` | `admissionsRecStatusEnum` | 4 | `schema.ts:434` | 1 |
| 60 | `admissions_submission_state` | `admissionsSubmissionStateEnum` | 3 | `schema.ts:441` | 1 |
| 61 | `admissions_college_category` | `admissionsCollegeCategoryEnum` | 4 | `schema.ts:447` | 1 |

Only two enums have their members lifted back into TypeScript through `enumValues` — `progressTestBookingStatusEnum` (`src/lib/progress-tests/booking.ts:43-44`) and `modalityEnum` (`src/lib/sync/orchestrator.ts:308`). Everywhere else, feature code writes the string literals directly and relies on Drizzle's inferred column type.

---

## Core sync & normalization

### `sync_status`

- **Variable**: `syncStatusEnum`
- **Definition**: `src/lib/db/schema.ts:21`
- **Values**: `running`, `success`, `failed`
- **Used by** — 15 columns, every one `NOT NULL DEFAULT 'running'`:
  - `sync_runs.status` (`schema.ts:464`)
  - `wise_activity_sync_runs.status` (`schema.ts:555`)
  - `sales_dashboard_import_runs.status` (`schema.ts:653`)
  - `sales_dashboard_projection_import_runs.status` (`schema.ts:746`)
  - `competitor_sync_runs.status` (`schema.ts:846`)
  - `competitor_source_runs.status` (`schema.ts:878`)
  - `competitor_ai_runs.status` (`schema.ts:1000`)
  - `credit_control_sync_runs.status` (`schema.ts:1164`)
  - `payroll_sync_runs.status` (`schema.ts:1763`)
  - `leave_request_sync_runs.status` (`schema.ts:2095`)
  - `line_backlog_recovery_sync_runs.status` (`schema.ts:2665`)
  - `progress_test_sync_runs.status` (`schema.ts:2977`)
  - `ipeds_import_runs.status` (`schema.ts:3007`)
  - `post_class_sync_runs.status` (`schema.ts:3225`)
  - `admissions_notification_runs.status` (`schema.ts:4551`)

The most-reused enum in the schema — the shared vocabulary for every sync/import/notification run table across all subsystems. The `running` default is what the single-flight guards select on.

### `data_issue_type`

- **Variable**: `dataIssueTypeEnum`
- **Definition**: `src/lib/db/schema.ts:27`
- **Values**: `alias`, `modality`, `tag`, `completeness`, `conflict_model`, `sync`
- **Used by**:
  - `data_issues.type` — no default (`schema.ts:2688`)

### `data_issue_severity`

- **Variable**: `dataIssueSeverityEnum`
- **Definition**: `src/lib/db/schema.ts:36`
- **Values**: `critical`, `high`, `medium`, `low`
- **Used by**:
  - `data_issues.severity` — default `high` (`schema.ts:2689`)

### `modality`

- **Variable**: `modalityEnum`
- **Definition**: `src/lib/db/schema.ts:43`
- **Values**: `online`, `onsite`, `both`, `unresolved`
- **Used by**:
  - `tutor_identity_groups.supported_modality` — default `unresolved` (`schema.ts:1521`)
  - `recurring_availability_windows.modality` — default `unresolved` (`schema.ts:1597`)

Only these two columns are typed by the enum — session-level modality is not persisted as an enum column anywhere in the schema. The `unresolved` default is the storage half of the fail-closed rule; the derivation pass keys its per-teacher map on `typeof schema.modalityEnum.enumValues[number]` (`src/lib/sync/orchestrator.ts:308`).

---

## Classroom assignment

### `classroom_room_category`

- **Variable**: `classroomRoomCategoryEnum`
- **Definition**: `src/lib/db/schema.ts:50`
- **Values**: `standard`, `overflow_only`, `online_only`
- **Used by**:
  - `classroom_rooms.category` — default `standard` (`schema.ts:1651`)

### `classroom_assignment_run_status`

- **Variable**: `classroomAssignmentRunStatusEnum`
- **Definition**: `src/lib/db/schema.ts:56`
- **Values**: `completed`, `published`, `partial`, `failed`
- **Used by**:
  - `classroom_assignment_runs.status` — default `completed` (`schema.ts:1665`)

### `classroom_assignment_row_status`

- **Variable**: `classroomAssignmentRowStatusEnum`
- **Definition**: `src/lib/db/schema.ts:63`
- **Values**: `assigned`, `needs_review`, `no_room`, `remote`
- **Used by**:
  - `classroom_assignment_rows.status` — default `assigned` (`schema.ts:1715`)

### `classroom_publish_status`

- **Variable**: `classroomPublishStatusEnum`
- **Definition**: `src/lib/db/schema.ts:70`
- **Values**: `not_published`, `skipped`, `success`, `failed`
- **Used by**:
  - `classroom_assignment_rows.publish_status` — default `not_published` (`schema.ts:1721`)

Per-row outcome of the opt-in Wise `location` writeback.

### `classroom_publish_job_status`

- **Variable**: `classroomPublishJobStatusEnum`
- **Definition**: `src/lib/db/schema.ts:77`
- **Values**: `pending`, `running`, `succeeded`, `partial`, `failed`
- **Used by**:
  - `classroom_publish_jobs.status` — default `pending` (`schema.ts:1924`)

Distinct from `classroom_publish_status`: this is the job-level lifecycle (note `succeeded`, not `success`), while `classroom_publish_status` is the per-row result.

---

## Proposals (admin holds)

### `proposal_scope`

- **Variable**: `proposalScopeEnum`
- **Definition**: `src/lib/db/schema.ts:85`
- **Values**: `recurring`, `one_time`
- **Used by**:
  - `proposal_items.scope` — no default (`schema.ts:2318`)

Mirrors the search engine's recurring/one-time blocking modes.

### `proposal_status`

- **Variable**: `proposalStatusEnum`
- **Definition**: `src/lib/db/schema.ts:90`
- **Values**: `pending`, `confirmed`, `released`, `expired`, `auto_resolved`
- **Used by**:
  - `proposal_items.status` — default `pending` (`schema.ts:2326`)

---

## AI scheduler

### `ai_scheduler_conversation_status`

- **Variable**: `aiSchedulerConversationStatusEnum`
- **Definition**: `src/lib/db/schema.ts:98`
- **Values**: `active`, `archived`
- **Used by**:
  - `ai_scheduler_conversations.status` — default `active` (`schema.ts:2347`)

### `ai_scheduler_message_role`

- **Variable**: `aiSchedulerMessageRoleEnum`
- **Definition**: `src/lib/db/schema.ts:103`
- **Values**: `admin`, `parent`, `assistant`, `system`
- **Used by**:
  - `ai_scheduler_messages.role` — no default (`schema.ts:2370`)

Four roles rather than the usual three — `admin` and `parent` are separate speakers on the same transcript. `admin` is what the assistant route stamps on the operator's own turn (`src/app/api/search/assistant/route.ts:172`).

---

## LINE integration

### `line_message_direction`

- **Variable**: `lineMessageDirectionEnum`
- **Definition**: `src/lib/db/schema.ts:110`
- **Values**: `inbound`, `outbound`
- **Used by**:
  - `line_messages.direction` — no default (`schema.ts:2472`)

### `line_scheduler_classifier_category`

- **Variable**: `lineSchedulerClassifierCategoryEnum`
- **Definition**: `src/lib/db/schema.ts:115`
- **Values**: `scheduling_request`, `scheduling_change`, `non_scheduling`, `unclear`
- **Used by**:
  - `line_messages.classifier_category` — no default, nullable (`schema.ts:2483`)
  - `line_messages.classification_reviewed_category` — no default, nullable (`schema.ts:2488`)
  - `line_scheduler_reviews.classifier_category` — no default (`schema.ts:2557`)

The model-assigned value and the human-corrected value are separate columns of the same type on `line_messages`, so correction telemetry can diff them without losing the original.

### `line_scheduler_review_status`

- **Variable**: `lineSchedulerReviewStatusEnum`
- **Definition**: `src/lib/db/schema.ts:122`
- **Values**: `pending_review`, `approved_sent`, `accepted_no_send`, `rejected`, `dismissed`
- **Used by**:
  - `line_scheduler_reviews.status` — default `pending_review` (`schema.ts:2561`)

`approved_sent` and `accepted_no_send` are written by two different service paths (`src/lib/line/review-service.ts:494`, `:562`), so a draft judged good without the reply leaving the system stays distinguishable in the accept-rate readout (`src/lib/line/data.ts:1204-1205`).

### `line_contact_student_link_status`

- **Variable**: `lineContactStudentLinkStatusEnum`
- **Definition**: `src/lib/db/schema.ts:130`
- **Values**: `suggested`, `verified`, `rejected`
- **Used by**:
  - `line_contact_student_links.status` — default `suggested` (`schema.ts:2510`)

---

## Student promotions

### `student_promotion_run_status`

- **Variable**: `studentPromotionRunStatusEnum`
- **Definition**: `src/lib/db/schema.ts:136`
- **Values**: `draft`, `verified`, `applying`, `applied`, `applied_with_errors`, `failed`
- **Used by**:
  - `student_promotion_runs.status` — default `draft` (`schema.ts:1346`)

### `student_promotion_action_status`

- **Variable**: `studentPromotionActionStatusEnum`
- **Definition**: `src/lib/db/schema.ts:145`
- **Values**: `pending`, `skipped`, `applied`, `failed`
- **Used by** — all three default `pending`:
  - `student_promotion_grade_actions.status` (`schema.ts:1386`)
  - `student_promotion_course_actions.status` (`schema.ts:1409`)
  - `student_promotion_future_session_actions.status` (`schema.ts:1434`)

One shared per-action lifecycle across the three write lanes of a promotion run.

---

## Sales dashboard

### `sales_dashboard_source_status`

- **Variable**: `salesDashboardSourceStatusEnum`
- **Definition**: `src/lib/db/schema.ts:152`
- **Values**: `active`, `refreshing`, `finalized`, `reopened`, `archived`
- **Used by**:
  - `sales_dashboard_sources.status` — default `active` (`schema.ts:626`)
  - `sales_dashboard_sources.status_before_archive` — no default, nullable (`schema.ts:636`)

`status_before_archive` stores the same enum so an archived source can be restored to exactly the lifecycle state it left.

---

## Payroll

### `payroll_review_status`

- **Variable**: `payrollReviewStatusEnum`
- **Definition**: `src/lib/db/schema.ts:160`
- **Values**: `draft`, `approved`
- **Used by**:
  - `payroll_reviews.status` — default `draft` (`schema.ts:1783`)

---

## Leave requests

### `leave_request_workflow_status`

- **Variable**: `leaveRequestWorkflowStatusEnum`
- **Definition**: `src/lib/db/schema.ts:165`
- **Values**: `new`, `needs_review`, `in_progress`, `done`, `ignored`, `canceled_by_tutor`
- **Used by**:
  - `leave_requests.workflow_status` — default `new` (`schema.ts:2144`)

### `leave_request_sheet_write_status`

- **Variable**: `leaveRequestSheetWriteStatusEnum`
- **Definition**: `src/lib/db/schema.ts:174`
- **Values**: `not_required`, `pending`, `success`, `failed`
- **Used by**:
  - `leave_requests.sheet_write_status` — default `not_required` (`schema.ts:2147`)

Outcome of the Google Sheets status writeback for a triaged request; `not_required` is the default so a row that never needs a write is not indistinguishable from one that failed.

---

## Progress tests

### `progress_test_status`

- **Variable**: `progressTestStatusEnum`
- **Definition**: `src/lib/db/schema.ts:181`
- **Values**: `accumulating`, `approaching`, `due`, `scheduled`, `completed`
- **Used by**:
  - `progress_test_cycle_state.status` — default `accumulating` (`schema.ts:2848`)

### `progress_test_booking_status`

- **Variable**: `progressTestBookingStatusEnum`
- **Definition**: `src/lib/db/schema.ts:189`
- **Values**: `recorded`, `dry_run`, `wise_created`, `manual_required`, `manual_confirmed`, `failed`
- **Used by**:
  - `progress_test_bookings.status` — default `recorded` (`schema.ts:2878`)

Feature code derives its `ProgressTestBookingStatus` union straight from this enum's `enumValues` (`src/lib/progress-tests/booking.ts:43-44`), so a schema change propagates into the type checker.

---

## Competitor intelligence

### `competitor_sync_trigger`

- **Variable**: `competitorSyncTriggerEnum`
- **Definition**: `src/lib/db/schema.ts:198`
- **Values**: `cron`, `manual`, `backfill`
- **Used by**:
  - `competitor_sync_runs.trigger_type` — default `manual` (`schema.ts:847`)

### `competitor_entity_kind`

- **Variable**: `competitorEntityKindEnum`
- **Definition**: `src/lib/db/schema.ts:204`
- **Values**: `competitor`, `own_brand`
- **Used by**:
  - `competitor_entities.kind` — default `competitor` (`schema.ts:799`)

### `competitor_source_type`

- **Variable**: `competitorSourceTypeEnum`
- **Definition**: `src/lib/db/schema.ts:209`
- **Values**: `website`, `sitemap`, `instagram`, `facebook`, `serp`, `manual`
- **Used by** — none have a default:
  - `competitor_sources.source_type` (`schema.ts:819`)
  - `competitor_source_runs.source_type` (`schema.ts:877`)
  - `competitor_vendor_usage.source_type` (`schema.ts:1136`)

Carried onto the vendor-usage rows so external-API spend is attributable to the kind of source that incurred it.

### `competitor_source_status`

- **Variable**: `competitorSourceStatusEnum`
- **Definition**: `src/lib/db/schema.ts:218`
- **Values**: `active`, `disabled`, `needs_review`, `archived`
- **Used by** — both default `active`:
  - `competitor_sources.status` (`schema.ts:825`)
  - `competitor_serp_keywords.status` (`schema.ts:953`)

Reused for SERP keywords, which follow the same enable/disable/retire lifecycle as a crawl source.

### `competitor_task_status`

- **Variable**: `competitorTaskStatusEnum`
- **Definition**: `src/lib/db/schema.ts:225`
- **Values**: `todo`, `in_progress`, `blocked`, `done`, `ignored`
- **Used by**:
  - `competitor_tasks.status` — default `todo` (`schema.ts:1093`)

---

## Post-class feedback (compliance)

### `post_class_source_status`

- **Variable**: `postClassSourceStatusEnum`
- **Definition**: `src/lib/db/schema.ts:233`
- **Values**: `ready`, `unavailable`, `form_drift`, `identity_review`
- **Used by**:
  - `post_class_sessions.source_status` — default `unavailable` (`schema.ts:3267`)
  - `post_class_sessions.source_status_before` — no default, nullable (`schema.ts:3272`)
  - `post_class_assessments.source_status` — no default (`schema.ts:3376`)

`source_status_before` is written only by the run-wide fail-closed demotion (design ID `REC-01`) and holds the status the row carried before source health became unprovable, so a later healthy sync restores it in one statement; `NULL` means `source_status` is the row's own observation (`schema.ts:3268-3272`). Session deletion is deliberately *not* an enum member — it is the separate `wise_deleted_at` timestamp (`REC-03`, `schema.ts:3273-3279`), because every `source_status <> 'ready'` reader treats its subject as blocking and a deleted session would then sit in the payout coverage denominator forever.

### `post_class_content_status`

- **Variable**: `postClassContentStatusEnum`
- **Definition**: `src/lib/db/schema.ts:240`
- **Values**: `missing`, `blank`, `substantive`
- **Used by**:
  - `post_class_sessions.content_status` — default `missing` (`schema.ts:3280`)
  - `post_class_assessments.content_status` — no default (`schema.ts:3377`)

`blank` is separate from `missing`: the policy pass picks `blank` when teacher feedback versions exist but carry no non-empty fields, and `missing` when none exist at all (`src/lib/post-class-feedback/policy.ts:274`, `:497`).

### `post_class_timing_status`

- **Variable**: `postClassTimingStatusEnum`
- **Definition**: `src/lib/db/schema.ts:246`
- **Values**: `not_due`, `on_time`, `late`, `unknown`
- **Used by**:
  - `post_class_sessions.timing_status` — default `not_due` (`schema.ts:3281`)
  - `post_class_assessments.timing_status` — no default (`schema.ts:3378`)

### `post_class_deduction_status`

- **Variable**: `postClassDeductionStatusEnum`
- **Definition**: `src/lib/db/schema.ts:253`
- **Values**: `none`, `pending_review`, `approved`, `waived`, `processed`, `reversed`
- **Used by**:
  - `post_class_sessions.deduction_status` — default `none` (`schema.ts:3282`)
  - `post_class_assessments.deduction_status` — default `none` (`schema.ts:3379`)
  - `post_class_deductions.status` — default `pending_review` (`schema.ts:3570`)
  - `post_class_deduction_actions.from_status` — no default, nullable (`schema.ts:3595`)
  - `post_class_deduction_actions.to_status` — no default (`schema.ts:3596`)

The most widely bound post-class enum. `post_class_deduction_actions` records each transition as a typed `from_status` → `to_status` pair, with a `NULL` `from_status` marking the creating action.

### `post_class_enforcement_mode`

- **Variable**: `postClassEnforcementModeEnum`
- **Definition**: `src/lib/db/schema.ts:262`
- **Values**: `shadow`, `live`, `paused`
- **Used by**:
  - `post_class_enforcement_windows.mode` — no default (`schema.ts:3140`)
  - `post_class_settings.enforcement_mode` — default `shadow` (`schema.ts:3154`)
  - `post_class_sessions.enforcement_mode` — default `shadow` (`schema.ts:3285`)
  - `post_class_assessments.enforcement_mode` — no default (`schema.ts:3380`)

Stamped onto each session and each assessment, not just onto settings, so a historical row records the mode in force when it was evaluated. The `shadow` default means enforcement is off unless explicitly switched on.

### `post_class_capability`

- **Variable**: `postClassCapabilityEnum`
- **Definition**: `src/lib/db/schema.ts:268`
- **Values**: `viewer`, `reviewer`, `finance`, `access_manager`
- **Used by**:
  - `post_class_access_grants.capability` — no default (`schema.ts:3187`)

One row per granted capability rather than a single role column, so grants compose — the table is uniquely indexed on `(email, capability)` (`schema.ts:3192`).

### `post_class_feedback_provenance`

- **Variable**: `postClassFeedbackProvenanceEnum`
- **Definition**: `src/lib/db/schema.ts:275`
- **Values**: `manual`, `auto`, `unknown`
- **Used by**:
  - `post_class_feedback_versions.provenance` — default `unknown` (`schema.ts:3330`)

`unknown` is the default, not `manual` — provenance is asserted, never assumed.

### `post_class_notification_kind`

- **Variable**: `postClassNotificationKindEnum`
- **Definition**: `src/lib/db/schema.ts:281`
- **Values**: `tutor_day_after`, `tutor_deadline`, `admin_digest`, `test`
- **Used by**:
  - `post_class_notification_runs.kind` — no default (`schema.ts:3424`)

### `post_class_notification_status`

- **Variable**: `postClassNotificationStatusEnum`
- **Definition**: `src/lib/db/schema.ts:288`
- **Values**: `pending`, `sending`, `sent`, `failed`, `cancelled`
- **Used by**:
  - `post_class_notification_runs.status` — default `pending` (`schema.ts:3425`)
  - `post_class_notification_deliveries.status` — default `pending` (`schema.ts:3453`)
  - `post_class_notification_attempts.status` — no default (`schema.ts:3489`)

One vocabulary across all three levels of the notification hierarchy: run → delivery → attempt.

### `post_class_ai_status`

- **Variable**: `postClassAiStatusEnum`
- **Definition**: `src/lib/db/schema.ts:296`
- **Values**: `pending`, `running`, `succeeded`, `failed`
- **Used by**:
  - `post_class_ai_runs.status` — default `pending` (`schema.ts:3504`)

Deliberately separate from `sync_status` (`succeeded` vs `success`, plus a `pending` queue state).

### `post_class_concern_decision`

- **Variable**: `postClassConcernDecisionEnum`
- **Definition**: `src/lib/db/schema.ts:303`
- **Values**: `pending`, `confirmed`, `dismissed`
- **Used by**:
  - `post_class_ai_concerns.decision` — default `pending` (`schema.ts:3527`)
  - `post_class_ai_reviews.decision` — no default (`schema.ts:3539`)

### `post_class_finance_period_status`

- **Variable**: `postClassFinancePeriodStatusEnum`
- **Definition**: `src/lib/db/schema.ts:309`
- **Values**: `open`, `closed`
- **Used by**:
  - `post_class_finance_periods.status` — default `open` (`schema.ts:3552`)

---

## Post-class payout runs

### `post_class_payout_run_status`

- **Variable**: `postClassPayoutRunStatusEnum`
- **Definition**: `src/lib/db/schema.ts:314`
- **Values**: `draft`, `publishing`, `partial`, `published`, `closed`
- **Used by**:
  - `post_class_payout_runs.status` — default `draft` (`schema.ts:3642`)

Indexed twice on this column — `pc_payout_runs_status_idx` over `(status, window_end)` and `pc_payout_runs_lease_idx` over `(status, lease_expires_at)` (`schema.ts:3699-3700`). Three of the five values are load-bearing in repository logic: `publishing` is the leased state, and a run left in it with an expired lease is recovered to `partial` under a CAS-fenced update guarded on both the old status and the old `version` (`src/lib/post-class-feedback/payout-repository.ts:789-802`); `closed` is rejected outright as unchangeable (`payout-repository.ts:777-779`); and the automated finalize selector treats only `published` and `closed` as "nothing left to do" (`payout-repository.ts:379`).

### `post_class_payout_match_status`

- **Variable**: `postClassPayoutMatchStatusEnum`
- **Definition**: `src/lib/db/schema.ts:322`
- **Values**: `pending`, `matched`, `unmatched`, `ambiguous`, `no_sheet`
- **Used by**:
  - `post_class_payout_run_lines.match_status` — default `pending` (`schema.ts:3787`)

`unmatched`, `ambiguous`, and `no_sheet` are the three separable reasons a line cannot be written; the run builder emits them as a closed union of its own (`src/lib/post-class-feedback/payout-run.ts:285`).

### `post_class_payout_write_status`

- **Variable**: `postClassPayoutWriteStatusEnum`
- **Definition**: `src/lib/db/schema.ts:330`
- **Values**: `pending`, `written`, `failed`, `skipped`
- **Used by**:
  - `post_class_payout_run_lines.write_status` — default `pending` (`schema.ts:3799`)

The sibling `post_class_payout_adjustments.status` is *not* this enum: it is a `text` column constrained to `pending | written | failed | exception` (`schema.ts:3830`, `schema.ts:3852-3855`). See the [appendix](#appendix-enum-shaped-text-columns).

---

## University admissions case management

### `admissions_case_status`

- **Variable**: `admissionsCaseStatusEnum`
- **Definition**: `src/lib/db/schema.ts:337`
- **Values**: `active`, `committed`, `completed`, `withdrawn`, `archived`
- **Used by**:
  - `admissions_cases.status` — default `active` (`schema.ts:3991`)

### `admissions_member_role`

- **Variable**: `admissionsMemberRoleEnum`
- **Definition**: `src/lib/db/schema.ts:345`
- **Values**: `counselor`, `student`, `parent`
- **Used by**:
  - `admissions_case_members.role` — no default (`schema.ts:4016`)

Case-scoped roles only; the platform-wide `admin` allowlist lives in `admin_users` and is not a member of this enum.

### `admissions_member_status`

- **Variable**: `admissionsMemberStatusEnum`
- **Definition**: `src/lib/db/schema.ts:351`
- **Values**: `invited`, `active`, `revoked`, `bounced`
- **Used by**:
  - `admissions_case_members.status` — default `invited` (`schema.ts:4017`)

### `admissions_task_status`

- **Variable**: `admissionsTaskStatusEnum`
- **Definition**: `src/lib/db/schema.ts:358`
- **Values**: `not_started`, `in_progress`, `done`
- **Used by** — both default `not_started`:
  - `admissions_case_tasks.status` (`schema.ts:4087`)
  - `admissions_college_requirements.status` (`schema.ts:4185`)

### `admissions_task_owner`

- **Variable**: `admissionsTaskOwnerEnum`
- **Definition**: `src/lib/db/schema.ts:364`
- **Values**: `student`, `counselor`, `parent`
- **Used by**:
  - `admissions_template_items.default_owner` — default `student` (`schema.ts:4068`)
  - `admissions_case_tasks.owner` — no default (`schema.ts:4086`)
  - `admissions_college_requirements.owner` — default `student` (`schema.ts:4186`)

Same three values as `admissions_member_role` but a separate type — ownership of a checklist item is not a membership grant.

### `admissions_app_round`

- **Variable**: `admissionsAppRoundEnum`
- **Definition**: `src/lib/db/schema.ts:370`
- **Values**: `ed`, `ed2`, `ea`, `rea`, `rd`, `rolling`, `priority`, `other`
- **Used by**:
  - `admissions_college_list_items.round` — no default (`schema.ts:4126`)

The widest enum in the schema at 8 values.

### `admissions_app_status`

- **Variable**: `admissionsAppStatusEnum`
- **Definition**: `src/lib/db/schema.ts:381`
- **Values**: `researching`, `applying`, `submitted`, `complete`
- **Used by**:
  - `admissions_college_list_items.app_status` — default `researching` (`schema.ts:4128`)

### `admissions_decision_event`

- **Variable**: `admissionsDecisionEventEnum`
- **Definition**: `src/lib/db/schema.ts:388`
- **Values**: `submitted`, `deferred`, `waitlisted`, `accepted`, `denied`, `withdrawn`, `committed`
- **Used by**:
  - `admissions_application_events.event` — no default (`schema.ts:4244`)

An append-only event log rather than a mutable status column — a college list item can accumulate `submitted` → `deferred` → `accepted`. Note `submitted` and `withdrawn` also exist in `admissions_app_status` / `admissions_case_status`; the three types are unrelated.

### `admissions_essay_status`

- **Variable**: `admissionsEssayStatusEnum`
- **Definition**: `src/lib/db/schema.ts:398`
- **Values**: `not_started`, `brainstorming`, `drafting`, `feedback`, `final`
- **Used by**:
  - `admissions_essays.status` — default `not_started` (`schema.ts:4298`)
  - `admissions_essays.counselor_stage` — no default, nullable (`schema.ts:4299`)

Two columns of the same type: the student-facing status and the counselor's own read of the stage.

### `admissions_test_type`

- **Variable**: `admissionsTestTypeEnum`
- **Definition**: `src/lib/db/schema.ts:406`
- **Values**: `sat`, `act`, `ap`, `ib`, `toefl`, `ielts`, `other`
- **Used by**:
  - `admissions_test_sittings.test_type` — no default (`schema.ts:4390`)

### `admissions_test_sitting_status`

- **Variable**: `admissionsTestSittingStatusEnum`
- **Definition**: `src/lib/db/schema.ts:416`
- **Values**: `planned`, `registered`, `taken`, `score_received`, `canceled`
- **Used by**:
  - `admissions_test_sittings.status` — default `planned` (`schema.ts:4394`)

`score_received` is separate from `taken` so a sat-but-unscored sitting is representable. Parent visibility of the raw score is *not* driven by this enum — it is the separate `admissions_test_sittings.score_released_to_parent` boolean, default `false` (`schema.ts:4398`), gated to counselor+ on write (`CM-83`, `src/app/api/admissions/cases/[caseId]/testing/route.ts:139-145`).

### `admissions_notification_outbox_status`

- **Variable**: `admissionsNotificationOutboxStatusEnum`
- **Definition**: `src/lib/db/schema.ts:424` — the only declaration whose SQL name and value array are wrapped onto their own lines (`schema.ts:425-426`)
- **Values**: `pending`, `processing`, `sent`, `failed`
- **Used by**:
  - `admissions_notification_outbox.status` — default `pending` (`schema.ts:4533`)

The per-row outbox lifecycle; the enclosing `admissions_notification_runs.status` uses the shared `sync_status` instead.

### `admissions_note_visibility`

- **Variable**: `admissionsNoteVisibilityEnum`
- **Definition**: `src/lib/db/schema.ts:429`
- **Values**: `staff_only`, `shared_with_family`
- **Used by**:
  - `admissions_notes.visibility` — no default (`schema.ts:4430`)

No column default: sharing is an explicit per-note choice at insert time.

### `admissions_rec_status`

- **Variable**: `admissionsRecStatusEnum`
- **Definition**: `src/lib/db/schema.ts:434`
- **Values**: `planned`, `asked`, `agreed`, `declined`
- **Used by**:
  - `admissions_recommenders.ask_status` — default `planned` (`schema.ts:4259`)

### `admissions_submission_state`

- **Variable**: `admissionsSubmissionStateEnum`
- **Definition**: `src/lib/db/schema.ts:441`
- **Values**: `draft`, `submitted`, `reviewed`
- **Used by**:
  - `admissions_self_report_sections.state` — default `draft` (`schema.ts:4477`)

### `admissions_college_category`

- **Variable**: `admissionsCollegeCategoryEnum`
- **Definition**: `src/lib/db/schema.ts:447`
- **Values**: `reach`, `match`, `safety`, `unset`
- **Used by**:
  - `admissions_college_list_items.category` — default `unset` (`schema.ts:4129`)

`unset` is an explicit member rather than a nullable column, so "not yet categorized" is a stored fact.

---

## Appendix: enum-shaped text columns

These columns behave like enums but are `text` with a `CHECK` constraint, not Postgres enum types. They are **not** part of the 61 and cannot be introspected via `pg_enum`. Every one of them sits in the post-class payout tables.

| Table | Column | Allowed values | Column line | `CHECK` line |
|---|---|---|---|---|
| `post_class_payout_runs` | `csv_status` | `pending`, `uploaded`, `failed` | `schema.ts:3679` | `schema.ts:3701` |
| `post_class_payout_runs` | `date_roll_status` | `not_started`, `running`, `partial`, `completed` | `schema.ts:3685` | `schema.ts:3705` |
| `post_class_payout_run_lines` | `line_kind` | `deduction` (single-valued) | `schema.ts:3768` | `schema.ts:3816` |
| `post_class_payout_adjustments` | `kind` | `waiver`, `reversal` | `schema.ts:3829` | `schema.ts:3851` |
| `post_class_payout_adjustments` | `status` | `pending`, `written`, `failed`, `exception` | `schema.ts:3830` | `schema.ts:3852` |
| `post_class_payout_exceptions` | `status` | `open`, `resolved` | `schema.ts:3866` | `schema.ts:3883` |
| `post_class_payout_roll_runs` | `status` | `running`, `partial`, `completed`, `failed` | `schema.ts:3894` | `schema.ts:3912` |
| `post_class_payout_roll_outcomes` | `status` | `pending`, `already_target`, `verified`, `failed` | `schema.ts:3925` | `schema.ts:3945` |

Every one of these columns carries a Drizzle `$type<…>()` union mirroring its constraint, so TypeScript and Postgres agree without an enum type. `post_class_payout_adjustments.status` overlaps `post_class_payout_write_status` on three of four values but adds `exception`, which is why it is a constrained `text` column rather than that enum.

Other `CHECK` constraints in the schema (`schema.ts:606`, `610`, `3817`, `3856`, `4159`, `4328`, `4369`, `4373`, `4377`, `4451`) are range, length, normalization, or XOR guards, not value sets, and are documented with their tables in [`index.md`](index.md).

---

## Related

- [`index.md`](index.md) — full table inventory and per-domain ER diagrams
- [`../api/index.md`](../api/index.md) — endpoints that read and write these state machines
- [`../../features/`](../../features/) — purpose, rules, and flows behind each state machine

_Verified against HEAD + uncommitted WIP on 2026-05-31._
