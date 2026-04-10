# Codebase Structure

**Analysis Date:** 2026-04-10

## Directory Layout

```
Scheduling/
├── src/
│   ├── app/                          # Next.js App Router
│   │   ├── layout.tsx                # Root layout (fonts, html shell)
│   │   ├── page.tsx                  # Root redirect to /search
│   │   ├── globals.css               # Tailwind + CSS custom properties
│   │   ├── login/
│   │   │   └── page.tsx              # Google sign-in page
│   │   ├── (app)/                    # Route group with nav bar
│   │   │   ├── layout.tsx            # AppNav + main wrapper
│   │   │   ├── search/
│   │   │   │   └── page.tsx          # Side-by-side search + compare workspace
│   │   │   ├── compare/
│   │   │   │   └── page.tsx          # Redirect to /search (backward compat)
│   │   │   └── data-health/
│   │   │       └── page.tsx          # Sync status & data issues dashboard
│   │   └── api/
│   │       ├── auth/[...nextauth]/
│   │       │   └── route.ts          # Auth.js route handler
│   │       ├── search/
│   │       │   ├── route.ts          # Legacy slot-based search
│   │       │   └── range/
│   │       │       └── route.ts      # Range search (time window + duration)
│   │       ├── compare/
│   │       │   ├── route.ts          # Compare 1-3 tutors
│   │       │   └── discover/
│   │       │       └── route.ts      # Discover candidate tutors
│   │       ├── filters/
│   │       │   └── route.ts          # Subject/curriculum/level dropdowns
│   │       ├── tutors/
│   │       │   └── route.ts          # All tutor names/IDs for combobox
│   │       ├── data-health/
│   │       │   └── route.ts          # Sync status, issue counts
│   │       └── internal/
│   │           └── sync-wise/
│   │               └── route.ts      # Cron-triggered Wise sync
│   ├── components/
│   │   ├── compare/                  # Compare-view components
│   │   │   ├── calendar-grid.tsx     # Day drill-down with positioned blocks
│   │   │   ├── discovery-panel.tsx   # Advanced tutor discovery modal
│   │   │   ├── session-colors.ts     # Shared RGBA fills, borders, text colors
│   │   │   ├── tutor-combobox.tsx    # Searchable tutor dropdown
│   │   │   ├── tutor-profile-popover.tsx  # Tutor detail popover
│   │   │   ├── tutor-selector.tsx    # Color-coded tutor chips (max 3)
│   │   │   └── week-overview.tsx     # GCal-style weekly time grid
│   │   ├── data-health/             # Data health page components
│   │   ├── layout/
│   │   │   └── app-nav.tsx           # Persistent top navigation bar
│   │   ├── search/                   # Search-view components
│   │   │   ├── availability-grid.tsx # Tutor x sub-slot availability table
│   │   │   ├── copy-button.tsx       # Copy-for-parents button
│   │   │   ├── recent-searches.tsx   # localStorage-backed recent searches
│   │   │   ├── results-view.tsx      # Search results container
│   │   │   ├── slot-builder.tsx      # Search form builder
│   │   │   ├── slot-chips.tsx        # Slot tag display
│   │   │   └── slot-input.tsx        # Slot text input
│   │   └── ui/                       # shadcn/ui primitives
│   │       ├── badge.tsx
│   │       ├── button.tsx
│   │       ├── card.tsx
│   │       ├── command.tsx
│   │       ├── dialog.tsx
│   │       ├── input.tsx
│   │       ├── input-group.tsx
│   │       ├── popover.tsx
│   │       ├── select.tsx
│   │       ├── separator.tsx
│   │       ├── table.tsx
│   │       ├── tabs.tsx
│   │       └── textarea.tsx
│   ├── lib/
│   │   ├── auth.ts                   # NextAuth config (Google + admin allowlist)
│   │   ├── env.ts                    # Zod-validated environment variables
│   │   ├── utils.ts                  # cn() Tailwind merge helper
│   │   ├── db/
│   │   │   ├── index.ts              # Neon Postgres client singleton
│   │   │   ├── schema.ts             # 14 Drizzle ORM table definitions
│   │   │   └── seed.ts              # Admin users + alias seeding script
│   │   ├── normalization/
│   │   │   ├── identity.ts           # Tutor identity resolution (5-step cascade)
│   │   │   ├── availability.ts       # Working hours normalization
│   │   │   ├── leaves.ts             # Leave normalization (UTC->Bangkok)
│   │   │   ├── sessions.ts           # Session blocking classification
│   │   │   ├── qualifications.ts     # Tag parsing to subject/curriculum/level
│   │   │   ├── modality.ts           # Online/onsite derivation
│   │   │   ├── timezone.ts           # Asia/Bangkok timezone utilities
│   │   │   └── __tests__/            # Unit tests for each normalization module
│   │   │       ├── identity.test.ts
│   │   │       ├── availability.test.ts
│   │   │       ├── leaves.test.ts
│   │   │       ├── sessions.test.ts
│   │   │       ├── qualifications.test.ts
│   │   │       ├── modality.test.ts
│   │   │       └── timezone.test.ts
│   │   ├── search/
│   │   │   ├── index.ts              # In-memory search index singleton
│   │   │   ├── engine.ts             # Search execution logic
│   │   │   ├── compare.ts            # Compare engine (schedules, conflicts, free slots)
│   │   │   ├── parser.ts             # Free-text slot input parser
│   │   │   ├── types.ts              # All search/compare request/response types
│   │   │   └── __tests__/            # Unit tests for search modules
│   │   │       ├── engine.test.ts
│   │   │       ├── compare.test.ts
│   │   │       └── parser.test.ts
│   │   ├── sync/
│   │   │   ├── orchestrator.ts       # Full sync pipeline (fetch -> normalize -> persist -> promote)
│   │   │   └── __tests__/            # (empty -- orchestrator tested via integration)
│   │   └── wise/
│   │       ├── client.ts             # HTTP client with retry/backoff/concurrency
│   │       ├── fetchers.ts           # Domain-specific API fetchers
│   │       ├── types.ts              # Wise API response type definitions
│   │       └── __tests__/
│   │           ├── client.test.ts
│   │           └── fetchers.test.ts
│   └── middleware.ts                 # Auth gate (redirects unauthenticated users)
├── drizzle/                          # Generated migration files
│   └── meta/                         # Drizzle migration metadata
├── public/                           # Static assets
├── docs/                             # Documentation artifacts
│   └── superpowers/
│       ├── plans/
│       └── specs/
├── .planning/                        # GSD planning documents
│   └── codebase/                     # Codebase analysis (this file)
├── package.json                      # Dependencies and scripts
├── tsconfig.json                     # TypeScript configuration
├── next.config.ts                    # Next.js configuration (minimal)
├── drizzle.config.ts                 # Drizzle Kit migration config
├── vitest.config.ts                  # Vitest test runner config
├── vercel.json                       # Vercel cron schedule
├── eslint.config.mjs                 # ESLint configuration
├── postcss.config.mjs                # PostCSS (Tailwind)
├── components.json                   # shadcn/ui configuration
├── CLAUDE.md                         # Project instructions for Claude
├── AGENTS.md                         # Detailed system documentation
└── README.md                         # Project readme
```

