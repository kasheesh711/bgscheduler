# Codebase Structure

**Analysis Date:** 2026-09-02

BGScheduler began as a tutor availability search tool and is now **BeGifted Ops** — an internal operations platform (title string in `src/app/layout.tsx:47`, `metadata.title = "BeGifted Ops"`). The single tutor-search product has become 22 nav-registered tools plus print and public surfaces: search/compare, AI scheduler, LINE review + schedule bot + credit/report bots, leave requests, classroom assignments, room capacity, post-class feedback + tutor payouts, progress tests, student monthly schedules, parent class reports, learning plans, student promotions, university admissions case management, sales dashboard, credit control, payroll, competitor intelligence, US universities (IPEDS), Wise audit, and data health. Authoritative scale: **189 database tables, 243 HTTP endpoints across 180 `route.ts` files, 17 Vercel crons, 31 `page.tsx` files (26 in the authenticated route group), 389 test files.**

Three structural facts distinguish this tree from the original:
- `/` is no longer a redirect. `src/app/(app)/page.tsx` renders the Home Hub and redirects only users whose access is limited to a single page.
- Not every page is admin-only anymore. `src/app/schedule/[token]/page.tsx` is public (capability token), and `src/app/(print)/` is a second route group with no nav chrome, used for PDF export — now three reports, not two.
- A maintenance kill switch sits **above** the public-route allowlist in `src/middleware.ts:76-82` (`MAINT-04`), so engaging it also closes `/api/line/webhook`, which the allowlist would otherwise wave through.

## Directory Layout

```
bgscheduler/
├── src/
│   ├── app/                          # Next.js 16 App Router (cacheComponents: true)
│   │   ├── (app)/                    # Authenticated route group — 26 pages, shared AppNav layout
│   │   │   ├── page.tsx              # "/" Home Hub (single-page users redirect to their landing)
│   │   │   ├── layout.tsx            # <Suspense>AppNav + <Suspense>StaleSnapshotBanner + <main>
│   │   │   ├── search/               # page.tsx + loading.tsx — search + embedded compare
│   │   │   ├── compare/page.tsx      # Client redirect to /search (preserves ?tutors=)
│   │   │   ├── scheduler/            # page.tsx + metrics/page.tsx
│   │   │   ├── line-review/          ├── leave-requests/     ├── tutor-profiles/
│   │   │   ├── class-assignments/    ├── room-capacity/      ├── post-class-feedback/
│   │   │   ├── progress-tests/       ├── student-schedule/   ├── student-report/
│   │   │   ├── learning-plans/       ├── student-promotions/ ├── sales-dashboard/
│   │   │   ├── credit-control/       ├── payroll/            ├── competitor-intelligence/
│   │   │   ├── wise-activity/        ├── data-health/
│   │   │   ├── admissions/           # page.tsx + [caseId]/page.tsx
│   │   │   └── us-universities/      # page.tsx + [unitId]/{page,loading}.tsx (+ __tests__)
│   │   ├── (print)/                  # Print-only route group (no layout.tsx, no nav chrome)
│   │   │   ├── learning-plans/report/page.tsx
│   │   │   ├── student-schedule/report/page.tsx
│   │   │   └── student-report/report/page.tsx
│   │   ├── schedule/[token]/page.tsx # PUBLIC parent schedule — capability token is the credential
│   │   ├── login/page.tsx            # Google sign-in (no AppNav)
│   │   ├── api/                      # 180 route.ts files / 243 method handlers (see below)
│   │   ├── layout.tsx                # Root layout — 5 Google fonts, "BeGifted Ops"
│   │   ├── globals.css               # Tailwind 4 + shadcn theme + semantic tokens
│   │   ├── credit-control.css        # Page-scoped stylesheets imported by their pages
│   │   ├── learning-plans.css        #   (learning-plans.css owns the app-wide portrait @page)
│   │   ├── student-report.css
│   │   ├── student-schedule.css      # includes the named `schedule-landscape` @page rule
│   │   └── favicon.ico
│   ├── components/                   # 25 feature dirs + ui/ (see Directory Purposes)
│   ├── hooks/                        # use-compare, use-keyboard-shortcuts, use-resizable-split,
│   │                                 #   use-sales-dimensions, use-theme
│   ├── lib/                          # 36 domain dirs + 10 root modules (see Directory Purposes)
│   ├── types/                        # credit-control.ts, next-auth.d.ts, post-class-feedback.ts
│   ├── tests/integration/            # db-helper.ts + README (testcontainers Postgres harness)
│   ├── __tests__/                    # middleware.test.ts, vercel-crons.test.ts
│   └── middleware.ts                 # Maintenance gate → public allowlist → edge auth → page access
│
│   src/app/api/ (29 groups, route.ts file counts):
│   ├── admin/sync-wise               (1)   ├── admissions/            (21)
│   ├── ai-scheduler/                 (5)   ├── auth/[...nextauth]/     (1)
│   ├── class-assignments/            (8)   ├── classrooms/             (2)
│   ├── compare/                      (2)   ├── competitor-intelligence/(8)
│   ├── credit-control/               (7)   ├── data-health/            (2)
│   ├── filters/                      (1)   ├── home/summary/           (1)
│   ├── internal/                    (22)   ├── leave-requests/         (4)
│   ├── line/                        (25)   ├── payroll/                (5)
│   ├── post-class-feedback/         (13)   ├── progress-tests/         (6)
│   ├── proposals/                    (3)   ├── room-capacity/          (3)
│   ├── sales-dashboard/             (11)   ├── search/                 (3)
│   ├── student-promotions/           (8)   ├── student-report/         (1)
│   ├── student-schedule/             (2)   ├── tutor-profiles/         (4)
│   ├── tutors/                       (1)   ├── us-universities/        (5)
│   └── wise-activity/                (5)
│
│   src/app/api/internal/ (22 route.ts — cron + machine-only, CRON_SECRET):
│   ├── sync-wise/  sync-wise-activity/  sync-sales-dashboard/  sync-credit-control/
│   ├── sync-progress-tests/  sync-post-class-feedback/  sync-leave-requests/
│   ├── sync-competitor-intelligence/  sync-room-utilization/
│   ├── post-class-feedback-backfill/  post-class-feedback/{admin-digest,payout-accrual,
│   │     reminder-day-after,reminder-deadline}/
│   ├── progress-tests/admin-digest/   class-assignments/{morning,admin-email}/
│   ├── student-promotions/july-1/     admissions-notifications/
│   └── cron-watchdog/  line-backlog-recovery/  line-credit-digest/
│
├── drizzle/                          # 69 generated migrations (0000–0068) + meta/
├── scripts/                          # tsx/node ops scripts + lib/ helpers + stubs/server-only.ts
├── docs/                             # Code-verified handbook (see below)
│   ├── handbook/                     # overview, architecture, conventions, data-flow, glossary,
│   │                                 #   not-the-nextjs-you-know
│   ├── features/                     # 22 per-feature meaning docs
│   ├── reference/                    # api/ (14 files), database/ (14 files), crons.md, env.md,
│   │                                 #   wise-api.md, production-route-surface.json
│   ├── operations/                   # auth-and-access, observability, runbook, release-checkpoints/
│   ├── proposals/                    # dated evaluations not yet built (cron efficiency + webhooks)
│   └── superpowers/                  # vendored skill docs (do not edit)
├── extensions/line-oa-resolver/      # Chrome MV3 extension for LINE OA contact resolution
├── public/brand/                     # Static assets (brand marks + Next.js default SVGs)
├── .planning/                        # GSD artifacts — codebase/ (this map), phases/, milestones/, …
├── .github/                          # CODEOWNERS, PR template, workflows/{ci,sales-dashboard-scope}.yml
├── .claude/                          # Claude Code config (hooks/, workflows/, launch.json, README)
├── AGENTS.md                         # Primary agent instructions
├── CLAUDE.md                         # Includes AGENTS.md + stack/conventions (synced — do not hand-edit)
├── package.json                      # npm scripts (incl. verify:release, deploy:prod, payout:*)
├── tsconfig.json                     # Strict, ES2017, bundler resolution, @/* → ./src/*
├── next.config.ts                    # `cacheComponents: true` — the only override
├── vercel.json                       # regions: ["sin1"] + 17 cron schedules
├── vitest.config.ts                  # Two projects: unit (node) + integration (forks, serial)
├── drizzle.config.ts                 # postgresql, schema → ./src/lib/db/schema.ts, out → ./drizzle
├── eslint.config.mjs                 # Flat config (next/core-web-vitals + next/typescript)
├── postcss.config.mjs                # @tailwindcss/postcss only
└── components.json                   # shadcn/ui config (base-nova, lucide, rsc: true)
```

