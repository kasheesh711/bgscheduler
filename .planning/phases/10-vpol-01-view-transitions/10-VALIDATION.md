---
phase: 10
slug: vpol-01-view-transitions
status: ready
nyquist_compliant: true
wave_0_complete: false
created: 2026-05-09
---

# Phase 10 - Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | Vitest |
| **Config file** | `vitest.config.ts` |
| **Quick run command** | `npm test -- src/lib/ui/__tests__/view-transitions.test.ts src/components/compare/__tests__/view-transitions-source.test.ts` |
| **Full suite command** | `npm test` |
| **Estimated runtime** | ~30 seconds for targeted tests; full suite runtime depends on local DB/integration availability |

---

## Sampling Rate

- **After every task commit:** Run the targeted Vitest command for the helper/source tests when those files exist.
- **After every plan wave:** Run `npm test` and `npm run lint`.
- **Before `/gsd-verify-work`:** Full suite must be green, and browser QA must be recorded.
- **Max feedback latency:** 60 seconds for targeted checks.

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Threat Ref | Secure Behavior | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|------------|-----------------|-----------|-------------------|-------------|--------|
| 10-W0-01 | TBD | 1 | TRANS-01, TRANS-03, TRANS-05 | T-10-01 | Transition kind/direction uses static typed values, not user-provided CSS selectors | unit | `npm test -- src/lib/ui/__tests__/view-transitions.test.ts` | no, W0 | pending |
| 10-W0-02 | TBD | 1 | TRANS-02, TRANS-03, TRANS-05 | T-10-02 | Source guardrails prevent `experimental.viewTransition`, animation dependencies, and RSC wrapper usage | source | `npm test -- src/components/compare/__tests__/view-transitions-source.test.ts` | no, W0 | pending |
| 10-W0-03 | TBD | 1 | TRANS-04 | T-10-03 | Scroll restoration targets only known calendar containers | unit/browser | `npm test -- src/lib/ui/__tests__/view-transitions.test.ts` plus browser QA | no, W0 | pending |
| 10-QA-01 | TBD | 2 | TRANS-01, TRANS-02, TRANS-03, TRANS-04 | T-10-04 | UI does not show stale/loading content as final availability state | browser | Browser QA on `/search` | no, W0 | pending |

*Status values: pending, green, red, flaky*

---

## Wave 0 Requirements

- [ ] `src/lib/ui/view-transitions.ts` - helper required by TRANS-05.
- [ ] `src/lib/ui/__tests__/view-transitions.test.ts` - helper behavior tests for SSR, unsupported browser, reduced motion, rapid nav, and transition type mapping.
- [ ] `src/components/compare/__tests__/view-transitions-source.test.ts` - source guardrails for `globals.css`, `next.config.ts`, animation dependencies, and RSC wrapper avoidance.
- [ ] Phase verification notes - browser QA checklist for rendered transition behavior.

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| Week prev/next directional slide | TRANS-01 | Native view-transition rendering is browser behavior, not fully proven by jsdom | Open `/search`, compare at least one tutor, click previous and next week, confirm opposite slide directions and duration at or below 160 ms target |
| Today and calendar-popup directional slide | TRANS-01 | Date-direction motion depends on rendered interaction | Navigate away from current week, click Today, then choose an earlier/later week from popup and confirm direction by target date |
| Day-tab crossfade | TRANS-02 | Visual flicker/skeleton capture is browser-rendered | Switch Week to a day, day to day, and day back to Week; confirm crossfade and no `CalendarSkeleton` capture |
| Reduced motion instant behavior | TRANS-03 | Requires browser media emulation or OS setting | Enable reduced motion in browser/OS emulation and repeat week/day navigation; confirm instant changes and no animation |
| Scroll preservation | TRANS-04 | Requires real scroll containers | Scroll to late afternoon in week view, change week, switch Week to Day, and switch Day to Day; confirm same time-of-day remains visible |

---

## Validation Sign-Off

- [ ] All tasks have automated verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all missing references
- [ ] No watch-mode flags
- [ ] Feedback latency < 60s for targeted tests
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
