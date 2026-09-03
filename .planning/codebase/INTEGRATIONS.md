# External Integrations

**Analysis Date:** 2026-09-02

BGScheduler talks to eight external systems: the **Wise** scheduling/billing platform (the canonical data source), **LINE** Messaging (parent-chat ingest, contact resolution, and three bots — schedule, credit, and report — across DM and group paths), **OpenAI** (eight call sites across seven modules), **Google** (OAuth sign-in, Sheets v4 read/write, Drive v3 upload, and a deployed Apps Script email relay), **Resend** (admissions transactional email), **Apify** + **DataForSEO** (competitor-intelligence scraping and SERP), **Neon Postgres** (the only datastore), and **Vercel** (hosting, 17 crons, GitHub Actions CI alongside it). Every integration is exercised from server code under `src/lib/**` and `src/app/api/**` — there is no client-side third-party SDK, no message broker, and no object storage of our own. Only one vendor library is used at all (`@neondatabase/serverless` / `pg`); every other integration is hand-rolled over plain `fetch`.

## APIs & External Services

### Wise scheduling platform (primary external data source)

- Service: Wise API at `https://api.wiseapp.live` (`src/lib/wise/client.ts:64`) — source of truth for teachers, sessions, availability, leaves, students, classes, courses, session credits, fees/receipts, audit events, locations, and analytics. No production fallback to sheets or files.
  - Tenant / namespace: `begifted-education` (`WISE_NAMESPACE`, defaulted in `src/lib/env.ts:10`).
  - Institute: `696e1f4d90102225641cc413` (`WISE_INSTITUTE_ID`, defaulted in `src/lib/env.ts:11`).
  - Client: hand-rolled `WiseClient` class (`src/lib/wise/client.ts`). `createWiseClient()` (`:214`) is the shared production factory and raises concurrency to 15 (`:219`).
  - Auth: Basic Auth (base64 `WISE_USER_ID:WISE_API_KEY`) plus `x-api-key`, `x-wise-namespace`, and `user-agent: VendorIntegrations/{namespace}` headers (`client.ts:68-76`). Fee/receipt and payout-trend reads add `x-wise-timezone: Asia/Bangkok` + `x-wise-platform: web` per call (`src/lib/wise/fetchers.ts:579-580`, `:743-744`).
  - Auth env vars: `WISE_USER_ID`, `WISE_API_KEY`, `WISE_NAMESPACE`, `WISE_INSTITUTE_ID`.
  - Concurrency: in-process queue limiter, default 5 (`client.ts:65`); 15 in `createWiseClient()`, 6 in the student-promotions client (`src/lib/student-promotions/data.ts:305`), default 5 in the classroom-publish client (`src/lib/classrooms/data.ts:1151-1158`).
  - Retry: exponential backoff 1s/2s/4s, max 3 retries (`client.ts:66`, `:150-153`, `:171-174`). Only `408/429/500/502/503/504` are retried; permanent 4xx (401/403/404/422) fail fast (`RETRYABLE_STATUS_CODES`, `:37-44`, `:166`, REL-05). Network-level failures (DNS/ECONNRESET/fetch `TypeError`) are also retried.
  - Per-client request tally (EFF-00): `WiseClientStats` counts every logical call (retries included), bucketed by a path normalized against a 24-hex object-id segment, so a sync run can answer "was this API-bound?" (`client.ts:15-27`).
  - Read endpoints — request/response signatures live in [reference/api](../../docs/reference/api/index.md), Wise-side mechanics in [reference/wise-api](../../docs/reference/wise-api.md). In `src/lib/wise/fetchers.ts`:
    - `GET /institutes/{id}/teachers` (`:35`)
    - `GET /institutes/{id}/teachers/{teacherUserId}/availability?startTime&endTime` (`:49`) — 7-day windows; `fetchTeacherFullAvailability` stitches 26 of them for the 180-day leave horizon (`:63`)
    - `GET /institutes/{id}/sessions` — future/paginated by count (`:134`, `PAGE_LIMIT = 1000` at `:24`) and past sessions paginated by Bangkok calendar date (`:162`)
    - `GET /user/classes/{classId}/sessions/{sessionId}` (`:192`) — canonical session detail for post-class feedback, strictly read-only
    - `GET /institutes/{id}/locations` (`:213`)
    - `GET /institutes/v3/{id}/students` (`:277`), `GET /institutes/{id}/participants/{studentId}?showRegistrationData=true` (`:301`)
    - `GET /user/v2/classes/{classId}?full=true` (`:324`), `GET /user/classes/{classId}/participants?showCoTeachers=true` (`:343`)
    - `GET /institutes/{id}/events` (`:512`) — audit feed; `page_size` clamped to ≤50 (`:504`) and the sync walks newest-first because the endpoint's date params are not trusted
    - `GET /institutes/{id}/analytics/sessionStats|classroomStats|classroomTrends` (`:528`, `:539`, `:549`) and `GET /institutes/{id}/trends` (`:571`)
    - `GET /institutes/{id}/fees/transactions` (`:729`) — receipts for credit-control + payroll, 50/page up to 200 pages (`:25-26`)
  - Credit Control keeps its own Wise read layer (`src/lib/credit-control/wise.ts`) rather than routing through `fetchers.ts`, and is the only caller of `GET /institutes/{id}/classes/{classId}/students/{studentId}/sessionCredits` (`:269`) — the package-balance endpoint behind every credit projection, the `/credit` LINE reply, and the parent report.
  - Write endpoints — six mutation-shaped calls, each with its own gate:

    | Write | Fetcher | Caller + gate |
    |---|---|---|
    | `PUT /teacher/classes/{classId}/sessions/{sessionId}?updateType=SINGLE` (location) | `updateSessionLocation` (`fetchers.ts:410`) | Classroom publish only, per-run opt-in; refuses to run when the Wise location catalog reads empty |
    | `PUT /teacher/classes/{classId}/sessions/{sessionId}?updateType=SINGLE` (subject) | `updateSessionSubject` (`fetchers.ts:426`) | Student promotions; throws unless `WISE_SESSION_SUBJECT_UPDATE_VERIFIED === "true"` (`src/lib/student-promotions/data.ts:450`, `:2412`) |
    | `PUT /teacher/editClass` (course subject) | `updateWiseCourseSubject` (`fetchers.ts:336`) | Student promotions, applied only after a verified run; rate-gated, roster-drift checked |
    | `PUT /institutes/{id}/students/{studentId}/registration` (grade answers) | `updateWiseStudentRegistrationAnswers` (`fetchers.ts:314`) | Student promotions; skipped on `already_target` / `grade_drift` before any call |
    | `POST /teacher/classes/{classId}/sessions` (create session) | `scheduleWiseSession` (`fetchers.ts:464`) | Progress-test booking; requires `WISE_SESSION_CREATE_VERIFIED === "true"` (`src/lib/progress-tests/config.ts:50`) |
    | `POST /institutes/{id}/checkSessionsAvailability` | `checkTeacherAvailabilityForSessions` (`fetchers.ts:399`) | No gate — read-shaped pre-check run before every progress-test create |

    Separately, `WISE_SESSION_OPERATIONS_VERIFIED` gates the LINE cancel/reschedule confirm path (`src/lib/wise/operations.ts:10-12`, `src/lib/line/operational.ts:21`). That path is **dry-run on both sides of the gate**: unset writes a `manual_required` log row, set writes a `dry_run` row, and no Wise mutation is ever sent because the cancel/move request shape is still unverified (`operations.ts:53-95`). Leave requests likewise record a dry run rather than cancelling in Wise.
  - Consumers of the shared `createWiseClient()`: ten lib modules — `sync/run-wise-sync.ts`, `wise-activity/reconciliation.ts`, `credit-control/run-sync-request.ts`, `classrooms/morning-automation.ts`, `room-capacity/utilization.ts`, `post-class-feedback/sync.ts`, `progress-tests/booking.ts`, `progress-tests/run-sync-request.ts`, `data-health/run-job.ts`, `student-schedule/live.ts` — plus four route handlers that construct it inline (`api/internal/sync-wise-activity`, `api/wise-activity/sync`, `api/wise-activity/reconciliation/backfill`, `api/payroll/sync`). Two modules build their own client at a different concurrency (`classrooms/data.ts:1151`, `student-promotions/data.ts:305`), and payroll sync takes an injected `WiseClient`. All server-side; nothing on the search request path queries Wise directly.
  - **One deliberate exception to "never on the request path"**: the parent-schedule live overlay (`src/lib/student-schedule/live.ts:110`) calls Wise while rendering `/schedule/{token}`. It is fail-soft by construction — the sweep is raced against a deadline and any error, Zod failure, or overrun drops back to snapshot data (`:71-86`) — and is disabled outright by `ENABLE_STUDENT_SCHEDULE_LIVE=false`. The deadline race exists because `WiseClient.fetchWithRetry` would otherwise burn its 1s/2s/4s backoff *after* the deadline fired (`:80-83`).
  - Deep links only (no API): the UI links out to `https://app.wise.live/classes/{classId}/sessions/{sessionId}` (`src/lib/post-class-feedback/dashboard.ts:115`, `src/lib/post-class-feedback/notifications.ts:260`).

