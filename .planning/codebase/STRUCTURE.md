# Codebase Structure

**Analysis Date:** 2026-06-05

BGScheduler began as a tutor availability search tool and has grown into **BeGifted Ops** — an internal operations platform (brand string `src/components/layout/app-nav.tsx:118`; root metadata in `src/app/layout.tsx`). The codebase now spans ~17 feature domains: tutor search/compare, AI scheduler, LINE integration, classroom assignment, leave requests, tutor profiles, room capacity, proposals/holds, progress tests, student promotions, sales dashboard, credit control, payroll, Wise activity audit, and a unified data-health/cron-health console. Navigation is organized into four sections (Scheduling & Tutors, Student Lifecycle, Finance & Revenue, Data & Audit) fronted by a home hub. Authoritative scale: **90 database tables, 130 HTTP endpoints across 111 `route.ts` files (+ the Auth.js catch-all), 10 Vercel crons, 17 user-facing pages, 162 test files.**

## Directory Layout

```
Scheduling/
├── src/
│   ├── app/                          # Next.js 16 App Router
│   │   ├── (app)/                    # Authenticated route group (shared AppNav layout)
│   │   │   ├── page.tsx              # Home hub (HomeHub) — section landing + action badges
│   │   │   ├── search/               # Search + compare workspace (page.tsx + loading.tsx)
│   │   │   ├── scheduler/            # AI scheduler workspace
│   │   │   │   ├── page.tsx
│   │   │   │   └── metrics/page.tsx  # AI scheduler eval/metrics dashboard
│   │   │   ├── line-review/page.tsx  # LINE AI message review workspace
│   │   │   ├── leave-requests/page.tsx
│   │   │   ├── tutor-profiles/page.tsx
│   │   │   ├── class-assignments/page.tsx
│   │   │   ├── room-capacity/page.tsx
│   │   │   ├── progress-tests/page.tsx     # Student Lifecycle
│   │   │   ├── student-promotions/page.tsx # Student Lifecycle
│   │   │   ├── sales-dashboard/page.tsx
│   │   │   ├── credit-control/page.tsx
│   │   │   ├── payroll/page.tsx
│   │   │   ├── wise-activity/page.tsx   # "Wise Audit"
│   │   │   ├── data-health/page.tsx     # sync + cron-health console
│   │   │   ├── compare/page.tsx         # client redirect to /search (back-compat, not in nav)
│   │   │   └── layout.tsx            # AppNav (Suspense + access) + StaleSnapshotBanner + <main>
│   │   ├── api/                      # 111 route.ts files / 130 endpoints (+ Auth catch-all)
│   │   │   ├── auth/[...nextauth]/route.ts  # re-exports { GET, POST } = handlers
│   │   │   ├── home/summary/route.ts        # nav badge + freshness payload (access-gated)
│   │   │   ├── search/              # route.ts, range/, assistant/ (public NL assistant)
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
│   │   │   ├── progress-tests/      # route.ts, book/, mark-complete/, resend-email/,
│   │   │   │                        #   select-at-home/, mark-at-home-submitted/
│   │   │   ├── student-promotions/  # runs/, runs/[runId]/{route,apply,verify}
│   │   │   ├── sales-dashboard/     # import/, import-runs/, sources/, projection-*/
│   │   │   ├── credit-control/      # route.ts, sync/, actions/, inactive/, admin-ownership/
│   │   │   ├── payroll/            # route.ts, sync/, review/, adjustments/
│   │   │   ├── wise-activity/       # route.ts, summary/, sync/, reconciliation/(+ backfill)
│   │   │   ├── data-health/        # route.ts + jobs/[jobKey]/run/ (manual cron trigger)
│   │   │   ├── admin/sync-wise/route.ts        # admin-triggered sync
│   │   │   └── internal/           # cron-only endpoints (CRON_SECRET, public in middleware)
│   │   │       ├── sync-wise/route.ts          # 30-min Wise snapshot sync (maxDuration=800)
│   │   │       ├── sync-wise-activity/route.ts
│   │   │       ├── sync-sales-dashboard/route.ts
│   │   │       ├── sync-credit-control/route.ts
│   │   │       ├── sync-progress-tests/route.ts
│   │   │       ├── sync-leave-requests/route.ts
│   │   │       ├── sync-room-utilization/route.ts (no cron entry; manual/script)
│   │   │       ├── progress-tests/admin-digest/route.ts   # daily 00:35 BKK digest
│   │   │       ├── student-promotions/july-1/route.ts     # one-shot 30-Jun cron
│   │   │       └── class-assignments/{morning,admin-email}/route.ts
│   │   ├── login/page.tsx            # Google sign-in (no AppNav, public)
│   │   ├── layout.tsx                # Root layout (Inter + JetBrains Mono fonts, "BeGifted Ops")
│   │   ├── globals.css               # Tailwind 4 + shadcn theme + semantic color tokens
│   │   └── credit-control.css        # Credit-control-specific styles
│   ├── components/                   # React components organized by feature
│   │   ├── ui/                       # shadcn/ui primitives (13: badge, button, card, command,
│   │   │                             #   dialog, input, input-group, popover, select, separator,
│   │   │                             #   table, tabs, textarea)
│   │   ├── layout/                   # app-nav.tsx, stale-snapshot-banner.tsx
│   │   ├── home/                     # home-hub.tsx (section grid + action cards)
│   │   ├── search/                   # search-workspace + form/results/recommend + AI panel + holds
│   │   ├── compare/                  # week-overview, calendar-grid, density-overview, combobox, ...
│   │   ├── scheduler/                # scheduler-workspace, metrics-view, scheduler-compare-focus
│   │   ├── line-review/             # line-review-workspace + mapping/resolution/oa-resolver panels
│   │   ├── leave-requests/          # leave-requests-workspace
│   │   ├── tutor-profiles/          # tutor-profiles-workspace
│   │   ├── class-assignments/       # workspace + timeline/floor-plan/heatmap visualizations
│   │   ├── room-capacity/           # room-capacity-dashboard
│   │   ├── progress-tests/          # progress-tests-dashboard
│   │   ├── student-promotions/      # student-promotions-workspace
│   │   ├── sales-dashboard/         # gm-command-center, shell, source-manager
│   │   ├── credit-control/          # dashboard-shell + queue/calendar/filter/bulk panels
│   │   ├── payroll/                 # payroll-dashboard
│   │   ├── wise-activity/           # wise-activity-workspace
│   │   ├── data-health/             # data-health-dashboard
│   │   └── skeletons/               # calendar/form/search loading skeletons
│   ├── hooks/                        # use-compare, use-keyboard-shortcuts, use-resizable-split, use-theme
│   ├── lib/                          # Shared library code (see Directory Purposes)
│   │   ├── ai/                       # AI scheduler (OpenAI extraction + constraint solver + metrics)
│   │   ├── auth/                     # __tests__ only (signin-callback.test.ts)
│   │   ├── classrooms/               # room assignment engine, floor plan, schedule email
│   │   ├── credit-control/           # credit/package sync, follow-up actions, analytics
│   │   ├── data/                     # cached server-only fetchers + active-snapshot helper
│   │   ├── data-health/              # cron registry + status engine + dashboard + manual job runner
│   │   ├── db/                       # Drizzle schema (90 tables) + Neon client + seed
│   │   ├── home/                     # summary.ts — home-hub + nav-badge aggregation payload
│   │   ├── internal/                 # cron-auth.ts (CRON_SECRET timing-safe check)
│   │   ├── leave-requests/           # leave-request parser/matching/sync
│   │   ├── line/                     # LINE webhook, classifier, OA resolver, link validation
│   │   ├── navigation/               # tools.ts — nav sections/tools, access filtering, shortcuts
│   │   ├── normalization/            # Wise → canonical (identity, availability, leaves, ...)
│   │   ├── ops/                      # stale.ts (staleness thresholds + banner copy)
│   │   ├── payroll/                  # payroll domain, rate cards, reconciliation, sync
│   │   ├── progress-tests/           # 8-class cycle engine, booking, teacher heads-up, digest
│   │   ├── proposals/                # tutor hold/proposal overlap + persistence
│   │   ├── room-capacity/            # utilization analysis, forecast, package mix
│   │   ├── sales-dashboard/          # sheet parser, analytics, projections, GM insights
│   │   ├── scheduler/                # admin-colors (scheduler UI helper)
│   │   ├── search/                   # in-memory index + search/compare/range engines + parser
│   │   ├── student-promotions/       # July grade/course promotion rules + audited run/apply
│   │   ├── sync/                     # ETL orchestrator + sync guard + snapshot pruning
│   │   ├── ui/                       # z-index.ts, view-transitions.ts
│   │   ├── wise/                     # Wise API client, fetchers, operations, types
│   │   ├── wise-activity/            # activity event sync, format, reconciliation
│   │   ├── auth.ts                   # NextAuth (Node) config + handlers (do-not-edit path)
│   │   ├── auth-access.ts            # resolveUserAccess — admin/teacher role + allowedPages
│   │   ├── auth-edge.ts              # Edge-safe auth for middleware
│   │   ├── bangkok-time.ts           # Asia/Bangkok date helpers (shared)
│   │   ├── env.ts                    # Zod-validated env vars
│   │   ├── tutor-business-profiles.ts / tutor-profile-import.ts / tutor-profile-vocabulary.ts
│   │   └── utils.ts                  # cn() class-merging helper
│   ├── types/                        # credit-control.ts (shared), next-auth.d.ts (session augmentation)
│   ├── tests/integration/            # integration harness (db-helper.ts + README)
│   ├── __tests__/                    # middleware.test.ts, vercel-crons.test.ts
│   └── middleware.ts                 # Edge auth gate + public allowlist + page-level access control
├── drizzle/                          # 40 generated migrations (0000–0040) + meta/
├── scripts/                          # tsx/node operational + release-guard scripts
├── docs/                             # Human + agent documentation (see below)
│   ├── handbook/                     # architecture, conventions, data-flow, glossary
│   ├── features/                     # per-feature meaning docs
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
├── next.config.ts                    # cacheComponents: true (only custom setting)
├── eslint.config.mjs                 # Flat config (next/core-web-vitals + typescript)
├── postcss.config.mjs                # @tailwindcss/postcss only
├── drizzle.config.ts                 # PostgreSQL dialect, schema → ./src/lib/db/schema.ts
├── vitest.config.ts                  # Two projects: unit (node) + integration (forks, serial)
├── vercel.json                       # 10 cron schedules
└── components.json                   # shadcn/ui config (base-nova style, lucide icons, rsc)
```

