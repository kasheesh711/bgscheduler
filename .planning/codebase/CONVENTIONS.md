# Coding Conventions

**Analysis Date:** 2026-05-31

These conventions are verified against current code (HEAD `9f72002` + uncommitted
WIP). BGScheduler is no longer a tutor-search tool with side features: it is a
multi-domain admin platform of **188 Postgres tables, 241 HTTP endpoints, 15
Vercel crons, 25 authenticated pages and 369 Vitest files**, spread across **35
`src/lib/*` directories** — 34 domains plus a shared `__tests__` — (`__tests__`,
`admissions`, `ai`, `auth`, `calendar`, `classrooms`, `competitor-intelligence`,
`credit-control`, `data`, `data-health`, `db`, `home`, `internal`,
`learning-plans`, `leave-requests`, `line`, `navigation`, `normalization`, `ops`,
`payroll`, `post-class-feedback`, `progress-tests`, `proposals`, `room-capacity`,
`sales-dashboard`, `scheduler`, `search`, `student-promotions`,
`student-schedule`, `syllabus`, `sync`, `ui`, `us-universities`, `wise`,
`wise-activity`) plus 9 loose top-level modules (`auth.ts`, `auth-access.ts`,
`auth-edge.ts`, `bangkok-time.ts`, `env.ts`, `tutor-business-profiles.ts`,
`tutor-profile-import.ts`, `tutor-profile-vocabulary.ts`, `utils.ts`).

The conventions below hold across **all** of those domains. Where the newest
modules (admissions, post-class-feedback, progress-tests, student-schedule,
competitor-intelligence) have refined an older pattern — per-domain error
responses, typed domain error classes, `db: Database = getDb()` injection,
role-aware `require*` session guards, file-header threat-model blocks — the newer
form is called out as the one to copy.

## Naming Patterns

### Files

- **kebab-case** for every source file, without exception:
  `cron-auth.ts`, `auth-access.ts`, `payout-window-health.ts`,
  `schedule-bot-group.ts`, `month-grid.ts`, `case-detail-shell.tsx`,
  `post-class-feedback-workspace.tsx`, `student-schedule-workspace.tsx`
- React components use `.tsx`; pure logic / type-only modules use `.ts`
  (`src/lib/student-schedule/types.ts`, `src/lib/admissions/types.ts`)
- Singular `schema.ts` for the Drizzle schema (`src/lib/db/schema.ts`)
- Per-domain `types.ts` is near-universal — `src/lib/search/types.ts`,
  `src/lib/admissions/types.ts`, `src/lib/post-class-feedback/types.ts`,
  `src/lib/us-universities/types.ts`, `src/lib/student-schedule/types.ts`,
  `src/lib/progress-tests/types.ts`, `src/lib/syllabus/types.ts`
- Recurring per-domain module names, reused verbatim across features so a new
  domain is navigable on sight: `access.ts` / `access-policy.ts` (authz),
  `api.ts` (route-facing guards + error mapper), `data.ts` (reads),
  `service.ts` (cached read façade), `sync.ts` + `run-sync-request.ts`
  (ingest + single-flight wrapper), `errors.ts`, `config.ts`, `types.ts`
- Test files: `{module}.test.ts(x)` inside a sibling `__tests__/` directory —
  **never** colocated. All **369** test files obey this; a search for
  `*.test.ts*` outside a `__tests__/` dir returns **zero** results
- Integration tests use `.integration.test.ts` (**12** files: 9 under
  `src/lib/post-class-feedback/__tests__/`, 3 under `src/lib/sync/__tests__/`);
  the shared Testcontainers helper is `src/tests/integration/db-helper.ts`
- Page components at `src/app/.../page.tsx` (29 files); route handlers at
  `src/app/api/.../route.ts` (**178** files, all under `src/app/api/` — there is
  no `route.ts` outside the API tree). Dynamic segments use bracket dirs
  (`src/app/api/admissions/cases/[caseId]/notes/route.ts`)
- Route groups carry cross-cutting shells: `(app)` (authenticated, **25**
  pages), `(print)` (2 print-only report pages), plus ungrouped `/login` and the
  public `src/app/schedule/[token]/page.tsx`
- Feature-scoped print/legacy CSS lives beside `globals.css` as
  `src/app/{feature}.css` and is pulled in via `@import` at
  `src/app/globals.css:4-6` (`credit-control.css`, `learning-plans.css`,
  `student-schedule.css`)
- Ambient/type-augmentation files live in `src/types/`
  (`next-auth.d.ts`, `credit-control.ts`, `post-class-feedback.ts`)

### Functions

- **camelCase** for all functions, verb-prefixed by intent. Measured across
  `export (async )?function` in `src/lib`, the dominant prefixes are `get` (131),
  `build` (103), `is` (57), `list` (48), `normalize` (41), `update` (36),
  `parse` (36), `create` (34), `format` (33), `fetch` (33), `run` (32),
  `resolve` (30), `load` (23), `compute` (18), `assert` (18), `find` (14),
  `require` (13):
  - `get*` — retrieval / accessors: `getDb()` (`src/lib/db/index.ts:22`),
    `getSearchIndex()` / `getActiveSnapshotId()` (`src/lib/search/index.ts:116-120`),
    `getCronSecretStatus()`, `getStudentMonthlySchedule()`,
    `getPostClassCapabilities()`, `getLearningPlansAccess()`, `getHomeSummaryPayload()`
  - `list*` — collection reads shaped for a caller/role: `listNotesForRole()`,
    `listOwnBrandSources()`, `listSalesDashboardSources()`
  - `is*` / `has*` / `should*` — booleans: `isBlockingStatus()`
    (`src/lib/normalization/sessions.ts:47`), `isMonthKey()`,
    `isUniqueViolation()`, `hasPageAccess()` (`src/lib/progress-tests/api.ts:14`)
  - `create*` / `make*` — factories: `createWiseClient()`
    (`src/lib/wise/client.ts:159`), `createDb()`, `createNote()`
  - `parse*` / `normalize*` — transformation: `normalizeSessions()`,
    `normalizeLeaves()`, `normalizeWorkingHours()`, `normalizeTeacherTags()`
  - `fetch*` — outbound I/O: `fetchAllTeachers()`, `fetchAllFutureSessions()`,
    `fetchPastSessionBlocks()`
  - `derive*` / `resolve*` / `extract*` — inference: `deriveModality()`,
    `resolveIdentities()`, `resolveUserAccess()` (`src/lib/auth-access.ts:56`),
    `resolveAdmissionsRole()`, `resolveTeacherCanonicalKeys()`, `extractNickname()`
  - `build*` / `compute*` — derived structures: `buildIndex()`
    (`src/lib/search/index.ts:140`), `buildCompareTutor()`,
    `buildStudentSchedulePayload()`, `buildFilterOptions()`
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
    Use these, not ad-hoc `auth()` checks, in any domain that already has one
  - **`assert*`** — invariant guards that throw on violation, **18** exported and
    concentrated in the payout/finance write paths: `assertPayoutRunPublishable`,
    `assertPayoutWindowOpenForDeduction`, `assertPostClassApprovalPeriodInvariant`,
    `assertPostClassFinanceIdempotentPayloadMatches`, `assertIsoDate`,
    `assertPayrollMonth`, `assertUtilizationDate`, …
  - `reject*` — guards that return an error response **or** `null` to continue:
    `rejectInvalidCronSecret()` (`src/lib/internal/cron-auth.ts:19`)
