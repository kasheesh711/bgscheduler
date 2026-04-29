# Codebase Structure

**Analysis Date:** 2026-04-29

## Directory Layout

```
Scheduling/
├── src/
│   ├── app/                          # Next.js 16 App Router
│   │   ├── (app)/                    # Authenticated route group (shared AppNav layout)
│   │   │   ├── search/
│   │   │   │   ├── page.tsx          # Server Component, fetches cached filters/tutors
│   │   │   │   └── loading.tsx       # Suspense fallback (SearchSkeleton)
│   │   │   ├── compare/
│   │   │   │   └── page.tsx          # Client redirect to /search (back-compat)
│   │   │   ├── data-health/
│   │   │   │   └── page.tsx          # Admin sync dashboard (client component)
│   │   │   └── layout.tsx            # AppNav + main wrapper
│   │   ├── api/                      # API route handlers
│   │   │   ├── auth/[...nextauth]/route.ts
│   │   │   ├── compare/
│   │   │   │   ├── route.ts          # POST: side-by-side compare
│   │   │   │   └── discover/route.ts # POST: discovery panel candidates
│   │   │   ├── data-health/
│   │   │   │   ├── route.ts          # GET: sync status + issue counts
│   │   │   │   └── modality-counter.ts # MOD-03 helper, separately importable
│   │   │   ├── filters/route.ts      # GET: distinct subjects/curriculums/levels
│   │   │   ├── internal/sync-wise/route.ts  # GET/POST: cron + manual sync
│   │   │   ├── search/
│   │   │   │   ├── route.ts          # POST: legacy slot-based search
│   │   │   │   └── range/route.ts    # POST: range-grid search
│   │   │   └── tutors/route.ts       # GET: tutor list for combobox
│   │   ├── login/page.tsx            # Google sign-in (no AppNav)
│   │   ├── layout.tsx                # Root layout (Inter + JetBrains Mono fonts)
│   │   ├── page.tsx                  # redirect("/search")
│   │   ├── globals.css               # Tailwind 4 + shadcn theme + semantic color tokens
│   │   └── favicon.ico
│   ├── components/                   # React components organized by feature
│   │   ├── ui/                       # shadcn/ui primitives (badge, button, card, command,
│   │   │                             #   dialog, input, input-group, popover, select,
│   │   │                             #   separator, table, tabs, textarea)
│   │   ├── compare/                  # Compare panel components
│   │   │   ├── calendar-grid.tsx     # Day drill-down GCal grid
│   │   │   ├── compare-panel.tsx     # Compare panel container
│   │   │   ├── discovery-panel.tsx   # Tutor discovery modal
│   │   │   ├── modality-display.ts   # Modality formatter helper
│   │   │   ├── session-colors.ts     # rgba()/sessionBgColor()/TUTOR_COLORS
│   │   │   ├── tutor-combobox.tsx    # Searchable cmdk combobox
│   │   │   ├── tutor-profile-popover.tsx
│   │   │   ├── tutor-selector.tsx    # TutorChip type only
│   │   │   ├── week-calendar.tsx     # Month-grid date picker
│   │   │   └── week-overview.tsx     # 7-day GCal-style overlap-aware grid
│   │   ├── search/                   # Search panel components
│   │   │   ├── availability-grid.tsx
│   │   │   ├── copy-button.tsx
│   │   │   ├── copy-for-parent-drawer.tsx
│   │   │   ├── recent-searches.tsx   # localStorage helpers
│   │   │   ├── recommended-slots.tsx
│   │   │   ├── results-view.tsx
│   │   │   ├── search-form.tsx
│   │   │   ├── search-results.tsx
│   │   │   ├── search-workspace.tsx  # Side-by-side workspace, top-level
│   │   │   ├── slot-builder.tsx
│   │   │   ├── slot-chips.tsx
│   │   │   └── slot-input.tsx
│   │   ├── layout/
│   │   │   └── app-nav.tsx           # Top nav: BeGifted brand + Search/Data Health links
│   │   ├── skeletons/                # Loading-state skeletons
│   │   │   ├── calendar-skeleton.tsx
│   │   │   ├── form-skeleton.tsx
│   │   │   └── search-skeleton.tsx
│   │   └── data-health/              # (empty subdirectory)
│   ├── hooks/
│   │   └── use-compare.ts            # Compare state + tutorCache + AbortController
│   ├── lib/                          # Shared library code
│   │   ├── auth.ts                   # NextAuth config + signIn allowlist callback
│   │   ├── env.ts                    # Zod-validated env vars
│   │   ├── utils.ts                  # cn() class-merging helper
│   │   ├── data/                     # Cached server-only fetchers ("use cache" + tags)
│   │   │   ├── filters.ts
│   │   │   ├── tutors.ts
│   │   │   ├── past-sessions.ts
│   │   │   └── __tests__/
│   │   ├── db/                       # Drizzle schema + Neon client
│   │   │   ├── index.ts              # getDb() globalThis singleton
│   │   │   ├── schema.ts             # 14 tables + 4 enums
│   │   │   └── seed.ts               # Aliases + admin emails
│   │   ├── normalization/            # Wise -> canonical transformations
│   │   │   ├── identity.ts
│   │   │   ├── availability.ts
│   │   │   ├── leaves.ts
│   │   │   ├── sessions.ts
│   │   │   ├── qualifications.ts
│   │   │   ├── modality.ts
│   │   │   ├── timezone.ts
│   │   │   └── __tests__/
│   │   ├── search/                   # In-memory index + engines + types
│   │   │   ├── index.ts              # SearchIndex singleton + buildIndex/ensureIndex
│   │   │   ├── engine.ts             # executeSearch / getBlockingSessions
│   │   │   ├── compare.ts            # buildCompareTutor / detectConflicts / findSharedFreeSlots
│   │   │   ├── types.ts              # Request/response types
│   │   │   ├── parser.ts             # Free-text slot parser
│   │   │   ├── recommend.ts          # Recommended-slots ranking
│   │   │   ├── cache-version.ts      # CACHE_VERSION = "v2"
│   │   │   └── __tests__/
│   │   ├── sync/                     # ETL orchestrator
│   │   │   ├── orchestrator.ts       # runFullSync (12 steps)
│   │   │   ├── past-sessions-diff-hook.ts
│   │   │   └── __tests__/
│   │   ├── ui/
│   │   │   └── z-index.ts            # Z_INDEX = { content: 1, legend: 6, popover: 50 }
│   │   └── wise/                     # Wise API client + types
│   │       ├── client.ts             # WiseClient with retry/concurrency
│   │       ├── fetchers.ts           # fetchAllTeachers/fetchAllFutureSessions/...
│   │       ├── types.ts              # Wise API shapes + accessor helpers
│   │       └── __tests__/
│   └── middleware.ts                 # Auth gate + public-route allowlist
├── drizzle/                          # Generated migrations
│   ├── 0000_tidy_black_bolt.sql
│   ├── 0001_tough_plazm.sql
│   ├── 0002_past_session_blocks.sql
│   └── meta/                         # Drizzle journal + per-migration snapshot JSON
├── public/                           # Static assets (Next.js conventions)
├── docs/                             # Project documentation
│   └── superpowers/
├── .planning/                        # GSD workflow artifacts
│   ├── codebase/                     # This document and siblings
│   ├── debug/, milestones/, phases/, quick/, reports/, research/
├── .claude/                          # Claude Code config
├── AGENTS.md                         # Primary agent instructions
├── CLAUDE.md                         # Includes AGENTS.md plus stack/conventions
├── PRD.md                            # Product requirements
├── PRODUCTION_SYNC_DEPLOY.md         # Deployment runbook
├── DATA_AUDIT.md, WISE_COMPARISON.md # Data integrity documentation
├── README.md
├── package.json                      # npm scripts + deps
├── package-lock.json
├── tsconfig.json                     # Strict mode, ES2017, bundler resolution
├── tsconfig.tsbuildinfo              # TypeScript incremental build cache
├── next.config.ts                    # Default config (no overrides)
├── next-env.d.ts                     # Next.js generated types
├── eslint.config.mjs                 # Flat config (next/core-web-vitals + typescript)
├── postcss.config.mjs                # @tailwindcss/postcss only
├── drizzle.config.ts                 # PostgreSQL dialect, schema -> ./src/lib/db/schema.ts
├── vitest.config.ts                  # Node env, @ alias mapped to ./src
├── vercel.json                       # Cron schedule "0 0 * * *"
├── components.json                   # shadcn/ui config (base-nova style, lucide icons)
├── Availability.xlsx                 # Legacy data audit file
└── Upcoming Sessions.xlsx            # Legacy data audit file
```