## Directory Purposes

**`src/app/`:**
- Purpose: Next.js 16 App Router — pages, layouts, API routes
- Contains: Server Components by default; client components opt in via `"use client"`
- Key files: `layout.tsx` (root, fonts, "BeGifted Ops" title), `(app)/layout.tsx` (AppNav + stale banner), `middleware.ts` (auth gate + page-level access control, sibling at `src/`)

**`src/app/(app)/`:**
- Purpose: Route group for authenticated pages sharing the `AppNav` layout
- Contains: a home hub at `(app)/page.tsx`, 15 feature page directories surfaced in nav (`search`, `scheduler` + `scheduler/metrics`, `line-review`, `leave-requests`, `tutor-profiles`, `class-assignments`, `room-capacity`, `progress-tests`, `student-promotions`, `sales-dashboard`, `credit-control`, `payroll`, `wise-activity`, `data-health`), plus a back-compat `compare` redirect and shared `layout.tsx`
- Notes: Parentheses in `(app)` mean route group only — no URL segment. `(app)/page.tsx` is the home hub; it redirects single-page-access users (e.g. teachers) straight to their one allowed page. `compare/page.tsx` redirects to `/search` and is not listed in nav.

**`src/app/api/`:**
- Purpose: HTTP endpoints exposed by Next.js App Router. **130 endpoints** across 111 `route.ts` files (**54 GET + 60 POST + 12 PATCH + 4 DELETE**; the Auth.js catch-all counts as its GET/POST, CORS `OPTIONS` preflight handlers excluded).
- Contains: `route.ts` files implementing GET/POST/PATCH/DELETE handlers, organized by feature
- Co-located: `__tests__/` next to many routes
- Canonical signatures: `docs/reference/api/` (feature docs link there rather than restating)

