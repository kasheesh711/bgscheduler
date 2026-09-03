# Technology Stack

**Analysis Date:** 2026-09-02

## Languages

**Primary:**
- TypeScript ^5.9.3 — all application code under `src/**/*.ts` and `src/**/*.tsx` (`package.json:78`). 1,099 TS/TSX files in `src/`, of which **389 are Vitest specs** (320 `.test.ts` + 69 `.test.tsx`).
- SQL (PostgreSQL) — **69 Drizzle-generated migrations** in `drizzle/*.sql` (`0000_*` … `0068_payout_adjustment_superseded.sql`), dialect `postgresql` (`drizzle.config.ts:5`).

**Secondary:**
- JavaScript (config, guards, and one browser extension):
  - `.mjs` config — `postcss.config.mjs`, `eslint.config.mjs` (`next.config.ts` and `drizzle.config.ts` are TS).
  - Three `.mjs` CI/deploy guards under `scripts/`: `check-sales-dashboard-scope.mjs`, `check-production-route-surface.mjs`, `assert-production-deploy-ready.mjs`; plus a local Claude hook `.claude/hooks/sales-dashboard-guard.mjs`.
  - **A committed Chrome MV3 extension** at `extensions/line-oa-resolver/` — plain JS, no build step, no bundler: `manifest.json` (v0.2.3, name "BeGifted LINE OA Resolver"), `background.js` (service worker), `candidate-utils.js` + `content.js` (content scripts on `https://chat.line.biz/*`), `popup.html`/`popup.js`, `README.md`. It talks to this app's LINE OA-resolver endpoints. Tracked in git, **not** part of the Next build.
- Shell — two IPEDS conversion helpers (`scripts/ipeds-convert.sh`, `scripts/ipeds-convert-historical.sh`) used by the US-Universities import.
- Google Apps Script — `scripts/list-payout-workbooks.gs`, run inside Google's own runtime (not bundled or executed by this app). A second Apps Script lives outside the repo: the classroom schedule-email web app that `src/lib/classrooms/schedule-email.ts` posts to.

## Runtime

**Environment:**
- Node.js — local development and Vercel build. **No version is pinned**: no `.nvmrc`, no `engines` field in `package.json`.
- Vercel Serverless Functions — production runtime, **pinned to the `sin1` region** (`vercel.json:2`, the only non-cron key in the file). **43 route handlers** raise their own ceiling via `export const maxDuration`; there is no `functions` block in `vercel.json` (see Configuration → Vercel).
- TypeScript target ES2017 (`tsconfig.json:3`), module `esnext`, `moduleResolution: bundler` (`tsconfig.json:10-11`).

**Package Manager:**
- npm
- Lockfile: `package-lock.json` present

## Frameworks

**Core:**
- Next.js 16.2.2 — App Router framework (`package.json:52`).
  - `cacheComponents: true` is the only custom setting (`next.config.ts:4`) — opts the app into the Next 16 Cache Components model.
  - **Nine modules** opt into the caching directive with `"use cache"`: the server data layer (`src/lib/data/tutors.ts`, `filters.ts`, `past-sessions.ts`), four feature data layers (`src/lib/sales-dashboard/data.ts`, `src/lib/credit-control/service.ts:31`, `src/lib/progress-tests/service.ts`, `src/lib/us-universities/data.ts`), and both Admissions pages. Membership is tag-scoped via `cacheTag` + `cacheLife` and invalidated by **21 `revalidateTag` call sites** across `src/lib` and `src/app` — e.g. `cacheTag(CREDIT_CONTROL_CACHE_TAG)` + `cacheLife({ stale: 60, revalidate: 60, expire: 300 })` (`src/lib/credit-control/service.ts:31-33`).
  - App Router structure under `src/app/`: **31 `page.tsx` files** — **26 authenticated application pages** in the `(app)` route group, plus `/login`, the public token-gated parent page `/schedule/[token]`, and **three** print-only routes in a separate `(print)` group (`/learning-plans/report`, `/student-schedule/report`, `/student-report/report`).
  - **180 `route.ts` files** export **243 endpoints**. The raw named-export tally is 243 handlers (99 GET, 95 POST, 34 PATCH, 12 DELETE, 2 OPTIONS, 1 PUT); the endpoint figure subtracts the 2 CORS-preflight `OPTIONS` handlers (both on the public OA-resolver routes, which carry no business surface) and adds back the 2 methods the Auth.js catch-all exports by destructuring rather than by `function` (`src/app/api/auth/[...nextauth]/route.ts:3`).
  - `src/middleware.ts` runs on the edge over everything except `_next/static`, `_next/image`, and `favicon.ico` (`src/middleware.ts:111-113`). Order matters: the **maintenance gate runs first** (MAINT-04), then a public-route allowlist (`/login`, `/api/auth/*`, `/api/search/assistant`, `/api/classrooms/floor-plan-map`, `/api/line/webhook`, `/schedule/*`, two LINE OA-resolver paths, and all of `/api/internal/*` — `src/middleware.ts:10-25`), then per-user page-level access from the JWT's `allowedPages` claim (`src/middleware.ts:36-66`). Post-class-feedback and Learning Plans are deliberately coarse-passed there because they re-resolve grants from the database downstream (`src/middleware.ts:39-57`).
