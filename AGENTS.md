<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

# AGENTS.md — Tutor Availability Search Tool

## Status: Live — production sync active, daily cron running

The application is fully built, tested, deployed, and live at https://bgscheduler.vercel.app. Google OAuth login works. Production Wise sync is active with daily cron.

## What Is Built

### Infrastructure (complete)
- Next.js 16 App Router + TypeScript + Tailwind + shadcn/ui
- Auth.js with Google provider + `admin_users` table for explicit email allowlisting
- Drizzle ORM + Neon Postgres (ap-southeast-1) with 14 tables
- Vercel hosting with daily cron (Hobby plan limit; upgrade to Pro for 30-min cadence)
- Vitest with 82 passing unit tests

### Database schema (complete, migrated, seeded)
- `snapshots` — versioned snapshot records with atomic `active` flag promotion
- `sync_runs` — sync metadata, status, timestamps, error summary
- `admin_users` — 8 allowlisted admin emails
- `tutor_identity_groups` — logical merged tutor grouping
- `tutor_identity_group_members` — Wise teacher/user IDs per group
- `tutor_aliases` — 4 seeded aliases (Kev→Kevin, Paoju→Paojuu, Poi→Nacha (Poi), Sam→Samantha)
- `tutors` — logical tutor display records
- `raw_teacher_tags` — original Wise tags per teacher
- `subject_level_qualifications` — normalized subject/curriculum/level/examPrep
- `recurring_availability_windows` — weekday + time + modality per group
- `dated_leaves` — exact leave windows for 180-day horizon
- `future_session_blocks` — blocking windows from Wise sessions
- `data_issues` — all unresolved normalization issues by type and severity
- `snapshot_stats` — counts for data-health dashboard

### Wise API client (repaired)
- HTTP client with retry/backoff (3 retries, 1s/2s/4s) and concurrency limiter (max 5)
- Base URL: `https://api.wiseapp.live`
- Auth: Basic Auth (base64 of userId:apiKey) + `x-api-key` + `x-wise-namespace` + `user-agent: VendorIntegrations/{namespace}`
- Fetchers aligned to the live Wise request/response contracts for teachers, availability, and future sessions
- 180-day leave stitching across 26 seven-day windows

### Normalization pipeline (complete)
- **Identity resolution** — 5-step cascade: nickname extraction via regex → alias table lookup → online/offline pair detection → unresolved → data_issue
- **Qualifications** — Wise tags parsed into subject/curriculum/level/examPrep via regex; unmapped tags → data_issue
- **Availability** — workingHours → recurring windows with overlapping merge and de-duplication
- **Leaves** — UTC→Asia/Bangkok conversion, overlapping leave merge
- **Sessions** — blocking status classification (CANCELLED/CANCELED=non-blocking, unknown=blocking fail-closed)
- **Modality** — derived from pair structure → session type → location → unresolved; never guessed
- **Timezone** — all conversions locked to Asia/Bangkok

### Sync orchestrator (complete)
- Full pipeline: fetch teachers → resolve identities → fetch availability/leaves per teacher → fetch future sessions → normalize qualifications → derive modality → write to snapshot tables → validate → atomic promote
- Failed syncs preserve previous active snapshot
- Completeness threshold: >50% unresolved identity groups prevents promotion
- Exposed at `POST /api/internal/sync-wise` (CRON_SECRET protected)

### Search engine (complete)
- In-memory index singleton loaded from active Postgres snapshot
- Stale detection: compares index snapshotId against DB on each request
- **Range search**: admin enters time window + class duration → backend generates sub-slots → availability grid
- **Recurring mode**: tutor blocked if any future session overlaps same weekday+time
- **One-time mode**: tutor blocked only if session overlaps exact date+time (supports drop-in classes via cancelled slots)
- Leaves block in both modes
- Qualification filtering by subject/curriculum/level (data-driven dropdowns)
- Modality filtering: online/onsite/either
- Fail-closed: unresolved identity/modality/qualification → Needs Review, never Available

### Compare engine (complete)
- Reads from the same in-memory SearchIndex singleton — no additional DB queries
- **Date-range filtering** — all compare queries are scoped to a specific week (Monday–Sunday). The `weekStart` parameter defaults to the current week in Asia/Bangkok. Sessions are filtered by actual `startTime` date, eliminating duplicate recurring instances
- **Schedule assembly** (`buildCompareTutor`) — transforms IndexedTutorGroup into CompareTutor with sessions filtered by date range + weekday, weekly hours booked, distinct student count, and per-session modality resolved from Wise teacher/session evidence. **Weekday fallback**: for weekdays with no sessions in the date range (e.g. past days not fetched by Wise FUTURE API), pulls the nearest future occurrence deduped by `recurrenceId`
- **Conflict detection** (`detectConflicts`) — finds same student with overlapping sessions across different selected tutors (case-insensitive name matching, deduped by student+day+tutor pair)
- **Shared free slots** (`findSharedFreeSlots`) — computes time ranges where ALL selected tutors are simultaneously free by subtracting blocking sessions (within the date range) from availability windows and intersecting intervals across tutors (minimum 30-minute threshold)
- **Discovery** — filters all tutors by subject/level/mode/time, pre-computes conflict status against existing selected tutors, sorts by conflicts then availability

