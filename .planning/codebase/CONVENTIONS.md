# Coding Conventions

**Analysis Date:** 2026-04-16

## File Naming

- **kebab-case** for all files: `session-colors.ts`, `week-overview.tsx`, `app-nav.tsx`, `copy-button.tsx`, `slot-input.tsx`
- React components use `.tsx`, logic/types use `.ts`
- Test files: `{module}.test.ts` inside `__tests__/` directories
- Schema file: `schema.ts` (singular, at `src/lib/db/schema.ts`)
- Type definition files: `types.ts` (per module, e.g. `src/lib/wise/types.ts`, `src/lib/search/types.ts`)
- Skeleton components: `{feature}-skeleton.tsx` in `src/components/skeletons/`

## Function Naming

All functions use **camelCase** with semantic prefixes:

| Prefix | Purpose | Examples |
|--------|---------|----------|
| `get` | Getters / accessors | `getDb()`, `getEnv()`, `getBaseName()`, `getWiseTeacherDisplayName()`, `getSearchIndex()`, `getFilterOptions()`, `getTutorList()` |
| `is` / `has` | Boolean returns | `isBlockingStatus()`, `isOnlineVariant()` |
| `make` / `create` | Factory functions | `createWiseClient()`, `createDb()` |
| `parse` / `normalize` | Data transformation | `parseTimeToMinutes()`, `normalizeLeaves()`, `normalizeTag()`, `normalizeWorkingHours()`, `normalizeSessions()`, `normalizeTeacherTags()` |
| `fetch` | API / network calls | `fetchAllTeachers()`, `fetchAllFutureSessions()`, `fetchTeacherAvailability()` |
| `build` | Complex assembly | `buildCompareTutor()`, `buildIndex()` |
| `detect` / `find` | Analysis / search | `detectConflicts()`, `findSharedFreeSlots()` |
| `ensure` | Lazy init with validation | `ensureIndex()` |
| `derive` | Computed derivation | `deriveModality()` |
| `execute` | Action / operation | `executeSearch()` |
| `extract` | Pull data from structure | `extractNickname()` |
| `resolve` | Multi-step resolution | `resolveIdentities()` |
| `deduplicate` | Merge overlapping data | `deduplicateWindows()`, `deduplicateLeaves()` |
| `compute` | Calculation | `computeFreeGaps()` |
| `format` | String formatting | `formatIsoDate()` |

## Variable Naming

- **camelCase** for local and module-level variables: `snapshotMeta`, `tutorGroupIds`, `sessionBlocks`, `fetchOnlySet`
- **UPPER_SNAKE_CASE** for constants: `TUTOR_COLORS`, `HOUR_HEIGHT`, `DAY_NAMES`, `DISPLAY_DAYS`, `ONLINE_SESSION_TYPES`, `NON_BLOCKING_STATUSES`
- **globalThis** for HMR-safe singletons: `globalThis.__bgscheduler_db`, `globalThis.__bgscheduler_searchIndex`
- **Prefix `_`** for module-level singletons (older pattern): `let _db`, `let _cachedIndex`

## Type Naming

- **PascalCase** for all types and interfaces: `SearchRequest`, `CompareTutor`, `IndexedTutorGroup`
- **Prefix `Wise`** for external API types: `WiseTeacher`, `WiseSession`, `WiseAvailabilityResponse`, `WiseWorkingHourSlot`, `WiseLeave`, `WiseTag`, `WiseTagObject`, `WiseUserReference`
- **Prefix `Indexed`** for in-memory index types: `IndexedTutorGroup`, `IndexedSessionBlock`, `IndexedAvailabilityWindow`, `IndexedLeave`, `IndexedQualification`, `IndexedWiseRecord`, `IndexedDataIssue`
- **Prefix `Normalized`** for pipeline output types: `NormalizedSessionBlock`
- Use **`interface`** for object shapes, **`type`** for unions/aliases:
  ```typescript
  type SearchMode = "recurring" | "one_time";
  type WiseTag = string | WiseTagObject;
  type Modality = "online" | "onsite" | "both" | "unresolved";
  ```
- Enums defined via **Drizzle `pgEnum`**, not TypeScript `enum`
- Helper type aliases for complex generics: `type DbInstance = ReturnType<typeof createDb>`

## Database Naming

- **snake_case** for table and column names: `tutor_identity_groups`, `snapshot_id`, `created_at`, `future_session_blocks`
- **camelCase** for Drizzle schema object names in TypeScript: `tutorIdentityGroups`, `snapshotId`

## Import Organization

Imports follow a consistent order:

1. **External packages** (`next/server`, `zod`, `drizzle-orm`, `react`, `vitest`)
2. **Internal absolute imports** via `@/` alias (`@/lib/db`, `@/components/ui/button`, `@/lib/auth`)
3. **Relative imports** for same-module files (`./index`, `./types`, `../identity`, `./timezone`)
4. **Type-only imports** use `import type` syntax: `import type { SearchRequest } from "../types"`

**Path alias:** `@/*` maps to `./src/*` (configured in both `tsconfig.json` and `vitest.config.ts`)

Canonical example from `src/app/api/compare/route.ts`:
```typescript
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { ensureIndex } from "@/lib/search/index";
import { buildCompareTutor, detectConflicts, findSharedFreeSlots } from "@/lib/search/compare";
import type { DateRange } from "@/lib/search/compare";
import type { CompareResponse, SnapshotMeta } from "@/lib/search/types";
```

**No barrel files.** Each module imports directly from the specific file.

## Error Handling

### API Route Pattern

Every route handler follows this exact sequence:

```typescript
export async function POST(request: NextRequest) {
  // 1. Auth check first
  const session = await auth();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // 2. JSON parsing in try/catch
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  // 3. Zod validation with safeParse
  const parsed = compareRequestSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid request", details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  // 4. Business logic in try/catch
  try {
    // ... logic ...
    return NextResponse.json(response);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Operation failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
```

### Fail-Closed Safety

- Unknown session status -> blocking (safe default). See `isBlockingStatus()` in `src/lib/normalization/sessions.ts`
- Unresolved identity/modality/qualification -> route to "Needs Review", never "Available"
- Missing env vars -> throw at startup via Zod validation in `src/lib/env.ts`
- Completeness threshold: >50% unresolved identity groups prevents snapshot promotion

### HTTP Client Resilience

`WiseClient` in `src/lib/wise/client.ts`:
- Exponential backoff retry: 1s, 2s, 4s (configurable `maxRetries`, default 3)
- Queue-based concurrency limiter (default 5, production sync 15)
- Errors re-thrown after max retries exhausted
- Pattern: `Math.pow(2, attempt) * 1000` for delay calculation

### Normalization Return Pattern

Normalization functions return `{ result, issues }` tuples so callers can collect data issues without exceptions:
```typescript
// src/lib/normalization/modality.ts
function deriveModality(group, sessions): { modality: Modality; issue: ModalityIssue | null }

// src/lib/normalization/qualifications.ts
function normalizeTeacherTags(tags, id, name): { qualifications: [...]; issues: [...] }
```

## Validation

- **Zod schemas** defined as `const` at module scope, above the handler
- Always use **`.safeParse()`** (never `.parse()` which throws)
- Transform strings to numbers where needed: `.transform(Number)`
- Array bounds enforced: `z.array(z.string()).min(1).max(3)`
- Enum validation: `z.enum(["recurring", "one_time"])`
- Environment validation centralized in `src/lib/env.ts` with defaults for optional vars

## Component Patterns

### UI Components (shadcn/ui)

Location: `src/components/ui/`

- Wrap `@base-ui/react` primitives with project styling
- Use `class-variance-authority` (CVA) for variant definitions
- Use `cn()` utility from `src/lib/utils.ts` for class merging (`clsx` + `tailwind-merge`)
- Export both component and variants: `export { Button, buttonVariants }`

```typescript
// src/components/ui/button.tsx
import { Button as ButtonPrimitive } from "@base-ui/react/button"
import { cva, type VariantProps } from "class-variance-authority"
import { cn } from "@/lib/utils"

const buttonVariants = cva("base-classes...", {
  variants: { variant: { default: "...", outline: "..." }, size: { default: "...", sm: "..." } },
  defaultVariants: { variant: "default", size: "default" },
})

function Button({ className, variant, size, ...props }) {
  return <ButtonPrimitive className={cn(buttonVariants({ variant, size, className }))} {...props} />
}

export { Button, buttonVariants }
```

### Feature Components

Location: `src/components/{feature}/` (e.g. `compare/`, `search/`, `layout/`, `skeletons/`)

- `"use client"` directive at top of interactive components
- Props typed inline or via imported interfaces
- Constants defined above component (e.g. `HOUR_HEIGHT`, `START_HOUR`)
- Helper functions defined in same file above component
- Shared color logic in dedicated modules: `src/components/compare/session-colors.ts`

### Page Components

Two patterns used:

**Server Component page (preferred, `src/app/(app)/search/page.tsx`):**
```typescript
import { Suspense } from "react";
import { SearchWorkspace } from "@/components/search/search-workspace";
import { SearchSkeleton } from "@/components/skeletons/search-skeleton";

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

**Client Component with Suspense wrapper (for `useSearchParams`, `src/app/(app)/compare/page.tsx`):**
```typescript
"use client";
import { useSearchParams, useRouter } from "next/navigation";
import { Suspense, useEffect } from "react";

