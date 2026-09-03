# Post-Class Feedback API

**19 endpoints** — the 13 admin handlers under `/api/post-class-feedback/**` plus the 6 `CRON_SECRET`-guarded internal routes that drive the subsystem (`/api/internal/sync-post-class-feedback`, `/api/internal/post-class-feedback-backfill`, and the four under `/api/internal/post-class-feedback/`). This page is the canonical home for their **mechanics**: method, path, auth, request shape, response shape, side effects, and status codes.

Meaning lives elsewhere and is not restated here — why feedback is scored, the evidence model, the enforcement gate, and the review workflow are in [docs/features/post-class-feedback.md](../../features/post-class-feedback.md); the payout window, ledger, and accrual rules are in [docs/features/post-class-payout.md](../../features/post-class-payout.md). The master endpoint inventory is [docs/reference/api/index.md](./index.md); cron schedules and budgets are in [docs/reference/crons.md](../crons.md); the `POST_CLASS_PAYOUT_*` / `POST_CLASS_AUTO_APPROVE_*` variables are in [docs/reference/env.md](../env.md). Table-level detail for the 32 `post_class_*` tables is in [docs/reference/database/erd-core.md](../database/erd-core.md).

**Authoritative source:** the 13 handlers under [`src/app/api/post-class-feedback/`](../../../src/app/api/post-class-feedback/), the 6 under [`src/app/api/internal/`](../../../src/app/api/internal/), and the 40 modules in [`src/lib/post-class-feedback/`](../../../src/lib/post-class-feedback/) they delegate to.

## Endpoint index (19)

### Workspace endpoints (13) — `admin + cap:X`

| Method | Path | Capability | Writes | Handler |
|--------|------|-----------|--------|---------|
| GET | `/api/post-class-feedback` | `viewer` | none | [`route.ts:10-26`](../../../src/app/api/post-class-feedback/route.ts) |
| GET | `/api/post-class-feedback/sessions/[sessionId]` | `viewer` | none | [`route.ts:11-24`](../../../src/app/api/post-class-feedback/sessions/%5BsessionId%5D/route.ts) |
| POST | `/api/post-class-feedback/review` | `reviewer` | `post_class_deductions` + action log + session mirror | [`review/route.ts:20-32`](../../../src/app/api/post-class-feedback/review/route.ts) |
| POST | `/api/post-class-feedback/ai-review` | `reviewer` | `post_class_ai_concerns` + `post_class_ai_reviews` + audit log | [`ai-review/route.ts:16-28`](../../../src/app/api/post-class-feedback/ai-review/route.ts) |
| POST | `/api/post-class-feedback/finance` | `finance` | deduction status/month + offsets + payout adjustments | [`finance/route.ts:36-48`](../../../src/app/api/post-class-feedback/finance/route.ts) |
| POST | `/api/post-class-feedback/finance-periods` | `finance` | `post_class_finance_periods` + audit log | [`finance-periods/route.ts:25-37`](../../../src/app/api/post-class-feedback/finance-periods/route.ts) |
| POST | `/api/post-class-feedback/payout-runs` | `finance` | Google Sheets ledger + Drive CSV + payout run/line/exception tables | [`payout-runs/route.ts:105-162`](../../../src/app/api/post-class-feedback/payout-runs/route.ts) |
| POST | `/api/post-class-feedback/sync` | `access_manager` | sync run + sessions/evidence, **or** re-decided verdicts | [`sync/route.ts:48-102`](../../../src/app/api/post-class-feedback/sync/route.ts) |
| PATCH | `/api/post-class-feedback/settings` | `access_manager` | `post_class_settings`, field mappings, enforcement windows, digest recipients | [`settings/route.ts:21-33`](../../../src/app/api/post-class-feedback/settings/route.ts) |
| POST | `/api/post-class-feedback/shadow-review` | `access_manager` | `post_class_settings.shadow_reviewed_at` + audit log | [`shadow-review/route.ts:31-125`](../../../src/app/api/post-class-feedback/shadow-review/route.ts) |
| PATCH | `/api/post-class-feedback/access` | `access_manager` | `post_class_access_grants` + audit log | [`access/route.ts:21-46`](../../../src/app/api/post-class-feedback/access/route.ts) |
| PATCH | `/api/post-class-feedback/tutor-emails` | `access_manager` | `tutor_contacts.primary_email` + audit log | [`tutor-emails/route.ts:18-40`](../../../src/app/api/post-class-feedback/tutor-emails/route.ts) |
| POST | `/api/post-class-feedback/test-email` | `access_manager` | sends one email; stamps `email_delivery_verified_at` | [`test-email/route.ts:10-23`](../../../src/app/api/post-class-feedback/test-email/route.ts) |

### Internal endpoints (6) — `cron`

| Method | Path | Cron | Job key | Handler |
|--------|------|------|---------|---------|
| GET | `/api/internal/sync-post-class-feedback` | `13,43 * * * *` | `post_class_feedback` | [`route.ts:15-46`](../../../src/app/api/internal/sync-post-class-feedback/route.ts) |
| GET | `/api/internal/post-class-feedback-backfill` | `23,53 * * * *` | `post_class_feedback_backfill` | [`route.ts:32-82`](../../../src/app/api/internal/post-class-feedback-backfill/route.ts) |
| GET | `/api/internal/post-class-feedback/payout-accrual` | `33 * * * *` | `post_class_feedback_payout_accrual` | [`payout-accrual/route.ts:18-41`](../../../src/app/api/internal/post-class-feedback/payout-accrual/route.ts) |
| GET | `/api/internal/post-class-feedback/reminder-day-after` | **none** (parked) | `post_class_feedback_day_after` | [`reminder-day-after/route.ts:9-30`](../../../src/app/api/internal/post-class-feedback/reminder-day-after/route.ts) |
| GET | `/api/internal/post-class-feedback/reminder-deadline` | **none** (parked) | `post_class_feedback_deadline` | [`reminder-deadline/route.ts:9-30`](../../../src/app/api/internal/post-class-feedback/reminder-deadline/route.ts) |
| GET | `/api/internal/post-class-feedback/admin-digest` | **none** (parked) | `post_class_feedback_digest` | [`admin-digest/route.ts:9-23`](../../../src/app/api/internal/post-class-feedback/admin-digest/route.ts) |

Only three of the six carry a `vercel.json` entry ([`vercel.json:32-43`](../../../vercel.json)). The three parked routes are registered `schedule: null, manualOnly: true, dangerous: true` so Data Health never reports them late while still allowing a deliberate manual run ([`cron-registry.ts:192-236`](../../../src/lib/data-health/cron-registry.ts)); `post_class_feedback_payout_accrual` keeps `dangerous: true` even though it is scheduled ([`:238-256`](../../../src/lib/data-health/cron-registry.ts)).

---

## Conventions shared by the 13 workspace endpoints

**Auth is a session *plus* a fresh Postgres grant.** Every handler's first statement is `await requirePostClassCapability(<capability>)` ([`access.ts:153-176`](../../../src/lib/post-class-feedback/access.ts)). It calls `auth()`, rejects a session with an explicit non-`admin` role, then reads the grant rows for that email from `post_class_access_grants` **joined against `admin_users`** — a grant for a non-allowlisted email resolves to nothing ([`access.ts:136-145`](../../../src/lib/post-class-feedback/access.ts)). Capabilities are deliberately never JWT claims, so a revocation takes effect on the next request. The four capabilities are `viewer`, `reviewer`, `finance`, `access_manager` ([`access.ts:11-16`](../../../src/lib/post-class-feedback/access.ts)); any action capability implies `viewer` through `normalizePostClassCapabilities` ([`access.ts:61-72`](../../../src/lib/post-class-feedback/access.ts)). Failures throw `PostClassAccessError` carrying its own status — `401 | 403 | 404 | 409 | 422` ([`access.ts:24-32`](../../../src/lib/post-class-feedback/access.ts)).

