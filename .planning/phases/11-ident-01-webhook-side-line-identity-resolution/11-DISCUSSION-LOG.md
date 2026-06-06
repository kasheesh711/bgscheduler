# Phase 11: IDENT-01 Webhook-Side LINE Identity Resolution - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-06-06
**Phase:** 11-ident-01-webhook-side-line-identity-resolution
**Areas discussed:** Ambiguous-match handling, followers/ids re-anchor trigger, Phantom quarantine visibility, Mapping Validation re-point scope

> SPEC.md was loaded (6 requirements locked) — discussion covered HOW to implement only.

---

## Gray Area Selection

User selected all 4 offered gray areas to discuss (the remaining implementation internals were left to builder/researcher discretion per the SPEC's fail-closed rules).

---

## Ambiguous-match handling

| Option | Description | Selected |
|--------|-------------|----------|
| Tiered: single → suggest, ambiguous → shortlist, none → Needs Review | Confident single match → one suggestion; multiple → ranked shortlist to pick; none → Needs Review | ✓ |
| Always a ranked shortlist | Even confident matches present a list to pick from | |
| Single best match only | Only top match shown; ambiguity → Needs Review | |

**User's choice:** Tiered.
**Notes:** Reinforces fail-closed (SPEC IDENT-02) — never auto-chosen; a human always confirms.

---

## followers/ids re-anchor trigger

| Option | Description | Selected |
|--------|-------------|----------|
| Admin-triggered, re-runnable button | Button in LINE admin UI; idempotent; re-runnable without dev | ✓ |
| One-off script | scripts/ command run once | |
| Scheduled recurring job | Cron periodically re-pulls followers | |

**User's choice:** Admin-triggered, re-runnable button.

---

## Phantom quarantine visibility

| Option | Description | Selected |
|--------|-------------|----------|
| Hidden from active views, visible in labeled archive filter | Excluded from queues/counts; reachable via 'legacy / needs re-match' filter | ✓ |
| Fully hidden everywhere | Flag + exclude from all surfaces | |
| Visible but clearly flagged as legacy | Kept in views with a 'wrong-namespace' badge | |

**User's choice:** Hidden from active views, visible in a labeled archive filter.
**Notes:** Flag + exclude, reversible — never delete.

---

## Mapping Validation re-point scope

| Option | Description | Selected |
|--------|-------------|----------|
| Minimal: widen existing worklist to real-contact suggestions | Drop OA-resolver-only scope; reuse current verify UI/flow | ✓ |
| Dedicated 'verify messaging contacts' surface | Purpose-built screen | |
| Both — widen now, dedicated surface later | Minimal now; dedicated if volume warrants | |

**User's choice:** Minimal widen.

---

## Claude's Discretion

- Name-matching algorithm internals (normalization incl. Thai, fuzzy/token strategy, confidence scoring, dedup)
- Confidence thresholds (single vs shortlist vs drop) — calibrated via eval set, precision-first
- Quarantine flag mechanism (new column vs derived predicate)
- Re-link recompute trigger (inline-on-verify vs backfill) + queue-badge live read
- followers/ids pagination + rate-limit handling, getProfile batching
- Eval set construction + precision/recall measurement

## Deferred Ideas

- Conversational self-identify (next phase)
- followers/ids recurring job
- Dedicated 'verify messaging contacts' surface
- Hard-delete / removal of the OA-resolver flow
- Wise mutation/writeback + autonomous replies (later autonomy-ladder phases)