- React 19.2.4 / React DOM 19.2.4 — UI library and browser renderer (`package.json:55-56`).
- `server-only` — imported by **57 modules** to hard-fail the build if a server module reaches a client bundle. It is **not** a declared dependency and is not installed at the `node_modules` root; Next resolves it from `next/dist/compiled/server-only` during its own build. One-shot `tsx` scripts therefore alias it to an empty stub, scoped deliberately to `scripts/tsconfig.json` so the guard stays armed for the app (`scripts/stubs/server-only.ts`, `scripts/tsconfig.json:5`).

**Testing:**
- Vitest ^4.1.2 — test runner (`package.json:79`). Config at `vitest.config.ts`.
  - `process.env.TZ = "Asia/Bangkok"` is set at config load (`vitest.config.ts:4`), so every suite runs in the product's canonical timezone.
  - Two named projects (`vitest.config.ts:25-51`): **`unit`** (`environment: node`, globals on, matches `src/**/*.test.ts(x)`, excludes integration) and **`integration`** (matches `src/**/*.integration.test.ts`, `pool: forks`, `fileParallelism: false`, `maxWorkers: 1`, 60s test/hook timeouts — the Vitest 4 equivalent of the removed `singleFork`).
  - `@vitest/coverage-v8` ^4.1.5 provides coverage; `coverage.include` is `src/**/*.{ts,tsx}` excluding tests, `src/tests/**`, and `src/app/**/*.tsx` (`vitest.config.ts:13-24`).
  - Path alias `@` → `./src` is declared independently for Vitest (`vitest.config.ts:7-11`).
  - Test mass is concentrated in the API surface and the newest subsystems: `src/app/**` (83), post-class feedback (38), LINE (24), admissions components (24), US-universities components (23), admissions lib (21), US-universities lib (13), sales dashboard (13), progress tests (11), classrooms (11).
- `testcontainers` / `@testcontainers/postgresql` ^11.14.0 — spin up a real ephemeral Postgres (`postgres:16-alpine`) and run the real `drizzle/` migrations against it (`src/tests/integration/db-helper.ts:18-45`). **13 `*.integration.test.ts` files** exist: 10 under `src/lib/post-class-feedback/__tests__/` (auto-approval, backfill window, deleted-session retirement, payout accrual/repository/retirement/run, recent readiness, recheck queue, source-status restore) and 3 under `src/lib/sync/__tests__/` (orchestrator, past-sessions diff hook, snapshot pruning). `TEST_DATABASE_URL` is an escape hatch pointing the suite at an already-running scratch Postgres instead of Docker; the helper migrates and truncates the target, so it must not hold data anyone wants (`src/tests/integration/db-helper.ts:19-25`).

**Build/Dev:**
- Tailwind CSS ^4 — styling via the `@tailwindcss/postcss` plugin (`package.json:64,76`, `postcss.config.mjs:3`). No `tailwind.config.*`; the theme lives in CSS. `src/app/globals.css` (273 lines, 72 OKLCH declarations) imports `tailwindcss`, `tw-animate-css`, `shadcn/tailwind.css`, and **four** feature stylesheets (`credit-control.css`, `learning-plans.css`, `student-schedule.css`, `student-report.css`) (`src/app/globals.css:1-7`).
- PostCSS — CSS pipeline, single plugin `@tailwindcss/postcss` (`postcss.config.mjs`).
- ESLint ^9 — flat config (`eslint.config.mjs`) extending `eslint-config-next/core-web-vitals` and `.../typescript`; the only override restores Next's default ignores.
- TypeScript ^5.9.3 — type checking via `tsc --noEmit` (`npm run typecheck`). Strict mode on (`tsconfig.json:7`), `jsx: react-jsx` (`:14`), incremental compilation (`:15`), `next` TS plugin (`:16-20`).

## Key Dependencies

