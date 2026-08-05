# Sales Dashboard API

**Authoritative source:** the twelve route files under [`src/app/api/sales-dashboard/`](../../../src/app/api/sales-dashboard/) and [`src/app/api/internal/sync-sales-dashboard/route.ts`](../../../src/app/api/internal/sync-sales-dashboard/route.ts), which together export the **15 handlers** documented here.

This page is the mechanical reference for the Sales Dashboard HTTP endpoints: method, path, auth, request shape, response shape, side effects, and status codes. Feature meaning — what a "source" is, why months finalize, how the GM readout is derived — lives in [docs/features/sales-dashboard.md](../../features/sales-dashboard.md). Column definitions for the `sales_dashboard_*` tables live in [`schema.ts`](../../../src/lib/db/schema.ts) and are indexed from [docs/reference/database/index.md](../database/index.md). The cron entry itself is catalogued in [docs/reference/crons.md](../crons.md).

## Endpoints at a glance

| Method | Path | Auth | Purpose |
|--------|------|------|---------|
| `GET` | `/api/internal/sync-sales-dashboard` | cron secret | Scheduled refresh of live-month sources + the projection workbook. |
| `POST` | `/api/internal/sync-sales-dashboard` | cron secret **or** session | Same job, manually triggerable by a signed-in admin. |
| `GET` | `/api/sales-dashboard` | session | Aggregated landing payload (analytics, sources, projection, token status). |
| `GET` | `/api/sales-dashboard/dimensions` | session | Month-grain dimensions payload for the tabbed workspace. |
| `POST` | `/api/sales-dashboard/import` | session | Manual import: one source, backfill-all, or the refreshable set. |
| `GET` | `/api/sales-dashboard/import-runs` | session | 20 most recent monthly-source import runs. |
| `POST` | `/api/sales-dashboard/projection-import` | session | Import the active scenario-projection workbook. |
| `POST` | `/api/sales-dashboard/projection-source` | session | Upsert (or seed the default) projection source. |
| `GET` | `/api/sales-dashboard/sources` | session | List non-archived monthly sources. |
| `POST` | `/api/sales-dashboard/sources` | session | Upsert one monthly source, keyed by month. |
| `DELETE` | `/api/sales-dashboard/sources/[sourceId]` | session | Archive a source (soft delete). |
| `PATCH` | `/api/sales-dashboard/sources/[sourceId]` | session | Change a source's lifecycle status. |
| `POST` | `/api/sales-dashboard/sources/seed` | session | Seed the 14 built-in historical sources. |
| `GET` | `/api/sales-dashboard/transactions` | session | Paged, filtered slim transaction rows. |
| `GET` | `/api/sales-dashboard/transactions/export` | session | Same filter set, streamed as CSV. |

---

## Conventions shared across the endpoints

**Authentication is a session, not a role.** Each of the 13 `/api/sales-dashboard/*` handlers opens with the same two lines — `const session = await auth();` then `if (!session?.user?.email) return 401 {"error":"Unauthorized"}` ([`route.ts:5-9`](../../../src/app/api/sales-dashboard/route.ts)). There is no in-handler role check beyond "signed in with an email". The middleware gates the subtree first: `/api/sales-dashboard/**` is not in the public-route allowlist ([`middleware.ts:4-20`](../../../src/middleware.ts)), so an unauthenticated browser request is redirected to `/login` ([`middleware.ts:70-75`](../../../src/middleware.ts)), and a signed-in user whose `allowedPages` does not cover `/sales-dashboard` gets `403 {"error":"Forbidden"}` before the handler runs ([`middleware.ts:79-82`](../../../src/middleware.ts)). The in-handler check is the API-level backstop and the only source of a `401` on these 13 routes.

`/api/internal/sync-sales-dashboard` is the exception: the whole `/api/internal/` prefix **is** in the public-route allowlist ([`middleware.ts:18`](../../../src/middleware.ts)), so that route's own `CRON_SECRET` comparison is the only gate.

**The session email is load-bearing, not just an audit field.** It becomes `actorEmail` on every import run, and on source upserts it is also stored as `connectedEmail` — the Google account whose OAuth token will be used to read that spreadsheet ([`sources/route.ts:41-46`](../../../src/app/api/sales-dashboard/sources/route.ts), [`data.ts:195`](../../../src/lib/sales-dashboard/data.ts)). Emails are trimmed and lowercased on write.

**Zod usage is split, and the split changes the status code.** Four routes declare module-scope schemas but call `.parse()` (not `.safeParse()`) *inside* the route's `try`, so a validation failure surfaces with that catch block's status rather than the repo-standard `400 … .error.flatten()`:

| Schema | File | Failure status |
|--------|------|----------------|
| `ImportSchema` | [`import/route.ts:14-18`](../../../src/app/api/sales-dashboard/import/route.ts) | **500** (via `errorResponse`) |
| `ProjectionSourceInputSchema` | [`projection-source/route.ts:9-14`](../../../src/app/api/sales-dashboard/projection-source/route.ts) | 400 |
| `SourceInputSchema` | [`sources/route.ts:10-16`](../../../src/app/api/sales-dashboard/sources/route.ts) | 400 |
| `PatchSchema` | [`sources/[sourceId]/route.ts:9-11`](../../../src/app/api/sales-dashboard/sources/[sourceId]/route.ts) | 400 |