### LINE Messaging (parent-chat ingest, contact resolution, three bots)

- Service: LINE Messaging API at `https://api.line.me` (`src/lib/line/client.ts:3`).
  - Auth: Bearer `LINE_CHANNEL_ACCESS_TOKEN`; `lineAccessToken()` throws when unset (`client.ts:29-33`).
  - Inbound webhook signature: HMAC-SHA256 of the raw body keyed by `LINE_CHANNEL_SECRET`, base64-compared with `timingSafeEqual` after a length pre-check (`src/lib/line/signature.ts:12-19`).
  - Endpoints used:
    - `GET /v2/bot/profile/{userId}` (`client.ts:42`) — 404 → `null`; batched at concurrency 5 by `fetchLineProfilesBatched`
    - `GET /v2/bot/followers/ids?limit=300` (`client.ts:69`) — cursor-paged follower enumeration for the OA resolver
    - `POST /v2/bot/message/push` (`client.ts:118`) — outbound push carrying an `X-Line-Retry-Key` idempotency header; HTTP 409 is treated as "retry already accepted"
    - `POST /v2/bot/message/reply` (`client.ts:166`) — reply-token reply used by the group paths; consumes no message quota, token valid ~1 minute, failures throw so the caller can deliberately fall back to a push
  - Feature flag: `lineSchedulerEnabled()` requires `ENABLE_LINE_SCHEDULER !== "false"` **and** both `LINE_CHANNEL_SECRET` and `LINE_CHANNEL_ACCESS_TOKEN` present (`client.ts:19-23`). When off the webhook returns 503 (`src/app/api/line/webhook/route.ts:9-11`).
  - Inbound processing: the route records the payload synchronously, then defers scheduler classification **and** group-command handling to Next's `after()` — both imported lazily, so the AI-scheduler and search subtrees never load before the 200 goes back to LINE (`webhook/route.ts:20-42`, `maxDuration = 60`).
  - **Schedule bot** (status: `stable`) — an admin names a student and the bot pushes that child's monthly schedule link. The DM path fails closed at four independent gates (sender allowlist `LINE_SCHEDULE_BOT_ADMIN_IDS`, verified-link-only recipient resolution, explicit YES confirm with a 5-minute TTL, non-empty-month check; SCHED-BOT-01…04, `src/lib/line/schedule-bot.ts`), and an empty or unset allowlist disables it entirely (`:116`). The group path re-weights those gates for a group destination — self-mention required, sender allowlist, exact nickname-code match, confirm-on-first-sight per group, non-empty month (GRP-BOT-01…05, `schedule-bot-group.ts`) — deliberately dropping the verified-student-link gate because the destination is the group everyone is already in. Both routers run before the OpenAI classifier, so an admin command never costs a model call.
  - **Credit bot** (status: `stable`) — `/credit <code>` replies with a family's live Wise credit balances plus a Parent Report link; `/credit setup` registers a staff group for the daily digest (`src/lib/line/credit-bot.ts`). It inherits the schedule bot's admin gate and adds **CRED-BOT-G1**: in a group, every `/credit` use requires the chat's stored audience to be exactly `"staff"`, read raw from `line_group_settings` rather than through `groupSettings()` (which coerces unknown values to `"staff"` — permissive in the wrong direction here). A missing row, a `"family"` audience, or any unexpected value produces **no reply at all**, help text included, so balances can never surface where a parent reads them (`credit-bot.ts:11-18`, `:325`).
  - **Report bot** (status: `stable`) — `/report` returns a Parent Report link (30-day default, day/date-range arguments) built from `src/lib/student-report/params.ts` and pointed at `/student-report/report` (`src/lib/line/report-bot.ts:148`). **REP-BOT-G1** is the verbatim mirror of CRED-BOT-G1: staff chats only, fail closed and fully silent (`report-bot.ts:10-11`, `:98`).
  - **Credit run-out digest** (status: `stable`) — pushed once daily into every staff group that opted in via `/credit setup` (`src/lib/line/credit-digest.ts`, cron `3 2 * * *`). Flags packages that run out within 7 days or are already out, sectioned per assigned admin from `credit_control_admin_ownership`. Balances are raw Wise `remainingCredits`, deliberately *not* the dashboard's adjusted-remaining, so the dashboard can flag a student a class or two earlier. Idempotency is doubled: a terminal `line_credit_digest_runs` row for the date short-circuits a re-run, and the per-`(date, group)` deterministic push retry key makes a webhook-level retry a no-op even without that row (`credit-digest.ts:22-26`).
  - Auth env vars: `LINE_CHANNEL_SECRET`, `LINE_CHANNEL_ACCESS_TOKEN`, `ENABLE_LINE_SCHEDULER`, `LINE_SCHEDULE_BOT_ADMIN_IDS` (all optional in `src/lib/env.ts:13-19`).
  - Other LINE env: `LINE_VALIDATION_LEAD_EMAILS` — comma-separated link-validation lead allowlist with a hardcoded fallback (`src/lib/line/link-validation.ts:221`).
  - Non-API surface: staff chat deep links are validated to be `https://chat.line.biz` over HTTPS only (`src/lib/line/oa-resolver.ts`).