### API routes (complete)
- `POST /api/search/range` — range search: time window + duration → availability grid with sub-slots
- `POST /api/search` — legacy slot-based search (kept for backward compatibility)
- `GET /api/filters` — distinct subjects, curriculums, levels from active snapshot for dropdown population
- `GET /api/data-health` — sync status, issue counts by type, unresolved aliases/modality/tags, recent sync history
- `POST /api/internal/sync-wise` — cron-triggered sync, CRON_SECRET auth
- `POST /api/compare` — compare 1-3 tutors: accepts optional `weekStart` (ISO date, defaults to current week), returns week-scoped schedules, student-level conflicts, shared free slots, and `weekStart`/`weekEnd` in response
- `POST /api/compare/discover` — find candidate tutors with subject/level/mode/time filters and pre-computed conflict status against existing selected tutors
- `GET /api/tutors` — all tutor names/IDs/modes/subjects from active snapshot (used by tutor combobox)

### Frontend (complete)

#### Design system
- **Color palette**: Sky blue primary (OKLCH hue 230) + amber accent (hue 75), cream backgrounds
- **Semantic color tokens**: `--available` (green), `--blocked` (amber), `--conflict` (red), `--free-slot` (green) mapped in Tailwind as `bg-available`, `text-conflict`, etc.
- **Layout**: Side-by-side split — search (left 50%) + compare (right 50%). Viewport-height with `overflow-hidden` on body, panels scroll internally. No page-level or horizontal scroll. `px-4 lg:px-6` padding.
- **Shared navigation**: `AppNav` component in `(app)` route group layout — persistent top bar with sky blue brand name, active link indicators. Login page excluded (no nav).
- **Fonts**: Inter + JetBrains Mono. Dark mode supported.
- **Session block colors**: Shared `session-colors.ts` module provides RGBA fills (28% bg opacity, 35% frame opacity), solid text colors, and solid 3px left borders. All cards use consistent solid styling — unreliable online/onsite detection removed from visual rendering.
- **Free-gap indicators**: `computeFreeGaps()` helper in week-overview subtracts session blocks from availability windows; only genuinely free time slots are rendered with subtle `bg-available/8` green tint. No per-tutor colored bands.
- **Date format**: D/M throughout compare view (e.g. "Mon 6/4", header "6 Apr – 12 Apr, 2026").
- **Tutor colors**: `TUTOR_COLORS = ["#3b82f6", "#e67e22", "#7c3aed"]` (sky blue, amber, purple)

#### Pages
- `/login` — Google sign-in with warm gradient background, sky blue title, access-denied error handling
- `/search` — side-by-side workspace:
  - **Left panel (Search)**: compact 3-column search form, mode toggle (recurring/one-time), data-driven dropdown filters (subject/curriculum/level), availability grid results (table-fixed, no horizontal scroll), row selection with copy-for-parents button, "Compare (N)" button (sends selected tutors to right panel), recent searches (localStorage, last 10), Needs Review section
  - **Right panel (Compare)**: tutor selector chips (max 3, color-coded, removable) + searchable tutor combobox dropdown (shadcn Command+Popover, fetches from `GET /api/tutors`), "Advanced search" link opens discovery modal (shadcn Dialog), **week picker** (prev/next arrows, week label "6 Apr – 12 Apr, 2026", Today button to reset to current week), week/day sub-tabs with D/M dates (e.g. "Mon 6/4"), GCal-style weekly time grid (7AM–9PM vertical axis, Mon–Sun sticky headers, full-width cards for single-tutor view and per-tutor lanes for 2-3 tutor view, sub-column cap at 3 single-tutor / 2 multi-tutor with "+N more" overflow badges, free-gap green indicators for available-but-unbooked time, vertical scrolling), day drill-down (side-by-side tutor columns with positioned session blocks), conflict bands + summary, shared free slot indicators, tutor profile popover, URL param support (`?tutors=id1,id2`)
- `/compare` — redirects to `/search` (backward compatibility for bookmarked URLs, preserves `?tutors=` param)
- `/data-health` — full-width sync status cards, snapshot stats, issues by type, unresolved aliases/modality/unmapped tags tables, recent sync history

