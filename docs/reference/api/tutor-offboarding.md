# Tutor Offboarding API

Five method/path endpoints (PR 1). All require a signed-in `admin` session (checked in the handler) and follow
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

Owner = `requireSuperAdmin()` (`SUPER_ADMIN_EMAILS` + enabled, current admin row). Source: `src/app/api/tutor-offboarding/`.