## Directory Purposes

**`src/app/`:**
- Purpose: Next.js 16 App Router — pages, layouts, API routes
- Contains: Server Components by default; client components opt in via `"use client"`
- Key files: `layout.tsx` (root, fonts), `(app)/layout.tsx` (AppNav wrapper), `middleware.ts` (auth gate, sibling at `src/`)

**`src/app/(app)/`:**
- Purpose: Route group for authenticated admin pages sharing the `AppNav` layout
- Contains: `search/`, `compare/`, `data-health/` directories plus shared `layout.tsx`
- Notes: Parentheses in `(app)` mean route group only — no URL segment.

**`src/app/api/`:**
- Purpose: HTTP endpoints exposed by Next.js App Router
- Contains: `route.ts` files implementing GET/POST handlers
- Co-located: `__tests__/` and helper modules (e.g. `data-health/modality-counter.ts`)

**`src/components/ui/`:**
- Purpose: Reusable design-system primitives wrapping `@base-ui/react`
- Contains: Generic widgets (badge, button, card, command, dialog, input, input-group, popover, select, separator, table, tabs, textarea)
- Source of truth: `components.json` declares this as `@/components/ui` for shadcn CLI; `style: "base-nova"`, `iconLibrary: "lucide"`
- Used by: All feature directories