#### Known UX Issues
- **Past-day session fallback**: Wise's FUTURE API omits past sessions. `buildCompareTutor` falls back to the nearest future occurrence (deduped by `recurrenceId`) for weekdays with no data in the selected range. One-time past sessions cannot be recovered.

### Tests
- Identity: nickname extraction, alias resolution, online/offline pairs, unresolved → data_issue
- Timezone: UTC→Asia/Bangkok conversion, weekday derivation, minute-of-day
- Availability: workingHours normalization, string weekday mapping, window de-duplication, merge overlapping
- Leaves: UTC conversion, overlapping merge
- Sessions: blocking vs non-blocking status, cancelled exclusion, nested user mapping
- Modality: pair derivation, session type evidence, unresolved → data_issue
- Qualifications: tag parsing (Int./Thai/ExamPrep), unmapped → data_issue
- Search engine: recurring blocking, one-time blocking, cancelled non-blocking, mode filtering, qualification filtering, multi-slot intersection, Needs Review routing
- Compare engine: buildCompareTutor (date range + weekday filtering, weekday fallback for missing data, weekly hours, student count), detectConflicts (same student overlap, different students, non-overlapping times), findSharedFreeSlots (date-range-scoped interval intersection across tutors)
- Wise contract: auth headers, teacher list parsing, availability envelope parsing, sessions pagination parsing
- Parser: single/multi slot parsing, abbreviated days, ambiguous input warnings

## Production Status

First successful production sync completed 2026-04-07 on commit `c673999`:
- Snapshot `d70608b0-0f2d-4738-b9b4-1f3fd5210fea` promoted successfully
- 131 teachers fetched, 72 identity groups resolved, 251 data issues logged
- Sync duration: ~4m26s (Vercel function ceiling is 5m)
- Daily cron active (`0 0 * * *`)

### Optional improvements
- Upgrade Vercel to Pro for 30-minute sync cadence (currently daily on Hobby)
- Monitor sync duration headroom — ~34s margin before function timeout at current data volume

## Source of Truth Rules
- Production truth comes from the Wise API only (tenant: `begifted-education`, institute: `696e1f4d90102225641cc413`).
- Search runs against precomputed normalized Wise snapshots + warm in-memory index.
- No production fallback to Google Sheets or `.xlsx` files.

## Non-Negotiable Product Rules
- Never return a tutor as available unless the system can prove availability from normalized Wise data.
- Unresolved identity, modality, or qualification → `Needs review`, never `Available`.
- Cancelled sessions must not block availability.
- All times normalized to `Asia/Bangkok`.

## Stack
- Next.js 16 App Router + TypeScript + Tailwind + shadcn/ui
- Auth.js with Google provider + admin allowlisting in Postgres
- Drizzle ORM + Neon Postgres (ap-southeast-1)
- Vercel hosting + Vercel Cron (daily on Hobby; 30-min on Pro)
- In-memory search index (< 400ms warm queries)
- Vitest for unit testing

## Deployment
- **Production**: https://bgscheduler.vercel.app
- **Repo**: https://github.com/kasheesh711/bgscheduler
- **Deploy**: `npx vercel --prod` or push to `main` (once Git integration triggers)
- **Database**: Neon Postgres `ep-calm-mud-a1d7pmsi.ap-southeast-1.aws.neon.tech`

## Environment Variables (9 required)
| Variable | Description |
|----------|-------------|
| `DATABASE_URL` | Neon Postgres connection string |
| `AUTH_GOOGLE_ID` | Google OAuth client ID |
| `AUTH_GOOGLE_SECRET` | Google OAuth client secret |
| `AUTH_SECRET` | Auth.js session encryption key |
| `WISE_USER_ID` | Wise API user ID |
| `WISE_API_KEY` | Wise API key |
| `WISE_NAMESPACE` | `begifted-education` |
| `WISE_INSTITUTE_ID` | `696e1f4d90102225641cc413` |
| `CRON_SECRET` | Protects sync endpoint from unauthorized calls |

## Admin Users (8 allowlisted)
- aoengnatchasmith@gmail.com
- k.waritpariya@gmail.com
- kevhsh7@gmail.com
- kevinhsieh711@gmail.com
- kittiya.carekt@gmail.com
- pakwalaan@gmail.com
- panida.wiya@gmail.com
- suphitsaramanosamrit@gmail.com

## Change Control
- Do not weaken the strict-fidelity rule without explicit user approval.
- Do not replace the locked stack without explicit user approval.
- Do not introduce sheet fallback without explicit user approval.
- If Wise behavior or tenant modeling changes, update the documentation before changing system behavior.
