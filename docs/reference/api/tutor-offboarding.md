# Tutor Offboarding API

These endpoints require a signed-in `admin` session (checked in the handler) and follow
`allowedPages` for `/api/tutor-offboarding`. Errors use the Shape B mapper `tutorOffboardingErrorResponse`
(`src/lib/tutor-offboarding/api.ts`): own refusals keep their status and message; validation → 400; a missing
migration (SQLSTATE 42P01/42703) → 503; anything else → 500 with a generic message (name and SQLSTATE logged only).

| Method | Path | Gate | Purpose |
|---|---|---|---|
| GET | `/api/tutor-offboarding` | admin | Dashboard payload (`OffboardingDashboard`); `{ available: false, reason }` when not set up, no snapshot |
| GET | `/api/tutor-offboarding/analytics` | admin | Read-only analytics report from 1 March 2026 onward; returns `TutorOffboardingAnalytics` directly |
| GET | `/api/tutor-offboarding/analytics/workforce` | admin | Filtered workforce report, with source revision and metric completeness |
| GET | `/api/tutor-offboarding/analytics/workforce/drilldown` | admin | Revision-bound contributing people, sessions, observations and exceptions |
| GET | `/api/tutor-offboarding/analytics/workforce/export` | admin | CSV from the same report calculation and selected filters |
| GET | `/api/tutor-offboarding/analytics/workforce/mappings` | admin | Reviewed subject mappings and unmapped lesson labels |
| POST | `/api/tutor-offboarding/analytics/workforce/mappings` | admin | Save a local academic-subject mapping with optimistic revision checking |
| GET, POST | `/api/tutor-offboarding/analytics/workforce/growth` | admin | Measured course demand report or read-only scenario calculation |
| POST | `/api/tutor-offboarding/analytics/workforce/growth/drilldown` | admin | Revision-bound cohort, churn, cancellation or capacity evidence |
| POST | `/api/tutor-offboarding/analytics/workforce/growth/export` | admin | CSV using the same scenario, source revision and metrics |
| POST | `/api/tutor-offboarding/decisions` | admin | Still with us: `{ canonicalKey, note?, snoozeDays: 90 \| 365 }` (strict). The score stored with it is computed by the server. 404 if the person is not on the page; 409 if already marked or a read-only Wise staff account |
| DELETE | `/api/tutor-offboarding/decisions/{decisionId}` | admin | Undo a decision; 404 if unknown or already undone |
| GET | `/api/tutor-offboarding/grants` | owner | `{ grants }` — who may remove tutors |
| POST | `/api/tutor-offboarding/grants` | owner | `{ action: "grant" \| "revoke", email }`; 422 unless an enabled admin; 409 duplicate; 404 revoking a non-grant |
| GET | `/api/tutor-offboarding/removal-runs` | admin | `{ runs }` — recent run history |
| POST | `/api/tutor-offboarding/removal-runs` | capability | `{ canonicalKeys }` (strict); rechecks current eligibility and Wise before saving a 15-minute preview `{ run }` |
| GET | `/api/tutor-offboarding/removal-runs/{runId}` | admin | `{ run }`; 404 if not found |
| POST | `/api/tutor-offboarding/removal-runs/{runId}/apply` | capability | `{ previewToken, confirmed: true, reason, accountCount }` (strict); applies the saved plan in its stored manual/live mode |
| POST | `/api/tutor-offboarding/reconcile` | capability | `{ result }`; read-only in Wise, settles run state from the current roster |

Removal endpoints re-read the enabled admin's removal grant from Postgres on each request. Apply also rechecks the
saved token, expiry and count. It never retries a Wise removal POST; uncertain outcomes are settled by roster
readback. The live write gate requires `WISE_TEACHER_REMOVAL_VERIFIED=true` **and** `VERCEL_ENV=production`; all
other environments produce manual-mode instructions.

## Existing analytics report (compatibility contract)

