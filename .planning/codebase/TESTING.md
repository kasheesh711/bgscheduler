# Testing Patterns

**Analysis Date:** 2026-05-31

## Test Framework

### Runner

- **Vitest** — `^4.1.2`, devDependency in `package.json:69`
- Coverage provider **`@vitest/coverage-v8`** `^4.1.5` (`package.json:61`)
- Container backing for integration tests: **`testcontainers` / `@testcontainers/postgresql`** `^11.14.0` (`package.json:55`, `:67`)
- Config: `vitest.config.ts` (project root)

```typescript
// vitest.config.ts (abridged)
process.env.TZ = "Asia/Bangkok";              // pinned at config load (vitest.config.ts:4)

export default defineConfig({
  resolve: {
    alias: { "@": path.resolve(__dirname, "./src") },  // mirrors tsconfig.json paths
  },
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

- **`process.env.TZ = "Asia/Bangkok"` is set at the top of the config file** (`vitest.config.ts:4`), before any project runs. This is load-bearing: the entire app normalizes to Asia/Bangkok, so the test process clock must match or day-boundary math drifts.
- **No top-level `environment`/`globals`** — those are set per-project (`vitest.config.ts:30-31`, `:40-41`). Both projects use `environment: "node"` and `globals: true`.
- There are no DOM tests. The nine `*.test.tsx` files render React to a string with `renderToStaticMarkup` from `react-dom/server` and assert on the markup — no jsdom/happy-dom is installed or configured.
- `@` alias mirrors `tsconfig.json` so the same `@/lib/...` imports work in tests (`vitest.config.ts:7-10`).
- **No `setupFiles`, no `globalSetup`** — there is no global test bootstrap (verified: neither key appears in `vitest.config.ts`); each file wires its own mocks/fixtures.

### Vitest Projects (unit vs integration)

The suite is split into two named Vitest projects (`vitest.config.ts:25-51`). This is the most important structural decision: integration tests are isolated so the default `npm test` never needs Docker.

| Project | `include` | `exclude` | Pool / isolation | Timeouts |
|---------|-----------|-----------|------------------|----------|
| **unit** | `src/**/*.test.ts`, `src/**/*.test.tsx` | `src/**/*.integration.test.ts` | default (threads) | default |
| **integration** | `src/**/*.integration.test.ts` | — | `pool: "forks"`, `fileParallelism: false`, `maxWorkers: 1` | `testTimeout: 60_000`, `hookTimeout: 60_000` |

The integration project runs serially in a single forked process because every integration file shares one ephemeral Postgres container and truncates between tests — parallel execution would race on the same database (`vitest.config.ts:43-48`). A code comment notes that Vitest 4 removed `poolOptions`, so `fileParallelism: false` + `maxWorkers: 1` is the `singleFork: true` equivalent (`vitest.config.ts:44`).

### Assertion Library

- Built-in Vitest `expect` (Chai/Jest-compatible API). No additional assertion library.

### Run Commands

```bash
npm test               # Unit only — `vitest run --project unit` (no Docker needed)
npm run test:watch     # Unit watch — `vitest --project unit`
npm run test:integration  # Integration only — `vitest run --project integration` (requires Docker)
npm run test:all       # Both projects — `vitest run`
npm run test:coverage  # Unit + v8 coverage — `vitest run --project unit --coverage`
```

(`package.json:11-15`)

Tests are also wired into release gating: `verify:release` runs `npm run typecheck && npm test && npm run build && ...` and `deploy:prod` runs `verify:release` before deploying (`package.json:28-29`). So the **unit** project is a hard gate on every release; the **integration** project (Docker-dependent) is run on demand, not in `verify:release`. Coverage is produced on demand and is **not** threshold-gated.

## Test File Organization

### Location

- **Sibling `__tests__/` directories** — co-located with the module under test. The source under test is one level up (`../module-name` or `@/lib/...`). Tests are never colocated next to the source file.
- Shared integration infrastructure lives in **`src/tests/integration/`** (`db-helper.ts`, `README.md`) — the only non-`__tests__` test directory.

The suite now spans **162 test files** (159 unit + 3 integration), with **236 `describe` blocks** and **1056 `it` blocks** (unit: 1044 `it` / 233 `describe`; integration: 12 `it` / 3 `describe`). Tests cover every feature domain, not just the original normalization/search core. (The single `it.each` table lives in `src/lib/classrooms/__tests__/assignment-engine.test.ts`; no `describe.each`, `it.skip`, `it.only`, or `it.todo` appears in the suite.)

Distribution by area (top groups):

```
src/app/api/**/__tests__/             44 files   API route handlers (largest group)
src/components/**/__tests__/          17 files   SSR-markup + source-grep UI invariants
src/lib/line/__tests__/               12 files   webhook / contacts / OA resolver / reviews
src/lib/progress-tests/__tests__/     11 files   every-8-classes tracker (engine, sync, booking, AI, access)
src/lib/classrooms/__tests__/         11 files   assignment engine, floor plan, email, reconciliation
src/lib/sales-dashboard/__tests__/     7 files   parser, analytics, projection, lifecycle, guard, dates
src/lib/normalization/__tests__/       7 files   identity, timezone, availability, leaves, sessions, modality, qualifications
src/lib/search/__tests__/              5 files   engine, compare, index, parser, recommend
src/lib/room-capacity/__tests__/       5 files   analysis, dates, forecast, package-mix, utilization
src/lib/payroll/__tests__/             5 files   data, domain, rate-card, sync, may-reconciliation
src/lib/sync/__tests__/                4 files   1 unit + 3 integration (see below)
src/lib/ai/__tests__/                  4 files   scheduler, scheduler-conversation, academic-levels, correction-telemetry
src/lib/leave-requests/__tests__/      4 files   parser, matching, sync, contact-context
src/lib/data-health/__tests__/         3 files   status, cron-registry, migration
src/lib/wise-activity/__tests__/       3 files   format, reconciliation, sync
src/lib/data/__tests__/                3 files   filters, past-sessions, tutors
src/lib/__tests__/                     3 files   bangkok-time, tutor-profile-import, auth-access
src/lib/wise/__tests__/                2 files   client, fetchers
src/lib/credit-control/__tests__/      2 files   sync, wise
src/__tests__/                         2 files   middleware, vercel-crons (app-level invariants)
src/lib/{ui,scheduler,proposals,ops,auth,home,navigation,student-promotions}/__tests__/  1 file each
```

The **44 API-route** test files split (by top-level group under `src/app/api/`): `line` (14), `internal` cron endpoints (5), `search` (3), `data-health` (3), `ai-scheduler` (3), `compare` (2), and one each for `wise-activity`, `tutors`, `student-promotions`, `sales-dashboard`, `room-capacity`, `proposals`, `progress-tests`, `payroll`, `leave-requests`, `home`, `filters`, `classrooms`, `class-assignments`, `admin`.

The **17 component** test files split (by feature dir under `src/components/`): `compare` (3), `line-review` (2), `class-assignments` (2), and one each for `wise-activity`, `student-promotions`, `scheduler`, `sales-dashboard`, `room-capacity`, `progress-tests`, `leave-requests`, `layout`, `home`, `data-health`.

### Integration Tests

Three files (the integration project) live in `src/lib/sync/__tests__/`:

```
src/lib/sync/__tests__/orchestrator.integration.test.ts
src/lib/sync/__tests__/past-sessions-diff-hook.integration.test.ts
src/lib/sync/__tests__/snapshot-pruning.integration.test.ts
```

They exercise `runFullSync`, the past-session diff hook, and snapshot pruning against a **real Postgres 16 container** via testcontainers, not mocks. Their `describe` names carry the coverage tags they satisfy: `runFullSync — TCOV-02 integration (real Postgres)`, `runPastSessionsDiffHook — TCOV-04 integration (real Postgres)`, and `pruneOldSnapshots — OPS-01 integration (real Postgres)`. Note `past-sessions-diff-hook` exists in **both** a unit variant (`*.test.ts`, with a mocked DB) and an integration variant (`*.integration.test.ts`, against the container).

### Naming

- `{module}.test.ts` / `{module}.test.tsx` for unit tests — matches the source file's base name.
- `{module}.integration.test.ts` for container-backed tests — the `.integration` infix is what routes them to the integration project.
- Source-inspection files name themselves by what they guard, not by a single source file: `view-transitions-source.test.ts`, `empty-state-source.test.ts`, `scheduler-compare-focus.test.ts`, `reconciliation-ui.test.ts`, `cron-registry.test.ts`, `migration.test.ts`.

### Coverage Surface

Tests now cover normalization, search/compare, Wise client + activity, sync orchestration (incl. real DB), classrooms/assignment, room capacity, payroll, credit control, sales dashboard, LINE, leave requests, AI scheduler, proposals, ops/stale detection, the progress-tests tracker, the home hub, navigation tooling, student promotions, data-health cron status, access resolution, API route handlers, middleware, and cron config. **Still untested:**
- DB seed scripts (`src/lib/db/seed.ts`) and the standalone `scripts/*.ts` runners (seeders, evaluators, sync utilities, guards).
- Most React client components — only 17 component files have tests, and those assert SSR markup or grep the source, not interactive (event-driven) behavior.
- Auth internals are covered only at the boundary: `src/lib/auth/__tests__/signin-callback.test.ts` (sign-in callback) and `src/lib/__tests__/auth-access.test.ts` (`resolveUserAccess`). `src/lib/auth.ts` itself is not directly unit-tested.
- The leave-requests source (`src/lib/leave-requests/`) has parser/matching/sync/contact-context tests that exist and pass; its young parser/normalization heuristics still have thin coverage relative to the rest of the pipeline.

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

- One `describe` block **per exported function or scenario**; the `describe` name usually matches the function name verbatim (`describe("getHomeSummaryPayload", ...)`, `describe("resolveUserAccess", ...)`, `describe("adminAccentFor", ...)`, `describe("buildRecommendedSlots", ...)`).
- `it` descriptions read as present-tense English sentences (`it("extracts nickname from parenthetical", ...)`, `it("treats CANCELLED as non-blocking", ...)`).
- Scenario suites carry a descriptive `describe` plus an explicit coverage-tag prefix tying the file to a planning artifact, e.g. `describe("runFullSync — TCOV-02 integration (real Postgres)", ...)` and `describe("WiseClient — REL-05 status-code-aware retry policy", ...)` (`src/lib/wise/__tests__/client.test.ts:45`).
- Design/decision IDs appear in test names and headers where load-bearing (modality `MOD-*`/`D-*`, reliability `REL-05`, ops `OPS-01`, coverage `TCOV-02`/`TCOV-04`).

### Setup & Teardown

- `beforeEach`/`afterEach` from Vitest for mock reset and fake-timer cleanup.
- API-route suites reset all mocks per test and re-stub auth:
  ```typescript
  beforeEach(() => {
    vi.resetAllMocks();
    authMock.mockResolvedValue({ user: { email: "admin@example.com" }, expires: "2026-05-21T00:00:00.000Z" });
    vi.mocked(getSalesDashboardPayload).mockResolvedValue({ ok: true } as never);
  });
  ```
  (`src/app/api/sales-dashboard/__tests__/route.test.ts:60-72`)
- Integration suites use `beforeAll`/`afterAll` to start/stop the container and `beforeEach` to truncate (the `beforeAll` carries a 60s timeout for the image pull):
  ```typescript
  beforeAll(async () => { handle = await startTestDb(); }, 60_000);
  afterAll(async () => { await stopTestDb(handle); });
  beforeEach(async () => { await truncateAll(handle.db); });
  ```
  (`src/tests/integration/README.md:19-21`)
- Tests that mutate `global.fetch` snapshot the original at file scope and restore it in `afterEach` (`src/lib/wise/__tests__/client.test.ts:5-10`).

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
    /* ...sane happy-path defaults... */
    ...overrides,
  };
}
```

(`src/lib/search/__tests__/engine.test.ts`)

The `overrides: Partial<T> = {}` row-factory idiom is pervasive across domains. Recent examples:
- `ledgerRow(overrides: Partial<ProgressTestLedgerRow> = {})` and a derived `attendedRows(count, start)` builder (`src/lib/progress-tests/__tests__/engine.test.ts:16-41`).
- `dailyRow`/`monthlyRow`/`roomRow` in `src/components/room-capacity/__tests__/room-capacity-dashboard.test.tsx`.
- Integration tests add scenario-builder factories that return a fake `WiseClient`: `happyPathClient`, `unresolvedIdentityClient`, and seed helpers like `seedExistingSnapshots` (`src/lib/sync/__tests__/orchestrator.integration.test.ts`).

### Assertion Style

- `expect(value).toBe(...)` / `.toEqual(...)` — primitive vs deep equality.
- `expect(arr).toHaveLength(N)`, `.toContain(...)`, `.toBeNull()`, `.toBeUndefined()`.
- `expect(value).toMatch(/regex/)` and `expect(arr.find(...)).toBeDefined()`.
- `expect.objectContaining(...)` for partial object / mock-arg matching:
  ```typescript
  expect(fetchMock).toHaveBeenCalledWith(
    "https://api.wiseapp.live/user/getUser",
    expect.objectContaining({ method: "GET", headers: expect.objectContaining({ Authorization: ... }) }),
  );
  ```
  (`src/lib/wise/__tests__/client.test.ts:30-41`)
- Custom assertion messages on loop/aggregate checks (compare matrix suites).
- Ordering/structure assertions for source-inspection tests use `indexOf` comparisons (`setupIndex < commandCenterIndex`) — see `src/components/sales-dashboard/__tests__/empty-state-source.test.ts`.

## Mocking

### Framework

- **Vitest's built-in `vi`** — `vi.fn()`, `vi.mock()`, `vi.mocked()`, `vi.spyOn()`, `vi.useFakeTimers()`, `vi.setSystemTime()`, `vi.resetAllMocks()`/`vi.restoreAllMocks()`.
- No external mocking libraries (no `jest`, `sinon`, or `nock`). **No `vi.hoisted`** is used anywhere in the suite (verified across all test files).
- **60 test files** use `vi.mock()`; **7** use fake timers; **2** assign `global.fetch`; **14** read source via `readFileSync`.

### Module Mocking with `vi.mock()` (dominant pattern)

`vi.mock()` is the most common mocking technique — it is how every API-route test isolates the handler from auth and its data layer. The canonical shape: declare the mock, then import the real symbol (Vitest hoists the `vi.mock` call above the import), then drive it with `vi.mocked(...)`:

```typescript
vi.mock("@/lib/auth", () => ({ auth: vi.fn() }));
vi.mock("@/lib/sales-dashboard/data", () => ({
  getSalesDashboardPayload: vi.fn(),
  importAllSalesSources: vi.fn(),
  /* ...one vi.fn() per exported function... */
}));