**Database / ORM:**
- `drizzle-orm` 0.45.2 — type-safe ORM, imported by **128 files**. Schema at `src/lib/db/schema.ts` — 4,772 lines declaring **189 tables** (`pgTable`) and **61 `pgEnum`** types, all via `drizzle-orm/pg-core`.
- `@neondatabase/serverless` ^1.0.2 — **primary** driver. The app DB singleton is built on the HTTP driver: `neon()` + `drizzle-orm/neon-http` (`src/lib/db/index.ts:1-2,11-12`), stashed on `globalThis.__bgscheduler_db` so it survives HMR (`src/lib/db/index.ts:16-27`).
- `pg` ^8.21.0 — node-postgres, used **only where transactions are required**, because the neon-http driver has none. Three subsystems each open a dedicated `Pool` plus a `drizzle-orm/node-postgres` instance: payroll sync (`src/lib/payroll/sync.ts:2-3`), post-class feedback (`src/lib/post-class-feedback/transaction.ts:3-4`), and the admissions audit log — the last one `await import("pg")` lazily so the module stays importable from client-component graphs without dragging `dns`/`net`/`tls` into the browser bundle (`src/lib/admissions/audit.ts:40-50,99`). Also used by the integration-test DB helper.
- `drizzle-kit` ^0.31.10 — migration generation/apply (`drizzle.config.ts`, `package.json:72`).

**Auth / Validation:**
- `next-auth` 5.0.0-beta.30 — Auth.js v5 beta, Google provider + Postgres admin allowlist, split across two configs. The Node config requests full `spreadsheets` + the deliberately narrow per-file `drive.file` scope and persists the OAuth token on sign-in; its `jwt` callback resolves `role` + `allowedPages` (`src/lib/auth.ts:37-39`). The edge-safe variant requests only `spreadsheets.readonly`, does **no** DB access, and backs `src/middleware.ts` (`src/lib/auth-edge.ts:11,22-25`).
- `zod` ^4.3.6 — runtime validation, imported by **99 files**: the centralized env schema (`src/lib/env.ts`) plus per-route request-body schemas across `src/app/api/**` and external-payload validation at the Wise boundary.

**AI (no vendor SDK):**
- No AI SDK is installed. Six modules call **OpenAI's Responses API** directly over `fetch` at `https://api.openai.com/v1/responses`: the AI scheduler (`src/lib/ai/scheduler.ts:544`, `scheduler-conversation.ts:2346`), LINE classification and contact-alias resolution (`src/lib/line/classifier.ts:98`, `contact-aliases.ts:368`), progress-test summaries (`src/lib/progress-tests/ai-summary.ts:185`), competitor intelligence (`src/lib/competitor-intelligence/ai.ts:161,300`), and post-class feedback (`src/lib/post-class-feedback/ai.ts:62`).
- Shared default model id `gpt-5.4-mini` (`src/lib/ai/scheduler.ts:8`, `src/lib/competitor-intelligence/ai.ts:5`, `src/lib/post-class-feedback/ai.ts:297`), each overridable by its own `OPENAI_*_MODEL` var. All seven `OPENAI_*` vars are read straight from `process.env`, **not** through `src/lib/env.ts`; the scheduler is gated by `ENABLE_AI_SCHEDULER`, competitor intel by `ENABLE_COMPETITOR_AI`.

**External service integrations (all raw `fetch`, no client libraries):**
- **Wise API** — `https://api.wiseapp.live` default base URL (`src/lib/wise/client.ts:64`), Basic-auth + `x-api-key` + `x-wise-namespace` + `user-agent: VendorIntegrations/{namespace}` headers (`:76`), concurrency limiter default 5 and 3 retries (`:65-66`), with an explicit `RETRYABLE_STATUS_CODES` allowlist (408/429/500/502/503/504) so permanent 4xx fail fast (`src/lib/wise/client.ts:37-44,166`). A per-instance request tally (`WiseClientStats`, `client.ts:16-25`) records how many calls each sync actually made, bucketed by normalized path. Four modules: `client.ts`, `fetchers.ts`, `operations.ts`, `types.ts`.
- **Google Sheets / Drive / OAuth** — token refresh at `https://oauth2.googleapis.com/token` (`src/lib/sales-dashboard/google-oauth.ts:146`) and reads/writes against `https://sheets.googleapis.com/v4/spreadsheets` (`src/lib/sales-dashboard/sheets.ts:58,76,99`); resumable Drive uploads at `https://www.googleapis.com/upload/drive/v3/files` for post-class-feedback artifacts (`src/lib/post-class-feedback/drive.ts:65`). Scopes are constants — readonly, write, and per-file `drive.file`, chosen over the restricted full `drive` scope to avoid Google verification plus an annual security assessment (`src/lib/sales-dashboard/google-oauth.ts:7-12`).
- **Google Apps Script** — schedule-email delivery posts to a deployed Apps Script web app; the URL and its shared secret are env-supplied with a backup pair, never hardcoded (`src/lib/classrooms/schedule-email.ts`).
- **LINE Messaging API** — `https://api.line.me` (`src/lib/line/client.ts:3`).
- **Resend** — transactional email for admissions notifications at `https://api.resend.com/emails` (`src/lib/admissions/notifications.ts:43`).
- **Apify + DataForSEO** — competitor-intelligence scraping and SERP data (`src/lib/competitor-intelligence/providers.ts:76,144`), budget-capped by four `COMPETITOR_*` env vars (`src/lib/competitor-intelligence/budget.ts`).

