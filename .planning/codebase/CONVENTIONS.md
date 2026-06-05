# Coding Conventions

**Analysis Date:** 2026-05-31

These conventions are verified against current code (HEAD `d4fe6d3`). The
codebase has grown well beyond the original tutor-search tool into a multi-domain
admin platform — search/compare, classroom assignment, sales dashboard, credit
control, payroll review, LINE scheduler review, AI scheduler, leave requests, room
capacity, Wise activity audit, **progress tests** (every-8-classes tracker with a
teacher-scoped read-only view), and **student promotions** (annual grade roll-up).
The conventions below hold across **all** of those domains; where a newer module
refines an older pattern (e.g. `z.coerce`, constant-time cron auth, graceful
table-missing fallbacks, the domain-scoped `require*Session` / `*ErrorResponse`
auth helpers) it is called out.

## Naming Patterns

### Files

- **kebab-case** for every source file: `session-colors.ts`, `week-overview.tsx`,
  `app-nav.tsx`, `cron-auth.ts`, `review-service.ts`, `teacher-access.ts`,
  `teacher-heads-up.ts`, `parent-message.ts`, `admin-digest.ts`,
  `sales-dashboard-shell.tsx`, `scheduler-conversation.ts`
- React components use `.tsx`; pure logic / type-only modules use `.ts`
  (e.g. `src/lib/normalization/timezone.ts`, `src/lib/progress-tests/types.ts`)
- Singular `schema.ts` for the Drizzle schema (`src/lib/db/schema.ts`)
- Per-domain `types.ts` files (`src/lib/search/types.ts`, `src/lib/wise/types.ts`,
  `src/lib/progress-tests/types.ts`, `src/lib/payroll/types.ts`)
- Test files: `{module}.test.ts` (or `.test.tsx`) inside a sibling `__tests__/`
  directory — **never** colocated. All 162 test files live under a `__tests__/`
  dir (`src/lib/normalization/__tests__/identity.test.ts`,
  `src/lib/progress-tests/__tests__/engine.test.ts`,
  `src/lib/auth/__tests__/signin-callback.test.ts`)
- Integration tests use the `.integration.test.ts` suffix and live under
  `__tests__/` too (3 suites); the shared integration helper sits in
  `src/tests/integration/db-helper.ts`
- Page components at `src/app/.../page.tsx`; route handlers at
  `src/app/api/.../route.ts`; dynamic segments use bracket dirs
  (`src/app/api/student-promotions/runs/[runId]/apply/route.ts`,
  `src/app/api/class-assignments/runs/[runId]/rows/[rowId]/route.ts`)
- Layouts at `src/app/.../layout.tsx`; the root redirect at
  `src/app/(app)/page.tsx`

### Functions

- **camelCase** for all functions, verb-prefixed by intent:
  - `get*` for retrieval / accessors: `getDb()`, `getEnv()`, `getCurrentMonday()`,
    `getStartOfTodayBkk()`, `getSearchIndex()`, `getActiveSnapshotId()`,
    `getCronSecretStatus()`, `getRoomCapacityForecast()`,
    `getProgressTestsPayload()`
  - `is*` / `has*` / `should*` for booleans: `isBlockingStatus()`,
    `isOnlineVariant()`, `isMissingForecastTableError()`,
    `shouldReturnAvailabilitySummary()`, `hasValidCronSecret()`, `hasPageAccess()`
  - `make*` / `create*` for factories: `createWiseClient()`, `createDb()`
  - `parse*` / `normalize*` for transformation: `parseTimeToMinutes()`,
    `parseSlotInput()`, `normalizeWorkingHours()`, `normalizeLeaves()`,
    `normalizeSessions()`, `normalizeWeekday()`, `normalizeEmail()`,
    `normalizeTutorLookupKey()`
  - `fetch*` for I/O: `fetchAllTeachers()`, `fetchAllFutureSessions()`,
    `fetchTeacherAvailability()`, `fetchPastSessionBlocks()`
  - `derive*` / `resolve*` / `extract*` for inference: `deriveModality()`,
    `resolveIdentities()`, `resolveSessionModality()`, `extractNickname()`,
    `resolveUserAccess()`, `resolveTeacherCanonicalKeys()`
  - `build*` / `compute*` for derived structures: `buildIndex()`,
    `buildCompareTutor()`, `computeFreeGaps()`
  - `detect*` / `find*` for analysis: `detectConflicts()`, `findSharedFreeSlots()`
  - `require*` for auth/precondition guards that throw on failure:
    `requireProgressTestsSession()`, `requireProgressTestsAdminSession()`
    (`src/lib/progress-tests/api.ts:32,57`)
  - `reject*` for guard helpers that return an error response or null:
    `rejectInvalidCronSecret()` (`src/lib/internal/cron-auth.ts:19`)
- Internal/private helpers are lowercased with no special marker
  (`searchSlot`, `formatIsoDate`, `parseMondayDate`, `addDays`)

### Variables

- **camelCase** for locals and properties: `snapshotMeta`, `tutorGroupIds`,
  `sessionBlocks`, `dateRange`, `mondayDate`, `pastBlocksByCanonicalKey`,
  `resolvedIdByRequestedId`, `usedStaleIds`, `teacherCanonicalKeys`,
  `enrollmentKey`
