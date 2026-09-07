# Classroom continuity and noticeboard rollout — 7 September 2026

## Behavior and rollout

`continuity-v1` runs after the existing feasibility repair. Manual generation, morning reconciliation and override recalculation use the same planning rules. Usual-room sets initialize on the next assignment generation and persist thereafter. Existing saved runs keep their original policy snapshot, so reports of runs created before this release say “Not yet established”. No operational Wise publishing or teacher email delivery was triggered during validation.

Additive migrations `0075_classroom_tutor_room_profiles` and `0076_classroom_stable_identity` were tested against an isolated local Postgres database, then applied to production after confirming they were the only pending migrations. The second migration backfilled canonical teacher keys on existing assignment rows. Room profiles use stable identity rather than snapshot UUIDs.

The existing morning cron remains the rollout path: 06:41 Bangkok, seven assignment dates, today's teacher emails only. The admin-email retry schedule is unchanged. Room counts, coverage and continuity search limits are persisted in each new run's `changeSummary.quality`.

Rollback: set `CLASSROOM_CONTINUITY_ENABLED=false` in the production environment and redeploy. This disables continuity optimization and new automatic profile initialization, retaining feasibility repair, saved profiles, print reports and notification protection. No destructive reverse migration is needed.

## Read-only allocation comparisons

The historical fixture is `src/lib/classrooms/__tests__/fixtures/2026-09-05.json`. Fresh comparisons used the active database snapshot, resolved teacher identities and fresh Wise GET responses on 7 September. Profile candidates were computed in memory from the previous 28 days' latest daily plans and the upcoming 28 days of teaching. No preview profiles or assignment plans were written.

| Dataset | Planned sessions | Short-gap moves before | After | Additional unassigned / constraint violations |
|---|---:|---:|---:|---|
| Historical 5 September fixture | 170 | 21 | 6 | 0 / 0 |
| Tuesday 8 September | 51 | 0 | 0 | 0 / 0 |
| Wednesday 9 September | 47 | 1 | 0 | 0 / 0 |
| Thursday 10 September | 50 | 0 | 0 | 0 / 0 |
| Friday 11 September | 32 | 0 | 0 | 0 / 0 |
| Saturday 12 September | 169 | 17 | 5 | 0 / 0 |
| Sunday 13 September | 149 | 19 | 3 | 0 / 0 |

Fresh data differs from the earlier audit's saved-run counts. The weekend previews cover 98 consecutive pairs each. Usual-room coverage is 100%, 97.3%, 100%, 100%, 75.9% and 73.8% respectively; 47 proposed profiles were evaluated. Every run used the 10,000-node continuity limit. Remaining moves are **not proven unavoidable**.

One Wednesday live online session for Kemjira (Kem) Waritpariya lacked a resolved snapshot teacher identity. It was not guessed or assigned; the preview reports it explicitly and exits with an attention status. This is separate from the allocator comparison (zero additional unassigned managed classes), and the existing operational identity alert remains active. One Tuesday session absent from the live response was retained as frozen evidence. Missing sessions were checked individually before treating them as cancelled.

Reproduce with:

```bash
npx tsx --tsconfig scripts/tsconfig.json scripts/preview-classroom-recovery.ts \
  --date=2026-09-08 --days=6 --output=/private/tmp/classroom-stability-preview
```

The script enforces a read-only database transaction and only Wise GET requests. Reports exclude student and contact details. Run the preview again before relying on its current allocations; schedules change.

## Verification

- Repository release checks passed: 4,658 unit tests in 401 files, production build and route guard (228 routes). Command: `npm run verify:release` (typecheck, complete unit suite, production build, second typecheck, whitespace and production route guard).
- Database integration suite: 186 tests in 18 files, using a dedicated scratch Postgres database. Includes concurrent profile initialization, snapshot rotation, stale-edit rejection, unavailable-room preservation, date-wide sent-teacher protection and privacy of explicitly selected saved print runs.
- Allocation regressions cover the three-class alphabetical failure, longer canonical online/onsite chains, occupied-room swaps, capacity and TV constraints, conflicting usual rooms, explicit overrides, notified/started protection, changed lesson metadata, rerun stability and bounded search exhaustion.
- Profile API tests cover unauthenticated reads/writes, invalid body/calendar dates, authenticated actor identity and optimistic revision conflicts.
- Browser validation uses the production build at localhost with installed Playwright/Chrome because the Browser plugin is not available. Desktop 1440×1000 and mobile 390×844; profile-edit interactions use a mocked API, while persistence is exercised against scratch Postgres. Saved print reads use production data without changing it.
- Print QA includes a busy Saturday, a seven-day pack, Thai text, long room/teacher names, failed publishing, remote/no-room/draft rows, oversized teacher continuation cards and grayscale rendering. The synthetic stress report retains all 95 class rows, has no footer overlap and no timetable text below 11pt. PDF page size is A4 landscape. The authenticated print action, missing-run error card and unauthenticated redirect are exercised.

The existing relay and Wise publisher were covered by regression tests; no real test email or room write was sent. The first scheduled run using the new algorithm is a subsequent runtime observation, not something these previews claim to have witnessed.