### OpenAI (eight call sites, all the Responses API)

- Service: `https://api.openai.com/v1/responses`, called directly over `fetch` — no vendor SDK.
  - Auth: Bearer `OPENAI_API_KEY` at every call site.
  - Call sites and their model env var:

    | Call site | File | Model env (fallback) |
    |---|---|---|
    | AI scheduler parse | `src/lib/ai/scheduler.ts:544` | `OPENAI_SCHEDULER_MODEL`, shadow `OPENAI_SCHEDULER_SHADOW_MODEL` |
    | AI scheduler conversation | `src/lib/ai/scheduler-conversation.ts:2346` | same as above |
    | LINE message classifier | `src/lib/line/classifier.ts:98` | reuses `aiSchedulerModel()` |
    | LINE contact-alias matching | `src/lib/line/contact-aliases.ts:368` | reuses `aiSchedulerModel()` |
    | Progress-test AI summary | `src/lib/progress-tests/ai-summary.ts:185` | `OPENAI_PROGRESS_TEST_MODEL` → scheduler default |
    | Post-class feedback review | `src/lib/post-class-feedback/ai.ts:62` | `OPENAI_POST_CLASS_FEEDBACK_MODEL` → module default |
    | Competitor-intelligence digest (2 calls) | `src/lib/competitor-intelligence/ai.ts:161`, `:300` | `OPENAI_COMPETITOR_INTEL_MODEL` → `OPENAI_SCHEDULER_MODEL` → default |

  - Feature flags: `isAiSchedulerConfigured()` requires `ENABLE_AI_SCHEDULER !== "false"` plus a non-empty `OPENAI_API_KEY`; the progress-test summary mirrors that gate; competitor AI has its own `ENABLE_COMPETITOR_AI !== "false"`. Post-class feedback degrades to a `"deterministic-only"` model label rather than failing.
  - Reasoning effort: `OPENAI_SCHEDULER_REASONING_EFFORT`.
  - Usage shape: strict JSON-schema structured output with `store: false`. The model never reaches Wise — it only emits search parameters that the in-memory index resolves, so availability is decided by the app, not the model. Both the AI Scheduler and Proposals carry the `experimental` maturity badge; every AI read-out in Competitor Intelligence has a deterministic fallback.

### Google (four distinct surfaces)

1. **Google OAuth sign-in** — Auth.js Google provider (see *Authentication & Identity*). Tokens captured at sign-in are the credential for every other Google surface below.
2. **Google Sheets API v4** — `https://sheets.googleapis.com/v4/spreadsheets/...` (`src/lib/sales-dashboard/sheets.ts:58`, `:76`, `:99`).
   - Auth: per-user OAuth access token from `getGoogleSheetsAccessToken()` / `getGoogleSheetsWriteAccessToken()`, refreshed via `POST https://oauth2.googleapis.com/token` with `grant_type=refresh_token` and `AUTH_GOOGLE_ID`/`AUTH_GOOGLE_SECRET` (`src/lib/sales-dashboard/google-oauth.ts:146`). A refresh failure records `lastError` on the token row before throwing.
   - Scopes: `spreadsheets.readonly` / `spreadsheets`, checked per operation (`google-oauth.ts:7-8`, `:82-89`, `:201`, `:228`).
   - Thirteen exported operations (`sheets.ts:53-451`): quote a sheet name, list titles and sheet properties, read rows / ranges / grid metadata, single-cell update, range and batch value updates, spreadsheet `batchUpdate`, row insert, row-value update, and `appendGoogleSheetRows`.
   - Consumers: Sales Dashboard import (`stable`), Tutor Leave Requests sync (`stable`) — reads form responses and writes status column `S` (`src/lib/leave-requests/config.ts:10`) — and Post-Class Payout publishing, which appends one deduction row at a time into the master workbook rather than batching, so every outcome has an unambiguous row number (`src/lib/post-class-feedback/payout-writer.ts`).
3. **Google Drive API v3 (upload)** — `https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&supportsAllDrives=true` (`src/lib/post-class-feedback/drive.ts:65-66`). The only Drive contact in the codebase. It is **no longer script-only**: `src/lib/post-class-feedback/payout-run.ts:13` imports `uploadCsvToDrive` to archive each payout run's CSV (injectable as `PayoutRunDependencies.uploadCsv` for tests, `payout-run.ts:147`); `scripts/verify-drive-upload.ts:38` remains a second caller.
   - Scope: `drive.file` (per-file), deliberately not the restricted full `drive` scope, which would require Google verification plus an annual security assessment (`google-oauth.ts:10-12`).
   - Error mapping is explicit: an "API not enabled" message is reported as a Cloud-project setting, a 404 as "the connected account cannot see the folder".
4. **Google Apps Script email relay** — schedule emails, admin schedule emails, leave-request notices, progress-test heads-ups and digests, post-class notifications, admissions mail fallbacks, and cron-watchdog alerts are POSTed to a deployed Apps Script web app, not an email SaaS (`src/lib/classrooms/schedule-email.ts:602-634`).
   - Endpoints: `SCHEDULE_EMAIL_APPS_SCRIPT_URL` (primary) and `SCHEDULE_EMAIL_BACKUP_APPS_SCRIPT_URL` (failover) (`:288-303`).
   - Auth: a `secret` field inside the JSON body (`SCHEDULE_EMAIL_APPS_SCRIPT_SECRET` / `..._BACKUP_...`), not a header (`:614`).
   - Idempotency: per-recipient key `classroom-schedule:{runId}:{canonicalKey}:{contentHash}`, truncated to 256 chars (`:648-649`).
   - Quota failover: on a MailApp "daily recipient quota is exhausted" error the primary sender stops and the backup takes the remaining recipients (`:653-655`).
   - Sender metadata: `SCHEDULE_EMAIL_SENDER_NAME` (default `BeGifted`), `SCHEDULE_EMAIL_REPLY_TO` (`:606-607`).
   - Reused as a generic sender: `createAppsScriptScheduleEmailSender()` is imported by ten modules, including the cron watchdog (`src/lib/internal/cron-watchdog.ts:23-26`).

### Resend (admissions transactional email)

- Service: `POST https://api.resend.com/emails` (`src/lib/admissions/notifications.ts:43`), the only Resend call site.
  - Auth: Bearer `RESEND_API_KEY`; a missing key throws (`:299-300`).
  - Sender overrides: `ADMISSIONS_EMAIL_FROM` and `ADMISSIONS_EMAIL_REPLY_TO`, each with a module default (`:301-302`).
  - Every send is recorded with its Resend email id and a dedupe key in `admissions_notification_log`; a per-recipient daily interrupt cap collapses excess notifications, and deadline reminders fire at T-7d and T-48h.
  - Driven by the `admissions-notifications` cron (`12 1 * * *`, 08:12 Bangkok). University Admissions is `stable`, with the caveat that its parity-hardening code is unmerged on `origin/codex/admissions-parity-hardening` while the schema has already landed.

