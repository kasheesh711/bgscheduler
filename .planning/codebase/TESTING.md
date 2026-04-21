# Testing Patterns

**Analysis Date:** 2026-04-21

## Test Framework

**Runner:**
- **Vitest ^4.1.2** — single test runner for the whole repo.
- Config: `vitest.config.ts`
  ```ts
  import { defineConfig } from "vitest/config";
  import path from "path";

  export default defineConfig({
    test: {
      globals: true,
      environment: "node",
    },
    resolve: {
      alias: {
        "@": path.resolve(__dirname, "./src"),
      },
    },
  });
  ```
- `globals: true` — `describe`, `it`, `expect`, `vi` are ambient, but tests still import them explicitly for clarity:
  ```ts
  import { describe, it, expect } from "vitest";
  import { afterEach, describe, expect, it, vi } from "vitest";
  ```
- `environment: "node"` — no jsdom. All suites are Node-land; no DOM/component rendering tests exist.

**Assertion library:**
- Vitest built-in `expect` with Jest-compatible matchers (`toBe`, `toEqual`, `toHaveLength`, `toBeDefined`, `toBeNull`, `toMatch`, `toContain`, `objectContaining`, `not.toBeNull()`).

**Run commands** (from `package.json`):
```bash
npm test              # vitest run — one-shot CI-style run
npm run test:watch    # vitest — interactive watch mode
```

There is no dedicated `test:coverage` script; Vitest's built-in `--coverage` flag works but is not wired into package.json.

## Test File Organization

**Location:** colocated with source inside `__tests__/` directories — never in a top-level `tests/` or `test/` folder.

```
src/
├── app/api/data-health/
│   └── __tests__/
│       └── modality-counter.test.ts
├── lib/
│   ├── normalization/
│   │   └── __tests__/
│   │       ├── availability.test.ts
│   │       ├── identity.test.ts
│   │       ├── leaves.test.ts
│   │       ├── modality.test.ts
│   │       ├── qualifications.test.ts
│   │       ├── sessions.test.ts
│   │       └── timezone.test.ts
│   ├── search/
│   │   └── __tests__/
│   │       ├── compare.test.ts
│   │       ├── engine.test.ts
│   │       ├── parser.test.ts
│   │       └── recommend.test.ts
│   └── wise/
│       └── __tests__/
│           ├── client.test.ts
│           └── fetchers.test.ts
└── lib/sync/
    └── __tests__/                 # (sync orchestrator integration tests)
```

**Naming:**
- `{module}.test.ts` — singular, matches the module it exercises.
- No `.test.tsx` in the repo (no component rendering tests).
- No `.spec.ts` alternate convention — always `.test.ts`.

**Import from the sibling file** using relative path (`../identity`, `../client`, `../compare`), and from other modules via `@/*`:
```ts
import { resolveIdentities } from "../identity";
import type { WiseTeacher } from "@/lib/wise/types";
```

## Test Structure

**Suite organization — one `describe` per public function:**

```ts
import { describe, it, expect } from "vitest";
import { extractNickname, isOnlineVariant, resolveIdentities } from "../identity";
import type { WiseTeacher } from "@/lib/wise/types";

describe("extractNickname", () => {
  it("extracts nickname from parenthetical", () => {
    expect(extractNickname("Chinnakrit (Celeste) Channiti")).toBe("Celeste");
  });

  it("returns null when no parenthetical", () => {
    expect(extractNickname("John Smith")).toBeNull();
  });
});

describe("isOnlineVariant", () => {
  it("detects Online suffix", () => {
    expect(isOnlineVariant("Usanee (Aey) Tortermpun Online")).toBe(true);
  });
});
```

**Patterns:**
- **`it` titles read as behavior sentences** — "extracts nickname from parenthetical", "treats CANCELLED as non-blocking", "excludes tutor blocked by future session (recurring)". Avoids the `should` prefix.
- **Flat test bodies** — arrange / act / assert inline; no `beforeEach` for shared state in most suites. The parallelism of Vitest plus the purely functional nature of the code under test makes global state unnecessary.
- **Phase/decision tags in titles** for tests that enforce design decisions from planning docs, e.g. `"returns unknown for an unresolved group even with sessionType evidence (MOD-01 fail-closed)"`, `"case 4: single-online + isOnlineVariant=true + sessionType=onsite → unknown/low + CONTRADICTION (D-08)"`, `"selectModalityIssues (MOD-03 / D-10)"`.
- **`afterEach` only when needed** — exclusively in the HTTP-mocking suites (`wise/__tests__/*.test.ts`) to restore `global.fetch` and call `vi.restoreAllMocks()`.

## Mocking

**Framework:** Vitest's `vi.fn()` / `vi.restoreAllMocks()` — no separate mocking library.

**HTTP mocking pattern** — swap `global.fetch` with a `vi.fn()` returning a real `Response` object, then restore in `afterEach`:

