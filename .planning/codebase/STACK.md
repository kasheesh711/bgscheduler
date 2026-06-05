# Technology Stack

**Analysis Date:** 2026-05-31

## Languages

**Primary:**
- TypeScript ^5.9.3 - All application code in `src/**/*.ts` and `src/**/*.tsx` (`package.json:68`). Strict mode on (`tsconfig.json:7`).
- SQL (PostgreSQL) - 40 Drizzle-generated migration files in `drizzle/*.sql`, dialect `postgresql` (`drizzle.config.ts:6`). The schema (90 tables) lives in `src/lib/db/schema.ts`.

**Secondary:**
- JavaScript (config + tooling only) - `.mjs` module config (`postcss.config.mjs`, `eslint.config.mjs`; `next.config.ts` and `drizzle.config.ts` are TS) and three guard/assert scripts (`scripts/check-sales-dashboard-scope.mjs`, `scripts/check-production-route-surface.mjs`, `scripts/assert-production-deploy-ready.mjs`).

## Runtime

**Environment:**
- Node.js - Local development and Vercel build. No version is pinned (no `.nvmrc`, no `engines` field in `package.json`).
- Vercel Serverless Functions - Production runtime. Sync/import endpoints raise their own ceiling via `export const maxDuration` (see Configuration → Vercel).
- TypeScript target: ES2017 (`tsconfig.json:3`), module `esnext`, `moduleResolution: bundler` (`tsconfig.json:10-11`).

**Package Manager:**
- npm
- Lockfile: `package-lock.json` present.

## Frameworks

**Core:**
- Next.js 16.2.2 - App Router framework (`package.json:42`).
  - `cacheComponents: true` is the only custom setting (`next.config.ts:4`) — opts the app into the Next 16 Cache Components model.
  - The server data layer uses `next/cache` `cacheTag` / `cacheLife` for snapshot-scoped caching (`src/lib/data/*`; the `snapshot` tag is swept on each successful Wise sync, `past-sessions` deliberately is not).
  - App Router structure under `src/app/`, with the authenticated UI grouped under the `(app)` route group and a top-level `login` route. Root metadata is branded **"BeGifted Ops"** (`src/app/layout.tsx:16`).
- React 19.2.4 / React DOM 19.2.4 - UI library and browser renderer (`package.json:45-46`).

**Testing:**
- Vitest ^4.1.2 - Test runner (`package.json:69`). Config at `vitest.config.ts`.
  - Two named projects (`vitest.config.ts:25-51`): **`unit`** (`environment: node`, globals on, matches `src/**/*.test.ts(x)`, excludes integration) and **`integration`** (matches `src/**/*.integration.test.ts`, `pool: forks`, `fileParallelism: false`, `maxWorkers: 1`, 60s test/hook timeouts).
  - `process.env.TZ = "Asia/Bangkok"` is forced at config load (`vitest.config.ts:4`) so date logic is exercised in the production timezone.
  - `@vitest/coverage-v8` provides coverage; `coverage.include` is `src/**/*.{ts,tsx}` excluding tests, `src/tests/**`, and `src/app/**/*.tsx` (`vitest.config.ts:13-24`).
  - Path alias `@` → `./src` declared independently for Vitest (`vitest.config.ts:7-10`).
  - Scope: **162 test files** under `src/**/__tests__/` (`*.test.ts` / `*.test.tsx`), of which **3** are `*.integration.test.ts`.
- `testcontainers` / `@testcontainers/postgresql` ^11.14.0 - Spin up a real ephemeral Postgres for the integration project (`src/tests/integration/`); Docker must be available locally to run them.

**Build/Dev:**
- Tailwind CSS ^4 - Styling via the `@tailwindcss/postcss` plugin (`package.json:54,66`, `postcss.config.mjs:3`). No `tailwind.config.*`; theme lives in CSS (`src/app/globals.css`, 72 OKLCH color declarations). Semantic tokens include `--available`/`--blocked`/`--conflict`/`--free-slot`; `TUTOR_COLORS = ["#3b82f6", "#e67e22", "#7c3aed"]`.
- PostCSS - CSS pipeline, single plugin `@tailwindcss/postcss` (`postcss.config.mjs`).
- ESLint ^9 - Flat config (`eslint.config.mjs`) extending `eslint-config-next/core-web-vitals` and `.../typescript`; only override is restoring Next's default ignores (`.next/**`, `out/**`, `build/**`, `next-env.d.ts`).
- TypeScript ^5.9.3 - Type checking via `tsc --noEmit` (`npm run typecheck`). Strict mode on, `jsx: react-jsx`, incremental compilation, `next` TS plugin (`tsconfig.json:14-19`).

