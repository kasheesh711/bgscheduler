# Phase 5: POLISH Drain - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-04-21
**Phase:** 05-polish-drain
**Areas discussed:** Human-QA execution (POLISH-01..05), POLISH-13 VERIFICATION.md depth, POLISH-09 today-indicator token, Orphan/working-tree cleanup

---

## Gray Area Selection

| Option | Description | Selected |
|--------|-------------|----------|
| Human-QA execution (POLISH-01..05) | 5 items need user in a browser (VoiceOver/NVDA, DiscoveryPanel error, light/dark tokens, skeleton proportions, text-[10px]). Decide execution mode, AT access, evidence format. | ✓ |
| POLISH-13 VERIFICATION.md depth | Phase 02 skipped VERIFICATION.md; audit already did integration checks. Full verifier re-run vs lightweight attestation. | ✓ |
| POLISH-09 today-indicator token | Literal `bg-red-500` on calendar-grid.tsx:303 + week-overview.tsx:547. New semantic token vs reuse, light/dark honoring. | ✓ |
| Orphan/working-tree cleanup | STATE.md flags `route 2.ts` duplicates, `.planning/debug/`, stale `FULL-APP-UI-REVIEW.md`, `.planning/ui-reviews/`. In-scope or out-of-scope. | ✓ |

**User's choice:** All four areas selected for discussion.

---

## Human-QA Execution (POLISH-01..05)

### Q1: How to run the 5 human-QA checks?

| Option | Description | Selected |
|--------|-------------|----------|
| One sitting on prod (Recommended) | Single ~30-45min session against bgscheduler.vercel.app. I draft a checklist, you walk through it and mark each item. Lowest overhead, matches v1.0.1 ship style. | ✓ |
| Split: code-level + one sitting | Automate what can be, human-only for the rest. Slower, covers more ground. | |
| Per-item, as we go | Each POLISH-01..05 as own mini-plan + commit. 5x ceremony. | |

**User's choice:** One sitting on prod (Recommended)

### Q2: Which AT do you have access to? (multi-select)

| Option | Description | Selected |
|--------|-------------|----------|
| VoiceOver on macOS | Built-in, darwin. | ✓ |
| NVDA on Windows | Requires Windows VM/machine. | |
| Only VoiceOver — relax NVDA requirement | Adjust success criteria to VoiceOver-only, defer NVDA. | |

**User's choice:** VoiceOver on macOS only (with follow-up to clarify NVDA handling)

### Q3: Where should sign-off evidence live?

| Option | Description | Selected |
|--------|-------------|----------|
| Short notes in 05-VERIFICATION.md (Recommended) | One line per item + pass/fail + timestamp. Screenshots only if something fails. Matches existing convention. | ✓ |
| Screenshot each + notes | Full visual evidence per item. Slow, bloats .planning. | |
| Inline commit message attestation | Sign-off in the commit message. Lightweight but harder to audit. | |

**User's choice:** Short notes in 05-VERIFICATION.md (Recommended)

### Q4 (follow-up): How should POLISH-01 handle the NVDA gap?

| Option | Description | Selected |
|--------|-------------|----------|
| Relax to VoiceOver-only, NVDA deferred to v1.2 (Recommended) | Update requirement; record relaxation in 05-CONTEXT.md + REQUIREMENTS.md note. | ✓ |
| Block POLISH-01 until NVDA access | Keep as-is; skip POLISH-01 until Windows access; bleed to v1.2. | |
| Use free NVDA cloud service or Windows VM | Stand up a VM / AssistivLabs; ~1hr setup. | |

**User's choice:** Relax to VoiceOver-only, NVDA deferred to v1.2 (Recommended)

**Notes:** POLISH-01 is explicitly amended. REQUIREMENTS.md traceability gets a note; NVDA coverage moves to v1.2+ deferred list.

---

## POLISH-13 VERIFICATION.md Depth

### Q1: What goes into the retroactive 02-VERIFICATION.md?

| Option | Description | Selected |
|--------|-------------|----------|
| Lightweight attestation citing audit (Recommended) | Short doc citing v1.0-MILESTONE-AUDIT.md integration-check file:line evidence for PERF-04..07 + INFRA-01. ~15min. Closes audit chain without re-doing work. | ✓ |
| Full gsd-verifier re-run | Spawn verifier agent, re-check each Phase 02 requirement. ~30-60min. May find drift but Phase 02 is archived. | |
| Delete the requirement | POLISH-13 isn't load-bearing; v1.0 is shipped. Mark as accepted tech debt, close. | |

