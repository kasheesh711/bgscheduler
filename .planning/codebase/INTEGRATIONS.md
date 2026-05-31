# External Integrations

**Analysis Date:** 2026-05-31

BGScheduler talks to six external systems: the **Wise** scheduling/billing platform (the canonical data source), **LINE** Messaging (parent-message ingest + push), **OpenAI** (the AI scheduler parser/assistant), **Google** (OAuth sign-in, Sheets read/write, and an Apps Script email relay), **Neon Postgres** (the only datastore), and **Vercel** (hosting + cron). Every integration is exercised from server code under `src/lib/**` and `src/app/api/**`; there is no client-side third-party SDK. The app is pull/push over plain `fetch` — no third-party SDK wrappers, no message broker, no object storage.

## APIs & External Services

### Wise scheduling platform (primary external data source)
- Service: Wise API at `https://api.wiseapp.live` — source of truth for teachers, sessions, availability, leaves, billing/fees, audit events, locations, and analytics. No production fallback to sheets or files.
  - Tenant / namespace: `begifted-education` (`WISE_NAMESPACE`, default in `src/lib/env.ts:10`)
  - Institute: `696e1f4d90102225641cc413` (`WISE_INSTITUTE_ID`, default in `src/lib/env.ts:11`)
  - Client: hand-rolled HTTP client `WiseClient` at `src/lib/wise/client.ts`; factory `createWiseClient()` (`src/lib/wise/client.ts:159`) builds the production instance with `maxConcurrency: 15`.
  - Auth: Basic Auth (base64 of `WISE_USER_ID:WISE_API_KEY`) plus `x-api-key`, `x-wise-namespace`, and `user-agent: VendorIntegrations/{namespace}` headers (`src/lib/wise/client.ts:52-61`).
  - Auth env vars: `WISE_USER_ID`, `WISE_API_KEY`, `WISE_NAMESPACE`, `WISE_INSTITUTE_ID`.
  - Concurrency: queue-based limiter, default 5, 15 for production sync (`src/lib/wise/client.ts:48`, `:164`).
  - Retry: exponential backoff 1s/2s/4s, max 3 retries (`src/lib/wise/client.ts:49`, `:108`, `:129`). Only `408/429/500/502/503/504` are retried; other 4xx (401/403/404/422) fail fast (`RETRYABLE_STATUS_CODES`, `src/lib/wise/client.ts:23-30`, `:123`). Network-level errors are also retried (`:105-112`).
  - Endpoints used (`src/lib/wise/fetchers.ts`, `src/lib/wise/operations.ts` — full signatures live in [reference/integrations.md](../reference/integrations.md)):
    - `GET /institutes/{instituteId}/teachers` — list teachers
    - `GET /institutes/{instituteId}/teachers/{teacherUserId}/availability?startTime&endTime` — 7-day availability windows, stitched across ~26 windows to cover the 180-day horizon
    - `GET /institutes/{instituteId}/sessions?status=FUTURE&paginateBy=COUNT&page_number&page_size` — paginated future sessions
    - `GET /institutes/{instituteId}/locations` — room/venue catalog
    - `POST /institutes/{instituteId}/checkSessionsAvailability` — room-availability check for class assignment
    - `GET /institutes/{instituteId}/events` — audit/activity event feed, `page_size` clamped to ≤50 (`src/lib/wise/fetchers.ts:238`); date params are not trusted (endpoint ignores them) so the sync walks newest-first
    - `GET /institutes/{instituteId}/fees/transactions` — receipt/fee transactions for credit-control + payroll reconciliation (`src/lib/wise/fetchers.ts:463`)
    - `GET /institutes/{instituteId}/analytics/sessionStats|classroomStats|classroomTrends` and `/trends`, `/fees/...` trends — analytics aggregates
    - `PUT /teacher/classes/{classId}/sessions/{sessionId}?updateType=SINGLE` — the only **write** to Wise (class-assignment location writeback)
  - Writeback safety gate: session writes are disabled unless `WISE_SESSION_OPERATIONS_VERIFIED === "true"` (`src/lib/wise/operations.ts:11`, also read in `src/lib/line/operational.ts:21`). Per policy, only `location` on eligible `OFFLINE` sessions is updated, and only after explicit admin confirmation.
  - Consumers (all server-side, all via `createWiseClient()`): sync orchestrator (`src/lib/sync/orchestrator.ts`, `run-wise-sync.ts`), Wise-activity audit sync + reconciliation (`src/lib/wise-activity/sync.ts`, `reconciliation.ts:739`), credit-control sync (`src/lib/credit-control/run-sync-request.ts:140`), payroll sync (`src/lib/payroll/sync.ts`), classroom morning automation (`src/lib/classrooms/morning-automation.ts:187`), room-capacity utilization (`src/lib/room-capacity/utilization.ts:436`).

