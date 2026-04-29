# Testing Patterns

**Analysis Date:** 2026-04-29

## Test Framework

### Runner

- **Vitest 4.1.2** — devDependency in `package.json:42`
- Config: `vitest.config.ts` (project root)

```typescript
// vitest.config.ts
import { defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
  test: {
    globals: true,             // describe / it / expect available without import
    environment: "node",       // no jsdom / browser environment
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),  // mirrors tsconfig.json paths
    },
  },
});
```

Key config decisions:

- `environment: "node"` — pure Node test environment. There are no DOM tests; React components are not rendered in the test suite.
- `globals: true` — `describe`, `it`, `expect`, `vi`, etc. are global. Most tests still import them explicitly (e.g., `import { describe, it, expect } from "vitest"`) for editor support.
- `@` alias mirrors `tsconfig.json` so the same `@/lib/...` imports work in tests.

### Assertion Library

- Built-in Vitest `expect` (Chai/Jest-compatible API). No additional library.

### Run Commands

```bash
npm test              # Single run — `vitest run`
npm run test:watch    # Watch mode — `vitest`
```

(`package.json:13-14`)

There is no `test:coverage` or `test:ui` script; coverage is not enforced.

## Test File Organization

### Location

- **Sibling `__tests__/` directories** — co-located with the module under test
- The test file's source is one level up (`../module-name`)

Current locations (15 test files, 30 `describe`s, 138 `it`s):

```
src/lib/normalization/__tests__/
├── availability.test.ts
├── identity.test.ts
├── leaves.test.ts
├── modality.test.ts
├── qualifications.test.ts
├── sessions.test.ts
└── timezone.test.ts

src/lib/search/__tests__/
├── compare.test.ts
├── engine.test.ts
├── parser.test.ts
└── recommend.test.ts

src/lib/wise/__tests__/
├── client.test.ts
└── fetchers.test.ts

src/lib/sync/__tests__/
└── past-sessions-diff-hook.test.ts

src/lib/data/__tests__/
└── past-sessions.test.ts
```

### Naming

- `{module}.test.ts` — matches the source file's base name plus `.test.ts`
- Example: `src/lib/normalization/identity.ts` → `src/lib/normalization/__tests__/identity.test.ts`

### Coverage Surface

Tests cover normalization, search, compare, Wise client, sync hooks, and data fetchers. **No tests** cover:
- React components (`src/components/**`)
- API route handlers (`src/app/api/**/route.ts`) — the modality-counter helper at `src/app/api/data-health/modality-counter.ts` is testable via re-export but the route itself is not
- Auth flows (`src/lib/auth/*`)
- DB seed scripts (`src/lib/db/seed.ts`)

## Test Structure

### Top-Level Layout

```typescript
import { describe, it, expect } from "vitest";
import { extractNickname, isOnlineVariant, getBaseName, resolveIdentities } from "../identity";
import type { WiseTeacher } from "@/lib/wise/types";

describe("extractNickname", () => {
  it("extracts nickname from parenthetical", () => {
    expect(extractNickname("Chinnakrit (Celeste) Channiti")).toBe("Celeste");
  });

  it("returns null when no parenthetical", () => {
    expect(extractNickname("John Smith")).toBeNull();
  });
});
```

(`src/lib/normalization/__tests__/identity.test.ts:1-26`)

### Conventions

- One `describe` block **per exported function or scenario**
- `describe` name matches the function name verbatim (e.g., `describe("extractNickname", ...)`)
- `it` descriptions read as English sentences in present tense: `it("extracts nickname from parenthetical", ...)`, `it("returns null when no parenthetical", ...)`, `it("treats CANCELLED as non-blocking", ...)`
- Multiple `describe` blocks per file — one per function under test
- Group scenario-style tests under a descriptive `describe` (e.g., `describe("buildCompareTutor past+future merge + per-weekday historical flag (Phase 7)", ...)` in `src/lib/search/__tests__/compare.test.ts:461`)
- Reference design IDs in test names where load-bearing: `it("case 4: single-online + isOnlineVariant=true + sessionType=onsite → unknown/low + CONTRADICTION (D-08)", ...)`

