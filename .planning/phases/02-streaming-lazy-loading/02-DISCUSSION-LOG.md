# Phase 2: Streaming & Lazy Loading - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-04-10
**Phase:** 02-streaming-lazy-loading
**Areas discussed:** Server/Client boundary, Skeleton design, Lazy loading triggers, Cache strategy

---

## Server/Client Boundary

### Q1: How should server data reach the client components?

| Option | Description | Selected |
|--------|-------------|----------|
| Props drilling (Recommended) | page.tsx becomes async Server Component, fetches filters+tutors, passes as props to client SearchWorkspace. Simple, no context providers. | |
| Suspense boundaries per section | Multiple Suspense wrappers: one for SearchForm (filters), one for TutorCombobox (tutor list). Each streams independently. | |
| You decide | Claude picks the approach that best fits the Phase 1 component structure. | ✓ |

**User's choice:** You decide — Claude's discretion
**Notes:** User trusts Claude to pick the best RSC boundary approach given Phase 1's component structure.

### Q2: Should the search page show anything before filter/tutor data arrives?

| Option | Description | Selected |
|--------|-------------|----------|
| Stream progressively (Recommended) | Show skeleton shell immediately, sections fill in as data arrives. | ✓ |
| Block until all data ready | Wait for all server data before rendering. Simpler but longer perceived wait. | |
| Shell + inline spinners | Full layout immediately with spinner icons inside each section. | |

**User's choice:** Stream progressively
**Notes:** First answer was "Block until ready" (misclick). Re-asked and user selected progressive streaming.

---

## Skeleton Design

### Q3: What style of skeleton loading?

| Option | Description | Selected |
|--------|-------------|----------|
| Shimmer animated (Recommended) | Gray placeholder blocks with subtle shimmer/pulse animation. Standard pattern. | ✓ |
| Static gray blocks | Plain gray rectangles. No animation. Minimal but can feel frozen. | |
| You decide | Claude picks the style fitting the sky blue design system. | |

**User's choice:** Shimmer animated

### Q4: How closely should skeletons match the real layout?

| Option | Description | Selected |
|--------|-------------|----------|
| High fidelity (Recommended) | Skeleton mirrors exact layout: side-by-side panels, form field shapes, calendar grid. | ✓ |
| Simplified placeholder | Generic card-shaped blocks. Faster to build but visible layout shift. | |
| You decide | Claude balances fidelity vs effort. | |

**User's choice:** High fidelity

---

## Lazy Loading Triggers

### Q5: When should heavy compare components load?

| Option | Description | Selected |
|--------|-------------|----------|
| On first tutor add (Recommended) | Load WeekOverview/CalendarGrid when first tutor added. DiscoveryPanel on modal open. | ✓ |
| On tab/modal activation | Each loads when its tab is active or modal opens. Most granular. | |
| On compare panel mount | Load all when right panel mounts. Simplest but defeats the purpose. | |
| You decide | Claude picks the trigger balancing bundle savings vs UX. | |

**User's choice:** On first tutor add

### Q6: What should compare panel show while lazy components load?

| Option | Description | Selected |
|--------|-------------|----------|
| Skeleton matching calendar grid | Same shimmer style, shaped like the week grid. Consistent. | ✓ |
| Empty state with spinner | Existing 'Select tutors' empty state with spinner overlay. | |
| You decide | Claude picks what fits the skeleton decisions above. | |

**User's choice:** Skeleton matching calendar grid

---

## Cache Strategy

### Q7: How should cached data be invalidated on new sync?

| Option | Description | Selected |
|--------|-------------|----------|
| Sync endpoint purges cache (Recommended) | sync-wise calls revalidateTag('snapshot') after promotion. Immediate, no stale data. | ✓ |
| Time-based TTL | Cache expires after fixed duration. Simple but up to 1hr stale window. | |
| You decide | Claude picks based on snapshot data model. | |

**User's choice:** Sync endpoint purges cache

### Q8: Should all API routes be cached or just filter/tutor data?

| Option | Description | Selected |
|--------|-------------|----------|
| Only filters + tutor list (Recommended) | Cache slow-changing snapshot-bound data. Search/compare stay uncached. | ✓ |
| Cache all read APIs | Also cache search/compare keyed by query params. Complex key management. | |
| You decide | Claude decides based on PERF-07 requirements. | |

**User's choice:** Only filters + tutor list

---

## Claude's Discretion

- RSC boundary approach (D-01)
- `next/dynamic` vs `React.lazy` choice
- Suspense boundary placement
- Cache implementation (`'use cache'` directive vs cached API routes)
- Skeleton component TypeScript interfaces

## Deferred Ideas

None — discussion stayed within phase scope.