### LINE Messaging (parent-chat ingest + push) — `[in-flight]`
- Service: LINE Messaging API at `https://api.line.me` (`src/lib/line/client.ts:3`).
  - Auth: Bearer `LINE_CHANNEL_ACCESS_TOKEN` (`src/lib/line/client.ts:29-33`). Required by `lineAccessToken()`; missing token throws.
  - Inbound webhook signature: HMAC-SHA256 of the raw body keyed by `LINE_CHANNEL_SECRET`, base64-compared with `timingSafeEqual` (`src/lib/line/signature.ts:12-19`). Invalid signature → 401 (`src/lib/line/webhook.ts:24-33`).
  - Endpoints used:
    - `GET /v2/bot/profile/{userId}` — fetch contact display name / picture (`src/lib/line/client.ts:42`); 404 → `null`
    - `POST /v2/bot/message/push` — outbound text push with `X-Line-Retry-Key` idempotency header; HTTP 409 treated as "retry already accepted" (`src/lib/line/client.ts:69-92`)
  - Feature flag: `lineSchedulerEnabled()` requires `ENABLE_LINE_SCHEDULER !== "false"` **and** both `LINE_CHANNEL_SECRET` and `LINE_CHANNEL_ACCESS_TOKEN` present (`src/lib/line/client.ts:19-23`). When off, the webhook route returns 503.
  - Auth env vars: `LINE_CHANNEL_SECRET`, `LINE_CHANNEL_ACCESS_TOKEN` (both optional in `src/lib/env.ts:13-14`), `ENABLE_LINE_SCHEDULER` (`src/lib/env.ts:15`).
  - Other LINE env: `LINE_VALIDATION_LEAD_EMAILS` — comma-separated allowlist of link-validation leads, with a hardcoded default list (`src/lib/line/link-validation.ts:157-163`).
  - Inbound processing: the webhook records the payload, then schedules per-message scheduler classification on the Next.js `after()` hook so the HTTP response returns immediately (`src/app/api/line/webhook/route.ts:21-30`, `maxDuration = 60`).

### OpenAI (AI scheduler parse + conversation)
- Service: OpenAI Responses API at `https://api.openai.com/v1/responses` (`src/lib/ai/scheduler.ts:544`, `src/lib/ai/scheduler-conversation.ts:2346`).
  - Auth: Bearer `OPENAI_API_KEY` (`src/lib/ai/scheduler.ts:539`, `:547`).
  - Feature flag: `isAiSchedulerConfigured()` requires `ENABLE_AI_SCHEDULER !== "false"` and a non-empty `OPENAI_API_KEY` (`src/lib/ai/scheduler.ts:477-480`).
  - Model selection env: `OPENAI_SCHEDULER_MODEL` (default in code), `OPENAI_SCHEDULER_SHADOW_MODEL` (optional shadow eval), `OPENAI_SCHEDULER_REASONING_EFFORT` (one of none/low/medium/high/xhigh) (`src/lib/ai/scheduler.ts:461-475`).
  - Usage shape: structured-output JSON-schema parse (`store: false`, `text.format.type = json_schema`, strict) that converts a pasted parent/admin chat into a single bounded Wise search request; the app, not the model, decides tutor availability (`src/lib/ai/scheduler.ts:550-574`). The conversation flow (`scheduler-conversation.ts`) issues a second `/v1/responses` call for the chat assistant.
  - The model never reaches Wise directly; it only emits search parameters that the in-memory index then resolves.