The two query-string routes do use `.safeParse()` and return the conventional `400 {"error":"Invalid query","details": <flatten()>}` ([`transactions/route.ts:17-22`](../../../src/app/api/sales-dashboard/transactions/route.ts), [`transactions/export/route.ts:43-48`](../../../src/app/api/sales-dashboard/transactions/export/route.ts)). The remaining routes take no input at all.

**Google Sheets token failures are a distinct status.** Anything that reads a spreadsheet can throw `MissingGoogleSheetsTokenError` ([`google-oauth.ts:34-39`](../../../src/lib/sales-dashboard/google-oauth.ts)) when the `connectedEmail` has no stored token, is missing the Sheets read scope, or cannot be refreshed ([`google-oauth.ts:191-205`](../../../src/lib/sales-dashboard/google-oauth.ts), [`google-oauth.ts:158-163`](../../../src/lib/sales-dashboard/google-oauth.ts)). The three import routes map it to **409**; everywhere else it degrades to an ordinary 500.

**Cache tag and invalidation.** The four cached readers all register under `SALES_DASHBOARD_CACHE_TAG = "sales-dashboard"` with `cacheLife({ stale: 60, revalidate: 60, expire: 300 })` ([`data.ts:61`](../../../src/lib/sales-dashboard/data.ts), [`data.ts:919-924`](../../../src/lib/sales-dashboard/data.ts), [`data.ts:932-941`](../../../src/lib/sales-dashboard/data.ts), [`data.ts:948-965`](../../../src/lib/sales-dashboard/data.ts)). Every source mutation and every import calls `revalidateSalesDashboardCache()` → `revalidateTag("sales-dashboard", "max")`, which swallows only the `"static generation store missing"` error and rethrows anything else ([`data.ts:97-104`](../../../src/lib/sales-dashboard/data.ts)). Refreshing a Google access token also revalidates the tag ([`google-oauth.ts:177`](../../../src/lib/sales-dashboard/google-oauth.ts)).

**Live rows are run-scoped.** Every read path goes through `loadLiveRowData()`, which selects `sales_dashboard_normal_rows` / `sales_dashboard_additional_rows` filtered to each non-archived source's `lastSuccessfulImportRunId` ([`data.ts:869-901`](../../../src/lib/sales-dashboard/data.ts)). Rows written by a failed or in-flight run are therefore never visible, and re-importing a month supersedes the previous run's rows without deleting them.

**Per-source single-flight.** Concurrency is guarded at the source level, not the route level: `acquireSalesImportRun` fails runs stuck `running` for more than 20 minutes, then refuses to start a second run while one is live ([`import-guard.ts:6-9`](../../../src/lib/sales-dashboard/import-guard.ts), [`import-guard.ts:168-216`](../../../src/lib/sales-dashboard/import-guard.ts)). A partial unique index (`sdir_source_single_running_idx`) backs it in Postgres ([`schema.ts:666-668`](../../../src/lib/db/schema.ts)). A blocked call returns HTTP **200** carrying `skipped: true` / `alreadyRunning: true` — it is not an error.

**`maxDuration = 800`** is set on the three long-running routes: the internal sync ([`route.ts:11`](../../../src/app/api/internal/sync-sales-dashboard/route.ts)), `import` ([`import/route.ts:12`](../../../src/app/api/sales-dashboard/import/route.ts)), and `projection-import` ([`projection-import/route.ts:6`](../../../src/app/api/sales-dashboard/projection-import/route.ts)).

**Import outcome object.** Several endpoints return `SalesDashboardImportOutcome`, a union ([`import-guard.ts:16-40`](../../../src/lib/sales-dashboard/import-guard.ts)):

- Success — `{ sourceId, runId, normalRows, additionalRows, staleRunningImportsFailed? }`.
- Skipped — `{ sourceId, runId, normalRows: 0, additionalRows: 0, skipped: true, alreadyRunning: true, runningStartedAt, message, staleRunningImportsFailed }`.

---

## Scheduled + manual sync

### `GET /api/internal/sync-sales-dashboard`

The Vercel Cron entry point. Registered at `10,40 * * * *` in [`vercel.json`](../../../vercel.json) and mirrored in the cron registry under job key `sales_dashboard` ([`cron-registry.ts:77-91`](../../../src/lib/data-health/cron-registry.ts)). Handler: [`route.ts:71-73`](../../../src/app/api/internal/sync-sales-dashboard/route.ts).

**Auth:** `Authorization: Bearer $CRON_SECRET` only — `allowSessionAuth: false` ([`route.ts:72`](../../../src/app/api/internal/sync-sales-dashboard/route.ts)). The comparison is constant-time: both strings are buffered, length-checked, then compared with `timingSafeEqual` ([`route.ts:15-22`](../../../src/app/api/internal/sync-sales-dashboard/route.ts)).

**Request:** no query parameters, no body.

**Work performed** (inside `withCronInvocationAudit`, [`route.ts:44-68`](../../../src/app/api/internal/sync-sales-dashboard/route.ts)):