## Directory Purposes

**`src/app/`:**
- Purpose: Next.js App Router pages and API routes
- Contains: Server components (layouts), client components (pages), route handlers
- Key files: `layout.tsx` (root), `(app)/layout.tsx` (nav wrapper), `(app)/search/page.tsx` (main workspace)

**`src/app/(app)/`:**
- Purpose: Route group for authenticated pages with shared navigation
- Contains: Pages that render with `AppNav` top bar
- Key files: `layout.tsx` wraps children with `<AppNav />` + `<main>`

**`src/app/api/`:**
- Purpose: Backend API endpoints consumed by frontend via `fetch()`
- Contains: Route handlers exporting `GET` or `POST` functions
- Key files: `compare/route.ts`, `search/range/route.ts`, `internal/sync-wise/route.ts`

**`src/components/`:**
- Purpose: Reusable React components organized by feature domain
- Contains: Client components (`"use client"` directive), one utility module (`session-colors.ts`)
- Key files: `compare/week-overview.tsx` (GCal grid), `search/availability-grid.tsx` (search results table)

**`src/components/ui/`:**
- Purpose: shadcn/ui design system primitives
- Contains: Low-level UI components (Button, Card, Dialog, etc.) using `class-variance-authority`
- Key files: All are generated/customized shadcn components. Do not modify unless updating the design system.

