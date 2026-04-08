# Tutor Schedule Compare & Quick Wins

## Context

Admins scheduling students often need to validate that a new tutor (Teacher B) doesn't conflict with the student's existing tutor (Teacher A), and if there is a conflict, quickly find alternatives. Today this requires multiple search queries, mental tracking of parameters, and no side-by-side view — leading to slow decisions and excessive context switching.

This spec covers:
1. **Compare page** — dedicated `/compare` page with Google Calendar-style side-by-side tutor schedule view, automated conflict detection, and a built-in discovery panel
2. **Search → Compare bridge** — entry point from the existing `/search` results page
3. **Quick Win: Find alternatives** — one-click button from compare conflicts to search for replacement tutors
4. **Quick Win: Tutor profile popover** — quick-view tutor stats on click

## 1. Compare Page (`/compare`)

### 1.1 Layout

Google Calendar-style layout with side-by-side tutor columns:

- **Top bar**: Tutor chips (color-coded, removable) + "+ Add tutor" button. Max 3 tutors.
- **Day tabs**: Mon–Sun tabs for day-by-day drill-down. Active day shows detailed view. "← Week overview" link toggles back to compressed weekly grid.
- **Calendar grid**: Each tutor gets their own column. Sessions rendered as positioned blocks at actual time positions (not table rows). Time labels on the left gutter.
- **Legend**: Color-coded per tutor + conflict + "both free" indicators.

### 1.2 Weekly Overview vs Day Drill-Down

**Weekly overview** (default):
- Compressed grid: days as columns, hourly rows
- Session blocks shown as compact chips (tutor color + subject)
- Conflicts highlighted with red background band
- Click any day header to drill down

**Day drill-down**:
- Full-height calendar for one day with 30-minute granularity
- Side-by-side tutor columns (like Google Calendar multi-person view)
- Session blocks show: subject, student name, time, class type (1:1/Group), modality (Online/Onsite), location
- "Both free" green dashed indicators in shared open slots

### 1.3 Conflict Detection

Automated, inline on the grid. A **conflict** is defined as: the same `student_name` appearing in overlapping time slots across two different selected tutors on the same day/weekday.

Visual treatment:
- Conflicting time band gets a red background highlight spanning all columns
- Both session blocks in the conflict turn red with ⚠️ icon
- A conflict tag appears on the row edge (e.g., "⚠ Ava T. conflict")

Data source: `future_session_blocks` table already stores `student_name`, `start_time`, `end_time`, `weekday`, `start_minute`, `end_minute` per tutor group. Conflict detection cross-references student names across selected tutors' session blocks for time overlaps.

### 1.4 Discovery Panel ("+ Add tutor")

Slide-out panel from the right. Calendar stays visible (dimmed) on the left.

**Search & filter**:
- Name search (autocomplete against all tutor display names in active snapshot)
- Subject / Level / Mode dropdown filters (reuses `/api/filters` data)
- "Only show tutors free at" checkbox with day + time range inputs, pre-populated from visible calendar gaps

**Results list**:
- Sorted by availability match (most free slots first)
- Each result card shows:
  - Tutor name, subjects, modality
  - Conflict status badge: "No conflicts" (green) / "N conflicts" (red) / "Needs review" (yellow)
  - Available/booked time chips for the filtered time window
- Action button: "Add to compare" (blue) for conflict-free, "Add anyway" (gray) for conflicted
- Needs Review tutors shown at bottom, dimmed, consistent with fail-closed rule

**Discovery API**: New `POST /api/compare/discover` endpoint that accepts subject/level/mode/time filters and returns tutor candidates with pre-computed conflict status against the currently selected tutors' students.

### 1.5 Compare API

New `POST /api/compare` endpoint:

**Request:**
```typescript
{
  tutorGroupIds: string[]          // 1-3 tutor group IDs
  mode: "recurring" | "one_time"   // same as search
  dayOfWeek?: number               // for recurring
  date?: string                    // for one_time
}
```