1. `importRefreshableSalesSources({ triggerType: "cron", actorEmail })` walks every non-archived source. A previous-month source on or after Bangkok day 8 is auto-finalized and skipped; otherwise the source is imported only if `sourceShouldRefresh` says so — current month always, previous month through day 7, never when `finalized` or `archived` ([`data.ts:567-585`](../../../src/lib/sales-dashboard/data.ts), [`lifecycle.ts:8-42`](../../../src/lib/sales-dashboard/lifecycle.ts)).
2. `importActiveSalesDashboardProjectionSource({ triggerType: "cron", actorEmail })` imports the single `active` projection source, or resolves to `null` when none is configured ([`data.ts:728-735`](../../../src/lib/sales-dashboard/data.ts)).

**Response 200:** `{ ok: true, results, projectionResult }` — `results` is an array of `SalesDashboardImportOutcome` (only the sources that actually refreshed), and `projectionResult` is `null` or `{ sourceId, runId, projectionMonths, targetMonthlyRevenue }` ([`data.ts:707-712`](../../../src/lib/sales-dashboard/data.ts)).

**Side effects:**

- A `cron_invocations` row is written on entry and updated on exit with duration, response status, derived outcome (`success` / `skipped` / `failed`), an error summary, and `linkedRunIds` extracted from the response body ([`cron-audit.ts:84-142`](../../../src/lib/data-health/cron-audit.ts)). A body containing `skipped: true` or the phrase "already running" is recorded as `skipped` even on a 200 ([`cron-audit.ts:61-70`](../../../src/lib/data-health/cron-audit.ts)).
- Per refreshed source: a `sales_dashboard_import_runs` row, chunked inserts (500 at a time) into `sales_dashboard_normal_rows` and `sales_dashboard_additional_rows`, and an update to the source's status / `lastSuccessfulImportRunId` / `lastImportedAt` / row counts ([`data.ts:485-544`](../../../src/lib/sales-dashboard/data.ts)).
- The source is flipped to `refreshing` for the duration of its import and restored to its previous status on failure, with `lastImportError` set ([`data.ts:459-462`](../../../src/lib/sales-dashboard/data.ts), [`data.ts:553-564`](../../../src/lib/sales-dashboard/data.ts)).
- Post-import status is decided by `statusAfterSuccessfulImport`: current month → `active`, previous month through day 7 → `active`, otherwise → `finalized`; `reopened` and `archived` are preserved ([`lifecycle.ts:21-33`](../../../src/lib/sales-dashboard/lifecycle.ts)).
- The `sales-dashboard` cache tag is revalidated.

**Status codes:**

| Status | When |
|--------|------|
| 200 | Job ran (including when every source was skipped). |
| 401 | Missing or wrong bearer token, with `CRON_SECRET` set ([`route.ts:40`](../../../src/app/api/internal/sync-sales-dashboard/route.ts)). |
| 409 | `MissingGoogleSheetsTokenError` ([`route.ts:64`](../../../src/app/api/internal/sync-sales-dashboard/route.ts)). |
| 500 | `CRON_SECRET` unset → `{"error":"Server misconfigured"}` ([`route.ts:38`](../../../src/app/api/internal/sync-sales-dashboard/route.ts)); any other import failure; or a throw that escapes the handler, which the audit wrapper converts to `500 {"error": message}` ([`cron-audit.ts:153-157`](../../../src/lib/data-health/cron-audit.ts)). |

> The whole job is sequential and *not* transactional. If source #3 throws, sources #1–#2 keep their newly promoted runs and the endpoint still returns a single error status.

### `POST /api/internal/sync-sales-dashboard`

Same job, reachable from the admin UI. Handler: [`route.ts:75-77`](../../../src/app/api/internal/sync-sales-dashboard/route.ts) (`allowSessionAuth: true`).

**Auth:** a valid `CRON_SECRET` bearer token, **or** an Auth.js session with an email. When the secret is absent/wrong the handler falls back to `auth()`; a session email is used as `actorEmail` and the audit row's `triggerSource` becomes `"admin"` instead of `"cron"` ([`route.ts:24-47`](../../../src/app/api/internal/sync-sales-dashboard/route.ts)). With no secret and no session, `CRON_SECRET` being unset yields 500 and everything else yields 401.

**Request / response / side effects:** identical to `GET`. Note that `triggerType` passed into the importers stays hard-coded `"cron"` even for an admin-triggered POST ([`route.ts:54`](../../../src/app/api/internal/sync-sales-dashboard/route.ts), [`route.ts:59`](../../../src/app/api/internal/sync-sales-dashboard/route.ts)), so `sales_dashboard_import_runs.trigger_type` reads `cron` while `actor_email` carries the admin's address.

---

## Reading the dashboard

### `GET /api/sales-dashboard`

The landing payload for `/sales-dashboard`, assembled in one cached call. Handler: [`route.ts:5-18`](../../../src/app/api/sales-dashboard/route.ts).

**Auth:** session ([`route.ts:6-9`](../../../src/app/api/sales-dashboard/route.ts)).

