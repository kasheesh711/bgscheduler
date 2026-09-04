# Database Reference — Master Table Index

The canonical lookup for every table in the BGScheduler Postgres database: **203 tables**, declared in
[`src/lib/db/schema.ts`](../../../src/lib/db/schema.ts) (5,198 lines, Drizzle ORM) and migrated under
[`drizzle/`](../../../drizzle) (74 `.sql` files, latest `0073_funny_ego.sql`). The
count is mechanical: `grep -c '= pgTable(' src/lib/db/schema.ts` → **203**.
The 61 Postgres enum types those tables bind live in [`enums.md`](./enums.md).

This page answers one question per row: **what is this table, what is exactly one row of it, and who
owns it**. It is a directory, not a column dump — the line range under each SQL name points into
`schema.ts`, which stays authoritative for columns, types, defaults, indexes and check constraints.
Relationship diagrams live on the `erd-*.md` page named in the last column; feature meaning, rules
and flows live under [`docs/features/`](../../features/).

## Domains

Twenty domains, one per `erd-*.md` page, so the last column of the big table is never ambiguous:
each table is documented on exactly one diagram page.

| Domain | Tables | ERD page |
|---|---:|---|
| `core` | 23 | [erd-core.md](./erd-core.md) — four numbered sections, linked per row below |
| `university-admissions` | 36 | [erd-university-admissions.md](./erd-university-admissions.md) — four numbered sections |
| `post-class-feedback` | 32 | [erd-post-class-feedback.md](./erd-post-class-feedback.md) — six named sections |
| `competitor-intelligence` | 16 | [erd-competitor-intelligence.md](./erd-competitor-intelligence.md) |
| `line` | 13 | [erd-line.md](./erd-line.md) |
| `credit-control` | 11 | [erd-credit-control.md](./erd-credit-control.md) |
| `unearned-revenue` | 9 | [erd-unearned-revenue.md](./erd-unearned-revenue.md) |
| `classrooms` | 9 | [erd-classrooms.md](./erd-classrooms.md) |
| `payroll` | 8 | [erd-payroll.md](./erd-payroll.md) |
| `progress-tests` | 8 | [erd-progress-tests.md](./erd-progress-tests.md) |
| `sales-dashboard` | 7 | [erd-sales-dashboard.md](./erd-sales-dashboard.md) |
| `ai-and-proposals` | 6 | [erd-ai-and-proposals.md](./erd-ai-and-proposals.md) |
| `student-promotions` | 6 | [erd-student-promotions.md](./erd-student-promotions.md) |
| `leave-requests` | 5 | [erd-leave-requests.md](./erd-leave-requests.md) |
| `room-capacity` | 4 | [erd-room-capacity.md](./erd-room-capacity.md) |
| `onsite-foot-traffic` | 4 | [erd-onsite-foot-traffic.md](./erd-onsite-foot-traffic.md) |
| `tutor-profiles` | 2 | [erd-tutor-profiles.md](./erd-tutor-profiles.md) |
| `wise-activity` | 2 | [erd-wise-activity.md](./erd-wise-activity.md) |
| `learning-plans` | 1 | [erd-learning-plans.md](./erd-learning-plans.md) |
| `student-schedule` | 1 | [erd-student-schedule.md](./erd-student-schedule.md) |
| **Total** | **203** | |

> **`core` now means 23 tables, not 124.** Earlier revisions of this index used ten domain labels and
> credited `core` with everything that had no page of its own. Eight of those sub-areas — post-class
> feedback, university admissions, competitor intelligence, progress tests, student promotions, Wise
> activity, student schedule, learning plans — were split onto their own diagram pages, taking 102
> tables with them (`erd-core.md`, "Moved"). The `core` allocation here matches the post-split page:
> the ETL spine, the sign-in allowlist and Google token store, the snapshot-scoped tutor and
> normalization tables, the two cross-snapshot exceptions, the room-utilization mirror, the two ETL
> self-report tables, and the read-only IPEDS dataset.

### What is inside `core`

Sectioned exactly as [`erd-core.md`](./erd-core.md) is:

