# Conventions

This page captures the handbook-level conventions you need before touching code. It is intentionally short. **The exhaustive, file:line-cited reference lives in the GSD source:**

> [`.planning/codebase/CONVENTIONS.md`](../../.planning/codebase/CONVENTIONS.md) — full breakdown of naming, imports, error handling, validation, logging, comments, function/module/component patterns.

This page does **not** fork that document; it summarizes the load-bearing rules and links back. When the two disagree, trust the code — every claim below was re-verified against HEAD.

> Note: the GSD source is a point-in-time snapshot and predates the newer route families (`line/*`, `sales-dashboard/*`, `tutor-profiles/*`, `student-promotions/*`, and the in-flight `progress-tests/*`). Its naming and style rules still hold across those modules, but treat its counts and "always/never" absolutes as approximate — the exceptions that matter are noted below.

---

## The seven rules that matter

| Rule | What it means | Verify at |
| --- | --- | --- |
| **kebab-case files** | Every source file is kebab-case: `session-colors.ts`, `week-overview.tsx`, `past-sessions.ts`. `.tsx` for components, `.ts` for logic/types. Tests live in a sibling `__tests__/` dir as `{module}.test.ts` — never colocated. | repo-wide (zero non-kebab source files outside the generated `components/ui/` primitives) |
| **Named exports only** | No default exports anywhere except Next.js framework files (`page.tsx`, `route.ts`, `layout.tsx`, `middleware.ts`). No barrel files — import from the specific module. | `src/lib`/`src/components`: zero default exports; the only 22 default exports are framework files under `src/app` |
| **Zod at route boundaries** | Mutating API routes validate the parsed body against a module-scope Zod schema *before* any business logic runs. | `src/app/api/compare/route.ts:24-31` |
| **Fail-closed defaults** | Unresolved identity/modality/qualification → "Needs Review", never "Available". Unknown session status → blocking. Cancelled → non-blocking. Never guess. | `src/lib/normalization/sessions.ts:46-51`, `src/lib/search/engine.ts:85-146` |
| **Asia/Bangkok time** | All time math goes through the `TIMEZONE = "Asia/Bangkok"` constant and `date-fns-tz`. Never use the server's local zone (Vercel runs UTC). | `src/lib/normalization/timezone.ts:3`, referenced in ~37 non-test files |
| **Lazy DB singleton** | `getDb()` lazily constructs the Neon client once and pins it to `globalThis` so it survives Next.js HMR in dev. | `src/lib/db/index.ts:22-27` |
| **Lazy index singleton** | `ensureIndex()` returns the in-memory `SearchIndex` singleton, rebuilding only when the active snapshot id or tutor-profile version changes. | `src/lib/search/index.ts:354-401` |

The rest of this page expands the four non-obvious rules. For everything else (variable casing, comment style, component patterns, function-design heuristics, the full import-order rule), go straight to the GSD source.

---

## Zod at route boundaries

Schemas are declared as `const` at module scope, above the handler. The canonical route shape — auth → JSON parse → validate → business logic, each step returning its own status — is documented in the GSD source. The dominant validation idiom is `.safeParse()` returning a `400` with `parsed.error.flatten()`:

```typescript
// src/app/api/compare/route.ts:24-31
const compareRequestSchema = z.object({
  tutorGroupIds: z.array(z.string()).min(1).max(3),
  mode: z.enum(["recurring", "one_time"]),
  dayOfWeek: z.number().min(0).max(6).optional(),
  date: z.string().optional(),
  weekStart: z.string().optional(),
  fetchOnly: z.array(z.string()).optional(),
});
```

`.safeParse()` is the norm across `compare`, `search`, `search/range`, `class-assignments/*`, `tutor-profiles/*`, and the `line/*` routes. Zod is also used to validate **external** payloads crossing into the system (e.g. the credit-control Wise client parses Wise responses before use), not just request bodies.

