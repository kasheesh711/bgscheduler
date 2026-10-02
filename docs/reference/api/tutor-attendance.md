# Tutor attendance API and persistence

All paths below begin `/api/tutor-attendance`. Auth.js sessions and fresh feature guards
are required; responses are `private, no-store`. Mutations require same-origin `Origin`,
JSON content type and a body no larger than 16 KB.

| Method | Suffix | Access | Contract |
|---|---|---|---|
| GET | root | Own enrollment or admin | Optional `start`, `end` (ISO Bangkok dates, maximum 366 days), `tutor` (admin only). Returns rows, access, network result, enabled state, corrections and current revisions. |
| POST | `/punch` | Enrolled tutor | `{kind: "in"\|"out", date, idempotencyKey: UUID}`. Server supplies identity/time/network. Unknown fields rejected. |
| POST | `/corrections` | Enrolled tutor | `{date, proposedIn: "HH:mm"\|null, proposedOut: "HH:mm"\|null, reason, expectedRevision, idempotencyKey: UUID}`. At least one time, none in the future. |
| PATCH | `/corrections/{id}` | Admin | `{decision: "approved"\|"rejected", reason, expectedRevision}`. Approval must match the request's original day revision too. |
| POST | `/wfh` | Enrolled tutor | `{date, reason, idempotencyKey: UUID}`. One current/future Bangkok date; identity comes from the session. Returns `{id}`. |
| PATCH | `/wfh/{id}` | Admin for review; owner or admin for cancellation | `{decision: "approved"\|"rejected"\|"cancelled", reason, expectedRevision}`. Revision belongs to the WFH request. Returns `{saved, replayed}`. |
| GET | `/settings` | Admin | Enrollment/contact options, schedule and exception versions, network configuration/revision and detected address. |
| PUT | `/settings` | Admin | Settings command below; returns new configuration revision. |
| GET | `/export` | Admin | Root's filters. CSV includes Bangkok date/requirements, original/effective UTC timestamps, flags and completed span minutes. Formula prefixes escaped. |

The overview also returns `clockingAllowed`, each row's `workMode` (`office` or `wfh`)
and nullable `wfhRequestId`, plus authorized `wfhRequests` including future dates regardless
of the attendance date filter. Each request has its revision, review/cancellation history,
and `canApprove`, `canReject`, `canCancel`, `locationLocked` UI permissions. Server mutations
recheck permissions inside the attendance lock. Tutors see only their own requests.

WFH request bodies reject unknown fields. At most one pending/approved request exists per
tutor/date. Matching idempotency keys replay the original submission; changed bodies conflict.
Matching decision retries replay the saved result; stale revisions conflict. Punch bodies
are unchanged: the server determines work location and verifies WFH approval. CSV appends
`Work location` and `WFH request ID` after the existing columns.

Every settings command includes `expectedRevision` and `reason`:

- `enrollment`: `canonicalKey`, `loginEmail`, `startDate`, nullable `endDate`, `active`.
- `schedule`: `canonicalKey`, `effectiveFrom`, `week`: seven entries, Sunday first;
  each is `null` or `{start: "HH:mm", end: "HH:mm"}`.
- `exception`: nullable `canonicalKey` (null = office), `date`, `kind` (`hours`,
  `excused`, `reset`), nullable `start`/`end`. Hours require an individual tutor.
- `networks`: `networks: [{label, cidr}]`, `verifiedOfficeConnection: true`. Maximum 12;
  IPv4 /24–/32 or IPv6 /48–/128, no private/loopback addresses. Exact IPs are accepted.

Errors: `{error, code?}`; 400 invalid input, 401 missing session, 403 access/network/origin,
404 missing correction, 409 conflicting/stale operation, 413 size, 415 content type,
503 clocking disabled. Generic 500 responses contain no database detail.

WFH errors include `WFH_REQUEST_EXISTS` (409), `WORK_LOCATION_LOCKED` (409),
`WFH_DATE_PASSED` (400), `WFH_APPROVAL_REQUIRED` (403) and `STALE_REVISION` (409).

## Persistence

Migration `0088_tutor_office_attendance.sql` adds seven snapshot-independent tables:

| SQL table | Grain / purpose |
|---|---|
| `tutor_attendance_enrollments` | One stable tutor canonical key; unique active normalized email, period and activity. |
| `tutor_attendance_schedules` | One immutable weekly revision and effective date. |
| `tutor_attendance_exceptions` | One immutable tutor/date or office/date revision. |
| `tutor_attendance_config` | Singleton `office`, approved connections and configuration revision. |
| `tutor_attendance_days` | One tutor/Bangkok date; raw/effective timestamps, correction flag and revision. |
| `tutor_attendance_corrections` | One request and review outcome; unique requester/idempotency key. |
| `tutor_attendance_audit` | Immutable command/punch/review evidence, actor and optional idempotency key. |

The existing Postgres transaction helper and an office-specific advisory lock serialize
punches, configuration changes and approvals. Permissions and admin access versions are
rechecked inside the lock. No external I/O occurs there. Config revisions, not timestamps,
order schedules/exceptions. Database triggers enforce append-only evidence. No cron is used.

Migration `0093_tutor_attendance_wfh.sql` adds `tutor_attendance_wfh_requests` (one request
attempt per tutor/date, reason, status/revision, request key and review/cancellation metadata).
It adds `work_mode` (default `office`) and nullable `wfh_request_id` to attendance days.
An approval creates/updates that date's day row, and cancellation restores `office` only
before attendance evidence exists. Existing records retain office mode and their timestamps.
Both changes increment the day revision, invalidating earlier time-correction proposals.
WFH actions append to the existing immutable audit, and punch evidence includes work mode,
approval ID and authorization method (`office_network` or `approved_wfh`).
