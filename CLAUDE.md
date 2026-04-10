@AGENTS.md

## Quick Reference

- **Production URL**: https://bgscheduler.vercel.app
- **Repo**: https://github.com/kasheesh711/bgscheduler
- **Database**: Neon Postgres (ap-southeast-1)
- **Wise API**: https://api.wiseapp.live
- **Wise namespace**: `begifted-education`
- **Wise institute**: `696e1f4d90102225641cc413`

## Current Status

Production sync is live. First successful sync completed 2026-04-07 (commit `c673999`), promoting snapshot `d70608b0` with 131 teachers and 72 identity groups. Daily cron runs at midnight UTC.

UX/UI refresh v2 deployed 2026-04-08 (commits `38b4688`–`b11734d`): side-by-side layout (search left, compare right), sky blue palette, Inter font, GCal-style week view, searchable tutor combobox, discovery modal. `/compare` redirects to `/search`.

Week view QA fixes deployed 2026-04-08: GCal-style overlap detection (sub-columns for overlapping sessions), consistent card styling (28% bg opacity, solid borders), sticky day headers with vertical scrolling.

Compare calendar v3 deployed 2026-04-08 (commits `c52deb8`–`9c6d637`): week picker with date-range session filtering (prev/next arrows, Today button, dated day tabs), sub-column cap (max 3 single-tutor / 2 multi-tutor with "+N more" overflow badges), improved card readability for narrow sub-columns.

Compare calendar v3.1 deployed 2026-04-08 (commit `f689edb`): weekday fallback for missing session data (past days pull nearest future occurrence), free-gap availability indicators (green tint only where tutor is available with no session), D/M date format throughout.

Compare performance v4 deployed 2026-04-08 (commit `f4cd925`): client-side tutor cache with incremental fetch. Adding a tutor only fetches the new tutor's schedule (`fetchOnly` param); removing a tutor reuses cached data and only recomputes conflicts/free-slots server-side. AbortController for request cancellation, automatic cache invalidation on snapshot change.

### Known Issues (open)
- **Online/onsite detection heuristic**: uses `location` field pattern matching (http/online/learn./zoom/meet.google/virtual). Most sessions have venue names like "Think Outside the Box", "Tesla", "Nerd" which don't match → all treated as onsite. Needs a more reliable data source (possibly `sessionType` from Wise or the `isOnlineVariant` flag on the tutor's underlying Wise records). Visual distinction (dashed vs solid border) removed from cards pending reliable detection; modality info still shown in popover.
- **Past-day session data**: Wise's `status: "FUTURE"` API does not return past sessions. For days earlier than the last sync, the compare view shows the nearest future occurrence of recurring sessions as a representative. One-time past sessions cannot be recovered.

## Running Commands

```bash
# Deploy to production
npx vercel --prod

# Run tests
npm test

# Generate migrations
npm run db:generate

# Run migrations
DATABASE_URL=... npm run db:migrate

# Seed data
DATABASE_URL=... SEED_ADMIN_EMAILS=email1,email2 npm run db:seed

# Trigger sync manually
curl -X POST https://bgscheduler.vercel.app/api/internal/sync-wise \
  -H "Authorization: Bearer $CRON_SECRET"
```

<!-- GSD:project-start source:PROJECT.md -->
## Project

**BGScheduler — Performance & UX Improvement**

A performance and UX overhaul of the existing BGScheduler tutor scheduling tool (bgscheduler.vercel.app). The goal is to make data loading near-instant across all views, streamline the search-to-compare workflow into a seamless experience with fewer clicks, and improve calendar readability when multiple tutors are displayed — all without regressing any current functionality. The primary users are non-technical admin staff who need to self-serve tutor comparisons without asking for help.

**Core Value:** Admin staff can find, compare, and schedule tutors instantly and independently — no waiting, no confusion, no handholding.

### Constraints