### Setup & Teardown

- `beforeEach` / `afterEach` from Vitest:
  ```typescript
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-15T00:00:00+07:00"));
  });
  afterEach(() => {
    vi.useRealTimers();
  });
  ```
  (`src/lib/search/__tests__/compare.test.ts:466-472`)
- For tests that mutate `global.fetch`, snapshot the original at the top of the `describe` and restore in `afterEach`:
  ```typescript
  const originalFetch = global.fetch;
  afterEach(() => {
    global.fetch = originalFetch;
    vi.restoreAllMocks();
  });
  ```
  (`src/lib/wise/__tests__/client.test.ts:5-10`)

### Fixture / Factory Pattern

Inline factory functions with `Partial<T>` overrides — defined at file scope, immediately above the `describe`:

```typescript
function makeTutor(overrides: Partial<IndexedTutorGroup> = {}): IndexedTutorGroup {
  return {
    id: "g1",
    canonicalKey: "test-tutor",
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
```

(`src/lib/search/__tests__/engine.test.ts:6-26`)

Tests in the same file may have multiple factories: `makeTutor`, `makeIndex`, `makeTeacher`, `makeNestedTeacher`, `makePastMondaySession`, `makePriorBlock`, `makeRow`, `makeRowFixture`, `makeResponse`, `runCase`. Each factory returns a fully populated default object that callers customize via spread.

### Assertion Style

- `expect(value).toBe(...)` — primitive equality
- `expect(value).toEqual(...)` — deep equality on objects/arrays
- `expect(arr).toHaveLength(N)` — array length
- `expect(value).toBeNull()` / `.toBeUndefined()` — explicit nullish checks
- `expect(arr).toContain(...)` — membership
- `expect(value).toMatch(/regex/)` — string regex match
- `expect(arr.find(...)).toBeDefined()` — existence under predicate
- `expect.objectContaining(...)` — partial object match (for `toEqual` and mock arg matchers):
  ```typescript
  expect(fetchMock).toHaveBeenCalledWith(
    "https://api.wiseapp.live/user/getUser",
    expect.objectContaining({
      method: "GET",
      headers: expect.objectContaining({ Authorization: ... }),
    }),
  );
  ```
  (`src/lib/wise/__tests__/client.test.ts:30-41`)
- Custom error messages on aggregate assertions (helps when failures are loops):
  ```typescript
  expect(resolverResult.confidence, `confidence for ${JSON.stringify(c)}`).not.toBe("medium");
  ```
  (`src/lib/search/__tests__/compare.test.ts:371`)

## Mocking

### Framework

- **Vitest's built-in `vi`** — `vi.fn()`, `vi.mock()`, `vi.spyOn()`, `vi.useFakeTimers()`, `vi.setSystemTime()`, `vi.restoreAllMocks()`
- No external mocking libraries (no `jest`, no `sinon`, no `nock`)

### `global.fetch` Mocking

Wise client and fetcher tests directly assign `global.fetch`:

```typescript
const fetchMock = vi.fn().mockResolvedValue(
  new Response(JSON.stringify({ status: 200, data: {...} }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  }),
);
global.fetch = fetchMock as typeof fetch;

// ... act + assert ...

// Restore in afterEach
global.fetch = originalFetch;
```

(`src/lib/wise/__tests__/client.test.ts:13-19`, `src/lib/wise/__tests__/fetchers.test.ts:27-49`)

For paginated requests, chain `.mockResolvedValueOnce()`:

```typescript
const fetchMock = vi
  .fn()
  .mockResolvedValueOnce(new Response(JSON.stringify({ data: { sessions: [...], page_number: 1, page_count: 2 } }), { status: 200 }))
  .mockResolvedValueOnce(new Response(JSON.stringify({ data: { sessions: [...], page_number: 2, page_count: 2 } }), { status: 200 }));
```

(`src/lib/wise/__tests__/fetchers.test.ts:101-144`)

Inspect calls via `fetchMock.mock.calls[i][j]`:

```typescript
const calledUrl = new URL(fetchMock.mock.calls[0][0] as string);
expect(calledUrl.pathname).toBe("/institutes/center-1/teachers/wise-user-1/availability");
expect(calledUrl.searchParams.get("startTime")).toBe(startTime.toISOString());
```