**Response:**
```typescript
{
  snapshotMeta: SnapshotMeta
  tutors: CompareTutor[]
  conflicts: Conflict[]
  sharedFreeSlots: TimeSlot[]
  latencyMs: number
}

CompareTutor: {
  tutorGroupId: string
  displayName: string
  supportedModes: string[]
  qualifications: Qualification[]
  color: string                    // assigned by backend for consistency
  sessions: BlockingSessionInfo[]   // reuses existing type from types.ts, plus weekday/startMinute/endMinute
  availabilityWindows: Window[]    // recurring availability
  leaves: Leave[]                  // active leaves
}

Conflict: {
  studentName: string
  dayOfWeek: number
  startMinute: number
  endMinute: number
  tutorA: { tutorGroupId: string, displayName: string, sessionTitle: string }
  tutorB: { tutorGroupId: string, displayName: string, sessionTitle: string }
}

TimeSlot: {
  dayOfWeek: number
  startMinute: number
  endMinute: number
}
```

### 1.6 Weekly Overview API

For the week overview, the same `/api/compare` endpoint is called without `dayOfWeek`/`date`, and returns sessions across all 7 days. The frontend renders the compressed weekly view from this data.

## 2. Search → Compare Bridge

On the existing `/search` availability grid:
- When 2-3 tutors are selected via row checkboxes, a **"Compare schedules"** button appears in the action bar next to "Copy for parents"
- Clicking navigates to `/compare?tutors=id1,id2,id3`
- Search context (day, time, filters) carries over as default "free at" filter on the compare page

Implementation: Add a button to the existing action bar in `availability-grid.tsx`. No changes to the search API.

## 3. Quick Win: Find Alternatives

When a conflict is detected on the compare page:
- A **"Find alternatives"** link appears on the conflict tag
- Clicking opens the discovery panel with filters pre-populated:
  - Subject: from the conflicting session
  - Time: the conflicting time slot
  - Mode: from the conflicting tutor's modality
- Admin immediately sees tutors who can replace the conflicted tutor at that exact slot

This is a UX shortcut only — it pre-fills the discovery panel. No new API needed.

## 4. Quick Win: Tutor Profile Popover

On the compare grid, clicking a tutor's name in the column header opens a popover showing:
- **Weekly hours booked**: sum of session durations for that tutor
- **Number of students**: distinct `student_name` count from session blocks
- **Subjects taught**: from qualifications
- **Modality**: Online / Onsite / Both
- **Data issues**: count of unresolved issues (if any)

Data source: all derived from the compare API response (sessions, qualifications, data issues). No additional API call needed.

## Key Files to Modify/Create

### New files
- `src/app/(app)/compare/page.tsx` — compare page
- `src/components/compare/calendar-grid.tsx` — GCal-style calendar component
- `src/components/compare/tutor-selector.tsx` — top bar tutor chips + add button
- `src/components/compare/discovery-panel.tsx` — slide-out discovery panel
- `src/components/compare/conflict-indicator.tsx` — conflict highlighting
- `src/components/compare/tutor-profile-popover.tsx` — quick stats popover
- `src/components/compare/week-overview.tsx` — compressed weekly grid
- `src/app/api/compare/route.ts` — compare API endpoint
- `src/app/api/compare/discover/route.ts` — discovery API endpoint
- `src/lib/search/compare.ts` — compare engine logic (conflict detection, free slot computation)

### Modified files
- `src/components/search/availability-grid.tsx` — add "Compare schedules" button
- `src/lib/search/types.ts` — add compare-related types
- `src/lib/search/engine.ts` — extract shared helpers for the compare engine to reuse

## Non-Functional Requirements

- Conflict detection runs client-side from the compare API response (no separate round-trip)
- Compare page must work with the same fail-closed rule: unresolved identity/modality/qualification → Needs Review
- All times in Asia/Bangkok
- Max 3 tutors in compare view (UI and API enforce this)
- Discovery panel results must respect the active snapshot only

## Verification

1. **Compare page renders**: Navigate to `/compare`, add 2 tutors via search, verify GCal-style grid shows their sessions side-by-side
2. **Conflict detection**: Add two tutors who share a student at overlapping times → verify red highlight band appears with student name
3. **Discovery panel**: Click "+ Add tutor" → set filters → verify results show conflict badges and availability chips
4. **Search bridge**: On `/search`, select 2 tutors, click "Compare schedules" → verify redirects to `/compare` with tutors pre-loaded
5. **Find alternatives**: Click "Find alternatives" on a conflict → verify discovery panel opens with pre-filled filters
6. **Tutor profile popover**: Click tutor name in column header → verify popover shows hours, student count, subjects
7. **Week overview ↔ day drill-down**: Toggle between views, verify data consistency
8. **Edge cases**: Single tutor (no conflicts possible), 3 tutors (columns scale), tutor with Needs Review status