- Internal/private helpers are lowercased with no special marker
  (`baseUrl`, `failStaleRunningSyncs`, `getWritePool`, `isUniqueViolation`)

### Variables

- **camelCase** for locals and properties: `snapshotMeta`, `tutorGroupIds`,
  `teacherCanonicalKeys`, `allowedPages`, `unresolvedRatio`, `reviewReasons`
- Module-level mutable singletons are **not** `_`-prefixed. The codebase uses a
  `globalThis` namespace (`globalThis.__bgscheduler_db`,
  `globalThis.__bgscheduler_searchIndex`,
  `globalThis.__bgscheduler_searchIndexBuildPromise`) to survive Next.js HMR
  (`src/lib/db/index.ts:16-27`, `src/lib/search/index.ts:94-113`). These two
  files are the **only** places `declare global` appears in non-test `src/`
  (a third `declare module` augmentation lives in `src/types/next-auth.d.ts`),
  and this is the **only** module-singleton mechanism — no `let _db` /
  `let _cachedIndex` style exists anywhere in `src/`. The two lazily-created
  `pg` write pools are the sole module-scoped `let` exceptions, and they are
  local to their transaction modules (`src/lib/post-class-feedback/transaction.ts:9`,
  `src/lib/payroll/sync.ts`)

### Constants

- **UPPER_SNAKE_CASE** for module-level constants: `TUTOR_COLORS`,
  `CACHE_VERSION`, `CRON_JOBS`, `Z_INDEX`, `TIMEZONE`, `BANGKOK_TIME_ZONE`,
  `TEACHER_TBC`, `TOKEN_BYTES`, `TOKEN_PATTERN`, `DEFAULT_LINK_TTL_DAYS`,
  `CANCELLED_PATTERN`, `HOUR_HEIGHT`, `START_HOUR`, `DISPLAY_DAYS`,
  `STALE_RUNNING_CREDIT_CONTROL_SYNC_MS`, `ADMISSIONS_ROUTE`
- Route-prefix constants back the whole page-access system — a domain declares
  its own prefix once and both the guard and the nav read it:
  `ADMISSIONS_ROUTE` (`src/lib/admissions/config.ts:11`),
  `LEARNING_PLANS_ROUTE` (`src/lib/learning-plans/access-policy.ts:1`),
  `COMPETITOR_INTELLIGENCE_ROUTE` (`src/lib/competitor-intelligence/access-policy.ts:1`),
  `POST_CLASS_FEEDBACK_ROUTE` (`src/lib/post-class-feedback/access.ts:9`),
  `PROGRESS_TESTS_ROUTE` (module-private in both `src/lib/progress-tests/api.ts:6`
  and `src/lib/auth-access.ts:29`)
- Cross-cutting versioned constants get a dedicated module with the migration
  history in the JSDoc — `src/lib/search/cache-version.ts`
  (`CACHE_VERSION = "v3"`, with the v1→v3 history and an explicit "MUST bump"
  rule) and `src/lib/ui/z-index.ts` (three-tier `content: 1` / `legend: 6` /
  `popover: 50` scale, `as const`)

### Types

- **PascalCase** for interfaces and type aliases
- `interface` for object shapes; `type` for unions, primitives, or aliases:
  - `interface SearchRequest`, `interface IndexedTutorGroup`,
    `interface CronJobDefinition` (`src/lib/data-health/cron-registry.ts:26`),
    `interface UserAccess` (`src/lib/auth-access.ts:33`)
  - `type SearchMode = "recurring" | "one_time"` (`src/lib/search/types.ts`),
    `type UserRole = "admin" | "teacher" | "counselor" | "student" | "parent"`
    (`src/lib/auth-access.ts:31`),
    `type CronSecretStatus = "valid" | "invalid" | "missing-secret"`
    (`src/lib/internal/cron-auth.ts:4`),
    `type CronJobKey = "wise_snapshot" | …` (21 members,
    `src/lib/data-health/cron-registry.ts:3-24`)
- Domain-prefixed names — the leading token names the owning subsystem. Top
  prefixes by exported-type count in `src/lib`: `Admissions*` (76), `Wise*` (65),
  `Line*` (65), `Payout*` (34), `Scheduler*` (33), `Post*` (32), `Progress*`
  (29), `Sales*` (27), `Room*` (24), `Tutor*` (23), `Student*` (23):
  - `Wise*` for external Wise API shapes: `WiseTeacher`, `WiseSession`, `WiseLeave`
  - `Indexed*` for in-memory index types: `IndexedTutorGroup`,
    `IndexedSessionBlock`, `IndexedAvailabilityWindow`, `IndexedDataIssue`
  - `Normalized*` for normalization-pipeline outputs: `NormalizedSessionBlock`,
    `NormalizedQualification`, `NormalizedPayrollSession`
  - `Compare*` for compare-engine outputs: `CompareTutor`, `CompareSessionBlock`
  - `Parsed*` for parser outputs (sales pipeline): `ParsedNormalSaleRow`
- Two suffix conventions, both load-bearing at the serialization boundary:
  - **`*Dto`** (43 exports) for shapes crossing a Server→Client or API boundary,
    with ISO-8601 strings for timestamps and `"YYYY-MM-DD"` for date-only
    columns: `AdmissionsNoteDto`, `AdmissionsCollegeListRowDto`. The contract is
    documented at the top of `src/lib/admissions/types.ts`
  - **`*Input`** (95 exports) for write-path argument objects: `FollowUpStateInput`,
    `SourceInputSchema`-shaped payloads
