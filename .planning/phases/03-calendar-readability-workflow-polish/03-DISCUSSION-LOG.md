# Phase 3: Calendar Readability & Workflow Polish - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-04-16
**Phase:** 03-calendar-readability-workflow-polish
**Areas discussed:** Quick-add flow, Fullscreen compare, Lane identity, Today & conflicts

---

## Quick-add flow

| Option | Description | Selected |
|--------|-------------|----------|
| End of each row | Small '+' icon at the right edge of each tutor row. Always visible, one click to add. | ✓ |
| On hover only | '+' appears when hovering over a tutor row — cleaner but less discoverable | |
| Replace checkbox | Replace multi-select checkboxes with individual '+' buttons | |

**User's choice:** End of each row (Recommended)
**Notes:** None

---

| Option | Description | Selected |
|--------|-------------|----------|
| Instant add + brief flash | Tutor immediately appears as chip. '+' briefly flashes green/check. No toast. | ✓ |
| Instant add + toast | Tutor appears in compare panel. Small toast confirms 'Added [name]'. | |
| Instant add, no feedback | Tutor silently appears. User notices via chip appearing. | |

**User's choice:** Instant add + brief flash (Recommended)
**Notes:** None

---

| Option | Description | Selected |
|--------|-------------|----------|
| Disable with tooltip | '+' grays out. Hover shows 'Remove a tutor first (max 3)'. | ✓ |
| Replace oldest | Clicking '+' replaces the first-added tutor automatically. | |
| Show error toast | Button stays clickable but shows 'Max 3 tutors' toast. | |

**User's choice:** Disable with tooltip (Recommended)
**Notes:** None

---

| Option | Description | Selected |
|--------|-------------|----------|
| Yes, same behavior | Needs Review tutors can also be quick-added to compare | ✓ |
| No, only available tutors | Only tutors in the main availability grid get '+' | |

**User's choice:** Yes, same behavior
**Notes:** None

---

## Fullscreen compare

| Option | Description | Selected |
|--------|-------------|----------|
| Expand button on compare panel | Small expand icon in compare panel header. Click to toggle fullscreen. | ✓ |
| Auto-expand on 2+ tutors | Compare panel automatically goes fullscreen when 2+ tutors added. | |
| Separate /compare route | Full-page compare at its own URL. | |

**User's choice:** Expand button on compare panel (Recommended)
**Notes:** None

---

| Option | Description | Selected |
|--------|-------------|----------|
| Yes, combobox stays | Tutor chips + combobox + week picker all remain usable in fullscreen. | ✓ |
| Read-only view | Fullscreen for viewing only. Must exit to modify selection. | |

**User's choice:** Yes, combobox stays (Recommended)
**Notes:** None

---

| Option | Description | Selected |
|--------|-------------|----------|
| Hidden, slide transition | Search panel slides left and hides. Compare expands to full width smoothly. | ✓ |
| Overlay on top | Compare panel overlays the entire page like a modal. | |
| Collapsed to icon strip | Search panel shrinks to narrow icon strip on left edge. | |

**User's choice:** Hidden, slide transition (Recommended)
**Notes:** None

---

## Lane identity

| Option | Description | Selected |
|--------|-------------|----------|
| Subtle bg tint + header | Each tutor's column gets their color at 5% opacity. Small header label with name + color dot. | ✓ |
| Header only, no tint | Tutor name + color dot header only. No background coloring. | |
| Bold vertical dividers | Solid colored vertical lines between tutor lanes. | |

**User's choice:** Subtle bg tint + header (Recommended)
**Notes:** None

---

| Option | Description | Selected |
|--------|-------------|----------|
| Yes, sticky headers | Lane headers stay pinned at top during vertical scroll. | ✓ |
| No, scroll with content | Headers scroll with grid. Tutor names disappear when scrolled. | |

**User's choice:** Yes, sticky headers (Recommended)
**Notes:** None

---

| Option | Description | Selected |
|--------|-------------|----------|
| Same layout, wider lanes | Lanes expand proportionally. Session cards get wider and show more text. | ✓ |
| Show full student names | Wider lanes show complete student names and session details. | |
| You decide | Claude has discretion on fullscreen lane sizing. | |

**User's choice:** Same layout, wider lanes (Recommended)
**Notes:** None

---

## Today & conflicts

| Option | Description | Selected |
|--------|-------------|----------|
| Red horizontal line | GCal-style thin red line at current time. Small red dot at left edge. Real-time updates. | ✓ |
| Highlighted column | Today's entire column gets subtle background plus time line. | |
| You decide | Claude picks styling. | |

**User's choice:** Red horizontal line (Recommended)
**Notes:** None

---

| Option | Description | Selected |
|--------|-------------|----------|
| Per-day in day tab header | Small red badge with count next to each day tab (e.g. 'Mon 13/4 - 2'). | ✓ |
| Per-day on grid column | Badge floats at top of each day column in the week grid. | |
| Summary bar only | Single conflict summary bar above calendar showing total. | |

**User's choice:** Per-day in day tab header (Recommended)
**Notes:** None

---

## Claude's Discretion

- CSS transition timing/easing for fullscreen toggle
- Expand icon choice from lucide-react
- Sticky lane header implementation approach
- Today indicator update interval
- Conflict badge sizing and positioning
- Hover tooltip implementation for disabled '+' button
- Session card text wrapping in wider fullscreen lanes

## Deferred Ideas

None — discussion stayed within phase scope

---

*Generated: 2026-04-16*
