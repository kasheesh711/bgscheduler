# Feature Landscape

**Domain:** Multi-resource scheduling calendar UX (tutor availability comparison tool)
**Researched:** 2026-04-10

## Table Stakes

Features users expect from a multi-resource calendar comparison tool. Missing = product feels incomplete or amateurish.

| Feature | Why Expected | Complexity | Notes |
|---------|--------------|------------|-------|
| **Alternating lane backgrounds** | Every multi-resource calendar (GCal, FullCalendar, Outlook) uses alternating tinted backgrounds per resource lane. Without it, lanes blur together visually. The current app uses only thin `border-r border-border/20` dividers between tutor lanes, which is the #1 cited readability complaint. | Low | Alternate tutor-tinted bg at ~5% opacity behind each lane. Trivial CSS change in week-overview.tsx. |
| **Lane header labels on the calendar grid** | GCal side-by-side day view, FullCalendar resource view, and Outlook all show resource names directly above or inside each lane column, not just in a separate selector chip area. Users need to know which lane belongs to which tutor without cross-referencing the chip bar. | Low | Add small tutor name + color dot at top of each day-lane. Currently only shown in calendar-grid.tsx day view, not week-overview.tsx. |
| **Skeleton loading states** | Modern scheduling tools (Cal.com, Calendly, Google Calendar) show skeleton placeholders during data load rather than empty grids or spinners. The current app shows "Loading..." text. Users perceive skeleton UIs as 30-40% faster than spinner-based loading. | Low | shadcn/ui has a `<Skeleton>` component. Render a skeleton week grid while compare data loads. |
| **Hover tooltips on session blocks** | All calendar tools show event details on hover (not just click). The current app requires clicking to open a Popover. For scanning/comparison workflows, hover-to-preview is essential to avoid constant clicking. | Low | Add `title` attribute or a lightweight tooltip (shadcn `<Tooltip>`) showing student name, subject, time range on hover. Keep the full Popover on click for detailed info. |
| **Today indicator line** | GCal, Outlook, and every major calendar show a horizontal "now" line on the current day. Without it, users lose temporal context when comparing schedules. | Low | A single red/blue horizontal line at the current time position. Only show on today's column. |
| **Click-to-compare from search results** | The current flow requires: search -> select rows -> click "Compare (N)" button -> tutors appear in right panel. Best-in-class tools reduce this to: search -> click tutor name -> added to compare. The extra "select then batch-add" step adds friction. | Medium | Add a "+" icon on each search result row that directly adds to compare panel. Keep the batch "Compare (N)" button as an alternative for multi-select. |
| **Conflict count badge per day** | The current week overview shows a generic "!" next to days with conflicts. Tools like Calendly and resource schedulers show the actual count ("2 conflicts") so users can prioritize which day to drill into. | Low | Change `!` to a numbered badge, e.g., `<Badge variant="destructive">2</Badge>`. |

## Differentiators

Features that set the product apart. Not universally expected, but valued by admin staff doing daily tutor comparisons.

| Feature | Value Proposition | Complexity | Notes |
|---------|-------------------|------------|-------|
| **Inline free-slot actions** | When a shared free slot is identified, let users click it to pre-fill a "schedule here" action (copy time details, open Wise, etc.). Currently free slots are passive green tints with no interactivity. | Medium | Add click handler to free-gap divs. Open a small action popover with "Copy time slot" and link context. |
| **Keyboard navigation for week picker** | Arrow keys to move between weeks, Enter to select day. Admin staff doing repetitive comparisons benefit from keyboard shortcuts. Cal.com supports this. | Low | Add onKeyDown handlers to week picker prev/next/today buttons and day tabs. |
| **Sticky tutor legend on scroll** | When scrolling vertically through long schedules, the tutor color legend disappears above the fold. A sticky mini-legend (colored dots with initials) anchored to the top of the grid area maintains context. | Low | Already have sticky day headers. Add tutor dots to the same sticky bar. |
| **Animated transitions between views** | Week-to-day drill-down and tutor add/remove currently cause a full re-render. Subtle fade/slide transitions make the experience feel polished. | Medium | CSS transitions or `framer-motion` layout animations. Risk: performance cost if overused. Keep simple (opacity + transform). |
| **Drag-to-select time range** | Let users drag across the calendar grid to define a time range, then show which tutors are free during that range. Combines search and compare into one gesture. Google Calendar uses this for event creation. | High | Requires mouse event tracking, coordinate-to-time mapping, and integration with the search engine. Powerful but complex. |
| **Conflict resolution suggestions** | When a conflict is detected (same student booked with 2 tutors), suggest alternative slots where the conflict would be resolved. Currently shows the conflict but offers no next step. | High | Requires running search engine queries for alternative slots per conflict. Computationally expensive but high-value. |
| **Mini-map / density overview** | A small compressed view of the entire week showing session density as colored bands. Useful for quickly spotting busy vs. free days without scrolling. Outlook uses a "scheduling assistant" density bar. | Medium | Render a thin horizontal bar per tutor per day showing % booked. Place above the main grid. |
| **URL-shareable compare state** | Current app supports `?tutors=id1,id2` but not the week. Add `&week=2026-04-06` to make compare views fully shareable via URL. Admin staff can send links to each other. | Low | Already have URL param for tutors. Add weekStart to searchParams sync. |