- Module-level mutable singletons are **not** `_`-prefixed. The codebase uses a
  `globalThis` namespace (`globalThis.__bgscheduler_db`,
  `globalThis.__bgscheduler_searchIndex`,
  `globalThis.__bgscheduler_searchIndexBuildPromise`) to survive Next.js HMR
  (`src/lib/db/index.ts:16-19`, `src/lib/search/index.ts:94-96`). This is the
  **only** module-singleton mechanism — no `let _db` / `let _cachedIndex` style
  exists anywhere.

### Constants

- **UPPER_SNAKE_CASE** for module-level constants: `TUTOR_COLORS`, `HOUR_HEIGHT`,
  `START_HOUR`, `END_HOUR`, `TOTAL_HOURS`, `DAY_NAMES`, `DISPLAY_DAYS`,
  `TIMEZONE`, `WEEKDAY_MAP`, `UUID_RE`, `API_STALE_THRESHOLD_MS`,
  `STALE_SEARCH_WARNING`
- Single-route literals that read more naturally lower-cased stay `const` but
  carry a descriptive name and a JSDoc line — e.g.
  `const PROGRESS_TESTS_ROUTE = "/progress-tests"` (`src/lib/auth-access.ts:18`,
  `src/lib/progress-tests/api.ts:6`)
- Examples: `src/components/compare/week-overview.tsx`,
  `src/lib/normalization/timezone.ts`, `src/lib/ops/stale.ts`,
  `src/app/api/compare/route.ts` (`UUID_RE`)

### Types

- **PascalCase** for interfaces and type aliases
- `interface` for object shapes; `type` for unions, primitives, or aliases:
  - `interface SearchRequest`, `interface IndexedTutorGroup`,
    `interface UserAccess` (`src/lib/auth-access.ts:23`)
  - `type SearchMode = "recurring" | "one_time"`,
    `type CronSecretStatus = "valid" | "invalid" | "missing-secret"`
    (`src/lib/internal/cron-auth.ts:4`),
    `type UserRole = "admin" | "teacher"` (`src/lib/auth-access.ts:21`)
- Domain-prefixed names:
  - `Wise*` for external Wise API shapes: `WiseTeacher`, `WiseSession`, `WiseTag`,
    `WiseLeave`, `WiseClientConfig`
  - `Indexed*` for in-memory index types: `IndexedTutorGroup`,
    `IndexedSessionBlock`, `IndexedAvailabilityWindow`, `IndexedQualification`,
    `IndexedLeave`, `IndexedDataIssue`, `IndexedWiseRecord`,
    `IndexedTutorBusinessProfile`
  - `Normalized*` for normalization-pipeline outputs (e.g. `NormalizedSessionBlock`)
  - `Compare*` for compare-engine outputs: `CompareTutor`, `CompareSessionBlock`,
    `CompareResponse`, `CompareRequest`
  - `Parsed*` for parser outputs in the sales pipeline: `ParsedNormalSaleRow`,
    `ParsedAdditionalSaleRow`
  - `App*` for shared session/app shapes: `AppSessionUser`
    (`src/lib/progress-tests/types.ts`, used by the auth helpers)
- TypeScript `enum` is **never** used. Database enums use Drizzle's `pgEnum`
  (**25 declarations** in `src/lib/db/schema.ts`, e.g. `syncStatusEnum`,
  `modalityEnum`, `payrollReviewStatusEnum`, `lineSchedulerReviewStatusEnum`,
  and the progress-tests / student-promotions status enums)

### Database (Drizzle / Postgres)

- **snake_case** for table and column SQL names: `tutor_identity_groups`,
  `snapshot_id`, `created_at`, `wise_teacher_id`, `is_online_variant`,
  `group_canonical_key`, `payroll_review_status`, `most_frequent_tutor_canonical_key`
- **camelCase** for the Drizzle schema object names: `tutorIdentityGroups`,
  `snapshotId`, `wiseTeacherId`, `isOnlineVariant`, `tutorContacts`
- **90 tables** defined with `pgTable(...)`; nearly all are snapshot-scoped or
  keyed by a domain partition key (`payrollMonth`, `studentKey`, `canonicalKey`).
  Snapshot-independent tables that survive snapshot rotation include `admin_users`
  (now carrying an `allowed_pages` column for page-scoped access),
  `tutor_aliases`, `tutor_contacts`, `wise_activity_events`,
  `room_utilization_sessions`, and the single documented cross-snapshot data
  table `past_session_blocks` (its deviation is explained inline near its
  definition in `src/lib/db/schema.ts`)
- Index names: short table-prefix + `_idx` suffix (e.g. `tig_snapshot_idx`,
  `tigm_group_idx`, `admin_users_email_idx`)
- Postgres enums declared with `pgEnum` and exported by name (used both for the
  column type and as the TS union source)

> `src/lib/db/schema.ts` is excluded from edits in this map's scope; counts here
> are read-only observations. Column-level detail is owned by
> `docs/reference/database/index.md`.

## Code Style

### Formatting

- **No formatter config** is checked in (no `.prettierrc`, no `.editorconfig`)
- **2-space indentation** throughout
- **Double quotes** for strings everywhere (TS imports, string literals, JSX
  attributes) — single-quote imports do not appear in `src/lib` or `src/app`
