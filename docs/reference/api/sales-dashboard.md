# Sales Dashboard API

HTTP reference for the 12 Sales Dashboard endpoints. Ten live under `/api/sales-dashboard/**` (admin-session), and two share the cron route `/api/internal/sync-sales-dashboard`. Together they: import monthly sales spreadsheets and scenario projections from Google Sheets into Postgres, manage the source/projection-source catalog and per-source lifecycle (active/finalized/reopened/archived), read the aggregated dashboard payload, and list recent import runs.

For *what* the Sales Dashboard means (Bear/Base/Bull scenarios, the finalize/refresh lifecycle, the shared Google-Sheets access layer, GM readout), see the feature documentation. This page documents mechanical request/response detail only.

All endpoints are implemented under `src/app/api/sales-dashboard/**/route.ts` and `src/app/api/internal/sync-sales-dashboard/route.ts`. The data layer they delegate to lives in `src/lib/sales-dashboard/data.ts`; payload/record types are in `src/lib/sales-dashboard/types.ts`.

## Conventions shared by the ten `/api/sales-dashboard/**` endpoints

**Authentication.** Every one of the ten admin endpoints begins with `const session = await auth(); if (!session?.user?.email) return 401 { "error": "Unauthorized" }`. There is no in-handler role/allowlist check beyond requiring a logged-in user with an email; the global middleware (`src/middleware.ts:37-48`) already redirects unauthenticated browser requests to `/login`, and none of the `/api/sales-dashboard/**` paths are in the public-route allowlist (`src/middleware.ts:4-15`). `session.user.email` is used as both the actor (`createdByEmail`/`updatedByEmail`) and, for new sources, the `connectedEmail` whose Google token is read at import time.

**Validation.** Endpoints that take a body validate it with a module-scope Zod schema and call `.parse()` (not `.safeParse()`). Because the `.parse()` call sits inside the handler's `try/catch`, a `ZodError` is caught and returned as the handler's error status (`400` for the write endpoints) with `{ "error": <error.message> }` — the raw Zod message string, not a `flatten()` payload. `GET` endpoints take no input.

**Error handling.** Each handler wraps its body in `try/catch` and returns `{ "error": <message> }` where `message = error instanceof Error ? error.message : "<fallback>"`. The HTTP status on the catch branch varies per endpoint (documented below): write/lifecycle endpoints use `400`, read endpoints use `500`, and the two import endpoints map a `MissingGoogleSheetsTokenError` to `409` (else `500`).

**Cache.** The cached dashboard payload registers under `cacheTag("sales-dashboard")` (`SALES_DASHBOARD_CACHE_TAG`, `src/lib/sales-dashboard/data.ts:53`, `886-888`). Every mutating data-layer helper (`upsertSalesDashboardSource`, `updateSalesDashboardSourceStatus`, `archiveSalesDashboardSource`, the import functions, etc.) calls `revalidateSalesDashboardCache()` which runs `revalidateTag("sales-dashboard", "max")`, swallowing only the "static generation store missing" error (`data.ts:89-96`). A successful write therefore forces the next `GET /api/sales-dashboard` to recompute.

**Google Sheets dependency.** The import endpoints read from Google Sheets through the OAuth token of the source's `connectedEmail` (`src/lib/sales-dashboard/google-oauth.ts`). When that account has no stored token, a missing read scope, or a missing refresh token, the data layer throws `MissingGoogleSheetsTokenError` (`google-oauth.ts:30-34, 155-227`), which the import handlers surface as **`409`**.

---

## Dashboard payload

### `GET /api/sales-dashboard`

Returns the fully aggregated dashboard payload for the active (non-archived) sources plus the active projection. Source: `src/app/api/sales-dashboard/route.ts`.

- **Auth:** `auth()` → `401` if no email (`route.ts:6-9`).
- **Request:** none (`GET()` takes no args).
- **Behavior:** calls `getSalesDashboardPayload(session.user.email)` (`route.ts:12`). That function is wrapped in `"use cache"` with `cacheTag("sales-dashboard")` and `cacheLife({ stale: 60, revalidate: 60, expire: 300 })` (`data.ts:885-890`); the uncached builder loads all non-archived sources, selects their `lastSuccessfulImportRunId` rows from `salesDashboardNormalRows` / `salesDashboardAdditionalRows`, reads the caller's Google token status, assembles the projection payload, and runs `buildSalesDashboardPayload(...)` (`data.ts:847-883`).
- **Side effects:** none (read-only).
- **Response `200`:** a `SalesDashboardPayload` object (`src/lib/sales-dashboard/types.ts:63-93`). Top-level keys include `normalDays`, `addDays`, `pkgCount`, `progCount`, `addPkgCount`, `repArr`, `dayCount`, `totalTxn`, `totalAddTxn`, `uniqueTrials`, `uniqueNewStudents`, `uniqueRenewals`, `churnedStudents`, `eligibleStudents`, `completionRate`, `completionMonths`, `weekBandPct`, `churnList`, `trialCohort`, `retentionCohort`, `lastUpdated`, `sources` (array of `SalesDashboardSourceSummary`, `types.ts:105-122`), `projection` (`SalesDashboardProjectionPayload`, `types.ts:95-103`), and `token` (`{ connected, email, expiresAt, lastError }`).
- **Errors:** `401` (no session); `500` `{ "error": <message | "Failed to load sales dashboard"> }` on any thrown error (`route.ts:14-17`).

