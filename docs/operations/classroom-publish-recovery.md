# Classroom publishing recovery

Publishing uses complete Bangkok-day Wise reads (`paginateBy=DATE`, inclusive
`startDate`, exclusive next-day `endDate`, 100 rows per page). Future dates request
FUTURE; past dates request PAST; today requests both. Every advertised page must be
valid and complete before any room writes. This contract was verified read-only on
2026-09-11: 232 sessions for September 12 arrived in three pages with no duplicate
IDs, out-of-date rows or missing eligible assignments.

One persisted publisher worker sends at most one Wise request every three seconds.
Attempts yield within four minutes. Transient errors retain the job as pending;
retry delays are 5, 10, 20, then 30 minutes, or longer when Retry-After requires it.
The five-minute recovery cron resumes due jobs without a browser. Completed writes
are re-read before retrying; a successful PUT alone is not final verification.

Each attempt takes the existing room-day lock and checks the current saved plan.
Superseded plans and started/changed sessions cannot be moved. Temporary swaps,
external Wise occupancy, room reservations and verified location names remain
constraints. Success means a complete fresh read matches all eligible target rows.
Emails remain blocked while the associated publish job is pending or running.

The September 12 recovery targets the latest saved plan, with verification due by
07:00 Bangkok before the first 08:00 class. Counts are re-read before publishing;
historical previews and earlier run IDs are not apply inputs. If Wise remains
unavailable, report unresolved rows explicitly rather than marking them published.