- TypeScript `enum` is **never** used — a repo-wide search returns **zero**
  declarations. Database enums use Drizzle's `pgEnum` (**61** declarations in
  `src/lib/db/schema.ts`), which doubles as the TS union source.

### Database (Drizzle / Postgres)

- **snake_case** for table and column SQL names: `admissions_case_members`,
  `student_schedule_links`, `cron_invocations`, `snapshot_id`,
  `group_canonical_key`, `is_online_variant`
- **camelCase** for the Drizzle schema object names — every table is
  `export const {camelCase} = pgTable("{snake_case}", …)`
  (`syncRuns` → `sync_runs`, `cronInvocations` → `cron_invocations`,
  `googleOAuthTokens` → `google_oauth_tokens`)
- **188 tables** declared with `pgTable(...)` in `src/lib/db/schema.ts`, plus
  **61** `pgEnum` declarations (`pgEnum("sync_status", …)` → `syncStatusEnum`).
  **65** SQL migrations under `drizzle/`, generated by `drizzle-kit` from
  `drizzle.config.ts` (`schema: ./src/lib/db/schema.ts`, `out: ./drizzle`,
  dialect `postgresql`)
- **458 index declarations**, of which **124** are `uniqueIndex(...)`. Two naming
  eras coexist — match the neighbours of the table you are editing:
  - A handful of the oldest core/snapshot tables use a short abbreviation
    prefix — only **13** such names survive: `tig_snapshot_idx`,
    `fsb_group_idx` / `fsb_snapshot_idx` / `fsb_weekday_idx`,
    `di_snapshot_idx` / `di_type_idx`, `cae_batch_idx` / `cae_date_idx` /
    `cae_run_idx` / `cae_type_idx`, `psb_group_key_start_idx` /
    `psb_start_time_idx` / `psb_wise_session_id_idx`
  - Everything else uses the **full table name** plus the indexed columns:
    `sync_runs_status_started_idx`, `cron_invocations_job_received_idx`,
    `wise_activity_events_type_timestamp_idx`, `admissions_cases_live_student_idx`.
    Use this form for new tables — it is self-documenting and collision-free
- `uniqueIndex` is not only a constraint but the **concurrency primitive**: sync
  and digest jobs rely on a unique partial index (e.g.
  `sync_runs_single_running_idx`) to enforce single-flight and catch the `23505`
  unique violation rather than taking a lock (see *Sync Orchestrator Errors*)

## Code Style

### Formatting

- **No formatter config** is checked in (no `.prettierrc`, no `.editorconfig`)
- **2-space indentation** throughout
- **Double quotes** for strings everywhere. Measured across `src/lib`, `src/app`,
  `src/components`: **5,050** double-quoted `from "…"` specifiers and **0**
  single-quoted ones
- **Semicolons required** in `src/lib/**`, `src/app/**`, and all feature
  components
- **Semicolons omitted** in the 15 shadcn/ui primitives (`src/components/ui/*.tsx`
  — every one of them has zero semicolon-terminated lines) and in
  `src/lib/utils.ts`. These are regenerated by the shadcn CLI; leave them alone
- Trailing commas on multi-line object/array literals
- Template literals for interpolation
  (`` `Wise API ${response.status}: ${text} (${url})` ``, `src/lib/wise/client.ts:133`)
- **File-header block comments** are the strongest newer convention: **81 of 284**
  non-test `src/lib` modules open with a `//` comment block stating the module's
  purpose, source of truth, and the product/security rules it enforces before any
  import. `src/lib/student-schedule/links.ts:1-14` (capability-token threat
  model), `src/lib/student-schedule/data.ts:1-17` (source-of-truth + two
  fail-closed product rules) and `src/lib/auth-access.ts:1-19` (five-role
  resolution order) are the models to copy for anything non-obvious

### Linting

- **ESLint 9** flat config at `eslint.config.mjs`
- Extends `eslint-config-next/core-web-vitals` and `eslint-config-next/typescript`
  only — **no custom rules**
- Default ignores re-declared so `.next/`, `out/`, `build/`, `next-env.d.ts`
  stay ignored (`eslint.config.mjs:9-15`)
- Runs via `npm run lint` (bare `eslint`); type-checking is separate
  (`npm run typecheck` → `tsc --noEmit`)
- Inline `eslint-disable` is rare — **25 sites** in non-test source, confined to
  four rules:
  - `react-hooks/exhaustive-deps` (14: 11 `-next-line`, 3 trailing
    `eslint-disable-line`) — intentionally non-reactive effects; newer sites
    append a `-- <reason>` clause
  - `react-hooks/set-state-in-effect` (8) — one-shot mount handoffs, e.g.
    `-- one-shot post-hydration localStorage read (CM-131)`
  - `@typescript-eslint/no-unused-vars` (2) — destructure-to-drop a column
  - `no-var` (1) — the `globalThis` augmentation in `src/lib/db/index.ts:17`
- When adding a disable, append `-- <reason>` after the rule name. Do not
  silence a rule project-wide.

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
  a boot boundary (`this.queue.shift()!` at `src/lib/wise/client.ts:145`, guarded
  by the `queue.length > 0` loop condition; `process.env.WISE_USER_ID!` inside
  `createWiseClient()`, `src/lib/wise/client.ts:159-165`)
- Type predicates at filter boundaries remain a recurring pattern
  (`.filter((g): g is IndexedTutorGroup => g !== undefined)`)
- Narrowing on `unknown` errors is always structural, never a cast to `any`:
  ```typescript
  typeof err === "object" && err !== null && "code" in err &&
    (err as { code?: unknown }).code === "23505"
  ```
  (`src/lib/credit-control/run-sync-request.ts:41-48`). Newer copies also check
  `cause.code`, because Drizzle wraps the driver error
  (`src/lib/post-class-feedback/repository.ts:363-364`)

## Import Organization

### Order (observed pattern)

1. External packages (`next/server`, `next/cache`, `zod`, `react`,
   `drizzle-orm`, `date-fns-tz`, `@base-ui/react`, `lucide-react`,
   `node:crypto`, `pg`)
2. Internal `@/` aliases, roughly by depth: `@/lib/auth` → `@/lib/db` →
   domain libs → `@/components/ui/*` → `@/components/{feature}/*`