**Request:** no query parameters, no body. The signed-in email is passed to `getSalesDashboardPayload(session.user.email)` — it is both a cache-key component and the account whose Google-token status is reported.

**Response 200** — a bare `SalesDashboardPayload` object (no envelope), type at [`types.ts:63-93`](../../../src/lib/sales-dashboard/types.ts), built by `buildSalesDashboardPayload` from the live rows, source summaries, projection payload, and token status ([`data.ts:903-917`](../../../src/lib/sales-dashboard/data.ts)).

| Key | Type | Meaning |
|-----|------|---------|
| `normalDays`, `addDays` | aggregates | Per-day revenue/transaction rollups for the normal and additional sheets. |
| `pkgCount`, `progCount`, `addPkgCount`, `dayCount` | `Record<string, number>` | Package / program / additional-package / weekday tallies. |
| `repArr` | `SalesRepAggregate[]` | Per-sales-rep rollup. |
| `totalTxn`, `totalAddTxn` | number | Transaction counts. |
| `uniqueTrials`, `uniqueNewStudents`, `uniqueRenewals`, `churnedStudents`, `eligibleStudents` | number | Student-level counters. |
| `completionRate`, `completionMonths`, `weekBandPct` | mixed | Package-completion and weekly-band distributions. |
| `churnList`, `trialCohort`, `retentionCohort` | arrays | Cohort/churn detail tables. |
| `lastUpdated` | `string \| null` | Newest import timestamp across sources. |
| `sources` | `SalesDashboardSourceSummary[]` | **Includes archived sources** — `loadLiveRowData` lists with `includeArchived: true` for this list while scoping rows to non-archived sources ([`data.ts:870-871`](../../../src/lib/sales-dashboard/data.ts)). Shape at [`types.ts:105-122`](../../../src/lib/sales-dashboard/types.ts); `Date` fields are pre-serialized to ISO strings by `toSummary` ([`data.ts:123-142`](../../../src/lib/sales-dashboard/data.ts)). |
| `projection` | `SalesDashboardProjectionPayload` | `{ source, targetMonthlyRevenue, targetSource, scenarioSummaries, months, lastImportedAt, lastImportError }`. All-null/empty when no active projection source exists ([`data.ts:811-853`](../../../src/lib/sales-dashboard/data.ts)). `scenarioSummaries` is re-read from the last run's `metadata` and filtered to `Bear`/`Base`/`Bull` ([`data.ts:801-809`](../../../src/lib/sales-dashboard/data.ts)). |
| `token` | object | `{ connected, email, expiresAt, lastError }` for the caller's Google OAuth token; `connected` requires both a stored ciphertext and the Sheets read scope ([`google-oauth.ts:267-284`](../../../src/lib/sales-dashboard/google-oauth.ts)). |

**Side effects:** none — read-only apart from populating the Next cache entry.

**Status codes:** 200; 401 unauthenticated; 500 `{"error": <message ?? "Failed to load sales dashboard">}` ([`route.ts:14-17`](../../../src/app/api/sales-dashboard/route.ts)).

### `GET /api/sales-dashboard/dimensions`

Month-grain slice the tabbed workspace fetches lazily on first non-Overview activation. Handler: [`dimensions/route.ts:5-18`](../../../src/app/api/sales-dashboard/dimensions/route.ts).

**Auth:** session. **Request:** none.

**Response 200** — a bare `SalesDimensionsPayload` ([`types.ts:339-350`](../../../src/lib/sales-dashboard/types.ts)): `{ months, reps, repFunnels, programs, packages, additionalMix, students, targetMonthlyRevenue, unparsedPackageCount, generatedAt }`. Built by `buildSalesDimensions` over the same live rows, seeded with only `targetMonthlyRevenue` / `targetSource` from the projection payload ([`data.ts:948-965`](../../../src/lib/sales-dashboard/data.ts)).

**Side effects:** none.

**Status codes:** 200; 401; 500 `{"error": <message ?? "Failed to load sales dimensions">}`.

### `GET /api/sales-dashboard/import-runs`

Recent import history for the sources panel. Handler: [`import-runs/route.ts:5-18`](../../../src/app/api/sales-dashboard/import-runs/route.ts).

**Auth:** session. **Request:** none — the limit is fixed.

**Response 200:** `{ runs }`, the **20** newest `sales_dashboard_import_runs` rows ordered by `startedAt DESC`, returned as full table rows ([`data.ts:967-973`](../../../src/lib/sales-dashboard/data.ts)). Columns include `id`, `sourceId`, `status`, `triggerType`, `startedAt`, `finishedAt`, `sourceCount`, `normalRowCount`, `additionalRowCount`, `errorSummary`, `actorEmail`, `metadata` ([`schema.ts:650-669`](../../../src/lib/db/schema.ts)). Projection imports are a separate table and do **not** appear here.

**Side effects:** none. This route is uncached — it queries Postgres on every request.

**Status codes:** 200; 401; 500 `{"error": <message ?? "Failed to list sales imports">}`.

---

## Running imports

### `POST /api/sales-dashboard/import`

The one manual-import endpoint; three different behaviours are selected by the body. Handler: [`import/route.ts:30-96`](../../../src/app/api/sales-dashboard/import/route.ts). `maxDuration = 800`.

