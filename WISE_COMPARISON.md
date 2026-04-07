# Wise vs Sheets Comparison

## Status of This Document
This file is a migration decision record and evidence document.

It is not the active production specification. The active production-spec documents are:

- [PRD.md](/Users/kevinhsieh/Desktop/Scheduling/PRD.md)
- [AGENTS.md](/Users/kevinhsieh/Desktop/Scheduling/AGENTS.md)
- [DATA_AUDIT.md](/Users/kevinhsieh/Desktop/Scheduling/DATA_AUDIT.md)

This comparison explains why production truth has been moved to the Wise API and why Google Sheets and local `.xlsx` exports are now reference material only.

As of 2026-04-07, production sync is live. First successful sync completed on commit `c673999`, promoting snapshot `d70608b0` with 131 teachers and 72 identity groups. Daily cron is active.

## Purpose
This document records a read-only comparison between the former spreadsheet-based workflow and the Wise API for tutor availability search.

The comparison answered three questions:

1. Can Wise replace `Upcoming Sessions.xlsx`?
2. Can Wise replace `Availability.xlsx > Master`?
3. Can Wise replace `Availability.xlsx > Subject-LevelMatrix`?

This comparison used only non-mutating operations:

- local reads of `Availability.xlsx` and `Upcoming Sessions.xlsx`
- `GET` requests to Wise
- `POST /checkSessionsAvailability` in read-only validation mode

No Wise data was created, updated, or deleted.

## Scope

Compared sources:

- Local workbook: `Upcoming Sessions.xlsx`
- Local workbook: `Availability.xlsx`
  - `Master`
  - `Subject-LevelMatrix`
- Wise tenant: `begifted-education`
- Wise institute: `696e1f4d90102225641cc413`

Relevant Wise endpoints validated:

- `GET /user/getUser`
- `GET /teacher/institutes`
- `GET /institutes/{center_id}/teachers`
- `GET /institutes/{center_id}/teachers/{teacher_id}/availability`
- `GET /institutes/{center_id}/sessions?status=FUTURE`
- `POST /institutes/{center_id}/checkSessionsAvailability`

Important Wise constraint:

- `GET /teachers/{teacher_id}/availability` only supports ranges up to one week.

## Executive Verdict

| Former source | Verdict | Notes |
| --- | --- | --- |
| `Upcoming Sessions.xlsx` | Replace | Wise session parity was strong and materially cleaner than the export. |
| `Availability.xlsx > Subject-LevelMatrix` | Replace with normalization | Wise teacher tags appear sufficient, but require normalization rules and alias cleanup. |
| `Availability.xlsx > Master` | Replace with normalization | Wise working hours are structured and often cleaner, but modality and identity normalization are mandatory. |

Decision outcome for the project:

- Wise is the only production source of truth.
- Google Sheets and `.xlsx` exports are migration/reference artifacts only.
- Production search must run on normalized Wise-derived snapshots and an indexed model.

This is not a direct raw-source swap. It is a source-of-truth shift through normalization.

## Method

### 1. Identity and roster comparison

Compared:

- Wise teacher display name
- nickname extracted from Wise parentheses
- Wise user ID
- Wise participant ID
- `Master` tutor key
- `Subject-LevelMatrix` tutor key

Classified each tutor into:

- exact match
- alias mapping required
- present only in Wise
- present only in Sheets

### 2. Qualification comparison

Compared:

- `Subject-LevelMatrix` row semantics
- Wise teacher `tags`

Focused on representative subjects and curricula:

- Math
- Science
- EFL / ESL
- exam prep
- Thai vs Int variations

### 3. Weekly availability comparison

Compared Wise `workingHours.slots` against `Master` for representative tutors covering:

- clean weekly availability
- split-day availability
- offline / online paired identities
- ambiguous spreadsheet rows

Representative tutors sampled:

- `Aey`
- `Da`
- `Mimi`
- `Ek`
- `Buzz`
- `Menika`
- `Gift`
- `Jan`
- `Amy`
- `Grace`

### 4. Future-session comparison

Compared Wise future sessions against `Upcoming Sessions.xlsx` and checked:

- tutor identity
- start time
- end time
- meeting status
- modality-related fields

### 5. Conflict-check comparison

Used `POST /checkSessionsAvailability` to validate sampled session conflicts against sheet-derived expectations.

## Findings

### A. Wise tenant and scheduling features are live

Wise access for the target tenant was valid and returned live institute and teacher data.

Important institute settings observed:

- `teacherAvailabilitySettings.enabled = true`
- `teacherAvailabilitySettings.disableUpdatingLeaves = true`
- `teacherAvailabilitySettings.disableUpdatingWorkingHours = true`
- `sessionSettings.disallowConflict = false`
- `bookingTimeslotGranularity = 15`
- `maxAdvanceSlotBookingDays = 180`

This confirms Wise is not just storing classes. It is actively storing teacher availability structures that can power the production search tool.

### B. Roster and identity comparison

Counts from the comparison:

- Wise teachers: `131`
- Unique Wise nickname keys: `71`
- `Master` tutor keys: `79`
- `Subject-LevelMatrix` tutor keys: `74`