### Google APIs (three distinct surfaces)
1. **Google OAuth sign-in** — NextAuth Google provider (see *Authentication & Identity*). Tokens captured at sign-in are reused for Sheets.
2. **Google Sheets API v4** — `https://sheets.googleapis.com/v4/spreadsheets/...` (`src/lib/sales-dashboard/sheets.ts:26`, `:44`).
   - Auth: per-user OAuth access token retrieved/refreshed by `getGoogleSheetsAccessToken()` / `getGoogleSheetsWriteAccessToken()` (`src/lib/sales-dashboard/google-oauth.ts:173`, `:200`).
   - Scopes: read `https://www.googleapis.com/auth/spreadsheets.readonly`, write `https://www.googleapis.com/auth/spreadsheets` (`src/lib/sales-dashboard/google-oauth.ts:7-8`).
   - Operations: list sheet titles, read rows (`UNFORMATTED_VALUE` / `SERIAL_NUMBER`), and a single-cell `PUT` writeback for status columns (`src/lib/sales-dashboard/sheets.ts:61-111`).
   - Consumers: Sales Dashboard import (`src/lib/sales-dashboard/**`) and Tutor Leave Requests sync (`src/lib/leave-requests/sync.ts:4`, reads the leave-request form responses sheet, writes the status column back).
   - Token refresh: `POST https://oauth2.googleapis.com/token` with `grant_type=refresh_token` using `AUTH_GOOGLE_ID`/`AUTH_GOOGLE_SECRET` (`src/lib/sales-dashboard/google-oauth.ts:138-147`).
3. **Google Apps Script email relay** — schedule emails are POSTed to a deployed Apps Script web app, not an email SaaS (`src/lib/classrooms/schedule-email.ts:597-633`).
   - Endpoint: `SCHEDULE_EMAIL_APPS_SCRIPT_URL` (primary) and `SCHEDULE_EMAIL_BACKUP_APPS_SCRIPT_URL` (failover) (`src/lib/classrooms/schedule-email.ts:288-304`).
   - Auth: a `secret` field in the JSON body (`SCHEDULE_EMAIL_APPS_SCRIPT_SECRET` / `SCHEDULE_EMAIL_BACKUP_APPS_SCRIPT_SECRET`), not a header.
   - Idempotency: per-recipient `idempotencyKey` derived from run + recipient + content hash (`src/lib/classrooms/schedule-email.ts:648-649`).
   - Quota failover: on a MailApp "daily recipient quota exhausted" error the primary run stops and the backup sender takes over the remaining recipients (`src/lib/classrooms/schedule-email.ts:652-655`, `:898-1024`).
   - Sender metadata env: `SCHEDULE_EMAIL_SENDER_NAME` (default `BeGifted`), `SCHEDULE_EMAIL_REPLY_TO` (`src/lib/classrooms/schedule-email.ts:606-607`).

## Data Storage

