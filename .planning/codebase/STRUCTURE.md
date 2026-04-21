# Codebase Structure

**Analysis Date:** 2026-04-21

## Directory Layout

```
Scheduling/
├── .planning/                     # GSD planning artifacts (docs, phases, roadmap)
│   ├── codebase/                  # Auto-generated codebase maps (this directory)
│   ├── phases/                    # Per-phase context + plans
│   ├── milestones/                # Milestone tracking
│   ├── research/                  # Research artifacts (PITFALLS.md)
│   ├── quick/                     # `/gsd-quick` outputs
│   ├── debug/                     # `/gsd-debug` outputs
│   ├── ROADMAP.md, STATE.md, ...  # Top-level planning docs
├── docs/                          # Human documentation (superpowers notes)
├── drizzle/                       # Drizzle-generated SQL migrations
│   ├── 0000_tidy_black_bolt.sql   # Initial schema
│   ├── 0001_tough_plazm.sql       # Follow-up migration
│   └── meta/                      # Drizzle journal + snapshots
├── node_modules/                  # Dependencies (gitignored)
├── public/                        # Static assets served at root
├── src/                           # Application source
│   ├── app/                       # Next.js 16 App Router
│   │   ├── (app)/                 # Authenticated route group (uses AppNav layout)
│   │   │   ├── layout.tsx         # Shared nav + main container
│   │   │   ├── search/            # /search — primary workspace
│   │   │   │   ├── page.tsx       # RSC entry; loads filterOptions + tutorList
│   │   │   │   └── loading.tsx    # Suspense fallback
│   │   │   ├── compare/
│   │   │   │   └── page.tsx       # Client-side redirect to /search
│   │   │   └── data-health/
│   │   │       └── page.tsx       # /data-health dashboard
│   │   ├── api/                   # Route handlers
│   │   │   ├── auth/[...nextauth]/route.ts
│   │   │   ├── compare/
│   │   │   │   ├── route.ts
│   │   │   │   └── discover/route.ts
│   │   │   ├── data-health/
│   │   │   │   ├── route.ts
│   │   │   │   ├── modality-counter.ts
│   │   │   │   └── __tests__/modality-counter.test.ts
│   │   │   ├── filters/route.ts
│   │   │   ├── internal/
│   │   │   │   └── sync-wise/route.ts
│   │   │   ├── search/
│   │   │   │   ├── route.ts
│   │   │   │   └── range/route.ts
│   │   │   └── tutors/route.ts
│   │   ├── login/page.tsx         # Outside (app) group — no AppNav
│   │   ├── layout.tsx             # Root html + fonts
│   │   ├── page.tsx               # Redirects to /search
│   │   └── globals.css            # Tailwind v4 + CSS custom properties
│   ├── components/                # UI — organized by feature
│   │   ├── ui/                    # shadcn primitives (badge, button, card,
│   │   │                          # command, dialog, input, popover, select,
│   │   │                          # separator, table, tabs, textarea, ...)
│   │   ├── layout/
│   │   │   └── app-nav.tsx        # Persistent nav bar
│   │   ├── search/                # Search-left-panel components
│   │   │   ├── search-workspace.tsx
│   │   │   ├── search-form.tsx
│   │   │   ├── search-results.tsx / results-view.tsx / availability-grid.tsx
│   │   │   ├── recommended-slots.tsx
│   │   │   ├── copy-for-parent-drawer.tsx / copy-button.tsx
│   │   │   ├── recent-searches.tsx
│   │   │   └── slot-*.tsx         # slot-builder, slot-chips, slot-input
│   │   ├── compare/               # Compare-right-panel components
│   │   │   ├── compare-panel.tsx
│   │   │   ├── week-overview.tsx
│   │   │   ├── calendar-grid.tsx
│   │   │   ├── week-calendar.tsx  # Month-grid date picker
│   │   │   ├── tutor-combobox.tsx
│   │   │   ├── tutor-selector.tsx
│   │   │   ├── tutor-profile-popover.tsx
│   │   │   ├── discovery-panel.tsx
│   │   │   ├── session-colors.ts
│   │   │   └── modality-display.ts
│   │   ├── data-health/           # Data-health dashboard widgets
│   │   └── skeletons/             # Suspense fallbacks
│   ├── hooks/
│   │   └── use-compare.ts         # Compare state machine + tutor cache
│   ├── lib/
│   │   ├── auth.ts                # NextAuth config + allowlist callback
│   │   ├── env.ts                 # Zod-validated process.env
│   │   ├── utils.ts               # cn() class merger
│   │   ├── data/                  # RSC-cached read helpers (tagged "snapshot")
│   │   │   ├── filters.ts
│   │   │   └── tutors.ts
│   │   ├── db/                    # Database layer
│   │   │   ├── index.ts           # getDb() singleton
│   │   │   ├── schema.ts          # 14 tables + 4 enums
│   │   │   └── seed.ts            # Aliases + admin users seeder
│   │   ├── wise/                  # External API client
│   │   │   ├── client.ts          # HTTP + retry + concurrency limiter
│   │   │   ├── fetchers.ts
│   │   │   ├── types.ts
│   │   │   └── __tests__/
│   │   ├── normalization/         # 6 domain modules + tests
│   │   │   ├── identity.ts
│   │   │   ├── availability.ts
│   │   │   ├── leaves.ts
│   │   │   ├── sessions.ts
│   │   │   ├── qualifications.ts
│   │   │   ├── modality.ts
│   │   │   ├── timezone.ts
│   │   │   └── __tests__/
│   │   ├── sync/
│   │   │   └── orchestrator.ts    # runFullSync() — full ETL pipeline
│   │   └── search/
│   │       ├── index.ts           # SearchIndex singleton
│   │       ├── engine.ts          # executeSearch()
│   │       ├── compare.ts         # buildCompareTutor/detect/findShared
│   │       ├── recommend.ts       # Client-derived top slots
│   │       ├── parser.ts          # Natural-language slot parsing
│   │       ├── types.ts           # Shared wire types
│   │       ├── cache-version.ts   # CACHE_VERSION = "v1"
│   │       └── __tests__/
│   └── middleware.ts              # Auth gate
├── .env.example                   # Documented required env vars
├── .env.local                     # Local secrets (gitignored)
├── AGENTS.md                      # Agent-facing project brief
├── CLAUDE.md                      # Project instructions (imports AGENTS.md)
├── DATA_AUDIT.md / PRD.md / README.md / WISE_COMPARISON.md
├── components.json                # shadcn config (base-nova style)
├── drizzle.config.ts              # Drizzle-kit config (points at schema.ts)
├── eslint.config.mjs              # Flat config: next/core-web-vitals + typescript
├── next-env.d.ts                  # Next.js type ambient
├── next.config.ts                 # Default config
├── package.json / package-lock.json
├── postcss.config.mjs             # @tailwindcss/postcss plugin
├── tsconfig.json                  # strict, ES2017, bundler, @/* -> ./src/*
├── vercel.json                    # Cron schedule (0 0 * * *)
└── vitest.config.ts               # Node environment, @/* alias
```

