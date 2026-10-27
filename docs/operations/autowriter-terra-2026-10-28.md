# Terra writer and outstanding feedback issues — 28 October 2026

## Changes

- Use GPT-6.1 Terra at low reasoning for every tutor. Retain GPT-6 Luna at max as fallback and retain zero-data-retention routing.
- Record Terra as a separate arm in calls, session records, labels and trend totals. Migration 0117 widens the two arm constraints without removing older values.
- When reliable join, leave and attendance-duration evidence exists, calculate conservative attendance within the scheduled lesson. Subtract every possible gap. Keep existing checks when timing evidence is missing or inconsistent.
- Identify each alert email by its exact content, with stable ordering. Changed alert content no longer conflicts with an earlier Resend idempotency key.

## Production evidence

Terra's Azure zero-retention route completed one private retained-lesson check in 4.405 seconds. The result parsed and passed validation. The recorded charge was USD 0.0056571; conservative accounting across the previously approved USD 5 comparison remains USD 4.8049536. No benchmark draft was posted.

Ten dashboard incidents were examined and resolved with evidence:

- Six API saves match verified owner-requested manual feedback receipts.
- Two historical Atom collection failures have later successful full collection runs.
- Cayenne's homework is supported by the tutor's explicit instruction at 59:22.
- Layya's two video-character claims were removed in one owner correction. Fresh Wise text, event and credit checks passed. The existing zero charge was preserved. Audit post: `b52861c6-e7c1-4b0e-909e-23a5cbec1d73`.

Prom's raw record shows 3,639 attendance seconds during a one-hour lesson, but 23% against a teacher room open for 16,111 seconds. Entry and exit times prove at least 93% scheduled attendance after allowing for every possible gap. The attendance repair permits this case without accepting attendance outside the lesson.

Private source receipts and before/after data are in `.feedback-autowriter/issues-terra-20261028/` in the operator's original checkout. They are not committed.

## Release checks

Focused model, alert and dashboard checks: 1,463 passed before the attendance regression was added. Attendance checks: 44 passed. Database migration tests, full CI, deployment and the live Prom retry must finish before this release is reported complete.
