# Phase 10: VPOL-01 View Transitions - Research

**Researched:** 2026-05-09 [VERIFIED: system current_date]
**Domain:** Native same-document View Transitions in a Next.js 16 App Router compare calendar [VERIFIED: .planning/phases/10-vpol-01-view-transitions/10-CONTEXT.md; VERIFIED: next.config.ts]
**Confidence:** HIGH for helper/API shape and local integration points; MEDIUM for cross-browser visual behavior until browser QA runs on the implemented code. [CITED: https://developer.mozilla.org/en-US/docs/Web/API/Document/startViewTransition; CITED: https://developer.chrome.com/docs/web-platform/view-transitions/same-document; VERIFIED: src/components/compare/compare-panel.tsx]

<user_constraints>
## User Constraints (from CONTEXT.md)

Source for all content in this block: [VERIFIED: .planning/phases/10-vpol-01-view-transitions/10-CONTEXT.md]

### Locked Decisions

## Implementation Decisions

### Motion Feel

- **D-01:** Week prev/next navigation uses a directional slide. Moving to a later week slides in the forward direction; moving to an earlier week slides in the reverse direction. This should reinforce the calendar mental model.
- **D-02:** Today and calendar-popup week jumps also use directional slide by date direction. If the target week is later than the current visible week, use the forward direction; if earlier, use the reverse direction.
- **D-03:** Day-tab switches use a subtle crossfade, not a horizontal slide. Day drill-down changes are a lens switch, not week movement.
- **D-04:** Motion should be fast and utilitarian: target duration is at most 160 ms with light easing. Avoid decorative, long, or highly noticeable animation.

### Transition Timing

- **D-05:** Week changes animate final loaded content only. Fetch new compare data first, then run the view transition when the new compare response is ready. Do not capture loading skeletons or Suspense fallback DOM as the transition target.
- **D-06:** Use the same final-content timing path even when data is cached. A single timing model is preferred over special-casing cached weeks.
- **D-07:** During a week-change fetch, keep the current calendar content visible until replacement content is ready. Do not show the existing full-panel loading state for this path unless planning finds a blocking reason.
- **D-08:** Day-tab switches have no server fetch, so wrap the local `activeDay` state update directly in the view-transition helper.

### Scroll Preservation

- **D-09:** Preserve the current calendar scroll offset across all week changes. If staff are looking around 5pm, the new week should remain around that same time-of-day position.
- **D-10:** Phase 10 must explicitly support both calendar scroll containers: the WeekOverview internal scroll body and the day-drill-down wrapper in ComparePanel / CalendarGrid.
- **D-11:** Week to Day and Day to Week switches carry over the same time-of-day scroll offset.
- **D-12:** Day-to-day tab switches also preserve the same time-of-day offset. Do not reset each day to the top.

### Fallbacks and Fast Navigation

- **D-13:** `prefers-reduced-motion: reduce` is strict instant mode. The helper should bypass view transitions for reduced-motion users, and CSS should also disable any `::view-transition-*` animation.
- **D-14:** Browsers without `document.startViewTransition` use a silent instant fallback. No warning UI and no CSS-transition fallback are required.
- **D-15:** Rapid week navigation skips animation so power users are not slowed down.
- **D-16:** A rapid navigation burst is defined as another week-navigation start within 300 ms of the previous one.

### Technical Guardrails

- **D-17:** The helper lives in `src/lib/ui/view-transitions.ts` and feature-detects the native browser API. It must be safe in SSR by falling back when `document` is unavailable.
- **D-18:** Do not enable `experimental.viewTransition` in `next.config.ts`. Local Next.js 16 docs mark that flag experimental and advise against production use. This phase uses `document.startViewTransition()` directly instead.
- **D-19:** Do not add Framer Motion, Motion One, React canary APIs, or any new animation dependency.
- **D-20:** No `CACHE_VERSION` bump is expected. If planning discovers an unavoidable client-cached response shape change, the plan must call that out explicitly and include the cache-version migration.

### Claude's Discretion

- Exact helper function names and option shape, provided it supports named transition kinds/directions, reduced-motion bypass, unsupported-browser fallback, and rapid-navigation bypass.
- Exact CSS keyframe names and `view-transition-name` values, provided week slide and day crossfade are separately addressable.
- Exact scroll-container ref plumbing. The implementation may centralize scroll capture/restore in `ComparePanel`, `useCompare`, or a small UI helper as long as both week and day containers are covered.
- Exact visual easing curve, provided duration stays at or below 160 ms and the result remains quiet.
- Whether a small non-disruptive pending affordance is useful while week data fetches, provided current calendar content remains visible and no skeleton is captured by the transition.

### Deferred Ideas (OUT OF SCOPE)

- Tutor add/remove shared-element or lane enter/exit transitions remain deferred to v1.2+ (`TRANS-06`).
- Fullscreen morph transition remains deferred to v1.2+ (`TRANS-07`).
- CSS fallback animation for browsers without native view transitions is not needed in Phase 10.
- Per-week remembered scroll positions are not needed in Phase 10.
</user_constraints>

## Project Constraints (from CLAUDE.md)

- `CLAUDE.md` delegates to `AGENTS.md`, and `AGENTS.md` requires reading relevant `node_modules/next/dist/docs/` guides before recommending Next.js 16 code. [VERIFIED: CLAUDE.md; VERIFIED: AGENTS.md]
- `next.config.ts` currently sets `cacheComponents: true`; Phase 10 must leave `next.config.ts` unchanged unless the user explicitly changes the locked decision. [VERIFIED: next.config.ts; VERIFIED: .planning/phases/10-vpol-01-view-transitions/10-CONTEXT.md]
- Production truth remains Wise API only; this UI-only phase must not introduce API, schema, or cache-shape changes. [VERIFIED: AGENTS.md; VERIFIED: .planning/phases/10-vpol-01-view-transitions/10-CONTEXT.md]
- The stack is locked to Next.js 16, TypeScript, Tailwind, shadcn/ui, Drizzle, Neon, Auth.js, and Vitest; no animation dependency should be added. [VERIFIED: AGENTS.md; VERIFIED: package.json]
- The GCal-style grid, sky-blue palette, sticky legend, density overview, and admin-workflow speed are frozen baseline surfaces for this phase. [VERIFIED: .planning/PROJECT.md; VERIFIED: .planning/phases/08-vpol-02-sticky-tutor-legend/08-CONTEXT.md; VERIFIED: .planning/phases/09-vpol-03-density-overview/09-CONTEXT.md]
- No project-local skills were found in `.claude/skills/` or `.agents/skills/`. [VERIFIED: find .claude/skills .agents/skills -maxdepth 2 -name SKILL.md]

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| TRANS-01 | Week prev/next/today navigation animates via native `document.startViewTransition()` | Use a client-only helper around native same-document transitions; fetch compare data before starting the transition; commit final state synchronously inside the update callback. [VERIFIED: .planning/REQUIREMENTS.md; CITED: https://developer.chrome.com/docs/web-platform/view-transitions/same-document; CITED: https://react.dev/reference/react-dom/flushSync] |
| TRANS-02 | Day-tab switches in compare view animate via view transition | Wrap `activeDay` state changes through the same helper with a day-crossfade transition type; preload or bypass first-load dynamic chunks so `CalendarSkeleton` is not captured. [VERIFIED: .planning/REQUIREMENTS.md; VERIFIED: src/components/compare/compare-panel.tsx:15-23; CITED: https://developer.mozilla.org/en-US/docs/Web/API/View_Transition_API/Using] |
| TRANS-03 | `@media (prefers-reduced-motion: reduce)` CSS skips all view-transition animations | Gate in JS with `matchMedia("(prefers-reduced-motion: reduce)")` and add a global CSS reduced-motion override for view-transition pseudo-elements. [VERIFIED: .planning/REQUIREMENTS.md; CITED: https://developer.mozilla.org/en-US/docs/Web/CSS/Reference/At-rules/@media/prefers-reduced-motion; CITED: https://react.dev/reference/react/ViewTransition] |
| TRANS-04 | Calendar scroll position is preserved across view transitions | Add refs/data attributes for both active scroll containers and restore `scrollTop` inside the transition update callback after synchronous React commit. [VERIFIED: .planning/REQUIREMENTS.md; VERIFIED: src/components/compare/week-overview.tsx:315; VERIFIED: src/components/compare/compare-panel.tsx:263] |
| TRANS-05 | View-transition helper lives in `src/lib/ui/view-transitions.ts` and does not wrap the RSC streaming boundary | Keep the helper imported only from client compare code; do not use Next `experimental.viewTransition`, React canary `<ViewTransition>`, router refreshes, or server/RSC wrappers. [VERIFIED: .planning/REQUIREMENTS.md; VERIFIED: src/hooks/use-compare.ts:1; VERIFIED: node_modules/next/dist/docs/01-app/03-api-reference/05-config/01-next-config-js/viewTransition.md; CITED: https://github.com/vercel/next.js/issues/85693] |
</phase_requirements>

## Summary

Use the native same-document View Transition API directly from a small client-only helper, not the Next.js experimental integration and not React canary view-transition components. [CITED: https://developer.mozilla.org/en-US/docs/Web/API/Document/startViewTransition; VERIFIED: node_modules/next/dist/docs/01-app/03-api-reference/05-config/01-next-config-js/viewTransition.md; CITED: https://react.dev/reference/react/ViewTransition]

The planner should split week navigation into two phases: fetch and prepare the new compare data while the old calendar stays mounted, then call `document.startViewTransition()` only for the synchronous final state commit. [VERIFIED: .planning/phases/10-vpol-01-view-transitions/10-CONTEXT.md; VERIFIED: src/hooks/use-compare.ts:90-166; CITED: https://developer.chrome.com/docs/web-platform/view-transitions/same-document]

The highest-risk details are React commit timing, dynamic-import skeleton capture, and internal scroll restoration. [VERIFIED: src/components/compare/compare-panel.tsx:15-23; VERIFIED: src/components/compare/week-overview.tsx:315; VERIFIED: src/components/compare/compare-panel.tsx:263; CITED: https://react.dev/reference/react-dom/flushSync]

**Primary recommendation:** Implement `src/lib/ui/view-transitions.ts` as a typed platform helper with SSR/reduced-motion/unsupported/rapid-nav bypasses, then wire compare week/day handlers through a final-content commit path that uses `flushSync` only for the narrow DOM update required by `startViewTransition`. [VERIFIED: .planning/phases/10-vpol-01-view-transitions/10-CONTEXT.md; CITED: https://developer.chrome.com/docs/web-platform/view-transitions/same-document; CITED: https://react.dev/reference/react-dom/flushSync]

## Standard Stack

### Core

| Library / API | Version | Purpose | Why Standard |
|---------------|---------|---------|--------------|
| `document.startViewTransition()` | Browser API, Baseline 2025 on MDN | Same-document visual transition around a DOM update | It is the platform primitive for SPA view transitions and returns a `ViewTransition` object with `ready`, `finished`, `types`, and `skipTransition()`. [CITED: https://developer.mozilla.org/en-US/docs/Web/API/Document/startViewTransition; CITED: https://developer.mozilla.org/en-US/docs/Web/API/View_Transition_API/Using] |
| Next.js | Project installed `16.2.2`; npm latest observed `16.2.6` modified 2026-05-08 | App Router, `cacheComponents`, dynamic component loading | The project is pinned to Next 16.2.2 and local docs warn against production use of `experimental.viewTransition`. [VERIFIED: package.json; VERIFIED: ./node_modules/.bin/next --version; VERIFIED: npm --cache /private/tmp/npm-cache-gsd view next version time.modified; VERIFIED: node_modules/next/dist/docs/01-app/03-api-reference/05-config/01-next-config-js/viewTransition.md] |
| React / React DOM | Project installed `19.2.4`; npm latest observed `19.2.6` modified 2026-05-08 | Client state commit and `flushSync` for browser API integration | The installed React package does not export `ViewTransition` or `addTransitionType`, so this phase should not rely on React canary APIs. [VERIFIED: package.json; VERIFIED: node -e "const react=require('react'); console.log(typeof react.ViewTransition, typeof react.addTransitionType)"; CITED: https://react.dev/reference/react/ViewTransition] |
| TypeScript DOM lib | TypeScript installed `5.9.3`; npm latest observed `6.0.3` modified 2026-04-16 | Types for `Document.startViewTransition`, `ViewTransition`, and transition options | `lib.dom.d.ts` in the installed TypeScript includes `startViewTransition(callbackOptions?: ViewTransitionUpdateCallback | StartViewTransitionOptions): ViewTransition`, so no local type augmentation is expected. [VERIFIED: node -e "const ts=require('typescript'); console.log(ts.version)"; VERIFIED: rg -n "startViewTransition" node_modules/typescript/lib/lib.dom.d.ts] |
| Tailwind CSS / global CSS | Project uses Tailwind `^4` and `src/app/globals.css` | Defines transition pseudo-element CSS and reduced-motion overrides | `globals.css` is the existing global stylesheet for theme tokens and is the correct place for `::view-transition-*` selectors. [VERIFIED: package.json; VERIFIED: src/app/globals.css] |

### Supporting

| Library / Tool | Version | Purpose | When to Use |
|----------------|---------|---------|-------------|
| Vitest | Installed `4.1.5`; npm latest observed `4.1.5` modified 2026-05-05 | Unit/source tests for helper behavior, CSS presence, and guardrails | Use for helper tests with mocked `document`, reduced-motion checks, and source-level assertions against `next.config.ts` and `globals.css`. [VERIFIED: ./node_modules/.bin/vitest --version; VERIFIED: npm --cache /private/tmp/npm-cache-gsd view vitest version time.modified; VERIFIED: vitest.config.ts] |
| Browser plugin / in-app browser | Session plugin available | Rendered verification of transitions, scrollTop, reduced motion, and skeleton avoidance | Use for post-implementation QA because node-based Vitest cannot prove native browser transition rendering. [VERIFIED: Browser plugin skill list in session; VERIFIED: /Users/kevinhsieh/.codex/plugins/cache/openai-bundled/browser-use/0.1.0-alpha2/skills/browser/SKILL.md] |
| Playwright CLI wrapper | Wrapper available; `npx` available | Fallback browser automation path | Use only if Browser plugin invocation fails or a terminal-driven browser check is explicitly preferred. [VERIFIED: command -v npx; VERIFIED: test -x /Users/kevinhsieh/.codex/skills/playwright/scripts/playwright_cli.sh] |

### Alternatives Considered

| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| Native `document.startViewTransition()` helper | Next.js `experimental.viewTransition` | Do not use: local Next docs mark the flag experimental and advise against production use; GitHub issue #85693 is still open for `cacheComponents` interaction as of 2026-05-09. [VERIFIED: node_modules/next/dist/docs/01-app/03-api-reference/05-config/01-next-config-js/viewTransition.md; CITED: https://github.com/vercel/next.js/issues/85693] |
| Native helper | React `<ViewTransition>` / `addTransitionType` | Do not use: React docs list `<ViewTransition>` as Canary-only, and installed React exports are `undefined` for both APIs. [CITED: https://react.dev/reference/react/ViewTransition; VERIFIED: node -e "const react=require('react'); console.log(typeof react.ViewTransition, typeof react.addTransitionType)"] |
| Platform CSS animations on view-transition pseudo-elements | Framer Motion / Motion One / React Spring | Do not add: Phase context explicitly forbids new animation dependencies, and the needed motions are slide/crossfade platform transitions. [VERIFIED: .planning/phases/10-vpol-01-view-transitions/10-CONTEXT.md; CITED: https://developer.mozilla.org/en-US/docs/Web/API/View_Transition_API/Using] |
| Manual CSS fallback animations for unsupported browsers | CSS class transitions on calendar wrapper | Do not build: unsupported browsers should silently commit instantly per D-14. [VERIFIED: .planning/phases/10-vpol-01-view-transitions/10-CONTEXT.md] |

**Installation:**

```bash
# No package installation for Phase 10.
```

**Version verification:** `npm view` initially failed against `~/.npm` because that cache contains root-owned files, then registry checks succeeded with `--cache /private/tmp/npm-cache-gsd`. [VERIFIED: npm view command output; VERIFIED: npm --cache /private/tmp/npm-cache-gsd view next version time.modified]

## Architecture Patterns

### Recommended Project Structure

```text
src/
├── lib/ui/view-transitions.ts                  # typed native helper, SSR/reduced-motion/unsupported/rapid bypasses
├── lib/ui/__tests__/view-transitions.test.ts   # mocked-document helper tests
├── components/compare/compare-panel.tsx        # handlers, scroll refs, transition surface attrs/classes
├── hooks/use-compare.ts                        # final-content week fetch/commit path
└── app/globals.css                             # named view-transition CSS + reduced-motion override
```

This structure keeps platform transition logic under `src/lib/ui/`, leaves data/cache code under `src/lib/search/` untouched, and confines UI wiring to the compare client surface. [VERIFIED: .planning/phases/10-vpol-01-view-transitions/10-CONTEXT.md; VERIFIED: src/hooks/use-compare.ts; VERIFIED: src/components/compare/compare-panel.tsx; VERIFIED: src/lib/search/cache-version.ts]

### Pattern 1: Client-Only Native Helper

**What:** Export a small helper such as `runViewTransition(update, options)` that checks `typeof document`, `document.startViewTransition`, `matchMedia("(prefers-reduced-motion: reduce)")`, and rapid-navigation metadata before deciding whether to animate. [VERIFIED: .planning/phases/10-vpol-01-view-transitions/10-CONTEXT.md; CITED: https://developer.mozilla.org/en-US/docs/Web/API/Document/startViewTransition; CITED: https://developer.mozilla.org/en-US/docs/Web/CSS/Reference/At-rules/@media/prefers-reduced-motion]

**When to use:** Use for compare week commits and day tab commits only; do not wrap page navigation, RSC streaming boundaries, or server data calls. [VERIFIED: .planning/phases/10-vpol-01-view-transitions/10-CONTEXT.md; VERIFIED: src/components/compare/compare-panel.tsx]

**Example:**

```ts
// Source: MDN startViewTransition + Chrome same-document docs + Phase 10 decisions.
export type ViewTransitionKind = "week-forward" | "week-back" | "day";

export function shouldBypassViewTransition(options: {
  reducedMotion?: boolean;
  unsupported?: boolean;
  rapidNavigation?: boolean;
}) {
  return options.reducedMotion || options.unsupported || options.rapidNavigation;
}
```

The concrete helper should call `update()` directly on bypass paths and should avoid constructing CSS class names from arbitrary user input by using a TypeScript literal union. [CITED: https://developer.mozilla.org/en-US/docs/Web/API/Document/startViewTransition; VERIFIED: .planning/phases/10-vpol-01-view-transitions/10-CONTEXT.md]

### Pattern 2: Fetch Before Transition, Commit Inside Transition

**What:** For week changes, fetch the new compare response first while the old calendar remains mounted, then start the view transition and synchronously commit final state. [VERIFIED: .planning/phases/10-vpol-01-view-transitions/10-CONTEXT.md; CITED: https://developer.chrome.com/docs/web-platform/view-transitions/same-document]

**Why:** Chrome docs explicitly recommend doing network fetches before `startViewTransition()` because the page is frozen while the update callback is pending. [CITED: https://developer.chrome.com/docs/web-platform/view-transitions/same-document]

**React timing implication:** The update callback must leave the DOM updated before it returns; React's `flushSync` is the official escape hatch for browser APIs that need synchronous DOM updates, but React warns it can hurt performance and can force Suspense fallbacks if used while work is pending. [CITED: https://react.dev/reference/react-dom/flushSync]

**Example:**

```tsx
// Source: Chrome framework guidance + React flushSync docs.
await preloadCalendarChunks();
const nextCompare = await fetchCompareData(targetWeek);
const scrollTop = captureCalendarScrollTop();

runViewTransition(() => {
  flushSync(() => commitCompareWeek(targetWeek, nextCompare));
  restoreCalendarScrollTop(scrollTop);
}, { kind: direction });
```

The planner should create a data-returning fetch path or a deferred-commit option in `useCompare`; the current `fetchCompare()` commits state and toggles `compareLoading`, which would hide the calendar before the transition target exists. [VERIFIED: src/hooks/use-compare.ts:90-166; VERIFIED: src/components/compare/compare-panel.tsx:151-157]

### Pattern 3: Scoped Calendar Snapshot

**What:** Use one named calendar surface, not the default full-page root snapshot, for week and day transitions. [CITED: https://developer.mozilla.org/en-US/docs/Web/API/View_Transition_API/Using; CITED: https://developer.chrome.com/docs/web-platform/view-transitions/same-document]

**When to use:** Apply the transition name only while an active calendar transition type is running, and ensure only one rendered element has the chosen `view-transition-name`. [CITED: https://developer.mozilla.org/en-US/docs/Web/API/View_Transition_API/Using]

**Example CSS:**

```css
/* Source: MDN/Chrome view-transition pseudo-elements and types. */
html:active-view-transition-type(bgs-week-forward),
html:active-view-transition-type(bgs-week-back),
html:active-view-transition-type(bgs-day) {
  view-transition-name: none;
}

html:active-view-transition-type(bgs-week-forward) [data-vt-surface="compare-calendar"],
html:active-view-transition-type(bgs-week-back) [data-vt-surface="compare-calendar"],
html:active-view-transition-type(bgs-day) [data-vt-surface="compare-calendar"] {
  view-transition-name: bgs-compare-calendar;
}
```

The named element should be the compare calendar surface in `ComparePanel`, because `ComparePanel` owns week controls, day tabs, density day clicks, and the day-view scroll wrapper. [VERIFIED: src/components/compare/compare-panel.tsx:160-287]

### Pattern 4: Scroll Capture / Restore Inside the Commit

**What:** Capture `scrollTop` from the currently active calendar scroll element before mutation, and restore the new active scroll element immediately after the synchronous state commit. [VERIFIED: .planning/phases/10-vpol-01-view-transitions/10-CONTEXT.md; VERIFIED: src/components/compare/week-overview.tsx:315; VERIFIED: src/components/compare/compare-panel.tsx:263]

**When to use:** Use for week changes, week-to-day/day-to-week changes, density day clicks, and day-to-day tab changes. [VERIFIED: .planning/phases/10-vpol-01-view-transitions/10-CONTEXT.md; VERIFIED: src/components/compare/compare-panel.tsx:217-287]

**Example:**

```ts
// Source: Phase 10 D-09..D-12 + DOM scrollTop behavior.
export function captureScrollTop(el: HTMLElement | null): number {
  return el?.scrollTop ?? 0;
}

export function restoreScrollTop(el: HTMLElement | null, top: number) {
  if (el) el.scrollTop = top;
}
```

Do not restore only in a later `requestAnimationFrame`; the browser captures the new view after the update callback finishes, so late restoration can snapshot the wrong time-of-day position. [CITED: https://developer.mozilla.org/en-US/docs/Web/API/View_Transition_API/Using; CITED: https://react.dev/reference/react-dom/flushSync]

### Anti-Patterns to Avoid

- **Starting the transition before fetching week data:** This freezes the page and risks capturing loading UI, which violates D-05 and D-07. [VERIFIED: .planning/phases/10-vpol-01-view-transitions/10-CONTEXT.md; CITED: https://developer.chrome.com/docs/web-platform/view-transitions/same-document]
- **Calling plain `setState` in the native update callback and assuming React has committed:** React may batch updates asynchronously; use `flushSync` narrowly for the transition commit. [CITED: https://react.dev/reference/react-dom/flushSync; CITED: https://developer.chrome.com/docs/web-platform/view-transitions/same-document]
- **Leaving `compareLoading` as the week-change render gate:** Current `ComparePanel` hides the calendar behind `Loading schedules...` whenever `compareLoading` is true. [VERIFIED: src/components/compare/compare-panel.tsx:151-157]
- **Capturing `CalendarSkeleton`:** `WeekOverview` and `CalendarGrid` are dynamically imported with `CalendarSkeleton` loading fallbacks, so first-use transitions must preload chunks or bypass animation until the target chunk is ready. [VERIFIED: src/components/compare/compare-panel.tsx:15-23]
- **Setting duplicate `view-transition-name` values:** Duplicate rendered names cause the transition readiness promise to reject and skip the transition. [CITED: https://developer.mozilla.org/en-US/docs/Web/API/View_Transition_API/Using]
- **Animating for reduced-motion users in CSS only or JS only:** D-13 requires strict instant mode in both helper behavior and CSS pseudo-element animation rules. [VERIFIED: .planning/phases/10-vpol-01-view-transitions/10-CONTEXT.md; CITED: https://developer.mozilla.org/en-US/docs/Web/CSS/Reference/At-rules/@media/prefers-reduced-motion]

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Calendar state-change animation | A custom animation scheduler or animation library | Native `document.startViewTransition()` plus CSS pseudo-elements | The API separates DOM update from visual animation and already provides old/new snapshots. [CITED: https://drafts.csswg.org/css-view-transitions-1/; CITED: https://developer.mozilla.org/en-US/docs/Web/API/View_Transition_API/Using] |
| Framework-integrated route transitions | Next `experimental.viewTransition` or React canary components | Local client helper called from compare state handlers | Local docs warn against production use, installed React lacks the APIs, and the compare transitions are same-page state swaps. [VERIFIED: node_modules/next/dist/docs/01-app/03-api-reference/05-config/01-next-config-js/viewTransition.md; VERIFIED: node -e "const react=require('react'); console.log(typeof react.ViewTransition, typeof react.addTransitionType)"; VERIFIED: src/components/compare/compare-panel.tsx] |
| Unsupported-browser fallback | CSS transition fallback choreography | Instant direct commit | D-14 explicitly requires a silent instant fallback with no fallback animation. [VERIFIED: .planning/phases/10-vpol-01-view-transitions/10-CONTEXT.md] |
| Scroll restoration library | A generalized scroll manager | Two explicit refs/data attrs plus `scrollTop` capture/restore | There are exactly two calendar scroll containers in scope. [VERIFIED: src/components/compare/week-overview.tsx:315; VERIFIED: src/components/compare/compare-panel.tsx:263; VERIFIED: .planning/phases/10-vpol-01-view-transitions/10-CONTEXT.md] |
| Rapid-navigation queue | A transition queue or debounce framework | Existing AbortController fetch cancellation plus 300 ms animation bypass | `useCompare` already aborts in-flight compare fetches, and D-16 defines the rapid-nav window. [VERIFIED: src/hooks/use-compare.ts:88-103; VERIFIED: .planning/phases/10-vpol-01-view-transitions/10-CONTEXT.md] |

**Key insight:** This phase is not an animation-system build; it is a narrow platform-helper and commit-timing change around an already frozen compare UI. [VERIFIED: .planning/phases/10-vpol-01-view-transitions/10-CONTEXT.md; VERIFIED: .planning/STATE.md]

## Common Pitfalls

### Pitfall 1: Capturing Loading UI Instead of Final Content

**What goes wrong:** Week navigation captures `Loading schedules...` or `CalendarSkeleton` as the new view. [VERIFIED: src/components/compare/compare-panel.tsx:151-157; VERIFIED: src/components/compare/compare-panel.tsx:15-23]
**Why it happens:** The current `fetchCompare()` sets `compareLoading` before data arrives, and dynamic calendar components have skeleton fallbacks. [VERIFIED: src/hooks/use-compare.ts:105; VERIFIED: src/components/compare/compare-panel.tsx:15-23]
**How to avoid:** Fetch before starting the transition, keep current calendar mounted, preload calendar chunks, then commit final state inside the transition. [VERIFIED: .planning/phases/10-vpol-01-view-transitions/10-CONTEXT.md; CITED: https://developer.chrome.com/docs/web-platform/view-transitions/same-document]
**Warning signs:** Browser QA shows a white/gray skeleton flash, `Loading schedules...`, or a transition to empty calendar chrome. [VERIFIED: src/components/skeletons/calendar-skeleton.tsx; VERIFIED: src/components/compare/compare-panel.tsx:151-157]

### Pitfall 2: React State Does Not Commit Before the New Snapshot

**What goes wrong:** The transition does nothing, crossfades the same frame, or snapshots stale content. [CITED: https://developer.chrome.com/docs/web-platform/view-transitions/same-document; CITED: https://react.dev/reference/react-dom/flushSync]
**Why it happens:** Native `startViewTransition` expects the DOM update to complete inside its update callback; React state updates are normally batched. [CITED: https://developer.mozilla.org/en-US/docs/Web/API/Document/startViewTransition; CITED: https://react.dev/reference/react-dom/flushSync]
**How to avoid:** Use `flushSync` only inside the helper update callback for the final ready-data commit, never around the network fetch. [CITED: https://react.dev/reference/react-dom/flushSync; CITED: https://developer.chrome.com/docs/web-platform/view-transitions/same-document]
**Warning signs:** `ViewTransition.ready` resolves but old/new screenshots are identical, or scroll restoration applies after the animated frame. [CITED: https://developer.mozilla.org/en-US/docs/Web/API/View_Transition_API/Using]

### Pitfall 3: Duplicate or Overbroad View-Transition Names

**What goes wrong:** The browser skips the transition or animates the whole `/search` page, including unrelated search/filter UI. [CITED: https://developer.mozilla.org/en-US/docs/Web/API/View_Transition_API/Using; VERIFIED: .planning/research/PITFALLS.md]
**Why it happens:** The default root snapshot is page-wide, and duplicate `view-transition-name` values are invalid. [CITED: https://developer.mozilla.org/en-US/docs/Web/API/View_Transition_API/Using]
**How to avoid:** Disable the root snapshot only for active compare-calendar transition types and name a single calendar surface. [CITED: https://developer.chrome.com/docs/web-platform/view-transitions/same-document; VERIFIED: src/components/compare/compare-panel.tsx:262-287]
**Warning signs:** Search panel crossfades, sticky/popover layers appear in the transition overlay, or console shows a rejected `ready` promise. [CITED: https://developer.mozilla.org/en-US/docs/Web/API/View_Transition_API/Using]

### Pitfall 4: Scroll Restoration Happens Too Late

**What goes wrong:** Staff looking near 5pm land back near 7am after week/day switches. [VERIFIED: .planning/phases/10-vpol-01-view-transitions/10-CONTEXT.md]
**Why it happens:** Week view scrolls inside `WeekOverview`, while day view scrolls in the `ComparePanel` wrapper. [VERIFIED: src/components/compare/week-overview.tsx:315; VERIFIED: src/components/compare/compare-panel.tsx:263]
**How to avoid:** Keep a single active-scroll resolver that can find week or day container, then restore inside the transition update callback after the React commit. [VERIFIED: .planning/phases/10-vpol-01-view-transitions/10-CONTEXT.md; CITED: https://react.dev/reference/react-dom/flushSync]
**Warning signs:** Week-to-day works but day-to-week resets, or day-to-day tab switches preserve one container but not the other. [VERIFIED: .planning/phases/10-vpol-01-view-transitions/10-CONTEXT.md]

### Pitfall 5: Reduced Motion Still Pays Transition Cost

**What goes wrong:** CSS animation is disabled, but the helper still starts view transitions and freezes rendering briefly. [VERIFIED: .planning/phases/10-vpol-01-view-transitions/10-CONTEXT.md; CITED: https://developer.chrome.com/docs/web-platform/view-transitions/same-document]
**Why it happens:** Teams add only the `@media` CSS block and forget JS feature gating. [CITED: https://react.dev/reference/react/ViewTransition; CITED: https://developer.mozilla.org/en-US/docs/Web/CSS/Reference/At-rules/@media/prefers-reduced-motion]
**How to avoid:** Check reduced motion before calling `document.startViewTransition`, and keep CSS as a second guard. [VERIFIED: .planning/phases/10-vpol-01-view-transitions/10-CONTEXT.md; CITED: https://developer.mozilla.org/en-US/docs/Web/CSS/Reference/At-rules/@media/prefers-reduced-motion]
**Warning signs:** Reduced-motion browser QA still shows delayed interaction or a transition overlay in DevTools animations. [CITED: https://developer.chrome.com/docs/web-platform/view-transitions/same-document]

## Code Examples

### Helper Option Shape

```ts
// Source: Phase 10 D-17 + MDN startViewTransition options/types.
export interface CalendarViewTransitionOptions {
  kind: "week-forward" | "week-back" | "day";
  skip?: boolean;
}
```

Use a literal union so CSS transition types are controlled by code, not user input. [VERIFIED: .planning/phases/10-vpol-01-view-transitions/10-CONTEXT.md; CITED: https://developer.mozilla.org/en-US/docs/Web/API/Document/startViewTransition]

### Reduced-Motion CSS Guard

```css
/* Source: MDN prefers-reduced-motion + Phase 10 D-13. */
@media (prefers-reduced-motion: reduce) {
  ::view-transition-group(*),
  ::view-transition-old(*),
  ::view-transition-new(*) {
    animation: none !important;
  }
}
```

The JS helper should still bypass before calling the browser API for reduced-motion users. [VERIFIED: .planning/phases/10-vpol-01-view-transitions/10-CONTEXT.md; CITED: https://developer.mozilla.org/en-US/docs/Web/CSS/Reference/At-rules/@media/prefers-reduced-motion]

### Week Direction

```ts
// Source: Phase 10 D-01/D-02 + existing ISO week strings.
function getWeekDirection(currentWeek: string, targetWeek: string) {
  return targetWeek > currentWeek ? "week-forward" : "week-back";
}
```

The existing `weekStart` and `shiftWeek()` values use ISO-like `YYYY-MM-DD` strings, so lexical comparison is suitable for direction after inputs are normalized to that format. [VERIFIED: src/hooks/use-compare.ts:15-41; VERIFIED: src/hooks/use-compare.ts:84]

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| Framework/page-wide transition wrappers | Scoped native same-document transition around client DOM commits | MDN marks `startViewTransition()` Baseline 2025, and Chrome docs document same-document SPA use. [CITED: https://developer.mozilla.org/en-US/docs/Web/API/Document/startViewTransition; CITED: https://developer.chrome.com/docs/web-platform/view-transitions/same-document] | Use direct platform API for this same-page compare panel. |
| Temporary root classes for direction | `startViewTransition({ update, types })` with `:active-view-transition-type()` selectors | Chrome docs call transition types the modern approach for multiple transition styles. [CITED: https://developer.chrome.com/docs/web-platform/view-transitions/same-document] | Encode week-forward/week-back/day in types, with class/data fallback only if implementation finds a target browser lacking type support. |
| React canary `<ViewTransition>` | Native helper because installed React does not export canary transition APIs | React docs list `<ViewTransition>` as Canary-only; local runtime shows missing exports. [CITED: https://react.dev/reference/react/ViewTransition; VERIFIED: node -e "const react=require('react'); console.log(typeof react.ViewTransition, typeof react.addTransitionType)"] | Do not import canary APIs. |
| Next `experimental.viewTransition` | Leave `next.config.ts` at `cacheComponents: true` only | Next local docs advise against production use; GitHub issue #85693 remains open. [VERIFIED: node_modules/next/dist/docs/01-app/03-api-reference/05-config/01-next-config-js/viewTransition.md; CITED: https://github.com/vercel/next.js/issues/85693] | Do not touch framework config. |

**Deprecated/outdated:**

- `experimental.viewTransition` in `next.config.ts` is not appropriate for this phase because local docs call it experimental and advise against production use. [VERIFIED: node_modules/next/dist/docs/01-app/03-api-reference/05-config/01-next-config-js/viewTransition.md]
- React `<ViewTransition>` is not appropriate because React docs mark it Canary-only and the installed stable package does not export it. [CITED: https://react.dev/reference/react/ViewTransition; VERIFIED: node -e "const react=require('react'); console.log(typeof react.ViewTransition, typeof react.addTransitionType)"]
- Animation libraries are out of scope because user decisions forbid Framer Motion, Motion One, React canary APIs, and new animation dependencies. [VERIFIED: .planning/phases/10-vpol-01-view-transitions/10-CONTEXT.md]

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|

**This table is empty:** All planning-critical claims in this research were verified in local files, local package docs, registry output, or cited official/current docs. [VERIFIED: local command outputs; CITED: Sources section]

## Open Questions

1. **Should the implementation show a small pending affordance while week data fetches?** [VERIFIED: .planning/phases/10-vpol-01-view-transitions/10-CONTEXT.md]
   - What we know: Current full-panel loading must not replace the calendar during animated week changes. [VERIFIED: .planning/phases/10-vpol-01-view-transitions/10-CONTEXT.md; VERIFIED: src/components/compare/compare-panel.tsx:151-157]
   - What's unclear: Whether staff need a subtle non-disruptive pending indicator during the fetch window. [VERIFIED: .planning/phases/10-vpol-01-view-transitions/10-CONTEXT.md]
   - Recommendation: Plan no new pending affordance unless QA shows week fetch latency feels ambiguous; if added, keep it outside the named transition surface. [VERIFIED: src/components/compare/compare-panel.tsx:207-214]

2. **Should first-ever day-view chunk load animate or bypass?** [VERIFIED: src/components/compare/compare-panel.tsx:15-23]
   - What we know: `CalendarGrid` and `WeekOverview` are dynamic imports with skeleton fallbacks. [VERIFIED: src/components/compare/compare-panel.tsx:15-23]
   - What's unclear: Whether chunks are already loaded in normal production sessions by the time a staff user first switches views. [VERIFIED: src/components/compare/compare-panel.tsx:15-23]
   - Recommendation: Preload both chunks once compare data is visible, and bypass animation if preload has not resolved. [CITED: https://developer.chrome.com/docs/web-platform/view-transitions/same-document; VERIFIED: src/components/compare/compare-panel.tsx:157-287]

## Environment Availability

| Dependency | Required By | Available | Version | Fallback |
|------------|-------------|-----------|---------|----------|
| Node.js | Next/Vitest commands | Yes | `v20.20.2` | None needed. [VERIFIED: node --version] |
| npm / npx | scripts and Playwright wrapper | Yes | npm `10.8.2`, npx at `/opt/homebrew/bin/npx` | None needed. [VERIFIED: npm --version; VERIFIED: command -v npx] |
| Next CLI | build/dev validation | Yes | `Next.js v16.2.2` | None needed. [VERIFIED: ./node_modules/.bin/next --version] |
| Vitest CLI | unit/source tests | Yes | `vitest/4.1.5 darwin-arm64 node-v20.20.2` | None needed. [VERIFIED: ./node_modules/.bin/vitest --version] |
| Browser plugin | rendered transition QA | Yes in current Codex session | Browser plugin listed and skill file loaded | Playwright CLI wrapper if Browser invocation fails. [VERIFIED: Browser plugin skill list in session; VERIFIED: browser skill file] |
| Playwright CLI wrapper | fallback browser QA | Yes | wrapper script exists; project does not include `@playwright/test` | Use wrapper for ad-hoc QA, not committed E2E tests unless explicitly planned. [VERIFIED: test -x /Users/kevinhsieh/.codex/skills/playwright/scripts/playwright_cli.sh; VERIFIED: test -d node_modules/@playwright/test] |

**Missing dependencies with no fallback:** None identified. [VERIFIED: Environment probes above]

**Missing dependencies with fallback:** `@playwright/test` is not installed in the project, but Browser plugin and the Playwright CLI wrapper are available for rendered QA. [VERIFIED: test -d node_modules/@playwright/test; VERIFIED: Browser plugin skill list in session]

## Validation Architecture

### Test Framework

| Property | Value |
|----------|-------|
| Framework | Vitest unit project, installed `4.1.5`. [VERIFIED: vitest.config.ts; VERIFIED: ./node_modules/.bin/vitest --version] |
| Config file | `vitest.config.ts`. [VERIFIED: vitest.config.ts] |
| Quick run command | `npm test -- src/lib/ui/__tests__/view-transitions.test.ts src/components/compare/__tests__/view-transitions-source.test.ts` [VERIFIED: package.json; VERIFIED: vitest.config.ts] |
| Full suite command | `npm test` [VERIFIED: package.json] |

### Phase Requirements -> Test Map

| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|--------------|
| TRANS-01 | Week navigation uses native helper and bypasses unsupported/reduced/rapid cases | Unit + source + browser smoke | `npm test -- src/lib/ui/__tests__/view-transitions.test.ts` plus Browser week prev/next smoke | No, Wave 0. [VERIFIED: rg --files] |
| TRANS-02 | Day-tab switches animate without fallback capture | Source + browser smoke | `npm test -- src/components/compare/__tests__/view-transitions-source.test.ts` plus Browser day switch smoke | No, Wave 0. [VERIFIED: rg --files] |
| TRANS-03 | Reduced motion skips helper and CSS animations | Unit + source + browser emulation/manual | `npm test -- src/lib/ui/__tests__/view-transitions.test.ts src/components/compare/__tests__/view-transitions-source.test.ts` | No, Wave 0. [VERIFIED: rg --files] |
| TRANS-04 | ScrollTop preserved in week/day containers | Unit helper + browser interaction | `npm test -- src/lib/ui/__tests__/view-transitions.test.ts` plus Browser scroll interaction | No, Wave 0. [VERIFIED: rg --files] |
| TRANS-05 | Helper location and no RSC/framework config wrapping | Source/guardrail test | `npm test -- src/components/compare/__tests__/view-transitions-source.test.ts` and `rg -n "viewTransition" next.config.ts src/app src/lib/ui src/components/compare src/hooks` | No, Wave 0. [VERIFIED: rg --files; VERIFIED: next.config.ts] |

### Sampling Rate

- **Per task commit:** Run the quick Vitest command for the touched helper/source tests. [VERIFIED: vitest.config.ts]
- **Per wave merge:** Run `npm test` and `npm run lint`. [VERIFIED: package.json]
- **Phase gate:** Run full unit suite plus Browser QA on `/search` for week prev, next, today, calendar-popup selection, week-to-day, day-to-day, reduced-motion, and scroll preservation. [VERIFIED: .planning/REQUIREMENTS.md; VERIFIED: browser skill file]

### Wave 0 Gaps

- [ ] `src/lib/ui/view-transitions.ts` — helper required by TRANS-05. [VERIFIED: rg --files]
- [ ] `src/lib/ui/__tests__/view-transitions.test.ts` — helper behavior tests for unsupported browser, SSR, reduced motion, rapid nav, and transition type mapping. [VERIFIED: rg --files]
- [ ] `src/components/compare/__tests__/view-transitions-source.test.ts` — source guardrails for `globals.css`, `next.config.ts`, no animation dependency imports, and no RSC wrapper usage. [VERIFIED: rg --files]
- [ ] Browser QA checklist artifact in the phase verification file — rendered transition behavior cannot be fully proven in node-only Vitest. [VERIFIED: vitest.config.ts; VERIFIED: browser skill file]

## Security Domain

### Applicable ASVS Categories

| ASVS Category | Applies | Standard Control |
|---------------|---------|------------------|
| V2 Authentication | No new auth behavior | Existing Auth.js/admin allowlist remains untouched. [VERIFIED: AGENTS.md; VERIFIED: src/lib/auth.ts] |
| V3 Session Management | No new session behavior | Do not touch cookies/session handling. [VERIFIED: .planning/phases/10-vpol-01-view-transitions/10-CONTEXT.md] |
| V4 Access Control | No new access-control behavior | Keep changes inside authenticated compare UI; no API route changes expected. [VERIFIED: .planning/phases/10-vpol-01-view-transitions/10-CONTEXT.md; VERIFIED: src/components/compare/compare-panel.tsx] |
| V5 Input Validation | Yes, narrow | Transition kind/direction should be a typed literal union, not a user-provided CSS selector or arbitrary string. [VERIFIED: .planning/phases/10-vpol-01-view-transitions/10-CONTEXT.md] |
| V6 Cryptography | No | No secrets, crypto, or token handling in this UI phase. [VERIFIED: .planning/phases/10-vpol-01-view-transitions/10-CONTEXT.md] |

### Known Threat Patterns for This Stack

| Pattern | STRIDE | Standard Mitigation |
|---------|--------|---------------------|
| User-controlled CSS transition type or selector | Tampering | Use a TypeScript literal union and static mapping to browser transition `types`. [CITED: https://developer.mozilla.org/en-US/docs/Web/API/Document/startViewTransition; VERIFIED: TypeScript installed DOM types] |
| UI confusion from stale or loading-state capture | Spoofing / Information integrity | Fetch before transition and commit only final loaded compare response; preserve strict data display rules. [VERIFIED: AGENTS.md; VERIFIED: .planning/phases/10-vpol-01-view-transitions/10-CONTEXT.md] |
| Accessibility harm from motion | Denial of usability | JS reduced-motion bypass plus CSS `@media (prefers-reduced-motion: reduce)` override. [CITED: https://developer.mozilla.org/en-US/docs/Web/CSS/Reference/At-rules/@media/prefers-reduced-motion; VERIFIED: .planning/phases/10-vpol-01-view-transitions/10-CONTEXT.md] |

## Sources

### Primary (HIGH confidence)

- Local Next docs: `node_modules/next/dist/docs/01-app/03-api-reference/05-config/01-next-config-js/viewTransition.md` — experimental flag status and production caution. [VERIFIED: local file read]
- Local Next docs: `node_modules/next/dist/docs/01-app/03-api-reference/05-config/01-next-config-js/cacheComponents.md` — `cacheComponents` and React Activity state preservation behavior. [VERIFIED: local file read]
- Local Next docs: `node_modules/next/dist/docs/01-app/02-guides/upgrading/version-16.md` — React 19.2 and `cacheComponents` references. [VERIFIED: local file read]
- MDN `Document.startViewTransition()` — syntax, callback/options, types, return value, Baseline 2025. [CITED: https://developer.mozilla.org/en-US/docs/Web/API/Document/startViewTransition]
- MDN `Using the View Transition API` — process, pseudo-elements, unique `view-transition-name`, reduced interaction points. [CITED: https://developer.mozilla.org/en-US/docs/Web/API/View_Transition_API/Using]
- Chrome for Developers same-document view transitions — fetch-before-transition guidance, React `flushSync` framework note, transition types, skip behavior. [CITED: https://developer.chrome.com/docs/web-platform/view-transitions/same-document]
- React `flushSync` docs — synchronous DOM update for browser API integration and caveats. [CITED: https://react.dev/reference/react-dom/flushSync]
- React `<ViewTransition>` docs — canary status and reduced-motion note. [CITED: https://react.dev/reference/react/ViewTransition]
- MDN `prefers-reduced-motion` — media feature purpose and `reduce` value. [CITED: https://developer.mozilla.org/en-US/docs/Web/CSS/Reference/At-rules/@media/prefers-reduced-motion]
- W3C CSS View Transitions Module Level 1 draft — API model, lifecycle, visual enhancement behavior. [CITED: https://drafts.csswg.org/css-view-transitions-1/]

### Secondary (MEDIUM confidence)

- Vercel/Next.js GitHub issue #85693 — current open bug report for `experimental.viewTransition` with `cacheComponents` mode. [CITED: https://github.com/vercel/next.js/issues/85693]
- Project research docs under `.planning/research/` — prior VPOL-01 architecture/pitfall guidance; reconciled with current local docs and current Phase 10 decisions. [VERIFIED: .planning/research/ARCHITECTURE.md; VERIFIED: .planning/research/PITFALLS.md; VERIFIED: .planning/research/STACK.md]

### Tertiary (LOW confidence)

- None used as authoritative support. [VERIFIED: source review process]

## Metadata

**Confidence breakdown:**

- Standard stack: HIGH — package versions, installed exports, local Next docs, and npm registry metadata were checked. [VERIFIED: package.json; VERIFIED: npm --cache /private/tmp/npm-cache-gsd view next version time.modified; VERIFIED: node -e "const react=require('react'); console.log(typeof react.ViewTransition, typeof react.addTransitionType)"]
- Architecture: HIGH — integration points are directly visible in `useCompare`, `ComparePanel`, `WeekOverview`, and `CalendarGrid`. [VERIFIED: src/hooks/use-compare.ts; VERIFIED: src/components/compare/compare-panel.tsx; VERIFIED: src/components/compare/week-overview.tsx; VERIFIED: src/components/compare/calendar-grid.tsx]
- Pitfalls: MEDIUM-HIGH — API lifecycle and React commit concerns are documented, but actual browser rendering must be verified after implementation. [CITED: https://developer.chrome.com/docs/web-platform/view-transitions/same-document; CITED: https://react.dev/reference/react-dom/flushSync; VERIFIED: browser skill file]

**Research date:** 2026-05-09 [VERIFIED: system current_date]
**Valid until:** 2026-05-16 because Next/React view-transition APIs and browser support are fast-moving. [VERIFIED: npm registry versions modified 2026-05-08; CITED: https://react.dev/reference/react/ViewTransition]