- **Stack**: No stack changes — Next.js 16, Tailwind, shadcn/ui, Drizzle, Neon Postgres
- **Deployment**: Vercel Hobby plan (daily cron, 300s function timeout)
- **Data integrity**: Fail-closed safety rules are non-negotiable
- **Visual**: Keep GCal-style calendar grid and sky blue color palette
- **Regression**: All 82 existing tests must continue to pass
<!-- GSD:project-end -->

<!-- GSD:stack-start source:codebase/STACK.md -->
## Technology Stack

## Languages
- TypeScript ^5.9.3 - All application code (`src/**/*.ts`, `src/**/*.tsx`)
- SQL (PostgreSQL) - Database schema via Drizzle ORM migrations (`drizzle/`)
## Runtime
- Node.js (no `.nvmrc` detected; target ES2017 in `tsconfig.json`)
- Vercel Serverless Functions (max 300s duration configured in `src/app/api/internal/sync-wise/route.ts`)
- npm
- Lockfile: `package-lock.json` present
## Frameworks
- Next.js 16.2.2 - App Router, full-stack framework
- React 19.2.4 - UI rendering
- React DOM 19.2.4 - Browser rendering
- Vitest ^4.1.2 - Unit test runner, node environment, globals enabled
- Config: `vitest.config.ts`
- Tailwind CSS ^4 - Utility-first CSS (via `@tailwindcss/postcss` plugin)
- PostCSS - CSS processing (`postcss.config.mjs`)
- ESLint ^9 - Linting with `eslint-config-next` 16.2.2 (core-web-vitals + typescript presets)
- TypeScript ^5.9.3 - Type checking (`tsconfig.json`, strict mode, bundler module resolution)
## Key Dependencies
- `next-auth` ^5.0.0-beta.30 - Authentication (Auth.js v5 beta with Google provider)
- `drizzle-orm` ^0.45.2 - Type-safe ORM for PostgreSQL
- `@neondatabase/serverless` ^1.0.2 - Neon serverless Postgres driver (HTTP mode)
- `zod` ^4.3.6 - Runtime schema validation
- `drizzle-kit` ^0.31.10 - Schema migrations and generation
- `tsx` (implicit via `db:seed` script) - TypeScript execution for seed scripts
- `shadcn` ^4.1.2 - Component library (uses Radix primitives under the hood)
- `@base-ui/react` ^1.3.0 - Base UI primitives
- `cmdk` ^1.1.1 - Command palette / searchable combobox
- `lucide-react` ^1.7.0 - Icon library
- `class-variance-authority` ^0.7.1 - Variant-based component styling
- `clsx` ^2.1.1 - Conditional className utility
- `tailwind-merge` ^3.5.0 - Tailwind class deduplication
- `tw-animate-css` ^1.4.0 - Tailwind animation utilities
- `date-fns` ^4.1.0 - Date manipulation
- `date-fns-tz` ^3.2.0 - Timezone-aware date operations (Asia/Bangkok)
- `uuid` ^13.0.0 - UUID generation
## Configuration
- `tsconfig.json`: strict mode, ES2017 target, bundler moduleResolution
- Path alias: `@/*` maps to `./src/*`
- `.env.example` documents 9 required variables (see INTEGRATIONS.md)
- `.env.local` present (gitignored, contains local secrets)
- Variables loaded via `process.env.*` at runtime
- `next.config.ts`: Default configuration (no custom settings)
- `postcss.config.mjs`: `@tailwindcss/postcss` plugin only
- `eslint.config.mjs`: Flat config with core-web-vitals + typescript presets
- `drizzle.config.ts`: PostgreSQL dialect, schema at `./src/lib/db/schema.ts`, migrations output to `./drizzle/`
## NPM Scripts
## Platform Requirements
- Node.js (ES2017+ compatible)
- npm
- PostgreSQL connection (Neon or local)
- Google OAuth credentials for auth testing
- Vercel (Hobby plan, daily cron; Pro plan for 30-min cron)
- Neon Postgres (ap-southeast-1 region)
- Vercel Cron for scheduled sync
- Vercel Serverless Functions (300s max duration for sync endpoint)
<!-- GSD:stack-end -->