---

## Monthly source imports

### `POST /api/sales-dashboard/import`

Multi-mode import trigger for the monthly normal/additional sales sheets. Source: `src/app/api/sales-dashboard/import/route.ts`. Carries `export const maxDuration = 800` (`route.ts:12`).

- **Auth:** `auth()` → `401` (`route.ts:31-34`).
- **Request body** — `ImportSchema` (`route.ts:14-18`), all fields optional:
  - `sourceId?: string` (UUID)
  - `mode?: "source" | "backfill" | "refreshable"`
  - `allowFinalized?: boolean`
- **Behavior** (branch order, `route.ts:37-92`):
  1. **`mode === "backfill"`** → `importAllSalesSources(email)` re-imports **every** non-archived source with `triggerType: "backfill"` and `allowFinalized: true` (`data.ts:579-593`).
  2. **else if `sourceId` present** → `importSalesDashboardSource(sourceId, { triggerType: "manual", actorEmail, allowFinalized })` imports that single source (`data.ts:406`). A `finalized` source with `allowFinalized` not set throws `"Source is finalized. Reopen or confirm manual refresh first."` (`data.ts:418-419`); an archived source throws `"Sales dashboard source is archived. Restore it before importing."` (`data.ts:402`).
  3. **else (no `sourceId`, mode `"source"`/`"refreshable"`/absent)** → if there are zero configured sources, returns an empty-result envelope with a seed-first `message`; otherwise `importRefreshableSalesSources({ triggerType: "manual", actorEmail })` imports only the current/previous-month sources that need a refresh, auto-finalizing eligible previous-month sources along the way (`data.ts:559-577`, `route.ts:63-92`).
- **Side effects (per imported source):** acquires a single-flight `salesDashboardImportRuns` row (`acquireSalesImportRun`, fails any run stuck `running` > 20 min first — `STALE_RUNNING_SALES_IMPORT_MS`, `src/lib/sales-dashboard/import-guard.ts:6`); flips the source to `refreshing`; fetches + parses the resolved normal/additional sheets; chunk-inserts parsed rows into `salesDashboardNormalRows` / `salesDashboardAdditionalRows` (500-row chunks, `data.ts:145-153`); marks the run `success`, updates the source's `lastSuccessfulImportRunId` / row counts / next status (active→finalized auto-finalize via `statusAfterSuccessfulImport`), and revalidates the cache (`data.ts:451-544`). On failure the run is marked `failed`, the source reverts to its previous status with `lastImportError`, and the error re-throws (`data.ts:545-556`).
- **Responses:**
  - **`200`** — single-source (`{ "ok": true, "result": <SalesDashboardImportOutcome> }`, `route.ts:61`). The outcome is either `{ sourceId, runId, normalRows, additionalRows, staleRunningImportsFailed? }` or a skipped result `{ sourceId, runId, normalRows: 0, additionalRows: 0, skipped: true, alreadyRunning: true, runningStartedAt, message, staleRunningImportsFailed }` (`import-guard.ts:16-40`).
  - **`200`** — backfill / refreshable / empty (`route.ts:43-92`): `{ ok: true, results: SalesDashboardImportOutcome[], sourceCount, importedSourceCount, normalRows, additionalRows, message }`. `importedSourceCount` counts non-skipped results; `normalRows`/`additionalRows` are summed across results. The `message` is the seed-first string when no sources are configured.
  - **`409`** — `MissingGoogleSheetsTokenError` → `{ "error": <message> }` (`errorResponse`, `route.ts:24-28`).
  - **`500`** — any other thrown error → `{ "error": <message | "Sales dashboard import failed"> }`.
  - **`401`** — no session.

### `GET /api/sales-dashboard/import-runs`

Lists the most recent monthly import runs. Source: `src/app/api/sales-dashboard/import-runs/route.ts`.

