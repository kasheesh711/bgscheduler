---
phase: 10
slug: vpol-01-view-transitions
status: verified
threats_open: 0
asvs_level: 1
created: 2026-05-11
updated: 2026-05-11
---

# Phase 10 - Security

Per-phase security contract: threat register, accepted risks, and audit trail.

---

## Trust Boundaries

| Boundary | Description | Data Crossing |
|----------|-------------|---------------|
| client UI to CSS view-transition types | Compare UI selects a transition kind that the browser maps to CSS pseudo-elements. | Static transition type strings only: `week-forward`, `week-back`, `day`, `compare-calendar`. |
| browser capability to helper | Helper consumes `document`, `window.matchMedia`, and optional injected fakes in tests. | Browser capability state and reduced-motion preference; no tutor, auth, or availability data. |
| client compare UI to `/api/compare` | Existing authenticated UI fetches compare data for selected tutor IDs. | Existing compare request shape; no new request fields introduced by Phase 10. |
| loaded compare data to transition commit | New week data is prepared before DOM transition starts. | Existing `CompareResponse` from active Wise snapshot, committed inside final transition update. |
| compare client state to DOM snapshot | State commits for week/day navigation are captured by native browser view transitions. | Rendered compare calendar state and scroll position. |
| user accessibility preference to UI behavior | `prefers-reduced-motion` must disable helper and CSS animation paths. | OS/browser motion preference. |
| implemented browser UI to human operator | User verifies animation does not misrepresent availability or harm accessibility. | Visual transition behavior and final rendered availability state. |
| source guardrails to production safety | Verification artifact records that UI-only scope did not touch auth/API/schema/cache. | Source-file scope evidence, grep checks, test results. |

---

## Threat Register

| Threat ID | Category | Component | Disposition | Mitigation | Status |
|-----------|----------|-----------|-------------|------------|--------|
| T-10-01 | Tampering | `src/lib/ui/view-transitions.ts` | mitigate | `CalendarViewTransitionKind` is a static union and native calls pass `types: [options.kind]`; focused tests and source checks verify no arbitrary selector/user string reaches CSS. | closed |
| T-10-02 | Denial of usability | `runCalendarViewTransition` | mitigate | Helper bypasses native transitions for explicit skip, reduced motion, SSR, and unsupported browsers; focused tests verify direct-update paths. | closed |
| T-10-03 | Spoofing | helper scope | accept | Helper has no tutor/auth/API/availability data access; downstream fetch-first and QA threats cover stale/loading capture. | closed |
| T-10-04 | Elevation of privilege | phase scope | accept | Phase 10 plan and final guardrails verify no auth/session/API/schema files were changed by the helper plan. | closed |
| T-10-05 | Spoofing | `changeWeek` final-content timing | mitigate | `changeWeek` awaits target compare data with `keepCurrentVisible: true`, then commits prepared data inside the transition update; browser QA verifies no loading/skeleton capture. | closed |
| T-10-06 | Tampering | transition options | mitigate | `WeekChangeOptions.kind` uses `CalendarViewTransitionKind`; callers cannot pass arbitrary CSS transition types. | closed |
| T-10-07 | Information disclosure | compare request body | accept | Request body keys and selected tutor IDs are unchanged from the existing authenticated compare flow; no new data field is sent. | closed |
| T-10-08 | Elevation of privilege | phase scope | accept | No auth, API route, schema, DB, middleware, or SearchIndex file was modified. | closed |
| T-10-09 | Spoofing | `ComparePanel` week transition | mitigate | Week controls call the fetch-first `changeWeek` path; current content remains mounted during fetch and final loaded content commits inside transition. | closed |
| T-10-10 | Tampering | `globals.css` active transition selectors | mitigate | CSS references only static names: `week-forward`, `week-back`, `day`, and `compare-calendar`; no interpolation path exists. | closed |
| T-10-11 | Denial of usability | day/week motion | mitigate | Helper bypasses reduced motion and CSS applies `animation: none !important` plus `view-transition-name: none` under `prefers-reduced-motion: reduce`. | closed |
| T-10-12 | Information integrity | scroll restoration | mitigate | Scroll restoration converts through normalized minute-of-day across WeekOverview and CalendarGrid; raw `scrollTop` reuse is limited to same-view week changes. | closed |
| T-10-13 | Elevation of privilege | UI-only source scope | accept | Source guardrails and final verification show `next.config.ts`, `package.json`, `CACHE_VERSION`, API, DB, and SearchIndex surfaces were not changed. | closed |
| T-10-14 | Spoofing | browser QA for stale/loading capture | mitigate | Browser QA explicitly passed no full-panel loading state or skeleton capture as final availability content. | closed |
| T-10-15 | Denial of usability | reduced-motion QA | mitigate | Browser QA repeated week/day navigation with reduced motion and verified instant changes. | closed |
| T-10-16 | Tampering | source guardrails | mitigate | Verification records exact grep checks for no Next experimental `viewTransition`, no animation dependency, unchanged `CACHE_VERSION`, and no API/schema/SearchIndex drift. | closed |
| T-10-17 | Elevation of privilege | phase scope | accept | Final guardrails verify no auth/session/API/schema/DB/SearchIndex file entered Phase 10. | closed |

