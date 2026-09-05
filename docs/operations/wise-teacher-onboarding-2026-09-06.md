# Wise teacher onboarding — September 6 activation

Automatic onboarding is floored at **2026-09-06 00:00 Asia/Bangkok**
(`2026-09-05T17:00:00Z`). It uses the existing half-hour Wise sync; no cron
schedule or route changes are required. September 5 assignment, publish and
operational email ledgers must remain untouched.

## Ownership and delivery

The roster's `userId.email` is the only new contact source. Persistent
`tutor_wise_accounts` mappings preserve account ownership and canonical keys
across snapshots, name changes and snapshot pruning. New teachers without
nicknames receive a `wise:<userId>` key. Exact full-name Online/non-Online pairs
can share that key; ambiguous newcomers are isolated and blocked for review.
Existing aliases and canonical keys remain intact.

`tutor_contacts.wise_email_state` records the last imported value and owning
accounts for each managed field. Existing populated addresses are configured
values and are never adopted as Wise-managed merely because they match Wise.
A changed or cleared managed value becomes a manual override. Inactive contacts,
phones, primary-email overrides and business profiles are preserved.

The short promotion transaction locks contact writes, imports account/contact
changes, appends `tutor_contact_sync_events`, records contact issues and promotes
the snapshot together. Rollback preserves the previous active snapshot and
contacts. Empty/malformed rosters cannot erase imported contacts. Unchanged
imports create no audit noise. Missing/invalid/conflicting accounts lose their
managed email fields without deleting history.

Classroom delivery selects a valid non-Online address, then a valid Online
address. Runtime previews no longer seed hardcoded contacts. Post-Class Feedback
keeps its primary override and distinct-address conflict policy. Imported
contacts enable only the existing teacher access; they cannot acquire other
teachers' Progress Tests data through name bridging. Admin and Learning Plans
permissions remain separate.

## Failure reporting

Sync results/metadata include `contactSync` creation/update/blocked/source-issue
counts and `unmanagedTeacherSessionCount`. Source defects remain in Data Health;
configured delivery fallbacks can still be usable. Unusable contacts or absent
roster teachers produce failed sync outcomes while retaining valid promoted
work. Morning allocation accepts that promoted snapshot, carries its diagnostic
into the result and assignment metadata, and the admin digest uses
`ACTION REQUIRED`. An entirely rejected snapshot cannot be reused as fresh.

The future preview exposed an additional retained-room edge case: an Online
class using a center room could overlap an unresolved OFFLINE class's actual
Wise room. Repair now reconsiders these local Online placements as well as
publishable OFFLINE placements. Two synthetic regressions cover this case and
new external occupancy.

## Read-only preview

Run:

```bash
npx tsx --tsconfig scripts/tsconfig.json scripts/preview-wise-teacher-onboarding.ts --output=/private/tmp/wise-onboarding-preview.json
```

This uses Wise GETs and a repeatable-read, read-only database transaction. It
creates no assignment runs, imports no contacts, publishes no locations and
sends no emails. Reports omit email addresses and student details. The preview
works before or after migration 0074.

The September 5 fresh-data preview proposed **13 new contacts**, no changes to
configured addresses, and no identity collisions. All matched tutors scheduled
September 6–12 had a usable recipient. Two roster accounts lacked usable Wise
emails (Tutor Sandhya and Pearcha); existing configuration supplies Pearcha's
recipient, while one contact remains blocked. No affected blocked contact was
scheduled in this preview window.

| Date | Live classes | Planned | No room | Missing roster | Invalid proposed placements |
|---|---:|---:|---:|---:|---:|
| September 6 | 122 | 122 | 0 | 0 | 0 |
| September 7 | 38 | 38 | 0 | 0 | 0 |
| September 8 | 54 | 54 | 0 | 0 | 0 |
| September 9 | 50 | 49 | 0 | 1 | 0 |
| September 10 | 45 | 45 | 0 | 0 | 0 |
| September 11 | 31 | 31 | 0 | 0 | 0 |
| September 12 | 175 | 175 | 2 | 0 | 0 |

Kem's September 9 session still references a teacher absent from the current
Wise roster. Kavin and Shop's September 12 10:30 placements remain unresolved
with bounded-search-exhaustion diagnostics; their actual Wise occupancy is
retained. Do not report search exhaustion as proof that no arrangement exists.
Neither condition should be hidden by a successful cron outcome.

## Rollout and verification

Apply additive migration `0074_wise_teacher_onboarding.sql` before deploying
code through the documented production release process. There is no contact
backfill or manual automation invocation: the first eligible scheduled sync
performs the import. Retain the migration/audit tables when rolling code back.

Verify the first eligible sync, September 6 06:41 allocation and subsequent
admin window using read-only ledger queries: account/contact counts, blocked
sources, assignment coverage, valid locations, publish outcomes and recipient
receipts. Preserve all successful sends and all September 5 records. Do not
send test or operational messages as part of this verification.

Release validation: 4,637 unit tests and 183 database integration tests passed.
The complete `verify:release` gate passed, including the production build, both
type checks and route-surface guard. Lint passed with existing warnings and no
errors. Migration 0074 was applied at 2026-09-05 05:59:50 UTC; immediately
afterward there were zero imported accounts, contact audit events or managed
contacts, confirming that the migration did not perform an early import.
