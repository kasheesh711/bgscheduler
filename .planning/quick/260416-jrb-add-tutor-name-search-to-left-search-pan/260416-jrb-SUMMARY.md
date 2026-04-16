# Quick Task 260416-jrb: Add tutor name search to left search panel

**Status:** Complete
**Date:** 2026-04-16
**Commits:** `406c073`, `9443093`

## What Changed

### Task 1: Add tutorGroupIds filter to range search API
- Added optional `tutorGroupIds: z.array(z.string()).optional()` to `rangeRequestSchema` in `/api/search/range`
- Post-filters `tutorMap` and `reviewMap` results when tutor IDs are provided
- No changes to core search engine — filter applied at the API layer

### Task 2: Add tutor name multi-select combobox to SearchForm
- Passed `tutorList` from `SearchWorkspace` to `SearchForm`
- Added cmdk-powered searchable combobox with multi-select tutor chips
- Selected tutor IDs included in API request as `tutorGroupIds`
- Removable badge chips show selected tutors above the day/time row
- Matches existing `TutorCombobox` UX pattern from the compare panel

## Files Modified

| File | Change |
|------|--------|
| `src/app/api/search/range/route.ts` | Added `tutorGroupIds` to Zod schema + post-filter logic |
| `src/components/search/search-form.tsx` | Added Popover+Command combobox with multi-select tutor chips |
| `src/components/search/search-workspace.tsx` | Passes `tutorList` prop to SearchForm |

## Verification

- TypeScript compiles without errors
- All existing tests pass
