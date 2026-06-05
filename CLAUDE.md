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

Production sync is live. First successful sync completed 2026-04-07 (commit `c673999`), promoting snapshot `d70608b0` with 131 teachers and 72 identity groups. Cron runs every 30 minutes on Vercel Pro with a single-flight guard.

UX/UI refresh v2 deployed 2026-04-08 (commits `38b4688`–`b11734d`): side-by-side layout (search left, compare right), sky blue palette, Inter font, GCal-style week view, searchable tutor combobox, discovery modal. `/compare` redirects to `/search`.

Week view QA fixes deployed 2026-04-08: GCal-style overlap detection (sub-columns for overlapping sessions), consistent card styling (28% bg opacity, solid borders), sticky day headers with vertical scrolling.

Compare calendar v3 deployed 2026-04-08 (commits `c52deb8`–`9c6d637`): week picker with date-range session filtering (prev/next arrows, Today button, dated day tabs), sub-column cap (max 3 single-tutor / 2 multi-tutor with "+N more" overflow badges), improved card readability for narrow sub-columns.

Compare calendar v3.1 deployed 2026-04-08 (commit `f689edb`): weekday fallback for missing session data (past days pull nearest future occurrence), free-gap availability indicators (green tint only where tutor is available with no session), D/M date format throughout.

Compare performance v4 deployed 2026-04-08 (commit `f4cd925`): client-side tutor cache with incremental fetch. Adding a tutor only fetches the new tutor's schedule (`fetchOnly` param); removing a tutor reuses cached data and only recomputes conflicts/free-slots server-side. AbortController for request cancellation, automatic cache invalidation on snapshot change.

Calendar date picker deployed 2026-04-10: click the week label to open a month-grid calendar popup (custom `WeekCalendar` component, no new dependencies). Full-week highlight band, week-row hover preview, today indicator. Click any date to jump to that week. Prev/next arrows and Today button unchanged.

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
- **Deployment**: Vercel Pro plan (30-minute cron, 800s sync function timeout)
- **Data integrity**: Fail-closed safety rules are non-negotiable
- **Visual**: Keep GCal-style calendar grid and sky blue color palette
- **Regression**: All 82 existing tests must continue to pass
<!-- GSD:project-end -->

<!-- GSD:stack-start source:codebase/STACK.md -->
## Technology Stack

No stack changes from the locked baseline — all versions current as of 2026-05-31.

