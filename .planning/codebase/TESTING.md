# Testing Patterns

**Analysis Date:** 2026-04-16

## Test Framework

**Runner:** Vitest 4.x

**Configuration (`vitest.config.ts`):**
```typescript
import { defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
  test: {
    globals: true,        // describe/it/expect available without import
    environment: "node",  // No DOM environment
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),  // Matches tsconfig paths
    },
  },
});
```

**Run Commands (`package.json`):**
```bash
npm test              # vitest run (single pass)
npm run test:watch    # vitest (watch mode)
```

## Test File Organization

### Directory Structure

Tests are co-located in `__tests__/` directories next to their source modules:

```
src/lib/
  normalization/
    __tests__/
      availability.test.ts    # normalizeWorkingHours, deduplicateWindows
      identity.test.ts        # extractNickname, isOnlineVariant, getBaseName, resolveIdentities
      leaves.test.ts          # normalizeLeaves, deduplicateLeaves
      modality.test.ts        # deriveModality
      qualifications.test.ts  # normalizeTag, normalizeTeacherTags
      sessions.test.ts        # isBlockingStatus, normalizeSessions
      timezone.test.ts        # parseTimeToMinutes, toLocalTime, getLocalWeekday, getLocalMinuteOfDay
    availability.ts
    identity.ts
    leaves.ts
    modality.ts
    qualifications.ts
    sessions.ts
    timezone.ts
  search/
    __tests__/
      compare.test.ts         # buildCompareTutor, detectConflicts, findSharedFreeSlots
      engine.test.ts          # executeSearch (recurring, one-time, filtering, intersection)
      parser.test.ts          # parseSlotInput
    compare.ts
    engine.ts
    parser.ts
  wise/
    __tests__/
      client.test.ts          # WiseClient auth headers
      fetchers.test.ts        # fetchAllTeachers, fetchTeacherAvailability, fetchAllFutureSessions
    client.ts
    fetchers.ts
```

### Naming Convention

- File: `{module-name}.test.ts` (kebab-case matching source file)
- Suite: one `describe` per exported function or class
- Test: plain English behavior description starting with a verb

### Coverage by Domain

| Domain | Test Files | Test Count | Key Areas |
|--------|-----------|------------|-----------|
| Normalization | 7 files | ~35 tests | Identity resolution, timezone conversion, availability windows, leaves, sessions, modality derivation, qualification parsing |
| Search | 3 files | ~20 tests | Recurring/one-time search, mode filtering, qualification filtering, multi-slot intersection, conflict detection, shared free slots, slot parsing |
| Wise API | 2 files | ~5 tests | Auth headers, response parsing, pagination |
| Sync | 0 files | 0 tests | Orchestrator untested |
| Components | 0 files | 0 tests | No React component tests |
| API Routes | 0 files | 0 tests | No route handler tests |

**Total: 12 test files, 82 passing tests**

## Test Structure Pattern

Every test file follows this structure:

```typescript
import { describe, it, expect } from "vitest";           // 1. Vitest imports (explicit despite globals)
import { functionUnderTest } from "../module";             // 2. Module under test
import type { SomeType } from "@/lib/some/types";          // 3. Type imports

// 4. Factory functions (if needed)
function makeTestData(overrides: Partial<SomeType> = {}): SomeType {
  return { ...defaults, ...overrides };
}

// 5. Test suites - one describe per exported function
describe("functionUnderTest", () => {
  it("describes expected behavior in plain English", () => {
    const input = makeTestData();                          // Arrange
    const result = functionUnderTest(input);                // Act
    expect(result).toHaveLength(1);                        // Assert
  });
});
```

**Key conventions:**
- Flat `describe`/`it` structure (no deeply nested `describe` blocks)
- Arrange-Act-Assert pattern (implicit, no comments separating phases)
- No `beforeEach` for most tests -- each test builds its own data inline
- `afterEach` only in tests that stub `global.fetch` (Wise client/fetcher tests)
- Explicit `import { describe, it, expect } from "vitest"` even though globals are enabled