**`src/components/{compare,search,data-health,layout,skeletons}/`:**
- Purpose: Feature-scoped components, all `"use client"`
- Contains: Compare grid + week overview + tutor combobox; search workspace + form + results; nav; loading skeletons

**`src/hooks/`:**
- Purpose: Reusable React hooks
- Contains: `use-compare.ts` (largest hook; owns compare state, cache, abort controller)
- Maps to: `@/hooks` alias in `components.json`

**`src/lib/`:**
- Purpose: Shared business logic and platform integrations
- Contains: Domain modules (db, wise, normalization, sync, search, data, ui, auth, env, utils)
- Maps to: `@/lib` alias in `components.json`

**`src/lib/data/`:**
- Purpose: Server-only cached fetchers (`"use cache"` + `cacheTag` + `cacheLife`)
- Contains: `filters.ts`, `tutors.ts`, `past-sessions.ts` (separate `"past-sessions"` tag)
- Used by: Server Components and API routes

**`src/lib/db/`:**
- Purpose: Postgres connection and schema definition
- Contains: `index.ts` (Neon serverless + Drizzle), `schema.ts` (14 tables + 4 enums), `seed.ts`
- Generated: `drizzle/` migrations are generated FROM `schema.ts` via `drizzle-kit generate`

**`src/lib/normalization/`:**
- Purpose: Pure transformation functions (Wise data -> canonical internal)
- Contains: `identity.ts`, `availability.ts`, `leaves.ts`, `sessions.ts`, `qualifications.ts`, `modality.ts`, `timezone.ts`
- Tests: Co-located in `__tests__/` (one test per module)