- **Semicolons required** in `src/lib/**` and `src/app/**`
- **Semicolons omitted** in shadcn/ui primitives (`src/components/ui/*.tsx`,
  13 files) — these are regenerated by the shadcn CLI and follow upstream style
  (`src/components/ui/button.tsx` import lines carry no semicolons)
- Trailing commas on multi-line object/array literals
- Template literals for interpolation
  (e.g. `` `Wise API ${response.status}: ${text} (${url})` `` in
  `src/lib/wise/client.ts`; `` `Bearer ${cronSecret}` `` in
  `src/lib/internal/cron-auth.ts:13`)
- Section-header comment patterns (two coexist — match whichever the file already
  uses):
  - `// ── Section Name ─────────` (em-dash bars) — preferred in `src/lib/**`
    (`src/lib/db/schema.ts`, `src/lib/search/index.ts`)
  - `// -------------------------` (long-hyphen blocks above/below a label) —
    used pervasively in `src/components/**` and across newer lib modules
    (e.g. `src/lib/sales-dashboard/*.ts`, `src/lib/line/*.ts`)

### Linting

- **ESLint 9** with flat config at `eslint.config.mjs`
- Extends `eslint-config-next/core-web-vitals` and `eslint-config-next/typescript`
  only — **no custom rules** added beyond Next.js defaults
  (`eslint.config.mjs:5-16`)
- Default ignores re-declared via `globalIgnores([...])` to keep `.next/`, `out/`,
  `build/`, and `next-env.d.ts` ignored (`eslint.config.mjs:9-15`)
- Runs via `npm run lint` (resolves to bare `eslint`); type-checking is a separate
  `npm run typecheck` (`tsc --noEmit`). The release gate
  (`npm run verify:release`) chains `typecheck` → `test` → `build` → `typecheck`
  again → `git diff --check` → a production-route-surface guard.
- Inline `eslint-disable` is used sparingly and only for two narrow purposes:
  - `// eslint-disable-next-line no-var` for the `globalThis` `var` augmentations
    (`src/lib/db/index.ts:17`, `src/lib/search/index.ts`)
  - `react-hooks/exhaustive-deps` and `react-hooks/set-state-in-effect`
    suppressions inside interactive client components where the effect is
    intentionally not reactive to a dependency or sets state on mount
    (`src/components/search/*`, `src/components/scheduler/*`,
    `src/components/compare/week-calendar.tsx`, etc.)

### TypeScript

- **strict: true** in `tsconfig.json`
- `target: "ES2017"`, `module: "esnext"`, `moduleResolution: "bundler"`
- `lib: ["dom", "dom.iterable", "esnext"]`, `jsx: "react-jsx"` (no React import
  needed for JSX)
- `isolatedModules: true`, `esModuleInterop: true`, `allowJs: true`,
  `noEmit: true`, `resolveJsonModule: true`, `incremental: true`,
  `skipLibCheck: true`, `plugins: [{ "name": "next" }]`
- Path alias `"@/*": ["./src/*"]`
- Non-null assertions used sparingly and only after defensive checks
  (e.g. `this.queue.shift()!` in `src/lib/wise/client.ts`)
- Type predicates at filter boundaries are a recurring pattern:
  `.filter((g): g is IndexedTutorGroup => g !== undefined)`
  (`src/app/api/compare/route.ts`),
  `.filter((g): g is NonNullable<typeof g> => g !== undefined)`
  (`src/app/api/compare/discover/route.ts`),
  `.filter((item): item is string => typeof item === "string")`
  (`src/app/api/leave-requests/[requestId]/wise-cancel-preview/route.ts`),
  and a custom user-defined type guard `shouldReturnAvailabilitySummary(...): result is ...`
  (`src/app/api/search/assistant/route.ts`)

## Import Organization

### Order (observed pattern)

1. External packages (`next/server`, `zod`, `react`, `drizzle-orm`,
   `date-fns-tz`, `@base-ui/react`, `lucide-react`, `node:crypto`, etc.)
2. Internal `@/` aliases, grouped roughly by depth:
   - `@/lib/auth`, `@/lib/db`, `@/lib/env`
   - domain libs: `@/lib/wise/*`, `@/lib/normalization/*`, `@/lib/search/*`,
     `@/lib/ops/*`, `@/lib/data/*`, `@/lib/progress-tests/*`,
     `@/lib/student-promotions/*`, etc.
   - `@/components/ui/*`
   - `@/components/{feature}/*`
3. Relative imports (`./types`, `../identity`)
4. Type-only imports use `import type {...}`, often grouped at the end of the
   import block

Example (`src/app/api/compare/route.ts`):

```typescript
import { NextRequest, NextResponse } from "next/server";
import { toZonedTime } from "date-fns-tz";
import { z } from "zod";
import { inArray } from "drizzle-orm";
import { auth } from "@/lib/auth";
import { getDb } from "@/lib/db";
import * as schema from "@/lib/db/schema";
import { ensureIndex } from "@/lib/search/index";
import {
  buildCompareTutor,
  detectConflicts,
  findSharedFreeSlots,
  getStartOfTodayBkk,
} from "@/lib/search/compare";
import type { DateRange } from "@/lib/search/compare";
import { fetchPastSessionBlocks } from "@/lib/data/past-sessions";
import type { IndexedSessionBlock } from "@/lib/search/index";
import { TIMEZONE } from "@/lib/normalization/timezone";
import { API_STALE_THRESHOLD_MS, STALE_SEARCH_WARNING } from "@/lib/ops/stale";
import type { CompareResponse, SnapshotMeta } from "@/lib/search/types";
```