## Mock Patterns

### Global Fetch Mocking (Wise API tests only)

Pattern used in `src/lib/wise/__tests__/client.test.ts` and `fetchers.test.ts`:

```typescript
import { afterEach, describe, expect, it, vi } from "vitest";

describe("WiseClient", () => {
  const originalFetch = global.fetch;             // Save original

  afterEach(() => {
    global.fetch = originalFetch;                  // Restore after each test
    vi.restoreAllMocks();
  });

  it("sends correct auth headers", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          status: 200,
          message: "Success",
          data: { /* mock response body */ },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      )
    );
    global.fetch = fetchMock as typeof fetch;       // Override global

    await client.get("/some/path");

    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.wiseapp.live/some/path",
      expect.objectContaining({
        method: "GET",
        headers: expect.objectContaining({
          Authorization: `Basic ${Buffer.from("user-123:api-key-456").toString("base64")}`,
          "x-api-key": "api-key-456",
          "x-wise-namespace": "begifted-education",
        }),
      })
    );
  });
});
```

### Pagination Mocking (chained responses)

```typescript
const fetchMock = vi.fn()
  .mockResolvedValueOnce(
    new Response(JSON.stringify({
      status: 200, message: "Success",
      data: { sessions: [{ _id: "s1", ... }], page_number: 1, page_count: 2, totalRecords: 2 },
    }), { status: 200, headers: { "Content-Type": "application/json" } })
  )
  .mockResolvedValueOnce(
    new Response(JSON.stringify({
      status: 200, message: "Success",
      data: { sessions: [{ _id: "s2", ... }], page_number: 2, page_count: 2, totalRecords: 2 },
    }), { status: 200, headers: { "Content-Type": "application/json" } })
  );
```

### What Is NOT Mocked

- **Database** -- tests don't touch DB; search engine tests use in-memory `SearchIndex` built by `makeIndex()`
- **Internal modules** -- no module-level mocking; tests call real functions
- **Date/time** -- tests use fixed date strings like `"2024-01-15T02:00:00Z"` (a Monday in UTC, Tuesday in Bangkok at 20:00 UTC)
- **File system** -- no file I/O in tested modules

## Factory Functions

### `makeTutor()` -- Indexed Tutor Group

Used in `engine.test.ts` and `compare.test.ts`:

```typescript
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
```

### `makeIndex()` -- Search Index

Used in `engine.test.ts`:

```typescript
function makeIndex(tutors: IndexedTutorGroup[]): SearchIndex {
  const byWeekday = new Map<number, IndexedTutorGroup[]>();
  for (const t of tutors) {
    for (const w of t.availabilityWindows) {
      if (!byWeekday.has(w.weekday)) byWeekday.set(w.weekday, []);
      byWeekday.get(w.weekday)!.push(t);
    }
  }
  return {
    snapshotId: "snap-1",
    builtAt: new Date(),
    tutorGroups: tutors,
    byWeekday,
  };
}
```

### `makeTeacher()` -- Wise API Teacher

Used in `identity.test.ts`:

```typescript
const makeTeacher = (id: string, name: string): WiseTeacher => ({
  _id: id,
  name,
});

const makeNestedTeacher = (id: string, userId: string, name: string): WiseTeacher => ({
  _id: id,
  userId: { _id: userId, name },
});
```

### `makeGroup()` -- Identity Group

Used in `modality.test.ts`:

```typescript
function makeGroup(overrides: Partial<IdentityGroup> = {}): IdentityGroup {
  return {
    canonicalKey: "Test",
    displayName: "Test",
    members: [
      { wiseTeacherId: "t1", wiseDisplayName: "Test Tutor", isOnlineVariant: false },
    ],
    ...overrides,
  };
}
```

### `makeClient()` -- Wise API Client

Used in `fetchers.test.ts`:

```typescript
function makeClient() {
  return new WiseClient({
    userId: "user-123",
    apiKey: "api-key-456",
    namespace: "begifted-education",
    maxRetries: 0,  // Disable retries in tests for speed
  });
}
```