## Directory Purposes

**`src/app/`:**
- Purpose: Next.js 16 App Router — pages, route groups, API routes
- Contains: Server Components by default; client components opt in via `"use client"`. Five stylesheets live here: the global `globals.css` plus four page-scoped sheets (`credit-control.css`, `learning-plans.css`, `student-report.css`, `student-schedule.css`)
- Key files: `layout.tsx` (root; loads Inter, JetBrains Mono, Cormorant Garamond, Sarabun, Trirong via `next/font/google` — the last three with `preload: false`), `(app)/layout.tsx`, `middleware.ts` (sibling at `src/`)

**`src/app/(app)/`:**
- Purpose: Authenticated route group sharing the `AppNav` layout. 26 `page.tsx` files
- Notes: `(app)/layout.tsx:13-28` resolves nav access inside its own async component wrapped in `<Suspense>` — required because the uncached `auth()` call must not block the route group under `cacheComponents`. That component also resolves two fresh DB grants in parallel (`getPostClassCapabilities`, `getLearningPlansAccess`) so the nav reflects live capabilities rather than a stale JWT. Fallback is `AppNavSkeleton`, which deliberately avoids `usePathname()` so dynamic-param routes do not break the prerendered shell. `StaleSnapshotBanner` sits in a second `<Suspense fallback={null}>`
- Dynamic segments: `admissions/[caseId]`, `us-universities/[unitId]`
- Back-compat: `compare/page.tsx` is a client redirect to `/search` preserving `?tutors=`

**`src/app/(print)/`:**
- Purpose: Second route group for printable A4 output — no `layout.tsx`, so no nav, banner, or `<main>` wrapper
- Contains: `learning-plans/report/page.tsx`, `student-schedule/report/page.tsx`, `student-report/report/page.tsx`
- Notes: all three are admin-authenticated and set `robots: { index: false, follow: false }`; portrait is the app-wide default `@page` in `learning-plans.css`, and landscape comes from a *named* `schedule-landscape` `@page` rule in `student-schedule.css` so it cannot flip the other printable pages

**`src/app/schedule/[token]/`:**
- Purpose: The only unauthenticated page rendering student data. Reachable because `middleware.ts:21` allowlists the `/schedule/` prefix (the trailing slash keeps the authenticated `/student-schedule` admin page out of the allowlist)
- Notes: every failure mode (malformed / unknown / expired / revoked) renders one identical message, so the page cannot be used as a token oracle; the schedule is re-read live on each visit, so a link stays accurate but can never widen scope. `PublicScheduleShell` owns the scroll region and the agenda-vs-month-grid toggle, because the root layout body is a fixed-height `overflow-hidden` flex shell

**`src/app/api/`:**
- Purpose: HTTP endpoints — 243 method handlers across 180 `route.ts` files. Method mix: 99 GET, 95 POST, 34 PATCH, 12 DELETE, 1 PUT (241 named `export async function` handlers) plus `export const { GET, POST } = handlers` in the Auth.js catch-all (`src/app/api/auth/[...nextauth]/route.ts:3`). Two `OPTIONS` preflight handlers on the public OA-resolver routes are excluded from the 243
- Co-located: `__tests__/` in 75 route directories
- Per-route `maxDuration` is set in the route file, not `vercel.json` — 43 routes declare it: 30 at 800 (long syncs), 12 at 300 (medium jobs), 1 at 60 (`api/line/webhook`)
- Canonical signatures: `docs/reference/api/` (feature docs link there rather than restating)

**`src/app/api/internal/`:**
- Purpose: Cron-triggered, machine-only endpoints. They bypass session auth via the `/api/internal/` prefix in `middleware.ts:24` and instead require `CRON_SECRET`
- Contains: 22 `route.ts` files / 31 endpoints — 17 wired to `vercel.json` crons, 5 manual/admin-triggered (`line-backlog-recovery`, `sync-room-utilization`, and three of the four `post-class-feedback/*` jobs: `admin-digest`, `reminder-day-after`, `reminder-deadline`). `post-class-feedback/payout-accrual` is now a scheduled hourly cron, not manual
- Auth: constant-time comparison in `src/lib/internal/cron-auth.ts:14` (length pre-check + `timingSafeEqual`)

**`src/components/ui/`:**
- Purpose: Design-system primitives wrapping `@base-ui/react`
- Contains: 16 primitives — badge, button, card, checkbox, command, dialog, input, input-group, label, popover, select, separator, skeleton, table, tabs, textarea
- Source of truth: `components.json` (`style: "base-nova"`, `iconLibrary: "lucide"`, `rsc: true`, `baseColor: "neutral"`)

**`src/components/{feature}/`:**
- Purpose: Feature-scoped components, mostly `"use client"`
- 25 feature directories: `admissions` (25 `.tsx`, the largest), `us-universities` (20), `search` (15), `sales-dashboard` (13), `line-review` (13), `compare`, `credit-control`, `post-class-feedback` (9 each), `class-assignments`, `learning-plan` (6), `student-schedule` (5), `skeletons` (4), `student-report` (3), `layout`, `leave-requests`, `scheduler` (2), plus single-file roots for `competitor-intelligence`, `data-health`, `home`, `payroll`, `progress-tests`, `room-capacity`, `student-promotions`, `tutor-profiles`, `wise-activity`
- Nesting appears where an audience or tab set needs its own subtree: `admissions/parent/`, `admissions/student/`, `sales-dashboard/tabs/`
- `skeletons/` holds the four shared loading shells (`calendar-`, `form-`, `sales-dashboard-`, `search-skeleton.tsx`); each feature page mounts a top-level `*-workspace.tsx` / `*-dashboard.tsx` / `*-shell.tsx` composition root

**`src/hooks/`:**
- Purpose: Reusable React hooks
- Contains: `use-compare.ts` (compare state, client tutor cache keyed `` `${tutorGroupId}:${week}:${CACHE_VERSION}` `` at line 170, AbortController), `use-sales-dimensions.ts`, `use-keyboard-shortcuts.ts`, `use-resizable-split.ts`, `use-theme.ts`

**`src/lib/`:**
- Purpose: Shared business logic and platform integrations — the bulk of the codebase
- Contains: 36 subdirectories plus 10 root modules — `auth.ts`, `auth-edge.ts`, `auth-access.ts`, `env.ts`, `maintenance.ts`, `bangkok-time.ts`, `utils.ts`, `tutor-business-profiles.ts`, `tutor-profile-import.ts`, `tutor-profile-vocabulary.ts` (the root modules are tested from `src/lib/__tests__/`, which holds 4 files)
- Convention: route logic lives here so it is unit-testable without the Next/auth route graph

