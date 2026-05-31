# Codebase Structure

**Analysis Date:** 2026-06-01

BGScheduler began as a tutor availability search tool and has grown into **BeGifted Ops** — an internal operations platform (`src/app/layout.tsx:16-17`, brand string in `src/components/layout/app-nav.tsx:68`). The codebase now spans 15 feature domains: AI scheduler, classroom assignment, credit control, leave requests, LINE integration, payroll, proposals/holds, room capacity, sales dashboard, tutor profiles, Wise activity audit, plus the original search/compare core. Authoritative scale: **78 database tables, 110 HTTP endpoint handlers across 96 `route.ts` files, 7 Vercel crons, 14 user-facing pages, 132 test files.**

## Directory Layout

```
Scheduling/
├── src/
│   ├── app/                          # Next.js 16 App Router
│   │   ├── (app)/                    # Authenticated route group (shared AppNav layout)
│   │   │   ├── search/               # Search + compare workspace (page.tsx + loading.tsx)
│   │   │   ├── scheduler/            # AI scheduler workspace
│   │   │   │   ├── page.tsx
│   │   │   │   └── metrics/page.tsx  # AI scheduler eval/metrics dashboard
│   │   │   ├── compare/page.tsx      # Client redirect to /search (back-compat)
│   │   │   ├── line-review/page.tsx  # LINE AI message review workspace
│   │   │   ├── leave-requests/page.tsx
│   │   │   ├── tutor-profiles/page.tsx
│   │   │   ├── class-assignments/page.tsx
│   │   │   ├── room-capacity/page.tsx
│   │   │   ├── sales-dashboard/page.tsx
│   │   │   ├── credit-control/page.tsx
│   │   │   ├── payroll/page.tsx
│   │   │   ├── wise-activity/page.tsx   # "Wise Audit"
│   │   │   ├── data-health/page.tsx
│   │   │   └── layout.tsx            # AppNav + StaleSnapshotBanner + <main> wrapper
│   │   ├── api/                      # 96 route.ts files / 110 method handlers
│   │   │   ├── auth/[...nextauth]/route.ts
│   │   │   ├── search/              # route.ts, range/, assistant/ (AI scheduler, public)
│   │   │   ├── compare/            # route.ts, discover/
│   │   │   ├── filters/route.ts
│   │   │   ├── tutors/route.ts
│   │   │   ├── tutor-profiles/      # CRUD + import-preview/import-commit
│   │   │   ├── proposals/          # holds: route.ts, active/, items/[itemId]/
│   │   │   ├── ai-scheduler/        # conversations/, messages/.../feedback, metrics/
│   │   │   ├── line/               # webhook/, contacts/, messages/, scheduler-reviews/, students/
│   │   │   ├── leave-requests/      # route.ts, sync/, [requestId]/, wise-cancel-preview/
│   │   │   ├── class-assignments/   # run/, runs/[runId]/{rows,publish,schedule-email,teacher-schedule}
│   │   │   ├── classrooms/         # rooms/, floor-plan-map/ (public)
│   │   │   ├── room-capacity/       # utilization/, month/, forecast/
│   │   │   ├── sales-dashboard/     # import/, sources/, projection-*/
│   │   │   ├── credit-control/      # route.ts, sync/, actions/, inactive/, admin-ownership/
│   │   │   ├── payroll/            # route.ts, sync/, review/, adjustments/
│   │   │   ├── wise-activity/       # route.ts, summary/, sync/, reconciliation/
│   │   │   ├── data-health/        # route.ts + modality-counter.ts helper
│   │   │   ├── admin/sync-wise/route.ts        # admin-triggered sync
│   │   │   └── internal/           # cron-only endpoints (CRON_SECRET, public in middleware)
│   │   │       ├── sync-wise/route.ts          # 30-min Wise snapshot sync (maxDuration=800)
│   │   │       ├── sync-wise-activity/route.ts
│   │   │       ├── sync-sales-dashboard/route.ts
│   │   │       ├── sync-credit-control/route.ts
│   │   │       ├── sync-leave-requests/route.ts
│   │   │       ├── sync-room-utilization/route.ts (no cron entry; manual/script)
│   │   │       └── class-assignments/{morning,admin-email}/route.ts
│   │   ├── login/page.tsx            # Google sign-in (no AppNav)
│   │   ├── layout.tsx                # Root layout (Inter + JetBrains Mono fonts, "BeGifted Ops")
│   │   ├── page.tsx                  # redirect("/search")
│   │   └── globals.css               # Tailwind 4 + shadcn theme + semantic color tokens
│   ├── components/                   # React components organized by feature
│   │   ├── ui/                       # shadcn/ui primitives (13: badge, button, card, command,
│   │   │                             #   dialog, input, input-group, popover, select, separator,
│   │   │                             #   table, tabs, textarea)
│   │   ├── layout/                   # app-nav.tsx, stale-snapshot-banner.tsx
│   │   ├── search/                   # search-workspace + form/results/recommend + AI panel + holds
│   │   ├── compare/                  # week-overview, calendar-grid, density-overview, combobox, ...
│   │   ├── scheduler/                # scheduler-workspace, metrics-view, scheduler-compare-focus
│   │   ├── line-review/             # line-review-workspace + mapping/resolution/oa-resolver panels
│   │   ├── leave-requests/          # leave-requests-workspace
│   │   ├── tutor-profiles/          # tutor-profiles-workspace
│   │   ├── class-assignments/       # workspace + timeline/floor-plan/heatmap visualizations
│   │   ├── room-capacity/           # room-capacity-dashboard
│   │   ├── sales-dashboard/         # gm-command-center, shell, source-manager
│   │   ├── credit-control/          # dashboard-shell + queue/calendar/filter/bulk panels
│   │   ├── payroll/                 # payroll-dashboard
│   │   ├── wise-activity/           # wise-activity-workspace
│   │   └── skeletons/               # calendar/form/search loading skeletons
│   ├── hooks/                        # use-compare, use-keyboard-shortcuts, use-resizable-split, use-theme
│   ├── lib/                          # Shared library code (see Directory Purposes)
│   │   ├── ai/                       # AI scheduler (OpenAI extraction + constraint solver + metrics)
│   │   ├── auth/                     # __tests__ only (signin-callback.test.ts)
│   │   ├── classrooms/               # room assignment engine, floor plan, schedule email
│   │   ├── credit-control/           # credit/package sync, follow-up actions, analytics
│   │   ├── data/                     # cached server-only fetchers + active-snapshot helper
│   │   ├── db/                       # Drizzle schema (78 tables, 20 enums) + Neon client + seed
│   │   ├── internal/                 # cron-auth.ts (CRON_SECRET timing-safe check)
│   │   ├── leave-requests/           # leave-request parser/matching/sync
│   │   ├── line/                     # LINE webhook, classifier, OA resolver, link validation
│   │   ├── normalization/            # Wise → canonical (identity, availability, leaves, ...)
│   │   ├── ops/                      # stale.ts (staleness thresholds + banner copy)
│   │   ├── payroll/                  # payroll domain, rate cards, reconciliation, sync
│   │   ├── proposals/                # tutor hold/proposal overlap + persistence
│   │   ├── room-capacity/            # utilization analysis, forecast, package mix
│   │   ├── sales-dashboard/          # sheet parser, analytics, projections, GM insights
│   │   ├── scheduler/                # admin-colors (scheduler UI helper)
│   │   ├── search/                   # in-memory index + search/compare/range engines + parser
│   │   ├── sync/                     # ETL orchestrator + sync guard + snapshot pruning
│   │   ├── ui/                       # z-index.ts, view-transitions.ts
│   │   ├── wise/                     # Wise API client, fetchers, operations, types
│   │   ├── wise-activity/            # activity event sync, format, reconciliation
│   │   ├── auth.ts                   # NextAuth (Node) config + admin allowlist signIn callback
│   │   ├── auth-edge.ts              # Edge-safe auth for middleware
│   │   ├── bangkok-time.ts           # Asia/Bangkok date helpers (shared)
│   │   ├── env.ts                    # Zod-validated env vars
│   │   ├── tutor-business-profiles.ts / tutor-profile-import.ts / tutor-profile-vocabulary.ts
│   │   └── utils.ts                  # cn() class-merging helper
│   ├── types/credit-control.ts       # shared cross-layer types
│   ├── tests/integration/            # integration harness (db-helper.ts + README)
│   ├── __tests__/                    # middleware.test.ts, vercel-crons.test.ts
│   └── middleware.ts                 # Edge auth gate + public-route allowlist
├── drizzle/                          # 35 generated migrations (0000–0037) + meta/
├── scripts/                          # tsx/node operational scripts (seed, eval, import, cleanup)
├── docs/                             # Human + agent documentation (see below)
│   ├── handbook/                     # architecture, conventions, data-flow, glossary
│   ├── features/                     # 14 per-feature meaning docs
│   ├── reference/                    # api/, database/, crons.md, env.md (mechanical detail)
│   ├── operations/                   # auth-and-access, observability, runbook
│   └── superpowers/                  # vendored skill docs (do not edit)
├── public/                           # Static assets
├── .planning/                        # GSD workflow artifacts (this document lives in codebase/)
├── .claude/                          # Claude Code config
├── AGENTS.md                         # Primary agent instructions
├── CLAUDE.md                         # Includes AGENTS.md plus stack/conventions (synced — do not hand-edit)
├── package.json                      # npm scripts + deps (Next 16, React 19, Drizzle, chart.js, ...)
├── tsconfig.json                     # Strict mode, ES2017, bundler resolution, @/* → ./src/*
├── next.config.ts                    # Default config (no overrides)
├── eslint.config.mjs                 # Flat config (next/core-web-vitals + typescript)
├── postcss.config.mjs                # @tailwindcss/postcss only
├── drizzle.config.ts                 # PostgreSQL dialect, schema → ./src/lib/db/schema.ts
├── vitest.config.ts                  # Two projects: unit (node) + integration (forks, serial)
├── vercel.json                       # 7 cron schedules
└── components.json                   # shadcn/ui config (base-nova style, lucide icons, rsc)
```