**Key conventions:**
- Factory functions defined at top of test file, before `describe` blocks
- Use `Partial<T>` with object spread for overrides
- Provide sensible defaults that make tests pass without specifying every field
- Disable retries (`maxRetries: 0`) in HTTP client tests
- Use deterministic dates (`"2024-01-15"` = Monday) for predictable weekday calculations
- All factories are **inline** in test files (no shared fixtures directory)

## Test Coverage Areas

### Identity Resolution (`identity.test.ts`)

- Nickname extraction from parenthetical names
- Online variant detection (case-insensitive suffix matching)
- Base name extraction (stripping Online suffix)
- Identity grouping by extracted nickname
- Online/offline pair merging into single group
- Alias override application
- Data issue creation for unresolvable teachers
- Nested Wise user identity fields (userId as object)
- Resolution order: nickname -> alias -> unresolved -> data_issue

### Timezone Conversion (`timezone.test.ts`)

- UTC to Asia/Bangkok conversion (+7 hours)
- Weekday derivation accounting for timezone offset (UTC Monday evening -> Bangkok Tuesday)
- Minute-of-day calculation in local timezone
- Time string parsing ("HH:mm" -> minutes since midnight)

### Availability Normalization (`availability.test.ts`)

- Wise working hour slot conversion to recurring windows
- Empty/undefined input handling
- String weekday mapping from Wise responses ("Sunday" -> 0, "Wednesday" -> 3)
- Zero-length window filtering
- Overlapping window merging on same weekday
- Non-overlapping window preservation
- Cross-weekday separation

### Leave Normalization (`leaves.test.ts`)

- UTC to local time conversion for leave windows
- Empty input handling
- Overlapping leave merging
- Non-overlapping leave preservation (different dates)

### Session Classification (`sessions.test.ts`)

- CONFIRMED/SCHEDULED -> blocking
- CANCELLED/CANCELED -> non-blocking (both spellings)
- Unknown status -> blocking (fail-closed)
- Undefined status -> blocking (fail-closed)
- Session normalization with teacher ID resolution
- Cancelled session non-blocking flag
- Teacher-less session skipping
- Nested Wise user object resolution for teacher ID

### Modality Derivation (`modality.test.ts`)

- Online/offline pair -> "both"
- Online-only group -> "online"
- Session type evidence ("online" type) -> "online"
- Single offline member with no evidence -> "unresolved" with data issue

### Qualification Parsing (`qualifications.test.ts`)

- International curriculum tag parsing: `"Math (Int.) Y2-8"` -> subject/curriculum/level
- Thai curriculum tag parsing
- ExamPrep tag with exam type
- EFL subject parsing
- Unparseable tag -> null return
- Live Wise string tag support (tags as plain strings, not objects)
- Batch tag normalization with issue collection for unmapped tags

### Search Engine (`engine.test.ts`)

- Available tutor matching for recurring slot
- Session blocking in recurring mode (any future overlap)
- Cancelled session non-blocking
- Data issue routing to Needs Review
- Unresolved modality routing to Needs Review
- Mode filtering (online/onsite/either)
- Subject/curriculum/level qualification filtering
- Multi-slot intersection computation
- One-time mode: exact date blocking (same date blocked, different date available)

### Compare Engine (`compare.test.ts`)

- Weekday-filtered session assembly
- Full week session assembly (no weekday filter)
- Weekly hours booked calculation
- Distinct student count computation
- Online variant modality marking on sessions
- Session type evidence fallback for modality
- Same-student overlap conflict detection across tutors
- No conflict for different students at same time
- No conflict for same student at non-overlapping times
- Shared free slot computation (interval intersection minus blocking sessions)

### Slot Parser (`parser.test.ts`)

- Single slot parsing ("Monday 11:00-12:00")
- Multiple comma-separated slots
- Abbreviated day names ("Mon")
- Unparseable input warning
- Default mode application
- En-dash separator support

### Wise API Contract (`client.test.ts`, `fetchers.test.ts`)