**User's choice:** Lightweight attestation citing audit (Recommended)

### Q2: Where should the retroactive VERIFICATION.md live?

| Option | Description | Selected |
|--------|-------------|----------|
| Under .planning/milestones/v1.0/ (Recommended) | Goes with archived milestone. Matches existing `.planning/milestones/v1.0-*` prefix convention. | ✓ |
| Recreate .planning/phases/02-*/ just for this | Original phase dir was deleted during archival. Awkward. | |

**User's choice:** Under .planning/milestones/ (Recommended)

**Notes:** Follow the existing prefix convention; the file name will be `v1.0-PHASE-02-VERIFICATION.md` or similar (planner chooses).

---

## POLISH-09 Today-Indicator Token

### Q1: What semantic token should replace `bg-red-500`?

| Option | Description | Selected |
|--------|-------------|----------|
| New `--today-indicator` keeping GCal red (Recommended) | Add OKLCH token to globals.css, consume via Tailwind. Preserves GCal convention. | ✓ |
| Reuse existing `--destructive` token | Overloads destructive (error) with today indicator (now). Saves a token but semantically muddled. | |
| Change color entirely (non-GCal) | Pick primary sky blue or amber accent. Breaks universal calendar convention; risks confusion. | |

**User's choice:** New `--today-indicator` keeping GCal red (Recommended)

### Q2: Should the token honor light/dark mode?

| Option | Description | Selected |
|--------|-------------|----------|
| Same red in both modes (Recommended) | GCal/Outlook/Cron all hold red consistent across themes. Today indicator is a signal, not a theme element. | ✓ |
| Lighter red in dark mode | Dims indicator in dark mode. Adds theme work; matches `--blocked` which does vary. | |

**User's choice:** Same red in both modes (Recommended)

---

## Orphan/Working-Tree Cleanup

### Q1: Fold working-tree cleanup into Phase 5?

| Option | Description | Selected |
|--------|-------------|----------|
| Yes, as a prep commit (Recommended) | `chore(05): working-tree cleanup` at phase start. Delete `route 2.ts` dupes, stale `FULL-APP-UI-REVIEW.md`, empty `.planning/ui-reviews/`. ~5min. | ✓ |
| No — separate quick task | Use `/gsd-quick` for cleanup before Phase 5. Keeps Phase 5 strictly requirement-scoped. | |
| Ignore — not load-bearing | Orphans don't affect prod or tests. Accumulate risk. | |

**User's choice:** Yes, as a prep commit (Recommended)

### Q2: How to handle the 40 lines of `D .planning/phases/*` staged deletions?

| Option | Description | Selected |
|--------|-------------|----------|
| Include in prep commit (Recommended) | Single `chore(05): clean working tree + commit archival deletions`. | ✓ |
| Separate commit | Archive commit first, orphan commit second. 1 extra commit. | |
| Skip — let them ride with first POLISH commit | Whichever POLISH item commits first picks them up. Messy. | |

**User's choice:** Include in prep commit (Recommended)

**Notes:** Inventory confirmed `route 2.ts` pairs are byte-for-byte identical (macOS Finder artifacts), `.planning/ui-reviews/` is empty, `FULL-APP-UI-REVIEW.md` is stale pre-v1.1.

---

## Claude's Discretion

Areas where the user left decisions to the planner / executor:

- **Plan file structure** — single `05-01-PLAN.md`, multiple plans, or plan-per-category (planner optimizes for commit cadence)
- **POLISH-16 test coverage depth** — sensible Vitest cases for `recommend.ts` ranking, tier assignment, empty guard, modality-label reasons
- **POLISH-11 useCallback dep array** for `addTutor`
- **POLISH-07 midnight-tick implementation details** — day-check inside the interval
- **POLISH-06/08 regex tightening + effect-dep memoization technique**
- **Commit cadence** — one per POLISH item where reasonable

## Deferred Ideas

- NVDA coverage → v1.2 (explicit relaxation of POLISH-01)
- CACHE_VERSION constant → Phase 6 (MOD-01), not Phase 5
- Stale v1.0 REQUIREMENTS traceability checkboxes — should already be resolved by /gsd-complete-milestone 1.0; planner verifies
- Additional regression tests for POLISH-07/08 fixes — encouraged, not required
- Lighthouse / Playwright a11y automation — not scoped for v1.1