## Directory Purposes

**`src/app/`:**
- Purpose: Next.js 16 App Router — pages, layouts, API routes
- Contains: Server Components by default; client components opt in via `"use client"`
- Key files: `layout.tsx` (root, fonts, "BeGifted Ops" title), `(app)/layout.tsx` (AppNav + stale banner), `middleware.ts` (auth gate, sibling at `src/`)

**`src/app/(app)/`:**
- Purpose: Route group for authenticated admin pages sharing the `AppNav` layout
- Contains: 13 feature page directories (`search`, `scheduler` + `scheduler/metrics`, `line-review`, `leave-requests`, `tutor-profiles`, `class-assignments`, `room-capacity`, `sales-dashboard`, `credit-control`, `payroll`, `wise-activity`, `data-health`) plus a back-compat `compare` redirect and shared `layout.tsx`
- Notes: Parentheses in `(app)` mean route group only — no URL segment. The `compare/page.tsx` stub redirects to `/search`.

**`src/app/api/`:**
- Purpose: HTTP endpoints exposed by Next.js App Router (110 method handlers across 96 `route.ts` files; method mix: 46 GET, 48 POST, 12 PATCH, 4 DELETE)
- Contains: `route.ts` files implementing GET/POST/PATCH/DELETE handlers, organized by feature
- Co-located: `__tests__/` next to many routes, plus helper modules (e.g. `data-health/modality-counter.ts`)
- Canonical signatures: `docs/reference/api/` (feature docs link there rather than restating)