### Apify + DataForSEO (competitor intelligence)

- **Apify** — `POST https://api.apify.com/v2/acts/{actor}/run-sync-get-dataset-items?token=…` with a 60s timeout (`src/lib/competitor-intelligence/providers.ts:69-82`).
  - Auth: `APIFY_API_TOKEN` in the query string; when unset the fetch is skipped with `skippedReason: "APIFY_API_TOKEN is not configured"` rather than failing the run (`:70-72`, `:93-99`).
  - Actors: `APIFY_INSTAGRAM_ACTOR` (default `apify/instagram-scraper`) and `APIFY_FACEBOOK_ACTOR` (default `apify/facebook-posts-scraper`) (`:17-18`).
- **DataForSEO** — `POST https://api.dataforseo.com/v3/serp/google/organic/live/regular` (`:144`), Basic Auth from `DATAFORSEO_LOGIN`/`DATAFORSEO_PASSWORD`; unset → skipped, not failed (`:130-139`). Bangkok queries are rewritten to the `Bangkok,Bangkok,Thailand` location name (`:19`, `:31-33`).
- **Plain website fetch** — competitor sites are fetched directly with a 10s timeout and a `BGSchedulerCompetitorIntelligence/1.0` user agent (`:16`, `:37-50`).
- Cost control: each provider result carries an `estimatedCostUsd` (`COMPETITOR_APIFY_COST_PER_ITEM_USD` default 0.01, `COMPETITOR_DATAFORSEO_COST_PER_QUERY_USD` default 0.002) and a monthly hard cap resolved per provider from `COMPETITOR_{PROVIDER}_MONTHLY_CAP_USD` → `COMPETITOR_INTEL_MONTHLY_CAP_USD` → 250 USD, with website/manual sources capped at 0 (`src/lib/competitor-intelligence/budget.ts:18-24`). A source whose estimate would exceed the cap is marked skipped *before* the vendor call (`sync.ts:157`).

### Non-runtime data ingest (for completeness)

The US-universities catalog (`us-universities`, `stable`) is loaded from an IPEDS Microsoft Access file converted to CSV **locally** with `mdbtools` and imported into Postgres by `scripts/ipeds-import.ts`. There is no runtime IPEDS integration — the app only ever reads Postgres.

## Data Storage

**Databases:**
- Neon Postgres (serverless, ap-southeast-1) — the only datastore.
  - Connection: `DATABASE_URL`, validated as a URL by Zod (`src/lib/env.ts:4`).
  - Default driver: `@neondatabase/serverless` HTTP-mode `neon()` wrapped by `drizzle-orm/neon-http` (`src/lib/db/index.ts:1-12`), exposed as a `globalThis.__bgscheduler_db` singleton so it survives HMR (`:16-27`).
  - Transaction caveat: neon-http cannot run interactive transactions. Three call sites detect the literal `"No transactions support in neon-http driver"` error and fall back to a `pg` `Pool({ max: 1 })` against the same `DATABASE_URL` — payroll sync (`src/lib/payroll/sync.ts:90`, `:96`), post-class feedback writes (`src/lib/post-class-feedback/transaction.ts:12`, `:18`), and admissions audit, which additionally imports `pg` lazily so the module stays importable from client-component graphs (`src/lib/admissions/audit.ts:13`, `:54`). `pg` also backs the integration-test harness (`src/tests/integration/db-helper.ts:5`, `:33`).
  - ORM / migrations: Drizzle ORM 0.45.2 with `drizzle-kit`; dialect `postgresql`, schema `src/lib/db/schema.ts`, output `drizzle/`.
  - Schema scale: **189 tables** and **61 `pgEnum` types**. Column-level detail is the canonical property of [reference/database](../../docs/reference/database/index.md); do not restate it here.
  - Migrations: **69 SQL migrations** in `drizzle/`, `0000_*` through `0068_payout_adjustment_superseded`. The four most recent — `0065_line_group_settings_skip_confirm`, `0066_credit_control_session_title`, `0067_line_credit_digest`, `0068_payout_adjustment_superseded` — carry the LINE credit bot/digest and the payout-adjustment supersession chain.
  - Google token vault: `google_oauth_tokens` stores per-email access/refresh tokens encrypted at rest with AES-256-GCM, key = SHA-256 of `AUTH_SECRET` (`src/lib/sales-dashboard/google-oauth.ts:40-76`). Missing `AUTH_SECRET` throws rather than storing plaintext.

**File Storage:**
- No object storage of our own. The one file-egress path is the Drive CSV upload described above, now reachable from the payout-run path as well as its verification script. `xlsx` is used for in-process parsing of sales/projection imports, never for persistence.

**Caching:**
- In-memory search index singleton anchored on `globalThis.__bgscheduler_searchIndex`, with a build-promise coalescer `__bgscheduler_searchIndexBuildPromise` against thundering herds (`src/lib/search/index.ts:100-112`). Rebuilt when the active snapshot id changes. This is what makes Tutor Search (`stable`) sub-400ms warm.
- Next.js Data Cache via `"use cache"` + `cacheTag`/`revalidateTag` across five tags: `snapshot` (`src/lib/data/tutors.ts:82`, `src/lib/data/filters.ts:54`; swept by `run-wise-sync.ts:161` after a successful promote), `past-sessions` (deliberately NOT swept with `snapshot` — `src/lib/data/past-sessions.ts:11`, `:88`), `sales-dashboard` (`src/lib/sales-dashboard/data.ts:921-950`, also swept on Google token writes at `google-oauth.ts:138`, `:183`), `credit-control` (`src/lib/credit-control/service.ts:32`, swept from seven mutation sites plus the sync), and `us-universities` (`src/lib/us-universities/data.ts:370-410`). Progress Tests sweeps its own tag from eight booking paths and the sync (`src/lib/progress-tests/booking.ts`, `sync.ts:599`).
- Client-side compare cache: `Map<"tutorGroupId:weekStart:CACHE_VERSION", CompareTutor>` in browser memory; recent searches in `localStorage`. Tutor Compare's engine is live; `/compare` itself is `legacy-redirect` to `/search`.

## Authentication & Identity

