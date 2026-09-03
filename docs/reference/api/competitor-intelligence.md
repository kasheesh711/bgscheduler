# Competitor Intelligence API

**Status: stable** (handbook maturity map; no `@deprecated` or status marker exists in code). Feature meaning — why the pipeline exists, the budget-cap rule, the human-promotes-a-suggestion loop — lives in [docs/features/competitor-intelligence.md](../../features/competitor-intelligence.md). Column-level detail for the 16 `competitor_*` tables lives in [docs/reference/database/erd-competitor-intelligence.md](../database/erd-competitor-intelligence.md). The cron schedule and health thresholds live in [docs/reference/crons.md](../crons.md). **This page owns the mechanics**: method, path, auth, request shape, response shape, side effects, and status codes. Group index: [docs/reference/api/index.md](./index.md).

**Authoritative source:** the eight route files under [`src/app/api/competitor-intelligence/`](../../../src/app/api/competitor-intelligence/) plus [`src/app/api/internal/sync-competitor-intelligence/route.ts`](../../../src/app/api/internal/sync-competitor-intelligence/route.ts), and the three libs they delegate to — [`access.ts`](../../../src/lib/competitor-intelligence/access.ts), [`data.ts`](../../../src/lib/competitor-intelligence/data.ts), [`sync.ts`](../../../src/lib/competitor-intelligence/sync.ts).

## Endpoint index (11)

Nine method+path endpoints under `/api/competitor-intelligence` (eight route files; `own-sources/route.ts` exports two handlers), plus the two on the internal cron route.

