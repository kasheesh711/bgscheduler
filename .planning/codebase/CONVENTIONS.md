# Coding Conventions

**Analysis Date:** 2026-09-02

These conventions are verified against `main@0cd1e81`. BGScheduler is not a
tutor-search tool with side features: it is a multi-domain admin platform of
**189 Postgres tables, 243 HTTP endpoints, 17 Vercel crons, 31 `page.tsx` files
(26 of them in the authenticated `(app)` group) and 389 Vitest files**, spread
across **36 `src/lib/*` directories** — 35 domains plus a shared `__tests__` —
(`__tests__`, `admissions`, `ai`, `auth`, `calendar`, `classrooms`,
`competitor-intelligence`, `credit-control`, `data`, `data-health`, `db`,
`home`, `internal`, `learning-plans`, `leave-requests`, `line`, `navigation`,
`normalization`, `ops`, `payroll`, `post-class-feedback`, `progress-tests`,
`proposals`, `room-capacity`, `sales-dashboard`, `scheduler`, `search`,
`student-promotions`, `student-report`, `student-schedule`, `syllabus`, `sync`,
`ui`, `us-universities`, `wise`, `wise-activity`) plus **10** loose top-level
modules (`auth.ts`, `auth-access.ts`, `auth-edge.ts`, `bangkok-time.ts`,
`env.ts`, `maintenance.ts`, `tutor-business-profiles.ts`,
`tutor-profile-import.ts`, `tutor-profile-vocabulary.ts`, `utils.ts`).

The conventions below hold across **all** of those domains. Where the newest
modules (post-class-feedback payout, student-report, maintenance, admissions,
competitor-intelligence) have refined an older pattern — per-domain error
responses, typed domain error classes, `db: Database = getDb()` injection,
**injectable `env` records instead of direct `process.env` reads**, role-aware
`require*` session guards, file-header threat-model blocks — the newer form is
called out as the one to copy.

## Naming Patterns

### Files

- **kebab-case** for every source file, without exception:
  `cron-auth.ts`, `auth-access.ts`, `payout-window-health.ts`,
  `payout-retirement.ts`, `schedule-bot-group.ts`, `month-grid.ts`,
  `case-detail-shell.tsx`, `post-class-feedback-workspace.tsx`,
  `student-report-workspace.tsx`
- React components use `.tsx`; pure logic / type-only modules use `.ts`
  (`src/lib/student-report/types.ts`, `src/lib/admissions/types.ts`)
- Singular `schema.ts` for the Drizzle schema (`src/lib/db/schema.ts`)
- Per-domain `types.ts` is the norm — **15** exist, including
  `src/lib/search/types.ts`, `src/lib/admissions/types.ts`,
  `src/lib/post-class-feedback/types.ts`, `src/lib/us-universities/types.ts`,
  `src/lib/student-schedule/types.ts`, `src/lib/student-report/types.ts`,
  `src/lib/progress-tests/types.ts`, `src/lib/syllabus/types.ts`
- Recurring per-domain module names, reused verbatim across features so a new
  domain is navigable on sight. Current file counts under `src/lib/*/`:
  `types.ts` (15), `data.ts` (12), `sync.ts` (7), `config.ts` (5), `access.ts`
  (4), `api.ts` (4), `service.ts` (2), `access-policy.ts` (2),
  `run-sync-request.ts` (2), `actions.ts` (2), `repository.ts` (1),
  `errors.ts` (1). Their roles are fixed: `access.ts`/`api.ts` = authz guards +
  error mapper, `data.ts` = uncached reads, `service.ts` = cached read façade,
  `sync.ts` + `run-sync-request.ts` = ingest + single-flight wrapper
- Test files: `{module}.test.ts(x)` inside a sibling `__tests__/` directory —
  **never** colocated. All **389** test files obey this; a search for
  `*.test.ts*` outside a `__tests__/` dir returns **zero** results
- Integration tests use `.integration.test.ts` (**13** files: 10 under
  `src/lib/post-class-feedback/__tests__/`, 3 under `src/lib/sync/__tests__/`);
  the shared Testcontainers helper is `src/tests/integration/db-helper.ts`
- Page components at `src/app/.../page.tsx` (**31** files); route handlers at
  `src/app/api/.../route.ts` (**180** files, all under `src/app/api/` — there is
  no `route.ts` outside the API tree). Dynamic segments use bracket dirs
  (`src/app/api/admissions/cases/[caseId]/notes/route.ts`)
- Route groups carry cross-cutting shells: `(app)` (authenticated, **26**
  pages), `(print)` (**3** print-only report pages — `learning-plans/report`,
  `student-schedule/report`, `student-report/report`), plus ungrouped `/login`
  and the public `src/app/schedule/[token]/page.tsx`
- Feature-scoped print/legacy CSS lives beside `globals.css` as
  `src/app/{feature}.css` and is pulled in via `@import` at
  `src/app/globals.css:4-7` — **four** files now (`credit-control.css`,
  `learning-plans.css`, `student-schedule.css`, `student-report.css`)
- Ambient/type-augmentation files live in `src/types/`
  (`next-auth.d.ts`, `credit-control.ts`, `post-class-feedback.ts`)

### Functions

- **camelCase** for all functions, verb-prefixed by intent. Measured across
  `export (async )?function` in `src/lib`, the dominant prefixes are `get` (132),
  `build` (109), `is` (61), `list` (48), `normalize` (43), `update` (36),
  `parse` (36), `run` (35), `format` (35), `fetch` (35), `resolve` (34),
  `create` (34), `load` (24), `compute` (19), `assert` (18), `find` (14),
  `require` (13), `upsert` (12), `has` (11):
  - `get*` — retrieval / accessors: `getDb()` (`src/lib/db/index.ts:22`),
    `getSearchIndex()` (`src/lib/search/index.ts:115`),
    `getCronSecretStatus()` (`src/lib/internal/cron-auth.ts:6`),
    `getStudentMonthlySchedule()` (`src/lib/student-schedule/data.ts:309`),
    `getPostClassCapabilities()`, `getLearningPlansAccess()`,
    `getHomeSummaryPayload()` (`src/lib/home/summary.ts:151`)
  - `list*` — collection reads shaped for a caller/role: `listNotesForRole()`,
    `listOwnBrandSources()`, `listSalesDashboardSources()`
  - `is*` / `has*` / `should*` — booleans: `isBlockingStatus()`
    (`src/lib/normalization/sessions.ts:46`), `isMonthKey()`,
    `isUniqueViolation()` (`src/lib/admissions/cohorts.ts:19`),
    `isMaintenanceMode()` / `isMaintenanceExempt()` (`src/lib/maintenance.ts`)
  - `create*` / `make*` — factories: `createWiseClient()`
    (`src/lib/wise/client.ts:214`), `createDb()`, `createNote()`
  - `parse*` / `normalize*` — transformation: `normalizeSessions()`,
    `normalizeLeaves()`, `normalizeWorkingHours()`, `normalizeTeacherTags()`
  - `fetch*` — outbound I/O: `fetchAllTeachers()`, `fetchAllFutureSessions()`,
    `fetchInstituteSessionsForDays()`
  - `derive*` / `resolve*` / `extract*` — inference: `deriveModality()`,
    `resolveIdentities()`, `resolveUserAccess()` (`src/lib/auth-access.ts:56`),
    `resolveAdmissionsRole()`, `resolveWriteTarget()`, `extractNickname()`
  - `build*` / `compute*` — derived structures: `buildIndex()`
    (`src/lib/search/index.ts:142`), `buildCompareTutor()`,
    `buildParentReportPayload()`, `buildStudentSchedulePayload()`
  - `detect*` / `find*` — analysis: `detectConflicts()`, `findSharedFreeSlots()`
  - `run*` — orchestrated jobs: `runFullSync()`, plus the per-domain sync entries
    (`runCreditControlSync()`, `runPostClassFeedbackSync()`, …)
  - **`require*`** — session/authorization guards that **throw** on failure.
    **13** exported: `requireAdmissionsSession`, `requireAdmissionsAdmin`,
    `requireCaseAccess`, `requireCounselorOrAdmin`, `requireCreditControlSession`,
    `requireCompetitorIntelligenceSession`, `requireLearningPlansAccess`,
    `requirePayoutGoogleTarget`, `requirePostClassCapability`,
    `requireProgressTestsSession`, `requireProgressTestsAdminSession`,
    `requireStudentPromotionSession`, `requireStudentPromotionRunId`.
    Use these, not ad-hoc `auth()` checks, in any domain that already has one.
    (`requiredYearForTransition` in student-promotions is an adjective, not a
    guard — do not read it as part of this family)
  - **`assert*`** — invariant guards that throw on violation, **18** exported and
    concentrated in the payout/finance write paths: `assertPayoutRunPublishable`
    (`src/lib/post-class-feedback/payout-plan.ts:93`),
    `assertPayoutWindowOpenForDeduction`, `assertPayoutWindowOpenForSession`,
    `assertPayoutAnchorMonth`, `assertPayoutRollFitsLease`,
    `assertPostClassApprovalPeriodInvariant`,
    `assertPostClassDeductionCandidateStillActionable`,
    `assertPostClassFinanceIdempotentPayloadMatches`, `assertIsoDate`,
    `assertPayrollMonth`, `assertUtilizationDate`, …
  - `reject*` — guards that return an error response **or** `null` to continue:
    `rejectInvalidCronSecret()` (`src/lib/internal/cron-auth.ts:19`)
- Internal/private helpers are lowercased with no special marker
  (`baseUrl`, `failStaleRunningSyncs`, `getWritePool`, `pruneExpired`)

### Variables