## Directory Purposes

**`src/app/`:**
- Purpose: Next.js 16 App Router — server components, route handlers, layouts
- Contains: Pages, API routes, `globals.css`
- Key files: `src/app/(app)/search/page.tsx` (primary entry), `src/app/layout.tsx` (root html + fonts), `src/app/globals.css` (Tailwind + CSS custom properties for `--available`, `--blocked`, `--conflict`, `--free-slot`)

**`src/app/(app)/`:**
- Purpose: Route group for authenticated pages; shared `AppNav` layout
- Contains: `search/`, `compare/`, `data-health/`, and the group `layout.tsx`
- Key files: `src/app/(app)/layout.tsx` (nav + main container with `overflow-hidden px-4 lg:px-6 py-3`)

**`src/app/api/`:**
- Purpose: HTTP route handlers under `/api/*`
- Contains: `auth/`, `compare/`, `data-health/`, `filters/`, `internal/`, `search/`, `tutors/`
- Key files: `src/app/api/compare/route.ts`, `src/app/api/search/range/route.ts`, `src/app/api/internal/sync-wise/route.ts`

**`src/components/ui/`:**
- Purpose: shadcn-generated primitives wrapping `@base-ui/react` + `cmdk`
- Contains: `badge.tsx`, `button.tsx`, `card.tsx`, `command.tsx`, `dialog.tsx`, `input.tsx`, `input-group.tsx`, `popover.tsx`, `select.tsx`, `separator.tsx`, `table.tsx`, `tabs.tsx`, `textarea.tsx`
- Key files: All tracked in `components.json` (registry `base-nova`, `rsc: true`, `tsx: true`, icons `lucide`)

**`src/components/search/`, `src/components/compare/`, `src/components/layout/`, `src/components/data-health/`, `src/components/skeletons/`:**
- Purpose: Feature-organized client components
- Contains: `"use client"` modules with domain-specific logic
- Key files: `search-workspace.tsx`, `compare-panel.tsx`, `week-overview.tsx`, `tutor-combobox.tsx`, `week-calendar.tsx`, `discovery-panel.tsx`, `copy-for-parent-drawer.tsx`, `recommended-slots.tsx`, `app-nav.tsx`

