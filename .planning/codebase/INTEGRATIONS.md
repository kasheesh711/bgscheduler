# External Integrations

**Analysis Date:** 2026-04-29

## APIs & External Services

**Wise Scheduling Platform (primary external data source):**
- Service: Wise API at `https://api.wiseapp.live` - Source of truth for tutor data, sessions, availability, leaves
  - Tenant: `begifted-education` (namespace)
  - Institute: `696e1f4d90102225641cc413`
  - SDK/Client: Custom HTTP client at `src/lib/wise/client.ts`
  - Auth: Basic Auth (base64 of `WISE_USER_ID:WISE_API_KEY`) plus `x-api-key`, `x-wise-namespace`, and `user-agent: VendorIntegrations/{namespace}` headers (`src/lib/wise/client.ts` lines 37-46)
  - Auth env vars: `WISE_USER_ID`, `WISE_API_KEY`, `WISE_NAMESPACE`, `WISE_INSTITUTE_ID`
  - Concurrency: queue-based limiter, max 5 default, 15 for production sync (`src/lib/wise/client.ts` line 33, line 121)
  - Retry: exponential backoff 1s/2s/4s, max 3 retries (`src/lib/wise/client.ts` lines 84-86)
  - Endpoints used (`src/lib/wise/fetchers.ts`):
    - `GET /institutes/{instituteId}/teachers` - List all teachers (line 21)
    - `GET /institutes/{instituteId}/teachers/{teacherUserId}/availability?startTime=...&endTime=...` - 7-day availability windows; called 26 times per teacher to cover 180-day horizon (lines 35-41, 74-83)
    - `GET /institutes/{instituteId}/sessions?status=FUTURE&paginateBy=COUNT&page_number=N&page_size=1000` - Paginated future sessions (lines 105-113)

**Google OAuth (authentication):**
- Service: Google Identity Services for sign-in
  - SDK/Client: `next-auth` ^5.0.0-beta.30 with Google provider (`src/lib/auth.ts` lines 1-2)
  - Auth env vars: `AUTH_GOOGLE_ID`, `AUTH_GOOGLE_SECRET`, `AUTH_SECRET`
  - Allowlist enforced via `admin_users` Postgres table (`src/lib/auth.ts` lines 22-29)

## Data Storage

**Databases:**
- Neon Postgres (serverless, ap-southeast-1)
  - Provider: Neon Postgres `ep-calm-mud-a1d7pmsi.ap-southeast-1.aws.neon.tech`
  - Connection: `DATABASE_URL` env var (validated as URL by Zod in `src/lib/env.ts` line 4)
  - Driver: `@neondatabase/serverless` ^1.0.2 HTTP-mode neon client (`src/lib/db/index.ts` line 1, line 10)
  - ORM: `drizzle-orm` ^0.45.2 with `drizzle-orm/neon-http` adapter (`src/lib/db/index.ts` line 2)
  - Schema location: `src/lib/db/schema.ts` (14 tables, 4 enums)
  - Migrations: `drizzle/0000_tidy_black_bolt.sql`, `drizzle/0001_tough_plazm.sql`, `drizzle/0002_past_session_blocks.sql`
  - Tables: `snapshots`, `sync_runs`, `admin_users`, `tutor_identity_groups`, `tutor_identity_group_members`, `tutor_aliases`, `tutors`, `raw_teacher_tags`, `subject_level_qualifications`, `recurring_availability_windows`, `dated_leaves`, `future_session_blocks`, `past_session_blocks`, `data_issues`, `snapshot_stats`
  - DB instance is a `globalThis` singleton for HMR survival (`src/lib/db/index.ts` lines 17-27)

**File Storage:**
- None - No file uploads or external object storage detected

**Caching:**
- In-memory search index singleton: module-level `currentIndex` in `src/lib/search/index.ts` rebuilt lazily on snapshot change
- Next.js Data Cache: `cacheTag`/`cacheLife` from `next/cache` used in `src/lib/data/filters.ts`, `src/lib/data/tutors.ts`, `src/lib/data/past-sessions.ts`
- Cache invalidation: `revalidateTag("snapshot", { expire: 0 })` called after successful sync (`src/app/api/internal/sync-wise/route.ts` line 26)
- Client-side cache: `Map<tutorGroupId:weekStart, CompareTutor>` for compare view in browser memory
- localStorage: Recent searches (last 10) persisted in browser

## Authentication & Identity

