# External Integrations

**Analysis Date:** 2026-05-31

BGScheduler talks to six external systems: the **Wise** scheduling/billing platform (the canonical data source), **LINE** Messaging (parent-message ingest + push + verified-contact links), **OpenAI** (the AI scheduler parser/assistant + progress-test summaries), **Google** (OAuth sign-in, Sheets read/write, and an Apps Script email relay), **Neon Postgres** (the only datastore), and **Vercel** (hosting + cron). Every integration is exercised from server code under `src/lib/**` and `src/app/api/**`; there is no client-side third-party SDK. The app is pull/push over plain `fetch` — no third-party SDK wrappers, no message broker, no object storage. The Wise write surface has widened beyond a single location writeback: two independent verification flags now gate it (`WISE_SESSION_OPERATIONS_VERIFIED` for the legacy location `PUT`, `WISE_SESSION_CREATE_VERIFIED` for progress-test session creation), and the student-promotions feature writes course/registration data through additional guarded calls.

## APIs & External Services

### Wise scheduling platform (primary external data source)
- Service: Wise API at `https://api.wiseapp.live` — source of truth for teachers, sessions, availability, leaves, billing/fees, audit events, locations, analytics, courses, and student registration. No production fallback to sheets or files.
  - Tenant / namespace: `begifted-education` (`WISE_NAMESPACE`, default in `src/lib/env.ts:10`).
  - Institute: `696e1f4d90102225641cc413` (`WISE_INSTITUTE_ID`, default in `src/lib/env.ts:11`).
  - Client: hand-rolled HTTP client `WiseClient` at `src/lib/wise/client.ts:16`; `get`/`post`/`put` helpers all funnel through a concurrency limiter + retry wrapper.
  - Auth: Basic Auth (base64 of `WISE_USER_ID:WISE_API_KEY`) plus `x-api-key`, `x-wise-namespace`, and `user-agent: VendorIntegrations/{namespace}` headers (`src/lib/wise/client.ts:52-61`).
  - Auth env vars: `WISE_USER_ID`, `WISE_API_KEY`, `WISE_NAMESPACE`, `WISE_INSTITUTE_ID`.
  - Concurrency: queue-based limiter, default 5 (`src/lib/wise/client.ts:48`), raised for the production sync via `createWiseClient()`.
  - Retry: exponential backoff, max 3 retries (`src/lib/wise/client.ts:49`). Only `408/429/500/502/503/504` are retried (`RETRYABLE_STATUS_CODES`, `src/lib/wise/client.ts:23-30`); permanent 4xx (401/403/404/422) fail fast. Network-level errors are also retried.
  - **Read** endpoints (`src/lib/wise/fetchers.ts` — full signatures live in [reference/integrations.md](../reference/integrations.md)):
    - `GET /institutes/{id}/teachers` — list teachers.
    - `GET /institutes/{id}/teachers/{teacherUserId}/availability?startTime&endTime` — 7-day availability windows, stitched across ~26 windows to cover the 180-day horizon.
    - `GET /institutes/{id}/sessions?status=FUTURE&...` — paginated future sessions.
    - `GET /institutes/{id}/locations` — room/venue catalog.
    - `GET /institutes/{id}/events` — audit/activity feed, `page_size` clamped to ≤50 (`src/lib/wise/fetchers.ts:430`); date params are untrusted, so the sync walks newest-first.
    - `GET /institutes/{id}/fees/transactions` — receipt/fee transactions for credit-control + payroll reconciliation (`src/lib/wise/fetchers.ts:655`).
    - `GET /institutes/{id}/analytics/sessionStats|classroomStats|classroomTrends` and `/fees/...PaidTrends` — analytics aggregates (`src/lib/wise/fetchers.ts:444-492`).
    - `GET /institutes/{id}/participants/{studentId}?showRegistrationData=true` — student registration data (`src/lib/wise/fetchers.ts:242`).
    - `GET /user/v2/classes/{classId}?full=true` and `GET /user/classes/{classId}/participants` — course detail + roster (student-promotions; `src/lib/wise/fetchers.ts:265,285`).
    - `fetchWiseAcceptedStudents` (`src/lib/wise/fetchers.ts:210`) — accepted-student feed for promotions.
  - **Write** endpoints — all gated; the legacy single writeback is no longer the only one:
    - `PUT /teacher/classes/{classId}/sessions/{sessionId}?updateType=SINGLE` — class-assignment `location` writeback (`updateSessionLocation`, `src/lib/wise/fetchers.ts:357`). Gated by `wiseSessionOperationsVerified()` → `WISE_SESSION_OPERATIONS_VERIFIED === "true"` (`src/lib/wise/operations.ts:10-12`); only `location` on eligible `OFFLINE` sessions, only after explicit admin confirmation.
    - `POST /teacher/classes/{classId}/sessions` — create a new SINGLE session (`scheduleWiseSession`, `src/lib/wise/fetchers.ts:389`). Used by progress-test booking, gated by `WISE_SESSION_CREATE_VERIFIED === "true"` (`src/lib/progress-tests/config.ts:50`) after an availability pre-check; when off, booking finalizes `manual_required` instead of writing.
    - `POST /institutes/{id}/checkSessionsAvailability` — teacher/time/location conflict pre-check before any session write (`checkTeacherAvailabilityForSessions`, `src/lib/wise/fetchers.ts:340`).
    - `PUT /teacher/editClass` — update a course's subject (`updateWiseCourseSubject`, `src/lib/wise/fetchers.ts:277`); student-promotions only.
    - `PUT /institutes/{id}/students/{studentId}/registration` — write registration answers (`updateWiseStudentRegistrationAnswers`, `src/lib/wise/fetchers.ts:255`); student-promotions only.
  - Consumers (all server-side): sync orchestrator (`src/lib/sync/`), Wise-activity audit sync + reconciliation (`src/lib/wise-activity/`), credit-control sync (`src/lib/credit-control/run-sync-request.ts`), payroll sync (`src/lib/payroll/sync.ts`), classroom morning automation (`src/lib/classrooms/morning-automation.ts`), room-capacity utilization (`src/lib/room-capacity/utilization.ts`), progress-tests booking/sync (`src/lib/progress-tests/`), and student-promotions (`src/lib/student-promotions/data.ts`, which builds its own `WiseClient` via `createPromotionWiseClient()`).

