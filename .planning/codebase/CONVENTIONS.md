# Coding Conventions

**Analysis Date:** 2026-04-21

## Naming Patterns

**Files:**
- **kebab-case** for all source files — no exceptions.
  - `src/components/compare/session-colors.ts`
  - `src/components/compare/week-overview.tsx`
  - `src/components/layout/app-nav.tsx`
  - `src/components/search/copy-for-parent-drawer.tsx`
- **`.tsx`** — React components (JSX-bearing).
- **`.ts`** — logic, types, utilities, pure modules (`src/lib/**/*`, `src/components/compare/session-colors.ts`).
- **Singular** names for canonical modules: `schema.ts`, `types.ts`, `client.ts`, `engine.ts`, `compare.ts`, `parser.ts`.
- **Test files**: `{module}.test.ts` colocated inside a sibling `__tests__/` directory (e.g. `src/lib/normalization/__tests__/identity.test.ts`).

**Functions (camelCase, verb-prefixed):**
- `get*` — synchronous accessor/getter: `getDb()`, `getEnv()`, `getBaseName()`, `getCurrentMonday()`, `getLocalWeekday()`, `getCurrentIndex()`, `getFilterOptions()`, `getTutorList()`.
- `is*` / `has*` — boolean: `isBlockingStatus()`, `isOnlineVariant()`.
- `make*` / `create*` — factory: `createDb()`, `createWiseClient()`, `makeClient()`, `makeTutor()`, `makeIndex()`.
- `parse*` / `normalize*` — transform: `parseTimeToMinutes()`, `parseMondayDate()`, `parseSlotInput()`, `normalizeWorkingHours()`, `normalizeSessions()`, `deduplicateWindows()`.
- `fetch*` — remote data: `fetchAllTeachers()`, `fetchTeacherAvailability()`, `fetchAllFutureSessions()`.
- `extract*` — substring/field pull: `extractNickname()`.
- `resolve*` / `detect*` / `build*` / `execute*` — domain verbs: `resolveIdentities()`, `resolveSessionModality()`, `detectConflicts()`, `detectSessionModalityConflict()`, `buildCompareTutor()`, `executeSearch()`, `findSharedFreeSlots()`.
- `ensure*` — lazy init with side-effect: `ensureIndex(db)`.

**Variables:**
- **camelCase** for locals and object properties: `snapshotMeta`, `tutorGroupIds`, `sessionBlocks`, `dateRange`, `allCompareTutors`.
- **UPPER_SNAKE_CASE** for module-level constants: `TUTOR_COLORS`, `HOUR_HEIGHT`, `START_HOUR`, `END_HOUR`, `DAY_NAMES`, `DISPLAY_DAYS`, `NAV_ITEMS`, `NON_BLOCKING_STATUSES`, `ONLINE_SESSION_TYPES`, `ONSITE_SESSION_TYPES`, `TIMEZONE`, `DAY_OPTIONS`, `DURATION_OPTIONS`, `BLOCKED`.
- **globalThis singletons** prefixed with project slug and double underscore: `globalThis.__bgscheduler_db`, `globalThis.__bgscheduler_searchIndex`, `globalThis.__bgscheduler_searchIndexBuildPromise` (see `src/lib/db/index.ts`, `src/lib/search/index.ts`).

**Types/Interfaces (PascalCase):**
- Plain types: `SearchRequest`, `SearchMode`, `CompareTutor`, `CompareResponse`, `DateRange`.
- **`Wise` prefix** for Wise API response shapes (`src/lib/wise/types.ts`): `WiseTeacher`, `WiseSession`, `WiseWorkingHourSlot`, `WiseClientConfig`.
- **`Indexed` prefix** for in-memory search index shapes (`src/lib/search/index.ts`): `IndexedTutorGroup`, `IndexedSessionBlock`, `IndexedAvailabilityWindow`, `IndexedLeave`, `IndexedDataIssue`, `IndexedWiseRecord`, `IndexedQualification`.
- **`Normalized` prefix** for normalization pipeline outputs: `NormalizedSessionBlock`.
- `interface` for object shapes that may be extended; `type` for unions/aliases:
  ```ts
  export type SearchMode = "recurring" | "one_time";
  export interface SearchIndex { snapshotId: string; builtAt: Date; ... }
  ```

**Database (Drizzle / Postgres):**
- **snake_case** table and column names in SQL: `tutor_identity_groups`, `snapshot_id`, `created_at`, `started_at`, `promoted_snapshot_id`.
- **camelCase** for Drizzle schema object names (`src/lib/db/schema.ts`): `tutorIdentityGroups`, `snapshots`, `syncRuns`, `adminUsers`, `dataIssueTypeEnum`.
- Enums defined with Drizzle `pgEnum` (not TypeScript `enum`): `syncStatusEnum`, `dataIssueTypeEnum`, `dataIssueSeverityEnum`, `modalityEnum`.

