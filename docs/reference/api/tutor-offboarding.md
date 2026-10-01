# Tutor Offboarding API

Ten method/path endpoints. All require a signed-in `admin` session (checked in the handler) and follow
`allowedPages` for `/api/tutor-offboarding`. Errors use the Shape B mapper `tutorOffboardingErrorResponse`
(`src/lib/tutor-offboarding/api.ts`): own refusals keep their status and message; validation → 400; a missing
migration (SQLSTATE 42P01/42703) → 503; anything else → 500 with a generic message (name and SQLSTATE logged only).

| Method | Path | Gate | Purpose |
|---|---|---|---|
| GET | `/api/tutor-offboarding` | admin | Dashboard payload (`OffboardingDashboard`); `{ available: false, reason }` when not set up, no snapshot |
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

Owner = `requireSuperAdmin()` (`SUPER_ADMIN_EMAILS` + enabled, current admin row). Source: `src/app/api/tutor-offboarding/`.
