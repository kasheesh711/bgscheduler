# External Integrations

**Analysis Date:** 2026-04-10

## APIs & External Services

**Wise API (Primary Data Source):**
- Purpose: Fetches all tutor/teacher data, availability, leaves, and future sessions
- Base URL: `https://api.wiseapp.live`
- Namespace: `begifted-education`
- Institute ID: `696e1f4d90102225641cc413`
- SDK/Client: Custom `WiseClient` class at `src/lib/wise/client.ts`
- Factory: `createWiseClient()` in `src/lib/wise/client.ts`
- Auth: Basic Auth (base64 `userId:apiKey`) + `x-api-key` header + `x-wise-namespace` header + custom `user-agent: VendorIntegrations/{namespace}`
- Env vars: `WISE_USER_ID`, `WISE_API_KEY`, `WISE_NAMESPACE`, `WISE_INSTITUTE_ID`
- Resilience: 3 retries with exponential backoff (1s, 2s, 4s), concurrency limiter (max 15 in production, configurable)
- Fetchers: `src/lib/wise/fetchers.ts`
  - `fetchAllTeachers()` - GET `/institutes/{id}/teachers`
  - `fetchTeacherAvailability()` - GET `/institutes/{id}/teachers/{userId}/availability` (7-day windows)
  - `fetchTeacherFullAvailability()` - 26 parallel 7-day windows for 180-day leave horizon
  - `fetchAllFutureSessions()` - GET `/institutes/{id}/sessions?status=FUTURE` (paginated, 1000/page)
- Types: `src/lib/wise/types.ts` - Full response type definitions

## Data Storage

**Database:**
- Provider: Neon Postgres (serverless)
- Region: ap-southeast-1
- Driver: `@neondatabase/serverless` (HTTP mode via `neon()` function)
- ORM: Drizzle ORM (`drizzle-orm/neon-http` adapter)
- Connection: `DATABASE_URL` env var
- Client singleton: `getDb()` in `src/lib/db/index.ts` (lazy-initialized, cached)
- Schema: `src/lib/db/schema.ts` (14 tables)
- Migrations: `drizzle/` directory, managed by `drizzle-kit`

**Tables (14 total):**
- `snapshots` - Versioned data snapshots with atomic `active` flag
- `sync_runs` - Sync execution metadata and status tracking
- `admin_users` - Email allowlist for Google OAuth
- `tutor_identity_groups` - Merged tutor identity groupings
- `tutor_identity_group_members` - Wise teacher/user IDs per group
- `tutor_aliases` - Name alias mappings (e.g. "Kev" -> "Kevin")
- `tutors` - Logical tutor display records
- `raw_teacher_tags` - Original Wise tags per teacher
- `subject_level_qualifications` - Normalized subject/curriculum/level/examPrep
- `recurring_availability_windows` - Weekday + time + modality per group
- `dated_leaves` - Leave windows for 180-day horizon
- `future_session_blocks` - Blocking windows from Wise sessions
- `data_issues` - Unresolved normalization issues by type/severity
- `snapshot_stats` - Aggregate counts for data-health dashboard

**File Storage:**
- Not used (no file uploads or static asset storage)

**Caching:**
- In-memory search index singleton (`src/lib/search/`) loaded from active Postgres snapshot
- Client-side tutor cache (`Map<tutorGroupId:weekStart, CompareTutor>`) in browser for compare view

## Authentication & Identity

**Auth Provider:**
- Auth.js v5 (next-auth ^5.0.0-beta.30) with Google OAuth provider
- Config: `src/lib/auth.ts`
- Route handler: `src/app/api/auth/[...nextauth]/route.ts`
- Middleware: `src/middleware.ts` - Protects all routes except `/login`, `/api/auth/*`, `/api/internal/*`
- Authorization: Email allowlist in `admin_users` Postgres table (8 emails)
- Sign-in callback checks user email against `admin_users` table; rejects non-allowlisted emails
- Custom login page: `/login`
- Env vars: `AUTH_GOOGLE_ID`, `AUTH_GOOGLE_SECRET`, `AUTH_SECRET`

## Monitoring & Observability

**Error Tracking:**
- None (no Sentry, Datadog, or similar)

**Logs:**
- Console logging only (Vercel function logs)
- Sync results stored in `sync_runs` table with error summaries

**Health Dashboard:**
- Custom `/data-health` page showing sync status, issue counts, unresolved items
- API: `GET /api/data-health`

## CI/CD & Deployment

**Hosting:**
- Vercel (Hobby plan)
- Production URL: https://bgscheduler.vercel.app

**CI Pipeline:**
- No CI/CD pipeline detected (no GitHub Actions, no `.github/workflows/`)
- Manual deploy: `npx vercel --prod`
- Git push to `main` triggers Vercel auto-deploy (when Git integration configured)

**Scheduled Tasks:**
- Vercel Cron configured in `vercel.json`
- Schedule: `0 0 * * *` (daily at midnight UTC)
- Endpoint: `POST /api/internal/sync-wise`
- Auth: `CRON_SECRET` Bearer token
- Max duration: 300s (5 minutes, configured in route handler)

## Environment Configuration

**Required env vars (9):**

| Variable | Purpose |
|----------|---------|
| `DATABASE_URL` | Neon Postgres connection string |
| `AUTH_GOOGLE_ID` | Google OAuth client ID |
| `AUTH_GOOGLE_SECRET` | Google OAuth client secret |
| `AUTH_SECRET` | Auth.js session encryption key |
| `WISE_USER_ID` | Wise API user ID |
| `WISE_API_KEY` | Wise API key |
| `WISE_NAMESPACE` | Wise tenant namespace (default: `begifted-education`) |
| `WISE_INSTITUTE_ID` | Wise institute ID (default: `696e1f4d90102225641cc413`) |
| `CRON_SECRET` | Bearer token protecting sync endpoint |

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
| `/api/internal/sync-wise` | POST | CRON_SECRET | Trigger full Wise data sync |
| `/api/search` | POST | Session | Legacy slot-based search |
| `/api/search/range` | POST | Session | Range search with sub-slots |
| `/api/filters` | GET | Session | Dropdown filter options |
| `/api/compare` | POST | Session | Compare 1-3 tutors (week-scoped) |
| `/api/compare/discover` | POST | Session | Discover candidate tutors |
| `/api/tutors` | GET | Session | All tutor names/IDs for combobox |
| `/api/data-health` | GET | Session | Sync status and data issues |

---

*Integration audit: 2026-04-10*