**Auth Provider:**
- Auth.js v5 (`next-auth` 5.0.0-beta.30), Google OAuth only. Node config `src/lib/auth.ts`; edge-safe config `src/lib/auth-edge.ts` backs middleware.
  - Scopes differ by runtime: the Node provider requests `openid email profile https://www.googleapis.com/auth/spreadsheets https://www.googleapis.com/auth/drive.file` with `access_type: offline` (`src/lib/auth.ts:37-39`); the edge provider declares only `spreadsheets.readonly` (`src/lib/auth-edge.ts:11`) since it never mints tokens and does no DB work (`:22-25`).
  - Sign-in gate is **role resolution, not a flat allowlist** (`src/lib/auth-access.ts:1-19`; order admin → counselor → teacher → case member, first match wins): `admin` from `admin_users` (the row carries `allowedPages`; `null` = full access), `counselor` from an active `admissions_counselors` row (restricted to `/admissions`), `teacher` when the email matches an active tutor contact (restricted to `/progress-tests`, scoped read-only to their own students), and `student`/`parent` from an active `admissions_case_members` membership. No match → sign-in denied (fail-closed).
  - Admissions invite activation runs *before* access resolution so a freshly invited member passes the active-only membership filter on their first sign-in; failures are logged and never unblock a denied user (`src/lib/auth.ts:16-23`).
  - Google token capture: on a successful sign-in the account's access/refresh token, scope and expiry are persisted (encrypted) via `storeGoogleOAuthTokenForUser()` so Sheets/leave-request/payout features can act as that user later (`src/lib/auth.ts:50-53`).
  - `allowedPages` and `role` are resolved once at sign-in and persisted on the JWT, so subsequent requests need no DB call (`auth.ts:57-65`).
  - Route handlers: `src/app/api/auth/[...nextauth]/route.ts` — the only file that exports its methods by destructuring (`export const { GET, POST } = handlers`), which is why a naive `export async function` grep undercounts the endpoint total by two.
  - Required env vars: `AUTH_GOOGLE_ID`, `AUTH_GOOGLE_SECRET`, `AUTH_SECRET` (also the Google-token encryption key).

**Maintenance gate** (`src/lib/maintenance.ts`, MAINT-01…05): a staff-UI kill switch that sits **above** the public-route allowlist in `src/middleware.ts:76-82`. Vercel's Pause Project cannot serve this purpose — pausing blocks the production deployment, and the crons target that same deployment, so pausing would stop the syncs too. Engages only on the exact string `MAINTENANCE_MODE=true` (fail-open, MAINT-01); exempts `/api/internal/`, `/schedule/`, `/api/auth/`, and `/login` so crons, parent links and sign-in survive (MAINT-02); `MAINTENANCE_BYPASS_EMAILS` is comma-separated and fail-closed (MAINT-03). Ordering is load-bearing: the public allowlist passes `/api/line/webhook`, so a gate placed after it would wave through the one path maintenance mode exists to close — at the documented cost that LINE does not redeliver, so inbound OA messages during a window are lost rather than queued (MAINT-04). Responses are 503 with `Retry-After`, JSON under `/api/` and a self-contained inline-styled page elsewhere (MAINT-05).

**Middleware gate** (`src/middleware.ts:9-25`): a public allowlist passes through without a session — `/login`, `/api/auth/*`, `/api/search/assistant`, `/api/classrooms/floor-plan-map`, `/api/line/webhook`, `/schedule/*` (note the trailing slash — it keeps the authenticated `/student-schedule` admin page out), the two LINE OA-resolver paths, and `/api/internal/*`. Everything else redirects to `/login`. Signed-in but page-restricted users are then matched against `allowedPages` both as a page prefix and as its `/api` namespace (`:36-66`), with three carve-outs: `/api/home/summary` always passes; post-class-feedback pages and APIs pass the coarse check because a fresher DB capability grant supersedes the JWT claim; learning-plan **pages** pass for the same reason, but the learning-plans **API namespace** is explicitly denied (`:47-57`). API denials return 403; page denials redirect to the user's landing page with a loop guard.

Middleware allowlisting is not the same as being unauthenticated. `POST /api/search/assistant` is allowlisted in middleware yet still calls `auth()` and returns 401 without a session; the OA-resolver worklist requires its own opaque bearer resolver token and answers 401 otherwise, with permissive CORS for the browser extension that consumes it (`src/app/api/line/contacts/oa-resolver/worklist/route.ts:5-32`). Only `GET /api/classrooms/floor-plan-map` is genuinely open — it renders an SVG from query params with no data access and `Cache-Control: public, max-age=3600` (`src/app/api/classrooms/floor-plan-map/route.ts:3-16`).

**Capability-token access (no session):** the parent monthly-schedule page `/schedule/{token}` is reached from a LINE message, so the token *is* the credential (`src/lib/student-schedule/links.ts:1-14`). Tokens are 32 random bytes base64url-encoded, stored only as a SHA-256 hash and compared in constant time after a length pre-check, scoped to exactly one `(studentKey, monthKey)`, and expire after `STUDENT_SCHEDULE_LINK_TTL_DAYS` (default 30 — `:24-28`, `:38-51`). Expired, revoked, unknown and malformed tokens all resolve to `null` so the page cannot be used as an existence oracle. The Parent Class Report (`student-report`, `stable`) does **not** share this model: `GET /api/student-report` requires a session (`src/app/api/student-report/route.ts:14-17`), and the `/report` LINE bot hands out a link into the authenticated print surface.

**Seeding:** `npm run db:seed` reads a comma-separated `SEED_ADMIN_EMAILS` and upserts `admin_users` (`src/lib/db/seed.ts:31-43`), then upserts a small set of deliberately page-restricted accounts that are intentionally NOT in `SEED_ADMIN_EMAILS` (`:46-57`). The provisioned admin list is operational config, not source.

## Monitoring & Observability

**Error Tracking:**
- None — no Sentry/Datadog/Bugsnag/OpenTelemetry dependency. Failures surface through domain tables instead: `data_issues` (typed + severity-classified normalization problems), per-domain `*_sync_runs` rows, the Wise-activity reconciliation tables, `cron_invocations`, and `cron_alert_state`.

**Logs:**
- Bare `console.error` (66 call sites under `src/lib`) plus Vercel platform logs. No structured logging library, no request-logging middleware. Fire-and-forget boundaries — the two `after()` handlers in the LINE webhook — log rather than throw (`src/app/api/line/webhook/route.ts:27-29`, `:38-40`).

**Health / status surfaces (`data-health`, `stable`):**
- `GET /api/data-health` — sync status, snapshot stats, issue counts, recent history.
- `POST /api/data-health/jobs/{jobKey}/run` — authenticated manual trigger for any registered cron job; jobs whose key starts with `post_class_feedback` additionally require the `access_manager` capability (403 otherwise), and jobs flagged `dangerous` require `confirmed: true` in the body or return 409 (`src/app/api/data-health/jobs/[jobKey]/run/route.ts:14-42`, `maxDuration = 800`).
- **Cron watchdog** (`src/lib/internal/cron-watchdog.ts`) — sweeps every registered cron every 30 minutes using the same health derivation as `/data-health` and emails admins through the Apps Script relay. Episode-based dedup (one alert per job per failure episode) persisted in `cron_alert_state` (`:1-17`); a sentinel `__watchdog_sweep_lock` row acts as the single-flight lock because neon-http supports neither transactions nor session advisory locks, reclaimable after route `maxDuration` + buffer (`:42-51`). Alert state is only written after at least one recipient accepted, so a failed delivery retries next sweep; partial delivery is a documented tradeoff (`:11-17`). It also prunes `cron_invocations` and carries a dedicated payout-window staleness probe for the accrual job (`:28-36`).
- Staleness thresholds: API warning at 90 minutes, app-wide banner at 2 hours (`src/lib/ops/stale.ts:1-3`) — staleness is a warning, never withheld data.