### LINE Messaging (parent-chat ingest + push + verified-contact links)
- Service: LINE Messaging API at `https://api.line.me` (`src/lib/line/client.ts:3`).
  - Auth: Bearer `LINE_CHANNEL_ACCESS_TOKEN` (`src/lib/line/client.ts:29-33`); `lineAccessToken()` throws if absent.
  - Inbound webhook signature: HMAC-SHA256 of the raw body keyed by `LINE_CHANNEL_SECRET`, base64-compared with `timingSafeEqual` (`src/lib/line/signature.ts`). Invalid signature → 401.
  - Endpoints used:
    - `GET /v2/bot/profile/{userId}` — fetch contact display name / picture (`src/lib/line/client.ts:42`); 404 → `null`.
    - `POST /v2/bot/message/push` — outbound text push with `X-Line-Retry-Key` idempotency header; HTTP 409 treated as "retry already accepted" (`src/lib/line/client.ts:69-92`).
  - Feature flag: `lineSchedulerEnabled()` requires `ENABLE_LINE_SCHEDULER !== "false"` **and** both `LINE_CHANNEL_SECRET` and `LINE_CHANNEL_ACCESS_TOKEN` present (`src/lib/line/client.ts:19-23`). When off, the webhook route returns 503.
  - Auth env vars: `LINE_CHANNEL_SECRET`, `LINE_CHANNEL_ACCESS_TOKEN` (both optional in `src/lib/env.ts:13-14`), `ENABLE_LINE_SCHEDULER` (`src/lib/env.ts:15`).
  - Other LINE env: `LINE_VALIDATION_LEAD_EMAILS` — comma-separated allowlist of link-validation leads, with a hardcoded default list (`src/lib/line/link-validation.ts`).
  - Inbound processing: the webhook records the payload, then schedules per-message scheduler classification on the Next.js `after()` hook so the HTTP response returns immediately (`src/app/api/line/webhook/route.ts`, `maxDuration = 60`).
  - Cross-feature reuse: progress-tests does **not** push over LINE; it resolves verified parent contacts via `line_contact_student_links` (status `verified`) and surfaces a validated `chat.line.biz` staff-chat URL through `trustedLineChatUrlFromEvidence`, sharing the leave-requests resolution path (`src/lib/progress-tests/line.ts:1-40`).

