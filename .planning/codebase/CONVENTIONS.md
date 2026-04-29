# Coding Conventions

**Analysis Date:** 2026-04-29

## Naming Patterns

### Files

- **kebab-case** for all source files: `session-colors.ts`, `week-overview.tsx`, `app-nav.tsx`, `tutor-combobox.tsx`, `past-sessions-diff-hook.ts`
- React components use `.tsx` extension (e.g., `src/components/compare/week-overview.tsx`)
- Pure logic / type-only modules use `.ts` (e.g., `src/lib/normalization/timezone.ts`)
- Singular `schema.ts` for the Drizzle schema (`src/lib/db/schema.ts`)
- Per-domain `types.ts` files (`src/lib/search/types.ts`, `src/lib/wise/types.ts`)
- Test files: `{module}.test.ts` inside a sibling `__tests__/` directory (e.g., `src/lib/normalization/__tests__/identity.test.ts`)
- Page components live at `src/app/.../page.tsx`; route handlers at `src/app/api/.../route.ts`
- Layouts at `src/app/.../layout.tsx`; redirects at `src/app/page.tsx`

### Functions

- **camelCase** for all functions
- Verb-prefixed by intent:
  - `get*` for retrieval / accessors: `getDb()`, `getEnv()`, `getBaseName()`, `getCurrentMonday()`, `getStartOfTodayBkk()`, `getCurrentIndex()`, `getRecommendedSlots()`, `getWiseTeacherDisplayName()`
  - `is*` / `has*` for booleans: `isBlockingStatus()`, `isOnlineVariant()`, `hasWindow` (local boolean)
  - `make*` / `create*` for factories: `createWiseClient()`, `createDb()`, `makeTutor()` (test fixtures), `makeIndex()`, `makeRow()`
  - `parse*` / `normalize*` for transformation: `parseTimeToMinutes()`, `parseSlotInput()`, `normalizeWorkingHours()`, `normalizeLeaves()`, `normalizeSessions()`, `normalizeTeacherTags()`, `normalizeWeekday()`
  - `fetch*` for I/O: `fetchAllTeachers()`, `fetchAllFutureSessions()`, `fetchTeacherAvailability()`, `fetchPastSessionBlocks()`
  - `derive*` / `resolve*` / `extract*` for inference: `deriveModality()`, `resolveIdentities()`, `resolveSessionModality()`, `extractNickname()`
  - `build*` / `compute*` for derived structures: `buildIndex()`, `buildCompareTutor()`, `computeFreeGaps()`, `computeIntersection()`, `computeDateForWeekdayInRange()`
  - `detect*` / `find*` for analysis: `detectConflicts()`, `detectSessionModalityConflict()`, `findSharedFreeSlots()`
- Internal/private helpers prefixed with no special marker but lowercased (e.g., `searchSlot`, `intersectIntervals`, `formatMinute`)

### Variables

- **camelCase** for locals and properties: `snapshotMeta`, `tutorGroupIds`, `sessionBlocks`, `dateRange`, `mondayDate`, `pastBlocksByCanonicalKey`
- Module-level mutable singletons prefixed with `_`: not used directly here; instead, this codebase uses a `globalThis` namespace (`globalThis.__bgscheduler_db`, `globalThis.__bgscheduler_searchIndex`) to survive Next.js HMR (`src/lib/db/index.ts:16-19`, `src/lib/search/index.ts:81-86`)

### Constants

- **UPPER_SNAKE_CASE** for module-level constants: `TUTOR_COLORS`, `HOUR_HEIGHT`, `START_HOUR`, `END_HOUR`, `TOTAL_HOURS`, `DAY_NAMES`, `DISPLAY_DAYS`, `TIMEZONE`, `WEEKDAY_MAP`, `NON_BLOCKING_STATUSES`, `ONLINE_SESSION_TYPES`, `DAY_OPTIONS`, `DURATION_OPTIONS`, `TIME_OPTIONS`
- Examples: `src/components/compare/week-overview.tsx:23-28`, `src/lib/normalization/timezone.ts:3`, `src/lib/normalization/availability.ts:10-18`

### Types

- **PascalCase** for interfaces and type aliases
- `interface` for object shapes; `type` for unions, primitives, or aliases
  - Examples: `interface SearchRequest`, `interface CompareTutor`, `interface IndexedTutorGroup`, `type SearchMode = "recurring" | "one_time"`, `type WiseTag = string | WiseTagObject`