**`src/lib/search/`:**
- Purpose: In-memory index and query engines
- Contains: `index.ts` (singleton + builders), `engine.ts` (search), `compare.ts` (compare/conflicts/free-slots), `types.ts`, `parser.ts`, `recommend.ts`, `cache-version.ts`
- Singleton lives in: `globalThis.__bgscheduler_searchIndex`

**`src/lib/sync/`:**
- Purpose: ETL pipeline
- Contains: `orchestrator.ts` (runFullSync), `past-sessions-diff-hook.ts` (PAST-01 capture)
- Triggered by: `src/app/api/internal/sync-wise/route.ts`

**`src/lib/wise/`:**
- Purpose: External Wise API integration
- Contains: `client.ts` (HTTP), `fetchers.ts` (domain fetchers), `types.ts` (response shapes + accessor helpers)
- No internal dependencies (pure HTTP + env)

**`src/lib/ui/`:**
- Purpose: UI constants shared across components
- Contains: `z-index.ts` (3-tier z-index scale)

**`drizzle/`:**
- Purpose: Generated database migrations + schema snapshots
- Contains: `0000_*.sql`, `0001_*.sql`, `0002_past_session_blocks.sql`, plus `meta/` with Drizzle journal
- Generated: `npm run db:generate` updates this directory; `npm run db:migrate` applies migrations
- Committed: Yes

**`.planning/`:**
- Purpose: GSD workflow artifacts (plans, milestones, debug docs, codebase maps)
- Contains: `codebase/` (this directory), `phases/` (phase-specific plans), `milestones/`, `quick/`, `debug/`, `reports/`, `research/`
- Committed: Yes (workflow scaffolding)

**`docs/`:**
- Purpose: Project documentation outside the workflow scaffolding
- Contains: `superpowers/`

**`public/`:**
- Purpose: Static assets served at the site root
- Convention: Next.js default

## Key File Locations

**Entry Points:**
- `src/app/page.tsx`: Root redirect to `/search`
- `src/app/(app)/search/page.tsx`: Primary admin UI (Server Component)
- `src/app/api/internal/sync-wise/route.ts`: Cron + manual sync trigger
- `src/middleware.ts`: Auth gate for every request

**Configuration:**
- `tsconfig.json`: TypeScript strict mode, `@/*` alias -> `./src/*`
- `next.config.ts`: Default Next.js config (no overrides)
- `vercel.json`: Daily cron at midnight UTC
- `drizzle.config.ts`: Schema path + migrations output
- `vitest.config.ts`: Node env + `@` alias
- `eslint.config.mjs`: Flat config with Next.js presets
- `postcss.config.mjs`: Tailwind 4 plugin only
- `components.json`: shadcn/ui registry config
- `package.json`: Scripts (`dev`, `build`, `test`, `db:generate`, `db:migrate`, `db:seed`)

**Core Logic:**
- `src/lib/sync/orchestrator.ts`: Full ETL pipeline (`runFullSync`)
- `src/lib/search/index.ts`: In-memory index singleton
- `src/lib/search/engine.ts`: Search execution
- `src/lib/search/compare.ts`: Compare engine (build/conflicts/free-slots)
- `src/lib/db/schema.ts`: All 14 table definitions
- `src/lib/wise/client.ts`: Wise API HTTP client
- `src/lib/auth.ts`: NextAuth + admin allowlist
- `src/lib/env.ts`: Zod env validation

**Frontend Composition Roots:**
- `src/components/search/search-workspace.tsx`: Side-by-side layout root
- `src/components/compare/compare-panel.tsx`: Compare panel container
- `src/components/compare/week-overview.tsx`: 7-day GCal grid (largest UI file at 597 lines)
- `src/hooks/use-compare.ts`: Compare state hook

