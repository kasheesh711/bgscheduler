# Unearned Revenue API

Six read/import/access endpoints serve the finance dashboard. The five `/api/unearned-revenue/*`
handlers require a signed-in user and a fresh feature-local capability; the internal endpoint uses
the constant-time `CRON_SECRET` guard and invocation audit wrapper.

## `GET /api/unearned-revenue`

**Auth:** `viewer` (an `access_manager` implicitly has viewer access).

Returns active snapshot metadata, all reporting periods, the selected-period overview and quality
counts, and one page of aggregated students.

Query parameters:

| Parameter | Values / constraint | Default |
|---|---|---|
| `period` | `YYYY-MM-DD` present in the snapshot | latest completed period |
| `search` | student name, parent name, or WISE student ID; max 120 chars | empty |
| `scope` | `positive`, `all` | `positive` |
| `attribution` | `all`, `attributed`, `residual`, `ambiguous`, `unattributed` | `all` |
| `review` | `all`, `needs_review`, `clear` | `all` |
| `sort` | `liability_desc`, `liability_asc`, `name_asc`, `credits_desc` | `liability_desc` |
| `page` | positive integer | `1` |
| `pageSize` | 1–100 | `50` |

`503` means no QA-passed snapshot is active; `404` means the requested period is absent.

## `GET /api/unearned-revenue/students/{studentId}`

**Auth:** `viewer`.

Optional query: `period=YYYY-MM-DD`; otherwise the snapshot's `LATEST` period is used. Returns the
student aggregate, all student/class account reconciliation rows, and all package lots for that
student and period. Formula and source trace anchors are separate. `404` means the student or period
does not exist in the active snapshot.

## `POST /api/unearned-revenue/sync`

**Auth:** `access_manager`. **Maximum duration:** 800 seconds.

Runs the same read-only Google workbook importer as the cron and records the actor email. Returns the
sync result. A normal import or idempotent success is `200`; an already-running single-flight skip is
`202`; a source/read/validation failure is `502` and does not replace the last good snapshot.

## `GET /api/unearned-revenue/access`

**Auth:** `access_manager`.

Returns allowlisted admin users with their `viewer` / `access_manager` capabilities and the current
optimistic-lock version derived from access audit history.

## `PATCH /api/unearned-revenue/access`

**Auth:** `access_manager`.

Request body:

```json
{
  "targetEmail": "finance@example.com",
  "capabilities": ["viewer"],
  "expectedVersion": 3,
  "note": "Quarterly access review"
}
```

Capabilities replace the target's current set. The route rejects stale `expectedVersion`, non-admin
targets, self-removal, and removal of the final access manager. A successful replacement is audited.

## `GET /api/internal/sync-unearned-revenue`

**Auth:** `CRON_SECRET`. **Maximum duration:** 800 seconds.

The daily 01:30 Bangkok entry point. It is wrapped by `withCronInvocationAudit` under job key
`unearned_revenue`; response status follows the manual sync route. The importer reads Google Sheets
and writes only its own Postgres snapshot tables.
