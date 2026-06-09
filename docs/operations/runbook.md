# Operations Runbook

Day-to-day operational procedures for BGScheduler: deploying, running database
scripts, manually triggering each scheduled sync, and recovering when a sync
fails. This is the page to open when something is wrong with data freshness or a
cron, or when you need to run a one-off command against production.

> Scope note. This runbook owns the **how-to** of running and recovering the
> system. For the meaning of the data-health surface (what each issue type means,
> the fail-closed rules), see [features/data-health.md](../features/data-health.md).
> Coding/style conventions live in [handbook/conventions.md](../handbook/conventions.md).

---

## 1. Quick reference

| What | Command / value |
| --- | --- |
| Production URL | `https://bgscheduler.vercel.app` |
| Deploy to production | `npm run deploy:prod` |
| Run unit tests | `npm test` |
| Generate a migration | `npm run db:generate` |
| Apply migrations | `DATABASE_URL=... npm run db:migrate` |
| Seed aliases + admins | `DATABASE_URL=... SEED_ADMIN_EMAILS=... npm run db:seed` |
| Cron auth header | `Authorization: Bearer $CRON_SECRET` |
| Sync function timeout | `maxDuration = 800` seconds (Wise sync) |
| Single-flight stale cutoff | 20 minutes (`STALE_RUNNING_SYNC_MS`) |