- **Auth:** `auth()` → `401` (`route.ts:6-9`).
- **Request:** none.
- **Behavior:** `listRecentSalesDashboardImportRuns()` selects from `salesDashboardImportRuns` ordered by `startedAt DESC`, limit `20` (`data.ts:892-897`).
- **Side effects:** none.
- **Response `200`:** `{ "runs": SalesDashboardImportRun[] }` — raw `salesDashboardImportRuns` rows (status, trigger type, actor, started/finished timestamps, normal/additional row counts, error summary, metadata). For the column list see [the database reference](../database/index.md).
- **Errors:** `401`; `500` `{ "error": <message | "Failed to list sales imports"> }` (`route.ts:14-17`).

---

## Source catalog

### `GET /api/sales-dashboard/sources`

Lists all non-archived monthly sources. Source: `src/app/api/sales-dashboard/sources/route.ts`.

- **Auth:** `auth()` → `401` (`route.ts:19-22`).
- **Request:** none.
- **Behavior:** `listSalesDashboardSources(getDb())` selects every `salesDashboardSources` row where `status <> 'archived'`, ordered by `sourceMonth` (`data.ts:156-171`); archived rows are excluded.
- **Side effects:** none.
- **Response `200`:** `{ "sources": SalesDashboardSourceRecord[] }` (`types.ts:6-30` — `id`, `sourceMonth`, `label`, `spreadsheetId`, `spreadsheetUrl`, `normalSheetName`, `additionalSheetName`, `status`, `lastSuccessfulImportRunId`, `lastImportedAt`, `lastImportError`, `lastNormalRowCount`, `lastAdditionalRowCount`, finalize/reopen/archive timestamps, `connectedEmail`, audit emails, `createdAt`, `updatedAt`).
- **Errors:** `401`; `500` `{ "error": <message | "Failed to list sales dashboard sources"> }` (`route.ts:27-30`).

### `POST /api/sales-dashboard/sources`

Creates or updates (upserts by month) a monthly source. Source: `src/app/api/sales-dashboard/sources/route.ts`.

- **Auth:** `auth()` → `401` (`route.ts:34-37`).
- **Request body** — `SourceInputSchema` (`route.ts:10-16`):
  - `spreadsheetUrl: string` (min length 1, required)
  - `sourceMonth: string` matching `/^\d{4}-\d{2}(-\d{2})?$/` (required; truncated to `YYYY-MM` before persistence, `route.ts:43`)
  - `label?: string`
  - `normalSheetName?: string`
  - `additionalSheetName?: string`
- **Behavior:** `upsertSalesDashboardSource({ ...input, sourceMonth: input.sourceMonth.slice(0,7), connectedEmail: email, actorEmail: email })` (`route.ts:41-46`). The helper extracts the spreadsheet id from the URL, derives a month label when none is given, and `INSERT ... ON CONFLICT (sourceMonth) WHERE archivedAt IS NULL DO UPDATE`, so a second POST for the same month edits the existing non-archived row rather than creating a duplicate (`data.ts:173-210`).
- **Side effects:** writes a `salesDashboardSources` row; calls `revalidateSalesDashboardCache()`.
- **Response `200`:** `{ "source": SalesDashboardSourceRecord }`.
- **Errors:** `401`; `400` `{ "error": <message | "Failed to save sales dashboard source"> }` on Zod or DB failure (`route.ts:48-51`).

### `POST /api/sales-dashboard/sources/seed`

Seeds the default set of historical monthly sources. Source: `src/app/api/sales-dashboard/sources/seed/route.ts`.

- **Auth:** `auth()` → `401` (`route.ts:6-9`).
- **Request:** none (`POST()` reads no body).
- **Behavior:** `seedDefaultSalesSources(session.user.email)` upserts each entry in `DEFAULT_SALES_SOURCES` (`src/lib/sales-dashboard/default-sources.ts`) via `upsertSalesDashboardSource` (`data.ts:212-226`). Idempotent — re-running edits the same per-month rows rather than duplicating them.
- **Side effects:** upserts multiple `salesDashboardSources` rows; each upsert revalidates the cache.
- **Response `200`:** `{ "sources": SalesDashboardSourceRecord[], "count": number }` (`route.ts:12-13`).
- **Errors:** `401`; `500` `{ "error": <message | "Failed to seed sales sources"> }` (`route.ts:14-17`).

### `PATCH /api/sales-dashboard/sources/[sourceId]`

Changes a single source's lifecycle status. Source: `src/app/api/sales-dashboard/sources/[sourceId]/route.ts`.

