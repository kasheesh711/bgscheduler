# Testing Patterns

**Analysis Date:** 2026-05-31

## Test Framework

### Runner

- **Vitest ^4.1.2** — devDependency (`package.json:75`)
- Coverage provider **`@vitest/coverage-v8` ^4.1.5** (`package.json:67`)
- Container harness: **`testcontainers` ^11.14.0** + **`@testcontainers/postgresql` ^11.14.0** (`package.json:73`, `:61`)
- Config: `vitest.config.ts` (project root, 53 lines — the whole test configuration)

```typescript
// vitest.config.ts (abridged)
process.env.TZ = "Asia/Bangkok";            // :4 — global timezone pin

export default defineConfig({
  resolve: { alias: { "@": path.resolve(__dirname, "./src") } },   // :7-11
  test: {
    coverage: {
      provider: "v8",
      include: ["src/**/*.{ts,tsx}"],
      exclude: [
        "src/**/__tests__/**",
        "src/**/*.test.ts",
        "src/**/*.integration.test.ts",
        "src/tests/**",
        "src/app/**/*.tsx",   // page/server components excluded from coverage
      ],
      reporter: ["text", "html"],
    },
    projects: [ /* unit + integration — see below */ ],
  },
});
```

Key config decisions:

- **`process.env.TZ = "Asia/Bangkok"` is set at config load** (`vitest.config.ts:4`), before any project spins up. This is load-bearing: the product normalizes every timestamp to Asia/Bangkok, and dozens of date-boundary tests assume the runner's local zone is Bangkok rather than the CI host's zone.
- **No top-level `environment`/`globals`** — both are set per project (`vitest.config.ts:30-31`, `:40-41`). Both projects use `environment: "node"` and `globals: true`.
- **There are no DOM tests.** No `jsdom`, no `happy-dom`, no `@testing-library/*` anywhere in `package.json` or `src/`. The 65 `*.test.tsx` files render React to a string with `renderToStaticMarkup` from `react-dom/server` and assert on the markup.
- `@` alias mirrors `tsconfig.json` so the same `@/lib/...` imports resolve in tests (`vitest.config.ts:7-11`).
- **No `setupFiles`, no `globalSetup`, no `__mocks__` directory** — there is no global bootstrap; every file wires its own mocks and fixtures.

### Vitest Projects (unit vs integration)

The suite is split into two named Vitest projects (`vitest.config.ts:25-51`). Integration tests are isolated so the default `npm test` never needs Docker.

| Project | `include` | `exclude` | Pool / isolation | Timeouts |
|---------|-----------|-----------|------------------|----------|
| **unit** | `src/**/*.test.ts`, `src/**/*.test.tsx` | `src/**/*.integration.test.ts` | default (threads) | default |
| **integration** | `src/**/*.integration.test.ts` | — | `pool: "forks"`, `fileParallelism: false`, `maxWorkers: 1` (the Vitest 4 replacement for the removed `poolOptions.singleFork`) | `testTimeout: 60_000`, `hookTimeout: 60_000` |

The integration project runs serially in a single forked process because every integration file shares one Postgres instance and truncates between tests — parallel execution would race on the same database (`vitest.config.ts:43-48`, and the comment at `:44` explains the Vitest 4 migration).

### Assertion Library

- Built-in Vitest `expect` (Chai/Jest-compatible API). No additional assertion library, no snapshot files.

### Run Commands

```bash
npm test                  # Unit only — `vitest run --project unit` (no Docker needed)
npm run test:watch        # Unit watch — `vitest --project unit`
npm run test:integration  # Integration only — `vitest run --project integration` (needs Docker or TEST_DATABASE_URL)
npm run test:all          # Both projects — `vitest run`
npm run test:coverage     # Unit + v8 coverage — `vitest run --project unit --coverage`
```

(`package.json:11-15`)

`npm test` is also a hard gate inside the release script:

```
"verify:release": "npm run typecheck && npm test && npm run build && npm run typecheck
                   && git diff --check && npm run guard:production-route-surface"
```

(`package.json:34`) — and `deploy:prod` runs `verify:release` before `assert-production-deploy-ready.mjs` (`package.json:35`). So the **unit** project gates every guarded production deploy; the integration project does not.

Coverage is **not gated** anywhere — no threshold, no CI enforcement. It is produced on demand.

## Test File Organization

### Location

- **Sibling `__tests__/` directories**, co-located with the module under test. The source under test is one level up (`../module-name`) or reached through the `@/` alias.
- **All 369 test files live inside a `__tests__/` directory** — verified: `find src \( -name "*.test.ts" -o -name "*.test.tsx" \) ! -path "*__tests__*"` returns nothing.
- Shared integration infrastructure lives in **`src/tests/integration/`** (`db-helper.ts`, `README.md`) — the only test directory that is not a `__tests__/`.

The suite is **369 test files** (357 unit + 12 integration), holding **985 `describe` blocks** and **4,061 `it` blocks** (unit: 3,923 `it` / 960 `describe`; integration: 138 `it` / 25 `describe`).

Distribution by layer:

| Layer | Files |
|---|---|
| `src/lib/**/__tests__/` | 206 |
| `src/app/api/**/__tests__/` | 81 |
| `src/components/**/__tests__/` | 79 |
| `src/__tests__/` (app-level invariants: `middleware.test.ts`, `vercel-crons.test.ts`) | 2 |
| `src/app/(app)/**/__tests__/` (page-level) | 1 |
| **Total** | **369** |

Test files per `src/lib` module — the tree has 35 entries and every one except `db` has a `__tests__/`:

```
post-class-feedback 35   line              21   admissions        21
us-universities     13   sales-dashboard   13   progress-tests    11
classrooms          11   normalization      7   credit-control     7
competitor-intelligence 6  search           5   room-capacity      5
payroll              5   sync               4   leave-requests     4
learning-plans       4   ai                 4   wise-activity      3
wise                 3   data-health        3   data               3
__tests__ (root)     3   syllabus           2   student-schedule   2
student-promotions   2   ui 1  scheduler 1  proposals 1  ops 1
navigation 1  internal 1  home 1  calendar 1  auth 1
db                   0   ← only lib module with no tests
```