- **camelCase** for locals and properties: `snapshotMeta`, `tutorGroupIds`,
  `teacherCanonicalKeys`, `allowedPages`, `unresolvedRatio`, `reviewReasons`,
  `rowSignature`, `idempotencyKey`
- Module-level mutable singletons are **not** `_`-prefixed. The codebase uses a
  `globalThis` namespace to survive Next.js HMR. **Three** globals exist —
  `__bgscheduler_db` (`src/lib/db/index.ts:16-27`), `__bgscheduler_searchIndex`
  + `__bgscheduler_searchIndexBuildPromise` (`src/lib/search/index.ts:94-113`),
  and `__bgscheduler_liveMonthSessionsCache`
  (`src/lib/student-schedule/live.ts:37-46`, a TTL'd Wise-overlay cache with an
  explicit `pruneExpired` because TTL alone never frees memory on a long-lived
  Fluid Compute instance). Those three files are the **only** places
  `declare global` appears in non-test `src/` (a fourth `declare module`
  augmentation lives in `src/types/next-auth.d.ts`), and this is the **only**
  module-singleton mechanism — no `let _db` / `let _cachedIndex` style exists
  anywhere in `src/`
- The **three** lazily-created `pg` write pools are the sole module-scoped `let`
  exceptions, and each is local to its transaction module
  (`src/lib/post-class-feedback/transaction.ts:9`,
  `src/lib/payroll/sync.ts:27`, `src/lib/admissions/audit.ts:38`)

### Constants

- **UPPER_SNAKE_CASE** for module-level constants: `TUTOR_COLORS`,
  `CACHE_VERSION`, `CRON_JOBS`, `Z_INDEX`, `BANGKOK_TIME_ZONE`, `TEACHER_TBC`,
  `DEFAULT_LINK_TTL_DAYS`, `HOUR_HEIGHT`, `START_HOUR`, `DISPLAY_DAYS`,
  `DEFAULT_DEADLINE_MS`, `CACHE_TTL_MS`, `CACHE_MAX_ENTRIES`,
  `STALE_RUNNING_CREDIT_CONTROL_SYNC_MS`, `ADMISSIONS_ROUTE`,
  `PAYOUT_MASTER_SPREADSHEET_ID`
- Route-prefix constants back the page-access system — a domain declares its own
  prefix once and both the guard and the nav read it. **Four** are exported:
  `ADMISSIONS_ROUTE = "/admissions"` (`src/lib/admissions/config.ts`),
  `LEARNING_PLANS_ROUTE = "/learning-plans"`
  (`src/lib/learning-plans/access-policy.ts`),
  `COMPETITOR_INTELLIGENCE_ROUTE = "/competitor-intelligence"`
  (`src/lib/competitor-intelligence/access-policy.ts`),
  `POST_CLASS_FEEDBACK_ROUTE = "/post-class-feedback"`
  (`src/lib/post-class-feedback/access.ts`). `PROGRESS_TESTS_ROUTE` is
  deliberately module-private in both `src/lib/progress-tests/api.ts` and
  `src/lib/auth-access.ts:29`
- Cache-tag constants follow `{DOMAIN}_CACHE_TAG`. **Five** exist:
  `CREDIT_CONTROL_CACHE_TAG`, `PROGRESS_TESTS_CACHE_TAG`,
  `SALES_DASHBOARD_CACHE_TAG`, `US_UNIVERSITIES_CACHE_TAG`,
  `DASHBOARD_CACHE_TAG`. The older snapshot-scoped helpers instead use the bare
  string tag `"snapshot"` (`src/lib/data/filters.ts:53-55`)
- Cross-cutting versioned constants get a dedicated module with the migration
  history in the JSDoc — `src/lib/search/cache-version.ts`
  (`CACHE_VERSION = "v3"`, with the v1→v3 history and an explicit "MUST bump"
  rule) and `src/lib/ui/z-index.ts` (three-tier `content: 1` / `legend: 6` /
  `popover: 50` scale, `as const`, with the consumer convention spelled out)

### Types

- **PascalCase** for interfaces and type aliases. **1,017** types are exported
  from `src/lib`
- `interface` for object shapes; `type` for unions, primitives, or aliases:
  - `interface SearchRequest`, `interface IndexedTutorGroup`,
    `interface CronJobDefinition` (`src/lib/data-health/cron-registry.ts:26`),
    `interface UserAccess` (`src/lib/auth-access.ts:33`),
    `interface PayoutGoogleTarget` (`src/lib/post-class-feedback/payout-config.ts:53`)
  - `type SearchMode = "recurring" | "one_time"` (`src/lib/search/types.ts`),
    `type UserRole = "admin" | "teacher" | "counselor" | "student" | "parent"`
    (`src/lib/auth-access.ts:31`),
    `type CronSecretStatus = "valid" | "invalid" | "missing-secret"`
    (`src/lib/internal/cron-auth.ts:4`),
    `type PayoutEnvironmentTarget = "scratch" | "production"`
    (`src/lib/post-class-feedback/payout-config.ts:7`),
    `type CronJobKey = "wise_snapshot" | …` (**22** members,
    `src/lib/data-health/cron-registry.ts:3-24`)
- Domain-prefixed names — the leading token names the owning subsystem. Top
  prefixes by exported-type count in `src/lib`: `Admissions*` (76), `Line*` (67),
  `Wise*` (66), `Payout*` (39), `Post*` (34), `Scheduler*` (33), `Progress*`
  (29), `Sales*` (27), `Student*` (26), `Room*` (25), `Tutor*` (23):
  - `Wise*` for external Wise API shapes: `WiseTeacher`, `WiseSession`,
    `WiseCreditSession`, `WiseClientStats`
  - `Indexed*` (8) for in-memory index types: `IndexedTutorGroup`,
    `IndexedSessionBlock`, `IndexedAvailabilityWindow`, `IndexedDataIssue`
  - `Normalized*` (7) for normalization-pipeline outputs:
    `NormalizedSessionBlock`, `NormalizedQualification`, `NormalizedPayrollSession`
  - `Compare*` (5) for compare-engine outputs: `CompareTutor`, `CompareSessionBlock`
  - `Parsed*` (9) for parser outputs (sales pipeline): `ParsedNormalSaleRow`
- Two suffix conventions, both load-bearing at the serialization boundary:
  - **`*Dto`** (43 exports) for shapes crossing a Server→Client or API boundary,
    with ISO-8601 strings for timestamps and `"YYYY-MM-DD"` for date-only
    columns: `AdmissionsNoteDto`, `AdmissionsCollegeListRowDto`. The contract is
    documented at the top of `src/lib/admissions/types.ts`
  - **`*Input`** (99 exports) for write-path argument objects: `FollowUpStateInput`,
    `SourceInputSchema`-shaped payloads
- TypeScript `enum` is **never** used — a repo-wide search returns **zero**
  declarations. Database enums use Drizzle's `pgEnum` (**61** declarations in
  `src/lib/db/schema.ts`), which doubles as the TS union source.

### Database (Drizzle / Postgres)

- **snake_case** for table and column SQL names: `admissions_case_members`,
  `post_class_payout_run_lines`, `student_schedule_links`, `cron_invocations`,
  `snapshot_id`, `group_canonical_key`, `is_online_variant`
- **camelCase** for the Drizzle schema object names — every table is
  `export const {camelCase} = pgTable("{snake_case}", …)`
  (`syncRuns` → `sync_runs`, `cronInvocations` → `cron_invocations`,
  `googleOAuthTokens` → `google_oauth_tokens`)
- **189 tables** declared with `pgTable(...)` in `src/lib/db/schema.ts`, plus
  **61** `pgEnum` declarations (`pgEnum("sync_status", …)` → `syncStatusEnum`).
  **69** SQL migrations under `drizzle/`, generated by `drizzle-kit` from
  `drizzle.config.ts` (`schema: ./src/lib/db/schema.ts`, `out: ./drizzle`,
  dialect `postgresql`)
- **460 index declarations** (334 `index(...)` + 126 `uniqueIndex(...)`), every
  name unique. Two naming eras genuinely coexist at roughly a 50/50 split —
  **224** names use a subsystem abbreviation prefix and **236** use the full
  table name. Match the neighbours of the table you are editing:
  - Abbreviation-prefixed families are large and current, not vestigial:
    `pc_*` (91, post-class feedback), `sp_*` (18, student promotions),
    `pt_*`/`ptal_*`/`ptcs_*` (progress tests), `cc_*`/`ccs_*`/`ccsr_*` (credit
    control), `car_*`/`caer_*`/`cae_*`/`cser_*` (classroom assignments),
    `sdar_*`/`sdnr_*`/`sdpm_*`/`sdps_*`/`sds_*`/`sdir_*`/`sdpir_*` (sales
    dashboard), `rcdm_*`/`rcfd_*`/`rcmr_*`/`rcpm_*`/`rus_*` (room capacity),
    plus the original snapshot core (`tig_*`, `fsb_*`, `di_*`, `dl_*`, `psb_*`,
    `raw_*`, `rtt_*`, `slq_*`, `ss_*`)
  - Full-table-name families: `admissions_*` (61), `competitor_*` (47),
    `line_*` (37), `payroll_*` (19), `leave_*` (13), `ipeds_*` (10),
    `wise_activity_events_*`, `cron_invocations_*`, `sync_runs_*`.
    **Prefer this form for new tables** — it is self-documenting and
    collision-free
