# Classroom allocation and mail repair — September 5, 2026

## Scope and evidence

The incident combined abandoned provisional room reservations, fingerprints containing rotating
snapshot group IDs, a greedy allocator without displacement search, and failed mail delivery.
The missing-room outcomes already existed in the August 30 preview for September 5; the latest
refactor is not established as the cause.

The sanitized regression fixture contains 170 sessions. Student names and Wise IDs are synthetic;
tutor nicknames are retained to exercise the existing named-tutor rules and ordering. The repaired
historical plan assigns all 164 center-room sessions and marks six online sessions remote. All five
Shop sessions receive rooms. Capacity, TV, modality, designated assignments and overlaps are checked.
The fixture is test data, never an input to production publishing.

## Delivery verification

The user explicitly authorized one test per configured relay to `kevhsh7@gmail.com`, subject
`BGScheduler mail relay verification`, without class or student data. Both accepted their test
using the existing shared-secret configuration:

| Relay | Verified at (UTC) | Result |
|---|---|---|
| Backup | 2026-09-05 04:36:45 | HTTP 200, `ok: true`, deterministic verification id |
| Primary | 2026-09-05 04:39:12 | HTTP 200, `ok: true`, deterministic verification id |

Primary project `Scheduling Email Send` has an active Version 2 deployment executing as
`kevhsh7@gmail.com` with access `Anyone`. An owner authorization prompt was encountered and cleared
during inspection. Its script checks the existing shared secret and uses a lock plus idempotency
cache. No deployment URL, access setting or secret was changed. The backup's authenticated POST
succeeded without changing its deployment; its execution identity was not independently inspected
in the available project console. A HEAD/GET 403 is not a reliable POST relay health check. A POST
without the correct secret was rejected as unauthorized; the authorized test payload was accepted.

These checks establish current server-call availability and successful relay acceptance, not the
exact Google-side reason for every earlier 403. Successful sends and existing audit records remain
intact. No operational tutor/admin resend has been performed as part of this verification.

## Fresh recovery preview

The [read-only preview](classroom-recovery-preview-2026-09-05.md) was generated at 11:52 Bangkok from
live Wise data and a read-only Postgres transaction. It planned 105 upcoming sessions, froze 67 saved
or started sessions, and proposed 16 eligible Wise room changes, with zero unassigned upcoming
sessions and zero proposed overlap/capacity/TV/modality validation errors.

Individual Wise GETs confirmed that two missing upcoming sessions (Sand and Fluke) were cancelled,
so their old reservations could be released. Two other missing sessions could not be verified and
remain frozen; absence from the future-session list alone never releases a room. Frozen onsite
sessions also remain context for determining whether later online classes require center rooms.

The user superseded the recovery proposal with a future-only rollout. September 5 assignments,
Wise locations and operational emails must remain unchanged. This preview is retained as an audit
record and must not be applied. The [September 6–12 preview](classroom-future-preview-2026-09-06.md)
documents future room constraints and an unresolved Wise tutor identity before deployment.

The preview script accepts `--date=2026-09-06 --days=7` and performs one shared live read across the
range. It only reads Postgres/Wise and writes local reports; it does not create assignment runs,
seed configuration, publish locations or send mail.

## Validation and release state

- Repository release checks pass: typecheck, complete unit suite, production build, post-build
  typecheck, whitespace check and production-route guard.
- All 173 tests in 16 database integration suites pass against an isolated local scratch Postgres,
  including concurrent admin claims, partial/failed retries and ten-minute abandoned claim recovery.
- Full lint has no errors (19 existing warnings); changed repair/preview modules lint cleanly.
- No database migration, route, schedule, room capacity, class time or recipient expansion is needed.
- The user authorized committing and deploying these prevention fixes for future scheduled runs.
  The first expected run is September 6 at 06:41 Bangkok. A one-time read-only follow-up at 07:45
  checks allocation, publishing, tutor delivery and the admin retry window. No September 5 replay
  or operational resend is authorized.