**`src/app/api/internal/`:**
- Purpose: Cron-triggered, machine-only endpoints; bypass session auth via the `/api/internal/` prefix allowlist in `middleware.ts` and instead require `CRON_SECRET`
- Contains: `sync-wise`, `sync-wise-activity`, `sync-sales-dashboard`, `sync-credit-control`, `sync-progress-tests`, `sync-leave-requests`, `sync-room-utilization`, `progress-tests/admin-digest`, `student-promotions/july-1`, and `class-assignments/{morning,admin-email}`
- Auth: constant-time CRON_SECRET check (`src/lib/internal/cron-auth.ts`; `sync-wise` inlines the same check). Most internal routes export both `GET` (cron path) and `POST` (manual/admin path).

**`src/components/ui/`:**
- Purpose: Reusable design-system primitives wrapping `@base-ui/react`
- Contains: 13 generic widgets (badge, button, card, command, dialog, input, input-group, popover, select, separator, table, tabs, textarea)
- Source of truth: `components.json` declares `@/components/ui`; `style: "base-nova"`, `iconLibrary: "lucide"`, `rsc: true`
- Used by: All feature component directories

**`src/components/{feature}/`:**
- Purpose: Feature-scoped components, mostly `"use client"`
- 19 feature directories: `home`, `search`, `compare`, `scheduler`, `line-review`, `leave-requests`, `tutor-profiles`, `class-assignments`, `room-capacity`, `progress-tests`, `student-promotions`, `sales-dashboard`, `credit-control`, `payroll`, `wise-activity`, `data-health`, `layout`, `skeletons`
- Each feature page mounts a top-level `*-workspace.tsx` / `*-dashboard.tsx` / `*-shell.tsx` / `*-hub.tsx` composition root

**`src/hooks/`:**
- Purpose: Reusable React hooks
- Contains: `use-compare.ts` (compare state, tutor cache, AbortController), `use-keyboard-shortcuts.ts`, `use-resizable-split.ts`, `use-theme.ts`
- Maps to: `@/hooks` alias in `components.json`