| Method | Path | Auth | Writes | Handler |
|--------|------|------|--------|---------|
| GET | `/api/competitor-intelligence` | admin session | none | [`route.ts:8-16`](../../../src/app/api/competitor-intelligence/route.ts) |
| POST | `/api/competitor-intelligence/sync` | admin session | the whole collection lineage — see [side effects](#side-effects-of-a-sync-run) | [`sync/route.ts:10-26`](../../../src/app/api/competitor-intelligence/sync/route.ts) |
| POST | `/api/competitor-intelligence/manual-evidence` | admin session | `competitor_evidence_items` upsert | [`manual-evidence/route.ts:17-26`](../../../src/app/api/competitor-intelligence/manual-evidence/route.ts) |
| GET | `/api/competitor-intelligence/own-sources` | admin session | none | [`own-sources/route.ts:17-25`](../../../src/app/api/competitor-intelligence/own-sources/route.ts) |
| POST | `/api/competitor-intelligence/own-sources` | admin session | `competitor_entities` upsert + `competitor_sources` upsert | [`own-sources/route.ts:27-36`](../../../src/app/api/competitor-intelligence/own-sources/route.ts) |
| PATCH | `/api/competitor-intelligence/own-sources/[sourceId]` | admin session | `competitor_sources` update (disable **or** upsert) | [`own-sources/[sourceId]/route.ts:19-31`](../../../src/app/api/competitor-intelligence/own-sources/[sourceId]/route.ts) |
| PATCH | `/api/competitor-intelligence/sources/[sourceId]` | admin session | `competitor_sources.status` update | [`sources/[sourceId]/route.ts:15-26`](../../../src/app/api/competitor-intelligence/sources/[sourceId]/route.ts) |
| POST | `/api/competitor-intelligence/task-suggestions/[suggestionId]/accept` | admin session | `competitor_tasks` insert + suggestion close + `competitor_task_events` insert | [`task-suggestions/[suggestionId]/accept/route.ts:10-19`](../../../src/app/api/competitor-intelligence/task-suggestions/[suggestionId]/accept/route.ts) |
| PATCH | `/api/competitor-intelligence/tasks/[taskId]` | admin session | `competitor_tasks` update + `competitor_task_events` insert | [`tasks/[taskId]/route.ts:19-29`](../../../src/app/api/competitor-intelligence/tasks/[taskId]/route.ts) |
| GET | `/api/internal/sync-competitor-intelligence` | `CRON_SECRET` only | same as the sync run, plus a `cron_invocations` row | [`route.ts:66-68`](../../../src/app/api/internal/sync-competitor-intelligence/route.ts) |
| POST | `/api/internal/sync-competitor-intelligence` | `CRON_SECRET` **or** admin session | same, plus a `cron_invocations` row | [`route.ts:70-72`](../../../src/app/api/internal/sync-competitor-intelligence/route.ts) |

Every one of the nine app endpoints is called by exactly one in-repo consumer, the dashboard client component [`competitor-intelligence-dashboard.tsx`](../../../src/components/competitor-intelligence/competitor-intelligence-dashboard.tsx) — **except `GET /api/competitor-intelligence/own-sources`, which has no caller at all**: the dashboard reads its own-brand list out of the `ownBrandSources` key of the main payload ([`dashboard.tsx:228,263,273,283,298,309,352-353,366`](../../../src/components/competitor-intelligence/competitor-intelligence-dashboard.tsx)). The endpoint is live and tested; it is simply unused by the UI.

---

## Conventions shared by the nine app endpoints

**Auth is one guard, not `auth()` directly.** Every handler's first line is `await requireCompetitorIntelligenceSession()` ([`access.ts:19-30`](../../../src/lib/competitor-intelligence/access.ts)). It reads the Auth.js session, lowercases/trims the email, and throws the literal string `Unauthorized` when either email or name is missing, then `Forbidden` when `hasCompetitorIntelligenceAccess(allowedPages, role)` fails. That policy denies any session whose `role` is set and is not `"admin"`, allows any session with `allowedPages === null` (full-access admin), and otherwise requires an allowed page equal to `/competitor-intelligence` or prefixed by `/competitor-intelligence/` ([`access-policy.ts:3-13`](../../../src/lib/competitor-intelligence/access-policy.ts)). The guard returns `{ email, name, role: "admin" }`; the seven mutating handlers all stamp that `email` onto the row they write or the run they start — only the two `GET`s ignore it.

**Middleware runs first.** `/api/competitor-intelligence/**` is not in the public allowlist ([`middleware.ts:10-25`](../../../src/middleware.ts)), so an unauthenticated request is redirected to `/login` before the handler runs ([`middleware.ts:90-92`](../../../src/middleware.ts)), and a restricted user whose `allowedPages` do not prefix-match gets a middleware-level `403 {"error":"Forbidden"}` ([`middleware.ts:97-99`](../../../src/middleware.ts)). The in-handler guard is therefore a second, independent check rather than the only one — and it is the *only* one on the internal cron route, which middleware treats as public.

**One error mapper, and it has no 400 branch.** Every handler's `catch` calls `competitorIntelligenceErrorResponse(error, fallback)` ([`access.ts:32-54`](../../../src/lib/competitor-intelligence/access.ts)), which:

1. rethrows anything carrying Next's `digest === "HANGING_PROMISE_REJECTION"`, so `cacheComponents` prerender signals are not swallowed ([`access.ts:33-40`](../../../src/lib/competitor-intelligence/access.ts));
2. maps the exact message `Unauthorized` → **401** and `Forbidden` → **403**;
3. otherwise `console.error`s and returns **500** with `{"error": <error.message>}`, falling back to the per-handler string for a non-`Error` throw.

Bodies are validated with a bare `Schema.parse()`, never `.safeParse()`. A `ZodError` is an `Error` whose message is neither `Unauthorized` nor `Forbidden`, so **a malformed body returns 500 carrying the serialized Zod issues, not 400** — a deliberate-looking deviation from the house four-step route convention. The same applies to a not-found row: `updateCompetitorSourceStatus` throws `Source not found`, `acceptCompetitorTaskSuggestion` throws `Task suggestion not found`, `updateCompetitorTask` throws `Task not found`, and `createManualCompetitorEvidence` throws `Competitor not found` — all surface as **500**, never 404 ([`data.ts:540,576,590,604-605,668,694`](../../../src/lib/competitor-intelligence/data.ts)).

**No caching, no revalidation.** No handler declares `"use cache"`, `revalidate`, or `dynamic`. Every request reads Postgres directly, and no mutation revalidates a cache tag — the dashboard re-`GET`s the whole payload after every write instead.

**Status codes not otherwise noted.** 200 on success (201 for `POST own-sources`), 401 for a session that fails the guard's identity check, 403 for a session that fails the page/role policy, 500 for everything else including validation. Only `POST /api/competitor-intelligence/sync` adds a 409.

**Tests.** Two route suites: [`competitor-intelligence/__tests__/route.test.ts`](../../../src/app/api/competitor-intelligence/__tests__/route.test.ts) — 2 cases, access refusal and the full War Room payload contract — and [`own-sources/__tests__/route.test.ts`](../../../src/app/api/competitor-intelligence/own-sources/__tests__/route.test.ts) — 4 cases covering GET auth, GET list, POST 201 with the actor email forwarded, and the PATCH disable branch. The other six app handlers and both internal-route handlers have **no route test**; the lib behind them is covered by six suites under [`src/lib/competitor-intelligence/__tests__/`](../../../src/lib/competitor-intelligence/__tests__/) (`access`, `ai`, `budget`, `normalization`, `sync-guard`, `war-room`).

---

## Reading the dashboard

### `GET /api/competitor-intelligence`

The dashboard's only read. Everything the page renders arrives in one response, which is why no endpoint here supports paging or filtering. Handler [`route.ts:8-16`](../../../src/app/api/competitor-intelligence/route.ts) → `getCompetitorIntelligencePayload` ([`data.ts:224-447`](../../../src/lib/competitor-intelligence/data.ts)).

**Request:** no query params, no body. Anything sent is ignored.

**Response `200`:** a `CompetitorDashboardPayload` verbatim — no wrapper key. The interface is declared at [`types.ts:124-280`](../../../src/lib/competitor-intelligence/types.ts):

| Key | Type | Notes |
|-----|------|-------|
| `checkedAt` | `string` | ISO timestamp of assembly. |
| `weeklyWarRoom` | object | Latest snapshot: `id`, `weekStart`/`weekEnd`, `lookbackStart`/`lookbackEnd`, `generatedAt`, `confidence`, `executiveSummary`, `status`, `sourceHealth`. |
| `competitorMatrix` | `CompetitorMatrixRow[]` | Per-entity attention score + its six components, cadence, channels, top theme, SEO visibility, `beGiftedGap`, `recommendedAngle`, `coverageWarnings` ([`types.ts:61-82`](../../../src/lib/competitor-intelligence/types.ts)). |
| `contentAngles` | `CompetitorContentAngle[]` | AI angles, each carrying its evidence list and the `suggestionId` that `POST …/task-suggestions/[id]/accept` takes ([`types.ts:84-102`](../../../src/lib/competitor-intelligence/types.ts)). |
| `scoreDrilldowns` | `Record<entityId, CompetitorScoreDrilldown>` | Formula string + weekly timeline with top evidence ([`types.ts:104-122`](../../../src/lib/competitor-intelligence/types.ts)). |
| `brief` | object | Latest daily brief: `whatChanged`, `whyItMatters`, `recommendedResponses`, `confidence`, `coverageScore`, `seoVisibilityScore`, `openTaskCount`, `budgetUsageRatio`, `sourceHealth`. |
| `kpis` | object | `coveragePercent`, `seoVisibilityScore`, `openTaskCount`, `budgetUsedPercent`, `highImpactMoves`, `sourceFailures`. |
| `entities` | array | Every competitor + own-brand entity with `sourceCount` and `latestItemAt`. |
| `sources` | array | Every source row joined to its entity, with `reliability`, `bestEffort`, `lastRunAt`, `lastSuccessAt`, `lastError`. |
| `recentItems` | array | Evidence items, newest `observedAt` first. |
| `serp` | array | Per-keyword rollup with `bestBeGiftedRank` / `bestCompetitorRank`. |
| `taskSuggestions` | array | Open suggestions only. |
| `tasks` | array | Response tasks, newest `updatedAt` first. |
| `runs` | array | Recent `competitor_sync_runs` with their per-source counters. |
| `usage` | array | Per month/provider/source-type vendor spend with `hardCapUsd` and `capped`. |
| `ownBrandSources` | array | BeGifted's own website/Instagram/Facebook sources — the same rows `GET …/own-sources` returns. |

**Read shape.** Twelve queries fire in one `Promise.all` ([`data.ts:225-282`](../../../src/lib/competitor-intelligence/data.ts)). Six carry hard caps, so a busy tenant gets a truncated view rather than a slow one: brief `limit(1)`, evidence items `limit(80)`, SERP observations `limit(300)`, task suggestions `limit(24)` (filtered to `status = "suggested"`), tasks `limit(50)`, sync runs `limit(12)` ([`data.ts:246,253,255,265,274,275`](../../../src/lib/competitor-intelligence/data.ts)). Entities, sources, keywords, vendor usage, and the asset counts are unbounded.

**Status codes:** 200 · 401 · 403 · 500 (fallback message `Failed to load competitor intelligence`).

---

## Running the collection pipeline

Three doors open the same function, `runCompetitorIntelligenceSync` ([`sync.ts:494-826`](../../../src/lib/competitor-intelligence/sync.ts)): the admin `POST …/sync`, the internal cron route, and the Data Health **Run now** dispatcher, which calls it in-process with `actorEmail` defaulting to `data-health@begifted.local` ([`run-job.ts:82-98`](../../../src/lib/data-health/run-job.ts)). All three return the same `{ ok, result }` envelope with the same 200/409/500 mapping.

### Side effects of a sync run

Ordered as `runCompetitorIntelligenceSync` performs them:

1. **Reap, then claim.** `failStaleRunningCompetitorSyncs` flips any `competitor_sync_runs` row still `running` past `STALE_RUNNING_COMPETITOR_SYNC_MS` (20 minutes) to `failed` with a fixed summary ([`sync.ts:40-42`](../../../src/lib/competitor-intelligence/sync.ts)); a surviving `running` row then makes the function **throw** `Competitor intelligence sync is already running` ([`sync.ts:501-509`](../../../src/lib/competitor-intelligence/sync.ts)). The guard is a plain `SELECT … WHERE status = 'running' LIMIT 1`, not a partial unique index, and it is **global** — the lineage runs one at a time, full stop. A `running` row is then inserted with the caller's `triggerType` and `actorEmail`.
2. **Seed defaults.** `seedDefaultCompetitorSources` upserts the built-in competitor entities, their sources, and the SERP keyword set ([`data.ts:61-162`](../../../src/lib/competitor-intelligence/data.ts), catalogue at [`default-sources.ts:26,186`](../../../src/lib/competitor-intelligence/default-sources.ts)). It never writes `status`, which is why a human `PATCH` on a source survives re-seeding. Counts land in the response's `seeded`.
3. **Per non-SERP source:** insert a `competitor_source_runs` child row, stamp `lastRunAt`, then either **skip on budget** — `Monthly vendor budget cap reached`, child run closed `success` with a `skippedReason`, `budgetSkippedCount` incremented ([`sync.ts:556-569`](../../../src/lib/competitor-intelligence/sync.ts)) — or fetch through Apify/HTTP, record vendor usage, upsert evidence items and assets, and close the child run with its counters. A per-source throw is caught, counted into `sourceFailedCount`, written to `competitor_sources.lastError`, and pushed onto the run's error list; **it never aborts the run** ([`sync.ts:614-626`](../../../src/lib/competitor-intelligence/sync.ts)).
4. **Per active SERP keyword:** the same child-run/budget/fetch shape against DataForSEO, storing `competitor_serp_observations` ([`sync.ts:629-694`](../../../src/lib/competitor-intelligence/sync.ts)).
5. **AI brief.** One `competitor_ai_runs` row, then either OpenAI or the deterministic fallback depending on `isCompetitorAiConfigured()` — `ENABLE_COMPETITOR_AI !== "false"` **and** a non-empty `OPENAI_API_KEY` ([`ai.ts:71`](../../../src/lib/competitor-intelligence/ai.ts)). High-confidence keyword suggestions (`>= 0.7`) and competitor suggestions are upserted, a `competitor_briefs` row is upserted on `briefDate` (Bangkok date), task suggestions are inserted, and `openTaskCount` is back-filled ([`sync.ts:696-784`](../../../src/lib/competitor-intelligence/sync.ts)).
6. **War Room snapshot** regenerated ([`sync.ts:788-801`](../../../src/lib/competitor-intelligence/sync.ts)).
7. **Finalize.** Run status is `"failed"` **if and only if** the AI-brief step or the War Room step threw; source-level failures alone still finish `success` ([`sync.ts:802`](../../../src/lib/competitor-intelligence/sync.ts)). Up to six error strings are joined into `errorSummary`. A throw escaping the outer `try` is caught and returned as a `failed` result — the function itself does not rethrow past the guard ([`sync.ts:814-825`](../../../src/lib/competitor-intelligence/sync.ts)).

Nothing here writes to Wise, and nothing writes outside `competitor_*` (plus `cron_invocations` on the internal route).

**`CompetitorSyncResult`** ([`sync.ts:57-66`](../../../src/lib/competitor-intelligence/sync.ts)) — the `result` value all three doors return:

```
{ runId, status: "success" | "failed",
  seeded: { entities, sources, keywords },
  errorSummary: string | null,
  sourceCount, sourceSuccessCount, sourceFailedCount, sourceSkippedCount,
  itemCount, newItemCount, assetCount,
  aiRunCount, taskSuggestionCount, budgetSkippedCount }
```

**Budget cap.** Each source's estimated cost is checked against a per-provider monthly hard cap before the fetch. The cap is read from `COMPETITOR_<PROVIDER>_MONTHLY_CAP_USD`, then `COMPETITOR_INTEL_MONTHLY_CAP_USD`, defaulting to `0` for `website`/`manual` and `250` USD otherwise; a cap of `0` disables the check rather than blocking everything ([`budget.ts:18-30`](../../../src/lib/competitor-intelligence/budget.ts)).

### `POST /api/competitor-intelligence/sync`

Runs the pipeline now, as `triggerType: "manual"` with the signed-in user as `actorEmail`. Handler [`sync/route.ts:10-26`](../../../src/app/api/competitor-intelligence/sync/route.ts); `export const maxDuration = 800` ([`sync/route.ts:8`](../../../src/app/api/competitor-intelligence/sync/route.ts)).

**Request:** no query params; the body is never read (the dashboard posts `{}` for form's sake).

**Response:** `{ ok: boolean, result: CompetitorSyncResult }`.

**Status codes:**

| Code | Condition |
|------|-----------|
| 200 | `result.status === "success"` ([`sync/route.ts:17-19`](../../../src/app/api/competitor-intelligence/sync/route.ts)). |
| 409 | Thrown message contains `already running` — a run is in flight and this request wrote nothing ([`sync/route.ts:21-23`](../../../src/app/api/competitor-intelligence/sync/route.ts)). |
| 401 / 403 | Guard rejection. |
| 500 | `result.status === "failed"` — note the body is still `{ ok: false, result }` with the full counters, **not** an `{error}` object. Also 500 for any other throw. |

### `GET` and `POST /api/internal/sync-competitor-intelligence`

The weekly cron door. `vercel.json` schedules `28 18 * * 0` (Mon 01:28 Bangkok) against this path, and the Data Health registry declares the same schedule with `maxDurationSeconds: 800`, `lateAfterMinutes: 120`, `routeMethod: "GET"` ([`cron-registry.ts:94-108`](../../../src/lib/data-health/cron-registry.ts)). The route itself sets `export const maxDuration = 800` ([`route.ts:7`](../../../src/app/api/internal/sync-competitor-intelligence/route.ts)). Both methods funnel into one `handleSync` ([`route.ts:20-64`](../../../src/app/api/internal/sync-competitor-intelligence/route.ts)); the only difference is the `allowSessionAuth` flag.

**Auth.** `/api/internal/*` is in the middleware public allowlist ([`middleware.ts:10-25`](../../../src/middleware.ts)), so this route enforces its own check. `hasValidCronSecret` compares the raw `authorization` header against `Bearer ${CRON_SECRET}` with a length pre-check plus `timingSafeEqual` — constant-time, an inline copy of the shared helper rather than an import ([`route.ts:11-18`](../../../src/app/api/internal/sync-competitor-intelligence/route.ts)):

| | `GET` (`allowSessionAuth: false`) | `POST` (`allowSessionAuth: true`) |
|---|---|---|
| Valid secret | runs as `triggerType: "cron"`, `triggerSource: "cron"`, `actorEmail: "cron@begifted.local"` | same |
| Invalid secret | **401** `Unauthorized` | falls back to `requireCompetitorIntelligenceSession()`; on success runs as `triggerType: "manual"`, `triggerSource: "admin"`, actor = the session email; on failure **401** |
| `CRON_SECRET` unset | **500** `Server misconfigured` | falls through to the session path (the misconfiguration is not reported) |

Because the session fallback goes through the same guard, a page-restricted user without `/competitor-intelligence` still gets 401 here even though middleware waved the request through.

**Request:** no query params, no body.

**Response:** `{ ok: boolean, result: CompetitorSyncResult }`, identical to the admin sync route; an auth rejection is `{ error: string }`.

**Status codes:** 200 success · 401 unauthorized · 409 message contains `already running` · 500 failed run, `CRON_SECRET` unset on `GET`, or any other throw ([`route.ts:26-29,52-60`](../../../src/app/api/internal/sync-competitor-intelligence/route.ts)).

**Extra side effect — the cron ledger.** Only this route wraps the work in `withCronInvocationAudit({ jobKey: "competitor_intelligence", … })` ([`route.ts:39-63`](../../../src/app/api/internal/sync-competitor-intelligence/route.ts)). A `cron_invocations` row is inserted `running` before the handler and closed after with `durationMs`, `responseStatus`, a size-capped response digest, and an `outcome` ([`cron-audit.ts:191-206`](../../../src/lib/data-health/cron-audit.ts)). Two consequences worth knowing:

- A 409 is recorded as **`skipped`**, not `failed`, because `determineOutcome` matches `already running` in the body before it looks at the status code ([`cron-audit.ts:108-111`](../../../src/lib/data-health/cron-audit.ts)). A failed run (`ok: false`) is recorded `failed`.
- `linkedRunIds` comes out **empty** for this job: the extractor looks for `result.syncRunId` or `result.id`, while `CompetitorSyncResult` names the field `runId` ([`cron-audit.ts:44-46`](../../../src/lib/data-health/cron-audit.ts), [`sync.ts:57-58`](../../../src/lib/competitor-intelligence/sync.ts)). Correlating an invocation to its `competitor_sync_runs` row has to go through timestamps.
- Auth rejections return **before** the wrapper, so an unauthorized call leaves no `cron_invocations` row at all ([`route.ts:24-37`](../../../src/app/api/internal/sync-competitor-intelligence/route.ts)).

---

## Managing sources

### `PATCH /api/competitor-intelligence/sources/[sourceId]`

The human override on any source — competitor or own-brand. This is the one write the weekly re-seed cannot undo, because `seedDefaultCompetitorSources` never sets `status`. Handler [`sources/[sourceId]/route.ts:15-26`](../../../src/app/api/competitor-intelligence/sources/[sourceId]/route.ts).

**Path param:** `sourceId` — `competitor_sources.id`. Not validated as a UUID; a malformed id reaches Postgres.

**Body** — `PatchSchema` at [`sources/[sourceId]/route.ts:9-11`](../../../src/app/api/competitor-intelligence/sources/[sourceId]/route.ts):

| Field | Type | Required |
|-------|------|----------|
| `status` | `"active"` \| `"disabled"` \| `"needs_review"` \| `"archived"` | **yes** |

**Response `200`:** `{ source }` — the full updated `competitor_sources` row as returned by Drizzle.

**Side effects:** one `UPDATE` setting `status`, `updatedByEmail` (the acting user), and `updatedAt` ([`data.ts:580-592`](../../../src/lib/competitor-intelligence/data.ts)). No audit row — unlike tasks, source status changes leave only the `updatedByEmail` stamp.

**Status codes:** 200 · 401 · 403 · 500 (Zod failure, or `Source not found` when the id matches nothing).

### `GET /api/competitor-intelligence/own-sources`

Lists BeGifted's own tracked sources. Handler [`own-sources/route.ts:17-25`](../../../src/app/api/competitor-intelligence/own-sources/route.ts) → `listOwnBrandSources` ([`data.ts:478-502`](../../../src/lib/competitor-intelligence/data.ts)).

**Request:** none.

**Response `200`:** `{ sources: [...] }` — sources joined to entities where `entity.kind = "own_brand"`, ordered by `sourceType` then `label`, and **filtered in JS to the three own-brand types** `website` / `instagram` / `facebook`, so a `serp`, `sitemap`, or `manual` row attached to the own-brand entity is silently omitted ([`data.ts:488`](../../../src/lib/competitor-intelligence/data.ts)). Per row: `id`, `entityId`, `sourceType`, `label`, `url`, `handle`, `provider`, `priority`, `status`, `lastSuccessAt`, `lastError` (truncated to 220 chars).

**Status codes:** 200 · 401 · 403 · 500.

### `POST /api/competitor-intelligence/own-sources`

Adds an own-brand source. Handler [`own-sources/route.ts:27-36`](../../../src/app/api/competitor-intelligence/own-sources/route.ts).

**Body** — `OwnSourceSchema` at [`own-sources/route.ts:9-15`](../../../src/app/api/competitor-intelligence/own-sources/route.ts):

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `sourceType` | `"website"` \| `"instagram"` \| `"facebook"` | **yes** | |
| `label` | string, trimmed, 1–120 | **yes** | |
| `url` | string, trimmed, must parse as a URL | **yes** | |
| `handle` | string ≤ 120, nullable | no | |
| `status` | `"active"` \| `"disabled"` \| `"needs_review"` \| `"archived"` | no | defaults to `"active"` |

**Response `201`:** `{ source }` — the inserted/updated row ([`own-sources/route.ts:32`](../../../src/app/api/competitor-intelligence/own-sources/route.ts)).

**Side effects** ([`upsertOwnBrandSource`, `data.ts:504-558`](../../../src/lib/competitor-intelligence/data.ts)):

1. `ensureOwnBrandEntity` upserts the `begifted` entity on its `slug` — display name `BeGifted`, `kind: "own_brand"`, baseline category tags — creating it if this is the first own-brand source, then bumps its `updatedAt` ([`data.ts:449-476`](../../../src/lib/competitor-intelligence/data.ts)). The `actorEmail` is accepted but deliberately unused here (`void actorEmail`).
2. Inserts the source with a derived `provider`, fixed `priority: 100`, and `bestEffort`/`reliability` derived from the type (everything except `website` is best-effort), `onConflictDoUpdate` against the `(entityId, sourceType, url)` unique target — so re-posting the same URL edits rather than duplicates.

**Status codes:** 201 · 401 · 403 · 500 (Zod failure included).

### `PATCH /api/competitor-intelligence/own-sources/[sourceId]`

Edits or disables one own-brand source. Handler [`own-sources/[sourceId]/route.ts:19-31`](../../../src/app/api/competitor-intelligence/own-sources/[sourceId]/route.ts).

**Path param:** `sourceId`.

**Body** — `PatchOwnSourceSchema` at [`own-sources/[sourceId]/route.ts:9-15`](../../../src/app/api/competitor-intelligence/own-sources/[sourceId]/route.ts) — **byte-identical to `OwnSourceSchema`**, so this PATCH is a full replacement, not a partial one: `sourceType`, `label`, and `url` are all required even when the caller only wants to flip the status. The dashboard duly re-sends the whole row when disabling ([`dashboard.tsx:364-377`](../../../src/components/competitor-intelligence/competitor-intelligence-dashboard.tsx)).

**Two branches** ([`own-sources/[sourceId]/route.ts:24-26`](../../../src/app/api/competitor-intelligence/own-sources/[sourceId]/route.ts)):

- `status === "disabled"` → `disableOwnBrandSource`, which first re-reads the row joined to its entity and throws `Own-brand source not found` unless it belongs to an `own_brand` entity, then delegates to the shared status update ([`data.ts:560-578`](../../../src/lib/competitor-intelligence/data.ts)). The other body fields are discarded on this path.
- anything else → `upsertOwnBrandSource({ ...input, id: sourceId })`, whose `UPDATE` is scoped to `id = sourceId AND entityId = <begifted>` and throws `Own-brand source not found` when it matches nothing ([`data.ts:531-542`](../../../src/lib/competitor-intelligence/data.ts)). A competitor-owned source id therefore cannot be hijacked through this route.

**Response `200`:** `{ source }`.

**Status codes:** 200 · 401 · 403 · 500 (Zod failure, or `Own-brand source not found`).

---

## Filing evidence by hand

### `POST /api/competitor-intelligence/manual-evidence`

Records a signal a human saw — a flyer, a LINE broadcast, a price quoted in conversation — as an evidence item on a competitor, scored and classified by the same rules as scraped items. Handler [`manual-evidence/route.ts:17-26`](../../../src/app/api/competitor-intelligence/manual-evidence/route.ts).

**Body** — `ManualEvidenceSchema` at [`manual-evidence/route.ts:9-15`](../../../src/app/api/competitor-intelligence/manual-evidence/route.ts):

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `entityId` | UUID | **yes** | Must exist in `competitor_entities`, else 500 `Competitor not found`. |
| `title` | string, trimmed, 2–180 | **yes** | |
| `contentText` | string, trimmed, 2–5000 | **yes** | |
| `canonicalUrl` | URL string, nullable | no | Participates in the dedupe key. |
| `pricingSignal` | boolean | no | Defaults to `category === "pricing_offer"`. |

**Response `200`:** `{ evidence }` — the inserted or updated `competitor_evidence_items` row.

**Side effects** ([`createManualCompetitorEvidence`, `data.ts:678-745`](../../../src/lib/competitor-intelligence/data.ts)): the entity is loaded and verified; `${title}\n${contentText}` is run through `classifyMarketCategory` and `scoreImpact`; language is set to `th` when the text contains any Thai codepoint, else `en`; `confidence` is fixed at `0.7`, `evidenceStatus` at `"manual"`, `reviewStatus` at `"new"`, `channel` at `"manual"`, `sourceId`/`sourceRunId` at `null`, and `raw` records the acting `actorEmail`. The row is upserted on the derived `itemKey`, so re-filing the same text against the same competitor **edits the existing item rather than creating a duplicate**. No vendor call, no cost, no source run.

**Status codes:** 200 · 401 · 403 · 500 (Zod failure or `Competitor not found`).

---

## The human loop: suggestions and tasks

### `POST /api/competitor-intelligence/task-suggestions/[suggestionId]/accept`

Promotes an AI suggestion into a tracked task. Suggestions are never auto-executed; this endpoint is the only path from suggestion to task. Handler [`task-suggestions/[suggestionId]/accept/route.ts:10-19`](../../../src/app/api/competitor-intelligence/task-suggestions/[suggestionId]/accept/route.ts).

**Path param:** `suggestionId`. **Request body:** ignored entirely — the handler's first argument is `_request` and is never read.

**Response `200`:** `{ task }` — the newly created `competitor_tasks` row.

**Side effects** ([`acceptCompetitorTaskSuggestion`, `data.ts:594-640`](../../../src/lib/competitor-intelligence/data.ts)), in order:

1. Load the suggestion; throw `Task suggestion not found` if absent.
2. Throw `Task suggestion is not open` unless `status === "suggested"` — accepting twice fails rather than creating a second task ([`data.ts:605`](../../../src/lib/competitor-intelligence/data.ts)).
3. Insert a `competitor_tasks` row copying the suggestion's `itemId`, `briefId`, `title`, `description`, `priority`, `dueDate`, `labels`, and `suggestedOwnerEmail` → `ownerEmail`, stamping the actor as both creator and updater.
4. In parallel: mark the suggestion `accepted` with `acceptedTaskId` / `acceptedAt` / `acceptedByEmail`, and insert a `competitor_task_events` row of type `created_from_suggestion` carrying `{ suggestionId }`.

Steps 3 and 4 are not in one transaction — the Neon HTTP driver has none here — so an interrupted call can in principle leave a task whose suggestion is still `suggested`.

**Status codes:** 200 · 401 · 403 · 500 (`Task suggestion not found` or `Task suggestion is not open`).

### `PATCH /api/competitor-intelligence/tasks/[taskId]`

Edits a response task in place. Handler [`tasks/[taskId]/route.ts:19-29`](../../../src/app/api/competitor-intelligence/tasks/[taskId]/route.ts).

**Path param:** `taskId`.

**Body** — `PatchSchema` at [`tasks/[taskId]/route.ts:9-15`](../../../src/app/api/competitor-intelligence/tasks/[taskId]/route.ts); every field is optional, and only the keys actually present are written:

| Field | Type | Notes |
|-------|------|-------|
| `status` | `"todo"` \| `"in_progress"` \| `"blocked"` \| `"done"` \| `"ignored"` | |
| `ownerEmail` | email string, nullable | |
| `priority` | `"low"` \| `"medium"` \| `"high"` | |
| `dueDate` | `YYYY-MM-DD` (regex `^\d{4}-\d{2}-\d{2}$`), nullable | Shape only — `2026-13-45` passes. |
| `labels` | array of trimmed strings 1–40 chars, max 8 entries | Replaces the whole array. |

An empty body `{}` is valid and still performs a write (stamping `updatedByEmail`/`updatedAt`) and still appends an event.

**Response `200`:** `{ task }` — the updated row.

**Side effects** ([`updateCompetitorTask`, `data.ts:642-676`](../../../src/lib/competitor-intelligence/data.ts)): the `SET` clause is built with `"key" in input` guards so an absent field is left untouched and an explicit `null` is written as `null`. `completedAt` is derived, not client-settable — `new Date()` when `status === "done"`, `null` for any other explicit status, and untouched when the patch carries no `status` ([`data.ts:654`](../../../src/lib/competitor-intelligence/data.ts)). Every successful patch then appends a `competitor_task_events` row of type `updated` whose `payload` is the parsed input verbatim, so **the audit trail is a side effect no caller can opt out of** ([`data.ts:669-675`](../../../src/lib/competitor-intelligence/data.ts)).

**Status codes:** 200 · 401 · 403 · 500 (Zod failure or `Task not found`).

---

_Verified against main@0cd1e81 (clean tree) on 2026-09-02._
