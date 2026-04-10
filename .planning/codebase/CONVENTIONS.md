# Coding Conventions

**Analysis Date:** 2026-04-10

## Naming Patterns

**Files:**
- kebab-case for all files: `session-colors.ts`, `week-overview.tsx`, `app-nav.tsx`, `copy-button.tsx`
- React components use `.tsx`, logic/types use `.ts`
- Test files: `{module}.test.ts` inside `__tests__/` directories
- Schema file: `schema.ts` (singular)
- Type definition files: `types.ts` (per module)

**Functions:**
- camelCase for all functions: `executeSearch`, `buildCompareTutor`, `detectConflicts`, `normalizeWorkingHours`
- Prefix `get` for getters: `getDb()`, `getEnv()`, `getBaseName()`, `getWiseTeacherDisplayName()`
- Prefix `is`/`has` for boolean returns: `isBlockingStatus()`, `isOnlineVariant()`
- Prefix `make`/`create` for factory functions: `createWiseClient()`, `createDb()`
- Prefix `parse`/`normalize` for data transformation: `parseTimeToMinutes()`, `normalizeLeaves()`, `normalizeTag()`
- Prefix `fetch` for API calls: `fetchAllTeachers()`, `fetchAllFutureSessions()`

**Variables:**
- camelCase: `snapshotMeta`, `tutorGroupIds`, `sessionBlocks`
- UPPER_SNAKE_CASE for constants: `TUTOR_COLORS`, `HOUR_HEIGHT`, `DAY_NAMES`, `DISPLAY_DAYS`, `ONLINE_SESSION_TYPES`
- Prefix `_` for module-level singletons: `let _db`, `let _cachedIndex`

**Types/Interfaces:**
- PascalCase: `SearchRequest`, `CompareTutor`, `IndexedTutorGroup`
- Prefix `Wise` for external API types: `WiseTeacher`, `WiseSession`, `WiseAvailabilityResponse`
- Prefix `Indexed` for in-memory index types: `IndexedTutorGroup`, `IndexedSessionBlock`
- Prefix `Normalized` for pipeline output types: `NormalizedSessionBlock`
- Use `interface` for object shapes, `type` for unions/aliases: `type SearchMode = "recurring" | "one_time"`, `type WiseTag = string | WiseTagObject`
- Enums defined via Drizzle `pgEnum`, not TypeScript `enum`

**Database:**
- snake_case for table/column names: `tutor_identity_groups`, `snapshot_id`, `created_at`
- camelCase for Drizzle schema object names: `tutorIdentityGroups`, `snapshotId`

## Code Style

**Formatting:**
- No dedicated formatter config (no `.prettierrc`). Relies on editor defaults.
- 2-space indentation
- Double quotes for strings in most files; some shadcn/ui components omit semicolons
- Trailing commas in multi-line structures
- Template literals for string interpolation

**Linting:**
- ESLint 9 with flat config at `eslint.config.mjs`
- Extends `eslint-config-next/core-web-vitals` and `eslint-config-next/typescript`
- No custom rules added beyond Next.js defaults

**TypeScript:**
- `strict: true` in `tsconfig.json`
- Target ES2017, module esnext, bundler resolution
- Non-null assertions used sparingly (e.g., `this.queue.shift()!`)
- Path alias: `@/*` maps to `./src/*`

## Import Organization

**Order:**
1. External packages (`next/server`, `zod`, `drizzle-orm`, `react`, `next/font/google`)
2. Internal absolute imports via `@/` alias (`@/lib/db`, `@/components/ui/button`)
3. Relative imports for same-module files (`./index`, `./types`, `../identity`)
4. Type-only imports use `import type` syntax: `import type { SearchRequest } from "../types"`

**Path Aliases:**
- `@/*` -> `./src/*` (configured in both `tsconfig.json` and `vitest.config.ts`)

**Pattern:**
```typescript
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { ensureIndex } from "@/lib/search/index";
import type { CompareResponse, SnapshotMeta } from "@/lib/search/types";
```

## Error Handling

**API Routes:**
- Auth check first, return 401 if unauthorized
- Parse JSON body in try/catch, return 400 for invalid JSON
- Validate with Zod `.safeParse()`, return 400 with flattened errors on failure
- Wrap business logic in try/catch, return 500 with error message
- Pattern: `const message = err instanceof Error ? err.message : "Compare failed"`