```ts
import { afterEach, describe, expect, it, vi } from "vitest";
import { WiseClient } from "../client";

describe("WiseClient", () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("sends the live Wise auth headers to the correct base URL", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ status: 200, message: "Success", data: {} }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    );
    global.fetch = fetchMock as typeof fetch;

    const client = new WiseClient({ userId: "user-123", apiKey: "api-key-456", namespace: "begifted-education", maxRetries: 0 });
    await client.get("/user/getUser");

    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.wiseapp.live/user/getUser",
      expect.objectContaining({
        method: "GET",
        headers: expect.objectContaining({
          Authorization: `Basic ${Buffer.from("user-123:api-key-456").toString("base64")}`,
          "x-api-key": "api-key-456",
          "x-wise-namespace": "begifted-education",
          "user-agent": "VendorIntegrations/begifted-education",
        }),
      })
    );
  });
});
```

**Pagination mocking** uses `mockResolvedValueOnce` in sequence for multi-page APIs (`src/lib/wise/__tests__/fetchers.test.ts:100+`):
```ts
const fetchMock = vi.fn()
  .mockResolvedValueOnce(new Response(JSON.stringify({ ..., page_number: 1, page_count: 2 }), ...))
  .mockResolvedValueOnce(new Response(JSON.stringify({ ..., page_number: 2, page_count: 2 }), ...));
```

**What to mock:**
- `global.fetch` for Wise API calls.
- Nothing else. Most of the codebase is pure normalization/transform logic that needs no mocks.

**What NOT to mock:**
- The database — search engine / compare tests build in-memory `SearchIndex` fixtures directly.
- `date-fns-tz` / timezone helpers — tests pick UTC values whose Bangkok offset is deterministic (`2024-01-15T02:00:00Z` → 09:00 Bangkok).
- Zod schemas — validated via the real API handler behavior.
- Auth — route-handler tests that would require this do not exist; the pattern is tested indirectly via integration.

## Fixtures and Factories

**Local factory functions** defined inside each test file — no shared fixture directory. Named `make*`:

```ts
// src/lib/search/__tests__/compare.test.ts
function makeTutor(overrides: Partial<IndexedTutorGroup> = {}): IndexedTutorGroup {
  return {
    id: "g1",
    displayName: "Test Tutor",
    supportedModes: ["online", "onsite"],
    qualifications: [{ subject: "Math", curriculum: "International", level: "Y2-8" }],
    wiseRecords: [{ wiseTeacherId: "t1", wiseDisplayName: "Test Tutor", isOnline: false }],
    availabilityWindows: [
      { weekday: 1, startMinute: 540, endMinute: 1020, modality: "both", wiseTeacherId: "t1" },
    ],
    leaves: [],
    sessionBlocks: [],
    dataIssues: [],
    ...overrides,
  };
}

// src/lib/search/__tests__/engine.test.ts
function makeIndex(tutors: IndexedTutorGroup[]): SearchIndex {
  const byWeekday = new Map<number, IndexedTutorGroup[]>();
  for (const t of tutors) {
    for (const w of t.availabilityWindows) {
      if (!byWeekday.has(w.weekday)) byWeekday.set(w.weekday, []);
      byWeekday.get(w.weekday)!.push(t);
    }
  }
  return { snapshotId: "snap-1", builtAt: new Date(), tutorGroups: tutors, byWeekday };
}

// src/lib/normalization/__tests__/identity.test.ts
const makeTeacher = (id: string, name: string): WiseTeacher => ({ _id: id, name });
const makeNestedTeacher = (id: string, userId: string, name: string): WiseTeacher => ({
  _id: id,
  userId: { _id: userId, name },
});
```

Pattern: sensible defaults + `...overrides` spread so each test adjusts only the fields it cares about. Keeps tests readable and decoupled.

**Parameterized matrices** — when enforcing a combinatorial contract, the test file defines a local `runCase` helper that takes the dimensions and returns `{ resolverResult, compareResult, conflictResult }` (see `src/lib/search/__tests__/compare.test.ts:104+` — MOD-05 / D-21 regression matrix covering every `{group shape × isOnlineVariant × sessionType}` combination).

## Coverage

**Requirement:** No enforced coverage threshold. `AGENTS.md` tracks raw test count: **82 passing unit tests** spread across identity, timezone, availability, leaves, sessions, modality, qualifications, search engine, compare engine, Wise contract, parser, modality counter, recommend, and the D-21 regression matrix.

**Coverage by area** (count of `.test.ts` files under each `__tests__/`):

| Area | Files | Focus |
|------|-------|-------|
| `src/lib/normalization/` | 7 | `availability`, `identity`, `leaves`, `modality`, `qualifications`, `sessions`, `timezone` |
| `src/lib/search/` | 4 | `compare`, `engine`, `parser`, `recommend` |
| `src/lib/wise/` | 2 | `client` (auth headers), `fetchers` (teacher/availability/session parsing + pagination) |
| `src/app/api/data-health/` | 1 | `modality-counter` (D-10) |
| `src/lib/sync/` | — | orchestrator integration tests present |

