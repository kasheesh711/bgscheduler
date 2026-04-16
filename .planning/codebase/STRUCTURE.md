# Codebase Structure

**Analysis Date:** 2026-04-16

## Directory Layout

```
Scheduling/
├── src/
│   ├── app/                              # Next.js App Router
│   │   ├── layout.tsx                    # Root layout (fonts, html shell)
│   │   ├── page.tsx                      # Root redirect to /search
│   │   ├── globals.css                   # Tailwind + CSS custom properties
│   │   ├── favicon.ico
│   │   ├── login/
│   │   │   └── page.tsx                  # Google sign-in page
│   │   ├── (app)/                        # Route group (shared AppNav layout)
│   │   │   ├── layout.tsx                # AppNav + main wrapper
│   │   │   ├── search/
│   │   │   │   ├── page.tsx              # Side-by-side search + compare workspace
│   │   │   │   └── loading.tsx           # Search page loading skeleton
│   │   │   ├── compare/
│   │   │   │   └── page.tsx              # Redirect to /search (backward compat)
│   │   │   └── data-health/
│   │   │       └── page.tsx              # Sync status + data issues dashboard
│   │   └── api/
│   │       ├── auth/
│   │       │   └── [...nextauth]/
│   │       │       └── route.ts          # Auth.js catch-all handler
│   │       ├── search/
│   │       │   ├── route.ts              # POST: slot-based search
│   │       │   └── range/
│   │       │       └── route.ts          # POST: range search with sub-slots
│   │       ├── compare/
│   │       │   ├── route.ts              # POST: compare 1-3 tutors
│   │       │   └── discover/
│   │       │       └── route.ts          # POST: find candidate tutors
│   │       ├── filters/
│   │       │   └── route.ts              # GET: dropdown filter options
│   │       ├── tutors/
│   │       │   └── route.ts              # GET: all tutor names/IDs
│   │       ├── data-health/
│   │       │   └── route.ts              # GET: sync status + issue counts
│   │       └── internal/
│   │           └── sync-wise/
│   │               └── route.ts          # POST: cron-triggered full sync
│   ├── components/
│   │   ├── compare/                      # Compare panel components
│   │   │   ├── calendar-grid.tsx         # GCal-style weekly time grid
│   │   │   ├── compare-panel.tsx         # Right panel container
│   │   │   ├── discovery-panel.tsx       # "Advanced search" modal content
│   │   │   ├── session-colors.ts         # Shared color logic (RGBA fills, borders)
│   │   │   ├── tutor-combobox.tsx        # Searchable tutor dropdown (cmdk)
│   │   │   ├── tutor-profile-popover.tsx # Tutor detail popover
│   │   │   ├── tutor-selector.tsx        # Color-coded tutor chips (max 3)
│   │   │   ├── week-calendar.tsx         # Month-grid date picker popup
│   │   │   └── week-overview.tsx         # Week view with free-gap indicators
│   │   ├── search/                       # Search panel components
│   │   │   ├── availability-grid.tsx     # Table-based availability results
│   │   │   ├── copy-button.tsx           # Copy-for-parents clipboard button
│   │   │   ├── recent-searches.tsx       # localStorage recent search list
│   │   │   ├── results-view.tsx          # Search results container
│   │   │   ├── search-form.tsx           # Compact 3-column search form
│   │   │   ├── search-results.tsx        # Results with Needs Review section
│   │   │   ├── search-workspace.tsx      # Left panel orchestrator
│   │   │   ├── slot-builder.tsx          # Multi-slot search builder
│   │   │   ├── slot-chips.tsx            # Visual slot tag display
│   │   │   └── slot-input.tsx            # Time slot input controls
│   │   ├── layout/
│   │   │   └── app-nav.tsx               # Top navigation bar
│   │   ├── skeletons/
│   │   │   ├── calendar-skeleton.tsx     # Compare panel loading state
│   │   │   ├── form-skeleton.tsx         # Search form loading state
│   │   │   └── search-skeleton.tsx       # Full search page loading state
│   │   └── ui/                           # shadcn/ui primitives
│   │       ├── badge.tsx
│   │       ├── button.tsx
│   │       ├── card.tsx
│   │       ├── command.tsx               # cmdk-based command palette
│   │       ├── dialog.tsx
│   │       ├── input-group.tsx
│   │       ├── input.tsx
│   │       ├── popover.tsx
│   │       ├── select.tsx
│   │       ├── separator.tsx
│   │       ├── table.tsx
│   │       ├── tabs.tsx
│   │       └── textarea.tsx
│   ├── hooks/
│   │   └── use-compare.ts                # Compare state + cache management hook
│   ├── lib/
│   │   ├── auth.ts                       # Auth.js config (Google provider + allowlist)
│   │   ├── env.ts                        # Zod env var validation (9 vars)
│   │   ├── utils.ts                      # cn() class merge utility
│   │   ├── data/
│   │   │   ├── filters.ts                # Cached filter options ("use cache")
│   │   │   └── tutors.ts                 # Cached tutor list ("use cache")
│   │   ├── db/
│   │   │   ├── index.ts                  # Neon serverless singleton (getDb)
│   │   │   ├── schema.ts                 # 14 Drizzle table definitions + 4 enums
│   │   │   └── seed.ts                   # Admin users + alias seeding
│   │   ├── normalization/
│   │   │   ├── identity.ts               # 5-step identity resolution cascade
│   │   │   ├── availability.ts           # Working hours normalization
│   │   │   ├── leaves.ts                 # Leave normalization (UTC->Bangkok)
│   │   │   ├── sessions.ts              # Session blocking classification
│   │   │   ├── qualifications.ts         # Tag parsing (subject/curriculum/level)
│   │   │   ├── modality.ts               # Online/onsite derivation
│   │   │   ├── timezone.ts               # Asia/Bangkok conversion utilities
│   │   │   └── __tests__/
│   │   │       ├── identity.test.ts
│   │   │       ├── availability.test.ts
│   │   │       ├── leaves.test.ts
│   │   │       ├── sessions.test.ts
│   │   │       ├── modality.test.ts
│   │   │       ├── qualifications.test.ts
│   │   │       └── timezone.test.ts
│   │   ├── search/
│   │   │   ├── index.ts                  # In-memory SearchIndex singleton
│   │   │   ├── engine.ts                 # Availability search execution
│   │   │   ├── compare.ts                # Compare engine (schedule, conflicts, free slots)
│   │   │   ├── parser.ts                 # Natural language slot parser
│   │   │   ├── types.ts                  # All search/compare type definitions
│   │   │   └── __tests__/
│   │   │       ├── engine.test.ts
│   │   │       ├── compare.test.ts
│   │   │       └── parser.test.ts
│   │   ├── sync/
│   │   │   └── orchestrator.ts           # Full ETL pipeline (runFullSync)
│   │   └── wise/
│   │       ├── client.ts                 # WiseClient class (retry, concurrency)
│   │       ├── fetchers.ts               # Domain-specific API fetchers
│   │       ├── types.ts                  # Wise API type definitions
│   │       └── __tests__/
│   │           ├── client.test.ts
│   │           └── fetchers.test.ts
│   └── middleware.ts                     # Auth gate (session check + redirects)
├── drizzle/                              # Database migrations
│   ├── 0000_tidy_black_bolt.sql          # Initial schema migration
│   ├── 0001_tough_plazm.sql              # Second migration
│   └── meta/
│       ├── 0000_snapshot.json
│       ├── 0001_snapshot.json
│       └── _journal.json
├── .planning/                            # Project planning artifacts
│   ├── PROJECT.md
│   ├── REQUIREMENTS.md
│   ├── ROADMAP.md
│   ├── STATE.md
│   ├── config.json
│   ├── codebase/                         # Auto-generated codebase docs
│   │   ├── ARCHITECTURE.md
│   │   ├── CONCERNS.md
│   │   ├── CONVENTIONS.md
│   │   ├── INTEGRATIONS.md
│   │   ├── STACK.md
│   │   ├── STRUCTURE.md
│   │   └── TESTING.md
│   ├── phases/                           # Phase planning directories
│   └── research/                         # Research artifacts
├── CLAUDE.md                             # Claude Code project instructions
├── AGENTS.md                             # Agent behavior instructions
├── drizzle.config.ts                     # Drizzle Kit config (schema + output paths)
├── eslint.config.mjs                     # ESLint 9 flat config
├── next.config.ts                        # Next.js config (default)
├── package.json
├── package-lock.json
├── postcss.config.mjs                    # Tailwind PostCSS plugin
├── tsconfig.json                         # TypeScript strict config
└── vitest.config.ts                      # Vitest config (node env, globals)
```

