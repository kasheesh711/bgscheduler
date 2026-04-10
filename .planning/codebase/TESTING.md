# Testing Patterns

**Analysis Date:** 2026-04-10

## Test Framework

**Runner:**
- Vitest 4.x
- Config: `vitest.config.ts`
- Globals enabled (`describe`, `it`, `expect` available without import, but tests explicitly import them)
- Environment: `node`

**Assertion Library:**
- Vitest built-in (`expect`)

**Run Commands:**
```bash
npm test              # Run all tests (vitest run)
npm run test:watch    # Watch mode (vitest)
```

## Test File Organization

**Location:**
- Co-located `__tests__/` directories next to source modules
- Pattern: `src/lib/{module}/__tests__/{file}.test.ts`

**Naming:**
- `{module-name}.test.ts` (kebab-case matching source file)

**Structure:**
```
src/lib/
  normalization/
    __tests__/
      availability.test.ts
      identity.test.ts
      leaves.test.ts
      modality.test.ts
      qualifications.test.ts
      sessions.test.ts
      timezone.test.ts
    availability.ts
    identity.ts
    ...
  search/
    __tests__/
      compare.test.ts
      engine.test.ts
      parser.test.ts
    compare.ts
    engine.ts
    parser.ts
  wise/
    __tests__/
      client.test.ts
      fetchers.test.ts
    client.ts
    fetchers.ts
  sync/
    __tests__/           # Empty - no tests for orchestrator
    orchestrator.ts
```

**Coverage by module:**
- `normalization/` - 7 test files (comprehensive)
- `search/` - 3 test files (engine, compare, parser)
- `wise/` - 2 test files (client, fetchers)
- `sync/` - 0 test files (orchestrator untested)
- `components/` - 0 test files (no component tests)
- `app/api/` - 0 test files (no route handler tests)

## Test Structure

**Suite Organization:**
```typescript
import { describe, it, expect } from "vitest";
import { functionUnderTest } from "../module";
import type { SomeType } from "@/lib/some/types";

describe("functionUnderTest", () => {
  it("describes expected behavior in plain English", () => {
    // Arrange
    const input = makeTestData();

    // Act
    const result = functionUnderTest(input);

    // Assert
    expect(result).toHaveLength(1);
    expect(result[0].field).toBe("expected");
  });
});
```

**Patterns:**
- Flat `describe`/`it` structure (no deeply nested `describe` blocks)
- One `describe` block per exported function/class
- Test names describe behavior: `"returns available tutor for matching recurring slot"`, `"does not block on cancelled session"`
- Arrange-Act-Assert pattern (implicit, no comments separating phases)
- No `beforeEach` for most tests -- each test builds its own data
- `afterEach` only in tests that stub `global.fetch`

## Mocking

**Framework:** Vitest built-in (`vi`)

**Global Fetch Mocking Pattern:**
```typescript
import { afterEach, describe, expect, it, vi } from "vitest";

describe("Wise fetchers", () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("parses response correctly", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          status: 200,
          message: "Success",
          data: { /* ... */ },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      )
    );
    global.fetch = fetchMock as typeof fetch;

    const result = await fetchSomething(makeClient());

    expect(result).toEqual(expect.objectContaining({ /* ... */ }));
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.wiseapp.live/some/path",
      expect.objectContaining({ method: "GET" })
    );
  });
});
```

**What to Mock:**
- `global.fetch` for HTTP client tests (Wise API)
- Nothing else -- all other tests are pure function tests with no I/O

