# Phase 10: VPOL-01 View Transitions - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md - this log preserves the alternatives considered.

**Date:** 2026-05-09
**Phase:** 10 - VPOL-01 View Transitions
**Areas discussed:** Motion Feel, Transition Timing, Scroll Preservation, Fallbacks & Fast Navigation

---

## Motion Feel

### Week navigation animation

| Option | Description | Selected |
|--------|-------------|----------|
| Directional slide | Next week moves left, previous week moves right; strongest calendar mental model. | yes |
| Crossfade | Quieter and safer, less spatial but less chance of feeling busy. | |
| Hybrid | Directional slide for prev/next, crossfade for Today/calendar-pick/day tabs. | |
| You decide | Planner chooses the most practical version. | |

**User's choice:** Directional slide.
**Notes:** Week prev/next should feel spatial.

### Today and calendar-pick jumps

| Option | Description | Selected |
|--------|-------------|----------|
| Directional by date | Slide left if target week is later, right if earlier. | yes |
| Crossfade | Use a neutral fade because jumps may skip many weeks. | |
| Instant for large jumps | Animate adjacent weeks only; jump instantly when target is more than one week away. | |
| You decide | Planner chooses. | |

**User's choice:** Directional by date.
**Notes:** Applies to Today and calendar-popup week selection.

### Day-tab switches

| Option | Description | Selected |
|--------|-------------|----------|
| Subtle crossfade | Day drill-down changes without implying horizontal week movement. | yes |
| Directional by weekday | Monday to Tuesday slides left, Tuesday to Monday slides right. | |
| Instant | Only week navigation gets motion. | |
| You decide | Planner chooses. | |

**User's choice:** Subtle crossfade.
**Notes:** Day tabs are not treated like week movement.

### Duration and tone

| Option | Description | Selected |
|--------|-------------|----------|
| Fast, utilitarian | At most 160 ms, very light easing. | yes |
| Standard polish | At most 200 ms, slightly more visible. | |
| Very subtle | At most 120 ms, barely perceptible. | |
| You decide | Planner chooses. | |

**User's choice:** Fast, utilitarian.
**Notes:** Admin workflow speed matters more than decorative motion.

---

## Transition Timing

### Week-change capture timing

| Option | Description | Selected |
|--------|-------------|----------|
| Animate final loaded content only | Fetch first, then transition when the new compare response is ready. | yes |
| Animate immediately on click | Transition into loading state, then content appears after fetch. | |
| Hybrid | Use immediate transition only when data is already cached; otherwise wait for loaded content. | |
| You decide | Planner chooses. | |

**User's choice:** Animate final loaded content only.
**Notes:** Avoid capturing loading skeletons or Suspense fallbacks.

### Cached week data

| Option | Description | Selected |
|--------|-------------|----------|
| Always final-content path | One timing model for all week changes; simplest and safest. | yes |
| Immediate if cached | Faster feel when the week is already in the client cache. | |
| You decide | Planner chooses. | |

**User's choice:** Always final-content path.
**Notes:** Consistency over a cached special case.

### Day-tab timing

| Option | Description | Selected |
|--------|-------------|----------|
| Wrap active-day state update directly | Day tabs animate immediately because content is local. | yes |
| Defer one frame before switching | Slightly safer DOM capture, more complexity. | |
| Only animate Week to Day, not Day to Day | Narrower surface. | |
| You decide | Planner chooses. | |

**User's choice:** Wrap the active-day state update directly.
**Notes:** No server fetch is involved.

### Week-fetch loading state

| Option | Description | Selected |
|--------|-------------|----------|
| Keep current content visible until replacement is ready | Avoids flicker; loading can be subtle or disabled during transition fetch. | yes |
| Show existing full loading state | Clear feedback but conflicts with final-content-only transition. | |
| Keep current content plus small pending indicator | More feedback, slightly more UI change. | |
| You decide | Planner chooses. | |

**User's choice:** Keep current content visible until replacement is ready.
**Notes:** Do not replace the calendar with the current full loading state during transition fetches.

---

## Scroll Preservation

### Week-change scroll behavior