### OpenAI (AI scheduler parse + conversation + progress-test summaries)
- Service: OpenAI Responses API at `https://api.openai.com/v1/responses`. Three call sites: the scheduler parser (`src/lib/ai/scheduler.ts`), the chat-assistant turn (`src/lib/ai/scheduler-conversation.ts:2346`), and the progress-test narrative summarizer (`src/lib/progress-tests/ai-summary.ts:185`).
  - Auth: Bearer `OPENAI_API_KEY` (`src/lib/ai/scheduler-conversation.ts:2341-2349`, `src/lib/progress-tests/ai-summary.ts:164`).
  - Feature flag: `isAiSchedulerConfigured()` requires `ENABLE_AI_SCHEDULER !== "false"` and a non-empty `OPENAI_API_KEY` (`src/lib/ai/scheduler.ts:477-480`). Progress-test summaries gate on the same flag plus `OPENAI_API_KEY` (`src/lib/progress-tests/ai-summary.ts:78`).
  - Model selection env: `OPENAI_SCHEDULER_MODEL` (default in code, `src/lib/ai/scheduler.ts:461`), `OPENAI_SCHEDULER_SHADOW_MODEL` (optional shadow eval, `:465`), `OPENAI_SCHEDULER_REASONING_EFFORT` (none/low/medium/high/xhigh, `:469-475`), and `OPENAI_PROGRESS_TEST_MODEL` (falls back to the scheduler default, `src/lib/progress-tests/ai-summary.ts:88`).
  - Usage shape: structured-output JSON-schema parse (`store: false`, strict) converts pasted chat into a single bounded Wise search request; the app — not the model — decides availability. The model never reaches Wise directly.

### Google APIs (three distinct surfaces)
1. **Google OAuth sign-in** — NextAuth Google provider (see *Authentication & Identity*). Tokens captured at sign-in are reused for Sheets.
2. **Google Sheets API v4** — `https://sheets.googleapis.com/v4/spreadsheets/...` (`src/lib/sales-dashboard/sheets.ts`).
   - Auth: per-user OAuth access token retrieved/refreshed by the helpers in `src/lib/sales-dashboard/google-oauth.ts`.
   - Scopes: read `https://www.googleapis.com/auth/spreadsheets.readonly`, write `https://www.googleapis.com/auth/spreadsheets` (`src/lib/sales-dashboard/google-oauth.ts:7-8`).
   - Operations: list sheet titles, read rows (`UNFORMATTED_VALUE` / `SERIAL_NUMBER`), and single-cell `PUT` writeback for status columns.
   - Consumers: Sales Dashboard import (`src/lib/sales-dashboard/**`) and Tutor Leave Requests sync (`src/lib/leave-requests/sync.ts`, reads the leave-request form-responses sheet and writes the status column back).
   - Token refresh: `POST https://oauth2.googleapis.com/token` with `grant_type=refresh_token` using `AUTH_GOOGLE_ID`/`AUTH_GOOGLE_SECRET`.
   - Token storage: `google_oauth_tokens` rows, AES-256-GCM-encrypted at rest, key = SHA-256 of `AUTH_SECRET`, `v1:` token envelope (`src/lib/sales-dashboard/google-oauth.ts:37-68`).