**Auth:** session.

**Request body** — `ImportSchema`, all fields optional ([`import/route.ts:14-18`](../../../src/app/api/sales-dashboard/import/route.ts)):

| Field | Type | Notes |
|-------|------|-------|
| `sourceId` | `string` (uuid) | Import exactly this source. |
| `mode` | `"source" \| "backfill" \| "refreshable"` | Only `"backfill"` alters behaviour; `"source"` and `"refreshable"` are accepted and then ignored — routing is by the presence of `sourceId` ([`import/route.ts:38-75`](../../../src/app/api/sales-dashboard/import/route.ts)). |
| `allowFinalized` | `boolean` | Single-source path only: permits importing a `finalized` source. |

Dispatch order:

1. **`mode: "backfill"`** → `importAllSalesSources(email)` imports every non-archived source with `triggerType: "backfill"` and `allowFinalized: true` ([`data.ts:587-601`](../../../src/lib/sales-dashboard/data.ts)).
2. **`sourceId` present** → `importSalesDashboardSource(sourceId, { triggerType: "manual", actorEmail, allowFinalized })`.
3. **Neither** → if no sources exist, return the zeroed envelope; otherwise `importRefreshableSalesSources({ triggerType: "manual" })`, applying the same current/previous-month lifecycle rules as the cron ([`import/route.ts:63-92`](../../../src/app/api/sales-dashboard/import/route.ts)).

**Response 200 — single-source path:** `{ ok: true, result }` where `result` is a `SalesDashboardImportOutcome`.

**Response 200 — batch paths:** `{ ok: true, results, sourceCount, importedSourceCount, normalRows, additionalRows, message }`. `importedSourceCount` counts results without `skipped` ([`import/route.ts:20-22`](../../../src/app/api/sales-dashboard/import/route.ts)); `normalRows`/`additionalRows` are summed across results; `message` is a human string that differs per path ("Backfilled …", "Refreshed … live-month sources", or "No sources configured. Seed historical sources first.").

**Side effects:** identical to the cron's per-source work — run rows, chunked row inserts, source status transitions, stale-run recovery, `sales-dashboard` cache revalidation.

**Status codes:**

| Status | When |
|--------|------|
| 200 | Import ran, including all-skipped and no-sources-configured. |
| 401 | No session. |
| 409 | `MissingGoogleSheetsTokenError` ([`import/route.ts:24-28`](../../../src/app/api/sales-dashboard/import/route.ts)). |
| 500 | Everything else, including **malformed JSON**, **Zod validation failure**, `"Sales dashboard source not found"`, `"Sales dashboard source is archived. Restore it before importing."` ([`data.ts:407-412`](../../../src/lib/sales-dashboard/data.ts)), and `"Source is finalized. Reopen or confirm manual refresh first."` ([`data.ts:426-428`](../../../src/lib/sales-dashboard/data.ts)). |

> The finalized-source guard fires twice: once before the run row is created, and once after acquiring it — the second pass marks the just-created run `failed` before rethrowing ([`data.ts:445-455`](../../../src/lib/sales-dashboard/data.ts)).

### `POST /api/sales-dashboard/projection-import`

Imports the Bear/Base/Bull scenario workbook. Handler: [`projection-import/route.ts:8-28`](../../../src/app/api/sales-dashboard/projection-import/route.ts). `maxDuration = 800`.

**Auth:** session. **Request:** no body is read — the target is always the single `status: "active"` projection source ([`data.ts:236-243`](../../../src/lib/sales-dashboard/data.ts)).

**Response 200:** `{ ok: true, result }` with `result = { sourceId, runId, projectionMonths, targetMonthlyRevenue }` ([`data.ts:707-712`](../../../src/lib/sales-dashboard/data.ts)).

**Side effects** ([`data.ts:633-726`](../../../src/lib/sales-dashboard/data.ts)):

1. Inserts a `sales_dashboard_projection_import_runs` row with `status: "running"` and clears the source's `lastImportError`.
2. Reads three sheets by name — `summarySheetName`, `whatIfSheetName`, `calcMultiSheetName` — each of which **must** exist in the workbook or the import throws `Projection workbook is missing <purpose> sheet "<name>"` ([`data.ts:603-612`](../../../src/lib/sales-dashboard/data.ts)).
3. Chunk-inserts parsed months into `sales_dashboard_projection_months`.
4. Marks the run `success` with `monthRowCount`, `targetMonthlyRevenue`, and parser `metadata` (which carries `scenarioSummaries`), and updates the source's `lastSuccessfulImportRunId` / `lastImportedAt` / `lastProjectionMonthCount` / `lastTargetMonthlyRevenue`.
5. Revalidates the `sales-dashboard` tag on both success **and** failure.

Unlike the monthly-source importer there is **no single-flight guard** on projection imports — two concurrent calls each insert their own run.

**Status codes:**

