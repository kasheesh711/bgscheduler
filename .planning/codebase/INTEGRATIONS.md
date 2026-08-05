# External Integrations

**Analysis Date:** 2026-05-31

BGScheduler talks to eight external systems: the **Wise** scheduling/billing platform (the canonical data source), **LINE** Messaging (parent-chat ingest, contact resolution, and the schedule bot's DM + group paths), **OpenAI** (eight call sites across seven modules), **Google** (OAuth sign-in, Sheets v4 read/write, a Drive v3 upload used only by a verification script, and a deployed Apps Script email relay), **Resend** (admissions transactional email), **Apify** + **DataForSEO** (competitor-intelligence scraping and SERP), **Neon Postgres** (the only datastore), and **Vercel** (hosting, cron, GitHub Actions CI alongside it). Every integration is exercised from server code under `src/lib/**` and `src/app/api/**` — there is no client-side third-party SDK, no message broker, and no object storage of our own. Only one vendor library is used at all (`@neondatabase/serverless` / `pg`); every other integration is hand-rolled over plain `fetch`.

## APIs & External Services

### Wise scheduling platform (primary external data source)

- Service: Wise API at `https://api.wiseapp.live` (`src/lib/wise/client.ts:47`) — source of truth for teachers, sessions, availability, leaves, students, classes, courses, fees/receipts, audit events, locations, and analytics. No production fallback to sheets or files.
  - Tenant / namespace: `begifted-education` (`WISE_NAMESPACE`, defaulted in `src/lib/env.ts:10`).
  - Institute: `696e1f4d90102225641cc413` (`WISE_INSTITUTE_ID`, defaulted in `src/lib/env.ts:11`).
  - Client: hand-rolled `WiseClient` class (`src/lib/wise/client.ts`). `createWiseClient()` (`:159`) is the shared production factory and raises concurrency to 15 (`:164`).
  - Auth: Basic Auth (base64 `WISE_USER_ID:WISE_API_KEY`) plus `x-api-key`, `x-wise-namespace`, and `user-agent: VendorIntegrations/{namespace}` headers (`src/lib/wise/client.ts:53-59`). Fee/receipt and payout-trend reads add `x-wise-timezone: Asia/Bangkok` + `x-wise-platform: web` per-call (`src/lib/wise/fetchers.ts:576-580`, `:743-746`).
  - Auth env vars: `WISE_USER_ID`, `WISE_API_KEY`, `WISE_NAMESPACE`, `WISE_INSTITUTE_ID`.
  - Concurrency: in-process queue limiter, default 5 (`client.ts:48`); 15 in `createWiseClient()`, 6 in the student-promotions client (`src/lib/student-promotions/data.ts:305`), default 5 in the classroom-publish client (`src/lib/classrooms/data.ts:1151-1158`).
  - Retry: exponential backoff 1s/2s/4s, max 3 retries (`client.ts:49`, `:106-107`, `:127-128`). Only `408/429/500/502/503/504` are retried; permanent 4xx (401/403/404/422) fail fast (`RETRYABLE_STATUS_CODES`, `:23-30`, REL-05). Network-level failures (DNS/ECONNRESET/fetch TypeError) are also retried (`:105-112`).
  - Read endpoints (`src/lib/wise/fetchers.ts` — request/response signatures live in [reference/api](../../docs/reference/api/index.md)):
    - `GET /institutes/{id}/teachers` (`:35`)
    - `GET /institutes/{id}/teachers/{teacherUserId}/availability?startTime&endTime` (`:49`) — 7-day windows; `fetchTeacherFullAvailability` stitches 26 of them for the 180-day leave horizon (`:63-70`)
    - `GET /institutes/{id}/sessions` — future/paginated by count (`:134`, `PAGE_LIMIT = 1000` at `:24`) and past sessions paginated by Bangkok calendar date (`:162`)
    - `GET /user/classes/{classId}/sessions/{sessionId}` (`:192`) — canonical session detail for post-class feedback, strictly read-only
    - `GET /institutes/{id}/locations` (`:213`)
    - `GET /institutes/v3/{id}/students` (`:277`), `GET /institutes/{id}/participants/{studentId}?showRegistrationData=true` (`:301`)
    - `GET /user/v2/classes/{classId}?full=true` (`:324`), `GET /user/classes/{classId}/participants?showCoTeachers=true` (`:343`)
    - `GET /institutes/{id}/events` (`:512`) — audit feed; `page_size` clamped to ≤50 (`:505`) and the sync walks newest-first because the endpoint's date params are not trusted
    - `GET /institutes/{id}/analytics/sessionStats|classroomStats|classroomTrends` (`:528`, `:539`, `:549`) and `GET /institutes/{id}/trends` (`:571`)
    - `GET /institutes/{id}/fees/transactions` (`:729`) — receipts for credit-control + payroll, 50/page up to 200 pages (`:25-26`)
  - Write endpoints — six mutation-shaped calls, each with its own gate:

    | Write | Fetcher | Caller + gate |
    |---|---|---|
    | `PUT /teacher/classes/{classId}/sessions/{sessionId}?updateType=SINGLE` (location) | `updateSessionLocation` (`fetchers.ts:410`) | Classroom publish only, per-run opt-in; refuses to run when the Wise location catalog reads empty (`src/lib/classrooms/data.ts:1414-1416`, `:1442`, `:1687`) |
    | `PUT /teacher/classes/{classId}/sessions/{sessionId}?updateType=SINGLE` (subject) | `updateSessionSubject` (`fetchers.ts:426`) | Student promotions; throws unless `WISE_SESSION_SUBJECT_UPDATE_VERIFIED === "true"` (`src/lib/student-promotions/data.ts:449-450`, `:2411-2413`) |
    | `PUT /teacher/editClass` (course subject) | `updateWiseCourseSubject` (`fetchers.ts:331`) | Student promotions, applied only after a verified run; rate-gated, roster-drift checked (`data.ts:2213`) |
    | `PUT /institutes/{id}/students/{studentId}/registration` (grade answers) | `updateWiseStudentRegistrationAnswers` (`fetchers.ts:308`) | Student promotions; skipped on `already_target` / `grade_drift` before any call (`data.ts:2102-2129`) |
    | `POST /teacher/classes/{classId}/sessions` (create session) | `scheduleWiseSession` (`fetchers.ts:460`) | Progress-test booking; requires `WISE_SESSION_CREATE_VERIFIED === "true"` (`src/lib/progress-tests/config.ts:47-50`) |
    | `POST /institutes/{id}/checkSessionsAvailability` | `checkTeacherAvailabilityForSessions` (`fetchers.ts:394`) | No gate — read-shaped pre-check run before every progress-test create (`src/lib/progress-tests/booking.ts:263`) |

    Separately, `WISE_SESSION_OPERATIONS_VERIFIED` gates the LINE cancel/reschedule confirm path (`src/lib/wise/operations.ts:10-12`). That path is **dry-run on both sides of the gate**: unset writes a `manual_required` log row, set writes a `dry_run` row, and no Wise mutation is ever sent because the cancel/move request shape is still unverified (`operations.ts:49-88`). Leave requests likewise record `dryRun: true` rather than cancelling in Wise (`src/lib/leave-requests/data.ts:658`).
  - Consumers of the shared `createWiseClient()`: nine lib modules — `sync/run-wise-sync.ts`, `wise-activity/reconciliation.ts`, `credit-control/run-sync-request.ts`, `classrooms/morning-automation.ts`, `room-capacity/utilization.ts`, `post-class-feedback/sync.ts`, `progress-tests/booking.ts`, `progress-tests/run-sync-request.ts`, `data-health/run-job.ts` — plus four route handlers that construct it inline (`api/internal/sync-wise-activity`, `api/wise-activity/sync`, `api/wise-activity/reconciliation/backfill`, `api/payroll/sync`). Two modules build their own client with different concurrency (`classrooms/data.ts:1151`, `student-promotions/data.ts:298`), and payroll sync takes an injected `WiseClient` (`src/lib/payroll/sync.ts:6`). All server-side; nothing on the search request path queries Wise directly.
  - Deep links only (no API): the UI links out to `https://app.wise.live/classes/{classId}/sessions/{sessionId}` (`src/lib/post-class-feedback/dashboard.ts:115`, `src/lib/post-class-feedback/notifications.ts:250`).

### LINE Messaging (parent-chat ingest, contact resolution, schedule bot)

- Service: LINE Messaging API at `https://api.line.me` (`src/lib/line/client.ts:3`).
  - Auth: Bearer `LINE_CHANNEL_ACCESS_TOKEN`; `lineAccessToken()` throws when unset (`client.ts:29-33`).
  - Inbound webhook signature: HMAC-SHA256 of the raw body keyed by `LINE_CHANNEL_SECRET`, base64-compared with `timingSafeEqual` after a length pre-check (`src/lib/line/signature.ts:12-19`).
  - Endpoints used:
    - `GET /v2/bot/profile/{userId}` (`client.ts:42`) — 404 → `null`; batched at concurrency 5 by `fetchLineProfilesBatched` (`:95-110`)
    - `GET /v2/bot/followers/ids?limit=300` (`:68-71`) — cursor-paged follower enumeration for the OA resolver
    - `POST /v2/bot/message/push` (`:118`) — outbound push carrying an `X-Line-Retry-Key` idempotency header; HTTP 409 is treated as "retry already accepted" and annotated with `x-line-accepted-request-id` (`:132-141`)
    - `POST /v2/bot/message/reply` (`:166`) — reply-token reply used by the group path; consumes no message quota, token valid ~1 minute, failures throw so the caller can deliberately fall back to a push (`:151-161`)
  - Feature flag: `lineSchedulerEnabled()` requires `ENABLE_LINE_SCHEDULER !== "false"` **and** both `LINE_CHANNEL_SECRET` and `LINE_CHANNEL_ACCESS_TOKEN` present (`client.ts:19-23`). When off the webhook returns 503 (`src/app/api/line/webhook/route.ts:11-13`).
  - Inbound processing: the route records the payload synchronously, then defers scheduler classification **and** group-command handling to Next's `after()` so the HTTP response returns immediately (`webhook/route.ts:22-39`, `maxDuration = 60`).
  - **Schedule bot — DM path** (an admin DMs a student code; the bot pushes that child's monthly schedule link to the verified parent) fails closed at four independent gates: sender allowlist `LINE_SCHEDULE_BOT_ADMIN_IDS`, verified-link-only recipient resolution, an explicit YES confirm with a 5-minute pending TTL, and a non-empty-month check (`src/lib/line/schedule-bot.ts:1-27`, `:76`, SCHED-BOT-01…04). An empty or unset allowlist disables the bot entirely (`:109-123`). The router runs before the OpenAI classifier so an admin command never costs a model call.
  - **Schedule bot — group path** (an admin @-mentions the OA inside a family group; the bot replies into that group) re-weights the gates for a group destination: self-mention required, sender allowlist, exact nickname-code match only, confirm-on-first-sight per group, non-empty month (`src/lib/line/schedule-bot-group.ts:1-35`, GRP-BOT-01…05). The verified-student-link gate is deliberately dropped here because the destination is the group everyone is already in.
  - Auth env vars: `LINE_CHANNEL_SECRET`, `LINE_CHANNEL_ACCESS_TOKEN`, `ENABLE_LINE_SCHEDULER`, `LINE_SCHEDULE_BOT_ADMIN_IDS` (all optional in `src/lib/env.ts:13-19`).
  - Other LINE env: `LINE_VALIDATION_LEAD_EMAILS` — comma-separated link-validation lead allowlist that falls back to a hardcoded two-address default (`src/lib/line/link-validation.ts:122-125`, `:221-229`).
  - Non-API surface: staff chat deep links are validated to be `https://chat.line.biz` over HTTPS only (`src/lib/line/oa-resolver.ts:352`, `src/lib/leave-requests/data.ts:99`).

### OpenAI (eight call sites, all the Responses API)

- Service: `https://api.openai.com/v1/responses`, called directly over `fetch` — no vendor SDK.
  - Auth: Bearer `OPENAI_API_KEY` at every call site.
  - Call sites and their model env var:

    | Call site | File | Model env (fallback) |
    |---|---|---|
    | AI scheduler parse | `src/lib/ai/scheduler.ts:544` | `OPENAI_SCHEDULER_MODEL` (`:461-462`), shadow `OPENAI_SCHEDULER_SHADOW_MODEL` (`:466`) |
    | AI scheduler conversation | `src/lib/ai/scheduler-conversation.ts:2346` | same as above |
    | LINE message classifier | `src/lib/line/classifier.ts:98` | reuses `aiSchedulerModel()` (`:105`) |
    | LINE contact-alias matching | `src/lib/line/contact-aliases.ts:368` | reuses `aiSchedulerModel()` (`:375`) |
    | Progress-test AI summary | `src/lib/progress-tests/ai-summary.ts:185` | `OPENAI_PROGRESS_TEST_MODEL` → scheduler default (`:88`) |
    | Post-class feedback review | `src/lib/post-class-feedback/ai.ts:62` | `OPENAI_POST_CLASS_FEEDBACK_MODEL` → `gpt-5.4-mini` (`:297`) |
    | Competitor-intelligence digest (2 calls) | `src/lib/competitor-intelligence/ai.ts:161`, `:300` | `OPENAI_COMPETITOR_INTEL_MODEL` → `OPENAI_SCHEDULER_MODEL` → default (`:65-67`) |

  - Feature flags: `isAiSchedulerConfigured()` requires `ENABLE_AI_SCHEDULER !== "false"` plus a non-empty `OPENAI_API_KEY` (`src/lib/ai/scheduler.ts:477-480`); the progress-test summary mirrors that gate (`ai-summary.ts:70`); competitor AI has its own `ENABLE_COMPETITOR_AI !== "false"` (`competitor-intelligence/ai.ts:71`). Post-class feedback degrades to a `"deterministic-only"` model label rather than failing (`post-class-feedback/ai.ts:282`).
  - Reasoning effort: `OPENAI_SCHEDULER_REASONING_EFFORT` (`scheduler.ts:470`).
  - Usage shape: strict JSON-schema structured output with `store: false` (`scheduler.ts:551-553`). The model never reaches Wise — it only emits search parameters that the in-memory index resolves, so availability is decided by the app.

### Google (four distinct surfaces)

1. **Google OAuth sign-in** — Auth.js Google provider (see *Authentication & Identity*). Tokens captured at sign-in are the credential for every other Google surface below.
2. **Google Sheets API v4** — `https://sheets.googleapis.com/v4/spreadsheets/...` (`src/lib/sales-dashboard/sheets.ts:58`, `:76`, `:99`).
   - Auth: per-user OAuth access token from `getGoogleSheetsAccessToken()` / `getGoogleSheetsWriteAccessToken()` (`src/lib/sales-dashboard/google-oauth.ts:181`, `:208`), refreshed via `POST https://oauth2.googleapis.com/token` with `grant_type=refresh_token` and `AUTH_GOOGLE_ID`/`AUTH_GOOGLE_SECRET` (`:146-154`). A refresh failure records `lastError` on the token row before throwing (`:158-162`).
   - Scopes: `spreadsheets.readonly` / `spreadsheets`, checked per operation (`google-oauth.ts:7-8`, `:82-89`).
   - Operations exported (`sheets.ts:116-451`): list sheet titles and properties, read rows/ranges/grid metadata, single-cell update, range and batch value updates, spreadsheet `batchUpdate`, row insert, row-value update, and `appendGoogleSheetRows`.
   - Consumers: Sales Dashboard import, Tutor Leave Requests sync (reads form responses, writes status column `S` — `src/lib/leave-requests/config.ts:10`, `src/lib/leave-requests/data.ts:551-555`), and Post-Class Feedback payout publishing, which appends one deduction row at a time into the master workbook rather than batching, so every outcome has an unambiguous row number (`src/lib/post-class-feedback/payout-writer.ts:118-128`, `:169-185`).
3. **Google Drive API v3 (upload only, script-only today)** — `https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&supportsAllDrives=true` (`src/lib/post-class-feedback/drive.ts:65-68`). The only Drive contact in the codebase, and its sole caller is the one-off verification script `scripts/verify-drive-upload.ts:38`; no request-path or cron code uploads to Drive.
   - Scope: `drive.file` (per-file), deliberately not the restricted full `drive` scope, which would require Google verification plus an annual security assessment (`google-oauth.ts:9-12`).
   - Error mapping is explicit: an "API not enabled" message is reported as a Cloud-project setting, a 404 as "the connected account cannot see the folder" (`drive.ts:79-92`).
4. **Google Apps Script email relay** — schedule emails, leave-request notices, progress-test digests and cron-watchdog alerts are POSTed to a deployed Apps Script web app, not an email SaaS (`src/lib/classrooms/schedule-email.ts:597-635`).
   - Endpoints: `SCHEDULE_EMAIL_APPS_SCRIPT_URL` (primary) and `SCHEDULE_EMAIL_BACKUP_APPS_SCRIPT_URL` (failover) (`:288-303`).
   - Auth: a `secret` field inside the JSON body (`SCHEDULE_EMAIL_APPS_SCRIPT_SECRET` / `..._BACKUP_...`), not a header (`:614`).
   - Idempotency: per-recipient key `classroom-schedule:{runId}:{canonicalKey}:{contentHash}`, truncated to 256 chars (`:648-650`).
   - Quota failover: on a MailApp "daily recipient quota is exhausted" error the primary sender stops and the backup takes the remaining recipients (`:653-656`).
   - Sender metadata: `SCHEDULE_EMAIL_SENDER_NAME` (default `BeGifted`), `SCHEDULE_EMAIL_REPLY_TO` (`:606-607`).
   - Reused as a generic sender: `createAppsScriptScheduleEmailSender()` is imported by the cron watchdog (`src/lib/internal/cron-watchdog.ts:22-25`).

### Resend (admissions transactional email)

- Service: `POST https://api.resend.com/emails` (`src/lib/admissions/notifications.ts:43`, `:304`), the only Resend call site.
  - Auth: Bearer `RESEND_API_KEY`; a missing key throws (`:299-300`).
  - Sender overrides: `ADMISSIONS_EMAIL_FROM` (fallback `BeGifted Admissions <onboarding@resend.dev>`, `:46`), `ADMISSIONS_EMAIL_REPLY_TO` (fallback mirrors the schedule-email default, `:49`).
  - Every send is recorded with its Resend email id and a dedupe key in `admissions_notification_log` (`:325-339`); a per-recipient daily interrupt cap of 3 collapses excess notifications (`:55`), and deadline reminders fire at T-7d and T-48h (`:58`).
  - Driven by the `admissions-notifications` cron (below).

### Apify + DataForSEO (competitor intelligence)

- **Apify** — `POST https://api.apify.com/v2/acts/{actor}/run-sync-get-dataset-items?token=…` with a 60s timeout (`src/lib/competitor-intelligence/providers.ts:70-83`).
  - Auth: `APIFY_API_TOKEN` in the query string; when unset the fetch is skipped with `skippedReason: "APIFY_API_TOKEN is not configured"` rather than failing the run (`:71-73`, `:92-100`).
  - Actors: `APIFY_INSTAGRAM_ACTOR` (default `apify/instagram-scraper`) and `APIFY_FACEBOOK_ACTOR` (default `apify/facebook-posts-scraper`) (`:17-18`).
- **DataForSEO** — `POST https://api.dataforseo.com/v3/serp/google/organic/live/regular` (`:144`), Basic Auth from `DATAFORSEO_LOGIN`/`DATAFORSEO_PASSWORD`; unset → skipped, not failed (`:128-140`). Bangkok queries are rewritten to the `Bangkok,Bangkok,Thailand` location name (`:19`, `:29-33`).
- **Plain website fetch** — competitor sites are fetched directly with a 10s timeout and a `BGSchedulerCompetitorIntelligence/1.0` user agent (`:16`, `:35-50`).
- Cost control: each provider result carries an `estimatedCostUsd` (`COMPETITOR_APIFY_COST_PER_ITEM_USD` default 0.01, `COMPETITOR_DATAFORSEO_COST_PER_QUERY_USD` default 0.002) and a monthly hard cap resolved per provider from `COMPETITOR_{PROVIDER}_MONTHLY_CAP_USD` → `COMPETITOR_INTEL_MONTHLY_CAP_USD` → 250 USD, with website/manual sources capped at 0 (`src/lib/competitor-intelligence/budget.ts:18-24`). A source whose estimate would exceed the cap is marked skipped *before* the vendor call — separately for scraped sources and SERP keywords (`sync.ts:556-565`, `:646-651`).

### Non-runtime data ingest (for completeness)

The US-universities catalog is loaded from a 591 MB IPEDS Microsoft Access file converted to CSV **locally** with `mdbtools` and imported into Postgres by `scripts/ipeds-import.ts`. There is no runtime IPEDS integration — the app only ever reads Postgres (`scripts/ipeds-convert.sh:1-12`).

## Data Storage

**Databases:**
- Neon Postgres (serverless, ap-southeast-1) — the only datastore.
  - Connection: `DATABASE_URL`, validated as a URL by Zod (`src/lib/env.ts:4`).
  - Default driver: `@neondatabase/serverless` HTTP-mode `neon()` wrapped by `drizzle-orm/neon-http` (`src/lib/db/index.ts:1-12`), exposed as a `globalThis` singleton so it survives HMR (`:16-27`).
  - Transaction caveat: neon-http cannot run interactive transactions. Three call sites detect the literal `"No transactions support in neon-http driver"` error and fall back to a `pg` `Pool({ max: 1 })` against the same `DATABASE_URL` — payroll sync (`src/lib/payroll/sync.ts:89-110`), post-class feedback writes (`src/lib/post-class-feedback/transaction.ts:11-40`), and admissions audit, which additionally imports `pg` lazily so the module stays importable from client-component graphs (`src/lib/admissions/audit.ts:41-56`). `pg` also backs the integration-test harness (`src/tests/integration/db-helper.ts:5`, `:33`).
  - ORM / migrations: Drizzle ORM with `drizzle-kit`; dialect `postgresql`, schema `src/lib/db/schema.ts`, output `drizzle/`.
  - Schema scale: **188 tables** and **61 `pgEnum` types**. Domains: tutor snapshots/identity/qualifications/availability/leaves/sessions, data issues, classroom assignment + schedule email, Wise-activity audit, sales dashboard, credit control, payroll, LINE (contacts/threads/messages/links/reviews/OA-resolver/group settings), AI scheduler, proposals, room capacity, tutor profiles, leave requests, admissions case management, US universities (IPEDS), progress tests, post-class feedback + payout runs, student promotions, student schedule links, learning plans, syllabus, competitor intelligence, cron alert state, and the Google OAuth token vault.
  - Migrations: **65 SQL migrations** in `drizzle/`, `0000_*` through `0064_line_group_settings`.
  - Google token vault: `google_oauth_tokens` stores per-email access/refresh tokens encrypted at rest with AES-256-GCM, key = SHA-256 of `AUTH_SECRET` (`src/lib/sales-dashboard/google-oauth.ts:40-76`). Missing `AUTH_SECRET` throws rather than storing plaintext.

**File Storage:**
- No object storage of our own. The only file egress path in the codebase is the Drive CSV upload, and today it is reachable only from `scripts/verify-drive-upload.ts`. `xlsx` is used for in-process parsing of sales/projection imports, never for persistence.

**Caching:**
- In-memory search index singleton anchored on `globalThis.__bgscheduler_searchIndex`, with a build-promise coalescer `__bgscheduler_searchIndexBuildPromise` against thundering herds (`src/lib/search/index.ts:92-113`). Rebuilt when the active snapshot id changes.
- Next.js Data Cache via `"use cache"` + `cacheTag`/`revalidateTag` across seven modules: `snapshot` (`src/lib/data/tutors.ts:82`, `src/lib/data/filters.ts:54`; swept by `run-wise-sync.ts:161` after a successful promote), `past-sessions` (deliberately NOT swept with `snapshot` — `src/lib/data/past-sessions.ts:11`, `:88`), `sales-dashboard` (also swept on Google token writes, `google-oauth.ts:138`, `:177`), `credit-control`, `progress-tests`, and `us-universities` (`src/lib/us-universities/data.ts:35`). Two admissions pages are `"use cache"` as well.
- Client-side compare cache: `Map<"tutorGroupId:weekStart:CACHE_VERSION", CompareTutor>` in browser memory; recent searches in `localStorage`.

## Authentication & Identity

**Auth Provider:**
- Auth.js v5 (`next-auth` 5.0.0-beta.30), Google OAuth only. Node config `src/lib/auth.ts`; edge-safe config `src/lib/auth-edge.ts` backs middleware.
  - Scopes differ by runtime: the Node provider requests `openid email profile https://www.googleapis.com/auth/spreadsheets https://www.googleapis.com/auth/drive.file` with `access_type: offline` (`src/lib/auth.ts:37-42`); the edge provider declares only `spreadsheets.readonly` (`src/lib/auth-edge.ts:11`) since it never mints tokens and does no DB work (`:22-26`).
  - Sign-in gate is **role resolution, not a flat allowlist** (`src/lib/auth-access.ts:1-18`; order admin → counselor → teacher → case member, first match wins): `admin` from `admin_users` (the row carries `allowedPages`; `null` = full access), `counselor` from an active `admissions_counselors` row (restricted to `/admissions`), `teacher` when the email matches an active tutor contact (restricted to `/progress-tests`), and `student`/`parent` from an active `admissions_case_members` membership. No match → sign-in denied (fail-closed).
  - Admissions invite activation runs *before* access resolution so a freshly invited member passes the active-only membership filter on their first sign-in; failures are logged and never unblock a denied user (`src/lib/auth.ts:16-29`).
  - Google token capture: on a successful sign-in the account's access/refresh token, scope and expiry are persisted (encrypted) via `storeGoogleOAuthTokenForUser()` so Sheets/leave-request/payout features can act as that user later (`src/lib/auth.ts:50-57`).
  - Route handlers: `src/app/api/auth/[...nextauth]/route.ts`.
  - Required env vars: `AUTH_GOOGLE_ID`, `AUTH_GOOGLE_SECRET`, `AUTH_SECRET` (also the Google-token encryption key).

**Middleware gate** (`src/middleware.ts`): a public allowlist passes through without a session — `/login`, `/api/auth/*`, `/api/search/assistant`, `/api/classrooms/floor-plan-map`, `/api/line/webhook`, `/schedule/*` (note the trailing slash — it keeps the authenticated `/student-schedule` admin page out), the two LINE OA-resolver paths, and `/api/internal/*` (`:4-20`). Everything else redirects to `/login`. Signed-in but page-restricted users are then matched against `allowedPages` both as a page prefix and as its `/api` namespace, with carve-outs where a fresher DB grant supersedes the JWT claim (post-class feedback, learning-plan pages — but explicitly *not* the learning-plans API namespace) (`:30-61`).

Middleware allowlisting is not the same as being unauthenticated. `POST /api/search/assistant` is allowlisted in middleware yet still calls `auth()` and returns 401 without a session (`src/app/api/search/assistant/route.ts:135-139`); the OA-resolver worklist requires its own bearer resolver token and answers 401 otherwise, with permissive CORS for the browser extension that consumes it (`src/app/api/line/contacts/oa-resolver/worklist/route.ts:5-32`). Only `GET /api/classrooms/floor-plan-map` is genuinely open — it renders an SVG from query params with no data access (`src/app/api/classrooms/floor-plan-map/route.ts:3-16`).

**Capability-token access (no session):** the parent monthly-schedule page `/schedule/{token}` is reached from a LINE message, so the token *is* the credential (`src/lib/student-schedule/links.ts:1-14`). Tokens are 32 random bytes base64url-encoded, stored only as a SHA-256 hash and compared in constant time, scoped to exactly one `(studentKey, monthKey)`, and expire after `STUDENT_SCHEDULE_LINK_TTL_DAYS` (default 30 — `:24-27`, `:39`, `:92-93`). Expired, revoked, unknown and malformed tokens all resolve to `null` so the page cannot be used as an existence oracle.

**Seeding:** `npm run db:seed` reads a comma-separated `SEED_ADMIN_EMAILS` and upserts `admin_users` (`src/lib/db/seed.ts:31-43`), then upserts a small set of deliberately page-restricted accounts that are intentionally NOT in `SEED_ADMIN_EMAILS` (`:46-59`). The provisioned admin list is operational config, not source.

## Monitoring & Observability

**Error Tracking:**
- None — no Sentry/Datadog/Bugsnag/OpenTelemetry dependency. Failures surface through domain tables instead: `data_issues` (typed + severity-classified normalization problems), per-domain `*_sync_runs` rows, the Wise-activity reconciliation tables, and `cron_alert_state`.

**Logs:**
- Bare `console.error` (53 call sites under `src/lib`) plus Vercel platform logs. No structured logging library, no request-logging middleware. Fire-and-forget boundaries (the `after()` handlers in the LINE webhook) log rather than throw (`src/app/api/line/webhook/route.ts:26-28`, `:35-37`).

**Health / status surfaces:**
- `GET /api/data-health` — sync status, snapshot stats, issue counts, recent history.
- `POST /api/data-health/jobs/{jobKey}/run` — authenticated manual trigger for any registered cron job; post-class jobs additionally require the `access_manager` capability, and jobs flagged `dangerous` require `confirmed: true` in the body or return 409 (`src/app/api/data-health/jobs/[jobKey]/run/route.ts:13-43`).
- **Cron watchdog** (`src/lib/internal/cron-watchdog.ts`) — sweeps every registered cron every 30 minutes using the same health derivation as `/data-health` and emails admins through the Apps Script relay. Episode-based dedup (one alert per job per failure episode) persisted in `cron_alert_state` (`:1-17`); a sentinel `__watchdog_sweep_lock` row acts as the single-flight lock because neon-http supports neither transactions nor session advisory locks (`:41-50`). Alert state is only written after at least one recipient accepted, so a failed delivery retries next sweep; partial delivery is a documented tradeoff (`:11-17`).
- Staleness thresholds: API warning at 90 minutes, app-wide banner at 2 hours (`src/lib/ops/stale.ts:1-8`) — staleness is a warning, never withheld data.

## CI/CD & Deployment

**Hosting:**
- Vercel (Pro plan). Production URL https://bgscheduler.vercel.app; repo https://github.com/kasheesh711/bgscheduler.
- Deploy by pushing to `main` (Vercel Git integration). The guarded manual path is `npm run deploy:prod` → `verify:release` (typecheck → unit tests → build → typecheck → `git diff --check` → `guard:production-route-surface`) → `scripts/assert-production-deploy-ready.mjs` (refuses a non-`main` branch — override via `PRODUCTION_BRANCH` — a dirty tree, or `HEAD != origin/main`) → `npx vercel --prod`. A bare `vercel --prod` from an unlinked worktree creates a stray project.
- Function ceilings are set per route via `export const maxDuration`, never in `vercel.json`: 800s on the heavy sync/automation/payout routes, 300s on the digest/watchdog/admin-email/backlog routes, 60s on the LINE webhook, 800s on the Data Health manual job runner.

**CI Pipeline:**
- **GitHub Actions, two workflows.** `.github/workflows/ci.yml` runs on PRs to `main` and pushes to `main` with five parallel jobs — `lint`, `typecheck`, `unit-tests` (`npm test`), `build` (+ a second typecheck), and `release-guards` (`guard:production-route-surface` plus a `git diff --check` whitespace gate). It injects dummy Wise/Auth/DB env vars and forces `ENABLE_AI_SCHEDULER=false`, `ENABLE_LINE_SCHEDULER=false`, `TZ=Asia/Bangkok`, so CI never touches a vendor. `.github/workflows/sales-dashboard-scope.yml` pipes the PR's changed-file list through `scripts/check-sales-dashboard-scope.mjs` with the PR author as `--actor`.
- Integration tests are **not** in CI: `npm run test:integration` runs the `*.integration.test.ts` project against Testcontainers Postgres locally (or an external instance via `TEST_DATABASE_URL`).

**Cron (Vercel Cron, `vercel.json`):** 15 registered jobs, all invoked as GET, all guarded by a constant-time `CRON_SECRET` Bearer check.

| Path | Schedule (UTC) | maxDuration |
|------|----------------|-------------|
| `/api/internal/sync-wise` | `*/30 * * * *` | 800 |
| `/api/internal/sync-wise-activity` | `5,35 * * * *` | 800 |
| `/api/internal/sync-sales-dashboard` | `10,40 * * * *` | 800 |
| `/api/internal/sync-credit-control` | `20,50 * * * *` | 800 |
| `/api/internal/sync-progress-tests` | `25,55 * * * *` | 300 |
| `/api/internal/sync-post-class-feedback` | `13,43 * * * *` | 800 |
| `/api/internal/post-class-feedback-backfill` | `23,53 * * * *` | 800 |
| `/api/internal/sync-leave-requests` | `15,45 * * * *` | 800 |
| `/api/internal/cron-watchdog` | `7,37 * * * *` | 300 |
| `/api/internal/sync-competitor-intelligence` | `25 18 * * 0` | 800 |
| `/api/internal/progress-tests/admin-digest` | `35 0 * * *` | 300 |
| `/api/internal/class-assignments/morning` | `45 23 * * *` | 800 |
| `/api/internal/class-assignments/admin-email` | `0,10,20,30 0 * * *` | 300 |
| `/api/internal/admissions-notifications` | `12 1 * * *` | 300 |
| `/api/internal/student-promotions/july-1` | `5 17 30 6 *` | 800 |

- Minute-stagger is deliberate and test-enforced: `src/__tests__/vercel-crons.test.ts` asserts the four 30-minute sync schedules and that the admissions-notifications minute (12) collides with no other cron minute.
- Cron auth: `getCronSecretStatus()` compares `Authorization` against `Bearer ${CRON_SECRET}` with `timingSafeEqual` after a length pre-check; missing secret → 500, mismatch → 401 (`src/lib/internal/cron-auth.ts:6-26`, REL-07). 15 of the 21 internal route files import that shared helper; 6 declare their own local `hasValidCronSecret()` with identical length-pre-check + `timingSafeEqual` logic — `sync-wise` (`route.ts:11-27`, which carries the original REL-07 comment), `sync-sales-dashboard` (`:15`), `sync-credit-control` (`:18`), `sync-competitor-intelligence` (`:11`), `student-promotions/july-1` (`:10-17`), and `sync-room-utilization` (`:12`).
- Admin-session manual triggers: on `POST`, five routes fall back to an authenticated session when the cron secret is absent/invalid — `sync-wise`, `sync-sales-dashboard`, `sync-credit-control`, `sync-progress-tests`, and `sync-competitor-intelligence` (which requires a feature-scoped session via `requireCompetitorIntelligenceSession()`). `sync-room-utilization` is POST-only and accepts either a cron secret or a session. Every other internal route is cron-secret-only on both verbs; `student-promotions/july-1` proxies POST straight to GET and additionally refuses to run on any Bangkok date other than its target date (409).
- **Manual-only internal routes** — present in the cron registry with `schedule: null`, absent from `vercel.json`, reachable from the Data Health UI or a script: `/api/internal/post-class-feedback/admin-digest`, `/reminder-day-after`, `/reminder-deadline`, `/payout-accrual` (all four flagged `dangerous`), `/api/internal/sync-room-utilization` (also driven by `npm run room-utilization:sync`), and `/api/internal/line-backlog-recovery`. Registry total: 21 jobs = 15 scheduled + 6 manual-only (`src/lib/data-health/cron-registry.ts`), matching the 21 `route.ts` files under `src/app/api/internal/`.

## Environment Configuration

**Validated at startup (Zod, `src/lib/env.ts`)** — invalid/missing required vars throw at module load, logging only `fieldErrors`:
- Required (9): `DATABASE_URL` (URL), `AUTH_GOOGLE_ID`, `AUTH_GOOGLE_SECRET`, `AUTH_SECRET`, `WISE_USER_ID`, `WISE_API_KEY`, `WISE_NAMESPACE` (default `begifted-education`), `WISE_INSTITUTE_ID` (default `696e1f4d90102225641cc413`), `CRON_SECRET`.
- Optional (6): `LINE_CHANNEL_SECRET`, `LINE_CHANNEL_ACCESS_TOKEN`, `ENABLE_LINE_SCHEDULER`, `LINE_SCHEDULE_BOT_ADMIN_IDS`, `STUDENT_SCHEDULE_LINK_TTL_DAYS` (coerced positive int), `APP_BASE_URL` (URL).

**Read directly via `process.env` (not in the Zod schema)** — grouped by integration:
- Wise writeback gates: `WISE_SESSION_OPERATIONS_VERIFIED`, `WISE_SESSION_CREATE_VERIFIED`, `WISE_SESSION_SUBJECT_UPDATE_VERIFIED`
- OpenAI: `OPENAI_API_KEY`, `OPENAI_SCHEDULER_MODEL`, `OPENAI_SCHEDULER_SHADOW_MODEL`, `OPENAI_SCHEDULER_REASONING_EFFORT`, `OPENAI_PROGRESS_TEST_MODEL`, `OPENAI_POST_CLASS_FEEDBACK_MODEL`, `OPENAI_COMPETITOR_INTEL_MODEL`, `ENABLE_AI_SCHEDULER`, `ENABLE_COMPETITOR_AI`
- LINE: `LINE_VALIDATION_LEAD_EMAILS`
- Google Sheets: `SALES_DASHBOARD_CONNECTED_EMAIL` (in source, consumed only as the leave-requests fallback — `src/lib/leave-requests/config.ts:13`), `LEAVE_REQUESTS_SPREADSHEET_ID`, `LEAVE_REQUESTS_SHEET_NAME`, `LEAVE_REQUESTS_CONNECTED_EMAIL`
- Payout target (Sheets + Drive; all eight mandatory at the operation boundary — no source-code fallbacks, because publishing moves money): `POST_CLASS_PAYOUT_TARGET` (`scratch`|`production`), `POST_CLASS_PAYOUT_CONNECTED_EMAIL`, `POST_CLASS_PAYOUT_DRIVE_FOLDER_ID`, `POST_CLASS_PAYOUT_WORKBOOKS_FOLDER_ID`, `POST_CLASS_PAYOUT_MASTER_SPREADSHEET_ID`, `POST_CLASS_PAYOUT_SOURCE_SHEET_NAME`, `POST_CLASS_PAYOUT_DEDUCTIONS_SHEET_NAME`, `POST_CLASS_PAYOUT_COMPOSITE_SHEET_NAME`, plus `POST_CLASS_PAYOUT_WRITES_ENABLED` (only the exact string `true` enables writes). `requirePayoutGoogleTarget()` cross-checks `VERCEL_ENV`: a production deployment must target `production`, a preview must target `scratch` (`src/lib/post-class-feedback/payout-config.ts:112-128`). Also `POST_CLASS_AUTO_APPROVE_GRACE_HOURS`.
- Apps Script email: `SCHEDULE_EMAIL_APPS_SCRIPT_URL`, `SCHEDULE_EMAIL_APPS_SCRIPT_SECRET`, `SCHEDULE_EMAIL_BACKUP_APPS_SCRIPT_URL`, `SCHEDULE_EMAIL_BACKUP_APPS_SCRIPT_SECRET`, `SCHEDULE_EMAIL_SENDER_NAME`, `SCHEDULE_EMAIL_REPLY_TO`, `SCHEDULE_EMAIL_PUBLIC_BASE_URL`
- Resend: `RESEND_API_KEY`, `ADMISSIONS_EMAIL_FROM`, `ADMISSIONS_EMAIL_REPLY_TO`
- Competitor intelligence: `APIFY_API_TOKEN`, `APIFY_INSTAGRAM_ACTOR`, `APIFY_FACEBOOK_ACTOR`, `DATAFORSEO_LOGIN`, `DATAFORSEO_PASSWORD`, `COMPETITOR_APIFY_COST_PER_ITEM_USD`, `COMPETITOR_DATAFORSEO_COST_PER_QUERY_USD`, `COMPETITOR_INTEL_MONTHLY_CAP_USD`, `COMPETITOR_{PROVIDER}_MONTHLY_CAP_USD` (dynamic name, e.g. `COMPETITOR_DATAFORSEO_MONTHLY_CAP_USD`)
- Base-URL resolution, three independent ladders: schedule-bot links use `APP_BASE_URL` → hardcoded default (`src/lib/line/schedule-bot.ts:130-132`, `schedule-bot-group.ts:120-122`) and the link API uses `APP_BASE_URL` → the request origin (`src/app/api/student-schedule/link/route.ts:19`); schedule-email links use `SCHEDULE_EMAIL_PUBLIC_BASE_URL` → `VERCEL_PROJECT_PRODUCTION_URL` → `VERCEL_URL` → default (`schedule-email.ts:265-276`); the shared `APP_BASE_URL` constant used by digests and the watchdog resolves `NEXT_PUBLIC_APP_URL` → `SCHEDULE_EMAIL_PUBLIC_BASE_URL` → `VERCEL_URL` → `https://bgscheduler.vercel.app` (`src/lib/leave-requests/config.ts:15-21`).
- Ops / scripts / tests: `SEED_ADMIN_EMAILS`, `TEST_DATABASE_URL`, `CONFIRM_DELETE_LINE_TEST_DATA`, `PRODUCTION_BRANCH`, `GITHUB_ACTOR`, `TZ`.

**Secrets location:**
- Production: Vercel project environment variables (UI-managed).
- CI: literal dummy values inlined in `.github/workflows/ci.yml` — no repository secrets are consumed by either workflow.
- Local: `.env.local` (gitignored). `.env.example` documents the core set including the full payout block, but is **incomplete** relative to code — it omits `OPENAI_SCHEDULER_SHADOW_MODEL`, `OPENAI_SCHEDULER_REASONING_EFFORT`, `OPENAI_PROGRESS_TEST_MODEL`, `OPENAI_POST_CLASS_FEEDBACK_MODEL`, `OPENAI_COMPETITOR_INTEL_MODEL`, `ENABLE_COMPETITOR_AI`, every `APIFY_*` / `DATAFORSEO_*` / `COMPETITOR_*` var, `RESEND_API_KEY` and the `ADMISSIONS_EMAIL_*` pair, `LINE_VALIDATION_LEAD_EMAILS`, the three `WISE_SESSION_*_VERIFIED` gates, `SALES_DASHBOARD_CONNECTED_EMAIL`, `SCHEDULE_EMAIL_PUBLIC_BASE_URL`, and `POST_CLASS_AUTO_APPROVE_GRACE_HOURS`.

## Webhooks & Callbacks

**Incoming:**
- `POST /api/line/webhook` — LINE Messaging webhook. Middleware-public but HMAC-SHA256 signature-verified against `LINE_CHANNEL_SECRET`; 503 when the LINE scheduler is disabled, 401 on bad signature, 400 on bad JSON. Scheduler classification and group-command handling are deferred to `after()`; `maxDuration = 60`.
- `GET /api/internal/*` — Vercel Cron triggers for the 15 scheduled jobs (Bearer `CRON_SECRET`). Some of the same paths also accept `POST` for a manual run; see the admin-session note under *Cron* for exactly which.
- `GET|POST /api/auth/[...nextauth]` — Auth.js Google OAuth callbacks.
- Middleware-allowlisted endpoints that still enforce their own credential: `POST /api/search/assistant` (session → 401), `GET|OPTIONS /api/line/contacts/oa-resolver/worklist` and `/api/line/contacts/oa-resolver/runs/{id}/rows` (bearer resolver token → 401, CORS `*`), and the capability-token page `/schedule/{token}`. Genuinely open: `GET /api/classrooms/floor-plan-map` (SVG rendered from query params, `Cache-Control: public, max-age=3600`).

**Outgoing:**
- Wise (`https://api.wiseapp.live`) — pull-heavy ETL plus six gated write paths. No Wise webhook subscription; the activity feed is polled newest-first.
- LINE (`https://api.line.me`) — profile fetch, follower enumeration, message push, reply-token reply.
- OpenAI (`https://api.openai.com/v1/responses`).
- Google — Sheets v4 (`https://sheets.googleapis.com`), OAuth token refresh (`https://oauth2.googleapis.com/token`), the Apps Script web app (`https://script.google.com/...`), and Drive upload (`https://www.googleapis.com/upload/drive/v3/files`, script-only).
- Resend (`https://api.resend.com/emails`).
- Apify (`https://api.apify.com/v2/acts/...`), DataForSEO (`https://api.dataforseo.com/v3/serp/...`), and direct fetches of competitor websites.

## Surface Counts (this snapshot)

- API endpoints: **241** exported HTTP handlers across 178 `route.ts` files.
- Pages: **25** application pages under `src/app/(app)/` (29 `page.tsx` files in total, including `/login`, the `(app)` root redirect, the public `/schedule/[token]` page, and two `(print)` report routes).
- Vercel crons: **15** registered (table above); the cron registry defines **21** jobs, the other 6 being manual-only.
- DB: **188** tables, **61** enums, **65** migrations.
- Tests: **369** test files (Vitest `unit` project; the `integration` project covers `*.integration.test.ts` via Testcontainers Postgres and does not run in CI).
- `src/lib` modules (35): `__tests__`, `admissions`, `ai`, `auth`, `calendar`, `classrooms`, `competitor-intelligence`, `credit-control`, `data`, `data-health`, `db`, `home`, `internal`, `learning-plans`, `leave-requests`, `line`, `navigation`, `normalization`, `ops`, `payroll`, `post-class-feedback`, `progress-tests`, `proposals`, `room-capacity`, `sales-dashboard`, `scheduler`, `search`, `student-promotions`, `student-schedule`, `syllabus`, `sync`, `ui`, `us-universities`, `wise`, `wise-activity`.

---

_Verified against HEAD + uncommitted WIP on 2026-05-31._