- **Languages**: TypeScript ^5.9.3 (all of `src/`); SQL (PostgreSQL) via Drizzle migrations in `drizzle/` (35 files). Config tooling in `.mjs`.
- **Runtime**: Node.js (no version pinned), Vercel Serverless Functions. TS target ES2017, module `esnext`, `moduleResolution: bundler`. Package manager npm (`package-lock.json`).
- **Framework**: Next.js 16.2.2 (App Router, `cacheComponents: true` — the only custom `next.config.ts` setting; uses `"use cache"` + `cacheTag`/`cacheLife`). React / React DOM 19.2.4. UI under `src/app/`, authed routes in the `(app)` group.
- **Testing**: Vitest ^4.1.2 with two projects — `unit` (node env, `src/**/*.test.ts(x)`) and `integration` (`*.integration.test.ts`, serial forks). `testcontainers` spins up ephemeral Postgres for the 3 integration suites. `@vitest/coverage-v8` for coverage.
- **DB / ORM**: `drizzle-orm` 0.45.2 (schema with 90 tables at `src/lib/db/schema.ts`). `@neondatabase/serverless` is the primary driver (neon-http, singleton on `globalThis.__bgscheduler_db`). `pg` ^8.21.0 is used ONLY where transactions are required (payroll sync via `node-postgres`), since neon-http has no transaction support. `drizzle-kit` ^0.31.10 for migrations.
- **Auth / validation**: `next-auth` 5.0.0-beta.30 (Auth.js v5, Google provider + `admin_users` allowlist; edge variant `src/lib/auth-edge.ts` backs middleware). `zod` ^4.3.6 (centralized env schema + per-route body schemas).
- **AI scheduler**: no vendor SDK — calls OpenAI's Responses API directly over `fetch`; reads `OPENAI_*` from `process.env`, gated by `ENABLE_AI_SCHEDULER`.
- **Sheets ingest**: no Google client lib — leave-request import hits OAuth + Sheets over `fetch`. `xlsx` ^0.18.5 parses sales-dashboard/projection imports.
- **UI / styling**: Tailwind CSS ^4 (theme in `src/app/globals.css`, OKLCH tokens; no `tailwind.config`), `shadcn` ^4.1.2 over `@base-ui/react` 1.3.0, `cmdk`, `lucide-react`, `class-variance-authority` + `clsx` + `tailwind-merge` (`cn()`), `chart.js`. Fonts: Inter + JetBrains Mono via `next/font/google`.
- **Dates**: `date-fns` + `date-fns-tz` (Asia/Bangkok), `uuid`.
- **Config**: strict TS, path alias `@/*` → `./src/*`. ESLint 9 flat config (`next/core-web-vitals` + `next/typescript`, no custom rules). `src/lib/env.ts` validates 9 required env vars at startup (+ 3 optional LINE vars); function `maxDuration` is set per-route (most sync/import routes 800s on Vercel Pro), NOT in `vercel.json`.
- **Platform**: Vercel Pro with 10 staggered crons (Wise snapshot `*/30`, plus sales/credit-control/wise-activity/leave-requests/progress-tests/class-assignment/student-promotion crons); Neon Postgres (ap-southeast-1); Docker for integration tests. External: Wise API, OpenAI (when enabled), Google Sheets, LINE Messaging API.

_Full detail: [.planning/codebase/STACK.md](.planning/codebase/STACK.md) and the [docs/ handbook](docs/README.md)._
<!-- GSD:stack-end -->

<!-- GSD:conventions-start source:CONVENTIONS.md -->
## Conventions

These hold across all subsystems (search/compare, classroom assignment, sales, credit control, payroll, LINE/AI review, leave requests, room capacity, Wise activity).