| Status | When |
|--------|------|
| 200 | Import succeeded. |
| 401 | No session. |
| 409 | No active projection source → `{"error":"No projection source configured."}` ([`projection-import/route.ts:19-21`](../../../src/app/api/sales-dashboard/projection-import/route.ts)); or `MissingGoogleSheetsTokenError`. |
| 500 | Missing sheet, parse failure, or any other error ([`projection-import/route.ts:23-27`](../../../src/app/api/sales-dashboard/projection-import/route.ts)). |

---

## Managing sources

### `GET /api/sales-dashboard/sources`

Handler: [`sources/route.ts:18-31`](../../../src/app/api/sales-dashboard/sources/route.ts).

**Auth:** session. **Request:** none.

**Response 200:** `{ sources }` — **non-archived** sources only, ordered by `sourceMonth` ascending ([`data.ts:164-179`](../../../src/lib/sales-dashboard/data.ts)). These are raw `SalesDashboardSourceRecord` rows, not the ISO-normalized `SalesDashboardSourceSummary` returned inside `GET /api/sales-dashboard`; `Date` columns serialize through `JSON.stringify` instead of `toSummary`. `status` is one of `active | refreshing | finalized | reopened | archived` ([`types.ts:1`](../../../src/lib/sales-dashboard/types.ts)) — `archived` never appears on this route.

**Status codes:** 200; 401; 500 `{"error": <message ?? "Failed to list sales dashboard sources">}`.

### `POST /api/sales-dashboard/sources`

Create or update the source for one month. Handler: [`sources/route.ts:33-52`](../../../src/app/api/sales-dashboard/sources/route.ts).

**Auth:** session.

**Request body** — `SourceInputSchema` ([`sources/route.ts:10-16`](../../../src/app/api/sales-dashboard/sources/route.ts)):

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `spreadsheetUrl` | `string` (min 1) | yes | Full Google Sheets URL or a bare ≥20-char spreadsheet ID; parsed by `extractSpreadsheetId`, which throws `Invalid Google Sheet URL or spreadsheet ID` otherwise ([`parser.ts:71-77`](../../../src/lib/sales-dashboard/parser.ts)). |
| `sourceMonth` | `string` matching `^\d{4}-\d{2}(-\d{2})?$` | yes | The route slices it to `YYYY-MM` before the upsert ([`sources/route.ts:43`](../../../src/app/api/sales-dashboard/sources/route.ts)), then `monthStartFromMonthKey` appends `-01` ([`dates.ts:40-45`](../../../src/lib/sales-dashboard/dates.ts)). |
| `label` | `string` | no | Blank/absent falls back to `labelForMonth(sourceMonth)`. |
| `normalSheetName` | `string` | no | Blank → `null`, which lets the importer auto-resolve `DEFAULT_NORMAL_SHEET` then `LEGACY_NORMAL_SHEET` ([`data.ts:466-471`](../../../src/lib/sales-dashboard/data.ts)). |
| `additionalSheetName` | `string` | no | Blank → `null`; when unresolved the additional sheet is simply skipped ([`data.ts:476-479`](../../../src/lib/sales-dashboard/data.ts)). |

**Response 200:** `{ source }` — the inserted/updated row.

**Side effects:** an `INSERT … ON CONFLICT (source_month) WHERE archived_at IS NULL DO UPDATE` ([`data.ts:186-215`](../../../src/lib/sales-dashboard/data.ts)), so at most one live source exists per month while archived rows for that month are left alone. Sets `connectedEmail`, `createdByEmail`/`updatedByEmail` from the session email, then revalidates the cache. Row data from prior imports is untouched — this only rewires the source.

**Status codes:** 200; 401; **400** for everything else, including Zod failure, a malformed JSON body, and an unparseable spreadsheet URL ([`sources/route.ts:48-51`](../../../src/app/api/sales-dashboard/sources/route.ts)).

### `PATCH /api/sales-dashboard/sources/[sourceId]`

Move a source through its lifecycle. Handler: [`sources/[sourceId]/route.ts:15-31`](../../../src/app/api/sales-dashboard/sources/[sourceId]/route.ts).

**Auth:** session. **Path param:** `sourceId` (awaited from `ctx.params`, Next 16 async params).

**Request body** — `PatchSchema`: `{ status: "active" | "finalized" | "reopened" }` ([`sources/[sourceId]/route.ts:9-11`](../../../src/app/api/sales-dashboard/sources/[sourceId]/route.ts)). `archived` and `refreshing` cannot be set through this route — archiving is the `DELETE` verb, and `refreshing` is owned by the importer.

**Response 200:** `{ source }` — the updated row.

**Behaviour and side effects** ([`data.ts:293-325`](../../../src/lib/sales-dashboard/data.ts)):

- Sets `status`, stamps `finalizedAt` when finalizing and `reopenedAt` when reopening (clearing the other), clears all archive bookkeeping (`archivedAt`, `archivedByEmail`, `statusBeforeArchive`), and writes `updatedByEmail`.
- If the source is currently `archived`: `status: "active"` is rerouted to `restoreSalesDashboardSource`, which restores `statusBeforeArchive` (falling back to `active`, never restoring `archived`/`refreshing`) and refuses when another live source already occupies that month ([`data.ts:356-396`](../../../src/lib/sales-dashboard/data.ts)). Any other target status throws `Restore archived source before changing its status.`
- Revalidates the `sales-dashboard` cache tag.