## Key Dependencies

**Database / ORM:**
- `drizzle-orm` 0.45.2 - Type-safe ORM. Schema (**90 tables**) at `src/lib/db/schema.ts` (uses `drizzle-orm/pg-core`); singleton accessor at `src/lib/db/index.ts`. Postgres enums for `status`/`category`/`role` columns are declared at the top of the schema (no TS `enum`).
- `@neondatabase/serverless` ^1.0.2 - **Primary** Neon driver. The app DB singleton is built on the HTTP driver: `neon()` + `drizzle-orm/neon-http` (`src/lib/db/index.ts:1-2,10-11`). The instance is stashed on `globalThis.__bgscheduler_db` to survive HMR (`src/lib/db/index.ts:16-27`).
- `pg` ^8.21.0 - node-postgres, used **only where transactions are required**, because the neon-http driver has no transaction support. Payroll sync opens a dedicated `Pool({ max: 1 })` and a `drizzle-orm/node-postgres` instance for multi-statement transactions, guarded by a "No transactions support in neon-http driver" check (`src/lib/payroll/sync.ts:2,90,96`). Also used by the integration-test DB helper.
- `drizzle-kit` ^0.31.10 - Migration generation/apply (`drizzle.config.ts`, `package.json:62`).

**Auth / Validation:**
- `next-auth` 5.0.0-beta.30 - Auth.js v5 beta, Google provider + Postgres `admin_users` allowlist. Node config in `src/lib/auth.ts`; an edge-safe variant (`src/lib/auth-edge.ts`) backs `src/middleware.ts`, which gates all routes except a public allowlist (`/login`, `/api/auth/*`, the public search assistant, …). The Google scope includes `spreadsheets.readonly` for the Sheets-backed features.
- `zod` ^4.3.6 - Runtime validation. Centralized env schema (`src/lib/env.ts`), per-route request-body schemas across `src/app/api/**`, and validation of external Wise payloads. Always `.safeParse()`, never `.parse()`.

**AI scheduler:**
- No vendor AI SDK is installed. The AI scheduler calls **OpenAI's Responses API** directly over `fetch` (`https://api.openai.com/v1/responses`, in `src/lib/ai/scheduler.ts:544` and `src/lib/ai/scheduler-conversation.ts:2346`). It reads `OPENAI_API_KEY`, `OPENAI_SCHEDULER_MODEL` (default model id `gpt-5.4-mini`, `src/lib/ai/scheduler.ts:8,462`), `OPENAI_SCHEDULER_SHADOW_MODEL`, and `OPENAI_SCHEDULER_REASONING_EFFORT` from `process.env` directly (**not** via `src/lib/env.ts`), and is gated by `ENABLE_AI_SCHEDULER` (enabled unless explicitly `"false"` and an API key is present, `src/lib/ai/scheduler.ts:478-479`).

**Google Sheets ingest:**
- No Google API client library. The leave-request and sales/projection flows authenticate against `oauth2.googleapis.com/token` and read `sheets.googleapis.com` over `fetch`, keyed by `LEAVE_REQUESTS_SPREADSHEET_ID` / `LEAVE_REQUESTS_SHEET_NAME` / `LEAVE_REQUESTS_CONNECTED_EMAIL`.
- `xlsx` ^0.18.5 - Spreadsheet (.xlsx) parsing for the sales-dashboard / projection imports (`package.json:50`).

**UI Component System:**
- `shadcn` ^4.1.2 - shadcn CLI (`package.json:65`). Config `components.json`: style `base-nova`, baseColor `neutral`, RSC + CSS variables on, icon library `lucide`.
- `@base-ui/react` 1.3.0 - Base UI primitives wrapped by `src/components/ui/*.tsx`.
- `cmdk` ^1.1.1 - Command palette / searchable combobox.
- `lucide-react` ^1.7.0 - Icons.
- `class-variance-authority` ^0.7.1 + `clsx` ^2.1.1 + `tailwind-merge` ^3.5.0 - Variant styling and class merging (`cn()` in `src/lib/utils.ts`). `tw-animate-css` ^1.4.0 - animation utilities.
- `chart.js` ^4.4.7 - Charts (dashboard views such as Wise Activity / Sales).
- Fonts via `next/font/google`: **Inter** (`--font-inter`) and **JetBrains Mono** (`--font-jetbrains-mono`) (`src/app/layout.tsx:2,5-13`).