(`src/lib/wise/__tests__/fetchers.test.ts:94-97`)

### Module Mocking with `vi.mock()`

Used when the module under test imports a side-effecting dependency (e.g., the DB client):

```typescript
const mockRows: MockRow[] = [];
const mockDb = {
  select: vi.fn(() => ({
    from: vi.fn(() => ({
      where: vi.fn(() => Promise.resolve(mockRows.slice())),
    })),
  })),
};

vi.mock("@/lib/db", () => ({
  getDb: () => mockDb,
}));
```

(`src/lib/data/__tests__/past-sessions.test.ts:8-20`)

Reset mock state in `beforeEach`:

```typescript
beforeEach(() => {
  mockRows.length = 0;
  mockDb.select.mockClear();
});
```

(`src/lib/data/__tests__/past-sessions.test.ts:50-53`)

### In-Memory Drizzle Mock

Complex sync hooks build a hand-rolled Drizzle call-chain mock that resolves only the specific `.select(...).from(target).where(...)` and `.insert(...).values(...).onConflictDoNothing(...).returning(...)` chains the function uses:

```typescript
function makeMockDb(opts: { ... }): { db: Database; insertedRows: ...; existingPastRows: Set<string> } {
  const insertedRows = [];
  const selectBuilder = (fieldsArg) => {
    const api = {
      _target: null,
      from(target) { api._target = target; return api; },
      where(_condition) { return api; },
      limit(_n) { return api._resolve(); },
      then(onFulfilled) { return Promise.resolve(api._resolve()).then(onFulfilled); },
      _resolve() {
        if (api._target === schema.snapshots) return [{ id: opts.priorSnapshotId }];
        // ...
      },
    };
    return api;
  };
  const insertBuilder = (target) => { ... };
  return { db: { select, insert } as Database, insertedRows, existingPastRows };
}
```

(`src/lib/sync/__tests__/past-sessions-diff-hook.test.ts:66-140`)

This pattern is heavyweight; only use it for orchestration-style tests where fully covering the SQL chain matters.

### Fake Timers

For time-dependent compare logic (e.g., `getStartOfTodayBkk`):

```typescript
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-04-15T00:00:00+07:00"));
});
afterEach(() => {
  vi.useRealTimers();
});
```

(`src/lib/search/__tests__/compare.test.ts:466-472`)

Always pair `useFakeTimers` with `useRealTimers` in `afterEach` so other tests aren't affected.

### Source Code Inspection (Grep Assertions)

For invariants that are easier to grep than to behavior-test, the codebase uses Node's `fs.readFileSync` against the source file:

```typescript
const sourcePath = path.resolve(__dirname, "../past-sessions.ts");
const source = fs.readFileSync(sourcePath, "utf8");

it("does NOT reference cacheTag('snapshot')", () => {
  const matches = source.match(/cacheTag\("snapshot"\)/g) ?? [];
  expect(matches).toHaveLength(0);
});
```

(`src/lib/data/__tests__/past-sessions.test.ts:129-152`)

Use sparingly — only when an invariant guards a regression that behavior tests can't catch (here, accidental cache-tag drift).

### What to Mock

- External I/O: `fetch`, the DB client (`@/lib/db`), filesystem reads
- Time: `Date.now()` via `vi.useFakeTimers()` + `vi.setSystemTime()`
- Module-level singletons that hit the network / DB

### What NOT to Mock

- Pure normalization, parsing, math (`parseTimeToMinutes`, `extractNickname`, `normalizeWorkingHours`) — these are deterministic and tested with literal inputs
- Internal helpers within the module under test
- Types — they're erased at runtime; mocking them adds no signal

## Fixtures and Factories

### Test Data

- **Inline factory functions** are the dominant pattern (15 distinct factories across the suite)
- Default fixtures cover the happy path; tests pass `Partial<T>` overrides
- No external fixture files — all data is constructed inline
- Date literals consistently use ISO strings (`"2024-01-15T02:00:00Z"`) or `new Date(year, monthIndex, day, hour, minute)` for local-time semantics

