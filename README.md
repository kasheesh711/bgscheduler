# Tutor Availability Search Tool

Internal admin app for searching tutor availability from normalized Wise snapshots.

## Current Status

- Production app: [https://bgscheduler.vercel.app](https://bgscheduler.vercel.app)
- Repo: [https://github.com/kasheesh711/bgscheduler](https://github.com/kasheesh711/bgscheduler)
- Stack: Next.js 16 App Router, TypeScript, Tailwind, shadcn/ui, Auth.js, Drizzle, Neon Postgres, Vercel
- Test status: 70 passing Vitest tests
- Wise status: credentials and namespace are valid; the client contract drift has been repaired locally
- Remaining launch work:
  - run a successful DB-backed Wise sync
  - validate live search results against Wise data
  - upgrade Vercel to Pro for 30-minute cron cadence if needed

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
```

## Useful Commands

```bash
npm test
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
- [DATA_AUDIT.md](/Users/kevinhsieh/Desktop/Scheduling/DATA_AUDIT.md): Wise readiness and blocker resolution status
- [WISE_COMPARISON.md](/Users/kevinhsieh/Desktop/Scheduling/WISE_COMPARISON.md): migration decision record from sheets to Wise
