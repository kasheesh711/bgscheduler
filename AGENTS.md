<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

# AGENTS.md — Tutor Availability Search Tool

## Status: Deployed — Wise API integration pending

The application is fully built, tested, deployed, and accessible at https://bgscheduler.vercel.app. Google OAuth login works. The Wise API sync is blocked on a namespace mismatch error that requires Wise admin resolution.

## What Is Built

### Infrastructure (complete)
- Next.js 16 App Router + TypeScript + Tailwind + shadcn/ui
- Auth.js with Google provider + `admin_users` table for explicit email allowlisting
- Drizzle ORM + Neon Postgres (ap-southeast-1) with 14 tables
- Vercel hosting with daily cron (Hobby plan limit; upgrade to Pro for 30-min cadence)
- Vitest with 63 passing unit tests

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

### Wise API client (complete, pending credential fix)
- HTTP client with retry/backoff (3 retries, 1s/2s/4s) and concurrency limiter (max 5)
- Base URL: `https://api.wiseapp.live/api/v1`
- Auth: Basic Auth (base64 of userId:apiKey) + `x-api-key` + `user-agent: VendorIntegrations/{namespace}`
- Paginated fetchers for teachers, availability (7-day window limit), and future sessions
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
- **Recurring mode**: tutor blocked if any future session overlaps same weekday+time
- **One-time mode**: tutor blocked only if session overlaps exact date+time
- Leaves block in both modes
- Multi-slot intersection: tutors available in ALL requested slots
- Qualification filtering by subject/curriculum/level
- Modality filtering: online/onsite/either
- Fail-closed: unresolved identity/modality/qualification → Needs Review, never Available

### API routes (complete)
- `POST /api/search` — zod-validated search request, auth-protected, returns perSlotResults + intersection + snapshotMeta + latencyMs
- `GET /api/data-health` — sync status, issue counts by type, unresolved aliases/modality/tags, recent sync history
- `POST /api/internal/sync-wise` — cron-triggered sync, CRON_SECRET auth

### Frontend (complete)
- `/login` — Google sign-in with access-denied error handling
- `/search` — structured slot builder (day/date dropdowns, 15-min time pickers), mode toggle (recurring/one-time), modality/subject/curriculum/level filters, tabbed results with per-slot + intersection views, Needs Review section with reason badges, stale snapshot banner
- `/data-health` — sync status cards, snapshot stats, issues by type, unresolved aliases table, unresolved modality table, unmapped tags table, recent sync history

### Tests (63 passing)
- Identity: nickname extraction, alias resolution, online/offline pairs, unresolved → data_issue
- Timezone: UTC→Asia/Bangkok conversion, weekday derivation, minute-of-day
- Availability: workingHours normalization, window de-duplication, merge overlapping
- Leaves: UTC conversion, overlapping merge
- Sessions: blocking vs non-blocking status, cancelled exclusion
- Modality: pair derivation, session type evidence, unresolved → data_issue
- Qualifications: tag parsing (Int./Thai/ExamPrep), unmapped → data_issue
- Search engine: recurring blocking, one-time blocking, cancelled non-blocking, mode filtering, qualification filtering, multi-slot intersection, Needs Review routing
- Parser: single/multi slot parsing, abbreviated days, ambiguous input warnings

## Current Blocker

**Wise API namespace mismatch.** The Wise API at `api.wiseapp.live` returns `400 Namespace mismatch` despite using the confirmed namespace `begifted-education`. Authentication passes (401→400 after adding Basic Auth). The namespace is sent via `user-agent: VendorIntegrations/begifted-education`. Wise admin needs to verify the credential-namespace binding on their side.

## What Remains After Blocker Is Resolved

1. Confirm Wise API credentials work end-to-end
2. Trigger first successful sync
3. Verify search results against live Wise data
4. Add Vercel production redirect URI to Google OAuth if not done
5. Upgrade Vercel to Pro plan for 30-minute cron cadence (currently daily on Hobby)

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