### Path Aliases

- Single alias: `@/*` → `./src/*`
- Configured in **both** `tsconfig.json` (`paths`) and `vitest.config.ts`
  (`resolve.alias`) so tests resolve identically
- **No barrel files** — modules import directly from specific files
  (`from "@/lib/wise/client"`, not `from "@/lib/wise"`). The Drizzle schema is
  the one exception, imported namespace-style as
  `import * as schema from "@/lib/db/schema"` (e.g.
  `src/lib/progress-tests/teacher-access.ts:18`)
- The shadcn `components.json` registers additional aliases for the CLI
  (`@/components`, `@/lib/utils`, `@/components/ui`, `@/lib`, `@/hooks`) but
  application code only ever uses the single `@/*` mapping

## Error Handling

### API Route Pattern

Two compatible shapes coexist. **Older / classic routes** follow the four-step
structure (auth-first), seen across search, compare, filters, class-assignments,
and credit-control:

```typescript
export async function POST(request: NextRequest) {
  // 1. Auth check first
  const session = await auth();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // 2. Parse JSON body in try/catch
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  // 3. Validate with Zod safeParse — never .parse()
  const parsed = requestSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid request", details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  // 4. Wrap business logic in try/catch — return 500 with extracted message
  try {
    // ... business logic
    return NextResponse.json(response);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Compare failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
```

**Newer domain routes (progress-tests)** wrap the *whole* handler in a single
try/catch and delegate auth + error mapping to shared per-domain helpers. Auth is
performed inside the `try` (so an auth failure flows through the same error mapper
that distinguishes 401 vs 403), and a domain-scoped `*ErrorResponse` translates
thrown sentinels into status codes:

```typescript
export async function POST(request: NextRequest) {
  try {
    const user = await requireProgressTestsAdminSession();   // throws "Unauthorized"/"Forbidden"

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
    }

    const parsed = MarkCompleteSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
    }

    const row = await markComplete({ enrollmentKey: parsed.data.enrollmentKey, actor: user });
    if (!row) return NextResponse.json({ error: "Enrollment not found" }, { status: 404 });
    return NextResponse.json({ row });
  } catch (error) {
    return progressTestsErrorResponse("/api/progress-tests/mark-complete", error, "Mark complete failed");
  }
}
```

(`src/app/api/progress-tests/mark-complete/route.ts`,
`src/lib/progress-tests/api.ts:32,57,65`)

Read-only `GET` routes that take a single trivial query param skip Zod and read
`request.nextUrl.searchParams.get(...)` with an inline default, then wrap the
data load in the same try/catch (`src/app/api/room-capacity/forecast/route.ts`).

### HTTP Status Conventions

- `200` — success
- `400` — invalid JSON body, Zod validation failure
- `401` — `auth()` returned null (not signed in), thrown `"Unauthorized"`, or an
  invalid cron secret
- `403` — authenticated but not permitted (a teacher hitting a mutating
  progress-tests route, or any page the session's `allowedPages` excludes;
  thrown `"Forbidden"` → `src/lib/progress-tests/api.ts:79-81`)