- **Naming**: kebab-case files (`.tsx` for components, `.ts` for logic/types); singular `schema.ts`; per-domain `types.ts`. Tests are `{module}.test.ts(x)` inside a sibling `__tests__/` dir (never colocated); integration tests use `.integration.test.ts`. camelCase functions, verb-prefixed: `get*`/`is*`/`has*`/`should*`/`make*`/`create*`/`parse*`/`normalize*`/`fetch*`/`derive*`/`resolve*`/`build*`/`compute*`/`detect*`/`find*`. UPPER_SNAKE_CASE constants. PascalCase types — domain-prefixed `Wise*` / `Indexed*` / `Normalized*` / `Compare*` / `Parsed*`. `interface` for shapes, `type` for unions. No TS `enum` — DB uses Drizzle `pgEnum` (snake_case SQL names, camelCase Drizzle objects).
- **Code style**: no formatter config; 2-space indent; double quotes; semicolons in `src/lib/**` and `src/app/**` but OMITTED in shadcn/ui primitives (`src/components/ui/*` — leave as-is). Trailing commas, template literals. Two section-header comment styles coexist (em-dash bars in `src/lib`, long-hyphen blocks in `src/components`/newer libs) — match the file. Strict TS; non-null assertions only after defensive checks; type-predicate filters at boundaries.
- **Imports**: external → `@/` aliases → relative → `import type`. Single alias `@/*` → `./src/*` (in both `tsconfig.json` and `vitest.config.ts`). No barrel files — import from specific files (exception: `import * as schema from "@/lib/db/schema"`).
- **Error handling**: every mutating route follows 4 steps — `auth()` → 401; `request.json()` in try/catch → 400; `schema.safeParse()` → 400 with `.error.flatten()`; business logic in try/catch → 500 with `err instanceof Error ? err.message : "…"`. Statuses 200/400/401/404/500. Internal cron routes use **constant-time** `CRON_SECRET` comparison (`timingSafeEqual` + length pre-check, REL-07) via shared `src/lib/internal/cron-auth.ts`. Optional-table routes detect "relation does not exist" and return a typed missing payload (HTTP 200), not 500.
- **Fail-closed (non-negotiable)**: unknown session status → blocking; unresolved identity/modality/qualification → "Needs Review", never "Available"; cancelled sessions non-blocking; modality contradictions emit `unknown` + low confidence, never guess.
- **Validation**: Zod schemas as module-scope `const`; always `.safeParse()` (never `.parse()`). Prefer `z.coerce.*` for boundary parsing; Zod also validates external Wise payloads. Env centralized in `src/lib/env.ts` (9 required + 3 optional LINE vars; throws on invalid, logs only `fieldErrors`).
- **Logging**: bare `console.error`/`console.log` only (no logger). Errors that must surface in Vercel logs or fire-and-forget boundaries use `console.error`; `console.log` reserved for the seed script. Never log bodies/secrets/env values.
- **Comments**: JSDoc on exported functions (numbered steps for multi-step algorithms). Design-decision IDs (`D-04`, `MOD-01`, `REL-07`, `PAST-01`, etc.) are **load-bearing** — preserve them when editing nearby code. Zero `TODO`/`FIXME`/`HACK` in non-test source.
- **Function design**: destructured object params for 3+ args / config objects; pipeline fns return `{ result, issues }`; guards return `T | null`; nullable returns use `| null`, not `undefined`.
- **Modules**: named exports only (zero default exports in `src/lib`/`src/components`); page components and route handlers are the exceptions. Singletons are `globalThis`-anchored (`__bgscheduler_db`, `__bgscheduler_searchIndex`, `__bgscheduler_searchIndexBuildPromise`) to survive HMR — NOT `let _db`. Route logic lives in plain `src/lib/{domain}/*.ts` so it's unit-testable without the Next/auth route graph.
- **Components**: shadcn/ui primitives in `src/components/ui/` (CVA `cva()` + `cn()`); feature dirs under `src/components/{feature}/`. Pages are async Server Components that fetch via server-only lib helpers and pass props to a client shell wrapped in `<Suspense>` with a skeleton. `"use client"` on interactive components; `useState`/`useCallback`/`useRef`/`useEffect` only (no Redux/Zustand). Tailwind 4 inline classes; OKLCH semantic tokens (`--available`/`--blocked`/`--conflict`/`--free-slot`); `TUTOR_COLORS = ["#3b82f6","#e67e22","#7c3aed"]`. Intentional non-reactive effects carry a targeted `eslint-disable` comment.

_Full detail: [.planning/codebase/CONVENTIONS.md](.planning/codebase/CONVENTIONS.md) and the [docs/ handbook](docs/README.md)._
<!-- GSD:conventions-end -->

<!-- GSD:architecture-start source:ARCHITECTURE.md -->
## Architecture

**Pattern**: snapshot-versioned ETL + in-memory query index, extended into a multi-domain admin platform. Wise (the source of truth) is slow and rate-limited, so it is never queried on the request path — a background sync pulls all tutor data, normalizes it through six domain modules, persists it to Postgres tables keyed by an immutable `snapshot_id`, and serves search/compare reads from a process-global in-memory index. The same spine now hosts ~15 feature subsystems (search/compare, sales dashboard, credit control, payroll, leave requests, LINE/AI review, classroom assignment, room capacity, AI scheduler), each with its own sync/import pipeline and tables. Scale: **90 tables, 111 route files (130 endpoints), 10 crons, 17 in-app pages, 162 test files**.