3. **Google Apps Script email relay** — schedule emails are POSTed to a deployed Apps Script web app, not an email SaaS (`src/lib/classrooms/schedule-email.ts`).
   - Endpoint: `SCHEDULE_EMAIL_APPS_SCRIPT_URL` (primary) and `SCHEDULE_EMAIL_BACKUP_APPS_SCRIPT_URL` (failover) (`src/lib/classrooms/schedule-email.ts:289-302`).
   - Auth: a `secret` field in the JSON body (`SCHEDULE_EMAIL_APPS_SCRIPT_SECRET` / `SCHEDULE_EMAIL_BACKUP_APPS_SCRIPT_SECRET`), not a header; a missing secret short-circuits the send (`:469-472`, `:604`).
   - Idempotency: per-recipient `idempotencyKey` derived from run + recipient + content (`src/lib/classrooms/schedule-email.ts:648`).
   - Quota failover: on a MailApp "daily recipient quota exhausted" error the primary run stops and the backup sender takes over the remaining recipients.
   - Sender metadata env: `SCHEDULE_EMAIL_SENDER_NAME` (default `BeGifted`), `SCHEDULE_EMAIL_REPLY_TO` (default `kevhsh7@gmail.com`), `SCHEDULE_EMAIL_PUBLIC_BASE_URL` (default `https://bgscheduler.vercel.app`) (`src/lib/classrooms/schedule-email.ts:606-607`, `:266-275`).

## Data Storage

**Databases:**
- Neon Postgres (serverless, ap-southeast-1) — the only datastore.
  - Provider: Neon Postgres `ep-calm-mud-a1d7pmsi.ap-southeast-1.aws.neon.tech` (per project docs).
  - Connection: `DATABASE_URL` env var, validated as a URL by Zod (`src/lib/env.ts:4`).
  - Default driver: `@neondatabase/serverless` HTTP-mode `neon()` client wrapped by `drizzle-orm/neon-http` (`src/lib/db/index.ts`), exposed as a `globalThis` singleton to survive HMR.
  - Transaction caveat: the neon-http driver cannot run interactive transactions. Payroll sync therefore opens a **direct node-postgres `Pool`** (`pg`) against the same `DATABASE_URL` (`max: 1`) for its transactional writes, detecting the "No transactions support in neon-http driver" error (`src/lib/payroll/sync.ts:3`, `:90-96`). `pg` is also used by the integration-test harness.
  - ORM / migrations: Drizzle ORM with `drizzle-kit`; dialect `postgresql`, schema at `src/lib/db/schema.ts`, output `drizzle/` (`drizzle.config.ts`).
  - Schema scale: **90 tables** and **25 `pgEnum`** types in `src/lib/db/schema.ts`. Beyond the prior tutor/snapshot/classroom/wise-activity/sales/credit-control/LINE/AI/payroll/room-capacity/profiles/leave-requests domains, the schema now adds **progress-tests** (every-8-classes tracker, teacher access scoping), **student-promotions** (annual grade-promotion runs), and a **`cron_invocations`** observability table.
  - Migrations: **40 SQL files** in `drizzle/` (`0000_*`–`0040_student_promotions`, with intentional number gaps and two duplicate-numbered pairs `0038_*` / `0039_*`). The newest add the data-health cron-invocations table (`0038_data_health_cron_invocations`), the `admin_users.allowed_pages` RBAC column + progress-tests tables (`0038_cynical_karma`, `0039_overrated_krista_starr`), a LINE link-validation index (`0039_line_link_validation_source_indexes`), and student-promotions (`0040_student_promotions`).
  - Google token vault: `google_oauth_tokens` stores per-email access/refresh tokens **encrypted at rest** with AES-256-GCM (key = SHA-256 of `AUTH_SECRET`).

**File Storage:**
- None — no object storage or file uploads. `xlsx` is used for in-process spreadsheet parsing of sales/projection imports, not persisted file storage.

**Caching:**
- In-memory search index singleton (`__bgscheduler_searchIndex` on `globalThis`, `src/lib/search/index.ts`), rebuilt lazily when the active snapshot or profile version changes.
- Next.js Data Cache: `cacheTag`/`revalidateTag` keyed by tags such as `snapshot` (swept on sync) and `sales-dashboard` (revalidated on Google-token writes, `src/lib/sales-dashboard/google-oauth.ts`).
- Client-side compare cache: `Map<tutorGroupId:weekStart:CACHE_VERSION, CompareTutor>` in browser memory; recent searches in `localStorage`.