**Data/Date Utilities:**
- `date-fns` ^4.1.0 + `date-fns-tz` ^3.2.0 - Date math and Asia/Bangkok timezone conversion (`src/lib/normalization/timezone.ts`).
- `uuid` ^13.0.0 (+ `@types/uuid` ^10.0.0) - UUID generation.

**Type Definitions (devDependencies):**
- `@types/node` ^20, `@types/react` ^19, `@types/react-dom` ^19, `@types/pg` ^8.20.0, `@types/uuid` ^10.0.0.

## Configuration

**TypeScript (`tsconfig.json`):**
- Strict mode; target ES2017; module `esnext`, `moduleResolution: bundler`.
- Path alias `@/*` → `./src/*` (`tsconfig.json:21-23`); JSX `react-jsx`; `incremental: true`; `next` plugin.
- `include` covers `**/*.ts(x)`, `**/*.mts`, and Next-generated `.next/types` / `.next/dev/types`.

**Next.js (`next.config.ts`):**
- `cacheComponents: true` (Next 16 Cache Components). No custom Webpack/Turbopack overrides.

**Drizzle (`drizzle.config.ts`):**
- Dialect `postgresql`; schema `./src/lib/db/schema.ts`; migrations out `./drizzle/`; credentials from `DATABASE_URL`.

**Vercel (`vercel.json`):** **10 crons** (no longer a single midnight job):

| Path | Schedule |
|------|----------|
| `/api/internal/sync-wise` | `*/30 * * * *` |
| `/api/internal/sync-sales-dashboard` | `10,40 * * * *` |
| `/api/internal/sync-credit-control` | `20,50 * * * *` |
| `/api/internal/sync-progress-tests` | `25,55 * * * *` |
| `/api/internal/progress-tests/admin-digest` | `35 0 * * *` |
| `/api/internal/sync-wise-activity` | `5,35 * * * *` |
| `/api/internal/sync-leave-requests` | `15,45 * * * *` |
| `/api/internal/class-assignments/morning` | `45 23 * * *` |
| `/api/internal/class-assignments/admin-email` | `0,10,20,30 0 * * *` |
| `/api/internal/student-promotions/july-1` | `5 17 30 6 *` |

- Function durations are set per-route via `export const maxDuration`, **not** in `vercel.json`. Observed values: `800` (16 routes — full Wise sync, sales/leave/wise-activity/payroll syncs, the once-a-year `student-promotions/july-1` job; e.g. `src/app/api/internal/sync-wise/route.ts:7`), `300` (7 routes — credit-control sync, progress-tests sync + admin-digest, class-assignment run/publish/admin-email), and `60` (the LINE webhook, `src/app/api/line/webhook/route.ts:7`).
- Internal cron routes authenticate with a **constant-time** `CRON_SECRET` comparison via the shared `src/lib/internal/cron-auth.ts` (`timingSafeEqual` + length pre-check, design ID REL-07). The LINE webhook verifies the `x-line-signature` HMAC via `src/lib/line/signature.ts`.

**Environment (`src/lib/env.ts`):**
- Zod schema validates env at startup (throws on failure, logs only `fieldErrors`). **9 required** vars — `DATABASE_URL`, `AUTH_GOOGLE_ID`, `AUTH_GOOGLE_SECRET`, `AUTH_SECRET`, `WISE_USER_ID`, `WISE_API_KEY`, `WISE_NAMESPACE` (default `begifted-education`), `WISE_INSTITUTE_ID` (default `696e1f4d90102225641cc413`), `CRON_SECRET` — plus **3 optional** LINE vars: `LINE_CHANNEL_SECRET`, `LINE_CHANNEL_ACCESS_TOKEN`, `ENABLE_LINE_SCHEDULER` (`src/lib/env.ts:4-16`).
- Additional runtime vars are read directly from `process.env` outside the schema: `OPENAI_API_KEY` / `OPENAI_SCHEDULER_*` / `ENABLE_AI_SCHEDULER` (AI scheduler) and `LEAVE_REQUESTS_*` (Sheets ingest).