- `404` — resource not found in active snapshot / domain (e.g. "Enrollment not
  found", or no matching tutor groups in `src/app/api/compare/route.ts`)
- `500` — caught business-logic exception, or `missing-secret` server
  misconfiguration on a cron route (`src/lib/internal/cron-auth.ts:23`)

### Error Message Extraction

Universal pattern in every catch block:
`const message = err instanceof Error ? err.message : "<Default message>"`
(`src/app/api/compare/route.ts`, `src/lib/progress-tests/api.ts:84-85`, and
throughout). The default string is route-specific.

### Role + Page-Level Access (defense in depth)

Sign-in eligibility and per-page authorization are resolved server-side:

- `resolveUserAccess(email)` (`src/lib/auth-access.ts:39`) is the Node-only
  sign-in gate. Admins (rows in `admin_users`) take precedence; their
  `allowed_pages` column is `null` for full access or a list of route prefixes
  for restricted admins. A non-admin whose email matches an active
  `tutor_contacts` row becomes a page-restricted **teacher** scoped to
  `/progress-tests`. Anyone else → `null` → sign-in denied (fail-closed, the same
  posture as the original admin-only allowlist). The edge auth config never
  imports this module — it only reads the resulting token claims.
- `hasPageAccess(allowedPages, route)` (`src/lib/progress-tests/api.ts:15`) is the
  in-handler / in-page check: `null` allowedPages ⇒ full access; otherwise the
  route must equal or be a child prefix of an allowed page.

### Cron-Protected Routes (constant-time auth)

Internal cron routes do not compare the bearer token with `===`. They use a
**constant-time** comparison via `node:crypto`'s `timingSafeEqual`, with an
O(1) length pre-check to avoid the `RangeError` that `timingSafeEqual` throws on
length-mismatched buffers (the REL-07 hardening):

- Shared helper `src/lib/internal/cron-auth.ts` exports `getCronSecretStatus()`
  (returns `"valid" | "invalid" | "missing-secret"`, line 6) and
  `rejectInvalidCronSecret()` (returns a `NextResponse` 401/500 or `null` to
  continue, line 19). It is used by **six** internal cron routes:
  `sync-wise-activity`, `sync-leave-requests`, `sync-progress-tests`,
  `progress-tests/admin-digest`, `class-assignments/morning`, and
  `class-assignments/admin-email`.
- `src/app/api/internal/sync-wise/route.ts` carries an equivalent **inline**
  `hasValidCronSecret()` implementation (same REL-07 logic, `route.ts:11-27`)
  because it also supports a session-auth fallback for manual admin triggers
  (`handleSync(request, { allowSessionAuth })`).

When refactoring, prefer the shared `cron-auth.ts` helper over inlining.

### Graceful Degradation for Optional Tables

Newer feature routes that depend on optionally-migrated tables detect the
"relation does not exist" error by message substring and return a typed
"missing" payload (HTTP 200) instead of a 500, so the UI can render an empty
state (`isMissingForecastTableError()` → `missingForecastBody()` in
`src/app/api/room-capacity/forecast/route.ts`).

### Next.js cacheComponents Re-throw

Handlers that call cached data helpers must not swallow Next's hanging-promise
sentinel. The progress-tests error mapper explicitly re-throws any error whose
`digest === "HANGING_PROMISE_REJECTION"` before its own status mapping, so
`cacheComponents` streaming semantics are preserved
(`src/lib/progress-tests/api.ts:66-73`). Replicate this in any new domain-scoped
error mapper.

### Fail-Closed Defaults

Non-negotiable safety rule (per AGENTS.md): unresolved data routes the user away
from "Available" / from access, never silently omits or guesses:

- Unknown session status → blocking (`src/lib/normalization/sessions.ts`,
  `isBlockingStatus()`)
- Unresolved identity / modality / qualification → "Needs Review", never
  "Available" (`src/lib/search/engine.ts`)
- Cancelled sessions: explicitly non-blocking
- Modality contradictions: emit `unknown` modality + low confidence, never guess
  (`src/lib/search/compare.ts` — `resolveSessionModality`)
- Unknown sign-in email or unresolvable teacher → no access, no rows
  (`resolveUserAccess` → `null`; `resolveTeacherCanonicalKeys` → empty set)

### Wise Client Errors

`src/lib/wise/client.ts` wraps `fetch` with:
- Non-OK response → throws `Error` with status, response text, and URL
- Exponential backoff retry: `Math.pow(2, attempt) * 1000` → 1 s, 2 s, 4 s
- Configurable `maxRetries` (default 3); errors re-thrown after retries exhausted
- A `RETRYABLE_STATUS_CODES` set so 4xx (except the retryable ones) fail fast
  rather than burning all retries
- Queue-based concurrency limiter, `maxConcurrency` default 5, raised (to ~15)
  for the production sync via config

### Sync Orchestrator Errors

- Per-teacher errors caught, logged as `data_issues` rows; sync continues
- Top-level failures mark `sync_runs.status = 'failed'` and preserve the previous
  active snapshot (no promotion)
- Completeness gate: > 50 % unresolved identity groups blocks promotion
- Non-Wise sync lineages (sales, credit-control, wise-activity, leave-requests,
  progress-tests, room utilization) replicate the single-flight `running`-row
  guard and `*_sync_runs` discipline rather than the snapshot/index machinery

## Validation

### Zod Pattern

Schemas are declared as `const` at module scope, above the handler:

```typescript
const compareRequestSchema = z.object({
  tutorGroupIds: z.array(z.string()).min(1).max(3),
  mode: z.enum(["recurring", "one_time"]),
  dayOfWeek: z.number().min(0).max(6).optional(),
  date: z.string().optional(),
  weekStart: z.string().optional(),
  fetchOnly: z.array(z.string()).optional(),
});
```

(`src/app/api/compare/route.ts`)

Small single-field bodies follow the same module-scope `const` convention, e.g.
`const MarkCompleteSchema = z.object({ enrollmentKey: z.string().min(1) })`
(`src/app/api/progress-tests/mark-complete/route.ts`).

### Coercion at the Boundary

Newer code prefers Zod's `z.coerce.*` helpers over the older `.transform(Number)`
idiom for parsing strings (query params, sheet/Wise payloads) into typed values:

- `z.coerce.number().min(0).max(1)`
  (`src/app/api/line/scheduler-reviews/false-negatives/route.ts`)
- `z.coerce.boolean()`, `z.coerce.number()`, `z.coerce.date()` for parsing the
  raw Wise credit-control envelope (`src/lib/credit-control/wise.ts`)

### Rules

- **Always `.safeParse()`**, never `.parse()` (`.parse()` throws; `.safeParse()`
  returns a discriminated `success` boolean)
- On failure return Zod's `.error.flatten()` in the JSON body (as `details` in
  classic routes, or directly as `error` in newer ones)
- Prefer narrowing helpers (`.min()`, `.max()`, `.regex()`, `.url()`,
  `z.coerce.*`) over manual checks
- Zod also validates **external** data crossing into the system, not just request
  bodies — the credit-control Wise client parses Wise API responses through Zod
  schemas before use (`src/lib/credit-control/wise.ts`)

