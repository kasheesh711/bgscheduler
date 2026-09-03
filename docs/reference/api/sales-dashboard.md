# Sales Dashboard API

**Authoritative source:** the twelve route files under [`src/app/api/sales-dashboard/`](../../../src/app/api/sales-dashboard/) and [`src/app/api/internal/sync-sales-dashboard/route.ts`](../../../src/app/api/internal/sync-sales-dashboard/route.ts). Feature status is **stable** and is declared by the feature doc ([docs/features/sales-dashboard.md](../../features/sales-dashboard.md)); this page does not restate the feature's purpose, business rules, or import semantics.

This page is the mechanical reference for the Sales Dashboard HTTP surface: method, path, auth, request shape, response shape, side effects, and status codes. What the numbers *mean*, how a sheet becomes a governed dataset, and which surfaces the GM readout renders live in [docs/features/sales-dashboard.md](../../features/sales-dashboard.md). Table columns live in [docs/reference/database/erd-sales-dashboard.md](../database/erd-sales-dashboard.md). The cron schedule table lives in [docs/reference/crons.md](../crons.md).

**Endpoints on this page (15):**

| Method | Path | Auth |
|--------|------|------|
| GET | `/api/internal/sync-sales-dashboard` | cron secret |
| POST | `/api/internal/sync-sales-dashboard` | cron secret **or** session |
| GET | `/api/sales-dashboard` | session **with email** |
| GET | `/api/sales-dashboard/dimensions` | session **with email** |
| POST | `/api/sales-dashboard/import` | session **with email** |
| GET | `/api/sales-dashboard/import-runs` | session **with email** |
| POST | `/api/sales-dashboard/projection-import` | session **with email** |
| POST | `/api/sales-dashboard/projection-source` | session **with email** |
| GET | `/api/sales-dashboard/sources` | session **with email** |
| POST | `/api/sales-dashboard/sources` | session **with email** |
| DELETE | `/api/sales-dashboard/sources/[sourceId]` | session **with email** |
| PATCH | `/api/sales-dashboard/sources/[sourceId]` | session **with email** |
| POST | `/api/sales-dashboard/sources/seed` | session **with email** |
| GET | `/api/sales-dashboard/transactions` | session **with email** |
| GET | `/api/sales-dashboard/transactions/export` | session **with email** |

## Conventions shared across the endpoints

- **Auth shape.** Every `/api/sales-dashboard/**` handler calls `auth()` from [`@/lib/auth`](../../../src/lib/auth.ts) and rejects on `!session?.user?.email` — not merely `!session`. The email is not decorative: it is written to `connected_email` / `created_by_email` / `updated_by_email` / `actor_email` and is the key the Google Sheets token store is looked up under ([`google-oauth.ts:276-293`](../../../src/lib/sales-dashboard/google-oauth.ts)). There is no Sales-Dashboard-specific role check beyond the session.
- **Middleware gating.** `/api/sales-dashboard/**` is **not** in the public-route allowlist ([`middleware.ts:10-26`](../../../src/middleware.ts)), so an unauthenticated request is redirected to `/login` before the handler runs ([`middleware.ts:89-93`](../../../src/middleware.ts)). A restricted user (non-null `allowedPages` that omits `/sales-dashboard`) is stopped at the middleware, because `isPathAllowed` matches each allowed page both as `/x` and as `/api/x` ([`middleware.ts:36-67,97-100`](../../../src/middleware.ts)). `/api/internal/*` — including the sync route — is in the public allowlist ([`middleware.ts:24`](../../../src/middleware.ts)) and enforces its own cron-secret check in-handler.
- **Two reader-cache layers.** The three read endpoints are served by `"use cache"` functions tagged `sales-dashboard` (`SALES_DASHBOARD_CACHE_TAG`, [`data.ts:61`](../../../src/lib/sales-dashboard/data.ts)) with `cacheLife({ stale: 60, revalidate: 60, expire: 300 })` — `getSalesDashboardPayload` ([`data.ts:919-925`](../../../src/lib/sales-dashboard/data.ts)), `getLiveSlimRows` ([`data.ts:932-941`](../../../src/lib/sales-dashboard/data.ts)), `getSalesDimensionsPayload` ([`data.ts:948-965`](../../../src/lib/sales-dashboard/data.ts)). Every mutating library call ends with `revalidateSalesDashboardCache()`, a `revalidateTag(tag, "max")` wrapped so that the "static generation store missing" error (thrown when invoked outside a request scope) is swallowed and any other error re-thrown ([`data.ts:97-104`](../../../src/lib/sales-dashboard/data.ts)). `GET /api/sales-dashboard/sources` and `GET /api/sales-dashboard/import-runs` are **not** cached — they read Postgres directly.
- **Run-scoped reads.** All three read payloads are built from `loadLiveRowData`, which lists sources (including archived), drops archived ones, and then selects `sales_dashboard_normal_rows` / `sales_dashboard_additional_rows` restricted to each surviving source's `lastSuccessfulImportRunId` ([`data.ts:869-901`](../../../src/lib/sales-dashboard/data.ts)). Imports **append** rows under a new `import_run_id` rather than deleting the previous run's rows ([`data.ts:485-516`](../../../src/lib/sales-dashboard/data.ts)), so a half-finished run is invisible to readers until its source row is repointed.
- **Zod is inconsistent.** Four handlers declare a Zod schema; three of those call `.parse()` (throwing) rather than the house `.safeParse()`, so a schema violation surfaces as whatever status that handler's `catch` assigns — **500** for `/import`, **400** for `/sources` and `/projection-source`, and **400** for `PATCH /sources/[sourceId]`. Only the two transaction endpoints use `.safeParse()` and return the conventional `400 { error: "Invalid query", details }`.
- **Google Sheets failures are 409, not 500.** Every import path maps `MissingGoogleSheetsTokenError` ([`google-oauth.ts:34-39`](../../../src/lib/sales-dashboard/google-oauth.ts)) to **409**. That error is raised when no token row exists, when the ciphertext is empty, or when the stored scope lacks Sheets read ([`google-oauth.ts:200-206`](../../../src/lib/sales-dashboard/google-oauth.ts)) — i.e. "reconnect Google Sheets", not "the server broke".
- **Long-running routes.** `export const maxDuration = 800` on `/api/internal/sync-sales-dashboard` ([`route.ts:11`](../../../src/app/api/internal/sync-sales-dashboard/route.ts)), `/api/sales-dashboard/import` ([`import/route.ts:12`](../../../src/app/api/sales-dashboard/import/route.ts)), and `/api/sales-dashboard/projection-import` ([`projection-import/route.ts:6`](../../../src/app/api/sales-dashboard/projection-import/route.ts)). No other handler on this page sets it.
- **Single-flight.** Per-source concurrency is enforced in Postgres by the partial unique index `sdir_source_single_running_idx` on `sales_dashboard_import_runs (source_id) WHERE status = 'running' AND source_id IS NOT NULL` ([`schema.ts:666-668`](../../../src/lib/db/schema.ts)). `acquireSalesImportRun` first fails any run still `running` after 20 minutes (`STALE_RUNNING_SALES_IMPORT_MS`, [`import-guard.ts:6-9,97-125`](../../../src/lib/sales-dashboard/import-guard.ts)) and restores the source's pre-import status from the stale run's `metadata.previousStatus`, then either inserts a run row or — on a live conflict — returns a **skipped** outcome ([`import-guard.ts:167-211`](../../../src/lib/sales-dashboard/import-guard.ts)). A skip is an HTTP **200**, not a 409.
- **Route tests.** [`src/app/api/sales-dashboard/__tests__/route.test.ts`](../../../src/app/api/sales-dashboard/__tests__/route.test.ts) covers the landing payload, `/import` (backfill, single-source, no-sources no-op, 409), `/projection-source`, `/projection-import`, and the archive/restore pair. [`transactions-route.test.ts`](../../../src/app/api/sales-dashboard/__tests__/transactions-route.test.ts) covers both transaction endpoints; [`dimensions-route.test.ts`](../../../src/app/api/sales-dashboard/__tests__/dimensions-route.test.ts) covers `/dimensions`; [`src/app/api/internal/sync-sales-dashboard/__tests__/route.test.ts`](../../../src/app/api/internal/sync-sales-dashboard/__tests__/route.test.ts) covers the cron route. `GET /api/sales-dashboard/sources`, `GET /api/sales-dashboard/import-runs`, and `POST /api/sales-dashboard/sources/seed` have no route test.