**Testing:**
- `src/lib/normalization/__tests__/`: 7 test files (one per normalizer)
- `src/lib/search/__tests__/`: `compare.test.ts`, `engine.test.ts`, `parser.test.ts`, `recommend.test.ts`
- `src/lib/sync/__tests__/`: `past-sessions-diff-hook.test.ts`
- `src/lib/wise/__tests__/`: `client.test.ts`, `fetchers.test.ts`
- `src/lib/data/__tests__/`: `past-sessions.test.ts`

## Naming Conventions

**Files:**
- All source files: kebab-case (`session-colors.ts`, `week-overview.tsx`, `app-nav.tsx`, `copy-button.tsx`)
- React components: `.tsx`
- Logic/types/helpers: `.ts`
- Tests: `{module}.test.ts` inside co-located `__tests__/` directory
- Schema definition: `schema.ts` (singular)
- Type definition modules: `types.ts` (per feature directory)

**Directories:**
- All lowercase (`compare`, `search`, `normalization`, `sync`, `data-health`, `data-health/__tests__`)
- Route groups in parentheses: `(app)` (Next.js convention; not part of URL)
- Dynamic route segments in brackets: `[...nextauth]`
- Test directories: `__tests__/` (double-underscore Vitest/Jest convention)

**Components (PascalCase exports):**
- `SearchWorkspace`, `ComparePanel`, `WeekOverview`, `CalendarGrid`, `TutorCombobox`, `AppNav`
- Page components export `default`: `export default function SearchPage()`

**Functions (camelCase):**
- Generic: `executeSearch`, `buildCompareTutor`, `detectConflicts`, `normalizeWorkingHours`
- Getters: `getDb()`, `getEnv()`, `getBaseName()`, `getWiseTeacherDisplayName()`
- Booleans: `isBlockingStatus()`, `isOnlineVariant()`
- Factories: `createWiseClient()`, `createDb()`
- Transforms: `parseTimeToMinutes()`, `normalizeLeaves()`, `normalizeTag()`
- Fetches: `fetchAllTeachers()`, `fetchAllFutureSessions()`

**Constants (UPPER_SNAKE_CASE):**
- `TUTOR_COLORS`, `HOUR_HEIGHT`, `START_HOUR`, `END_HOUR`, `DAY_NAMES`, `DISPLAY_DAYS`, `ONLINE_SESSION_TYPES`, `ONSITE_SESSION_TYPES`, `TIMEZONE`, `INSERT_CHUNK_SIZE`, `PAGE_LIMIT`, `CACHE_VERSION`, `Z_INDEX`

**Types:**
- Interfaces (PascalCase): `SearchRequest`, `CompareTutor`, `IndexedTutorGroup`, `WiseClientConfig`
- External API types prefixed `Wise`: `WiseTeacher`, `WiseSession`, `WiseAvailabilityResponse`
- In-memory index types prefixed `Indexed`: `IndexedTutorGroup`, `IndexedSessionBlock`, `IndexedAvailabilityWindow`
- Pipeline output types prefixed `Normalized`: `NormalizedSessionBlock`
- Type aliases for unions: `type SearchMode = "recurring" | "one_time"`

**Database:**
- Table column names: `snake_case` (`tutor_identity_groups`, `snapshot_id`, `created_at`)
- Drizzle schema object names: `camelCase` (`tutorIdentityGroups`, `snapshotId`)
- Enums via `pgEnum` (not TypeScript `enum`)

**Path aliases:**
- `@/*` -> `./src/*` (in `tsconfig.json` and `vitest.config.ts`)
- shadcn registry aliases (`components.json`): `@/components`, `@/components/ui`, `@/lib`, `@/lib/utils`, `@/hooks`

## Where to Add New Code