**Auth Provider:**
- Auth.js v5 (`next-auth` ^5.0.0-beta.30)
  - Implementation: `src/lib/auth.ts`
  - Provider: Google OAuth only (`src/lib/auth.ts` lines 8-13)
  - Sign-in/error redirects to `/login` (lines 14-17)
  - Allowlist callback: `signIn` callback queries `admin_users` table by email, denies non-allowlisted users (lines 19-30)
  - Adapter: `@auth/drizzle-adapter` declared in `package.json` line 17 but not currently imported in `src/`
  - Route handlers: `src/app/api/auth/[...nextauth]/route.ts` re-exports `GET, POST` from `handlers`
  - Middleware gate: `src/middleware.ts` allows `/login`, `/api/auth/*`, `/api/internal/*` without auth; redirects everything else to `/login` if unauthenticated
  - Required env vars: `AUTH_GOOGLE_ID`, `AUTH_GOOGLE_SECRET`, `AUTH_SECRET`

**Allowlist (9 admin emails, seeded via `npm run db:seed` with `SEED_ADMIN_EMAILS` env var, `src/lib/db/seed.ts` lines 31-43):**
- aoengnatchasmith@gmail.com
- chiraya.work@gmail.com
- k.waritpariya@gmail.com
- kevhsh7@gmail.com
- kevinhsieh711@gmail.com
- kittiya.carekt@gmail.com
- pakwalaan@gmail.com
- panida.wiya@gmail.com
- suphitsaramanosamrit@gmail.com

## Monitoring & Observability

**Error Tracking:**
- None detected - No Sentry, Datadog, Bugsnag, or similar service integrated
- Errors surfaced through `data_issues` Postgres table (`src/lib/db/schema.ts` lines 265-279) with type/severity classification (`alias`, `modality`, `tag`, `completeness`, `conflict_model`, `sync` × `critical`/`high`/`medium`/`low`)

**Logs:**
- `console.error()` for validation failures and caught errors
- Vercel platform logs (default platform observability)
- No structured logging library (no pino, winston, etc.)
- No request logging middleware

**Health Endpoint:**
- `GET /api/data-health` - Sync status, snapshot stats, issue counts, recent sync history (`src/app/api/data-health/route.ts`)

## CI/CD & Deployment

**Hosting:**
- Vercel (Hobby plan)
  - Deploy via `npx vercel --prod` or push to `main`
  - Production URL: https://bgscheduler.vercel.app
  - Repo: https://github.com/kasheesh711/bgscheduler

**CI Pipeline:**
- No `.github/workflows/` or other CI config files detected at repo root
- Vercel Git integration handles auto-deploy on `main` push
- Tests run locally via `npm test` (Vitest)

**Cron:**
- Vercel Cron (declared in `vercel.json`)
  - Schedule: `0 0 * * *` (daily at midnight UTC)
  - Path: `/api/internal/sync-wise`
  - Secured by `CRON_SECRET` Bearer token (`src/app/api/internal/sync-wise/route.ts` lines 12-17)
  - Function timeout: 300s (`maxDuration = 300` line 7)
  - Hobby plan limit: daily cron only; Pro plan would unlock 30-min cadence

## Environment Configuration

**Required env vars (9, validated at startup by Zod in `src/lib/env.ts`):**
- `DATABASE_URL` - Neon Postgres connection string (validated as URL)
- `AUTH_GOOGLE_ID` - Google OAuth client ID
- `AUTH_GOOGLE_SECRET` - Google OAuth client secret
- `AUTH_SECRET` - Auth.js session encryption key
- `WISE_USER_ID` - Wise API user ID
- `WISE_API_KEY` - Wise API key
- `WISE_NAMESPACE` - Defaults to `begifted-education` (`src/lib/env.ts` line 10)
- `WISE_INSTITUTE_ID` - Defaults to `696e1f4d90102225641cc413` (line 11)
- `CRON_SECRET` - Bearer token guarding `/api/internal/sync-wise`

**Optional env vars:**
- `SEED_ADMIN_EMAILS` - Comma-separated list consumed only by `src/lib/db/seed.ts` line 31

**Secrets location:**
- Production: Vercel project environment variables (UI-managed)
- Local: `.env.local` (gitignored, present per `ls -la` check)
- Documented in `.env.example`
- Validation: `src/lib/env.ts` throws at startup if any required var missing or `DATABASE_URL` is not a valid URL

## Webhooks & Callbacks

**Incoming:**
- `GET /api/internal/sync-wise` - Vercel Cron daily trigger (auth via `CRON_SECRET` Bearer token)
- `POST /api/internal/sync-wise` - Manual `curl` trigger (same auth)
- `GET /api/auth/[...nextauth]` and `POST /api/auth/[...nextauth]` - Auth.js OAuth callbacks (Google sign-in flow)

**Outgoing:**
- All outgoing HTTP traffic routed through `WiseClient` to `https://api.wiseapp.live` only (no other third-party API calls detected in `src/`)
- No webhook subscriptions registered with Wise (pull-only ETL model)

---

*Integration audit: 2026-04-29*