**Status codes:**

| Status | When |
|--------|------|
| 200 | Status updated. |
| 401 | No session. |
| 404 | `{"error":"Source not found"}` — unknown id, or the update returned no row ([`sources/[sourceId]/route.ts:25`](../../../src/app/api/sales-dashboard/sources/[sourceId]/route.ts)). |
| 400 | Zod failure, malformed body, the archived-source guard, and the month-collision guard on restore ([`sources/[sourceId]/route.ts:27-30`](../../../src/app/api/sales-dashboard/sources/[sourceId]/route.ts)). |

### `DELETE /api/sales-dashboard/sources/[sourceId]`

Soft-delete (archive) a source. Handler: [`sources/[sourceId]/route.ts:33-48`](../../../src/app/api/sales-dashboard/sources/[sourceId]/route.ts).

**Auth:** session. **Path param:** `sourceId`. **Request:** no body.

**Response 200:** `{ ok: true, source }`.

**Side effects** ([`data.ts:327-354`](../../../src/lib/sales-dashboard/data.ts)): sets `status: "archived"`, `archivedAt`, `archivedByEmail`, and preserves the prior status in `statusBeforeArchive` so a later restore can undo it. Already-archived sources return unchanged (idempotent). Nothing is deleted — the imported rows and run history survive, but `loadLiveRowData` stops counting the source's rows, so archiving immediately changes every dashboard number.

**Status codes:**

| Status | When |
|--------|------|
| 200 | Archived, or already archived. |
| 401 | No session. |
| 404 | `{"error":"Source not found"}`. |
| 500 | `Source is refreshing. Wait for the import to finish before archiving it.` ([`data.ts:335-337`](../../../src/lib/sales-dashboard/data.ts)), or any other failure ([`sources/[sourceId]/route.ts:44-47`](../../../src/app/api/sales-dashboard/sources/[sourceId]/route.ts)). |

### `POST /api/sales-dashboard/sources/seed`

One-shot bootstrap of the historical months. Handler: [`sources/seed/route.ts:5-18`](../../../src/app/api/sales-dashboard/sources/seed/route.ts).

**Auth:** session. **Request:** no body.

**Response 200:** `{ sources, count }` — the seeded rows and their count.

**Side effects:** loops `DEFAULT_SALES_SOURCES` — **14** hard-coded workbooks covering `2025-04` through `2026-05`, with the two oldest pinned to `LEGACY_NORMAL_SHEET` ([`default-sources.ts:3-19`](../../../src/lib/sales-dashboard/default-sources.ts)) — and calls the same month-keyed upsert as `POST /sources` for each ([`data.ts:220-234`](../../../src/lib/sales-dashboard/data.ts)). Idempotent: re-running rewrites URLs, labels, sheet names, and `connectedEmail` for those 14 months to the caller's identity, and never imports rows. Each upsert revalidates the cache.

**Status codes:** 200; 401; 500 `{"error": <message ?? "Failed to seed sales sources">}`.

### `POST /api/sales-dashboard/projection-source`

Point the projection importer at a workbook, or restore the built-in default. Handler: [`projection-source/route.ts:16-39`](../../../src/app/api/sales-dashboard/projection-source/route.ts).

**Auth:** session.

**Request body** — `ProjectionSourceInputSchema`, every field optional ([`projection-source/route.ts:9-14`](../../../src/app/api/sales-dashboard/projection-source/route.ts)):

| Field | Type | Notes |
|-------|------|-------|
| `spreadsheetUrl` | `string` (min 1) | **Presence is the dispatch switch.** Given → upsert with these values; omitted → `seedDefaultSalesDashboardProjectionSource`, which re-applies `DEFAULT_PROJECTION_SPREADSHEET_URL` and the three default sheet names ([`data.ts:282-291`](../../../src/lib/sales-dashboard/data.ts)). |
| `summarySheetName` | `string` | Blank/absent → `"Summary"` ([`projection.ts:10`](../../../src/lib/sales-dashboard/projection.ts)). |
| `whatIfSheetName` | `string` | Blank/absent → `"What_If"` ([`projection.ts:11`](../../../src/lib/sales-dashboard/projection.ts)). |
| `calcMultiSheetName` | `string` | Blank/absent → `"Calc_Multi"` ([`projection.ts:12`](../../../src/lib/sales-dashboard/projection.ts)). |

**Response 200:** `{ source }` — the projection source record.

**Side effects** ([`data.ts:245-280`](../../../src/lib/sales-dashboard/data.ts)): if an `active` projection source already exists it is **updated in place** (and `lastImportError` cleared); otherwise a new row is inserted with `status: "active"`. There is no unique constraint enforcing "one active projection source" — the code relies on the read-then-branch. `connectedEmail` and `updatedByEmail` come from the session. Revalidates the cache. No import is triggered; call `POST /api/sales-dashboard/projection-import` afterwards.

**Status codes:** 200; 401; **400** for Zod failure, malformed JSON, or an unparseable spreadsheet URL ([`projection-source/route.ts:35-38`](../../../src/app/api/sales-dashboard/projection-source/route.ts)).