- `uniqueIndex` is not only a constraint but the **concurrency primitive**: sync
  and digest jobs rely on a unique partial index to enforce single-flight and
  catch the `23505` unique violation rather than taking a lock. **13** such
  `*_single_running_idx` indexes exist — `sync_runs_single_running_idx`,
  `pc_sync_single_running_idx`, `pt_sync_runs_single_running_idx`,
  `ccsr_single_running_idx`, `payroll_sync_runs_single_running_idx`,
  `wise_activity_sync_runs_single_running_idx`,
  `leave_request_sync_runs_single_running_idx`,
  `competitor_sync_runs_single_running_idx`, `ipeds_runs_single_running_idx`,
  `admissions_notification_runs_single_running_idx`,
  `line_backlog_recovery_sync_runs_single_running_idx`,
  `sdir_source_single_running_idx`, `sdpir_source_single_running_idx`
  (see *Sync Orchestrator Errors*)
- Idempotency is a schema-level convention too: `idempotency_key` /
  `idempotencyKey` (174 references) guards replayed cron and notification work,
  and `row_signature` / `rowSignature` (70) guards duplicate payout-sheet rows

## Code Style

### Formatting

- **No formatter config** is checked in (no `.prettierrc`, no `.editorconfig`,
  no Biome)
- **2-space indentation** throughout
- **Double quotes** for strings everywhere. Measured across `src/lib`, `src/app`,
  `src/components`: **5,325** double-quoted `from "…"` specifiers and **0**
  single-quoted ones
- **Semicolons required** in `src/lib/**`, `src/app/**`, and all feature
  components
- **Semicolons omitted** in the 16 shadcn/ui primitives (`src/components/ui/*.tsx`
  — every one has zero semicolon-terminated lines) and in `src/lib/utils.ts`.
  These are regenerated by the shadcn CLI; leave them alone
- Trailing commas on multi-line object/array literals
- Template literals for interpolation
  (`` `Wise API ${response.status}: ${text} (${url})` ``, `src/lib/wise/client.ts:167`)
- **File-header block comments** are the strongest convention in newer code:
  **88 of 299** non-test `src/lib` modules open with a `//` comment block stating
  the module's purpose, source of truth, and the product/security rules it
  enforces before any import. `src/lib/student-schedule/links.ts:1-14`
  (capability-token threat model), `src/lib/student-report/db.ts:1-20`
  (snapshot-scoping rationale plus its one documented exception),
  `src/lib/maintenance.ts:1-20` (the MAINT-01..04 rule list),
  `src/lib/student-schedule/live.ts:1-15` (fail-soft contract) and
  `src/lib/auth-access.ts:1-19` (five-role resolution order) are the models to
  copy for anything non-obvious

### Linting

- **ESLint 9** flat config at `eslint.config.mjs`
- Extends `eslint-config-next/core-web-vitals` and `eslint-config-next/typescript`
  only — **no custom rules**
- Default ignores re-declared so `.next/`, `out/`, `build/`, `next-env.d.ts`
  stay ignored (`eslint.config.mjs:9-15`)
- Runs via `npm run lint` (bare `eslint`); type-checking is separate
  (`npm run typecheck` → `tsc --noEmit`)
- Inline `eslint-disable` is rare — **26 sites** in non-test source, confined to
  four rules:
  - `react-hooks/exhaustive-deps` (14) — intentionally non-reactive effects;
    newer sites append a `-- <reason>` clause
  - `react-hooks/set-state-in-effect` (9) — one-shot mount handoffs, e.g.
    `-- one-shot post-hydration localStorage read (CM-131)`
  - `@typescript-eslint/no-unused-vars` (2) — destructure-to-drop a column
  - `no-var` (1) — the `globalThis` augmentation in `src/lib/db/index.ts:17`
- When adding a disable, append `-- <reason>` after the rule name. Do not
  silence a rule project-wide.
- Two repo-specific guards run outside ESLint and are wired into
  `npm run verify:release`: `scripts/check-production-route-surface.mjs` walks
  every `page.tsx` / `route.ts` and diffs the result against
  `docs/reference/production-route-surface.json`, and
  `scripts/check-sales-dashboard-scope.mjs` fences that domain. Adding a page or
  route means updating the manifest in the same commit

### TypeScript

- **strict: true** in `tsconfig.json`
- `target: "ES2017"`, `module: "esnext"`, `moduleResolution: "bundler"`
- `lib: ["dom", "dom.iterable", "esnext"]`, `jsx: "react-jsx"`
- `isolatedModules: true`, `esModuleInterop: true`, `allowJs: true`,
  `noEmit: true`, `resolveJsonModule: true`, `incremental: true`,
  `skipLibCheck: true`, `plugins: [{ "name": "next" }]`
- Path alias `"@/*": ["./src/*"]`
- `next.config.ts` sets exactly one option — `cacheComponents: true` — which is
  why every uncached `auth()` call sits inside its own `async` component wrapped
  in `<Suspense>` (see *Component Patterns*)
- Non-null assertions are used sparingly and only after a defensive check or at
  a boot boundary (`this.queue.shift()!` in the Wise concurrency limiter, guarded
  by the `queue.length > 0` loop condition; `process.env.WISE_USER_ID!` inside
  `createWiseClient()`, `src/lib/wise/client.ts:214-221`)
- Type predicates at filter boundaries remain a recurring pattern
  (`.filter((g): g is IndexedTutorGroup => g !== undefined)`)
- Narrowing on `unknown` errors is always structural, never a cast to `any`:
  ```typescript
  typeof err === "object" && err !== null && "code" in err &&
    (err as { code?: unknown }).code === "23505"
  ```
  (`src/lib/credit-control/run-sync-request.ts:41-48`). Newer copies also check
  `cause.code`, because Drizzle wraps the driver error
  (`src/lib/post-class-feedback/repository.ts:361-366`), and the newest walks the
  whole `cause` chain recursively (`src/lib/admissions/cohorts.ts:19-31`)

## Import Organization

### Order (observed pattern)

1. External packages (`next/server`, `next/cache`, `zod`, `react`,
   `drizzle-orm`, `date-fns-tz`, `@base-ui/react`, `lucide-react`,
   `node:crypto`, `pg`)
2. Internal `@/` aliases, roughly by depth: `@/lib/auth` → `@/lib/db` →
   domain libs → `@/components/ui/*` → `@/components/{feature}/*`
3. Relative imports (`./types`, `./config`, `./access`, `../identity`)
4. Type-only imports — either a dedicated `import type { … }` line (**383** in
   `src/lib`) or an inline `type` specifier inside a value import (**114**), e.g.
   `import { getDb, type Database } from "@/lib/db"`. Both are idiomatic; the
   inline form is preferred when the same module supplies both

Server-only modules put `import "server-only";` on the very first line, above
everything else (**20** modules: 18 in `post-class-feedback`, plus
`src/lib/learning-plans/access.ts` and `src/lib/syllabus/get-year-syllabus.ts`) —
see `src/lib/post-class-feedback/transaction.ts:1`.

Newer modules insert a **blank line between the external block and the `@/`
block**; older ones run them together. Match the file.

Example (`src/lib/student-report/db.ts:22-30`):

```typescript
import { and, asc, eq, gte, inArray, lt, sql } from "drizzle-orm";

import { getActiveCreditSnapshot } from "@/lib/credit-control/db";
import * as schema from "@/lib/db/schema";
import { parseStudentDisplay } from "@/lib/student-schedule/data";
import {
  buildParentReportPayload,
  collectFeedbackWiseSessionIds,
  packageMetaKey,
} from "@/lib/student-report/build";
```

### Path Aliases

- Single alias: `@/*` → `./src/*`
- Configured in **both** `tsconfig.json` (`paths`) and `vitest.config.ts`
  (`resolve.alias`) so tests resolve identically
- **No barrel files.** Only two `index.ts` files exist in `src/lib`
  (`src/lib/db/index.ts`, `src/lib/search/index.ts`) and both are real modules
  with their own logic, not re-export shims. Import from the specific file:
  `from "@/lib/wise/client"`, never `from "@/lib/wise"`
- Namespace imports are reserved for three things: the Drizzle schema
  (`import * as schema from "@/lib/db/schema"` — **116** sites), React (10), and
  `XLSX` (1). The only other `import * as` sites are route-module imports inside
  admissions handler tests
- Cross-domain imports go through the owning domain's public function, not its
  internals — e.g. `auth-access.ts` calls `resolveAdmissionsRole()` and
  `resolveTeacherCanonicalKeys()` rather than querying those tables itself
  (`src/lib/auth-access.ts:22-26`), and `student-report/db.ts` reaches credit
  control through `getActiveCreditSnapshot()`
- The shadcn `components.json` registers extra CLI aliases (`@/components`,
  `@/lib/utils`, `@/components/ui`, `@/lib`, `@/hooks`); application code only
  ever uses `@/*`

## Error Handling

### API Route Pattern

Two shapes are in use. **Both are correct**; which one you write depends on
whether the domain already owns an error-response helper.

**Shape A — explicit four-step (the original; still the majority).** Auth →
JSON → Zod → business try/catch, each failure returning early:

```typescript
export async function POST(request: NextRequest) {
  const session = await auth();
  if (!session?.user?.email) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const parsed = bodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid body", details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  try {
    // ... business logic
  } catch (error) { /* 500 with extracted message */ }
}
```

(`src/app/api/student-schedule/link/route.ts:22-40`)

**Shape B — guard-and-map (every domain built since case management).** The
whole handler is one `try`, a `require*` guard throws `"Unauthorized"` /
`"Forbidden"` / a typed domain error, and a single per-domain helper maps the
thrown value to a status:

```typescript
export async function GET() {
  try {
    await requireCompetitorIntelligenceSession();
    const sources = await listOwnBrandSources();
    return NextResponse.json({ sources });
  } catch (error) {
    return competitorIntelligenceErrorResponse(error, "Failed to list own-brand sources");
  }
}
```

(`src/app/api/competitor-intelligence/own-sources/route.ts:17-25`)