## Code Style

**Formatting:**
- **No `.prettierrc`** — relies on editor defaults.
- 2-space indentation throughout.
- Double quotes for strings in app code (`"use client"`, `"Invalid JSON"`); shadcn/ui files in `src/components/ui/` sometimes omit semicolons (imported verbatim from the library).
- Trailing commas in multi-line objects/arrays.
- Template literals for interpolation: `` `Wise API ${response.status}: ${text} (${url})` ``.

**Linting:**
- ESLint 9 with flat config at `eslint.config.mjs`.
- Extends `eslint-config-next/core-web-vitals` + `eslint-config-next/typescript` — no custom rules layered on top:
  ```ts
  const eslintConfig = defineConfig([
    ...nextVitals,
    ...nextTs,
    globalIgnores([".next/**", "out/**", "build/**", "next-env.d.ts"]),
  ]);
  ```
- `no-var` disabled per-line only for `declare global { var __bgscheduler_* }` singleton declarations.

**TypeScript:**
- `"strict": true` in `tsconfig.json`.
- `"target": "ES2017"`, `"module": "esnext"`, `"moduleResolution": "bundler"`.
- `"jsx": "react-jsx"`, `"isolatedModules": true`, `"skipLibCheck": true`.
- Non-null assertions (`!`) used sparingly and only when the invariant is provably true (e.g. `this.queue.shift()!` inside a known-non-empty branch, `byWeekday.get(w.weekday)!.push(t)` after a `.has` check).
- Type narrowing via guard functions: `.filter((g): g is NonNullable<typeof g> => g !== undefined)`.

## Import Organization

**Path alias:** `@/*` → `./src/*`, configured in **both** `tsconfig.json` and `vitest.config.ts` (must stay in sync):
```ts
// vitest.config.ts
resolve: { alias: { "@": path.resolve(__dirname, "./src") } }
```

**Import order (observed across API routes and lib modules):**
1. Node/framework imports (`next/server`, `react`, `next/navigation`).
2. Third-party packages (`zod`, `drizzle-orm`, `date-fns-tz`, `lucide-react`).
3. Internal `@/*` imports — typically grouped auth → db → lib/search → lib/normalization.
4. Sibling/relative imports (`./identity`, `../client`).
5. `import type` for type-only imports, co-located with other imports from the same module or as a separate statement.

Example (`src/app/api/compare/route.ts`):
```ts
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { ensureIndex } from "@/lib/search/index";
import { buildCompareTutor, detectConflicts, findSharedFreeSlots } from "@/lib/search/compare";
import type { DateRange } from "@/lib/search/compare";
import type { CompareResponse, SnapshotMeta } from "@/lib/search/types";
```

## Error Handling

**API route pattern (consistent across all handlers):**
1. **Auth first** — `const session = await auth();` → 401 on miss.
2. **Parse body in try/catch** — 400 on JSON parse failure.
3. **Zod `.safeParse()`** — 400 with `flatten()` details on validation failure.
4. **Wrap business logic in try/catch** — 500 with `err instanceof Error ? err.message : "<operation> failed"` fallback.

Canonical example (`src/app/api/compare/route.ts`):
```ts
export async function POST(request: NextRequest) {
  const session = await auth();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const parsed = compareRequestSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid request", details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  try {
    // ... business logic ...
    return NextResponse.json(response);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Compare failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
```

**Cron endpoint** (`src/app/api/internal/sync-wise/route.ts`) deviates — uses bearer-token check against `CRON_SECRET` instead of session auth, and shares handler between GET (Vercel cron) and POST (manual curl):
```ts
const authHeader = request.headers.get("authorization");
if (!cronSecret || authHeader !== `Bearer ${cronSecret}`) {
  return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
}
```

**Fail-closed domain rules** (non-negotiable per `AGENTS.md`):
- Unknown session `meetingStatus` → treated as **blocking** (`src/lib/normalization/sessions.ts:36-41`):
  ```ts
  export function isBlockingStatus(status: string | undefined): boolean {
    if (!status) return true; // fail-closed
    const upper = status.toUpperCase();
    if (NON_BLOCKING_STATUSES.has(upper)) return false;
    return true; // Unknown statuses remain blocking (fail-closed)
  }
  ```
- Unresolved identity/modality/qualification → routed to **Needs Review**, never **Available**.
- Cancelled sessions (`CANCELLED`, `CANCELED`, `COMPLETED`, `MISSED`, `NO_SHOW`) → non-blocking.
- Contradictions between `sessionType` and `isOnlineVariant` → `modality: "unknown"`, `confidence: "low"` (see `src/lib/search/compare.ts:27-60`).