Nickname-level overlap:

- Wise keys matching `Master`: `53`
- Wise keys matching `Subject-LevelMatrix`: `59`

Wise keys present in `Subject-LevelMatrix` but not `Master`:

- `Celeste`
- `Grace`
- `Paoju`
- `Pearcha`
- `Poi`
- `Prae-Tarn`

Wise-only keys not found in either sheet key set:

- `A`
- `Aya`
- `Care`
- `Earng`
- `Fluke-Supha`
- `Kev`
- `Muk`
- `Palm`
- `Pat`
- `Petchy`
- `Phutta`
- `Sam`

`Master` keys not seen in Wise nickname extraction:

- `Celes`
- `Dan`
- `Film`
- `Gift (Kariya)`
- `Gush`
- `Kam`
- `Keane`
- `Ken`
- `Kevin`
- `Kim`
- `Lani`
- `Maii`
- `Nacha (Poi)`
- `Nat`
- `Nick`
- `Oaet`
- `Omsin`
- `Pamai`
- `Paojuu`
- `Polly`
- `Poom`
- `Poon`
- `Prae-tarn`
- `Tom`
- `Tong`
- `Tonkla`

`Subject-LevelMatrix` keys not seen in Wise nickname extraction:

- `Film`
- `Fluke-Suphax`
- `Gift-Kari`
- `Kam`
- `Keane`
- `Kevin`
- `Kim`
- `Kristiina`
- `Maii`
- `Mawin`
- `Pamai`
- `Poom`
- `Poon`
- `Samantha`
- `Tom`

Observed pattern:

- Wise commonly models the same logical tutor as multiple records.
- `59` nickname keys had multiple Wise teacher records.
- Commonly this appears as `Name` and `Name Online`.

Examples:

- `Usanee (Aey) Tortermpun`
- `Usanee (Aey) Tortermpun Online`
- `Ratthapon (Da) Punpo`
- `Ratthapon (Da) Punpo Online`
- `Wacharaphol (Gift) Daungsuwan`
- `Wacharaphol (Gift) Daungsuwan Online`
- `Khanittha (Grace) Hongkeaw`
- `Khanittha (Grace) Hongkeaw Online`

Conclusion:

- Wise has the roster data needed.
- Identity is not clean enough for direct use without a deterministic alias and merge layer.
- This is a normalization problem, not a reason to keep spreadsheets in production.

### C. Qualification comparison

Wise teacher records contain substantial `tags` data that maps closely to the former `Subject-LevelMatrix`.

Representative examples observed in Wise:

- `Math (Int.) Y2-8`
- `Math (ExamPrep) SAT`
- `EFL (Int.) Y2-8`
- Thai subject variants
- science variants
- level-specific variants

These tags appear strong enough to encode:

- subject
- curriculum family
- level band
- exam-prep variants

Observed caveats:

- some labels collapse multiple former sheet semantics into one label
- some tags include Wise-specific concepts such as tiering
- some modality hints appear to be expressed through separate teacher identities rather than through tag structure

Conclusion:

- Wise can replace `Subject-LevelMatrix`
- a normalization dictionary is still required to map raw tags into the app’s canonical filter model

### D. Weekly availability comparison

Wise `workingHours.slots` are structured and machine-readable. This is already an improvement over the mixed-text cells in `Master`.

Representative outcomes:

#### Close or exact matches

- `Gift`: Wise slots closely mirrored the sheet
- `Buzz`: Wise was exact or near-exact
- `Ek`: Wise was very close; most variance was identity splitting rather than time loss

#### Structured but meaningfully different

- `Mimi`: sheet showed roughly `09:00-20:00`; Wise showed `09:00-21:00` daily
- `Aey`: sheet had split Tue/Thu windows; Wise had broader contiguous ranges
- `Da`: Wise had richer split-slot structure and separate online/offline coverage
- `Amy`: Wise included Monday availability not present in the sheet

#### Wise clearly cleaner than the sheet

- `Menika`: sheet contained mixed-mode wording and ambiguous text; Wise returned clean structured slots
- `Jan`: sheet contained `onwards` style ambiguity; Wise returned concrete time windows
- `Grace`: present in Wise with clean structured availability, absent from `Master`

Interpretation:

- `Master` was not a stable canonical structure
- Wise availability is easier to parse, less ambiguous, and more current
- the largest replacement risk is modality semantics and identity merging, not time-slot coverage

Conclusion:

- Wise is a viable replacement for `Master` if the implementation treats availability as normalized data rather than as a direct one-to-one textual copy

### E. Future-session comparison

Wise future sessions returned the fields needed for scheduling:

- session ID
- teacher name
- `scheduledStartTime`
- `scheduledEndTime`
- `meetingStatus`
- `type`
- `title`
- `location`

Validation result:

- the first `20` Wise future session IDs sampled were all found in `Upcoming Sessions.xlsx`
- initial timestamp mismatches disappeared after converting Wise UTC timestamps into `Asia/Bangkok`
- final parity result on that sample: `0` mismatches

Interpretation:

- Wise session data is aligned with the former export
- Wise is a cleaner upstream source because it avoids export-shape defects and timezone ambiguity once normalized correctly