### Environment Variable Validation

Centralized in `src/lib/env.ts`:

```typescript
const envSchema = z.object({
  DATABASE_URL: z.string().url(),
  AUTH_GOOGLE_ID: z.string().min(1),
  AUTH_GOOGLE_SECRET: z.string().min(1),
  AUTH_SECRET: z.string().min(1),
  WISE_USER_ID: z.string().min(1),
  WISE_API_KEY: z.string().min(1),
  WISE_NAMESPACE: z.string().default("begifted-education"),
  WISE_INSTITUTE_ID: z.string().default("696e1f4d90102225641cc413"),
  CRON_SECRET: z.string().min(1),
  LINE_CHANNEL_SECRET: z.string().min(1).optional(),
  LINE_CHANNEL_ACCESS_TOKEN: z.string().min(1).optional(),
  ENABLE_LINE_SCHEDULER: z.string().optional(),
});

export const env = getEnv();
```

- Validates all required vars at module load (`src/lib/env.ts:29`)
- The 9 original vars are required; defaults are provided for `WISE_NAMESPACE` and
  `WISE_INSTITUTE_ID`; the three `LINE_*` / `ENABLE_LINE_SCHEDULER` vars are
  `.optional()` so the app boots without LINE configured
- On invalid env: `console.error(...)` with `.fieldErrors` only (never the
  values), then `throw new Error("Invalid environment variables")`
  (`src/lib/env.ts:22-25`)
- Other env vars consumed directly off `process.env` (not in this schema) include
  `CRON_SECRET` re-reads in cron-auth, `OPENAI_*` (gated by `ENABLE_AI_SCHEDULER`),
  and the `LEAVE_REQUESTS_*` Sheets settings — read at the point of use with
  inline defaults

## Logging

### Approach

- **No structured logger** — bare `console.error` / `console.log` only
- Currently **14 `console.error`** and **8 `console.log`** calls across non-test
  source

### Patterns

- `console.error` for errors that must surface in Vercel logs or that are caught
  at a fire-and-forget boundary:
  - Env validation failure (`src/lib/env.ts:23`)
  - Sync orchestrator failures (`src/lib/sync/orchestrator.ts`)
  - The domain `*ErrorResponse` 500 branch logs `(route, error)` before
    returning JSON (`src/lib/progress-tests/api.ts:83`)
  - Long-running pipeline steps (credit-control, LINE review-service, AI
    scheduler-data, progress-tests sync)
  - LINE webhook handler and the class-assignment publish route
  - Async `.catch(console.error)` for client fetches and caught component errors
- `console.log` is reserved for human-readable script progress (the seed script
  `src/lib/db/seed.ts` and the `tsx scripts/*` maintenance scripts)
- Standard request/response API handlers do **not** `console.*` on the happy path
  — they return JSON errors instead

### What to Avoid

- Do not introduce a logging dependency without explicit approval (Vercel +
  `console.*` is sufficient at current scale)
- Do not log request bodies, secrets, or env values (the env error logs only
  Zod `fieldErrors`, never the values; cron-auth never logs the token)

## Comments

### When to Comment

- **Public exported functions** get JSDoc with a short purpose statement, and for
  multi-step algorithms an explicit numbered list of steps (e.g.
  `resolveTeacherCanonicalKeys` documents its 3-step online/onsite bridging,
  `src/lib/progress-tests/teacher-access.ts:23-48`)
- **Non-obvious arithmetic / business logic** gets inline `//` notes
  (e.g. `// shift to Monday`, `// 1s, 2s, 4s`, `// 0=Sun`)
- **File-top design notes** explain a module's posture before the imports — the
  teacher-role rationale at the head of `src/lib/auth-access.ts:1-13`, and the
  online/onsite identity-bridging note at
  `src/lib/progress-tests/teacher-access.ts:1-13`, are good examples
- **Design decisions are referenced by ID inline** — `D-04`, `D-07`, `D-08`,
  `MOD-01`, `REL-07`, `REL-08`, `PAST-01`, `PAST-05`, plus `AGENTS.md:line`
  anchors. These IDs are **load-bearing**: they tie code to the plan/research
  documents under `.planning/` and appear across dozens of files. Preserve them
  when editing nearby code.

### JSDoc Pattern

```typescript
/**
 * Extract nickname from parenthetical in display name.
 * e.g. "Chinnakrit (Celeste) Channiti" → "Celeste"
 * e.g. "Usanee (Aey) Tortermpun Online" → "Aey"
 */
export function extractNickname(displayName: string): string | null { ... }
```

(`src/lib/normalization/identity.ts`)

Multi-step algorithms list the steps explicitly, and often note where the
function is called from and what an empty/null return means for the caller:

```typescript
/**
 * Resolves a login email to every tutor canonicalKey the teacher owns.
 *
 * 1. Match active `tutor_contacts` rows by normalized onsite OR online email.
 * 2. Seed the result with those rows' canonicalKeys (nickname-merged identities).
 * 3. Bridge any split online/onsite identities via displayName / sourceNames.
 *
 * @returns the unique set of canonicalKeys; empty when the email is unknown
 *   (→ fail-closed: the caller shows no rows / denies access).
 */
```

(`src/lib/progress-tests/teacher-access.ts:23-48`)

### Section Headers