## Authentication & Identity

**Auth Provider:**
- Auth.js v5 (`next-auth` 5.0.0-beta.30), Google OAuth only. Core config in `src/lib/auth.ts`, edge-safe config in `src/lib/auth-edge.ts` for middleware.
  - Allowlist: sign-in is denied unless the email exists in the `admin_users` table.
  - **Page-level RBAC (new):** `admin_users.allowed_pages` (nullable) scopes restricted users to specific page prefixes. `src/middleware.ts:25-37` (`isPathAllowed`) matches both the page (`/x`, `/x/...`) and its API namespace (`/api/x`, `/api/x/...`); a `null` value means full access. Restricted users get a 403 on disallowed API calls and a redirect to their landing page on disallowed pages. `/api/home/summary` is always allowed (`:27`). The seed provisions restricted users separately from full admins (e.g. `m.giftwan@gmail.com` scoped to `/progress-tests`, `src/lib/db/seed.ts:46-58`).
  - Google token capture: on sign-in the Google `account` (access/refresh token, scope, expiry) is persisted to `google_oauth_tokens` so the Sheets/leave-requests features can act as that user later.
  - Route handlers: `src/app/api/auth/[...nextauth]/route.ts`.
  - Middleware gate: `src/middleware.ts` uses `edgeAuth` and lets a small public allowlist through without a session — `/login`, `/api/auth/*`, `/api/internal/*`, `/api/search/assistant`, `/api/classrooms/floor-plan-map`, `/api/line/webhook`, and two LINE OA-resolver paths — redirecting everything else to `/login` (`src/middleware.ts:4-15`, `:42-51`).
  - Required env vars: `AUTH_GOOGLE_ID`, `AUTH_GOOGLE_SECRET`, `AUTH_SECRET` (also the encryption key for the Google token vault).

**Allowlist (admin emails):** seeded via `npm run db:seed`, which reads a comma-separated `SEED_ADMIN_EMAILS` into the `admin_users` table (`src/lib/db/seed.ts:31-42`); the script then upserts page-scoped restricted users that are intentionally **not** in `SEED_ADMIN_EMAILS` (`:44-58`). The currently provisioned full admins are:
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
- None — no Sentry/Datadog/Bugsnag. Normalization and sync problems surface through the `data_issues` table (typed + severity-classified) and the Wise-activity reconciliation tables, rendered on the Data Health page.

**Logs:**
- `console.error()` for caught/validation errors plus Vercel platform logs. No structured logging library and no request-logging middleware.

**Health / status surfaces:**
- `GET /api/data-health` — sync status, snapshot stats, issue counts, recent sync history (`src/app/api/data-health/route.ts`).
- **Cron-invocation audit (new):** every registered cron run is wrapped by `withCronInvocationAudit` against a central `cron-registry` (`src/lib/data-health/cron-audit.ts`, `cron-registry.ts`), persisting timing/outcome/error to the `cron_invocations` table. `POST /api/data-health/jobs/{jobKey}/run` manually triggers a registered job. The registry lists all 10 Vercel crons plus `sync-room-utilization` (schedule `null`).
- Per-domain sync-run tables (`sync_runs`, `wise_activity_sync_runs`, sales/credit-control/leave-request/progress-test sync-run tables) provide audit history with single-flight guards.

## CI/CD & Deployment

**Hosting:**
- Vercel (Pro plan). Deploy via `npx vercel --prod` or push to `main`.
  - Production URL: https://bgscheduler.vercel.app
  - Repo: https://github.com/kasheesh711/bgscheduler
  - Serverless function ceilings (`maxDuration`): Wise/Wise-activity/sales/leave-requests/morning-automation/room-utilization/student-promotions sync routes set `800`; credit-control, progress-test sync, progress-test admin-digest, and class-assignment admin-email set `300`; the LINE webhook sets `60`.