---

## Cron sync

### `GET /api/internal/sync-sales-dashboard`
### `POST /api/internal/sync-sales-dashboard`

Both methods run the same body, `handleSync` ([`route.ts:24-69`](../../../src/app/api/internal/sync-sales-dashboard/route.ts)); they differ only in the `allowSessionAuth` flag they pass — `false` for GET ([`route.ts:71-73`](../../../src/app/api/internal/sync-sales-dashboard/route.ts)), `true` for POST ([`route.ts:75-77`](../../../src/app/api/internal/sync-sales-dashboard/route.ts)).

**Schedule.** `"10,40 * * * *"` in [`vercel.json:8-11`](../../../vercel.json), pinned by a regression test ([`vercel-crons.test.ts:19,133`](../../../src/__tests__/vercel-crons.test.ts)) and mirrored in the Data Health registry as job key `sales_dashboard` with `routeMethod: "GET"`, `cadenceMinutes: 30`, `lateAfterMinutes: 45`, `maxDurationSeconds: 800` ([`cron-registry.ts:78-91`](../../../src/lib/data-health/cron-registry.ts)). Registry and route agree on 800s — there is no `maxDuration` drift here.

**Auth.** `hasValidCronSecret` compares the `authorization` header against `Bearer ${process.env.CRON_SECRET}` with a length pre-check plus `timingSafeEqual`, and distinguishes three states — `valid`, `invalid`, `missing-secret` ([`route.ts:13-22`](../../../src/app/api/internal/sync-sales-dashboard/route.ts)). Note this route reimplements the comparison locally rather than importing the shared `src/lib/internal/cron-auth.ts` helper.

| Method | Secret valid | Secret invalid / absent | `CRON_SECRET` unset |
|--------|--------------|-------------------------|---------------------|
| GET | runs, actor `cron@begifted.local` | **401** | **500** `{"error":"Server misconfigured"}` |
| POST | runs, actor `cron@begifted.local` | runs **if** `auth()` yields a `session.user.email`, actor = that email; otherwise **401** | **500** unless a session is present (a session wins before the misconfig branch, [`route.ts:29-36`](../../../src/app/api/internal/sync-sales-dashboard/route.ts)) |

**Request:** no query parameters, no body. Neither method reads the request beyond its `authorization` header and `request.method`.

**Side effects**, in order:

1. `withCronInvocationAudit` inserts a `cron_invocations` row (`jobKey: "sales_dashboard"`, `triggerSource: "cron"` when the secret validated and `"admin"` otherwise, `actorEmail`, `requestMethod`) and updates it with duration/status/outcome when the handler returns ([`route.ts:44-50`](../../../src/app/api/internal/sync-sales-dashboard/route.ts), [`cron-audit.ts:131-206`](../../../src/lib/data-health/cron-audit.ts)). Audit-write failures are logged and swallowed, so the handler's own response always passes through unchanged.
2. `importRefreshableSalesSources({ triggerType: "cron", actorEmail })` ([`route.ts:53-56`](../../../src/app/api/internal/sync-sales-dashboard/route.ts)) walks every non-archived source. For each: if `shouldAutoFinalizePreviousMonth` holds (previous Bangkok month, status not already `finalized`/`reopened`/`archived`, and Bangkok day-of-month ≥ 8) the source is flipped to `finalized` and **skipped**; otherwise it is imported only when `sourceShouldRefresh` holds — current Bangkok month always, previous month while day-of-month ≤ 7, never when `finalized` or `archived` ([`data.ts:567-585`](../../../src/lib/sales-dashboard/data.ts), [`lifecycle.ts:8-42`](../../../src/lib/sales-dashboard/lifecycle.ts)).
3. `importActiveSalesDashboardProjectionSource({ triggerType: "cron", actorEmail })` re-imports the single `status = "active"` projection workbook, or resolves to `null` when none is configured ([`route.ts:57-60`](../../../src/app/api/internal/sync-sales-dashboard/route.ts), [`data.ts:728-735`](../../../src/lib/sales-dashboard/data.ts)).