*Status: open / closed*
*Disposition: mitigate (implementation required) / accept (documented risk) / transfer (third-party)*

---

## Accepted Risks Log

| Risk ID | Threat Ref | Rationale | Accepted By | Date |
|---------|------------|-----------|-------------|------|
| R-10-01 | T-10-03 | Helper scope is intentionally data-free; stale/loading capture is handled by T-10-05 and T-10-14 mitigations. | Phase 10 plan disposition | 2026-05-09 |
| R-10-02 | T-10-04 | Helper plan does not touch privileged app surfaces; final phase guardrails verify this remained true. | Phase 10 plan disposition | 2026-05-09 |
| R-10-03 | T-10-07 | Compare request shape is unchanged from existing authenticated flow; Phase 10 adds no new data disclosure surface. | Phase 10 plan disposition | 2026-05-09 |
| R-10-04 | T-10-08 | No auth/API/schema/DB/middleware/SearchIndex changes occurred in the week timing plan. | Phase 10 plan disposition | 2026-05-09 |
| R-10-05 | T-10-13 | UI-only source scope is enforced by guardrail tests and verification artifacts rather than new runtime controls. | Phase 10 plan disposition | 2026-05-09 |
| R-10-06 | T-10-17 | Final phase scope remained UI-only; accepted risk is documented with source guardrail evidence. | Phase 10 plan disposition | 2026-05-09 |

---

## Evidence Commands

| Check | Command | Result |
|-------|---------|--------|
| Focused helper/source tests | `npm test -- src/lib/ui/__tests__/view-transitions.test.ts src/components/compare/__tests__/view-transitions-source.test.ts` | PASS - 2 files, 21 tests |
| Static mitigation evidence | `rg -n 'CalendarViewTransitionKind|types: \[options.kind\]|prefers-reduced-motion|startViewTransition|keepCurrentVisible: true|commitPreparedCompare\(prepared\)|pruneCacheToWeek|cancelCompareFetch|pendingWeekRef|view-transition-name: compare-calendar|:active-view-transition-type|animation: none !important|CACHE_VERSION = "v2"' ...` | PASS - expected source evidence found |
| No Next experimental viewTransition | `rg -n 'viewTransition' next.config.ts || true` | PASS - no matches |
| No animation library dependency | `rg -n 'framer-motion|"motion"|@react-spring|react-spring|motion/react' package.json || true` | PASS - no matches |
| No privileged source-scope drift | `rg -n 'src/app/api|src/lib/db|src/lib/search/index|middleware|auth' src/lib/ui/view-transitions.ts src/hooks/use-compare.ts src/components/compare/compare-panel.tsx src/components/compare/week-overview.tsx src/app/globals.css || true` | PASS - no matches |
| Final phase verification | `rg -n 'status: passed|score: 20/20' .planning/phases/10-vpol-01-view-transitions/10-VERIFICATION.md` | PASS |
| Clean code review | `rg -n 'status: clean' .planning/phases/10-vpol-01-view-transitions/10-REVIEW.md` | PASS |
| Browser QA sign-off | `rg -n 'Approved by user: YES' .planning/phases/10-vpol-01-view-transitions/10-VIEW-TRANSITIONS-VERIFICATION.md` | PASS |

---

## Security Audit Trail

| Audit Date | Threats Total | Closed | Open | Run By |
|------------|---------------|--------|------|--------|
| 2026-05-11 | 17 | 17 | 0 | Codex |

---

## Sign-Off

- [x] All threats have a disposition (mitigate / accept / transfer)
- [x] Accepted risks documented in Accepted Risks Log
- [x] `threats_open: 0` confirmed
- [x] `status: verified` set in frontmatter

**Approval:** verified 2026-05-11