**`src/lib/admissions/`** (university admissions — *stable*; parity-hardening code is unmerged on `origin/codex/admissions-parity-hardening` while its schema has landed): 23 modules plus `shared/` (8 client-safe helpers: `activities`, `colleges`, `config`, `essays`, `meetings`, `recommenders`, `resources`, `testing`). `access.ts` is the fail-closed guard — unknown role, missing/revoked membership, inactive counselor row, or soft-deleted case all deny, and non-admins get Forbidden rather than NotFound so case existence never leaks. Domain modules: `cases`, `cohorts`, `checklists`, `colleges`, `essays`, `activities`, `testing`, `meetings`, `members`, `notes`, `recommenders`, `resources`, `sections`, `announcements`, `calendar`, `counselors`, `audit`, `notifications`, `config`, `types`, `parent-projection.ts` (the whitelisted parent view), `student-home.ts`. Largest API surface in the app: 61 endpoints across 21 route files.

**`src/lib/ai/`** (AI scheduler — *experimental*): 8 modules — `scheduler-conversation.ts` (OpenAI extraction + constraint solve), `scheduler-service.ts` (orchestration), `scheduler-data.ts`, `scheduler-metrics.ts`, `correction-telemetry.ts`, `academic-levels.ts`, `tutor-profile-signals.ts`, `scheduler.ts`.

**`src/lib/auth/`:** Test-only directory — contains just `__tests__/`. Implementation lives in the `src/lib` root files: `auth.ts` (Node NextAuth), `auth-edge.ts` (edge config for middleware), `auth-access.ts` (`UserRole` at line 31, `resolveUserAccess` at line 56).

**`src/lib/calendar/`:** `month-grid.ts` — shared Monday-start month-grid math plus `getMonthWindow`, extracted so Server Components, the print routes, the public parent page, and the live Wise overlay can reuse it without pulling a `"use client"` module into the server graph.

**`src/lib/classrooms/`** (classroom assignments — *stable*): 12 modules — `assignment-engine.ts`, `rooms.ts`, `floor-plan.ts` / `floor-plan-map.ts`, `reconciliation.ts`, `schedule-email.ts` / `admin-schedule-email.ts`, `morning-automation.ts`, `tutor-contacts.ts`, `session-mode.ts`, `visualization.ts`, `data.ts`. `schedule-email.ts` also exports the Apps Script mail sender reused by the cron watchdog.

**`src/lib/competitor-intelligence/`** (*stable*): 11 modules — `sync.ts`, `providers.ts`, `ai.ts` (OpenAI brief with a deterministic fallback), `budget.ts` (per-provider hard caps), `normalization.ts`, `war-room.ts`, `access.ts` / `access-policy.ts`, `default-sources.ts`, `data.ts`, `types.ts`.

**`src/lib/credit-control/`** (*stable*): 19 modules — `sync.ts` (owns `PAST_WINDOW_DAYS` / `FUTURE_WINDOW_DAYS`, reused by the parent report), `wise.ts`, `service.ts`, `projection.ts`, `churn.ts`, `queue-window.ts`, `payload-patch.ts`, `actions.ts` + `action-helpers.ts`, `analytics.ts`, `packages.ts`, `admin-ownership-seed.ts`, `run-sync-request.ts`, `api.ts`, `db.ts`, `domain.ts`, `helpers.ts`, `ui-helpers.ts`, `config.ts`.

**`src/lib/data-health/`** (*stable*): 7 modules — `cron-registry.ts` (22 job definitions: 17 scheduled, 5 `manualOnly`; `SCHEDULED_CRON_JOBS` filters the rest at line 401), `dashboard.ts`, `status.ts`, `cron-audit.ts`, `cron-retention.ts` (`CRON_INVOCATION_RETENTION_DAYS = 90`, `pruneCronInvocations`), `run-job.ts` (`runDataHealthJob` dispatch that lets an admin fire a registered job by key), `types.ts`.

**`src/lib/data/`:** Server-only cached fetchers (`"use cache"` + cache tags) — `filters.ts`, `tutors.ts`, `past-sessions.ts`, `active-snapshot.ts`.

**`src/lib/db/`:** `index.ts` (Neon serverless + Drizzle `getDb()` singleton anchored on `globalThis.__bgscheduler_db`, `src/lib/db/index.ts:22-26`), `schema.ts` (189 `pgTable` + 61 `pgEnum` definitions, 4,772 lines), `seed.ts`. `schema.ts` is a do-not-edit path for this documentation pass; canonical column detail is `docs/reference/database/`.

**`src/lib/home/`:** `summary.ts` — `getHomeSummaryPayload` builds the Home Hub payload by fanning out to credit control, data health, leave requests, payroll, Wise reconciliation, and the Google token status, filtered through `canAccessHref` against the caller's `allowedPages`.

**`src/lib/internal/`:** `cron-auth.ts` (`getCronSecretStatus` line 6 / `rejectInvalidCronSecret` line 19) and `cron-watchdog.ts` (episode-based dedup in `cron_alert_state`; alert state is persisted only after at least one recipient accepted the email).

**`src/lib/learning-plans/`** (*stable*): `access.ts` + `access-policy.ts` — `server-only` DB-backed grant check (admin allowlist, `learning_plan_access_grants`, or an active tutor contact), exposed as `resolveLearningPlansAccess` / `getLearningPlansAccess` / `requireLearningPlansAccess`. The middleware coarse-passes the `/learning-plans` page namespace and hard-denies `/api/learning-plans` (`src/middleware.ts:47-57`) so the Server-Component grant is authoritative.

**`src/lib/leave-requests/`** (*stable*): `parser.ts`, `matching.ts`, `sync.ts`, `data.ts`, `config.ts` (the three `LEAVE_REQUESTS_*` vars are read straight from `process.env` here, not through `src/lib/env.ts`). In-flight source — documented, not edited.

**`src/lib/line/`** (LINE integration — *stable, scheduler write-path flag-gated*; the credit/report bots are *stable*): 24 modules. Inbound: `webhook.ts`, `signature.ts`, `client.ts`, `classifier.ts`, `confidence.ts`, `mentions.ts`, `backlog-matcher.ts` / `backlog-recovery.ts`. Contact resolution: `oa-resolver.ts`, `link-validation.ts`, `student-links.ts`, `contact-aliases.ts`, `name-matcher.ts`. Review: `review-service.ts`, `operational.ts`, `data.ts`. Schedule bot: `schedule-bot.ts` (DM path, four fail-closed gates `SCHED-BOT-01..04`), `schedule-bot-group.ts` (group-chat path, gates `GRP-BOT-01..06`), `schedule-bot-command.ts`, `schedule-bot-copy.ts` (also supplies `PUBLIC_PAGE_COPY` to the public parent page). Credit/report bots: `credit-bot.ts` (`/credit` balances; gate `CRED-BOT-G1` staff-chats-only and silent, rule `CRED-BOT-R1` hides finished packages; `rawStaffGroup` at line 114 backs both bots), `report-bot.ts` (`/report` Parent Report link, gate `REP-BOT-G1`), `credit-digest.ts` (`computeCreditRunouts` line 115, `sendLineCreditDigest` line 241, driven by the `line-credit-digest` cron). Plus `test-data-cleanup.ts`, driven by `npm run line:test-data:cleanup`; the companion read-only harvest script `scripts/find-line-user-ids.ts` (`npm run line:find-user-ids`) lives outside this directory but supports the same `LINE_SCHEDULE_BOT_ADMIN_IDS` admin-onboarding workflow.