**Middleware.** `/api/post-class-feedback/**` is not on the public allowlist ([`middleware.ts:10-26`](../../../src/middleware.ts)), so an unauthenticated request is redirected to `/login` before the handler runs. The page and its API namespace are **exempted from the legacy `allowedPages` prefix check** — the coarse JWT list must not override a live database grant ([`middleware.ts:39-46`](../../../src/middleware.ts)).

**One error mapper.** Every handler wraps its body in `try/catch` and hands the error to `postClassFeedbackErrorResponse(route, error, fallback)` ([`api.ts:12-54`](../../../src/lib/post-class-feedback/api.ts)). It maps, in order:

| Thrown | Status | Body |
|---|---|---|
| `digest === "HANGING_PROMISE_REJECTION"` | — | **rethrown** to the framework ([`api.ts:13-20`](../../../src/lib/post-class-feedback/api.ts)) |
| `PostClassAccessError` | its own `.status` | `{"error": <message>}` |
| `Error` with message exactly `Unauthorized` | 401 | `{"error":"Unauthorized"}` |
| `Error` with message exactly `Forbidden` | 403 | `{"error":"Forbidden"}` |
| `PostClassValidationError` | 400 | `{"error": <message>}` |
| `ZodError` | 400 | `{"error":"The request payload is invalid.","issues":[…]}` |
| `PostClassNotFoundError` | 404 | `{"error": <message>}` |
| `PostClassConflictError` | 409 | `{"error": <message>}` (default message `This record changed. Refresh and try again.`) |
| anything else | 500 | the handler's own fallback string |

The 500 branch deliberately **never serializes the error**: only `errorName` is logged, because database and HTTP clients attach request parameters and response bodies that can contain private feedback text ([`api.ts:45-49`](../../../src/lib/post-class-feedback/api.ts)). The three error classes are in [`errors.ts:1-20`](../../../src/lib/post-class-feedback/errors.ts).

**Zod, with one exception.** Twelve of the thirteen validate with a module-scope schema. Eleven call `BodySchema.parse(...)` and let the `ZodError` fall through to the mapper's 400; only `POST …/sync` uses `safeParse` and therefore returns a **different** 400 body — `{"error": <flatten()>}` ([`sync/route.ts:51-54`](../../../src/app/api/post-class-feedback/sync/route.ts)). `GET /api/post-class-feedback` has no schema at all: its two query params are validated inside the dashboard builder.

**Optimistic concurrency is mandatory on every mutation.** Each write body carries an `expectedVersion`, compared under a transaction (or advisory lock) against the row's current `version` — a mismatch is a `PostClassConflictError` → 409. Three different version sources are in play: a real integer column (`post_class_settings.version`, `post_class_deductions.version`, `post_class_ai_concerns.version`, `post_class_finance_periods.version`, `post_class_payout_runs.version`), **epoch seconds derived from `updated_at`** for `tutor_contacts` ([`tutor-emails/route.ts:27-30`](../../../src/app/api/post-class-feedback/tutor-emails/route.ts), [`settings.ts:326-338`](../../../src/lib/post-class-feedback/settings.ts)), and a max-of-timestamps-and-audit-log value for access grants ([`access.ts:312-319`](../../../src/lib/post-class-feedback/access.ts)).

**Idempotency keys.** `review`, `ai-review`, `finance`, and `finance-periods` require (or, for period `close`/`reopen`, accept) an `idempotencyKey` of 1–250 characters. A replay with the same key returns the prior outcome instead of acting twice, but only after the stored payload is asserted to match — a key reused with a different body is rejected rather than silently accepted ([`actions.ts:568-573`](../../../src/lib/post-class-feedback/actions.ts), [`ai.ts:409-427`](../../../src/lib/post-class-feedback/ai.ts)).

**No caching.** No handler declares `"use cache"`, `revalidate`, or `dynamic`. Two declare `export const maxDuration = 800`: `payout-runs` ([`:22`](../../../src/app/api/post-class-feedback/payout-runs/route.ts)) and `sync` ([`:11`](../../../src/app/api/post-class-feedback/sync/route.ts)).

**Route tests.** Only two of the thirteen have a route-level test file: [`payout-runs/__tests__/route.test.ts`](../../../src/app/api/post-class-feedback/payout-runs/__tests__/route.test.ts) (8 cases — preview canary, publish confirmation guard, exact-count passthrough, verify-sheet, CSV retry, exception resolution, disabled write capability) and [`shadow-review/__tests__/route.test.ts`](../../../src/app/api/post-class-feedback/shadow-review/__tests__/route.test.ts) (12 cases across mode, version, mapping, blocking-issue and acknowledgement paths). The other eleven are covered only through their libraries' own suites under `src/lib/post-class-feedback/__tests__/`.

---

## Reading the workspace

### `GET /api/post-class-feedback`

The whole dashboard payload for a Bangkok date range, shaped by the caller's capabilities. Read-only. Handler [`route.ts:10-26`](../../../src/app/api/post-class-feedback/route.ts).

**Auth:** `viewer`.

**Query:**

| Param | Type | Required | Default |
|-------|------|----------|---------|
| `startDate` | `YYYY-MM-DD` (Bangkok) | no | first day of the current Bangkok month |
| `endDate` | `YYYY-MM-DD` (Bangkok) | no | last day of the current Bangkok month |

Both defaults come from `defaultPostClassFeedbackRange()` ([`dashboard.ts:86-89`](../../../src/lib/post-class-feedback/dashboard.ts)) — a **calendar month**. Note that the client shell defaults instead to the current 26→25 payout window and passes it explicitly ([`post-class-feedback-workspace.tsx:118-125`](../../../src/components/post-class-feedback/post-class-feedback-workspace.tsx)), so the server default is only what a bare `GET` returns. Validation is a shape test plus a `startDate <= endDate` check, both raising `PostClassValidationError` → 400 ([`dashboard.ts:81-84`](../../../src/lib/post-class-feedback/dashboard.ts), [`:125`](../../../src/lib/post-class-feedback/dashboard.ts)). A range wider than 120 days switches the trend buckets from weekly to monthly ([`dashboard.ts:130-134`](../../../src/lib/post-class-feedback/dashboard.ts)).

**Response `200`** — the object returned by `getPostClassFeedbackDashboard` verbatim, no wrapper ([`dashboard.ts:771-836`](../../../src/lib/post-class-feedback/dashboard.ts)):

| Key | Shape | Capability gating |
|---|---|---|
| `capabilities` | `{viewer, reviewer, finance, accessManager}` booleans | always |
| `payoutGoogle` | `{connectedEmail, sheetsWriteReady, driveReady}` or `null` | `null` without `finance` |
| `settings` | `mode`, `effectiveAt`, `sourceHealth`, `openSourceIssues.{global,session}`, `sourceLastSyncedAt`, `formMappingHealth`, `mapping.{topics,performance,improvement,homework}`, `digestRecipientEmails`, `policyVersion` (`"v<n>"`), `version` | `mapping` and `digestRecipientEmails` are nulled/emptied without `access_manager` |
| `summary` | 16 roll-ups: `eligible`, `assessed`, `rawOnTime`, `rawOnTimeRate`, `adjustedCompliant`, `adjustedComplianceRate`, `openViolations`, `pendingDeductions`, `pendingDeductionAmount`, `reminderFailures`, `late`, `incomplete`, `waived`, `meanCharacters`, `medianCharacters`, `confirmedAiConcerns` | always |
| `sessions` | per-session evidence rows for the range | always |
| `tutorMetrics` | ranked per-tutor metrics | always |
| `deductions` | deduction DTOs | reviewer/finance-shaped |
| `audit` | configuration/decision history | always |
| `admins` | the allowlisted-admin capability matrix | `access_manager` |
| `tutorEmails` | tutor `primary_email` rows | `access_manager` |
| `financePeriods` | month gate rows | finance/access-manager |
| `setup` | `{complete, items[]}` — the four-item activation checklist | always |