**`src/lib/`:**
- Purpose: Backend logic — DB, auth, normalization pipeline, search, external API client
- Contains: `auth.ts`, `env.ts`, `utils.ts`, `data/`, `db/`, `wise/`, `normalization/`, `sync/`, `search/`
- Key files: `src/lib/db/schema.ts` (14 tables), `src/lib/search/index.ts` (in-memory index), `src/lib/sync/orchestrator.ts` (ETL)

**`src/lib/normalization/`:**
- Purpose: Pure functions that convert raw Wise responses into canonical domain objects
- Contains: 6 domain modules + `timezone.ts` + `__tests__/`
- Key files: `identity.ts`, `availability.ts`, `leaves.ts`, `sessions.ts`, `qualifications.ts`, `modality.ts`, `timezone.ts`

**`src/lib/search/`:**
- Purpose: In-memory index + query engines
- Contains: Singleton builder, search engine, compare engine, recommend helper, parser, types, cache-version constant
- Key files: `index.ts` (index + `ensureIndex`), `engine.ts` (`executeSearch`), `compare.ts` (`buildCompareTutor`/`detectConflicts`/`findSharedFreeSlots`/`resolveSessionModality`)

**`src/lib/wise/`:**
- Purpose: Wise API HTTP client + fetchers + types
- Contains: `client.ts` (WiseClient class with retry/backoff/concurrency), `fetchers.ts` (domain calls), `types.ts` (response shapes), `__tests__/`
- Key files: `createWiseClient()` factory in `client.ts`; `fetchAllTeachers`, `fetchTeacherFullAvailability`, `fetchAllFutureSessions` in `fetchers.ts`

**`src/lib/data/`:**
- Purpose: RSC-side cached read helpers (tagged `"snapshot"` for revalidation)
- Contains: `filters.ts` (subjects/curriculums/levels), `tutors.ts` (tutor list)
- Key files: Used by `src/app/(app)/search/page.tsx`

**`src/hooks/`:**
- Purpose: Client-side React hooks
- Contains: `use-compare.ts` — owns compare state machine, tutor cache, week navigation, AbortController, snapshot mismatch recovery

**`drizzle/`:**
- Purpose: Drizzle-generated migration SQL (committed)
- Generated: Yes (by `npm run db:generate`)
- Committed: Yes
- Key files: `0000_tidy_black_bolt.sql`, `0001_tough_plazm.sql`, `meta/_journal.json`

**`.planning/`:**
- Purpose: GSD workflow artifacts (plans, phases, milestones, codebase maps)
- Contains: ROADMAP, STATE, PROJECT, MILESTONES, HANDOFF, REQUIREMENTS, RETROSPECTIVE markdown files + per-phase context directories
- Generated: Partially (codebase/ is auto-generated)
- Committed: Yes

**`node_modules/`, `.next/`, `.vercel/`:**
- Purpose: Dependency + build caches
- Generated: Yes
- Committed: No (gitignored)

## Key File Locations

**Entry Points:**
- `src/app/page.tsx` — root redirect to `/search`
- `src/app/(app)/search/page.tsx` — primary workspace (RSC)
- `src/app/(app)/data-health/page.tsx` — ops dashboard
- `src/app/login/page.tsx` — Google sign-in
- `src/middleware.ts` — auth gate
- `src/app/api/internal/sync-wise/route.ts` — sync entry (cron + manual)

**Configuration:**
- `tsconfig.json` — strict, ES2017, `@/*` → `./src/*`
- `next.config.ts` — default
- `vercel.json` — daily cron `0 0 * * *`
- `drizzle.config.ts` — schema path + Postgres dialect
- `eslint.config.mjs` — flat config extending next presets
- `postcss.config.mjs` — `@tailwindcss/postcss` only
- `components.json` — shadcn `base-nova` style
- `vitest.config.ts` — node env, `@/*` alias
- `.env.example` — documents 9 required env vars
- `src/lib/env.ts` — Zod-validated accessor (fails loudly at startup)

