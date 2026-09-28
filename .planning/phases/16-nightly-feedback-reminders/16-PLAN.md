---
phase: 16
name: Nightly feedback reminders
status: implementing
---

# Nightly feedback reminders

Implement the user-approved reminder migration: one grouped email per tutor at 22:00 Bangkok, recovery every 30 minutes, prospective activation, and deductions independent of email delivery. Preserve previous deductions and human reviews.

Use complete Wise discovery and fresh canonical feedback. Persist every considered class, freeze dispatched message membership, distinguish rejection from uncertain acceptance, and require audited reconciliation before retrying uncertain delivery. Expose coverage, previews and history to the existing feedback workspace and watchdog.

Ship schema and code in shadow mode. Verify an entire batch against Wise and test both relays internally. Disable only the legacy sendMissingCommentsReminders trigger before live cutover. Verify the deployed revision and seven consecutive live nights. Preserve existing work in the primary checkout.

Validation: unit and Postgres integration tests for pagination, clocks, source faults, identities, races, stale feedback, retries, unknown outcomes, late discovery and financial isolation; production release gates; shadow evidence and relay receipts.
