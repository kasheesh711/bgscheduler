# Range Search with Availability Grid, Copy-to-Clipboard, and Recent Searches

## Problem

Admins use the search tool to find available tutors when parents call to book classes. The current UI requires building individual time slots one at a time, which is slow when parents give wide availability windows (e.g., "any hour between 1-7pm Saturday for a 1-hour class"). After finding tutors, admins manually format messages to send parents options via LINE/WhatsApp. These friction points slow down the booking process.

## Features

### 1. Range Search (replaces slot builder)

Instead of adding individual slots, the admin enters a single search range:

- **Mode toggle**: Recurring (weekday) or One-time (specific date)
- **Day/Date**: Weekday selector (recurring) or date picker (one-time)
- **From / To**: Start and end of the availability window (e.g., 13:00 - 19:00)
- **Class Duration**: 1 hour, 1.5 hours, or 2 hours
- **Filters**: Mode (online/onsite/either), Subject, Curriculum, Level (existing dropdowns from `/api/filters`)

The backend slices the range into non-overlapping sub-slots based on duration, tiling forward from the start time. Example: 13:00-19:00 with 1hr duration produces six sub-slots (13:00-14:00, 14:00-15:00, ... 18:00-19:00). With 1.5hr: four sub-slots (13:00-14:30, 14:30-16:00, 16:00-17:30, 17:30-19:00). With 2hr: three sub-slots (13:00-15:00, 15:00-17:00, 17:00-19:00). If the remaining time at the end is less than the duration, no partial sub-slot is generated. Each sub-slot is evaluated by the existing search engine.

Drop-in classes (parent wants a one-off session in a cancelled slot) are handled naturally by one-time mode — cancelled sessions are already non-blocking in the search engine.

### 2. Availability Grid (replaces tabbed results)

Results display as a grid:

- **Rows**: One per tutor (sorted by number of available sub-slots, descending)
- **Columns**: One per sub-slot (e.g., 1-2pm, 2-3pm, ... 6-7pm)
- **Cells**: Green check = available, dash = unavailable
- **Mode column**: Shows tutor's supported modes as badges (online/onsite)
- **Row selection**: Admin clicks rows to select tutors for copying

Below the grid, a "Needs Review" section lists tutors with data issues (same as current behavior).

Snapshot metadata (ID, sync time, staleness badge) shown above the grid, same as current.

### 3. Copy for Parents

A "Copy for parents" button generates formatted text from selected tutors:

```
Math (International) Y9-11 - Saturday

1. Kevin (onsite): 1-2pm, 2-3pm, 5-6pm, 6-7pm
2. Samantha (online/onsite): 1-2pm, 2-3pm, 3-4pm, 4-5pm
3. Nithi (online): 3-4pm, 4-5pm, 5-6pm
```

Format: header line with subject/curriculum/level + day, then numbered tutor lines with mode and available times. Language-neutral (no added English/Thai wrapper text) since admins message in both languages.

Copies to clipboard on click. Brief "Copied!" toast confirmation.

### 4. Recent Searches

Last 10 searches stored in `localStorage` (per-browser, per-admin). Shown as compact chips above the search form. Each chip shows a summary (e.g., "Sat 1-7pm Math Int Y9-11"). One click re-populates the form and auto-submits.

No server-side storage. No named saves. Chips are in reverse chronological order. Overflow chips hidden behind a "Show more" toggle.

## Architecture

### API

**New endpoint: `POST /api/search/range`**

Request:
```typescript
{
  searchMode: "recurring" | "one_time";
  dayOfWeek?: number;       // 0-6, for recurring
  date?: string;            // ISO date, for one_time
  startTime: string;        // "HH:mm"
  endTime: string;          // "HH:mm"
  durationMinutes: number;  // 60, 90, or 120
  mode: "online" | "onsite" | "either";
  filters?: {
    subject?: string;
    curriculum?: string;
    level?: string;
  };
}
```

Response:
```typescript
{
  snapshotMeta: { snapshotId: string; syncedAt: string; stale: boolean };
  subSlots: { start: string; end: string }[];
  grid: {
    tutorGroupId: string;
    displayName: string;
    supportedModes: string[];
    qualifications: { subject: string; curriculum: string; level: string }[];
    availability: boolean[];  // parallel to subSlots
  }[];
  needsReview: {
    tutorGroupId: string;
    displayName: string;
    reasons: string[];
  }[];
  latencyMs: number;
  warnings: string[];
}
```

Implementation: generate sub-slots from range, build synthetic `SearchSlot` objects, call `executeSearch` per sub-slot using the existing search engine, then reshape per-slot results into the grid structure.

**Existing endpoints unchanged**: `POST /api/search` (removed from UI but kept for backward compatibility), `GET /api/filters`.

### Frontend

**Removed components:**
- `SlotBuilder` — replaced by range input fields inline in search page
- `SlotChips` — no longer needed (single range, not multiple slots)
- `ResultsView` (tabbed) — replaced by grid view

**New components:**
- `AvailabilityGrid` — table rendering the grid with row selection
- `CopyButton` — generates formatted text from selected grid rows
- `RecentSearches` — localStorage-backed chips above search form

**Modified:**
- `search/page.tsx` — new form layout, state management, grid rendering

### Data Flow

```
Admin fills range form
  → POST /api/search/range
  → Backend slices range into sub-slots
  → Calls existing executeSearch() per sub-slot
  → Reshapes into grid response
  → UI renders AvailabilityGrid
  → Admin selects tutors, clicks Copy
  → Formatted text → clipboard
  → Search params saved to localStorage as recent search
```

## What's NOT Changing

- Search engine logic (`src/lib/search/engine.ts`) — reused as-is
- Search index (`src/lib/search/index.ts`) — reused as-is
- Qualification normalization — reused as-is
- Data health page — unchanged
- Auth flow — unchanged
- Filter dropdowns — data source unchanged (`GET /api/filters`)

## Files to Create/Modify

| File | Action |
|------|--------|
| `src/app/api/search/range/route.ts` | Create — new range search endpoint |
| `src/components/search/availability-grid.tsx` | Create — grid table with row selection |
| `src/components/search/copy-button.tsx` | Create — clipboard formatting + copy |
| `src/components/search/recent-searches.tsx` | Create — localStorage chips |
| `src/app/search/page.tsx` | Modify — new form layout, wire up grid + copy + recents |
| `src/lib/search/types.ts` | Modify — add range request/response types |
| `src/lib/search/engine.ts` | Possibly minor modification to expose per-slot helpers if needed |

## Verification

1. **Range search**: Enter "Saturday 1-7pm, 1hr, Math International Y9-11" → verify grid shows tutors with correct availability
2. **Sub-slot generation**: Verify 1-7pm with 1hr → 6 columns; 1-7pm with 1.5hr → 4 columns; 1-7pm with 2hr → 3 columns
3. **One-time mode**: Pick a specific date, verify cancelled sessions show as available
4. **Copy**: Select 2-3 tutors, click copy, paste into text editor, verify format matches spec
5. **Recent searches**: Run a search, refresh page, verify chip appears, click chip, verify form re-populates and search runs
6. **Filters**: Verify subject/curriculum/level dropdowns still work with range search
7. **Edge cases**: Range too short for duration (e.g., 1-1:30pm with 2hr) → show validation error
8. **Existing tests**: `npm test` — all 72 existing tests must pass