## Key File Locations

### Configuration Files

| File | Purpose |
|------|---------|
| `tsconfig.json` | TypeScript: strict, ES2017 target, bundler resolution, `@/*` -> `./src/*` |
| `next.config.ts` | Next.js: default config (no custom settings) |
| `drizzle.config.ts` | Drizzle Kit: PostgreSQL dialect, schema at `./src/lib/db/schema.ts`, output `./drizzle/` |
| `vitest.config.ts` | Vitest: node environment, globals enabled, `@/*` path alias |
| `postcss.config.mjs` | PostCSS: `@tailwindcss/postcss` plugin only |
| `eslint.config.mjs` | ESLint 9: flat config, core-web-vitals + typescript presets |
| `src/lib/env.ts` | Runtime env validation: 9 vars via Zod schema |

### Core Business Logic

| File | Purpose |
|------|---------|
| `src/lib/sync/orchestrator.ts` | Full ETL pipeline entry point (`runFullSync`) |
| `src/lib/search/index.ts` | In-memory index singleton (`buildIndex`, `ensureIndex`) |
| `src/lib/search/engine.ts` | Availability search execution (`executeSearch`) |
| `src/lib/search/compare.ts` | Compare engine (`buildCompareTutor`, `detectConflicts`, `findSharedFreeSlots`) |
| `src/lib/search/types.ts` | All search/compare TypeScript type definitions |
| `src/lib/db/schema.ts` | Database schema (14 tables, 4 enums) |
| `src/lib/auth.ts` | Auth.js config (Google provider, admin allowlist callback) |