import { auth } from "@/lib/auth";
import { getSalesDashboardPayload } from "@/lib/sales-dashboard/data";
import { GET as getDashboard } from "../route";   // handler under test imported AFTER mocks

const authMock = auth as unknown as Mock;
```

(`src/app/api/sales-dashboard/__tests__/route.test.ts:4-37`)

Route handlers are invoked directly with a hand-built `NextRequest`, and dynamic-route handlers receive a context whose `params` is a `Promise` (Next 16 convention):

```typescript
function request(body: unknown): NextRequest {
  return new NextRequest("http://test.local/api/sales-dashboard/import", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}
function sourceCtx(sourceId = "...") {
  return { params: Promise.resolve({ sourceId }) };   // params is awaited inside the handler
}
```

(`src/app/api/sales-dashboard/__tests__/route.test.ts:39-57`)

Middleware tests mock the edge auth wrapper to a pass-through and call the default export with a stub request object (`src/__tests__/middleware.test.ts`).

### `global.fetch` Mocking

Wise client/fetcher tests assign `global.fetch` directly and restore the original in `afterEach`:

```typescript
const originalFetch = global.fetch;
afterEach(() => { global.fetch = originalFetch; vi.restoreAllMocks(); });

const fetchMock = vi.fn().mockResolvedValue(
  new Response(JSON.stringify({ status: 200, message: "Success", data: {} }), { status: 200 }),
);
global.fetch = fetchMock as typeof fetch;
```

(`src/lib/wise/__tests__/client.test.ts:5-19`)

Paginated requests chain `.mockResolvedValueOnce()` per page and inspect calls via `fetchMock.mock.calls[i][j]` (`src/lib/wise/__tests__/fetchers.test.ts`).

### In-Memory Drizzle Mocks (unit DB tests)

Pure unit tests that touch the DB layer mock `@/lib/db.getDb()` with a hand-rolled query-builder chain that resolves the specific `.select().from().where()` / `.insert().values().onConflictDoNothing().returning()` chains the function uses:

```typescript
vi.mock("@/lib/db", () => ({ getDb: () => mockDb }));
```

(`src/lib/data/__tests__/past-sessions.test.ts`) — reset mock state in `beforeEach`. The heavier call-chain builders (dispatching on a `_target`) are reserved for orchestration tests where covering the full SQL chain matters. **For real DB coverage, prefer an integration test** (below) over an elaborate Drizzle mock.

### Container-Backed Integration (testcontainers)

`src/tests/integration/db-helper.ts` is the shared harness. It boots a `postgres:16-alpine` container, connects with `pg.Pool` + `drizzle-orm/node-postgres`, runs the real `drizzle/` migrations, and exposes `truncateAll` for inter-test cleanup:

```typescript
export async function startTestDb(): Promise<Handle> {
  const container = await new PostgreSqlContainer("postgres:16-alpine")
    .withDatabase("bgscheduler_test").withUsername("test").withPassword("test").start();
  const pool = new Pool({ connectionString: container.getConnectionUri() });
  const db = drizzle(pool, { schema });
  await migrate(db, { migrationsFolder: path.resolve(__dirname, "../../../drizzle") });
  return { db, pool, container };
}
```

(`src/tests/integration/db-helper.ts:17-32`)

`truncateAll` issues one `TRUNCATE ... RESTART IDENTITY CASCADE`; FK chains are followed by `CASCADE`, so order is irrelevant (`src/tests/integration/db-helper.ts:43-67`). **Note:** this truncate list is hand-maintained and currently names **19 tables** (snapshots, sync_runs, identity groups/members, qualifications, availability, leaves, future/past session blocks, tutors, raw tags, classroom rooms/runs/rows, room utilization, data issues, snapshot stats, admin users, aliases). It is **not** auto-derived from the full schema (~90 tables), so newer feature tables (sales, credit control, payroll, LINE, leave requests, progress tests, AI/proposals, etc.) are not part of the truncate set — integration suites that need those tables clean must extend this list.

**Why two drivers:** production uses `drizzle-orm/neon-http`, which cannot speak to a generic Postgres TCP port; integration tests use `drizzle-orm/node-postgres`. Both consume the same `drizzle/` migrations and present the same Drizzle query API, so there is no migration drift (`src/tests/integration/README.md:24-30`). Requires a running Docker daemon; `postgres:16-alpine` (~80MB) is pulled on first run (`src/tests/integration/README.md:7-10`).

Integration tests still inject a **fake `WiseClient`** (object with a `get<T>(path, params)` method that pattern-matches the path) so only the DB side is real — the Wise API is never hit. Some tests go further and install a temporary plpgsql trigger to simulate a mid-transaction failure, then drop it in a `finally`.

### Fake Timers

For time-dependent logic (Asia/Bangkok day boundaries, "today" windows, every-8-classes cycle math):

```typescript
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-04-15T00:00:00+07:00"));
});
afterEach(() => { vi.useRealTimers(); });
```

(`src/lib/search/__tests__/compare.test.ts`) — always pair `useFakeTimers` with `useRealTimers` in teardown. Seven files use fake timers; the process clock is already pinned to Asia/Bangkok via `vitest.config.ts:4`, but date-sensitive suites still pin a concrete `+07:00` instant for determinism.

### Environment-Variable Gating

Domains guarded by feature flags / API keys (AI scheduler, LINE) snapshot the relevant `process.env` keys at file scope, set them per test, and restore them in `afterEach` so flag-off and flag-on paths are both covered without leaking state:

```typescript
const originalEnv = {
  OPENAI_API_KEY: process.env.OPENAI_API_KEY,
  ENABLE_AI_SCHEDULER: process.env.ENABLE_AI_SCHEDULER,
  OPENAI_SCHEDULER_MODEL: process.env.OPENAI_SCHEDULER_MODEL,
  OPENAI_SCHEDULER_REASONING_EFFORT: process.env.OPENAI_SCHEDULER_REASONING_EFFORT,
};
```

(`src/lib/ai/__tests__/scheduler.test.ts`)

### Source Code Inspection (Grep Assertions)

For invariants easier to grep than to behavior-test, **14 files** read the source with `node:fs.readFileSync` and assert on its contents. This includes the UI-shell tests (which assert SSR-rendered or literal markup) and config-invariant tests:

- `src/__tests__/vercel-crons.test.ts` parses `vercel.json` and asserts each cron path/schedule.
- `src/lib/data-health/__tests__/cron-registry.test.ts` and `migration.test.ts` assert the cron registry/migration invariants by reading source.
- `src/components/sales-dashboard/__tests__/empty-state-source.test.ts` asserts the dashboard shell renders setup guidance before the command center and disables refresh until sources exist.
- `src/components/compare/__tests__/{view-transitions-source,modality-display,density-overview}.test.ts(x)`, `src/components/scheduler/__tests__/scheduler-compare-focus.test.ts`, `src/components/wise-activity/__tests__/reconciliation-ui.test.ts`, `src/components/class-assignments/__tests__/visualization-components.test.tsx`, `src/lib/classrooms/__tests__/{publish-eligibility,rooms}.test.ts`, `src/lib/ops/__tests__/stale.test.ts`, `src/lib/data/__tests__/past-sessions.test.ts` (cache-tag drift guard).

Use sparingly — only when an invariant guards a regression that behavior tests cannot catch.

### What to Mock

- External I/O: `fetch`, the DB client (`@/lib/db`), filesystem reads, the Wise client, the LINE client, Google Sheets access.
- Auth (`@/lib/auth`, `@/lib/auth-edge`) in route/middleware tests.
- Side-effecting data-layer modules behind a route handler (one `vi.fn()` per export).
- Time via `vi.useFakeTimers()` + `vi.setSystemTime()`; flags via `process.env` snapshot/restore.

### What NOT to Mock

- Pure normalization, parsing, math (`parseTimeToMinutes`, `extractNickname`, sales/payroll/room-capacity/progress-test calculators) — deterministic, tested with literal inputs.
- Internal helpers within the module under test.
- The database itself in integration tests — use a real container instead of a deep Drizzle mock.
- Types — erased at runtime; mocking adds no signal.

## Fixtures and Factories

### Test Data

- **Inline factory functions** remain the dominant pattern, now numbering dozens across domains. Default fixtures cover the happy path; tests pass `Partial<T>` overrides.
- **No external fixture files** and **no `fixtures/`/`__fixtures__/`/`__mocks__/` directories** (verified — none exist under `src/`). All test data is constructed inline; the only shared test helper is `src/tests/integration/db-helper.ts`.
- Date literals use ISO strings (`"2030-05-06T03:00:00.000Z"`) or `new Date(Date.UTC(...))`; Bangkok-sensitive tests pin offsets explicitly (`+07:00`).

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

Heavier factories accept full `Partial<T>` overrides (`makeTutor` in `engine.test.ts`/`compare.test.ts`, `ledgerRow` in `progress-tests/engine.test.ts`); integration factories return fake clients and seed helpers (`happyPathClient`, `seedExistingSnapshots` in `orchestrator.integration.test.ts`).

### Location

- Fixtures and factories live **inline at the top of each test file**.
- The one cross-file exception is the integration harness in `src/tests/integration/`.

## Coverage

### Requirements

- **None enforced** — no coverage threshold, no CI coverage gate. Coverage is opt-in via `npm run test:coverage` (unit project, v8 provider, `text` + `html` reporters). Page/server components (`src/app/**/*.tsx`), all test files, and `src/tests/**` are excluded from the coverage scope (`vitest.config.ts:13-24`).
- Total: **162 test files**, **1056 `it` blocks** (1044 unit + 12 integration) across **236 `describe` blocks**. (Legacy docs citing "82 tests" / "132 files" predate later feature domains — most recently the progress-tests tracker, the home hub, navigation tooling, student promotions, and data-health cron status.)

### View Coverage

```bash
npm run test:coverage   # unit project only, v8, text + html report
npm run test:all -- --coverage   # include integration (requires Docker)
```

### Coverage Surface (descriptive)

| Domain | Representative Test Files | Areas Covered |
|--------|--------------------------|---------------|
| Normalization | `src/lib/normalization/__tests__/*` (7) | Identity cascade, timezone (UTC→Bangkok), availability merge, leaves, session blocking, modality fail-closed, qualification tag parsing |
| Search / compare | `src/lib/search/__tests__/*` (5) | `executeSearch` recurring/one-time blocking, qualification + multi-slot intersection, `buildCompareTutor`, conflict detection, shared free slots, recommend tiering, parser, in-memory index |
| Wise client | `src/lib/wise/__tests__/{client,fetchers}.test.ts` | Auth header construction, base URL, REL-05 status-aware retry, teacher/availability parsing, COUNT pagination |
| Wise activity | `src/lib/wise-activity/__tests__/{format,reconciliation,sync}.test.ts` | Event normalization, reconciliation logic, sync dedupe/stop conditions, formatters |
| Sync (unit) | `src/lib/sync/__tests__/orchestrator-modality-conflict.test.ts` | Modality-conflict handling with mocked DB |
| Sync (integration) | `src/lib/sync/__tests__/*.integration.test.ts` (3) | `runFullSync` happy-path persistence + atomic promotion (TCOV-02), past-session diff hook end-to-end (TCOV-04), snapshot pruning + metadata-failure resilience (OPS-01) — all on real Postgres |
| Classrooms | `src/lib/classrooms/__tests__/*` (11) | Assignment engine, publish eligibility, floor-plan map, schedule/admin email, morning automation, reconciliation, room catalog, tutor contacts, visualization, data timezone |
| Room capacity | `src/lib/room-capacity/__tests__/*` (5) | Utilization analysis, date math, forecast, package mix |
| Payroll | `src/lib/payroll/__tests__/*` (5) | Domain rules, rate card, data layer, sync, May reconciliation scenario |
| Credit control | `src/lib/credit-control/__tests__/{sync,wise}.test.ts` | Sync logic and Wise integration |
| Sales dashboard | `src/lib/sales-dashboard/__tests__/*` (7) | Parser, analytics, GM insights, projection, lifecycle, import guard, date math |
| LINE | `src/lib/line/__tests__/*` (12) | Webhook, signature, confidence, contact aliases, link validation, OA resolver (+ extension candidates), student links, review service, operational helpers, client, test-data cleanup |
| Leave requests | `src/lib/leave-requests/__tests__/*` (4) | Request parsing, tutor/session matching, sync, contact context |
| Progress tests | `src/lib/progress-tests/__tests__/*` (11) | Every-8-classes cycle engine, sync + sync-request, booking confirmation, AI summary, admin digest, teacher heads-up, teacher-access scoping, page access, ledger DB writes, recommend |
| AI scheduler | `src/lib/ai/__tests__/*` (4) | Parse normalization, filter/tutor resolution, redaction, conversation flow, academic levels, correction telemetry (env-flag-gated) |
| Data health | `src/lib/data-health/__tests__/*` (3) | Cron status evaluation, cron registry, cron-invocations migration |
| Proposals / ops / scheduler / ui / home / navigation / student-promotions | `src/lib/{proposals,ops,scheduler,ui,home,navigation,student-promotions}/__tests__/*` | Overlap detection, stale detection, admin accent colors, view transitions, home-summary payload, navigation tool registry, student promotion rules |
| Cross-cutting | `src/lib/__tests__/{bangkok-time,tutor-profile-import,auth-access}.test.ts` | Bangkok time helpers, tutor profile import, `resolveUserAccess` |
| API routes | `src/app/api/**/__tests__/*` (44) | Auth gating + Zod validation + handler behavior for search, compare, filters, tutors, payroll, room-capacity, sales-dashboard, proposals, progress-tests, student-promotions, home, data-health (incl. job-run + modality-counter), class-assignments, classrooms, wise-activity, leave-requests, all 14 LINE endpoints, 3 AI-scheduler endpoints, and the internal cron endpoints |
| App invariants | `src/__tests__/{middleware,vercel-crons}.test.ts` | Middleware bypass/redirect rules, `vercel.json` cron paths + schedules |
| Components | `src/components/**/__tests__/*` (17) | SSR markup (`renderToStaticMarkup`) for room-capacity/class-assignments/compare-density/data-health/home/layout-nav/leave-requests/progress-tests/student-promotions, plus source-grep UI invariants for sales-dashboard, scheduler, wise-activity, compare, line-review |

## Test Types

### Unit Tests

- 159 of 162 files are unit-scope (the `unit` Vitest project). Pure functions are tested with literal inputs; orchestrators and route handlers use `vi.mock()` + hand-built `NextRequest`/fake-client mocks.
- Component "tests" are unit-scope SSR/source assertions, not interactive rendering.

### Integration / E2E

- **Integration tests** — 3 container-backed files in the `integration` Vitest project, driven through `src/tests/integration/db-helper.ts` (testcontainers + node-postgres against `postgres:16-alpine`). They require Docker and are excluded from the default `npm test` (and from `verify:release`).
- **No browser E2E** — no Playwright/Cypress and no Vitest browser mode. End-to-end production validation still relies on the staggered Vercel crons + admin spot-checks.

## Common Patterns

### Async Testing

Native `async/await`; no callback/`done()` style. Applies to fetch mocks, route handlers (`await getDashboard(...)`), and integration DB calls (`await runFullSync(...)`).

```typescript
it("persists a happy-path sync and promotes exactly one active snapshot", async () => {
  const result = await runFullSync(handle.db as unknown as Database, happyPathClient() as never, instituteId);
  expect(result.success).toBe(true);
  expect(result.promotedSnapshotId).toBe(result.snapshotId);
});
```

(`src/lib/sync/__tests__/orchestrator.integration.test.ts`)

### API Route Handler Testing

The standard recipe for the 44 route-test files:

1. `vi.mock("@/lib/auth", () => ({ auth: vi.fn() }))` and `vi.mock(...)` every data-layer dependency.
2. Import the real symbols + the handler (`GET`/`POST`/`PATCH`/`DELETE`) from `../route` after the mocks.
3. In `beforeEach`, `vi.resetAllMocks()` then stub `auth` to an admin session and stub each data fn.
4. Build a `NextRequest` (and, for dynamic routes, a `{ params: Promise.resolve({...}) }` context) and assert on `res.status` / parsed JSON, plus that the mocked data fns were called with expected args.

(`src/app/api/sales-dashboard/__tests__/route.test.ts`)

### Error / Validation Testing

- Tuple-return style (`{ result, issues }`): assert on the `issues` array (`src/lib/normalization/__tests__/identity.test.ts`).
- Route handlers: assert `401` when auth is null and `400` on Zod failure by sending malformed bodies; assert `500`/typed errors by making a mocked data fn reject (e.g. `MissingGoogleSheetsTokenError` imported in `src/app/api/sales-dashboard/__tests__/route.test.ts:30`).
- For functions that throw, `await expect(fn()).rejects.toThrow(...)`.

### Comprehensive Matrix Tests

Long-running invariants are encoded as case-numbered rows. The single `it.each` table is the classroom assignment-engine matrix (`src/lib/classrooms/__tests__/assignment-engine.test.ts`); the compare modality matrix uses an explicit aggregate `it` looping over case rows. When the underlying logic changes, the matrix breaks first — by design.

### Backward-Compat Tests

Explicit "old signature still works" tests accompany signature changes (e.g. `buildCompareTutor` 3-arg vs 4-arg calls in `src/lib/search/__tests__/compare.test.ts`).

### Coverage-Tag & Decision-ID Comments

Test files reference the planning artifact they satisfy in the `describe` name or header comment (`TCOV-02`, `TCOV-04`, `OPS-01`, `REL-05`) and annotate non-obvious business rules with decision IDs (`MOD-01`, `D-08`) plus a short rationale. These comments tell future engineers **why** a case exists and **which plan to read** before changing it.

---

*Testing analysis: 2026-05-31*

_Verified against HEAD `d4fe6d3` on 2026-06-05._