---

## Transactions

Both transaction routes read the same cached, run-scoped materialization: `getLiveSlimRows()` maps normal and additional rows through `toSlimTransaction` / `toSlimAdditionalTransaction` and sorts newest-first, tie-breaking on `kind`, `studentKey`, then descending `amount` ([`data.ts:932-941`](../../../src/lib/sales-dashboard/data.ts), [`dimensions.ts:465-471`](../../../src/lib/sales-dashboard/dimensions.ts)). The `raw` jsonb column is never serialized on these routes.

Shared filter semantics ([`dimensions.ts:450-462`](../../../src/lib/sales-dashboard/dimensions.ts)): `rep`, `program`, and `band` match **only** `kind: "normal"` rows — supplying any of them excludes every additional-sales row. `rep` and `student` are compared through normalizing key functions; `program` and `band` are exact string matches. `from`/`to` are inclusive lexicographic bounds on the `YYYY-MM-DD` `date` field.

### `GET /api/sales-dashboard/transactions`

Handler: [`transactions/route.ts:11-36`](../../../src/app/api/sales-dashboard/transactions/route.ts).

**Auth:** session.

**Query parameters** — `salesTransactionPageQuerySchema`, `.safeParse()`d over only the recognized keys ([`transaction-query.ts:8-28`](../../../src/lib/sales-dashboard/transaction-query.ts)); unknown parameters are dropped before parsing by `readSearchParams` ([`transaction-query.ts:33-43`](../../../src/lib/sales-dashboard/transaction-query.ts)):

| Param | Type | Default | Notes |
|-------|------|---------|-------|
| `rep` | non-empty string | — | Normal rows only. |
| `program` | non-empty string | — | Normal rows only. |
| `band` | non-empty string | — | Normal rows only. |
| `student` | non-empty string | — | Matched on normalized student key. |
| `from` | `YYYY-MM-DD` | — | Regex-enforced; message `Expected YYYY-MM-DD`. |
| `to` | `YYYY-MM-DD` | — | Same. |
| `limit` | coerced positive int | `200` | Silently clamped to `1000` — over-limit values are transformed, not rejected ([`transaction-query.ts:21-26`](../../../src/lib/sales-dashboard/transaction-query.ts)). |
| `offset` | coerced int ≥ 0 | `0` | |

**Response 200:** `{ rows, total }` — `rows` is the `limit`/`offset` window, `total` is the filtered count **before** pagination ([`transactions/route.ts:28-31`](../../../src/app/api/sales-dashboard/transactions/route.ts)). Each row is a `SlimTransaction`: `{ date, student, studentKey, rep, program, packageLabel, band, hours, amount, enrollmentType, validUntil, sourceMonth, numberOfStudents, kind, salesType? }` ([`types.ts:353-369`](../../../src/lib/sales-dashboard/types.ts)).

**Side effects:** none. Filtering and pagination happen in-process over the cached array, not in SQL.

**Status codes:** 200; 401; 400 `{"error":"Invalid query","details": <flatten()>}`; 500 `{"error": <message ?? "Failed to load sales transactions">}`.

### `GET /api/sales-dashboard/transactions/export`

Handler: [`transactions/export/route.ts:37-65`](../../../src/app/api/sales-dashboard/transactions/export/route.ts).

**Auth:** session.

**Query parameters** — `salesTransactionFilterSchema`: the same six filters as above, **without** `limit`/`offset` ([`transaction-query.ts:11-18`](../../../src/lib/sales-dashboard/transaction-query.ts)). The export is never paginated; it writes every matching row.

**Response 200** — a raw `Response` (not `NextResponse.json`) with headers ([`transactions/export/route.ts:54-60`](../../../src/app/api/sales-dashboard/transactions/export/route.ts)):

- `Content-Type: text/csv; charset=utf-8`
- `Cache-Control: no-store`
- `Content-Disposition: attachment; filename="sales-dashboard-transactions-{from}-to-{to}.csv"`, where each missing bound becomes the literal `all` and the whole name is passed through `sanitizeCsvFilename` ([`transactions/export/route.ts:31-35`](../../../src/app/api/sales-dashboard/transactions/export/route.ts), [`csv.ts:35-43`](../../../src/lib/sales-dashboard/csv.ts)).

Body: a UTF-8-BOM-prefixed, CRLF-delimited CSV in which **every** field is quoted and inner quotes are doubled ([`csv.ts:13-33`](../../../src/lib/sales-dashboard/csv.ts)). Fixed 15-column order ([`transactions/export/route.ts:13-29`](../../../src/app/api/sales-dashboard/transactions/export/route.ts)): `Date, Kind, Student, Student Key, Rep, Program, Package, Band, Hours, Amount, Enrollment Type, Sales Type, Valid Until, Source Month, Number Of Students`.

**Side effects:** none.

**Status codes:** 200 (CSV); 401 (JSON); 400 `{"error":"Invalid query","details": …}` (JSON); 500 `{"error": <message ?? "Failed to export sales transactions">}` (JSON). Error responses are JSON even though the success response is CSV.

---

_Verified against HEAD + uncommitted WIP on 2026-05-31._