**Core Logic:**
- `src/lib/db/schema.ts` — 14 tables: `snapshots`, `sync_runs`, `admin_users`, `tutor_identity_groups`, `tutor_identity_group_members`, `tutor_aliases`, `tutors`, `raw_teacher_tags`, `subject_level_qualifications`, `recurring_availability_windows`, `dated_leaves`, `future_session_blocks`, `data_issues`, `snapshot_stats`
- `src/lib/db/index.ts` — `getDb()` + `Database` type export
- `src/lib/auth.ts` — NextAuth config with Google + `admin_users` allowlist
- `src/lib/search/index.ts` — `SearchIndex`, `IndexedTutorGroup`, `buildIndex`, `ensureIndex`
- `src/lib/search/engine.ts` — `executeSearch`, `getBlockingSessions`
- `src/lib/search/compare.ts` — `buildCompareTutor`, `detectConflicts`, `findSharedFreeSlots`, `resolveSessionModality`, `detectSessionModalityConflict`
- `src/lib/search/types.ts` — wire types (`SearchRequest`, `CompareResponse`, `DiscoverCandidate`, etc.)
- `src/lib/sync/orchestrator.ts` — `runFullSync()`
- `src/lib/wise/client.ts` — `WiseClient` class + `createWiseClient()`
- `src/lib/normalization/timezone.ts` — Asia/Bangkok helpers + `parseTimeToMinutes`
- `src/hooks/use-compare.ts` — client-side compare state + tutor cache

**Testing:**
- `src/lib/normalization/__tests__/` — identity, timezone, availability, leaves, sessions, modality, qualifications
- `src/lib/search/__tests__/` — engine, compare, parser, recommend
- `src/lib/wise/__tests__/` — client, fetchers
- `src/lib/sync/__tests__/` — orchestrator unit tests
- `src/app/api/data-health/__tests__/modality-counter.test.ts`

## Naming Conventions

**Files:**
- kebab-case for all source files: `session-colors.ts`, `week-overview.tsx`, `app-nav.tsx`, `use-compare.ts`, `copy-for-parent-drawer.tsx`
- Tests co-located in `__tests__/` directories: `{module}.test.ts`
- Next.js reserved names lowercased: `page.tsx`, `layout.tsx`, `loading.tsx`, `route.ts`, `middleware.ts`

**Directories:**
- kebab-case feature directories: `data-health/`, `search/`, `compare/`, `layout/`
- Route-group directory in parentheses: `(app)/` (does not appear in URL)
- Dynamic segment brackets: `[...nextauth]/`

**Functions:**
- camelCase: `executeSearch`, `buildCompareTutor`, `detectConflicts`, `resolveSessionModality`
- `get` prefix for getters: `getDb`, `getEnv`, `getSearchIndex`, `getCurrentMonday`, `getBaseName`
- `is`/`has` prefix for booleans: `isBlockingStatus`, `isOnlineVariant`, `hasRecurringLeaveConflict`
- `make`/`create` prefix for factories: `createWiseClient`, `createDb`
- `parse`/`normalize` prefix for transformers: `parseTimeToMinutes`, `normalizeWorkingHours`, `normalizeLeaves`
- `fetch` prefix for API calls: `fetchAllTeachers`, `fetchAllFutureSessions`
- `use` prefix for React hooks: `useCompare`, `useSearchParams`

**Types & interfaces:**
- PascalCase: `SearchRequest`, `CompareTutor`, `IndexedTutorGroup`
- Prefix `Wise` for external shapes: `WiseTeacher`, `WiseSession`, `WiseAvailabilityResponse`
- Prefix `Indexed` for in-memory shapes: `IndexedTutorGroup`, `IndexedSessionBlock`
- `interface` for object shapes; `type` for unions/aliases: `type SearchMode = "recurring" | "one_time"`
- Database enums defined via Drizzle `pgEnum` (not TypeScript `enum`): `syncStatusEnum`, `modalityEnum`, `dataIssueTypeEnum`, `dataIssueSeverityEnum`

**Database identifiers:**
- snake_case table names: `tutor_identity_groups`, `future_session_blocks`, `snapshot_stats`
- snake_case column names: `snapshot_id`, `created_at`, `wise_teacher_id`, `is_online_variant`
- camelCase Drizzle schema exports: `tutorIdentityGroups`, `futureSessionBlocks`
- Index names prefixed by table abbreviation: `tig_snapshot_idx`, `fsb_weekday_idx`, `slq_group_idx`

**Constants:**
- UPPER_SNAKE_CASE: `TUTOR_COLORS`, `HOUR_HEIGHT`, `START_HOUR`, `DAY_NAMES`, `DISPLAY_DAYS`, `ONLINE_SESSION_TYPES`, `INSERT_CHUNK_SIZE`, `TIMEZONE`, `PAGE_LIMIT`, `CACHE_VERSION`
- Singleton private state: `globalThis.__bgscheduler_*` (prefixed to avoid collisions)

## Where to Add New Code

