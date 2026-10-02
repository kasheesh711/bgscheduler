---
quick: 261001-r5j
status: complete
implementation_commit: dc1bfbb9
date: 2026-10-01
---

# Mobile onsite class capture and reviewed feedback drafts

Implemented on isolated branch `codex/mobile-class-evidence` from `origin/main` at `3273ae89`, then synchronized with `main` at `e5f2d88e` before review. The class-capture migration moved to 0108 because the new upstream Atom migration uses 0107. Production activation is intentionally separate from this completed implementation.

Tutors choose an authorized one-to-one onsite class, attest to participant/guardian consent and named-provider processing, visibly record, optionally add a debrief or permitted worksheet photos, and explicitly request transcription and a draft. Sources remain distinct. The model selects validated current-source excerpts; class audio cannot establish student mastery or silent/written work. Tutors edit and save their review, copy the feedback, and explicitly submit through the existing Wise form. There is no new feedback submission or parent-message action.

Private upload intents, current session/identity checks, optimistic edits, processing leases, bounded file allocation, duplicate-click protection, cancellation, and account-scoped local recovery are implemented. Logical expiry is 24 hours. Independent bounded retention rotates retries, preserves uncertain-provider tombstones, and keeps the existing autowriter deadline. Migration 0108 is committed but has not run against production.

## Verification

- Full unit suite: **590 files, 6,928 tests passed**.
- Synthetic PostgreSQL integration: **3 files, 14 tests passed**, including migration, ownership, duplicate requests, cancellation, discard/replacement, retention fairness, and uncertain-provider reconciliation.
- Synthetic browser acceptance: **13 checks passed**, with 8 screenshots. No real recording or provider call.
- Typecheck passed. Lint passed with 18 existing warnings and no errors. Whitespace check passed. Production route guard passed with 319 source routes.
- Independent source recheck addressed all nine original findings, with no remaining confirmed P1/P2. See [REVIEW.md](REVIEW.md).
- Local checks used the available Node 22 runtime; the existing PR CI uses Node 24 and is checked on the final pushed commit separately.

## Deliverables and activation limits

- [Operational runbook and cost notes](../../../docs/operations/class-capture.md)
- [Screenshots and browser acceptance evidence](../../../docs/assets/class-capture/README.md)
- [Design and bounded assumptions](../../../docs/superpowers/specs/2026-10-01-onsite-class-evidence-design.md)

The feature remains default-off. Activation requires an operator-applied migration, private Blob storage, verified existing provider credentials/credit, approved processing spend, active retention, and synthetic staging plus real-device verification. Local credential absence does not establish hosted configuration. Real iOS/Android interruptions, live provider language quality, hosted cleanup, and Wise submission remain unverified. Browser background recording and exactly-once provider billing are not promised. The bounded orphan scan must be proven sufficient for the configured shared provider project before enabling capture.

No production data writes, migration, deployment, merge, credentials, grants, subscription changes, or real student media transmission were performed.