**Databases:**
- Neon Postgres (serverless, ap-southeast-1) — the only datastore.
  - Provider: Neon Postgres `ep-calm-mud-a1d7pmsi.ap-southeast-1.aws.neon.tech` (per project docs).
  - Connection: `DATABASE_URL` env var, validated as a URL by Zod (`src/lib/env.ts:4`).
  - Default driver: `@neondatabase/serverless` HTTP-mode `neon()` client wrapped by `drizzle-orm/neon-http` (`src/lib/db/index.ts:1-11`). Exposed as a `globalThis` singleton to survive HMR (`src/lib/db/index.ts:22-27`).
  - Transaction caveat: the neon-http driver cannot run interactive transactions. Payroll sync therefore opens a **direct node-postgres `Pool`** (`pg`) against the same `DATABASE_URL` (`max: 1`) for its transactional writes, detecting the "No transactions support in neon-http driver" error and falling back (`src/lib/payroll/sync.ts:3`, `:90-110`). `pg` is also used by the integration test harness (`src/tests/integration/db-helper.ts`).
  - ORM / migrations: Drizzle ORM with `drizzle-kit`; dialect `postgresql`, schema at `src/lib/db/schema.ts`, output `drizzle/` (`drizzle.config.ts:4-6`).
  - Schema scale: **78 tables** and 21 `pgEnum` types defined in `src/lib/db/schema.ts`. Schema covers tutor snapshots/identity/qualifications/availability/leaves/sessions, data issues, classroom assignment + schedule-email runs, Wise-activity audit + reconciliation, sales dashboard sources/imports/projections, credit-control packages/actions/ownership, LINE contacts/messages/links/scheduler-reviews/OA-resolver, AI-scheduler conversations/metrics, payroll trackers/adjustments/rate-cards, room-capacity model, tutor business profiles/contacts, leave requests, and the Google OAuth token vault.
  - Migrations: **38 SQL migrations** in `drizzle/`, `0000_*` through `0037_*` (latest: `0034_wise_payroll_tracker`, `0035_payroll_invoice_transaction_index`, `0036_tutor_leave_requests`, `0037_payroll_rate_cards`).
  - Google token vault: `google_oauth_tokens` table stores per-email access/refresh tokens **encrypted at rest** with AES-256-GCM, the key derived from a SHA-256 of `AUTH_SECRET` (`src/lib/sales-dashboard/google-oauth.ts:37-68`).

**File Storage:**
- None — no object storage or file uploads. `xlsx` (`package.json`) is used for in-process spreadsheet parsing of imports, not persisted file storage.

**Caching:**
- In-memory search index singleton: module-level `currentIndex` in `src/lib/search/index.ts`, rebuilt lazily when the active snapshot changes.
- Next.js Data Cache: `cacheTag`/`revalidateTag` keyed by tags such as `snapshot` (sync) and `sales-dashboard` (Google token writes call `revalidateTag("sales-dashboard", "max")`, `src/lib/sales-dashboard/google-oauth.ts:130`, `:169`).
- Client-side compare cache: `Map<tutorGroupId:weekStart, CompareTutor>` in browser memory; recent searches in `localStorage` (last 10).

## Authentication & Identity

**Auth Provider:**
- Auth.js v5 (`next-auth` 5.0.0-beta.30), Google OAuth only. Core config is `src/lib/auth.ts` with a separate edge-safe config `src/lib/auth-edge.ts` for middleware.
  - Allowlist: sign-in is denied unless the email exists in the `admin_users` table.
  - Google token capture: on sign-in the Google `account` (access/refresh token, scope, expiry) is persisted to `google_oauth_tokens` via `storeGoogleOAuthTokenForUser()` so the Sheets/leave-requests features can act as that user later (`src/lib/sales-dashboard/google-oauth.ts:87-131`).
  - Route handlers: `src/app/api/auth/[...nextauth]/route.ts`.
  - Middleware gate: `src/middleware.ts` uses `edgeAuth` and lets a small public allowlist through without a session — `/login`, `/api/auth/*`, `/api/internal/*`, `/api/search/assistant`, `/api/classrooms/floor-plan-map`, `/api/line/webhook`, and two LINE OA-resolver paths — redirecting everything else to `/login` (`src/middleware.ts:4-31`).
  - Required env vars: `AUTH_GOOGLE_ID`, `AUTH_GOOGLE_SECRET`, `AUTH_SECRET` (also the encryption key for the Google token vault).