### Normalization Modules

| File | Purpose |
|------|---------|
| `src/lib/normalization/identity.ts` | Teacher identity resolution (5-step cascade) |
| `src/lib/normalization/availability.ts` | Working hours normalization |
| `src/lib/normalization/leaves.ts` | Leave normalization (UTC -> Bangkok) |
| `src/lib/normalization/sessions.ts` | Session blocking classification |
| `src/lib/normalization/qualifications.ts` | Tag parsing into subject/curriculum/level |
| `src/lib/normalization/modality.ts` | Online/onsite derivation |
| `src/lib/normalization/timezone.ts` | Asia/Bangkok timezone utilities |

### External API Integration

| File | Purpose |
|------|---------|
| `src/lib/wise/client.ts` | `WiseClient` class (retry, concurrency, auth headers) |
| `src/lib/wise/fetchers.ts` | Domain fetchers (teachers, availability, sessions) |
| `src/lib/wise/types.ts` | Wise API response shapes + accessor helpers |

### Frontend Entry Points

| File | Purpose |
|------|---------|
| `src/app/(app)/search/page.tsx` | Main workspace (search + compare side-by-side) |
| `src/hooks/use-compare.ts` | Compare state management hook with client cache |
| `src/components/compare/compare-panel.tsx` | Compare panel container |
| `src/components/search/search-workspace.tsx` | Search panel orchestrator |
| `src/components/compare/calendar-grid.tsx` | GCal-style weekly time grid |
| `src/components/compare/session-colors.ts` | Shared color logic module |

## Naming Conventions

### Files

- **kebab-case** for all files: `session-colors.ts`, `week-overview.tsx`, `app-nav.tsx`
- **React components** use `.tsx`, logic/types use `.ts`
- **Test files:** `{module}.test.ts` inside `__tests__/` directories co-located with source
- **Schema:** singular `schema.ts`
- **Type definitions:** `types.ts` per module

