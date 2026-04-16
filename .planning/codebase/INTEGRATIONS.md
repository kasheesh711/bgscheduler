# External Integrations

**Analysis Date:** 2026-04-16

## APIs & External Services

### Wise API (Primary Data Source)

- **Purpose:** Fetches all tutor/teacher data, availability, leaves, and future sessions
- **Base URL:** `https://api.wiseapp.live`
- **Namespace:** `begifted-education`
- **Institute ID:** `696e1f4d90102225641cc413`
- **Client:** Custom `WiseClient` class at `src/lib/wise/client.ts`
- **Factory:** `createWiseClient()` in `src/lib/wise/client.ts`

**Authentication:**
- Basic Auth: base64-encoded `userId:apiKey` in `Authorization` header
- `x-api-key`: raw API key
- `x-wise-namespace`: tenant namespace
- `user-agent`: `VendorIntegrations/{namespace}`
- Env vars: `WISE_USER_ID`, `WISE_API_KEY`, `WISE_NAMESPACE`, `WISE_INSTITUTE_ID`

**Resilience:**
- 3 retries with exponential backoff (1s, 2s, 4s)
- Queue-based concurrency limiter (default 5, production sync 15)
- Errors re-thrown after max retries exhausted

**Endpoints consumed (via `src/lib/wise/fetchers.ts`):**

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/institutes/{id}/teachers` | GET | Fetch all teachers for institute |
| `/institutes/{id}/teachers/{userId}/availability` | GET | Fetch 7-day availability window (workingHours + leaves) |
| `/institutes/{id}/sessions?status=FUTURE` | GET | Fetch paginated future sessions (1000/page) |

**Fetcher functions:**
- `fetchAllTeachers()` - Single call, returns all teachers
- `fetchTeacherAvailability()` - Single 7-day window for one teacher
- `fetchTeacherFullAvailability()` - 26 parallel 7-day windows for 180-day leave horizon
- `fetchAllFutureSessions()` - Paginated loop until all pages consumed

**Type definitions:** `src/lib/wise/types.ts` (response shapes: `WiseTeacher`, `WiseSession`, `WiseAvailabilityResponse`, envelopes, helper functions)

## Data Storage

### Neon Postgres (Primary Database)

- **Provider:** Neon (serverless PostgreSQL)
- **Region:** ap-southeast-1
- **Driver:** `@neondatabase/serverless` (HTTP mode via `neon()` function)
- **ORM:** Drizzle ORM (`drizzle-orm/neon-http` adapter)
- **Connection:** `DATABASE_URL` env var (format: `postgresql://user:password@host:5432/dbname?sslmode=require`)
- **Client singleton:** `getDb()` in `src/lib/db/index.ts` (lazy-initialized, cached via `globalThis.__bgscheduler_db` to survive HMR)
- **Schema:** `src/lib/db/schema.ts` (14 tables, 4 enums)
- **Migrations:** `drizzle/` directory, managed by `drizzle-kit`

**Database Enums (4):**
- `sync_status`: running, success, failed
- `data_issue_type`: alias, modality, tag, completeness, conflict_model, sync
- `data_issue_severity`: critical, high, medium, low
- `modality`: online, onsite, both, unresolved

**Tables (14):**

| Table | Purpose | Key columns |
|-------|---------|-------------|
| `snapshots` | Versioned data snapshots | `id`, `active` (atomic flag), `created_at` |
| `sync_runs` | Sync execution metadata | `status`, `snapshot_id`, `promoted_snapshot_id`, `teacher_count`, `error_summary` |
| `admin_users` | Email allowlist for Google OAuth | `email` (unique index), `name` |
| `tutor_identity_groups` | Merged tutor identity groupings | `snapshot_id`, `canonical_key`, `display_name`, `supported_modality` |
| `tutor_identity_group_members` | Wise teacher/user IDs per group | `group_id`, `wise_teacher_id`, `wise_user_id`, `is_online_variant` |
| `tutor_aliases` | Name alias mappings | `from_key` (unique index), `to_key` |
| `tutors` | Logical tutor display records | `group_id`, `display_name`, `supported_modes` (jsonb) |
| `raw_teacher_tags` | Original Wise tags per teacher | `group_id`, `wise_teacher_id`, `tag_value`, `tag_raw` (jsonb) |
| `subject_level_qualifications` | Normalized qualifications | `subject`, `curriculum`, `level`, `exam_prep`, `source_tag` |
| `recurring_availability_windows` | Weekday + time + modality | `weekday` (0-6), `start_minute`, `end_minute`, `modality` |
| `dated_leaves` | Leave windows for 180-day horizon | `start_time`, `end_time` (timestamptz) |
| `future_session_blocks` | Blocking windows from Wise sessions | `start_time`, `end_time`, `weekday`, `is_blocking`, `student_name`, `recurrence_id` |
| `data_issues` | Unresolved normalization issues | `type`, `severity`, `entity_type`, `entity_id`, `message`, `metadata` (jsonb) |
| `snapshot_stats` | Aggregate counts per snapshot | `total_wise_teachers`, `total_identity_groups`, `issues_by_type` (jsonb) |

### In-Memory Caching