The `settings.version` in this payload is the `expectedVersion` the settings, shadow-review, and access mutations expect back.

**Status codes:** 200 · 400 (bad date shape or inverted range) · 401 (no session) · 403 (no `viewer` grant) · 500 (`"Could not load post-class feedback."`).

### `GET /api/post-class-feedback/sessions/[sessionId]`

One session's complete evidence record. Read-only. Handler [`route.ts:11-24`](../../../src/app/api/post-class-feedback/sessions/%5BsessionId%5D/route.ts).

**Auth:** `viewer`.

**Path param:** `sessionId` accepts **either** the internal `post_class_sessions.id` UUID **or** the Wise session id, so an admin holding only a Wise id can open the same record. The UUID branch is guarded by a regex test first, because Postgres rejects a non-UUID literal against a `uuid` column outright ([`detail.ts:96-112`](../../../src/lib/post-class-feedback/detail.ts)).

**Response `200`** ([`detail.ts:185-356`](../../../src/lib/post-class-feedback/detail.ts)):

| Key | Contents |
|---|---|
| `session` | identity, Wise ids, `scheduledStartAt` / `scheduledEndAt` / `deadlineAt` as ISO strings, `finalStatus`, `creditsConsumed`, `payableEligible`, and the derived Wise session URL |
| `participants` | student rows, ordered by name |
| `evidence` | the immutable `versions[]` (newest first, with per-answer question text and raw answer) plus the `SessionFeedbackSubmittedEvent` timeline, each event annotated `countedAsProof` / `notCountedReason` by `eventProofOutcome` ([`detail.ts:19-37`](../../../src/lib/post-class-feedback/detail.ts)) |
| `assessments` | every verdict written for the session — `sourceStatus`, `contentStatus`, `timingStatus`, `deductionStatus`, `enforcementMode`, `policyVersion`, `mappingVersion`, `combinedRawCharCount`, `fieldFailures`, `objectiveViolation`, `rawOnTime`, `adjustedCompliant`, `remediatedLate`, `timingUnknown`, `timingEvidence`, `sourceReady` |
| `sourceIssues` | session-scoped issues **plus every `global`-scope issue** |
| `reminders` | notification item/delivery/run joins |
| `ai` | AI runs with their concerns — `[]` without `reviewer` |
| `review` | `{id, status, amountMinor, waiverCategory, waiverNote, decisionByEmail, decisionAt, version}` or `null`; `status` reads `"reversed"` whenever an offset row exists |
| `finance` | `{id, status, amountMinor, defaultFinanceMonth, financePeriodId, processingReference, processedByEmail, processedAt, version, actions[], offset}` or `null` |

The deduction itself is only read when the caller holds `reviewer` or `finance`; `deductionActions` additionally requires `finance` ([`detail.ts:170-184`](../../../src/lib/post-class-feedback/detail.ts)). The `review.version` and `finance.version` are the `expectedVersion` for the review and finance mutations.

**Status codes:** 200 · 401 · 403 · 404 (`"Post-class feedback session was not found."`) · 500 (`"Could not load feedback history."`).

---

## Review decisions

### `POST /api/post-class-feedback/review`

Decides exactly one deduction. There is no bulk path. Handler [`review/route.ts:20-32`](../../../src/app/api/post-class-feedback/review/route.ts).

**Auth:** `reviewer`.

**Body** — schema at [`review/route.ts:11-18`](../../../src/app/api/post-class-feedback/review/route.ts):

| Field | Type | Required |
|---|---|---|
| `deductionId` | UUID | yes |
| `action` | `"approve" \| "waive" \| "reopen" \| "reinstate"` | yes |
| `note` | string ≤ 2000, defaults `""` | no |
| `waiverCategory` | one of the seven `POST_CLASS_WAIVER_CATEGORIES` — `wise_system_outage`, `incorrect_session_tutor_data`, `pre_approved_exception`, `tutor_emergency`, `duplicate_system_error`, `class_cancelled`, `other` ([`actions.ts:25-33`](../../../src/lib/post-class-feedback/actions.ts)) | required for `waive` ([`actions.ts:538`](../../../src/lib/post-class-feedback/actions.ts)) |
| `expectedVersion` | positive integer | yes |
| `idempotencyKey` | string 1–250 | yes |

**Response `200`:** `{ ok: true, deduction }` — the updated `post_class_deductions` row.

**Side effects,** all inside one transaction that first takes the finance lock ([`actions.ts:566-568`](../../../src/lib/post-class-feedback/actions.ts)):

1. Idempotency replay check, then `expectedVersion` check → 409.
2. `assertNoActivePayoutOperationForDeduction` — refuses while a payout run holds a lease on the row.
3. Per-action legality (all `PostClassValidationError` → 400): `approve` only from `pending_review`, and only after `revalidateDeductionCandidate` re-proves the session and `assertApprovalPeriodOpen` passes; `waive` from `pending_review` or `approved`; `reopen` only from `approved`, and **never once the row is verifiably on the ledger** — the message tells the operator to waive instead, which appends a positive correction; `reinstate` only from `waived`, and only when no live written line exists ([`actions.ts:611-634`](../../../src/lib/post-class-feedback/actions.ts)). `processed` and `reversed` are refused outright — those are Finance reversals.
4. Updates the deduction (`version + 1`), mirrors `deductionStatus` onto `post_class_sessions`, and appends a `post_class_deduction_actions` row.
5. A `waive` on an already-written deduction creates a `waiver` payout adjustment; an `approve` after the payout window closed records a late-approval payout exception ([`actions.ts:686-700`](../../../src/lib/post-class-feedback/actions.ts)).

**Status codes:** 200 · 400 (Zod, or any illegal transition) · 401 · 403 · 404 (deduction not found) · 409 (stale `expectedVersion`, or a replayed key with a different payload) · 500 (`"Could not update the review decision."`).

### `POST /api/post-class-feedback/ai-review`

Confirms or dismisses exactly one AI concern. Handler [`ai-review/route.ts:16-28`](../../../src/app/api/post-class-feedback/ai-review/route.ts).

**Auth:** `reviewer`.

**Body** — schema at [`ai-review/route.ts:8-14`](../../../src/app/api/post-class-feedback/ai-review/route.ts): `concernId` (UUID), `action` (`"confirm" | "dismiss"`), `note` (trimmed, 1–2000 — **required**, a blank note is a 400), `expectedVersion` (positive integer), `idempotencyKey` (1–250).

**Response `200`:** `{ ok: true, result }` where `result` is `{reviewed: 1, duplicate: false}` for a fresh decision or `{reviewed: 0, duplicate: true}` for a matching replay ([`ai.ts:427,464`](../../../src/lib/post-class-feedback/ai.ts)).

