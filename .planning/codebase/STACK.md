# Technology Stack

**Analysis Date:** 2026-05-31

## Languages

**Primary:**
- TypeScript ^5.9.3 - All application code in `src/**/*.ts` and `src/**/*.tsx` (`package.json:65`)
- SQL (PostgreSQL) - 35 Drizzle-generated migration files in `drizzle/*.sql`, dialect `postgresql` (`drizzle.config.ts:6`)

**Secondary:**
- JavaScript (config + tooling only) - `.mjs` module config (`postcss.config.mjs`, `eslint.config.mjs`, `next.config.ts` is TS) and one guard script (`scripts/check-sales-dashboard-scope.mjs`, wired to `npm run guard:sales-dashboard-scope`)

## Runtime

**Environment:**
- Node.js - Local development and Vercel build. No version is pinned (no `.nvmrc`, no `engines` field in `package.json`).
- Vercel Serverless Functions - Production runtime. Sync/import endpoints raise their own ceiling via `export const maxDuration` (see Configuration → Vercel).
- TypeScript target: ES2017 (`tsconfig.json:3`), module `esnext`, `moduleResolution: bundler` (`tsconfig.json:10-11`)

**Package Manager:**
- npm
- Lockfile: `package-lock.json` present

## Frameworks

**Core:**
- Next.js 16.2.2 - App Router framework (`package.json:39`)
  - `cacheComponents: true` is the only custom setting (`next.config.ts:4`) — opts the app into the Next 16 Cache Components model.
  - The server data layer uses `next/cache` `cacheTag` / `cacheLife` for snapshot-scoped caching (`src/lib/data/filters.ts:1`, also `src/lib/data/tutors.ts`, `src/lib/data/past-sessions.ts`).
  - App Router structure under `src/app/`, with the authenticated UI grouped under the `(app)` route group and a top-level `login` route.
- React 19.2.4 / React DOM 19.2.4 - UI library and browser renderer (`package.json:42-43`)

**Testing:**
- Vitest ^4.1.2 - Test runner (`package.json:66`). Config at `vitest.config.ts`.
  - Two named projects (`vitest.config.ts:23-49`): **`unit`** (`environment: node`, globals on, matches `src/**/*.test.ts(x)`, excludes integration) and **`integration`** (matches `src/**/*.integration.test.ts`, `pool: forks`, `fileParallelism: false`, `maxWorkers: 1`, 60s test/hook timeouts).
  - `@vitest/coverage-v8` provides coverage; `coverage.include` is `src/**/*.{ts,tsx}` excluding tests and `src/app/**/*.tsx` (`vitest.config.ts:11-22`).
  - Path alias `@` → `./src` declared independently for Vitest (`vitest.config.ts:6-8`).
- `testcontainers` / `@testcontainers/postgresql` ^11.14.0 - Spin up a real ephemeral Postgres for integration tests (`src/tests/integration/db-helper.ts`); only 3 `*.integration.test.ts` files exist today.

**Build/Dev:**
- Tailwind CSS ^4 - Styling via the `@tailwindcss/postcss` plugin (`package.json:51,63`, `postcss.config.mjs:3`). No `tailwind.config.*`; theme lives in CSS (`src/app/globals.css`, 72 OKLCH color declarations).
- PostCSS - CSS pipeline, single plugin `@tailwindcss/postcss` (`postcss.config.mjs`).
- ESLint ^9 - Flat config (`eslint.config.mjs`) extending `eslint-config-next/core-web-vitals` and `.../typescript` (`eslint.config.mjs:2-3`); only override is restoring Next's default ignores.
- TypeScript ^5.9.3 - Type checking via `tsc --noEmit` (`npm run typecheck`). Strict mode on (`tsconfig.json:7`), `jsx: react-jsx`, incremental compilation, `next` TS plugin (`tsconfig.json:14-19`).

## Key Dependencies

**Database / ORM:**
- `drizzle-orm` 0.45.2 - Type-safe ORM. Schema (78 tables) at `src/lib/db/schema.ts` (uses `drizzle-orm/pg-core`); singleton accessor at `src/lib/db/index.ts`.
- `@neondatabase/serverless` ^1.0.2 - **Primary** Neon driver. The app DB singleton is built on the HTTP driver: `neon()` + `drizzle-orm/neon-http` (`src/lib/db/index.ts:1-2,10-11`). The instance is stashed on `globalThis.__bgscheduler_db` to survive HMR (`src/lib/db/index.ts:16-27`).
- `pg` ^8.21.0 - node-postgres, used **only where transactions are required**, because the neon-http driver has no transaction support. Payroll sync opens a dedicated `Pool` (`max: 1`) and a `drizzle-orm/node-postgres` instance for multi-statement transactions, falling back on a "No transactions support in neon-http driver" guard (`src/lib/payroll/sync.ts:2-3,90,93-113`). Also used by the integration-test DB helper.
- `drizzle-kit` ^0.31.10 - Migration generation/apply (`drizzle.config.ts`, `package.json:59`).