**Allowlist (admin emails):** seeded via `npm run db:seed`, which reads a comma-separated `SEED_ADMIN_EMAILS` and writes the `admin_users` table (`src/lib/db/seed.ts:31`). The list is operational config (env-driven), not hardcoded. The currently provisioned 9 admins are:
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
- None — no Sentry/Datadog/Bugsnag. Normalization and sync problems are surfaced through the `data_issues` table (typed + severity-classified) and the Wise-activity reconciliation tables, then rendered in the Data Health page.

**Logs:**
- `console.error()` for caught/validation errors (e.g. `src/app/api/line/webhook/route.ts:26`), plus Vercel platform logs. No structured logging library and no request-logging middleware.

**Health / status surfaces:**
- `GET /api/data-health` — sync status, snapshot stats, issue counts, recent sync history (`src/app/api/data-health/route.ts`).
- Per-domain sync-run tables (`sync_runs`, `wise_activity_sync_runs`, sales/credit-control/leave-request sync-run tables) provide audit history with single-flight guards.

## CI/CD & Deployment

**Hosting:**
- Vercel (Pro plan). Deploy via `npx vercel --prod` or push to `main`.
  - Production URL: https://bgscheduler.vercel.app
  - Repo: https://github.com/kasheesh711/bgscheduler
  - Serverless function ceilings: most internal sync routes set `maxDuration = 800`; credit-control sync and the class-assignment admin-email route set `maxDuration = 300`; the LINE webhook sets `maxDuration = 60`.

**CI Pipeline:**
- No `.github/workflows/` CI config in the repo. Vercel Git integration auto-deploys on `main`. Tests run via npm scripts (`npm test` → `vitest run --project unit`; `npm run test:integration` for `*.integration.test.ts`, which spins up Postgres via `@testcontainers/postgresql`). A scope guard script `scripts/check-sales-dashboard-scope.mjs` is wired as `npm run guard:sales-dashboard-scope`.

**Cron (Vercel Cron, `vercel.json`):** 7 scheduled jobs, all GET, all secured by a constant-time `CRON_SECRET` Bearer check.
| Path | Schedule (UTC) | maxDuration |
|------|----------------|-------------|
| `/api/internal/sync-wise` | `*/30 * * * *` | 800 |
| `/api/internal/sync-wise-activity` | `5,35 * * * *` | 800 |
| `/api/internal/sync-sales-dashboard` | `10,40 * * * *` | 800 |
| `/api/internal/sync-credit-control` | `20,50 * * * *` | 300 |
| `/api/internal/sync-leave-requests` | `15,45 * * * *` | 800 |
| `/api/internal/class-assignments/morning` | `45 23 * * *` | 800 |
| `/api/internal/class-assignments/admin-email` | `0,10,20,30 0 * * *` | 300 |

- Cron auth: every internal route compares `Authorization: Bearer <CRON_SECRET>` with `timingSafeEqual` after a length pre-check; missing secret → 500, mismatch → 401 (`src/app/api/internal/sync-wise/route.ts:10-28`). `sync-wise` and the sales/credit/room routes additionally accept an authenticated admin session for manual POST triggers.
- Not a Vercel cron: `/api/internal/sync-room-utilization` exists (CRON_SECRET-guarded, `maxDuration = 800`) but is **not** registered in `vercel.json`; it is invoked out-of-band by the `npm run room-utilization:sync` script.

## Environment Configuration

**Validated at startup (Zod, `src/lib/env.ts`):** `DATABASE_URL` (URL), `AUTH_GOOGLE_ID`, `AUTH_GOOGLE_SECRET`, `AUTH_SECRET`, `WISE_USER_ID`, `WISE_API_KEY`, `WISE_NAMESPACE` (default `begifted-education`), `WISE_INSTITUTE_ID` (default `696e1f4d90102225641cc413`), `CRON_SECRET`. LINE vars are declared optional here: `LINE_CHANNEL_SECRET`, `LINE_CHANNEL_ACCESS_TOKEN`, `ENABLE_LINE_SCHEDULER`. Invalid/missing required vars throw at module load.