**`src/app/api/internal/`:**
- Purpose: Cron-triggered, machine-only endpoints; bypass session auth via the `/api/internal/` prefix allowlist in `middleware.ts:13` and instead require `CRON_SECRET`
- Contains: `sync-wise`, `sync-wise-activity`, `sync-sales-dashboard`, `sync-credit-control`, `sync-leave-requests`, `sync-room-utilization`, and `class-assignments/{morning,admin-email}`
- Auth: constant-time CRON_SECRET check (`src/lib/internal/cron-auth.ts`; `sync-wise` inlines the same check)

**`src/components/ui/`:**
- Purpose: Reusable design-system primitives wrapping `@base-ui/react`
- Contains: 13 generic widgets (badge, button, card, command, dialog, input, input-group, popover, select, separator, table, tabs, textarea)
- Source of truth: `components.json` declares `@/components/ui`; `style: "base-nova"`, `iconLibrary: "lucide"`, `rsc: true`
- Used by: All feature component directories

**`src/components/{feature}/`:**
- Purpose: Feature-scoped components, mostly `"use client"`
- 14 feature directories: `compare`, `search`, `scheduler`, `line-review`, `leave-requests`, `tutor-profiles`, `class-assignments`, `room-capacity`, `sales-dashboard`, `credit-control`, `payroll`, `wise-activity`, `layout`, `skeletons`
- Each feature page mounts a top-level `*-workspace.tsx` / `*-dashboard.tsx` / `*-shell.tsx` composition root