**`src/lib/`:**
- Purpose: Shared business logic and platform integrations
- Contains: 26 domain subdirectories plus loose root modules (`auth.ts`, `auth-access.ts`, `auth-edge.ts`, `env.ts`, `bangkok-time.ts`, `utils.ts`, the three `tutor-profile*`/`tutor-business-profiles` files)
- Maps to: `@/lib` alias in `components.json`

**`src/lib/ai/`:**
- Purpose: AI scheduler — OpenAI-backed conversational slot finder over the search index
- Contains: `scheduler.ts` (config/date helpers), `scheduler-conversation.ts` (OpenAI extraction + constraint solver), `scheduler-service.ts` (orchestration, versioned `AI_SCHEDULER_VERSION`), `scheduler-data.ts`, `scheduler-metrics.ts`, `correction-telemetry.ts`, `academic-levels.ts`, `tutor-profile-signals.ts`
- Powers `/api/search/assistant` and `/api/ai-scheduler/*`

**`src/lib/auth/`:**
- Purpose: Auth helper test home. The directory itself holds only `__tests__/signin-callback.test.ts`; the implementation lives in root `src/lib/auth.ts` (Node, full NextAuth + `handlers` export), `src/lib/auth-access.ts` (role + page-access resolution), and `src/lib/auth-edge.ts` (edge-safe config consumed by `middleware.ts`)

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

**`src/lib/data-health/`:**
- Purpose: Unified sync + cron-health observability and the manual job-runner backing the Data Health page
- Contains: `cron-registry.ts` (`CRON_JOBS` — the canonical 11-job registry of cadence/late-thresholds/maxDuration/danger flags, including manual-only `room_utilization`), `status.ts` (`evaluateCronJobStatus` healthy/late/failing/running), `dashboard.ts` (`getDataHealthDashboardPayload` joining every `*_sync_runs`/`cron_invocations` table), `run-job.ts` (`runDataHealthJob` — admin-triggered cron execution), `cron-audit.ts` (`withCronInvocationAudit`), `types.ts`
- Consumed by: `/api/data-health`, `/api/data-health/jobs/[jobKey]/run`, and `src/lib/home/summary.ts`

**`src/lib/db/`:**
- Purpose: Postgres connection and schema definition
- Contains: `index.ts` (Neon serverless + Drizzle `getDb()` singleton; `pg` node-postgres used where transactions are required), `schema.ts` (90 tables + Postgres enums), `seed.ts` (aliases + admin emails)
- Generated: `drizzle/` migrations are generated FROM `schema.ts`. Canonical column reference: `docs/reference/database/`. (`schema.ts` is a do-not-edit path for this documentation pass.)

**`src/lib/home/`:**
- Purpose: Home-hub + nav-badge data aggregation
- Contains: `summary.ts` — `getHomeSummaryPayload`, which fans out to credit-control, payroll, leave-requests, progress-tests, Wise reconciliation, data-health freshness, and Google-token status to produce per-tool action counts and an overall freshness headline (each branch fail-soft to `status: "error"`)
- Consumed by: `(app)/page.tsx`, `/api/home/summary`, and `AppNav` badges

**`src/lib/internal/`:**
- Purpose: Shared internals for cron endpoints
- Contains: `cron-auth.ts` — `getCronSecretStatus` / `rejectInvalidCronSecret` with `timingSafeEqual`

**`src/lib/leave-requests/`:**
- Purpose: Tutor leave-request intake and Wise session matching
- Contains: `parser.ts`, `matching.ts`, `sync.ts`, `data.ts`, `config.ts`
- Note: `src/lib/leave-requests/**` is a do-not-edit path for this pass — documented but not modified.

**`src/lib/line/`:**
- Purpose: LINE OA integration — inbound webhook capture, AI classification, contact/student resolution
- Contains: `webhook.ts`, `signature.ts`, `client.ts`, `classifier.ts`, `confidence.ts`, `oa-resolver.ts`, `link-validation.ts`, `student-links.ts`, `contact-aliases.ts`, `operational.ts`, `review-service.ts`, `data.ts`, `test-data-cleanup.ts`

**`src/lib/navigation/`:**
- Purpose: Single source of truth for the top-nav information architecture
- Contains: `tools.ts` — `NAV_SECTIONS` (4 sections), `NAV_TOOLS` (15 tools with `href`/`section`/`badgeKey`/`shortcut`), and the access helpers `canAccessHref` / `filterToolsByAccess` / `visibleSections` / `shortcutTools` / `activeSection` consumed by `AppNav` and the home hub

**`src/lib/normalization/`:**
- Purpose: Pure transformation functions (Wise data → canonical internal)
- Contains: `identity.ts`, `availability.ts`, `leaves.ts`, `sessions.ts`, `qualifications.ts`, `modality.ts`, `timezone.ts`
- Tests: Co-located `__tests__/` (one per module)