| § | Sub-area | Tables |
|---|---|---:|
| [1](./erd-core.md#1-snapshot--sync-control-plane-and-cron-observability-4-tables) | Snapshot & sync control plane and cron observability | 4 |
| [2](./erd-core.md#2-auth--access-2-tables) | Auth & access | 2 |
| [3](./erd-core.md#3-tutor-identity-normalization-session-blocks--data-health-13-tables) | Tutor identity, normalization, session blocks, availability cache & data health | 14 |
| [4](./erd-core.md#4-us-universities--ipeds-3-tables) | US universities / IPEDS | 3 |
| | **Total** | **23** |

## How to read this table

- **Table** is the SQL name — the first argument to `pgTable` — with its `src/lib/db/schema.ts` line
  range underneath. That range is the citation for every claim in the row.
- **Line range convention.** The range is the `pgTable(...)` **declaration itself**: the
  `export const` line through its closing `);`. It deliberately excludes the JSDoc or `//` comment
  block that precedes the *next* declaration. Several sibling `erd-*.md` pages instead print the
  declaration line through the line before the next declaration, which sweeps that comment in — see
  [Open questions](#open-questions).
- **Const** is the exported Drizzle constant, i.e. what application code imports from
  `@/lib/db/schema`.
- **Grain** states what exactly one row is. Where a `uniqueIndex` or a natural-key primary key
  enforces the grain, the cell names it — that index *is* the evidence. Where nothing enforces it,
  the cell says **conventional**: the grain is held by write-path code, not by the database.
- **Owning feature** names the subsystem that writes the table; the [legend](#owning-feature-legend)
  maps each to its `src/lib/` directory and its feature doc. It is an attribution, not a constraint —
  a few tables have more than one writer.
- **ERD** links to the page that documents the table's relationships, and to the numbered section
  where the page has one.

Three structural patterns recur often enough to state once, so the grain cells need not repeat them:

- **Snapshot-scoped.** Fourteen tables hold a foreign key to `snapshots.id` (15 references —
  `sync_runs` points at both `snapshot_id` and `promoted_snapshot_id`). Ten are the ETL output
  proper, rewritten under each new snapshot id and read only where `snapshots.active = true`;
  `pruneOldSnapshots` deletes exactly those ten, nullifies the two `sync_runs` pointers, then deletes
  the `snapshots` row once it falls outside the newest `SNAPSHOT_RETENTION_COUNT = 30`
  (`src/lib/sync/snapshot-pruning.ts:5,88-179`). The other three —
  `classroom_assignment_runs`, `classroom_assignment_rows`, `leave_request_affected_sessions` — *pin*
  the snapshot they read and then persist independently.
- **Snapshot-independent.** Most tables are keyed by a durable natural key (an email, a `student_key`,
  a `canonical_key`, an `enrollment_key`, a `wise_session_id`, a `group_id`) and survive rotation on
  purpose. `past_session_blocks` carries that intent in the schema comment: it is the one
  cross-snapshot tutor data table, and first-observation-wins — a later retroactive cancellation does
  not rewrite a captured row (`schema.ts:2239-2257`).
- **Single-flight in Postgres.** Fourteen run ledgers enforce concurrency with a partial
  `uniqueIndex(...).where(status = 'running')`, so the guard lives in the database rather than in
  application code. Eleven are globally single-flight; three are scoped — `sales_dashboard_import_runs`
  and `sales_dashboard_projection_import_runs` allow one running run *per source*, and
  `ipeds_import_runs` one *per data year* (`schema.ts:475,569,668,760,866,1179,1778,2112,2682,2997,3021,3248,4570,5134`).

## Owning-feature legend

The `src/lib/` column is a code fact — the directory whose write paths touch the tables attributed to
that feature. The feature doc carries the rules and the why.

| Owning feature | Writes from | Feature doc |
|---|---|---|
| Tutor Search | `src/lib/sync/`, `src/lib/normalization/`, `src/lib/search/` | [tutor-search.md](../../features/tutor-search.md) |
| Tutor Compare | `src/lib/sync/past-sessions-diff-hook.ts` | [tutor-compare.md](../../features/tutor-compare.md) |
| Tutor Profiles | `src/lib/tutor-business-profiles.ts`, `src/lib/tutor-profile-import.ts` | [tutor-profiles.md](../../features/tutor-profiles.md) |
| Classroom Assignments | `src/lib/classrooms/` | [classroom-assignments.md](../../features/classroom-assignments.md) |
| Room Capacity | `src/lib/room-capacity/` | [room-capacity.md](../../features/room-capacity.md) |
| Onsite Foot Traffic | `src/lib/onsite-foot-traffic/` | [onsite-foot-traffic.md](../../features/onsite-foot-traffic.md) |
| Sales Dashboard | `src/lib/sales-dashboard/` | [sales-dashboard.md](../../features/sales-dashboard.md) |
| Credit Control | `src/lib/credit-control/` | [credit-control.md](../../features/credit-control.md) |
| Unearned Revenue | `src/lib/unearned-revenue/` | [unearned-revenue.md](../../features/unearned-revenue.md) |
| Payroll | `src/lib/payroll/` | [payroll.md](../../features/payroll.md) |
| Wise Activity Audit | `src/lib/wise-activity/` | [wise-activity-audit.md](../../features/wise-activity-audit.md) |
| Post-Class Feedback | `src/lib/post-class-feedback/` | [post-class-feedback.md](../../features/post-class-feedback.md) |
| Post-Class Payout | `src/lib/post-class-feedback/` (payout writer) | [post-class-payout.md](../../features/post-class-payout.md) |
| Learning Plans | `src/lib/learning-plans/access.ts` | [learning-plans.md](../../features/learning-plans.md) |
| Student Promotions | `src/lib/student-promotions/` | [student-promotions.md](../../features/student-promotions.md) |
| LINE Integration | `src/lib/line/` | [line-integration.md](../../features/line-integration.md) |
| LINE Credit Bot | `src/lib/line/credit-bot.ts`, `src/lib/line/credit-digest.ts` | [line-credit-bot.md](../../features/line-credit-bot.md) |
| Proposals | `src/lib/proposals/` | [proposals.md](../../features/proposals.md) |
| AI Scheduler | `src/lib/ai/` | [ai-scheduler.md](../../features/ai-scheduler.md) |
| Data Health | `src/lib/data-health/`, `src/lib/sync/` | [data-health.md](../../features/data-health.md) |
| Leave Requests | `src/lib/leave-requests/` | [leave-requests.md](../../features/leave-requests.md) |
| Student Schedule | `src/lib/student-schedule/`, `src/lib/line/schedule-bot*.ts` | [student-schedule.md](../../features/student-schedule.md) |
| University Admissions | `src/lib/admissions/` | [university-admissions.md](../../features/university-admissions.md) |
| Progress Tests | `src/lib/progress-tests/` | [progress-tests.md](../../features/progress-tests.md) |
| Competitor Intelligence | `src/lib/competitor-intelligence/` | [competitor-intelligence.md](../../features/competitor-intelligence.md) |
| US Universities | `src/lib/us-universities/` | [us-universities.md](../../features/us-universities.md) |
| Platform auth | `src/lib/auth.ts`, `src/lib/auth-access.ts`, `src/lib/db/seed.ts` | cross-cutting — [handbook/architecture.md](../../handbook/architecture.md) |

## All 203 tables

Ordered by domain (the [Domains](#domains) order, `core` first), then by declaration order in
`src/lib/db/schema.ts`.

| Table | Const | Domain | Grain — one row per… | Owning feature | ERD |
|---|---|---|---|---|---|
| `snapshots`<br><sub>456–460</sub> | `snapshots` | core | Immutable Wise ETL snapshot. `active = true` marks the single snapshot readers see. The only constraint is the `id` primary key — nothing enforces at-most-one active; that invariant lives in the promotion `UPDATE`. | Tutor Search | [core §1][c1] |
| `sync_runs`<br><sub>462–477</sub> | `syncRuns` | core | `runFullSync()` attempt. `sync_runs_single_running_idx` (partial unique on `status`) allows one `running` row. Points at both the candidate `snapshot_id` and the `promoted_snapshot_id`. | Tutor Search | [core §1][c1] |
| `cron_invocations`<br><sub>479–499</sub> | `cronInvocations` | core | HTTP invocation of a registered cron job (`job_key`, `received_at`, `trigger_source`), manual triggers included; `linked_run_ids` ties it to the domain run it started. No unique index — invocations accumulate. | Data Health | [core §1][c1] |
| `cron_alert_state`<br><sub>505–514</sub> | `cronAlertState` | core | Cron job the watchdog has alerted on — PK `job_key`, so exactly one row per job. `episode_key` dedupes the failure episode; `last_alert_outcome = "recovered"` re-arms it. | Data Health | [core §1][c1] |
| `admin_users`<br><sub>575–585</sub> | `adminUsers` | core | Allowlisted sign-in email (unique `admin_users_email_idx`). `allowed_pages` null = full access; non-null restricts to those route prefixes. | Platform auth | [core §2][c2] |
| `google_oauth_tokens`<br><sub>587–597</sub> | `googleOAuthTokens` | core | Connected Google account — PK `email`. Holds the encrypted access/refresh pair, scope, and last token error; shared by every Sheets-backed subsystem. | Platform auth | [core §2][c2] |
| `tutor_identity_groups`<br><sub>1519–1528</sub> | `tutorIdentityGroups` | core | Resolved tutor identity inside one snapshot (`snapshot_id` + `canonical_key`). Conventional — the declaration adds no unique index. | Tutor Search | [core §3][c3] |
| `wise_teacher_availability_cache`<br><sub>1558–1567</sub> | `wiseTeacherAvailabilityCache` | core | Cross-snapshot cache of the expensive far-leave window, keyed by Wise teacher user ID. A cache miss/error always falls back to a live fetch. | Tutor Search | [core §3][c3] |
| `tutor_identity_group_members`<br><sub>1530–1541</sub> | `tutorIdentityGroupMembers` | core | Wise teacher record attached to an identity group in one snapshot; `is_online_variant` marks the online twin. Conventional. | Tutor Search | [core §3][c3] |
| `tutor_aliases`<br><sub>1543–1550</sub> | `tutorAliases` | core | Alias redirect `from_key` → `to_key` (unique `from_key`). Snapshot-independent curated input — step 2 of the identity cascade. | Tutor Search | [core §3][c3] |
| `tutors`<br><sub>1552–1561</sub> | `tutors` | core | Denormalized tutor row per identity group per snapshot, carrying `supported_modes`. Conventional. | Tutor Search | [core §3][c3] |
| `raw_teacher_tags`<br><sub>1565–1574</sub> | `rawTeacherTags` | core | Raw Wise tag observed on one teacher record in one snapshot — the unparsed input to qualification parsing. Conventional. | Tutor Search | [core §3][c3] |
| `subject_level_qualifications`<br><sub>1576–1588</sub> | `subjectLevelQualifications` | core | Parsed subject / curriculum / level / exam-prep qualification for one group in one snapshot; `source_tag` keeps the provenance. Conventional. | Tutor Search | [core §3][c3] |
| `recurring_availability_windows`<br><sub>1592–1604</sub> | `recurringAvailabilityWindows` | core | Merged weekday window (`weekday`, `start_minute`, `end_minute`) for one group in one snapshot, with its `modality`. Conventional. | Tutor Search | [core §3][c3] |
| `dated_leaves`<br><sub>1606–1616</sub> | `datedLeaves` | core | Bangkok-normalized leave interval for one group in one snapshot; overlaps already merged upstream. Conventional. | Tutor Search | [core §3][c3] |
| `future_session_blocks`<br><sub>1618–1645</sub> | `futureSessionBlocks` | core | Future Wise session for one group in one snapshot, carrying the raw `wise_status` beside the fail-closed `is_blocking` verdict. Conventional. | Tutor Search | [core §3][c3] |
| `room_utilization_sessions`<br><sub>1739–1759</sub> | `roomUtilizationSessions` | core | Observed Wise session, deduped on `wise_session_id` (unique). Snapshot-independent history feeding room utilization. | Room Capacity | [core §3][c3] |
| `past_session_blocks`<br><sub>2258–2297</sub> | `pastSessionBlocks` | core | Captured past session (unique `wise_session_id`). The sole cross-snapshot tutor table; read by `group_canonical_key`, and `captured_in_snapshot_id` is a plain uuid, not an FK, so pruning cannot cascade into it. | Tutor Compare | [core §3][c3] |
| `data_issues`<br><sub>2688–2702</sub> | `dataIssues` | core | Normalization issue emitted during one snapshot's sync (`type`, `severity`, offending entity). Conventional. | Data Health | [core §3][c3] |
| `snapshot_stats`<br><sub>2706–2722</sub> | `snapshotStats` | core | Roll-up counters for one snapshot — unique `snapshot_id`, so exactly one row per snapshot: teacher totals, resolved vs unresolved groups, issues by type. | Data Health | [core §3][c3] |
| `ipeds_import_runs`<br><sub>3007–3022</sub> | `ipedsImportRuns` | core | Offline IPEDS import for a `data_year`; the partial unique is on `data_year` where `status = 'running'`, so imports for different years may run concurrently. | US Universities | [core §4][c4] |
| `ipeds_institutions`<br><sub>3024–3116</sub> | `ipedsInstitutions` | core | Institution per IPEDS release year (unique `data_year` + `unit_id`), so a new release drops in beside the old one without a migration. | US Universities | [core §4][c4] |
| `ipeds_completions`<br><sub>3118–3133</sub> | `ipedsCompletions` | core | CIP code × award level completion count for one institution-year. Conventional — three plain indexes, no unique. | US Universities | [core §4][c4] |
| `admissions_cohorts`<br><sub>3965–3974</sub> | `admissionsCohorts` | university-admissions | Graduating-year cohort (unique `name`). | University Admissions | [admissions §1][a1] |
| `admissions_students`<br><sub>3976–3993</sub> | `admissionsStudents` | university-admissions | Student profile, soft-deleted via `deleted_at`. `wise_student_key` is a plain soft-reference column, never an FK into Wise or snapshot tables. Conventional. | University Admissions | [admissions §1][a1] |
| `admissions_cases`<br><sub>3995–4018</sub> | `admissionsCases` | university-admissions | Counseling case. A partial unique on `student_id` where `status IN ('active','committed')` keeps at most one live case per student while closed cases accumulate. | University Admissions | [admissions §1][a1] |
| `admissions_case_members`<br><sub>4020–4044</sub> | `admissionsCaseMembers` | university-admissions | Email's membership and role on a case (unique `case_id` + `email`) — the row every request re-checks. | University Admissions | [admissions §1][a1] |
| `admissions_counselors`<br><sub>4046–4055</sub> | `admissionsCounselors` | university-admissions | Counselor (unique `email`), with an `active` toggle. | University Admissions | [admissions §1][a1] |
| `admissions_checklist_templates`<br><sub>4057–4067</sub> | `admissionsChecklistTemplates` | university-admissions | Published checklist version for a cohort (unique `cohort_id` + `version`). | University Admissions | [admissions §1][a1] |
| `admissions_template_items`<br><sub>4069–4083</sub> | `admissionsTemplateItems` | university-admissions | Checklist item inside a template version, ordered by `sort_order`. Conventional. | University Admissions | [admissions §1][a1] |
| `admissions_case_tasks`<br><sub>4085–4107</sub> | `admissionsCaseTasks` | university-admissions | Checklist task materialized onto a case, pinned to the `template_version` it came from; soft-deleted. Conventional. | University Admissions | [admissions §1][a1] |
| `admissions_case_meetings`<br><sub>4109–4122</sub> | `admissionsCaseMeetings` | university-admissions | Meeting on a case, soft-deleted. Conventional. | University Admissions | [admissions §1][a1] |
| `admissions_college_list_items`<br><sub>4124–4151</sub> | `admissionsCollegeListItems` | university-admissions | College on a case's list. `unit_id` soft-references `ipeds_institutions.unit_id` (never an FK) and `is_manual` covers colleges outside IPEDS. Conventional. | University Admissions | [admissions §2][a2] |
| `admissions_college_research`<br><sub>4153–4172</sub> | `admissionsCollegeResearch` | university-admissions | Research record for a list item — unique `list_item_id`, so at most one per college; a CHECK bounds `fit_rating` to 1–5 when set. | University Admissions | [admissions §2][a2] |
| `admissions_interest_events`<br><sub>4174–4186</sub> | `admissionsInterestEvents` | university-admissions | Demonstrated-interest event on a list item, soft-deleted. Conventional. | University Admissions | [admissions §2][a2] |
| `admissions_college_requirements`<br><sub>4188–4208</sub> | `admissionsCollegeRequirements` | university-admissions | Requirement item attached to a list item, with owner, due date and verification. Conventional. | University Admissions | [admissions §2][a2] |
| `admissions_financial_aid_offers`<br><sub>4210–4226</sub> | `admissionsFinancialAidOffers` | university-admissions | Aid offer for a list item (unique `list_item_id`), with cost / gift / loan breakdowns and net cost. | University Admissions | [admissions §2][a2] |
| `admissions_scholarships`<br><sub>4228–4247</sub> | `admissionsScholarships` | university-admissions | Scholarship a case is pursuing, optionally tied to a list item. Conventional. | University Admissions | [admissions §2][a2] |
| `admissions_application_events`<br><sub>4249–4259</sub> | `admissionsApplicationEvents` | university-admissions | Application or decision event on a list item — the decision chain. Conventional. | University Admissions | [admissions §2][a2] |
| `admissions_recommenders`<br><sub>4261–4273</sub> | `admissionsRecommenders` | university-admissions | Recommender on a case, with `ask_status`. Conventional. | University Admissions | [admissions §2][a2] |
| `admissions_recommender_colleges`<br><sub>4275–4286</sub> | `admissionsRecommenderColleges` | university-admissions | Recommender × college assignment (unique `recommender_id` + `list_item_id`) with its submitted flag. | University Admissions | [admissions §2][a2] |
| `admissions_college_docs`<br><sub>4288–4299</sub> | `admissionsCollegeDocs` | university-admissions | Document or score send for a list item, optionally pointing at a test sitting. Conventional. | University Admissions | [admissions §2][a2] |
| `admissions_essays`<br><sub>4301–4317</sub> | `admissionsEssays` | university-admissions | Essay on a case, optionally scoped to a college. Content lives in Drive — only `drive_url` and status are stored. Conventional. | University Admissions | [admissions §3][a3] |
| `admissions_essay_prompt_catalog`<br><sub>4319–4343</sub> | `admissionsEssayPromptCatalog` | university-admissions | Catalogued prompt (unique `institution` + `program` + `cycle` + `prompt_key`); a CHECK forces `word_limit` positive when set. | University Admissions | [admissions §3][a3] |
| `admissions_activities`<br><sub>4345–4359</sub> | `admissionsActivities` | university-admissions | Common App / UC activity on a case, ordered by `sort_order`. Conventional. | University Admissions | [admissions §3][a3] |
| `admissions_awards`<br><sub>4361–4393</sub> | `admissionsAwards` | university-admissions | Award on a case. Partial unique on (`case_id`, `common_app_rank`) among live, ranked rows; CHECKs bound the rank to 1–5 and cap the UC narratives at 250 and 350 characters. | University Admissions | [admissions §3][a3] |
| `admissions_test_sittings`<br><sub>4395–4414</sub> | `admissionsTestSittings` | university-admissions | Test sitting on a case; `score_released_to_parent` is the column that gates parent visibility of raw scores. Conventional. | University Admissions | [admissions §3][a3] |
| `admissions_academic_records`<br><sub>4416–4430</sub> | `admissionsAcademicRecords` | university-admissions | Academic record per case × `system` × `effective_date` — partial unique among rows where `deleted_at IS NULL`, so a soft-deleted record does not block a replacement. | University Admissions | [admissions §3][a3] |
| `admissions_notes`<br><sub>4432–4445</sub> | `admissionsNotes` | university-admissions | Note on a case; `visibility` defaults to staff-only and is what per-item sharing flips. Conventional. | University Admissions | [admissions §4][a4] |
| `admissions_announcements`<br><sub>4447–4465</sub> | `admissionsAnnouncements` | university-admissions | Announcement scoped to exactly one target — a CHECK enforces `(cohort_id IS NULL) <> (case_id IS NULL)`, so cohort broadcast and case-scoped are mutually exclusive. | University Admissions | [admissions §4][a4] |
| `admissions_resources`<br><sub>4467–4478</sub> | `admissionsResources` | university-admissions | Curated resource link, grouped by `topic` and ordered by `sort_order`. Conventional. | University Admissions | [admissions §4][a4] |
| `admissions_self_report_sections`<br><sub>4480–4494</sub> | `admissionsSelfReportSections` | university-admissions | Student self-report section per case (unique `case_id` + `section_key`), with its submission state and family sharing flag. | University Admissions | [admissions §4][a4] |
| `admissions_audit_log`<br><sub>4496–4510</sub> | `admissionsAuditLog` | university-admissions | Append-only audit entry with a field-level `diff`, actor email and actor role. Conventional. | University Admissions | [admissions §4][a4] |
| `admissions_notification_log`<br><sub>4512–4531</sub> | `admissionsNotificationLog` | university-admissions | Sent notification; a partial unique on `dedupe_key` applies only where it is non-null, so un-deduped sends still record. | University Admissions | [admissions §4][a4] |
| `admissions_notification_outbox`<br><sub>4533–4555</sub> | `admissionsNotificationOutbox` | university-admissions | Queued notification (unique `dedupe_key`), with attempt count and `next_attempt_at` scheduling. | University Admissions | [admissions §4][a4] |
| `admissions_notification_runs`<br><sub>4557–4572</sub> | `admissionsNotificationRuns` | university-admissions | Notification cron run; partial unique on `status` enforces single-flight. | University Admissions | [admissions §4][a4] |
| `admissions_import_runs`<br><sub>4574–4594</sub> | `admissionsImportRuns` | university-admissions | Workbook import (unique `case_id` + `spreadsheet_id` + `source_fingerprint`), so re-importing byte-identical content cannot double-apply. | University Admissions | [admissions §4][a4] |
| `admissions_import_issues`<br><sub>4596–4610</sub> | `admissionsImportIssues` | university-admissions | Issue raised by an import run, with severity, source ref and resolution. Conventional. | University Admissions | [admissions §4][a4] |
| `admissions_import_mappings`<br><sub>4612–4625</sub> | `admissionsImportMappings` | university-admissions | Source-key → target-entity mapping made by an import run (unique `run_id` + `source_type` + `source_key`). | University Admissions | [admissions §4][a4] |
| `post_class_enforcement_windows`<br><sub>3141–3153</sub> | `postClassEnforcementWindows` | post-class-feedback | Enforcement-mode interval, open-ended until `ends_at` is set. `policy_effective_at` is the column that makes enforcement prospective. Conventional. | Post-Class Feedback | [post-class · config][p1] |
| `post_class_settings`<br><sub>3155–3169</sub> | `postClassSettings` | post-class-feedback | The settings singleton — PK `id` is text defaulting to `'default'`; `version` carries optimistic concurrency. | Post-Class Feedback | [post-class · config][p1] |
| `post_class_field_mappings`<br><sub>3171–3185</sub> | `postClassFieldMappings` | post-class-feedback | Wise form field mapped to a compliance key within one `mapping_version` (unique `mapping_version` + `field_key`). | Post-Class Feedback | [post-class · config][p1] |
| `post_class_access_grants`<br><sub>3187–3197</sub> | `postClassAccessGrants` | post-class-feedback | Email × capability grant (unique `email` + `capability`). | Post-Class Feedback | [post-class · config][p1] |
| `post_class_config_audit_log`<br><sub>3199–3212</sub> | `postClassConfigAuditLog` | post-class-feedback | Config change, with `before_value` / `after_value` jsonb. Append-only, conventional. | Post-Class Feedback | [post-class · config][p1] |
| `post_class_digest_recipients`<br><sub>3214–3224</sub> | `postClassDigestRecipients` | post-class-feedback | Digest recipient email (unique `email`), with an `enabled` toggle. | Post-Class Feedback | [post-class · config][p1] |
| `post_class_sync_runs`<br><sub>3226–3251</sub> | `postClassSyncRuns` | post-class-feedback | Evidence collection or backfill run over a `window_start`…`window_end`, carrying a resume `cursor`; partial unique on `status` enforces single-flight. | Post-Class Feedback | [post-class · evidence][p2] |
| `post_class_sessions`<br><sub>3253–3308</sub> | `postClassSessions` | post-class-feedback | Wise session under feedback policy (unique `wise_session_id`); holds eligibility, source/content/timing/deduction status, the deadline, and two filtered recovery indexes on `source_status_before` and `wise_deleted_at`. | Post-Class Feedback | [post-class · evidence][p2] |
| `post_class_session_participants`<br><sub>3310–3324</sub> | `postClassSessionParticipants` | post-class-feedback | Student on a session (unique `session_id` + `participant_key`), with credits consumed and billability. | Post-Class Feedback | [post-class · evidence][p2] |
| `post_class_feedback_versions`<br><sub>3326–3355</sub> | `postClassFeedbackVersions` | post-class-feedback | Immutable feedback submission version for a session (unique `session_id` + `version_key`), with `raw_char_count`, trust flags on the source timestamp, and per-field failures. | Post-Class Feedback | [post-class · evidence][p2] |
| `post_class_feedback_event_links`<br><sub>3357–3370</sub> | `postClassFeedbackEventLinks` | post-class-feedback | Wise activity event linked to a session's feedback (unique `session_id` + `wise_event_id`) — the timing evidence, and the domain's only outbound FK. | Post-Class Feedback | [post-class · evidence][p2] |
| `post_class_assessments`<br><sub>3372–3401</sub> | `postClassAssessments` | post-class-feedback | Policy evaluation of a session at a given policy + mapping version (unique `assessment_key`). | Post-Class Feedback | [post-class · evidence][p2] |
| `post_class_source_issues`<br><sub>3403–3423</sub> | `postClassSourceIssues` | post-class-feedback | Deduped source-data defect (unique `fingerprint`); `blocks_enforcement` defaults true — the fail-closed switch. | Post-Class Feedback | [post-class · evidence][p2] |
| `post_class_notification_runs`<br><sub>3425–3448</sub> | `postClassNotificationRuns` | post-class-feedback | Reminder or digest run of one `kind` (unique `idempotency_key`). | Post-Class Feedback | [post-class · notifications][p3] |
| `post_class_notification_deliveries`<br><sub>3450–3472</sub> | `postClassNotificationDeliveries` | post-class-feedback | Tutor-addressed email inside a run (unique `idempotency_key`), with `next_attempt_at` retry scheduling. | Post-Class Feedback | [post-class · notifications][p3] |
| `post_class_notification_items`<br><sub>3474–3485</sub> | `postClassNotificationItems` | post-class-feedback | Session listed inside one delivery (unique `delivery_id` + `session_id`). | Post-Class Feedback | [post-class · notifications][p3] |
| `post_class_notification_attempts`<br><sub>3487–3501</sub> | `postClassNotificationAttempts` | post-class-feedback | Provider send attempt for a delivery (unique `delivery_id` + `attempt_number`). | Post-Class Feedback | [post-class · notifications][p3] |
| `post_class_ai_runs`<br><sub>3503–3522</sub> | `postClassAiRuns` | post-class-feedback | AI review call on a feedback version (unique `request_hash`, so identical input never re-bills). | Post-Class Feedback | [post-class · AI][p4] |
| `post_class_ai_concerns`<br><sub>3524–3537</sub> | `postClassAiConcerns` | post-class-feedback | Concern dimension raised by one AI run (unique `run_id` + `dimension`). Advisory only — never a financial decision. | Post-Class Feedback | [post-class · AI][p4] |
| `post_class_ai_reviews`<br><sub>3539–3550</sub> | `postClassAiReviews` | post-class-feedback | Human decision on a concern; `expected_version` makes the write optimistic-concurrent. Conventional. | Post-Class Feedback | [post-class · AI][p4] |
| `post_class_finance_periods`<br><sub>3552–3568</sub> | `postClassFinancePeriods` | post-class-feedback | Calendar finance month (unique `month`) with open/closed state and the reason for each transition. | Post-Class Feedback | [post-class · finance][p5] |
| `post_class_deductions`<br><sub>3570–3592</sub> | `postClassDeductions` | post-class-feedback | Deduction against one session (unique `session_id`, so at most one), in minor currency units. | Post-Class Feedback | [post-class · finance][p5] |
| `post_class_deduction_actions`<br><sub>3594–3613</sub> | `postClassDeductionActions` | post-class-feedback | State transition on a deduction (unique `idempotency_key`); append-only `from_status` → `to_status` trail. | Post-Class Feedback | [post-class · finance][p5] |
| `post_class_deduction_offsets`<br><sub>3615–3630</sub> | `postClassDeductionOffsets` | post-class-feedback | Offsetting credit against a deduction — unique on `deduction_id` (at most one) *and* on `idempotency_key`. | Post-Class Feedback | [post-class · finance][p5] |
| `post_class_payout_runs`<br><sub>3639–3712</sub> | `postClassPayoutRuns` | post-class-feedback | Payout export window — unique on (`window_start`, `window_end`) and on `anchor_month`; `lease_token` + `lease_expires_at` serialize publishing, and CHECKs bound `csv_status` and `date_roll_status`. | Post-Class Payout | [post-class · payout][p6] |
| `post_class_payout_tutor_names`<br><sub>3722–3738</sub> | `postClassPayoutTutorNames` | post-class-feedback | Canonical tutor's ledger-name mapping — unique on `canonical_key`, on `primary_ledger_name`, and partially on a non-null `alternate_ledger_name`. | Post-Class Payout | [post-class · payout][p6] |
| `post_class_tutor_payout_sheets`<br><sub>3745–3759</sub> | `postClassTutorPayoutSheets` | post-class-feedback | Tutor's payout workbook/tab binding (unique `canonical_key`), carrying `spreadsheet_id`, `sheet_name` and `sheet_gid`. | Post-Class Payout | [post-class · payout][p6] |
| `post_class_payout_run_lines`<br><sub>3766–3821</sub> | `postClassPayoutRunLines` | post-class-feedback | Deduction line written into a payout sheet — unique on `idempotency_key`, `source_identity` and `row_signature`; CHECKs force `line_kind = 'deduction'` and `amount_minor < 0`. | Post-Class Payout | [post-class · payout][p6] |
| `post_class_payout_adjustments`<br><sub>3827–3865</sub> | `postClassPayoutAdjustments` | post-class-feedback | Waiver or reversal offsetting a payout line — unique on `idempotency_key`, `source_identity` and `row_signature`; CHECKs restrict `kind` to `waiver`/`reversal`, `status` to five values including terminal `superseded`, and force `amount_minor > 0`. | Post-Class Payout | [post-class · payout][p6] |
| `post_class_payout_exceptions`<br><sub>3868–3892</sub> | `postClassPayoutExceptions` | post-class-feedback | Payout exception needing a human — unique on `source_identity` and on `idempotency_key`; a CHECK restricts `status` to `open`/`resolved`. | Post-Class Payout | [post-class · payout][p6] |
| `post_class_payout_roll_runs`<br><sub>3895–3924</sub> | `postClassPayoutRollRuns` | post-class-feedback | Date-roll of the tutor workbooks for one payout run (unique `payout_run_id`), leased and `manifest_hash`-pinned; a CHECK bounds `status` to running/partial/completed/failed. | Post-Class Payout | [post-class · payout][p6] |
| `post_class_payout_roll_outcomes`<br><sub>3927–3957</sub> | `postClassPayoutRollOutcomes` | post-class-feedback | One workbook's outcome inside a roll run (unique `roll_run_id` + `workbook_id`), with before/after date serials; a CHECK bounds `status` to pending/already_target/verified/failed. | Post-Class Payout | [post-class · payout][p6] |
| `competitor_entities`<br><sub>795–814</sub> | `competitorEntities` | competitor-intelligence | Tracked competitor or adjacent entity (unique `slug`); `kind` and `confidence` record how it was discovered. | Competitor Intelligence | [competitor-intelligence][ci] |
| `competitor_sources`<br><sub>816–842</sub> | `competitorSources` | competitor-intelligence | Monitored source URL for an entity (unique `entity_id` + `source_type` + `url`), with provider, priority and reliability. | Competitor Intelligence | [competitor-intelligence][ci] |
| `competitor_sync_runs`<br><sub>844–869</sub> | `competitorSyncRuns` | competitor-intelligence | Collection run (weekly cron or manual); partial unique on `status` enforces single-flight. | Competitor Intelligence | [competitor-intelligence][ci] |
| `competitor_source_runs`<br><sub>871–894</sub> | `competitorSourceRuns` | competitor-intelligence | One source's fetch inside one sync run, with its vendor `usage_units` and `estimated_cost_usd`. Conventional (`sync_run_id` × `source_id`). | Competitor Intelligence | [competitor-intelligence][ci] |
| `competitor_evidence_items`<br><sub>896–927</sub> | `competitorEvidenceItems` | competitor-intelligence | Normalized evidence item, deduped on `item_key` (unique); scored by `impact_score` and `confidence`. | Competitor Intelligence | [competitor-intelligence][ci] |
| `competitor_assets`<br><sub>929–945</sub> | `competitorAssets` | competitor-intelligence | Stored media artifact for an evidence item (unique `storage_key`), with mime type, size and checksum. | Competitor Intelligence | [competitor-intelligence][ci] |
| `competitor_serp_keywords`<br><sub>947–966</sub> | `competitorSerpKeywords` | competitor-intelligence | Tracked keyword × language × location × device (unique), with approval state. | Competitor Intelligence | [competitor-intelligence][ci] |
| `competitor_serp_observations`<br><sub>968–994</sub> | `competitorSerpObservations` | competitor-intelligence | SERP result observed for a keyword at one time, deduped on `observation_key` (unique); `is_begifted` marks own-brand rows. | Competitor Intelligence | [competitor-intelligence][ci] |
| `competitor_ai_runs`<br><sub>996–1013</sub> | `competitorAiRuns` | competitor-intelligence | AI read-out call inside a sync run, tagged by `run_type` and `prompt_version`. Conventional. | Competitor Intelligence | [competitor-intelligence][ci] |
| `competitor_briefs`<br><sub>1015–1036</sub> | `competitorBriefs` | competitor-intelligence | Daily brief (unique `brief_date`), carrying the summary plus coverage, SEO-visibility and budget-usage scores. | Competitor Intelligence | [competitor-intelligence][ci] |
| `competitor_war_room_snapshots`<br><sub>1038–1061</sub> | `competitorWarRoomSnapshots` | competitor-intelligence | Weekly War Room snapshot (unique `week_start`), with its matrix, content angles and score drilldowns. | Competitor Intelligence | [competitor-intelligence][ci] |
| `competitor_task_suggestions`<br><sub>1063–1084</sub> | `competitorTaskSuggestions` | competitor-intelligence | AI-suggested response task awaiting human promotion; `accepted_task_id` records the promotion. Conventional. | Competitor Intelligence | [competitor-intelligence][ci] |
| `competitor_tasks`<br><sub>1086–1108</sub> | `competitorTasks` | competitor-intelligence | Tracked response task a human owns. Conventional. | Competitor Intelligence | [competitor-intelligence][ci] |
| `competitor_task_comments`<br><sub>1110–1119</sub> | `competitorTaskComments` | competitor-intelligence | Comment on a task, optionally carrying an attachment asset. Conventional. | Competitor Intelligence | [competitor-intelligence][ci] |
| `competitor_task_events`<br><sub>1121–1130</sub> | `competitorTaskEvents` | competitor-intelligence | Audit event on a task. Conventional. | Competitor Intelligence | [competitor-intelligence][ci] |
| `competitor_vendor_usage`<br><sub>1132–1146</sub> | `competitorVendorUsage` | competitor-intelligence | Month × provider × source-type usage accumulator (unique), carrying `hard_cap_usd` and the `capped` flag. | Competitor Intelligence | [competitor-intelligence][ci] |
| `line_contacts`<br><sub>2437–2453</sub> | `lineContacts` | line | LINE user (unique `line_user_id`) — the identity anchor the whole domain hangs off. | LINE Integration | [line][ln] |
| `line_threads`<br><sub>2455–2469</sub> | `lineThreads` | line | Conversation thread per LINE user (unique `line_user_id`), optionally bound to an AI-scheduler conversation. | LINE Integration | [line][ln] |
| `line_messages`<br><sub>2471–2504</sub> | `lineMessages` | line | Webhook message — unique on both `webhook_event_id` and `line_message_id`, so a redelivery cannot duplicate; carries the classifier verdict and its human review. | LINE Integration | [line][ln] |
| `line_contact_student_links`<br><sub>2506–2545</sub> | `lineContactStudentLinks` | line | Contact ↔ student link (unique `contact_id` + `student_key`) with confidence, evidence and review state; three further partial indexes serve the OA-resolver worklist. | LINE Integration | [line][ln] |
| `line_scheduler_reviews`<br><sub>2547–2594</sub> | `lineSchedulerReviews` | line | Review of one inbound message (unique `inbound_message_id`) — draft, proposed Wise actions, and the send outcome. | LINE Integration | [line][ln] |
| `line_wise_action_logs`<br><sub>2596–2611</sub> | `lineWiseActionLogs` | line | Wise action attempted from a review; `dry_run` is the flag gate. Conventional. | LINE Integration | [line][ln] |
| `line_oa_resolver_runs`<br><sub>2613–2637</sub> | `lineOaResolverRuns` | line | OA-resolver harvest run (unique `token_hash` — only the hash of the bearer token is stored, never the token). | LINE Integration | [line][ln] |
| `line_oa_resolver_rows`<br><sub>2639–2664</sub> | `lineOaResolverRows` | line | Student worklist row inside a resolver run (unique `run_id` + `student_key` + `search_code`). | LINE Integration | [line][ln] |
| `line_backlog_recovery_sync_runs`<br><sub>2666–2684</sub> | `lineBacklogRecoverySyncRuns` | line | Follower-backlog recovery run; partial unique on `status` enforces single-flight. | LINE Integration | [line][ln] |
| `line_schedule_bot_pending`<br><sub>4668–4686</sub> | `lineScheduleBotPending` | line | Pending schedule-bot confirmation per admin per scope (unique `line_user_id` + `scope_key`), where `scope_key` is a group id or the literal `"dm"` — so a group confirm and a DM confirm coexist. | Student Schedule | [line][ln] |
| `line_group_settings`<br><sub>4700–4722</sub> | `lineGroupSettings` | line | Registered LINE group chat — PK `group_id`. Holds `audience` (family/staff template), the `skip_confirm` instant mode, and the credit-digest opt-in; written by both bots. | LINE Integration | [line][ln] |
| `line_credit_digest_runs`<br><sub>4740–4758</sub> | `lineCreditDigestRuns` | line | Daily credit run-out digest — unique on both `digest_date` and `idempotency_key`. | LINE Credit Bot | [line][ln] |
| `line_group_schedule_sends`<br><sub>4760–4772</sub> | `lineGroupScheduleSends` | line | Schedule link posted into a group chat, pointing at the `student_schedule_links` row it delivered. Conventional. | Student Schedule | [line][ln] |
| `credit_control_snapshots`<br><sub>1150–1160</sub> | `creditControlSnapshots` | credit-control | Credit-control snapshot on a lineage entirely separate from the Wise scheduling `snapshots`; `active` marks the served one, with no constraint enforcing a single active row. | Credit Control | [credit-control][cc] |
| `credit_control_sync_runs`<br><sub>1162–1180</sub> | `creditControlSyncRuns` | credit-control | Credit-control sync; partial unique on `status` enforces single-flight. Holds both candidate and promoted snapshot ids as plain uuids. | Credit Control | [credit-control][cc] |
| `credit_control_students`<br><sub>1182–1195</sub> | `creditControlStudents` | credit-control | Wise student within one snapshot (unique `snapshot_id` + `wise_student_id`). | Credit Control | [credit-control][cc] |
| `credit_control_packages`<br><sub>1197–1220</sub> | `creditControlPackages` | credit-control | Class × student prepaid package within one snapshot (unique `snapshot_id` + `wise_class_id` + `wise_student_id`). | Credit Control | [credit-control][cc] |
| `credit_control_sessions`<br><sub>1222–1262</sub> | `creditControlSessions` | credit-control | Session × student row within one snapshot (unique `snapshot_id` + `wise_session_id` + `wise_student_id`). Also the source the Student Schedule calendar reads. | Credit Control | [credit-control][cc] |
| `credit_control_credit_history`<br><sub>1264–1281</sub> | `creditControlCreditHistory` | credit-control | Wise credit-history entry within one snapshot (unique on snapshot + history id + student + class). | Credit Control | [credit-control][cc] |
| `credit_control_follow_up_state`<br><sub>1283–1293</sub> | `creditControlFollowUpState` | credit-control | Student's current follow-up status — PK `student_key`; a snapshot-independent sidecar. | Credit Control | [credit-control][cc] |
| `credit_control_follow_up_log`<br><sub>1295–1308</sub> | `creditControlFollowUpLog` | credit-control | Follow-up action taken by a named admin — PK `event_id`, append-only. | Credit Control | [credit-control][cc] |
| `credit_control_inactive_students`<br><sub>1310–1320</sub> | `creditControlInactiveStudents` | credit-control | Student marked inactive — PK `student_key`, recording who marked it and the balance at removal. | Credit Control | [credit-control][cc] |
| `credit_control_zero_balance_tracking`<br><sub>1325–1332</sub> | `creditControlZeroBalanceTracking` | credit-control | Student's current zero-or-below credit streak — PK `student_key`, holding `zero_since` and `last_remaining`. | Credit Control | [credit-control][cc] |
| `credit_control_admin_ownership`<br><sub>1334–1342</sub> | `creditControlAdminOwnership` | credit-control | Student's owning admin — PK `student_key`. | Credit Control | [credit-control][cc] |
| `unearned_revenue_access_grants`<br><sub>4816–4827</sub> | `unearnedRevenueAccessGrants` | unearned-revenue | Normalized admin email × `viewer` or `access_manager` capability (unique). | Unearned Revenue | [unearned-revenue][ur] |
| `unearned_revenue_access_audit_log`<br><sub>4830–4843</sub> | `unearnedRevenueAccessAuditLog` | unearned-revenue | Immutable capability-matrix replacement with actor, before/after state, and optimistic-lock version. | Unearned Revenue | [unearned-revenue][ur] |
| `unearned_revenue_sync_runs`<br><sub>4846–4870</sub> | `unearnedRevenueSyncRuns` | unearned-revenue | Workbook import attempt; partial unique on `running` enforces single-flight. | Unearned Revenue | [unearned-revenue][ur] |
| `unearned_revenue_snapshots`<br><sub>4873–4902</sub> | `unearnedRevenueSnapshots` | unearned-revenue | Immutable QA-passed workbook header; source contract is unique and a partial index permits one active snapshot. | Unearned Revenue | [unearned-revenue][ur] |
| `unearned_revenue_periods`<br><sub>4905–4936</sub> | `unearnedRevenuePeriods` | unearned-revenue | Finance total per imported snapshot and reporting date, including model comparison, QA counts, and formula anchor. | Unearned Revenue | [unearned-revenue][ur] |
| `unearned_revenue_package_periods`<br><sub>4943–4976</sub> | `unearnedRevenuePackagePeriods` | unearned-revenue | Exact-package liability per snapshot/date and literal sales package, split by automatic and Finance-reviewed evidence. | Unearned Revenue | [unearned-revenue][ur] |
| `unearned_revenue_student_periods`<br><sub>4979–5009</sub> | `unearnedRevenueStudentPeriods` | unearned-revenue | Stable WISE student aggregate per snapshot and reporting date, across all class accounts. | Unearned Revenue | [unearned-revenue][ur] |
| `unearned_revenue_account_periods`<br><sub>5012–5043</sub> | `unearnedRevenueAccountPeriods` | unearned-revenue | Student/class account reconciliation per snapshot and reporting date. | Unearned Revenue | [unearned-revenue][ur] |
| `unearned_revenue_lot_periods`<br><sub>5046–5111</sub> | `unearnedRevenueLotPeriods` | unearned-revenue | Package-lot credit and THB roll-forward per snapshot/date, with versioned matching evidence and separate formula/source anchors. | Unearned Revenue | [unearned-revenue][ur] |
| `classroom_rooms`<br><sub>1649–1662</sub> | `classroomRooms` | classrooms | Physical room (unique `name`), with capacity, TV flag, category and sort order. | Classroom Assignments | [classrooms][cr] |
| `classroom_assignment_runs`<br><sub>1664–1688</sub> | `classroomAssignmentRuns` | classrooms | Assignment run for one Bangkok date, pinned to the snapshot it read. Append-only and conventional — runs accumulate per date and the newest wins on read. | Classroom Assignments | [classrooms][cr] |
| `classroom_assignment_rows`<br><sub>1690–1735</sub> | `classroomAssignmentRows` | classrooms | Wise session inside a run (unique `run_id` + `wise_session_id`), with assigned room, rule trace, `assignment_fingerprint` and publish status. | Classroom Assignments | [classrooms][cr] |
| `classroom_publish_jobs`<br><sub>1924–1944</sub> | `classroomPublishJobs` | classrooms | Publish job writing eligible `OFFLINE` rooms back to Wise for one run, with per-outcome counters. Conventional. | Classroom Assignments | [classrooms][cr] |
| `classroom_automation_events`<br><sub>1946–1963</sub> | `classroomAutomationEvents` | classrooms | Event emitted by one morning-automation batch (`automation_batch_id`). Conventional. | Classroom Assignments | [classrooms][cr] |
| `classroom_schedule_email_runs`<br><sub>2021–2035</sub> | `classroomScheduleEmailRuns` | classrooms | Per-tutor schedule email run for one assignment run. Conventional. | Classroom Assignments | [classrooms][cr] |
| `classroom_schedule_email_recipients`<br><sub>2037–2054</sub> | `classroomScheduleEmailRecipients` | classrooms | Tutor recipient inside a schedule email run, with the Resend message id. Conventional. | Classroom Assignments | [classrooms][cr] |
| `classroom_admin_email_runs`<br><sub>2056–2076</sub> | `classroomAdminEmailRuns` | classrooms | Admin notification for one date (unique `idempotency_key` — one send per date per trigger kind). | Classroom Assignments | [classrooms][cr] |
| `classroom_admin_email_recipients`<br><sub>2078–2092</sub> | `classroomAdminEmailRecipients` | classrooms | Admin recipient inside an admin email run. Conventional. | Classroom Assignments | [classrooms][cr] |
| `payroll_sync_runs`<br><sub>1763–1781</sub> | `payrollSyncRuns` | payroll | Payroll sync for one `payroll_month`; partial unique on `status` enforces single-flight across all months. | Payroll | [payroll][pr] |
| `payroll_reviews`<br><sub>1783–1797</sub> | `payrollReviews` | payroll | Review row for one `payroll_month` (unique), carrying approval state and approver. | Payroll | [payroll][pr] |
| `payroll_teacher_tiers`<br><sub>1799–1813</sub> | `payrollTeacherTiers` | payroll | Teacher's tier for one month (unique `payroll_month` + `wise_teacher_id`), raw and normalized. | Payroll | [payroll][pr] |
| `payroll_payout_invoices`<br><sub>1815–1841</sub> | `payrollPayoutInvoices` | payroll | Wise payout event (unique `event_id`) — what Wise actually paid, in both minor units and decimal. | Payroll | [payroll][pr] |
| `payroll_session_observations`<br><sub>1843–1868</sub> | `payrollSessionObservations` | payroll | Taught session in one month (unique `payroll_month` + `wise_session_id`) — what the tutor actually taught. | Payroll | [payroll][pr] |
| `payroll_adjustments`<br><sub>1870–1886</sub> | `payrollAdjustments` | payroll | Manual correction for one month, entered by a named admin. Conventional. | Payroll | [payroll][pr] |
| `payroll_rate_card_versions`<br><sub>1888–1903</sub> | `payrollRateCardVersions` | payroll | Rate-card version; a partial unique on `active` where `active = true` allows exactly one live card. | Payroll | [payroll][pr] |
| `payroll_rate_rules`<br><sub>1905–1922</sub> | `payrollRateRules` | payroll | Rate rule inside a card version (unique `version_id` + `student_band` + `normalized_course_key` + `tier_key`). | Payroll | [payroll][pr] |
| `progress_test_attendance_ledger`<br><sub>2815–2839</sub> | `progressTestAttendanceLedger` | progress-tests | Attended session per student (unique `wise_session_id` + `wise_student_id`). Survives credit-control snapshot rotation; `first_observed_snapshot_id` is a nullable non-FK uuid so snapshots can still be pruned. | Progress Tests | [progress-tests][pt] |
| `progress_test_cycle_state`<br><sub>2841–2875</sub> | `progressTestCycleState` | progress-tests | Student-subject enrollment's live cycle state — PK `enrollment_key`; holds the count, the status, the booked test and the most-frequent tutor. | Progress Tests | [progress-tests][pt] |
| `progress_test_bookings`<br><sub>2877–2898</sub> | `progressTestBookings` | progress-tests | Booking attempt for one enrollment cycle; `dry_run` separates preview from a real Wise write. Conventional. | Progress Tests | [progress-tests][pt] |
| `progress_test_email_runs`<br><sub>2900–2919</sub> | `progressTestEmailRuns` | progress-tests | Teacher heads-up email run for one enrollment cycle (unique `idempotency_key`). | Progress Tests | [progress-tests][pt] |
| `progress_test_notifications`<br><sub>2921–2938</sub> | `progressTestNotifications` | progress-tests | Notification delivery inside an email run (unique `idempotency_key`). | Progress Tests | [progress-tests][pt] |
| `progress_test_admin_digest_runs`<br><sub>2940–2960</sub> | `progressTestAdminDigestRuns` | progress-tests | Daily admin digest — unique on both `digest_date` and `idempotency_key`. | Progress Tests | [progress-tests][pt] |
| `progress_test_admin_digest_recipients`<br><sub>2962–2976</sub> | `progressTestAdminDigestRecipients` | progress-tests | Recipient of one digest run. Conventional. | Progress Tests | [progress-tests][pt] |
| `progress_test_sync_runs`<br><sub>2978–2998</sub> | `progressTestSyncRuns` | progress-tests | Counting/ingest run; partial unique on `status` enforces single-flight. | Progress Tests | [progress-tests][pt] |
| `sales_dashboard_sources`<br><sub>618–648</sub> | `salesDashboardSources` | sales-dashboard | Monthly sales workbook. A partial unique on `source_month` where `archived_at IS NULL` keeps one live source per Bangkok month while archives accumulate. | Sales Dashboard | [sales-dashboard][sd] |
| `sales_dashboard_import_runs`<br><sub>650–669</sub> | `salesDashboardImportRuns` | sales-dashboard | Import of one source; the partial unique is on `source_id`, so one `running` run *per source*. | Sales Dashboard | [sales-dashboard][sd] |
| `sales_dashboard_normal_rows`<br><sub>671–696</sub> | `salesDashboardNormalRows` | sales-dashboard | Parsed row of the "normal" sheet (unique `import_run_id` + `row_number`), keeping the `raw` cells beside the normalized fields. | Sales Dashboard | [sales-dashboard][sd] |
| `sales_dashboard_additional_rows`<br><sub>698–716</sub> | `salesDashboardAdditionalRows` | sales-dashboard | Parsed row of the "additional" sheet (unique `import_run_id` + `row_number`). | Sales Dashboard | [sales-dashboard][sd] |
| `sales_dashboard_projection_sources`<br><sub>718–741</sub> | `salesDashboardProjectionSources` | sales-dashboard | Scenario-projection workbook; a partial unique on `status` where `status = 'active'` allows exactly one active source. | Sales Dashboard | [sales-dashboard][sd] |
| `sales_dashboard_projection_import_runs`<br><sub>743–761</sub> | `salesDashboardProjectionImportRuns` | sales-dashboard | Projection import; partial unique on `source_id` allows one `running` run per source. | Sales Dashboard | [sales-dashboard][sd] |
| `sales_dashboard_projection_months`<br><sub>763–791</sub> | `salesDashboardProjectionMonths` | sales-dashboard | Scenario × projection month row (unique `import_run_id` + `scenario` + `projection_month`) — the Bear/Base/Bull grid. | Sales Dashboard | [sales-dashboard][sd] |
| `proposal_bundles`<br><sub>2303–2313</sub> | `proposalBundles` | ai-and-proposals | Parent proposal bundle created by an admin. Local-only — never written to Wise. Conventional. | Proposals | [ai-and-proposals][ap] |
| `proposal_items`<br><sub>2315–2343</sub> | `proposalItems` | ai-and-proposals | Held slot inside a bundle — recurring (`weekday`) or dated (`proposal_date`), with expiry, confirm and release timestamps. Conventional. | Proposals | [ai-and-proposals][ap] |
| `ai_scheduler_conversations`<br><sub>2347–2366</sub> | `aiSchedulerConversations` | ai-and-proposals | Pasted-chat conversation with its extracted customer state. Conventional. | AI Scheduler | [ai-and-proposals][ap] |
| `ai_scheduler_messages`<br><sub>2368–2384</sub> | `aiSchedulerMessages` | ai-and-proposals | Message in a conversation (user or assistant), with any structured payload. Conventional. | AI Scheduler | [ai-and-proposals][ap] |
| `ai_scheduler_runs`<br><sub>2386–2408</sub> | `aiSchedulerRuns` | ai-and-proposals | Model + deterministic-solver run behind one assistant message; `prompt_version` and `scheduler_version` pin reproducibility, and the input preview is stored redacted. Conventional. | AI Scheduler | [ai-and-proposals][ap] |
| `ai_scheduler_feedback`<br><sub>2410–2433</sub> | `aiSchedulerFeedback` | ai-and-proposals | Staff accept / edit / reject decision on one run — the eval signal. Conventional. | AI Scheduler | [ai-and-proposals][ap] |
| `student_promotion_runs`<br><sub>1346–1377</sub> | `studentPromotionRuns` | student-promotions | Promotion cycle for a `target_date`, moving through dry-run → verified → applied. Conventional — no unique on `target_date`, so re-runs accumulate. | Student Promotions | [student-promotions][sp] |
| `student_promotion_grade_actions`<br><sub>1379–1401</sub> | `studentPromotionGradeActions` | student-promotions | Student's grade action in one run (unique `run_id` + `wise_student_id`), with request/response payloads. | Student Promotions | [student-promotions][sp] |
| `student_promotion_course_actions`<br><sub>1403–1424</sub> | `studentPromotionCourseActions` | student-promotions | Class's course move in one run (unique `run_id` + `wise_class_id`). | Student Promotions | [student-promotions][sp] |
| `student_promotion_future_session_actions`<br><sub>1426–1451</sub> | `studentPromotionFutureSessionActions` | student-promotions | Future session retitled by a course move (unique `run_id` + `wise_session_id`). | Student Promotions | [student-promotions][sp] |
| `student_promotion_graduation_actions`<br><sub>1453–1474</sub> | `studentPromotionGraduationActions` | student-promotions | Graduating student's disposition in one run (unique `run_id` + `wise_student_id`), reviewed by a named human. | Student Promotions | [student-promotions][sp] |
| `student_promotion_pay_rate_impacts`<br><sub>1476–1515</sub> | `studentPromotionPayRateImpacts` | student-promotions | Tutor × class pay-band impact of a course move (unique `run_id` + `impact_key`), with before/after rate rules and the blocker reason. | Student Promotions | [student-promotions][sp] |
| `leave_request_sync_runs`<br><sub>2096–2114</sub> | `leaveRequestSyncRuns` | leave-requests | Google-Sheet ingest run; partial unique on `status` enforces single-flight. | Leave Requests | [leave-requests][lr] |
| `leave_requests`<br><sub>2116–2172</sub> | `leaveRequests` | leave-requests | Source sheet row (unique `spreadsheet_id` + `sheet_name` + `source_row_number`), carrying normalization, tutor match, workflow and sheet-writeback state in one wide row. | Leave Requests | [leave-requests][lr] |
| `leave_request_affected_sessions`<br><sub>2174–2203</sub> | `leaveRequestAffectedSessions` | leave-requests | Wise session overlapped by one leave window (unique `leave_request_id` + `wise_session_id`), with `overlap_minutes` and the cancel-preview selection. | Leave Requests | [leave-requests][lr] |
| `leave_request_activity_logs`<br><sub>2205–2219</sub> | `leaveRequestActivityLogs` | leave-requests | Action on a leave request, with request/response payloads. Append-only, conventional. | Leave Requests | [leave-requests][lr] |
| `leave_request_notifications`<br><sub>2221–2237</sub> | `leaveRequestNotifications` | leave-requests | Outbound notification (unique `idempotency_key`). | Leave Requests | [leave-requests][lr] |
| `room_capacity_model_runs`<br><sub>2729–2741</sub> | `roomCapacityModelRuns` | room-capacity | Offline forecast model run (unique `source_fingerprint`), holding only aggregates — the Vercel runtime never reads the source workbooks. | Room Capacity | [room-capacity][rc] |
| `room_capacity_forecast_drivers`<br><sub>2743–2764</sub> | `roomCapacityForecastDrivers` | room-capacity | Scenario × month driver row inside a model run: leads, conversion, revenue, capacity utilization. Conventional. | Room Capacity | [room-capacity][rc] |
| `room_capacity_demand_mix`<br><sub>2766–2782</sub> | `roomCapacityDemandMix` | room-capacity | Demand-mix bucket (weekday × start × duration × mode × subject) inside a model run, with its share. Conventional. | Room Capacity | [room-capacity][rc] |
| `room_capacity_package_mix`<br><sub>2784–2798</sub> | `roomCapacityPackageMix` | room-capacity | Package-hour bucket inside a model run, with average revenue and share. Conventional. | Room Capacity | [room-capacity][rc] |
| `onsite_foot_traffic_sync_runs`<br><sub>5116–5139</sub> | `onsiteFootTrafficSyncRuns` | onsite-foot-traffic | PAST-session reconciliation attempt; partial unique on `status = 'running'` enforces global single-flight. | Onsite Foot Traffic | [onsite-foot-traffic][oft] |
| `onsite_foot_traffic_sessions`<br><sub>5142–5167</sub> | `onsiteFootTrafficSessions` | onsite-foot-traffic | Current canonical Wise PAST session, keyed by `wise_session_id`, including fail-closed classification and quality counts but no student/class-title PII. | Onsite Foot Traffic | [onsite-foot-traffic][oft] |
| `onsite_foot_traffic_visits`<br><sub>5170–5182</sub> | `onsiteFootTrafficVisits` | onsite-foot-traffic | Qualifying participant × Wise session student-visit; unique per `(wise_session_id, participant_key)`, with only an HMAC fingerprint for stable identities. | Onsite Foot Traffic | [onsite-foot-traffic][oft] |
| `onsite_foot_traffic_report_snapshots`<br><sub>5185–5197</sub> | `onsiteFootTrafficReportSnapshots` | onsite-foot-traffic | Immutable de-identified aggregate payload used by both HTML and PDF downloads; expires after 30 days. | Onsite Foot Traffic | [onsite-foot-traffic][oft] |
| `tutor_contacts`<br><sub>1965–1983</sub> | `tutorContacts` | tutor-profiles | Tutor's contact and delivery record (unique `canonical_key`); onsite and online addresses are kept in separate columns. | Tutor Profiles | [tutor-profiles][tp] |
| `tutor_business_profiles`<br><sub>1985–2019</sub> | `tutorBusinessProfiles` | tutor-profiles | Editorial business profile — PK `canonical_key`: parent-safe summary, fit signals, and internal notes Wise does not store. | Tutor Profiles | [tutor-profiles][tp] |
| `wise_activity_events`<br><sub>518–551</sub> | `wiseActivityEvents` | wise-activity | Wise audit event, deduped on `event_id` (unique). A read-only mirror — the app never writes back to Wise. | Wise Activity Audit | [wise-activity][wa] |
| `wise_activity_sync_runs`<br><sub>553–571</sub> | `wiseActivitySyncRuns` | wise-activity | Activity-ingest run, recording the oldest and newest event timestamps fetched; partial unique on `status` enforces single-flight. | Wise Activity Audit | [wise-activity][wa] |
| `learning_plan_access_grants`<br><sub>601–614</sub> | `learningPlanAccessGrants` | learning-plans | Email granted Learning Plans access — PK `email`, with CHECKs forcing a lowercased, trimmed, non-blank address and a non-blank granter. | Learning Plans | [learning-plans][lp] |
| `student_schedule_links`<br><sub>4635–4656</sub> | `studentScheduleLinks` | student-schedule | Capability token for the public `/schedule/{token}` page — only the SHA-256 `token_hash` is stored (unique). Grants read access to exactly one (`student_key`, `month_key`) and is expiring plus revocable. | Student Schedule | [student-schedule][ss] |

[c1]: ./erd-core.md#1-snapshot--sync-control-plane-and-cron-observability-4-tables
[c2]: ./erd-core.md#2-auth--access-2-tables
[c3]: ./erd-core.md#3-tutor-identity-normalization-session-blocks--data-health-13-tables
[c4]: ./erd-core.md#4-us-universities--ipeds-3-tables
[a1]: ./erd-university-admissions.md#1-case-spine-membership-checklist-meetings-9-tables
[a2]: ./erd-university-admissions.md#2-college-list-and-applications-10-tables
[a3]: ./erd-university-admissions.md#3-student-profile-essays-activities-awards-testing-academics-6-tables
[a4]: ./erd-university-admissions.md#4-communication-audit-notifications-import-11-tables
[p1]: ./erd-post-class-feedback.md#configuration-access-and-audit
[p2]: ./erd-post-class-feedback.md#evidence-collection
[p3]: ./erd-post-class-feedback.md#notifications
[p4]: ./erd-post-class-feedback.md#ai-quality-review
[p5]: ./erd-post-class-feedback.md#finance-and-deductions
[p6]: ./erd-post-class-feedback.md#payout-ledger
[ci]: ./erd-competitor-intelligence.md
[ln]: ./erd-line.md
[cc]: ./erd-credit-control.md
[ur]: ./erd-unearned-revenue.md
[cr]: ./erd-classrooms.md
[pr]: ./erd-payroll.md
[pt]: ./erd-progress-tests.md
[sd]: ./erd-sales-dashboard.md
[ap]: ./erd-ai-and-proposals.md
[sp]: ./erd-student-promotions.md
[lr]: ./erd-leave-requests.md
[rc]: ./erd-room-capacity.md
[oft]: ./erd-onsite-foot-traffic.md
[tp]: ./erd-tutor-profiles.md
[wa]: ./erd-wise-activity.md
[lp]: ./erd-learning-plans.md
[ss]: ./erd-student-schedule.md

## Snapshot scoping at a glance

The fourteen tables holding a foreign key to `snapshots.id` (15 references in `schema.ts`):

| Table | Role under `pruneOldSnapshots` |
|---|---|
| `sync_runs` | The only table with two references — `snapshot_id` and `promoted_snapshot_id`. Both are **nullified**, not deleted, so the run ledger survives its snapshot (`snapshot-pruning.ts:88-102`). |
| `tutor_identity_groups`, `tutor_identity_group_members`, `tutors`, `raw_teacher_tags`, `subject_level_qualifications`, `recurring_availability_windows`, `dated_leaves`, `future_session_blocks`, `data_issues`, `snapshot_stats` | The ETL output proper. Written fresh under each new snapshot id, read only where `snapshots.active = true`, and **deleted** by name once the snapshot falls outside the newest 30 (`snapshot-pruning.ts:104-172`). |
| `classroom_assignment_runs`, `classroom_assignment_rows`, `leave_request_affected_sessions` | *Pin* the snapshot they were computed from and then persist independently. The pruner does not touch them — see [Open questions](#open-questions). |

Eight further tables carry a snapshot-shaped column that is **not** an FK into `snapshots`.
`credit_control_sync_runs`, `credit_control_students`, `credit_control_packages`,
`credit_control_sessions` and `credit_control_credit_history` belong to the independent
`credit_control_snapshots` lineage; `student_promotion_runs.source_snapshot_id`,
`past_session_blocks.captured_in_snapshot_id` and
`progress_test_attendance_ledger.first_observed_snapshot_id` are deliberately plain uuids recording
provenance, so a snapshot can be pruned without cascading into them.

## Where the rest of the detail lives

| You want | Go to |
|---|---|
| Columns, types, defaults, indexes, CHECK constraints | `src/lib/db/schema.ts` at the line range in this table |
| Relationships and cardinality for a domain | the `erd-*.md` page in the last column |
| Enum value sets and which columns bind them | [`enums.md`](./enums.md) |
| Endpoint signatures that read or write a table | [`../api/index.md`](../api/index.md) |
| Which cron writes a table, and when | [`../crons.md`](../crons.md) |
| Why a rule exists, and what the workflow is | the feature doc in the [legend](#owning-feature-legend) |

Adding a value to any enum requires a migration (`ALTER TYPE … ADD VALUE`), not just a schema edit;
adding a table means a new `drizzle/` migration and a new row here.

## Open questions

- **Two line-range conventions are in use across this directory.** This page prints the `pgTable`
  declaration range. `erd-post-class-feedback.md`, `erd-room-capacity.md`, `erd-wise-activity.md`,
  `erd-student-schedule.md` and `erd-learning-plans.md` agree with it; `erd-core.md`,
  `erd-line.md`, `erd-payroll.md`, `erd-credit-control.md`, `erd-sales-dashboard.md`,
  `erd-classrooms.md`, `erd-leave-requests.md`, `erd-ai-and-proposals.md`,
  `erd-student-promotions.md`, `erd-competitor-intelligence.md`, `erd-progress-tests.md`,
  `erd-tutor-profiles.md` and `erd-university-admissions.md` run each range to the line before the
  next declaration, which absorbs the following table's doc comment. `line_schedule_bot_pending` is
  the clearest case: the declaration ends at `schema.ts:4686`, and lines 4687–4699 are
  `lineGroupSettings`' own JSDoc block.
- **`erd-student-schedule.md` still says `student_schedule_links` is "grouped as `core` in
  `./index.md`"** (`erd-student-schedule.md:19`). At this revision it is its own domain here, matching
  the page split.
- **Pruning a snapshot that a classroom run still pins would violate a foreign key.**
  `classroom_assignment_runs.snapshot_id` and `classroom_assignment_rows.snapshot_id` are `notNull`
  references with no `onDelete` clause (`schema.ts:1667`, `:1693`), and `pruneOldSnapshots` deletes
  the `snapshots` row without clearing them. Whether any run is ever old enough to collide with the
  30-snapshot retention window is a runtime question the schema cannot answer.
- **Three `schema.ts` section headers no longer bracket what they name.**
  `// ── Admissions Case Management ──` sits at `schema.ts:3135`, directly above
  `// ── Post-Class Feedback ──` at `:3136`, while the `admissions_*` tables do not begin until
  `:3965` under no header at all. The four late LINE tables (`schema.ts:4668-4772`) were appended
  after `// ── Student monthly schedule (parent-facing) ──` at `:4627`. And six `classroom_*` plus
  both `tutor_*` profile tables (`:1924-2092`) sit under `// ── Wise Payroll Review ──` at `:1761`.
  Cosmetic, but it makes a header-based reading of the file wrong — the `pgTable` declarations are
  the only reliable grouping.
- **Owning feature is an attribution, not a code fact.** `line_group_settings` is written by both the
  schedule bot and the credit bot (`src/lib/line/schedule-bot-group.ts`, `src/lib/line/credit-bot.ts`,
  `src/lib/line/credit-digest.ts`); `google_oauth_tokens` is read by every Sheets-backed subsystem.
  Where a table has more than one writer, the column names the primary one.
- **`snapshots.active` has no database guard.** Nothing prevents two rows with `active = true`; the
  single-active invariant is held only by the promotion `UPDATE`. Every other "exactly one" in the
  schema — active rate card, active projection source, live admissions case, one live sales source
  per month — is enforced by a partial unique index.

_Verified mechanically against the working tree on 2026-09-04._
