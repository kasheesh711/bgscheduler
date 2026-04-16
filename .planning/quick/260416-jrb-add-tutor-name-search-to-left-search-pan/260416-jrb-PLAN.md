---
phase: quick
plan: 01
type: execute
wave: 1
depends_on: []
files_modified:
  - src/components/search/search-form.tsx
  - src/components/search/search-workspace.tsx
  - src/app/api/search/range/route.ts
autonomous: true
must_haves:
  truths:
    - "Admin can optionally filter search results to specific tutors by name on the left panel"
    - "Tutor name filter uses a searchable multi-select combobox matching existing TutorCombobox UX pattern"
    - "Selecting tutor names narrows the availability grid to only those tutors"
    - "Clearing the tutor filter returns to showing all matching tutors"
    - "All existing search functionality (day/time/duration/mode/subject/curriculum/level) continues to work unchanged"
  artifacts:
    - path: "src/components/search/search-form.tsx"
      provides: "Tutor name multi-select combobox in search form"
    - path: "src/components/search/search-workspace.tsx"
      provides: "Passes tutorList prop to SearchForm"
    - path: "src/app/api/search/range/route.ts"
      provides: "Optional tutorGroupIds filter in range search API"
  key_links:
    - from: "src/components/search/search-workspace.tsx"
      to: "src/components/search/search-form.tsx"
      via: "tutorList prop"
      pattern: "tutorList={tutorList}"
    - from: "src/components/search/search-form.tsx"
      to: "/api/search/range"
      via: "fetch POST body with tutorGroupIds"
      pattern: "tutorGroupIds"
---

<objective>
Add a tutor name search/filter to the left search panel so admins can narrow availability
results to specific tutors by name. This uses a multi-select combobox (cmdk) matching the
existing TutorCombobox pattern on the right panel, but integrated into the search form as
an optional filter.

Purpose: Admins currently must scan the full results grid to find a specific tutor. This
lets them type a tutor name to filter results directly, saving time when they already know
who they are looking for.

Output: Updated search form with tutor name filter, updated API to accept tutor ID filtering.
</objective>

<execution_context>
@.claude/get-shit-done/workflows/execute-plan.md
@.claude/get-shit-done/templates/summary.md
</execution_context>

<context>
@CLAUDE.md
@src/components/search/search-form.tsx
@src/components/search/search-workspace.tsx
@src/components/compare/tutor-combobox.tsx
@src/app/api/search/range/route.ts
@src/lib/data/tutors.ts
@src/lib/search/types.ts

<interfaces>
<!-- Key types and contracts the executor needs. -->

From src/lib/data/tutors.ts:
```typescript
export interface TutorListItem {
  tutorGroupId: string;
  displayName: string;
  supportedModes: string[];
  subjects: string[];
}
```

From src/components/search/search-form.tsx:
```typescript
export interface SearchFormProps {
  filterOptions: FilterOptions;
  onSearchResponse: (response: RangeSearchResponse, context: SearchContext) => void;
  onError: (error: string | null) => void;
}
```

From src/components/search/search-workspace.tsx:
```typescript
interface SearchWorkspaceProps {
  filterOptions: FilterOptions;
  tutorList: TutorListItem[];
}
```

From src/app/api/search/range/route.ts (Zod schema):
```typescript
const rangeRequestSchema = z.object({
  searchMode: z.enum(["recurring", "one_time"]),
  dayOfWeek: z.number().min(0).max(6).optional(),
  date: z.string().optional(),
  startTime: z.string().regex(/^\d{2}:\d{2}$/),
  endTime: z.string().regex(/^\d{2}:\d{2}$/),
  durationMinutes: z.enum(["60", "90", "120"]).transform(Number).or(z.literal(60)).or(z.literal(90)).or(z.literal(120)),
  mode: z.enum(["online", "onsite", "either"]),
  filters: z.object({
    subject: z.string().optional(),
    curriculum: z.string().optional(),
    level: z.string().optional(),
  }).optional(),
});
```

shadcn/ui Command components available at src/components/ui/command.tsx:
Command, CommandInput, CommandList, CommandEmpty, CommandGroup, CommandItem
(wraps cmdk library)

Popover components at src/components/ui/popover.tsx:
Popover, PopoverContent, PopoverTrigger

Badge component at src/components/ui/badge.tsx
</interfaces>
</context>

<tasks>

<task type="auto">
  <name>Task 1: Add tutorGroupIds filter to range search API</name>
  <files>src/app/api/search/range/route.ts</files>
  <action>