function CompareRedirectInner() {
  const searchParams = useSearchParams();
  const router = useRouter();
  useEffect(() => { /* redirect logic */ }, [searchParams, router]);
  return null;
}

export default function CompareRedirect() {
  return <Suspense><CompareRedirectInner /></Suspense>;
}
```

### State Management

- React hooks only: `useState`, `useCallback`, `useRef`, `useEffect`
- No external state management library
- Client-side tutor cache via `Map<string, CompareTutor>` keyed by `tutorGroupId:weekStart`
- AbortController for request cancellation / race-condition safety
- Recent searches persisted in `localStorage` (last 10)

### Styling

- Tailwind CSS 4 utility classes inline
- Semantic color tokens via CSS custom properties: `--available`, `--blocked`, `--conflict`, `--free-slot`
- OKLCH color space for palette definition
- Template literal for conditional classes: `` `${isActive ? "text-primary" : "text-muted-foreground"}` ``
- Tutor colors: `TUTOR_COLORS = ["#3b82f6", "#e67e22", "#7c3aed"]` (sky blue, amber, purple)

## Module Design

### Exports

- **Named exports only** (no default exports except page components)
- Page components: `export default function SearchPage()` or `export default async function SearchPage()`
- Re-export types from central `types.ts` files
- Helper functions exported individually, not via barrel

### Singletons

HMR-safe singleton pattern using `globalThis`:

```typescript
// src/lib/db/index.ts
declare global {
  var __bgscheduler_db: DbInstance | undefined;
}

export function getDb(): DbInstance {
  if (!globalThis.__bgscheduler_db) {
    globalThis.__bgscheduler_db = createDb();
  }
  return globalThis.__bgscheduler_db;
}
```

Same pattern used for the search index in `src/lib/search/index.ts`.

### Lazy Initialization

- `ensureIndex(db)` checks active snapshot on every call
- Stale detection compares index `snapshotId` against DB
- Build promise deduplication prevents concurrent rebuilds

## Code Style

- **2-space indentation** throughout
- **Double quotes** for strings in most files; some shadcn/ui components omit semicolons
- **Trailing commas** in multi-line structures
- **Template literals** for string interpolation
- **No dedicated formatter** (no `.prettierrc`); relies on editor defaults
- **ESLint 9** flat config: `eslint-config-next/core-web-vitals` + `eslint-config-next/typescript`
- **TypeScript strict mode** enabled: `strict: true` in `tsconfig.json`
- **Target:** ES2017, module esnext, bundler resolution
- **Non-null assertions** used sparingly (e.g. `this.queue.shift()!`)

## Comments

- **JSDoc `/** */`** for exported public functions with brief description
- **Section headers** using `// -- Section Name --` pattern with em-dash decorations (in `types.ts`, `schema.ts`)
- **Inline comments** for non-obvious logic (e.g. `// shift to Monday`, `// fail-closed`)
- **Type comments** on interface fields: `dayOfWeek?: number; // 0=Sunday..6=Saturday`
- **Step comments** in multi-step algorithms: `// Step 1: Extract canonical keys`, `// Step 2: Check alias table`

## Function Design

- Functions are compact (10-40 lines). Larger functions exist in orchestrator and page components.
- Use destructured objects for 3+ params
- Optional params via `?` property or default values: `staleThresholdMs: number = 35 * 60 * 1000`
- Factory functions accept config objects: `WiseClientConfig`
- Return typed objects, never raw primitives for complex operations
- Nullable returns use `| null` (not undefined): `extractNickname() -> string | null`
- Higher-order function parameters for extensibility: `teacherIdResolver: (session: WiseSession) => string | null`

## Key File Paths

| Pattern | Location |
|---------|----------|
| UI components | `src/components/ui/` |
| Feature components | `src/components/{feature}/` |
| Skeleton components | `src/components/skeletons/` |
| API routes | `src/app/api/` |
| Pages | `src/app/(app)/` |
| Normalization modules | `src/lib/normalization/` |
| Search / Compare engine | `src/lib/search/` |
| Wise API client | `src/lib/wise/` |
| DB schema + singleton | `src/lib/db/` |
| Sync orchestrator | `src/lib/sync/orchestrator.ts` |
| Env validation | `src/lib/env.ts` |
| Utility functions | `src/lib/utils.ts` |

---

*Convention analysis: 2026-04-16 (updated from 2026-04-10)*