**Side effects:** under a `pg_advisory_xact_lock` keyed on the idempotency key, updates `post_class_ai_concerns.decision` to `confirmed`/`dismissed` with a version bump, inserts a `post_class_ai_reviews` row, and writes an `ai_review_request` audit entry ([`ai.ts:404-465`](../../../src/lib/post-class-feedback/ai.ts)). The update is additionally guarded on `decision = 'pending'`, so a race loses with a 409 rather than overwriting.

**Status codes:** 200 · 400 (Zod, or an empty note) · 401 · 403 · 404 (`"The pending AI concern was not found."` — also returned when the concern is no longer pending) · 409 (`"The AI concern changed; refresh before reviewing it."`) · 500 (`"Could not record the AI concern review."`).

---

## Finance handoff

### `POST /api/post-class-feedback/finance`

Moves, processes, or reverses one decided deduction. Handler [`finance/route.ts:36-48`](../../../src/app/api/post-class-feedback/finance/route.ts).

**Auth:** `finance`.

**Body** — a discriminated union on `action` ([`finance/route.ts:8-34`](../../../src/app/api/post-class-feedback/finance/route.ts)). All three variants share `deductionId` (UUID), `processingMonth` (`YYYY-MM`, regex-anchored), `expectedVersion` (positive integer), and `idempotencyKey` (1–250):

| `action` | `referenceNote` | `reason` |
|---|---|---|
| `move` | ≤ 2000, optional, defaults `""` | optional in the schema, but `requireText` makes it **mandatory** at runtime ([`actions.ts:785`](../../../src/lib/post-class-feedback/actions.ts)) |
| `process` | trimmed 1–2000, required | optional |
| `reverse` | trimmed 1–2000, required | trimmed 1–2000, required |

**Response `200`:** `{ ok: true, deduction }`.

**Side effects** ([`actions.ts:711-899`](../../../src/lib/post-class-feedback/actions.ts)), inside the finance-locked transaction:

- **`move`** requires status `approved`, refuses once the deduction is verifiably on the ledger, refuses while a previous write is uncertain, requires the deduction's payout window to still be open, and re-points `financePeriodId` at the target month's **open** period.
- **`process`** requires status `approved` and re-runs `revalidateDeductionCandidate`; it stamps `processingReference`, `processedByEmail`, `processedAt`, and sets status `processed`.
- **`reverse`** requires status `processed`, refuses a second offset for the same deduction, writes a `post_class_deduction_offsets` row with a **negated** `amountMinor`, flips the deduction to `reversed` under a status-guarded update, and creates a `reversal` payout adjustment.

Every branch mirrors `deductionStatus` onto `post_class_sessions` and appends a `post_class_deduction_actions` row. The target month must resolve to an **open** finance period (`loadOpenPeriod`), and `assertPostClassFinanceMonthActionInvariant` rejects a month that contradicts the deduction's default or already-assigned month.

**Status codes:** 200 · 400 (Zod, illegal status transition, missing move/reversal reason, ledger conflict, closed period) · 401 · 403 · 404 · 409 (stale version, mismatched idempotent replay, or the concurrent-reversal guard) · 500 (`"Could not update the finance handoff."`).

### `POST /api/post-class-feedback/finance-periods`

Opens, closes, or reopens one calendar month's finance gate. Handler [`finance-periods/route.ts:25-37`](../../../src/app/api/post-class-feedback/finance-periods/route.ts).

**Auth:** `finance`.

**Body** — discriminated union ([`finance-periods/route.ts:8-23`](../../../src/app/api/post-class-feedback/finance-periods/route.ts)):

| `action` | `month` | `reason` | `expectedVersion` | `idempotencyKey` |
|---|---|---|---|---|
| `open` | `YYYY-MM` | ≤ 2000, optional | not accepted | **required**, 1–250 |
| `close` / `reopen` | `YYYY-MM` | ≤ 2000, optional | **required**, positive integer | optional, 1–250 |

**Response `200`:** `{ ok: true, period }` — the `post_class_finance_periods` row.

**Side effects** ([`actions.ts:903-1010+`](../../../src/lib/post-class-feedback/actions.ts)): under the finance lock, an idempotent replay is resolved from `post_class_config_audit_log` (matched on `afterValue->>'idempotencyKey'`) and returns the existing period. Otherwise `open` inserts a new `open` period, or records an `idempotentNoop` audit row when the month is already open; `close` refuses when the period is not open and additionally counts still-undecided deductions before closing; `reopen` flips it back. Every branch appends a `finance_period` audit entry.

**Status codes:** 200 · 400 (Zod; a missing `idempotencyKey` on `open`; `"The finance period already exists."`; `"The period is already closed."`) · 401 · 403 · 404 (`"Finance period was not found."` — closing or reopening a month that was never opened) · 409 (stale version, unresolvable prior action, or a mismatched replay) · 500 (`"Could not update the finance period."`).

---

## Payout runs

### `POST /api/post-class-feedback/payout-runs`

Five actions behind one route: the entire payout handoff, from read-only preview to the irreversible ledger append. `export const maxDuration = 800` ([`:22`](../../../src/app/api/post-class-feedback/payout-runs/route.ts)) — Google row writes are paced under a ten-minute application budget and a durable lease. Handler [`route.ts:105-162`](../../../src/app/api/post-class-feedback/payout-runs/route.ts).

**Auth:** `finance`. There is no separate payout capability; the write *gate* is environment, not identity.

**Body** — a `.strict()` discriminated union on `action` ([`route.ts:30-69`](../../../src/app/api/post-class-feedback/payout-runs/route.ts)). Shared field types: `anchorMonth` = `YYYY-MM`; `expectedVersion` = integer ≥ 1; `tutorFilter` = trimmed 1–200; `AuditReason` = trimmed **10–1000**; `ExternalReference` = trimmed 1–500.

| `action` | Fields | Writes? |
|---|---|---|
| `preview` | `anchorMonth`, `tutorFilter?` | no |
| `publish` | `anchorMonth`, `expectedVersion`, `previewToken` (trimmed 16–500), `tutorFilter?`, `acknowledgements` | **yes — money** |
| `retry_csv` | `anchorMonth`, `expectedVersion` | Drive only |
| `verify_sheet` | `anchorMonth` | no (one Sheets read) |
| `resolve_exception` | `exceptionId` (UUID), `expectedVersion`, `note` (AuditReason), `externalReference` | database only |

`acknowledgements` is itself `.strict()`: `{confirmed: true (literal), reason: AuditReason, pendingReviewDeductions: integer ≥ 0, nonReadySessions: integer ≥ 0}`. The two counts are **numbers, never booleans**, by design — they must echo the exact preview, so a stale tab cannot acknowledge a set that has grown since it rendered ([`route.ts:42-49`](../../../src/app/api/post-class-feedback/payout-runs/route.ts)). `publishPayoutRun` re-checks all four fields and the 10-character reason floor server-side ([`payout-run.ts:704-712`](../../../src/lib/post-class-feedback/payout-run.ts)).

**`writeCapability` on every response.** `payoutWriteCapability()` returns `{enabled, target, reason}` where `target` is `"scratch" | "production" | null` ([`route.ts:71-103`](../../../src/app/api/post-class-feedback/payout-runs/route.ts)). It reports disabled when `requirePayoutGoogleTarget({forWrite: false})` throws (any of the eight `POST_CLASS_PAYOUT_*` variables missing, or a production deployment pointed at a non-production target — [`payout-config.ts:72-120`](../../../src/lib/post-class-feedback/payout-config.ts)) or when `POST_CLASS_PAYOUT_WRITES_ENABLED` is not the exact string `"true"` ([`payout-config.ts:49-51`](../../../src/lib/post-class-feedback/payout-config.ts)). **The projection is advisory only** — `publish` and `retry_csv` independently re-resolve the target with `forWrite: true`, and their responses recompute the projection after the operation ([`route.ts:132,145`](../../../src/app/api/post-class-feedback/payout-runs/route.ts)).