## CI/CD & Deployment

**Hosting:**
- Vercel (Pro plan), region pinned to `sin1` (`vercel.json:2`). Production URL https://bgscheduler.vercel.app; repo https://github.com/kasheesh711/bgscheduler.
- Deploy by pushing to `main` (Vercel Git integration). The guarded manual path is `npm run deploy:prod` → `verify:release` (typecheck → unit tests → build → typecheck → `git diff --check` → `guard:production-route-surface`) → `scripts/assert-production-deploy-ready.mjs` (refuses a non-`main` branch — override via `PRODUCTION_BRANCH` — a dirty tree, or `HEAD != origin/main`) → `npx vercel --prod` (`package.json:38-39`). A bare `vercel --prod` from an unlinked worktree creates a stray project.
- Function ceilings are set per route via `export const maxDuration`, never in `vercel.json`: across the 22 internal routes, 14 sit at 800s and 8 at 300s; the LINE webhook is 60s; the Data Health manual job runner is 800s.

**CI Pipeline:**
- **GitHub Actions, two workflows.** `.github/workflows/ci.yml` runs on PRs to `main` and pushes to `main` with five parallel jobs on Node 20 — `lint`, `typecheck`, `unit-tests` (`npm test`), `build` (+ a second typecheck), and `release-guards` (`guard:production-route-surface` plus a `git diff --check` whitespace gate that diffs against the PR base or `HEAD^` on push). It injects dummy Wise/Auth/DB env vars and forces `ENABLE_AI_SCHEDULER=false`, `ENABLE_LINE_SCHEDULER=false`, `TZ=Asia/Bangkok`, so CI never touches a vendor. `.github/workflows/sales-dashboard-scope.yml` pipes the PR's changed-file list through `scripts/check-sales-dashboard-scope.mjs` with the PR author as `--actor`.
- Integration tests are **not** in CI: `npm run test:integration` runs the 13 `*.integration.test.ts` files against Testcontainers Postgres locally (or an external instance via `TEST_DATABASE_URL`).

**Cron (Vercel Cron, `vercel.json`):** 17 registered jobs, all invoked as GET, all guarded by a constant-time `CRON_SECRET` Bearer check. Canonical schedule table: [reference/crons](../../docs/reference/crons.md).

| Path | Schedule (UTC) | maxDuration |
|------|----------------|-------------|
| `/api/internal/sync-wise` | `*/30 * * * *` | 800 |
| `/api/internal/sync-wise-activity` | `2,17,32,47 * * * *` | 800 |
| `/api/internal/sync-sales-dashboard` | `10,40 * * * *` | 800 |
| `/api/internal/sync-credit-control` | `20,50 * * * *` | 800 |
| `/api/internal/sync-progress-tests` | `25,55 * * * *` | 300 |
| `/api/internal/sync-post-class-feedback` | `13,43 * * * *` | 800 |
| `/api/internal/post-class-feedback-backfill` | `23,53 * * * *` | 800 |
| `/api/internal/post-class-feedback/payout-accrual` | `33 * * * *` | 800 |
| `/api/internal/sync-leave-requests` | `15,45 * * * *` | 800 |
| `/api/internal/cron-watchdog` | `7,37 * * * *` | 300 |
| `/api/internal/sync-competitor-intelligence` | `28 18 * * 0` | 800 |
| `/api/internal/progress-tests/admin-digest` | `35 0 * * *` | 300 |
| `/api/internal/class-assignments/morning` | `41 23 * * *` | 800 |
| `/api/internal/class-assignments/admin-email` | `4,14,24,36 0 * * *` | 300 |
| `/api/internal/admissions-notifications` | `12 1 * * *` | 300 |
| `/api/internal/line-credit-digest` | `3 2 * * *` | 300 |
| `/api/internal/student-promotions/july-1` | `5 17 30 6 *` | 800 |

- Minute-stagger is deliberate and **fully test-enforced**: `src/__tests__/vercel-crons.test.ts` pins all 17 schedules exactly (`:17-35`, `:99-104`), then expands every cron field — wildcard, list, range, step — and asserts that **no two crons can fire in the same UTC minute** (`:107-127`). Two named regressions are pinned on top: the Wise Activity mirror runs every 15 minutes (`2,17,32,47`) rather than the usual 30, because it is the only source of feedback-submission timestamps and an event written minutes before a 23:59:59.999 Bangkok deadline must be mirrored the same evening (`:138-145`); and the LINE credit digest holds 09:03 Bangkok (`:169-172`).
- Two schedules changed since the previous revision: Wise Activity moved from `5,35` to `2,17,32,47`, and Competitor Intelligence from `25 18 * * 0` to `28 18 * * 0`. Two crons are new: `post-class-feedback/payout-accrual` (`33 * * * *`) and `line-credit-digest` (`3 2 * * *`).
- **The hourly payout-accrual cron is the unattended money path.** It runs `runPayoutAccrualPass()` then `runPayoutFinalizePass()`, the latter no-opping with `{ skipped: "window-not-ended" }` until the 26th-to-25th window has closed (`src/app/api/internal/post-class-feedback/payout-accrual/route.ts:13-38`). It is registered `dangerous: true` (confirm-gated in the Data Health UI) and is doubly flag-gated: `POST_CLASS_AUTO_APPROVE_ENABLED` must be the exact string `"true"` for unattended approval, and `POST_CLASS_PAYOUT_WRITES_ENABLED` must be `"true"` for any Sheets write. The reopen sweep is deliberately *not* behind the auto-approve flag — reopening restores safety, approving moves money (`src/lib/post-class-feedback/payout-config.ts:159-168`). Grace defaults to 24 hours and rejects blank or malformed values rather than coercing `""` to an immediate-approval `0` (`:184-190`); an explicit `"0"` remains a legitimate immediate-approval mode. The signing actor is `system:post-class-auto-approve`.
- Cron auth: `getCronSecretStatus()` compares `Authorization` against `Bearer ${CRON_SECRET}` with `timingSafeEqual` after a length pre-check; missing secret → 500, mismatch → 401 (`src/lib/internal/cron-auth.ts:6-25`, REL-07). **16 of the 22 internal route files import that shared helper; 6 declare their own local equivalent** with identical length-pre-check + `timingSafeEqual` logic — `sync-wise`, `sync-sales-dashboard`, `sync-credit-control`, `sync-competitor-intelligence`, `student-promotions/july-1`, and `sync-room-utilization`.
- 21 of the 22 internal routes wrap their work in `withCronInvocationAudit(...)`, writing a `cron_invocations` row keyed by registry job key and trigger source — the substrate the watchdog and `/data-health` read. The lone exception is `student-promotions/july-1`, the annual one-shot. Health derivation handles that explicitly rather than by accident: because the route is un-wrapped **and** its run table mixes admin drafts with the cron apply, `getCronJobsHealth` refuses to borrow the room-utilization run-table fallback and returns no evidence at all, so the job fails closed to `unknown` (which is alertable) instead of reporting a dangerous write-path cron as healthy without it ever firing (`src/lib/data-health/dashboard.ts:274-285`).
- Admin-session manual triggers: six routes fall back to an authenticated session when the cron secret is absent or invalid — `sync-wise`, `sync-sales-dashboard`, `sync-credit-control`, `sync-progress-tests`, `sync-room-utilization` (POST-only), and `sync-competitor-intelligence` (which requires a feature-scoped session via `requireCompetitorIntelligenceSession()`). `admissions-notifications`, `cron-watchdog`, `sync-leave-requests`, and `student-promotions/july-1` expose POST but keep it cron-secret-only; `july-1` proxies POST straight to GET and additionally refuses to run on any Bangkok date other than its target date.
- **Manual-only internal routes** — present in the cron registry with `schedule: null`, absent from `vercel.json`, reachable from the Data Health UI or a script: `/api/internal/post-class-feedback/admin-digest`, `/reminder-day-after`, `/reminder-deadline` (all three `dangerous`), `/api/internal/sync-room-utilization` (also driven by `npm run room-utilization:sync`), and `/api/internal/line-backlog-recovery`. Registry total: **22 jobs = 17 scheduled + 5 manual-only** (`src/lib/data-health/cron-registry.ts`), matching the 22 `route.ts` files under `src/app/api/internal/` exactly.
- The previously documented credit-control drift is **resolved**: the registry now declares `maxDurationSeconds: 800` (`cron-registry.ts:122`), matching the route's own `maxDuration = 800`, so a legitimate 301–800s run no longer reports `failing`. Room Capacity's remaining caveat stands — utilization is `stable`, but the forecast/month engines have no UI caller and the sync is `manualOnly`.

