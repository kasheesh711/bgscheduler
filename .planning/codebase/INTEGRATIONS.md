# External Integrations

**Analysis Date:** 2026-04-21

## APIs & External Services

**Wise API (primary data source):**
- Service: Wise scheduling platform — `https://api.wiseapp.live`
- Tenant: `begifted-education` (namespace)
- Institute: `696e1f4d90102225641cc413`
- SDK/Client: Custom HTTP client at `src/lib/wise/client.ts` (class `WiseClient`, factory `createWiseClient()`)
- Fetchers: `src/lib/wise/fetchers.ts` (`fetchAllTeachers`, `fetchTeacherAvailability`, `fetchTeacherFullAvailability`, `fetchAllFutureSessions`)
- Types: `src/lib/wise/types.ts` (`WiseTeacher`, `WiseWorkingHourSlot`, `WiseLeave`, `WiseSession`, etc.)
- Auth headers (from `src/lib/wise/client.ts:37-46`):
  - `Authorization: Basic {base64(userId:apiKey)}`
  - `x-api-key: {apiKey}`
  - `x-wise-namespace: {namespace}`
  - `user-agent: VendorIntegrations/{namespace}`
  - `Content-Type: application/json`
- Auth env vars: `WISE_USER_ID`, `WISE_API_KEY`, `WISE_NAMESPACE`, `WISE_INSTITUTE_ID`
- Endpoints consumed:
  - `GET /institutes/{instituteId}/teachers` — all teachers
  - `GET /institutes/{instituteId}/teachers/{teacherUserId}/availability?startTime=...&endTime=...` — workingHours + leaves per 7-day window (180-day horizon stitched across 26 windows)
  - `GET /institutes/{instituteId}/sessions?status=FUTURE&paginateBy=COUNT&page_number=N&page_size=1000` — paginated future sessions
- Resilience patterns (all in `src/lib/wise/client.ts`):
  - Exponential backoff retry: 1s → 2s → 4s, `maxRetries` default `3` (line 84-88)
  - Concurrency limiter: queue-based, `maxConcurrency` default `5`; `createWiseClient()` sets `15` for production sync (line 121)
  - Non-2xx responses throw `Error("Wise API {status}: {body} ({url})")` (line 77-80)
- Known limitation: `status: "FUTURE"` endpoint does NOT return past sessions; compare view compensates with weekday fallback in `src/lib/search/compare.ts`

**Google OAuth (authentication only):**
- Service: Google Identity / OAuth 2.0
- SDK: `next-auth` `^5.0.0-beta.30` with built-in provider `next-auth/providers/google`
- Integration: `src/lib/auth.ts` — calls `Google({ clientId, clientSecret })`
- Auth env vars: `AUTH_GOOGLE_ID`, `AUTH_GOOGLE_SECRET`, `AUTH_SECRET`

## Data Storage

**Databases:**
- Neon Postgres (serverless, HTTP driver)
  - Region: `ap-southeast-1` (Singapore)
  - Host: `ep-calm-mud-a1d7pmsi.ap-southeast-1.aws.neon.tech`
  - Connection: `DATABASE_URL` env var (Postgres connection string with `?sslmode=require`)
  - Driver: `@neondatabase/serverless` `^1.0.2` via `neon(databaseUrl)` at `src/lib/db/index.ts:10`
  - ORM: `drizzle-orm` `^0.45.2` via `drizzle({ client: sql, schema })` from `drizzle-orm/neon-http` at `src/lib/db/index.ts:11`
  - Singleton pattern: `globalThis.__bgscheduler_db` survives HMR (`src/lib/db/index.ts:16-27`)
  - Schema: `src/lib/db/schema.ts` — 14 tables (`snapshots`, `sync_runs`, `admin_users`, `tutor_identity_groups`, `tutor_identity_group_members`, `tutor_aliases`, `tutors`, `raw_teacher_tags`, `subject_level_qualifications`, `recurring_availability_windows`, `dated_leaves`, `future_session_blocks`, `data_issues`, `snapshot_stats`)
  - Enums: `sync_status`, `data_issue_type`, `data_issue_severity`, `modality`
  - Migrations: `drizzle/0000_tidy_black_bolt.sql`, `drizzle/0001_tough_plazm.sql`
  - Seed script: `src/lib/db/seed.ts` (run via `npm run db:seed` / `tsx`)

**File Storage:**
- Not applicable — all persistent state lives in Postgres
- Static assets: served from `public/` via Next.js static handling

**Caching:**
- In-memory search index singleton at `src/lib/search/index.ts` (module-level `currentIndex` with stale detection against active snapshot)
- Next.js cache: `cacheComponents: true` in `next.config.ts`; `revalidateTag("snapshot", { expire: 0 })` fired after successful sync in `src/app/api/internal/sync-wise/route.ts:26`
- Client-side `Map<tutorGroupId:weekStart, CompareTutor>` cache in the search page (see `src/app/(app)/search/page.tsx`)
- Browser `localStorage` — last 10 recent searches (client-only)
- No Redis / external cache service