**Responses `200`:**

| Action | Body |
|---|---|
| `preview`, `publish`, `retry_csv` | `{ok: true, …PayoutRunView, writeCapability}` |
| `verify_sheet` | `{ok: true, verification, writeCapability}` |
| `resolve_exception` | `{ok: true, exception, writeCapability}` |

`PayoutRunView` is spread at the top level, not nested ([`payout-run.ts:96-109`](../../../src/lib/post-class-feedback/payout-run.ts)): `run` (a `preview:<anchorMonth>` draft projection before the first publish), `runPersisted`, `window`, `previewToken`, `coverage`, `lines`, `adjustments`, `exceptions`, `policyVersion`, `csvError`, `stoppedEarly`. `coverage` carries the twelve counters `publish` acknowledges against — `eligibleSessions`, `readySessions`, `nonReadySessions`, `unavailableSessions`, `formDriftSessions`, `identityReviewSessions`, `pendingReviewDeductions`, `unprovenApprovedDeductions`, `approvedDeductions`, `unmappedTutorKeys[]`, `nullTutorKeyLines`, `blockingGlobalSourceIssues` ([`payout-plan.ts:53-70`](../../../src/lib/post-class-feedback/payout-plan.ts)). Each line is a `PayoutRunLine` plus `persisted` and the backward-compatible `masterRowNumber` alias ([`payout-run.ts:90-94`](../../../src/lib/post-class-feedback/payout-run.ts)).

`verification` is `PayoutSheetVerifyResult` ([`payout-sheet-verify.ts:56-69`](../../../src/lib/post-class-feedback/payout-sheet-verify.ts)): `anchorMonth`, `checkedAt`, `sheetRowCount`, `summary.{present, ledgerRemoved, missing, amountChanged, unwrittenApproved}`, `rows[]`, `attention[]`, `perTutor[]`. Each row's `sheetStatus` is `present | absent | amount-changed | netted-removed | n/a`; `netted-removed` marks a row deliberately deleted by the retirement pass and is **expected-absent, not a problem**.

**Side effects by action:**

- **`preview`** — pure read. Computes the 26→25 window from `anchorMonth`, reads the candidate snapshot, and mints a `previewToken`. Creates no run row ([`payout-run.ts:269-281`](../../../src/lib/post-class-feedback/payout-run.ts)).
- **`publish`** — the money move ([`payout-run.ts:681+`](../../../src/lib/post-class-feedback/payout-run.ts)). Rejects before touching Google if the window has not ended in Bangkok, then resolves the write target with `forWrite: true`, acquires a **durable lease** on the run keyed to the `previewToken` and `expectedVersion`, asserts the connected Google account holds Sheets (and, unless the CSV upload is injected, Drive) scope, reads the master workbook's raw and deductions grids, plans and applies append operations for every unwritten line and pending adjustment, then uploads the CSV artifact to Drive. Lines that cannot be matched to a tutor sheet are marked `skipped` with a `writeError` rather than failing the run. A budget exhaustion sets `stoppedEarly: true`.
- **`retry_csv`** — regenerates and re-uploads the CSV **only**: no sheet read, no append. Claims the run's CSV-retry lease, then finalizes with the new file id/url or a captured `csvError` ([`payout-run.ts:957-1004`](../../../src/lib/post-class-feedback/payout-run.ts)).
- **`verify_sheet`** — one paced read of the app-owned deductions tab, then a pure database-vs-sheet comparison. Writes nothing anywhere, and `POST_CLASS_PAYOUT_WRITES_ENABLED` deliberately does **not** gate it: the flag gates money rows, not reads ([`payout-sheet-verify.ts:20-25`](../../../src/lib/post-class-feedback/payout-sheet-verify.ts)). Safe on any run state.
- **`resolve_exception`** — marks one `post_class_payout_exceptions` row resolved with the actor, note, and external reference ([`payout-run.ts:1007-1020`](../../../src/lib/post-class-feedback/payout-run.ts)).

**Status codes:** 200 · 400 (Zod — including an unknown key, since every variant is `.strict()`; a window that has not ended; a preview token that is absent) · 401 · 403 · 409 (stale `expectedVersion`, a lease held by another operation, a closed run, or a preview token that no longer matches) · 500 (`"Could not update the payout run."`). Note the two plain-`Error` paths that land in the 500 bucket rather than a typed 4xx: `requirePayoutGoogleTarget` throwing on an incomplete target ([`payout-config.ts:106-113`](../../../src/lib/post-class-feedback/payout-config.ts)), and `verify_sheet` failing to parse the deductions tab header ([`payout-sheet-verify.ts:110`](../../../src/lib/post-class-feedback/payout-sheet-verify.ts)).

---

## Collection and reassessment

### `POST /api/post-class-feedback/sync`

Two modes behind one route, kept separate because their inputs, costs, and blast radii differ entirely — `collect` fetches fresh Wise detail; `reassess` re-decides verdicts from evidence already persisted and never touches Wise ([`sync/route.ts:19-22`](../../../src/app/api/post-class-feedback/sync/route.ts)). `export const maxDuration = 800`. Handler [`route.ts:48-102`](../../../src/app/api/post-class-feedback/sync/route.ts).

**Auth:** `access_manager`.

**Body** — `z.union([ReassessSchema, CollectSchema]).default({})`, parsed with `safeParse` over `request.json().catch(() => ({}))`, so an absent or unparseable body degrades to `{}` and selects `collect` ([`sync/route.ts:46,51`](../../../src/app/api/post-class-feedback/sync/route.ts)).

*Collect mode* — `.strict()`, schema at [`sync/route.ts:23-34`](../../../src/app/api/post-class-feedback/sync/route.ts):

| Field | Type | Notes |
|---|---|---|
| `mode` | `"collect"` | optional; the default branch |
| `detailCap` | integer 1–400 | 400 is honoured **only** for an explicit `startDate`/`endDate` window; every other trigger is clamped back to 50 inside the sync |
| `startDate` / `endDate` | `YYYY-MM-DD`, calendar-validated by a `refine` ([`:13-17`](../../../src/app/api/post-class-feedback/sync/route.ts)) | must be supplied **together** and `startDate <= endDate`, both enforced by `refine` |

*Reassess mode* — `.strict()`, schema at [`sync/route.ts:36-44`](../../../src/app/api/post-class-feedback/sync/route.ts):

| Field | Type | Notes |
|---|---|---|
| `mode` | literal `"reassess"` | required — this is the discriminator |
| `apply` | boolean, **default `false`** | the dry run is the default; the destructive form is always the explicit one |
| `timingStatuses` | array of `not_due \| on_time \| late \| unknown`, min 1 | optional; defaults to `late` inside the engine |
| `wiseSessionIds` | array of non-empty strings, 1–500 | optional |
| `limit` | integer 1–5000 | optional |

**Response `200` (collect):** `{ok: true, result, ai, retries}`. `result` is `SyncPostClassFeedbackResult` ([`sync.ts:97-118`](../../../src/lib/post-class-feedback/sync.ts)): `runId`, `status` (`"success" | "partial"`), `windowStart`, `windowEnd`, `discoveredCount`, `candidateCount`, `windowCandidateCount`, `detailFetchedCount`, `sessionSavedCount`, `sourceIssueCount`, `checkpoint`. The AI-review and notification-retry passes run under `Promise.allSettled`, so a failure in either degrades that key to `{failed: true}` instead of failing the request ([`sync/route.ts:85-94`](../../../src/app/api/post-class-feedback/sync/route.ts)).