**UI Component System:**
- `shadcn` ^4.1.2 — shadcn CLI **and** a runtime CSS source: `globals.css` imports `shadcn/tailwind.css` even though the package sits in devDependencies (`package.json:75`, `src/app/globals.css:3`). Config `components.json`: style `base-nova`, baseColor `neutral`, RSC + CSS variables on, icon library `lucide`.
- `@base-ui/react` 1.3.0 — Base UI primitives, wrapped by **9 of the 16 files** in `src/components/ui/` (badge, button, checkbox, dialog, input, popover, select, separator, tabs); the other seven (card, command, input-group, label, skeleton, table, textarea) are plain Tailwind/CVA wrappers.
- `cmdk` ^1.1.1 — command-palette primitive behind `src/components/ui/command.tsx`, which every searchable combobox builds on (`src/components/us-universities/institution-search-combobox.tsx`).
- `lucide-react` ^1.7.0 — icons; the most widely imported UI package (**107 files**).
- `class-variance-authority` ^0.7.1 + `clsx` ^2.1.1 + `tailwind-merge` ^3.5.0 — variant styling and class merging (`cn()` in `src/lib/utils.ts`). `tw-animate-css` ^1.4.0 supplies animation utilities, imported from `globals.css`.
- `chart.js` ^4.4.7 — charts across **10 modules**: the Sales Dashboard (`chart-canvas.tsx`, `gm-command-center.tsx`, and the reps/programs/packages tabs), Wise Activity (`wise-activity-workspace.tsx`), and US Universities (`overview-charts.tsx`, `compare-panel.tsx`, `institution-dossier.tsx`, `src/lib/us-universities/trend-charts.ts`).
- Fonts via `next/font/google` — five families, all wired as CSS variables on `<html>` (`src/app/layout.tsx:2-8,11-44`): **Inter** (`--font-inter`), **JetBrains Mono** (`--font-jetbrains-mono`), **Cormorant Garamond** (`--font-cormorant`), and the Thai-subset **Sarabun** / **Trirong** (`--font-sarabun`, `--font-trirong`). The latter three set `preload: false`.
- **No PDF library is installed** (nothing matching `pdf`/`puppeteer`/`playwright` in `package.json`). "Print / Save PDF" is browser print: a workspace opens the dedicated `(print)` route in a new tab and the user saves from the print dialog.

**Data/Date Utilities:**
- `date-fns` ^4.1.0 + `date-fns-tz` ^3.2.0 — deliberately thin usage: `date-fns-tz`'s `toZonedTime` in 8 files anchoring Asia/Bangkok conversion (`src/lib/normalization/timezone.ts`, `src/lib/search/compare.ts`, `src/hooks/use-compare.ts`, …), and `date-fns` in 3 (`src/lib/wise/fetchers.ts`, `src/lib/line/operational.ts`, `src/lib/progress-tests/service.ts`). Most date math is hand-rolled in `src/lib/bangkok-time.ts` and `src/lib/calendar/month-grid.ts`.
- `uuid` ^13.0.0 (+ `@types/uuid` ^10.0.0) — used by exactly 5 files: `v4` for client-generated slot ids (`src/components/search/slot-builder.tsx`, `src/lib/search/parser.ts`) and `v5` for deterministic namespaced ids in LINE (`src/lib/line/schedule-bot.ts`, `review-service.ts`, `credit-digest.ts`). Elsewhere the code uses the platform `crypto.randomUUID`.
- `xlsx` ^0.18.5 — spreadsheet parsing in three places: the tutor-profile bulk import (`src/lib/tutor-profile-import.ts`) plus two one-shot seed scripts (`scripts/seed-credit-control-admin-ownership.ts`, `scripts/import-room-capacity-model.ts`). The Sales Dashboard reads Google Sheets over the API instead.

**Type Definitions (devDependencies):**
- `@types/node` ^20, `@types/react` ^19, `@types/react-dom` ^19, `@types/pg` ^8.20.0, `@types/uuid` ^10.0.0. Local ambient types live in `src/types/` (`next-auth.d.ts`, `credit-control.ts`, `post-class-feedback.ts`).