Two patterns coexist (use whichever already appears in the file):

- **Em-dash bars** — preferred in `src/lib/**`:
  ```
  // ── Section Name ──────────────────────────────────────────────────
  ```
  (`src/lib/db/schema.ts`, `src/lib/search/index.ts`, `src/lib/search/types.ts`)

- **Long-hyphen blocks** — used in `src/components/**` and across the newer lib
  modules (`src/lib/sales-dashboard/*`, `src/lib/line/*`):
  ```
  // ---------------------------------------------------------------------------
  // Section Name
  // ---------------------------------------------------------------------------
  ```

### Inline Comment Style

- Reference plan/research IDs in line: `// D-07 / PAST-01: historical-range trigger.`
  (`src/app/api/compare/route.ts`)
- Use `→` to note transformations: `// "Chinnakrit (Celeste) Channiti" → "Celeste"`
- Type-field documentation: `dayOfWeek?: number; // 0=Sunday..6=Saturday`
- Magic numbers explained: `// 1s, 2s, 4s` (`src/lib/wise/client.ts`); the
  length pre-check rationale on `timingSafeEqual`
  (`src/lib/internal/cron-auth.ts` / sync-wise inline copy)
- Long-form deviation rationales live as multi-line `//` blocks directly above the
  code they justify (the `past_session_blocks` cross-snapshot deviation in
  `src/lib/db/schema.ts`)

### TODO Discipline

- **Zero** `TODO` / `FIXME` / `HACK` markers exist in non-test source. Treat them
  as code smells and resolve before merging.

## Function Design

### Signature Style

- Destructured object parameters when 3+ args, or a single config object
  (`new WiseClient({ userId, apiKey, namespace, maxConcurrency, maxRetries })`;
  `markComplete({ enrollmentKey, actor })`)
- Helper functions that need a DB handle take it as a trailing parameter that
  **defaults to `getDb()`**, so production callers omit it and tests inject a
  handle: `resolveUserAccess(email, db: Database = getDb())`
  (`src/lib/auth-access.ts:46`),
  `resolveTeacherCanonicalKeys(email, db: Database = getDb())`
  (`src/lib/progress-tests/teacher-access.ts`). Where a handle and options are
  both needed, the handle is positional and options trail as an object
  (`getRoomCapacityForecast(getDb(), { scenario })`).
- Optional params expressed with `?` property or default values:
  - `staleThresholdMs: number = ...` (search engine)
  - `attempt = 0` (`src/lib/wise/client.ts`)
  - `options: { allowSessionAuth: boolean }` (sync route `handleSync`)

### Return Values

- Return typed objects, not raw primitives, for any non-trivial operation
- Pipeline / normalization functions return `{ result, issues }`-shaped objects to
  surface problems without throwing:
  - `deriveModality(...) → { modality, issue }`
  - `normalizeTeacherTags(...) → { qualifications, issues }`
  - `resolveIdentities(...) → { groups, issues }`
  - `resolveSessionModality(...) → { modality, confidence }`
  - `resolveTutorGroupsForActiveSnapshot(...) → { groups, resolvedIdByRequestedId, usedStaleIds }`
- Auth/precondition guards split by failure mode:
  - **Throwing guards** raise a sentinel `Error` mapped to a status by a shared
    `*ErrorResponse` (`requireProgressTestsSession` throws `"Unauthorized"` /
    `"Forbidden"`)
  - **Response-or-null guards** return `NextResponse | null`
    (`rejectInvalidCronSecret(): NextResponse | null` — `null` means "continue")
- Resolver functions that may find nothing return a concrete empty value
  (`resolveTeacherCanonicalKeys → string[]`, empty on miss) or `| null`
  (`resolveUserAccess → UserAccess | null`); avoid `undefined` in domain return
  types
- Nullable returns use `| null` (e.g. `extractNickname(): string | null`)
- Async functions return `Promise<T>` directly; no callback style

### Function Length

- Most domain functions ≤ 40 lines
- Larger orchestrators (`buildCompareTutor`, `runFullSync`, the progress-tests
  sync/booking engines, the compare `POST` handler) factor sub-steps into named
  helpers in the same file

## Module Design

### Exports

- **Named exports** everywhere except page components and route handlers — there
  are **zero** default exports in `src/lib` or `src/components`
- Page components: `export default async function SearchPage()`
  (`src/app/(app)/search/page.tsx`)
- Route handlers use named `GET`/`POST`/`PATCH`/`DELETE` exports per the Next.js
  App Router contract (**130 endpoints** across 111 `route.ts` files; method
  exports skew POST/GET with a handful of `PATCH` and `DELETE`, no `PUT`)
- Types co-exported with implementations or re-exported from a sibling `types.ts`
- No barrel files — `from "@/lib/wise/client"`, never `from "@/lib/wise"`

### Singletons

Two patterns:

1. **`globalThis`-anchored** — survives Next.js HMR in dev. This is the only
   place `declare global` appears (`src/lib/db/index.ts`, `src/lib/search/index.ts`):
   ```typescript
   type DbInstance = ReturnType<typeof createDb>;

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

   export type Database = ReturnType<typeof getDb>;
   ```
   The public handle type is **`Database`** (`src/lib/db/index.ts:29`), which
   newer modules accept as a defaulted parameter (see Function Design).