| Option | Description | Selected |
|--------|-------------|----------|
| Preserve current scroll offset across all week changes | If staff are looking at 5pm, they stay near 5pm. | yes |
| Remember scroll per week | Returning to a week restores that week's previous scroll. | |
| Reset to top on new weeks | Preserve only browser back/forward style behavior. | |
| You decide | Planner chooses. | |

**User's choice:** Preserve current scroll offset across all week changes.
**Notes:** Scroll offset represents time-of-day context.

### Supported containers

| Option | Description | Selected |
|--------|-------------|----------|
| Both week view and day drill-down | WeekOverview internal scroll plus day-view wrapper. | yes |
| Week view only | Directly matches the most-used surface. | |
| Whichever view is active at transition time | Pragmatic wording; implementation discovers active container. | |
| You decide | Planner chooses. | |

**User's choice:** Both week view and day drill-down.
**Notes:** Phase 10 must explicitly cover both surfaces.

### Week to Day scroll

| Option | Description | Selected |
|--------|-------------|----------|
| Carry over the same time-of-day offset | Week at 5pm opens Day near 5pm. | yes |
| Each view keeps its own scroll offset | Week and Day are independent. | |
| Day tabs always reset to top | Simpler but loses context. | |
| You decide | Planner chooses. | |

**User's choice:** Carry over the same time-of-day offset.
**Notes:** Applies between Week and a Day tab.

### Day-to-day scroll

| Option | Description | Selected |
|--------|-------------|----------|
| Preserve time-of-day across all day switches | Consistent with scheduling workflow. | yes |
| Each day remembers its own offset | Per-day memory. | |
| Reset to top for each day | Simpler but loses context. | |
| You decide | Planner chooses. | |

**User's choice:** Preserve time-of-day across all day switches.
**Notes:** Applies to every supported day-tab switch.

---

## Fallbacks & Fast Navigation

### Reduced motion

| Option | Description | Selected |
|--------|-------------|----------|
| Strict instant mode | No view-transition animation at all; helper bypasses transition and CSS disables keyframes. | yes |
| CSS-only disable | Still call the API but set animation to none. | |
| Short fade allowed | Reduced but not zero motion. | |
| You decide | Planner chooses. | |

**User's choice:** Strict instant mode.
**Notes:** Reduced-motion users get instant navigation.

### Unsupported browsers

| Option | Description | Selected |
|--------|-------------|----------|
| Silent instant fallback | Same behavior, no warning. | yes |
| CSS class transition fallback | More complexity, broader motion support. | |
| Dev-console debug only | No animation but console hint for developers. | |
| You decide | Planner chooses. | |

**User's choice:** Silent instant fallback.
**Notes:** No user-facing fallback UI.

### Rapid week navigation

| Option | Description | Selected |
|--------|-------------|----------|
| Disable animation during rapid bursts | Close clicks update instantly to keep the tool responsive. | yes |
| Animate every click | Consistent but can feel laggy. | |
| Throttle clicks while transition runs | Prevents overlap but slows power users. | |
| You decide | Planner chooses. | |

**User's choice:** Disable animation during rapid bursts.
**Notes:** Power users can click through weeks quickly.

### Rapid-burst threshold

| Option | Description | Selected |
|--------|-------------|----------|
| 300 ms between navigation starts | Common debounce window; practical default. | yes |
| 200 ms | Stricter; only very fast repeats bypass animation. | |
| 500 ms | Broader; many normal clicks become instant. | |
| You decide | Planner chooses. | |

**User's choice:** 300 ms between navigation starts.
**Notes:** This threshold defines rapid week navigation.

---

## the agent's Discretion

- Exact helper API shape.
- Exact CSS selector/keyframe names.
- Exact ref plumbing for scroll capture and restore.
- Exact easing curve within the at-most-160-ms motion contract.

## Deferred Ideas

- Tutor add/remove shared-element transitions remain deferred to v1.2+.
- Fullscreen morph transition remains deferred to v1.2+.
- CSS animation fallback for unsupported browsers is out of scope.
- Per-week remembered scroll positions are out of scope.