**`src/hooks/`:**
- Purpose: Reusable React hooks
- Contains: `use-compare.ts` (compare state, tutor cache, AbortController), `use-keyboard-shortcuts.ts`, `use-resizable-split.ts`, `use-theme.ts`
- Maps to: `@/hooks` alias in `components.json`

**`src/lib/`:**
- Purpose: Shared business logic and platform integrations
- Contains: 20 domain subdirectories plus loose root modules (`auth.ts`, `auth-edge.ts`, `env.ts`, `bangkok-time.ts`, `utils.ts`, the three `tutor-profile*`/`tutor-business-profiles` files)
- Maps to: `@/lib` alias in `components.json`

**`src/lib/ai/`:**
- Purpose: AI scheduler — OpenAI-backed conversational slot finder over the search index
- Contains: `scheduler.ts` (config/date helpers), `scheduler-conversation.ts` (OpenAI extraction + constraint solver), `scheduler-service.ts` (orchestration, versioned `AI_SCHEDULER_VERSION`), `scheduler-data.ts`, `scheduler-metrics.ts`, `correction-telemetry.ts`, `academic-levels.ts`, `tutor-profile-signals.ts`
- Maps to the spine "ai-scheduler" module; powers `/api/search/assistant` and `/api/ai-scheduler/*`

**`src/lib/auth/`:**
- Purpose: Auth helper test home (spine "auth-helpers"). The directory itself holds only `__tests__/signin-callback.test.ts`; the implementation lives in root `src/lib/auth.ts` (Node, full NextAuth + admin allowlist) and `src/lib/auth-edge.ts` (edge-safe config consumed by `middleware.ts`)

**`src/lib/classrooms/`:**
- Purpose: Local classroom/room assignment engine and publishing
- Contains: `assignment-engine.ts`, `rooms.ts`, `floor-plan.ts` / `floor-plan-map.ts`, `reconciliation.ts`, `schedule-email.ts` / `admin-schedule-email.ts`, `morning-automation.ts`, `tutor-contacts.ts`, `session-mode.ts`, `visualization.ts`, `data.ts`

**`src/lib/credit-control/`:**
- Purpose: Credit/package balance tracking and follow-up workflow
- Contains: `sync.ts`, `wise.ts`, `api.ts`, `actions.ts` + `action-helpers.ts`, `analytics.ts`, `projection.ts`, `packages.ts`, `domain.ts`, `service.ts`, `config.ts`, `db.ts`, `helpers.ts`, `ui-helpers.ts`, `admin-ownership-seed.ts`, `run-sync-request.ts`

**`src/lib/data/`:**
- Purpose: Server-only cached fetchers (`"use cache"` + cache tags) + active-snapshot lookup
- Contains: `filters.ts`, `tutors.ts`, `past-sessions.ts`, `active-snapshot.ts` (`getActiveSnapshotIdOrThrow`)
- Used by: Server Components and API routes

**`src/lib/db/`:**
- Purpose: Postgres connection and schema definition
- Contains: `index.ts` (Neon serverless + Drizzle `getDb()` singleton), `schema.ts` (78 tables + 20 enums), `seed.ts` (aliases + admin emails)
- Generated: `drizzle/` migrations are generated FROM `schema.ts`. Canonical column reference: `docs/reference/database/`. (Note: `schema.ts` is a do-not-edit path for this documentation pass.)

**`src/lib/internal/`:**
- Purpose: Shared internals for cron endpoints
- Contains: `cron-auth.ts` — `getCronSecretStatus` / `rejectInvalidCronSecret` with `timingSafeEqual`

**`src/lib/leave-requests/`:**
- Purpose: Tutor leave-request intake and Wise session matching
- Contains: `parser.ts`, `matching.ts`, `sync.ts`, `data.ts`, `config.ts`
- Note: `src/lib/leave-requests/**` is in-flight source — documented but not edited.

**`src/lib/line/`:**
- Purpose: LINE OA integration — inbound webhook capture, AI classification, contact/student resolution
- Contains: `webhook.ts`, `signature.ts`, `client.ts`, `classifier.ts`, `confidence.ts`, `oa-resolver.ts`, `link-validation.ts`, `student-links.ts`, `contact-aliases.ts`, `operational.ts`, `review-service.ts`, `data.ts`, `test-data-cleanup.ts`

**`src/lib/normalization/`:**
- Purpose: Pure transformation functions (Wise data → canonical internal)
- Contains: `identity.ts`, `availability.ts`, `leaves.ts`, `sessions.ts`, `qualifications.ts`, `modality.ts`, `timezone.ts`
- Tests: Co-located `__tests__/` (one per module)