**Library surface (`src/lib`, 36 domain modules):**
`__tests__`, `admissions`, `ai`, `auth`, `calendar`, `classrooms`, `competitor-intelligence`, `credit-control`, `data`, `data-health`, `db`, `home`, `internal`, `learning-plans`, `leave-requests`, `line`, `navigation`, `normalization`, `ops`, `payroll`, `post-class-feedback`, `progress-tests`, `proposals`, `room-capacity`, `sales-dashboard`, `scheduler`, `search`, `student-promotions`, `student-report`, `student-schedule`, `syllabus`, `sync`, `ui`, `us-universities`, `wise`, `wise-activity` — plus **ten** loose top-level modules (`auth.ts`, `auth-edge.ts`, `auth-access.ts`, `bangkok-time.ts`, `env.ts`, `maintenance.ts`, `tutor-business-profiles.ts`, `tutor-profile-import.ts`, `tutor-profile-vocabulary.ts`, `utils.ts`). The rest of `src/` is `app/`, `components/` (26 feature dirs + `ui/`), `hooks/` (5 hooks: `use-compare`, `use-keyboard-shortcuts`, `use-resizable-split`, `use-sales-dimensions`, `use-theme`), `tests/`, `types/`, `__tests__/`, and `middleware.ts`.

Two `globalThis`-anchored singletons survive HMR: the DB client (`__bgscheduler_db`, `src/lib/db/index.ts:16-27`) and the search index plus its build-promise coalescer (`__bgscheduler_searchIndex`, `__bgscheduler_searchIndexBuildPromise`, `src/lib/search/index.ts:92-113`).

## Configuration

**TypeScript (`tsconfig.json`):**
- Strict mode (`:7`); target ES2017 (`:3`); module `esnext` (`:10`), `moduleResolution: bundler` (`:11`); `isolatedModules`, `resolveJsonModule`, `allowJs`, `skipLibCheck` all on.
- Path alias `@/*` → `./src/*` (`tsconfig.json:21-23`); JSX `react-jsx`; `incremental: true`; `next` plugin.
- `include` covers `**/*.ts(x)`, `**/*.mts`, and Next-generated `.next/types` + `.next/dev/types`.
- `scripts/tsconfig.json` extends the root and adds two script-only path mappings: `@/*` → `../src/*` and `server-only` → `./stubs/server-only.ts`.

**Next.js (`next.config.ts`):**
- `cacheComponents: true` (Next 16 Cache Components). No custom Webpack/Turbopack overrides.

**Drizzle (`drizzle.config.ts`):**
- Dialect `postgresql`; schema `./src/lib/db/schema.ts`; migrations out `./drizzle`; credentials from `DATABASE_URL`.

**Vercel (`vercel.json`):** `regions: ["sin1"]` plus **17 cron entries** — and nothing else (no `functions`, `headers`, or `rewrites` block).

| Path | Schedule |
|------|----------|
| `/api/internal/sync-wise` | `*/30 * * * *` |
| `/api/internal/sync-sales-dashboard` | `10,40 * * * *` |
| `/api/internal/sync-competitor-intelligence` | `28 18 * * 0` |
| `/api/internal/sync-credit-control` | `20,50 * * * *` |
| `/api/internal/sync-progress-tests` | `25,55 * * * *` |
| `/api/internal/progress-tests/admin-digest` | `35 0 * * *` |
| `/api/internal/sync-wise-activity` | `2,17,32,47 * * * *` |
| `/api/internal/sync-post-class-feedback` | `13,43 * * * *` |
| `/api/internal/post-class-feedback-backfill` | `23,53 * * * *` |
| `/api/internal/post-class-feedback/payout-accrual` | `33 * * * *` |
| `/api/internal/sync-leave-requests` | `15,45 * * * *` |
| `/api/internal/class-assignments/morning` | `41 23 * * *` |
| `/api/internal/class-assignments/admin-email` | `4,14,24,36 0 * * *` |
| `/api/internal/student-promotions/july-1` | `5 17 30 6 *` |
| `/api/internal/cron-watchdog` | `7,37 * * * *` |
| `/api/internal/admissions-notifications` | `12 1 * * *` |
| `/api/internal/line-credit-digest` | `3 2 * * *` |