**Response `200` (reassess):** `{ok: true, mode: "reassess", applied, result}` where `result` is `PostClassReassessResult` — `scanned`, `changed`, `deductionsWaived`, `failed`, `outcomes[]` ([`reassess.ts:63-70`](../../../src/lib/post-class-feedback/reassess.ts)). Every reassess call also emits a one-line `console.error` audit record naming the actor and the four counters ([`sync/route.ts:64-74`](../../../src/app/api/post-class-feedback/sync/route.ts)).

**Status codes:** 200 · **400 with `{"error": <Zod flatten()>}`** — the one endpoint whose 400 body differs from the shared mapper · 401 · 403 · 409 (`PostClassFeedbackSyncAlreadyRunningError` escapes as a generic 500 here, unlike the cron route — see below) · 500 (`"Could not sync post-class feedback."`).

> `PostClassFeedbackSyncAlreadyRunningError` is **not** in the shared error mapper's ladder, so a single-flight collision on this route falls through to the generic 500 rather than the 409 the internal cron routes return.

---

## Configuration and activation

### `PATCH /api/post-class-feedback/settings`

Enforcement mode, effective instant, Wise field mapping, and digest recipients. Handler [`settings/route.ts:21-33`](../../../src/app/api/post-class-feedback/settings/route.ts).

**Auth:** `access_manager`.

**Body** — schema at [`settings/route.ts:8-19`](../../../src/app/api/post-class-feedback/settings/route.ts): `mode` (`"shadow" | "live" | "paused"`, optional), `effectiveAt` (non-empty string or `null`, optional), `mapping` (`{topics, performance, improvement, homework}`, each `string | null`, all optional), `digestRecipientEmails` (array of emails, max 100, optional), `expectedVersion` (positive integer, **required**).

**Response `200`:** `{ ok: true, settings }` — the updated `post_class_settings` row.

**Side effects and refusals** ([`settings.ts:90-...`](../../../src/lib/post-class-feedback/settings.ts)), all inside one transaction:

- `expectedVersion` must match `post_class_settings.version` → 409.
- A `mapping` change while `mode === "live"` is refused (`"Pause enforcement before changing the Wise form mapping."`). Accepting one inserts a **new** `formMappingVersion` row set — mappings are versioned, never edited in place — and recomputes `formMappingValid` from the three required fields (`homework` is not required).
- `effectiveAt` accepts a Bangkok `YYYY-MM-DD` (today resolves to *now*) or a full timestamp. Once a live policy effective instant exists it is **immutable**.
- Transitioning to `live` requires: a valid mapping; reviewer, finance, and access-manager coverage; a confirmed shadow review that is not invalidated by a mapping change in the same request; and a **prospective** effective instant — a backdated activation is refused ([`settings.ts:172-193`](../../../src/lib/post-class-feedback/settings.ts)). Email relay, digest recipients, and tutor-email coverage were deliberately removed from the activation gate when outbound email was parked.
- A mode change closes the current `post_class_enforcement_windows` row and opens a new one.

**Status codes:** 200 · 400 (Zod, or any activation refusal) · 401 · 403 · 404 (`"Post-class feedback settings are not initialized."`) · 409 · 500 (`"Could not update post-class feedback settings."`).

### `POST /api/post-class-feedback/shadow-review`

Confirms that a shadow run has been reviewed — the gate that must pass before enforcement can go live. Handler [`shadow-review/route.ts:31-125`](../../../src/app/api/post-class-feedback/shadow-review/route.ts).

**Auth:** `access_manager`.

**Body** — schema at [`shadow-review/route.ts:20-29`](../../../src/app/api/post-class-feedback/shadow-review/route.ts): `expectedVersion` (positive integer, required), `acknowledgeSessionIssues` (non-negative integer, optional), `reason` (string, optional).

**Evidence the handler gathers before deciding** — this endpoint does its own work inline rather than delegating to a single service:

1. Settings must exist and be in `shadow` mode, and `settings.version` must equal `expectedVersion`.
2. At least one **active** field mapping must exist at the current `formMappingVersion`; the newest `updatedAt` across those rows is fed to the classifier so a mapping edited after the shadow run invalidates it.
3. In parallel: the 20 most recent `success` sync runs, the count of open blocking **global** source issues, and session readiness over a rolling 4-day window — `RECENT_READINESS_DAYS = 4`, deliberately mirroring the collector's own `ROLLING_WINDOW_DAYS` so the gate judges exactly the period the live system keeps reconciled ([`shadow-review/route.ts:17-18,54-56`](../../../src/app/api/post-class-feedback/shadow-review/route.ts)).
4. `classifyPostClassShadowReviewEvidence` returns `{ready, evidence, conditions, blockedBy, acknowledgeableTotal}`.

A not-ready verdict throws `PostClassValidationError` naming **the conditions that actually failed**, joined from `blockedBy[].detail`; when a condition is acknowledgeable the message appends the exact count to echo back ([`shadow-review/route.ts:84-97`](../../../src/app/api/post-class-feedback/shadow-review/route.ts)). A stale count from a tab left open is rejected.

**Response `200`:** `{ok: true, settings, evidenceSyncRunId, conditions}`.

**Side effects:** `markPostClassShadowReviewed` stamps `shadow_reviewed_at`, bumps `version`, and writes a `shadow_review_confirmed` audit row recording the evidence run id, the acknowledged count, the reason, and every condition's pass/fail ([`settings.ts:368-410`](../../../src/lib/post-class-feedback/settings.ts)).