```typescript
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
    const message = err instanceof Error ? err.message : "Operation failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
```

**Fail-Closed Strategy:**
- Unknown session status -> blocking (safe default)
- Unresolved identity/modality/qualification -> route to "Needs Review", never "Available"
- Missing env vars -> throw at startup via Zod validation in `src/lib/env.ts`

**HTTP Client (WiseClient):**
- Retry with exponential backoff: 1s, 2s, 4s (configurable `maxRetries`)
- Concurrency limiter (max 5 default, 15 for production sync)
- Errors re-thrown after max retries exhausted

## Validation

**Request Validation:**
- Use Zod schemas at API route boundaries
- Schema defined as `const` at module scope, above the handler
- Transform strings to numbers where needed: `.transform(Number)`
- `.safeParse()` pattern (never `.parse()` which throws)

**Environment Validation:**
- Centralized in `src/lib/env.ts` using Zod schema
- Validates all 9 required env vars at startup
- Defaults provided for `WISE_NAMESPACE` and `WISE_INSTITUTE_ID`

## Logging

**Framework:** `console` (no structured logging library)

**Patterns:**
- `console.error()` for validation failures and caught errors
- No request logging middleware
- Sync orchestrator likely logs progress (not examined in detail)

## Comments

**When to Comment:**
- JSDoc `/** */` for exported public functions with brief description
- Section headers using `// -- Section Name --` pattern with em-dash decorations
- Inline comments for non-obvious logic (e.g., `// shift to Monday`, `// fail-closed`)
- Type comments on interface fields: `dayOfWeek?: number; // 0=Sunday..6=Saturday`

**Section Header Pattern:**
```typescript
// -- Enums --
// -- Snapshots & Sync --
// -- Search request/response types --
// -- Compare types --
```

## Function Design

**Size:** Functions are generally compact (10-40 lines). Larger functions exist in orchestrator and page components.

**Parameters:**
- Use destructured objects for 3+ params
- Optional params via `?` property or default values: `staleThresholdMs: number = 35 * 60 * 1000`
- Factory functions accept config objects: `WiseClientConfig`

**Return Values:**
- Return typed objects, never raw primitives for complex operations
- Tuples of `{ result, issues }` for normalization functions: `{ modality, issue }`, `{ qualifications, issues }`
- Nullable returns use `| null` (not undefined): `extractNickname() -> string | null`

## Module Design

**Exports:**
- Named exports only (no default exports except page components)
- Page components: `export default function SearchPage()`
- Re-export types from central `types.ts` files
- Helper functions exported individually, not via barrel

**Barrel Files:**
- Not used. Each module imports directly from the specific file.

**Singletons:**
- Lazy initialization pattern for DB and search index
- Module-level `let _db` with `getDb()` accessor
- `ensureIndex(db)` checks staleness and rebuilds if needed

## Component Patterns

**UI Components (shadcn/ui):**
- Located in `src/components/ui/`
- Use `class-variance-authority` (CVA) for variant styling
- Use `cn()` utility from `src/lib/utils.ts` for class merging
- Wrap `@base-ui/react` primitives with project styling
- Export both component and variants: `export { Button, buttonVariants }`

**Feature Components:**
- Located in `src/components/{feature}/` (e.g., `compare/`, `search/`, `layout/`)
- `"use client"` directive at top of interactive components
- Props typed inline or via imported interfaces
- Constants defined above component (e.g., `HOUR_HEIGHT`, `START_HOUR`)
- Helper functions defined in same file above component

**Page Components:**
- `"use client"` with Suspense wrapper for pages using `useSearchParams`
- Inner component pattern: `SearchPage` wraps `SearchPageInner` in Suspense
- State management via `useState`/`useCallback`/`useRef` hooks
- No external state management library

**Styling:**
- Tailwind CSS 4 utility classes inline
- Semantic color tokens via CSS custom properties: `--available`, `--blocked`, `--conflict`
- OKLCH color space for palette definition
- Template literal for conditional classes: `` `${isActive ? "text-primary" : "text-muted-foreground"}` ``
- Shared color logic in dedicated modules: `src/components/compare/session-colors.ts`

---

*Convention analysis: 2026-04-10*
