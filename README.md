# Tutor Availability Search Tool

Internal admin app for searching tutor availability from normalized Wise snapshots.

## Current Status

- Production app: [https://bgscheduler.vercel.app](https://bgscheduler.vercel.app)
- Repo: [https://github.com/kasheesh711/bgscheduler](https://github.com/kasheesh711/bgscheduler)
- Stack: Next.js 16 App Router, TypeScript, Tailwind, shadcn/ui, Auth.js, Drizzle, Neon Postgres, Vercel
- Test status: 281 passing Vitest unit tests
- Wise status: production sync live since 2026-04-07 (131 teachers, 72 groups, 30-minute cron)
- Compare UI: side-by-side search and compare workspace with weekly/day schedule views, tutor combobox, discovery modal, and student-level conflict detection
- Class assignments: native `/class-assignments` workspace for local room assignment, admin overrides, teacher schedules, and explicit Wise OFFLINE location publishing
- Latest compare fixes: week view uses per-tutor lanes for 2-3 tutors, session cards use normalized RGBA fills, and online/onsite styling now prefers Wise identity/session evidence over raw location strings
- Vercel cadence: Pro plan with 30-minute Wise sync cron

## Product Rules

- Wise is the only production source of truth.
- Search runs on normalized, persisted Wise snapshots plus a warm in-memory index.
- Never return a tutor as available unless availability is provable from Wise-derived data.
- Unresolved identity, modality, or qualification must route to `Needs Review`, never `Available`.
- Cancelled sessions must not block availability.
- All times are normalized to `Asia/Bangkok`.

## Wise API Contract

The live Wise integration currently expects:

- Base URL: `https://api.wiseapp.live`
- Headers:
  - `Authorization: Basic <base64(userId:apiKey)>`
  - `x-api-key: <apiKey>`
  - `x-wise-namespace: begifted-education`
  - `user-agent: VendorIntegrations/begifted-education`

Important live payload details:

- `GET /institutes/{centerId}/teachers` returns `data.teachers`
- teacher identity is nested under `teacher.userId._id` and `teacher.userId.name`
- teacher tags in the live tenant are plain strings, not `{ name }` objects
- `GET /institutes/{centerId}/teachers/{wiseUserId}/availability` expects `startTime` and `endTime`
- availability is returned under `data.workingHours` and `data.leaves`
- `workingHours.slots[].day` can be weekday strings like `"Sunday"`
- `GET /institutes/{centerId}/sessions` expects `paginateBy=COUNT&page_number=...&page_size=...`
- sessions are returned under `data.sessions`
- `GET /institutes/{centerId}/locations` returns Wise location strings under `data.locations`
- `PUT /teacher/classes/{classId}/sessions/{sessionId}?updateType=SINGLE` updates one session; the app only uses it to publish `location` for eligible `OFFLINE` rows after admin confirmation

## Classroom Assignments

- `/class-assignments` generates room assignments locally from the active Wise snapshot for one Bangkok date.
- Assignment runs preserve admin override rooms unless the admin chooses force reassign.
- Local rooms are stored in `classroom_rooms` and seeded from the 24-room BeGifted catalog.
- Wise writeback is deliberately conservative: `Publish to Wise` updates only eligible `OFFLINE` session locations with reliable capacity and Wise class/session IDs. Online booth assignments stay local.
- Run `npm run db:migrate` before using this feature in production so the classroom tables and new Wise session columns exist.

## Local Development

Install dependencies and run the app:

```bash
npm install
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

Required environment variables:

```bash
DATABASE_URL=
AUTH_GOOGLE_ID=
AUTH_GOOGLE_SECRET=
AUTH_SECRET=
WISE_USER_ID=
WISE_API_KEY=
WISE_NAMESPACE=begifted-education
WISE_INSTITUTE_ID=696e1f4d90102225641cc413
CRON_SECRET=

# Required for classroom schedule email sending
SCHEDULE_EMAIL_APPS_SCRIPT_URL=
SCHEDULE_EMAIL_APPS_SCRIPT_SECRET=
SCHEDULE_EMAIL_SENDER_NAME=BeGifted
SCHEDULE_EMAIL_REPLY_TO=kevhsh7@gmail.com
```

Classroom schedule emails are sent through a private Google Apps Script Web App
owned by `kevhsh7@gmail.com`. See [docs/apps-script-schedule-email.md](docs/apps-script-schedule-email.md)
for the relay script and deployment steps.

## Useful Commands

```bash
npm test
npm run build
npm run db:generate
npm run db:migrate
npm run db:seed
```

Manual sync trigger:

```bash
curl -X POST https://bgscheduler.vercel.app/api/internal/sync-wise \
  -H "Authorization: Bearer $CRON_SECRET"
```

## Documentation

- [AGENTS.md](/Users/kevinhsieh/Desktop/Scheduling/AGENTS.md): current implementation inventory and operating rules
- [PRD.md](/Users/kevinhsieh/Desktop/Scheduling/PRD.md): product requirements and launch status
- [DATA_AUDIT.md](/Users/kevinhsieh/Desktop/Scheduling/DATA_AUDIT.md): data audit and normalization status
- [WISE_COMPARISON.md](/Users/kevinhsieh/Desktop/Scheduling/WISE_COMPARISON.md): migration decision record from sheets to Wise