3. Relative imports (`./types`, `./config`, `./access`, `../identity`)
4. Type-only imports — either a dedicated `import type { … }` line (**232** in
   `src/lib`) or an inline `type` specifier inside a value import (**87**), e.g.
   `import { getDb, type Database } from "@/lib/db"`. Both are idiomatic; the
   inline form is preferred when the same module supplies both

Server-only modules put `import "server-only";` on the very first line, above
everything else (**17** modules: 15 in `post-class-feedback`, plus
`src/lib/learning-plans/access.ts` and `src/lib/syllabus/get-year-syllabus.ts`) —
see `src/lib/post-class-feedback/transaction.ts:1`.

Newer modules insert a **blank line between the external block and the `@/`
block**; older ones run them together. Match the file.

Example (`src/lib/student-schedule/data.ts:19-35`):

```typescript
import { and, asc, desc, eq, gte, lt } from "drizzle-orm";

import { getDb, type Database } from "@/lib/db";
import * as schema from "@/lib/db/schema";
import { BANGKOK_TIME_ZONE } from "@/lib/bangkok-time";
import { bangkokDateKey, bangkokDateStartUtc } from "@/lib/room-capacity/dates";
import {
  addMonths,
  formatMonthLabel,
  getMonthWindow,
  isMonthKey,
} from "@/lib/calendar/month-grid";
import {
  TEACHER_TBC,
  type StudentSchedulePayload,
  type StudentScheduleSession,
  type StudentScheduleStudent,
} from "@/lib/student-schedule/types";
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
  (`import * as schema from "@/lib/db/schema"` — **85** sites), React (10), and
  `XLSX` (1). Nothing else uses `import * as`
- Cross-domain imports go through the owning domain's public function, not its
  internals — e.g. `auth-access.ts` calls `resolveAdmissionsRole()` and
  `resolveTeacherCanonicalKeys()` rather than querying those tables itself
  (`src/lib/auth-access.ts:22-26`)
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

(`src/app/api/student-schedule/link/route.ts:22-70`)

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
(`src/app/api/admissions/cases/[caseId]/notes/route.ts:55-63`).

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
Vercel logs greppable. `competitorIntelligenceErrorResponse` is the odd one out
and logs the fallback message instead (`src/lib/competitor-intelligence/access.ts:49`).

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

(`src/lib/post-class-feedback/errors.ts` — the only dedicated `errors.ts` in the
repo; other domains declare their classes beside the code that throws them.)

**21** such classes exist, concentrated in the optimistic-concurrency and
single-flight paths: `PostClassValidationError`, `PostClassNotFoundError`,
`PostClassAccessError`, `PostClassPolicySnapshotConflictError`,
`PostClassFeedbackSyncAlreadyRunningError`, `PostClassFeedbackSyncSourceFenceError`,
`PostClassWiseSchemaError`, `PostClassSessionDataError`,
`DuplicatePayoutSignatureError`, `DuplicatePayoutAppendSignatureError`,
`ProposalConflictError`, `ProposalNotFoundError`, `ProposalValidationError`,
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
| `400` | 199 | invalid JSON body, Zod failure, domain validation error |
| `401` | 110 | no session, or invalid cron secret |
| `500` | 65 | caught business-logic exception (or cron `missing-secret`) |
| `404` | 36 | resource absent from the active snapshot / soft-deleted |
| `409` | 18 | optimistic-concurrency conflict, duplicate signature, job already running |
| `403` | 6 | authenticated but `allowedPages` / case role forbids it |
| `201` | 6 | resource created |
| `503` | 5 | upstream dependency unavailable |
| `502` | 2 | upstream returned an unusable response |
| `204` | 2 | accepted, no body |
| `202` | 1 | accepted, async work continues |
| `200` | 1 | explicit success literal (the default; usually omitted) |

`403` is the marker of the role system: non-admins never learn whether a case
exists, so a case they cannot see returns **Forbidden, not NotFound**
(`src/lib/admissions/access.ts:1-7`). The middleware issues the same 403 for an
API path outside a restricted user's `allowedPages` (`src/middleware.ts:80-82`).

### Error Message Extraction

The universal pattern in catch blocks remains
`const message = err instanceof Error ? err.message : "<Default message>"`,
with a route-specific default. The single deliberate exception is the
post-class feedback path, which returns only the caller-supplied `fallback`
because upstream error objects may embed private student/tutor feedback text
(`src/lib/post-class-feedback/api.ts:45-53`). Apply the same restraint to any
new surface handling parent-visible or payroll data.

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
  secret, `null` to continue). **15 of the 21** `src/app/api/internal/**` routes
  import it
- **6 routes still inline** an equivalent implementation:
  `sync-wise` (which also supports session-auth fallback for manual admin
  triggers), `sync-room-utilization`, `sync-competitor-intelligence`,
  `sync-sales-dashboard`, `sync-credit-control`, `student-promotions/july-1`.
  When touching one of these, migrate it to the shared helper rather than
  copying the block again
- Cron routes are exempt from the middleware auth gate — `/api/internal/` is on
  the public-route allowlist (`src/middleware.ts:18`), so the secret check
  inside the handler is the *only* thing protecting them. Never add a route
  under `/api/internal/` without one
- The **15** crons in `vercel.json` are mirrored by a typed `CRON_JOBS` registry
  (`src/lib/data-health/cron-registry.ts`) that carries **21** entries — the 15
  scheduled jobs plus **6** `manualOnly: true` / `schedule: null` jobs
  (post-class digest/reminders, room utilization, LINE backlog recovery) that are
  triggered from the Data Health UI instead. Each entry declares `path`,
  `schedule`, `cadenceMinutes`, `lateAfterMinutes`, `maxDurationSeconds`,
  `manualOnly`, `dangerous`, `confirmationLabel`, `routeMethod`. A derived
  `SCHEDULED_CRON_JOBS = CRON_JOBS.filter((job) => !job.manualOnly)`
  (`src/lib/data-health/cron-registry.ts:375`) is what
  `src/lib/data-health/__tests__/cron-registry.test.ts` diffs against
  `vercel.json`. Adding a scheduled cron means adding **both** entries; that test
  fails if they disagree

### Graceful Degradation for Optional Tables

Routes depending on optionally-migrated tables detect Postgres' "relation does
not exist" by message substring — checking `error.message` **and**
`error.cause.message`, because Drizzle wraps the driver error as
`Failed query: <sql>` — and return a typed "missing" payload with HTTP 200 so
the UI renders an empty state instead of an error
(`src/lib/internal/cron-watchdog.ts:266-290`,
`src/lib/tutor-business-profiles.ts:196-200`,
`src/lib/data-health/dashboard.ts:834`).

### Fail-Closed Defaults

Non-negotiable safety rule (AGENTS.md). Unresolved data routes the user away
from a confident answer; it is never silently dropped and never guessed:

- Unknown or absent session status → **blocking**
  (`src/lib/normalization/sessions.ts:47-52`, both branches commented `fail-closed`)
- Unresolved identity / modality / qualification → **"Needs Review"**, never
  "Available". `reviewReasons` accumulates and routes the tutor into the
  `needsReview` bucket rather than `available`
  (`src/lib/search/engine.ts:83-146`)
- Cancelled sessions are explicitly non-blocking, and a `CANCELLED`/`CANCELED`
  session is omitted from the parent-facing monthly schedule entirely
  (`src/lib/student-schedule/data.ts:11-13`)
- A session with no resolvable teacher renders the `TEACHER_TBC` placeholder —
  it is never dropped and the teacher is never inferred from the class or
  package name (`src/lib/student-schedule/data.ts:14-16`)
- Sign-in itself is fail-closed: an email matching none of admin / counselor /
  teacher / case-member resolves to `null` and is denied
  (`src/lib/auth-access.ts:14-16`, `src/lib/auth-access.ts:53-55`)
- Role escalation is refused rather than guessed: an unrecognized JWT role claim
  throws `"Forbidden"` instead of falling back to admin
  (`src/lib/progress-tests/api.ts:48-55`)
- Capability tokens for the public parent page fail closed and leak nothing:
  expired, revoked, unknown, and malformed all return `null`, so the page
  cannot be used as an existence oracle (`src/lib/student-schedule/links.ts:10-13`)
- The LINE schedule bot is fail-closed by construction — an unset or empty
  `LINE_SCHEDULE_BOT_ADMIN_IDS` disables it entirely (`src/lib/env.ts:16-19`)
- Wise write paths are gated behind explicit `WISE_SESSION_*_VERIFIED`
  environment flags (`WISE_SESSION_CREATE_VERIFIED`,
  `WISE_SESSION_OPERATIONS_VERIFIED`, `WISE_SESSION_SUBJECT_UPDATE_VERIFIED`)

### Wise Client Errors

`src/lib/wise/client.ts` wraps `fetch` with:

- Non-OK response → throws `Error` carrying status, response text, and URL
  (`src/lib/wise/client.ts:123-133`)
- A private static `RETRYABLE_STATUS_CODES` set (`408, 429, 500, 502, 503, 504`)
  so permanent 4xx fail fast instead of burning retries — the REL-05 hardening,
  with its sources cited in the comment (`src/lib/wise/client.ts:17-30`)
- Network-level failures (DNS / ECONNRESET / fetch `TypeError`) are retried on
  the same schedule (`src/lib/wise/client.ts:105-113`)
- Exponential backoff `Math.pow(2, attempt) * 1000` → 1 s, 2 s, 4 s
  (`src/lib/wise/client.ts:108`, `:129`)
- `maxRetries` default 3, `maxConcurrency` default 5
  (`src/lib/wise/client.ts:48-49`); `createWiseClient()` raises concurrency to
  **15** for the production sync (`src/lib/wise/client.ts:159-165`)

### Sync Orchestrator Errors

- **Fail-isolated inside the run**: a per-teacher/per-group fetch failure is
  caught and pushed as a `completeness` `data_issue` row carrying the teacher
  name and the extracted message; the sync continues
  (`src/lib/sync/orchestrator.ts:165`, `:252`, with the rationale at `:405`)
- **Promotion gate**: `unresolvedRatio = identityIssues.length /
  Math.max(groups.length, 1)`; promotion only happens when `unresolvedRatio < 0.5`
  (`src/lib/sync/orchestrator.ts:473-476`)
- **Fail-loud at the top**: a top-level throw marks `sync_runs.status = "failed"`
  and preserves the previous active snapshot — no promotion
  (`src/lib/sync/orchestrator.ts:568`, logged at `:529`, `:543`, `:581`)
- **Single-flight via unique index, not a lock.** Every long-running job races
  to insert its `running` row and treats a `23505` unique violation as "someone
  else already has it", converting it to a typed `*AlreadyRunningError` or a
  friendly "already running" result. Stale `running` rows are swept by a
  `failStaleRunningSyncs(db, now)` helper against a per-domain
  `STALE_RUNNING_*_MS` cutoff before the claim attempt
  (`src/lib/credit-control/run-sync-request.ts:9`, `:41-66`;
  `src/lib/progress-tests/run-sync-request.ts:39`;
  `src/lib/sales-dashboard/import-guard.ts:58`;
  `src/lib/sync/run-wise-sync.ts:42`;
  `src/lib/progress-tests/admin-digest.ts:242`, `:266`).
  The `isUniqueViolation` predicate is duplicated in **8** modules — reuse the
  nearest copy verbatim rather than inventing a variant. The newest copies
  (`src/lib/post-class-feedback/repository.ts:361`, `src/lib/payroll/sync.ts:56`,
  `src/lib/admissions/notifications.ts:231`) also inspect `cause.code` and are
  the ones to copy

## Validation

### Zod Pattern

Schemas are declared as module-scope `const` above the handler. Two casings
coexist — **camelCase dominates ~96 to ~42**: lowerCamel (`bodySchema`,
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

(`src/app/api/admissions/cases/[caseId]/notes/route.ts:22-32`)

Note the deliberate absence of a `.default()` on `visibility`, and that the
absence is *commented with its decision ID*. When a Zod field maps to a column,
mirror the column's nullability and defaults exactly, and say so in a comment.

### Coercion at the Boundary

`z.coerce.*` (**38** uses in non-test source) is the preferred way to parse query
params, sheet cells, and raw Wise payloads into typed values:

- `z.coerce.number().int().positive().optional()` for
  `STUDENT_SCHEDULE_LINK_TTL_DAYS` (`src/lib/env.ts:21`)
- `z.coerce.number().min(0).max(1)` for a confidence query param
- `z.coerce.boolean()` / `z.coerce.number()` / `z.coerce.date()` for the raw
  Wise credit-control envelope (`src/lib/credit-control/wise.ts`)

Prefer `z.coerce.*` over `.transform(Number)`.

### Rules

- **`.safeParse()` is the default** (**107** non-test call sites) — it returns a
  discriminated `success` boolean instead of throwing
- **`.parse()` is permitted only inside a `try` whose catch maps `ZodError` to
  400.** **31** non-test sites use it, in four groups:
  - post-class-feedback routes (11) — its helper maps `ZodError` → 400 explicitly
    (`src/lib/post-class-feedback/api.ts:35-37`) ✅
  - sales-dashboard routes (4) — a blanket `catch → 400`
    (`src/app/api/sales-dashboard/sources/route.ts:47-51`) ✅
  - competitor-intelligence routes (5) — **its helper has no `ZodError` branch**,
    so a malformed body currently surfaces as a **500**
    (`src/lib/competitor-intelligence/access.ts:42-53`). Do not copy this; add a
    `ZodError → 400` branch when you next touch that helper
  - internal (non-request) parses of trusted-but-external payloads — Wise
    envelopes (`src/lib/credit-control/wise.ts:156`, `:183`, `:202`, `:217`),
    OpenAI responses (`src/lib/ai/scheduler.ts:330`,
    `src/lib/ai/scheduler-conversation.ts:826`,
    `src/lib/line/classifier.ts:80`, `src/lib/competitor-intelligence/ai.ts:114`,
    `:286`), and a `.catch(...)`-guarded DB row read
    (`src/lib/tutor-business-profiles.ts:134-135`)
  Never use `.parse()` in a route whose catch returns 500
- On `.safeParse()` failure return Zod's `.error.flatten()` in a `details` field
- Prefer narrowing helpers (`.trim()`, `.min()`, `.max()`, `.regex()`, `.url()`,
  `.uuid()`, `z.coerce.*`) over manual checks
- Zod validates **external** data crossing into the system, not just request
  bodies — Wise API envelopes, OpenAI responses, and imported sheet rows all
  pass through a schema first

### Environment Variable Validation

`src/lib/env.ts` declares a **15-key** schema — 9 required (`DATABASE_URL`,
`AUTH_GOOGLE_ID`, `AUTH_GOOGLE_SECRET`, `AUTH_SECRET`, `WISE_USER_ID`,
`WISE_API_KEY`, `WISE_NAMESPACE`, `WISE_INSTITUTE_ID`, `CRON_SECRET`; the two
`WISE_*` naming keys carry `.default(...)`) plus 6 optional
(`LINE_CHANNEL_SECRET`, `LINE_CHANNEL_ACCESS_TOKEN`, `ENABLE_LINE_SCHEDULER`,
`LINE_SCHEDULE_BOT_ADMIN_IDS`, `STUDENT_SCHEDULE_LINK_TTL_DAYS`,
`APP_BASE_URL`). It `.safeParse()`s `process.env`, logs **only**
`.error.flatten().fieldErrors` (never values), and throws
`"Invalid environment variables"` (`src/lib/env.ts:28-37`).

**Important caveat, verified: nothing imports `@/lib/env`.** A search across
`src/` and `scripts/` returns zero importers, so the schema never actually runs
at boot. In practice **57 distinct environment variables** are read directly as
`process.env.X` inside `src/` (61 counting `scripts/`) with an inline default or
feature gate — including `OPENAI_*`, `RESEND_API_KEY`, `APIFY_*`, `DATAFORSEO_*`,
`LEAVE_REQUESTS_*`, `SCHEDULE_EMAIL_*`, `WISE_SESSION_*_VERIFIED`, and the
`COMPETITOR_*` cost caps. The convention that *is* live:

- Read a feature-scoped var at its point of use with an explicit fallback
  (`process.env.APP_BASE_URL?.trim() || request.nextUrl.origin`,
  `src/app/api/student-schedule/link/route.ts:18-20`), or a boolean feature gate
- Treat an unset var as **off**, never as a permissive default
- Never log an env value; never place one in a URL or error body

See *openQuestions* — the dead `env.ts` module is a real inconsistency, not a
convention to imitate.

## Logging

### Approach

- **No structured logger.** Bare `console.error` / `console.log` only, and
  **zero** `console.warn` anywhere in non-test source
- Non-test totals: **63 `console.error`** calls across **36 files**, **9
  `console.log`** calls across exactly **2 files**

### Patterns

- `console.error` for errors that must surface in Vercel logs or sit at a
  fire-and-forget boundary:
  - Env validation failure (`src/lib/env.ts:31`)
  - Sync orchestrator failures (`src/lib/sync/orchestrator.ts:529`, `:543`, `:581`)
  - The tail of every per-domain error-response helper, immediately before the
    500 — logged as `console.error(route, error)` so the route path is the first
    token in the log line (`src/lib/admissions/access.ts:282`,
    `src/lib/progress-tests/api.ts:92`)
  - Async `.catch(console.error)` for client fetches and caught component errors
- `console.log` appears in only two files:
  - `src/lib/db/seed.ts` (8 calls) — human-readable seed progress
  - `src/lib/line/schedule-bot-group.ts:367` — a single prefixed sink,
    `` console.log(`[schedule-bot] ${parts.join(" ")}`) ``. The same
    `[schedule-bot]` prefix is used for its `console.error` calls in
    `src/lib/line/schedule-bot.ts`. If you need operational tracing, copy that
    shape: one function, one bracketed prefix, no scattered calls
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
  comment in the codebase and the newest strong convention (81 of 284 non-test
  `src/lib` modules)
- **Public exported functions** get JSDoc with a purpose statement, and for
  multi-step algorithms an explicit numbered list of steps
- **Non-obvious arithmetic / business logic** gets inline `//` notes
  (`// 1s, 2s, 4s`, `// 0=Sun`, `// minutes since midnight, Asia/Bangkok`)
- **Design decisions are referenced by ID inline** and are **load-bearing** —
  they tie code to plan/research documents under `.planning/` and to
  `docs/casemanagementsystem_design.md`. Preserve them when editing nearby code.
  Live families, by citation count across `src/**` (tests included):

  | Family | Cites | Domain |
  |---|---|---|
  | `CM-*` | 637 | Case management / admissions (`CM-46`, `CM-91`, `CM-121`, `CM-131`) |
  | `D-*` | 72 | Phase decisions (`D-03`, `D-04`, `D-08`, `D-17`) |
  | `BOT-*` | 37 | LINE schedule bot |
  | `REC-*` | 27 | Recommendation / recurrence |
  | `REL-*` | 26 | Reliability hardening (`REL-05` retryable statuses, `REL-07` constant-time cron auth) |
  | `IDENT-*` | 23 | Identity resolution |
  | `MOD-*` | 19 | Modality derivation (`MOD-01`) |
  | `PAST-*` | 12 | Past-session capture (`PAST-01`) |
  | `TCOV-*` | 10 | Test coverage |
  | `INV/UAT/CAL/STICKY/VPOL/CONTRACT/…` | 1–10 each | Per-phase |

- Section references into design docs are cited the same way and are equally
  load-bearing: `design §2.1`,
  `docs/casemanagementsystem_design.md §2.1` (`src/lib/auth-access.ts:13`),
  `.planning/REQUIREMENTS.md §STICKY-02` (`src/lib/ui/z-index.ts`)

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
(`/** Route prefix this domain's pages and APIs live under. */`,
`src/lib/progress-tests/api.ts:5`; `/** Get or create the DB singleton (survives
HMR in dev). */`, `src/lib/db/index.ts:21`).

### Section Headers

Two patterns coexist — **use whichever the file already uses**. Neither is
domain-specific any more; both appear in `src/lib` and `src/components`:

- **Em-dash bars** — 172 occurrences in `src/lib`, 232 in `src/components`.
  Dominant in the search/admissions/LINE lineage:
  ```
  // ── Section Name ──────────────────────────────────────────────────
  ```
  (`src/lib/search/index.ts:92`, `src/lib/admissions/types.ts`,
  `src/components/admissions/case-detail-shell.tsx`)

- **Long-hyphen blocks** — 36 occurrences in `src/lib`, 159 in
  `src/components`. This is also the form used for file-header blocks and for
  the CSS-file headers:
  ```
  // ---------------------------------------------------------------------------
  // Section Name
  // ---------------------------------------------------------------------------
  ```
  (`src/lib/student-schedule/data.ts:1-17`, `src/lib/calendar/month-grid.ts`,
  `src/lib/line/schedule-bot.ts`, `src/app/student-schedule.css:1-8`)

### Inline Comment Style

- Reference plan/design IDs inline: `// REL-05: only these HTTP status codes are
  considered transient…` (`src/lib/wise/client.ts:17`), `// (CM-131)`,
  `// (CM-91)`