**`src/lib/ops/`:**
- Purpose: Operational thresholds shared by API + UI
- Contains: `stale.ts` — `isApiSnapshotStale` / `shouldShowStaleBanner`, staleness thresholds, banner copy

**`src/lib/payroll/`:**
- Purpose: Teacher payroll computation, rate cards, reconciliation
- Contains: `domain.ts`, `rate-card.ts`, `sync.ts`, `data.ts`, `may-reconciliation.ts`, `types.ts`

**`src/lib/progress-tests/`:**
- Purpose: Every-8-classes progress-test tracker — counts each enrollment's position in its 8-class cycle, books/marks tests, alerts teachers, and recommends schedule-aware slots
- Contains: `engine.ts` (pure counting engine, no DB/Next imports; counting window starts 2026-03-01 BKK), `db.ts` (ledger + cycle-state queries, chunked inserts under the Postgres param limit), `sync.ts` (Wise ledger sync), `service.ts` (dashboard payload + action wrappers), `booking.ts`, `teacher-heads-up.ts`, `teacher-access.ts` (`resolveTeacherCanonicalKeys` — backs teacher-scoped read-only sign-in), `recommend.ts`, `ai-summary.ts`, `admin-digest.ts`, `parent-message.ts`, `line.ts`, `run-sync-request.ts`, `config.ts`, `api.ts`, `types.ts`

**`src/lib/proposals/`:**
- Purpose: Tutor "holds"/proposals — soft reservations with overlap detection
- Contains: `overlap.ts` (`ACTIVE_PROPOSAL_STATUSES`, interval overlap), `data.ts` (`listActiveProposalHolds`), `types.ts`

**`src/lib/room-capacity/`:**
- Purpose: Room utilization analysis and capacity forecasting
- Contains: `utilization.ts` (`syncRoomUtilizationSessions`), `analysis.ts`, `forecast.ts`, `package-mix.ts`, `dates.ts` (Bangkok date math reused by payroll/home/progress-tests), `data.ts`, `types.ts`

**`src/lib/sales-dashboard/`:**
- Purpose: Sales spreadsheet ingestion, normalization, projections, GM analytics
- Contains: `parser.ts`, `analytics.ts`, `projection.ts`, `lifecycle.ts`, `gm-insights.ts`, `import-guard.ts`, `sheets.ts`, `google-oauth.ts`, `program-map.ts`, `default-sources.ts`, `dates.ts`, `data.ts`, `types.ts`

**`src/lib/scheduler/`:**
- Purpose: Scheduler-UI helpers (distinct from `src/lib/ai/`)
- Contains: `admin-colors.ts` (per-admin color assignment)

**`src/lib/search/`:**
- Purpose: In-memory index and query engines (the original product core)
- Contains: `index.ts` (singleton + `buildIndex`/`ensureIndex`, loads tutor business profiles too), `engine.ts` (`executeSearch`), `compare.ts` (build/conflicts/free-slots + `detectSessionModalityConflict`), `range-search.ts`, `parser.ts`, `recommend.ts`, `types.ts`, `cache-version.ts`

**`src/lib/student-promotions/`:**
- Purpose: One-time July student grade/course promotion — audited dry-run → review → apply against Wise
- Contains: `rules.ts` (`STUDENT_PROMOTION_TARGET_DATE` 2026-07-01, grade-transition + course-subject mapping, registration-field IDs), `data.ts` (Wise fetch/update wrappers + run/grade-action/course-action persistence), `api.ts`
- Consumed by: `/api/student-promotions/*` and the `july-1` internal cron

**`src/lib/sync/`:**
- Purpose: Wise snapshot ETL pipeline + concurrency guard
- Contains: `orchestrator.ts` (`runFullSync`), `run-wise-sync.ts` (single-flight guard, fails abandoned `running` rows after a timeout, `revalidateTag("snapshot")` on success), `past-sessions-diff-hook.ts`, `snapshot-pruning.ts`
- Triggered by: `src/app/api/internal/sync-wise/route.ts` (and `admin/sync-wise`)

**`src/lib/ui/`:**
- Purpose: UI constants shared across components
- Contains: `z-index.ts`, `view-transitions.ts`

**`src/lib/wise/`:**
- Purpose: External Wise API integration
- Contains: `client.ts` (retry/backoff/concurrency HTTP client + `createWiseClient`/`WiseClient`), `fetchers.ts` (domain fetchers — teachers, availability, sessions, locations, analytics, activity, plus student-promotion course/participant/registration fetch+update), `operations.ts` (writeback: locations, availability check, session-location PUT), `types.ts` (response shapes + accessor helpers)
- No internal dependencies beyond env

**`src/lib/wise-activity/`:**
- Purpose: Read-only Wise audit-event ingestion and reconciliation
- Contains: `sync.ts` (`syncWiseActivityEvents`), `format.ts`, `reconciliation.ts` (`getWiseReconciliationActionSummary`), `data.ts`

