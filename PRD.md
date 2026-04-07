# Tutor Availability Search Tool PRD

## 1. Document Purpose
This document defines the product requirements for an internal admin tool that searches tutor availability against parent-requested timeslots using Wise API data as the sole production source of truth.

This repo remains documentation-first. No implementation should begin until this document, [AGENTS.md](/Users/kevinhsieh/Desktop/Scheduling/AGENTS.md), and [DATA_AUDIT.md](/Users/kevinhsieh/Desktop/Scheduling/DATA_AUDIT.md) are reviewed and accepted.

[WISE_COMPARISON.md](/Users/kevinhsieh/Desktop/Scheduling/WISE_COMPARISON.md) is the migration decision record that justifies the move from sheet-based exports to Wise-only production truth.

## 2. Product Goal
Admins need a near-instant way to answer: "Which tutors can actually take this requested slot?" The tool must:

- search a single requested timeslot or multiple candidate timeslots
- reflect current tutor availability, leaves, and future scheduled conflicts with strict fidelity
- support subject, curriculum, level, and delivery mode filtering
- return results fast enough to feel immediate in live admin workflows

The product goal is to replace manual sheet interpretation and cross-referencing with a trusted internal search tool powered by normalized Wise data.

## 3. Success Metrics
- Warm search response time is under 400 ms end-to-end for current Wise tenant scale.
- Search data freshness is within 30 minutes of the live Wise tenant or the latest successful Wise sync.
- False positive availability rate is 0 by policy for data the system cannot prove.
- Admin can evaluate multi-slot requests in one search without manual cross-checking in Wise or exported files.
- All blocking Wise normalization and sync issues are visible in a review path rather than silently ignored.

## 4. Users
### Primary users
- Internal operations/admin staff scheduling tutors for parents
- Internal managers reviewing tutor coverage and data quality

### User needs
- Paste or type parent-stated availability such as:
  - `Monday 11:00-12:00`
  - `Monday 11:00-12:00, Tuesday 15:00-17:00, Wednesday 19:00-21:00`
- immediately see which tutors are eligible
- optionally narrow by subject, curriculum, level, and mode
- understand why a tutor is excluded or routed to review

## 5. Source of Truth
### Primary production source
Production truth comes from the Wise tenant `begifted-education` for institute `696e1f4d90102225641cc413`.

The production system must ingest and normalize at least these Wise data domains:

- teacher roster
- teacher availability
- teacher leaves
- future sessions
- teacher tags
- conflict validation data where needed

### Production truth model
The production app must search against:

- a normalized persisted snapshot derived from Wise
- a warm in-memory search index built from that snapshot

If the latest scheduled Wise sync fails, the app must continue serving the last successful Wise-derived snapshot. Production must not fall back to Google Sheets or local Excel files.

### Historical reference sources
The following files are migration/reference fixtures only:

- `Upcoming Sessions.xlsx`
- `Availability.xlsx`

They may be used for analysis or regression reference during planning and migration, but they are not production sources of truth and must not appear in runtime decisioning.

## 6. Product Scope
### In scope for v1
- Authenticated internal web app for company admins
- Search by one or more requested slots
- Two search modes:
  - `Recurring weekly`
  - `One-time`
- Result grouping by requested slot
- Intersection result across all requested slots
- Filters for:
  - subject
  - curriculum
  - level
  - mode: `online`, `onsite`, `either`
- Strict availability decisioning based on normalized Wise data
- Data review visibility for unresolved identity, modality, or normalization issues
- 30-minute Wise sync target

### Explicitly out of scope for v1
- Tutor assignment optimization
- Automated booking
- Parent-facing UI
- Spreadsheet ingestion in production
- Sheet fallback in production
- Partial-confidence best guesses for ambiguous modality or identity
- Automatically promoting unresolved Wise records into positive matches

## 7. Required Product Behavior
### 7.1 Input handling
The tool must support:

