# Sales Dashboard API

Endpoint reference for the Sales Dashboard feature. All routes live under `src/app/api/sales-dashboard/**` except the cron sync endpoint, which lives under `src/app/api/internal/sync-sales-dashboard/`.

For the meaning of sources, projections, import lifecycle, and why each rule exists, see the feature docs. This page documents endpoint signatures, request/response shapes, side effects, and status codes only.

## Auth model

Two distinct mechanisms appear across these endpoints:

- **Admin session.** Most routes call `auth()` from `@/lib/auth` and reject with `401 {"error":"Unauthorized"}` when there is no `session.user.email`. The session itself is gated by the admin allowlist: the NextAuth `signIn` callback only grants a session to emails present in the `admin_users` table (`src/lib/auth.ts:7-24`, `:42-45`). So a valid session is always an allowlisted admin.
- **Cron secret.** The `/api/internal/sync-sales-dashboard` route is matched as a public route in middleware (`src/middleware.ts:13`, `isPublicRoute` allows `/api/internal/*`), so the auth gate is enforced inside the handler instead, by comparing the `Authorization` header against `Bearer ${CRON_SECRET}` (`src/app/api/internal/sync-sales-dashboard/route.ts:14-21`).

A shared error helper maps a `MissingGoogleSheetsTokenError` (thrown when the connected Google account has no stored Sheets token / scope — `src/lib/sales-dashboard/google-oauth.ts:30-35`) to HTTP **409**, and all other thrown errors to **500**. This appears in the import, projection-import, and cron routes.

---

## Dashboard payload

### `GET /api/sales-dashboard`

File: `src/app/api/sales-dashboard/route.ts:5-18`

- **Auth:** admin session (`:6-9`).
- **Request:** none (no query params, no body).
- **Response 200:** the full dashboard payload from `getSalesDashboardPayload(session.user.email)` (`:12`). This is a `SalesDashboardPayload` (`src/lib/sales-dashboard/types.ts:63-93`) returned directly (not wrapped). Top-level keys include `normalDays`, `addDays`, `pkgCount`, `progCount`, `addPkgCount`, `repArr`, `dayCount`, `totalTxn`, `totalAddTxn`, `uniqueTrials`, `uniqueNewStudents`, `uniqueRenewals`, `churnedStudents`, `eligibleStudents`, `completionRate`, `completionMonths`, `weekBandPct`, `churnList`, `trialCohort`, `retentionCohort`, `lastUpdated`, `sources` (array of `SalesDashboardSourceSummary`), `projection` (`SalesDashboardProjectionPayload`), and `token` (`{ connected, email, expiresAt, lastError }`).
- **Side effects:** read path is wrapped in `"use cache"` with cache tag `sales-dashboard` and `cacheLife({ stale: 60, revalidate: 60, expire: 300 })` (`src/lib/sales-dashboard/data.ts:885-890`). Aggregation reads only the `lastSuccessfulImportRunId` rows of non-archived sources (`:847-883`).
- **Errors:** `401` (no session); `500 {"error": message}` on any thrown error, default message `"Failed to load sales dashboard"` (`:14-17`).

---

## Dimensions and transaction drills

These read from the same live Sales Dashboard materialization as the workspace tabs. They expose normalized dashboard fields only; raw sheet JSON, OAuth token state, and source internals are not serialized.

### `GET /api/sales-dashboard/dimensions`

File: `src/app/api/sales-dashboard/dimensions/route.ts:1-17`

- **Auth:** admin session (`:5-8`).
- **Request:** none.
- **Response 200:** `SalesDimensionsPayload` from `getSalesDimensionsPayload()` (`:11`). Top-level keys include `months`, `reps`, `repFunnels`, `programs`, `packages`, `additionalMix`, `students`, `targetMonthlyRevenue`, `unparsedPackageCount`, and `generatedAt`.
- **Side effects:** none; read-only aggregation.
- **Errors:** `401`; `500 {"error": message}` on any thrown error, default message `"Failed to load sales dimensions"` (`:13-16`).

### `GET /api/sales-dashboard/transactions`