- Auth header format (Basic Auth base64, x-api-key, x-wise-namespace, user-agent)
- Base URL correctness (https://api.wiseapp.live)
- Teacher list response parsing (nested userId object)
- Availability response unwrapping (workingHours.slots, leaves)
- Query parameter passing (startTime, endTime as ISO strings)
- Session pagination (COUNT mode, page_number/page_size params)
- Multi-page session aggregation

## Assertion Patterns

### Exact Match
```typescript
expect(result).toBe(true);
expect(result).toBe(540);           // minutes
expect(result).toBe("Celeste");
```

### Length Check
```typescript
expect(result).toHaveLength(1);
expect(result.slots).toHaveLength(2);
```

### Deep Equality
```typescript
expect(result[0]).toEqual({ weekday: 1, startMinute: 540, endMinute: 1020 });
```

### Partial Object Matching
```typescript
expect(result).toEqual([
  expect.objectContaining({
    wiseTeacherId: "t1",
    wiseUserId: "u1",
    wiseDisplayName: "Usanee (Aey) Tortermpun",
  }),
]);
```

### Null / Defined Checks
```typescript
expect(extractNickname("John Smith")).toBeNull();
expect(result.groups.find((g) => g.canonicalKey === "Aey")).toBeDefined();
expect(issue).not.toBeNull();
```

### Greater Than / Range
```typescript
expect(slots.length).toBeGreaterThanOrEqual(1);
```

### Called With (mock assertions)
```typescript
expect(fetchMock).toHaveBeenCalledWith(
  "https://api.wiseapp.live/some/path",
  expect.objectContaining({
    method: "GET",
    headers: expect.objectContaining({ "x-api-key": "api-key-456" }),
  })
);
```

### URL Parameter Verification
```typescript
const calledUrl = new URL(fetchMock.mock.calls[0][0] as string);
expect(calledUrl.pathname).toBe("/institutes/center-1/teachers/wise-user-1/availability");
expect(calledUrl.searchParams.get("startTime")).toBe(startTime.toISOString());
```

## Adding New Tests

### For a new normalization module:

1. Create `src/lib/normalization/__tests__/{module}.test.ts`
2. Import `describe, it, expect` from `vitest`
3. Import functions under test from `../{module}`
4. Import types with `import type` from relevant type files
5. Create a factory function if needed (`make{Thing}()` with `Partial<T>` overrides)
6. Write one `describe` per exported function
7. Test happy path, edge cases (empty/undefined input), and fail-closed behavior

### For a new search feature:

1. Create test in `src/lib/search/__tests__/{feature}.test.ts`
2. Reuse `makeTutor()` and `makeIndex()` patterns from `engine.test.ts`
3. Build minimal `SearchRequest` objects for each scenario
4. Test availability, blocking, filtering, and intersection separately

### For a new Wise API endpoint:

1. Create test in `src/lib/wise/__tests__/{feature}.test.ts`
2. Import `afterEach, vi` from `vitest`
3. Save `global.fetch` in `const originalFetch = global.fetch`
4. Restore in `afterEach(() => { global.fetch = originalFetch; vi.restoreAllMocks(); })`
5. Mock with `vi.fn().mockResolvedValue(new Response(JSON.stringify({...})))`
6. Create client with `maxRetries: 0` to avoid slow test runs
7. Verify both response parsing and request construction (URL, params, headers)

## Coverage Configuration

- No coverage thresholds configured
- No coverage tool explicitly set up (available via `npx vitest run --coverage`)
- Current test count: **82 passing**
- No CI enforcement of coverage minimums

## Test Types Present

| Type | Present | Notes |
|------|---------|-------|
| Unit tests | Yes (12 files) | Pure function tests, no I/O dependencies |
| Integration tests | No | No request/response cycle tests |
| E2E tests | No | No Playwright/Cypress |
| Component tests | No | No React Testing Library |
| Snapshot tests | No | Not used |

---

*Testing analysis: 2026-04-16 (updated from 2026-04-10)*