### Common Factory Conventions

```typescript
function makeTeacher(id: string, name: string): WiseTeacher {
  return { _id: id, name };
}

function makeNestedTeacher(id: string, userId: string, name: string): WiseTeacher {
  return { _id: id, userId: { _id: userId, name } };
}
```

(`src/lib/normalization/__tests__/identity.test.ts:57-68`)

Heavier factories accept full `Partial<T>` overrides (`makeTutor` in `engine.test.ts` and `compare.test.ts`).

### Location

- Fixtures live **inline at the top of each test file**
- No `fixtures/` or `__fixtures__/` directories anywhere in the repo

## Coverage

### Requirements

- **None enforced** — there is no coverage threshold, no CI gate on coverage, and no `test:coverage` npm script
- Suite has 82 passing unit tests reported in AGENTS.md (current count is 138 `it` blocks across 15 files)

### View Coverage

Vitest can produce coverage on demand if needed:

```bash
npx vitest run --coverage
```

This is **not part of the standard workflow**. Adding `@vitest/coverage-v8` and a `test:coverage` script would be required for routine measurement.

### Coverage Surface (descriptive)

| Module | Test File | Areas Covered |
|--------|-----------|---------------|
| Identity normalization | `src/lib/normalization/__tests__/identity.test.ts` | Nickname extraction, online-variant detection, base-name stripping, alias overrides, online/offline pair merging, unresolved → data_issue |
| Timezone | `src/lib/normalization/__tests__/timezone.test.ts` | UTC → Asia/Bangkok conversion, weekday derivation, minute-of-day, `parseTimeToMinutes` |
| Availability | `src/lib/normalization/__tests__/availability.test.ts` | `normalizeWorkingHours` (numeric + string day names), zero-length skip, overlapping window merge in `deduplicateWindows` |
| Leaves | `src/lib/normalization/__tests__/leaves.test.ts` | UTC → BKK conversion, overlap merge, empty-input handling |
| Sessions | `src/lib/normalization/__tests__/sessions.test.ts` | `isBlockingStatus` for CONFIRMED/SCHEDULED/CANCELLED/CANCELED/unknown/undefined, blocking vs cancelled normalization, nested userId resolution |
| Modality | `src/lib/normalization/__tests__/modality.test.ts` | Pair-derived modality, online-only / onsite-only single-member groups, `sessionType` evidence, fail-closed unresolved |
| Qualifications | `src/lib/normalization/__tests__/qualifications.test.ts` | Math/Thai/ExamPrep/EFL tag parsing, string-tag fallback, unparseable → data_issue |
| Search engine | `src/lib/search/__tests__/engine.test.ts` | Recurring-mode blocking, one-time blocking by exact date, cancelled non-blocking, mode filtering, qualification filtering, multi-slot intersection, Needs Review routing |
| Compare engine | `src/lib/search/__tests__/compare.test.ts` | `buildCompareTutor` (weekday filter, full-week, weekly hours, distinct students, online-variant marking), the 19-case modality matrix (MOD-01 / MOD-05 / D-21), `detectConflicts` (same-student overlap, different students, non-overlapping), `findSharedFreeSlots`, Phase 7 historical-week + per-weekday fallback |
| Recommend | `src/lib/search/__tests__/recommend.test.ts` | Best/Strong/Good tier assignment, count DESC + start-time ASC tie-break, zero-availability filtering, limit param, modality reasons, pluralization, "variety" reason at 3+ tutors |
| Parser | `src/lib/search/__tests__/parser.test.ts` | Single + comma-separated slot parsing, abbreviated day names, en-dash separator, default mode, unparseable warnings |
| Wise client | `src/lib/wise/__tests__/client.test.ts` | Auth header construction (Basic Auth + x-api-key + x-wise-namespace + user-agent), correct base URL |
| Wise fetchers | `src/lib/wise/__tests__/fetchers.test.ts` | Teacher list parsing, availability envelope + start/end time params, sessions COUNT pagination |
| Sync diff hook | `src/lib/sync/__tests__/past-sessions-diff-hook.test.ts` | Capture dropped past sessions, idempotent ON CONFLICT DO NOTHING, no prior snapshot early-return, future-cancelled exclusion, completeness data_issue on missing canonical_key, no double-capture when session still present |
| Past-sessions data | `src/lib/data/__tests__/past-sessions.test.ts` | Empty-key short-circuit, bucketing by canonical key, missing-key omission, null → undefined column mapping, cache-discipline grep assertions |