File: `src/app/api/sales-dashboard/transactions/route.ts:1-36`

- **Auth:** admin session (`:10-13`).
- **Query params:** optional `rep`, `program`, `band`, `student`, `from`, `to`, `limit`, and `offset`. `from`/`to` must be `YYYY-MM-DD`. `limit` defaults to `200` and clamps at `1000`; `offset` defaults to `0` (`src/lib/sales-dashboard/transaction-query.ts:5-27`).
- **Response 200:** `{ "rows": SlimTransaction[], "total": number }`. Filtering is applied before pagination, and `total` is the filtered row count (`:25-31`).
- **Side effects:** none; reads `getLiveSlimRows()` and filters via `filterSlimTransactions()`.
- **Errors:** `401`; `400 {"error":"Invalid query","details":...}` on malformed query params; `500 {"error": message}` on any thrown error, default message `"Failed to load sales transactions"` (`:15-35`).

### `GET /api/sales-dashboard/transactions/export`

File: `src/app/api/sales-dashboard/transactions/export/route.ts:1-70`

- **Auth:** admin session (`:41-44`).
- **Query params:** optional `rep`, `program`, `band`, `student`, `from`, and `to`. These are the same filters as the JSON transaction route, without `limit` or `offset`; all matching rows are exported (`src/lib/sales-dashboard/transaction-query.ts:8-20`).
- **Response 200:** CSV text with a UTF-8 BOM and CRLF row endings. Headers are `Date`, `Kind`, `Student`, `Student Key`, `Rep`, `Program`, `Package`, `Band`, `Hours`, `Amount`, `Enrollment Type`, `Sales Type`, `Valid Until`, `Source Month`, and `Number Of Students` (`:10-26`).
- **Response headers:** `Content-Type: text/csv; charset=utf-8`; `Content-Disposition: attachment; filename="sales-dashboard-transactions-<from>-to-<to>.csv"`; `Cache-Control: no-store` (`:60-64`).
- **Side effects:** none; reads `getLiveSlimRows()`, filters via `filterSlimTransactions()`, and serializes the normalized slim transaction rows only.
- **Errors:** `401`; `400 {"error":"Invalid query","details":...}` on malformed query params; `500 {"error": message}` on any thrown error, default message `"Failed to export sales transactions"` (`:46-68`).

---

## Source management

These manage the per-month Google Sheet "sources" that feed the dashboard.

### `GET /api/sales-dashboard/sources`

File: `src/app/api/sales-dashboard/sources/route.ts:18-31`

- **Auth:** admin session (`:19-22`).
- **Request:** none.
- **Response 200:** `{ "sources": SalesDashboardSourceRecord[] }` from `listSalesDashboardSources(getDb())` (`:25`). By default archived sources are excluded — the query filters `status::text <> 'archived'` and orders by `sourceMonth` (`src/lib/sales-dashboard/data.ts:156-171`). Each record shape is `SalesDashboardSourceRecord` (`src/lib/sales-dashboard/types.ts:6-30`).
- **Errors:** `401`; `500` default message `"Failed to list sales dashboard sources"` (`:27-30`).

### `POST /api/sales-dashboard/sources`

File: `src/app/api/sales-dashboard/sources/route.ts:33-52`

- **Auth:** admin session (`:34-37`).
- **Request body (Zod `SourceInputSchema`, `:10-16`):**
  - `spreadsheetUrl`: string, min length 1 (required).
  - `sourceMonth`: string matching `^\d{4}-\d{2}(-\d{2})?$` (required; `YYYY-MM` or `YYYY-MM-DD`).
  - `label`: string, optional.
  - `normalSheetName`: string, optional.
  - `additionalSheetName`: string, optional.
- **Response 200:** `{ "source": SalesDashboardSourceRecord }` (`:47`). The handler truncates `sourceMonth` to its first 7 chars before passing to `upsertSalesDashboardSource`, and sets both `connectedEmail` and `actorEmail` to the session email (`:41-46`).
- **Side effects:** upserts a row in `sales_dashboard_sources` keyed on `sourceMonth` (conflict target `sourceMonth` where `archivedAt IS NULL`), extracts a spreadsheet ID from the URL, derives a `label` when absent, and revalidates the `sales-dashboard` cache tag (`src/lib/sales-dashboard/data.ts:173-210`). Does **not** import any data — only registers/updates the source.
- **Errors:** `401`; `400` on Zod validation failure or any other thrown error, default message `"Failed to save sales dashboard source"` (`:48-51`).