**Auth / Validation:**
- `next-auth` 5.0.0-beta.30 - Auth.js v5 beta, Google provider + Postgres admin allowlist. Node config in `src/lib/auth.ts`; an edge-safe variant (`src/lib/auth-edge.ts`) backs `src/middleware.ts`, which gates all routes except a public allowlist (`/login`, `/api/auth/*`, `/api/search/assistant`, …).
- `zod` ^4.3.6 - Runtime validation. Centralized env schema (`src/lib/env.ts`) and per-route request-body schemas across `src/app/api/**`.

**AI scheduler:**
- No vendor AI SDK is installed. The AI scheduler calls **OpenAI's Responses API** directly over `fetch` (`https://api.openai.com/v1/responses`, in `src/lib/ai/`). It reads `OPENAI_API_KEY`, `OPENAI_SCHEDULER_MODEL` (default model id `gpt-5.4-mini`), `OPENAI_SCHEDULER_SHADOW_MODEL`, and `OPENAI_SCHEDULER_REASONING_EFFORT` from `process.env` directly (not via `src/lib/env.ts`), and is gated by `ENABLE_AI_SCHEDULER` (`src/lib/ai/scheduler.ts`).

**Google Sheets ingest:**
- No Google API client library; leave-request import authenticates against `oauth2.googleapis.com/token` and reads `sheets.googleapis.com` over `fetch`, keyed by `LEAVE_REQUESTS_SPREADSHEET_ID` (`src/lib/leave-requests/**`, the in-flight module documented but not editable here).
- `xlsx` ^0.18.5 - Spreadsheet (.xlsx) parsing for the sales-dashboard / projection imports (`package.json:47`).

**UI Component System:**
- `shadcn` ^4.1.2 - shadcn CLI (`package.json:62`). Config `components.json`: style `base-nova`, baseColor `neutral`, RSC + CSS variables on, icon library `lucide`.
- `@base-ui/react` 1.3.0 - Base UI primitives wrapped by `src/components/ui/*.tsx`.
- `cmdk` ^1.1.1 - Command palette / searchable combobox.
- `lucide-react` ^1.7.0 - Icons.
- `class-variance-authority` ^0.7.1 + `clsx` ^2.1.1 + `tailwind-merge` ^3.5.0 - Variant styling and class merging (`cn()` in `src/lib/utils.ts`). `tw-animate-css` ^1.4.0 - animation utilities.
- `chart.js` ^4.4.7 - Charts (used by dashboard views such as Wise Activity / Sales).
- Fonts via `next/font/google`: **Inter** (`--font-inter`) and **JetBrains Mono** (`--font-jetbrains-mono`) (`src/app/layout.tsx:2,5-13`).

**Data/Date Utilities:**
- `date-fns` ^4.1.0 + `date-fns-tz` ^3.2.0 - Date math and Asia/Bangkok timezone conversion (`src/lib/normalization/timezone.ts`, `src/lib/bangkok-time.ts`).
- `uuid` ^13.0.0 (+ `@types/uuid` ^10.0.0) - UUID generation.

**Type Definitions (devDependencies):**
- `@types/node` ^20, `@types/react` ^19, `@types/react-dom` ^19, `@types/pg` ^8.20.0, `@types/uuid` ^10.0.0.

## Configuration

**TypeScript (`tsconfig.json`):**
- Strict mode; target ES2017; module `esnext`, `moduleResolution: bundler`.
- Path alias `@/*` → `./src/*` (`tsconfig.json:21-23`); JSX `react-jsx`; `incremental: true`; `next` plugin.
- `include` covers `**/*.ts(x)`, `**/*.mts`, and Next-generated `.next/types`.

**Next.js (`next.config.ts`):**
- `cacheComponents: true` (Next 16 Cache Components). No custom Webpack/Turbopack overrides.

**Drizzle (`drizzle.config.ts`):**
- Dialect `postgresql`; schema `./src/lib/db/schema.ts`; migrations out `./drizzle/`; credentials from `DATABASE_URL`.

**Vercel (`vercel.json`):** 7 crons (no longer a single midnight job):
| Path | Schedule |
|------|----------|
| `/api/internal/sync-wise` | `*/30 * * * *` |
| `/api/internal/sync-sales-dashboard` | `10,40 * * * *` |
| `/api/internal/sync-credit-control` | `20,50 * * * *` |
| `/api/internal/sync-wise-activity` | `5,35 * * * *` |
| `/api/internal/sync-leave-requests` | `15,45 * * * *` |
| `/api/internal/class-assignments/morning` | `45 23 * * *` |
| `/api/internal/class-assignments/admin-email` | `0,10,20,30 0 * * *` |

