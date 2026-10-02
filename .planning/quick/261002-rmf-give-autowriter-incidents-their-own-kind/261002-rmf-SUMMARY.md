---
status: complete
quick_id: 261002-rmf
branch: fix/autowriter-incident-kinds
commits: [d33f1148, 53edb60b]
---

# 261002-rmf — Autowriter incidents get their own kinds

**Problem:** the dashboard titled Atom-collector and guided-post style-review incidents "The forward scan failed",
because both jobs recorded under `scan_failed` (the only spare kind in the 0101 CHECK). No forward scan exists.

**Done:**
- Migration `0110_feedback_autowriter_incident_kinds.sql`: kind CHECK adds `atom_collection_failed`,
  `style_review_flagged`, `style_review_unavailable`, `style_review_source_missing`; relabels existing rows by
  dedupe-key prefix; style rows become info / `not_required` (pushed_at/pushed_channels keep delivery history).
- Writers: Atom collector and missing-source stay critical; style flagged/unavailable are info (owner decision
  2 Oct 2026: dashboard-only). Style review records the incident before the review row.
- Inbox: per-kind titles; an unacknowledged style fix is listed (normal urgency, neutral row, after criticals) and
  can be acknowledged in the drawer; an unavailable check shows under Details only. Review payload loads every
  listed incident uncapped. Group header red only with a critical.
- Runbook incident paragraph updated.

**Verification:** unit 7,314 passed; integration atom + review + dashboard passed (incl. replay of 0110 SQL over
old-style rows); tsc + eslint clean; fixture render checked. Independent review: APPROVE (MEDIUMs fixed).

**Deploy gate:** apply 0110 in prod BEFORE the code deploys (new kinds fail the old CHECK). Owner OK required.

**Accepted / not done:** style dedupe key ignores `ISEB_STYLE_REVIEW_VERSION` (a re-flag after a version bump of an
acknowledged post is not re-raised). Draft PR #139 edits the same Atom `recordIncident` call — rebase whichever merges second.