- Domain-prefixed names:
  - `Wise*` for external Wise API shapes: `WiseTeacher`, `WiseSession`, `WiseTag`, `WiseLeave`, `WiseWorkingHourSlot`, `WiseClientConfig`
  - `Indexed*` for in-memory index types: `IndexedTutorGroup`, `IndexedSessionBlock`, `IndexedAvailabilityWindow`, `IndexedQualification`, `IndexedLeave`, `IndexedDataIssue`, `IndexedWiseRecord`
  - `Normalized*` for normalization-pipeline outputs: `NormalizedSessionBlock`
  - `Compare*` for compare-engine outputs: `CompareTutor`, `CompareSessionBlock`, `CompareResponse`, `CompareRequest`
- TypeScript `enum` is **not** used; database enums use Drizzle's `pgEnum` (`src/lib/db/schema.ts:16-43`)

### Database (Drizzle / Postgres)

- **snake_case** for table and column SQL names: `tutor_identity_groups`, `snapshot_id`, `created_at`, `wise_teacher_id`, `is_online_variant`
- **camelCase** for the Drizzle schema object names: `tutorIdentityGroups`, `snapshotId`, `wiseTeacherId`, `isOnlineVariant`
- Index names: short prefix + `_idx` suffix: `tig_snapshot_idx`, `tigm_group_idx`, `admin_users_email_idx` (`src/lib/db/schema.ts:73, 86, 98-99`)
- Postgres enums declared with `pgEnum`: `syncStatusEnum`, `dataIssueTypeEnum`, `dataIssueSeverityEnum`, `modalityEnum` (`src/lib/db/schema.ts:16-43`)

## Code Style

### Formatting

- **No formatter config** is checked in (no `.prettierrc`, no `.editorconfig`)
- **2-space indentation** throughout
- **Double quotes** for strings everywhere (TS imports, string literals, JSX attributes)
- **Semicolons required** in `src/lib/**` and `src/app/**`
- **Semicolons omitted** in shadcn/ui primitives (`src/components/ui/*.tsx`) — these are regenerated by the shadcn CLI and follow upstream style
- Trailing commas on multi-line object/array literals
- Template literals for interpolation (e.g., `` `Wise API ${response.status}: ${text} (${url})` `` in `src/lib/wise/client.ts:79`)
- Section header comment patterns:
  - `// ── Section Name ─────────` (em-dash bars) — used in `src/lib/db/schema.ts:14`, `src/lib/search/index.ts:5`, `src/lib/search/types.ts:1`
  - `// -- Section Name --` (double-hyphen) — used in `src/lib/sync/__tests__/past-sessions-diff-hook.test.ts:7`
  - `// --------------------` (long underscores) — used in components like `src/components/compare/week-overview.tsx:48-50`, `src/components/search/search-form.tsx:17-19`

### Linting

- **ESLint 9** with flat config at `eslint.config.mjs`
- Extends `eslint-config-next/core-web-vitals` and `eslint-config-next/typescript` only
- **No custom rules** added beyond Next.js defaults
- Default ignores overridden to keep `.next/`, `out/`, `build/`, `next-env.d.ts` ignored (`eslint.config.mjs:8-13`)
- Runs via `npm run lint` (resolves to `eslint`)
- Inline `eslint-disable-next-line` only used to relax `no-var` for `globalThis` augmentations (`src/lib/db/index.ts:17`, `src/lib/search/index.ts:82, 84`)

### TypeScript

- **strict: true** in `tsconfig.json`
- `target: "ES2017"`, `module: "esnext"`, `moduleResolution: "bundler"` (`tsconfig.json:3-13`)
- `lib: ["dom", "dom.iterable", "esnext"]`
- `jsx: "react-jsx"` (no need to import React for JSX)
- `isolatedModules: true`, `esModuleInterop: true`
- `allowJs: true`, `noEmit: true` (Next.js handles emission)
- Path alias `"@/*": ["./src/*"]` (`tsconfig.json:24-26`)
- Non-null assertions used sparingly and only after defensive checks (e.g., `this.queue.shift()!` in `src/lib/wise/client.ts:102`, `byWeekday.get(w.weekday)!` after a `has` check)
- Type predicates used at filter boundaries: `.filter((g): g is NonNullable<typeof g> => g !== undefined)` (`src/app/api/compare/route.ts:94`)

## Import Organization

### Order (observed pattern)

1. External packages (`next`, `zod`, `react`, `drizzle-orm`, `@base-ui/react`, `lucide-react`, etc.)
2. Internal `@/` aliases grouped by depth:
   - `@/lib/auth`, `@/lib/db`, `@/lib/env`
   - `@/lib/wise/*`, `@/lib/normalization/*`, `@/lib/search/*`
   - `@/components/ui/*`
   - `@/components/{feature}/*`