API-route tests by group (81 files): `admissions` 22, `line` 15, `internal` 7, `us-universities` 5, `search` 3, `sales-dashboard` 3, `data-health` 3, `ai-scheduler` 3, `post-class-feedback` 2, `competitor-intelligence` 2, `compare` 2, and one each for `wise-activity`, `tutors`, `student-schedule`, `student-promotions`, `room-capacity`, `proposals`, `progress-tests`, `payroll`, `leave-requests`, `home`, `filters`, `classrooms`, `class-assignments`, `admin`.

Component tests by feature (79 files): `admissions` 24, `us-universities` 23, `sales-dashboard` 7, `post-class-feedback` 6, `compare` 3, `line-review` 2, `class-assignments` 2, and one each for `wise-activity`, `student-schedule`, `student-promotions`, `scheduler`, `room-capacity`, `progress-tests`, `leave-requests`, `learning-plan`, `layout`, `home`, `data-health`, `credit-control`. Six component directories have no tests at all: `competitor-intelligence`, `payroll`, `search`, `skeletons`, `tutor-profiles`, `ui`.

One page-level test sits under `src/app/(app)/`: `src/app/(app)/us-universities/[unitId]/__tests__/page-params.test.ts`.

For calibration against the app surface: 81 route-test files cover a surface of **241 endpoints**, and 1 page-level test plus a handful of source-grep page guards cover **25 pages**. Route and page coverage is therefore selective, not exhaustive — the depth is in `src/lib`, where the decisions live.

### Integration Tests

Twelve `*.integration.test.ts` files, in exactly two modules:

```
src/lib/post-class-feedback/__tests__/auto-approval.integration.test.ts
src/lib/post-class-feedback/__tests__/backfill-window.integration.test.ts
src/lib/post-class-feedback/__tests__/deleted-session-retirement.integration.test.ts
src/lib/post-class-feedback/__tests__/payout-accrual.integration.test.ts
src/lib/post-class-feedback/__tests__/payout-repository.integration.test.ts
src/lib/post-class-feedback/__tests__/payout-run.integration.test.ts
src/lib/post-class-feedback/__tests__/recent-readiness.integration.test.ts
src/lib/post-class-feedback/__tests__/recheck-queue.integration.test.ts
src/lib/post-class-feedback/__tests__/source-status-restore.integration.test.ts
src/lib/sync/__tests__/orchestrator.integration.test.ts
src/lib/sync/__tests__/past-sessions-diff-hook.integration.test.ts
src/lib/sync/__tests__/snapshot-pruning.integration.test.ts
```

The choice of what earns an integration test is deliberate and narrow: **money and snapshot promotion.** The three `sync` files pin `runFullSync`, the atomic snapshot flip, the past-session diff hook, and snapshot pruning. The nine `post-class-feedback` files pin the payout ledger — accrual, finalize, run-candidate selection, lease acquisition, publish idempotency, source-status demotion/restore, recheck-queue ordering, and deleted-session retirement — all against real Postgres with real FK and transaction semantics, because a Drizzle mock cannot prove "pressing Publish twice must not pay a tutor twice" (`src/lib/post-class-feedback/__tests__/payout-run.integration.test.ts:1-10`).

Note that `past-sessions-diff-hook` and several post-class concerns exist in **both** unit and integration variants: the unit variant pins the decision logic, the integration variant pins the persistence.

### Naming

- `{module}.test.ts` / `{module}.test.tsx` for unit tests — matches the source file's base name.
- `{module}.integration.test.ts` for DB-backed tests — the `.integration` infix is the only thing routing a file to the integration project.
- `{module}.eval.test.ts` for fixture-corpus quality gates — one file: `src/lib/line/__tests__/name-matcher.eval.test.ts`, whose header documents fixture provenance and states that production-labeled calibration is still a follow-up (`:1-12`).
- Cross-cutting guards name themselves by what they protect rather than by one source file: `migration.test.ts`, `page-guards.test.ts`, `cron-registry.test.ts`, `workspace-contract.test.ts`, `view-transitions-source.test.ts`, `empty-state-source.test.ts`, `vercel-crons.test.ts`.

### Coverage Surface

Tests reach every `src/lib` module except `db`, both app-level invariant surfaces, and a large share of API routes and components. **Still untested:**

- `src/lib/db/` — `index.ts` (the Neon singleton), `schema.ts`, and `seed.ts` have no tests.
- The 20+ `scripts/*.ts` runners (payout workbook operations, IPEDS import, AI-scheduler eval/replay/compare, room-capacity import, seeds). `scripts/` has its own `tsconfig.json` and a `scripts/stubs/` shim directory, but zero test files.
- The `.mjs` guard scripts (`check-production-route-surface.mjs`, `check-sales-dashboard-scope.mjs`, `assert-production-deploy-ready.mjs`) are themselves guards and are not tested.
- Six component directories (`competitor-intelligence`, `payroll`, `search`, `skeletons`, `tutor-profiles`, `ui`) have no component tests — though `search`, `payroll`, and `competitor-intelligence` all have deep `src/lib` coverage behind them.
- **Interactive** component behavior. Component tests assert SSR markup, exported pure helpers, or grep source; there is no click/keyboard/state-transition coverage anywhere.
- Auth internals beyond `src/lib/auth/__tests__/signin-callback.test.ts` and `src/lib/__tests__/auth-access.test.ts`. `src/lib/auth.ts` itself is mocked in 77 files and unit-tested in none.

## Test Structure

### Top-Level Layout