The invariant that survives both shapes: **authorization is resolved before the
body is read.** In case-scoped routes this is explicit —
`requireAdmissionsSession()` then `requireCaseAccess(email, caseId, minRole)`
run *before* `request.json()` on every method
(`src/app/api/admissions/cases/[caseId]/notes/route.ts:52-62`).

### Per-Domain Error Response Helpers

Six domains export a `{domain}ErrorResponse(...)` mapper. Copy one when adding a
domain rather than hand-rolling status logic:

| Helper | File:line | Signature |
|---|---|---|
| `admissionsErrorResponse` | `src/lib/admissions/access.ts:256` | `(route, error, fallbackMessage)` |
| `postClassFeedbackErrorResponse` | `src/lib/post-class-feedback/api.ts:12` | `(route, error, fallback)` |
| `progressTestsErrorResponse` | `src/lib/progress-tests/api.ts:74` | `(route, error, fallbackMessage)` |
| `creditControlErrorResponse` | `src/lib/credit-control/api.ts:17` | `(route, error, fallbackMessage)` |
| `studentPromotionErrorResponse` | `src/lib/student-promotions/api.ts:29` | `(route, error, fallbackMessage)` |
| `competitorIntelligenceErrorResponse` | `src/lib/competitor-intelligence/access.ts:32` | `(error, fallbackMessage)` — **no `route` arg** |

Every one of them opens with the same **re-throw guard** for Next.js internals —
an error carrying `digest === "HANGING_PROMISE_REJECTION"` is re-thrown, never
converted to a 500 (`src/lib/post-class-feedback/api.ts:13-20`). Preserve that
block verbatim when writing a new helper.

Prefer the three-argument `(route, error, fallback)` signature for new domains:
it puts the route path as the first token of the log line, which is what makes
Vercel logs greppable. Routes that use it declare the path once as a
module-scope `const ROUTE = "/api/admissions/cases/[caseId]/notes"` and pass it
to every handler's catch (`.../notes/route.ts:19`).
`competitorIntelligenceErrorResponse` is the odd one out and logs the fallback
message instead (`src/lib/competitor-intelligence/access.ts:49`).

The most complete implementation is `postClassFeedbackErrorResponse`: it maps
`PostClassAccessError` → its own `.status`, sentinel `"Unauthorized"`/`"Forbidden"`
→ 401/403, `PostClassValidationError` and `ZodError` → 400,
`PostClassNotFoundError` → 404, `PostClassConflictError` → 409, and — uniquely —
**refuses to serialize an unknown error** into the response, logging only
`error.name` because DB/HTTP client errors can carry private feedback text
(`src/lib/post-class-feedback/api.ts:45-53`).

### Typed Domain Error Classes

Newer write paths throw named classes instead of bare `Error`, so the route
mapper can branch without string matching. Each sets `this.name` in its
constructor:

```typescript
export class PostClassConflictError extends Error {
  constructor(message = "This record changed. Refresh and try again.") {
    super(message);
    this.name = "PostClassConflictError";
  }
}
```

(`src/lib/post-class-feedback/errors.ts:1-6` — the only dedicated `errors.ts` in
the repo; other domains declare their classes beside the code that throws them.)

**21** such classes exist across `src/lib` (22 `export class` declarations, of
which only `WiseClient` is not an error), concentrated in the
optimistic-concurrency and single-flight paths: `PostClassValidationError`,
`PostClassNotFoundError`, `PostClassAccessError`,
`PostClassPolicySnapshotConflictError`, `PostClassFeedbackSyncAlreadyRunningError`,
`PostClassFeedbackSyncSourceFenceError`, `PostClassWiseSchemaError`,
`PostClassSessionDataError`, `DuplicatePayoutSignatureError`,
`DuplicatePayoutAppendSignatureError`, `ProposalConflictError`,
`ProposalNotFoundError`, `ProposalValidationError`,
`StaleClassroomAssignmentSnapshotError`, `PayrollSyncAlreadyRunningError`,
`WiseActivitySyncAlreadyRunningError`, `LeaveRequestSyncAlreadyRunningError`,
`LineLinkValidationError`, `MissingGoogleSheetsTokenError`,
`CreditControlInsertError`.

Older/simpler domains still throw sentinel `new Error("Unauthorized")` /
`"Forbidden"` / `"NotFound"` / `"Conflict"` strings that the helpers match on
(`src/lib/admissions/access.ts:266-280`). Both work; prefer a typed class for
anything a caller may need to distinguish.

### HTTP Status Conventions

Actual distribution of `status: NNN` literals across `src/app/api/**/route.ts`:

| Status | Count | Meaning |
|---|---|---|
| `400` | 201 | invalid JSON body, Zod failure, domain validation error |
| `401` | 111 | no session, or invalid cron secret |
| `500` | 67 | caught business-logic exception (or cron `missing-secret`) |
| `404` | 37 | resource absent from the active snapshot / soft-deleted |
| `409` | 18 | optimistic-concurrency conflict, duplicate signature, job already running |
| `503` | 6 | upstream dependency unavailable |
| `403` | 6 | authenticated but `allowedPages` / case role forbids it |
| `201` | 6 | resource created |
| `502` | 2 | upstream returned an unusable response |
| `204` | 2 | accepted, no body |
| `202` | 1 | accepted, async work continues |
| `200` | 1 | explicit success literal (the default; usually omitted) |

`403` is the marker of the role system: non-admins never learn whether a case
exists, so a case they cannot see returns **Forbidden, not NotFound**
(`src/lib/admissions/access.ts:1-7`). The middleware issues the same 403 for an
API path outside a restricted user's `allowedPages` (`src/middleware.ts:94-96`).

### Error Message Extraction

The universal pattern in catch blocks remains
`const message = err instanceof Error ? err.message : "<Default message>"`
(**82** sites in route handlers), with a route-specific default. The single
deliberate exception is the post-class feedback path, which returns only the
caller-supplied `fallback` because upstream error objects may embed private
student/tutor feedback text (`src/lib/post-class-feedback/api.ts:45-53`). Apply
the same restraint to any new surface handling parent-visible or payroll data.

### Cron-Protected Routes (constant-time auth)

Internal cron routes never compare the bearer token with `===`. They use a
**constant-time** `timingSafeEqual` from `node:crypto` with an O(1) length
pre-check that avoids the `RangeError` `timingSafeEqual` throws on
length-mismatched buffers (the REL-07 hardening):

```typescript
const received = Buffer.from(authHeader);
const known = Buffer.from(`Bearer ${cronSecret}`);
const valid = received.length === known.length && timingSafeEqual(received, known);
```

(`src/lib/internal/cron-auth.ts:12-16`)

- The shared helper exports `getCronSecretStatus()` →
  `"valid" | "invalid" | "missing-secret"` and `rejectInvalidCronSecret()` →
  `NextResponse | null` (401 for invalid, **500** for a server missing its
  secret, `null` to continue). **16 of the 22** `src/app/api/internal/**` routes
  import it
- **6 routes still inline** an equivalent implementation:
  `sync-wise` (which also supports session-auth fallback for manual admin
  triggers), `sync-room-utilization`, `sync-competitor-intelligence`,
  `sync-sales-dashboard`, `sync-credit-control`, `student-promotions/july-1`.
  When touching one of these, migrate it to the shared helper rather than
  copying the block again
- Cron routes are exempt from the middleware auth gate — `/api/internal/` is on
  the public-route allowlist (`src/middleware.ts:23`), so the secret check
  inside the handler is the *only* thing protecting them. Never add a route
  under `/api/internal/` without one
- The **17** crons in `vercel.json` are mirrored by a typed `CRON_JOBS` registry
  (`src/lib/data-health/cron-registry.ts:47`) that carries **22** entries — the
  17 scheduled jobs plus **5** `manualOnly: true` / `schedule: null` jobs
  (`post_class_feedback_digest`, `post_class_feedback_day_after`,
  `post_class_feedback_deadline`, `room_utilization`, `line_backlog_recovery`)
  triggered from the Data Health UI instead. Each entry declares `path`,
  `schedule`, `cadenceLabel`, `cadenceMinutes`, `lateAfterMinutes`,
  `maxDurationSeconds`, `manualOnly`, `dangerous`, `confirmationLabel`,
  `routeMethod`, plus optional `expectedBangkok*` window fields. A derived
  `SCHEDULED_CRON_JOBS = CRON_JOBS.filter((job) => !job.manualOnly)`
  (`cron-registry.ts:401`) is what
  `src/lib/data-health/__tests__/cron-registry.test.ts` and
  `src/__tests__/vercel-crons.test.ts` diff against `vercel.json`. Adding a
  scheduled cron means adding **both** entries; those tests fail if they disagree

### Graceful Degradation for Optional Tables

Routes depending on optionally-migrated tables detect Postgres' "relation does
not exist" by message substring — checking `error.message` **and**
`error.cause.message`, because Drizzle wraps the driver error as
`Failed query: <sql>` — and return a typed "missing" payload with HTTP 200 so
the UI renders an empty state instead of an error
(`src/lib/internal/cron-watchdog.ts:273-292`,
`src/lib/tutor-business-profiles.ts:196-200`,
`src/lib/data-health/dashboard.ts:848`).

### Fail-Closed Defaults

Non-negotiable safety rule (AGENTS.md). Unresolved data routes the user away
from a confident answer; it is never silently dropped and never guessed:

- Unknown or absent session status → **blocking**
  (`src/lib/normalization/sessions.ts:46-52`, both branches commented `fail-closed`)
- Unresolved identity / modality / qualification → **"Needs Review"**, never
  "Available". `reviewReasons` accumulates and routes the tutor into the
  `needsReview` bucket rather than `available`
  (`src/lib/search/engine.ts:83-149`)
- Cancelled sessions are explicitly non-blocking, and a `CANCELLED`/`CANCELED`
  session is omitted from the parent-facing monthly schedule entirely
  (`src/lib/student-schedule/data.ts:11-13`)
