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
| GET | `/settings` | Admin | Enrollment/contact options, schedule and exception versions, network configuration/revision and detected address. |
| PUT | `/settings` | Admin | Settings command below; returns new configuration revision. |
| GET | `/export` | Admin | Root's filters. CSV includes Bangkok date/requirements, original/effective UTC timestamps, flags and completed span minutes. Formula prefixes escaped. |

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