**Status codes:** 200 · 400 (Zod; not in shadow mode; no active mapping; any unmet condition) · 401 · 403 · 409 (stale `expectedVersion`, at either the handler's own check or inside `markPostClassShadowReviewed`) · 500 (`"Could not confirm the shadow review."`).

### `PATCH /api/post-class-feedback/access`

Toggles **one** capability for **one** allowlisted admin. Handler [`access/route.ts:21-46`](../../../src/app/api/post-class-feedback/access/route.ts).

**Auth:** `access_manager`.

**Body** — schema at [`access/route.ts:13-19`](../../../src/app/api/post-class-feedback/access/route.ts): `email` (valid email), `capability` (one of the four), `enabled` (boolean), `expectedVersion` (**non-negative** integer — `0` is the legitimate value for an admin with no grants yet), `note` (≤ 2000, optional).

The handler reads the target's current set, adds or removes the one capability, and hands the whole resulting set to `replacePostClassCapabilities` — the route is a delta API over a replace-shaped service ([`access/route.ts:26-37`](../../../src/app/api/post-class-feedback/access/route.ts)).

**Response `200`:** `{ ok: true, capabilities }` — the normalized resulting array.

**Side effects** ([`access.ts:219-379`](../../../src/lib/post-class-feedback/access.ts)): inside one transaction, takes `pg_advisory_xact_lock(hashtext('post_class_access_grants'))` so two managers cannot concurrently remove one another against the same stale manager count, then `SELECT … FOR KEY SHARE` on both admin rows so allowlist membership cannot change mid-mutation. New grants are **inserted before** obsolete grants are deleted, avoiding a transient last-manager gap. A `post_class_config_audit_log` row records the before/after capability sets and versions.

Four refusals from `assertPostClassCapabilityReplacementAllowed` ([`access.ts:91-126`](../../../src/lib/post-class-feedback/access.ts)) carry non-standard statuses: actor lacking `access_manager` → **403**; version mismatch → **409**; removing your own `access_manager` → **422** (another manager must do it, so an accidental save cannot lock you out of Settings); removing the **last** access manager → **422**.

**Status codes:** 200 · 400 (Zod) · 401 · 403 (`"Actor must be an allowlisted admin"`, or the capability check) · 404 (`"Target must be an allowlisted admin"`) · 409 · 422 (self-removal; last manager; missing actor/target email) · 500 (`"Could not update feature access."`).

### `PATCH /api/post-class-feedback/tutor-emails`

Sets or clears one tutor's `primary_email` on the shared `tutor_contacts` table. Handler [`tutor-emails/route.ts:18-40`](../../../src/app/api/post-class-feedback/tutor-emails/route.ts).

**Auth:** `access_manager`.

**Body** — schema at [`tutor-emails/route.ts:12-16`](../../../src/app/api/post-class-feedback/tutor-emails/route.ts): `tutorKey` (trimmed 1–250 — the canonical key), `primaryEmail` (valid email **or** `null` to clear), `expectedVersion` (non-negative integer).

**The version is epoch seconds, not a counter.** The handler pre-checks `Math.floor(updatedAt.getTime() / 1000) === expectedVersion` for an existing row, and requires exactly `0` when no `tutor_contacts` row exists yet ([`tutor-emails/route.ts:23-30`](../../../src/app/api/post-class-feedback/tutor-emails/route.ts)). The service re-checks the same thing under a tutor-scoped advisory lock plus `SELECT … FOR UPDATE`, then advances `updatedAt` by at least one whole second so two rapid saves cannot share a concurrency token ([`settings.ts:326-338`](../../../src/lib/post-class-feedback/settings.ts)).

**Response `200`:** `{ ok: true, tutor }` — the created or updated `tutor_contacts` row.

**Side effects:** creates the contact row when absent (seeding `displayName` and `sourceNames` from `post_class_sessions.canonical_tutor_name`), otherwise updates `primaryEmail`. Either way a `tutor_primary_email` audit row is written. An inactive contact row is treated as not found.

**Status codes:** 200 · 400 (Zod) · 401 · 403 · 404 (`"Tutor identity was not found."` when no session carries the key; `"Active tutor contact was not found."` for a deactivated contact) · 409 (version mismatch, at the handler pre-check or in the service) · 500 (`"Could not update the tutor primary email."`).

### `POST /api/post-class-feedback/test-email`

Sends one test message through the Apps Script relay. Part of the **parked** email subsystem — nothing dispatches tutor reminders or the digest on a schedule at this revision. Handler [`test-email/route.ts:10-23`](../../../src/app/api/post-class-feedback/test-email/route.ts).

**Auth:** `access_manager`.

**Body:** `{ recipientEmail }` — a single validated email ([`test-email/route.ts:8`](../../../src/app/api/post-class-feedback/test-email/route.ts)).

**Response `200`:** `{ ok: true, recipient, providerMessageId }` — returned from the service verbatim, **without** the usual `{ok, …}` re-wrap ([`test-email/route.ts:14-15`](../../../src/app/api/post-class-feedback/test-email/route.ts), [`notifications.ts:1220-1252`](../../../src/lib/post-class-feedback/notifications.ts)).

**Side effects:** sends the email with an idempotency key derived from a SHA-256 of actor, recipient, and timestamp; then stamps `post_class_settings.email_delivery_verified_at`, **bumps `settings.version` by one** (so any settings form open in another tab is now stale), and appends an `email_delivery / test_succeeded` audit row.

**Status codes:** 200 · 400 (Zod, or `"A valid test recipient email is required."`) · 401 · 403 · 500 (`"Could not send the test email."` — including any relay failure).

---

## Internal cron routes

### Conventions shared by all six

**Auth is the cron secret, and nothing else.** `/api/internal/*` is exempt from the middleware session gate ([`middleware.ts:24`](../../../src/middleware.ts)), so each handler's first statement is `rejectInvalidCronSecret(request)` ([`cron-auth.ts:19-26`](../../../src/lib/internal/cron-auth.ts)). It compares the `authorization` header against `Bearer ${CRON_SECRET}` with a length pre-check plus `timingSafeEqual` ([`cron-auth.ts:6-17`](../../../src/lib/internal/cron-auth.ts)). A **missing** `CRON_SECRET` returns `500 {"error":"Server misconfigured"}`; a wrong one returns `401 {"error":"Unauthorized"}`. All six are `GET`-only — a `POST` to any of them 405s at the framework.

**Every body is wrapped in `withCronInvocationAudit`.** The wrapper opens a `cron_invocations` row keyed by `jobKey` and `triggerSource`, runs the handler, and finalizes the row with the response status, duration, a size-capped response digest, and an extracted `errorSummary`. An **uncaught** throw is converted to `500 {"error": <message>}` and still audited ([`cron-audit.ts:191-206`](../../../src/lib/data-health/cron-audit.ts)). The audit is the mechanism Data Health uses to declare a job late or failing.

**No request body.** Only the backfill route reads anything from the request, and it reads query parameters.

**Manual runs.** Five of the six job keys have an in-process branch in the Data Health job runner, which calls the same libraries directly rather than re-issuing an HTTP request ([`run-job.ts:104-150`](../../../src/lib/data-health/run-job.ts)). `post_class_feedback_backfill` has **no** branch, so a targeted drain cannot be started from Data Health — only by a hand-issued request with the cron secret. That runner additionally requires the `access_manager` capability for any `post_class_feedback*` key and `confirmed: true` for any `dangerous` job ([`jobs/[jobKey]/run/route.ts:25-44`](../../../src/app/api/data-health/jobs/%5BjobKey%5D/run/route.ts)).

### `GET /api/internal/sync-post-class-feedback`

The rolling collector. Cron `13,43 * * * *`, job key `post_class_feedback`, `maxDuration = 800` ([`route.ts:13`](../../../src/app/api/internal/sync-post-class-feedback/route.ts)). Handler [`route.ts:15-46`](../../../src/app/api/internal/sync-post-class-feedback/route.ts).

**Side effects:** runs `runPostClassFeedbackSync({triggerType: "cron"})` — which requires `WISE_INSTITUTE_ID` and fails loudly without it ([`sync.ts:1050-1065`](../../../src/lib/post-class-feedback/sync.ts)) — then three follow-up passes under `Promise.allSettled`: AI review, due notification retries, and `runPostClassDeductionHygiene`. The hygiene pass **releases claims only, never approves**: it reopens unproven approvals and waives deductions on sessions the sync just found ineligible, returning `{reopened, reopenFailed, waived, waiveFailed}` ([`auto-approval.ts:266-281`](../../../src/lib/post-class-feedback/auto-approval.ts)).

**Response `200`:** `{ok: true, result, ai, retries, hygiene}` — `result` is `SyncPostClassFeedbackResult`; each of the other three degrades to `{failed: true}` when its settled promise rejected, so one broken pass never fails the run.

**Status codes:** 200 · 401 / 500 (secret) · **409** when `PostClassFeedbackSyncAlreadyRunningError` is caught — the single-flight guard, surfaced here as a typed conflict rather than an error ([`route.ts:39-41`](../../../src/app/api/internal/sync-post-class-feedback/route.ts)) · 500 (`"Post-class feedback sync failed"`, a fixed string that leaks nothing).

### `GET /api/internal/post-class-feedback-backfill`

Drains history behind the four-day rolling collector. Cron `23,53 * * * *`, job key `post_class_feedback_backfill`, `maxDuration = 800`. Handler [`route.ts:32-82`](../../../src/app/api/internal/post-class-feedback-backfill/route.ts).

**Query** — schema at [`route.ts:21-30`](../../../src/app/api/internal/post-class-feedback-backfill/route.ts), parsed from `Object.fromEntries(searchParams)`:

| Param | Type | Default |
|---|---|---|
| `startDate` / `endDate` | `YYYY-MM-DD` | none — when omitted, the window is chosen automatically |
| `detailCap` | coerced integer 1–400 | **50** |
| `maxBatches` | coerced integer 1–50 | **1** |

Two `refine` rules: the dates must be supplied **together**, and `startDate <= endDate`. Both `detailCap` and `maxBatches` use `z.coerce`, since query values arrive as strings.

**The two-tier cap is the point.** The scheduled cron takes the defaults — one batch of 50 detail calls — so routine runs never monopolise the Wise API; 400 is the ceiling a deliberate manual recovery may request ([`route.ts:64-68`](../../../src/app/api/internal/post-class-feedback-backfill/route.ts)). Both defaults are pinned by [`__tests__/route.test.ts`](../../../src/app/api/internal/post-class-feedback-backfill/__tests__/route.test.ts).

**Window selection:** with no explicit dates, `findOldestUnreconciledBackfillWindow` takes the oldest eligible session whose `source_status` is not `ready`, buckets it by the Bangkok calendar date it ended on, and extends forward by the window length, clamped to today ([`backfill-window.ts:32-56`](../../../src/lib/post-class-feedback/backfill-window.ts)). Repeated runs therefore converge without anyone choosing dates by hand.

**Responses `200`:** `{ok: true, skipped: "nothing-unreconciled"}` when no window is outstanding, otherwise `{ok: true, window, result}` where `result` is `PostClassBackfillJobResult` — `startDate`, `endDate`, `batches`, `detailFetchedCount`, `sessionSavedCount`, `sourceIssueCount`, `syncRuns[]`, `drained`, and `stoppedReason` (`"drained" | "batch_limit" | "time_limit"`) ([`backfill-job.ts:27-51`](../../../src/lib/post-class-feedback/backfill-job.ts)).

**Status codes:** 200 · 400 `{"error": <Zod flatten()>}` — **emitted before `withCronInvocationAudit`, so a malformed query writes no `cron_invocations` row** ([`route.ts:36-41`](../../../src/app/api/internal/post-class-feedback-backfill/route.ts)) · 401 / 500 (secret) · 409 (single-flight collision) · 500 (`"Post-class feedback backfill failed"`).

### `GET /api/internal/post-class-feedback/payout-accrual`

The hourly money job: accrue, then finalize if the window has ended. Cron `33 * * * *`, job key `post_class_feedback_payout_accrual`, `maxDuration = 800`, registry `dangerous: true` so even the manual Run-now path stays confirm-gated. Handler [`route.ts:18-41`](../../../src/app/api/internal/post-class-feedback/payout-accrual/route.ts).

**Side effects — two passes, unconditionally in this order:**

1. `runPayoutAccrualPass` ([`payout-accrual.ts:95-...`](../../../src/lib/post-class-feedback/payout-accrual.ts)) runs the auto-approval sweep (itself inert unless `POST_CLASS_AUTO_APPROVE_ENABLED` is the exact string `"true"` — [`payout-config.ts:164-168`](../../../src/lib/post-class-feedback/payout-config.ts)), then the ledger **retirement** pass, which removes rows whose violation cleared by deletion rather than by netting a correction. A retirement failure is deliberately non-fatal: it is logged and the pass continues. It then previews the current window and, unless everything is already written, publishes in `accrual` mode — which skips the window-ended guard, can never mint a `published` run, and skips the CSV/Drive leg entirely. Returns `{skipped: "nothing-pending"}` when there is nothing to append.
2. `runPayoutFinalizePass` ([`payout-accrual.ts:223-256`](../../../src/lib/post-class-feedback/payout-accrual.ts)) resolves a finalize-eligible window or returns `{skipped: "window-not-ended"}`, so a typical invocation's second half is a no-op. When a window does resolve, it sweeps auto-approvals again, previews, and publishes as the system actor with acknowledgements echoing its own preview counts. A `PostClassConflictError` is caught and downgraded to `{skipped: <message>}`; any other error propagates.

**Response `200`:** `{ok: true, accrual, finalize}` — each half is either a `{skipped}` marker or a full `PayoutRunView`.

**Status codes:** 200 · 401 / 500 (secret) · 500 (`"Post-class payout accrual failed"` — the `catch` discards the error entirely, so nothing about the ledger leaks into the response).

### `GET /api/internal/post-class-feedback/reminder-day-after` · `GET /api/internal/post-class-feedback/reminder-deadline`

The two tutor-reminder checkpoints. **Both are parked** — no `vercel.json` entry, `schedule: null`, `manualOnly: true`, `dangerous: true` with a confirmation label warning that a run may email tutors. `maxDuration = 800` on each. Handlers [`reminder-day-after/route.ts:9-30`](../../../src/app/api/internal/post-class-feedback/reminder-day-after/route.ts) and [`reminder-deadline/route.ts:9-30`](../../../src/app/api/internal/post-class-feedback/reminder-deadline/route.ts) — structurally identical apart from the checkpoint literal, the job key, and the error string.

**Side effects:** `runPostClassReminderJob(<checkpoint>, {triggerType: "cron"})` refreshes **every** candidate for the checkpoint before creating any tutor delivery, looping bounded sync batches until the checkpoint drains or the batch/time budget is spent ([`reminder-job.ts:49-...`](../../../src/lib/post-class-feedback/reminder-job.ts)).

**Responses:**

| Code | Body | Condition |
|---|---|---|
| 200 | `{ok: true, result}` | `result.ready === true` — the checkpoint drained and reminders dispatched |
| **503** | `{ok: false, error: "Post-class <checkpoint> reminder checkpoint still has unreconciled Wise sessions.", result}` | `result.ready === false` — dispatch stays **fail-closed** and Data Health records a recoverable failed invocation ([`reminder-day-after/route.ts:17-23`](../../../src/app/api/internal/post-class-feedback/reminder-day-after/route.ts)) |
| 401 / 500 | secret | |
| 500 | `"Post-class <checkpoint> reminder job failed"` | any throw |

`result` is `PostClassReminderJobResult` — `{ready, checkpoint, syncRuns[], reminder, blockedReason}` where `blockedReason` is `"batch_limit" | "time_limit" | "missing_checkpoint" | null` ([`reminder-job.ts:34-40`](../../../src/lib/post-class-feedback/reminder-job.ts)).

### `GET /api/internal/post-class-feedback/admin-digest`

The daily admin digest email. **Parked** — no cron entry, `manualOnly: true`, `dangerous: true`. The only one of the six with `maxDuration = 300` rather than 800 ([`route.ts:7`](../../../src/app/api/internal/post-class-feedback/admin-digest/route.ts)). Handler [`route.ts:9-23`](../../../src/app/api/internal/post-class-feedback/admin-digest/route.ts).

**Side effects:** `sendPostClassAdminDigest()` establishes a durable `post_class_notification_runs` row under an advisory lock, keyed by an idempotency key of `admin_digest` plus the Bangkok date — so a second call on the same day joins the existing run instead of sending twice. It then reconciles deliveries against the currently-enabled digest recipients, cancelling deliveries for recipients who are no longer active ([`notifications.ts:1127-1180`](../../../src/lib/post-class-feedback/notifications.ts)).

**Response `200`:** `{ok: true, digest}`.

**Status codes:** 200 · 401 / 500 (secret) · 500 (`"Post-class feedback digest job failed"` — the `catch` binds no error).

---

_Verified against main@0cd1e81 (clean tree) on 2026-09-02._