**`src/lib/`:**
- Purpose: Shared server-side business logic and utilities
- Contains: Domain modules organized by concern (db, normalization, search, sync, wise)
- Key files: `auth.ts`, `env.ts`, `utils.ts`

**`src/lib/normalization/`:**
- Purpose: Data transformation from Wise API formats to canonical internal representations
- Contains: Pure functions (no side effects, no DB access). Each module handles one normalization domain.
- Key files: `identity.ts` (most complex -- 5-step cascade resolution)

**`src/lib/search/`:**
- Purpose: In-memory search and compare engines
- Contains: Index builder, search executor, compare engine, input parser, shared types
- Key files: `index.ts` (singleton), `engine.ts` (search), `compare.ts` (compare), `types.ts` (all shared types)

**`src/lib/sync/`:**
- Purpose: ETL pipeline orchestration
- Contains: Single `orchestrator.ts` that wires together Wise client, normalization, and DB writes
- Key files: `orchestrator.ts` (~470 lines, single `runFullSync()` function)

**`src/lib/wise/`:**
- Purpose: Wise API client and type definitions
- Contains: HTTP client, domain fetchers, response types
- Key files: `client.ts` (WiseClient class), `fetchers.ts` (teacher/availability/session fetchers)

**`drizzle/`:**
- Purpose: Generated SQL migration files from Drizzle Kit
- Contains: SQL migration files and metadata JSON
- Generated: Yes (via `npm run db:generate`)
- Committed: Yes

## Key File Locations

**Entry Points:**
- `src/app/page.tsx`: Root redirect to `/search`
- `src/app/(app)/search/page.tsx`: Main application page (side-by-side search + compare)
- `src/app/api/internal/sync-wise/route.ts`: Cron-triggered sync endpoint
- `src/middleware.ts`: Auth gate for all routes

**Configuration:**
- `package.json`: Dependencies, scripts
- `next.config.ts`: Next.js config (currently minimal/empty)
- `drizzle.config.ts`: DB schema location and migration output
- `vitest.config.ts`: Test runner config
- `vercel.json`: Cron schedule (`0 0 * * *`)
- `components.json`: shadcn/ui component config
- `src/lib/env.ts`: Zod-validated environment variable schema

**Core Logic:**
- `src/lib/sync/orchestrator.ts`: Full sync pipeline
- `src/lib/search/index.ts`: In-memory index builder + singleton
- `src/lib/search/engine.ts`: Search execution
- `src/lib/search/compare.ts`: Compare engine
- `src/lib/normalization/identity.ts`: Identity resolution
- `src/lib/db/schema.ts`: All 14 database tables

**Types:**
- `src/lib/search/types.ts`: All search/compare request/response types (shared between API routes and frontend)
- `src/lib/wise/types.ts`: Wise API response shapes

**Testing:**
- `src/lib/normalization/__tests__/*.test.ts`: Normalization unit tests (7 files)
- `src/lib/search/__tests__/*.test.ts`: Search/compare unit tests (3 files)
- `src/lib/wise/__tests__/*.test.ts`: Wise client unit tests (2 files)

## Naming Conventions