- A session with no resolvable teacher renders the `TEACHER_TBC` placeholder
  (`src/lib/student-schedule/types.ts:10`) — it is never dropped and the teacher
  is never inferred from the class or package name
  (`src/lib/student-schedule/data.ts:14-16`)
- Sign-in itself is fail-closed: an email matching none of admin / counselor /
  teacher / case-member resolves to `null` and is denied
  (`src/lib/auth-access.ts:14-16`, `:38-55`)
- Capability tokens for the public parent page fail closed and leak nothing:
  expired, revoked, unknown, and malformed all return `null`, so the page
  cannot be used as an existence oracle (`src/lib/student-schedule/links.ts:11-13`)
- The LINE schedule bot is fail-closed by construction — an unset or empty
  `LINE_SCHEDULE_BOT_ADMIN_IDS` disables it entirely (`src/lib/env.ts:15-18`)
- Maintenance-mode bypass is the same shape: an unset or empty
  `MAINTENANCE_BYPASS_EMAILS` means **nobody** bypasses (`src/lib/env.ts:33-35`)
- Money-moving configuration has **no fallbacks**: `payout-config.ts` states
  outright that every deployment must name every Google resource and declare
  `scratch` or `production`, and `payoutWritesEnabled()` accepts only the exact
  string `"true"` — `"TRUE"`, `" true "` and `"1"` are all false
  (`src/lib/post-class-feedback/payout-config.ts:1-5`, `:48-51`). Post-class
  payout is **stable, with writes flag-gated by
  `POST_CLASS_PAYOUT_WRITES_ENABLED` / `POST_CLASS_AUTO_APPROVE_ENABLED`**
- Wise write paths are gated behind explicit `WISE_SESSION_*_VERIFIED`
  environment flags (`WISE_SESSION_CREATE_VERIFIED`,
  `WISE_SESSION_OPERATIONS_VERIFIED`, `WISE_SESSION_SUBJECT_UPDATE_VERIFIED`)
- **Fail-soft is the deliberate opposite, and is documented where it applies.**
  The live Wise overlay on `/schedule` returns `ok: false` with an empty session
  list on any error, Zod failure, or deadline overrun, and callers must render
  the snapshot exactly as before — it never throws into the render path
  (`src/lib/student-schedule/live.ts:11-14`). Use fail-soft only where the
  fallback is itself trustworthy data

### Wise Client Errors

`src/lib/wise/client.ts` wraps `fetch` with:

- Non-OK response → throws `Error` carrying status, response text, and URL
  (`src/lib/wise/client.ts:167`, `:176`)
- A private static `RETRYABLE_STATUS_CODES` set (`408, 429, 500, 502, 503, 504`)
  so permanent 4xx fail fast instead of burning retries — the REL-05 hardening,
  with its sources cited in the comment (`src/lib/wise/client.ts:31-44`)
- Network-level failures (DNS / ECONNRESET / fetch `TypeError`) are retried on
  the same schedule (`src/lib/wise/client.ts:149-153`)
- Exponential backoff `Math.pow(2, attempt) * 1000` → 1 s, 2 s, 4 s
  (`src/lib/wise/client.ts:151`, `:172`)
- `maxRetries` default 3, `maxConcurrency` default 5
  (`src/lib/wise/client.ts:65-66`); `createWiseClient()` raises concurrency to
  **15** for the production sync (`src/lib/wise/client.ts:214-221`)
- An EFF-00 per-instance request tally (`WiseClientStats`, counted per logical
  call including retries and bucketed by a normalized path with 24-hex object-id
  segments collapsed) so a sync can report whether it was API-bound
  (`src/lib/wise/client.ts:16-28`)

### Sync Orchestrator Errors

- **Fail-isolated inside the run**: a per-teacher/per-group fetch failure is
  caught and pushed as a `completeness` `data_issue` row carrying the teacher
  name and the extracted message; the sync continues
  (`src/lib/sync/orchestrator.ts`)
- **Promotion gate**: `unresolvedRatio = identityIssues.length /
  Math.max(groups.length, 1)`; promotion only happens when `unresolvedRatio < 0.5`
  (`src/lib/sync/orchestrator.ts:473-476`)
- **Fail-loud at the top**: a top-level throw marks `sync_runs.status = "failed"`
  and preserves the previous active snapshot — no promotion, with an explicit
  comment on why the failure detail is written so an operator can see *why* a
  row is stuck in `running` (`src/lib/sync/orchestrator.ts:586`)
- **Single-flight via unique index, not a lock.** Every long-running job races
  to insert its `running` row and treats a `23505` unique violation as "someone
  else already has it", converting it to a typed `*AlreadyRunningError` or a
  friendly "already running" result. Stale `running` rows are swept by a
  `failStale*` helper against a per-domain `STALE_RUNNING_*_MS` cutoff before the
  claim attempt — four such sweepers exist (`failStaleRunningSyncs`,
  `failStaleRunningCompetitorSyncs`, `failStaleSalesDashboardImports`,
  `failStalePublishJob`), and twelve `STALE_RUNNING_*` constants pair a cutoff
  with its operator-facing error string
  (`src/lib/credit-control/run-sync-request.ts:12`, `:41-46`;
  `src/lib/progress-tests/run-sync-request.ts:39`;
  `src/lib/sales-dashboard/import-guard.ts:58`;
  `src/lib/sync/run-wise-sync.ts:42`)
- The unique-violation predicate is duplicated across **12** modules under three
  shapes — `isUniqueViolation` (7 copies), `isUniqueRunningViolation`
  (`src/lib/payroll/sync.ts:54-59`), and inline `23505` checks in
  `progress-tests/admin-digest.ts`, `line/credit-digest.ts` and
  `classrooms/admin-schedule-email.ts`. **Reuse the exported one** —
  `src/lib/admissions/cohorts.ts:19-31` is the only exported copy and the most
  complete: it checks `code`, the duplicate-key message text, and recurses down
  the whole `cause` chain. The index-name-specific copies
  (`post-class-feedback/repository.ts:361-366`, `payroll/sync.ts:54-59`) also
  regex their own `*_single_running_idx` name, which is the right extra
  narrowing when a module owns exactly one guarded index

## Validation

### Zod Pattern

Schemas are declared as module-scope `const` above the handler. Two casings
coexist — **camelCase dominates 96 to 44**: lowerCamel (`bodySchema`,
`createNoteSchema`, `noteVisibilitySchema`) in the search/admissions/LINE
lineage, PascalCase (`OwnSourceSchema`, `PatchSchema`, `ImportSchema`,
`BodySchema`) in sales-dashboard / competitor-intelligence /
post-class-feedback. Match the file.

```typescript
// Mirrors ADMISSIONS_NOTE_VISIBILITIES (src/lib/admissions/notes.ts). The
// field is deliberately required with NO default — every write carries an
// explicit audience choice (CM-91).
const noteVisibilitySchema = z.enum(["staff_only", "shared_with_family"]);

const createNoteSchema = z.object({
  body: z.string().trim().min(1, "Note body must not be empty"),
  visibility: noteVisibilitySchema,
});
```

(`src/app/api/admissions/cases/[caseId]/notes/route.ts:21-29`)

Note the deliberate absence of a `.default()` on `visibility`, and that the
absence is *commented with its decision ID*. When a Zod field maps to a column,
mirror the column's nullability and defaults exactly, and say so in a comment.

### Coercion at the Boundary

`z.coerce.*` (**38** uses in non-test source) is the preferred way to parse query
params, sheet cells, and raw Wise payloads into typed values:

- `z.coerce.number().int().positive().optional()` for
  `STUDENT_SCHEDULE_LINK_TTL_DAYS` (`src/lib/env.ts:25`)
- `z.coerce.number().min(0).max(1)` for a confidence query param
- `z.coerce.boolean()` / `z.coerce.number()` / `z.coerce.date()` for the raw
  Wise credit-control envelope (`src/lib/credit-control/wise.ts`)

Prefer `z.coerce.*` over `.transform(Number)`.

### Rules

- **`.safeParse()` is the default** (**111** non-test call sites, **96** of them
  inside route handlers) — it returns a discriminated `success` boolean instead
  of throwing
- **`.parse()` is permitted only inside a `try` whose catch maps `ZodError` to
  400.** **19** route sites use it, in three groups:
  - post-class-feedback routes (10) — its helper maps `ZodError` → 400 explicitly
    (`src/lib/post-class-feedback/api.ts:34-36`) ✅
  - sales-dashboard routes (4) — a blanket `catch → 400` ✅
  - competitor-intelligence routes (5) — **its helper still has no `ZodError`
    branch**, so a malformed body surfaces as a **500**
    (`src/lib/competitor-intelligence/access.ts:32-53`). Do not copy this; add a
    `ZodError → 400` branch when you next touch that helper
- A further **16** non-route `.parse()` calls sit on trusted-but-external
  payloads: Wise envelopes (`src/lib/credit-control/wise.ts`, 5), OpenAI /
  classifier responses (`src/lib/ai/*`, `src/lib/line/classifier.ts`,
  `src/lib/competitor-intelligence/ai.ts`), admissions and post-class internal
  reads, and two `.catch(...)`-guarded DB row reads
  (`src/lib/tutor-business-profiles.ts:134-135`).
  Never use `.parse()` in a route whose catch returns 500
- On `.safeParse()` failure return Zod's `.error.flatten()` in a `details` field
  (**87** sites in route handlers)
- Prefer narrowing helpers (`.trim()`, `.min()`, `.max()`, `.regex()`, `.url()`,
  `.uuid()`, `z.coerce.*`) over manual checks
- Zod validates **external** data crossing into the system, not just request
  bodies — Wise API envelopes, OpenAI responses, and imported sheet rows all
  pass through a schema first