### `PATCH /api/sales-dashboard/sources/[sourceId]`

File: `src/app/api/sales-dashboard/sources/[sourceId]/route.ts:15-31`

- **Auth:** admin session (`:16-19`).
- **Path param:** `sourceId` (from `ctx.params`, awaited — `:22`).
- **Request body (Zod `PatchSchema`, `:9-11`):** `status`: enum `"active" | "finalized" | "reopened"` (required).
- **Response 200:** `{ "source": SalesDashboardSourceRecord }` from `updateSalesDashboardSourceStatus(sourceId, status, email)` (`:24-26`).
- **Side effects:** updates `status` and the matching timestamp (`finalizedAt` when finalizing, `reopenedAt` when reopening), clears archive fields, and revalidates the cache (`src/lib/sales-dashboard/data.ts:285-317`). If the source is currently `archived`, only `status: "active"` is allowed and it routes through restore logic; any other target status throws `"Restore archived source before changing its status."` (`:294-299`).
- **Errors:** `401`; `404 {"error":"Source not found"}` when the source lookup returns null (`:25`); `400 {"error": message}` on Zod failure or thrown error (e.g. the archived-restore guard), default message `"Failed to update source"` (`:27-30`).

### `DELETE /api/sales-dashboard/sources/[sourceId]`

File: `src/app/api/sales-dashboard/sources/[sourceId]/route.ts:33-48`

- **Auth:** admin session (`:34-37`).
- **Path param:** `sourceId` (awaited from `ctx.params` — `:40`).
- **Request:** no body.
- **Response 200:** `{ "ok": true, "source": SalesDashboardSourceRecord }` from `archiveSalesDashboardSource(sourceId, email)` (`:41-43`).
- **Side effects:** soft-delete — sets `status: "archived"`, records `archivedAt`, `archivedByEmail`, and `statusBeforeArchive`, then revalidates the cache (`src/lib/sales-dashboard/data.ts:319-346`). This is **not** a hard row delete. If the source is already archived it is returned unchanged; if it is `refreshing` the function throws `"Source is refreshing. Wait for the import to finish before archiving it."` (`:326-329`).
- **Errors:** `401`; `404 {"error":"Source not found"}` when the source is null (`:42`); `500 {"error": message}` on thrown error (e.g. archiving a refreshing source), default message `"Failed to archive source"` (`:44-47`).

### `POST /api/sales-dashboard/sources/seed`

File: `src/app/api/sales-dashboard/sources/seed/route.ts:5-18`

- **Auth:** admin session (`:6-9`).
- **Request:** no body.
- **Response 200:** `{ "sources": SalesDashboardSourceRecord[], "count": number }` (`:13`).
- **Side effects:** iterates `DEFAULT_SALES_SOURCES` and upserts each via `upsertSalesDashboardSource`, using the session email as both connected and actor email; revalidates the cache once per upsert (`src/lib/sales-dashboard/data.ts:212-226`). Registers default monthly sources only — does **not** import data.
- **Errors:** `401`; `500` default message `"Failed to seed sales sources"` (`:14-17`).

---

## Imports

### `POST /api/sales-dashboard/import`

File: `src/app/api/sales-dashboard/import/route.ts:30-96`. `export const maxDuration = 800` (`:12`).

- **Auth:** admin session (`:31-34`).
- **Request body (Zod `ImportSchema`, `:14-18`), all optional:**
  - `sourceId`: UUID.
  - `mode`: enum `"source" | "backfill" | "refreshable"`.
  - `allowFinalized`: boolean.