**Retry/backoff** (`src/lib/wise/client.ts`):
- Exponential backoff: 1s, 2s, 4s (configurable via `maxRetries`, default 3).
- Concurrency limiter: 5 default, 15 for production sync.
- Errors re-thrown after `maxRetries` exhausted.

**Missing env vars** throw at module load via `src/lib/env.ts` (Zod `.safeParse()` → `throw new Error("Invalid environment variables")`).

## Validation

**Zod at every API boundary:**
- Schema defined as `const` at module scope, above the handler, named `{operation}RequestSchema`.
- Always `.safeParse()`, never `.parse()` (which would throw).
- Inline regex for shape-constrained strings: `.regex(/^\d{2}:\d{2}$/)` for HH:mm times.
- `.min()` / `.max()` enum-like bounds for ids and weekdays.

Example (`src/app/api/search/route.ts`):
```ts
const searchRequestSchema = z.object({
  searchMode: z.enum(["recurring", "one_time"]),
  slots: z.array(
    z.object({
      id: z.string(),
      dayOfWeek: z.number().min(0).max(6).optional(),
      date: z.string().optional(),
      start: z.string().regex(/^\d{2}:\d{2}$/),
      end: z.string().regex(/^\d{2}:\d{2}$/),
      mode: z.enum(["online", "onsite", "either"]),
    })
  ).min(1),
  filters: z.object({ subject: z.string().optional(), ... }).optional(),
});
```

**Environment variables** — centralized at `src/lib/env.ts`, validated once at startup:
```ts
const envSchema = z.object({
  DATABASE_URL: z.string().url(),
  AUTH_GOOGLE_ID: z.string().min(1),
  // ... 7 more required vars ...
  WISE_NAMESPACE: z.string().default("begifted-education"),
  WISE_INSTITUTE_ID: z.string().default("696e1f4d90102225641cc413"),
});
export const env = getEnv();
```

## Logging

- **`console.error()`** for validation failures and caught errors (`src/lib/env.ts:20`):
  ```ts
  console.error("Invalid environment variables:", parsed.error.flatten().fieldErrors);
  ```
- **No request-logging middleware.** Only the auth middleware at `src/middleware.ts`.
- Sync orchestrator (`src/lib/sync/orchestrator.ts`) logs pipeline progress via `console.log` / `console.error`.
- No structured logging library (no winston/pino/bunyan). Production logs flow through Vercel runtime.

## Comments

- **JSDoc `/** */`** for exported public functions with a one-line description:
  ```ts
  /** Get or create the DB singleton (survives HMR in dev). */
  export function getDb(): DbInstance { ... }

  /**
   * Convert a UTC ISO string or Date to a Date in Asia/Bangkok timezone.
   */
  export function toLocalTime(utcDateOrString: Date | string): Date { ... }
  ```
- **Section headers** using Unicode box-drawing decorations, placed between top-level declarations:
  ```ts
  // ── Enums ──────────────────────────────────────────────────────────────
  // ── globalThis-anchored singleton (survives HMR in dev) ────────────
  // ---------------------------------------------------------------------------
  // Free-gap computation — subtract sessions from availability windows
  // ---------------------------------------------------------------------------
  ```
- **Inline comments** for non-obvious logic: `// shift to Monday`, `// fail-closed`, `// 0=Sun`, `// 09:00 Bangkok`.
- **Type-field comments** on interface properties where semantics matter: `dayOfWeek?: number; // 0=Sunday..6=Saturday`.
- Phase/decision references in tests and multi-branch logic: `// MOD-01`, `// (AGENTS.md:146-149 / D-01 / D-05)`, `// D-21`, `// D-22` — used to link code back to planning documents in `.planning/phases/`.

## Function Design

- **Destructured object params** when a function takes 3+ inputs; primitive lists for 1–2.
- **Optional params** via `?` on interfaces or default values in signatures: `staleThresholdMs: number = 35 * 60 * 1000`.
- **Factory functions** accept a config object (`WiseClientConfig`) rather than positional args.
- **Return shape for pipelines** — tuple-like `{ result, issues }` / `{ groups, issues }` / `{ modality, issue }` so callers can handle partial failures without exceptions:
  ```ts
  resolveIdentities(teachers, aliases) -> { groups, issues }
  resolveSessionModality(tutor, block) -> { modality, confidence, contradiction? }
  normalizeQualifications(tags) -> { qualifications, issues }
  ```
- **Nullable returns** use `| null`, not `undefined`: `extractNickname() -> string | null`.
- Small pure helpers defined above the component/handler in the same file when used only there (e.g. `getCurrentMonday`, `parseMondayDate`, `addDays`, `formatIsoDate` inside `src/app/api/compare/route.ts`).

## Module Design

- **Named exports only.** Default exports reserved for Next.js page/layout components that the framework requires:
  ```ts
  export default function SearchPage() { ... }       // src/app/(app)/search/page.tsx
  export default async function RootLayout(...)      // src/app/layout.tsx
  ```