**Read directly via `process.env` (not in the Zod schema)** — grouped by integration:
- AI scheduler: `OPENAI_API_KEY`, `OPENAI_SCHEDULER_MODEL`, `OPENAI_SCHEDULER_SHADOW_MODEL`, `OPENAI_SCHEDULER_REASONING_EFFORT`, `ENABLE_AI_SCHEDULER`
- LINE: `LINE_VALIDATION_LEAD_EMAILS`
- Wise writeback: `WISE_SESSION_OPERATIONS_VERIFIED`
- Google Sheets / dashboards: `SALES_DASHBOARD_CONNECTED_EMAIL`, `LEAVE_REQUESTS_SPREADSHEET_ID`, `LEAVE_REQUESTS_SHEET_NAME`, `LEAVE_REQUESTS_CONNECTED_EMAIL`
- Schedule email (Apps Script): `SCHEDULE_EMAIL_APPS_SCRIPT_URL`, `SCHEDULE_EMAIL_APPS_SCRIPT_SECRET`, `SCHEDULE_EMAIL_BACKUP_APPS_SCRIPT_URL`, `SCHEDULE_EMAIL_BACKUP_APPS_SCRIPT_SECRET`, `SCHEDULE_EMAIL_SENDER_NAME`, `SCHEDULE_EMAIL_REPLY_TO`, `SCHEDULE_EMAIL_PUBLIC_BASE_URL`
- Seeding / base URL: `SEED_ADMIN_EMAILS`, `NEXT_PUBLIC_APP_URL`, `VERCEL_PROJECT_PRODUCTION_URL`, `VERCEL_URL`

**Secrets location:**
- Production: Vercel project environment variables (UI-managed).
- Local: `.env.local` (gitignored). `.env.example` documents the public-facing set but is **incomplete** relative to the code (e.g. it omits `OPENAI_SCHEDULER_SHADOW_MODEL`, `OPENAI_SCHEDULER_REASONING_EFFORT`, `LINE_VALIDATION_LEAD_EMAILS`, `WISE_SESSION_OPERATIONS_VERIFIED`, `SALES_DASHBOARD_CONNECTED_EMAIL`, `SCHEDULE_EMAIL_PUBLIC_BASE_URL`).

## Webhooks & Callbacks

**Incoming:**
- `POST /api/line/webhook` — LINE Messaging webhook. Public route (no session) but HMAC-SHA256 signature-verified against `LINE_CHANNEL_SECRET`; returns 503 when the LINE scheduler is disabled, 401 on bad signature, 400 on bad JSON. Heavy processing is deferred to `after()` (`src/app/api/line/webhook/route.ts`).
- `GET /api/internal/*` — Vercel Cron triggers for the 7 scheduled jobs above (Bearer `CRON_SECRET`). The same paths accept manual `POST` (cron secret, or admin session on select routes).
- `GET|POST /api/auth/[...nextauth]` — Auth.js OAuth callbacks for the Google sign-in flow.

**Outgoing:**
- Wise API (`https://api.wiseapp.live`) — pull-heavy ETL plus the single guarded session `PUT` writeback. No Wise webhook subscription; the activity feed is polled.
- LINE API (`https://api.line.me`) — outbound profile fetch + message push.
- OpenAI (`https://api.openai.com/v1/responses`).
- Google — Sheets v4 (`https://sheets.googleapis.com`), OAuth token refresh (`https://oauth2.googleapis.com/token`), and the Apps Script email web app (`https://script.google.com/...`).

## Surface Counts (this snapshot)

- API endpoints: **110** exported HTTP handlers across 96 `route.ts` files (several files export multiple methods).
- Pages: **14** feature pages under `src/app/(app)/**`, plus `/login` and the root `/` redirect.
- Vercel crons: **7** (table above); `sync-room-utilization` is an internal endpoint, not a registered cron.
- DB: **78** tables, 21 enums, 38 migrations.
- Tests: **130** test files (Vitest unit project; integration project covers `*.integration.test.ts` via Testcontainers Postgres).

---

_Verified against HEAD + uncommitted WIP on 2026-05-31._