3. Relative imports (`./types`, `./modality-display`, `../identity`)
4. Type-only imports separated where appropriate using `import type {...}`

Example (`src/app/api/compare/route.ts:1-15`):

```typescript
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { getDb } from "@/lib/db";
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
import type { CompareResponse, SnapshotMeta } from "@/lib/search/types";
```

### Path Aliases

- Single alias: `@/*` → `./src/*`
- Configured in **both** `tsconfig.json` (`paths`) and `vitest.config.ts` (`resolve.alias`) so tests resolve identically
- No barrel files — modules import directly from specific files (`from "@/lib/wise/client"`, not `from "@/lib/wise"`)

## Error Handling

### API Route Pattern

Every API route follows the same structure (see `src/app/api/compare/route.ts`, `src/app/api/search/route.ts`, `src/app/api/filters/route.ts`):

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

### HTTP Status Conventions

- `200` — success
- `400` — invalid JSON body, Zod validation failure
- `401` — `auth()` returned null (not signed in)
- `404` — resource not found in active snapshot (e.g., `src/app/api/compare/route.ts:96-101` when no matching tutor groups exist)
- `500` — caught business-logic exception
- Cron-protected routes (`src/app/api/internal/sync-wise/route.ts:15-17`) check `Authorization: Bearer ${CRON_SECRET}` header before any other work

### Error Message Extraction

Universal pattern: `const message = err instanceof Error ? err.message : "<Default message>"` — used in every API route's catch block (e.g., `src/app/api/compare/route.ts:184`, `src/app/api/search/route.ts:58`, `src/app/api/filters/route.ts:35`).

### Fail-Closed Defaults

Non-negotiable safety rule (per AGENTS.md): unresolved data routes the user away from "Available", never silently omits records:

- Unknown session status → blocking (`src/lib/normalization/sessions.ts`, `isBlockingStatus()` returns `true` for unknown / undefined)
- Unresolved identity / modality / qualification → "Needs Review", never "Available" (`src/lib/search/engine.ts:83-93`)
- Cancelled sessions: explicitly non-blocking
- Modality contradictions: emit `unknown` modality + `low` confidence, never guess (`src/lib/search/compare.ts` — `resolveSessionModality`, `detectSessionModalityConflict`)

### Wise Client Errors

`src/lib/wise/client.ts:67-91` wraps `fetch` with:
- Non-OK response → throws `Error` with status, response text, and URL: `Wise API ${response.status}: ${text} (${url})`
- Exponential backoff retry: `Math.pow(2, attempt) * 1000` → 1 s, 2 s, 4 s
- Configurable `maxRetries` (default 3); errors re-thrown after retries exhausted
- Concurrency limiter (default 5; production sync uses 15 — `src/lib/wise/client.ts:121`)

### Sync Orchestrator Errors

- Per-teacher errors caught, logged as `data_issues` rows; sync continues
- Top-level failures mark `sync_runs.status = 'failed'` and preserve previous active snapshot (no promotion)
- Completeness gate: > 50 % unresolved identity groups blocks promotion

## Validation

### Zod Pattern

Schemas declared as `const` at module scope, above the handler:

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

(`src/app/api/compare/route.ts:17-24`)

### Search Schema

Uses regex constraints for time format:

```typescript
start: z.string().regex(/^\d{2}:\d{2}$/),
end: z.string().regex(/^\d{2}:\d{2}$/),
mode: z.enum(["online", "onsite", "either"]),
```

(`src/app/api/search/route.ts:15-17`)

### Rules

- **Always `.safeParse()`**, never `.parse()` (`.parse()` throws; `.safeParse()` returns a discriminated `success` boolean)
- On failure return Zod's `.error.flatten()` in the JSON `details` field for client-side highlighting
- Use `.transform(Number)` for string-to-number coercion at the boundary
- Prefer narrowing helpers (`.min()`, `.max()`, `.regex()`, `.url()`) over manual checks

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
});