- Cron auth is centralized and constant-time: `getCronSecretStatus()` length-checks then `timingSafeEqual`s the `Authorization` header against `Bearer ${CRON_SECRET}`, and `rejectInvalidCronSecret()` returns 500 when the secret is unset, 401 when it mismatches (`src/lib/internal/cron-auth.ts:6-27`).
- A separate in-app registry (`src/lib/data-health/cron-registry.ts:3-24`) declares **22 job keys** — the 17 scheduled above plus **5 `manualOnly`** jobs (post-class-feedback digest / day-after / deadline, room utilization, LINE backlog recovery). Each entry carries `lateAfterMinutes`, `maxDurationSeconds`, and a `dangerous` flag (**9 jobs** are flagged dangerous, i.e. they send email, move money, or mutate Wise) that drives the Data Health dashboard and the `cron-watchdog`. The registry's `maxDurationSeconds` must mirror the route's own `maxDuration`, because health derivation uses the registry value for stuck detection (`cron-registry.ts:119-122`).
- Function durations are set per-route via `export const maxDuration`, **not** in `vercel.json`: **30 routes at `800`** (Wise/sales/wise-activity/post-class collection + backfill + payout-accrual/leave/credit-control/payroll/competitor/room-utilization syncs, student-promotion runs and applies, sales imports, post-class payout runs, the Data Health manual job runner), **12 at `300`** (class-assignment run + publish + admin-email, progress-tests sync + digest, admissions notifications, LINE credit digest, LINE backlog recovery, LINE followers re-anchor, post-class admin digest, cron-watchdog), and **1 at `60`** (`src/app/api/line/webhook/route.ts:6`).

**Environment (`src/lib/env.ts`):**
- A Zod schema validates env at startup and throws on failure, logging only `fieldErrors` (`src/lib/env.ts:3-36`, `:40-47`). **18 declared vars**: 7 hard-required — `DATABASE_URL`, `AUTH_GOOGLE_ID`, `AUTH_GOOGLE_SECRET`, `AUTH_SECRET`, `WISE_USER_ID`, `WISE_API_KEY`, `CRON_SECRET` — plus 2 required-with-default (`WISE_NAMESPACE` → `begifted-education`, `WISE_INSTITUTE_ID` → `696e1f4d90102225641cc413`) and **9 optional**: `LINE_CHANNEL_SECRET`, `LINE_CHANNEL_ACCESS_TOKEN`, `ENABLE_LINE_SCHEDULER`, `LINE_SCHEDULE_BOT_ADMIN_IDS` (fail-closed: unset disables the schedule bot entirely), `ENABLE_STUDENT_SCHEDULE_LIVE` (fail-**open**: only the exact string `"false"` disables the live overlay), `STUDENT_SCHEDULE_LINK_TTL_DAYS` (coerced positive int, defaults to 30), `APP_BASE_URL`, `MAINTENANCE_MODE` (fail-open: only the exact string `"true"` engages), `MAINTENANCE_BYPASS_EMAILS` (fail-closed).
- `MAINTENANCE_MODE` is declared here **for inventory parity only** — `src/middleware.ts` runs on the edge and reads `process.env` directly, because this module throws on a partial env (`src/lib/env.ts:28-31`).
- **74 distinct env names are read across `src/` + `scripts/`; only the 18 above are schema-validated, leaving 56 unvalidated.** 65 are reached as `process.env.X`; a further 9 payout names are read through a dynamic indexer in `src/lib/post-class-feedback/payout-config.ts:11-13` and so are invisible to a naive grep (`POST_CLASS_PAYOUT_TARGET`, `_CONNECTED_EMAIL`, `_DRIVE_FOLDER_ID`, `_WORKBOOKS_FOLDER_ID`, `_MASTER_SPREADSHEET_ID`, `_SOURCE_SHEET_NAME`, `_DEDUCTIONS_SHEET_NAME`, `_COMPOSITE_SHEET_NAME`, `_WRITES_ENABLED`). By group the unvalidated set is: AI (`OPENAI_API_KEY`, `OPENAI_SCHEDULER_MODEL`/`_SHADOW_MODEL`/`_REASONING_EFFORT`, `OPENAI_PROGRESS_TEST_MODEL`, `OPENAI_POST_CLASS_FEEDBACK_MODEL`, `OPENAI_COMPETITOR_INTEL_MODEL`, `ENABLE_AI_SCHEDULER`, `ENABLE_COMPETITOR_AI`); Sheets/Drive (`LEAVE_REQUESTS_SPREADSHEET_ID`, `LEAVE_REQUESTS_SHEET_NAME`, `LEAVE_REQUESTS_CONNECTED_EMAIL`, `SALES_DASHBOARD_CONNECTED_EMAIL`); schedule email (`SCHEDULE_EMAIL_APPS_SCRIPT_URL`/`_SECRET`, `SCHEDULE_EMAIL_BACKUP_APPS_SCRIPT_URL`/`_SECRET`, `SCHEDULE_EMAIL_PUBLIC_BASE_URL`, `SCHEDULE_EMAIL_REPLY_TO`, `SCHEDULE_EMAIL_SENDER_NAME`); email (`RESEND_API_KEY`, `ADMISSIONS_EMAIL_FROM`, `ADMISSIONS_EMAIL_REPLY_TO`); competitor intel (`APIFY_API_TOKEN`, `APIFY_FACEBOOK_ACTOR`, `APIFY_INSTAGRAM_ACTOR`, `DATAFORSEO_LOGIN`, `DATAFORSEO_PASSWORD`, `COMPETITOR_INTEL_MONTHLY_CAP_USD`, `COMPETITOR_APIFY_COST_PER_ITEM_USD`, `COMPETITOR_DATAFORSEO_COST_PER_QUERY_USD`, `COMPETITOR_DATAFORSEO_MONTHLY_CAP_USD`); the nine payout names above; post-class charging (`POST_CLASS_AUTO_APPROVE_ENABLED`, `POST_CLASS_AUTO_APPROVE_GRACE_HOURS`); Wise write gates (`WISE_SESSION_CREATE_VERIFIED`, `WISE_SESSION_OPERATIONS_VERIFIED`, `WISE_SESSION_SUBJECT_UPDATE_VERIFIED`); plus `LINE_VALIDATION_LEAD_EMAILS`, `NEXT_PUBLIC_APP_URL`, `VERCEL_URL`, `VERCEL_PROJECT_PRODUCTION_URL`, `PRODUCTION_BRANCH`, `SEED_ADMIN_EMAILS`, `TEST_DATABASE_URL`, `CONFIRM_DELETE_LINE_TEST_DATA`, and the ambient `GITHUB_ACTOR` / `USER`.
- **Money- and Wise-write kill switches all follow the same "exact string `true`" contract**: `payoutWritesEnabled()` gates every app-originated payout write (`src/lib/post-class-feedback/payout-config.ts:49-51`); `POST_CLASS_AUTO_APPROVE_ENABLED` gates unattended charging and its auto-un-charge counterpart (`payout-config.ts:165`, `payout-retirement.ts:169`); `WISE_SESSION_CREATE_VERIFIED` (`src/lib/progress-tests/config.ts:50`), `WISE_SESSION_OPERATIONS_VERIFIED` (`src/lib/wise/operations.ts:11`), and `WISE_SESSION_SUBJECT_UPDATE_VERIFIED` (`src/lib/student-promotions/data.ts:450`) gate the three Wise session mutation paths. `payout-config.ts` deliberately hardcodes **no** spreadsheet, folder, tab, or account fallbacks — every deployment must name whether it targets `scratch` or `production` and supply every Google resource id.