**New API endpoint:**
- Implementation: `src/app/api/{feature}/route.ts`
- Pattern to follow: `src/app/api/compare/route.ts:53-187`
- Always: `auth()` first -> JSON parse in try/catch -> Zod `.safeParse()` -> business logic in try/catch -> NextResponse.json
- For server-fetched data, prefer adding a cached function in `src/lib/data/{feature}.ts` with `"use cache"` + `cacheTag("snapshot")` + `cacheLife("hours")`

**New UI page:**
- Authenticated route: `src/app/(app)/{route}/page.tsx`
- Public route: `src/app/{route}/page.tsx` (and update `middleware.ts` allowlist if needed)
- Loading state: `loading.tsx` sibling
- Skeleton: add to `src/components/skeletons/`

**New React component:**
- Generic primitive: `src/components/ui/{name}.tsx` (use shadcn CLI; uses `@base-ui/react`)
- Feature component: `src/components/{feature}/{name}.tsx`
- Always: kebab-case filename, `"use client"` if interactive, props interface above component, helpers above component

**New normalizer:**
- Implementation: `src/lib/normalization/{domain}.ts`
- Test: `src/lib/normalization/__tests__/{domain}.test.ts`
- Wire into orchestrator: `src/lib/sync/orchestrator.ts` (between fetch and persist steps)

**New database table:**
- Schema: append to `src/lib/db/schema.ts` using `pgTable(...)`. Add `snapshotId` FK if snapshot-scoped.
- Generate migration: `npm run db:generate` writes to `drizzle/`
- Apply: `DATABASE_URL=... npm run db:migrate`
- Wire into index: load in parallel inside `buildIndex()` (`src/lib/search/index.ts:136-161`)

**New Wise API call:**
- Add fetcher: `src/lib/wise/fetchers.ts`
- Add response type: `src/lib/wise/types.ts`
- Test: `src/lib/wise/__tests__/fetchers.test.ts`
- Wire into orchestrator: `src/lib/sync/orchestrator.ts`

**New utility:**
- General-purpose helper: `src/lib/utils.ts` (currently only `cn()`)
- UI constant: `src/lib/ui/{name}.ts` (e.g. `z-index.ts`)
- Search-specific helper: in the appropriate `src/lib/search/*.ts` file (don't add new files unless new domain)

**New compare-side helper:**
- Pure function: `src/lib/search/compare.ts`
- Stateful logic: extend `src/hooks/use-compare.ts`
- Visual rendering: `src/components/compare/{component}.tsx`

**New test:**
- Always co-located in `__tests__/` next to the module being tested
- Vitest config: `vitest.config.ts` (Node env, globals enabled, `@` alias)
- Run: `npm test`

## Special Directories

**`drizzle/`:**
- Purpose: Generated SQL migrations and metadata
- Generated: Yes — by `drizzle-kit generate` from `src/lib/db/schema.ts`
- Committed: Yes
- Manual edits: Discouraged; modify `schema.ts` and regenerate

**`drizzle/meta/`:**
- Purpose: Drizzle journal + per-migration schema snapshots (JSON)
- Generated: Yes
- Committed: Yes

**`__tests__/` (multiple locations):**
- Purpose: Co-located Vitest test files
- Generated: No
- Committed: Yes

**`.planning/`:**
- Purpose: GSD workflow planning artifacts (this directory's grandparent)
- Generated: Partially — agent commands write here
- Committed: Yes
- Subdirectories: `codebase/`, `debug/`, `milestones/`, `phases/`, `quick/`, `reports/`, `research/`

**`.next/` (not in tree):**
- Purpose: Next.js build output
- Generated: Yes — `npm run build` or `npm run dev`
- Committed: No (gitignored)

**`node_modules/` (not in tree):**
- Purpose: npm dependencies
- Generated: Yes — `npm install`
- Committed: No (gitignored)

**`public/`:**
- Purpose: Static assets served at site root
- Generated: No
- Committed: Yes

**`docs/superpowers/`:**
- Purpose: Project documentation
- Committed: Yes

---

*Structure analysis: 2026-04-29*