## Anti-Features

Features to explicitly NOT build. These would add complexity without value for this use case.

| Anti-Feature | Why Avoid | What to Do Instead |
|--------------|-----------|-------------------|
| **Drag-and-drop event rescheduling** | This is a read-only comparison tool. The source of truth is Wise. Allowing drag-to-reschedule creates a write-back problem and data integrity risk. | Keep calendar read-only. Link to Wise for modifications. |
| **Real-time collaborative viewing** | Only 8 admin users. WebSocket infrastructure for real-time sync is massive overkill. The data changes once daily (cron sync). | Snapshot-based data with stale detection is sufficient. |
| **Full calendar library integration (FullCalendar, etc.)** | FullCalendar Premium costs money and adds a heavy dependency. The current custom grid is lightweight, fits the exact use case, and is already built. Adding a library means conforming to its API and losing customization control. | Continue with custom grid. Cherry-pick UX patterns (lane coloring, resource headers) without the library. |
| **Mobile-responsive calendar** | Out of scope per PROJECT.md. Admin staff use desktop exclusively. Mobile calendar grids are notoriously difficult and the effort is not justified. | Keep `overflow-hidden` body layout optimized for desktop. |
| **Inline session editing** | Same as drag-and-drop: this is a read-only tool. Edit forms create a false expectation that changes persist back to Wise. | Read-only with "Open in Wise" links where applicable. |
| **Multi-week view** | Showing 2+ weeks simultaneously makes the grid unreadably small. The week picker (prev/next/today) is the correct interaction for week navigation. | Keep single-week view with week picker navigation. |
| **Dark mode polish** | Dark mode is technically "supported" via Tailwind, but admin staff use the tool in an office during business hours. Polishing dark mode is low ROI. | Leave existing dark mode support as-is. Do not invest in dark-mode-specific tweaks. |

## Feature Dependencies

```
Alternating lane backgrounds  (independent - do first, biggest impact)
Lane header labels            (independent - do alongside lane backgrounds)
Skeleton loading states       (independent - do early, improves perceived performance)
Hover tooltips                (independent)
Today indicator line          (independent)
Conflict count badge          (independent)
Click-to-compare from search  --> requires tutor selector state management refactor
URL-shareable week state      --> requires weekStart in searchParams
Inline free-slot actions      --> requires free-gap computation (already exists)
Keyboard navigation           --> requires week picker (already exists)
Sticky tutor legend           --> requires lane header labels
Drag-to-select time range     --> requires search engine integration + coordinate mapping
Conflict resolution           --> requires search engine + conflict detection (already exists)
```

## MVP Recommendation

Prioritize these for maximum impact with minimum effort:

1. **Alternating lane backgrounds** - The single highest-impact visual fix. Every user complaint about "lanes blurring together" is solved by this. 2 hours of work.
2. **Lane header labels on week grid** - Complements lane backgrounds. Users should never have to guess which lane is which. 1 hour.
3. **Skeleton loading states** - Replace "Loading..." with skeleton grid. Immediately makes the app feel faster. 2 hours.
4. **Hover tooltips on session blocks** - Reduces click fatigue during comparison scanning. 1 hour.
5. **Click-to-compare from search** - Biggest workflow improvement. Reduces 3 clicks to 1 for the most common action. 4 hours.
6. **Today indicator line** - Small but expected. 30 minutes.
7. **Conflict count badge** - Trivial change, real usability improvement. 15 minutes.

Defer:
- **Drag-to-select time range**: High complexity, nice-to-have. Defer to future milestone.
- **Conflict resolution suggestions**: High complexity, requires search engine queries. Defer.
- **Animated transitions**: Polish item. Do after core readability fixes.
- **Mini-map density overview**: Medium complexity, useful but not urgent.

## Sources

- [FullCalendar Vertical Resource View](https://fullcalendar.io/docs/vertical-resource-view) - Resource column patterns
- [FullCalendar Resource Display](https://fullcalendar.io/docs/resource-display) - Color and grouping patterns
- [Google Calendar Side-by-Side Day View](https://support.google.com/calendar/thread/12481125) - Multi-person overlay vs. side-by-side
- [Calendar View Pattern | UX Patterns for Developers](https://uxpatterns.dev/patterns/data-display/calendar) - General calendar UX patterns
- [Mobiscroll Scheduler Resource View](https://demo.mobiscroll.com/scheduler/resource-view) - Resource lane visual separation
- [shadcn/ui Skeleton](https://www.shadcn.io/ui/skeleton) - Skeleton component for loading states
- [Calendar UI Examples | Eleken](https://www.eleken.co/blog-posts/calendar-ui) - Multi-calendar color coding patterns
- [React Loading Skeleton](https://blog.logrocket.com/handling-react-loading-states-react-loading-skeleton/) - Skeleton loading best practices
