# Tutor Offboarding API

Eleven method/path endpoints. All require a signed-in `admin` session (checked in the handler) and follow
`allowedPages` for `/api/tutor-offboarding`. Errors use the Shape B mapper `tutorOffboardingErrorResponse`
(`src/lib/tutor-offboarding/api.ts`): own refusals keep their status and message; validation → 400; a missing
migration (SQLSTATE 42P01/42703) → 503; anything else → 500 with a generic message (name and SQLSTATE logged only).

| Method | Path | Gate | Purpose |
|---|---|---|---|
| GET | `/api/tutor-offboarding` | admin | Dashboard payload (`OffboardingDashboard`); `{ available: false, reason }` when not set up, no snapshot |
| GET | `/api/tutor-offboarding/analytics` | admin | Read-only analytics report from 1 March 2026 onward; returns `TutorOffboardingAnalytics` directly |
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

## Analytics report

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