**ESLint (`eslint.config.mjs`):** Flat config; `next/core-web-vitals` + `next/typescript`; global ignores `.next/**`, `out/**`, `build/**`, `next-env.d.ts`.

**PostCSS (`postcss.config.mjs`):** Single plugin `@tailwindcss/postcss`.

**shadcn (`components.json`):** Style `base-nova`; baseColor `neutral`; CSS vars on; icon library `lucide`; aliases `@/components`, `@/components/ui`, `@/lib`, `@/lib/utils`, `@/hooks`.

## Codebase Spine (counts)

Authoritative counts for the current revision:

| Metric | Count | How to verify |
|--------|-------|---------------|
| Database tables | **90** | `grep -c "pgTable(" src/lib/db/schema.ts` |
| HTTP endpoints | **130** | `src/app/api/**/route.ts` — 130 endpoints across 111 route files (CORS `OPTIONS` preflight handlers not counted); canonical inventory in `docs/reference/api/index.md` and `docs/reference/production-route-surface.json` |
| Vercel crons | **10** | `vercel.json` |
| Application pages | **17** | routable `(app)` pages (includes the `(app)/page.tsx` Ops Hub home and the `/compare` redirect; excludes `/login`) |
| Test files | **162** | `find src -name '*.test.ts*'` |
| `src/lib` domain modules | **25** | listed below |

**`src/lib` modules (25):** `__tests__`, `ai`, `auth`, `classrooms`, `credit-control`, `data`, `data-health`, `db`, `internal`, `leave-requests`, `line`, `normalization`, `ops`, `payroll`, `progress-tests`, `proposals`, `room-capacity`, `sales-dashboard`, `scheduler`, `search`, `student-promotions`, `sync`, `ui`, `wise`, `wise-activity`.

Architectural anchors confirmed in code:
- **In-memory search index** singleton, `globalThis`-anchored (`__bgscheduler_searchIndex` + `__bgscheduler_searchIndexBuildPromise`, `src/lib/search/index.ts:95-112`) with build-promise coalescing.
- **ETL orchestrator** at `src/lib/sync/orchestrator.ts` (fetch → normalize → persist → validate → promote), wrapped by `run-wise-sync.ts` (single-flight + `revalidateTag("snapshot")`); companions `snapshot-pruning.ts` and `past-sessions-diff-hook.ts`.
- **Sectioned navigation** is data-driven from `src/lib/navigation/tools.ts` (4 sections — Scheduling & Tutors, Student Lifecycle, Finance & Revenue, Data & Audit — over 15 `NAV_TOOLS` entries), consumed by `src/components/layout/app-nav.tsx` with per-tool access filtering and badge counts from `/api/home/summary`.

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
| `guard:production-route-surface` | `node scripts/check-production-route-surface.mjs` | Diff live page/route files against `docs/reference/production-route-surface.json` |
| `verify:release` | `npm run typecheck && npm test && npm run build && npm run typecheck && git diff --check && npm run guard:production-route-surface` | Full pre-release gate |
| `deploy:prod` | `npm run verify:release && node scripts/assert-production-deploy-ready.mjs && npx vercel --prod` | Verified production deploy |

> `tsx` is invoked by the seed/script commands but is **not** a declared dependency in `package.json` (resolved via `npx`/global).

## Platform Requirements

**Development:**
- Node.js (ES2017+; no version pinned) and npm.
- A PostgreSQL connection (Neon or local) via `DATABASE_URL`.
- Google OAuth credentials for auth.
- All 9 required env vars set (validated at startup by `src/lib/env.ts`); optional LINE / OpenAI / Sheets vars enable those features.
- Docker available for `test:integration` (testcontainers spins up Postgres).

**Production:**
- Vercel **Pro** — 10 staggered crons (`vercel.json`); per-route function ceilings up to 800s.
- Neon Postgres (ap-southeast-1).
- External integrations: Wise API (`https://api.wiseapp.live`), OpenAI Responses API (AI scheduler, when enabled), Google Sheets (leave-request / sales ingest), and LINE Messaging API (when `ENABLE_LINE_SCHEDULER` is set).
- Production URL: https://bgscheduler.vercel.app

---

_Verified against HEAD `d4fe6d3` on 2026-06-05._