- Use `→` to note transformations: `// "Chinnakrit (Celeste) Channiti" → "Celeste"`
- Type-field documentation: `startMinute: number; // minutes since midnight,
  Asia/Bangkok` (`src/lib/normalization/availability.ts:6`)
- Magic numbers explained: `// 1s, 2s, 4s` (`src/lib/wise/client.ts:107`)
- Long-form deviation rationales live as multi-line `//` blocks directly above
  the code they justify — the `/schedule/` trailing-slash subtlety
  (`src/middleware.ts:11-15`), the "coarse-pass only, do not broaden" note on
  the learning-plans middleware exception (`src/middleware.ts:41-44`), the
  `cacheComponents` Suspense requirement (`src/app/(app)/layout.tsx:8-12`), and
  the load-bearing `JWT` re-export in `src/types/next-auth.d.ts:13-18`

### TODO Discipline

**Zero** `TODO` / `FIXME` / `HACK` markers exist in non-test source — verified
by a repo-wide grep. Treat them as code smells and resolve before merging.

## Function Design

### Signature Style

- Destructured object parameters for 3+ args or any config object
  (`new WiseClient({ userId, apiKey, namespace, maxConcurrency })`,
  `getStudentMonthlySchedule(db, { studentKey, monthKey })`)
- **Database handle as a defaulted trailing parameter** is the dominant DI
  convention — **223** non-test signatures end in `db: Database = getDb()`:
  ```typescript
  export async function resolveUserAccess(
    email: string | null | undefined,
    db: Database = getDb(),
  ): Promise<UserAccess | null>
  ```
  (`src/lib/auth-access.ts:56-59`). Production callers omit it; tests pass a
  hand-rolled chainable fake. Some older modules take the handle **first**
  (`getStudentMonthlySchedule(db, opts)`,
  `getHomeSummaryPayload(opts, getDb())`) — match the neighbours, but always
  expose the seam