**`src/lib/ops/`:**
- Purpose: Operational thresholds shared by API + UI
- Contains: `stale.ts` — `API_STALE_THRESHOLD_MS` (90 min), `APP_STALE_BANNER_THRESHOLD_MS` (2 h), banner copy, `isApiSnapshotStale` / `shouldShowStaleBanner`

**`src/lib/payroll/`:**
- Purpose: Teacher payroll computation, rate cards, reconciliation
- Contains: `domain.ts`, `rate-card.ts`, `sync.ts`, `data.ts`, `may-reconciliation.ts`, `types.ts`

**`src/lib/proposals/`:**
- Purpose: Tutor "holds"/proposals — soft reservations with overlap detection
- Contains: `overlap.ts` (`ACTIVE_PROPOSAL_STATUSES`, interval overlap), `data.ts` (`listActiveProposalHolds`), `types.ts`

**`src/lib/room-capacity/`:**
- Purpose: Room utilization analysis and capacity forecasting
- Contains: `utilization.ts`, `analysis.ts`, `forecast.ts`, `package-mix.ts`, `dates.ts` (Bangkok date math reused by payroll), `data.ts`, `types.ts`

**`src/lib/sales-dashboard/`:**
- Purpose: Sales spreadsheet ingestion, normalization, projections, GM analytics
- Contains: `parser.ts`, `analytics.ts`, `projection.ts`, `lifecycle.ts`, `gm-insights.ts`, `import-guard.ts`, `sheets.ts`, `google-oauth.ts`, `program-map.ts`, `default-sources.ts`, `dates.ts`, `data.ts`, `types.ts`

**`src/lib/scheduler/`:**
- Purpose: Scheduler-UI helpers (distinct from `src/lib/ai/`)
- Contains: `admin-colors.ts` (per-admin color assignment)

**`src/lib/search/`:**
- Purpose: In-memory index and query engines (the original product core)
- Contains: `index.ts` (singleton + `buildIndex`/`ensureIndex`, loads tutor business profiles too), `engine.ts` (`executeSearch`), `compare.ts` (build/conflicts/free-slots + `detectSessionModalityConflict`), `range-search.ts`, `parser.ts`, `recommend.ts`, `types.ts`, `cache-version.ts`

**`src/lib/sync/`:**
- Purpose: Wise snapshot ETL pipeline + concurrency guard
- Contains: `orchestrator.ts` (`runFullSync`), `run-wise-sync.ts` (single-flight guard, fails `running` rows after 20 min, `revalidateTag("snapshot")` on success), `past-sessions-diff-hook.ts`, `snapshot-pruning.ts`
- Triggered by: `src/app/api/internal/sync-wise/route.ts` (and `admin/sync-wise`)

**`src/lib/ui/`:**
- Purpose: UI constants shared across components
- Contains: `z-index.ts`, `view-transitions.ts`

**`src/lib/wise/`:**
- Purpose: External Wise API integration
- Contains: `client.ts` (retry/backoff/concurrency HTTP client + `createWiseClient`), `fetchers.ts` (domain fetchers), `operations.ts` (writeback: locations, availability check, session-location PUT), `types.ts` (response shapes + accessor helpers)
- No internal dependencies beyond env

**`src/lib/wise-activity/`:**
- Purpose: Read-only Wise audit-event ingestion and reconciliation
- Contains: `sync.ts`, `format.ts`, `reconciliation.ts`, `data.ts`

**`drizzle/`:**
- Purpose: Generated database migrations + schema snapshots
- Contains: 35 `*.sql` files (`0000_*` … `0037_*`, with gaps) plus `meta/` (Drizzle journal + per-migration JSON snapshots)
- Generated: `npm run db:generate` writes here; `npm run db:migrate` applies. Committed: Yes.

**`scripts/`:**
- Purpose: One-off / scheduled operational scripts run via `tsx` or `node`
- Contains: seeds (`seed-credit-control-admin-ownership.ts`, `seed-tutor-business-profiles.ts`), AI scheduler evals (`evaluate-ai-scheduler*.ts`, `compare-ai-scheduler-models.ts`, `replay-ai-scheduler-runs.ts`), `import-room-capacity-model.ts`, `sync-room-utilization.ts`, `delete-line-test-data.ts`, `check-sales-dashboard-scope.mjs`
- Wired to npm scripts (see `package.json`)