- No barrel files (no `src/lib/index.ts` re-exporting subtrees). Consumers import directly from the specific file.
- Types re-exported from a central `types.ts` per domain (`src/lib/search/types.ts`, `src/lib/wise/types.ts`).
- **Lazy init singleton pattern** — anchored on `globalThis` so the instance survives Next.js dev HMR:
  ```ts
  // src/lib/db/index.ts
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
- Same pattern in `src/lib/search/index.ts` (`__bgscheduler_searchIndex`, `__bgscheduler_searchIndexBuildPromise`) with `ensureIndex(db)` checking staleness and rebuilding when the active snapshot changes.

## Component Patterns

**Location:**
- `src/components/ui/` — primitives (shadcn/ui + @base-ui/react wrappers). Tone/style typically uses CVA variants.
- `src/components/{feature}/` — feature components (`compare/`, `search/`, `data-health/`, `layout/`, `skeletons/`).

**Primitives (shadcn/ui style):**
- Wrap `@base-ui/react` primitives with `cva(...)` for variant styling.
- Merge classes with `cn()` from `src/lib/utils.ts`:
  ```ts
  import { clsx, type ClassValue } from "clsx"
  import { twMerge } from "tailwind-merge"
  export function cn(...inputs: ClassValue[]) {
    return twMerge(clsx(inputs))
  }
  ```
- Export both the component and the variant builder: `export { Button, buttonVariants }`, `export { Badge, badgeVariants }`.
- Variants object typed via `VariantProps<typeof buttonVariants>`; sensible `defaultVariants` always declared.

**Feature components:**
- `"use client";` directive at the top of any interactive component (hooks, event handlers, `usePathname`, `useSearchParams`).
- Props typed via inline `interface` above the component, or imported from a sibling types module.
- Constants defined at module scope **above** the component (never inside — would re-allocate each render):
  ```ts
  const HOUR_HEIGHT = 48;
  const START_HOUR = 7;
  const DISPLAY_DAYS = [1, 2, 3, 4, 5, 6, 0]; // Mon-Sun
  const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  ```
- Pure helpers (e.g. `minuteToY`, `computeFreeGaps`, `formatClassType`) defined in the same file above the component export.
- Feature components compose UI primitives: `<Button>`, `<Popover>`, `<Command>`, `<Dialog>`, `<Badge>` from `@/components/ui/*`.

**Pages:**
- Server component by default. When `useSearchParams` is needed, wrap the inner client component in `<Suspense fallback={...}>`:
  ```tsx
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

**State management:**
- React built-ins only (`useState`, `useCallback`, `useEffect`, `useRef`, `useMemo`). No Redux/Zustand/Jotai.
- Client caches (e.g. tutor cache in compare view) via `useRef<Map<string, CompareTutor>>` keyed `tutorGroupId:weekStart`.
- Persistent client state in `localStorage` only for recent searches (last 10).

## Styling

- **Tailwind CSS 4** via `@tailwindcss/postcss` (see `postcss.config.mjs`).
- **Utility classes inline** on JSX elements. No CSS modules, no styled-components.
- **Semantic color tokens** exposed as CSS custom properties and consumed through Tailwind utility names: `bg-available`, `bg-blocked`, `text-conflict`, `bg-free-slot`, `text-primary`, `text-muted-foreground`, `border-border`, `bg-card`.
- **Palette**: OKLCH-defined (sky blue hue 230 primary, amber hue 75 accent, cream bg). Tutor lane colors come from a shared constant:
  ```ts
  // src/components/compare/session-colors.ts
  export const TUTOR_COLORS = ["#3b82f6", "#e67e22", "#7c3aed"];
  ```
- **Shared color logic** lives in dedicated `.ts` modules next to the components that use it (`session-colors.ts`, `modality-display.ts`) — pure helpers return RGBA/hex strings consumed by inline `style={{ backgroundColor: ... }}` where dynamic per-tutor coloring is needed.
- **CVA variants** for primitive styling (`src/components/ui/button.tsx`, `src/components/ui/badge.tsx`):
  ```ts
  const buttonVariants = cva(
    "group/button inline-flex ... focus-visible:border-ring ...",
    { variants: { variant: { default: "bg-primary ...", outline: "...", ghost: "..." }, size: {...} },
      defaultVariants: { variant: "default", size: "default" } }
  );
  ```
- **Conditional classes** via template literals for simple cases, via `cn()` when merging Tailwind overrides:
  ```tsx
  className={`px-3 py-1.5 text-sm rounded-md transition-colors ${
    isActive ? "text-primary font-medium bg-primary/10" : "text-muted-foreground hover:text-foreground hover:bg-muted"
  }`}
  ```
- **Dark mode** supported via `dark:` variants scattered through primitives.

---

*Convention analysis: 2026-04-21*
