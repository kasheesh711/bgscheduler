---
status: issues_found
phase: 06-mod-01-reliable-modality-detection
source: [06-VERIFICATION.md]
started: 2026-04-21T15:55:55.463Z
updated: 2026-04-21T16:10:00Z
---

## Current Test

[complete — 1 issue found, 2 pending full confirmation]

## Tests

### 1. Visual confirmation of modality icons + popover labels on production compare view
expected: Every session card in compare view shows exactly one modality icon (Video / MapPin / HelpCircle) in the top-right corner; hovering the card shows a popover with the D-15 terse label ("Online" / "Onsite" / "Unknown" / "Likely online — unconfirmed" / "Likely onsite — unconfirmed"); no card has border, fill, or stroke that varies by modality (Pitfall 3).
result: ISSUE — user reports seeing "Likely online" labels on sessions that should be high-confidence online. DB query confirmed: active snapshot has only two distinct sessionType values (`OFFLINE` → matches `ONSITE_SESSION_TYPES` ✓, `SCHEDULED` → matches NEITHER set). Staff term for online is "Live"; Wise API value is `SCHEDULED`. 9,677 / 34,092 sessions (~28%) are silently degraded to "Likely online — unconfirmed" because `ONLINE_SESSION_TYPES = {"online", "virtual"}` does not include `"scheduled"`. Tracked as MOD-UAT-01 in 06-VERIFICATION.md.

### 2. Low-confidence renders identical to unknown (D-14 visual parity)
expected: For a paired tutor whose session has a missing `sessionType` value, the card shows the `HelpCircle` icon identical to a truly unresolved session. Low-confidence modality is visually indistinguishable from unknown.
result: pending — deferred until MOD-UAT-01 gap fix lands (D-14 parity must be re-checked after the cascade stops silently downgrading valid online sessions)

### 3. Post-deploy `/data-health` modality counter rise is surface-of-reality
expected: After this phase deploys to production, the `/data-health` page "Modality issues" counter shows a higher number than before (rise attributable to new per-session `conflict_model` issues); the inline D-11 note ("expected to rise", "surface-of-reality", "not a regression") is visible in the card. Per-row badges show "group" vs "session" correctly.
result: pending — deferred until MOD-UAT-01 gap fix lands (counter semantics may shift as SCHEDULED sessions move from "likely" to "high-confidence" online)

## Summary

total: 3
passed: 0
issues: 1
pending: 2
skipped: 0
blocked: 0

## Gaps

- **MOD-UAT-01** — Tenant vocabulary mismatch: `ONLINE_SESSION_TYPES` does not contain `"scheduled"`. Fix documented in `06-VERIFICATION.md` Gaps section. Route: `/gsd-plan-phase 6 --gaps` → `/gsd-execute-phase 6 --gaps-only`.