<!-- GSD:conventions-start source:CONVENTIONS.md -->
## Conventions

## Naming Patterns
- kebab-case for all files: `session-colors.ts`, `week-overview.tsx`, `app-nav.tsx`, `copy-button.tsx`
- React components use `.tsx`, logic/types use `.ts`
- Test files: `{module}.test.ts` inside `__tests__/` directories
- Schema file: `schema.ts` (singular)
- Type definition files: `types.ts` (per module)
- camelCase for all functions: `executeSearch`, `buildCompareTutor`, `detectConflicts`, `normalizeWorkingHours`
- Prefix `get` for getters: `getDb()`, `getEnv()`, `getBaseName()`, `getWiseTeacherDisplayName()`
- Prefix `is`/`has` for boolean returns: `isBlockingStatus()`, `isOnlineVariant()`
- Prefix `make`/`create` for factory functions: `createWiseClient()`, `createDb()`
- Prefix `parse`/`normalize` for data transformation: `parseTimeToMinutes()`, `normalizeLeaves()`, `normalizeTag()`
- Prefix `fetch` for API calls: `fetchAllTeachers()`, `fetchAllFutureSessions()`
- camelCase: `snapshotMeta`, `tutorGroupIds`, `sessionBlocks`
- UPPER_SNAKE_CASE for constants: `TUTOR_COLORS`, `HOUR_HEIGHT`, `DAY_NAMES`, `DISPLAY_DAYS`, `ONLINE_SESSION_TYPES`
- Prefix `_` for module-level singletons: `let _db`, `let _cachedIndex`
- PascalCase: `SearchRequest`, `CompareTutor`, `IndexedTutorGroup`
- Prefix `Wise` for external API types: `WiseTeacher`, `WiseSession`, `WiseAvailabilityResponse`
- Prefix `Indexed` for in-memory index types: `IndexedTutorGroup`, `IndexedSessionBlock`
- Prefix `Normalized` for pipeline output types: `NormalizedSessionBlock`
- Use `interface` for object shapes, `type` for unions/aliases: `type SearchMode = "recurring" | "one_time"`, `type WiseTag = string | WiseTagObject`
- Enums defined via Drizzle `pgEnum`, not TypeScript `enum`
- snake_case for table/column names: `tutor_identity_groups`, `snapshot_id`, `created_at`
- camelCase for Drizzle schema object names: `tutorIdentityGroups`, `snapshotId`
## Code Style
- No dedicated formatter config (no `.prettierrc`). Relies on editor defaults.
- 2-space indentation
- Double quotes for strings in most files; some shadcn/ui components omit semicolons
- Trailing commas in multi-line structures
- Template literals for string interpolation
- ESLint 9 with flat config at `eslint.config.mjs`
- Extends `eslint-config-next/core-web-vitals` and `eslint-config-next/typescript`
- No custom rules added beyond Next.js defaults
- `strict: true` in `tsconfig.json`
- Target ES2017, module esnext, bundler resolution
- Non-null assertions used sparingly (e.g., `this.queue.shift()!`)
- Path alias: `@/*` maps to `./src/*`
## Import Organization
- `@/*` -> `./src/*` (configured in both `tsconfig.json` and `vitest.config.ts`)
## Error Handling
- Auth check first, return 401 if unauthorized
- Parse JSON body in try/catch, return 400 for invalid JSON
- Validate with Zod `.safeParse()`, return 400 with flattened errors on failure
- Wrap business logic in try/catch, return 500 with error message
- Pattern: `const message = err instanceof Error ? err.message : "Compare failed"`
- Unknown session status -> blocking (safe default)
- Unresolved identity/modality/qualification -> route to "Needs Review", never "Available"
- Missing env vars -> throw at startup via Zod validation in `src/lib/env.ts`
- Retry with exponential backoff: 1s, 2s, 4s (configurable `maxRetries`)
- Concurrency limiter (max 5 default, 15 for production sync)
- Errors re-thrown after max retries exhausted
## Validation
- Use Zod schemas at API route boundaries
- Schema defined as `const` at module scope, above the handler
- Transform strings to numbers where needed: `.transform(Number)`
- `.safeParse()` pattern (never `.parse()` which throws)
- Centralized in `src/lib/env.ts` using Zod schema
- Validates all 9 required env vars at startup
- Defaults provided for `WISE_NAMESPACE` and `WISE_INSTITUTE_ID`
## Logging
- `console.error()` for validation failures and caught errors
- No request logging middleware
- Sync orchestrator likely logs progress (not examined in detail)
## Comments
- JSDoc `/** */` for exported public functions with brief description
- Section headers using `// -- Section Name --` pattern with em-dash decorations
- Inline comments for non-obvious logic (e.g., `// shift to Monday`, `// fail-closed`)
- Type comments on interface fields: `dayOfWeek?: number; // 0=Sunday..6=Saturday`
## Function Design
- Use destructured objects for 3+ params
- Optional params via `?` property or default values: `staleThresholdMs: number = 35 * 60 * 1000`
- Factory functions accept config objects: `WiseClientConfig`
- Return typed objects, never raw primitives for complex operations
- Tuples of `{ result, issues }` for normalization functions: `{ modality, issue }`, `{ qualifications, issues }`
- Nullable returns use `| null` (not undefined): `extractNickname() -> string | null`
## Module Design
- Named exports only (no default exports except page components)
- Page components: `export default function SearchPage()`
- Re-export types from central `types.ts` files
- Helper functions exported individually, not via barrel
- Not used. Each module imports directly from the specific file.
- Lazy initialization pattern for DB and search index
- Module-level `let _db` with `getDb()` accessor
- `ensureIndex(db)` checks staleness and rebuilds if needed
## Component Patterns
- Located in `src/components/ui/`
- Use `class-variance-authority` (CVA) for variant styling
- Use `cn()` utility from `src/lib/utils.ts` for class merging
- Wrap `@base-ui/react` primitives with project styling
- Export both component and variants: `export { Button, buttonVariants }`
- Located in `src/components/{feature}/` (e.g., `compare/`, `search/`, `layout/`)
- `"use client"` directive at top of interactive components
- Props typed inline or via imported interfaces
- Constants defined above component (e.g., `HOUR_HEIGHT`, `START_HOUR`)
- Helper functions defined in same file above component
- `"use client"` with Suspense wrapper for pages using `useSearchParams`
- Inner component pattern: `SearchPage` wraps `SearchPageInner` in Suspense
- State management via `useState`/`useCallback`/`useRef` hooks
- No external state management library
- Tailwind CSS 4 utility classes inline
- Semantic color tokens via CSS custom properties: `--available`, `--blocked`, `--conflict`
- OKLCH color space for palette definition
- Template literal for conditional classes: `` `${isActive ? "text-primary" : "text-muted-foreground"}` ``
- Shared color logic in dedicated modules: `src/components/compare/session-colors.ts`
<!-- GSD:conventions-end -->