**`src/lib/maintenance.ts`** (root module, not a directory): the site-wide kill switch, five load-bearing decision IDs `MAINT-01..05`. `isMaintenanceMode` (line 59) engages only on the exact string `"true"`; `MAINTENANCE_EXEMPT_PREFIXES` (line 43) keeps `/api/internal/` and `/schedule/` alive; `isMaintenanceBypassEmail` (line 95) is fail-closed on an empty allowlist; `maintenanceResponse` (line 120) returns 503 with `Retry-After` — JSON under `/api/`, HTML elsewhere.

**`src/lib/navigation/`:** `tools.ts` — the single nav registry: `HOME_HREF` (line 58), 6 `NAV_SECTIONS` (`scheduling-tutors`, `student-lifecycle`, `finance-revenue`, `market-intelligence`, `research-reference`, `data-audit`), 22 `NAV_TOOLS`, 7 `NavBadgeKey` values (`leaveRequests`, `lineReviews`, `progressTests`, `creditControl`, `payroll`, `wiseReconciliation`, `dataHealth`), 4 tools flagged `shortcut: true`, plus `isActivePath` / `canAccessHref` / `filterToolsByAccess` / `sectionTools` / `visibleSections` / `activeSection` / `shortcutTools`. Both `app-nav.tsx` and `home/summary.ts` read it, so a tool is registered once.

**`src/lib/normalization/`:** Pure Wise → canonical transforms — `identity.ts`, `availability.ts`, `leaves.ts`, `sessions.ts`, `qualifications.ts`, `modality.ts`, `timezone.ts`. Co-located `__tests__/`, one per module.

**`src/lib/ops/`:** `stale.ts` — `API_STALE_THRESHOLD_MS` (90 min, line 2), `APP_STALE_BANNER_THRESHOLD_MS` (2 h, line 3), the banner copy/session key, and `isApiSnapshotStale` / `shouldShowStaleBanner`.

**`src/lib/payroll/`** (*stable*): `domain.ts`, `rate-card.ts`, `sync.ts` (imports `Pool` from `pg` at line 3 for real transactions), `data.ts`, `may-reconciliation.ts`, `types.ts`.

**`src/lib/post-class-feedback/`** (*stable*; payout writes flag-gated by `POST_CLASS_PAYOUT_WRITES_ENABLED` / `POST_CLASS_AUTO_APPROVE_ENABLED`): the largest domain — 40 modules. Ingest + policy: `sync.ts`, `policy.ts`, `backfill-job.ts` / `backfill-window.ts`, `wise.ts`, `events.ts`, `repository.ts`, `reassess.ts` (re-derives persisted evidence and re-runs `applyPostClassReviewAction`). Review: `ai.ts`, `auto-approval.ts` (continuous unattended approve/reopen sweeps that never write approval logic of their own — every state change goes through `applyPostClassReviewAction`), `shadow-review.ts`, `similarity.ts`, `dashboard.ts`, `detail.ts`, `metrics.ts`, `actions.ts`, `api.ts`. Payout: `payout-run.ts`, `payout-plan.ts`, `payout-sheet.ts`, `payout-sheet-verify.ts`, `payout-master.ts`, `payout-writer.ts`, `payout-repository.ts`, `payout-accrual.ts`, `payout-retirement.ts` (auto-un-charge by row deletion, wholly gated on `POST_CLASS_AUTO_APPROVE_ENABLED`), `payout-config.ts` (no live spreadsheet/folder/tab/account fallbacks in source — every deployment must name every Google resource and declare `scratch` or `production`; `payoutWritesEnabled` at line 49), `payout-window.ts` / `payout-window-health.ts`, `payout-tutor-mapping.ts`, `payout-workbook-operations.ts`, `drive.ts`, `finance-lock.ts`. Cross-cutting: `access.ts` (DB capabilities re-checked per request — `middleware.ts:41-46` deliberately coarse-passes this namespace so stale JWT prefixes cannot override them), `transaction.ts` (`pg` transactions), `notifications.ts`, `reminder-job.ts`, `settings.ts`, `errors.ts`, `types.ts`.

**`src/lib/progress-tests/`** (*stable*): 16 modules — `engine.ts` (pure counting/cycle math on `PROGRESS_TEST_THRESHOLD = 8` and `PROGRESS_TEST_COUNTING_START`, deliberately free of DB and Next imports), `sync.ts`, `db.ts`, `booking.ts`, `recommend.ts`, `service.ts`, `api.ts`, `line.ts`, `parent-message.ts`, `ai-summary.ts`, `admin-digest.ts`, `teacher-access.ts`, `teacher-heads-up.ts`, `config.ts`, `types.ts`, `run-sync-request.ts`.

**`src/lib/proposals/`** (*experimental*): `overlap.ts` (`ACTIVE_PROPOSAL_STATUSES = ["pending","confirmed"]` line 9, interval overlap, `proposalHoldBlocksSearchSlot`, `findConflictingProposal`), `data.ts`, `types.ts`.

**`src/lib/room-capacity/`** (*stable* for utilization; the forecast/month engines have no UI caller and the sync is `manualOnly`): `utilization.ts`, `analysis.ts`, `forecast.ts`, `package-mix.ts`, `dates.ts` (Bangkok date math — `todayBangkok` / `bangkokDateKey` / `addBangkokDays` are reused by home, payroll, post-class auto-approval, the parent report, and the public schedule page), `data.ts`, `types.ts`.

**`src/lib/sales-dashboard/`** (*stable*): 21 modules — `parser.ts`, `analytics.ts`, `projection.ts`, `lifecycle.ts`, `gm-insights.ts`, `cohorts.ts`, `dimensions.ts`, `student-journey.ts`, `transaction-query.ts`, `package-hours.ts`, `csv.ts` / `export-links.ts`, `import-guard.ts`, `sheets.ts` (the shared Sheets read/batch-update layer, also used by post-class payout retirement), `google-oauth.ts` (the shared Google token layer, also read by post-class payouts and the Home Hub), `program-map.ts`, `default-sources.ts`, `dates.ts`, `format.ts`, `data.ts`, `types.ts`.

**`src/lib/scheduler/`:** `admin-colors.ts` — scheduler-UI helper, distinct from `src/lib/ai/`.

**`src/lib/search/`** (tutor search — *stable*; tutor compare — *legacy-redirect* at the page level, engine fully live): 8 modules — `index.ts` (singleton + build-promise guard anchored on `globalThis.__bgscheduler_searchIndex` / `__bgscheduler_searchIndexBuildPromise`, `src/lib/search/index.ts:92-115`; `ensureIndex` at line 354 sets the singleton synchronously before any `await` so concurrent callers coalesce), `engine.ts` (`executeSearch` line 22, `getBlockingSessions` line 200), `compare.ts` (`resolveSessionModality` 97, `detectSessionModalityConflict` 185, `buildCompareTutor` 225, `detectConflicts` 322, `findSharedFreeSlots` 361), `range-search.ts`, `parser.ts`, `recommend.ts`, `cache-version.ts` (`CACHE_VERSION = "v3"`, line 24), `types.ts`.

**`src/lib/student-promotions/`** (*stable*): July-1 year-group promotion — `rules.ts` (`STUDENT_PROMOTION_TARGET_DATE = "2026-07-01"` line 1, the Wise grade registration field id, transition + source-subject tables), `data.ts`, `api.ts`.