- **Behavior — three branches based on the body:**
  1. **`mode === "backfill"`** (`:38-54`): calls `importAllSalesSources(email)`, which imports every source with `triggerType: "backfill"` and `allowFinalized: true` (`src/lib/sales-dashboard/data.ts:579-593`).
  2. **`sourceId` present** (`:55-62`): imports that single source via `importSalesDashboardSource` with `triggerType: "manual"` and the supplied `allowFinalized`.
  3. **Default / no `sourceId`** (`:63-92`): if no sources are configured, returns an empty summary with a "Seed historical sources first." message; otherwise calls `importRefreshableSalesSources({ triggerType: "manual" })`, which imports only the current- and previous-month sources that are due to refresh and auto-finalizes eligible previous months (`src/lib/sales-dashboard/data.ts:559-577`).
- **Response 200 (single-source branch):** `{ "ok": true, "result": SalesDashboardImportOutcome }` (`:61`). The outcome is either a success result `{ sourceId, runId, normalRows, additionalRows, staleRunningImportsFailed }` or a skipped result `{ ..., skipped: true, alreadyRunning: true, runningStartedAt, message, staleRunningImportsFailed }` (`src/lib/sales-dashboard/import-guard.ts:16-40`).
- **Response 200 (backfill / refreshable branches):** `{ ok: true, results: SalesDashboardImportOutcome[], sourceCount, importedSourceCount, normalRows, additionalRows, message }` (`:43-53`, `:82-92`). `importedSourceCount` counts results that were not skipped (`:20-22`); `normalRows`/`additionalRows` are summed across results.
- **Side effects:** each per-source import acquires a single-flight run guard (skips if a run is already in progress), fails stale `running` rows older than 20 minutes, fetches Google Sheet rows, parses them, inserts into `sales_dashboard_normal_rows` / `sales_dashboard_additional_rows`, updates the source and run records, and revalidates the `sales-dashboard` cache (`src/lib/sales-dashboard/data.ts:406-557`; guard at `import-guard.ts:97-216`). Importing a `finalized` source without `allowFinalized` throws `"Source is finalized. Reopen or confirm manual refresh first."` (`data.ts:418-420`).
- **Errors:** `401`; **`409`** when a `MissingGoogleSheetsTokenError` is thrown (Google Sheets not connected); **`500`** for any other error (Zod parse failure included, since `ImportSchema.parse` throws). Error body is `{"error": message}` with default `"Sales dashboard import failed"` (`errorResponse`, `:24-28`).

### `GET /api/sales-dashboard/import-runs`

File: `src/app/api/sales-dashboard/import-runs/route.ts:5-18`

- **Auth:** admin session (`:6-9`).
- **Request:** none.
- **Response 200:** `{ "runs": [...] }` — the 20 most recent rows of `sales_dashboard_import_runs` ordered by `startedAt` descending (`listRecentSalesDashboardImportRuns`, `src/lib/sales-dashboard/data.ts:892-898`). Rows are returned as full `salesDashboardImportRuns` select rows.
- **Errors:** `401`; `500` default message `"Failed to list sales imports"` (`:14-17`).

---

## Projections

The projection source is a single active workbook (summary / what-if / calc-multi sheets) used for forecasting; only one row is `active` at a time.

### `POST /api/sales-dashboard/projection-source`

File: `src/app/api/sales-dashboard/projection-source/route.ts:16-39`

- **Auth:** admin session (`:17-20`).
- **Request body (Zod `ProjectionSourceInputSchema`, `:9-14`), all optional:**
  - `spreadsheetUrl`: string, min length 1.
  - `summarySheetName`: string.
  - `whatIfSheetName`: string.
  - `calcMultiSheetName`: string.
- **Behavior:** if `spreadsheetUrl` is provided, upserts the active projection source with the given (or default) sheet names via `upsertSalesDashboardProjectionSource`; if `spreadsheetUrl` is absent, falls back to `seedDefaultSalesDashboardProjectionSource`, which seeds the built-in default workbook URL and default sheet names (`:24-33`; `src/lib/sales-dashboard/data.ts:237-283`).
- **Response 200:** `{ "source": SalesDashboardProjectionSourceRecord }` (`:34`), shape at `src/lib/sales-dashboard/types.ts:124-142`.
- **Side effects:** upserts the single active row in `sales_dashboard_projection_sources` (updates the existing active row if present, else inserts), and revalidates the cache. Registers the source only — does **not** import projection data.
- **Errors:** `401`; `400` on Zod failure or thrown error, default message `"Failed to save projection source"` (`:35-38`).