### Environment Variable Validation

`src/lib/env.ts` declares an **18-key** schema — 9 required (`DATABASE_URL`,
`AUTH_GOOGLE_ID`, `AUTH_GOOGLE_SECRET`, `AUTH_SECRET`, `WISE_USER_ID`,
`WISE_API_KEY`, `WISE_NAMESPACE`, `WISE_INSTITUTE_ID`, `CRON_SECRET`; the two
`WISE_*` naming keys carry `.default(...)`) plus 9 optional
(`LINE_CHANNEL_SECRET`, `LINE_CHANNEL_ACCESS_TOKEN`, `ENABLE_LINE_SCHEDULER`,
`LINE_SCHEDULE_BOT_ADMIN_IDS`, `ENABLE_STUDENT_SCHEDULE_LIVE`,
`STUDENT_SCHEDULE_LINK_TTL_DAYS`, `APP_BASE_URL`, `MAINTENANCE_MODE`,
`MAINTENANCE_BYPASS_EMAILS`). It `.safeParse()`s `process.env`, logs **only**
`.error.flatten().fieldErrors` (never values), and throws
`"Invalid environment variables"` (`src/lib/env.ts:39-48`).

**Important caveat, verified: nothing imports `@/lib/env`.** A search across
`src/` and `scripts/` returns zero importers, so the schema never actually runs
at boot — and the file now says so itself for `MAINTENANCE_MODE`, which is
"declared here for inventory parity only" because `src/middleware.ts` runs on the
edge and reads `process.env` directly (`src/lib/env.ts:28-32`). In practice
**71 distinct environment variables** are read inside `src/` (75 counting
`scripts/`) with an inline default or feature gate — including `OPENAI_*`,
`RESEND_API_KEY`, `APIFY_*`, `DATAFORSEO_*`, `LEAVE_REQUESTS_*`,
`SCHEDULE_EMAIL_*`, `WISE_SESSION_*_VERIFIED`, `POST_CLASS_PAYOUT_*` and the
`COMPETITOR_*` cost caps. The conventions that *are* live:

- Read a feature-scoped var at its point of use with an explicit fallback
  (`process.env.APP_BASE_URL?.trim() || request.nextUrl.origin`,
  `src/app/api/student-schedule/link/route.ts:18-20`), or a boolean feature gate
- **Newer, and the one to copy: take the environment as an injectable record.**
  `src/lib/post-class-feedback/payout-config.ts` types
  `PayoutEnvironment = Record<string, string | undefined>`, defaults every reader
  to `process.env`, and routes all access through one `value(env, name)` helper
  that trims. That is what makes `payoutWritesEnabled()` and
  `payoutEnvironmentTarget()` unit-testable without mutating global state
  (`payout-config.ts:9-51`); `src/lib/maintenance.ts` follows the same shape
- Treat an unset var as **off**, never as a permissive default
- Never log an env value; never place one in a URL or error body

See *openQuestions* — the dead `env.ts` module is a real inconsistency, not a
convention to imitate.

## Logging

### Approach

- **No structured logger.** Bare `console.error` / `console.log` only, and
  **zero** `console.warn` anywhere in non-test source
- Non-test totals: **79 `console.error`** calls across **44 files**, **10
  `console.log`** calls across exactly **3 files**

### Patterns

- `console.error` for errors that must surface in Vercel logs or sit at a
  fire-and-forget boundary:
  - Env validation failure (`src/lib/env.ts:42`)
  - Sync orchestrator failures (`src/lib/sync/orchestrator.ts`)
  - The tail of every per-domain error-response helper, immediately before the
    500 — logged as `console.error(route, error)` so the route path is the first
    token in the log line (`src/lib/admissions/access.ts:282`,
    `src/lib/progress-tests/api.ts:92`)
  - Async `.catch(console.error)` for client fetches and caught component errors
- `console.log` appears in only three files:
  - `src/lib/db/seed.ts` — human-readable seed progress
  - `src/lib/line/schedule-bot-group.ts:482` — a single prefixed sink,
    `` console.log(`[schedule-bot] ${parts.join(" ")}`) ``
  - `src/lib/line/schedule-bot.ts:232` — the same `[schedule-bot]` prefix.
    If you need operational tracing, copy that shape: one function, one
    bracketed prefix, no scattered calls
- Ordinary request/response handlers do **not** `console.*` — they return JSON
  errors instead

### What to Avoid

- Do not introduce a logging dependency without explicit approval
- **Do not serialize unknown error objects into logs or responses.** DB and HTTP
  client errors can carry request parameters or response bodies containing
  private feedback, payroll, or student data — log `error.name` only, as
  `src/lib/post-class-feedback/api.ts:45-49` does
- Do not log request bodies, secrets, tokens, or env values. `env.ts` logs only
  Zod `fieldErrors`; `student-schedule/links.ts` persists only a SHA-256 hash so
  a log or DB read can never reconstruct a live token
  (`src/lib/student-schedule/links.ts:8-9`)

## Comments

### When to Comment

- **File-header blocks** on any module with a non-obvious source of truth,
  threat model, or product rule — see *Formatting*. This is the highest-value
  comment in the codebase and the strongest current convention (**88 of 299**
  non-test `src/lib` modules)
- **Public exported functions** get JSDoc with a purpose statement, and for
  multi-step algorithms an explicit numbered list of steps
- **Non-obvious arithmetic / business logic** gets inline `//` notes
  (`// 1s, 2s, 4s`, `// 0=Sun`, `// minutes since midnight, Asia/Bangkok`).
  Performance constants carry their measurements: `// Measured against
  production (6 cold months, one student): min 1178ms, p50 1485ms, p95 2783ms`
  is what justifies `DEFAULT_DEADLINE_MS = 8_000`
  (`src/lib/student-schedule/live.ts:22-27`)
- **Design decisions are referenced by ID inline** and are **load-bearing** —
  they tie code to plan/research documents under `.planning/` and to
  `docs/casemanagementsystem_design.md`. Preserve them when editing nearby code.
  Live families, by citation count across `src/**` (tests included):

  | Family | Cites | Domain |
  |---|---|---|
  | `CM-*` | 637 | Case management / admissions (`CM-46`, `CM-91`, `CM-121`, `CM-131`) |
  | `D-*` | 72 | Phase decisions (`D-03`, `D-04`, `D-08`, `D-17`) |
  | `BOT-*` | 59 | LINE schedule bot |
  | `REL-*` | 28 | Reliability hardening (`REL-05` retryable statuses, `REL-07` constant-time cron auth) |
  | `REC-*` | 27 | Recommendation / recurrence |
  | `IDENT-*` | 23 | Identity resolution |
  | `MAINT-*` | 21 | Maintenance-mode kill switch (`MAINT-01`..`MAINT-04`) |
  | `MOD-*` | 19 | Modality derivation (`MOD-01`) |
  | `D-EVT-*` | 15 | Post-class evidence / authorship (`D-EVT-04`) |
  | `PAST-*` | 12 | Past-session capture (`PAST-01`) |
  | `TCOV-*` | 10 | Test coverage |
  | `EFF-*`, `INV/UAT/CAL/STICKY/VPOL/CONTRACT/POLISH/…` | 1–10 each | Per-phase |

  Do **not** mistake student-promotion course codes (`Y2-8`, `G8-10`, `Y9-11`)
  for decision IDs — they are Wise course-level names in
  `src/lib/student-promotions/rules.ts`
- Section references into design docs are cited the same way and are equally
  load-bearing: `docs/casemanagementsystem_design.md §2.1`
  (`src/lib/auth-access.ts:13`), `.planning/REQUIREMENTS.md §STICKY-02`
  (`src/lib/ui/z-index.ts`)

### JSDoc Pattern

```typescript
/**
 * Determines whether an email may sign in, and with what role + page access.
 *
 * 1. `admin_users` row → "admin" with the row's allowedPages (so kevhsh7 /
 *    m.giftwan keep their admin view even if they also appear as a tutor
 *    contact or admissions member).
 * 2. Active `admissions_counselors` registry row → "counselor", restricted to
 *    `/admissions`. …
 * 3. Email matches at least one active tutor contact → "teacher", restricted
 *    to `/progress-tests`.
 * 4. Active `admissions_case_members` membership on any case → "student" or
 *    "parent" (student wins when both), restricted to `/admissions`.
 *
 * @returns the resolved access, or null when the email matches none of the
 *   above (caller denies sign-in — fail-closed).
 */
```

(`src/lib/auth-access.ts:38-55`)

`@returns` is used consistently; `@param` only when the name is not
self-explanatory. Single-line JSDoc for small helpers is fine
(`/** Route prefix this domain's pages and APIs live under. */`;
`/** Get or create the DB singleton (survives HMR in dev). */`,
`src/lib/db/index.ts:21`; ``/** Only the exact string `true` enables
app-originated payout writes. */``,
`src/lib/post-class-feedback/payout-config.ts:48`). Where a helper exists to
fix a specific failure mode, the JSDoc names the failure —
`pruneExpired()` explains that TTL alone "only stops a stale entry being
*served* — it never removes it" (`src/lib/student-schedule/live.ts:48-53`).

### Section Headers

Two patterns coexist — **use whichever the file already uses**. Neither is
domain-specific any more; both appear in `src/lib` and `src/components`:

- **Em-dash bars** — 242 occurrences in `src/lib`, 290 in `src/components`.
  Dominant in the search/admissions/LINE lineage and in the payout modules:
  ```
  // ── Section Name ──────────────────────────────────────────────────
  ```
  (`src/lib/search/index.ts:92`,
  `src/lib/post-class-feedback/payout-config.ts:1`,
  `src/components/admissions/case-detail-shell.tsx`)