- **Auth:** `auth()` → `401` (`route.ts:16-19`).
- **Path param:** `sourceId` (awaited from `ctx.params`, `route.ts:22`).
- **Request body** — `PatchSchema` (`route.ts:9-11`): `{ status: "active" | "finalized" | "reopened" }` (required enum).
- **Behavior:** `updateSalesDashboardSourceStatus(sourceId, status, email)` (`route.ts:24`, `data.ts:285-317`). Returns `null` if the source does not exist. If the source is currently `archived`, only `status: "active"` is allowed (it routes to `restoreSalesDashboardSource`; any other target throws `"Restore archived source before changing its status."`). Otherwise it sets the new status and stamps `finalizedAt`/`reopenedAt` accordingly, clearing archive fields.
- **Side effects:** updates the `salesDashboardSources` row; `revalidateSalesDashboardCache()`.
- **Response `200`:** `{ "source": SalesDashboardSourceRecord }`.
- **Errors:** `401`; **`404`** `{ "error": "Source not found" }` when the helper returns `null` (`route.ts:25`); `400` `{ "error": <message | "Failed to update source"> }` on Zod error or a thrown lifecycle error (the archived-restore guard message surfaces as `400`, `route.ts:27-30`).

### `DELETE /api/sales-dashboard/sources/[sourceId]`

Archives (soft-deletes) a single source. Source: `src/app/api/sales-dashboard/sources/[sourceId]/route.ts`.

- **Auth:** `auth()` → `401` (`route.ts:34-37`).
- **Path param:** `sourceId` (`route.ts:40`).
- **Request:** no body.
- **Behavior:** `archiveSalesDashboardSource(sourceId, email)` (`route.ts:41`, `data.ts:319-346`). Returns `null` if the source does not exist; if already `archived` it is returned unchanged; if currently `refreshing` it throws `"Source is refreshing. Wait for the import to finish before archiving it."`. Otherwise it sets `status: "archived"`, records `archivedAt`/`archivedByEmail`/`statusBeforeArchive`, and does **not** delete imported rows.
- **Side effects:** updates the `salesDashboardSources` row to archived; `revalidateSalesDashboardCache()`.
- **Response `200`:** `{ "ok": true, "source": SalesDashboardSourceRecord }`.
- **Errors:** `401`; **`404`** `{ "error": "Source not found" }` when the helper returns `null` (`route.ts:42`); `500` `{ "error": <message | "Failed to archive source"> }` — note the `refreshing` guard surfaces as `500` here, not `400` (`route.ts:44-47`).

---

## Projection source

### `POST /api/sales-dashboard/projection-source`

Creates or updates the single active scenario-projection source (Bear/Base/Bull workbook). Source: `src/app/api/sales-dashboard/projection-source/route.ts`.

- **Auth:** `auth()` → `401` (`route.ts:17-20`).
- **Request body** — `ProjectionSourceInputSchema` (`route.ts:9-14`), all optional:
  - `spreadsheetUrl?: string` (min length 1)
  - `summarySheetName?: string`
  - `whatIfSheetName?: string`
  - `calcMultiSheetName?: string`
- **Behavior:** if `spreadsheetUrl` is present → `upsertSalesDashboardProjectionSource({ ...sheet names, connectedEmail: email, actorEmail: email })` (`data.ts:237-272`); otherwise → `seedDefaultSalesDashboardProjectionSource(email)`, which upserts the built-in default projection workbook + default sheet names (`data.ts:274-283`). The upsert updates the existing `status: "active"` projection-source row if one exists, else inserts one; missing sheet names default to `DEFAULT_PROJECTION_*` constants.
- **Side effects:** writes the `salesDashboardProjectionSources` row; `revalidateSalesDashboardCache()`. Does **not** import workbook data (that is `projection-import`).
- **Response `200`:** `{ "source": SalesDashboardProjectionSourceRecord }` (`types.ts:124-142`).
- **Errors:** `401`; `400` `{ "error": <message | "Failed to save projection source"> }` (`route.ts:35-38`).

### `POST /api/sales-dashboard/projection-import`

Imports the active projection workbook (parses scenario months from the Summary/What_If/Calc_Multi sheets). Source: `src/app/api/sales-dashboard/projection-import/route.ts`. Carries `export const maxDuration = 800` (`route.ts:6`).