**View coverage:**
```bash
npx vitest run --coverage   # uses Vitest's v8 coverage provider by default
```

## Test Types

**Unit tests** (dominant):
- Pure function verification — input → output with no I/O.
- Target: every exported function in `src/lib/normalization/*`, `src/lib/search/{engine,compare,parser,recommend}.ts`, `src/lib/wise/client.ts`.

**Contract tests** (`src/lib/wise/__tests__/*.test.ts`):
- Assert HTTP shape of outgoing requests (headers, URL, query params, pagination params).
- Assert parsing of real-world Wise response envelopes (`data.teachers`, `data.workingHours.slots`, `data.sessions` with `page_number`/`page_count`).

**Regression matrix tests** (`src/lib/search/__tests__/compare.test.ts` — MOD-05 / D-21):
- Enumerate every branch of a domain decision (16+ cases for modality resolution).
- Each contradiction case asserts **both** `modality === "unknown"` **and** a non-null conflict payload naming both signals — preventing silent removal of fail-closed branches.

**Integration tests:** sync orchestrator tests under `src/lib/sync/__tests__/`. No e2e / browser tests.

**E2E tests:** Not used. There is no Playwright / Cypress setup.

## Common Patterns

**Timezone-sensitive testing** — pick UTC inputs whose Bangkok equivalent is unambiguous:
```ts
// 2024-01-15 02:00 UTC = 2024-01-15 09:00 Bangkok (UTC+7)
const local = toLocalTime("2024-01-15T02:00:00Z");
expect(local.getHours()).toBe(9);

// 20:00 UTC on Monday = 03:00 Tuesday in Bangkok
const weekday = getLocalWeekday("2024-01-15T20:00:00Z");
expect(weekday).toBe(2); // Tuesday
```

**Fail-closed testing** — explicit assertions that unknown / missing inputs produce a safe-but-restrictive result:
```ts
it("treats unknown status as blocking (fail-closed)", () => {
  expect(isBlockingStatus("SOMETHING_NEW")).toBe(true);
});

it("treats undefined as blocking (fail-closed)", () => {
  expect(isBlockingStatus(undefined)).toBe(true);
});
```

**Async testing** — `async` `it` + `await` on the subject:
```ts
it("sends the live Wise auth headers to the correct base URL", async () => {
  // ... set up fetchMock ...
  await client.get("/user/getUser");
  expect(fetchMock).toHaveBeenCalledWith(...);
});
```

**Partial-match assertions** for objects with non-deterministic fields (e.g. timestamps):
```ts
expect(result.groups[0].members).toEqual([
  expect.objectContaining({
    wiseTeacherId: "t1",
    wiseUserId: "u1",
    wiseDisplayName: "Usanee (Aey) Tortermpun",
  }),
]);
```

**Set-based assertions** for unordered collections:
```ts
expect(result.map((r) => r.issueType).sort()).toEqual(["conflict_model", "modality"]);
```

**Test-file comments that cite decisions** — the D-21 matrix header in `compare.test.ts` explains *why* every contradiction case must stay green, naming the source doc:
```ts
// Merge-gate regression matrix per 06-CONTEXT.md D-21/D-22 and research Pitfall 1.
// Covers every combination of {group shape × isOnlineVariant × sessionType} with
// explicit expected {modality, confidence} outputs. ... Any future refactor that
// silently replaces a fail-closed "unknown" branch with a concrete value
// breaks this matrix and blocks the merge.
```

**Avoiding Next.js ESM import issues in tests** — when a route module transitively imports `next-auth` (whose ESM subpath `next/server` cannot be resolved by Vitest's bare Node resolver), extract the testable helper into a dedicated file and re-export it from the route. See `src/app/api/data-health/__tests__/modality-counter.test.ts:1-7`:
```ts
// Import from the dedicated helper module rather than `../route` — the route
// module transitively imports `next-auth`, whose ESM subpath `next/server`
// cannot be resolved by Vitest's bare Node resolver. `route.ts` re-exports the
// same `selectModalityIssues` as a thin wrapper so acceptance greps on the
// route module still pass; this test targets the canonical implementation.
import { selectModalityIssues } from "../modality-counter";
```

## CI Integration

- **No GitHub Actions workflow** checked into the repo (no `.github/workflows/`).
- **Vercel deploy** triggered on push to `main`. `vercel.json` controls the daily cron (`0 0 * * *`) at `/api/internal/sync-wise`.
- **Local enforcement** only: `npm test` before deploy. The `AGENTS.md` constraint **"All 82 existing tests must continue to pass"** is treated as a merge gate in planning docs rather than an automated check.

---

*Testing analysis: 2026-04-21*