### Functions

- **camelCase** for all functions: `executeSearch`, `buildCompareTutor`, `detectConflicts`
- **Prefix `get`** for getters: `getDb()`, `getEnv()`, `getBaseName()`
- **Prefix `is`/`has`** for booleans: `isBlockingStatus()`, `isOnlineVariant()`
- **Prefix `create`** for factories: `createWiseClient()`, `createDb()`
- **Prefix `parse`/`normalize`** for transforms: `parseTimeToMinutes()`, `normalizeLeaves()`
- **Prefix `fetch`** for API calls: `fetchAllTeachers()`, `fetchAllFutureSessions()`

### Variables and Constants

- **camelCase** for variables: `snapshotMeta`, `tutorGroupIds`
- **UPPER_SNAKE_CASE** for constants: `TUTOR_COLORS`, `HOUR_HEIGHT`, `DAY_NAMES`
- **Prefix `_`** for module singletons: `let _db`, `let _cachedIndex`

### Types

- **PascalCase** for types/interfaces: `SearchRequest`, `CompareTutor`
- **Prefix `Wise`** for external API types: `WiseTeacher`, `WiseSession`
- **Prefix `Indexed`** for in-memory index types: `IndexedTutorGroup`, `IndexedSessionBlock`
- **Prefix `Normalized`** for pipeline outputs: `NormalizedSessionBlock`
- **`interface`** for object shapes, **`type`** for unions/aliases

### Database

- **snake_case** for table/column names: `tutor_identity_groups`, `snapshot_id`
- **camelCase** for Drizzle schema objects: `tutorIdentityGroups`, `snapshotId`
- **Enums** via `pgEnum`, not TypeScript `enum`

## Route Structure

### Page Routes

| Route | File | Rendering | Auth |
|-------|------|-----------|------|
| `/` | `src/app/page.tsx` | Server (redirect) | Middleware |
| `/login` | `src/app/login/page.tsx` | Server | Public |
| `/search` | `src/app/(app)/search/page.tsx` | Client (`"use client"`) | Middleware |
| `/compare` | `src/app/(app)/compare/page.tsx` | Client (redirect) | Middleware |
| `/data-health` | `src/app/(app)/data-health/page.tsx` | Server | Middleware |

### API Routes

| Method | Route | Auth Mechanism |
|--------|-------|----------------|
| GET/POST | `/api/auth/[...nextauth]` | Public (Auth.js internal) |
| POST | `/api/search` | Session (auth()) |
| POST | `/api/search/range` | Session (auth()) |
| GET | `/api/filters` | Session (auth()) |
| GET | `/api/tutors` | Session (auth()) |
| POST | `/api/compare` | Session (auth()) |
| POST | `/api/compare/discover` | Session (auth()) |
| GET | `/api/data-health` | Session (auth()) |
| POST | `/api/internal/sync-wise` | CRON_SECRET Bearer |

### Route Groups

- `(app)` -- shared layout with `AppNav` navigation bar. Contains `/search`, `/compare`, `/data-health`.
- `/login` -- standalone page outside the `(app)` group (no nav bar).
- `/api/internal/` -- internal endpoints with CRON_SECRET auth, excluded from middleware session check.

## Test File Locations

```
src/lib/normalization/__tests__/
├── identity.test.ts          # Identity resolution tests
├── availability.test.ts      # Working hours normalization tests
├── leaves.test.ts            # Leave normalization tests
├── sessions.test.ts          # Session blocking tests
├── modality.test.ts          # Modality derivation tests
├── qualifications.test.ts    # Tag parsing tests
└── timezone.test.ts          # Timezone conversion tests

src/lib/search/__tests__/
├── engine.test.ts            # Search engine tests
├── compare.test.ts           # Compare engine tests
└── parser.test.ts            # Slot parser tests

src/lib/wise/__tests__/
├── client.test.ts            # Wise API client tests
└── fetchers.test.ts          # Wise fetcher contract tests
```

Total: 12 test files across 3 `__tests__/` directories.
