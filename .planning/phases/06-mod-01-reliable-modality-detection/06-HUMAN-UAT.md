---
status: partial
phase: 06-mod-01-reliable-modality-detection
source: [06-VERIFICATION.md]
started: 2026-04-21T15:55:55.463Z
updated: 2026-04-21T15:55:55.463Z
---

## Current Test

[awaiting human testing]

## Tests

### 1. Visual confirmation of modality icons + popover labels on production compare view
expected: Every session card in compare view shows exactly one modality icon (Video / MapPin / HelpCircle) in the top-right corner; hovering the card shows a popover with the D-15 terse label ("Online" / "Onsite" / "Unknown" / "Likely online — unconfirmed" / "Likely onsite — unconfirmed"); no card has border, fill, or stroke that varies by modality (Pitfall 3).
result: [pending]

### 2. Low-confidence renders identical to unknown (D-14 visual parity)
expected: For a paired tutor whose session has a missing `sessionType` value, the card shows the `HelpCircle` icon identical to a truly unresolved session. Low-confidence modality is visually indistinguishable from unknown.
result: [pending]

### 3. Post-deploy `/data-health` modality counter rise is surface-of-reality
expected: After this phase deploys to production, the `/data-health` page "Modality issues" counter shows a higher number than before (rise attributable to new per-session `conflict_model` issues); the inline D-11 note ("expected to rise", "surface-of-reality", "not a regression") is visible in the card. Per-row badges show "group" vs "session" correctly.
result: [pending]

## Summary

total: 3
passed: 0
issues: 0
pending: 3
skipped: 0
blocked: 0

## Gaps
