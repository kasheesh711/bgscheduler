# Database Enums Reference

Postgres enum types defined as Drizzle `pgEnum` declarations in `src/lib/db/schema.ts` (lines 19–161). Each enum maps to a native Postgres `CREATE TYPE ... AS ENUM` type whose name is the first `pgEnum()` argument; the exported TypeScript constant (the `varName`) wraps it for column definitions.

This page is the canonical home for the mechanical detail of every enum: its allowed values, default, and the table/column(s) that reference it. Meaning, rules, and workflow semantics live in the corresponding feature docs.

All values, defaults, and column references below are taken from `src/lib/db/schema.ts` at the cited line numbers. Only schema-level (`pgEnum(...)`) column bindings are listed under "Used by".

---

## `sync_status`

- **Variable**: `syncStatusEnum`
- **Definition**: `src/lib/db/schema.ts:19`
- **Values**: `running`, `success`, `failed`
- **Used by** (column default in parentheses):
  - `sync_runs.status` — default `running` (`schema.ts:173`)
  - `wise_activity_sync_runs.status` — default `running` (`schema.ts:227`)
  - `sales_dashboard_import_runs.status` — default `running` (`schema.ts:305`)
  - `sales_dashboard_projection_import_runs.status` — default `running` (`schema.ts:398`)
  - `credit_control_sync_runs.status` — default `running` (`schema.ts:461`)
  - `payroll_sync_runs.status` — default `running` (`schema.ts:858`)
  - `leave_request_sync_runs.status` — default `running` (`schema.ts:1187`)

The shared status lifecycle for every sync/import run table across the app.

---

## `data_issue_type`

- **Variable**: `dataIssueTypeEnum`
- **Definition**: `src/lib/db/schema.ts:25`
- **Values**: `alias`, `modality`, `tag`, `completeness`, `conflict_model`, `sync`
- **Used by**:
  - `data_issues.type` — no default (`schema.ts:1747`)

Classifies the category of an unresolved normalization issue surfaced on the data-health view.

---

## `data_issue_severity`

- **Variable**: `dataIssueSeverityEnum`
- **Definition**: `src/lib/db/schema.ts:34`
- **Values**: `critical`, `high`, `medium`, `low`
- **Used by**:
  - `data_issues.severity` — default `high` (`schema.ts:1748`)

---

## `modality`

- **Variable**: `modalityEnum`
- **Definition**: `src/lib/db/schema.ts:41`
- **Values**: `online`, `onsite`, `both`, `unresolved`
- **Used by**:
  - `tutor_identity_groups.supported_modality` — default `unresolved` (`schema.ts:616`)
  - `recurring_availability_windows.modality` — default `unresolved` (`schema.ts:692`)

The `unresolved` default enforces the fail-closed rule: modality is never guessed, and unresolved tutors route to "Needs review".

---

## `classroom_room_category`

- **Variable**: `classroomRoomCategoryEnum`
- **Definition**: `src/lib/db/schema.ts:48`
- **Values**: `standard`, `overflow_only`, `online_only`
- **Used by**:
  - `classroom_rooms.category` — default `standard` (`schema.ts:746`)

---

## `classroom_assignment_run_status`

- **Variable**: `classroomAssignmentRunStatusEnum`
- **Definition**: `src/lib/db/schema.ts:54`
- **Values**: `completed`, `published`, `partial`, `failed`
- **Used by**:
  - `classroom_assignment_runs.status` — default `completed` (`schema.ts:760`)

---

## `classroom_assignment_row_status`

- **Variable**: `classroomAssignmentRowStatusEnum`
- **Definition**: `src/lib/db/schema.ts:61`
- **Values**: `assigned`, `needs_review`, `no_room`, `remote`
- **Used by**:
  - `classroom_assignment_rows.status` — default `assigned` (`schema.ts:810`)

---

## `classroom_publish_status`

- **Variable**: `classroomPublishStatusEnum`
- **Definition**: `src/lib/db/schema.ts:68`
- **Values**: `not_published`, `skipped`, `success`, `failed`
- **Used by**:
  - `classroom_assignment_rows.publish_status` — default `not_published` (`schema.ts:816`)

Tracks the Wise writeback outcome per assignment row (only eligible OFFLINE sessions are published).

---

## `classroom_publish_job_status`

- **Variable**: `classroomPublishJobStatusEnum`
- **Definition**: `src/lib/db/schema.ts:75`
- **Values**: `pending`, `running`, `succeeded`, `partial`, `failed`
- **Used by**:
  - `classroom_publish_jobs.status` — default `pending` (`schema.ts:1019`)

Distinct from `classroom_publish_status`: this is the job-level lifecycle (note `succeeded`, not `success`), whereas `classroom_publish_status` is the per-row result.

---

## `proposal_scope`

- **Variable**: `proposalScopeEnum`
- **Definition**: `src/lib/db/schema.ts:83`
- **Values**: `recurring`, `one_time`
- **Used by**:
  - `proposal_items.scope` — no default (`schema.ts:1410`)

Mirrors the search-engine recurring/one-time mode for a held tutor-slot proposal.

---

## `proposal_status`