2. **Lazy ensure-pattern with staleness check + in-flight dedupe** — the search
   index adds a build-promise singleton
   (`globalThis.__bgscheduler_searchIndexBuildPromise`) so concurrent requests
   share a single rebuild; `ensureIndex(db: Database)` rebuilds when the active
   snapshot's id changes (`src/lib/search/index.ts:94-96,354`)

### Server-only Helpers Behind Routes

Logic invoked by route handlers lives in plain `src/lib/{domain}/*.ts` modules
(`@/lib/data/filters`, `@/lib/room-capacity/data`, `@/lib/sync/run-wise-sync`,
`@/lib/credit-control/service`, `@/lib/progress-tests/service`,
`@/lib/student-promotions/data`) so it is unit-testable in the Vitest `node`
environment without pulling in the Next.js / next-auth route graph. Auth +
error-mapping helpers for a domain are co-located in that domain's `api.ts`
(`src/lib/progress-tests/api.ts`). Server-component pages call these helpers
directly (see Component Patterns).

## Component Patterns

### Where Components Live

- shadcn/ui primitives: `src/components/ui/` (13 files) — wrap `@base-ui/react`
  with `cva()` variants
- Feature components: `src/components/{feature}/` —
  `compare/`, `search/`, `class-assignments/`, `credit-control/`,
  `sales-dashboard/`, `payroll/`, `line-review/`, `leave-requests/`,
  `room-capacity/`, `scheduler/`, `tutor-profiles/`, `wise-activity/`,
  `progress-tests/`, `student-promotions/`, `home/`, `layout/`, `skeletons/`

### "use client" Directive

- Required on every interactive component or component using browser APIs / hooks
  (**65 client components** under `src/components/`)
- Top of file, before imports: `"use client";`
- **Pages are async server components by default.** The dominant page pattern is:
  the `page.tsx` is an `async` server component that fetches data via server-only
  lib helpers and passes it as props into a client "shell"/"workspace" wrapped in
  `<Suspense>` with a skeleton fallback:
  ```typescript
  export default async function SearchPage() {
    const filterOptions = await getFilterOptions();
    const tutorList = await getTutorList();
    return (
      <Suspense fallback={<SearchSkeleton />}>
        <SearchWorkspace filterOptions={filterOptions} tutorList={tutorList} />
      </Suspense>
    );
  }
  ```
  (`src/app/(app)/search/page.tsx`). Most `(app)` pages — sales-dashboard,
  credit-control, scheduler, payroll, leave-requests, wise-activity,
  tutor-profiles, progress-tests, student-promotions, compare — follow this
  server-fetch → `<Suspense>` → client-shell shape. Pages that gate on role
  resolve access in the server component (or rely on middleware + the in-handler
  `hasPageAccess` check) before rendering the shell.

### Variant Components (shadcn / CVA)

- Variants declared with `class-variance-authority`'s `cva()`
- `cn()` utility from `src/lib/utils.ts` merges variants with caller `className`:
  ```typescript
  export function cn(...inputs: ClassValue[]) {
    return twMerge(clsx(inputs))
  }
  ```
- Both component and variants exported: `export { Button, buttonVariants }`
- shadcn/ui files **omit semicolons** — leave them as is. The CLI config
  (`components.json`) records `style: "base-nova"`, `baseColor: "neutral"`, CSS
  variables enabled

### Hooks & State

- React `useState` / `useCallback` / `useRef` / `useEffect` only; no Redux,
  Zustand, Jotai, etc.
- Recent searches persisted via `localStorage` (capped at 10)
- The compare tutor cache lives client-side as
  `Map<"tutorGroupId:weekStart:CACHE_VERSION", CompareTutor>` with incremental
  fetch + `AbortController` for race-condition safety
- Intentional non-reactive effects or mount-time `setState` are documented with a
  targeted `// eslint-disable-next-line react-hooks/exhaustive-deps`
  (or `set-state-in-effect`) comment rather than silenced project-wide

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

Pure helpers (no hooks, no JSX) are defined in the same file above the component
(`minuteToY`, `minuteToLabel`, `formatClassType`). Visual helpers shared across
components live in dedicated modules — e.g. `src/components/compare/session-colors.ts`
exports `rgba()`, `sessionBgColor()`, `sessionFrameColor()`, `sessionTextColor()`,
`sessionBorderStyle()`, and `TUTOR_COLORS`. Per-feature color/z-index tokens are
centralized in `src/lib/ui/` (`z-index.ts`, `view-transitions.ts`) and
`src/lib/scheduler/admin-colors.ts`.

### Styling

- Tailwind CSS 4 utility classes inline on JSX; theme in `src/app/globals.css`
  (OKLCH tokens, no `tailwind.config`)
- Semantic color tokens via CSS custom properties: `--available`, `--blocked`,
  `--conflict`, `--free-slot`
- OKLCH color space for the palette (sky-blue primary, amber accent, cream
  backgrounds)
- Tutor lane colors centralized: `TUTOR_COLORS = ["#3b82f6", "#e67e22", "#7c3aed"]`
  (sky blue, amber, purple)
- Conditional classes via `cn()` + template literals:
  ```typescript
  className={cn("base-class", isActive && "text-primary", className)}
  ```

---

_Verified against HEAD `d4fe6d3` on 2026-06-05._