**`docs/`:**
- Purpose: Human + agent documentation, organized by the canonical-home convention
- `handbook/` — orientation prose (architecture, conventions, data-flow, glossary, the Next.js-16 warning)
- `features/` — 14 per-feature "meaning" docs (purpose, rules, flows)
- `reference/` — mechanical detail: `api/`, `database/`, `crons.md`, `env.md`
- `operations/` — `auth-and-access.md`, `observability.md`, `runbook.md`
- `superpowers/` — vendored skill docs (do not edit)
- AI scheduler audit/eval markdown + JSON live at `docs/` root (read-only for this pass)

**`.planning/`:**
- Purpose: GSD workflow artifacts (this directory's grandparent owns plans/milestones/debug/etc.)
- Contains `codebase/` (this map), plus phase/milestone/quick/debug/report/research subdirs. Committed: Yes.

**`public/`:** Static assets served at site root. Next.js default. Committed: Yes.

## Key File Locations

**Entry Points:**
- `src/app/page.tsx`: Root redirect to `/search`
- `src/app/(app)/search/page.tsx`: Original search + compare workspace
- `src/app/(app)/scheduler/page.tsx`: AI scheduler workspace (gated on `isAiSchedulerConfigured()`)
- `src/app/api/internal/sync-wise/route.ts`: Cron + admin Wise snapshot sync (`maxDuration = 800`)
- `src/middleware.ts`: Edge auth gate (via `auth-edge`) for every non-public request

**Configuration:**
- `tsconfig.json`: TypeScript strict mode, `@/*` alias → `./src/*`
- `next.config.ts`: Default Next.js config (no overrides)
- `vercel.json`: 7 crons — Wise sync `*/30`, sales-dashboard `10,40`, credit-control `20,50`, Wise activity `5,35`, leave-requests `15,45`, class-assignments morning `45 23`, class-assignments admin-email `0,10,20,30 0`. Canonical: `docs/reference/crons.md`.
- `drizzle.config.ts`: Schema path + migrations output (PostgreSQL)
- `vitest.config.ts`: Two named projects — `unit` (node env) and `integration` (forks, serial, 60 s timeouts); `@` alias
- `eslint.config.mjs`: Flat config with Next.js presets
- `postcss.config.mjs`: Tailwind 4 plugin only
- `components.json`: shadcn/ui registry config (`base-nova`, rsc, lucide)
- `package.json`: Scripts (`dev`, `build`, `lint`, `typecheck`, `test`/`test:integration`/`test:all`/`test:coverage`, `db:generate`/`db:migrate`/`db:seed`, plus feature seed/eval/import scripts)

**Core Logic:**
- `src/lib/sync/orchestrator.ts`: Full Wise ETL pipeline (`runFullSync`)
- `src/lib/sync/run-wise-sync.ts`: Single-flight sync guard + cache revalidation
- `src/lib/search/index.ts`: In-memory index singleton + builders
- `src/lib/search/engine.ts`: Search execution
- `src/lib/search/compare.ts`: Compare engine (build/conflicts/free-slots)
- `src/lib/ai/scheduler-service.ts`: AI scheduler orchestration
- `src/lib/db/schema.ts`: All 78 table + 20 enum definitions
- `src/lib/wise/client.ts`: Wise API HTTP client; `src/lib/wise/operations.ts`: writeback ops
- `src/lib/auth.ts` / `src/lib/auth-edge.ts`: NextAuth (Node) + edge config
- `src/lib/env.ts`: Zod env validation
- `src/lib/internal/cron-auth.ts`: CRON_SECRET verification

**Frontend Composition Roots (one per feature):**
- `src/components/search/search-workspace.tsx`, `src/components/compare/compare-panel.tsx`, `src/components/compare/week-overview.tsx`
- `src/components/scheduler/scheduler-workspace.tsx`, `src/components/line-review/line-review-workspace.tsx`
- `src/components/credit-control/dashboard-shell.tsx`, `src/components/sales-dashboard/sales-dashboard-shell.tsx`
- `src/components/payroll/payroll-dashboard.tsx`, `src/components/room-capacity/room-capacity-dashboard.tsx`
- `src/components/class-assignments/class-assignments-workspace.tsx`, `src/components/wise-activity/wise-activity-workspace.tsx`
- `src/components/leave-requests/leave-requests-workspace.tsx`, `src/components/tutor-profiles/tutor-profiles-workspace.tsx`
- `src/hooks/use-compare.ts`: Compare state hook

**Testing (132 test files):**
- Co-located `__tests__/` next to nearly every `src/lib/<domain>/` module and many API routes
- Top-level: `src/__tests__/middleware.test.ts`, `src/__tests__/vercel-crons.test.ts` (asserts the cron registry)
- Integration suite: `*.integration.test.ts` (e.g. `src/lib/sync/__tests__/orchestrator.integration.test.ts`, `snapshot-pruning.integration.test.ts`) run by the `integration` project against a real DB via `src/tests/integration/db-helper.ts`

## Naming Conventions

**Files:**
- All source files: kebab-case (`session-colors.ts`, `week-overview.tsx`, `app-nav.tsx`, `run-wise-sync.ts`)
- React components: `.tsx`; logic/types/helpers: `.ts`
- Tests: `{module}.test.ts(x)` in co-located `__tests__/`; integration tests: `{module}.integration.test.ts`
- Schema definition: `schema.ts` (singular); type definition modules: `types.ts` (per feature)
- Feature composition roots: `{feature}-workspace.tsx`, `{feature}-dashboard.tsx`, or `{feature}-shell.tsx`

**Directories:**
- All lowercase (`compare`, `search`, `normalization`, `sync`, `data-health`, `line-review`)
- Route groups in parentheses: `(app)` (Next.js convention; not part of URL)
- Dynamic route segments in brackets: `[...nextauth]`, `[runId]`, `[conversationId]`, `[canonicalKey]`
- Test directories: `__tests__/`

**Components (PascalCase exports):**
- `SearchWorkspace`, `ComparePanel`, `WeekOverview`, `SchedulerWorkspace`, `AppNav`, `CreditControlShell`-style roots
- Page components export `default`: `export default function SchedulerPage()`

**Functions (camelCase):**
- Generic: `executeSearch`, `buildCompareTutor`, `detectConflicts`, `normalizeWorkingHours`, `runFullSync`
- Getters: `getDb()`, `getEnv()`, `getActiveSnapshotIdOrThrow()`, `getWiseTeacherDisplayName()`
- Booleans: `isBlockingStatus()`, `isOnlineVariant()`, `isApiSnapshotStale()`, `isAiSchedulerConfigured()`
- Factories: `createWiseClient()`, `createDb()`
- Transforms: `parseTimeToMinutes()`, `normalizeLeaves()`, `normalizeTag()`
- Fetches: `fetchAllTeachers()`, `fetchAllFutureSessions()`

**Constants (UPPER_SNAKE_CASE):**
- `TUTOR_COLORS`, `HOUR_HEIGHT`, `START_HOUR`, `END_HOUR`, `TIMEZONE`, `INSERT_CHUNK_SIZE`, `CACHE_VERSION`, `Z_INDEX`, `API_STALE_THRESHOLD_MS`, `STALE_RUNNING_SYNC_MS`, `AI_SCHEDULER_VERSION`, `ACTIVE_PROPOSAL_STATUSES`

**Types:**
- Interfaces (PascalCase): `SearchRequest`, `CompareTutor`, `IndexedTutorGroup`, `WiseClientConfig`, `SyncResult`
- External API types prefixed `Wise`: `WiseTeacher`, `WiseSession`, `WiseActivityEvent`
- In-memory index types prefixed `Indexed`: `IndexedTutorGroup`, `IndexedSessionBlock`, `IndexedAvailabilityWindow`
- Pipeline output types prefixed `Normalized`
- Type aliases for unions: `type SearchMode = "recurring" | "one_time"`, `type CronSecretStatus`

**Database:**
- Table/column names: `snake_case` (`tutor_identity_groups`, `snapshot_id`, `payroll_payout_invoices`)
- Drizzle schema object names: `camelCase` (`tutorIdentityGroups`, `snapshotId`)
- Enums via `pgEnum` (20 of them; e.g. `modality`, `sync_status`, `payroll_review_status`, `line_scheduler_review_status`)

**Path aliases:**
- `@/*` → `./src/*` (in `tsconfig.json` and `vitest.config.ts`)
- shadcn registry aliases (`components.json`): `@/components`, `@/components/ui`, `@/lib`, `@/lib/utils`, `@/hooks`

## Where to Add New Code

**New API endpoint:**
- Implementation: `src/app/api/{feature}/route.ts` (nest segments/`[param]` dirs as needed)
- Pattern to follow: `src/app/api/compare/route.ts` — `auth()` first → JSON parse in try/catch → Zod `.safeParse()` → business logic in try/catch → `NextResponse.json`
- For cron-only work, place under `src/app/api/internal/` and guard with `rejectInvalidCronSecret` (`src/lib/internal/cron-auth.ts`); the `/api/internal/` prefix is already allowlisted in `middleware.ts`
- For server-fetched data, prefer a cached function in `src/lib/data/{feature}.ts` (`"use cache"` + cache tag) over inline DB queries
- Document the signature in `docs/reference/api/`

**New UI page:**
- Authenticated route: `src/app/(app)/{route}/page.tsx`, and add the link to the right group in `src/components/layout/app-nav.tsx` (`SCHEDULING_ITEMS` dropdown vs. top-level `NAV_ITEMS`)
- Public route: `src/app/{route}/page.tsx` (and update the `middleware.ts` allowlist if it must skip auth)
- Loading state: `loading.tsx` sibling; skeleton in `src/components/skeletons/`
- Composition root: `src/components/{feature}/{feature}-workspace.tsx`

**New React component:**
- Generic primitive: `src/components/ui/{name}.tsx` (use shadcn CLI; wraps `@base-ui/react`)
- Feature component: `src/components/{feature}/{name}.tsx`
- Always: kebab-case filename, `"use client"` if interactive, props interface above component, helpers above component

**New normalizer:**
- Implementation: `src/lib/normalization/{domain}.ts`; test: `src/lib/normalization/__tests__/{domain}.test.ts`
- Wire into the orchestrator: `src/lib/sync/orchestrator.ts` (between fetch and persist steps)

**New database table:**
- Schema: append to `src/lib/db/schema.ts` via `pgTable(...)` (add `snapshotId` FK if snapshot-scoped)
- Generate + apply: `npm run db:generate` → `DATABASE_URL=... npm run db:migrate`
- If query-hot, load it in parallel inside `buildIndex()` (`src/lib/search/index.ts`)
- Update `docs/reference/database/`

**New Wise API call:**
- Add fetcher: `src/lib/wise/fetchers.ts`; writeback op: `src/lib/wise/operations.ts`; response type: `src/lib/wise/types.ts`
- Test: `src/lib/wise/__tests__/`
- Wire into the relevant sync (`src/lib/sync/orchestrator.ts`, `src/lib/wise-activity/sync.ts`, etc.)

**New feature domain (the common case now):**
- Library logic: `src/lib/{feature}/` with co-located `__tests__/`
- API: `src/app/api/{feature}/`; cron (if any): `src/app/api/internal/sync-{feature}/route.ts` + a `vercel.json` cron entry (and update `src/__tests__/vercel-crons.test.ts`)
- UI: `src/app/(app)/{feature}/page.tsx` + `src/components/{feature}/`
- Meaning doc in `docs/features/{feature}.md`, mechanical detail in `docs/reference/`

**New utility / constant:**
- General helper: `src/lib/utils.ts` (currently `cn()`); Bangkok date math: reuse `src/lib/bangkok-time.ts` or `src/lib/room-capacity/dates.ts`
- UI constant: `src/lib/ui/{name}.ts`; operational threshold: `src/lib/ops/stale.ts`

**New test:**
- Co-located in `__tests__/` next to the module; unit tests `*.test.ts(x)`, DB-backed tests `*.integration.test.ts`
- Run: `npm test` (unit) or `npm run test:integration`

## Special Directories

**`drizzle/`:**
- Purpose: Generated SQL migrations and metadata (35 `*.sql` + `meta/`)
- Generated: Yes — by `drizzle-kit generate` from `src/lib/db/schema.ts`. Committed: Yes. Manual edits discouraged.

**`drizzle/meta/`:** Drizzle journal + per-migration schema snapshots (JSON). Generated, committed.

**`scripts/`:** Operational `tsx`/`node` scripts (not part of the app bundle). Committed.

**`__tests__/` (many locations):** Co-located Vitest test files. Committed.

**`src/tests/integration/`:** Integration harness — `db-helper.ts` + README; consumed by the `integration` Vitest project. Committed.

**`docs/superpowers/`:** Vendored skill documentation — do not edit.

**`.planning/`:** GSD workflow planning artifacts. Partially agent-generated, committed.

**`.next/` (not in tree):** Next.js build output. Generated, gitignored.

**`node_modules/` (not in tree):** npm dependencies. Generated, gitignored.

**`public/`:** Static assets served at site root. Committed.

---

_Verified against HEAD + uncommitted WIP on 2026-05-31._