**What NOT to Mock:**
- Database (tests don't touch DB; search engine tests use in-memory `SearchIndex`)
- Internal modules (no module-level mocking; tests call real functions)
- Date/time (tests use fixed date strings like `"2024-01-15T02:00:00Z"`)

## Fixtures and Factories

**Test Data Factories:**
```typescript
// Pattern: `makeTutor()` with spread overrides
function makeTutor(overrides: Partial<IndexedTutorGroup> = {}): IndexedTutorGroup {
  return {
    id: "g1",
    displayName: "Test Tutor",
    supportedModes: ["online", "onsite"],
    qualifications: [
      { subject: "Math", curriculum: "International", level: "Y2-8" },
    ],
    wiseRecords: [
      { wiseTeacherId: "t1", wiseDisplayName: "Test (Test) Tutor", isOnline: false },
    ],
    availabilityWindows: [
      { weekday: 1, startMinute: 540, endMinute: 1020, modality: "both", wiseTeacherId: "t1" },
    ],
    leaves: [],
    sessionBlocks: [],
    dataIssues: [],
    ...overrides,
  };
}

// Pattern: `makeIndex()` builds SearchIndex from tutor array
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

// Pattern: `makeTeacher()` for Wise API types
const makeTeacher = (id: string, name: string): WiseTeacher => ({
  _id: id,
  name,
});

// Pattern: `makeClient()` for WiseClient
function makeClient() {
  return new WiseClient({
    userId: "user-123",
    apiKey: "api-key-456",
    namespace: "begifted-education",
    maxRetries: 0,  // Disable retries in tests
  });
}
```

**Key conventions:**
- Factory functions defined at top of test file, before `describe` blocks
- Use `Partial<T>` with spread for overrides
- Provide sensible defaults that make tests pass without specifying every field
- Disable retries (`maxRetries: 0`) in client tests to avoid slow test runs
- Use deterministic dates (`"2024-01-15"` = Monday) for predictable weekday calculations

**Location:**
- Inline in test files (no shared fixtures directory)

## Coverage

**Requirements:** None enforced (no coverage thresholds configured)

**Current Coverage:**
- 82 passing unit tests (per CLAUDE.md)
- Strong coverage of normalization pipeline and search engine
- No coverage of: sync orchestrator, API routes, React components

**View Coverage:**
```bash
npx vitest run --coverage   # Not configured but available via Vitest
```

## Test Types

**Unit Tests:**
- All 12 test files are pure unit tests
- Test individual exported functions in isolation
- No database, network, or filesystem dependencies (except mocked `global.fetch`)
- Focus on business logic correctness: normalization rules, search matching, conflict detection

**Integration Tests:**
- Not present. No tests exercise the full request/response cycle through API routes.

**E2E Tests:**
- Not used. No Playwright, Cypress, or similar framework.

**Component Tests:**
- Not present. No React component tests (no React Testing Library or similar).

## Common Patterns

**Async Testing:**
```typescript
it("parses teachers from data.teachers", async () => {
  const fetchMock = vi.fn().mockResolvedValue(
    new Response(JSON.stringify({ status: 200, data: { teachers: [/*...*/] } }))
  );
  global.fetch = fetchMock as typeof fetch;

  const teachers = await fetchAllTeachers(makeClient(), "center-1");
  expect(teachers).toEqual([expect.objectContaining({ _id: "teacher-record-1" })]);
});
```

**Error/Edge Case Testing:**
```typescript
it("handles empty slots", () => {
  expect(normalizeWorkingHours(undefined)).toEqual([]);
  expect(normalizeWorkingHours([])).toEqual([]);
});

it("treats unknown status as blocking (fail-closed)", () => {
  expect(isBlockingStatus("SOMETHING_NEW")).toBe(true);
});

it("treats undefined as blocking (fail-closed)", () => {
  expect(isBlockingStatus(undefined)).toBe(true);
});
```

**Boundary Behavior Testing:**
```typescript
it("skips zero-length windows", () => {
  const slots = [{ day: 1, startTime: "09:00", endTime: "09:00" }];
  expect(normalizeWorkingHours(slots)).toEqual([]);
});
```

**Pagination Testing:**
```typescript
it("paginates sessions using COUNT mode", async () => {
  const fetchMock = vi.fn()
    .mockResolvedValueOnce(new Response(JSON.stringify({ data: { sessions: [{ _id: "s1" }], page_number: 1, page_count: 2 } })))
    .mockResolvedValueOnce(new Response(JSON.stringify({ data: { sessions: [{ _id: "s2" }], page_number: 2, page_count: 2 } })));
  global.fetch = fetchMock as typeof fetch;

  const sessions = await fetchAllFutureSessions(makeClient(), "center-1");
  expect(sessions.map((s) => s._id)).toEqual(["s1", "s2"]);
});
```

**Partial Object Matching:**
```typescript
expect(result.groups[0].members).toEqual([
  expect.objectContaining({
    wiseTeacherId: "t1",
    wiseUserId: "u1",
    wiseDisplayName: "Usanee (Aey) Tortermpun",
  }),
  expect.objectContaining({
    wiseTeacherId: "t2",
    wiseUserId: "u2",
  }),
]);
```

## Adding New Tests

**For a new normalization module:**
1. Create `src/lib/normalization/__tests__/{module}.test.ts`
2. Import `describe, it, expect` from `vitest`
3. Import the functions under test from `../{module}`
4. Create a factory function if needed (e.g., `makeSomething()`)
5. Write one `describe` per exported function

**For a new search feature:**
1. Create test in `src/lib/search/__tests__/{feature}.test.ts`
2. Reuse `makeTutor()` and `makeIndex()` patterns from `engine.test.ts`
3. Build minimal `SearchRequest` objects for each scenario

**For a new Wise API endpoint:**
1. Create test in `src/lib/wise/__tests__/{feature}.test.ts`
2. Mock `global.fetch` with `vi.fn().mockResolvedValue(new Response(...))`
3. Save and restore `global.fetch` in `afterEach`
4. Set `maxRetries: 0` on test client

---

*Testing analysis: 2026-04-10*