- **Long-hyphen blocks** — 72 occurrences in `src/lib`, 169 in
  `src/components`. This is also the form used for file-header blocks and for
  the CSS-file headers:
  ```
  // ---------------------------------------------------------------------------
  // Section Name
  // ---------------------------------------------------------------------------
  ```
  (`src/lib/student-report/db.ts:1-20`, `src/lib/student-schedule/live.ts:1-15`,
  `src/lib/calendar/month-grid.ts`, `src/app/student-schedule.css:1-8`)

### Inline Comment Style

- Reference plan/design IDs inline: `// REL-05: only these HTTP status codes are
  considered transient…` (`src/lib/wise/client.ts:31`), `// MAINT-04 — see
  src/lib/maintenance.ts` (`src/middleware.ts:72`), `// (CM-131)`, `// (CM-91)`
- Use `→` to note transformations: `// "Chinnakrit (Celeste) Channiti" → "Celeste"`
- Type-field documentation: `startMinute: number; // minutes since midnight,
  Asia/Bangkok` (`src/lib/normalization/availability.ts:6`);
  `/** Resolved teacher, or TEACHER_TBC. Never blank. */`
  (`src/lib/student-schedule/types.ts:34`)
- Magic numbers explained: `// 1s, 2s, 4s` (`src/lib/wise/client.ts:151`)
- Long-form deviation rationales live as multi-line `//` blocks directly above
  the code they justify — the `/schedule/` trailing-slash subtlety
  (`src/middleware.ts:17-20`), the "coarse-pass only, do not broaden" note on
  the learning-plans middleware exception (`src/middleware.ts:46-48`), the
  ordering constraint that puts the maintenance gate **above** `isPublicRoute`
  so it can still close `/api/line/webhook` (`src/middleware.ts:72-75`), and the
  `cacheComponents` Suspense requirement (`src/app/(app)/layout.tsx:8-12`)

### TODO Discipline

**Zero** `TODO` / `FIXME` / `HACK` markers exist in non-test source — verified
by a repo-wide grep. Treat them as code smells and resolve before merging.

## Function Design

### Signature Style

- Destructured object parameters for 3+ args or any config object
  (`new WiseClient({ userId, apiKey, namespace, maxConcurrency })`,
  `getStudentMonthlySchedule(db, { studentKey, monthKey, liveSweep, preResolved })`)
- **Database handle as a defaulted trailing parameter** is the dominant DI
  convention — **227** non-test signatures end in `db: Database = getDb()`:
  ```typescript
  export async function resolveUserAccess(
    email: string | null | undefined,
    db: Database = getDb(),
  ): Promise<UserAccess | null>
  ```
  (`src/lib/auth-access.ts:56-59`). Production callers omit it; tests pass a
  hand-rolled chainable fake. Some older modules take the handle **first**
  (`getStudentMonthlySchedule(db, opts)`,
  `src/lib/student-schedule/data.ts:309`) and wrap it in a request-shaped
  convenience export that supplies `getDb()` itself
  (`getStudentMonthlyScheduleForRequest`, `data.ts:411-415`) — match the
  neighbours, but always expose the seam
- The same seam is now applied to the environment: `env: PayoutEnvironment =
  process.env` on every payout-config reader
  (`src/lib/post-class-feedback/payout-config.ts:37-51`)
- Optional params expressed with `?` or a default value (`attempt = 0`,
  `locale = "en-GB"` in `src/lib/bangkok-time.ts`, `liveSweep = "always"`,
  `options: { allowSessionAuth: boolean }`)
- Route handlers with dynamic segments take Next 16's promised params:
  `ctx: { params: Promise<{ caseId: string }> }`, awaited inside the guard block
  (`src/app/api/admissions/cases/[caseId]/notes/route.ts:37-45`)

### Return Values

- Return typed objects, not raw primitives, for any non-trivial operation
- Pipeline / normalization functions return `{ result, issues }`-shaped objects
  so problems surface without throwing: `deriveModality() → { modality, issue }`,
  `normalizeTeacherTags() → { qualifications, issues }`,
  `resolveIdentities() → { groups, issues }`,
  `executeSearch() → { slotId, available, needsReview }`
  (`src/lib/search/engine.ts:149`)
- Fail-soft readers return a discriminated `ok` flag rather than throwing —
  `{ ok: false, sessions: [] }` from the live Wise overlay
  (`src/lib/student-schedule/live.ts:11-14`)
- Guard helpers return `T | null` to signal continue-vs-stop
  (`rejectInvalidCronSecret(): NextResponse | null`,
  `src/lib/internal/cron-auth.ts:19`)
- **`require*` guards throw instead of returning** — they are used at the top of
  a `try` whose catch is the domain error mapper. Do not convert them to
  nullable returns
- **`assert*` guards throw and return `void`** — they exist to make an invariant
  violation impossible to ignore in a finance/payout write path
- Nullable returns use `| null`, not `undefined`, in domain return types
  (`resolveUserAccess(): Promise<UserAccess | null>`,
  `getSearchIndex(): SearchIndex | null`,
  `payoutEnvironmentTarget(): PayoutEnvironmentTarget | null`)
- Async functions return `Promise<T>` directly; no callback style

### Function Length

- Most domain functions ≤ 40 lines
- Larger orchestrators (`runFullSync`, `buildCompareTutor`, the payout writers)
  factor sub-steps into named helpers in the same file rather than growing
  inline branches

## Module Design

### Exports

- **Named exports** everywhere except page components and route handlers —
  there are **zero** `export default` statements in `src/lib` or
  `src/components`
- Page components: `export default async function …` /
  `export default function StudentSchedulePage()`
  (`src/app/(app)/student-schedule/page.tsx`)
- Route handlers use named `GET`/`POST`/`PATCH`/`PUT`/`DELETE` exports per the
  App Router contract. Across 180 `route.ts` files there are **241** `export
  async function` method handlers (**99** GET, **95** POST, **34** PATCH, **12**
  DELETE, **1** PUT) plus the Auth.js catch-all's
  `export const { GET, POST } = handlers`
  (`src/app/api/auth/[...nextauth]/route.ts:3`) — **243 endpoints total**. Two
  CORS-preflight `OPTIONS` handlers on the public OA-resolver routes are
  excluded from that count; they carry no business surface. **Zero** non-async
  and zero `export const GET = …` handlers otherwise
- No route-segment config (`dynamic` / `revalidate` / `runtime` /
  `preferredRegion` / `fetchCache`) is exported anywhere; the only per-route knob
  is `export const maxDuration`, on **43** routes — **30** at 800 s
  (Wise/sales/promotions/payout/backfill work), **12** at 300 s (lighter cron and
  class-assignment jobs), and **1** at 60 s (`src/app/api/line/webhook/route.ts`)
- Types co-exported with implementations or re-exported from a sibling `types.ts`

### Singletons

Three patterns, all `globalThis`-anchored so they survive Next.js HMR in dev:

1. **Plain lazy singleton** — the DB handle:
   ```typescript
   declare global {
     // eslint-disable-next-line no-var
     var __bgscheduler_db: DbInstance | undefined;
   }

   export function getDb(): DbInstance {
     if (!globalThis.__bgscheduler_db) {
       globalThis.__bgscheduler_db = createDb();
     }
     return globalThis.__bgscheduler_db;
   }
   ```
   (`src/lib/db/index.ts:16-27`; `export type Database = ReturnType<typeof getDb>`
   at `:29` is what every `db: Database = getDb()` parameter refers to)

2. **Ensure-pattern with staleness check + in-flight dedupe** — the search index
   adds a build-promise singleton (`__bgscheduler_searchIndexBuildPromise`) so
   concurrent requests share one rebuild, and it rebuilds when either the active
   snapshot id **or** the tutor-profile version changes
   (`src/lib/search/index.ts:92-135`, `ensureIndex` at `:354`). Access is always
   through the four private accessors (`getCurrentIndex` / `setCurrentIndex` /
   `getBuildingPromise` / `setBuildingPromise`), never the global directly

3. **TTL'd bounded cache** — the live Wise month overlay keeps a
   `Map<string, LiveMonthCacheEntry>` with a 60 s TTL, paired with an explicit
   `pruneExpired()` past `CACHE_MAX_ENTRIES = 500`, because a TTL alone stops a
   stale entry being *served* but never frees it on a long-lived Fluid Compute
   instance (`src/lib/student-schedule/live.ts:28-59`). Copy this whenever you
   add a process-global cache

Transactions are the one place the Neon HTTP driver is bypassed: `neon-http`
has no transaction support, so post-class payout writes, payroll sync, and the
admissions audit log first *try* `db.transaction(...)`, detect the
`No transactions support in neon-http driver` message, and fall back to a `pg`
`Pool` (`max: 1`) with the `drizzle-orm/node-postgres` adapter
(`src/lib/post-class-feedback/transaction.ts:11-49`, `src/lib/payroll/sync.ts`,
`src/lib/admissions/audit.ts` — the last one imports the adapter lazily so the
serverless bundle stays lean).

### Server-only Helpers Behind Routes

Route logic lives in plain `src/lib/{domain}/*.ts` modules so it is unit-testable
in the Vitest `node` environment without the Next/next-auth route graph.
A domain's public surface is conventionally:

- `access.ts` / `api.ts` — `require*` guards + the `{domain}ErrorResponse` mapper
- `access-policy.ts` — the pure, importable-from-edge predicate + route constant
  (`hasCompetitorIntelligenceAccess`, `LEARNING_PLANS_ROUTE`)
