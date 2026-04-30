# Integration Test Helpers

This directory contains the shared integration-test infrastructure used by
`*.integration.test.ts` suites in the `src/lib/sync/__tests__/` directory.

## Requirements

- **Docker Desktop** (or any Docker-compatible daemon) must be running
- **Node ≥ 20** (testcontainers v11 + native fetch)
- The `postgres:16-alpine` image will be pulled on first run (~80MB)

## Usage

```typescript
import { startTestDb, stopTestDb, truncateAll } from "@/tests/integration/db-helper";

let handle: Awaited<ReturnType<typeof startTestDb>>;

beforeAll(async () => { handle = await startTestDb(); }, 60_000);
afterAll(async () => { await stopTestDb(handle); });
beforeEach(async () => { await truncateAll(handle.db); });
```

## Why testcontainers + node-postgres

Production uses `drizzle-orm/neon-http` against Neon serverless. The Neon HTTP
driver cannot connect to a generic Postgres TCP port, so integration tests use
`drizzle-orm/node-postgres` against an ephemeral Postgres 16 container. Both
drivers consume the same `drizzle/` migration directory and produce the same
Drizzle query API — there is no migration drift risk.

## Run

- Default `npm test` runs UNIT tests only (does not require Docker)
- `npm run test:integration` runs integration tests (requires Docker daemon)
- `npm run test:all` runs both