- Optional params expressed with `?` or a default value (`attempt = 0`,
  `locale = "en-GB"` in `src/lib/bangkok-time.ts:14`,
  `options: { allowSessionAuth: boolean }`)
- Route handlers with dynamic segments take Next 16's promised params:
  `ctx: { params: Promise<{ caseId: string }> }`, awaited inside the guard block
  (`src/app/api/admissions/cases/[caseId]/notes/route.ts:36-45`)

### Return Values

- Return typed objects, not raw primitives, for any non-trivial operation
- Pipeline / normalization functions return `{ result, issues }`-shaped objects
  so problems surface without throwing: `deriveModality() → { modality, issue }`,
  `normalizeTeacherTags() → { qualifications, issues }`,
  `resolveIdentities() → { groups, issues }`,
  `executeSearch() → { slotId, available, needsReview }`
  (`src/lib/search/engine.ts:146`)
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
  `getSearchIndex(): SearchIndex | null`)
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
  (`src/app/(app)/student-schedule/page.tsx:13`)
- Route handlers use named `GET`/`POST`/`PATCH`/`PUT`/`DELETE` exports per the
  App Router contract. Across 178 `route.ts` files there are **239** `export
  async function` method handlers (**97** GET, **95** POST, **34** PATCH, **12**
  DELETE, **1** PUT) plus the Auth.js catch-all's
  `export const { GET, POST } = handlers`
  (`src/app/api/auth/[...nextauth]/route.ts:3`) — **241 endpoints total**.
  **Zero** non-async and zero `export const GET = …` handlers otherwise