- **Auth:** `auth()` → `401` (`route.ts:9-12`).
- **Request:** none (`POST()` reads no body).
- **Behavior:** `importActiveSalesDashboardProjectionSource({ triggerType: "manual", actorEmail: email })` (`route.ts:15-18`). Resolves the active projection source; returns `null` (→ `409`) when none is configured (`data.ts:720-727`). Otherwise it inserts a `salesDashboardProjectionImportRuns` row (`running`), fetches + parses the three required sheets (each missing sheet throws `Projection workbook is missing <purpose> sheet "<name>"`), chunk-inserts parsed scenario months into `salesDashboardProjectionMonths`, then marks the run `success` and updates the projection source's `lastSuccessfulImportRunId` / `lastProjectionMonthCount` / `lastTargetMonthlyRevenue` (`data.ts:625-718`). On failure the run is marked `failed`, `lastImportError` is set, the cache is revalidated, and the error re-throws.
- **Side effects:** inserts a projection import-run row and projection-month rows; updates the projection source; `revalidateSalesDashboardCache()`.
- **Responses:**
  - **`200`** — `{ "ok": true, "result": { sourceId, runId, projectionMonths, targetMonthlyRevenue } }` (`data.ts:699-704`).
  - **`409`** — no projection source configured → `{ "error": "No projection source configured." }` (`route.ts:19-21`); also `409` for `MissingGoogleSheetsTokenError` (`route.ts:24-26`).
  - **`500`** — any other thrown error → `{ "error": <message | "Sales projection import failed"> }`.
  - **`401`** — no session.

---

## Internal cron (combined refresh)

### `GET /api/internal/sync-sales-dashboard` · `POST /api/internal/sync-sales-dashboard`

The Vercel-cron-driven combined refresh: refreshable monthly sources **and** the active projection in one invocation. Both verbs share one handler (`handleSync`). Source: `src/app/api/internal/sync-sales-dashboard/route.ts`. Carries `export const maxDuration = 800` (`route.ts:11`). Registered cron: `vercel.json:8-10`, schedule `10,40 * * * *`.

- **Auth (differs from the admin endpoints):** this route is in the middleware public-route allowlist via the `pathname.startsWith("/api/internal/")` branch (`src/middleware.ts:13`), so the middleware does not gate it — the handler authorizes itself:
  - Constant-time `CRON_SECRET` check: compares the `Authorization` header against `Bearer ${CRON_SECRET}` with a length pre-check + `timingSafeEqual` (`route.ts:15-22`), yielding `valid` / `invalid` / `missing-secret`.
  - **`GET`** calls `handleSync(request, { allowSessionAuth: false })` (`route.ts:71-73`): a valid cron secret is the only accepted credential. `missing-secret` → `500 { "error": "Server misconfigured" }`; otherwise `invalid` → `401 { "error": "Unauthorized" }`.
  - **`POST`** calls `handleSync(request, { allowSessionAuth: true })` (`route.ts:75-77`): when the cron secret is not `valid`, it falls back to an Auth.js `auth()` session — a logged-in admin email is accepted (actor = that email); else `missing-secret` → `500`, else `401`.
  - The actor email is `cron@begifted.local` for cron-secret calls, or the session email for admin calls (`route.ts:25-42`).
- **Request:** no body is read for either verb.
- **Behavior:** wraps the work in `withCronInvocationAudit({ jobKey: "sales_dashboard", triggerSource: <"cron" | "admin">, actorEmail, requestMethod }, ...)` (`route.ts:44-50`, `src/lib/data-health/cron-audit.ts:144-159`), which records a `cronInvocations` row (start + finish/status) under the registered `sales_dashboard` job (`src/lib/data-health/cron-registry.ts:67`). Inside, it runs `importRefreshableSalesSources({ triggerType: "cron", actorEmail })` then `importActiveSalesDashboardProjectionSource({ triggerType: "cron", actorEmail })` (`route.ts:52-60`).
- **Side effects:** same per-source import side effects as `POST /api/sales-dashboard/import` (run rows, `refreshing` state, row inserts, status transitions, cache revalidation) for any source that needs refreshing, plus a projection import run + month rows when a projection source is active; and one `cronInvocations` audit row per request.
- **Responses:**
  - **`200`** — `{ "ok": true, "results": SalesDashboardImportOutcome[], "projectionResult": <projection outcome | null> }` (`route.ts:61`). `projectionResult` is `null` when no active projection source exists.
  - **`409`** — `MissingGoogleSheetsTokenError` thrown inside the work → `{ "error": <message> }` (`route.ts:63-65`).
  - **`500`** — any other thrown error inside the work → `{ "error": <message | "Sales dashboard sync failed"> }`. (The audit wrapper also converts a handler throw into a `500` `{ "error": <message> }` and still records the invocation, `cron-audit.ts:153-158`.)
  - **`401` / `500`** — auth failures as described above (`Unauthorized` / `Server misconfigured`).

_Verified against HEAD `d4fe6d3` on 2026-06-05._