**`drizzle/`:**
- Purpose: Generated database migrations + schema snapshots
- Contains: 40 `*.sql` files (`0000_*` … `0040_student_promotions.sql`) plus `meta/` (Drizzle journal + per-migration JSON snapshots)
- Generated: `npm run db:generate` writes here; `npm run db:migrate` applies. Committed: Yes.

**`scripts/`:**
- Purpose: One-off / scheduled operational scripts + release guards (`tsx` or `node`)
- Contains: seeds (`seed-credit-control-admin-ownership.ts`, `seed-tutor-business-profiles.ts`), AI scheduler evals (`evaluate-ai-scheduler*.ts`, `compare-ai-scheduler-models.ts`, `replay-ai-scheduler-runs.ts`), `import-room-capacity-model.ts`, `sync-room-utilization.ts`, `delete-line-test-data.ts`, and release guards (`check-sales-dashboard-scope.mjs`, `check-production-route-surface.mjs`, `assert-production-deploy-ready.mjs`)
- Wired to npm scripts (see `package.json`)

**`docs/`:**
- Purpose: Human + agent documentation, organized by the canonical-home convention
- `handbook/` — orientation prose (architecture, conventions, data-flow, glossary, the Next.js-16 warning)
- `features/` — per-feature "meaning" docs (purpose, rules, flows)
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
- `src/app/(app)/page.tsx`: Home hub (`HomeHub`); redirects single-page-access users to their one allowed page
- `src/app/(app)/search/page.tsx`: Original search + compare workspace
- `src/app/(app)/scheduler/page.tsx`: AI scheduler workspace (gated on `isAiSchedulerConfigured()`)
- `src/app/api/internal/sync-wise/route.ts`: Cron + admin Wise snapshot sync (`maxDuration = 800`)
- `src/middleware.ts`: Edge auth gate (via `auth-edge`) + page-level access control for every non-public request

**Configuration:**
- `tsconfig.json`: TypeScript strict mode, `@/*` alias → `./src/*`
- `next.config.ts`: `cacheComponents: true` (the only custom setting; enables `"use cache"`)
- `vercel.json`: 10 crons — Wise sync `*/30`, sales-dashboard `10,40`, credit-control `20,50`, progress-tests `25,55`, progress-tests admin-digest `35 0`, Wise activity `5,35`, leave-requests `15,45`, class-assignments morning `45 23`, class-assignments admin-email `0,10,20,30 0`, student-promotions july-1 `5 17 30 6 *`. Canonical: `docs/reference/crons.md`.
- `drizzle.config.ts`: Schema path + migrations output (PostgreSQL)
- `vitest.config.ts`: Two named projects — `unit` (node env) and `integration` (forks, serial, 60 s timeouts); `@` alias
- `eslint.config.mjs`: Flat config with Next.js presets
- `postcss.config.mjs`: Tailwind 4 plugin only
- `components.json`: shadcn/ui registry config (`base-nova`, rsc, lucide)
- `package.json`: Scripts (`dev`, `build`, `lint`, `typecheck`, `test`/`test:integration`/`test:all`/`test:coverage`, `db:generate`/`db:migrate`/`db:seed`, feature seed/eval/import scripts, `guard:*` release guards, `verify:release`, `deploy:prod`)

**Core Logic:**
- `src/lib/sync/orchestrator.ts`: Full Wise ETL pipeline (`runFullSync`)
- `src/lib/sync/run-wise-sync.ts`: Single-flight sync guard + cache revalidation
- `src/lib/search/index.ts`: In-memory index singleton + builders
- `src/lib/search/engine.ts`: Search execution
- `src/lib/search/compare.ts`: Compare engine (build/conflicts/free-slots)
- `src/lib/ai/scheduler-service.ts`: AI scheduler orchestration
- `src/lib/progress-tests/engine.ts`: Pure 8-class progress-test cycle counting engine
- `src/lib/data-health/dashboard.ts`: Cross-feature sync + cron health rollup
- `src/lib/home/summary.ts`: Home-hub + nav-badge aggregation payload
- `src/lib/db/schema.ts`: All 90 table + enum definitions
- `src/lib/wise/client.ts`: Wise API HTTP client; `src/lib/wise/operations.ts`: writeback ops
- `src/lib/auth.ts` / `src/lib/auth-access.ts` / `src/lib/auth-edge.ts`: NextAuth (Node) + role/page-access resolution + edge config
- `src/lib/env.ts`: Zod env validation
- `src/lib/internal/cron-auth.ts`: CRON_SECRET verification
- `src/lib/navigation/tools.ts`: Nav IA + access filtering