**Documented exception (not a bug):** the `sales-dashboard/*` routes call `.parse()` (which throws) *inside* a `try/catch` that returns `400` with the extracted message — e.g. `src/app/api/sales-dashboard/sources/route.ts:40` parses, and the catch at `:48-50` funnels the thrown Zod error into a `400`. This is a valid alternative that routes Zod failures through the same catch as other errors; it does **not** leak a `500`. Prefer `.safeParse()` for new routes to keep the discriminated-error pattern, but recognize both when reading the code.

Environment variables are validated the same way at module load via Zod in `src/lib/env.ts`. Unlike a request boundary, a bad env **fails the process** rather than degrading: on failure it logs only `parsed.error.flatten().fieldErrors` (never the values) and throws (`src/lib/env.ts:20-26`). See [reference/env.md](../reference/env.md) for the variable list.

For the complete route skeleton, HTTP status conventions (401/400/404/500), the `err instanceof Error ? err.message : "<default>"` extraction idiom, and the constant-time `CRON_SECRET` comparison used on internal cron routes (REL-07), see the GSD source's *Error Handling* and *Validation* sections.

---

## Fail-closed defaults

The non-negotiable product rule (never show a tutor as available without proof) is enforced mechanically in two places.

**1. Session blocking — unknown status blocks.** Only an explicit allowlist of statuses is non-blocking; everything else (including `undefined`) blocks.

```typescript
// src/lib/normalization/sessions.ts:46-51
export function isBlockingStatus(status: string | undefined): boolean {
  if (!status) return true; // fail-closed
  const upper = status.toUpperCase();
  if (NON_BLOCKING_STATUSES.has(upper)) return false;
  return true; // Unknown statuses remain blocking (fail-closed)
}
```

The non-blocking set is `CANCELLED, CANCELED, COMPLETED, MISSED, NO_SHOW` (`src/lib/normalization/sessions.ts:34-40`).

**2. Search engine — unresolved data routes to "Needs Review", never silently dropped.** A tutor group with any data issue, or with no resolved modality, accumulates `reviewReasons`; at the end of the per-group loop a non-empty `reviewReasons` lands the group in `needsReview` instead of `available` (`src/lib/search/engine.ts:142-146`):

```mermaid
flowchart TD
  G["Tutor group (per slot)"] --> DI{"dataIssues > 0?"}
  DI -- yes --> RR["push to reviewReasons"]
  DI -- no --> MOD
  RR --> MOD{"supportedModes empty?"}
  MOD -- yes --> RR2["reviewReasons += 'Unresolved modality'"]
  MOD -- no --> WIN{"availability window<br/>covers slot?"}
  RR2 --> WIN
  WIN -- no --> SKIP["skip group"]
  WIN -- yes --> BLK{"blocked by session<br/>or leave?"}
  BLK -- yes --> SKIP
  BLK -- no --> OUT{"reviewReasons empty?"}
  OUT -- yes --> AVAIL["Available"]
  OUT -- no --> REVIEW["Needs Review"]
```

See `src/lib/search/engine.ts:80-146`. The *meaning* and product rationale of these rules live in the feature docs ([Tutor Search](../features/tutor-search.md), [Tutor Compare](../features/tutor-compare.md)); this page only records that they are conventions you must not weaken without explicit approval (per AGENTS.md change-control).

---

## Asia/Bangkok time

There is exactly one timezone constant and it is the single source of truth:

```typescript
// src/lib/normalization/timezone.ts:3
export const TIMEZONE = "Asia/Bangkok";
```

All UTC→local conversion, weekday derivation, and minute-of-day computation go through `toLocalTime` / `getLocalWeekday` / `getLocalMinuteOfDay` in that module, which wrap `date-fns-tz`'s `toZonedTime` (`src/lib/normalization/timezone.ts:8-26`). Route-level "now in Bangkok" math (e.g. the current-Monday calc for the compare week picker) also imports `TIMEZONE` rather than hardcoding the string — see `getCurrentMonday()` at `src/app/api/compare/route.ts:34-41` (commented `REL-08`). Never call `new Date().getDay()` against the server clock; the server runs UTC.