export const env = getEnv();
```

- Validates all 9 vars at module load (`src/lib/env.ts:26`)
- Defaults provided for `WISE_NAMESPACE` and `WISE_INSTITUTE_ID`
- On invalid env: `console.error(...)` then `throw new Error("Invalid environment variables")` (`src/lib/env.ts:19-22`)

## Logging

### Approach

- **No structured logger** — bare `console.error` / `console.log`
- Used in roughly 10 places total across the codebase

### Patterns

- `console.error` for errors that bubble up to the user or that must surface in Vercel logs:
  - Env validation failure (`src/lib/env.ts:20`)
  - Async `.catch(console.error)` for fire-and-forget client fetches (`src/app/(app)/data-health/page.tsx:95`)
  - Caught errors in components (`src/components/compare/discovery-panel.tsx:59`: `console.error("Failed to load filter options:", err)`)
  - Seed script failures (`src/lib/db/seed.ts:49`)
- `console.log` is reserved for the seed script for human-readable progress (`src/lib/db/seed.ts:14, 28, 33, 40, 42, 45`)
- API route handlers do **not** call `console.*` — they return JSON errors instead

### What to Avoid

- Do not introduce a logging dependency without explicit approval (Vercel + console.log is sufficient for current scale)
- Do not log request bodies or env values

## Comments

### When to Comment

- **Public exported functions** get JSDoc with a short purpose statement (sometimes including pre-/post-conditions)
- **Non-obvious arithmetic / business logic** gets inline `//` notes (e.g., `// shift to Monday`, `// 1s, 2s, 4s`, `// fail-closed`)
- **References to design decisions** are linked by ID: `D-04`, `D-07`, `MOD-01`, `Pitfall 16`, `AGENTS.md:146-149`. The codebase treats these IDs as load-bearing — they tie code to plan documents under `.planning/`

### JSDoc Pattern

```typescript
/**
 * Extract nickname from parenthetical in display name.
 * e.g. "Chinnakrit (Celeste) Channiti" → "Celeste"
 * e.g. "Usanee (Aey) Tortermpun Online" → "Aey"
 */
export function extractNickname(displayName: string): string | null { ... }
```

(`src/lib/normalization/identity.ts:38-46`)

Multi-step algorithms list the steps explicitly:

```typescript
/**
 * Resolve tutor identities from Wise teacher records.
 *
 * Resolution order:
 * 1. Extract nickname from parenthetical
 * 2. Apply alias overrides
 * 3. Detect online/offline pairs and merge them
 * 4. Any teacher that doesn't resolve → data_issue
 */
```

(`src/lib/normalization/identity.ts:64-71`)

### Section Headers

Two patterns coexist (use the one that already appears in the file):

- **Em-dash bars** — preferred for `src/lib/**`:
  ```
  // ── Section Name ──────────────────────────────────────────────────
  ```
  Examples: `src/lib/db/schema.ts:14`, `src/lib/search/index.ts:5,79`, `src/lib/search/types.ts:1`

- **Long-hyphen blocks** — used in `src/components/**` and `src/components/compare/week-overview.tsx`:
  ```
  // ---------------------------------------------------------------------------
  // Section Name
  // ---------------------------------------------------------------------------
  ```

### Inline Comment Style

- Reference plan/research IDs in line: `// D-07 / PAST-01: historical-range trigger.` (`src/app/api/compare/route.ts:115`)
- Use `→` to note transformations: `// "Chinnakrit (Celeste) Channiti" → "Celeste"`
- Type-field documentation: `dayOfWeek?: number; // 0=Sunday..6=Saturday` (`src/lib/search/types.ts:7`)
- Magic numbers explained: `// 1s, 2s, 4s` (`src/lib/wise/client.ts:85`)

### TODO Discipline

- Only one `TODO` exists in the codebase (`src/components/compare/modality-display.ts:9`) — and it specifically annotates a future-phase D-03 follow-up
- Treat `TODO`, `FIXME`, `HACK` as code smells; resolve before merging when possible

## Function Design

### Signature Style

- Destructured object parameters when 3+ args: `executeSearch(index, request, staleThresholdMs?)`
- Optional params expressed with `?` property or default values:
  - `staleThresholdMs: number = 35 * 60 * 1000` (`src/lib/search/engine.ts:24`)
  - `attempt = 0` (`src/lib/wise/client.ts:67`)
- Factory functions take a single config object: `new WiseClient({ userId, apiKey, namespace, maxRetries })`

### Return Values

- Return typed objects, not raw primitives, for any non-trivial operation
- Pipeline / normalization functions return `{ result, issues }` tuples to surface problems without exceptions:
  - `deriveModality(group, sessions) → { modality, issue }` (`src/lib/normalization/modality.ts`)
  - `normalizeTeacherTags(...)` → `{ qualifications, issues }` (`src/lib/normalization/qualifications.ts`)
  - `resolveIdentities(...)` → `{ groups, issues }` (`src/lib/normalization/identity.ts`)
  - `resolveSessionModality(...)` → `{ modality, confidence }` (`src/lib/search/compare.ts:97`)
- Nullable returns use `| null` (e.g., `extractNickname() → string | null`); avoid `undefined` in domain return types
- Async functions return `Promise<T>` directly; no callback style

### Function Length