- `data.ts` — uncached reads, all taking `db: Database = getDb()`
- `service.ts` — the cached façade: `"use cache"` + `cacheTag(TAG)` +
  `cacheLife({ stale, revalidate, expire })`
  (`src/lib/credit-control/service.ts:33-35`), invalidated from the write path
  with `revalidateTag(TAG, { expire: 0 })` (`src/lib/credit-control/actions.ts:79`,
  `src/lib/credit-control/sync.ts:752`, `src/lib/progress-tests/booking.ts`)
- `sync.ts` + `run-sync-request.ts` — ingest plus the single-flight wrapper
- `config.ts` — the injectable-environment reader (`payout-config.ts` is the
  reference implementation)

**Nine** modules currently carry `"use cache"`:
`src/lib/data/{filters,tutors,past-sessions}.ts`,
`src/lib/{credit-control,progress-tests}/service.ts`,
`src/lib/{sales-dashboard,us-universities}/data.ts`, and the two admissions
pages (`src/app/(app)/admissions/page.tsx`,
`src/app/(app)/admissions/[caseId]/page.tsx`). The snapshot-scoped read helpers
use the string tag `"snapshot"` with `cacheLife("hours")`
(`src/lib/data/filters.ts:53-55`, `src/lib/data/tutors.ts:81-83`); newer domains
use an exported `{DOMAIN}_CACHE_TAG` constant and an explicit `cacheLife` object.

**20** modules import `"server-only"` as their first line to make a
server-boundary violation a build error rather than a leak.

There are **no Server Actions** — a repo-wide search for `"use server"` returns
nothing. All mutations go through API routes.

## Component Patterns

### Where Components Live

- shadcn/ui primitives: `src/components/ui/` (**16** files) wrapping
  `@base-ui/react`; only 4 of them declare `cva()` variants (`badge`, `button`,
  `input-group`, `tabs`)
- Feature components: `src/components/{feature}/` — **25** feature directories
  alongside `ui/` (`admissions/`, `class-assignments/`, `compare/`,
  `competitor-intelligence/`, `credit-control/`, `data-health/`, `home/`,
  `layout/`, `learning-plan/`, `leave-requests/`, `line-review/`, `payroll/`,
  `post-class-feedback/`, `progress-tests/`, `room-capacity/`,
  `sales-dashboard/`, `scheduler/`, `search/`, `skeletons/`,
  `student-promotions/`, `student-report/`, `student-schedule/`,
  `tutor-profiles/`, `us-universities/`, `wise-activity/`)
- Large features nest a sub-directory per audience rather than flattening —
  `src/components/admissions/{parent,student}/`
- File-name suffixes carry meaning and are consistent enough to navigate by:
  `-panel.tsx` (13), `-workspace.tsx` (12), `-tab.tsx` (10), `-view.tsx` (6),
  `-shell.tsx` (6), `-dialog.tsx` (6), `-skeleton.tsx` (5), `-dashboard.tsx` (5)

### "use client" Directive

- Required on every interactive component or component using browser APIs /
  hooks — **150** files carry it: 137 under `src/components`, 9 under `src/lib`
  (`src/lib/calendar/month-grid.ts` plus the eight `src/lib/admissions/shared/*.ts`
  modules shared with client shells), 2 under `src/hooks`, and 2 under `src/app`
  (`(app)/compare/page.tsx`, the legacy redirect, and `login/page.tsx`)
- Top of file, before imports: `"use client";`
- **Pages are Server Components.** The dominant shape is a thin `page.tsx` that
  wraps an `async` body component in `<Suspense>`, resolves auth/data there, and
  hands props to a client workspace:
  ```typescript
  async function StudentScheduleBody() {
    const session = await auth();
    if (!session?.user?.email) redirect("/login");
    return <StudentScheduleWorkspace />;
  }

  export default function StudentSchedulePage() {
    return (
      <Suspense fallback={null}>
        <StudentScheduleBody />
      </Suspense>
    );
  }
  ```
  (`src/app/(app)/student-schedule/page.tsx`)
- **This is required, not stylistic.** With `cacheComponents: true`, an uncached
  `auth()` outside a `<Suspense>` boundary would block the whole route group.
  `src/app/(app)/layout.tsx` isolates it in `AppNavWithAccess` for exactly that
  reason, with `AppNavSkeleton` as the fallback because the skeleton omits the
  `usePathname()` call that would break prerendering of dynamic-param routes
  (see the comment at `src/app/(app)/layout.tsx:8-12`)
- Data the shell needs beyond the session is fetched with `Promise.all` in the
  async body, never sequentially (`src/app/(app)/layout.tsx:15-20`)

### Variant Components (shadcn / CVA)

- Variants declared with `class-variance-authority`'s `cva()`
- `cn()` from `src/lib/utils.ts` merges variants with the caller's `className`:
  ```typescript
  export function cn(...inputs: ClassValue[]) {
    return twMerge(clsx(inputs))
  }
  ```
- Both component and variants exported: `export { Button, buttonVariants }`
- shadcn/ui files **omit semicolons** — leave them as is

### Hooks & State

- React `useState` / `useCallback` / `useRef` / `useEffect` only; no Redux,
  Zustand, or Jotai
- Shared hooks live in `src/hooks/` as `use-*.ts` (5 files: `use-compare.ts`,
  `use-keyboard-shortcuts.ts`, `use-resizable-split.ts`,
  `use-sales-dimensions.ts`, `use-theme.ts`)
- The compare tutor cache is a client-side
  `Map<"tutorGroupId:weekStart:CACHE_VERSION", CompareTutor>` in a `useRef`,
  with incremental fetch and `AbortController` for race safety
  (`src/hooks/use-compare.ts`). **Bump `CACHE_VERSION`
  (`src/lib/search/cache-version.ts`) whenever a client-cached server shape
  changes** — the module's JSDoc carries the v1→v3 migration history and states
  the rule explicitly
- `localStorage` is used for small, non-authoritative UI preferences only, always
  behind a namespaced key and a `try`/`catch` for quota. **11** modules use it,
  including `src/components/credit-control/dashboard-shell.tsx`,
  `src/components/search/recent-searches.tsx`,
  `src/components/student-schedule/schedule-view-preference.ts`,
  `src/components/admissions/parent/parent-dashboard.tsx`, and
  `src/hooks/use-theme.ts` / `use-resizable-split.ts`
- Intentional non-reactive effects or mount-time `setState` carry a targeted
  `// eslint-disable-next-line react-hooks/… -- <reason>` rather than a
  project-wide suppression

### Constants in Components

Defined at module scope above the component
(`src/components/compare/week-overview.tsx`):

```typescript
const HOUR_HEIGHT = 48;
const START_HOUR = 7;
const END_HOUR = 21;
const TOTAL_HOURS = END_HOUR - START_HOUR;
const DISPLAY_DAYS = [1, 2, 3, 4, 5, 6, 0]; // Mon-Sun
const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
```

### Helpers

Pure helpers (no hooks, no JSX) sit in the same file above the component
(`minuteToY`, `minuteToLabel`, `formatClassType`). Shared visual helpers get
their own module — `src/components/compare/session-colors.ts` exports `rgba()`,
`sessionBgColor()` (`:26`, 0.28 alpha fill), `sessionFrameColor()` (`:34`, 0.35),
`sessionTextColor()`, `sessionBorderStyle()` (solid 3px left border), and
`TUTOR_COLORS` (`:51`). Non-visual formatting helpers live in `src/lib` —
`src/lib/bangkok-time.ts` wraps every Bangkok-localized `Intl.DateTimeFormat`
call (`BANGKOK_TIME_ZONE`, `hour12: false`, `locale = "en-GB"`), and
`src/lib/calendar/month-grid.ts` owns month windows. Cross-cutting design tokens
live in `src/lib/ui/` (`z-index.ts`, `view-transitions.ts`) and
`src/lib/scheduler/admin-colors.ts`.

### Styling

- Tailwind CSS 4 utility classes inline on JSX. shadcn style `base-nova`, base
  color `neutral`, CSS variables enabled, icon library `lucide`
  (`components.json`); **no `tailwind.config` file** — the theme is
  `@theme inline` in `src/app/globals.css:11-58`
- **72 OKLCH color declarations** define the palette; sky-blue primary
  (`--primary: oklch(0.55 0.14 230)` at `globals.css:68`, with the dark override
  `oklch(0.65 0.14 230)` at `:108`), amber accent and cream backgrounds, all
  behind `@custom-variant dark (&:is(.dark *))`
- Semantic tokens exposed as Tailwind colors: `--available`, `--blocked`,
  `--conflict`, `--free-slot`, `--today-indicator`, plus `--chart-1..5`
- Radii derive from one `--radius` via `calc()` (`--radius-sm` … `--radius-4xl`)
- Fonts wired through CSS vars: `--font-inter` (sans + heading),
  `--font-jetbrains-mono` (mono)
- Tutor lane colors centralized:
  `TUTOR_COLORS = ["#3b82f6", "#e67e22", "#7c3aed"]` (sky blue, amber, purple)
- **Hand-written CSS is allowed only for print and for legacy dense tables**, in
  a feature file imported by `globals.css` — there are four
  (`credit-control.css`, `learning-plans.css`, `student-schedule.css`,
  `student-report.css`). `student-schedule.css` is the model: it declares a
  **named** `@page schedule-landscape` precisely because `learning-plans.css`
  already declares a global portrait `@page`, and both land in the same document
  (`src/app/student-schedule.css:1-20`). Any new print surface must use a named
  page for the same reason
- Conditional classes via `cn()`:
  `className={cn("base-class", isActive && "text-primary", className)}`
- Z-index goes through the documented three-tier scale — prefer
  `style={{ zIndex: Z_INDEX.legend }}`; a Tailwind `z-[6]` is acceptable only
  with a same-line comment naming the slot (`src/lib/ui/z-index.ts`)

---

_Verified against main@0cd1e81 (clean tree) on 2026-09-02._
