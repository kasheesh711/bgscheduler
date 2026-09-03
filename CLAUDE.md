@AGENTS.md

## Quick Reference

- **Production URL**: https://bgscheduler.vercel.app
- **Repo**: https://github.com/kasheesh711/bgscheduler
- **Database**: Neon Postgres (ap-southeast-1)
- **Wise API**: https://api.wiseapp.live
- **Wise namespace**: `begifted-education`
- **Wise institute**: `696e1f4d90102225641cc413`
- **Docs**: comprehensive handbook at [docs/README.md](docs/README.md); open questions in [docs/OPEN-QUESTIONS.md](docs/OPEN-QUESTIONS.md)

## Current Status

Production is `origin/main` at the 2026-09-02 refresh (docs regenerated from code, Tier 1 scheduled-load fixes). Scale at that commit: 189 tables and 61 enums in `src/lib/db/schema.ts`, 180 `route.ts` files exporting 243 method+path endpoints, 31 `page.tsx` files (26 in the authenticated `(app)` group, 3 `(print)` reports, `/login`, the public `/schedule/[token]`), 22 navigation tools in 6 sections, 17 Vercel Cron entries plus 5 manual-only registry jobs, 389 Vitest files (13 Testcontainers integration suites), 69 Drizzle migrations.

Shipped since the previous refresh (2026-08-05): Parent Report (`/student-report` page, A4 print route, `GET /api/student-report`, LINE `/report`), the LINE credit bot (`/credit`, `/credit setup`) with the daily `line-credit-digest` cron, maintenance mode (`MAINTENANCE_MODE`, `MAINTENANCE_BYPASS_EMAILS`), post-class payout runs with unattended charging behind `POST_CLASS_AUTO_APPROVE_ENABLED` / `POST_CLASS_PAYOUT_WRITES_ENABLED` and the hourly `payout-accrual` cron, student-schedule live refresh, classroom continuity, and the Tier 1 cron fixes (registry/route `maxDuration` parity, bounded and pruned `cron_invocations`, collision-free calendar-job minutes, Wise call telemetry in `sync_runs.metadata`).

Handbook: [docs/README.md](docs/README.md). Efficiency and webhook roadmap: [docs/proposals/2026-09-02-cron-efficiency-and-wise-webhooks.md](docs/proposals/2026-09-02-cron-efficiency-and-wise-webhooks.md). Unresolved items: [docs/OPEN-QUESTIONS.md](docs/OPEN-QUESTIONS.md).

### Known Issues (open)
- **Online/onsite detection heuristic (search/compare only)**: the tutor snapshot still derives modality from the `location` pattern; the Student Schedule path uses the Wise session-title prefix (`deriveSessionModality`, >99.5% agreement with Wise `session_type`) and the same idea would close this. See [docs/features/student-schedule.md](docs/features/student-schedule.md).
- **Past-day session data**: Wise's `status: "FUTURE"` API omits past sessions; compare falls back to the nearest future occurrence of recurring sessions for earlier weekdays.
- **Wise availability spans are capped at 7 days** (HTTP 400 above that, probed 2026-09-02), so `sync-wise` must issue 26 windows per teacher; see the proposal for the tiered-horizon mitigation.
- **`codex/admissions-parity-hardening`** holds ~60 admissions files whose tables already exist on `main`; merge decision pending.

## Running Commands