### `POST /api/sales-dashboard/projection-import`

File: `src/app/api/sales-dashboard/projection-import/route.ts:8-28`. `export const maxDuration = 800` (`:6`).

- **Auth:** admin session (`:9-12`).
- **Request:** no body.
- **Behavior:** imports the active projection source via `importActiveSalesDashboardProjectionSource({ triggerType: "manual", actorEmail })` (`:15-18`). That helper returns `null` when no active projection source exists (`src/lib/sales-dashboard/data.ts:720-727`).
- **Response 200:** `{ "ok": true, "result": { sourceId, runId, projectionMonths, targetMonthlyRevenue } }` (`:22`; result shape at `data.ts:699-704`).
- **Response 409 (no source):** when the helper returns `null`, responds `409 {"error":"No projection source configured."}` (`:19-21`).
- **Side effects:** creates a `sales_dashboard_projection_import_runs` row, fetches and parses the projection workbook, inserts `sales_dashboard_projection_months`, updates source/run records, and revalidates the cache (`data.ts:625-718`). Required summary/what-if/calc-multi sheets that are missing cause the import to throw (`data.ts:595-598`).
- **Errors:** `401`; `409` (no source, as above, **and** when a `MissingGoogleSheetsTokenError` is thrown); `500 {"error": message}` for any other error, default message `"Sales projection import failed"` (`:23-27`).

---

## Cron sync (sales + projection)

### `GET /api/internal/sync-sales-dashboard` · `POST /api/internal/sync-sales-dashboard`

File: `src/app/api/internal/sync-sales-dashboard/route.ts`. `export const maxDuration = 800` (`:10`). Both verbs delegate to `handleSync` (`:23-58`); the only difference is the auth fallback (see below).

- **Auth:**
  - Primary: a constant-time check (`timingSafeEqual`) of the `Authorization` header against `Bearer ${CRON_SECRET}` (`:14-21`). If `CRON_SECRET` is unset, the secret check returns `missing-secret`.
  - **GET** (`:60-62`) calls `handleSync` with `allowSessionAuth: false` — only a valid cron secret is accepted. This is the endpoint Vercel Cron invokes (see schedule below).
  - **POST** (`:64-66`) calls `handleSync` with `allowSessionAuth: true` — if the cron secret is not valid, it falls back to an admin `auth()` session; a logged-in admin can trigger it manually (`:27-41`).
  - `actorEmail` is `"cron@begifted.local"` for cron-secret calls, or the session email when session auth is used (`:25`, `:30`).
- **Request:** no body or query params are read; only the `Authorization` header matters.
- **Behavior / side effects:** runs `importRefreshableSalesSources({ triggerType: "cron", actorEmail })` (current/previous-month due sources, with auto-finalize) **then** `importActiveSalesDashboardProjectionSource({ triggerType: "cron", actorEmail })` (`:43-51`). Both write to their respective row tables and revalidate the `sales-dashboard` cache as described above.
- **Response 200:** `{ "ok": true, "results": SalesDashboardImportOutcome[], "projectionResult": <projection result | null> }` (`:52`). `projectionResult` is `null` when no active projection source exists.
- **Errors:**
  - `401 {"error":"Unauthorized"}` — invalid cron secret with no usable session (GET always; POST when no admin session) (`:34`, `:39`).
  - `500 {"error":"Server misconfigured"}` — `CRON_SECRET` not set and no session path satisfied (`:32`, `:37`).
  - `409` — a thrown `MissingGoogleSheetsTokenError`; `500` for any other thrown error, default message `"Sales dashboard sync failed"` (`:53-57`).
- **Cron schedule:** registered in `vercel.json` at `"10,40 * * * *"` (twice hourly, `vercel.json:7-10`).

---

_Verified against HEAD + uncommitted WIP on 2026-05-31._
