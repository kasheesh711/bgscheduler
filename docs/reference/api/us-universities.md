# US Universities (IPEDS) API

**Status: stable** (handbook maturity map; no `@deprecated` or status marker exists in code). Feature meaning — what the research console is for, the load-time institution filter, the CIP rules, the fail-closed null policy — lives in [docs/features/us-universities.md](../../features/us-universities.md). Column-level detail for the three `ipeds_*` tables lives in [the core ERD, §4](../database/erd-core.md#4-us-universities--ipeds-3-tables). **This page owns the mechanics**: method, path, auth, request shape, response shape, side effects, and status codes.

**Authoritative source:** the five handlers under [`src/app/api/us-universities/`](../../../src/app/api/us-universities/), the shared query parser [`src/lib/us-universities/request.ts`](../../../src/lib/us-universities/request.ts), the cached data layer [`src/lib/us-universities/data.ts`](../../../src/lib/us-universities/data.ts), and the query builder [`src/lib/us-universities/query.ts`](../../../src/lib/us-universities/query.ts).

Group index and the cross-group endpoint table: [docs/reference/api/index.md](./index.md).

## Endpoint index (5)

| Method | Path | Auth | Writes | Handler |
|--------|------|------|--------|---------|
| GET | `/api/us-universities` | session **with `user.email`** | none | [`route.ts:5-18`](../../../src/app/api/us-universities/route.ts) |
| GET | `/api/us-universities/search` | session **with `user.email`** | none | [`search/route.ts:10-28`](../../../src/app/api/us-universities/search/route.ts) |
| GET | `/api/us-universities/export` | session **with `user.email`** | none | [`export/route.ts:11-36`](../../../src/app/api/us-universities/export/route.ts) |
| GET | `/api/us-universities/institutions/[unitId]` | session **with `user.email`** | none | [`institutions/[unitId]/route.ts:8-31`](../../../src/app/api/us-universities/institutions/[unitId]/route.ts) |
| GET | `/api/us-universities/compare` | session **with `user.email`** | none | [`compare/route.ts:9-37`](../../../src/app/api/us-universities/compare/route.ts) |

**All five are `GET` and all five are read-only.** The namespace exports no `POST`, `PUT`, `PATCH`, or `DELETE` handler, so nothing here writes Postgres, and nothing here touches Wise. The `ipeds_*` tables are populated exclusively by the local one-time importer (`scripts/ipeds-import.ts`), which is not reachable over HTTP — the schema comment states the runtime "only ever reads these tables, never the source `.accdb`/CSV" ([`schema.ts:3000-3005`](../../../src/lib/db/schema.ts)). There is no cron: `grep -n 'us-universities' vercel.json src/lib/data-health/cron-registry.ts` returns nothing.

**Only three of the five have an in-app caller.** `/search` is polled by the console shell on every filter/sort/page change ([`us-universities-shell.tsx:150`](../../../src/components/us-universities/us-universities-shell.tsx)) and by the type-ahead combobox ([`institution-search-combobox.tsx:33-38`](../../../src/components/us-universities/institution-search-combobox.tsx)); `/export` is an `href` on two download links ([`institution-table.tsx:185`](../../../src/components/us-universities/institution-table.tsx), [`us-universities-shell.tsx:359`](../../../src/components/us-universities/us-universities-shell.tsx)); `/compare` is fetched by the compare panel ([`compare-panel.tsx:333`](../../../src/components/us-universities/compare-panel.tsx)). The overview and single-institution endpoints have **no caller outside their own route tests** — both pages bypass HTTP and call the cached helpers directly on the server ([`(app)/us-universities/page.tsx:14`](../../../src/app/%28app%29/us-universities/page.tsx), [`(app)/us-universities/[unitId]/page.tsx`](../../../src/app/%28app%29/us-universities/[unitId]/page.tsx)).

---

## Conventions shared by all five endpoints

**Auth.** Every handler calls `auth()` from [`@/lib/auth`](../../../src/lib/auth.ts) and tests `session?.user?.email`, not merely `session` — a session without an email address is rejected. Failure is always `401 {"error":"Unauthorized"}` ([`route.ts:6-9`](../../../src/app/api/us-universities/route.ts), [`search/route.ts:11-14`](../../../src/app/api/us-universities/search/route.ts), [`export/route.ts:12-15`](../../../src/app/api/us-universities/export/route.ts), [`institutions/[unitId]/route.ts:12-15`](../../../src/app/api/us-universities/institutions/[unitId]/route.ts), [`compare/route.ts:10-13`](../../../src/app/api/us-universities/compare/route.ts)). There is no role model and no per-institution capability check: any signed-in user who reaches these paths reads the whole curated slice.

**Middleware.** `/api/us-universities/**` is not in the public allowlist ([`middleware.ts:10-26`](../../../src/middleware.ts)), so an unauthenticated request is redirected to `/login` before the handler runs ([`middleware.ts:89-93`](../../../src/middleware.ts)) — the handler's own 401 is the second gate, reachable when a session exists but carries no email. A restricted user whose `allowedPages` does not prefix-match `/us-universities` gets a middleware-level `403 {"error":"Forbidden"}`, because `isPathAllowed` matches each allowed page both as `/x` and as `/api/x` ([`middleware.ts:36-67`](../../../src/middleware.ts), [`:97-100`](../../../src/middleware.ts)).

**Error envelope.** Every handler wraps its data call in `try/catch` and returns `{"error": <message>}` with 500, falling back to a per-route literal for a non-`Error` throw: `"Failed to load overview"`, `"Failed to search institutions"`, `"Failed to export institutions"`, `"Failed to load institution"`, `"Failed to compare institutions"`. Zod failures return `400 {"error": <flattened>}` using `parsed.error.flatten()` — an object with `formErrors` / `fieldErrors`, not a string.

**No route segment config.** None of the five declares `maxDuration`, `dynamic`, `revalidate`, or `"use cache"` at the route level (`grep` over the directory returns nothing), so each runs at the platform default.

**Caching lives one layer down.** All five delegate to helpers in [`data.ts`](../../../src/lib/us-universities/data.ts) that are themselves `"use cache"` functions tagged `us-universities` with `cacheLife({ stale: 300, revalidate: 600, expire: 3600 })` ([`data.ts:366-413`](../../../src/lib/us-universities/data.ts), tag constant at [`:35`](../../../src/lib/us-universities/data.ts)). Two consequences worth knowing:

- A response can be up to an hour stale, keyed by the helper's arguments — so two clients sending the same filter string share one cache entry.
- **Nothing ever sweeps the tag.** `revalidateTag("us-universities")` appears nowhere in `src/` or `scripts/`; the source comment says the tag is "swept by a future re-import flow if added" ([`data.ts:1-4`](../../../src/lib/us-universities/data.ts)). A fresh local import is therefore invisible to these endpoints until entries expire on their own.

**The data year is not client-settable.** Every helper takes `dataYear` as a defaulted parameter, and no handler passes it — so all five are pinned to `CURRENT_DATA_YEAR = "2024-25"` ([`constants.ts:6`](../../../src/lib/us-universities/constants.ts)). The one exception to "current year only" is the admissions trend, which deliberately reads every year present for a unit id ([`data.ts:89-98`](../../../src/lib/us-universities/data.ts)).

**Row shape.** List, compare, and export payloads run rows through `stripRaw`, which removes only the `raw` JSONB blob ([`data.ts:45-48`](../../../src/lib/us-universities/data.ts)) — `IpedsInstitutionSummary` is `Omit<IpedsInstitution, "raw">` ([`types.ts:16`](../../../src/lib/us-universities/types.ts)), so the internal `id`, `importRunId`, and `createdAt` columns still ship to the client. The **profile endpoint does not strip anything** and returns `raw` too (see below).

**Tests.** Five route suites, one per endpoint, under [`src/app/api/us-universities/__tests__/`](../../../src/app/api/us-universities/__tests__/) — all mock `@/lib/auth` and the whole data module, so none touches Postgres. Between them they cover the 401 on every route, the 400 paths on search and compare, the CSV headers and a header-only body on export, the 404 and non-numeric-param 400 on the institution route, and a 500 on overview. The `MAX_COMPARE` truncation is the one branch no test exercises ([`compare-route.test.ts`](../../../src/app/api/us-universities/__tests__/compare-route.test.ts) never sends more than two ids).

### The shared filter query (`/search` and `/export`)

Both browse endpoints parse the query string identically: `searchParamsToObject` flattens `URLSearchParams` into a plain object, `FilterQuerySchema.safeParse` validates it, and `toFilterParams` converts the validated object into `FilterParams` ([`request.ts:12-54`](../../../src/lib/us-universities/request.ts)).

| Param | Zod rule ([`request.ts`](../../../src/lib/us-universities/request.ts)) | Effect |
|-------|------------------|--------|
| `search` | `z.string().trim().min(1).optional()` (`:13`) | Case-insensitive `ILIKE '%term%'` against `inst_name` **only** — alias, city, and state are not searched ([`query.ts:57-58`](../../../src/lib/us-universities/query.ts)). |
| `states` | `z.string().optional()` (`:14`) | Comma list → `IN (…)` on `state_abbr` ([`request.ts:6-10,33`](../../../src/lib/us-universities/request.ts), [`query.ts:59`](../../../src/lib/us-universities/query.ts)). |
| `control` | `z.string().optional()` (`:15`) | Comma list parsed to integers, non-numeric entries dropped → `IN (…)` on `control` (`1` public, `2` private nonprofit, `3` private for-profit — [`constants.ts:9-13`](../../../src/lib/us-universities/constants.ts)). A list that parses to nothing simply drops the filter ([`request.ts:34-36`](../../../src/lib/us-universities/request.ts), [`query.ts:60`](../../../src/lib/us-universities/query.ts)). |
| `minAcceptance` / `maxAcceptance` | `z.coerce.number().optional()` (`:16-17`) | `>=` / `<=` on `acceptance_rate` (percentage points, not a fraction) ([`query.ts:61-62`](../../../src/lib/us-universities/query.ts)). |
| `maxNetPrice` | `z.coerce.number().optional()` (`:18`) | `<=` on `avg_net_price` ([`query.ts:63`](../../../src/lib/us-universities/query.ts)). |
| `minGradRate` | `z.coerce.number().optional()` (`:19`) | `>=` on `grad_rate_bach_6yr` ([`query.ts:64`](../../../src/lib/us-universities/query.ts)). |
| `cip2` | `z.string().trim().min(1).optional()` (`:20`) | Two-digit CIP family. Composed as an `IN (subquery)` against `ipeds_completions` for the same data year — the one condition built in `data.ts`, not `query.ts` ([`data.ts:108-114`](../../../src/lib/us-universities/data.ts), [`:162-169`](../../../src/lib/us-universities/data.ts)). |
| `sort` | `z.string().trim().min(1).optional()` (`:21`) | Resolved against a nine-key whitelist — `instName`, `stateAbbr`, `acceptanceRate`, `enrollmentTotal`, `gradRateBach6yr`, `avgNetPrice`, `totalPriceInState`, `satReadingP75`, `studentFacultyRatio` ([`constants.ts:160-174`](../../../src/lib/us-universities/constants.ts)). An unrecognised key **silently falls back** to `instName`; raw input never reaches SQL ([`query.ts:29-38`](../../../src/lib/us-universities/query.ts)). |
| `dir` | `z.enum(["asc","desc"]).optional()` (`:22`) | Anything else is a **400**. Default `asc` ([`query.ts:37`](../../../src/lib/us-universities/query.ts)). |
| `page` | `z.coerce.number().int().positive().optional()` (`:23`) | 1-based; floored and clamped to `>= 1` ([`query.ts:50`](../../../src/lib/us-universities/query.ts)). Ignored by `/export`. |
| `pageSize` | `z.coerce.number().int().positive().optional()` (`:24`) | Default `50`, clamped to `[1, 100]` — a `pageSize=1000` is silently reduced, not rejected ([`constants.ts:175-176`](../../../src/lib/us-universities/constants.ts), [`query.ts:46-49`](../../../src/lib/us-universities/query.ts)). Ignored by `/export`. |

Four parsing behaviours are easy to trip over:

1. **Repeated params: last one wins.** `searchParamsToObject` assigns into a plain object as it iterates, so `?states=CA&states=NY` yields `states=NY`, not both ([`request.ts:50-54`](../../../src/lib/us-universities/request.ts)). Use the comma list.
2. **An empty numeric param is a real filter of `0`, not "absent".** `z.coerce.number()` runs `Number("")`, which is `0`, so `?maxNetPrice=` parses successfully as `maxNetPrice: 0` and pushes `avg_net_price <= 0` — matching almost nothing. `?page=` is different: `0` fails `.positive()` and returns 400. The in-app query builder never emits an empty numeric param ([`institution-table.tsx:94-117`](../../../src/components/us-universities/institution-table.tsx)).
3. **An empty `search=` is a 400,** because `.min(1)` runs after `.trim()`. `buildSuggestQuery("")` produces exactly that string, but the combobox returns early on an empty term and never fetches it ([`institution-search-combobox.tsx:33-38,57-61`](../../../src/components/us-universities/institution-search-combobox.tsx)).
4. **Unknown params are ignored,** not rejected — `z.object` strips unrecognised keys by default.

---

## Overview

### `GET /api/us-universities`

The console's landing payload: totals, facets, chart series, and the last successful import time. Handler [`route.ts:5-18`](../../../src/app/api/us-universities/route.ts).

**Auth:** session with `user.email` → otherwise `401 {"error":"Unauthorized"}` ([`route.ts:6-9`](../../../src/app/api/us-universities/route.ts)).

**Request:** none. The handler is declared `export async function GET()` with **zero parameters** ([`route.ts:5`](../../../src/app/api/us-universities/route.ts)), so it never sees the URL — any query string is ignored rather than validated, and no body or header is read.

**Response `200`:** `UsUniversitiesOverview` verbatim, with no wrapper key ([`route.ts:13`](../../../src/app/api/us-universities/route.ts)). Type at [`types.ts:123-135`](../../../src/lib/us-universities/types.ts); assembled by `getUsUniversitiesOverviewUncached` ([`data.ts:179-298`](../../../src/lib/us-universities/data.ts)).

| Key | Type | Notes |
|-----|------|-------|
| `dataYear` | `string` | Always `"2024-25"` at this revision. |
| `totalInstitutions` | number | `count(*)` for the year ([`data.ts:183-190`](../../../src/lib/us-universities/data.ts)). |
| `withAcceptanceRate` | number | Count of rows with a non-null `acceptance_rate`. |
| `avgAcceptanceRate` | number \| `null` | Raw SQL `avg`, **not** rounded ([`data.ts:289`](../../../src/lib/us-universities/data.ts)) — unlike `acceptanceTrend`, which is. |
| `states` | `StateFacet[]` | `{ state, count }`, descending by count; rows with a null `state_abbr` are dropped ([`data.ts:192-200`](../../../src/lib/us-universities/data.ts)). |
| `controls` | `ControlFacet[]` | `{ control, label, count }`; label from `CONTROL_LABELS`, falling back to the literal `Control <n>` for an unmapped code ([`data.ts:202-214`](../../../src/lib/us-universities/data.ts)). |
| `acceptanceBuckets` | `AcceptanceBucket[]` | Five fixed bands — Under 10%, 10–25%, 25–50%, 50–75%, 75–100% ([`data.ts:37-43`](../../../src/lib/us-universities/data.ts)). Counted **in JavaScript** over every non-null acceptance row for the year, not in SQL ([`data.ts:216-225`](../../../src/lib/us-universities/data.ts)); the top band's `max` is `100.01` so a 100% rate lands inside it. |
| `scatter` | `ScatterPoint[]` | One point per institution with a non-null `grad_rate_bach_6yr`. `cost` prefers `total_price_in_state` and falls back to `avg_net_price`, else `null` ([`data.ts:227-244`](../../../src/lib/us-universities/data.ts)). |
| `cip2Options` | `Cip2Option[]` | Distinct CIP-2 families present in that year's completions, labelled via `cip2Label` (fallback `CIP <nn>`) and sorted by label ([`data.ts:246-252`](../../../src/lib/us-universities/data.ts), [`constants.ts:134-136`](../../../src/lib/us-universities/constants.ts)). |
| `acceptanceTrend` | `AcceptanceTrendPoint[]` | `{ dataYear, avgAcceptance, n }` ascending by year, rounded to one decimal. Restricted to the **current-year cohort** via a self-subquery so every year averages the same set of schools ([`data.ts:254-276`](../../../src/lib/us-universities/data.ts)). |
| `lastImportedAt` | ISO string \| `null` | `finished_at` of the newest `success` run in `ipeds_import_runs` for the year ([`data.ts:278-283,296`](../../../src/lib/us-universities/data.ts)). |

**Side effects:** none. Eight sequential reads against `ipeds_institutions`, `ipeds_completions`, and `ipeds_import_runs` ([`data.ts:183,192,202,216,227,246,262,278`](../../../src/lib/us-universities/data.ts)), all cached under the shared tag.

**Status codes:**

| Code | Condition |
|------|-----------|
| 200 | Payload returned. A year with no imported rows is still 200, with zero totals and empty arrays. |
| 401 | No session, or a session without `user.email`. |
| 500 | Data-layer throw; body `{"error": <message>}`, default `"Failed to load overview"` ([`route.ts:14-17`](../../../src/app/api/us-universities/route.ts)). |

---

## Browsing the institution set

### `GET /api/us-universities/search`

Filtered, sorted, paged browse — the endpoint the console polls on every interaction. Handler [`search/route.ts:10-28`](../../../src/app/api/us-universities/search/route.ts).

**Auth:** session with `user.email` ([`search/route.ts:11-14`](../../../src/app/api/us-universities/search/route.ts)).

**Query:** the shared filter query above, validated by `FilterQuerySchema` ([`request.ts:12-25`](../../../src/lib/us-universities/request.ts)) at [`search/route.ts:17`](../../../src/app/api/us-universities/search/route.ts). All params are optional — a bare `GET /api/us-universities/search` returns page 1 of the whole year, 50 rows, sorted by name ascending.

**Response `200`:** `InstitutionListResult` ([`types.ts:82-87`](../../../src/lib/us-universities/types.ts)), returned unwrapped:

```
{ rows: IpedsInstitutionListItem[], total: number, page: number, pageSize: number }
```

- `total` is the **unpaged** count for the filter set ([`data.ts:118-121`](../../../src/lib/us-universities/data.ts)), so the client derives page count from it.
- `page` and `pageSize` are the **clamped** values actually used, not the requested ones ([`data.ts:116,147-152`](../../../src/lib/us-universities/data.ts)) — the way a client learns its `pageSize=1000` was reduced to 100.
- Each row is every `ipeds_institutions` column except `raw` (see [erd-core §4](../database/erd-core.md#4-us-universities--ipeds-3-tables)) plus `acceptancePrevYear` ([`types.ts:61-63`](../../../src/lib/us-universities/types.ts)): the same unit's acceptance rate in the immediately prior data year, or `null` when that year was never imported. It comes from one extra query issued only when the page is non-empty ([`data.ts:131-145`](../../../src/lib/us-universities/data.ts), prior-year derivation at [`trend.ts:22-28`](../../../src/lib/us-universities/trend.ts)).

**Side effects:** none — a count query, a page query, and the optional prior-year query.

**Status codes:**

| Code | Condition |
|------|-----------|
| 200 | Result returned; an over-large `page` yields `rows: []` with a non-zero `total`, not a 404. |
| 400 | `FilterQuerySchema` rejected the query — a non-numeric or non-positive `page`/`pageSize`, a `dir` outside `asc`/`desc`, an empty `search`/`cip2`. Body is the flattened Zod error ([`search/route.ts:18-20`](../../../src/app/api/us-universities/search/route.ts)). |
| 401 | No session, or a session without `user.email`. |
| 500 | Data-layer throw; default message `"Failed to search institutions"` ([`search/route.ts:25-27`](../../../src/app/api/us-universities/search/route.ts)). |

### `GET /api/us-universities/export`

The same filter set serialized as a CSV download rather than JSON. Handler [`export/route.ts:11-36`](../../../src/app/api/us-universities/export/route.ts).

**Auth:** session with `user.email` ([`export/route.ts:12-15`](../../../src/app/api/us-universities/export/route.ts)). Note that the console exposes this as a plain `<a href>` ([`us-universities-shell.tsx:359`](../../../src/components/us-universities/us-universities-shell.tsx)), so the browser's session cookie is what authenticates the download.

**Query:** identical parsing to `/search` — same schema, same `toFilterParams` ([`export/route.ts:17-21`](../../../src/app/api/us-universities/export/route.ts)). Two differences in how the params are *used*:

- `page` and `pageSize` are accepted and validated but **ignored**: `exportInstitutionsUncached` applies no offset and a single `limit` of `EXPORT_ROW_CAP = 5000` ([`data.ts:155-177`](../../../src/lib/us-universities/data.ts)). The export is the filter set, not the current page.
- `sort` and `dir` still apply, through the same whitelist ([`data.ts:174`](../../../src/lib/us-universities/data.ts)).

**Response `200`:** a CSV body, not JSON ([`export/route.ts:26-32`](../../../src/app/api/us-universities/export/route.ts)).

| Header | Value |
|--------|-------|
| `Content-Type` | `text/csv;charset=utf-8` |
| `Content-Disposition` | `attachment; filename="us-universities.csv"` — a fixed filename; it encodes neither the filters nor the data year. |

Body format comes from the shared serializer ([`csv.ts:37-39`](../../../src/lib/us-universities/csv.ts) → [`sales-dashboard/csv.ts:22-33`](../../../src/lib/sales-dashboard/csv.ts)): a UTF-8 BOM prefix, `\r\n` row separators, **every** field wrapped in double quotes with embedded quotes doubled, and nulls rendered as an empty string. The header row is always emitted, so a zero-row export is a valid one-line CSV.

**22 columns**, in order ([`csv.ts:8-35`](../../../src/lib/us-universities/csv.ts)): Institution, City, State, Control, Acceptance %, Yield %, SAT Reading 25th, SAT Reading 75th, SAT Math 25th, SAT Math 75th, ACT 25th, ACT 75th, Total enrollment, Undergrad enrollment, Student-faculty ratio, Retention % (FT), Grad rate 6yr %, Tuition (in-state), Tuition (out-of-state), Total price (in-state), Avg net price, Website. `Control` is written as its human label, not the code. **`unitId` is not among them**, so an exported row cannot be joined back to IPEDS by id.

**Side effects:** none.

**Status codes:**

| Code | Condition |
|------|-----------|
| 200 | CSV returned. Silently capped at 5 000 rows — nothing in the body or headers signals truncation. |
| 400 | Zod rejected the query, exactly as on `/search`. The error body is **JSON**, even though the success body is CSV ([`export/route.ts:18-21`](../../../src/app/api/us-universities/export/route.ts)). |
| 401 | No session, or a session without `user.email`. |
| 500 | Data-layer or serializer throw; JSON body, default message `"Failed to export institutions"` ([`export/route.ts:33-36`](../../../src/app/api/us-universities/export/route.ts)). |

---

## One institution

### `GET /api/us-universities/institutions/[unitId]`

The full dossier payload for a single institution. Handler [`institutions/[unitId]/route.ts:8-31`](../../../src/app/api/us-universities/institutions/[unitId]/route.ts).

**Auth:** session with `user.email` ([`:12-15`](../../../src/app/api/us-universities/institutions/[unitId]/route.ts)).

**Path parameter:** `unitId`, awaited from the Next 16 async `params` promise and validated by `z.object({ unitId: z.coerce.number().int().positive() })` ([`:6,17`](../../../src/app/api/us-universities/institutions/[unitId]/route.ts)). A non-numeric, fractional, zero, or negative segment is a 400 before any query runs. There is no query string and no body.

**Response `200`:** `InstitutionProfile` verbatim, no wrapper ([`types.ts:49-53`](../../../src/lib/us-universities/types.ts)), built by `getInstitutionProfileUncached` ([`data.ts:300-328`](../../../src/lib/us-universities/data.ts)):

| Key | Notes |
|-----|-------|
| *(spread institution row)* | The **entire** `ipeds_institutions` row for the current data year — this is the one endpoint that does **not** call `stripRaw`, so the `raw` JSONB source record ships with every response ([`data.ts:305-310,327`](../../../src/lib/us-universities/data.ts)). |
| `completions` | Every `ipeds_completions` row for that unit and year, descending by `count` — uncapped at this layer ([`data.ts:312-316`](../../../src/lib/us-universities/data.ts)); the dossier UI is what limits what is displayed. |
| `topMajors` | The top **eight** CIP-2 families by summed count, each `{ cip2, label, count }` ([`data.ts:318-323`](../../../src/lib/us-universities/data.ts)). |
| `admissionsTrend` | `AdmissionsTrendPoint[]` for that unit across **all** imported years, ascending by `dataYear` — acceptance and yield rates, applicant/admit/enrolled totals, and the four SAT/ACT percentile bands, each independently nullable ([`types.ts:27-40`](../../../src/lib/us-universities/types.ts), [`data.ts:73-98`](../../../src/lib/us-universities/data.ts), grouping at [`trend.ts:7-20`](../../../src/lib/us-universities/trend.ts)). Empty array when the unit has no rows. |

**Side effects:** none — three reads (institution, completions, cross-year trend).

**Status codes:**

| Code | Condition |
|------|-----------|
| 200 | Profile returned. |
| 400 | `unitId` is not a positive integer; body is the flattened Zod error ([`:18-20`](../../../src/app/api/us-universities/institutions/[unitId]/route.ts)). |
| 401 | No session, or a session without `user.email`. |
| 404 | No `ipeds_institutions` row for that `unitId` in the current data year — `{"error":"Institution not found"}` ([`:24-26`](../../../src/app/api/us-universities/institutions/[unitId]/route.ts)). A unit that exists only in an older imported year returns 404 here, even though its rows would still appear in another institution's trend query. |
| 500 | Data-layer throw; default message `"Failed to load institution"` ([`:28-30`](../../../src/app/api/us-universities/institutions/[unitId]/route.ts)). |

---

## Compare set

### `GET /api/us-universities/compare`

Side-by-side payload for up to four institutions. Handler [`compare/route.ts:9-37`](../../../src/app/api/us-universities/compare/route.ts).

**Auth:** session with `user.email` ([`compare/route.ts:10-13`](../../../src/app/api/us-universities/compare/route.ts)).

**Query:**

| Param | Type | Required | Notes |
|-------|------|----------|-------|
| `ids` | comma-separated integers | **yes** | Validated as `z.object({ ids: z.string().min(1) })` ([`compare/route.ts:7`](../../../src/app/api/us-universities/compare/route.ts)). The handler reads `searchParams.get("ids") ?? ""`, so a *missing* param becomes an empty string and fails `.min(1)` — a missing `ids` and an explicitly empty `ids=` produce the same flattened-Zod 400 ([`:16-19`](../../../src/app/api/us-universities/compare/route.ts)). |

Id parsing is deliberately lenient and happens **after** Zod ([`:21-25`](../../../src/app/api/us-universities/compare/route.ts)): split on `,`, trim, `Number.parseInt(…, 10)`, drop non-finite results, then `slice(0, MAX_COMPARE)` with `MAX_COMPARE = 4` ([`constants.ts:177`](../../../src/lib/us-universities/constants.ts)). Three consequences:

- **A fifth and later id is silently dropped** — no 400, no warning in the payload. This server-side cap is the backstop for the client's own cap, and it is the one branch with no test.
- `Number.parseInt` accepts a numeric prefix, so `3abc` becomes `3`.
- Zero and negative ids survive the `Number.isFinite` filter and reach the query, where they simply match nothing. This is looser than the dossier page's own parser, which additionally requires `> 0` ([`(app)/us-universities/[unitId]/page.tsx:23-29`](../../../src/app/%28app%29/us-universities/[unitId]/page.tsx)).

When every id is unparseable the handler short-circuits with `400 {"error":"No valid institution ids"}` before touching the database ([`:27-29`](../../../src/app/api/us-universities/compare/route.ts)).

**Response `200`:** `{ institutions: CompareInstitution[] }` — the one endpoint in this group with a wrapper key ([`:33`](../../../src/app/api/us-universities/compare/route.ts)). Each entry is `IpedsInstitutionSummary` (the row minus `raw`) plus ([`types.ts:55-58`](../../../src/lib/us-universities/types.ts)):

- `topMajor` — the single highest-count CIP-2 family for that unit, or `null` when it has no completions ([`data.ts:50-69`](../../../src/lib/us-universities/data.ts)).
- `admissionsTrend` — the same cross-year series as the dossier, fetched for all requested units in one query ([`data.ts:350`](../../../src/lib/us-universities/data.ts)).

**Caller order is preserved and unknown ids are silently dropped** ([`data.ts:352-361`](../../../src/lib/us-universities/data.ts)): the array can be shorter than the id list, and there is no per-id "not found" marker — the client compares lengths, or matches on `unitId`. Duplicate ids yield duplicate entries.

**Side effects:** none — three reads (institutions, completions, cross-year trend).

**Status codes:**

| Code | Condition |
|------|-----------|
| 200 | Compare set returned, possibly shorter than the id list. An id list that parses cleanly but matches no institution is still 200, with `{"institutions":[]}`. |
| 400 | `ids` missing or empty (flattened Zod error), or present but containing no parseable integer (`{"error":"No valid institution ids"}`). |
| 401 | No session, or a session without `user.email`. |
| 500 | Data-layer throw; default message `"Failed to compare institutions"` ([`:34-36`](../../../src/app/api/us-universities/compare/route.ts)). |

---

_Verified against main@0cd1e81 (clean tree) on 2026-09-02._