Add an optional `tutorGroupIds` field to `rangeRequestSchema`:

```
tutorGroupIds: z.array(z.string()).optional(),
```

After the existing grid is built (after the `tutorMap` and `reviewMap` loops, before the sort), apply a post-filter if `tutorGroupIds` is provided and non-empty:

1. Destructure `tutorGroupIds` from `parsed.data` alongside the existing fields.
2. After the "Fill in blocking session details" loop and before "Sort grid by number of available slots", add:
   ```
   // Filter to specific tutors if requested
   if (tutorGroupIds && tutorGroupIds.length > 0) {
     const idSet = new Set(tutorGroupIds);
     for (const [id] of tutorMap) {
       if (!idSet.has(id)) tutorMap.delete(id);
     }
     for (const [id] of reviewMap) {
       if (!idSet.has(id)) reviewMap.delete(id);
     }
   }
   ```

This is a post-filter approach: the search engine runs normally, then we narrow the results. This avoids touching the core search engine and keeps the change minimal. Tutors not in the ID list are removed from both the available grid and needsReview list.

Do NOT modify `src/lib/search/engine.ts` -- keep the filter at the API layer.
  </action>
  <verify>
    <automated>cd /Users/kevinhsieh/Desktop/Scheduling && npm test</automated>
  </verify>
  <done>
The `/api/search/range` endpoint accepts an optional `tutorGroupIds` array. When provided, only tutors with matching IDs appear in the response grid and needsReview. When omitted or empty, behavior is identical to before (all matching tutors returned). All existing tests pass.
  </done>
</task>

<task type="auto">
  <name>Task 2: Add tutor name multi-select combobox to SearchForm</name>
  <files>src/components/search/search-form.tsx, src/components/search/search-workspace.tsx</files>
  <action>
**In `src/components/search/search-workspace.tsx`:**

1. Pass `tutorList` to `SearchForm` by adding the prop: `<SearchForm filterOptions={filterOptions} tutorList={tutorList} onSearchResponse={handleSearchResponse} onError={setError} />`

**In `src/components/search/search-form.tsx`:**

1. Add imports at top:
   ```
   import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
   import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
   import { Badge } from "@/components/ui/badge";
   import { X } from "lucide-react";
   import type { TutorListItem } from "@/lib/data/tutors";
   ```

2. Update `SearchFormProps` interface -- add `tutorList: TutorListItem[]` field.

3. Destructure `tutorList` from props in the component function signature.

4. Add state for selected tutor IDs and combobox open state:
   ```
   const [selectedTutorIds, setSelectedTutorIds] = useState<string[]>([]);
   const [tutorPopoverOpen, setTutorPopoverOpen] = useState(false);
   ```

5. Add helper to get display names for selected tutors:
   ```
   const selectedTutorNames = selectedTutorIds
     .map((id) => tutorList.find((t) => t.tutorGroupId === id)?.displayName)
     .filter(Boolean);
   ```

6. Add handler functions:
   ```
   const handleAddTutor = (id: string) => {
     setSelectedTutorIds((prev) => prev.includes(id) ? prev : [...prev, id]);
   };

   const handleRemoveTutor = (id: string) => {
     setSelectedTutorIds((prev) => prev.filter((x) => x !== id));
   };
   ```

7. In `handleSearch`, include `tutorGroupIds` in the params sent to the API. After the existing `filters` field, add:
   ```
   tutorGroupIds: selectedTutorIds.length > 0 ? selectedTutorIds : undefined,
   ```

