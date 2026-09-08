# Leave Requests API

All in-app routes require an authenticated admin with Leave Requests page access. The new board and mutation routes recheck the current admin registry, including disabled/restricted accounts. Responses containing operational data use `Cache-Control: private, no-store`.

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/leave-requests/board` | Daily/upcoming/history board, roster, owners, checklists, freshness and processing issues |
| GET | `/api/leave-requests/assignments/{assignmentId}` | Source submissions, current normalization provenance and assignment activity |
| PATCH | `/api/leave-requests/assignments/{assignmentId}` | Narrow ownership, family-notification or class-cancellation update |
| GET | `/api/leave-requests` | Retained legacy request list |
| GET | `/api/leave-requests/{requestId}` | Retained source request detail and activity |
| PATCH | `/api/leave-requests/{requestId}` | Retained request metadata interface |
| POST | `/api/leave-requests/{requestId}/wise-cancel-preview` | Retained dry-run cancellation preview; never writes Wise |
| POST | `/api/leave-requests/sync` | Manual source import, normalization, roster allocation, reconciliation and writeback |
| GET/POST | `/api/internal/sync-leave-requests` | Same pipeline via constant-time cron-secret authorization |

## Board

`GET /api/leave-requests/board?date=2026-09-08&view=daily&q=Buzz`

`date` is a valid ISO Bangkok processing date, default today. `view` is `daily`, `upcoming`, or `history`. `q` searches teacher, owner, class date, family and student names. Invalid dates/views return 400. The client filters owners locally so all authorized admins can inspect and cover each other's work.

The response follows `LeaveBoard` in `src/lib/leave-requests/work-types.ts`: `date`, `today`, `viewerEmail`, `defaultOwner`, `roster`, `admins`, `assignments`, `history`, and `freshness`. Every assignment includes its stable teacher identity, class/due dates, owner, version, classes, families, linked source requests, completion state, and issues. Class tasks include original UTC times, Wise session ID, relevant students, cancellation evidence and version. Family tasks include student/contact details, current and informed session coverage, evidence and version.

`freshness` distinguishes source read, class snapshot and roster read timestamps; running syncs; stale data; pending/failed normalizations; and pending writebacks. Outages retain the last usable work.

## Narrow updates and conflicts

All updates require a UUID `mutationKey` for retry idempotency, `expectedVersion` from the current entity, `kind`, and the entity's UUID `entityId`.

```json
{"kind":"family","entityId":"family-task-uuid","expectedVersion":2,"mutationKey":"operation-uuid","checked":true}
```

- `kind: "family"`: `checked` records/undoes Parent informed against the current family coverage revision.
- `kind: "class"`: `checked` records/undoes manual cancellation tracking. An explicit Wise cancelled status cannot be undone here.
- `kind: "owner"`: `entityId` is the assignment ID; `ownerEmail` is an enabled Leave Requests admin or null. Taking over is this same explicit operation using the viewer's email. The expected version is the assignment version.

Success is `{ "success": true, "replayed": false }`; an identical retry returns `replayed: true`. Each operation locks the assignment, validates the target/version, updates only the relevant fields, and adds an audit record atomically. Entity-version mismatch, competing takeover, or reuse of an operation ID for another action returns 409. Invalid input returns 400; missing records 404; missing authentication 401; missing page access 403. The client reloads on conflict rather than overwriting another admin.

No endpoint sends parent messages or performs a Wise cancellation. All completing-admin identities and completion times come from the authenticated server action; imported notes use nullable completion timestamps.

## Sync

Both manual and cron handlers retain `maxDuration = 800`. Running rows abandoned for more than 20 minutes are recovered before the existing database single-flight insert. A concurrent active run returns 409. Results include source counts and normalization processed/failed/remaining counts. Bounded model and reconciliation work checkpoints resume on later runs. Writeback failure does not undo work and retries separately.