---

## Lazy singletons (DB + search index)

Both heavy server resources are lazily constructed and pinned to `globalThis` so they survive Next.js Hot Module Replacement in development — a fresh module evaluation per edit would otherwise leak Neon connections or rebuild the in-memory index repeatedly. This `globalThis` namespace is the **only** module-singleton mechanism in the codebase; there is no `let _db` / `let _cachedIndex` style anywhere.

**DB** — construct once, reuse forever:

```typescript
// src/lib/db/index.ts:22-27
export function getDb(): DbInstance {
  if (!globalThis.__bgscheduler_db) {
    globalThis.__bgscheduler_db = createDb();
  }
  return globalThis.__bgscheduler_db;
}
```

**Search index** — the in-memory `SearchIndex` is the whole active snapshot loaded into RAM; all search/compare queries hit it instead of Postgres. `ensureIndex()` adds two behaviors beyond plain memoization (both on three `globalThis` slots: `__bgscheduler_searchIndex`, plus a build-promise at `__bgscheduler_searchIndexBuildPromise`):

- **Staleness check.** It keeps the cached index only if the active snapshot id *and* the tutor-profile version still match; otherwise it rebuilds (`src/lib/search/index.ts:377-388`).
- **Race coalescing.** The in-flight build promise is assigned to the `globalThis` singleton *synchronously* — before any `await` yields to the microtask queue — so concurrent first-time callers reuse one rebuild instead of each starting their own (`src/lib/search/index.ts:354-400`).

```mermaid
flowchart TD
  C["ensureIndex(db)"] --> IF{"build promise<br/>in flight?"}
  IF -- yes --> RET["return that promise"]
  IF -- no --> CA{"cached index<br/>exists?"}
  CA -- no --> BUILD["buildIndex(db)"]
  CA -- yes --> FRESH{"active snapshot id<br/>+ profileVersion<br/>still match?"}
  FRESH -- yes --> USE["return cached"]
  FRESH -- no --> BUILD
  BUILD --> PIN["pin promise to globalThis<br/>(synchronously)"]
```

`clearSearchIndex()` resets both the cached index and the in-flight promise (`src/lib/search/index.ts:123-126`); it is the hook the sync pipeline calls after promoting a new snapshot.

---

## Quick reminders (see GSD source for detail)

- **No formatter config.** 2-space indent, double quotes, trailing commas, semicolons in `src/lib/**` and `src/app/**`.
- **shadcn/ui primitives omit semicolons** — they are regenerated by the shadcn CLI and follow upstream style. Leave them as-is (e.g. `export { Button, buttonVariants }` with no trailing `;` in `src/components/ui/button.tsx:58`).
- **Pages are async Server Components** that fetch via server-only `src/lib/data/*` helpers and pass props into a `"use client"` shell wrapped in `<Suspense>` with a skeleton (e.g. `export default async function SearchPage()` at `src/app/(app)/search/page.tsx:8`).
- **Path alias `@/*` → `./src/*`**, configured in both `tsconfig.json:21-22` and `vitest.config.ts:8-9` so tests resolve identically.
- **No external state library** on the client — `useState`/`useCallback`/`useRef`/`useEffect` only.
- **No TS `enum`.** Database enums use Drizzle's `pgEnum` (snake_case SQL names, camelCase Drizzle objects), and those declarations double as the source for TS union types.
- **Design-decision IDs are load-bearing** in comments (e.g. `D-04`, `REL-07`, `REL-08`, `MOD-01`, `PAST-01`); they tie code back to the `.planning/` documents — keep them when editing nearby code.

---

_Verified against HEAD `d4fe6d3` on 2026-06-05._