<!-- GSD:architecture-start source:ARCHITECTURE.md -->
## Architecture

## Pattern Overview
- **Snapshot-based data model** -- all tutor data is versioned under a `snapshot_id`. The active snapshot is atomically promoted after a successful sync. Failed syncs preserve the previous active snapshot.
- **In-memory search index singleton** -- the entire active snapshot is loaded into a `SearchIndex` object in server memory. All search and compare queries run against this index with no additional DB queries. Stale detection triggers a rebuild when the active snapshot changes.
- **ETL pipeline** -- a sync orchestrator fetches from the Wise API, normalizes data through six domain-specific modules, writes to Postgres, and promotes a new snapshot.
- **Fail-closed safety** -- unresolved identity, modality, or qualification data routes tutors to "Needs Review", never "Available".
## Layers
- Purpose: HTTP communication with the Wise scheduling platform
- Location: `src/lib/wise/`
- Contains: `client.ts` (HTTP client with retry/backoff/concurrency), `fetchers.ts` (domain fetchers for teachers, availability, sessions), `types.ts` (Wise API response shapes)
- Depends on: Nothing internal (pure HTTP + env vars)
- Used by: Sync orchestrator
- Purpose: Transform raw Wise API data into canonical internal representations
- Location: `src/lib/normalization/`
- Contains: `identity.ts` (tutor identity resolution with 5-step cascade), `availability.ts` (working hours normalization), `leaves.ts` (leave normalization with UTC-to-Bangkok conversion), `sessions.ts` (session blocking classification), `qualifications.ts` (tag parsing into subject/curriculum/level), `modality.ts` (online/onsite derivation), `timezone.ts` (Asia/Bangkok timezone utilities)
- Depends on: Wise types
- Used by: Sync orchestrator
- Purpose: Full ETL pipeline -- fetch, normalize, persist, validate, promote
- Location: `src/lib/sync/orchestrator.ts`
- Contains: `runFullSync()` function (single entry point for the entire pipeline)
- Depends on: Wise client, all normalization modules, DB layer
- Used by: `POST /api/internal/sync-wise` route handler
- Purpose: Postgres connection and schema definition
- Location: `src/lib/db/`
- Contains: `index.ts` (Neon serverless client singleton via `getDb()`), `schema.ts` (14 Drizzle ORM table definitions), `seed.ts` (admin user and alias seeding)
- Depends on: `@neondatabase/serverless`, `drizzle-orm`
- Used by: All server-side code (sync, search index, API routes, auth)
- Purpose: In-memory data structure for fast query execution
- Location: `src/lib/search/index.ts`
- Contains: Module-level singleton (`currentIndex`), `buildIndex()` (loads entire snapshot into memory with parallel DB queries), `ensureIndex()` (lazy init with stale detection), indexed data structures (`IndexedTutorGroup`, `SearchIndex`)
- Depends on: DB layer, schema
- Used by: Search engine, compare engine, API routes (filters, tutors)
- Purpose: Execute availability searches against the in-memory index
- Location: `src/lib/search/engine.ts`
- Contains: `executeSearch()` (slot-based search with recurring/one-time modes), blocking checks (sessions, leaves), qualification/modality filtering, multi-slot intersection
- Depends on: Search index, normalization/timezone
- Used by: `POST /api/search`, `POST /api/search/range`
- Purpose: Build side-by-side tutor schedules, detect conflicts, find shared free slots
- Location: `src/lib/search/compare.ts`
- Contains: `buildCompareTutor()` (date-range filtered schedule assembly with weekday fallback), `detectConflicts()` (same-student overlap detection), `findSharedFreeSlots()` (interval intersection across tutors)
- Depends on: Search index types
- Used by: `POST /api/compare`, `POST /api/compare/discover`
- Purpose: HTTP endpoints consumed by the frontend
- Location: `src/app/api/`
- Contains: Route handlers using Next.js App Router conventions
- Depends on: Auth, DB, search index, search engine, compare engine
- Used by: Frontend client components
- Purpose: Admin UI for searching and comparing tutor availability
- Location: `src/app/(app)/` (pages), `src/components/` (reusable components)
- Contains: Client components with `"use client"` directive, shadcn/ui primitives
- Depends on: API routes (via `fetch`), search types (shared type imports)
- Used by: End users (admin staff)
## Data Flow
- **Server state**: Module-level singleton `currentIndex` in `src/lib/search/index.ts`. Rebuilt lazily when active snapshot changes.
- **Client state**: React `useState` in `src/app/(app)/search/page.tsx`. Client-side tutor cache (`Map<string, CompareTutor>`) keyed by `tutorGroupId:weekStart` with incremental fetch. AbortController for request cancellation.
- **Persistent client state**: Recent searches in `localStorage` (last 10).
## Key Abstractions
- Purpose: Versioned point-in-time capture of all tutor data
- Examples: `src/lib/db/schema.ts` (table definition), `src/lib/sync/orchestrator.ts` (creation/promotion)
- Pattern: Only one snapshot is `active = true` at a time. All data tables reference a `snapshotId`.
- Purpose: In-memory representation of a tutor with all associated data (qualifications, availability, sessions, leaves, issues)
- Examples: `src/lib/search/index.ts` (interface + build logic)
- Pattern: Denormalized aggregate loaded once, queried many times. The `byWeekday` map provides O(1) weekday lookup.
- Purpose: Logical grouping of multiple Wise teacher records that represent the same real person (e.g. online + onsite variants)
- Examples: `src/lib/normalization/identity.ts` (`IdentityGroup` interface), `src/lib/db/schema.ts` (`tutorIdentityGroups` + `tutorIdentityGroupMembers` tables)
- Pattern: 5-step cascade resolution: nickname extraction -> alias table lookup -> online/offline pair detection -> unresolved -> data_issue
- Purpose: Rate-limited, retry-capable HTTP client for the Wise API
- Examples: `src/lib/wise/client.ts`
- Pattern: Queue-based concurrency limiter (max 5 or 15 concurrent), exponential backoff (1s/2s/4s), Basic Auth + API key headers
## Entry Points
- Location: `src/app/page.tsx`
- Triggers: User navigates to `/`
- Responsibilities: Redirects to `/search`
- Location: `src/app/(app)/search/page.tsx`
- Triggers: User navigates to `/search`
- Responsibilities: Renders the side-by-side search + compare workspace. Client component with `"use client"` directive. All data fetching via `fetch()` to API routes.
- Location: `src/app/api/internal/sync-wise/route.ts`
- Triggers: Vercel cron (daily at midnight UTC) or manual `curl` with CRON_SECRET
- Responsibilities: Runs the full sync pipeline. `maxDuration = 300` (5 minutes).
- Location: `src/middleware.ts`
- Triggers: Every request (except static assets)
- Responsibilities: Auth gate. Allows `/login`, `/api/auth/*`, `/api/internal/*` without auth. Redirects unauthenticated users to `/login`.
## Error Handling
- **Sync errors**: Per-teacher errors are caught and logged as `data_issues` without aborting the entire sync. Top-level sync errors mark the sync run as `failed` and preserve the previous active snapshot. (`src/lib/sync/orchestrator.ts` lines 239-249, 443-468)
- **API route errors**: All route handlers wrap logic in try-catch, return `{ error: string }` with appropriate HTTP status codes (400, 401, 404, 500). Zod schema validation with `.safeParse()` returns 400 with flattened error details. (`src/app/api/compare/route.ts` lines 53-65)
- **Search index staleness**: `ensureIndex()` checks active snapshot on every call. Stale data is flagged in response `warnings` array and `snapshotMeta.stale` boolean. (`src/lib/search/index.ts` lines 252-274)
- **Data integrity**: Unresolved identity/modality/qualification routes tutors to "Needs Review" rather than silently omitting them. Cancelled sessions are explicitly non-blocking. Unknown session statuses are blocking (fail-closed). (`src/lib/search/engine.ts` lines 83-93)
## Cross-Cutting Concerns
<!-- GSD:architecture-end -->

<!-- GSD:skills-start source:skills/ -->
## Project Skills

No project skills found. Add skills to any of: `.claude/skills/`, `.agents/skills/`, `.cursor/skills/`, or `.github/skills/` with a `SKILL.md` index file.
<!-- GSD:skills-end -->

<!-- GSD:workflow-start source:GSD defaults -->
## GSD Workflow Enforcement

Before using Edit, Write, or other file-changing tools, start work through a GSD command so planning artifacts and execution context stay in sync.

Use these entry points:
- `/gsd-quick` for small fixes, doc updates, and ad-hoc tasks
- `/gsd-debug` for investigation and bug fixing
- `/gsd-execute-phase` for planned phase work

Do not make direct repo edits outside a GSD workflow unless the user explicitly asks to bypass it.
<!-- GSD:workflow-end -->

<!-- GSD:profile-start -->
## Developer Profile

> Profile not yet configured. Run `/gsd-profile-user` to generate your developer profile.
> This section is managed by `generate-claude-profile` -- do not edit manually.
<!-- GSD:profile-end -->