- No route-segment config (`dynamic` / `revalidate` / `runtime` /
  `preferredRegion` / `fetchCache`) is exported anywhere; the only per-route knob
  is `export const maxDuration`, on **42** routes — **30** at 800 s
  (Wise/sales/promotions/payout/backfill work), **11** at 300 s (lighter cron and
  class-assignment jobs), and **1** at 60 s (`src/app/api/line/webhook/route.ts:8`)
- Types co-exported with implementations or re-exported from a sibling `types.ts`

### Singletons

Two patterns, both `globalThis`-anchored so they survive Next.js HMR in dev:

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
   (`src/lib/search/index.ts:92-135`). Access is always through the four
   private accessors (`getCurrentIndex` / `setCurrentIndex` /
   `getBuildingPromise` / `setBuildingPromise`), never the global directly

Transactions are the one place the Neon HTTP driver is bypassed: `neon-http`
has no transaction support, so post-class payout writes, payroll sync, and the
admissions audit log first *try* `db.transaction(...)`, detect the
`No transactions support in neon-http driver` message, and fall back to a `pg`
`Pool` (`max: 1`) with the `drizzle-orm/node-postgres` adapter
(`src/lib/post-class-feedback/transaction.ts:11-51`, `src/lib/payroll/sync.ts:96`,
`src/lib/admissions/audit.ts:99` — the last one imports the adapter lazily so the
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
  (`src/lib/credit-control/service.ts:32-33`), invalidated from the write path
  with `revalidateTag(TAG, { expire: 0 })` (`src/lib/credit-control/actions.ts:79`,
  `src/lib/progress-tests/booking.ts:252`)
- `sync.ts` + `run-sync-request.ts` — ingest plus the single-flight wrapper

**Nine** modules currently carry `"use cache"`:
`src/lib/data/{filters,tutors,past-sessions}.ts`,
`src/lib/{credit-control,progress-tests}/service.ts`,
`src/lib/{sales-dashboard,us-universities}/data.ts`, and the two admissions
pages (`src/app/(app)/admissions/page.tsx`,
`src/app/(app)/admissions/[caseId]/page.tsx`). The snapshot-scoped read helpers
use the string tag `"snapshot"` with `cacheLife("hours")`
(`src/lib/data/filters.ts:54-55`); newer domains use an exported
`{DOMAIN}_CACHE_TAG` constant and an explicit `cacheLife` object.

**17** modules import `"server-only"` as their first line to make a
server-boundary violation a build error rather than a leak.

There are **no Server Actions** — a repo-wide search for `"use server"` returns
nothing. All mutations go through API routes.

## Component Patterns

### Where Components Live

- shadcn/ui primitives: `src/components/ui/` (15 files) wrapping
  `@base-ui/react`; only 4 of them declare `cva()` variants (`badge`, `button`,
  `input-group`, `tabs`)
- Feature components: `src/components/{feature}/` — **24** feature directories
  (`admissions/`, `class-assignments/`, `compare/`, `competitor-intelligence/`,
  `credit-control/`, `data-health/`, `home/`, `layout/`, `learning-plan/`,
  `leave-requests/`, `line-review/`, `payroll/`, `post-class-feedback/`,
  `progress-tests/`, `room-capacity/`, `sales-dashboard/`, `scheduler/`,
  `search/`, `skeletons/`, `student-promotions/`, `student-schedule/`,
  `tutor-profiles/`, `us-universities/`, `wise-activity/`)
- Large features nest a sub-directory per audience rather than flattening —
  `src/components/admissions/{parent,student}/`
- File-name suffixes carry meaning and are consistent enough to navigate by:
  `-panel.tsx` (13), `-workspace.tsx` (11), `-tab.tsx` (10), `-view.tsx` (6),
  `-dialog.tsx` (6), `-shell.tsx` (5), `-skeleton.tsx` (5), `-dashboard.tsx` (5)

### "use client" Directive

- Required on every interactive component or component using browser APIs /
  hooks — **137** files carry it: 133 under `src/components`, 2 under `src/app`
  (`(app)/compare/page.tsx`, the legacy redirect), 2 under `src/hooks`
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
  (`src/hooks/use-compare.ts:107-109`, `:127`, `:170-175`). **Bump
  `CACHE_VERSION` (`src/lib/search/cache-version.ts`) whenever a client-cached
  server shape changes** — the module's JSDoc carries the v1→v3 migration
  history and states the rule explicitly
- `localStorage` is used for small, non-authoritative UI preferences only, always
  behind a namespaced key and a `try`/`catch` for quota
  (`begifted-admin-view`, `begifted-hide-worked` in
  `src/components/credit-control/dashboard-shell.tsx:64-68`; recent searches in
  `src/components/search/recent-searches.tsx:52-72`)
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
`sessionBgColor()` (0.28 alpha fill), `sessionFrameColor()` (0.35),
`sessionTextColor()`, `sessionBorderStyle()` (solid 3px left border), and
`TUTOR_COLORS` (`src/components/compare/session-colors.ts:21-58`). Non-visual
formatting helpers live in `src/lib` — `src/lib/bangkok-time.ts` wraps every
Bangkok-localized `Intl.DateTimeFormat` call (`BANGKOK_TIME_ZONE`, `hour12:
false`, `locale = "en-GB"`), and `src/lib/calendar/month-grid.ts` owns month
windows. Cross-cutting design tokens live in `src/lib/ui/` (`z-index.ts`,
`view-transitions.ts`) and `src/lib/scheduler/admin-colors.ts`.

### Styling

- Tailwind CSS 4 utility classes inline on JSX. shadcn style `base-nova`, base
  color `neutral`, CSS variables enabled, icon library `lucide`
  (`components.json`); **no `tailwind.config` file** — the theme is
  `@theme inline` in `src/app/globals.css:10-57`
- **72 OKLCH color declarations** define the palette; sky-blue primary
  (`oklch(0.55 0.14 230)`), amber accent, cream backgrounds
  (`oklch(0.985 0.005 85)`), with a full `.dark` override set behind
  `@custom-variant dark (&:is(.dark *))`
- Semantic tokens exposed as Tailwind colors: `--available`, `--blocked`,
  `--conflict`, `--free-slot`, `--today-indicator`, plus `--chart-1..5`
- Radii derive from one `--radius` via `calc()` (`--radius-sm` … `--radius-4xl`)
- Fonts wired through CSS vars: `--font-inter` (sans + heading),
  `--font-jetbrains-mono` (mono)
- Tutor lane colors centralized:
  `TUTOR_COLORS = ["#3b82f6", "#e67e22", "#7c3aed"]` (sky blue, amber, purple)
- **Hand-written CSS is allowed only for print and for legacy dense tables**, in
  a feature file imported by `globals.css`. `student-schedule.css` is the model:
  it declares a **named** `@page schedule-landscape` precisely because
  `learning-plans.css` already declares a global portrait `@page`, and both land
  in the same document (`src/app/student-schedule.css:1-20`). Any new print
  surface must use a named page for the same reason
- Conditional classes via `cn()`:
  `className={cn("base-class", isActive && "text-primary", className)}`
- Z-index goes through the documented three-tier scale — prefer
  `style={{ zIndex: Z_INDEX.legend }}`; a Tailwind `z-[6]` is acceptable only
  with a same-line comment naming the slot (`src/lib/ui/z-index.ts`)

---

_Verified against HEAD + uncommitted WIP on 2026-05-31._