- free-text entry of parent-provided availability
- structured editing of parsed slots after input
- multiple requested slots in one search
- timezone default of `Asia/Bangkok`

Each normalized slot must capture:

- day of week for recurring searches or date for one-time searches
- start time
- end time
- requested mode

### 7.2 Search modes
#### Recurring weekly mode
- A slot like `Monday 11:00-12:00` is treated as a long-term weekly commitment.
- A tutor is unavailable if a normalized Wise availability window does not cover that slot.
- A tutor is unavailable if any future overlapping scheduled session exists for that same weekday and time window.
- A tutor is unavailable if a leave blocks the requested time.
- If Wise identity, modality, or qualification data is unresolved for a tutor, that tutor must not be returned as available.

#### One-time mode
- The tool checks the exact requested date and time.
- A tutor is unavailable if a normalized Wise availability window does not cover the slot on that date.
- A tutor is unavailable if there is an overlapping future Wise session for that concrete date and time.
- A tutor is unavailable if a Wise leave blocks the requested time.
- Unresolved Wise identity, modality, or qualification data still routes affected tutors to review instead of available results.

### 7.3 Multi-slot behavior
For a request containing multiple candidate slots:

- results must be shown per requested slot
- the tool must also return an `intersection` section containing tutors who match all requested slots
- the primary user workflow assumes a parent is offering candidate options, not a combined mandatory schedule

### 7.4 Result behavior
Each slot result must be separated into:

- `Available`
- `Needs review`

`Available` means the system can prove all of the following:

- the tutor maps to a resolved normalized Wise identity
- the tutor has normalized availability covering the requested slot
- the tutor passes all selected filters
- the tutor does not have a blocking session conflict for the relevant search mode
- the tutor does not have a blocking leave
- no unresolved Wise data issue invalidates the decision

`Needs review` means the tutor might be relevant, but the system cannot safely make a positive determination because of issues such as:

- unresolved aliases
- unresolved online/offline merge rules
- unclear modality derivation
- incomplete qualification normalization
- incomplete Wise sync coverage
- unresolved conflict-model discrepancies

### 7.5 Filtering
The user must be able to narrow results by:

- subject
- curriculum
- level
- mode

Filter behavior:

- filters are optional
- if no subject/curriculum/level filters are set, time and mode matching alone may return tutors
- if any qualification filter is set, a tutor must explicitly qualify through normalized Wise tags
- `either` mode matches tutors whose normalized Wise modality supports online, onsite, or both for the requested slot

## 8. Wise Interpretation Rules
### Tutor identity
- Wise teacher records are the upstream identity source.
- Parenthetical nickname extraction is a core normalization bridge, for example:
  - `Chinnakrit (Celeste) Channiti` -> `Celeste`
- Some logical tutors are represented as separate Wise records such as offline and online variants.
- Alias mismatches and merge rules must be handled by an explicit normalization layer.

### Availability
- Wise teacher availability is the authority for weekly working hours.
- The availability endpoint only supports query windows up to one week.
- Production normalization must stitch one-week reads into the required indexed model.
- The product must not infer availability from free text or historical sheet patterns.

### Scheduled conflicts
- Wise future sessions are the authority for future conflict blocking.
- Wise timestamps must be normalized from UTC into `Asia/Bangkok`.
- Cancelled or non-blocking statuses must not block availability once normalized.

### Leaves
- Wise leaves are a blocking source for availability.
- A tutor on leave during the requested slot must not appear in `Available`.

### Qualifications
- Wise teacher tags are the authority for subject/curriculum/level qualification inputs.
- Raw tags must be normalized into the app’s canonical filter model before they are used in search.

### Modality
- Online and onsite availability must be derived from normalized Wise data.
- Modality may require combining signals from:
  - paired Wise identities
  - session type
  - location
  - explicit merge/group rules
- The product must not guess modality when Wise-derived normalization is unresolved.

## 9. Data Quality Policy
The product must fail closed.

That means:

- if the system cannot prove a tutor is available, it must not show that tutor in `Available`
- ambiguous or unresolved tutors may appear in `Needs review`
- normalization defects and sync issues must be surfaced explicitly
- launch quality depends on resolving or formally accepting blockers listed in [DATA_AUDIT.md](/Users/kevinhsieh/Desktop/Scheduling/DATA_AUDIT.md)

The product must prefer false negatives over false positives.

## 10. Performance and Freshness Requirements
### Performance
- Warm query response: under 400 ms
- Search experience must feel near-instant to admins under normal operating conditions
- Search latency must remain stable for multi-slot requests at current Wise tenant scale

### Freshness
- Production data must sync from Wise every 30 minutes
- Search responses must be based on the latest successful normalized Wise snapshot
- The UI must display the timestamp of the latest successful sync
- If a sync fails, the app must continue serving the prior successful snapshot and show stale-data state clearly

## 11. Recommended Stack and System Shape
The stack is locked for planning purposes.

### Recommended implementation stack
- `Next.js` with TypeScript for the internal web app and API surface
- company login for authenticated internal access
- `Postgres` for normalized persisted Wise-derived data
- scheduled Wise API ingestion every 30 minutes
- precomputed in-memory search index built from the latest successful normalized snapshot

### System shape
- scheduled sync job reads Wise roster, availability, leaves, sessions, and tags
- raw Wise responses are persisted for traceability where useful
- normalization transforms Wise data into structured entities
- search index is rebuilt from normalized data after each successful sync
- admin UI queries the search API and displays results plus review-state issues

## 12. Acceptance Criteria

Implementation status as of 2026-04-07:

- [x] search supports both `Recurring weekly` and `One-time`
- [x] multi-slot requests return per-slot results and intersection results
- [x] all four filters exist and behave consistently
- [x] warm queries meet the sub-400 ms requirement (tested via unit tests)
- [ ] Wise sync runs every 30 minutes — currently daily (Vercel Hobby plan); upgrade to Pro for 30-min
- [x] no production sheet fallback exists
- [x] Wise timestamps are normalized correctly to `Asia/Bangkok`
- [x] unresolved identity, modality, or qualification issues never create positive matches
- [x] data issues are visible in a review path (`/data-health` page)
- [x] authentication is required for internal access (Google OAuth + admin allowlist)
- [x] Wise API credentials and namespace validated against the live API contract
- [x] Wise API sync working end-to-end — first production sync succeeded 2026-04-07 (131 teachers, 72 groups)

## 13. Launch Blockers

### Resolved through implementation
- identity normalization gaps → 5-step identity resolution pipeline with alias table
- online/offline paired-identity merge decisions → automatic detection of `Name` / `Name Online` pairs
- modality derivation rules → 4-step precedence (pair structure → session type → location → unresolved)
- tag normalization gaps → regex parser for `Subject (Curriculum) Level` format; unmapped → data_issue
- Wise sync and pagination guardrails → paginated fetchers with retry/backoff, concurrency limit, snapshot promotion thresholds
- conflict-model guardrails → primary engine uses workingHours+leaves+sessions; checkSessionsAvailability is secondary only
- data completeness gaps → fail-closed routing to Needs Review for any unresolved data

### Resolved since implementation
- First successful production sync completed 2026-04-07 (commit `c673999`, snapshot `d70608b0`)
- Wise client contract repair pushed to GitHub and deployed to Vercel production

### Optional post-launch
- Search results spot-checked by admin against known tutor schedules
- Vercel Pro upgrade for 30-minute sync cadence (currently daily on Hobby)

## 14. Implementation Gate
This PRD, [AGENTS.md](/Users/kevinhsieh/Desktop/Scheduling/AGENTS.md), and [DATA_AUDIT.md](/Users/kevinhsieh/Desktop/Scheduling/DATA_AUDIT.md) together formed the approval gate for the project.

Implementation is complete and live. The app is deployed at https://bgscheduler.vercel.app with an active production snapshot promoted on 2026-04-07. Daily Wise sync cron is running.