- Most domain functions ≤ 40 lines
- Larger orchestrators (`buildCompareTutor`, `runFullSync`) factor sub-steps into named helpers in the same file

## Module Design

### Exports

- **Named exports** everywhere except page components and route handlers
- Page components: `export default function SearchPage()` (`src/app/(app)/search/page.tsx:7`)
- Route handlers use named `GET`/`POST` exports per Next.js App Router contract (`src/app/api/compare/route.ts:53`)
- Types co-exported with implementations or re-exported from a sibling `types.ts`
- No barrel files — `from "@/lib/wise/client"`, never `from "@/lib/wise"`

### Singletons

Two patterns:

1. **`globalThis`-anchored** — survives Next.js HMR in dev:
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
   (`src/lib/db/index.ts:14-27`, `src/lib/search/index.ts:81-102`)

2. **Lazy ensure-pattern with staleness check** — `ensureIndex(db)` rebuilds when the active snapshot's id changes (`src/lib/search/index.ts`, `ensureIndex`)

### Type Re-Exports

`src/app/api/data-health/route.ts:25-31` re-exports a helper from a sibling module just so Vitest can import without pulling in the full Next.js / next-auth route graph:

```typescript
export function selectModalityIssues<T extends ...>(issues: T[]) {
  return _selectModalityIssues(issues);
}
```

Use this pattern when a route's helper needs unit testing.

## Component Patterns

### Where Components Live

- shadcn/ui primitives: `src/components/ui/` — wrap `@base-ui/react` with `cva()` variants (`src/components/ui/button.tsx`)
- Feature components: `src/components/{feature}/` — `compare/`, `search/`, `data-health/`, `layout/`, `skeletons/`

### "use client" Directive

- Required on every interactive component or component using browser APIs / hooks
- Top of file, before imports: `"use client";` (`src/components/compare/week-overview.tsx:1`, `src/components/search/search-form.tsx:1`)
- Server components have **no** directive — Next.js App Router defaults to server (`src/app/(app)/search/page.tsx`, which is `async` and awaits server-only `getFilterOptions()`)
- Pages using `useSearchParams` wrap an inner client component in `<Suspense>`:
  ```typescript
  <Suspense fallback={<SearchSkeleton />}>
    <SearchWorkspace ... />
  </Suspense>
  ```

### Variant Components (shadcn / CVA)

- Variants declared with `class-variance-authority`'s `cva()`
- `cn()` utility from `src/lib/utils.ts` merges variants with caller `className`:
  ```typescript
  export function cn(...inputs: ClassValue[]) {
    return twMerge(clsx(inputs));
  }
  ```
- Both component and variants exported: `export { Button, buttonVariants }` (`src/components/ui/button.tsx:58`)
- shadcn/ui files **omit semicolons** — leave them as is

### Hooks & State

- React `useState` / `useCallback` / `useRef` only; no Redux, Zustand, Jotai, etc.
- Recent searches persisted via `localStorage` (`src/components/search/recent-searches.tsx`, capped at 10)
- Tutor cache lives client-side as `Map<tutorGroupId:weekStart, CompareTutor>` with incremental fetch + `AbortController` for race-condition safety

### Constants in Components

Defined at module scope above the component (`src/components/compare/week-overview.tsx:23-28`):

```typescript
const HOUR_HEIGHT = 48;
const START_HOUR = 7;
const END_HOUR = 21;
const TOTAL_HOURS = END_HOUR - START_HOUR;
const DISPLAY_DAYS = [1, 2, 3, 4, 5, 6, 0]; // Mon-Sun
const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
```

### Helpers

Pure helpers (no hooks, no JSX) defined in the same file above the component:

```typescript
function minuteToY(minute: number): number { ... }
function minuteToLabel(minute: number): string { ... }
function formatClassType(ct?: string): string { ... }
```

Visual helpers shared across components live in dedicated modules: `src/components/compare/session-colors.ts` exports `rgba()`, `sessionBgColor()`, `sessionFrameColor()`, `sessionTextColor()`, `sessionBorderStyle()`, `TUTOR_COLORS`.

### Styling

- Tailwind CSS 4 utility classes inline on JSX
- Semantic color tokens via CSS custom properties: `--available`, `--blocked`, `--conflict`, `--free-slot`
- OKLCH color space for the palette
- Tutor lane colors centralized: `TUTOR_COLORS = ["#3b82f6", "#e67e22", "#7c3aed"]` (sky blue, amber, purple)
- Conditional classes via template literals + `cn()`:
  ```typescript
  className={cn("base-class", isActive && "text-primary", className)}
  ```

---

*Convention analysis: 2026-04-29*