**ESLint (`eslint.config.mjs`):** flat config; `next/core-web-vitals` + `next/typescript`; global ignores `.next/**`, `out/**`, `build/**`, `next-env.d.ts`.

**PostCSS (`postcss.config.mjs`):** single plugin `@tailwindcss/postcss`.

**shadcn (`components.json`):** style `base-nova`; baseColor `neutral`; CSS vars on; icon library `lucide`; RTL off; aliases `@/components`, `@/components/ui`, `@/lib`, `@/lib/utils`, `@/hooks`.

**Release guards (`scripts/`):**
- `check-production-route-surface.mjs` walks `src/app` for `page.tsx`/`route.ts`, strips route groups (`(x)`) and parallel segments (`@x`), and diffs the result against the committed manifest `docs/reference/production-route-surface.json` (keys `version`, `description`, `recordedAt`, `productionDeployment`, `minSourceRouteCount`, `criticalRoutes`, `sourceRoutes`) — currently **211 recorded source routes, `minSourceRouteCount` 211, 9 critical routes**, `recordedAt` 2026-07-29. A route cannot silently vanish from a release.
- `assert-production-deploy-ready.mjs` refuses to deploy from a non-`main` branch (overridable via `PRODUCTION_BRANCH`), a dirty worktree, or a `HEAD` that differs from `origin/main` (`scripts/assert-production-deploy-ready.mjs:5,17-40`).
- `check-sales-dashboard-scope.mjs` restricts one named collaborator (`aoengnatchasmith-spec`, resolved from `GITHUB_ACTOR` or `--actor`) to five sales-dashboard path prefixes (`scripts/check-sales-dashboard-scope.mjs:3-11`).

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
| `line:test-data:cleanup` | `tsx scripts/delete-line-test-data.ts` | Delete LINE test data (guarded by `CONFIRM_DELETE_LINE_TEST_DATA`) |
| `line:find-user-ids` | `tsx scripts/find-line-user-ids.ts` | Harvest LINE user IDs for the schedule-bot allowlist (read-only) |
| `payout:inventory` | `npx tsx --tsconfig scripts/tsconfig.json scripts/inventory-payout-workbooks.ts` | Inventory payout workbooks in Drive |
| `payout:setup-master-tabs` | `… scripts/setup-payout-master-tabs.ts` | Create the payout master workbook tabs |
| `payout:repoint-workbooks` | `… scripts/repoint-payout-workbook-formulas.ts` | Repoint tutor-workbook QUERY formulas at the master |
| `payout:restore-workbooks` | `… scripts/restore-payout-workbook-formulas.ts` | Restore workbook formulas from backup |
| `payout:derive-tutor-names` | `… scripts/derive-payout-tutor-names.ts` | Derive tutor names for payout workbooks |
| `payout:roll-workbooks` | `… scripts/roll-payout-workbook-dates.ts` | Roll payout workbook date ranges forward |
| `payout:backfill-submitted` | `… scripts/backfill-payout-tutor-submitted.ts` | Backfill `tutor_submitted_at` on payout rows |
| `payout:remove-netted` | `… scripts/remove-netted-payout-rows.ts` | Remove netted rows from the payout master |
| `payout:reconcile-sheet` | `… scripts/report-payout-sheet-reconciliation.ts` | Report payout sheet vs. ledger reconciliation |
| `guard:sales-dashboard-scope` | `node scripts/check-sales-dashboard-scope.mjs` | Restrict one named collaborator to five sales-dashboard path prefixes |
| `guard:production-route-surface` | `node scripts/check-production-route-surface.mjs` | Diff `src/app` routes against the committed route manifest |
| `verify:release` | `npm run typecheck && npm test && npm run build && npm run typecheck && git diff --check && npm run guard:production-route-surface` | Full pre-release gate; note `typecheck` runs twice, once before and once after `build` |
| `deploy:prod` | `npm run verify:release && node scripts/assert-production-deploy-ready.mjs && npx vercel --prod` | Guarded manual production deploy |