- **Variable**: `proposalStatusEnum`
- **Definition**: `src/lib/db/schema.ts:88`
- **Values**: `pending`, `confirmed`, `released`, `expired`, `auto_resolved`
- **Used by**:
  - `proposal_items.status` — default `pending` (`schema.ts:1418`)

---

## `ai_scheduler_conversation_status`

- **Variable**: `aiSchedulerConversationStatusEnum`
- **Definition**: `src/lib/db/schema.ts:96`
- **Values**: `active`, `archived`
- **Used by**:
  - `ai_scheduler_conversations.status` — default `active` (`schema.ts:1439`)

---

## `ai_scheduler_message_role`

- **Variable**: `aiSchedulerMessageRoleEnum`
- **Definition**: `src/lib/db/schema.ts:101`
- **Values**: `admin`, `parent`, `assistant`, `system`
- **Used by**:
  - `ai_scheduler_messages.role` — no default (`schema.ts:1462`)

---

## `line_message_direction`

- **Variable**: `lineMessageDirectionEnum`
- **Definition**: `src/lib/db/schema.ts:108`
- **Values**: `inbound`, `outbound`
- **Used by**:
  - `line_messages.direction` — no default (`schema.ts:1564`)

---

## `line_scheduler_classifier_category`

- **Variable**: `lineSchedulerClassifierCategoryEnum`
- **Definition**: `src/lib/db/schema.ts:113`
- **Values**: `scheduling_request`, `scheduling_change`, `non_scheduling`, `unclear`
- **Used by**:
  - `line_messages.classifier_category` — no default (`schema.ts:1575`)
  - `line_messages.classification_reviewed_category` — no default (`schema.ts:1580`)
  - `line_scheduler_reviews.classifier_category` — no default (`schema.ts:1636`)

The model-assigned category for an inbound LINE message; the reviewed variant on `line_messages` and the copy on `line_scheduler_reviews` hold the human-corrected value.

---

## `line_scheduler_review_status`

- **Variable**: `lineSchedulerReviewStatusEnum`
- **Definition**: `src/lib/db/schema.ts:120`
- **Values**: `pending_review`, `approved_sent`, `accepted_no_send`, `rejected`, `dismissed`
- **Used by**:
  - `line_scheduler_reviews.status` — default `pending_review` (`schema.ts:1640`)

---

## `line_contact_student_link_status`

- **Variable**: `lineContactStudentLinkStatusEnum`
- **Definition**: `src/lib/db/schema.ts:128`
- **Values**: `suggested`, `verified`, `rejected`
- **Used by**:
  - `line_contact_student_links.status` — default `suggested` (`schema.ts:1602`)

---

## `student_promotion_run_status`

- **Variable**: `studentPromotionRunStatusEnum`
- **Definition**: `src/lib/db/schema.ts:134`
- **Values**: `draft`, `verified`, `applying`, `applied`, `applied_with_errors`, `failed`
- **Used by**:
  - `student_promotion_runs.status` — default `draft` (`schema.ts:652`)

Tracks the dry-run verification and apply lifecycle for the July 1 student-promotion workflow.

---

## `student_promotion_action_status`

- **Variable**: `studentPromotionActionStatusEnum`
- **Definition**: `src/lib/db/schema.ts:143`
- **Values**: `pending`, `skipped`, `applied`, `failed`
- **Used by**:
  - `student_promotion_grade_actions.status` — default `pending` (`schema.ts:692`)
  - `student_promotion_course_actions.status` — default `pending` (`schema.ts:715`)

Per-action status for grade registration writes and class-subject writes. `skipped` covers dry-run exclusions and apply-time drift.

---

## `sales_dashboard_source_status`

- **Variable**: `salesDashboardSourceStatusEnum`
- **Definition**: `src/lib/db/schema.ts:134`
- **Values**: `active`, `refreshing`, `finalized`, `reopened`, `archived`
- **Used by**:
  - `sales_dashboard_sources.status` — default `active` (`schema.ts:278`)
  - `sales_dashboard_sources.status_before_archive` — no default, nullable (`schema.ts:288`)

`status_before_archive` preserves the prior lifecycle state so an archived source can be reopened to where it was.

---

## `payroll_review_status`

- **Variable**: `payrollReviewStatusEnum`
- **Definition**: `src/lib/db/schema.ts:142`
- **Values**: `draft`, `approved`
- **Used by**:
  - `payroll_reviews.status` — default `draft` (`schema.ts:878`)

---

## `leave_request_workflow_status`

- **Variable**: `leaveRequestWorkflowStatusEnum`
- **Definition**: `src/lib/db/schema.ts:147`
- **Values**: `new`, `needs_review`, `in_progress`, `done`, `ignored`, `canceled_by_tutor`
- **Used by**:
  - `leave_requests.workflow_status` — default `new` (`schema.ts:1236`)

---

## `leave_request_sheet_write_status`

- **Variable**: `leaveRequestSheetWriteStatusEnum`
- **Definition**: `src/lib/db/schema.ts:156`
- **Values**: `not_required`, `pending`, `success`, `failed`
- **Used by**:
  - `leave_requests.sheet_write_status` — default `not_required` (`schema.ts:1239`)

Tracks the outcome of writing an approved leave request back to its Google Sheet.

---

_Verified against HEAD + uncommitted WIP on 2026-05-31._