The full npm script list is in `package.json:5`. The required environment
variables are validated at startup in `src/lib/env.ts:3` (see
[§3](#3-environment-variables)).

---

## 2. Deploy

The app deploys to Vercel. `next.config.ts` sets exactly one option,
`cacheComponents: true` (`next.config.ts:4`), and `vercel.json` only declares crons
(`vercel.json:1`) — there is no custom build/output config beyond those.

### Deploy to production

```bash
npm run deploy:prod
```

`npm run deploy:prod` runs the release verification chain, refuses dirty
worktrees, refuses non-`main` branches, refuses commits that do not match
`origin/main`, and then calls `npx vercel --prod`. Before deploying anything
that touches the database schema, apply migrations first (see
[§4](#4-database-scripts)) — a deploy does **not** run migrations.

### Pre-deploy checklist

```bash
npm run typecheck   # tsc --noEmit            (package.json:10)
npm run lint        # eslint                  (package.json:9)
npm test            # vitest run --project unit (package.json:11)
npm run guard:production-route-surface
```

> A Vercel deploy does **not** run migrations. Any schema-affecting feature must
> have its migration applied to the production database (§4) before the code that
> reads the new schema goes live, or the running app will error against the old
> schema. See §4.1 for additive-vs-destructive ordering.

---

## 3. Environment variables

`src/lib/env.ts:20` validates `process.env` with a Zod schema **at module load**.
If any required variable is missing or malformed, `getEnv()` logs the flattened
field errors (`src/lib/env.ts:23`) and throws `Invalid environment variables`
(`src/lib/env.ts:24`), which crashes the importing process/function. Required and
optional variables:

| Variable | Required? | Notes |
| --- | --- | --- |
| `DATABASE_URL` | yes | must be a URL (`src/lib/env.ts:4`) |
| `AUTH_GOOGLE_ID` | yes | Google OAuth client id |
| `AUTH_GOOGLE_SECRET` | yes | Google OAuth client secret |
| `AUTH_SECRET` | yes | Auth.js session encryption key |
| `WISE_USER_ID` | yes | Wise API user id |
| `WISE_API_KEY` | yes | Wise API key |
| `WISE_NAMESPACE` | defaulted | defaults to `begifted-education` (`src/lib/env.ts:10`) |
| `WISE_INSTITUTE_ID` | defaulted | defaults to `696e1f4d90102225641cc413` (`src/lib/env.ts:11`) |
| `CRON_SECRET` | yes | protects every `/api/internal/*` sync (`src/lib/env.ts:12`) |
| `LINE_CHANNEL_SECRET` | optional | LINE integration |
| `LINE_CHANNEL_ACCESS_TOKEN` | optional | LINE integration |
| `ENABLE_LINE_SCHEDULER` | optional | feature flag |

Feature-specific variables consumed by leave-requests, the AI scheduler, LINE
writeback, and the schedule emails are **not** in the `src/lib/env.ts` schema (the
schema is the twelve entries above, `src/lib/env.ts:3`–`:16`). Those modules read
`process.env` directly, so a missing value degrades that one feature rather than
crashing startup. The full list with sources is in
[`docs/reference/env.md`](../reference/env.md).

`CRON_SECRET` is the single most operationally important secret: rotating or
clearing it changes how every internal sync responds (see
[§6](#6-the-single-flight-guard-and-cron-auth)).

---

## 4. Database scripts

Drizzle is configured in `drizzle.config.ts:3`: schema at `./src/lib/db/schema.ts`,
migrations emitted to `./drizzle`, dialect `postgresql`, credentials from
`DATABASE_URL` (`drizzle.config.ts:8`). All three commands read `DATABASE_URL`
from the environment, so always prefix them with the target connection string.

### `npm run db:generate` — author a migration

```bash
npm run db:generate    # drizzle-kit generate  (package.json:16)
```

Diffs `src/lib/db/schema.ts` against the committed migration history in
`drizzle/` and writes a new timestamped `.sql` file plus a `meta/` snapshot.
This does **not** touch any database — review the generated SQL, then commit it.

### `npm run db:migrate` — apply migrations

```bash
DATABASE_URL='postgres://...' npm run db:migrate    # drizzle-kit migrate (package.json:17)
```

Applies any unapplied `drizzle/*.sql` files to the target database. Run this
against production **before** deploying code that depends on the new schema.

> The directory holds **40** `.sql` files; the highest at HEAD is
> `0040_student_promotions.sql`. Numbering is **not** contiguous — `0009`, `0010`,
> and `0025` are absent, and there are **two** files each at `0038` and `0039`
> (numbers collided when branches merged). drizzle-kit tracks applied migrations in
> its `meta` journal, not by filename arithmetic, so always apply with
> `db:migrate` rather than hand-running individual files in numeric order. There is
> **no** `db:push` script — never push schema directly to production.

### `npm run db:seed` — seed aliases and admins

```bash
DATABASE_URL='postgres://...' SEED_ADMIN_EMAILS='a@x.com,b@y.com' npm run db:seed
```

`src/lib/db/seed.ts:5` is the seed entrypoint (`db:seed` runs `tsx src/lib/db/seed.ts`).
It is idempotent and does **three** things:

- Inserts four tutor aliases (`Kev→Kevin`, `Paoju→Paojuu`, `Poi→Nacha (Poi)`,
  `Sam→Samantha`, `src/lib/db/seed.ts:15`–`:20`) with `onConflictDoNothing` on
  `fromKey` (`:26`).
- **Admin users** — only if `SEED_ADMIN_EMAILS` is set; it is comma-split and empties
  filtered out, then each email is inserted into `admin_users` with
  `onConflictDoNothing` on `email` (`src/lib/db/seed.ts:31`–`:38`). If unset it logs
  `No SEED_ADMIN_EMAILS set, skipping admin user seed` and skips this step
  (`:42`). These are **full-access** admins.
- **Restricted users** — always seeded, regardless of `SEED_ADMIN_EMAILS`. The
  array at `src/lib/db/seed.ts:47`–`:49` scopes specific emails to a page-prefix
  allowlist (`allowedPages`) via `onConflictDoUpdate` (`:55`). At HEAD this grants
  `m.giftwan@gmail.com` access to `/progress-tests` only. The inline comment notes
  these are intentionally **not** in `SEED_ADMIN_EMAILS` (`:45`–`:46`).

`DATABASE_URL` is mandatory — the script throws `DATABASE_URL is not set` if missing
(`src/lib/db/seed.ts:7`–`:9`). On any error it logs `Seed failed:` and exits non-zero
(`src/lib/db/seed.ts:65`–`:67`). The driver is the Neon **HTTP** client
(`src/lib/db/seed.ts:1`).

### Other one-off scripts

`package.json` also defines operational `tsx` scripts outside the Drizzle set —
e.g. `credit-control:seed-admin-ownership`, `tutor-profiles:seed`,
`room-capacity:import-model`, `room-utilization:sync`, and the
`guard:sales-dashboard-scope` check (`package.json:19`–`package.json:26`). These
are feature-specific bootstrap utilities; consult the relevant feature doc before
running them.

---

## 5. Tests

| Script | Command | Purpose |
| --- | --- | --- |
| `npm test` | `vitest run --project unit` (`package.json:11`) | the default CI gate — unit suite only |
| `npm run test:watch` | `vitest --project unit` (`package.json:12`) | watch mode for the unit project |
| `npm run test:integration` | `vitest run --project integration` (`package.json:13`) | container-backed integration suite |
| `npm run test:all` | `vitest run` (`package.json:14`) | both projects |
| `npm run test:coverage` | `vitest run --project unit --coverage` (`package.json:15`) | v8 coverage of the unit project |

Two Vitest projects are configured in `vitest.config.ts:25`:

- **`unit`** — `node` environment, matches `src/**/*.test.ts(x)`, **excludes**
  `*.integration.test.ts` (`vitest.config.ts:32`–`:33`). This is what `npm test`
  runs. The suite forces `TZ = "Asia/Bangkok"` (`vitest.config.ts:4`).
- **`integration`** — matches `src/**/*.integration.test.ts`, runs in a single
  forked worker (`pool: "forks"`, `fileParallelism: false`, `maxWorkers: 1`) with
  60s test/hook timeouts (`vitest.config.ts:43`–`:48`). Integration specs use
  `@testcontainers/postgresql` (a `devDependency`, `package.json:55`), so the
  integration project needs Docker available locally. The three integration suites
  are `orchestrator.integration.test.ts`,
  `past-sessions-diff-hook.integration.test.ts`, and
  `snapshot-pruning.integration.test.ts`, all under `src/lib/sync/__tests__/`.

---

## 6. The single-flight guard and cron auth

Every scheduled sync lives under `/api/internal/*` and is gated by a constant-time
`CRON_SECRET` comparison. The Wise snapshot sync additionally enforces a
**single-flight guard** so two runs can never overlap.

### 6.1 Cron authentication

Two equivalent constant-time check implementations exist (same algorithm):

- The **shared helper** `getCronSecretStatus` / `rejectInvalidCronSecret` in
  `src/lib/internal/cron-auth.ts:6`, `:19`. Used by `sync-wise-activity`,
  `progress-tests/admin-digest`, `sync-leave-requests`, `class-assignments/morning`,
  and `class-assignments/admin-email` (via `rejectInvalidCronSecret`), and by
  `sync-progress-tests` (via `getCronSecretStatus`,
  `src/app/api/internal/sync-progress-tests/route.ts:3`).
- An **inline copy** `hasValidCronSecret` in `src/app/api/internal/sync-wise/route.ts:11`,
  the sales-dashboard route, the credit-control route, the room-utilization route,
  and `student-promotions/july-1` (`src/app/api/internal/student-promotions/july-1/route.ts:10`).

Both return one of three states and map them to HTTP responses:

| State | Condition | Response |
| --- | --- | --- |
| `valid` | header equals `Bearer $CRON_SECRET` | run the sync |
| `invalid` | header present but wrong | `401 Unauthorized` |
| `missing-secret` | `CRON_SECRET` env var unset | `500 Server misconfigured` |

The comparison length-pre-checks before `timingSafeEqual` to avoid the
`RangeError` that `crypto.timingSafeEqual` throws on mismatched-length buffers,
and the pre-check is O(1) so it does not leak the secret length
(`src/app/api/internal/sync-wise/route.ts:11`, `src/lib/internal/cron-auth.ts:12`).

**Operational consequence:** if you see every internal sync returning
`500 {"error":"Server misconfigured"}`, `CRON_SECRET` is unset in that
environment — fix the env var, do not touch the route code.

### 6.2 GET vs POST and session fallback

The Wise sync, sales-dashboard, credit-control, and progress-tests routes accept
**both** verbs and add a session fallback on `POST` (`allowSessionAuth: true`). The
room-utilization route is POST-only but likewise falls back to a session
(`src/app/api/internal/sync-room-utilization/route.ts:30`):

```mermaid
flowchart TD
  A[Request] --> B{Authorization == Bearer CRON_SECRET?}
  B -- valid --> R[Run sync]
  B -- invalid/missing --> C{Verb / allowSessionAuth}
  C -- "GET (cron only)" --> X[401 or 500]
  C -- "POST + logged-in Auth.js session" --> R
  C -- "POST, no session" --> X
```

- `GET` is what Vercel cron calls; on the Wise route it does **not** allow session
  auth (`allowSessionAuth: false`, `src/app/api/internal/sync-wise/route.ts:70`). The
  session fallback is gated on this flag (`src/app/api/internal/sync-wise/route.ts:45`).
- `POST` allows an authenticated Auth.js admin session as an alternative to the
  secret (`allowSessionAuth: true`, `src/app/api/internal/sync-wise/route.ts:75`).
  This is what lets a logged-in admin trigger a sync from the browser/UI without
  knowing `CRON_SECRET`.

The activity, leave-requests, classroom-morning, and classroom-admin-email routes
use `rejectInvalidCronSecret` directly and therefore require the secret on **all**
verbs (no session fallback) — e.g. `src/app/api/internal/sync-wise-activity/route.ts:13`,
`src/app/api/internal/sync-leave-requests/route.ts:10` (leave-requests exposes both
GET and POST, but both go through the same secret check).

There is also a dedicated admin-only trigger at `POST /api/admin/sync-wise`
(`src/app/api/admin/sync-wise/route.ts`) that requires an Auth.js session (`401`
otherwise) and then calls the same `runWiseSyncRequest()` as the cron path.

### 6.3 The single-flight guard (Wise snapshot sync)

The guard lives in `src/lib/sync/run-wise-sync.ts`. Before starting work,
`acquireSyncRun` does three things in order (`src/lib/sync/run-wise-sync.ts:88`):

1. **Fail stale runs.** `failStaleRunningSyncs` marks any `sync_runs` row still
   `status='running'` whose `started_at` is older than
   `STALE_RUNNING_SYNC_MS` (20 minutes, `src/lib/sync/run-wise-sync.ts:10`) as
   `failed`, stamping `finished_at` and the error summary
   *"Sync marked failed because it was still running after 20 minutes; likely
   timed out or the request was aborted."* (`src/lib/sync/run-wise-sync.ts:39`,
   `:51`).
2. **Check for a live run.** If a `running` row still exists after step 1, return
   a **skip** result (`src/lib/sync/run-wise-sync.ts:95`).
3. **Insert the guard row.** Otherwise insert a new `sync_runs` row with
   `status='running'` (`src/lib/sync/run-wise-sync.ts:100`).

The insert is backstopped by a **partial unique index** that allows at most one
`running` row at a time — `sync_runs_single_running_idx` on `(status) WHERE
status='running'` (`drizzle/0013_sync_run_single_flight.sql`). If two requests
race past step 2, one insert hits a `23505` unique violation; `acquireSyncRun`
catches it (`isUniqueViolation`, `src/lib/sync/run-wise-sync.ts:42`) and converts
it into the same skip result instead of erroring (`src/lib/sync/run-wise-sync.ts:107`).

When skipped, `runWiseSyncRequest` returns **HTTP 202** with a body containing
`skipped: true`, `alreadyRunning: true`, the in-flight `runningStartedAt`, and the
count of `staleRunningSyncsFailed` (`src/lib/sync/run-wise-sync.ts:148`). A 202
from a manual trigger is normal and means "a sync is already in progress" — it is
**not** an error.

```mermaid
flowchart TD
  S[runWiseSyncRequest] --> F[failStaleRunningSyncs:\nrunning > 20 min -> failed]
  F --> Q{running row exists?}
  Q -- yes --> SK[Return 202 skipped]
  Q -- no --> I[INSERT running row]
  I -- unique violation 23505 --> SK
  I -- ok --> RUN[runFullSync]
  RUN --> OK{success?}
  OK -- yes --> RV["revalidateTag('snapshot')\n+ 200"]
  OK -- no --> E[500 with errorSummary]
```

On success the route calls `revalidateTag("snapshot", { expire: 0 })`
(`src/lib/sync/run-wise-sync.ts:161`) and returns 200; on failure it returns
500 with the orchestrator's `errorSummary` (`src/lib/sync/run-wise-sync.ts:164`).

> Other syncs have their own guards, in two flavors:
> - **Same DB single-flight + 20-minute sweep as Wise.** Credit-control mirrors
>   this pattern exactly — its own `acquireSyncRun` fails `running` rows older than
>   20 minutes, returns **202 skipped** when one is live, and is backstopped by the
>   `ccsr_single_running_idx` partial unique index
>   (`src/lib/credit-control/run-sync-request.ts:12`, `:100`, `:120`;
>   `drizzle/0024_dashboard_sync_single_flight.sql:33`–`:34`). Sales-dashboard guards its
>   *projection import* with a per-source partial unique index
>   (`sdpir_source_single_running_idx`, `drizzle/0029_sales_dashboard_projection.sql:74`).
> - **In-process `…AlreadyRunningError` → HTTP 409.** Wise-activity and
>   leave-requests throw a typed error their routes translate to **409**
>   (`src/app/api/internal/sync-wise-activity/route.ts:29`,
>   `src/app/api/internal/sync-leave-requests/route.ts:21`).
>
> All of these are independent of the Wise-snapshot guard above.

### 6.4 How a fresh snapshot reaches live queries

A successful Wise sync promotes a new snapshot (see [§8](#8-snapshot-promotion-and-rollback)),
but search/compare read from an **in-memory index singleton**, not Postgres
directly. `ensureIndex` (`src/lib/search/index.ts:354`) re-checks the active
snapshot on each call and rebuilds the index when the cached `snapshotId` (or
`profileVersion`) no longer matches the DB's `active=true` row
(`src/lib/search/index.ts:367`–`:380`). The `revalidateTag("snapshot")` call
after a successful sync invalidates the Next.js data cache so the next request
observes the new snapshot. Net effect: a promoted snapshot becomes visible to
users on the next query, without a redeploy.

---

## 7. The crons and how to trigger each manually

`vercel.json` registers **ten** crons (`vercel.json:2`–`:43`). All scheduled
entries are `GET /api/internal/*` and all require
`Authorization: Bearer $CRON_SECRET`. The interval jobs are staggered onto
different minutes so the ~30-minute jobs never all fire in the same minute.

| Path | Schedule (UTC) | Bangkok | Verb(s) accepted | maxDuration | Manual-trigger notes |
| --- | --- | --- | --- | --- | --- |
| `/api/internal/sync-wise` | `*/30 * * * *` (`vercel.json:5`) | every 30 min | GET + POST(session) | 800s (`…/sync-wise/route.ts:7`) | single-flight; 202 if already running |
| `/api/internal/sync-wise-activity` | `5,35 * * * *` (`vercel.json:23`) | every 30 min | GET only | 800s (`…/sync-wise-activity/route.ts:8`) | 409 if already running |
| `/api/internal/sync-sales-dashboard` | `10,40 * * * *` (`vercel.json:8`) | every 30 min | GET + POST(session) | 800s (`…/sync-sales-dashboard/route.ts:8`) | projection-import single-flight |
| `/api/internal/sync-credit-control` | `20,50 * * * *` (`vercel.json:11`) | every 30 min | GET + POST(session) | 300s (`…/sync-credit-control/route.ts:7`) | single-flight; 202 if already running |
| `/api/internal/sync-progress-tests` | `25,55 * * * *` (`vercel.json:14`) | every 30 min | GET + POST(session) | 300s (`…/sync-progress-tests/route.ts:7`) | — |
| `/api/internal/progress-tests/admin-digest` | `35 0 * * *` (`vercel.json:18`) | 07:35 daily | GET only | 300s (`…/admin-digest/route.ts:6`) | daily progress-tests digest email |
| `/api/internal/sync-leave-requests` | `15,45 * * * *` (`vercel.json:26`) | every 30 min | GET + POST (secret only) | 800s (`…/sync-leave-requests/route.ts:7`) | 409 if already running |
| `/api/internal/class-assignments/morning` | `45 23 * * *` (`vercel.json:31`) | 06:45 daily | GET only | 800s (`…/morning/route.ts`) | **dangerous**: assigns + publishes rooms + emails tutors |
| `/api/internal/class-assignments/admin-email` | `0,10,20,30 0 * * *` (`vercel.json:34`) | 07:00–07:30 | GET only | 300s (`…/admin-email/route.ts`) | **dangerous**: sends/retries admin digest email |
| `/api/internal/student-promotions/july-1` | `5 17 30 6 *` (`vercel.json:38`) | 00:05 Jul 1 2026 | GET + POST | 800s (`…/july-1/route.ts:8`) | **dangerous**, one-shot; 409 outside July 1 2026 Bangkok |

> `dangerous: true` is set per-job in
> `src/lib/data-health/cron-registry.ts:153`, `:169`, `:186` — those jobs have
> real-world side effects (write `location` to Wise, send emails, write student
> grade/course promotions). Prefer the
> [Data Health manual-run endpoint](#data-health-manual-run-recommended-for-operators)
> over a bare curl for these.
>
> The morning/admin-email schedules (`23:45 UTC` and the four `00:xx UTC` slots)
> are 06:45 and 07:00–07:30 Bangkok (UTC+7); the digest at `35 0 * * *` is 07:35
> Bangkok (`cron-registry.ts:117`–`:124`).

### Manual triggers (copy/paste)

The canonical manual trigger documented in the README is the Wise sync
(`README.md:167`–`:169`):

```bash
# Wise snapshot sync (POST works for both admin session and CRON_SECRET)
curl -X POST https://bgscheduler.vercel.app/api/internal/sync-wise \
  -H "Authorization: Bearer $CRON_SECRET"
```

The cron path is `GET`; to reproduce exactly what Vercel cron sends, use `-X GET`:

```bash
# Wise activity audit (GET only)
curl https://bgscheduler.vercel.app/api/internal/sync-wise-activity \
  -H "Authorization: Bearer $CRON_SECRET"

# Sales dashboard
curl -X POST https://bgscheduler.vercel.app/api/internal/sync-sales-dashboard \
  -H "Authorization: Bearer $CRON_SECRET"

# Credit control
curl -X POST https://bgscheduler.vercel.app/api/internal/sync-credit-control \
  -H "Authorization: Bearer $CRON_SECRET"

# Progress tests
curl -X POST https://bgscheduler.vercel.app/api/internal/sync-progress-tests \
  -H "Authorization: Bearer $CRON_SECRET"

# Progress-tests admin digest (GET only)
curl https://bgscheduler.vercel.app/api/internal/progress-tests/admin-digest \
  -H "Authorization: Bearer $CRON_SECRET"

# Leave requests (GET or POST; both require the secret — no session fallback)
curl https://bgscheduler.vercel.app/api/internal/sync-leave-requests \
  -H "Authorization: Bearer $CRON_SECRET"

# Room utilization (POST only; secret OR admin session; not on any cron)
curl -X POST https://bgscheduler.vercel.app/api/internal/sync-room-utilization \
  -H "Authorization: Bearer $CRON_SECRET"

# DANGEROUS — classroom morning automation: assigns rooms, publishes OFFLINE
# location to Wise, emails tutors. Prefer the Data Health manual-run endpoint.
curl https://bgscheduler.vercel.app/api/internal/class-assignments/morning \
  -H "Authorization: Bearer $CRON_SECRET"

# DANGEROUS — admin classroom schedule email: sends/retries the daily digest.
curl https://bgscheduler.vercel.app/api/internal/class-assignments/admin-email \
  -H "Authorization: Bearer $CRON_SECRET"

# Student promotions (one-shot; 409 on any day other than 1 Jul 2026 Bangkok)
curl -X POST https://bgscheduler.vercel.app/api/internal/student-promotions/july-1 \
  -H "Authorization: Bearer $CRON_SECRET"
```

### Manual Wise-activity backfill (admin session, not CRON_SECRET)

`POST /api/wise-activity/sync` (`src/app/api/wise-activity/sync/route.ts:16`) is the
operator backfill path. It requires an **Auth.js session** (401 otherwise,
`route.ts:17`–`:19`), not the cron secret, and accepts an optional JSON body with
`lookbackDays` (clamped 1–365, default 30) and `maxPages` (clamped 1–1000, default
500) (`route.ts:37`–`:38`). It returns **409** if an activity sync is already running
(`route.ts:43`–`:44`). Use this when the audit log needs more history than the cron's
default window provides.

### Room-utilization sync (no cron)

`POST /api/internal/sync-room-utilization` exists
(`src/app/api/internal/sync-room-utilization/route.ts:26`) and accepts either the
cron secret **or** an Auth.js session fallback
(`route.ts:30`–`:40`), **but it is not registered in `vercel.json`** and is marked
`manualOnly: true` in the registry (`cron-registry.ts:191`–`:205`). It runs only when
triggered manually — by curl with the secret, by the Data Health manual control
(below), or via the `room-utilization:sync` npm script (`package.json:22`).

### Data Health manual-run (recommended for operators)

The Data Health page exposes a manual-run endpoint that needs **no `CRON_SECRET`** —
just an admin session — and records who ran it:

```
POST /api/data-health/jobs/{jobKey}/run
```

`src/app/api/data-health/jobs/[jobKey]/run/route.ts:11` checks the session, then
`runDataHealthJob(jobKey, actorEmail)` dispatches on `jobKey` to the same underlying
sync function as the cron and wraps it in the audit with `triggerSource: "admin"`
(`src/lib/data-health/run-job.ts:20`–`:124`). Valid `jobKey` values are the eleven in
`src/lib/data-health/cron-registry.ts:3`–`:14`. This is the preferred way to retrigger
a job — especially a `dangerous` one — because the secret never leaves Vercel, the run
is attributed to the operator, and the UI surfaces the confirmation label. (Note: a few
jobs map to slightly different entrypoints than their cron route — e.g. `sales_dashboard`
runs both the refreshable-source import and the projection import,
`run-job.ts:56`–`:71`.)

---

## 8. Snapshot promotion and rollback

The Wise sync is **fail-safe by construction**: a failed run never replaces the
live data, and there is no separate "rollback" step to run — rollback is implicit.

### What promotion does

`runFullSync` (`src/lib/sync/orchestrator.ts:50`) builds a *candidate* snapshot
with `active: false` (`src/lib/sync/orchestrator.ts:71`), writes all normalized
data under that `snapshotId`, then decides whether to promote:

- It computes `unresolvedRatio = identityIssues / max(groups, 1)` and only
  promotes when `unresolvedRatio < 0.5` — i.e. **>50% unresolved identity groups
  blocks promotion** (`src/lib/sync/orchestrator.ts:473`).
- Promotion is a **single atomic UPDATE**. One statement flips the new snapshot
  to `active=true` and every previously-active row to `active=false`, scoped by
  `WHERE active=true OR id=:snapshotId` (`src/lib/sync/orchestrator.ts:488`). The
  comment notes PostgreSQL MVCC guarantees readers always see exactly one active
  row — never a window with zero (`src/lib/sync/orchestrator.ts:480`).

```mermaid
flowchart TD
  C[Create candidate snapshot active=false] --> W[Write normalized data under snapshotId]
  W --> R{unresolvedRatio < 0.5?}
  R -- yes --> P[Atomic UPDATE: candidate active=true,\nprior active=false]
  P --> SR[sync_runs: status=success,\npromotedSnapshotId set]
  SR --> PR[pruneOldSnapshots]
  R -- no --> SR2[sync_runs: status=success,\npromotedSnapshotId=null]
  SR2 --> KEEP[Prior snapshot stays active]
```

> Subtle: even when the completeness gate blocks promotion, the run is still
> marked `status='success'` with `promotedSnapshotId=null`
> (`src/lib/sync/orchestrator.ts:509`). The candidate snapshot rows persist but
> stay `active=false`. So "success with no promotion" is a real state — check
> `promotedSnapshotId`, not just `status`, when verifying that live data actually
> advanced.

### Rollback = "a failed sync preserves the previous active snapshot"

If `runFullSync` throws anywhere before the promotion UPDATE, the `catch` block
sets the run's `sync_runs` row to `status='failed'` with the error message in
`errorSummary` and returns `success:false` / `promotedSnapshotId:null`
(`src/lib/sync/orchestrator.ts:561`). Because promotion is the **last** mutation
and the candidate was created `active=false`, the previously-active snapshot is
never touched — the live index keeps serving the last good data. There is nothing
to undo.

If the `sync_runs` cleanup UPDATE itself fails inside the catch, the error is
logged (`[sync-orchestrator] cleanup failed for syncRunId=…`) but swallowed so the
primary error is not masked (`src/lib/sync/orchestrator.ts:573`). The
consequence: a row can be left in `running` state — which is exactly what the
20-minute stale-run sweep ([§6.3](#63-the-single-flight-guard-wise-snapshot-sync))
later cleans up on the next sync attempt.

### Per-teacher error isolation

A single teacher failing to fetch does **not** abort the sync. The orchestrator
catches per-teacher errors and records a `completeness` data_issue, then continues
(`src/lib/sync/orchestrator.ts:249`). Similarly the past-sessions diff hook and
the modality-conflict pass emit data_issues without aborting
(`src/lib/sync/orchestrator.ts:407`). So a sync can be `success` and still have
many issues — that surfaces on `/data-health`, not as a failure.

### Snapshot retention / pruning

After a **promoted** run, `pruneOldSnapshots` runs (`src/lib/sync/orchestrator.ts:526`).
It keeps the most recent `SNAPSHOT_RETENTION_COUNT = 30` snapshots by `created_at`
plus the active one, and hard-deletes the rest along with all their child rows
(`src/lib/sync/snapshot-pruning.ts:5`, `:49`). Pruning is best-effort: if it
throws, the failure is logged and recorded in the run's `metadata.pruning`, but
the sync still reports success (`src/lib/sync/orchestrator.ts:527`). Manual
rollback to a snapshot older than the last 30 is therefore not generally possible
— old snapshots are physically gone.

> **Manual emergency rollback.** There is no app endpoint to re-promote a prior
> snapshot. If you must force the live snapshot back to a specific id, you would
> reproduce the orchestrator's atomic flip directly against the DB — set the
> chosen snapshot `active=true` and all others `active=false` in one transaction —
> and the in-memory index will rebuild on the next query
> ([§6.4](#64-how-a-fresh-snapshot-reaches-live-queries)). This is an unusual,
> manual operation; prefer simply re-running the sync, which self-heals from the
> last good snapshot.

---

## 9. When a sync fails: where to look

Work from the in-app surface outward to the platform logs.

### 9.1 `/data-health` (start here for the Wise snapshot sync)

`GET /api/data-health` (`src/app/api/data-health/route.ts:14`) requires an admin
session and returns the payload built in `src/lib/data-health/dashboard.ts:723`–`:740`:

- `lastSuccessfulSync`, `lastFailedSync`, and **`lastFailureError`** — the
  `errorSummary` of the most recent failed run, the first thing to read
  (`dashboard.ts:703`).
- `staleAgeMs` / `staleMinutes` — time since the last successful finish
  (`dashboard.ts:704`–`:705`).
- `activeSnapshotId` and `stats` (teacher / identity-group counts, total issues)
  (`dashboard.ts:700`, `:706`).
- `issuesByType`, `unresolvedAliases`, `unresolvedModality`, `unmappedTags`
  (`dashboard.ts:731`–`:734`).
- `recentSyncs` — the last `sync_runs` with `status`, timestamps, and
  `errorSummary` (`dashboard.ts:735`).

Interpretation cheat-sheet:

| Symptom on `/data-health` | Likely cause | Next step |
| --- | --- | --- |
| `staleMinutes` climbing well past 30 | crons not firing, or every run skipping | check `recentSyncs` for stuck `running` rows; check Vercel cron logs |
| recent run `failed` with an error string | exception in `runFullSync` | read `lastFailureError`; reproduce with a manual trigger |
| a run stuck `running` | a previous invocation timed out/aborted | next sync auto-fails it after 20 min ([§6.3](#63-the-single-flight-guard-wise-snapshot-sync)); or trigger a sync to sweep it now |
| `success` but `activeSnapshotId` unchanged | completeness gate blocked promotion (>50% unresolved identity) | investigate identity issues; `promotedSnapshotId` was null |
| every manual trigger returns 202 | a real sync is in flight | wait for it to finish, or check it isn't a stuck `running` row |

For what each issue type means and the fail-closed rules behind "Needs Review",
see [features/data-health.md](../features/data-health.md).

### 9.2 The HTTP response from a manual trigger

Triggering the sync by `curl` tells you a lot immediately:

| Response | Meaning | Source |
| --- | --- | --- |
| `200` + `success:true` | sync ran; check `promotedSnapshotId` | `src/lib/sync/run-wise-sync.ts:160`–`:166` |
| `202` + `skipped:true` | already running — not an error | `src/lib/sync/run-wise-sync.ts:148`–`:150` |
| `500` + `error:"Server misconfigured"` | `CRON_SECRET` unset in env | `src/app/api/internal/sync-wise/route.ts:61`–`:63` |
| `401` + `error:"Unauthorized"` | wrong/absent secret (GET) or no session (POST) | `src/app/api/internal/sync-wise/route.ts:65` |
| `500` + `errorSummary` | `runFullSync` threw; the string is the cause | `src/lib/sync/run-wise-sync.ts:164`–`:166` |
| `409` (activity / leave-requests) | that sync's own already-running guard | `…/sync-wise-activity/route.ts:29`, `…/sync-leave-requests/route.ts:21` |

### 9.3 Vercel platform logs

The sync runs as a serverless function with `maxDuration = 800`
(`src/app/api/internal/sync-wise/route.ts:6`). For failures that don't show a
clean `errorSummary` (timeouts, OOM, cold-start crashes, env-validation throws),
read the function/runtime logs in the Vercel dashboard for the
`/api/internal/sync-wise` invocation. Two log lines are emitted specifically to
aid diagnosis:

- `[sync-orchestrator] cleanup failed for syncRunId=… after primary error "…"` —
  the sync failed **and** couldn't update its own `sync_runs` row; the row may be
  stuck `running` (`src/lib/sync/orchestrator.ts:581`).
- `[sync-orchestrator] snapshot pruning failed for syncRunId=…` — promotion
  succeeded but pruning didn't; live data is fine (`src/lib/sync/orchestrator.ts:529`).

If the function exceeds 800s it is killed by the platform with no `errorSummary`
write; the `running` row then waits for the next sync's 20-minute sweep to be
marked `failed`. The README notes monitoring sync duration headroom against the
800s ceiling as an ongoing concern.

### 9.4 The database (last resort)

When the in-app surface is itself broken, query `sync_runs` directly (ordered by
`started_at desc`) to see statuses, `error_summary`, `snapshot_id`, and
`promoted_snapshot_id`; and `snapshots` to confirm exactly one row has
`active=true`. The single-flight invariant is enforced by
`sync_runs_single_running_idx` (`drizzle/0013_sync_run_single_flight.sql`), so a
manual insert of a second `running` row will be rejected by the unique index.

---

## Open questions

- **`/api/internal/sync-room-utilization` is intentionally cron-less.** It accepts
  the cron secret *or* an Auth.js session
  (`src/app/api/internal/sync-room-utilization/route.ts:26`–`:40`) but is absent
  from `vercel.json` and is marked `manualOnly: true` in the registry
  (`src/lib/data-health/cron-registry.ts:191`–`:205`). It runs only from the Data
  Health manual control or the `room-utilization:sync` script. Confirm with the
  team whether it *should* eventually be scheduled, or whether on-demand is the
  permanent intent.
- **Migration numbering has gaps and duplicates.** `drizzle/` skips `0009`,
  `0010`, `0025`, and has **two** files each at `0038` and `0039` (a merge-time
  collision); highest is `0040_student_promotions.sql`. drizzle-kit's `meta`
  journal — not filename order — is authoritative for what production has applied.
  Worth confirming the duplicate-numbered files were both intended (and apply
  cleanly in journal order) before relying on this during a manual recovery.
- **Whether `student-promotions/july-1` should be auditable.** Unlike every other
  cron, its route does not wrap `withCronInvocationAudit`
  (`src/app/api/internal/student-promotions/july-1/route.ts:19`–`:48`), so its runs
  leave no `cron_invocations` row and the Data Health page cannot prove it fired.
  Is this deliberate (it has its own domain run table) or an oversight?
- **Emergency manual rollback is not a first-class procedure.** The fail-closed
  design means re-running the sync is the intended recovery, and §8 documents a
  manual `UPDATE snapshots SET active = …` flip, but there is no app endpoint to
  re-promote a specific older snapshot — and pruning physically deletes snapshots
  beyond the most recent 30 (`src/lib/sync/snapshot-pruning.ts:5`). Should a
  guarded "re-promote snapshot N" admin action exist?

_Verified against HEAD `d4fe6d3` on 2026-06-05._