`GET /api/tutor-offboarding/analytics` requires the regular page-scoped admin session. It does not require a removal
grant and performs no Wise or Sheets request. The response is either `{ available: false, reason }` or the
`AnalyticsReport` object itself; `not_set_up`, `no_snapshot` and `load_failed` are explicit unavailable reasons.

The report covers observed classes since 1 March 2026 and includes current-roster and person-level cohorts, monthly
ended teaching activity, matched termination evidence, scored idle-gap scenarios, qualifications, observed course
impact and future scheduled sessions. People are grouped by `canonicalKey`, so onsite/online account variants count
once. Wise `ADMIN` accounts are excluded from the tutor denominator. Full-time is an overlapping flag: a full-time
non-ADMIN person with an ended class remains in the denominator and appears in the separate full-time breakout.
Unresolved identities and incomplete feeds remain visible as limitations.

`turnover.actualRate` is always `null`: these sources have neither an effective separation date for the marked Sheet
rows nor a reliable 1 March opening employee headcount. `denominator` is the number of distinct non-ADMIN people
with at least one `ENDED` class since 1 March. `markedShare` is matched marked people in that observed teaching cohort
divided by the cohort; `markedAndInferredShare` adds unmarked very-likely people to the numerator over the same
denominator. These are observed-teaching-cohort scenario shares, not HR turnover rates or confirmed-exit rates. Their
difference is the percentage-point increase under the inferred-idle scenario; inferred people are not confirmed
departures. The numerator excludes marked roster matches without an ended class in the period, while separate
current-roster counts retain those people.

Qualification coverage is based on `subjectLevelQualifications` for subject/curriculum/level/exam-prep, not Wise's
subject-like course field, which is a pricing band. `remainingAfterMarked` and `remainingAfterMarkedAndInferred` list
qualified people after each scenario. They measure roster qualification depth, not availability or replacement
capacity. Scheduled future classes are reported separately as pending load. Per-course upcoming-session totals count
only assignments to the marked or inferred cohorts and provide separate marked/inferred subtotals. Ended-session
totals describe the whole course; `otherHistoricalPeople` are prior teachers, not proven available replacements.
Class rows also retain the Wise course category as operational metadata. Missing qualifications, future session
records without a course ID, unresolved/conflicting historical teachers and data freshness are reported explicitly.

Owner = `requireSuperAdmin()` (`SUPER_ADMIN_EMAILS` + enabled, current admin row). Source: `src/app/api/tutor-offboarding/`.

## Workforce report

Every workforce handler calls `requireTutorOffboardingAdmin()` before reading data; no removal grant is needed.
Responses use `Cache-Control: private, no-store`, including validation and service errors. There is no Wise request
inside a report, drilldown, export or mapping handler.

Shared query parameters:

| Parameter | Contract |
|---|---|
| `from`, `to` | Inclusive Bangkok dates (`YYYY-MM-DD`); defaults 2026-03-01 through today; ordered, valid calendar dates |
| `viewMonth` | `YYYY-MM`, within the selected range; defaults to the end date's month |
| `role` | `all`, `tutor`, `teaching_admin`; default `all` |
| `modality` | `all`, `online`, `onsite`; default `all` |
| `subject`, `curriculum`, `level` | Optional nonempty labels, at most 120 characters |

Duplicate and unrecognized query parameters return 400. The start cannot precede 1 March 2026, and the end cannot
extend more than one year beyond today. The report returns `WorkforceReport` directly: schemaVersion, reportRevision,
generatedAt, query, totals, months, subjects, weekCells, people and quality. Numeric fields are `WorkforceMetric`:
`{value:number|null, completeness:complete|partial|unknown, reasonCodes:string[]}`.

Drilldown adds `kind=person|subject_cell|turnover`, `key`, mandatory `reportRevision`, optional `cursor`, and `pageSize`
(default 100, maximum 500). It returns the shared query/revision, contributor identifiers, people, sessions, observations,
exceptions and nextCursor. A stale revision returns 409; clients refresh the report before retrying.
The revision pins the calculation time as well as the evidence. Opening details or exporting later does not move
the observation boundary; the server still reads fresh sources and returns 409 if those sources changed.