## Environment Configuration

**Validated at startup (Zod, `src/lib/env.ts`)** — 18 declared vars; invalid or missing required ones throw at module load, logging only `fieldErrors`:
- Required (9, of which 2 carry defaults): `DATABASE_URL` (URL), `AUTH_GOOGLE_ID`, `AUTH_GOOGLE_SECRET`, `AUTH_SECRET`, `WISE_USER_ID`, `WISE_API_KEY`, `CRON_SECRET`, plus `WISE_NAMESPACE` (default `begifted-education`) and `WISE_INSTITUTE_ID` (default `696e1f4d90102225641cc413`).
- Optional (9): `LINE_CHANNEL_SECRET`, `LINE_CHANNEL_ACCESS_TOKEN`, `ENABLE_LINE_SCHEDULER`, `LINE_SCHEDULE_BOT_ADMIN_IDS`, `ENABLE_STUDENT_SCHEDULE_LIVE`, `STUDENT_SCHEDULE_LINK_TTL_DAYS` (coerced positive int), `APP_BASE_URL` (URL), `MAINTENANCE_MODE`, `MAINTENANCE_BYPASS_EMAILS`.
- `MAINTENANCE_MODE` and `MAINTENANCE_BYPASS_EMAILS` are declared here **for inventory parity only** — `src/middleware.ts` runs on the edge and reads `process.env` directly, because this module throws on a partial env (`env.ts:28-31`).

**Read directly via `process.env` (not in the Zod schema)** — grouped by integration. Reconciled inventory: [reference/env](../../docs/reference/env.md).
- Wise writeback gates: `WISE_SESSION_OPERATIONS_VERIFIED`, `WISE_SESSION_CREATE_VERIFIED`, `WISE_SESSION_SUBJECT_UPDATE_VERIFIED`
- OpenAI: `OPENAI_API_KEY`, `OPENAI_SCHEDULER_MODEL`, `OPENAI_SCHEDULER_SHADOW_MODEL`, `OPENAI_SCHEDULER_REASONING_EFFORT`, `OPENAI_PROGRESS_TEST_MODEL`, `OPENAI_POST_CLASS_FEEDBACK_MODEL`, `OPENAI_COMPETITOR_INTEL_MODEL`, `ENABLE_AI_SCHEDULER`, `ENABLE_COMPETITOR_AI`
- LINE: `LINE_VALIDATION_LEAD_EMAILS`
- Google Sheets: `SALES_DASHBOARD_CONNECTED_EMAIL` (consumed only as the leave-requests fallback — `src/lib/leave-requests/config.ts:12`), `LEAVE_REQUESTS_SPREADSHEET_ID`, `LEAVE_REQUESTS_SHEET_NAME`, `LEAVE_REQUESTS_CONNECTED_EMAIL`
- Payout target (Sheets + Drive; all eight mandatory at the operation boundary — no source-code fallbacks, because publishing moves money): `POST_CLASS_PAYOUT_TARGET` (`scratch`|`production`), `POST_CLASS_PAYOUT_CONNECTED_EMAIL`, `POST_CLASS_PAYOUT_DRIVE_FOLDER_ID`, `POST_CLASS_PAYOUT_WORKBOOKS_FOLDER_ID`, `POST_CLASS_PAYOUT_MASTER_SPREADSHEET_ID`, `POST_CLASS_PAYOUT_SOURCE_SHEET_NAME`, `POST_CLASS_PAYOUT_DEDUCTIONS_SHEET_NAME`, `POST_CLASS_PAYOUT_COMPOSITE_SHEET_NAME`. Plus the two kill switches `POST_CLASS_PAYOUT_WRITES_ENABLED` and `POST_CLASS_AUTO_APPROVE_ENABLED` (each enabled only by the exact string `true`) and `POST_CLASS_AUTO_APPROVE_GRACE_HOURS`. `requirePayoutGoogleTarget()` cross-checks `VERCEL_ENV`: a production deployment must target `production`, a preview must target `scratch` (`src/lib/post-class-feedback/payout-config.ts:112-128`).
- Apps Script email: `SCHEDULE_EMAIL_APPS_SCRIPT_URL`, `SCHEDULE_EMAIL_APPS_SCRIPT_SECRET`, `SCHEDULE_EMAIL_BACKUP_APPS_SCRIPT_URL`, `SCHEDULE_EMAIL_BACKUP_APPS_SCRIPT_SECRET`, `SCHEDULE_EMAIL_SENDER_NAME`, `SCHEDULE_EMAIL_REPLY_TO`, `SCHEDULE_EMAIL_PUBLIC_BASE_URL`
- Resend: `RESEND_API_KEY`, `ADMISSIONS_EMAIL_FROM`, `ADMISSIONS_EMAIL_REPLY_TO`
- Competitor intelligence: `APIFY_API_TOKEN`, `APIFY_INSTAGRAM_ACTOR`, `APIFY_FACEBOOK_ACTOR`, `DATAFORSEO_LOGIN`, `DATAFORSEO_PASSWORD`, `COMPETITOR_APIFY_COST_PER_ITEM_USD`, `COMPETITOR_DATAFORSEO_COST_PER_QUERY_USD`, `COMPETITOR_INTEL_MONTHLY_CAP_USD`, `COMPETITOR_{PROVIDER}_MONTHLY_CAP_USD` (dynamic name, e.g. `COMPETITOR_DATAFORSEO_MONTHLY_CAP_USD`)
- Base-URL resolution, three independent ladders: schedule-bot and credit-digest links use `APP_BASE_URL` → hardcoded default (`src/lib/line/schedule-bot.ts:135`, `schedule-bot-group.ts:134`, `credit-digest.ts:354`); schedule-email links use `SCHEDULE_EMAIL_PUBLIC_BASE_URL` → `VERCEL_PROJECT_PRODUCTION_URL` → `VERCEL_URL` → default (`schedule-email.ts:266`); the shared `APP_BASE_URL` constant used by digests and the watchdog resolves `NEXT_PUBLIC_APP_URL` → `SCHEDULE_EMAIL_PUBLIC_BASE_URL` → `VERCEL_URL` → `https://bgscheduler.vercel.app` (`src/lib/leave-requests/config.ts:17-21`).
- Ops / scripts / tests: `SEED_ADMIN_EMAILS`, `TEST_DATABASE_URL`, `CONFIRM_DELETE_LINE_TEST_DATA`, `PRODUCTION_BRANCH`, `GITHUB_ACTOR`, `TZ`, and the Vercel-injected `VERCEL_ENV` / `VERCEL_URL` / `VERCEL_PROJECT_PRODUCTION_URL`.