```typescript
import { describe, it, expect } from "vitest";
import {
  extractNickname,
  isOnlineVariant,
  getBaseName,
  resolveIdentities,
} from "../identity";
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

- One `describe` block **per exported function or scenario**; the `describe` name usually matches the exported symbol verbatim (`describe("runPayoutAccrualPass", ...)`, `describe("publishPayoutRun", ...)`, `describe("acquirePayoutRunLease", ...)`, `describe("selectPayoutRunCandidates", ...)`, `describe("retireDeletedWiseSessions", ...)`).
- `it` descriptions read as present-tense English sentences that state the rule, not the mechanics: `it("anchors the deadline to the Bangkok scheduled-end date plus two calendar days", ...)` (`src/lib/post-class-feedback/__tests__/policy.test.ts:44`).
- Scenario suites carry an explicit coverage-tag prefix tying the file to a planning artifact — `TCOV-01`, `TCOV-02`, `TCOV-04`, `TCOV-06`, `TCOV-07` for test-coverage plans, `REC-01`…`REC-04` for post-class recovery decisions, and `OPS-01` for the pruning job. Examples: `describe("runFullSync — TCOV-02 integration (real Postgres)", ...)` (`src/lib/sync/__tests__/orchestrator.integration.test.ts:196`), `describe("pruneOldSnapshots — OPS-01 integration (real Postgres)", ...)` (`src/lib/sync/__tests__/snapshot-pruning.integration.test.ts:104`), `describe("REC-01 run-wide source demotion and restore", ...)` (`src/lib/post-class-feedback/__tests__/source-status-restore.integration.test.ts:207`), `describe("REC-04 non-ready-first recheck ordering", ...)` (`src/lib/post-class-feedback/__tests__/recheck-queue.integration.test.ts:205`), `describe("middleware — TCOV-06 part 2 (bypass paths)", ...)` (`src/__tests__/middleware.test.ts:19`).
- Design/decision IDs appear in test names and comments where load-bearing — most heavily `REL-05` (Wise status-code-aware retry policy, 6 occurrences in `src/lib/wise/__tests__/client.test.ts:45-150`), plus `MOD-01`/`MOD-02`/`MOD-03`/`MOD-05`, `D-01`…`D-22`, `PAST-01`, and `REL-02`/`REL-03`/`REL-04`/`REL-08`.
- **Nothing is skipped.** There are zero `it.skip` / `describe.skip` / `it.todo` / `.only(` occurrences in the suite.

### Setup & Teardown

- `beforeEach`/`afterEach` for mock reset and fake-timer cleanup.
- API-route suites reset all mocks per test and re-stub the auth guard, then drive the mocked data layer per case.
- Integration suites use `beforeAll`/`afterAll` to start/stop the database handle and `beforeEach` to truncate:
  ```typescript
  beforeAll(async () => { handle = await startTestDb(); }, 60_000);
  afterAll(async () => { if (handle) await stopTestDb(handle); });
  beforeEach(async () => {
    await truncateAll(handle.db);
    await handle.db.delete(schema.postClassPayoutTutorNames);
  });
  ```
  (`src/lib/post-class-feedback/__tests__/payout-run.integration.test.ts:38-49`) — the extra `delete` is a historical belt-and-braces line: `post_class_payout_tutor_names` is now inside the shared truncate list (`src/tests/integration/db-helper.ts:80`), so the statement is redundant today. Keep it or drop it deliberately, but do not treat it as evidence the shared list covers the table you are adding.
- Tests that mutate `global.fetch` snapshot the original at `describe` scope and restore it plus `vi.restoreAllMocks()` in `afterEach` (`src/lib/wise/__tests__/client.test.ts:4-10`).

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
    wiseRecords: [{ wiseTeacherId: "t1", wiseDisplayName: "Test (Test) Tutor", isOnline: false }],
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

The `overrides: Partial<T> = {}` idiom is pervasive across every domain — `version(...)` in `src/lib/post-class-feedback/__tests__/policy.test.ts:21-41`, `modelParsed(...)` in `src/lib/ai/__tests__/scheduler.test.ts:31-62`, row factories in the dashboard component tests. Where a factory would over-specify a wide DB row, tests instead cast a partial literal with a commented `as unknown as T` and say which columns are deliberately unexercised (`src/components/us-universities/__tests__/institution-card.test.tsx:6-20`).

Integration files add scenario builders that return a fake `WiseClient` or a fake `MasterLedgerGateway` holding a real in-memory ledger, so the "publish twice" property is observable (`src/lib/post-class-feedback/__tests__/payout-run.integration.test.ts:32`, `:76+`).

### Assertion Style

- `expect(value).toBe(...)` / `.toEqual(...)` — primitive vs deep equality.
- `expect(arr).toHaveLength(N)`, `.toContain(...)`, `.toBeNull()`, `.toBeUndefined()`, `.toBeDefined()`, `.toBeGreaterThan(...)`.
- `expect.objectContaining(...)` for partial mock-arg matching:
  ```typescript
  expect(fetchMock).toHaveBeenCalledWith(
    "https://api.wiseapp.live/user/getUser",
    expect.objectContaining({
      method: "GET",
      headers: expect.objectContaining({ Authorization: `Basic ${...}` }),
    }),
  );
  ```
  (`src/lib/wise/__tests__/client.test.ts:29-40`)
- SSR component tests assert on substrings of the rendered HTML, including accessible labels: `expect(html).toContain("Add Example University to compare")` (`src/components/us-universities/__tests__/institution-card.test.tsx:43`).
- Ordering assertions for source-inspection tests compare `indexOf` positions — e.g. the access guard must appear before the feature content in a page file (`src/lib/learning-plans/__tests__/page-guards.test.ts:11-18`).
- `it.each` / `describe.each` table-driven cases appear in 9 files: `src/__tests__/middleware.test.ts`, `src/app/api/progress-tests/__tests__/route.test.ts`, `src/components/admissions/__tests__/section-form.test.tsx`, `src/lib/__tests__/auth-access.test.ts`, `src/lib/admissions/__tests__/{notes,recommenders}.test.ts`, `src/lib/classrooms/__tests__/assignment-engine.test.ts`, `src/lib/post-class-feedback/__tests__/{payout-tutor-mapping,shadow-review}.test.ts`.

## Mocking

### Framework

- **Vitest's built-in `vi`** — `vi.fn()`, `vi.mock()`, `vi.mocked()`, `vi.spyOn()`, `vi.useFakeTimers()`, `vi.setSystemTime()`, `vi.resetAllMocks()`, `vi.restoreAllMocks()`, `vi.unstubAllGlobals()`, and `importOriginal` for partial mocks (31 files).
- No external mocking libraries (no `jest`, `sinon`, `nock`, `msw`). `vi.hoisted` is used in only 3 files.

### Module Mocking with `vi.mock()` (dominant pattern)

`vi.mock()` is how nearly every route and service test isolates the unit under test. The most-mocked modules, by file count:

| Mock target | Files | Why |
|---|---|---|
| `@/lib/db` | 91 | importing it constructs the Neon driver |
| `@/lib/auth` | 77 | importing it executes NextAuth at module load |
| `next/navigation` | 25 | client components call `useRouter`/`useSearchParams` |
| `server-only` | 23 | server-only modules throw when imported outside a server graph |
| `@/lib/admissions/access` | 23 | partially mocked — see below |
| `@/lib/wise/client` | 9 | keeps the Wise API out of every test run |
| `next/cache` | 5 | `"use cache"` helpers (`cacheTag`/`cacheLife`) are no-ops under Vitest |
| `@/lib/auth-edge` | 1 | middleware test flattens `edgeAuth` to identity |

Two shapes matter.

**Full stub** — one `vi.fn()` per export, driven with `vi.mocked(...)`:

```typescript
vi.mock("@/lib/db", () => ({ getDb: vi.fn() }));
vi.mock("@/lib/auth", () => ({ auth: vi.fn() }));
vi.mock("@/lib/admissions/cases", () => ({
  createCase: vi.fn(),
  getCaseloadForUser: vi.fn(),
}));
```

(`src/app/api/admissions/cases/__tests__/route.test.ts:8-22`)

**Partial mock via `importOriginal`** — keep the real logic you want under test, stub only the guard:

```typescript
vi.mock("@/lib/admissions/access", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/admissions/access")>();
  return {
    ...actual,
    requireAdmissionsSession: vi.fn(),
    requireCaseAccess: vi.fn(),
    requireCounselorOrAdmin: vi.fn(),
  };
});
```

(`src/app/api/admissions/cases/__tests__/route.test.ts:10-18`) — the comment at `:4-7` states the intent explicitly: the real `admissionsErrorResponse` status mapping (401/403/404/409/500) stays under test while the session guard is driven directly. Prefer this over a full stub whenever the module also owns behavior you care about.

`vi.mock("server-only", () => ({}))` is a plain neutralizer, used by both unit and integration files that import server-scoped modules directly (`src/lib/post-class-feedback/__tests__/payout-run.integration.test.ts:14`). The parallel production-side shim for the `scripts/` runners lives in `scripts/stubs/`.

Route handlers are invoked directly with a hand-built `NextRequest`, and dynamic-route handlers receive a context whose `params` is a `Promise` (Next 16 convention):

```typescript
function postRequest(body?: unknown) {
  return new NextRequest("http://test.local/api/admissions/cases", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}
```

(`src/app/api/admissions/cases/__tests__/route.test.ts:63-70`) — note the spread that omits the body entirely, which is how the "malformed / missing body → 400" branch is exercised without constructing an invalid `Request`.

### `global.fetch` Mocking

Five files touch `global.fetch`. Three are the Wise-facing client/fetcher suites (`src/lib/wise/__tests__/{client,fetchers,post-class-feedback-fetchers}.test.ts`); the other two are admissions component tests that exercise exported request helpers (`requestCohortCreate`, `requestPushNewItems`) pulled out of the `.tsx` so they can be tested without a DOM (`src/components/admissions/__tests__/{cohorts-manager,counselors-manager}.test.tsx`).

They snapshot the original at `describe` scope and restore it in `afterEach`:

```typescript
describe("WiseClient", () => {
  const originalFetch = global.fetch;
  afterEach(() => {
    global.fetch = originalFetch;
    vi.restoreAllMocks();
  });
  // ...
  global.fetch = fetchMock as typeof fetch;
```

(`src/lib/wise/__tests__/client.test.ts:4-19`)

Paginated fetchers chain `.mockResolvedValueOnce()` per page and inspect `fetchMock.mock.calls[i][j]` to assert the pagination contract. Everywhere else, HTTP is mocked one level higher by stubbing `@/lib/wise/client` or `@/lib/wise/fetchers`.

### In-Memory Drizzle Mocks (unit DB tests)

Unit tests that must touch the DB layer mock `@/lib/db`'s `getDb()` with a hand-rolled query-builder chain that resolves exactly the call chain the function under test uses:

```typescript
// Mock db — the fetcher calls `db.select().from(X).where(Y)` and awaits.
const mockDb = {
  select: vi.fn(() => ({
    from: vi.fn(() => ({
      where: vi.fn(() => Promise.resolve(mockRows.slice())),
    })),
  })),
};
vi.mock("@/lib/db", () => ({ getDb: () => mockDb }));
```

(`src/lib/data/__tests__/past-sessions.test.ts:6-20`, with a comment naming the exact chain being emulated) — mutable fixture state is reset in `beforeEach`.

This scales poorly past a couple of chained calls. **The rule the codebase now follows: if the assertion depends on FK behavior, transactions, ordering, uniqueness, or `ON CONFLICT`, write an integration test instead of deepening the Drizzle mock.** That is precisely the boundary the 12 integration files sit on.

### Container-Backed Integration (testcontainers)

`src/tests/integration/db-helper.ts` is the single shared harness. It boots a `postgres:16-alpine` container, connects with `pg.Pool` + `drizzle-orm/node-postgres`, runs the real `drizzle/` migrations, and exposes `truncateAll`:

```typescript
export async function startTestDb(): Promise<Handle> {
  const externalUrl = process.env.TEST_DATABASE_URL?.trim();
  const container = externalUrl
    ? null
    : await new PostgreSqlContainer("postgres:16-alpine")
      .withDatabase("bgscheduler_test").withUsername("test").withPassword("test").start();

  const pool = new Pool({ connectionString: externalUrl || container!.getConnectionUri() });
  const db = drizzle(pool, { schema });
  await migrate(db, { migrationsFolder: path.resolve(__dirname, "../../../drizzle") });
  return { db, pool, container };
}
```

(`src/tests/integration/db-helper.ts:18-41`)

**`TEST_DATABASE_URL` escape hatch** (`db-helper.ts:19-24`, `:14`): setting it points the suite at an already-running Postgres instead of a container, for machines without a Docker daemon. The comment is emphatic and should be respected — the target gets migrated and truncated like any container, so **it must be a scratch database, never one holding data anyone wants to keep.**

`truncateAll` issues one `TRUNCATE ... RESTART IDENTITY CASCADE`; FK chains are followed by `CASCADE`, so ordering is irrelevant (`db-helper.ts:52-96`).

> **Known drift:** the truncate list is hand-maintained and currently names 39 tables — the core snapshot/tutor/classroom set (19) plus the `post_class_*` family (20). Against **188 tables** in `src/lib/db/schema.ts`, that is a small minority. It works today because only `sync` and `post-class-feedback` have integration tests, but it is a trap for the next feature that adds one: nothing fails loudly when a table is missing from the list, the next test just inherits dirty rows. **Extending the truncate set is part of adding an integration test, not an afterthought.**
>
> A second, smaller drift: `src/tests/integration/README.md:3-4` still says the harness is used by suites "in the `src/lib/sync/__tests__/` directory" — nine of the twelve consumers now live in `src/lib/post-class-feedback/__tests__/`.

**Why two drivers:** production uses `drizzle-orm/neon-http`, which cannot speak to a generic Postgres TCP port; integration tests use `drizzle-orm/node-postgres`. Both consume the same `drizzle/` migrations and present the same Drizzle query API, so there is no migration drift (`src/tests/integration/README.md:24-31`). Docker must be running; `postgres:16-alpine` (~80MB) is pulled on first run.

Integration tests still inject **fakes at the outer boundary** — a fake `WiseClient` whose `get<T>(path, params)` pattern-matches the path, and a fake `MasterLedgerGateway` for the payout sheet — so only the DB is real; Wise and Google Sheets are never contacted. Some sync tests go further and install a temporary plpgsql trigger to simulate a mid-transaction failure, dropping it in a `finally`.

### Fake Timers

Ten files use fake timers, all for Bangkok day-boundary, retry-backoff, or "today"-window logic:

```typescript
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-04-15T00:00:00+07:00"));
});
afterEach(() => { vi.useRealTimers(); });
```

Files: `src/lib/search/__tests__/{compare,engine}.test.ts`, `src/lib/room-capacity/__tests__/dates.test.ts`, `src/lib/competitor-intelligence/__tests__/normalization.test.ts`, `src/lib/post-class-feedback/__tests__/payout-writer.test.ts`, `src/lib/wise/__tests__/client.test.ts` (retry backoff), and the `compare`, `compare/discover`, `student-promotions`, and `internal/admissions-notifications` route tests. Always pair `useFakeTimers` with `useRealTimers` in teardown.

### Environment-Variable Gating

Domains guarded by feature flags or API keys (AI scheduler, LINE, competitor intelligence) snapshot the relevant `process.env` keys at file scope, set them per test, and restore them in `afterEach` so both flag-off and flag-on paths are covered without leaking state:

```typescript
const originalEnv = {
  OPENAI_API_KEY: process.env.OPENAI_API_KEY,
  ENABLE_AI_SCHEDULER: process.env.ENABLE_AI_SCHEDULER,
  OPENAI_SCHEDULER_MODEL: process.env.OPENAI_SCHEDULER_MODEL,
  OPENAI_SCHEDULER_REASONING_EFFORT: process.env.OPENAI_SCHEDULER_REASONING_EFFORT,
};

afterEach(() => {
  vi.unstubAllGlobals();
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});
```

(`src/lib/ai/__tests__/scheduler.test.ts:24-29`, `:65-74`) — restoring by delete-vs-assign matters, because assigning `undefined` would leave the literal string `"undefined"` in `process.env`.

### Source Code Inspection (Grep Assertions)

For invariants that are easier to read off the source than to drive behaviorally, tests read files with `node:fs.readFileSync` and assert on their contents. **21 files** use this technique, in three distinct flavors:

1. **Config-vs-code registries.** `src/lib/data-health/__tests__/cron-registry.test.ts:6-20` parses `vercel.json` and asserts the deployed cron list is exactly equal to the in-app `SCHEDULED_CRON_JOBS` registry (sorted by path, compared with `toEqual`) — so a cron added to one and not the other fails the build. It also asserts the room-utilization sync is deliberately *absent* from the registry (manual-only, `:35-38`). `src/__tests__/vercel-crons.test.ts:13-40` adds semantic checks on top: the staggered `*/30`, `5,35`, `10,40`, `20,50` schedules, and a test asserting the daily admissions-notification minute (`12`) collides with no other cron's minute field across all **15 crons**.
2. **Migration SQL guards.** The three `migration.test.ts` files (`post-class-feedback`, `learning-plans`, `data-health`) read the specific `drizzle/00NN_*.sql` files plus `drizzle/meta/_journal.json` and assert the required tables/columns are created and the journal entries exist — the post-class one alone pins seven migrations, `0055` through `0062` (`src/lib/post-class-feedback/__tests__/migration.test.ts:1-40`). This catches a schema edit that never got a migration.
3. **Page/UI ordering invariants.** `src/lib/learning-plans/__tests__/page-guards.test.ts:11-18` asserts `await requireLearningPlansAccess()` appears *before* `<LearningPlanForm` in the page source, and `:22-40` asserts the same guard precedes `await searchParams` in both the print-route metadata and body — an access-control ordering rule that no SSR assertion could catch. Similar shells: `src/components/{compare,sales-dashboard,scheduler,wise-activity,post-class-feedback,class-assignments}/__tests__/*`, plus `src/lib/classrooms/__tests__/{publish-eligibility,rooms}.test.ts`, `src/lib/ops/__tests__/stale.test.ts`, `src/lib/data/__tests__/past-sessions.test.ts` (cache-tag drift guard), `src/lib/us-universities/__tests__/dot-map.test.ts`, and `src/app/api/sales-dashboard/__tests__/dimensions-route.test.ts:76-81` (asserts the data layer still carries the sales-dashboard cache tag).

Use sparingly — only when the invariant guards a regression that behavior tests structurally cannot catch. A grep assertion is brittle against harmless refactors, so each one should carry a comment saying what it is protecting.

### What to Mock

- External I/O: `fetch`, the DB client (`@/lib/db`), the Wise client, Google Sheets/Drive gateways, filesystem writes.
- Auth (`@/lib/auth`, `@/lib/auth-edge`, `@/lib/admissions/access`, `@/lib/post-class-feedback/access`) in route and middleware tests — but prefer `importOriginal` partial mocks when the module also owns error-mapping you want tested.
- `server-only` (neutralize to `{}`) and `next/navigation` / `next/cache` when importing server or client modules outside their runtime.
- Side-effecting data-layer modules behind a route handler (one `vi.fn()` per export).
- Time via `vi.useFakeTimers()` + `vi.setSystemTime()`; flags via the `process.env` snapshot/restore pattern.

### What NOT to Mock

- Pure normalization, parsing, policy, and math — identity extraction, Bangkok date math, feedback policy, payout window math, sales/payroll/room-capacity calculators. Deterministic, tested with literal inputs.
- Internal helpers within the module under test.
- The database, when the assertion depends on real Postgres semantics — use a container instead of a deeper Drizzle mock.
- Static JSON data that ships with the product: `src/lib/syllabus/__tests__/data-integrity.test.ts:3-16` imports the real `year-01.json` … `year-13.json` and `topics-index.json` and validates them directly. That is a data-integrity gate on shipped content, not a fixture.
- Types — erased at runtime; mocking adds no signal.

## Fixtures and Factories

### Test Data

- **Inline factory functions** remain the dominant pattern, now numbering in the hundreds across domains. Defaults cover the happy path; tests pass `Partial<T>` overrides.
- **No external fixture files, no `fixtures/` / `__fixtures__/` / `__mocks__/` directories anywhere in `src/`.** All test data is constructed inline; the only shared test helper in the repo is `src/tests/integration/db-helper.ts`.
- The one large hand-built corpus is the LINE name-matcher eval directory, which is still inline in `name-matcher.eval.test.ts` and carries a provenance header explaining that the names are synthetic-but-realistic, that no row maps to a real production record, and that the distractor set was constructed by hand — with production-labeled calibration named as an explicit follow-up before the matcher is relied on at scale (`:1-20`).
- Date literals use ISO strings or `new Date(Date.UTC(...))`; Bangkok-sensitive tests pin the offset explicitly (`+07:00`). Spreadsheet-facing payout tests convert through explicit `dateSerial`/`timeSerial` helpers rather than trusting a library (`src/lib/post-class-feedback/__tests__/payout-run.integration.test.ts:63-68`).

### Common Factory Conventions

```typescript
function makeTeacher(id: string, name: string): WiseTeacher {
  return { _id: id, name };
}
function makeNestedTeacher(id: string, userId: string, name: string): WiseTeacher {
  return { _id: id, userId: { _id: userId, name } };
}
```

(`src/lib/normalization/__tests__/identity.test.ts`)

Positional args for two- or three-field shapes; `Partial<T>` override objects for anything wider. Integration factories return fake clients and seed helpers rather than raw rows.

### Location

- Fixtures and factories live **inline at the top of each test file**, above the first `describe`.
- The one cross-file exception is the integration harness in `src/tests/integration/`.

## Coverage

### Requirements

- **None enforced** — no threshold, no CI coverage gate. Coverage is opt-in via `npm run test:coverage` (unit project, v8 provider, `text` + `html` reporters). Page/server components (`src/app/**/*.tsx`), `src/tests/**`, and all test files are excluded from the coverage scope (`vitest.config.ts:13-24`).
- What *is* enforced is that the whole unit project passes: `npm test` runs inside `verify:release`, which `deploy:prod` requires (`package.json:34-35`).
- Total: **369 test files**, **4,061 `it` blocks** (3,923 unit + 138 integration) across **985 `describe` blocks**. Any legacy doc citing "82 tests" or "132 test files" predates most of the current feature set.

### View Coverage

```bash
npm run test:coverage              # unit project only, v8, text + html report
npm run test:all -- --coverage     # include integration (requires Docker or TEST_DATABASE_URL)
```

### Coverage Surface (descriptive)

| Domain | Representative Test Files | Areas Covered |
|--------|--------------------------|---------------|
| Post-class feedback / payout | `src/lib/post-class-feedback/__tests__/*` (35: 26 unit + 9 integration), `src/components/post-class-feedback/__tests__/*` (6), 2 API | Feedback policy + deadline anchoring, content assessment, similarity, AI review, shadow review, sync, backfill + reminder jobs, access/capabilities, settings, notifications, metrics, events, detail, actions, deductions, migration SQL; payout config/plan/window/window-health/sheet/master/writer/tutor-mapping/workbook-ops; and on real Postgres: accrual, finalize, run-candidate selection, lease acquisition, publish idempotency, compensation + post-close exceptions, strict close fencing, CSV retry fencing, audited date rolls, source-anchor fingerprint quarantine, source-status demotion/restore (REC-01), recheck-queue ordering (REC-02/REC-04), backfill window (REC-03), auto-approval/auto-reopen sweeps, recent-readiness, deleted-session retirement |
| Admissions | `src/lib/admissions/__tests__/*` (21), `src/components/admissions/**` (24), `src/app/api/admissions/**` (22) | Role/case access wall, parent projection whitelist, audit diffs, cases, sections, checklists, colleges, essays, activities, testing release, recommenders, meetings, notes sharing, members, announcements, resources, calendar, cohorts, counselors, notifications, student home |
| US universities (IPEDS) | `src/lib/us-universities/__tests__/*` (13), `src/components/us-universities/__tests__/*` (23), 5 API, 1 page | Query/transform/parser, CSV export, active + chart filters, compare set, constants, trend + dossier sections, dot-map projection, nav, formatting; research-console shell, cards/table, charts, price ladder, demographics, shortlist, combobox, compare panel/sheet |
| LINE | `src/lib/line/__tests__/*` (21), `src/components/line-review/__tests__/*` (2), 15 API | Webhook + signature, client, classifier confidence, contact aliases, data-group ingest, mentions, name matcher (+ eval corpus), backlog matcher/recovery, link validation, student links, OA resolver (+ extension candidates), review service, operational planner, schedule bot (core/group/copy), test-data cleanup |
| Sales dashboard | `src/lib/sales-dashboard/__tests__/*` (13), `src/components/sales-dashboard/**` (7), 3 API | Parser, analytics, cohorts, CSV, dates, dimensions, GM insights, import guard, lifecycle, package hours, projection, Sheets access, student journey; tab views + export + empty-state ordering |
| Progress tests | `src/lib/progress-tests/__tests__/*` (11), 1 component, 1 API | Engine, recommend, booking, sync + run-sync-request, DB layer, API layer, teacher access, teacher heads-up, admin digest, AI summary |
| Classrooms / assignments | `src/lib/classrooms/__tests__/*` (11), `src/components/class-assignments/__tests__/*` (2), 2 API | Assignment engine, publish eligibility, floor-plan map, room catalog, reconciliation, schedule + admin email, morning automation, tutor contacts, visualization, data timezone |
| Normalization | `src/lib/normalization/__tests__/*` (7) | Identity cascade, timezone (UTC→Bangkok), availability merge, leaves, session blocking, modality fail-closed, qualification tag parsing |
| Search / compare | `src/lib/search/__tests__/*` (5), `src/components/compare/__tests__/*` (3), 5 API | `executeSearch` recurring/one-time blocking, qualification + multi-slot intersection, `buildCompareTutor`, conflict detection, shared free slots, recommend tiering, parser, in-memory index; density overview, modality display, view transitions |
| Credit control | `src/lib/credit-control/__tests__/*` (7), 1 component | Sync, Wise + Wise-teacher fetch, analytics, churn, payload patch, queue window; queue panel |
| Competitor intelligence | `src/lib/competitor-intelligence/__tests__/*` (6), 2 API | Access, AI extraction, budget guard, normalization, sync guard, war room |
| Room capacity | `src/lib/room-capacity/__tests__/*` (5), 1 component, 1 API | Utilization analysis, date math, forecast, package mix; dashboard SSR |
| Payroll | `src/lib/payroll/__tests__/*` (5), 1 API | Domain rules, rate card, data layer, sync, May reconciliation scenario |
| Sync | `src/lib/sync/__tests__/*` (1 unit + 3 integration) | Modality-conflict handling; and on real Postgres: `runFullSync` persistence + atomic promotion + unresolved-ratio gate (TCOV-02), past-session diff hook (TCOV-04/PAST-01), snapshot pruning + pruning-metadata-failure resilience (OPS-01) |
| Wise client | `src/lib/wise/__tests__/{client,fetchers,post-class-feedback-fetchers}.test.ts` | Auth header construction, base URL, REL-05 status-code-aware retry/backoff (4xx fail fast, 5xx/429/network retry), teacher/availability parsing, COUNT pagination, post-class session/feedback fetchers |
| Wise activity | `src/lib/wise-activity/__tests__/{format,reconciliation,sync}.test.ts`, 1 API, 1 component | Event normalization, reconciliation, sync dedupe/stop conditions, formatters, reconciliation UI |
| Leave requests | `src/lib/leave-requests/__tests__/*` (4), 1 component, 1 API | Sheet parsing, tutor/session matching, sync, contact context; view model |
| Learning plans | `src/lib/learning-plans/__tests__/*` (4), 1 component | Access + access policy, migration SQL guard, page + print-route access-ordering guards; digit-safe rendering |
| AI scheduler | `src/lib/ai/__tests__/*` (4), 3 API, 1 component | Parse normalization, filter/tutor resolution, redaction, conversation flow, academic levels, correction telemetry (env-flag-gated); compare focus |
| Data health / ops | `src/lib/data-health/__tests__/*` (3), `src/lib/internal/__tests__/cron-watchdog.test.ts`, `src/lib/ops/__tests__/stale.test.ts`, 3 API, 1 component | Sync status, cron registry ↔ `vercel.json` equality, migration guard, cron watchdog, 90-minute API + 2-hour banner staleness thresholds |
| Student schedule / promotions | `src/lib/{student-schedule,student-promotions}/__tests__/*` (4), 2 components, 2 API | Month data + share links; promotion rules + data; month calendar, target-grade filter |
| Syllabus | `src/lib/syllabus/__tests__/*` (2) | Year-01…Year-13 JSON data integrity, report params |
| Home / navigation / layout | `src/lib/{home,navigation}/__tests__/*`, `src/components/{home,layout}/__tests__/*`, 1 API | Home summary, tool registry, hub SSR, nav shell |
| Cross-cutting | `src/lib/__tests__/{auth-access,bangkok-time,tutor-profile-import}.test.ts`, `src/lib/{calendar,proposals,scheduler,ui}/__tests__/*` | Access helpers, Bangkok time helpers, tutor-profile import, month grid, proposal overlap, admin colors, view transitions |
| API routes (all) | `src/app/api/**/__tests__/*` (81) | Auth gating → JSON parse → Zod validation → handler behavior, across every route group; 6 of the 7 internal-cron route tests additionally assert the `CRON_SECRET` check (all but `post-class-feedback-backfill`) |
| App invariants | `src/__tests__/{middleware,vercel-crons}.test.ts` | Middleware bypass/redirect rules and per-page allowlist gating (`TCOV-06`); `vercel.json` cron paths, schedules, and minute-collision staggering across all 15 crons |

## Test Types

### Unit Tests

- 357 of 369 files are unit-scope (the `unit` Vitest project). Pure functions are tested with literal inputs; orchestrators and route handlers use `vi.mock()` plus hand-built `NextRequest` / fake-client mocks.
- Component tests are unit-scope: 61 of the 65 `.test.tsx` files call `renderToStaticMarkup` and assert on the returned HTML string (one `.test.ts` file, `src/components/post-class-feedback/__tests__/operations-filter.test.ts`, does the same — 62 SSR files total). The remaining 4 `.tsx` files (`compare-panel`, `us-universities-shell-nav`, `institution-search-combobox`, `apply-chart-filter`) skip rendering entirely and unit-test pure helpers that happen to be exported from a `.tsx`. Another 21 files (any extension) assert by reading source text. **None of it exercises interaction.**

### Integration / E2E

- **Integration** — 12 container-backed files in the `integration` Vitest project, driven through `src/tests/integration/db-helper.ts` (testcontainers + node-postgres against `postgres:16-alpine`, or an external scratch DB via `TEST_DATABASE_URL`). They require Docker and are excluded from the default `npm test` and from `verify:release`.
- **No browser E2E** — no Playwright, Cypress, or Puppeteer in `package.json`, and no Vitest browser mode. End-to-end production validation relies on the 15 Vercel crons, the `/data-health` dashboard, and admin spot-checks.
- **Adjacent, non-Vitest harnesses** exist as `scripts/` runners rather than tests: `ai-scheduler:evaluate` / `ai-scheduler:compare-models` (`scripts/evaluate-ai-scheduler.ts`, `scripts/compare-ai-scheduler-models.ts`, plus `scripts/replay-ai-scheduler-runs.ts` and a dated `evaluate-ai-scheduler-2026-05-21.ts`) score the AI scheduler against a case file; `scripts/backlog-recovery-dry-run.ts` and `scripts/verify-drive-upload.ts` are manual verification runners; and the `guard:*` scripts diff the app's route surface and sales-dashboard scope against committed manifests. They are run manually or by `verify:release`, not by Vitest.

## Common Patterns

### Async Testing

Native `async/await`; no callback/`done()` style. Applies to fetch mocks, route handlers (`await GET(request)`), and integration DB calls (`await runFullSync(...)`).

```typescript
it("persists a happy-path sync and promotes exactly one active snapshot", async () => {
  const result = await runFullSync(handle.db as unknown as Database, happyPathClient() as never, instituteId);
  expect(result.success).toBe(true);
  expect(result.promotedSnapshotId).toBe(result.snapshotId);
});
```

(`src/lib/sync/__tests__/orchestrator.integration.test.ts:197+`)

The `handle.db as unknown as Database` cast is the standard bridge between the node-postgres test handle and the app's neon-http `Database` type; post-class integration files wrap it in a local `appDb()` helper (`src/lib/post-class-feedback/__tests__/payout-run.integration.test.ts:52-54`).

### API Route Handler Testing

The standard recipe for the 81 route-test files:

1. `vi.mock("@/lib/db", () => ({ getDb: vi.fn() }))` and `vi.mock("@/lib/auth", () => ({ auth: vi.fn() }))` — both must be mocked because importing either executes real driver/NextAuth setup.
2. `vi.mock(...)` every data-layer dependency (full stub), and `importOriginal`-partial-mock any access module whose error mapping you want under test.
3. Import the real symbols and the handler (`GET`/`POST`/`PATCH`/`DELETE`) from `../route` *after* the mocks — Vitest hoists `vi.mock` above imports.
4. In `beforeEach`, `vi.resetAllMocks()` then stub the session guard to the role under test and stub each data fn.
5. Build a `NextRequest` (and, for dynamic routes, `{ params: Promise.resolve({...}) }`) and assert `res.status` + parsed JSON, plus that the mocked data fns received the expected args.

Role-based routes define the personas once at file scope (`COUNSELOR`, `ADMIN`, `STUDENT`, `PARENT`) and loop the same request through each to prove the access wall (`src/app/api/admissions/cases/__tests__/route.test.ts:30-36`).

### Component SSR Testing

```typescript
const html = renderToStaticMarkup(<InstitutionCard row={ROW} inCompare={false} ... />);
expect(html).toContain("Example University");
expect(html).toContain("20,000 and above");   // enum decoded
expect(html).toContain("$18,200");            // currency formatted
expect(html).toContain("Add Example University to compare");  // aria label
```

(`src/components/us-universities/__tests__/institution-card.test.tsx:23-43`)

What this is good for: label/format/derivation correctness and the presence of accessible names. What it cannot see: hooks after first render, event handlers, focus, or anything conditional on client state. Handlers are passed as no-op `() => {}`. When the interesting logic is a pure transform or a request builder, export it from the `.tsx` and test it directly instead of rendering (`applyChartFilter` in `src/components/us-universities/__tests__/apply-chart-filter.test.tsx`; `buildCohortPayload` / `requestCohortCreate` in `src/components/admissions/__tests__/cohorts-manager.test.tsx:10-22`).

### Error / Validation Testing

- Pipeline-return style (`{ result, issues }`): assert on the `issues` array rather than on a thrown error — this is how fail-closed normalization is verified.
- Route handlers: assert `401` when the session guard rejects, `403` on a role wall, `400` on Zod failure by sending a malformed or absent body, `404`/`409` from the real error mapper, and `500` by making a mocked data fn reject with a typed error.
- For functions that throw, `await expect(fn()).rejects.toThrow(...)`.

### Comprehensive Matrix Tests

Long-running invariants are encoded as case-numbered rows with an aggregate `it` looping over them (the modality matrix in `src/lib/search/__tests__/compare.test.ts`; `it.each` tables in 9 files). When the underlying logic changes, the matrix breaks first — by design.

### Backward-Compat Tests

Explicit "old signature still works" tests accompany signature changes — e.g. `it("backward-compat: calling without pastBlocks behaves identically to pre-Phase-7", ...)` pins the 3-arg `buildCompareTutor` call against the 4-arg form (`src/lib/search/__tests__/compare.test.ts:655`, `:676`). Keep them until the old call sites are gone.

### Coverage-Tag & Decision-ID Comments

Test files reference the planning artifact they satisfy in the `describe` name or a header comment (`TCOV-01`/`-02`/`-04`/`-06`/`-07`, `REC-01`…`REC-04`, `OPS-01`) and annotate non-obvious business rules with decision IDs (`REL-02`…`REL-05`/`REL-08`, `MOD-01`…`MOD-05`, `D-01`…`D-22`, `PAST-01`) plus a short rationale. Integration files go further with a multi-line header stating what property is being pinned, what is explicitly out of scope, and how to run the file (`src/lib/sync/__tests__/orchestrator.integration.test.ts:1-9`). These are load-bearing: they tell the next engineer **why** a case exists and **which plan to read** before changing it. Preserve them when editing nearby code.

---

*Testing analysis: 2026-05-31*

_Verified against HEAD + uncommitted WIP on 2026-05-31._