- **Core invariants**:
  - **Snapshot persistence** — tutor writes scoped to `snapshot_id`; one atomic `UPDATE` flips a candidate to `active = true` after a successful sync; failed syncs preserve the prior snapshot. `past_session_blocks` is the sole cross-snapshot table (keyed by `group_canonical_key`).
  - **Single in-memory index** — the active snapshot is loaded once into a `globalThis`-anchored singleton (`__bgscheduler_searchIndex`) and queried in-process; `ensureIndex()` rebuilds on snapshot-id or profile-version change, with build-promise coalescing against thundering herds.
  - **ETL orchestrator** — one `runFullSync()` (`src/lib/sync/orchestrator.ts`) does fetch → normalize → persist → validate → promote in a single try/catch; `run-wise-sync.ts` wraps it with a single-flight guard and `revalidateTag("snapshot")` on success.
  - **Fail-closed safety** — unresolved identity/modality/qualification → "Needs Review", never "Available" (`src/lib/search/engine.ts`).
  - **Server-first reads** — Server Components fetch via cached `src/lib/data/*` helpers (`"use cache"` + `cacheTag`/`cacheLife`); clients hydrate from props and call API routes.
- **Layers** (lower layers know nothing of upper): Wise client `src/lib/wise/` (retry/backoff, concurrency limiter 5→15 for sync, `RETRYABLE_STATUS_CODES` so 4xx fail fast; no internal imports) → normalization `src/lib/normalization/` (identity 5-step cascade, availability, leaves, sessions, qualifications, modality, timezone; depends only on Wise types) → orchestrator `src/lib/sync/` → DB `src/lib/db/` (`getDb()` Neon-http singleton, `schema.ts`) → in-memory index `src/lib/search/index.ts` → search engine `engine.ts` (recurring/one-time, multi-slot intersection) + compare engine `compare.ts` (`buildCompareTutor`/`detectConflicts`/`findSharedFreeSlots`) → API routes `src/app/api/` → server data layer `src/lib/data/` → frontend `src/app/(app)/` + `src/components/`.
- **Key abstractions**: Snapshot (immutable point-in-time data); IndexedTutorGroup (denormalized read aggregate with O(1) `byWeekday`, `canonicalKey` denormalized for cross-snapshot past-session fetch); IdentityGroup (5-step cascade merging Wise teacher records); WiseClient (rate-limited HTTP); SearchIndex singleton (lazy, stale-detected); client-side `CompareTutor` cache (`Map<"tutorGroupId:weekStart:CACHE_VERSION", CompareTutor>` in `src/hooks/use-compare.ts`, version `v3`).
- **Entry points**: `/` renders the Ops Hub (`src/app/(app)/page.tsx` → `HomeHub`); `src/app/(app)/search/page.tsx` (async Server Component → `<SearchWorkspace>`); `src/app/api/internal/sync-wise/route.ts` (`maxDuration=800`, cron `*/30`, constant-time `CRON_SECRET`) + 6 other internal crons; `src/middleware.ts` (auth gate via edge Auth.js, public-route allowlist, else redirect to `/login`).
- **Error handling**: fail-closed at the data boundary, fail-loud at the API boundary (uniform auth→JSON→Zod→try/catch), fail-isolated inside sync (per-teacher errors → `data_issues`, no abort; top-level throw → `sync_runs.status="failed"`, no promotion; promotion gate blocks at ≥50% unresolved identity). Staleness is a warning (90-min threshold), never withheld data.
- **Cross-cutting**: Auth.js v5 (edge + Node split, `admin_users` allowlist, `spreadsheets.readonly` scope); Zod everywhere; `console.error` only; all times `Asia/Bangkok`; Next `"use cache"` tags (`snapshot` swept on sync, `past-sessions` deliberately not); non-Wise subsystems replicate the single-flight + `*_sync_runs` discipline rather than the snapshot/index machinery.

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
