# Database Reference — Master Table Index

The canonical lookup for every table in the BGScheduler Postgres database: **188 tables**, all
declared in [`src/lib/db/schema.ts`](../../../src/lib/db/schema.ts) (4,719 lines) with Drizzle ORM
and migrated under [`drizzle/`](../../../drizzle) (65 `.sql` files, latest `0064_line_group_settings.sql`).
The count is mechanical: `grep -c "^export const .* = pgTable" src/lib/db/schema.ts` → `188`.

This page answers "what is this table, what is one row of it, and who owns it". It is a
**directory, not a column dump** — every row cites the exact `schema.ts` line range, which is the
authoritative source for columns, types, defaults, indexes, and check constraints. Per-domain
relationship diagrams live on the `erd-*.md` pages linked in the ERD column; enum value sets live
in [`enums.md`](./enums.md); feature meaning, rules, and flows live under
[`docs/features/`](../../features/).

## Domains

Ten domain groupings. `core` is the original snapshot/ETL spine plus every newer subsystem that
hangs off it directly; the other nine are self-contained lineages with their own sync/import
machinery.

| Domain | Tables | ERD page(s) |
|---|---:|---|
| `core` | 124 | [erd-core.md](./erd-core.md) — plus dedicated pages for two sub-areas: [erd-student-promotions.md](./erd-student-promotions.md) (6 tables) and [erd-university-admissions.md](./erd-university-admissions.md) (36 tables) |
| `sales-dashboard` | 7 | [erd-sales-dashboard.md](./erd-sales-dashboard.md) |
| `credit-control` | 11 | [erd-credit-control.md](./erd-credit-control.md) |
| `classrooms` | 9 | [erd-classrooms.md](./erd-classrooms.md) |
| `payroll` | 8 | [erd-payroll.md](./erd-payroll.md) |
| `tutor-profiles` | 2 | [erd-tutor-profiles.md](./erd-tutor-profiles.md) |
| `leave-requests` | 5 | [erd-leave-requests.md](./erd-leave-requests.md) |
| `ai-and-proposals` | 6 | [erd-ai-and-proposals.md](./erd-ai-and-proposals.md) |
| `line` | 12 | [erd-line.md](./erd-line.md) |
| `room-capacity` | 4 | [erd-room-capacity.md](./erd-room-capacity.md) |
| **Total** | **188** | |

### What is inside `core`

124 tables is too coarse to navigate, so the sub-areas are:

| Sub-area | Tables | Prefix / anchor |
|---|---:|---|
| Snapshot & sync control plane, cron observability, Wise activity audit, auth & access | 9 | `snapshots` … `learning_plan_access_grants` |
| Competitor intelligence | 16 | `competitor_*` |
| Student promotion | 6 | `student_promotion_*` |
| Tutor identity, normalization, session blocks, data health | 13 | the snapshot-scoped ETL output plus `past_session_blocks`, `room_utilization_sessions`, `data_issues`, `snapshot_stats` |
| Progress tests | 8 | `progress_test_*` |
| US universities (IPEDS) | 3 | `ipeds_*` |
| Post-class feedback — config, evidence, notifications, AI, finance, payout | 32 | `post_class_*` |
| University admissions case management | 36 | `admissions_*` |
| Student monthly schedule (parent-facing) | 1 | `student_schedule_links` |
| **Total** | **124** | |

## Reading the Grain column

"Grain" states what exactly one row is. Where a `uniqueIndex` enforces the grain, that index is the
evidence; where the primary key is a natural key (an email, a `student_key`, a `group_id`), the row
says so. Where nothing enforces it, the grain cell says the shape is conventional, not constrained.
Three recurring patterns are worth naming once:

- **Snapshot-scoped.** Thirteen tables carry a `snapshotId` FK to `snapshots` and are rewritten
  wholesale by each ETL run; readers only ever see the row set where `snapshots.active = true`
  (`schema.ts:456-460`). `credit_control_snapshots` runs the same pattern on its own independent
  lineage (`schema.ts:1150-1160`). See [Snapshot scoping](#snapshot-scoping) for the exact list.
- **Snapshot-independent.** Everything else. Rows keyed by a durable natural key (email,
  `student_key`, `canonical_key`, `wise_session_id`, `group_canonical_key`, `enrollment_key`)
  deliberately survive snapshot rotation. `past_session_blocks` carries the schema comment naming
  itself the one cross-snapshot *tutor data* table (`schema.ts:2242-2244`).
- **Single-flight run ledgers.** Most `*_sync_runs` tables carry a partial
  `uniqueIndex(...).where(status = 'running')`, so a second concurrent run cannot insert — the
  guard is in Postgres, not application code. Example: `sync_runs_single_running_idx`
  (`schema.ts:473-475`).

## All 188 tables

| Table (SQL name) | Const (varName) | Domain | Grain — one row per… | Owning feature | ERD | `schema.ts` |
|---|---|---|---|---|---|---|
| `snapshots` | `snapshots` | core | Wise ETL snapshot; `active` marks the single promoted one | [Tutor Search](../../features/tutor-search.md) | [core](./erd-core.md) | 456-460 |
| `sync_runs` | `syncRuns` | core | full-sync attempt; partial unique index permits at most one `running` | [Data Health](../../features/data-health.md) | [core](./erd-core.md) | 462-477 |
| `cron_invocations` | `cronInvocations` | core | invocation of an internal cron or manual job (`job_key` + `received_at`); not unique-constrained | [Data Health](../../features/data-health.md) | [core](./erd-core.md) | 479-499 |
| `cron_alert_state` | `cronAlertState` | core | cron job key (PK `job_key`) — watchdog alert dedup and recovery state | [Data Health](../../features/data-health.md) | [core](./erd-core.md) | 505-514 |
| `wise_activity_events` | `wiseActivityEvents` | core | Wise activity event (unique `event_id`); snapshot-independent audit mirror | [Wise Activity Audit](../../features/wise-activity-audit.md) | [core](./erd-core.md) | 518-551 |
| `wise_activity_sync_runs` | `wiseActivitySyncRuns` | core | activity-audit sync attempt; single-running guard | [Wise Activity Audit](../../features/wise-activity-audit.md) | [core](./erd-core.md) | 553-571 |
| `admin_users` | `adminUsers` | core | allowlisted admin email (unique `email`); `allowed_pages` null = full access | Auth / middleware | [core](./erd-core.md) | 575-585 |
| `google_oauth_tokens` | `googleOAuthTokens` | core | connected Google account (PK `email`); tokens stored as ciphertext | [Sales Dashboard](../../features/sales-dashboard.md) owns the shared layer (`src/lib/sales-dashboard/google-oauth.ts`); Leave Requests + Post-Class read it | [core](./erd-core.md) | 587-597 |
| `learning_plan_access_grants` | `learningPlanAccessGrants` | core | email granted learning-plan access (PK `email`; a check constraint forces lower/trimmed, non-blank) | [Learning Plans](../../features/learning-plans.md) | [core](./erd-core.md) | 601-614 |
| `competitor_entities` | `competitorEntities` | core | tracked competitor or own brand (unique `slug`) | [Competitor Intelligence](../../features/competitor-intelligence.md) | [core](./erd-core.md) | 795-814 |
| `competitor_sources` | `competitorSources` | core | monitored source — unique (`entity_id`, `source_type`, `url`) | [Competitor Intelligence](../../features/competitor-intelligence.md) | [core](./erd-core.md) | 816-842 |
| `competitor_sync_runs` | `competitorSyncRuns` | core | competitor sync attempt; single-running guard | [Competitor Intelligence](../../features/competitor-intelligence.md) | [core](./erd-core.md) | 844-869 |
| `competitor_source_runs` | `competitorSourceRuns` | core | one source fetched inside one sync run; carries that source's usage units and estimated cost | [Competitor Intelligence](../../features/competitor-intelligence.md) | [core](./erd-core.md) | 871-894 |
| `competitor_evidence_items` | `competitorEvidenceItems` | core | captured evidence item (unique `item_key`) | [Competitor Intelligence](../../features/competitor-intelligence.md) | [core](./erd-core.md) | 896-927 |
| `competitor_assets` | `competitorAssets` | core | stored binary asset belonging to an evidence item (unique `storage_key`) | [Competitor Intelligence](../../features/competitor-intelligence.md) | [core](./erd-core.md) | 929-945 |
| `competitor_serp_keywords` | `competitorSerpKeywords` | core | tracked keyword — unique (`keyword`, `language`, `location`, `device`) | [Competitor Intelligence](../../features/competitor-intelligence.md) | [core](./erd-core.md) | 947-966 |
| `competitor_serp_observations` | `competitorSerpObservations` | core | observed SERP result (unique `observation_key`) | [Competitor Intelligence](../../features/competitor-intelligence.md) | [core](./erd-core.md) | 968-994 |
| `competitor_ai_runs` | `competitorAiRuns` | core | AI generation run (brief, war room, or task suggestions), typed by `run_type` | [Competitor Intelligence](../../features/competitor-intelligence.md) | [core](./erd-core.md) | 996-1013 |
| `competitor_briefs` | `competitorBriefs` | core | brief date (unique `brief_date`) | [Competitor Intelligence](../../features/competitor-intelligence.md) | [core](./erd-core.md) | 1015-1036 |
| `competitor_war_room_snapshots` | `competitorWarRoomSnapshots` | core | week (unique `week_start`) of war-room matrix + content angles | [Competitor Intelligence](../../features/competitor-intelligence.md) | [core](./erd-core.md) | 1038-1061 |
| `competitor_task_suggestions` | `competitorTaskSuggestions` | core | AI-suggested task awaiting accept/ignore | [Competitor Intelligence](../../features/competitor-intelligence.md) | [core](./erd-core.md) | 1063-1084 |
| `competitor_tasks` | `competitorTasks` | core | human-owned competitor task | [Competitor Intelligence](../../features/competitor-intelligence.md) | [core](./erd-core.md) | 1086-1108 |
| `competitor_task_comments` | `competitorTaskComments` | core | comment on a task | [Competitor Intelligence](../../features/competitor-intelligence.md) | [core](./erd-core.md) | 1110-1119 |
| `competitor_task_events` | `competitorTaskEvents` | core | task lifecycle event; append-only (`created_at` only) | [Competitor Intelligence](../../features/competitor-intelligence.md) | [core](./erd-core.md) | 1121-1130 |
| `competitor_vendor_usage` | `competitorVendorUsage` | core | unique (`usage_month`, `provider`, `source_type`) — spend-cap accounting | [Competitor Intelligence](../../features/competitor-intelligence.md) | [core](./erd-core.md) | 1132-1146 |
| `student_promotion_runs` | `studentPromotionRuns` | core | promotion run for a `target_date` (draft → verified → applied) | [Student Promotions](../../features/student-promotions.md) | [promotions](./erd-student-promotions.md) | 1343-1374 |
| `student_promotion_grade_actions` | `studentPromotionGradeActions` | core | unique (`run_id`, `wise_student_id`) — one planned grade bump | [Student Promotions](../../features/student-promotions.md) | [promotions](./erd-student-promotions.md) | 1376-1398 |
| `student_promotion_course_actions` | `studentPromotionCourseActions` | core | unique (`run_id`, `wise_class_id`) — one planned course transition | [Student Promotions](../../features/student-promotions.md) | [promotions](./erd-student-promotions.md) | 1400-1421 |
| `student_promotion_future_session_actions` | `studentPromotionFutureSessionActions` | core | unique (`run_id`, `wise_session_id`) — one future session to re-subject | [Student Promotions](../../features/student-promotions.md) | [promotions](./erd-student-promotions.md) | 1423-1448 |
| `student_promotion_graduation_actions` | `studentPromotionGraduationActions` | core | unique (`run_id`, `wise_student_id`) flagged as graduating; needs a human disposition | [Student Promotions](../../features/student-promotions.md) | [promotions](./erd-student-promotions.md) | 1450-1471 |
| `student_promotion_pay_rate_impacts` | `studentPromotionPayRateImpacts` | core | unique (`run_id`, `impact_key`) — the tutor pay-rate delta a course move causes | [Student Promotions](../../features/student-promotions.md) | [promotions](./erd-student-promotions.md) | 1473-1512 |
| `tutor_identity_groups` | `tutorIdentityGroups` | core | resolved tutor identity per snapshot; `canonical_key` is the stable cross-snapshot anchor | [Tutor Search](../../features/tutor-search.md) | [core](./erd-core.md) | 1516-1525 |
| `tutor_identity_group_members` | `tutorIdentityGroupMembers` | core | Wise teacher record inside an identity group, per snapshot | [Tutor Search](../../features/tutor-search.md) | [core](./erd-core.md) | 1527-1538 |
| `tutor_aliases` | `tutorAliases` | core | alias mapping `from_key` → `to_key` (unique `from_key`); snapshot-independent | [Tutor Search](../../features/tutor-search.md) | [core](./erd-core.md) | 1540-1547 |
| `tutors` | `tutors` | core | identity group per snapshot — the denormalized read aggregate | [Tutor Search](../../features/tutor-search.md) | [core](./erd-core.md) | 1549-1558 |
| `raw_teacher_tags` | `rawTeacherTags` | core | raw Wise tag value per teacher per snapshot (pre-normalization evidence) | [Tutor Search](../../features/tutor-search.md) | [core](./erd-core.md) | 1562-1571 |
| `subject_level_qualifications` | `subjectLevelQualifications` | core | parsed subject/curriculum/level/examPrep qualification per group per snapshot | [Tutor Search](../../features/tutor-search.md) | [core](./erd-core.md) | 1573-1585 |
| `recurring_availability_windows` | `recurringAvailabilityWindows` | core | weekday availability window per teacher per snapshot (minutes since Bangkok midnight) | [Tutor Search](../../features/tutor-search.md) | [core](./erd-core.md) | 1589-1601 |
| `dated_leaves` | `datedLeaves` | core | merged dated leave interval per teacher per snapshot | [Tutor Search](../../features/tutor-search.md) | [core](./erd-core.md) | 1603-1613 |
| `future_session_blocks` | `futureSessionBlocks` | core | future Wise session per snapshot; `is_blocking` defaults **true** (fail-closed) | [Tutor Search](../../features/tutor-search.md) | [core](./erd-core.md) | 1615-1642 |
| `room_utilization_sessions` | `roomUtilizationSessions` | core | Wise session (unique `wise_session_id`) with a normalized room label; snapshot-independent | [Room Capacity](../../features/room-capacity.md) | [core](./erd-core.md) | 1736-1756 |
| `past_session_blocks` | `pastSessionBlocks` | core | Wise session captured after it dropped out of the FUTURE feed (unique `wise_session_id`, first-observation-wins); the only cross-snapshot tutor data table | [Tutor Compare](../../features/tutor-compare.md) | [core](./erd-core.md) | 2255-2294 |
| `data_issues` | `dataIssues` | core | normalization/sync issue raised during one snapshot's ETL | [Data Health](../../features/data-health.md) | [core](./erd-core.md) | 2685-2699 |
| `snapshot_stats` | `snapshotStats` | core | snapshot (unique `snapshot_id`) — the counts the promotion gate is measured against | [Data Health](../../features/data-health.md) | [core](./erd-core.md) | 2703-2719 |
| `progress_test_attendance_ledger` | `progressTestAttendanceLedger` | core | unique (`wise_session_id`, `wise_student_id`) counted toward a progress-test cycle; cross-snapshot | [Progress Tests](../../features/progress-tests.md) | [core](./erd-core.md) | 2812-2836 |
| `progress_test_cycle_state` | `progressTestCycleState` | core | enrollment key (PK) = student × class — current count, status, booked test | [Progress Tests](../../features/progress-tests.md) | [core](./erd-core.md) | 2838-2872 |
| `progress_test_bookings` | `progressTestBookings` | core | booking attempt for one enrollment's cycle (`dry_run` defaults true) | [Progress Tests](../../features/progress-tests.md) | [core](./erd-core.md) | 2874-2895 |
| `progress_test_email_runs` | `progressTestEmailRuns` | core | teacher heads-up email run (unique `idempotency_key`) | [Progress Tests](../../features/progress-tests.md) | [core](./erd-core.md) | 2897-2916 |
| `progress_test_notifications` | `progressTestNotifications` | core | outbound notification to one recipient (unique `idempotency_key`) | [Progress Tests](../../features/progress-tests.md) | [core](./erd-core.md) | 2918-2935 |
| `progress_test_admin_digest_runs` | `progressTestAdminDigestRuns` | core | digest date — unique on both `digest_date` and `idempotency_key` | [Progress Tests](../../features/progress-tests.md) | [core](./erd-core.md) | 2937-2957 |
| `progress_test_admin_digest_recipients` | `progressTestAdminDigestRecipients` | core | recipient of one admin digest run | [Progress Tests](../../features/progress-tests.md) | [core](./erd-core.md) | 2959-2973 |
| `progress_test_sync_runs` | `progressTestSyncRuns` | core | progress-test sync attempt; single-running guard | [Progress Tests](../../features/progress-tests.md) | [core](./erd-core.md) | 2975-2995 |
| `ipeds_import_runs` | `ipedsImportRuns` | core | IPEDS import run for a `data_year`; partial unique permits one `running` per year | [US Universities](../../features/us-universities.md) | [core](./erd-core.md) | 3004-3019 |
| `ipeds_institutions` | `ipedsInstitutions` | core | institution per unique (`data_year`, `unit_id`) — directory, admissions, cost, outcomes | [US Universities](../../features/us-universities.md) | [core](./erd-core.md) | 3021-3113 |
| `ipeds_completions` | `ipedsCompletions` | core | completions count per data year × unit × CIP code × award level (indexed, not unique-constrained) | [US Universities](../../features/us-universities.md) | [core](./erd-core.md) | 3115-3130 |
| `post_class_enforcement_windows` | `postClassEnforcementWindows` | core | enforcement-mode window (`shadow`/`live`/`paused`); the open window has a null `ends_at` | [Post-Class Feedback](../../features/post-class-feedback.md) | [core](./erd-core.md) | 3138-3150 |
| `post_class_settings` | `postClassSettings` | core | the feature's single settings row (PK `id`, defaults to `"default"`) | [Post-Class Feedback](../../features/post-class-feedback.md) | [core](./erd-core.md) | 3152-3166 |
| `post_class_field_mappings` | `postClassFieldMappings` | core | unique (`mapping_version`, `field_key`) — Wise question text → compliance field | [Post-Class Feedback](../../features/post-class-feedback.md) | [core](./erd-core.md) | 3168-3182 |
| `post_class_access_grants` | `postClassAccessGrants` | core | unique (`email`, `capability`) — one granted capability | [Post-Class Feedback](../../features/post-class-feedback.md) | [core](./erd-core.md) | 3184-3194 |
| `post_class_config_audit_log` | `postClassConfigAuditLog` | core | config change with before/after values; append-only | [Post-Class Feedback](../../features/post-class-feedback.md) | [core](./erd-core.md) | 3196-3209 |
| `post_class_digest_recipients` | `postClassDigestRecipients` | core | admin digest recipient email (unique `email`) | [Post-Class Feedback](../../features/post-class-feedback.md) | [core](./erd-core.md) | 3211-3221 |
| `post_class_sync_runs` | `postClassSyncRuns` | core | post-class sync attempt over a date window; single-running guard | [Post-Class Feedback](../../features/post-class-feedback.md) | [core](./erd-core.md) | 3223-3248 |
| `post_class_sessions` | `postClassSessions` | core | Wise session in feedback scope (unique `wise_session_id`), carrying source/content/timing/deduction status | [Post-Class Feedback](../../features/post-class-feedback.md) | [core](./erd-core.md) | 3250-3305 |
| `post_class_session_participants` | `postClassSessionParticipants` | core | unique (`session_id`, `participant_key`) — who consumed credit | [Post-Class Feedback](../../features/post-class-feedback.md) | [core](./erd-core.md) | 3307-3321 |
| `post_class_feedback_versions` | `postClassFeedbackVersions` | core | unique (`session_id`, `version_key`) — one observed feedback submission | [Post-Class Feedback](../../features/post-class-feedback.md) | [core](./erd-core.md) | 3323-3352 |
| `post_class_feedback_event_links` | `postClassFeedbackEventLinks` | core | unique (`session_id`, `wise_event_id`) — links a version to activity-mirror evidence | [Post-Class Feedback](../../features/post-class-feedback.md) | [core](./erd-core.md) | 3354-3367 |
| `post_class_assessments` | `postClassAssessments` | core | assessment key (unique) — one compliance evaluation at a policy + mapping version | [Post-Class Feedback](../../features/post-class-feedback.md) | [core](./erd-core.md) | 3369-3398 |
| `post_class_source_issues` | `postClassSourceIssues` | core | source-health defect fingerprint (unique); `blocks_enforcement` defaults true | [Post-Class Feedback](../../features/post-class-feedback.md) | [core](./erd-core.md) | 3400-3420 |
| `post_class_notification_runs` | `postClassNotificationRuns` | core | notification run of one kind at one scheduled time (unique `idempotency_key`) | [Post-Class Feedback](../../features/post-class-feedback.md) | [core](./erd-core.md) | 3422-3445 |
| `post_class_notification_deliveries` | `postClassNotificationDeliveries` | core | one recipient's email inside a run (unique `idempotency_key`) | [Post-Class Feedback](../../features/post-class-feedback.md) | [core](./erd-core.md) | 3447-3469 |
| `post_class_notification_items` | `postClassNotificationItems` | core | unique (`delivery_id`, `session_id`) — the sessions listed in that email | [Post-Class Feedback](../../features/post-class-feedback.md) | [core](./erd-core.md) | 3471-3482 |
| `post_class_notification_attempts` | `postClassNotificationAttempts` | core | unique (`delivery_id`, `attempt_number`) — one provider try and its outcome | [Post-Class Feedback](../../features/post-class-feedback.md) | [core](./erd-core.md) | 3484-3498 |
| `post_class_ai_runs` | `postClassAiRuns` | core | AI review request over a feedback version (unique `request_hash`) | [Post-Class Feedback](../../features/post-class-feedback.md) | [core](./erd-core.md) | 3500-3519 |
| `post_class_ai_concerns` | `postClassAiConcerns` | core | unique (`run_id`, `dimension`) — one concern awaiting confirm/dismiss | [Post-Class Feedback](../../features/post-class-feedback.md) | [core](./erd-core.md) | 3521-3534 |
| `post_class_ai_reviews` | `postClassAiReviews` | core | human decision recorded against a concern; append-only, CAS via `expected_version` | [Post-Class Feedback](../../features/post-class-feedback.md) | [core](./erd-core.md) | 3536-3547 |
| `post_class_finance_periods` | `postClassFinancePeriods` | core | calendar month (unique `month`) — the open/closed gate for deductions | [Post-Class Feedback](../../features/post-class-feedback.md) | [core](./erd-core.md) | 3549-3565 |
| `post_class_deductions` | `postClassDeductions` | core | session (unique `session_id`) — at most one deduction per session, ever | [Post-Class Feedback](../../features/post-class-feedback.md) | [core](./erd-core.md) | 3567-3589 |
| `post_class_deduction_actions` | `postClassDeductionActions` | core | deduction state transition (unique `idempotency_key`); append-only | [Post-Class Feedback](../../features/post-class-feedback.md) | [core](./erd-core.md) | 3591-3610 |
| `post_class_deduction_offsets` | `postClassDeductionOffsets` | core | deduction (unique `deduction_id`) — its compensating offset row | [Post-Class Feedback](../../features/post-class-feedback.md) | [core](./erd-core.md) | 3612-3627 |
| `post_class_payout_runs` | `postClassPayoutRuns` | core | 26th→25th payout window; unique on `anchor_month` and on (`window_start`, `window_end`); publish is lease-fenced | [Post-Class Feedback](../../features/post-class-feedback.md) | [core](./erd-core.md) | 3636-3709 |
| `post_class_payout_tutor_names` | `postClassPayoutTutorNames` | core | tutor `canonical_key` (unique) → the exact ledger identity strings, copied never constructed | [Post-Class Feedback](../../features/post-class-feedback.md) | [core](./erd-core.md) | 3719-3735 |
| `post_class_tutor_payout_sheets` | `postClassTutorPayoutSheets` | core | tutor `canonical_key` (unique) → workbook + tab. **Superseded** by `post_class_payout_tutor_names`; retained only because migration 0057 created it, and nothing reads or writes it (`schema.ts:3737-3741`) | [Post-Class Feedback](../../features/post-class-feedback.md) | [core](./erd-core.md) | 3742-3756 |
| `post_class_payout_run_lines` | `postClassPayoutRunLines` | core | deduction line on a payout run; `source_identity` (`deduction:<uuid>`), `row_signature`, and `idempotency_key` are each **globally** unique, and a check forces `amount_minor < 0` | [Post-Class Feedback](../../features/post-class-feedback.md) | [core](./erd-core.md) | 3763-3818 |
| `post_class_payout_adjustments` | `postClassPayoutAdjustments` | core | positive correction obligation (`waiver` or `reversal`) against an already-written negative line; check forces `amount_minor > 0` | [Post-Class Feedback](../../features/post-class-feedback.md) | [core](./erd-core.md) | 3824-3857 |
| `post_class_payout_exceptions` | `postClassPayoutExceptions` | core | finance blocker raised while preparing or writing a run (unique `source_identity`) | [Post-Class Feedback](../../features/post-class-feedback.md) | [core](./erd-core.md) | 3860-3884 |
| `post_class_payout_roll_runs` | `postClassPayoutRollRuns` | core | date-roll attempt per payout run (unique `payout_run_id`); lease-fenced | [Post-Class Feedback](../../features/post-class-feedback.md) | [core](./erd-core.md) | 3887-3916 |
| `post_class_payout_roll_outcomes` | `postClassPayoutRollOutcomes` | core | unique (`roll_run_id`, `workbook_id`) — CAS-fenced before/after date serials | [Post-Class Feedback](../../features/post-class-feedback.md) | [core](./erd-core.md) | 3919-3949 |
| `admissions_cohorts` | `admissionsCohorts` | core | graduating cohort (unique `name`) | [University Admissions](../../features/university-admissions.md) | [admissions](./erd-university-admissions.md) | 3957-3966 |
| `admissions_students` | `admissionsStudents` | core | admissions student; `wise_student_key` is a soft reference, never an FK; soft-delete | [University Admissions](../../features/university-admissions.md) | [admissions](./erd-university-admissions.md) | 3968-3985 |
| `admissions_cases` | `admissionsCases` | core | case; a partial unique index enforces one live (`active`/`committed`) case per student | [University Admissions](../../features/university-admissions.md) | [admissions](./erd-university-admissions.md) | 3987-4010 |
| `admissions_case_members` | `admissionsCaseMembers` | core | unique (`case_id`, `email`) — the row that resolves role at sign-in | [University Admissions](../../features/university-admissions.md) | [admissions](./erd-university-admissions.md) | 4012-4036 |
| `admissions_counselors` | `admissionsCounselors` | core | counselor (unique `email`) available for case assignment | [University Admissions](../../features/university-admissions.md) | [admissions](./erd-university-admissions.md) | 4038-4047 |
| `admissions_checklist_templates` | `admissionsChecklistTemplates` | core | unique (`cohort_id`, `version`) | [University Admissions](../../features/university-admissions.md) | [admissions](./erd-university-admissions.md) | 4049-4059 |
| `admissions_template_items` | `admissionsTemplateItems` | core | checklist item inside one template version | [University Admissions](../../features/university-admissions.md) | [admissions](./erd-university-admissions.md) | 4061-4075 |
| `admissions_case_tasks` | `admissionsCaseTasks` | core | task on a case (materialized from a template item, or ad hoc); soft-delete | [University Admissions](../../features/university-admissions.md) | [admissions](./erd-university-admissions.md) | 4077-4099 |
| `admissions_case_meetings` | `admissionsCaseMeetings` | core | meeting logged on a case; soft-delete | [University Admissions](../../features/university-admissions.md) | [admissions](./erd-university-admissions.md) | 4101-4114 |
| `admissions_college_list_items` | `admissionsCollegeListItems` | core | college on one case's list; `unit_id` is a soft IPEDS reference, never an FK; soft-delete | [University Admissions](../../features/university-admissions.md) | [admissions](./erd-university-admissions.md) | 4116-4143 |
| `admissions_college_research` | `admissionsCollegeResearch` | core | college list item (unique `list_item_id`) — its research notes and 1-5 fit rating (check-constrained) | [University Admissions](../../features/university-admissions.md) | [admissions](./erd-university-admissions.md) | 4145-4164 |
| `admissions_interest_events` | `admissionsInterestEvents` | core | demonstrated-interest event on a list item; soft-delete | [University Admissions](../../features/university-admissions.md) | [admissions](./erd-university-admissions.md) | 4166-4178 |
| `admissions_college_requirements` | `admissionsCollegeRequirements` | core | requirement item on a list item (owner + status + due date); soft-delete | [University Admissions](../../features/university-admissions.md) | [admissions](./erd-university-admissions.md) | 4180-4200 |
| `admissions_financial_aid_offers` | `admissionsFinancialAidOffers` | core | list item (unique `list_item_id`) — its cost/gift-aid/loan breakdown | [University Admissions](../../features/university-admissions.md) | [admissions](./erd-university-admissions.md) | 4202-4218 |
| `admissions_scholarships` | `admissionsScholarships` | core | scholarship tracked on a case, optionally tied to a list item; soft-delete | [University Admissions](../../features/university-admissions.md) | [admissions](./erd-university-admissions.md) | 4220-4239 |
| `admissions_application_events` | `admissionsApplicationEvents` | core | decision/status event on a list item (submitted, deferred, accepted, …) | [University Admissions](../../features/university-admissions.md) | [admissions](./erd-university-admissions.md) | 4241-4251 |
| `admissions_recommenders` | `admissionsRecommenders` | core | recommender on a case; soft-delete | [University Admissions](../../features/university-admissions.md) | [admissions](./erd-university-admissions.md) | 4253-4265 |
| `admissions_recommender_colleges` | `admissionsRecommenderColleges` | core | unique (`recommender_id`, `list_item_id`) — per-college submission state | [University Admissions](../../features/university-admissions.md) | [admissions](./erd-university-admissions.md) | 4267-4278 |
| `admissions_college_docs` | `admissionsCollegeDocs` | core | document row for a list item (transcript, scores, …); indexed by (`list_item_id`, `doc_type`), not unique | [University Admissions](../../features/university-admissions.md) | [admissions](./erd-university-admissions.md) | 4280-4291 |
| `admissions_essays` | `admissionsEssays` | core | essay on a case, optionally scoped to a list item; soft-delete | [University Admissions](../../features/university-admissions.md) | [admissions](./erd-university-admissions.md) | 4293-4309 |
| `admissions_essay_prompt_catalog` | `admissionsEssayPromptCatalog` | core | unique (`institution`, `program`, `cycle`, `prompt_key`) — the reusable prompt library | [University Admissions](../../features/university-admissions.md) | [admissions](./erd-university-admissions.md) | 4311-4335 |
| `admissions_activities` | `admissionsActivities` | core | extracurricular activity on a case; soft-delete | [University Admissions](../../features/university-admissions.md) | [admissions](./erd-university-admissions.md) | 4337-4351 |
| `admissions_awards` | `admissionsAwards` | core | award/honor on a case; partial unique on (`case_id`, `common_app_rank`) among live rows, rank check-constrained 1-5 | [University Admissions](../../features/university-admissions.md) | [admissions](./erd-university-admissions.md) | 4353-4385 |
| `admissions_test_sittings` | `admissionsTestSittings` | core | test sitting on a case; raw scores stay staff-only until `score_released_to_parent` | [University Admissions](../../features/university-admissions.md) | [admissions](./erd-university-admissions.md) | 4387-4406 |
| `admissions_academic_records` | `admissionsAcademicRecords` | core | partial unique (`case_id`, `system`, `effective_date`) among live rows | [University Admissions](../../features/university-admissions.md) | [admissions](./erd-university-admissions.md) | 4408-4422 |
| `admissions_notes` | `admissionsNotes` | core | note on a case; `visibility` is NOT NULL **with no default**, forcing an explicit choice | [University Admissions](../../features/university-admissions.md) | [admissions](./erd-university-admissions.md) | 4424-4437 |
| `admissions_announcements` | `admissionsAnnouncements` | core | announcement; a check constraint enforces cohort-scoped XOR case-scoped | [University Admissions](../../features/university-admissions.md) | [admissions](./erd-university-admissions.md) | 4439-4457 |
| `admissions_resources` | `admissionsResources` | core | curated resource link under a topic; soft-delete | [University Admissions](../../features/university-admissions.md) | [admissions](./erd-university-admissions.md) | 4459-4470 |
| `admissions_self_report_sections` | `admissionsSelfReportSections` | core | unique (`case_id`, `section_key`) — the autosave upsert target for student self-report | [University Admissions](../../features/university-admissions.md) | [admissions](./erd-university-admissions.md) | 4472-4486 |
| `admissions_audit_log` | `admissionsAuditLog` | core | audited mutation with a field-level `diff`; append-only (`created_at` only) | [University Admissions](../../features/university-admissions.md) | [admissions](./erd-university-admissions.md) | 4488-4502 |
| `admissions_notification_log` | `admissionsNotificationLog` | core | email actually sent; partial unique on `dedupe_key` where non-null | [University Admissions](../../features/university-admissions.md) | [admissions](./erd-university-admissions.md) | 4504-4523 |
| `admissions_notification_outbox` | `admissionsNotificationOutbox` | core | queued notification (unique `dedupe_key`) with its retry schedule | [University Admissions](../../features/university-admissions.md) | [admissions](./erd-university-admissions.md) | 4525-4547 |
| `admissions_notification_runs` | `admissionsNotificationRuns` | core | daily/weekly digest run; single-running guard | [University Admissions](../../features/university-admissions.md) | [admissions](./erd-university-admissions.md) | 4549-4564 |
| `admissions_import_runs` | `admissionsImportRuns` | core | workbook import into one case — unique (`case_id`, `spreadsheet_id`, `source_fingerprint`) | [University Admissions](../../features/university-admissions.md) | [admissions](./erd-university-admissions.md) | 4566-4586 |
| `admissions_import_issues` | `admissionsImportIssues` | core | issue raised by one import run | [University Admissions](../../features/university-admissions.md) | [admissions](./erd-university-admissions.md) | 4588-4602 |
| `admissions_import_mappings` | `admissionsImportMappings` | core | unique (`run_id`, `source_type`, `source_key`) → the row it created or updated | [University Admissions](../../features/university-admissions.md) | [admissions](./erd-university-admissions.md) | 4604-4617 |
| `student_schedule_links` | `studentScheduleLinks` | core | issued capability token (unique `token_hash`; SHA-256 only, never the token) granting read of exactly one (`student_key`, `month_key`) | [Student Schedule](../../features/student-schedule.md) | [core](./erd-core.md) | 4627-4648 |
| `sales_dashboard_sources` | `salesDashboardSources` | sales-dashboard | source-month workbook; unique `source_month` while `archived_at IS NULL` | [Sales Dashboard](../../features/sales-dashboard.md) | [sales-dashboard](./erd-sales-dashboard.md) | 618-648 |
| `sales_dashboard_import_runs` | `salesDashboardImportRuns` | sales-dashboard | import attempt against a source; partial unique = one `running` per source | [Sales Dashboard](../../features/sales-dashboard.md) | [sales-dashboard](./erd-sales-dashboard.md) | 650-669 |
| `sales_dashboard_normal_rows` | `salesDashboardNormalRows` | sales-dashboard | parsed row of the `normal` tab — unique (`import_run_id`, `row_number`) | [Sales Dashboard](../../features/sales-dashboard.md) | [sales-dashboard](./erd-sales-dashboard.md) | 671-696 |
| `sales_dashboard_additional_rows` | `salesDashboardAdditionalRows` | sales-dashboard | parsed row of the `additional` tab — unique (`import_run_id`, `row_number`) | [Sales Dashboard](../../features/sales-dashboard.md) | [sales-dashboard](./erd-sales-dashboard.md) | 698-716 |
| `sales_dashboard_projection_sources` | `salesDashboardProjectionSources` | sales-dashboard | scenario-projection workbook; partial unique permits one `active` | [Sales Dashboard](../../features/sales-dashboard.md) | [sales-dashboard](./erd-sales-dashboard.md) | 718-741 |
| `sales_dashboard_projection_import_runs` | `salesDashboardProjectionImportRuns` | sales-dashboard | projection import attempt; one `running` per source | [Sales Dashboard](../../features/sales-dashboard.md) | [sales-dashboard](./erd-sales-dashboard.md) | 743-761 |
| `sales_dashboard_projection_months` | `salesDashboardProjectionMonths` | sales-dashboard | unique (`import_run_id`, `scenario`, `projection_month`) | [Sales Dashboard](../../features/sales-dashboard.md) | [sales-dashboard](./erd-sales-dashboard.md) | 763-791 |
| `credit_control_snapshots` | `creditControlSnapshots` | credit-control | credit-control snapshot on its own lineage; `active` marks the promoted one | [Credit Control](../../features/credit-control.md) | [credit-control](./erd-credit-control.md) | 1150-1160 |
| `credit_control_sync_runs` | `creditControlSyncRuns` | credit-control | credit-control sync attempt; single-running guard | [Credit Control](../../features/credit-control.md) | [credit-control](./erd-credit-control.md) | 1162-1180 |
| `credit_control_students` | `creditControlStudents` | credit-control | unique (`snapshot_id`, `wise_student_id`) | [Credit Control](../../features/credit-control.md) | [credit-control](./erd-credit-control.md) | 1182-1195 |
| `credit_control_packages` | `creditControlPackages` | credit-control | unique (`snapshot_id`, `wise_class_id`, `wise_student_id`) — one prepaid package holding | [Credit Control](../../features/credit-control.md) | [credit-control](./erd-credit-control.md) | 1197-1220 |
| `credit_control_sessions` | `creditControlSessions` | credit-control | unique (`snapshot_id`, `wise_session_id`, `wise_student_id`); an unresolved teacher stays null and renders "Teacher TBC" rather than being guessed | [Credit Control](../../features/credit-control.md) | [credit-control](./erd-credit-control.md) | 1222-1259 |
| `credit_control_credit_history` | `creditControlCreditHistory` | credit-control | unique (`snapshot_id`, `wise_credit_history_id`, `wise_student_id`, `wise_class_id`) | [Credit Control](../../features/credit-control.md) | [credit-control](./erd-credit-control.md) | 1261-1278 |
| `credit_control_follow_up_state` | `creditControlFollowUpState` | credit-control | `student_key` (PK) — current follow-up status; survives snapshot rotation | [Credit Control](../../features/credit-control.md) | [credit-control](./erd-credit-control.md) | 1280-1290 |
| `credit_control_follow_up_log` | `creditControlFollowUpLog` | credit-control | follow-up action event; append-only | [Credit Control](../../features/credit-control.md) | [credit-control](./erd-credit-control.md) | 1292-1305 |
| `credit_control_inactive_students` | `creditControlInactiveStudents` | credit-control | `student_key` (PK) marked inactive — `manual` or `auto-churn` | [Credit Control](../../features/credit-control.md) | [credit-control](./erd-credit-control.md) | 1307-1317 |
| `credit_control_zero_balance_tracking` | `creditControlZeroBalanceTracking` | credit-control | `student_key` (PK) continuously at ≤0 credits; the row is cleared on recovery | [Credit Control](../../features/credit-control.md) | [credit-control](./erd-credit-control.md) | 1322-1329 |
| `credit_control_admin_ownership` | `creditControlAdminOwnership` | credit-control | `student_key` (PK) → the owning admin | [Credit Control](../../features/credit-control.md) | [credit-control](./erd-credit-control.md) | 1331-1339 |
| `classroom_rooms` | `classroomRooms` | classrooms | bookable room (unique `name`) with capacity, TV flag, and category | [Classroom Assignments](../../features/classroom-assignments.md) | [classrooms](./erd-classrooms.md) | 1646-1659 |
| `classroom_assignment_runs` | `classroomAssignmentRuns` | classrooms | assignment run for one `assignment_date` against one snapshot | [Classroom Assignments](../../features/classroom-assignments.md) | [classrooms](./erd-classrooms.md) | 1661-1685 |
| `classroom_assignment_rows` | `classroomAssignmentRows` | classrooms | unique (`run_id`, `wise_session_id`) — the assigned room plus its rule trace | [Classroom Assignments](../../features/classroom-assignments.md) | [classrooms](./erd-classrooms.md) | 1687-1732 |
| `classroom_publish_jobs` | `classroomPublishJobs` | classrooms | publish job writing eligible rows' `location` back to Wise | [Classroom Assignments](../../features/classroom-assignments.md) | [classrooms](./erd-classrooms.md) | 1921-1941 |
| `classroom_automation_events` | `classroomAutomationEvents` | classrooms | event inside one automation batch (the reconciliation trace) | [Classroom Assignments](../../features/classroom-assignments.md) | [classrooms](./erd-classrooms.md) | 1943-1960 |
| `classroom_schedule_email_runs` | `classroomScheduleEmailRuns` | classrooms | tutor-schedule email send run for one assignment run | [Classroom Assignments](../../features/classroom-assignments.md) | [classrooms](./erd-classrooms.md) | 2018-2032 |
| `classroom_schedule_email_recipients` | `classroomScheduleEmailRecipients` | classrooms | tutor recipient inside a schedule email run | [Classroom Assignments](../../features/classroom-assignments.md) | [classrooms](./erd-classrooms.md) | 2034-2051 |
| `classroom_admin_email_runs` | `classroomAdminEmailRuns` | classrooms | admin notification email run (unique `idempotency_key`) | [Classroom Assignments](../../features/classroom-assignments.md) | [classrooms](./erd-classrooms.md) | 2053-2073 |
| `classroom_admin_email_recipients` | `classroomAdminEmailRecipients` | classrooms | recipient inside an admin email run | [Classroom Assignments](../../features/classroom-assignments.md) | [classrooms](./erd-classrooms.md) | 2075-2089 |
| `payroll_sync_runs` | `payrollSyncRuns` | payroll | payroll-month sync attempt; single-running guard across all months | [Payroll](../../features/payroll.md) | [payroll](./erd-payroll.md) | 1760-1778 |
| `payroll_reviews` | `payrollReviews` | payroll | payroll month (unique `payroll_month`) — its draft/approved review state | [Payroll](../../features/payroll.md) | [payroll](./erd-payroll.md) | 1780-1794 |
| `payroll_teacher_tiers` | `payrollTeacherTiers` | payroll | unique (`payroll_month`, `wise_teacher_id`) — the tier observed that month | [Payroll](../../features/payroll.md) | [payroll](./erd-payroll.md) | 1796-1810 |
| `payroll_payout_invoices` | `payrollPayoutInvoices` | payroll | Wise payout event (unique `event_id`) | [Payroll](../../features/payroll.md) | [payroll](./erd-payroll.md) | 1812-1838 |
| `payroll_session_observations` | `payrollSessionObservations` | payroll | unique (`payroll_month`, `wise_session_id`) — the taught-hours evidence | [Payroll](../../features/payroll.md) | [payroll](./erd-payroll.md) | 1840-1865 |
| `payroll_adjustments` | `payrollAdjustments` | payroll | manual correction entered against a payroll month | [Payroll](../../features/payroll.md) | [payroll](./erd-payroll.md) | 1867-1883 |
| `payroll_rate_card_versions` | `payrollRateCardVersions` | payroll | rate-card version; partial unique permits at most one `active` | [Payroll](../../features/payroll.md) | [payroll](./erd-payroll.md) | 1885-1900 |
| `payroll_rate_rules` | `payrollRateRules` | payroll | unique (`version_id`, `student_band`, `normalized_course_key`, `tier_key`) — one expected rate | [Payroll](../../features/payroll.md) | [payroll](./erd-payroll.md) | 1902-1919 |
| `tutor_contacts` | `tutorContacts` | tutor-profiles | tutor `canonical_key` (unique) — contact details and delivery-email overrides; not snapshot-scoped | [Tutor Profiles](../../features/tutor-profiles.md) | [tutor-profiles](./erd-tutor-profiles.md) | 1962-1980 |
| `tutor_business_profiles` | `tutorBusinessProfiles` | tutor-profiles | tutor `canonical_key` (PK) — editorial parent-safe summary, fit, tags | [Tutor Profiles](../../features/tutor-profiles.md) | [tutor-profiles](./erd-tutor-profiles.md) | 1982-2016 |
| `leave_request_sync_runs` | `leaveRequestSyncRuns` | leave-requests | Google-Sheet sync attempt; single-running guard | [Leave Requests](../../features/leave-requests.md) | [leave-requests](./erd-leave-requests.md) | 2093-2111 |
| `leave_requests` | `leaveRequests` | leave-requests | source sheet row — unique (`spreadsheet_id`, `sheet_name`, `source_row_number`) | [Leave Requests](../../features/leave-requests.md) | [leave-requests](./erd-leave-requests.md) | 2113-2169 |
| `leave_request_affected_sessions` | `leaveRequestAffectedSessions` | leave-requests | unique (`leave_request_id`, `wise_session_id`) the leave window overlaps | [Leave Requests](../../features/leave-requests.md) | [leave-requests](./erd-leave-requests.md) | 2171-2200 |
| `leave_request_activity_logs` | `leaveRequestActivityLogs` | leave-requests | action taken on a leave request; append-only | [Leave Requests](../../features/leave-requests.md) | [leave-requests](./erd-leave-requests.md) | 2202-2216 |
| `leave_request_notifications` | `leaveRequestNotifications` | leave-requests | outbound notification (unique `idempotency_key`) | [Leave Requests](../../features/leave-requests.md) | [leave-requests](./erd-leave-requests.md) | 2218-2234 |
| `proposal_bundles` | `proposalBundles` | ai-and-proposals | bundle of tentative holds offered to one student/parent (`student_label` is free text, not an FK) | [Proposals](../../features/proposals.md) | [ai-and-proposals](./erd-ai-and-proposals.md) | 2300-2310 |
| `proposal_items` | `proposalItems` | ai-and-proposals | held tutor slot inside a bundle; never written back to Wise | [Proposals](../../features/proposals.md) | [ai-and-proposals](./erd-ai-and-proposals.md) | 2312-2340 |
| `ai_scheduler_conversations` | `aiSchedulerConversations` | ai-and-proposals | scheduler chat workspace | [AI Scheduler](../../features/ai-scheduler.md) | [ai-and-proposals](./erd-ai-and-proposals.md) | 2344-2363 |
| `ai_scheduler_messages` | `aiSchedulerMessages` | ai-and-proposals | message in a conversation (`admin`/`parent`/`assistant`/`system`) | [AI Scheduler](../../features/ai-scheduler.md) | [ai-and-proposals](./erd-ai-and-proposals.md) | 2365-2381 |
| `ai_scheduler_runs` | `aiSchedulerRuns` | ai-and-proposals | one parse + solve run; `input_preview_redacted` is the only inbound text retained | [AI Scheduler](../../features/ai-scheduler.md) | [ai-and-proposals](./erd-ai-and-proposals.md) | 2383-2405 |
| `ai_scheduler_feedback` | `aiSchedulerFeedback` | ai-and-proposals | human accept/edit/reject action on a run, optionally tied to a LINE review | [AI Scheduler](../../features/ai-scheduler.md) | [ai-and-proposals](./erd-ai-and-proposals.md) | 2407-2430 |
| `line_contacts` | `lineContacts` | line | LINE user (unique `line_user_id`) | [LINE Integration](../../features/line-integration.md) | [line](./erd-line.md) | 2434-2450 |
| `line_threads` | `lineThreads` | line | LINE user's conversation (unique `line_user_id`), optionally bound to a scheduler chat | [LINE Integration](../../features/line-integration.md) | [line](./erd-line.md) | 2452-2466 |
| `line_messages` | `lineMessages` | line | LINE message (unique `webhook_event_id`, unique `line_message_id`) plus its classifier verdict | [LINE Integration](../../features/line-integration.md) | [line](./erd-line.md) | 2468-2501 |
| `line_contact_student_links` | `lineContactStudentLinks` | line | unique (`contact_id`, `student_key`) — suggested/verified/rejected identity link | [LINE Integration](../../features/line-integration.md) | [line](./erd-line.md) | 2503-2542 |
| `line_scheduler_reviews` | `lineSchedulerReviews` | line | inbound message routed to human review (unique `inbound_message_id`) | [LINE Integration](../../features/line-integration.md) | [line](./erd-line.md) | 2544-2591 |
| `line_wise_action_logs` | `lineWiseActionLogs` | line | proposed or executed Wise action from a review; `dry_run` defaults true | [LINE Integration](../../features/line-integration.md) | [line](./erd-line.md) | 2593-2608 |
| `line_oa_resolver_runs` | `lineOaResolverRuns` | line | resolver worklist session (unique `token_hash`, hash only) with an expiry | [LINE Integration](../../features/line-integration.md) | [line](./erd-line.md) | 2610-2634 |
| `line_oa_resolver_rows` | `lineOaResolverRows` | line | unique (`run_id`, `student_key`, `search_code`) — one lookup task | [LINE Integration](../../features/line-integration.md) | [line](./erd-line.md) | 2636-2661 |
| `line_backlog_recovery_sync_runs` | `lineBacklogRecoverySyncRuns` | line | follower backlog-recovery attempt; single-running guard | [LINE Integration](../../features/line-integration.md) | [line](./erd-line.md) | 2663-2681 |
| `line_schedule_bot_pending` | `lineScheduleBotPending` | line | pending confirm — unique (`line_user_id`, `scope_key`); `scope_key` is the group id, or the literal `"dm"` | [LINE Integration](../../features/line-integration.md) | [line](./erd-line.md) | 4660-4678 |
| `line_group_settings` | `lineGroupSettings` | line | LINE group id (PK) — its `audience` (`family` → Thai parent template, `staff` → English admin template); selects wording only, grants nothing | [LINE Integration](../../features/line-integration.md) | [line](./erd-line.md) | 4689-4696 |
| `line_group_schedule_sends` | `lineGroupScheduleSends` | line | schedule link delivered into a group; doubles as the "has this group seen this student?" confirm lookup | [LINE Integration](../../features/line-integration.md) | [line](./erd-line.md) | 4707-4719 |
| `room_capacity_model_runs` | `roomCapacityModelRuns` | room-capacity | imported forecast model run (unique `source_fingerprint`) | [Room Capacity](../../features/room-capacity.md) | [room-capacity](./erd-room-capacity.md) | 2726-2738 |
| `room_capacity_forecast_drivers` | `roomCapacityForecastDrivers` | room-capacity | model run × scenario × month — leads, revenue, hours, utilization | [Room Capacity](../../features/room-capacity.md) | [room-capacity](./erd-room-capacity.md) | 2740-2761 |
| `room_capacity_demand_mix` | `roomCapacityDemandMix` | room-capacity | session-shape bucket in a model run (weekday, start, duration, mode, size) | [Room Capacity](../../features/room-capacity.md) | [room-capacity](./erd-room-capacity.md) | 2763-2779 |
| `room_capacity_package_mix` | `roomCapacityPackageMix` | room-capacity | package-hour bucket in a model run — its share and average revenue | [Room Capacity](../../features/room-capacity.md) | [room-capacity](./erd-room-capacity.md) | 2781-2795 |

## Snapshot scoping

Exactly **13** tables carry a `snapshotId` column referencing `snapshots.id`, and are therefore
rewritten per ETL run:

`sync_runs` (both `snapshot_id` and `promoted_snapshot_id`) · `tutor_identity_groups` ·
`tutor_identity_group_members` · `tutors` · `raw_teacher_tags` · `subject_level_qualifications` ·
`recurring_availability_windows` · `dated_leaves` · `future_session_blocks` · `data_issues` ·
`snapshot_stats` · `classroom_assignment_runs` · `classroom_assignment_rows`
(`leave_request_affected_sessions` also references `snapshots.id`, but nullably — it pins the
snapshot a match was computed against rather than being scoped to it).

**Every other table is snapshot-independent** and survives snapshot rotation, either because it has
no snapshot lineage at all (`admin_users`, `google_oauth_tokens`, `tutor_aliases`, the whole
`admissions_*`, `competitor_*`, `ipeds_*`, `post_class_*`, `payroll_*`, `sales_dashboard_*`,
`room_capacity_*`, `line_*`, `leave_request*`, `proposal_*`, `ai_scheduler_*`, and
`progress_test_*` families) or because it is keyed by a durable natural key
(`past_session_blocks.wise_session_id`, `room_utilization_sessions.wise_session_id`, the five
credit-control sidecars keyed by `student_key`, the two tutor-profile tables keyed by
`canonical_key`). The credit-control tables carry a `snapshot_id`, but to
`credit_control_snapshots` — an independent lineage, not the Wise ETL one.

Three deviations are documented in the schema itself and worth knowing: `past_session_blocks`
(`schema.ts:2236-2254`) and the progress-test pair (`schema.ts:2797-2811`) both store a nullable,
**non-FK** `*_snapshot_id` for provenance so snapshots can be pruned without cascading.

## Where the rest of the detail lives

- **Columns, types, defaults, indexes, check constraints** — [`src/lib/db/schema.ts`](../../../src/lib/db/schema.ts), at the line ranges in the table above. That file is the source of truth; nothing else restates it.
- **Enum value sets** — [`enums.md`](./enums.md).
- **Relationships and diagrams** — the `erd-*.md` page named in the ERD column.
- **Migrations** — [`drizzle/`](../../../drizzle), applied with `npm run db:migrate`.
- **Feature meaning, rules, and flows** — [`docs/features/`](../../features/).
- **Endpoint mechanics** — [`docs/reference/api/index.md`](../api/index.md).

_Verified against HEAD + uncommitted WIP on 2026-05-31._