**CI Pipeline:**
- No `.github/workflows/` CI config in the repo. Vercel Git integration auto-deploys on `main`. Tests run via npm scripts (`npm test` → Vitest unit project; `npm run test:integration` for `*.integration.test.ts`, which spins up Postgres via Testcontainers). A scope guard `npm run guard:sales-dashboard-scope` is also wired.

**Cron (Vercel Cron, `vercel.json`):** **10** scheduled jobs, all secured by a constant-time `CRON_SECRET` Bearer check (`src/lib/internal/cron-auth.ts`, `timingSafeEqual` after a length pre-check; missing secret → 500, mismatch → 401).
| Path | Schedule (UTC) | maxDuration |
|------|----------------|-------------|
| `/api/internal/sync-wise` | `*/30 * * * *` | 800 |
| `/api/internal/sync-wise-activity` | `5,35 * * * *` | 800 |
| `/api/internal/sync-sales-dashboard` | `10,40 * * * *` | 800 |
| `/api/internal/sync-leave-requests` | `15,45 * * * *` | 800 |
| `/api/internal/sync-credit-control` | `20,50 * * * *` | 300 |
| `/api/internal/sync-progress-tests` | `25,55 * * * *` | 300 |
| `/api/internal/progress-tests/admin-digest` | `35 0 * * *` | 300 |
| `/api/internal/class-assignments/morning` | `45 23 * * *` | 800 |
| `/api/internal/class-assignments/admin-email` | `0,10,20,30 0 * * *` | 300 |
| `/api/internal/student-promotions/july-1` | `5 17 30 6 *` | 800 |

- The five `sync-*` crons are staggered at 5-minute offsets so they never collide on the Wise API or DB in the same minute.
- **Student-promotions** is an annual job: `5 17 30 6 *` fires once a year at 17:05 UTC on June 30 (= July 1 00:05 Asia/Bangkok). The handler hard-gates on the Bangkok date equalling its target and returns **409** on any other day (`src/app/api/internal/student-promotions/july-1/route.ts:27-31`); it carries its own inline constant-time `CRON_SECRET` check rather than the shared helper.
- Not a Vercel cron: `/api/internal/sync-room-utilization` exists (CRON_SECRET-guarded, `maxDuration = 800`) but is **not** in `vercel.json` (registry schedule `null`); it is invoked out-of-band by `npm run room-utilization:sync` (`tsx scripts/sync-room-utilization.ts`).
- `sync-wise` and the sales/credit/progress-test/room routes additionally accept an authenticated admin session (or admin trigger) for manual POSTs; `POST /api/admin/sync-wise` is the admin-session Wise trigger.

## Environment Configuration

**Validated at startup (Zod, `src/lib/env.ts`):** `DATABASE_URL` (URL), `AUTH_GOOGLE_ID`, `AUTH_GOOGLE_SECRET`, `AUTH_SECRET`, `WISE_USER_ID`, `WISE_API_KEY`, `WISE_NAMESPACE` (default `begifted-education`), `WISE_INSTITUTE_ID` (default `696e1f4d90102225641cc413`), `CRON_SECRET`. LINE vars are declared optional here: `LINE_CHANNEL_SECRET`, `LINE_CHANNEL_ACCESS_TOKEN`, `ENABLE_LINE_SCHEDULER`. Invalid/missing required vars throw at module load.