```bash
# Deploy to production — push to main; Vercel Git integration auto-deploys.
# The bgscheduler Vercel project is linked ONLY to the /Users/.../Scheduling worktree.
# Do NOT run a bare `npx vercel --prod`: from any other (unlinked) worktree it
# silently creates a new stray Vercel project instead of deploying.
# Guarded manual path (from the linked worktree, on main): npm run deploy:prod
#   -> runs verify:release, then scripts/assert-production-deploy-ready.mjs
#      (refuses non-main branch, dirty tree, or HEAD != origin/main), then vercel --prod.
git push origin <branch>:main

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
- **Deployment**: Vercel Pro plan (30-minute cron, 800s sync function timeout)
- **Data integrity**: Fail-closed safety rules are non-negotiable
- **Visual**: Keep GCal-style calendar grid and sky blue color palette
- **Regression**: All existing test files (389 at 2026-09-02, 13 of them Testcontainers integration suites) must continue to pass

### University Admissions Case Management (in build)

A case management system for the BeGifted university counseling team at `/admissions`, replacing per-student "SummitEd" Google Sheets workbooks with full functional parity (profile, 10-phase checklist, college list, application/decision tracking, essays, activities, testing, meetings, notes, announcements, resources, deadline calendar).

- **Roles (4)**: `admin` (all cases) · `counselor` (new role, assigned cases only — hard wall) · `student` (own case, self-report sections only) · `parent` (own child's case, **view-only** curated dashboard). Google OAuth for all; per-case email membership resolves role at sign-in; every API request re-checks case membership in Postgres (`requireCaseAccess`).
- **Key rules**: notes default staff-only with explicit per-item sharing; parent responses built only by a whitelisted projection helper; raw test scores parent-visible only after counselor release; append-only audit log with field diffs on sensitive mutations; retention indefinite (documented business decision).
- **Integrations**: college list soft-references `ipeds_institutions.unitId` with add-to-case from `/us-universities`; email via existing Resend integration; mobile-first student/parent shells, desktop-dense staff workspace.
- **Docs**: PRD at [docs/Casemanagementsystem_prd.md](docs/Casemanagementsystem_prd.md); design at [docs/casemanagementsystem_design.md](docs/casemanagementsystem_design.md).
<!-- GSD:project-end -->

<!-- GSD:stack-start source:codebase/STACK.md -->
## Technology Stack

No stack changes from the locked baseline — all versions current as of 2026-09-02.

- **Languages**: TypeScript ^5.9.3 (1,099 TS/TSX files in `src/`, 389 Vitest specs — 320 `.test.ts` + 69 `.test.tsx`); SQL (PostgreSQL) via **69** Drizzle-generated migrations in `drizzle/`. A committed Chrome MV3 extension (`extensions/line-oa-resolver/`) is plain JS, untouched by the Next build.
- **Runtime**: Node.js (no version pinned), Vercel Serverless Functions pinned to the `sin1` region; 43 route files raise their own `maxDuration` ceiling (no `functions` block in `vercel.json`). TS target ES2017, module `esnext`, `moduleResolution: bundler`. Package manager npm (`package-lock.json`).
- **Framework**: Next.js 16.2.2 (App Router, `cacheComponents: true` — the only custom `next.config.ts` setting; 9 modules use `"use cache"` + `cacheTag`/`cacheLife`, invalidated by 21 `revalidateTag` call sites). React / React DOM 19.2.4. **31 `page.tsx` files** (26 authenticated `(app)` pages, 3 `(print)` reports, `/login`, public `/schedule/[token]`). **180 `route.ts` files export 243 endpoints** (241 named `GET|POST|PUT|PATCH|DELETE` handlers — 99 GET / 95 POST / 34 PATCH / 12 DELETE / 1 PUT — plus 2 destructured from the Auth.js catch-all; 2 CORS `OPTIONS` preflights excluded).
- **Testing**: Vitest ^4.1.2 with two projects — `unit` (node env, `src/**/*.test.ts(x)`) and `integration` (`*.integration.test.ts`, serial forks). `TZ` is pinned to `Asia/Bangkok` at config load. `testcontainers` spins up ephemeral Postgres for **13 `*.integration.test.ts` files** (10 post-class-feedback, 3 sync); `TEST_DATABASE_URL` is the no-Docker escape hatch.
- **DB / ORM**: `drizzle-orm` 0.45.2 (schema with **189 tables** + **61 pgEnums** at `src/lib/db/schema.ts`, 4,772 lines). `@neondatabase/serverless` is the primary driver (neon-http, singleton on `globalThis.__bgscheduler_db`). `pg` ^8.21.0 is used ONLY where transactions are required — payroll sync, post-class-feedback writes, and the admissions audit log — since neon-http has no transaction support. `drizzle-kit` ^0.31.10 for migrations.
- **Auth / validation**: `next-auth` 5.0.0-beta.30 (Auth.js v5, Google provider + `admin_users` allowlist; edge variant `src/lib/auth-edge.ts` backs middleware). `zod` ^4.3.6 (99 files) — per-route body schemas plus a centralized env schema at `src/lib/env.ts` that is **dead code**: zero importers anywhere in `src/`/`scripts/`, so it never actually validates or throws at boot.
- **AI scheduler and friends**: no vendor SDK — six modules call OpenAI's Responses API directly over `fetch` (AI scheduler, LINE classifier/contact-aliases, progress-test summaries, competitor intelligence, post-class feedback), each gated by its own `ENABLE_*` flag read straight from `process.env`.
- **External integrations (raw `fetch`, no client libraries)**: Wise API (retry/backoff, concurrency limiter 5→15 for sync); Google Sheets/Drive/OAuth + Apps Script (schedule-email); LINE Messaging API; Resend; Apify + DataForSEO (budget-capped).
- **UI / styling**: Tailwind CSS ^4 (no `tailwind.config`; theme in `src/app/globals.css` — 72 OKLCH declarations + 4 feature stylesheets), `shadcn` ^4.1.2 over `@base-ui/react` 1.3.0, `cmdk`, `lucide-react`, `class-variance-authority` + `clsx` + `tailwind-merge` (`cn()`), `chart.js`. Fonts: Inter, JetBrains Mono, Cormorant Garamond, Sarabun, Trirong via `next/font/google`.
- **Dates**: `date-fns` + `date-fns-tz` (Asia/Bangkok), `uuid`; `xlsx` for tutor-profile import + seed scripts.
- **Config**: strict TS, path alias `@/*` → `./src/*`. ESLint 9 flat config (`next/core-web-vitals` + `next/typescript`, no custom rules). `src/lib/env.ts` declares 18 env vars — 7 hard-required, 2 defaulted, 9 optional — but has **zero importers**, so this schema is inventory only; ~74 env vars are actually read straight off `process.env` across `src/` + `scripts/`. `maxDuration` is set per-route, NOT in `vercel.json`: 30 routes at 800s, 12 at 300s, 1 at 60s.
- **Platform**: Vercel Pro with **17 `vercel.json` cron entries** (`regions: ["sin1"]`) against a **22-entry** `data-health` cron registry (17 scheduled + 5 `manualOnly`); Neon Postgres (ap-southeast-1); Docker for integration tests. External: Wise API, OpenAI (when enabled), Google Sheets/Drive, LINE Messaging API, Resend, Apify, DataForSEO.

_Full detail: [.planning/codebase/STACK.md](.planning/codebase/STACK.md) and the [docs/ handbook](docs/README.md)._
<!-- GSD:stack-end -->

<!-- GSD:conventions-start source:CONVENTIONS.md -->
## Conventions

These hold across all subsystems (search/compare, classroom assignment, sales, credit control, payroll, LINE/AI review + credit bot, leave requests, room capacity, Wise activity, admissions, post-class payout). Where the newest modules (post-class-feedback payout, student-report, maintenance, admissions, competitor-intelligence) have refined an older pattern, the newer form is called out below as the one to copy.

- **Naming**: kebab-case files (`.tsx` for components, `.ts` for logic/types); singular `schema.ts`; per-domain `types.ts` (15 exist). Tests are `{module}.test.ts(x)` inside a sibling `__tests__/` dir (never colocated — zero exceptions across all 389 test files); integration tests use `.integration.test.ts` (13 files). camelCase functions, verb-prefixed: `get*`/`is*`/`has*`/`should*`/`make*`/`create*`/`parse*`/`normalize*`/`fetch*`/`derive*`/`resolve*`/`build*`/`compute*`/`detect*`/`find*`/**`require*`** (throws, 13 exported)/**`assert*`** (throws + returns `void`, 18 exported, concentrated in payout/finance write paths). UPPER_SNAKE_CASE constants. PascalCase types (1,017 exported from `src/lib`) — domain-prefixed `Admissions*`/`Line*`/`Wise*`/`Payout*`/`Indexed*`/`Normalized*`/`Compare*`/`Parsed*`, plus `*Dto` (Server↔Client boundary) and `*Input` (write-path args) suffixes. `interface` for shapes, `type` for unions. No TS `enum` — DB uses Drizzle `pgEnum` (61 declarations, snake_case SQL names, camelCase Drizzle objects).
- **Code style**: no formatter config; 2-space indent; double quotes everywhere (5,325 double-quoted `from "…"` specifiers, 0 single-quoted); semicolons in `src/lib/**` and `src/app/**` but OMITTED in the 16 shadcn/ui primitives (`src/components/ui/*` — leave as-is) and `src/lib/utils.ts`. Trailing commas, template literals. Two section-header comment styles coexist (em-dash bars in `src/lib`, long-hyphen blocks in `src/components`/newer libs) — match the file. Strict TS; non-null assertions only after defensive checks; type-predicate filters at boundaries.
- **Imports**: external → `@/` aliases → relative → `import type`. Single alias `@/*` → `./src/*` (in both `tsconfig.json` and `vitest.config.ts`). No barrel files — only 2 real `index.ts` in `src/lib` — import from specific files (exception: `import * as schema from "@/lib/db/schema"`, 116 sites). `import "server-only";` as line one, above everything, in 20 server-only modules.
- **Error handling**: two shapes coexist. **Shape A** (the original, still the majority) — `auth()` → 401; `request.json()` in try/catch → 400; `schema.safeParse()` → 400 with `.error.flatten()`; business logic in try/catch → 500 with `err instanceof Error ? err.message : "…"`. **Shape B** (every domain built since case management — the one to copy) — one `try` wraps a `require*` guard plus business logic, caught by a per-domain `{domain}ErrorResponse(route, error, fallback)` mapper (6 domains have one); both shapes re-throw Next's `HANGING_PROMISE_REJECTION` digest verbatim rather than convert it. Statuses in use: 400/401/500/404/409/403/… Internal cron routes use **constant-time** `CRON_SECRET` comparison (`timingSafeEqual` + length pre-check, REL-07) via shared `src/lib/internal/cron-auth.ts` (16 of 22 internal routes import it; 6 still inline an equivalent). Optional-table routes detect "relation does not exist" and return a typed missing payload (HTTP 200), not 500.
- **Fail-closed (non-negotiable)**: unknown session status → blocking; unresolved identity/modality/qualification → "Needs Review", never "Available"; cancelled sessions non-blocking; modality contradictions emit `unknown` + low confidence (MOD-01), never guess. Sign-in itself is fail-closed — an unresolved email → `null` → denied.
- **Validation**: Zod schemas as module-scope `const`; `.safeParse()` is the default (111 sites); `.parse()` only inside a `try` whose catch maps `ZodError` → 400. Prefer `z.coerce.*` for boundary parsing; Zod also validates external Wise/OpenAI payloads. `src/lib/env.ts` declares an 18-key schema (7 hard-required + 2 defaulted + 9 optional) but has **zero importers**, so it never runs at boot; the newer, preferred pattern is an **injectable environment record** (`env: PayoutEnvironment = process.env`, one `value(env, name)` reader) as in `payout-config.ts` and `maintenance.ts`.
- **Logging**: bare `console.error`/`console.log` only (no logger, zero `console.warn` anywhere in non-test source). `console.error` for anything that must surface in Vercel logs or sit at a fire-and-forget boundary; `console.log` confined to the seed script and the LINE schedule-bot's `[schedule-bot]` trace prefix. Never log bodies/secrets/env values — log only `error.name` for an unknown error at a money-moving boundary.
- **Comments**: JSDoc on exported functions (numbered steps for multi-step algorithms). Design-decision IDs are **load-bearing** — preserve them when editing nearby code. Largest live families by citation count: `CM-*` (637, admissions), `D-*` (72), `BOT-*` (59, LINE schedule bot), `REL-*` (28 — e.g. `REL-05` retryable statuses, `REL-07` constant-time cron auth), `MAINT-*` (21), plus `MOD-01`, `PAST-01`, `D-04`. Zero `TODO`/`FIXME`/`HACK` in non-test source.
- **Function design**: destructured object params for 3+ args / config objects; **`db: Database = getDb()`** as a defaulted trailing parameter is the dominant DI seam (227 non-test signatures) — the same shape now applies to environment access (`env: PayoutEnvironment = process.env`). Pipeline fns return `{ result, issues }`; `require*` guards throw (never nullable); `assert*` guards throw and return `void`; other guards return `T | null`; nullable returns use `| null`, not `undefined`.
- **Modules**: named exports only (zero default exports in `src/lib`/`src/components`); page components and route handlers are the exceptions. No Server Actions anywhere (`"use server"` returns zero hits). Singletons are `globalThis`-anchored (`__bgscheduler_db`, `__bgscheduler_searchIndex` + `__bgscheduler_searchIndexBuildPromise`, and `__bgscheduler_liveMonthSessionsCache`) to survive HMR — NOT `let _db`. Route logic lives in plain `src/lib/{domain}/*.ts` so it's unit-testable without the Next/auth route graph; a domain's conventional surface is `access.ts`/`api.ts` (guards + error mapper), `data.ts` (uncached reads), `service.ts` (`"use cache"` façade), `sync.ts` + `run-sync-request.ts` (ingest + single-flight).
- **Components**: shadcn/ui primitives in `src/components/ui/` (16 files, CVA `cva()` + `cn()`); 25 feature dirs under `src/components/{feature}/`. Pages are async Server Components that fetch via server-only lib helpers and pass props to a client shell wrapped in `<Suspense>` with a skeleton — required, not stylistic, under `cacheComponents: true`. `"use client"` on interactive components (150 files); `useState`/`useCallback`/`useRef`/`useEffect` only (no Redux/Zustand). Tailwind 4 inline classes; OKLCH semantic tokens (`--available`/`--blocked`/`--conflict`/`--free-slot`/`--today-indicator`); `TUTOR_COLORS = ["#3b82f6","#e67e22","#7c3aed"]`. Intentional non-reactive effects carry a targeted `eslint-disable` comment.

_Full detail: [.planning/codebase/CONVENTIONS.md](.planning/codebase/CONVENTIONS.md) and the [docs/ handbook](docs/README.md)._
<!-- GSD:conventions-end -->

<!-- GSD:architecture-start source:ARCHITECTURE.md -->
## Architecture

**Pattern**: snapshot-versioned ETL + in-memory query index, serving as the spine of a multi-domain admin platform. Wise (the source of truth) is slow and rate-limited, so it is never queried on the request path — a background sync pulls all tutor data, normalizes it through **seven** domain modules, persists it to Postgres tables keyed by an immutable `snapshot_id`, and serves search/compare reads from a process-global in-memory index built from the active snapshot. The same spine now hosts two dozen feature subsystems (search/compare, sales dashboard, credit control, payroll, leave requests, LINE/AI review, classroom assignment, room capacity, AI scheduler, student schedule, post-class feedback, learning plans, student promotions, university admissions, progress tests, competitor intelligence, US universities), each with its own sync/import pipeline and tables — `docs/features/` documents 22 of them; three more surfaces have shipped since as extensions of an existing subsystem rather than new doc entries: the parent **Student Report** (student schedule), the **LINE credit bot** (LINE integration), and **post-class payout** (post-class feedback). Scale: **189 tables + 61 enums, 243 endpoints across 180 `route.ts` files, 17 Vercel crons (22-entry registry), 31 `page.tsx` files (26 in-app), 389 test files, 69 SQL migrations**.

- **Core invariants**:
  - **Snapshot persistence** — tutor writes scoped to `snapshot_id`; one atomic `UPDATE` flips a candidate to `active = true` after a successful sync (REL-01); failed syncs preserve the prior snapshot. `past_session_blocks` is the sole cross-snapshot table (PAST-01, keyed by `group_canonical_key`).
  - **Single in-memory index** — the active snapshot is loaded once into a `globalThis`-anchored singleton (`__bgscheduler_searchIndex`) and queried in-process; `ensureIndex()` rebuilds on snapshot-id or profile-version change, with build-promise coalescing against thundering herds (REL-02).
  - **ETL orchestrator** — one `runFullSync()` (`src/lib/sync/orchestrator.ts`) does fetch → normalize → persist → validate → promote in a single try/catch, including a per-group MOD-01 modality-contradiction pass and a pre-promotion past-sessions diff hook; `run-wise-sync.ts` wraps it with a single-flight guard and `revalidateTag("snapshot")` on success.
  - **Fail-closed safety** — unresolved identity/modality/qualification → "Needs Review", never "Available" (`src/lib/search/engine.ts`); the same posture denies sign-in for an unrecognized email.
  - **Server-first reads** — Server Components fetch via cached `src/lib/data/*` helpers (`"use cache"` + `cacheTag`/`cacheLife`); clients hydrate from props and call API routes.
- **Layers** (lower layers know nothing of upper): Wise client `src/lib/wise/` (retry/backoff REL-05, concurrency limiter 5→15 for sync, `RETRYABLE_STATUS_CODES` so 4xx fail fast; no internal imports) → normalization `src/lib/normalization/` (identity 5-step cascade, availability, leaves, sessions, qualifications, modality MOD-01, timezone REL-08; depends only on Wise types) → orchestrator `src/lib/sync/` → DB `src/lib/db/` (`getDb()` Neon-http singleton, `schema.ts`; `pg` transaction fallback for 3 subsystems) → in-memory index `src/lib/search/index.ts` → search engine `engine.ts` (recurring/one-time, multi-slot intersection) + compare engine `compare.ts` (`buildCompareTutor`/`detectConflicts`/`findSharedFreeSlots`) → API routes `src/app/api/` → server data layer `src/lib/data/` → frontend `src/app/(app)/` + `src/components/` (22 nav tools across 6 sections, `src/lib/navigation/tools.ts`).
- **Key abstractions**: Snapshot (immutable point-in-time data); `canonicalKey` (D-04, stable cross-snapshot anchor denormalized onto `IndexedTutorGroup`); IdentityGroup (5-step cascade merging Wise teacher records); WiseClient (rate-limited HTTP); SearchIndex singleton (lazy, stale-detected, REL-02 promise-coalesced); client-side `CompareTutor` cache (`Map<"tutorGroupId:weekStart:CACHE_VERSION", CompareTutor>` in `src/hooks/use-compare.ts`, `CACHE_VERSION = "v3"`).
- **Entry points**: `/` redirects to `/search`; `src/app/(app)/search/page.tsx` (async Server Component → `<SearchWorkspace>`); `src/app/api/internal/sync-wise/route.ts` (`maxDuration=800`, cron `*/30`, REL-07 constant-time `CRON_SECRET`) + 21 other `/api/internal/*` route files (16 scheduled, 5 `manualOnly`) — e.g. `sync-wise-activity` at `2,17,32,47 * * * *` and the hourly `post-class-feedback/payout-accrual` at `33 * * * *`; `src/middleware.ts` (MAINT-04 maintenance gate, then public-route allowlist, then `allowedPages` page/API gate, else redirect to `/login`).
- **Error handling**: fail-closed at the data boundary, fail-loud at the API boundary (uniform auth→JSON→Zod→try/catch), fail-isolated inside sync (per-teacher errors → `data_issues`, no abort; top-level throw → `sync_runs.status="failed"`, no promotion; promotion gate blocks at ≥50% unresolved identity, REL-01). Staleness is a warning (90-min API threshold, 2h app banner), never withheld data.
- **Cross-cutting**: Auth.js v5 (edge + Node split, 5 roles resolved to an `allowedPages` JWT claim); Zod everywhere (`src/lib/env.ts` declares 18 vars but has **zero importers** — dead code that never validates or throws at boot; ~74 env vars are read directly off `process.env` instead); `console.error` only; all times `Asia/Bangkok` (REL-08); Next `"use cache"` tags (`snapshot` swept on sync, `past-sessions` deliberately not); 13 `*_single_running_idx` partial unique indexes enforce single-flight platform-wide, independent of the snapshot/index machinery.

_Full detail: [.planning/codebase/ARCHITECTURE.md](.planning/codebase/ARCHITECTURE.md), the [docs/ handbook](docs/README.md), and [docs/handbook/architecture.md](docs/handbook/architecture.md)._
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