**Files:**
- `kebab-case.ts` for all TypeScript files: `session-colors.ts`, `tutor-combobox.tsx`
- `kebab-case.test.ts` for test files: `identity.test.ts`, `compare.test.ts`
- `route.ts` for API route handlers (Next.js convention)
- `page.tsx` for page components (Next.js convention)
- `layout.tsx` for layout components (Next.js convention)

**Directories:**
- `kebab-case` for all directories: `data-health`, `sync-wise`
- `__tests__` for test directories (co-located with source)
- `(app)` route group for pages with shared layout
- `[...nextauth]` catch-all for auth routes

**Exports:**
- Named exports for functions and components: `export function AppNav()`, `export async function runFullSync()`
- Default exports only for Next.js page/layout components: `export default function SearchPage()`
- `PascalCase` for React components: `AppNav`, `CalendarGrid`, `WeekOverview`
- `camelCase` for functions: `ensureIndex`, `buildCompareTutor`, `detectConflicts`
- `UPPER_SNAKE_CASE` for constants: `TUTOR_COLORS`, `INSERT_CHUNK_SIZE`
- `PascalCase` for types/interfaces: `IndexedTutorGroup`, `CompareResponse`

## Where to Add New Code

**New API endpoint:**
- Create directory: `src/app/api/{resource}/`
- Add route handler: `src/app/api/{resource}/route.ts`
- Pattern: Export `GET` or `POST` function. Call `auth()` for auth check. Use `getDb()` for DB access. Use `ensureIndex(db)` for search index access. Validate input with Zod. Return `NextResponse.json()`.
- Example: `src/app/api/filters/route.ts` (simple GET), `src/app/api/compare/route.ts` (complex POST)

**New page:**
- Add to `src/app/(app)/{page-name}/page.tsx` to get the shared nav bar
- Use `"use client"` directive if the page needs interactivity
- Wrap with `<Suspense>` if using `useSearchParams()`

**New component:**
- Feature-specific: `src/components/{feature}/{component-name}.tsx`
- Shared UI primitive: `src/components/ui/{component-name}.tsx` (use `npx shadcn@latest add`)
- Use `"use client"` directive for interactive components

**New normalization module:**
- Add to `src/lib/normalization/{domain}.ts`
- Add tests to `src/lib/normalization/__tests__/{domain}.test.ts`
- Wire into `src/lib/sync/orchestrator.ts` `runFullSync()` function

**New search capability:**
- Types: Add to `src/lib/search/types.ts`
- Logic: Add to `src/lib/search/engine.ts` or `src/lib/search/compare.ts`
- Tests: Add to `src/lib/search/__tests__/`
- Expose via new or existing API route in `src/app/api/`

**New database table:**
- Define in `src/lib/db/schema.ts`
- Run `npm run db:generate` to create migration
- Run `npm run db:migrate` to apply
- Add snapshot-scoped `snapshotId` foreign key if the data is part of the sync pipeline

**New Wise API integration:**
- Types: Add to `src/lib/wise/types.ts`
- Fetcher: Add to `src/lib/wise/fetchers.ts`
- Tests: Add to `src/lib/wise/__tests__/fetchers.test.ts`

**Utilities:**
- Shared helpers: `src/lib/utils.ts` (currently only `cn()` for Tailwind)
- Timezone utilities: `src/lib/normalization/timezone.ts`

## Special Directories

**`drizzle/`:**
- Purpose: Generated SQL migration files
- Generated: Yes (via `npm run db:generate`)
- Committed: Yes -- migrations are version-controlled

**`public/`:**
- Purpose: Static assets served at root URL
- Generated: No
- Committed: Yes

**`.next/`:**
- Purpose: Next.js build output
- Generated: Yes
- Committed: No (in `.gitignore`)

**`.vercel/`:**
- Purpose: Vercel project linking
- Generated: Yes (via `vercel link`)
- Committed: No (in `.gitignore`)

**`.planning/`:**
- Purpose: GSD planning and codebase analysis documents
- Generated: Yes (by GSD tools)
- Committed: Yes

---

*Structure analysis: 2026-04-10*