**`src/lib/student-report/`** (parent class report — *stable*): 6 modules — `build.ts` (assembles class rows, package rows, and summary lines; reuses `deriveSessionModality` / `deriveDisplaySubject` / `TEACHER_TBC` from student-schedule and treats both Wise cancellation spellings via `/^CANCELL?ED$/i`), `window.ts` (resolves the requested range against the credit-control snapshot's own `PAST_WINDOW_DAYS` / `FUTURE_WINDOW_DAYS` bounds and emits `windowWarnings` rather than silently truncating), `db.ts` (`getParentClassReport`), `params.ts` (`reportParamsSchema`, `normalizeReportParams` — shared by the API route and the print page), `csv.ts`, `types.ts`.

**`src/lib/student-schedule/`** (*stable*): parent-facing monthly schedule — `data.ts` (`getStudentMonthlySchedule`, `parseStudentDisplay`, `deriveSessionModality`), `links.ts` (32-byte `crypto.randomBytes` capability tokens, only the SHA-256 hash persisted, `DEFAULT_LINK_TTL_DAYS = 30` line 27, scoped to one `(studentKey, monthKey)`; `hashScheduleToken` / `mintStudentScheduleLink` / `resolveStudentScheduleLink` / `revokeStudentScheduleLink` / `studentScheduleLinkUrl`), `live.ts` (fail-soft live Wise overlay for the requested month — any error, Zod failure, or deadline overrun returns `ok: false` and an empty list so the caller renders the snapshot unchanged; gated by `ENABLE_STUDENT_SCHEDULE_LIVE`), `types.ts`.

**`src/lib/syllabus/`:** Static curriculum dataset behind learning plans — `get-year-syllabus.ts` (`server-only`, a static import map so each year's JSON bundles into its own server chunk and the dataset never reaches the client), `topics-index.ts`, `report-params.ts`, `types.ts`, and `data/` (13 `year-NN.json` files, year-01 … year-13, plus `topics-index.json`).

**`src/lib/sync/`:** Wise snapshot ETL — `orchestrator.ts` (`runFullSync`, line 50), `run-wise-sync.ts` (`runWiseSyncRequest` line 142, single-flight guard with `STALE_RUNNING_SYNC_MS = 20 min` line 10, `revalidateTag("snapshot", { expire: 0 })` line 161), `past-sessions-diff-hook.ts`, `snapshot-pruning.ts`.

**`src/lib/ui/`:** `z-index.ts`, `view-transitions.ts`.

**`src/lib/us-universities/`** (*stable*): IPEDS research console — 17 modules: `data.ts` (cached reads; the source `.accdb`/CSV are never touched at runtime), `query.ts`, `parser.ts`, `request.ts`, `transform.ts`, `trend.ts` / `trend-charts.ts`, `compare-set.ts`, `dossier-sections.ts`, `dot-map.ts`, `active-filters.ts`, `chart-filters.ts`, `csv.ts`, `format.ts`, `nav.ts`, `constants.ts`, `types.ts`.

**`src/lib/wise/`:** External Wise API — `client.ts` (retry/backoff + concurrency limiter, `createWiseClient`), `fetchers.ts`, `operations.ts` (writeback), `types.ts`. No internal dependencies beyond env.

**`src/lib/wise-activity/`** (Wise activity audit — *stable*): `sync.ts`, `format.ts`, `reconciliation.ts`, `data.ts`.

**`src/lib/tutor-*` root modules** (tutor profiles — *stable*): `tutor-business-profiles.ts`, `tutor-profile-import.ts`, `tutor-profile-vocabulary.ts` — editorial business context keyed by `canonicalKey`, read by the AI scheduler.

**`drizzle/`:**
- Purpose: Generated migrations + schema snapshots
- Contains: 69 `*.sql` files, `0000_tidy_black_bolt.sql` … `0068_payout_adjustment_superseded.sql`, plus `meta/`
- Generated by `npm run db:generate`; applied by `npm run db:migrate`. Committed: Yes

**`scripts/`:**
- Purpose: `tsx`/`node` operational scripts, outside the app bundle
- Groups: seeds (`seed-credit-control-admin-ownership.ts`, `seed-tutor-business-profiles.ts`), AI scheduler evals (`evaluate-ai-scheduler.ts`, `evaluate-ai-scheduler-2026-05-21.ts`, `compare-ai-scheduler-models.ts`, `replay-ai-scheduler-runs.ts`), payout workbook + incident tooling (`inventory-`/`setup-payout-master-tabs`/`repoint-`/`restore-`/`roll-`/`derive-payout-tutor-names`, `remove-netted-payout-rows.ts`, `report-payout-sheet-reconciliation.ts`, `backfill-payout-tutor-submitted.ts`, `backfill-ledger-removed-retirement.ts`, `reassess-content-bar.ts`, `reinstate-short-content-deductions.ts`, `remediate-auto-approved-deductions.ts`, `supersede-inc-260829-adjustments.ts`, plus `lib/payout-script.ts`, `lib/payout-formula-backup.ts`, `list-payout-workbooks.gs`, `verify-drive-upload.ts`), reporting (`report-student-classes.ts`, `report-online-by-year.ts`, `report-tutor-feedback-submissions.ts`, `price-student-credits.ts`), IPEDS import (`ipeds-import.ts`, `ipeds-convert.sh`, `ipeds-convert-historical.sh`), LINE/room/Wise ops (`delete-line-test-data.ts`, `find-line-user-ids.ts`, `backlog-recovery-dry-run.ts`, `sync-room-utilization.ts`, `import-room-capacity-model.ts`, `probe-wise-availability-range.ts`), release guards (`check-production-route-surface.mjs`, `check-sales-dashboard-scope.mjs`, `assert-production-deploy-ready.mjs`), plus `stubs/server-only.ts` and a scripts-local `tsconfig.json`
- `check-production-route-surface.mjs` walks `src/app` for `page.tsx`/`route.ts`, strips route-group and `@slot` segments, and diffs the result against `docs/reference/production-route-surface.json` (211 `sourceRoutes`, 9 `criticalRoutes`, plus a `minSourceRouteCount` floor) — adding a route without updating that manifest fails `verify:release`

**`extensions/line-oa-resolver/`:** Chrome MV3 extension (`manifest.json`, `background.js`, `content.js`, `candidate-utils.js`, `popup.html`/`popup.js`, README) used to harvest LINE OA contact candidates. Not part of the Next.js build.

**`docs/`:** Canonical-home split — `reference/` owns mechanical detail (endpoint signatures, columns, cron table, env table), `features/` owns meaning (purpose, rules, flows) and links to reference. `handbook/` is orientation prose (6 files); `operations/` holds runbook, observability, auth-and-access, and dated release checkpoints; `proposals/` holds dated evaluations that are not built yet (currently the cron-efficiency / Wise-webhooks proposal). `superpowers/` is vendored — do not edit. AI-scheduler audit/eval markdown + JSON and the two case-management design docs sit at the `docs/` root; the AI-scheduler files are read-only for this pass.

**`.planning/`:** GSD workflow artifacts — `codebase/` (this map plus ARCHITECTURE/CONVENTIONS/STACK/TESTING/INTEGRATIONS/CONCERNS), plus `phases/`, `milestones/`, `quick/`, `debug/`, `reports/`, `research/` and the root state files (`PROJECT.md`, `ROADMAP.md`, `STATE.md`, `REQUIREMENTS.md`, `MILESTONES.md`, `RETROSPECTIVE.md`, `HANDOFF.json`, `config.json`). Committed: Yes.

**`public/`:** Static assets served at site root — `brand/logo-horizontal.png`, `brand/logo-stacked.png`, and the five stock Next.js SVGs. Committed: Yes.

## Key File Locations

**Entry Points:**
- `src/app/(app)/page.tsx`: `/` Home Hub — resolves session, redirects single-page users to their landing page, renders `<HomeHub>` from `getHomeSummaryPayload`
- `src/app/(app)/search/page.tsx`: Search + embedded compare workspace (has a `loading.tsx` sibling)
- `src/app/schedule/[token]/page.tsx`: Public token-scoped parent schedule
- `src/app/api/internal/sync-wise/route.ts`: Wise snapshot cron (`maxDuration = 800`)
- `src/app/api/internal/cron-watchdog/route.ts`: Sweeps every registered cron and emails admins on unhealthy jobs
- `src/middleware.ts`: maintenance gate (lines 76-82, `MAINT-04` — deliberately above the allowlist) → public allowlist (`isPublicRoute`, line 10) → edge auth → per-user page access (`isPathAllowed`, line 36); API denials return 403 JSON, page denials redirect to `allowedPages[0]`

**Configuration:**
- `tsconfig.json`: strict, ES2017, `moduleResolution: bundler`, `@/*` → `./src/*`, `incremental: true`
- `next.config.ts`: `cacheComponents: true` — the only override
- `vercel.json`: `regions: ["sin1"]` plus 17 crons. Staggered minutes: sync-wise `*/30`; wise-activity `2,17,32,47`; cron-watchdog `7,37`; sales-dashboard `10,40`; post-class-feedback `13,43`; leave-requests `15,45`; credit-control `20,50`; post-class backfill `23,53`; progress-tests `25,55`; payout accrual `33 * * * *`. Daily/one-off: progress-tests digest `35 0`, admissions notifications `12 1`, LINE credit digest `3 2`, classroom morning `41 23`, classroom admin email `4,14,24,36 0`, student-promotions July-1 `5 17 30 6 *`, competitor-intelligence weekly `28 18 * * 0`. Canonical: `docs/reference/crons.md`
- `drizzle.config.ts`, `vitest.config.ts` (unit + integration projects; `process.env.TZ = "Asia/Bangkok"` set at config load; v8 coverage excludes `src/app/**/*.tsx` and all test dirs), `eslint.config.mjs`, `postcss.config.mjs`, `components.json`
- `package.json`: `verify:release` = typecheck → test → build → typecheck → `git diff --check` → `guard:production-route-surface`; `deploy:prod` runs that plus `assert-production-deploy-ready.mjs` before `npx vercel --prod`

**Core Logic:**
- `src/lib/sync/orchestrator.ts:50` (`runFullSync`) and `src/lib/sync/run-wise-sync.ts:142` (`runWiseSyncRequest`)
- `src/lib/search/index.ts:92-115` (index singleton) and `:354` (`ensureIndex`), `engine.ts:22` (`executeSearch`), `compare.ts:225/322/361` (`buildCompareTutor` / `detectConflicts` / `findSharedFreeSlots`)
- `src/lib/db/index.ts:22` (`getDb()`), `src/lib/db/schema.ts` (189 tables, 61 enums, 4,772 lines)
- `src/lib/auth.ts` / `auth-edge.ts` / `auth-access.ts` (`UserRole` line 31 — five roles: admin, teacher, counselor, student, parent; `resolveUserAccess` line 56, first match wins, `null` on no match denies sign-in)
- `src/lib/maintenance.ts` (`MAINT-01..05`), `src/lib/navigation/tools.ts` (nav registry), `src/lib/data-health/cron-registry.ts` (22 job definitions; `SCHEDULED_CRON_JOBS` line 401), `src/lib/internal/cron-auth.ts:14` (constant-time `CRON_SECRET`)
- `src/lib/env.ts`: one Zod schema with 18 keys — 7 hard-required (`DATABASE_URL`, `AUTH_GOOGLE_ID`, `AUTH_GOOGLE_SECRET`, `AUTH_SECRET`, `WISE_USER_ID`, `WISE_API_KEY`, `CRON_SECRET`), 2 defaulted (`WISE_NAMESPACE` → `begifted-education`, `WISE_INSTITUTE_ID` → `696e1f4d90102225641cc413`), 9 optional (`LINE_CHANNEL_SECRET`, `LINE_CHANNEL_ACCESS_TOKEN`, `ENABLE_LINE_SCHEDULER`, `LINE_SCHEDULE_BOT_ADMIN_IDS`, `ENABLE_STUDENT_SCHEDULE_LIVE`, `STUDENT_SCHEDULE_LINK_TTL_DAYS`, `APP_BASE_URL`, `MAINTENANCE_MODE`, `MAINTENANCE_BYPASS_EMAILS`); logs only `fieldErrors` and throws. Note the two families that bypass it deliberately: `POST_CLASS_PAYOUT_*` is read via `process.env` in `payout-config.ts` (so a partial env cannot crash the module), and `LEAVE_REQUESTS_*` in `leave-requests/config.ts`. Reconciled inventory: `docs/reference/env.md`
- Transaction escape hatch: `src/lib/payroll/sync.ts:3`, `src/lib/post-class-feedback/transaction.ts`, `src/lib/admissions/audit.ts` are the only three modules importing `pg`, because neon-http has no transactions

**Frontend Composition Roots:**
- `src/components/home/home-hub.tsx`, `src/components/search/search-workspace.tsx`, `src/components/compare/compare-panel.tsx`
- `src/components/scheduler/scheduler-workspace.tsx`, `src/components/line-review/line-review-workspace.tsx` (+ `mapping-validation-workspace.tsx`)
- `src/components/post-class-feedback/post-class-feedback-workspace.tsx`, `src/components/progress-tests/progress-tests-dashboard.tsx`
- `src/components/student-schedule/student-schedule-workspace.tsx` (+ `schedule-month-calendar.tsx`, `parent-schedule-agenda.tsx`, and `public-schedule-shell.tsx`, shared with the print and public routes)
- `src/components/student-report/student-report-workspace.tsx` (+ `report-document.tsx`, `report-tables.tsx` for the print route)
- `src/components/student-promotions/student-promotions-workspace.tsx`
- `src/components/admissions/caseload-shell.tsx` + `case-detail-shell.tsx` (+ `parent/parent-dashboard.tsx`, `student/portal-shell.tsx`)
- `src/components/learning-plan/learning-plan-form.tsx` (+ `print-toolbar.tsx`, reused by the parent-report print page), `src/components/us-universities/us-universities-shell.tsx`
- `src/components/sales-dashboard/sales-dashboard-shell.tsx`, `src/components/credit-control/dashboard-shell.tsx`, `src/components/payroll/payroll-dashboard.tsx`
- `src/components/class-assignments/class-assignments-workspace.tsx`, `src/components/room-capacity/room-capacity-dashboard.tsx`
- `src/components/competitor-intelligence/competitor-intelligence-dashboard.tsx`, `src/components/wise-activity/wise-activity-workspace.tsx`
- `src/components/data-health/data-health-dashboard.tsx`, `src/components/leave-requests/leave-requests-workspace.tsx`, `src/components/tutor-profiles/tutor-profiles-workspace.tsx`
- `src/components/layout/app-nav.tsx` + `stale-snapshot-banner.tsx` (mounted by `(app)/layout.tsx`)

**Testing (389 test files):**
- Co-located `__tests__/` directories: 35 under `src/lib/` (220 files), 75 under `src/app/api/` (82 files), 23 under `src/components/` (84 files), plus `src/app/(app)/us-universities/[unitId]/__tests__/page-params.test.ts`
- Top-level: `src/__tests__/middleware.test.ts`, `src/__tests__/vercel-crons.test.ts` (asserts the staggered schedules and that no two crons collide on a minute)
- Integration: 13 `*.integration.test.ts` files — 10 in `src/lib/post-class-feedback/__tests__/` (auto-approval, backfill-window, deleted-session-retirement, payout-accrual, payout-repository, payout-retirement, payout-run, recent-readiness, recheck-queue, source-status-restore) and 3 in `src/lib/sync/__tests__/` (orchestrator, past-sessions-diff-hook, snapshot-pruning) — run by the `integration` project (forks, `fileParallelism: false`, `maxWorkers: 1`, 60 s timeouts) against a testcontainers Postgres via `src/tests/integration/db-helper.ts`
- Data tests exist for static assets too — `src/lib/syllabus/__tests__/` validates the 13 year JSON bundles

## Naming Conventions

**Files:**
- All source files kebab-case (`schedule-bot-group.ts`, `month-grid.ts`, `payout-retirement.ts`, `parent-projection.ts`)
- React components `.tsx`; logic/types/helpers `.ts`
- Tests `{module}.test.ts(x)` in co-located `__tests__/`; DB-backed tests `{module}.integration.test.ts`
- `schema.ts` singular; per-feature `types.ts`; per-feature `data.ts` for read helpers; `config.ts` for tunables; `api.ts` for the route-facing service layer (`credit-control`, `progress-tests`, `student-promotions`, `post-class-feedback`)
- Feature composition roots: `{feature}-workspace.tsx`, `{feature}-dashboard.tsx`, or `{feature}-shell.tsx`
- Access pairs split server/client: `access.ts` (DB + `server-only`) vs `access-policy.ts` (pure predicates safe for client bundles) — see `learning-plans/` and `competitor-intelligence/`
- Bot modules pair a handler with its copy: `schedule-bot.ts` / `schedule-bot-copy.ts`, `credit-bot.ts` / `report-bot.ts` / `credit-digest.ts`

**Directories:**
- All lowercase (`post-class-feedback`, `student-promotions`, `us-universities`, `competitor-intelligence`, `student-report`)
- Route groups in parentheses: `(app)`, `(print)` — not URL segments
- Dynamic segments in brackets — 25 distinct names in the tree: `[...nextauth]`, `[actionId]`, `[adjustmentId]`, `[canonicalKey]`, `[caseId]`, `[cohortId]`, `[contactId]`, `[conversationId]`, `[impactId]`, `[itemId]`, `[jobId]`, `[jobKey]`, `[linkId]`, `[messageId]`, `[requestId]`, `[reviewId]`, `[rowId]`, `[runId]`, `[sectionKey]`, `[sessionId]`, `[sourceId]`, `[suggestionId]`, `[taskId]`, `[token]`, `[unitId]`
- Test directories `__tests__/`

**Components (PascalCase exports):** `HomeHub`, `SearchWorkspace`, `ComparePanel`, `AppNav` / `AppNavSkeleton`, `StaleSnapshotBanner`, `ScheduleMonthCalendar`, `PublicScheduleShell`, `PostClassFeedbackWorkspace`, `StudentReportWorkspace`, `ReportDocument`, `CaseDetailShell`, `PrintToolbar`. Page components use `export default`.

**Functions (camelCase, verb-prefixed):**
- Generic: `executeSearch`, `buildCompareTutor`, `runFullSync`, `runWiseSyncRequest`, `runDataHealthJob`, `resolveUserAccess`, `pruneCronInvocations`
- Getters: `getDb()`, `getSearchIndex()`, `getHomeSummaryPayload()`, `getStudentMonthlySchedule()`, `getParentClassReport()`, `getYearSyllabus()`, `getMonthWindow()`, `getCronSecretStatus()`, `getLearningPlansAccess()`
- Booleans: `isPublicRoute()`, `isPathAllowed()`, `isActivePath()`, `isApiSnapshotStale()`, `shouldShowStaleBanner()`, `isMaintenanceMode()`, `isMaintenanceExempt()`, `payoutWritesEnabled()`, `rawStaffGroup()`
- Guards: `requireLearningPlansAccess()`, `rejectInvalidCronSecret()`, `requirePayoutGoogleTarget()`
- Factories/minters: `createWiseClient()`, `mintStudentScheduleLink()`
- Transforms/resolvers: `parseStudentDisplay()`, `resolveStudentScheduleLink()`, `resolveFamilyStudents()`, `hashScheduleToken()`, `normalizeReportParams()`, `formatBangkokDateTime()`, `todayBangkok()`, `bangkokDateKey()`

**Constants (UPPER_SNAKE_CASE):** `TUTOR_COLORS = ["#3b82f6","#e67e22","#7c3aed"]` (`src/components/compare/session-colors.ts:51`), `CACHE_VERSION = "v3"` (`src/lib/search/cache-version.ts:24`), `API_STALE_THRESHOLD_MS` / `APP_STALE_BANNER_THRESHOLD_MS` (`src/lib/ops/stale.ts:2-3`), `STALE_RUNNING_SYNC_MS` (`src/lib/sync/run-wise-sync.ts:10`), `ACTIVE_PROPOSAL_STATUSES` (`src/lib/proposals/overlap.ts:9`), `CRON_JOBS` / `SCHEDULED_CRON_JOBS`, `CRON_INVOCATION_RETENTION_DAYS = 90`, `MAINTENANCE_EXEMPT_PREFIXES`, `NAV_SECTIONS` / `NAV_TOOLS` / `HOME_HREF`, `PROGRESS_TEST_THRESHOLD = 8` / `PROGRESS_TEST_COUNTING_START`, `STUDENT_PROMOTION_TARGET_DATE = "2026-07-01"`, `DEFAULT_LINK_TTL_DAYS = 30`, `PAST_WINDOW_DAYS` / `FUTURE_WINDOW_DAYS`, `TEACHER_TBC`, `BANGKOK_TIME_ZONE`, `PUBLIC_PAGE_COPY`, `PAYOUT_MASTER_SPREADSHEET_ID` and siblings.

**Types:**
- Interfaces PascalCase: `SearchRequest`, `CompareTutor`, `IndexedTutorGroup`, `CronJobDefinition`, `NavTool`, `NavSection`, `ResolvedReportWindow`, `PayoutGoogleTarget`
- External Wise types prefixed `Wise`: `WiseTeacher`, `WiseSession`, `WiseActivityEvent`, `WiseCreditSession`
- In-memory index types prefixed `Indexed`; pipeline outputs prefixed `Normalized`
- Unions as `type`: `type CronSecretStatus`, `type NavToolId`, `type NavSectionId`, `type NavBadgeKey`, `type UserRole`, `type ProgressTestStatus`, `type PayoutEnvironmentTarget`, `type SessionBucket`
- Ambient module augmentation lives in `src/types/next-auth.d.ts`

**Database:** table/column names `snake_case` (`line_contact_student_links`, `cron_alert_state`, `student_schedule_links`, `learning_plan_access_grants`); Drizzle exports `camelCase`; 61 `pgEnum` declarations at the top of `schema.ts`.

**Design-decision IDs** are load-bearing in comments and must be preserved when editing nearby code — `SCHED-BOT-01..04` (`src/lib/line/schedule-bot.ts`), `GRP-BOT-01..06` (`src/lib/line/schedule-bot-group.ts`), `CRED-BOT-G1` / `CRED-BOT-R1` (`src/lib/line/credit-bot.ts:11,25`), `REP-BOT-G1` (`src/lib/line/report-bot.ts:10`), `MAINT-01..05` (`src/lib/maintenance.ts:9-28`), plus the older `D-*` / `MOD-*` / `REL-*` / `PAST-*` families.

**Path aliases:** `@/*` → `./src/*` (both `tsconfig.json` and `vitest.config.ts`); shadcn aliases in `components.json` (`@/components`, `@/components/ui`, `@/lib`, `@/lib/utils`, `@/hooks`).

## Where to Add New Code

**New API endpoint:**
- Implementation: `src/app/api/{feature}/route.ts` (nest segments / `[param]` dirs as needed)
- Pattern: `auth()` → 401; `request.json()` in try/catch → 400; Zod `.safeParse()` → 400 with `.error.flatten()`; business logic in try/catch → 500
- Cron-only work goes under `src/app/api/internal/` guarded by `rejectInvalidCronSecret`; the `/api/internal/` prefix is already allowlisted at `src/middleware.ts:24` and exempted from maintenance mode at `src/lib/maintenance.ts:43`
- Long-running work needs an explicit `export const maxDuration` in the route file (800 / 300 / 60 are the values in use)
- **Add the path to `docs/reference/production-route-surface.json`** or `npm run guard:production-route-surface` (and therefore `verify:release`) fails
- Document the signature in `docs/reference/api/`

**New UI page:**
- Authenticated: `src/app/(app)/{route}/page.tsx`, then register the tool in `NAV_TOOLS` (`src/lib/navigation/tools.ts`) — that one entry drives the nav, the Home Hub card, and `canAccessHref`
- Printable: `src/app/(print)/{feature}/report/page.tsx` (no layout; reuse `src/components/learning-plan/print-toolbar.tsx` and set `robots: { index: false, follow: false }`). Portrait is the default `@page`; a landscape sheet needs a *named* `@page` rule so it cannot flip the other print routes
- Public: `src/app/{route}/page.tsx` plus an explicit prefix in `isPublicRoute` (`src/middleware.ts:10`) — and treat the URL itself as the credential. Decide explicitly whether the path also belongs in `MAINTENANCE_EXEMPT_PREFIXES`
- Wrap the async body in `<Suspense>` with a skeleton (`src/components/skeletons/`, or a page-local one as `student-report/page.tsx` does); `loading.tsx` siblings exist for `search` and `us-universities/[unitId]`
- Composition root: `src/components/{feature}/{feature}-workspace.tsx`

**New React component:**
- Generic primitive: `src/components/ui/{name}.tsx` (shadcn CLI; wraps `@base-ui/react`; semicolons omitted in these files — leave as-is)
- Feature component: `src/components/{feature}/{name}.tsx`; kebab-case filename, `"use client"` if interactive, props interface above the component

**New normalizer:** `src/lib/normalization/{domain}.ts` + `__tests__/{domain}.test.ts`, wired into `src/lib/sync/orchestrator.ts` between fetch and persist.

**New database table:** append `pgTable(...)` to `src/lib/db/schema.ts` (add `snapshotId` if snapshot-scoped) → `npm run db:generate` → `DATABASE_URL=… npm run db:migrate`. Trim the generated migration before applying if drizzle-kit emits catch-up DDL. Update `docs/reference/database/`.

**New Wise API call:** fetcher in `src/lib/wise/fetchers.ts`, writeback in `operations.ts`, response shape in `types.ts`, test in `src/lib/wise/__tests__/`, then wire into the owning sync.

**New cron:** route under `src/app/api/internal/`, entry in `vercel.json`, **and** a `CRON_JOBS` entry in `src/lib/data-health/cron-registry.ts` (set `schedule: null` + `manualOnly: true` for admin-triggered jobs) so Data Health, the Home Hub badges, the `runDataHealthJob` dispatch, and the watchdog all see it. Keep the registry's `maxDurationSeconds` in sync with the route's `maxDuration` — health derivation reads the registry, so a mismatch reports a healthy run as failing. Extend `src/__tests__/vercel-crons.test.ts` and pick a minute no other cron uses.

**New LINE bot command:** handler in `src/lib/line/{name}-bot.ts` with its own fail-closed gate ID, user-facing strings in a `*-copy.ts` sibling, and the staff-chat check via `rawStaffGroup` (`src/lib/line/credit-bot.ts:114`) — never a new ad-hoc audience query.

**New feature domain (the common case):**
- Library logic in `src/lib/{feature}/` with co-located `__tests__/`; keep pure engines free of DB/Next imports (see `progress-tests/engine.ts`)
- API under `src/app/api/{feature}/`; UI at `src/app/(app)/{feature}/page.tsx` + `src/components/{feature}/`
- Register in `NAV_TOOLS`; add a meaning doc at `docs/features/{feature}.md` and mechanical detail under `docs/reference/`

**New utility / constant:** general helper `src/lib/utils.ts`; Bangkok date math `src/lib/bangkok-time.ts` or `src/lib/room-capacity/dates.ts`; month-grid math `src/lib/calendar/month-grid.ts`; UI constant `src/lib/ui/`; operational threshold `src/lib/ops/stale.ts`.

**New test:** co-located `__tests__/`; unit `*.test.ts(x)` (`npm test`), DB-backed `*.integration.test.ts` (`npm run test:integration`, needs Docker).

## Special Directories

**`drizzle/`:** 69 generated SQL migrations + `meta/`. Generated by `drizzle-kit generate` from `src/lib/db/schema.ts`. Committed; manual edits discouraged (trimming an over-broad generated migration before applying is the documented exception).

**`drizzle/meta/`:** `_journal.json` (69 entries) plus 40 `*_snapshot.json` files — **not one per migration**. 29 snapshots (`0006`, `0009`–`0013`, `0022`–`0037`, `0048`–`0049`, `0057`–`0061`) are absent from disk, a side effect of trimming catch-up migrations. Generated, committed.

**`scripts/`** and **`scripts/lib/`**: operational `tsx`/`node` scripts outside the app bundle. `scripts/stubs/server-only.ts` and `scripts/tsconfig.json` let those scripts import `server-only` modules (the `payout:*` npm scripts all pass `--tsconfig scripts/tsconfig.json`). Committed.

**`__tests__/` (many locations):** Co-located Vitest files, 389 total across `src/lib/` (220), `src/components/` (84), `src/app/` (83), and `src/__tests__/` (2). Committed.

**`src/tests/integration/`:** testcontainers Postgres harness (`db-helper.ts` + README) consumed by the `integration` project. Committed.

**`extensions/line-oa-resolver/`:** Chrome MV3 extension, built and loaded by hand; not part of `next build`. Committed.

**`docs/superpowers/`:** Vendored skill documentation — do not edit.

**`docs/proposals/`:** Dated evaluations of work that is designed but not built — currently `2026-09-02-cron-efficiency-and-wise-webhooks.md`. Committed.

**`docs/operations/release-checkpoints/`:** Dated production-reconciliation records (`2026-06-04-reconcile-live-production.md`). Committed.

**`.planning/`:** GSD workflow artifacts. Partially agent-generated, committed.

**`.github/workflows/`:** `ci.yml` and `sales-dashboard-scope.yml`; `.github/` also holds `CODEOWNERS` and the PR template. Committed.

**`.claude/`:** Claude Code config — `hooks/sales-dashboard-guard.mjs`, `workflows/document-bgscheduler.js`, `launch.json`, `collaborator-settings.local.template.json`, README. Committed.

**`.next/`, `node_modules/`, `tsconfig.tsbuildinfo`:** build output, dependencies, and incremental TypeScript state. All generated and gitignored.

**`public/`:** Static assets served at site root, including `brand/`. Committed.

---

_Verified against main@0cd1e81 (clean tree) on 2026-09-02._