8. Add a new row ABOVE the existing "Row 1: Day/Date, From, To" section. This row shows the tutor name filter spanning the full width:

   ```jsx
   {/* Tutor name filter */}
   <div>
     <label className="text-[10px] font-medium text-muted-foreground">
       Tutor (optional)
     </label>
     <div className="flex flex-wrap items-center gap-1 mt-0.5">
       {selectedTutorIds.map((id) => {
         const tutor = tutorList.find((t) => t.tutorGroupId === id);
         return tutor ? (
           <Badge key={id} variant="secondary" className="text-xs px-1.5 py-0 gap-0.5">
             {tutor.displayName}
             <button
               type="button"
               onClick={() => handleRemoveTutor(id)}
               className="ml-0.5 hover:text-destructive"
             >
               <X className="h-3 w-3" />
             </button>
           </Badge>
         ) : null;
       })}
       <Popover open={tutorPopoverOpen} onOpenChange={setTutorPopoverOpen}>
         <PopoverTrigger
           render={(props) => (
             <button
               {...props}
               type="button"
               className="text-xs text-muted-foreground hover:text-foreground border border-dashed rounded px-1.5 py-0.5"
             >
               {selectedTutorIds.length === 0 ? "Filter by tutor name..." : "+ Add"}
             </button>
           )}
         />
         <PopoverContent className="w-72 p-0" align="start">
           <Command>
             <CommandInput placeholder="Search tutors..." />
             <CommandList>
               <CommandEmpty>No tutors found.</CommandEmpty>
               <CommandGroup>
                 {tutorList
                   .filter((t) => !selectedTutorIds.includes(t.tutorGroupId))
                   .map((t) => (
                     <CommandItem
                       key={t.tutorGroupId}
                       value={t.displayName}
                       onSelect={() => {
                         handleAddTutor(t.tutorGroupId);
                         setTutorPopoverOpen(false);
                       }}
                     >
                       <div className="flex flex-col gap-0.5">
                         <span className="text-sm font-medium">{t.displayName}</span>
                         <div className="flex gap-1 flex-wrap">
                           {t.supportedModes.map((m) => (
                             <Badge key={m} variant="secondary" className="text-[10px] px-1 py-0">
                               {m}
                             </Badge>
                           ))}
                           {t.subjects.slice(0, 3).map((s) => (
                             <Badge key={s} variant="outline" className="text-[10px] px-1 py-0">
                               {s}
                             </Badge>
                           ))}
                           {t.subjects.length > 3 && (
                             <span className="text-[10px] text-muted-foreground">
                               +{t.subjects.length - 3}
                             </span>
                           )}
                         </div>
                       </div>
                     </CommandItem>
                   ))}
               </CommandGroup>
             </CommandList>
           </Command>
         </PopoverContent>
       </Popover>
     </div>
   </div>
   ```

9. In `handleSelectRecent`, do NOT set selectedTutorIds (recent searches do not include tutor name filter -- keeps the feature orthogonal).

**Styling notes:**
- The tutor filter row goes between the mode toggle buttons and the Day/From/To row
- Use the same `text-[10px]` label style as other form fields
- Badge chips match the same pattern used in TutorCombobox (mode + subject badges in dropdown items)
- Removable chips use X icon from lucide-react (consistent with existing icon usage)
- Dashed border trigger button matches the TutorCombobox "+ Add tutor" button style
  </action>
  <verify>
    <automated>cd /Users/kevinhsieh/Desktop/Scheduling && npx tsc --noEmit && npm test</automated>
  </verify>
  <done>
The left search panel has a "Tutor (optional)" combobox above the day/time row. Typing filters the tutor list with cmdk fuzzy search. Selected tutors appear as removable badge chips. Searching with tutors selected narrows results to only those tutors. Clearing all tutor chips returns to full results. TypeScript compiles without errors. All existing tests pass.
  </done>
</task>

</tasks>

<threat_model>
## Trust Boundaries

| Boundary | Description |
|----------|-------------|
| client -> API | tutorGroupIds array in POST body is untrusted input |

## STRIDE Threat Register

| Threat ID | Category | Component | Disposition | Mitigation Plan |
|-----------|----------|-----------|-------------|-----------------|
| T-quick-01 | T (Tampering) | /api/search/range | mitigate | Zod validates tutorGroupIds as z.array(z.string()).optional() -- rejects non-string values. IDs are matched against in-memory index entries only (no SQL injection vector). |
| T-quick-02 | I (Info Disclosure) | /api/search/range | accept | Filtering by arbitrary tutorGroupIds does not disclose additional data -- the same tutor data is already available via GET /api/tutors. All users are authenticated admins. |
</threat_model>

<verification>
1. `npx tsc --noEmit` passes (no type errors)
2. `npm test` passes (all 82+ existing tests green)
3. Manual: visit /search, see "Tutor (optional)" field in left panel, type a name, select, search -- grid shows only that tutor
4. Manual: remove tutor chip, search again -- grid shows all matching tutors
5. Manual: existing search with no tutor filter works identically to before
</verification>

<success_criteria>
- Left search panel has a tutor name combobox that filters availability results by tutor
- Multi-select with removable badge chips for selected tutors
- API accepts optional tutorGroupIds and filters response accordingly
- Zero regressions: all existing search/compare functionality unchanged
- All tests pass, TypeScript compiles cleanly
</success_criteria>

<output>
After completion, create `.planning/quick/260416-jrb-add-tutor-name-search-to-left-search-pan/260416-jrb-SUMMARY.md`
</output>