**New API endpoint:**
- Route handler: `src/app/api/{feature}/route.ts` (or `src/app/api/{feature}/{sub-action}/route.ts`)
- Follow the canonical pattern: `auth()` gate → `.safeParse()` on body → `ensureIndex(getDb())` → business logic → typed response
- Wire types: add to `src/lib/search/types.ts` (or a new `{feature}/types.ts` if cleanly separable)
- Tests: `src/app/api/{feature}/__tests__/*.test.ts` co-located (see `data-health/__tests__/modality-counter.test.ts` for the ESM-safe pattern that avoids transitively importing `next-auth`)

**New search / compare logic:**
- Pure functions in `src/lib/search/{name}.ts`
- Export named functions (no default exports); expose types through `src/lib/search/types.ts` if consumed across modules
- Tests: `src/lib/search/__tests__/{name}.test.ts`

**New normalization step:**
- Module in `src/lib/normalization/{domain}.ts`
- Input: Wise types from `@/lib/wise/types`; output: canonical domain types + `{issues: ...}` tuple for fail-closed reporting
- Wire into `src/lib/sync/orchestrator.ts` between fetch and persist steps
- Tests: `src/lib/normalization/__tests__/{domain}.test.ts`

**New DB table / column:**
- Edit `src/lib/db/schema.ts` (Drizzle `pgTable` + `pgEnum` definitions)
- Run `npm run db:generate` — new SQL lands in `drizzle/000N_*.sql`
- Apply with `DATABASE_URL=... npm run db:migrate`
- If snapshot-scoped, include `snapshotId: uuid("snapshot_id").notNull().references(() => snapshots.id)` + `index("{tab}_snapshot_idx")`
- Update `src/lib/search/index.ts` `buildIndex()` if the new data needs to be loaded into the in-memory index

**New UI page:**
- Authenticated: `src/app/(app)/{route}/page.tsx` (inherits `AppNav`)
- Unauthenticated: `src/app/{route}/page.tsx` (outside `(app)` group; add to middleware allowlist if needed)
- Server-side data: create cached helper in `src/lib/data/{name}.ts` with `"use cache"` + `cacheTag("snapshot")`
- Suspense fallback: `src/app/{path}/loading.tsx` or wrap in `<Suspense fallback={...}>` inline

**New UI component:**
- Feature-local: `src/components/{feature}/{name}.tsx`
- Reusable primitive: add via `npx shadcn add {component}` (lands in `src/components/ui/`)
- Skeleton for suspense: `src/components/skeletons/{name}-skeleton.tsx`
- Use `"use client"` for interactive components; server-render by default when possible
- Use `cn()` from `@/lib/utils` for class merging; use `@/components/compare/session-colors` helpers for tutor/session styling

**New React hook:**
- `src/hooks/use-{name}.ts` with a `"use client"` directive at the top
- Follow `useCompare` pattern when adding cached async state (AbortController in `useRef`, cache in `useRef<Map>`, snapshot-mismatch recovery)

**New shared constant:**
- UPPER_SNAKE_CASE in the most specific module that needs it; lift to `src/components/compare/session-colors.ts` or `src/lib/search/types.ts` only when 2+ consumers appear
- Bump `src/lib/search/cache-version.ts` (`CACHE_VERSION`) whenever you change the shape of any client-cached server response (currently `CompareTutor`)

## Special Directories

**`(app)/` route group:**
- Purpose: Next.js App Router group that shares the `AppNav` layout without affecting the URL path
- Generated: No
- Committed: Yes
- Notes: The parentheses are route-group syntax, not a literal URL segment. Login page intentionally sits outside this group so it has no nav.

**`__tests__/`:**
- Purpose: Co-located Vitest test files
- Generated: No
- Committed: Yes
- Notes: Keep tests close to the module under test. The `data-health` route uses a separate `modality-counter.ts` helper specifically so Vitest can import it without pulling `next-auth`'s ESM subpath.

**`drizzle/`:**
- Purpose: Auto-generated SQL migrations + Drizzle journal metadata
- Generated: Yes (`npm run db:generate`)
- Committed: Yes
- Notes: Never edit generated SQL by hand. Edit `src/lib/db/schema.ts` and regenerate.

**`.next/`, `node_modules/`, `.vercel/`, `tsconfig.tsbuildinfo`:**
- Purpose: Build artifacts and dependency cache
- Generated: Yes
- Committed: No (gitignored)

**`.planning/`:**
- Purpose: GSD workflow artifacts
- Generated: Partial (`.planning/codebase/` is regenerated by `/gsd-map-codebase`; other subdirs are human-edited)
- Committed: Yes

**`.env.local`:**
- Purpose: Local-only secrets
- Committed: No (gitignored)
- Documented in: `.env.example` (9 required vars — see STACK.md)

---

*Structure analysis: 2026-04-21*