- **Server-side:** Search index singleton in `src/lib/search/index.ts` loaded from active Postgres snapshot. Stale detection compares index `snapshotId` against DB on each request.
- **Client-side:** Tutor cache (`Map<tutorGroupId:weekStart, CompareTutor>`) in browser for compare view. Invalidated on snapshot change.

### File Storage

- Not used (no file uploads, no blob storage, no static asset storage)

## Authentication & Identity

### Auth.js v5 (next-auth) with Google OAuth

- **Library:** `next-auth` ^5.0.0-beta.30 + `@auth/drizzle-adapter` ^1.11.1
- **Provider:** Google OAuth (`next-auth/providers/google`)
- **Config:** `src/lib/auth.ts`
- **Route handler:** `src/app/api/auth/[...nextauth]/route.ts`
- **Middleware:** `src/middleware.ts` - Protects all routes except `/login`, `/api/auth/*`, `/api/internal/*`
- **Env vars:** `AUTH_GOOGLE_ID`, `AUTH_GOOGLE_SECRET`, `AUTH_SECRET`

**Authorization model:**
- Email allowlist in `admin_users` Postgres table (8 allowlisted emails)
- `signIn` callback queries `admin_users` table; rejects non-allowlisted emails
- Custom login page at `/login` with error handling for access-denied
- Matcher excludes `_next/static`, `_next/image`, `favicon.ico`

## CI/CD & Deployment

### Vercel (Hosting & Functions)

- **Plan:** Hobby
- **Production URL:** https://bgscheduler.vercel.app
- **Repository:** https://github.com/kasheesh711/bgscheduler
- **Deploy command:** `npx vercel --prod` or push to `main` (Git integration)
- **Config:** `vercel.json` - cron schedule only

**Serverless Functions:**
- Max duration: 300s (configured via `export const maxDuration = 300` in `src/app/api/internal/sync-wise/route.ts`)
- Runtime: Node.js (default)

**CI Pipeline:**
- No CI/CD pipeline detected (no GitHub Actions, no `.github/workflows/`)
- Manual deploy or Git-push auto-deploy

### Vercel Cron (Scheduled Sync)

- **Config:** `vercel.json` -> `crons[0]`
- **Schedule:** `0 0 * * *` (daily at midnight UTC)
- **Endpoint:** `POST /api/internal/sync-wise`
- **Auth:** `CRON_SECRET` Bearer token in `Authorization` header
- **Handler:** Validates token, runs `runFullSync()`, calls `revalidateTag("snapshot", { expire: 0 })` on success

## Monitoring & Observability

**Error Tracking:**
- None (no Sentry, Datadog, or similar)

**Logs:**
- Console logging only (Vercel function logs)
- Sync results stored in `sync_runs` table with error summaries and metadata (jsonb)

**Health Dashboard:**
- Custom `/data-health` page showing sync status, issue counts, unresolved items
- API: `GET /api/data-health`

## Environment Configuration

**Required env vars (9), validated at startup via Zod in `src/lib/env.ts`:**

| Variable | Purpose | Default |
|----------|---------|---------|
| `DATABASE_URL` | Neon Postgres connection string | (required) |
| `AUTH_GOOGLE_ID` | Google OAuth client ID | (required) |
| `AUTH_GOOGLE_SECRET` | Google OAuth client secret | (required) |
| `AUTH_SECRET` | Auth.js session encryption key | (required) |
| `WISE_USER_ID` | Wise API user ID | (required) |
| `WISE_API_KEY` | Wise API key | (required) |
| `WISE_NAMESPACE` | Wise tenant namespace | `begifted-education` |
| `WISE_INSTITUTE_ID` | Wise institute ID | `696e1f4d90102225641cc413` |
| `CRON_SECRET` | Bearer token protecting sync endpoint | (required) |

**Secrets location:**
- `.env.local` for local development (gitignored)
- `.env.example` documents all required vars with placeholder values
- Vercel Environment Variables for production

## Webhooks & Callbacks

**Incoming:**
- `POST /api/internal/sync-wise` - Vercel Cron trigger (daily) or manual `curl` invocation
- `POST /api/auth/[...nextauth]/*` - Google OAuth callback

**Outgoing:**
- None (no webhooks sent to external services)

## API Route Summary

| Route | Method | Auth | Purpose |
|-------|--------|------|---------|
| `/api/auth/[...nextauth]` | ALL | Public | Auth.js handlers (Google OAuth) |
| `/api/internal/sync-wise` | POST | CRON_SECRET | Trigger full Wise data sync (300s max) |
| `/api/search` | POST | Session | Legacy slot-based search |
| `/api/search/range` | POST | Session | Range search with sub-slots |
| `/api/filters` | GET | Session | Dropdown filter options (subjects, curriculums, levels) |
| `/api/compare` | POST | Session | Compare 1-3 tutors (week-scoped, incremental fetch) |
| `/api/compare/discover` | POST | Session | Discover candidate tutors with filters |
| `/api/tutors` | GET | Session | All tutor names/IDs/modes/subjects for combobox |
| `/api/data-health` | GET | Session | Sync status, snapshot stats, data issues |

---

*Integration audit: 2026-04-16 | Source: `src/lib/wise/`, `src/lib/db/`, `src/lib/auth.ts`, `src/middleware.ts`, `vercel.json`, `.env.example`*