## Authentication & Identity

**Auth Provider:**
- Auth.js v5 beta (`next-auth` `^5.0.0-beta.30`) with Google OAuth provider only
- Entry points:
  - `src/lib/auth.ts` — `NextAuth(...)` configuration; exports `{ handlers, signIn, signOut, auth }`
  - `src/app/api/auth/[...nextauth]/route.ts` — re-exports `handlers.GET`/`handlers.POST`
  - `src/middleware.ts` — wraps `auth((req) => {...})` to gate all routes except `/login`, `/api/auth/*`, `/api/internal/*`, and static assets (matcher: `"/((?!_next/static|_next/image|favicon.ico).*)"`)
- Implementation approach: admin email allowlist — `signIn` callback queries `admin_users` table and rejects non-listed emails (`src/lib/auth.ts:19-30`)
- Custom pages: `signIn: "/login"`, `error: "/login"`
- Session callback is a passthrough (`src/lib/auth.ts:31-33`)
- `@auth/drizzle-adapter` `^1.11.1` is installed but not wired into `NextAuth({ adapter: ... })` currently — sessions are JWT-based, admin allowlist is the gate
- Allowlisted admins (9 emails per AGENTS.md): `aoengnatchasmith@gmail.com`, `chiraya.work@gmail.com`, `k.waritpariya@gmail.com`, `kevhsh7@gmail.com`, `kevinhsieh711@gmail.com`, `kittiya.carekt@gmail.com`, `pakwalaan@gmail.com`, `panida.wiya@gmail.com`, `suphitsaramanosamrit@gmail.com`

## Monitoring & Observability

**Error Tracking:**
- None (no Sentry, Rollbar, Datadog, etc.)

**Logs:**
- `console.error()` for validation failures and caught errors in API route handlers
- `console.error` in env parser at `src/lib/env.ts:19`
- Sync orchestrator logs progress via `console.*` (see `src/lib/sync/orchestrator.ts`)
- Persisted diagnostic state: `data_issues` table + `sync_runs.errorSummary`/`metadata` jsonb — surfaced in `/data-health` page and `GET /api/data-health`

**Metrics:**
- `snapshot_stats` table stores per-snapshot counts for the data-health dashboard
- No APM / metrics pipeline

## CI/CD & Deployment

**Hosting:**
- Vercel (account linked via `.vercel/` directory)
- Deployment command: `npx vercel --prod` or push to `main` (Git integration)
- Plan: Hobby (daily cron cadence is a Hobby-plan constraint; Pro required for 30-minute cadence)

**CI Pipeline:**
- No GitHub Actions workflows detected (no `.github/workflows/` directory)
- Tests run locally via `npm test`; Vercel handles build/deploy

**Cron:**
- Vercel Cron — configured in `vercel.json`:
  ```json
  { "crons": [{ "path": "/api/internal/sync-wise", "schedule": "0 0 * * *" }] }
  ```
- Cron triggers `GET /api/internal/sync-wise`; manual runs use `POST` with `Authorization: Bearer $CRON_SECRET`
- Both methods share `handleSync()` handler; secret check rejects with 401 if mismatch (`src/app/api/internal/sync-wise/route.ts:12-17`)

## Environment Configuration

**Required env vars (9) — validated by Zod at `src/lib/env.ts`:**

| Variable | Purpose | Validation |
|----------|---------|------------|
| `DATABASE_URL` | Neon Postgres connection string | `z.string().url()` |
| `AUTH_GOOGLE_ID` | Google OAuth client ID | `z.string().min(1)` |
| `AUTH_GOOGLE_SECRET` | Google OAuth client secret | `z.string().min(1)` |
| `AUTH_SECRET` | Auth.js session encryption key | `z.string().min(1)` |
| `WISE_USER_ID` | Wise API user ID (Basic Auth user) | `z.string().min(1)` |
| `WISE_API_KEY` | Wise API key (Basic Auth password + `x-api-key` header) | `z.string().min(1)` |
| `WISE_NAMESPACE` | Wise tenant namespace | `z.string().default("begifted-education")` |
| `WISE_INSTITUTE_ID` | Wise institute ID used in URL paths | `z.string().default("696e1f4d90102225641cc413")` |
| `CRON_SECRET` | Bearer token protecting the sync endpoint | `z.string().min(1)` |

**Secrets location:**
- Local development: `.env.local` (gitignored; present in repo root — contents never read)
- Production: Vercel project environment variables
- Template: `.env.example` at repo root

## Webhooks & Callbacks

**Incoming:**
- `GET /api/internal/sync-wise` — Vercel cron webhook trigger (Bearer-token protected)
- `POST /api/internal/sync-wise` — manual sync trigger (same handler, same protection)
- `GET/POST /api/auth/[...nextauth]` — Auth.js OAuth callback endpoints (Google redirect URI)

**Outgoing:**
- No outgoing webhooks to third-party services
- All external calls are request/response fetches to the Wise API

---

*Integration audit: 2026-04-21*