Export adds `section=months|subjects|week|people` and mandatory `reportRevision`. A stale revision returns 409 before
any CSV is returned. UTF-8 CSV contains the selected filters, source revision, each metric's value/completeness/reasons,
and the coverage-aligned utilization numerators. Spreadsheet formula-leading strings are neutralized; quotes and
newlines are escaped. The filename contains the validated section and dates.
Report-wide source issues, coverage and exceptions appear in the first data row. Every row carries
`report_metadata_data_row=1` and the report revision; blank metadata cells in later rows refer to that first row.
This preserves the complete source evidence without duplicating it for every exported metric row.

Mappings GET uses the shared filters and returns `{mappings,unmappedClasses}`. Each unmapped row carries classId,
sourceValue, bookedHours and sessionsCount. POST accepts `{id?,classId,sourceValue,subject,curriculum,level,expectedRevision}`;
revision 0 creates, and an outdated revision returns 409. Review identity and time come from the server. The response is
`{mapping}`. These edits affect local reporting only.

Implementation: `src/lib/tutor-offboarding/workforce/` and `src/app/api/tutor-offboarding/analytics/workforce/`.

## Growth report and scenarios

GET uses the shared workforce filters with measured assumptions. Growth requires `role=all` and `modality=all`;
subsets return 422 because its forecast allocates the full teaching pool. Academic and date filters select display
scope while cohort inception and competing capacity retain their complete history.

POST accepts `{filters,assumptions?}`. `filters` is an object containing the same string-valued query parameters.
`assumptions` contains `bufferPercent` (0–100, default 0) and optional `subjects`, a record keyed by exact `courseKey`
(the field name is retained for compatibility). At most 100 courses may override `newStudentHours`,
`reactivatedStudentHours`, `churnStudentHours` (finite, 0–100,000,000), `cancellationFraction` (0–1), or
`studentHoursPerTutorHour` (positive, at most 100,000). Unknown fields and prototype keys return 400. JSON bodies are
limited to 64 KiB before parsing. Scenarios perform no writes.

Both return `GrowthReport`: `schemaVersion`, `reportRevision`, `generatedAt`, `query`, `flows`, `forecast`, `quality`.
Flows retain monthly course rows, lifecycle evidence, the common mature window, averages and weekday/time patterns.
Forecast retains measured/override/unavailable inputs, twelve monthly points, dated shared-capacity allocations and
course-level hiring benchmarks. Numeric observations use the same value/completeness/reason contract as workforce.

Drilldown adds `reportRevision`, `kind=cohort|churn|cancellation|capacity`, `key`, optional `cursor` and `pageSize`
(default 100, maximum 500). Keys are returned chart-row keys; churn also accepts a returned lifecycle event key.
The page limit applies across sessions, lifecycle events and availability observations together. A cursor is bound to
the revision, kind and key. A stale revision returns 409; an unavailable row returns 404.
Growth revisions also pin the calculation time. A fresh source read must reproduce the pinned report before details
or a CSV are returned.

Export adds `reportRevision` and `section=months|averages|forecast|gaps`. It includes the exact common and baseline
months, contributor identifiers, inferred/observed certainty, source coverage and observation times, scenario inputs,
metric completeness and hiring benchmark context. A stale revision returns 409. CSV uses UTF-8 with a BOM, escaped
quotes/newlines and neutralized formula-leading text. All outcomes use `Cache-Control: private, no-store`.
Report-wide filters, scenario, source evidence, availability observation times and forecast assumptions appear once
in the first data row, referenced by `report_metadata_data_row=1`. Row-specific metrics, lifecycle contributions,
model inputs and hiring benchmarks remain on their own rows. JSON and CSV responses stream complete content.