**Frontend Composition Roots (one per feature):**
- `src/components/home/home-hub.tsx`, `src/components/search/search-workspace.tsx`, `src/components/compare/week-overview.tsx`
- `src/components/scheduler/scheduler-workspace.tsx`, `src/components/line-review/line-review-workspace.tsx`
- `src/components/credit-control/dashboard-shell.tsx`, `src/components/sales-dashboard/sales-dashboard-shell.tsx`
- `src/components/payroll/payroll-dashboard.tsx`, `src/components/room-capacity/room-capacity-dashboard.tsx`
- `src/components/class-assignments/class-assignments-workspace.tsx`, `src/components/wise-activity/wise-activity-workspace.tsx`
- `src/components/leave-requests/leave-requests-workspace.tsx`, `src/components/tutor-profiles/tutor-profiles-workspace.tsx`
- `src/components/progress-tests/progress-tests-dashboard.tsx`, `src/components/student-promotions/student-promotions-workspace.tsx`
- `src/components/data-health/data-health-dashboard.tsx`
- `src/hooks/use-compare.ts`: Compare state hook

**Testing (162 test files):**
- Co-located `__tests__/` next to nearly every `src/lib/<domain>/` module, many API routes, and most feature component dirs
- Top-level: `src/__tests__/middleware.test.ts`, `src/__tests__/vercel-crons.test.ts` (asserts the cron registry against `vercel.json`)
- Integration suite: `*.integration.test.ts` (3 files, e.g. `src/lib/sync/__tests__/orchestrator.integration.test.ts`, `snapshot-pruning.integration.test.ts`) run by the `integration` project against a real Postgres (testcontainers) via `src/tests/integration/db-helper.ts`

## Naming Conventions

**Files:**
- All source files: kebab-case (`session-colors.ts`, `week-overview.tsx`, `app-nav.tsx`, `run-wise-sync.ts`)
- React components: `.tsx`; logic/types/helpers: `.ts`
- Tests: `{module}.test.ts(x)` in co-located `__tests__/`; integration tests: `{module}.integration.test.ts`
- Schema definition: `schema.ts` (singular); type definition modules: `types.ts` (per feature)
- Feature composition roots: `{feature}-workspace.tsx`, `{feature}-dashboard.tsx`, `{feature}-shell.tsx`, or `{feature}-hub.tsx`

**Directories:**
- All lowercase (`compare`, `search`, `normalization`, `sync`, `data-health`, `line-review`, `progress-tests`, `student-promotions`)
- Route groups in parentheses: `(app)` (Next.js convention; not part of URL)
- Dynamic route segments in brackets: `[...nextauth]`, `[runId]`, `[conversationId]`, `[canonicalKey]`, `[jobKey]`
- Test directories: `__tests__/`

**Components (PascalCase exports):**
- `HomeHub`, `SearchWorkspace`, `WeekOverview`, `SchedulerWorkspace`, `AppNav`, `DataHealthDashboard`, `ProgressTestsDashboard`, `StudentPromotionsWorkspace`
- Page components export `default`: `export default function SchedulerPage()`

**Functions (camelCase):**
- Generic: `executeSearch`, `buildCompareTutor`, `detectConflicts`, `normalizeWorkingHours`, `runFullSync`, `getHomeSummaryPayload`, `getDataHealthDashboardPayload`, `resolveUserAccess`
- Getters: `getDb()`, `getEnv()`, `getActiveSnapshotIdOrThrow()`, `getWiseTeacherDisplayName()`
- Booleans: `isBlockingStatus()`, `isOnlineVariant()`, `isApiSnapshotStale()`, `isAiSchedulerConfigured()`, `canAccessHref()`
- Factories: `createWiseClient()`
- Transforms: `parseTimeToMinutes()`, `normalizeLeaves()`, `normalizeTag()`, `parseWiseGrade()`
- Fetches: `fetchAllTeachers()`, `fetchAllFutureSessions()`, `fetchWiseCourseParticipants()`

**Constants (UPPER_SNAKE_CASE):**
- `TUTOR_COLORS`, `HOUR_HEIGHT`, `START_HOUR`, `END_HOUR`, `TIMEZONE`, `INSERT_CHUNK_SIZE`, `CACHE_VERSION`, `Z_INDEX`, `AI_SCHEDULER_VERSION`, `ACTIVE_PROPOSAL_STATUSES`, `NAV_SECTIONS`, `NAV_TOOLS`, `CRON_JOBS`, `PROGRESS_TEST_THRESHOLD`, `STUDENT_PROMOTION_TARGET_DATE`

**Types:**
- Interfaces (PascalCase): `SearchRequest`, `CompareTutor`, `IndexedTutorGroup`, `WiseClientConfig`, `SyncResult`, `HomeSummaryPayload`, `NavTool`, `CronJobDefinition`, `UserAccess`
- External API types prefixed `Wise`: `WiseTeacher`, `WiseSession`, `WiseActivityEvent`, `WisePromotionStudent`
- In-memory index types prefixed `Indexed`: `IndexedTutorGroup`, `IndexedSessionBlock`, `IndexedAvailabilityWindow`
- Pipeline output types prefixed `Normalized`
- Type aliases for unions: `type SearchMode = "recurring" | "one_time"`, `type NavSectionId`, `type CronJobKey`, `type UserRole = "admin" | "teacher"`

