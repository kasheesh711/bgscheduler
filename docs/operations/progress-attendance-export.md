# Progress Test attendance connection

The Question Bank owns tests, work, marks, and reports. BGScheduler supplies roster,
class attendance, and class feedback through its existing private export route.

`GET /api/integrations/progress-export?type=attendance` uses the same
`PROGRESS_EXPORT_SECRET` bearer check as roster export. It reads fresh Wise evidence
with the existing bounded attendance reader. It uses the saved Progress launch date.
It does not change class counters, tests, or notification records.

The reply contains `schemaVersion`, `observedAt`, `launchedAt`, `source`, `packages`,
and `snapshotId`. The Question Bank checks the dates and data before it updates its
own existing attendance ledger. A failed read does not replace that ledger.

Deploy this read interface before enabling the Question Bank replacement pilot.
Live Wise access and latency have not been checked for this change.
