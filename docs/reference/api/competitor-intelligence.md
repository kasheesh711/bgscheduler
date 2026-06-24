# Competitor Intelligence API

Endpoint reference for the market-intelligence workspace. All feature routes live under `src/app/api/competitor-intelligence/**`; the scheduled sync route lives under `src/app/api/internal/sync-competitor-intelligence/`.

This page documents the mechanical HTTP contract only. It does not assert whether vendor collection, budget policy, or task ownership are product-stable.

## Auth Model

Feature routes call `requireCompetitorIntelligenceSession()` (`src/lib/competitor-intelligence/access.ts`). That helper:

- returns `401 {"error":"Unauthorized"}` when there is no session email/name;
- returns `403 {"error":"Forbidden"}` when the session is restricted away from `/competitor-intelligence`;
- otherwise returns an admin actor `{ email, name, role: "admin" }`.

The shared `competitorIntelligenceErrorResponse()` maps those two auth errors as above and maps every other thrown error to `500 {"error": <message>}`. Several write routes use `ZodSchema.parse()` instead of `safeParse()`, so validation failures currently follow that generic `500` path.

## Dashboard

### `GET /api/competitor-intelligence`

- **Auth:** competitor-intelligence admin session.
- **Request:** none.
- **Response 200:** the full war-room payload from `getCompetitorIntelligencePayload()`.
- **Errors:** `401`, `403`, `500`.

## Manual Sync

### `POST /api/competitor-intelligence/sync`

- **Auth:** competitor-intelligence admin session.
- **Function config:** `maxDuration = 800`.
- **Request:** none.
- **Behavior:** runs `runCompetitorIntelligenceSync({ triggerType: "manual", actorEmail })`.
- **Response 200:** `{ ok: true, result }` when `result.status === "success"`.
- **Response 409:** `{ error }` when the thrown message contains `"already running"`.
- **Response 500:** `{ ok: false, result }` when the sync returns a non-success status, or `{ error }` for other thrown errors.

## Evidence

### `POST /api/competitor-intelligence/manual-evidence`

- **Auth:** competitor-intelligence admin session.
- **Body:** `{ entityId, title, contentText, canonicalUrl?, pricingSignal? }`.
  - `entityId` must be a UUID.
  - `title` is 2-180 trimmed chars.
  - `contentText` is 2-5000 trimmed chars.
  - `canonicalUrl`, when provided and non-null, must be a URL.
- **Response 200:** `{ evidence }`.
- **Errors:** `401`, `403`, `500` (including current Zod parse failures).

## Own-Brand Sources

### `GET /api/competitor-intelligence/own-sources`

- **Auth:** competitor-intelligence admin session.
- **Response 200:** `{ sources }`.
- **Errors:** `401`, `403`, `500`.

### `POST /api/competitor-intelligence/own-sources`

- **Auth:** competitor-intelligence admin session.
- **Body:** `{ sourceType, label, url, handle?, status? }`, where `sourceType` is `website | instagram | facebook` and `status` is `active | disabled | needs_review | archived`.
- **Response 201:** `{ source }`.
- **Errors:** `401`, `403`, `500` (including current Zod parse failures).

### `PATCH /api/competitor-intelligence/own-sources/[sourceId]`

- **Auth:** competitor-intelligence admin session.
- **Path param:** `sourceId`.
- **Body:** same shape as `POST /own-sources`.
- **Behavior:** `status: "disabled"` calls `disableOwnBrandSource`; all other statuses upsert the source with the path id.
- **Response 200:** `{ source }`.
- **Errors:** `401`, `403`, `500` (including current Zod parse failures).

## Competitor Sources

### `PATCH /api/competitor-intelligence/sources/[sourceId]`

- **Auth:** competitor-intelligence admin session.
- **Path param:** `sourceId`.
- **Body:** `{ status }`, where `status` is `active | disabled | needs_review | archived`.
- **Response 200:** `{ source }`.
- **Errors:** `401`, `403`, `500` (including current Zod parse failures).

## Tasks

### `PATCH /api/competitor-intelligence/tasks/[taskId]`

- **Auth:** competitor-intelligence admin session.
- **Path param:** `taskId`.
- **Body:** any subset of:
  - `status`: `todo | in_progress | blocked | done | ignored`
  - `ownerEmail`: email or null
  - `priority`: `low | medium | high`
  - `dueDate`: `YYYY-MM-DD` or null
  - `labels`: up to 8 strings, each 1-40 chars
- **Response 200:** `{ task }`.
- **Errors:** `401`, `403`, `500` (including current Zod parse failures).

### `POST /api/competitor-intelligence/task-suggestions/[suggestionId]/accept`

- **Auth:** competitor-intelligence admin session.
- **Path param:** `suggestionId`.
- **Request:** no body is read.
- **Response 200:** `{ task }`.
- **Errors:** `401`, `403`, `500`.

## Internal Sync

### `GET /api/internal/sync-competitor-intelligence`

- **Auth:** `CRON_SECRET` bearer only.
- **Function config:** `maxDuration = 800`.
- **Request:** none.
- **Behavior:** runs the same sync as cron with actor `cron@begifted.local`; audited as job key `competitor_intelligence`.

### `POST /api/internal/sync-competitor-intelligence`

- **Auth:** `CRON_SECRET` bearer, or competitor-intelligence admin session when the bearer check is not valid.
- **Request:** none.
- **Behavior:** cron-secret calls are `triggerType: "cron"`; session fallback calls are `triggerType: "manual"` with the admin email.

### Internal Sync Responses

| Status | When | Body |
|---|---|---|
| `200` | Sync returned `status: "success"` | `{ "ok": true, "result": ... }` |
| `401` | Invalid/missing bearer on `GET`, or no valid bearer/session on `POST` | `{ "error": "Unauthorized" }` |
| `409` | Sync throws an already-running error | `{ "error": <message> }` |
| `500` | Missing `CRON_SECRET` where required, non-success sync result, or other thrown error | `{ "error": <message> }` or `{ "ok": false, "result": ... }` |

_Verified against HEAD on 2026-06-22._