> `tsx` is invoked by the seed/script/payout commands but is **not** declared in `package.json` — it resolves transitively (`drizzle-kit@0.31.10 → tsx@4.21.0`, deduped with `vitest@4.1.5 → vite@8.0.10 → tsx`), so a dependency bump could remove it without warning. The nine `payout:*` scripts pass `--tsconfig scripts/tsconfig.json` so `server-only` resolves to the local stub.
>
> Many `scripts/` entries have no npm alias and are run ad hoc via `tsx` — the post-class remediation and reporting one-shots (`remediate-auto-approved-deductions.ts`, `reinstate-short-content-deductions.ts`, `reassess-content-bar.ts`, `supersede-inc-260829-adjustments.ts`, `backfill-ledger-removed-retirement.ts`, `report-tutor-feedback-submissions.ts`, `report-student-classes.ts`, `report-online-by-year.ts`, `price-student-credits.ts`), plus `ipeds-import.ts`, `replay-ai-scheduler-runs.ts`, `backlog-recovery-dry-run.ts`, `verify-drive-upload.ts`, `probe-wise-availability-range.ts`, `evaluate-ai-scheduler-2026-05-21.ts`, and the shared helpers in `scripts/lib/` (`payout-script.ts`, `payout-formula-backup.ts`).

## Platform Requirements

**Development:**
- Node.js (ES2017+; no version pinned) and npm.
- A PostgreSQL connection (Neon or local) via `DATABASE_URL`.
- Google OAuth credentials for auth.
- The 9 required env vars set (validated at startup by `src/lib/env.ts`); the optional LINE / student-schedule / maintenance / OpenAI / Sheets / Drive / Resend / Apify / DataForSEO / payout vars enable those features. Every money-moving and Wise-mutating path is additionally off unless its flag is the exact string `true`.
- Docker available for `test:integration` (testcontainers spins up `postgres:16-alpine`); `TEST_DATABASE_URL` is the no-Docker escape hatch and must point at a scratch database, because the helper migrates and truncates it.
- The `extensions/line-oa-resolver/` Chrome extension is loaded unpacked; it has no build or install step.

**Production:**
- Vercel **Pro** — 17 crons and the `sin1` region (`vercel.json`); per-route function ceilings up to 800s.
- Neon Postgres (ap-southeast-1).
- External integrations: Wise API (`https://api.wiseapp.live`), OpenAI Responses API, Google Sheets + Drive + OAuth + Apps Script, LINE Messaging API, Resend, Apify, and DataForSEO.
- Production URL: https://bgscheduler.vercel.app

---

_Verified against main@0cd1e81 (clean tree) on 2026-09-02._