Per-source import side effects (run rows, `refreshing` status, row inserts, status transition) are documented under [`POST /api/sales-dashboard/import`](#post-apisales-dashboardimport) — the cron calls the same library function.

> **Quirk:** an admin-triggered POST still passes `triggerType: "cron"` to both importers ([`route.ts:54,58`](../../../src/app/api/internal/sync-sales-dashboard/route.ts)), so the resulting `sales_dashboard_import_runs.trigger_type` reads `cron` even though `actor_email` is the admin's address and the `cron_invocations` row is labelled `admin`. Confirmed by the route test ([`route.test.ts:68-81`](../../../src/app/api/internal/sync-sales-dashboard/__tests__/route.test.ts)).

**Response 200** — `{ ok: true, results, projectionResult }` ([`route.ts:61`](../../../src/app/api/internal/sync-sales-dashboard/route.ts)):

- `results` — an array of per-source outcomes, one entry per source that was actually attempted (auto-finalized and non-refreshable sources contribute nothing). Each is either a `SalesDashboardImportResult` `{ sourceId, runId, normalRows, additionalRows, staleRunningImportsFailed }` or a `SkippedSalesDashboardImportResult` `{ sourceId, runId, normalRows: 0, additionalRows: 0, skipped: true, alreadyRunning: true, runningStartedAt, message, staleRunningImportsFailed }` ([`import-guard.ts:16-40,148-165`](../../../src/lib/sales-dashboard/import-guard.ts)).
- `projectionResult` — `{ sourceId, runId, projectionMonths, targetMonthlyRevenue }` ([`data.ts:707-712`](../../../src/lib/sales-dashboard/data.ts)), or `null` when no active projection source exists.

**Status codes:**

| Status | When |
|--------|------|
| 200 | Sync completed; `results` + `projectionResult` returned. |
| 401 | Bad/absent cron secret (and, for POST, no session email). |
| 409 | `MissingGoogleSheetsTokenError` from either importer ([`route.ts:64`](../../../src/app/api/internal/sync-sales-dashboard/route.ts)). |
| 500 | `CRON_SECRET` unset, or any other thrown error; body `{ error: <message> }` ([`route.ts:33,38,62-65`](../../../src/app/api/internal/sync-sales-dashboard/route.ts)). |

An import failure is **not** isolated per source: `importRefreshableSalesSources` re-throws, so the first failing source aborts the loop and the projection import never runs.

---

## Reading the dashboard

### `GET /api/sales-dashboard`

The GM command-center payload. Read-only. Handler: [`route.ts:5-18`](../../../src/app/api/sales-dashboard/route.ts).

**Auth:** session with email ([`route.ts:6-9`](../../../src/app/api/sales-dashboard/route.ts)).

**Request:** no parameters. The signed-in email is passed through to `getSalesDashboardPayload(session.user.email)` ([`route.ts:12`](../../../src/app/api/sales-dashboard/route.ts)) solely so the Google-token block can be resolved for *that* account.

**Response 200** — a bare `SalesDashboardPayload` object ([`types.ts:63-93`](../../../src/lib/sales-dashboard/types.ts)), no envelope:

| Key | Type | Meaning |
|-----|------|---------|
| `normalDays` | `SalesDayAggregate[]` | Per-day normal-sale aggregates ([`types.ts:199-215`](../../../src/lib/sales-dashboard/types.ts)). |
| `addDays` | `SalesAdditionalDayAggregate[]` | Per-day additional-sale aggregates ([`types.ts:216-222`](../../../src/lib/sales-dashboard/types.ts)). |
| `pkgCount`, `progCount`, `addPkgCount`, `dayCount`, `completionRate` | `Record<string, number>` | Count/rate maps keyed by package, program, additional package, day, and completion bucket. |
| `repArr` | `SalesRepAggregate[]` | Per-rep totals ([`types.ts:234-239`](../../../src/lib/sales-dashboard/types.ts)). |
| `totalTxn`, `totalAddTxn`, `uniqueTrials`, `uniqueNewStudents`, `uniqueRenewals`, `churnedStudents`, `eligibleStudents`, `completionMonths` | number | Headline counters. |
| `weekBandPct` | `number[]` | Week-band distribution. |
| `churnList` | `SalesChurnListEntry[]` | Churn worklist ([`types.ts:240-245`](../../../src/lib/sales-dashboard/types.ts)). |
| `trialCohort`, `retentionCohort` | cohort entry arrays | ([`types.ts:246-265`](../../../src/lib/sales-dashboard/types.ts)). |
| `lastUpdated` | string \| null | Freshness stamp. |
| `sources` | `SalesDashboardSourceSummary[]` | Every source **including archived ones**, date fields serialized to ISO strings ([`types.ts:105-123`](../../../src/lib/sales-dashboard/types.ts), [`data.ts:869-871`](../../../src/lib/sales-dashboard/data.ts)). |
| `projection` | `SalesDashboardProjectionPayload` | `{ source, targetMonthlyRevenue, targetSource: "projection" \| "fallback", scenarioSummaries, months, lastImportedAt, lastImportError }` ([`types.ts:95-103`](../../../src/lib/sales-dashboard/types.ts)). Months are read from `sales_dashboard_projection_months` scoped to the source's `lastSuccessfulImportRunId`; with no active source the whole block degrades to nulls/empties rather than erroring ([`data.ts:811-853`](../../../src/lib/sales-dashboard/data.ts)). |
| `token` | object | `{ connected, email, expiresAt, lastError }` for the signed-in account. `connected` is true only when a ciphertext exists **and** the stored scope carries Sheets read ([`google-oauth.ts:276-293`](../../../src/lib/sales-dashboard/google-oauth.ts)). The helper also returns `writeConnected`, which the `SalesDashboardPayload` type does not declare. |

**Status codes:** 200 · 401 (no session email) · 500 with `{ error: <message> }` on any thrown error ([`route.ts:14-17`](../../../src/app/api/sales-dashboard/route.ts)).

**Caller:** [`sales-dashboard-shell.tsx:92`](../../../src/components/sales-dashboard/sales-dashboard-shell.tsx) fetches it with `cache: "no-store"`.

---

### `GET /api/sales-dashboard/dimensions`

The month-grain drill-down payload backing the Reps / Programs / Packages / Students tabs. Read-only. Handler: [`dimensions/route.ts:5-18`](../../../src/app/api/sales-dashboard/dimensions/route.ts).

**Auth:** session with email ([`dimensions/route.ts:6-9`](../../../src/app/api/sales-dashboard/dimensions/route.ts)).

**Request:** no parameters. Unlike the landing payload, this one takes no email — it is account-independent.

**Response 200** — a bare `SalesDimensionsPayload` ([`types.ts:339-350`](../../../src/lib/sales-dashboard/types.ts)):

| Key | Type | Grain |
|-----|------|-------|
| `months` | `string[]` | Month keys present in the data. |
| `reps` | `RepMonthAgg[]` | (rep, month) — revenue and counts split trial / new / renewal ([`types.ts:266-277`](../../../src/lib/sales-dashboard/types.ts)). |
| `repFunnels` | `RepFunnel[]` | rep, whole-history: trials handled/converted, median days to convert, top programs and packages ([`types.ts:280-288`](../../../src/lib/sales-dashboard/types.ts)). |
| `programs` | `ProgramMonthAgg[]` | (`programWiseName \|\| program`, month) ([`types.ts:290-300`](../../../src/lib/sales-dashboard/types.ts)). |
| `packages` | `PackageMonthAgg[]` | (packageBand, month) ([`types.ts:302-311`](../../../src/lib/sales-dashboard/types.ts)). |
| `additionalMix` | `AdditionalMixMonthAgg[]` | (month, salesType) ([`types.ts:332-337`](../../../src/lib/sales-dashboard/types.ts)). |
| `students` | `StudentDirectoryEntry[]` | Distinct normalized student nickname; `status` is live-recomputed from `validUntil + 14d`, **never** the stored `churn_status` ([`types.ts:313-330`](../../../src/lib/sales-dashboard/types.ts)). |
| `targetMonthlyRevenue` | number \| null | Copied from the projection payload. |
| `unparsedPackageCount` | number | Rows whose package band could not be parsed. |
| `generatedAt` | string | Build timestamp. |

Assembled by `buildSalesDimensions` ([`dimensions.ts:110`](../../../src/lib/sales-dashboard/dimensions.ts)) from the same `loadLiveRowData` pass plus the projection target ([`data.ts:948-965`](../../../src/lib/sales-dashboard/data.ts)).

**Status codes:** 200 · 401 · 500 `{ error: <message> }` ([`dimensions/route.ts:14-17`](../../../src/app/api/sales-dashboard/dimensions/route.ts)).

**Caller:** the lazy client cache in [`use-sales-dimensions.ts:85`](../../../src/hooks/use-sales-dimensions.ts), fetched once on first non-Overview tab activation.

---

### `GET /api/sales-dashboard/import-runs`

Recent import history. Read-only, uncached. Handler: [`import-runs/route.ts:5-18`](../../../src/app/api/sales-dashboard/import-runs/route.ts).

**Auth:** session with email ([`import-runs/route.ts:6-9`](../../../src/app/api/sales-dashboard/import-runs/route.ts)).

**Request:** no parameters — the page size is fixed.

**Response 200** — `{ runs }`, where `runs` is a raw `SELECT *` of `sales_dashboard_import_runs` ordered by `started_at DESC` and hard-limited to **20** ([`data.ts:967-973`](../../../src/lib/sales-dashboard/data.ts)). No projection or reshaping is applied, so each row carries the table's own columns: `id`, `sourceId`, `status`, `triggerType`, `startedAt`, `finishedAt`, `sourceCount`, `normalRowCount`, `additionalRowCount`, `errorSummary`, `actorEmail`, `metadata` ([`schema.ts:650-669`](../../../src/lib/db/schema.ts)). Projection import runs live in a separate table and are **not** included.

**Status codes:** 200 · 401 · 500 `{ error: <message> }` ([`import-runs/route.ts:14-17`](../../../src/app/api/sales-dashboard/import-runs/route.ts)).

**Callers:** none in `src/` — no component or hook fetches this path.

---

## Importing

### `POST /api/sales-dashboard/import`

The one manual entry point for monthly-sheet imports; three modes selected by the body. Handler: [`import/route.ts:30-96`](../../../src/app/api/sales-dashboard/import/route.ts). `maxDuration = 800` ([`import/route.ts:12`](../../../src/app/api/sales-dashboard/import/route.ts)).

**Auth:** session with email ([`import/route.ts:31-34`](../../../src/app/api/sales-dashboard/import/route.ts)).

**Request body** — `ImportSchema`, parsed with `.parse()` (throws) ([`import/route.ts:14-18,37`](../../../src/app/api/sales-dashboard/import/route.ts)):

| Field | Type | Notes |
|-------|------|-------|
| `sourceId` | `z.string().uuid()`, optional | Import exactly this source. |
| `mode` | `z.enum(["source","backfill","refreshable"])`, optional | Only `"backfill"` changes behaviour; see the branch table. |
| `allowFinalized` | `z.boolean()`, optional | Only consulted on the single-source branch; permits refreshing a `finalized` source. |

**Branch selection** — evaluated in this order ([`import/route.ts:38-92`](../../../src/app/api/sales-dashboard/import/route.ts)):

| Condition | Library call | Notes |
|-----------|--------------|-------|
| `mode === "backfill"` | `importAllSalesSources(email)` | Every non-archived source, `triggerType: "backfill"`, `allowFinalized: true` — finalized months are re-imported ([`data.ts:587-601`](../../../src/lib/sales-dashboard/data.ts)). |
| else if `sourceId` present | `importSalesDashboardSource(sourceId, { triggerType: "manual", actorEmail, allowFinalized })` | Single source. |
| else if no sources configured | none | Explicit no-op 200 with zeroed counters and `message: "No sources configured. Seed historical sources first."` ([`import/route.ts:63-74`](../../../src/app/api/sales-dashboard/import/route.ts)). |
| else | `importRefreshableSalesSources({ triggerType: "manual", actorEmail })` | Same live-month selection the cron uses. |

`mode: "source"` and `mode: "refreshable"` are **both** handled by the last branch when `sourceId` is absent — the enum value is never inspected beyond the `"backfill"` comparison.

**Side effects** of one source import (`importSalesDashboardSource`, [`data.ts:414-565`](../../../src/lib/sales-dashboard/data.ts)):

1. Loads the source; throws if unknown or `archived` ([`data.ts:407-412`](../../../src/lib/sales-dashboard/data.ts)).
2. Fails any of that source's `running` runs older than 20 minutes and restores the source status recorded in `metadata.previousStatus` ([`data.ts:421-424`](../../../src/lib/sales-dashboard/data.ts), [`import-guard.ts:97-125`](../../../src/lib/sales-dashboard/import-guard.ts)).
3. Rejects a `finalized` source unless `allowFinalized` ([`data.ts:426-428`](../../../src/lib/sales-dashboard/data.ts)); the same check is repeated after run acquisition, and the just-created run row is marked `failed` before the throw ([`data.ts:445-455`](../../../src/lib/sales-dashboard/data.ts)).
4. Acquires the single-flight run row, or returns the skipped outcome ([`data.ts:431-443`](../../../src/lib/sales-dashboard/data.ts)).
5. Sets the source to `status: "refreshing"` and clears `lastImportError` ([`data.ts:459-462`](../../../src/lib/sales-dashboard/data.ts)).
6. Lists the workbook's sheet titles, resolves the normal sheet (configured name, else `DEFAULT_NORMAL_SHEET`, else `LEGACY_NORMAL_SHEET`; **throws `"No normal sales sheet found"`** when none match) and optionally the additional sheet, fetches both, and parses them ([`data.ts:465-483`](../../../src/lib/sales-dashboard/data.ts)).
7. Inserts parsed rows into `sales_dashboard_normal_rows` / `sales_dashboard_additional_rows` in chunks of 500, stamped with `import_run_id` ([`data.ts:485-516`](../../../src/lib/sales-dashboard/data.ts), [`data.ts:153-162`](../../../src/lib/sales-dashboard/data.ts)).
8. Marks the run `success` with row counts and a `metadata` block naming the resolved sheets and every available sheet title, then repoints the source: `lastSuccessfulImportRunId`, `lastImportedAt`, row counts, and a new status from `statusAfterSuccessfulImport` — `active` for the current month (and for the previous month through day 7), `finalized` afterwards, with `reopened`/`archived` preserved ([`data.ts:517-544`](../../../src/lib/sales-dashboard/data.ts), [`lifecycle.ts:21-33`](../../../src/lib/sales-dashboard/lifecycle.ts)).
9. Invalidates the `sales-dashboard` cache tag ([`data.ts:545`](../../../src/lib/sales-dashboard/data.ts)).
10. On failure: the run row is set `failed` with an `errorSummary`, the source is rolled back to its pre-import status with `lastImportError` set, and the error is re-thrown ([`data.ts:553-565`](../../../src/lib/sales-dashboard/data.ts)).

**Response 200 — single-source branch:** `{ ok: true, result }` ([`import/route.ts:61`](../../../src/app/api/sales-dashboard/import/route.ts)), `result` being the import outcome or the skipped outcome described under the cron route.

**Response 200 — backfill / refreshable / no-op branches:** `{ ok: true, results, sourceCount, importedSourceCount, normalRows, additionalRows, message }` ([`import/route.ts:43-53,82-92`](../../../src/app/api/sales-dashboard/import/route.ts)). `normalRows`/`additionalRows` are summed across outcomes; `importedSourceCount` counts only entries without `skipped: true` ([`import/route.ts:20-22`](../../../src/app/api/sales-dashboard/import/route.ts)). `sourceCount` is the number of results on the backfill branch but the number of **configured** sources on the refreshable branch — the two are not the same denominator. `message` is human-readable and differs per branch.

**Status codes:**

| Status | When |
|--------|------|
| 200 | Any of the four branches, including a per-source single-flight skip. |
| 401 | No session email. |
| 409 | `MissingGoogleSheetsTokenError` ([`import/route.ts:24-28`](../../../src/app/api/sales-dashboard/import/route.ts)). |
| 500 | Everything else, **including a Zod validation failure and a malformed JSON body** — `ImportSchema.parse` throws into the same `errorResponse` helper, which only special-cases the Sheets-token error. A non-UUID `sourceId` therefore returns 500 with the serialized Zod message, not 400. |

**Callers:** [`sales-dashboard-shell.tsx:199`](../../../src/components/sales-dashboard/sales-dashboard-shell.tsx) (`mode: "backfill"`), [`:211`](../../../src/components/sales-dashboard/sales-dashboard-shell.tsx) (`mode: "refreshable"`), and [`source-manager.tsx:197`](../../../src/components/sales-dashboard/source-manager.tsx) (`{ sourceId, allowFinalized }`, where `allowFinalized` is a `window.confirm` result).

---

### `POST /api/sales-dashboard/projection-import`

Re-imports the single active Bear/Base/Bull scenario workbook. Handler: [`projection-import/route.ts:8-27`](../../../src/app/api/sales-dashboard/projection-import/route.ts). `maxDuration = 800` ([`projection-import/route.ts:6`](../../../src/app/api/sales-dashboard/projection-import/route.ts)).

**Auth:** session with email ([`projection-import/route.ts:9-12`](../../../src/app/api/sales-dashboard/projection-import/route.ts)).

**Request:** no body is read and no parameters are accepted. The target is always the row with `status = "active"` ([`data.ts:236-243`](../../../src/lib/sales-dashboard/data.ts)).

**Side effects** (`importSalesDashboardProjectionSource`, [`data.ts:633-726`](../../../src/lib/sales-dashboard/data.ts)):

- Inserts a `sales_dashboard_projection_import_runs` row with `status: "running"`, `triggerType: "manual"`, `actorEmail`, and clears the source's `lastImportError` ([`data.ts:641-655`](../../../src/lib/sales-dashboard/data.ts)). There is **no** single-flight guard on this table — concurrent projection imports are not prevented.
- Requires all three configured sheets to exist by name (`Summary`, `What_If`, `Calc_Multi` by default), throwing ``Projection workbook is missing <purpose> sheet "<name>"`` otherwise ([`data.ts:603-606`](../../../src/lib/sales-dashboard/data.ts)); fetches and parses them ([`data.ts:608-631`](../../../src/lib/sales-dashboard/data.ts)).
- Inserts one `sales_dashboard_projection_months` row per scenario-month under the new `import_run_id` (chunks of 500), then marks the run `success` with `monthRowCount`, `targetMonthlyRevenue`, and the parsed `metadata` (which carries `scenarioSummaries`), and repoints the source's `lastSuccessfulImportRunId` / `lastImportedAt` / `lastProjectionMonthCount` / `lastTargetMonthlyRevenue` ([`data.ts:658-706`](../../../src/lib/sales-dashboard/data.ts)).
- Invalidates the `sales-dashboard` cache tag; on failure marks the run `failed`, writes `lastImportError` on the source, invalidates the tag, and re-throws ([`data.ts:706,713-725`](../../../src/lib/sales-dashboard/data.ts)).

**Response 200** — `{ ok: true, result }` with `result = { sourceId, runId, projectionMonths, targetMonthlyRevenue }` ([`projection-import/route.ts:22`](../../../src/app/api/sales-dashboard/projection-import/route.ts), [`data.ts:707-712`](../../../src/lib/sales-dashboard/data.ts)).

**Status codes:**

| Status | When |
|--------|------|
| 200 | Import completed. |
| 401 | No session email. |
| 409 | No active projection source — body `{"error":"No projection source configured."}` ([`projection-import/route.ts:19-21`](../../../src/app/api/sales-dashboard/projection-import/route.ts)); **or** `MissingGoogleSheetsTokenError` ([`projection-import/route.ts:25`](../../../src/app/api/sales-dashboard/projection-import/route.ts)). The two cases share a status and are distinguishable only by message. |
| 500 | Any other thrown error, including a missing sheet tab. |

**Caller:** [`sales-dashboard-shell.tsx:243`](../../../src/components/sales-dashboard/sales-dashboard-shell.tsx).

---

## Source configuration

### `POST /api/sales-dashboard/projection-source`

Upserts the single active projection source, or seeds the built-in default when the body omits a URL. Handler: [`projection-source/route.ts:16-39`](../../../src/app/api/sales-dashboard/projection-source/route.ts).

**Auth:** session with email ([`projection-source/route.ts:17-20`](../../../src/app/api/sales-dashboard/projection-source/route.ts)).

**Request body** — `ProjectionSourceInputSchema`, `.parse()` (throws) ([`projection-source/route.ts:9-14,23`](../../../src/app/api/sales-dashboard/projection-source/route.ts)). **Every field is optional**, so `{}` is valid and selects the seed path:

| Field | Type | Notes |
|-------|------|-------|
| `spreadsheetUrl` | `z.string().min(1)`, optional | Present → upsert. Absent → `seedDefaultSalesDashboardProjectionSource`. Resolved through `extractSpreadsheetId`, which accepts a `/spreadsheets/d/<id>` URL or a bare ≥20-char id and otherwise throws `"Invalid Google Sheet URL or spreadsheet ID"` ([`parser.ts:71-77`](../../../src/lib/sales-dashboard/parser.ts)). |
| `summarySheetName` | string, optional | Defaults to `"Summary"` ([`projection.ts:10`](../../../src/lib/sales-dashboard/projection.ts)). |
| `whatIfSheetName` | string, optional | Defaults to `"What_If"` ([`projection.ts:11`](../../../src/lib/sales-dashboard/projection.ts)). |
| `calcMultiSheetName` | string, optional | Defaults to `"Calc_Multi"` ([`projection.ts:12`](../../../src/lib/sales-dashboard/projection.ts)). |

**Side effects** ([`data.ts:245-280`](../../../src/lib/sales-dashboard/data.ts)): updates the existing `status = "active"` row when one exists (also clearing `lastImportError`), otherwise inserts a new `active` row. `connectedEmail` and the actor columns are set from the session email, lowercased. The partial unique index `sdps_single_active_idx` keeps at most one active row ([`schema.ts:737-739`](../../../src/lib/db/schema.ts)). Ends with a cache-tag invalidation. **No import is triggered** — call `POST /api/sales-dashboard/projection-import` afterwards.

**Response 200** — `{ source }`, a `SalesDashboardProjectionSourceRecord` with `Date` fields serialized by `NextResponse.json` ([`types.ts:124-142`](../../../src/lib/sales-dashboard/types.ts)).

**Status codes:** 200 · 401 · **400** for *every* thrown error including Zod failures, a malformed body, an unparseable spreadsheet URL, and database errors ([`projection-source/route.ts:35-38`](../../../src/app/api/sales-dashboard/projection-source/route.ts)) — this handler has no 500 path.

**Caller:** [`sales-dashboard-shell.tsx:231`](../../../src/components/sales-dashboard/sales-dashboard-shell.tsx).

---

### `GET /api/sales-dashboard/sources`

Lists the configured monthly sales sources. Read-only, uncached. Handler: [`sources/route.ts:18-31`](../../../src/app/api/sales-dashboard/sources/route.ts).

**Auth:** session with email ([`sources/route.ts:19-22`](../../../src/app/api/sales-dashboard/sources/route.ts)).

**Request:** no parameters. `listSalesDashboardSources` is called without the `includeArchived` option, so archived rows are **excluded** here — the SQL filters `status::text <> 'archived'` — and rows come back ordered by `source_month` ascending ([`sources/route.ts:25`](../../../src/app/api/sales-dashboard/sources/route.ts), [`data.ts:164-178`](../../../src/lib/sales-dashboard/data.ts)). This differs from the `sources` array inside `GET /api/sales-dashboard`, which *does* include archived rows.

**Response 200** — `{ sources }`, an array of `SalesDashboardSourceRecord` ([`types.ts:6-30`](../../../src/lib/sales-dashboard/types.ts)): `id`, `sourceMonth`, `label`, `spreadsheetId`, `spreadsheetUrl`, `normalSheetName`, `additionalSheetName`, `status`, `lastSuccessfulImportRunId`, `lastImportedAt`, `lastImportError`, `lastNormalRowCount`, `lastAdditionalRowCount`, `finalizedAt`, `reopenedAt`, `archivedAt`, `archivedByEmail`, `statusBeforeArchive`, `connectedEmail`, `createdByEmail`, `updatedByEmail`, `createdAt`, `updatedAt`.

**Status codes:** 200 · 401 · 500 `{ error: <message> }` ([`sources/route.ts:27-30`](../../../src/app/api/sales-dashboard/sources/route.ts)).

**Callers:** none in `src/` — the shell reads its source list from the landing payload instead.

---

### `POST /api/sales-dashboard/sources`

Creates or updates the source for one month. Handler: [`sources/route.ts:33-52`](../../../src/app/api/sales-dashboard/sources/route.ts).

**Auth:** session with email ([`sources/route.ts:34-37`](../../../src/app/api/sales-dashboard/sources/route.ts)).

**Request body** — `SourceInputSchema`, `.parse()` (throws) ([`sources/route.ts:10-16,40`](../../../src/app/api/sales-dashboard/sources/route.ts)):

| Field | Type | Notes |
|-------|------|-------|
| `spreadsheetUrl` | `z.string().min(1)`, **required** | Through `extractSpreadsheetId` ([`parser.ts:71-77`](../../../src/lib/sales-dashboard/parser.ts)). |
| `sourceMonth` | string matching `^\d{4}-\d{2}(-\d{2})?$`, **required** | The handler truncates to `YYYY-MM` with `.slice(0, 7)` before the upsert, so a supplied day is discarded ([`sources/route.ts:43`](../../../src/app/api/sales-dashboard/sources/route.ts)); the library normalizes that to a first-of-month `date`. |
| `label` | string, optional | Blank or absent → derived from the month ([`data.ts:184`](../../../src/lib/sales-dashboard/data.ts)). |
| `normalSheetName` | string, optional | Blank → `null` (resolution then falls back to the default/legacy sheet names at import time). |
| `additionalSheetName` | string, optional | Blank → `null`. |

**Side effects** ([`data.ts:181-217`](../../../src/lib/sales-dashboard/data.ts)): an `INSERT … ON CONFLICT (source_month) WHERE archived_at IS NULL DO UPDATE`, matching the partial unique index `sds_source_month_active_idx` ([`schema.ts:643-645`](../../../src/lib/db/schema.ts)) — so a second POST for the same month **overwrites** the existing source rather than creating a duplicate, while an archived row for that month is left alone. `connectedEmail`/`createdByEmail`/`updatedByEmail` are lowercased from the session email; new rows are created `active`. Ends with a cache-tag invalidation. **No import is triggered.**

**Response 200** — `{ source }`, a `SalesDashboardSourceRecord`.

**Status codes:** 200 · 401 · **400** for every thrown error including Zod failures and DB errors ([`sources/route.ts:48-51`](../../../src/app/api/sales-dashboard/sources/route.ts)) — no 500 path.

**Caller:** [`sales-dashboard-shell.tsx:218`](../../../src/components/sales-dashboard/sales-dashboard-shell.tsx).

---

### `PATCH /api/sales-dashboard/sources/[sourceId]`

Changes a source's lifecycle status; doubles as the **restore** action for an archived source. Handler: [`[sourceId]/route.ts:15-31`](../../../src/app/api/sales-dashboard/sources/[sourceId]/route.ts).

**Auth:** session with email ([`[sourceId]/route.ts:16-19`](../../../src/app/api/sales-dashboard/sources/[sourceId]/route.ts)).

**Path parameter:** `sourceId` — awaited from `ctx.params` ([`[sourceId]/route.ts:13,22`](../../../src/app/api/sales-dashboard/sources/[sourceId]/route.ts)). It is **not** validated as a UUID; an unparseable id surfaces as a database error → 400.

**Request body** — `PatchSchema`, `.parse()` (throws) ([`[sourceId]/route.ts:9-11,23`](../../../src/app/api/sales-dashboard/sources/[sourceId]/route.ts)):

| Field | Type | Notes |
|-------|------|-------|
| `status` | `z.enum(["active","finalized","reopened"])`, **required** | `"archived"` is deliberately not accepted here — archiving is the DELETE verb. |

**Side effects** (`updateSalesDashboardSourceStatus`, [`data.ts:293-325`](../../../src/lib/sales-dashboard/data.ts)):

- Unknown id → `null` → **404**.
- Source currently `archived`: only `status: "active"` is permitted (anything else throws `"Restore archived source before changing its status."`), and it is routed to `restoreSalesDashboardSource`, which refuses when another non-archived source already owns that month (`"Another active source already exists for this month. Archive it before restoring this source."`) and otherwise restores `statusBeforeArchive` — falling back to `active` when that value was `archived`/`refreshing` ([`data.ts:298-305,356-393`](../../../src/lib/sales-dashboard/data.ts)).
- Otherwise the status is written directly, with `finalizedAt`/`reopenedAt` stamped only for the matching status and all three archive columns cleared ([`data.ts:307-322`](../../../src/lib/sales-dashboard/data.ts)).
- Ends with a cache-tag invalidation.

**Response 200** — `{ source }`, the updated `SalesDashboardSourceRecord`.

**Status codes:** 200 · 401 · **404** `{"error":"Source not found"}` ([`[sourceId]/route.ts:25`](../../../src/app/api/sales-dashboard/sources/[sourceId]/route.ts)) · **400** for every thrown error including Zod failures and the two restore guards ([`[sourceId]/route.ts:27-30`](../../../src/app/api/sales-dashboard/sources/[sourceId]/route.ts)).

**Callers:** [`source-manager.tsx:203`](../../../src/components/sales-dashboard/source-manager.tsx) (`{ status: "reopened" }`) and [`:250`](../../../src/components/sales-dashboard/source-manager.tsx) (`{ status: "active" }`, the Restore button).

---

### `DELETE /api/sales-dashboard/sources/[sourceId]`

**Archives** a source — it never hard-deletes. Handler: [`[sourceId]/route.ts:33-48`](../../../src/app/api/sales-dashboard/sources/[sourceId]/route.ts).

**Auth:** session with email ([`[sourceId]/route.ts:34-37`](../../../src/app/api/sales-dashboard/sources/[sourceId]/route.ts)).

**Path parameter:** `sourceId`, awaited from `ctx.params` ([`[sourceId]/route.ts:40`](../../../src/app/api/sales-dashboard/sources/[sourceId]/route.ts)). **Request body:** none — the `NextRequest` argument is discarded (`_request`).

**Side effects** (`archiveSalesDashboardSource`, [`data.ts:327-354`](../../../src/lib/sales-dashboard/data.ts)):

- Unknown id → `null` → **404**.
- Already `archived` → returned unchanged, **200**, no write (idempotent).
- Status `refreshing` → throws `"Source is refreshing. Wait for the import to finish before archiving it."` → **500**.
- Otherwise sets `status: "archived"`, `archivedAt`, `archivedByEmail`, and stores the prior status in `statusBeforeArchive` so a later restore can reinstate it. Imported rows are left in place; they simply stop being read, because `loadLiveRowData` drops archived sources ([`data.ts:870-871`](../../../src/lib/sales-dashboard/data.ts)). Ends with a cache-tag invalidation.

**Response 200** — `{ ok: true, source }`, the archived `SalesDashboardSourceRecord`.

**Status codes:** 200 · 401 · **404** `{"error":"Source not found"}` ([`[sourceId]/route.ts:42`](../../../src/app/api/sales-dashboard/sources/[sourceId]/route.ts)) · **500** for any thrown error, including the refreshing guard ([`[sourceId]/route.ts:44-47`](../../../src/app/api/sales-dashboard/sources/[sourceId]/route.ts)).

**Caller:** [`source-manager.tsx:210`](../../../src/components/sales-dashboard/source-manager.tsx).

---

### `POST /api/sales-dashboard/sources/seed`

Bulk-creates the built-in historical source set. Handler: [`sources/seed/route.ts:5-18`](../../../src/app/api/sales-dashboard/sources/seed/route.ts).

**Auth:** session with email ([`sources/seed/route.ts:6-9`](../../../src/app/api/sales-dashboard/sources/seed/route.ts)).

**Request:** no body is read, no parameters.

**Side effects** (`seedDefaultSalesSources`, [`data.ts:220-234`](../../../src/lib/sales-dashboard/data.ts)): iterates the hard-coded `DEFAULT_SALES_SOURCES` list — 14 monthly workbooks from `2025-04` to `2026-05`, the first two pinned to `LEGACY_NORMAL_SHEET` ([`default-sources.ts:3-18`](../../../src/lib/sales-dashboard/default-sources.ts)) — and runs the same month-keyed upsert as `POST /api/sales-dashboard/sources` for each, sequentially. Both `connectedEmail` and the actor columns are the caller's email, so **seeding repoints every listed month's Google connection at whoever ran it**. Each upsert invalidates the cache tag. **No import is triggered.**

**Response 200** — `{ sources, count }` where `sources` is the array of upserted `SalesDashboardSourceRecord`s and `count` its length ([`sources/seed/route.ts:13`](../../../src/app/api/sales-dashboard/sources/seed/route.ts)).

**Status codes:** 200 · 401 · 500 `{ error: <message> }` ([`sources/seed/route.ts:14-17`](../../../src/app/api/sales-dashboard/sources/seed/route.ts)).

**Caller:** [`sales-dashboard-shell.tsx:192`](../../../src/components/sales-dashboard/sales-dashboard-shell.tsx).

---

## Transactions

Both endpoints read the same cached slim materialization (`getLiveSlimRows`, [`data.ts:932-941`](../../../src/lib/sales-dashboard/data.ts)) — normal and additional rows mapped through `toSlimTransaction` / `toSlimAdditionalTransaction` and sorted newest-first, then by kind, student key, and descending amount ([`dimensions.ts:395-433,464-471`](../../../src/lib/sales-dashboard/dimensions.ts)). The `raw` jsonb column is **never** serialized on either path; a route test asserts this ([`transactions-route.test.ts:136`](../../../src/app/api/sales-dashboard/__tests__/transactions-route.test.ts)).

**Shared filters** — `salesTransactionFilterSchema` ([`transaction-query.ts:11-18`](../../../src/lib/sales-dashboard/transaction-query.ts)); only the declared keys are read off the query string, everything else is ignored ([`transaction-query.ts:33-43`](../../../src/lib/sales-dashboard/transaction-query.ts)):

| Param | Type | Semantics ([`dimensions.ts:450-462`](../../../src/lib/sales-dashboard/dimensions.ts)) |
|-------|------|-----------|
| `rep` | non-empty string | Compared through `normalizeRepKey`. Never matches an `additional` row. |
| `program` | non-empty string | Exact match. Never matches an `additional` row. |
| `band` | non-empty string | Exact match. Never matches an `additional` row. |
| `student` | non-empty string | Compared through `normalizeStudentKey`; matches **both** kinds. |
| `from` | `YYYY-MM-DD` | Inclusive lower bound on `date` (string compare). |
| `to` | `YYYY-MM-DD` | Inclusive upper bound on `date` (string compare). |

A malformed date yields `400 { error: "Invalid query", details: <flattened Zod error> }` on both endpoints.

### `GET /api/sales-dashboard/transactions`

Paged, filtered rows. Handler: [`transactions/route.ts:11-36`](../../../src/app/api/sales-dashboard/transactions/route.ts).

**Auth:** session with email ([`transactions/route.ts:12-15`](../../../src/app/api/sales-dashboard/transactions/route.ts)).

**Query parameters:** the six shared filters plus paging, via `salesTransactionPageQuerySchema` ([`transaction-query.ts:20-28`](../../../src/lib/sales-dashboard/transaction-query.ts)):

| Param | Type | Default | Notes |
|-------|------|---------|-------|
| `limit` | coerced positive int | `200` (`SALES_TRANSACTION_DEFAULT_LIMIT`) | **Clamped** down to `1000` (`SALES_TRANSACTION_MAX_LIMIT`) by a `.transform`, not rejected ([`transaction-query.ts:5-6,21-26`](../../../src/lib/sales-dashboard/transaction-query.ts)); a test pins this ([`transactions-route.test.ts:108`](../../../src/app/api/sales-dashboard/__tests__/transactions-route.test.ts)). `limit=0` or a negative value fails `.positive()` → 400. |
| `offset` | coerced int ≥ 0 | `0` | A negative value → 400. |

Filtering and paging both happen **in memory** — the full slim set is materialized, filtered, then sliced ([`transactions/route.ts:26-31`](../../../src/app/api/sales-dashboard/transactions/route.ts)).

**Response 200** — `{ rows, total }`, where `rows` is the `offset`-to-`offset+limit` slice and `total` is the count **after filtering, before paging**. Each row is a `SlimTransaction` ([`types.ts:353-370`](../../../src/lib/sales-dashboard/types.ts)): `date`, `student`, `studentKey`, `rep`, `program`, `packageLabel`, `band`, `hours`, `amount`, `enrollmentType`, `validUntil`, `sourceMonth`, `numberOfStudents`, `kind` (`"normal" | "additional"`), and `salesType` on additional rows.

**Status codes:** 200 · 400 (invalid query) · 401 · 500 `{ error: <message> }` ([`transactions/route.ts:32-35`](../../../src/app/api/sales-dashboard/transactions/route.ts)).

**Caller:** [`transactions-table.tsx:82`](../../../src/components/sales-dashboard/transactions-table.tsx), fetched with `cache: "no-store"` and an `AbortSignal`.

---

### `GET /api/sales-dashboard/transactions/export`

The same filtered set as a downloadable CSV. Handler: [`transactions/export/route.ts:37-65`](../../../src/app/api/sales-dashboard/transactions/export/route.ts).

**Auth:** session with email ([`transactions/export/route.ts:38-41`](../../../src/app/api/sales-dashboard/transactions/export/route.ts)).

**Query parameters:** the six shared filters only — `salesTransactionFilterSchema`, **no `limit`/`offset`** ([`transactions/export/route.ts:43-48`](../../../src/app/api/sales-dashboard/transactions/export/route.ts)). Every matching row is written, unpaged.

**Response 200** — a bare `Response` (not `NextResponse.json`) whose body is the CSV ([`transactions/export/route.ts:54-60`](../../../src/app/api/sales-dashboard/transactions/export/route.ts)):

| Header | Value |
|--------|-------|
| `Content-Type` | `text/csv; charset=utf-8` |
| `Content-Disposition` | `attachment; filename="sales-dashboard-transactions-<from>-to-<to>.csv"`, where an absent `from`/`to` becomes the literal `all`, run through `sanitizeCsvFilename` ([`transactions/export/route.ts:31-35`](../../../src/app/api/sales-dashboard/transactions/export/route.ts), [`csv.ts:35-43`](../../../src/lib/sales-dashboard/csv.ts)) |
| `Cache-Control` | `no-store` |

Fifteen columns in fixed order — Date, Kind, Student, Student Key, Rep, Program, Package, Band, Hours, Amount, Enrollment Type, Sales Type, Valid Until, Source Month, Number Of Students ([`transactions/export/route.ts:13-29`](../../../src/app/api/sales-dashboard/transactions/export/route.ts)). `serializeCsv` prefixes a UTF-8 BOM by default, joins rows with `\r\n`, and quotes **every** field with `""` escaping ([`csv.ts:1,13-33`](../../../src/lib/sales-dashboard/csv.ts)).

**Status codes:** 200 · 400 (invalid query, JSON body) · 401 · 500 `{ error: <message> }` ([`transactions/export/route.ts:61-64`](../../../src/app/api/sales-dashboard/transactions/export/route.ts)).

**Caller:** the href is built by `buildTransactionsExportHref` ([`export-links.ts:3-13`](../../../src/lib/sales-dashboard/export-links.ts)), which forwards only truthy filter values.

---

_Verified against main@0cd1e81 (clean tree) on 2026-09-02._