**Secrets location:**
- Production: Vercel project environment variables (UI-managed).
- CI: literal dummy values inlined in `.github/workflows/ci.yml` — no repository secrets are consumed by either workflow.
- Local: `.env.local` (gitignored). `.env.example` documents 40 vars including the full payout block, but is **incomplete** relative to code — it omits `OPENAI_SCHEDULER_SHADOW_MODEL`, `OPENAI_SCHEDULER_REASONING_EFFORT`, `OPENAI_PROGRESS_TEST_MODEL`, `OPENAI_POST_CLASS_FEEDBACK_MODEL`, `OPENAI_COMPETITOR_INTEL_MODEL`, `ENABLE_COMPETITOR_AI`, every `APIFY_*` / `DATAFORSEO_*` / `COMPETITOR_*` var, `RESEND_API_KEY` and the `ADMISSIONS_EMAIL_*` pair, `LINE_VALIDATION_LEAD_EMAILS`, the three `WISE_SESSION_*_VERIFIED` gates, `SALES_DASHBOARD_CONNECTED_EMAIL`, `SCHEDULE_EMAIL_PUBLIC_BASE_URL`, `POST_CLASS_AUTO_APPROVE_GRACE_HOURS`, and — most consequentially — `POST_CLASS_AUTO_APPROVE_ENABLED`, the switch that arms unattended charging.

## Webhooks & Callbacks

**Incoming:**
- `POST /api/line/webhook` — LINE Messaging webhook. Middleware-public but HMAC-SHA256 signature-verified against `LINE_CHANNEL_SECRET`; 503 when the LINE scheduler is disabled, 401 on bad signature, 400 on bad JSON. Scheduler classification and group-command handling are deferred to `after()` with lazy imports; `maxDuration = 60`. Blocked during maintenance mode by design (MAINT-04) — LINE does not redeliver, so those messages are lost rather than queued.
- `GET /api/internal/*` — Vercel Cron triggers for the 17 scheduled jobs (Bearer `CRON_SECRET`). Ten of the 22 internal routes also expose `POST`; see the admin-session note under *Cron* for which of those accept a session instead.
- `GET|POST /api/auth/[...nextauth]` — Auth.js Google OAuth callbacks.
- Middleware-allowlisted endpoints that still enforce their own credential: `POST /api/search/assistant` (session → 401), `GET|OPTIONS /api/line/contacts/oa-resolver/worklist` and `/api/line/contacts/oa-resolver/runs/{id}/rows` (opaque bearer resolver token → 401, CORS `*`), and the capability-token page `/schedule/{token}`. Genuinely open: `GET /api/classrooms/floor-plan-map`.

**Outgoing:**
- Wise (`https://api.wiseapp.live`) — pull-heavy ETL plus six gated write paths. No Wise webhook subscription; the activity feed is polled newest-first every 15 minutes.
- LINE (`https://api.line.me`) — profile fetch, follower enumeration, message push, reply-token reply.
- OpenAI (`https://api.openai.com/v1/responses`).
- Google — Sheets v4 (`https://sheets.googleapis.com`), OAuth token refresh (`https://oauth2.googleapis.com/token`), Drive upload (`https://www.googleapis.com/upload/drive/v3/files`), and the deployed Apps Script web app at whatever URL `SCHEDULE_EMAIL_APPS_SCRIPT_URL` names.
- Resend (`https://api.resend.com/emails`).
- Apify (`https://api.apify.com/v2/acts/...`), DataForSEO (`https://api.dataforseo.com/v3/serp/...`), and direct fetches of competitor websites.

## Surface Counts (this snapshot)

- API endpoints: **243** — 241 named `export async function GET|POST|PUT|PATCH|DELETE` handlers across 180 `route.ts` files, **plus 2** for the Auth.js catch-all, which destructures its methods (`export const { GET, POST } = handlers`) and matches no `function` grep. The two CORS-preflight `OPTIONS` handlers on the public OA-resolver routes are excluded as carrying no business surface. Largest groups: admissions 61, internal 31, line 29, sales-dashboard 13, post-class-feedback 13.
- Pages: **31** `page.tsx` files — **26** under `src/app/(app)/` (including the `/compare` legacy redirect and the new `/student-report`), plus `/login`, the public `/schedule/[token]`, and three `(print)` report surfaces (`learning-plans`, `student-schedule`, `student-report`).
- Vercel crons: **17** registered (table above); the cron registry defines **22** jobs, the other 5 being manual-only.
- DB: **189** tables, **61** enums, **69** migrations.
- Tests: **389** test files. `npm test` runs the `unit` project; the `integration` project covers **13** `*.integration.test.ts` files via Testcontainers Postgres (10 under `src/lib/post-class-feedback/`, 3 under `src/lib/sync/`) and does not run in CI.
- `src/lib` modules (35): `__tests__`, `admissions`, `ai`, `auth`, `calendar`, `classrooms`, `competitor-intelligence`, `credit-control`, `data`, `data-health`, `db`, `home`, `internal`, `learning-plans`, `leave-requests`, `line`, `navigation`, `normalization`, `ops`, `payroll`, `post-class-feedback`, `progress-tests`, `proposals`, `room-capacity`, `sales-dashboard`, `scheduler`, `search`, `student-promotions`, `student-report`, `student-schedule`, `syllabus`, `sync`, `ui`, `us-universities`, `wise`, `wise-activity`.

---

_Verified against main@0cd1e81 (clean tree) on 2026-09-02._