**Read directly via `process.env` (not in the Zod schema)** — grouped by integration:
- AI scheduler: `OPENAI_API_KEY`, `OPENAI_SCHEDULER_MODEL`, `OPENAI_SCHEDULER_SHADOW_MODEL`, `OPENAI_SCHEDULER_REASONING_EFFORT`, `ENABLE_AI_SCHEDULER`
- Progress tests: `OPENAI_PROGRESS_TEST_MODEL`, `WISE_SESSION_CREATE_VERIFIED`
- LINE: `LINE_VALIDATION_LEAD_EMAILS`
- Wise writeback: `WISE_SESSION_OPERATIONS_VERIFIED`
- Google Sheets / dashboards: `SALES_DASHBOARD_CONNECTED_EMAIL`, `LEAVE_REQUESTS_SPREADSHEET_ID`, `LEAVE_REQUESTS_SHEET_NAME`, `LEAVE_REQUESTS_CONNECTED_EMAIL`
- Schedule email (Apps Script): `SCHEDULE_EMAIL_APPS_SCRIPT_URL`, `SCHEDULE_EMAIL_APPS_SCRIPT_SECRET`, `SCHEDULE_EMAIL_BACKUP_APPS_SCRIPT_URL`, `SCHEDULE_EMAIL_BACKUP_APPS_SCRIPT_SECRET`, `SCHEDULE_EMAIL_SENDER_NAME`, `SCHEDULE_EMAIL_REPLY_TO`, `SCHEDULE_EMAIL_PUBLIC_BASE_URL`
- Seeding / base URL: `SEED_ADMIN_EMAILS`, `NEXT_PUBLIC_APP_URL`, `VERCEL_PROJECT_PRODUCTION_URL`, `VERCEL_URL`

**Secrets location:**
- Production: Vercel project environment variables (UI-managed).
- Local: `.env.local` (gitignored). `.env.example` documents the public-facing set but is **incomplete** relative to the code — it omits, among others, `OPENAI_SCHEDULER_SHADOW_MODEL`, `OPENAI_SCHEDULER_REASONING_EFFORT`, `OPENAI_PROGRESS_TEST_MODEL`, `LINE_VALIDATION_LEAD_EMAILS`, `WISE_SESSION_OPERATIONS_VERIFIED`, `WISE_SESSION_CREATE_VERIFIED`, `SALES_DASHBOARD_CONNECTED_EMAIL`, and `SCHEDULE_EMAIL_PUBLIC_BASE_URL`.

## Webhooks & Callbacks

**Incoming:**
- `POST /api/line/webhook` — LINE Messaging webhook. Public route (no session) but HMAC-SHA256 signature-verified against `LINE_CHANNEL_SECRET`; returns 503 when the LINE scheduler is disabled, 401 on bad signature, 400 on bad JSON. Heavy processing is deferred to `after()`.
- `GET /api/internal/*` — Vercel Cron triggers for the 10 scheduled jobs above (Bearer `CRON_SECRET`). The same paths accept manual `POST` (cron secret, or admin trigger on select routes); the student-promotions route additionally enforces a once-a-year Bangkok-date window.
- `GET|POST /api/auth/[...nextauth]` — Auth.js OAuth callbacks for the Google sign-in flow.

**Outgoing:**
- Wise API (`https://api.wiseapp.live`) — pull-heavy ETL plus the guarded session/location/course/registration writes. No Wise webhook subscription; the activity feed is polled.
- LINE API (`https://api.line.me`) — outbound profile fetch + message push.
- OpenAI (`https://api.openai.com/v1/responses`).
- Google — Sheets v4 (`https://sheets.googleapis.com`), OAuth token refresh (`https://oauth2.googleapis.com/token`), and the Apps Script email web app (`https://script.google.com/...`).

## Surface Counts (this snapshot)

- API endpoints: **130** HTTP handlers across the `route.ts` files under `src/app/api/**` (several files export multiple methods).
- Pages: **17** feature pages under `src/app/(app)/**`, plus `/login`; the root `/` renders the Ops Hub (no longer a `/search` redirect).
- Vercel crons: **10** (table above); `sync-room-utilization` is an internal endpoint, not a registered cron.
- DB: **90** tables, 25 enums, 40 migration files.
- Tests: **162** test files (Vitest unit project; integration project covers `*.integration.test.ts` via Testcontainers Postgres).
- Lib modules under `src/lib/`: `ai`, `auth`, `classrooms`, `credit-control`, `data`, `data-health`, `db`, `internal`, `leave-requests`, `line`, `normalization`, `ops`, `payroll`, `progress-tests`, `proposals`, `room-capacity`, `sales-dashboard`, `scheduler`, `search`, `student-promotions`, `sync`, `ui`, `wise`, `wise-activity` (plus `__tests__`).

---

_Verified against HEAD `d4fe6d3` on 2026-06-05._