## Test Types

### Unit Tests

- All current tests are unit-scope
- Pure functions tested with literal inputs; orchestrators tested with hand-rolled DB / fetch mocks
- No integration tests against the real Wise API or real Postgres
- No browser / DOM tests (component rendering is not currently exercised)

### Integration / E2E

- **Not present.** No Playwright, Cypress, or Vitest browser-mode setup
- Production validation relies on the daily Vercel cron sync + admin spot-checks

## Common Patterns

### Async Testing

Native `async/await` — no callback / `done()` style:

```typescript
it("paginates sessions using COUNT mode", async () => {
  const fetchMock = vi.fn().mockResolvedValueOnce(...).mockResolvedValueOnce(...);
  global.fetch = fetchMock as typeof fetch;

  const sessions = await fetchAllFutureSessions(makeClient(), "center-1");

  expect(sessions.map((s) => s._id)).toEqual(["s1", "s2"]);
});
```

(`src/lib/wise/__tests__/fetchers.test.ts:100-154`)

### Error Testing

For functions that throw, prefer `await expect(fn()).rejects.toThrow(...)` (currently no examples in this codebase). For the more common `{ result, issues }` tuple return style, assert on the `issues` array:

```typescript
it("creates data issue for teachers without nickname", () => {
  const result = resolveIdentities([makeTeacher("t1", "John Smith")], []);
  expect(result.issues).toHaveLength(1);
  expect(result.issues[0].type).toBe("alias");
  expect(result.groups).toHaveLength(1); // Still creates a group for Needs Review
});
```

(`src/lib/normalization/__tests__/identity.test.ts:102-110`)

### Comprehensive Matrix Tests

Long-running invariants are encoded as case-numbered test rows. The 19-case modality matrix in `src/lib/search/__tests__/compare.test.ts:105-415` covers every combination of `{group shape × isOnlineVariant × sessionType}` plus contradiction detection plus "never emits medium" plus tenant-vocabulary anchors. Pattern:

1. Define a `runCase` helper that returns `{ resolverResult, compareResult, conflictResult }`
2. Each `it("case N: ... → expected", ...)` calls `runCase` with one input row
3. Add a final aggregate `it` that loops over all rows asserting an invariant (e.g., `confidence !== "medium"`)

When you change the modality logic, this matrix breaks first — that's the design.

### Backward-Compat Tests

Add explicit "old signature still works" tests when changing a function signature:

```typescript
it("backward-compat: calling without pastBlocks behaves identically to pre-Phase-7", () => {
  const result = buildCompareTutor(tutor, undefined, futureWeek()); // 3-arg call
  expect(result.sessions).toHaveLength(1);

  // Sanity: passing `undefined` explicitly is also fine.
  const resultUndefined = buildCompareTutor(tutor, undefined, futureWeek(), undefined);
  expect(resultUndefined.sessions).toHaveLength(1);
});
```

(`src/lib/search/__tests__/compare.test.ts:651-683`)

### Comments in Tests

Tests that encode non-trivial business rules include 2–10 line comments explaining the scenario and referencing the design ID (e.g., `MOD-UAT-01`, `Pitfall 16`, `D-09`). Example:

```typescript
// Pre-MOD-01 this used location/sessionType as standalone fallback and returned "online".
// MOD-01 restricts the resolver to isOnlineVariant + sessionType corroboration — an
// unresolved group (supportedModes: []) has no isOnlineVariant signal to corroborate,
// so the session falls into the fail-closed branch (AGENTS.md:146-149 / D-01 / D-05).
```

(`src/lib/search/__tests__/compare.test.ts:88-91`)

These comments are how future engineers know **why** a test case is non-obvious and **what plan document to read** before changing it.

---

*Testing analysis: 2026-04-29*