Conclusion:

- Wise can replace `Upcoming Sessions.xlsx`

### F. Conflict-check comparison

Sampled validation confirmed that Wise correctly reports session conflicts for known occupied windows.

Examples observed:

- `Aey` session overlap -> `TEACHER_SESSION`
- `Aey Online` session overlap -> `TEACHER_SESSION`
- `Mimi Online` session overlap -> `TEACHER_SESSION`
- `Ek` session overlap -> `TEACHER_SESSION`

Important caveat:

- sampled checks outside expected working hours did not consistently return `TEACHER_WORKING_HOURS` once timestamps were normalized correctly
- earlier unnormalized tests did return `TEACHER_WORKING_HOURS`, which shows timezone handling can produce misleading results if done incorrectly
- the safer interpretation is:
  - Wise `checkSessionsAvailability` is reliable for session-collision validation
  - weekly working-hours enforcement should primarily come from `GET /availability` and normalized `workingHours`, not from assuming `checkSessionsAvailability` alone is the complete working-hours oracle

This does not block using Wise. It changes how the production search engine should validate availability:

- use normalized Wise `workingHours`
- subtract Wise sessions
- subtract Wise leaves
- optionally use `checkSessionsAvailability` as a secondary validation layer for session conflicts

## Discrepancy Register

### Identity mismatch

- many tutors require alias mapping between business names and Wise display names
- several logical tutors appear as multiple Wise teacher records
- some historical tutor keys do not have obvious Wise nickname equivalents

Impact:

- direct raw joins will produce false misses

Resolution:

- introduce a canonical tutor identity layer with:
  - extracted nickname key
  - explicit alias overrides
  - merge policy for online/offline paired Wise identities

### Qualification mismatch

- Wise tags are rich but not yet in canonical app filter format
- some raw tags contain extra Wise-specific semantics

Impact:

- filters may not behave exactly like the former matrix unless normalized

Resolution:

- build a controlled tag normalization table into:
  - subject
  - curriculum
  - level
  - exam-prep

### Weekly availability mismatch

- some tutors showed different slot boundaries between Wise and `Master`
- some former sheet rows appear stale or ambiguous
- some tutors exist in Wise with structured availability but not in `Master`

Impact:

- direct parity against the former sheet is not always possible

Resolution:

- treat Wise as the canonical schedule source
- record migration discrepancies during rollout rather than preserving ambiguous sheet text as truth

### Modality mismatch

- Wise does not appear to expose a single clean first-class online/onsite field in the sampled availability payload
- modality is often represented indirectly through separate teacher records and session metadata

Impact:

- a naive direct replacement of former modality cells would lose meaning

Resolution:

- normalize modality from:
  - paired Wise identities
  - session type
  - location metadata
- treat each Wise identity as distinct internally until merge rules are explicit

### Conflict-check mismatch

- `checkSessionsAvailability` matched sampled session-collision cases
- working-hours conflicts did not consistently surface in the same way during normalized tests

Impact:

- relying on `checkSessionsAvailability` alone for all availability logic is risky

Resolution:

- use Wise `workingHours` plus sessions plus leaves as the primary availability engine
- use `checkSessionsAvailability` as an additional confidence layer, especially for session overlap checks

## Decision by Former Source

### 1. `Upcoming Sessions.xlsx`

Decision: `Replace`

Why:

- Wise exposes the required future-session fields directly
- sampled session IDs and localized timestamps matched the workbook
- Wise avoids the workbook’s export-shape failure modes

### 2. `Availability.xlsx > Subject-LevelMatrix`

Decision: `Replace with normalization`

Why:

- Wise tags are rich enough to model subject, curriculum, and level filters
- some normalization is required to map raw Wise tags into canonical app filters
- this is a manageable transformation problem

### 3. `Availability.xlsx > Master`

Decision: `Replace with normalization`

Why:

- Wise `workingHours` is structured and machine-readable
- Wise handles ambiguous sheet cases better than the sheet itself
- the remaining complexity is identity and modality normalization, not lack of source coverage

Why this is not `Replace` without qualification:

- online vs onsite is not represented the same way as the sheet
- multiple Wise identities may correspond to one business tutor concept
- direct parity should not be expected without a normalization layer

## Recommended Production Model

Use Wise as the only production source of truth with a normalization layer:

1. teacher identity normalization
2. qualification normalization from tags
3. weekly availability normalization from `workingHours`
4. leave subtraction from Wise `leaves`
5. future-session blocking from Wise sessions
6. optional secondary verification through `checkSessionsAvailability`

Do not port the spreadsheet model forward as-is.

The spreadsheets and local `.xlsx` files should be treated as migration-era reference material only.

## Final Recommendation

Recommended final stance:

- do not stay on sheets for v1
- do not use a pure raw Wise passthrough either
- use Wise as the canonical upstream source and apply a controlled normalization layer

Decision summary:

- `Upcoming Sessions.xlsx` -> `Replace`
- `Subject-LevelMatrix` -> `Replace with normalization`
- `Master` -> `Replace with normalization`

This is the strongest path for speed, data quality, and long-term maintainability.