**Database:**
- Table/column names: `snake_case` (`tutor_identity_groups`, `snapshot_id`, `student_promotion_runs`, `progress_test_cycle_state`)
- Drizzle schema object names: `camelCase` (`tutorIdentityGroups`, `snapshotId`, `studentPromotionRuns`)
- Enums via `pgEnum` (snake_case SQL names, camelCase Drizzle objects; e.g. `modality`, `sync_status`, `payroll_review_status`, `line_scheduler_review_status`)

**Path aliases:**
- `@/*` → `./src/*` (in `tsconfig.json` and `vitest.config.ts`)
- shadcn registry aliases (`components.json`): `@/components`, `@/components/ui`, `@/lib`, `@/lib/utils`, `@/hooks`

## Where to Add New Code

**New API endpoint:**
- Implementation: `src/app/api/{feature}/route.ts` (nest segments/`[param]` dirs as needed)
- Pattern to follow: `src/app/api/compare/route.ts` — `auth()` first → JSON parse in try/catch → Zod `.safeParse()` → business logic in try/catch → `NextResponse.json`
- For cron-only work, place under `src/app/api/internal/` and guard with `rejectInvalidCronSecret` (`src/lib/internal/cron-auth.ts`); the `/api/internal/` prefix is already allowlisted in `middleware.ts`. Export `GET` for the cron call and `POST` for the admin/manual trigger.
- For server-fetched data, prefer a cached function in `src/lib/data/{feature}.ts` (`"use cache"` + cache tag) over inline DB queries
- Document the signature in `docs/reference/api/`

**New UI page:**
- Authenticated route: `src/app/(app)/{route}/page.tsx`, and register it in `src/lib/navigation/tools.ts` (add a `NavTool` to the right `section`, plus optional `badgeKey`/`shortcut`) — `AppNav` and the home hub render from that registry
- Public route: `src/app/{route}/page.tsx` (and update the `isPublicRoute` allowlist in `middleware.ts` if it must skip auth)
- Page-restricted access (e.g. teacher-only): access flows from `allowedPages` in `src/lib/auth-access.ts` + the `isPathAllowed` check in `middleware.ts`
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
- Wire into the relevant sync (`src/lib/sync/orchestrator.ts`, `src/lib/wise-activity/sync.ts`, `src/lib/progress-tests/sync.ts`, etc.)

**New feature domain (the common case now):**
- Library logic: `src/lib/{feature}/` with co-located `__tests__/`
- API: `src/app/api/{feature}/`; cron (if any): `src/app/api/internal/sync-{feature}/route.ts` + a `vercel.json` cron entry (update `src/__tests__/vercel-crons.test.ts` and register it in `src/lib/data-health/cron-registry.ts` so it shows in Data Health)
- UI: `src/app/(app)/{feature}/page.tsx` + `src/components/{feature}/` + a `NavTool` entry in `src/lib/navigation/tools.ts`
- Meaning doc in `docs/features/{feature}.md`, mechanical detail in `docs/reference/`

**New utility / constant:**
- General helper: `src/lib/utils.ts` (currently `cn()`); Bangkok date math: reuse `src/lib/bangkok-time.ts` or `src/lib/room-capacity/dates.ts`
- UI constant: `src/lib/ui/{name}.ts`; operational threshold: `src/lib/ops/stale.ts`

**New test:**
- Co-located in `__tests__/` next to the module; unit tests `*.test.ts(x)`, DB-backed tests `*.integration.test.ts`
- Run: `npm test` (unit) or `npm run test:integration`

## Special Directories

**`drizzle/`:**
- Purpose: Generated SQL migrations and metadata (40 `*.sql` + `meta/`)
- Generated: Yes — by `drizzle-kit generate` from `src/lib/db/schema.ts`. Committed: Yes. Manual edits discouraged (db:generate is known to emit bloated catch-up migrations — trim before db:migrate).

**`drizzle/meta/`:** Drizzle journal + per-migration schema snapshots (JSON). Generated, committed.

**`scripts/`:** Operational `tsx`/`node` scripts + release guards (not part of the app bundle). Committed.

**`__tests__/` (many locations):** Co-located Vitest test files. Committed.

**`src/tests/integration/`:** Integration harness — `db-helper.ts` + README; consumed by the `integration` Vitest project. Committed.

**`docs/superpowers/`:** Vendored skill documentation — do not edit.

**`.planning/`:** GSD workflow planning artifacts. Partially agent-generated, committed.

**`.next/` (not in tree):** Next.js build output. Generated, gitignored.

**`node_modules/` (not in tree):** npm dependencies. Generated, gitignored.

**`public/`:** Static assets served at site root. Committed.

---

_Verified against HEAD `d4fe6d3` on 2026-06-05._