- Function durations are set per-route via `export const maxDuration`, **not** in `vercel.json`. Most sync/import routes use `800` (Vercel Pro headroom — e.g. `src/app/api/internal/sync-wise/route.ts:6`, the sales-dashboard imports, payroll/leave/wise-activity syncs); credit-control sync and class-assignment run/publish/admin-email use `300`; the LINE webhook uses `60`.

**Environment (`src/lib/env.ts`):**
- Zod schema validates env at startup (throws on failure). 9 required vars — `DATABASE_URL`, `AUTH_GOOGLE_ID`, `AUTH_GOOGLE_SECRET`, `AUTH_SECRET`, `WISE_USER_ID`, `WISE_API_KEY`, `WISE_NAMESPACE` (default `begifted-education`), `WISE_INSTITUTE_ID` (default `696e1f4d90102225641cc413`), `CRON_SECRET` — plus 3 optional LINE vars: `LINE_CHANNEL_SECRET`, `LINE_CHANNEL_ACCESS_TOKEN`, `ENABLE_LINE_SCHEDULER` (`src/lib/env.ts:4-16`).
- Additional runtime vars are read directly from `process.env` outside the schema: `OPENAI_API_KEY` / `OPENAI_SCHEDULER_*` / `ENABLE_AI_SCHEDULER` (AI scheduler) and `LEAVE_REQUESTS_SPREADSHEET_ID` (Sheets ingest).

**ESLint (`eslint.config.mjs`):** Flat config; `next/core-web-vitals` + `next/typescript`; global ignores `.next/**`, `out/**`, `build/**`, `next-env.d.ts`.

**PostCSS (`postcss.config.mjs`):** Single plugin `@tailwindcss/postcss`.

**shadcn (`components.json`):** Style `base-nova`; baseColor `neutral`; CSS vars on; icon library `lucide`; aliases `@/components`, `@/components/ui`, `@/lib`, `@/lib/utils`, `@/hooks`.

## NPM Scripts

| Script | Command | Purpose |
|--------|---------|---------|
| `dev` | `next dev` | Local dev server |
| `build` | `next build` | Production build |
| `start` | `next start` | Production server |
| `lint` | `eslint` | Lint codebase |
| `typecheck` | `tsc --noEmit` | Type-check without emit |
| `test` | `vitest run --project unit` | Run unit tests once |
| `test:watch` | `vitest --project unit` | Unit tests, watch mode |
| `test:integration` | `vitest run --project integration` | Run testcontainers integration tests |
| `test:all` | `vitest run` | Run both projects |
| `test:coverage` | `vitest run --project unit --coverage` | Unit tests with v8 coverage |
| `db:generate` | `drizzle-kit generate` | Generate SQL migrations from schema |
| `db:migrate` | `drizzle-kit migrate` | Apply migrations |
| `db:seed` | `tsx src/lib/db/seed.ts` | Seed admin users and tutor aliases |
| `credit-control:seed-admin-ownership` | `tsx scripts/seed-credit-control-admin-ownership.ts` | Seed credit-control admin ownership |
| `tutor-profiles:seed` | `tsx scripts/seed-tutor-business-profiles.ts` | Seed tutor business profiles |
| `room-capacity:import-model` | `tsx scripts/import-room-capacity-model.ts` | Import room-capacity model |
| `room-utilization:sync` | `tsx scripts/sync-room-utilization.ts` | Sync room utilization |
| `ai-scheduler:evaluate` | `tsx scripts/evaluate-ai-scheduler.ts` | Run AI-scheduler eval harness |
| `ai-scheduler:compare-models` | `tsx scripts/compare-ai-scheduler-models.ts` | Compare AI-scheduler models |
| `line:test-data:cleanup` | `tsx scripts/delete-line-test-data.ts` | Delete LINE test data |
| `guard:sales-dashboard-scope` | `node scripts/check-sales-dashboard-scope.mjs` | Guard sales-dashboard change scope |

> `tsx` is invoked by the seed/script commands but is **not** a declared dependency in `package.json` (resolved via `npx`/global).

## Platform Requirements

**Development:**
- Node.js (ES2017+; no version pinned) and npm.
- A PostgreSQL connection (Neon or local) via `DATABASE_URL`.
- Google OAuth credentials for auth.
- All 9 required env vars set (validated at startup by `src/lib/env.ts`); optional LINE / OpenAI / Sheets vars enable those features.
- Docker available for `test:integration` (testcontainers spins up Postgres).

**Production:**
- Vercel **Pro** — 7 staggered crons (`vercel.json`); per-route function ceilings up to 800s.
- Neon Postgres (ap-southeast-1).
- External integrations: Wise API (`https://api.wiseapp.live`), OpenAI Responses API (AI scheduler, when enabled), Google Sheets (leave-request ingest), and LINE Messaging API (when `ENABLE_LINE_SCHEDULER` is set).
- Production URL: https://bgscheduler.vercel.app

---

_Verified against HEAD + uncommitted WIP on 2026-05-31._
