---
phase: 09
slug: vpol-03-density-overview
status: draft
nyquist_compliant: true
wave_0_complete: false
created: 2026-05-05
---

# Phase 09 - Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | Vitest 4.1.5 with node environment for unit tests |
| **Config file** | `vitest.config.ts` |
| **Quick run command** | `./node_modules/.bin/vitest run --project unit src/components/compare/__tests__/density-overview.test.tsx` |
| **Full suite command** | `npm test` |
| **Estimated runtime** | Quick: <10s; full suite: project default |

---

## Sampling Rate

- **After every task commit:** Run `./node_modules/.bin/vitest run --project unit src/components/compare/__tests__/density-overview.test.tsx` when the density component or tests exist.
- **After every plan wave:** Run `npm test`.
- **Before `/gsd-verify-work`:** Full suite must be green; lint must be green if code changed.
- **Max feedback latency:** <10s for density-specific feedback after Wave 0.

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Threat Ref | Secure Behavior | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|------------|-----------------|-----------|-------------------|-------------|--------|
| 09-01-01 | 01 | 1 | DENS-02 | - | N/A | doc check | `test -f .planning/phases/09-vpol-03-density-overview/09-DENSITY-DESIGN-REVIEW.md` | No - W0 | pending |
| 09-01-02 | 01 | 1 | DENS-01, DENS-03 | T-09-02 / T-09-03 | No new API/schema/SearchIndex/cache-version changes | unit + grep | `./node_modules/.bin/vitest run --project unit src/components/compare/__tests__/density-overview.test.tsx` and `git diff -- src/app/api src/lib/search/index.ts src/lib/db/schema.ts src/lib/search/cache-version.ts` | No - W0 | pending |
| 09-01-03 | 01 | 1 | DENS-04 | T-09-01 / T-09-04 | React text rendering only; fixed tutor colors only | unit + markup | `./node_modules/.bin/vitest run --project unit src/components/compare/__tests__/density-overview.test.tsx` | No - W0 | pending |
| 09-01-04 | 01 | 1 | DENS-01, DENS-04 | T-09-03 | Read-only navigation to existing day view only | manual + unit | `./node_modules/.bin/vitest run --project unit src/components/compare/__tests__/density-overview.test.tsx` | No - W0 | pending |

*Status: pending, green, red, flaky*

---

## Wave 0 Requirements

- [ ] `src/components/compare/density-overview.tsx` - component and exported pure helper.
- [ ] `src/components/compare/__tests__/density-overview.test.tsx` - aggregation and server-rendered markup checks.
- [ ] `.planning/phases/09-vpol-03-density-overview/09-DENSITY-DESIGN-REVIEW.md` - required DENS-02 rationale artifact.
- [ ] Manual verification notes for 1/2/3 tutors, week view, day view, light/dark, reduced motion, keyboard Tab/Enter/Space, and VoiceOver segment labels.

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| Density overview remains compact at 1/2/3 tutors | DENS-01 | Visual fit cannot be proven by Vitest | Capture or inspect week view at 50% compare width with 1, 2, and 3 tutors; confirm no text overlap and calendar remains primary. |
| Density overview appears in week and day views | DENS-01 | Requires real interaction between tabs and calendar body | In the browser, load compare with tutors, switch Week -> a day tab, and confirm the overview remains visible above the calendar body. |
| Reduced-motion behavior | DENS-04 | Browser preference behavior is visual/runtime | Enable `prefers-reduced-motion: reduce` in browser tools and confirm no density-specific animation, shimmer, pulse, or delayed fill. |
| Screen-reader labels | DENS-04 | Requires assistive-tech spot check | Use VoiceOver on the density segment buttons and confirm labels include day, tutor, booked hours, and session count. |
| No misleading availability claim | DENS-03 | Product wording check | Inspect visible copy and aria/title strings; confirm they say booked hours/session counts only, not available/capacity/utilization percentage. |

---

## Threat Model References

| Threat ID | Threat | Mitigation Required |
|-----------|--------|---------------------|
| T-09-01 | DOM XSS through tutor/student/subject strings | Render all dynamic strings as React text/attributes; do not use `dangerouslySetInnerHTML`, `innerHTML`, or `insertAdjacentHTML`. |
| T-09-02 | Client-side trust boundary drift | Keep density as read-only presentation; do not add endpoints, local persisted cache, or write-back actions. |
| T-09-03 | Misleading availability signal | Label density as booked hours/session count only; never claim tutor availability from this visualization. |
| T-09-04 | Style injection through color | Use fixed `tutorChips` / `TUTOR_COLORS` values only; do not accept color strings from API data. |

---

## Validation Sign-Off

- [x] All planned tasks have automated verification or Wave 0 dependencies.
- [x] Sampling continuity: no 3 consecutive tasks without automated verification.
- [x] Wave 0 covers all missing references.
- [x] No watch-mode flags.
- [x] Feedback latency target <10s for density-specific test.
- [x] `nyquist_compliant: true` set in frontmatter.

**Approval:** approved 2026-05-05 for planning input
