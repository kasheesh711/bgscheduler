# Classroom print roster verification — 11 September 2026

Implemented tutor/room print selection, exact Wise session rosters, refresh-before-print, review exceptions and capacity warnings. Both views use the same saved schedule and live roster payload. The existing BeGifted v2 print design is preserved; no migration or Wise writes are involved.

## Evidence

- Unit tests cover exact session membership, duplicate IDs, identical names belonging to different students, Thai names, missing names, cancellation, changed date/time/tutor/class/modality, shared future/directory reads, detail fallback and Wise failures.
- Follow-up regression tests verify that an exact live session supplies the detail-read class ID when the saved ID is missing or obsolete. The latter remains a rescheduled exception, while its student roster can still be verified.
- Projection/pagination tests cover active room order, empty rooms, chronological classes, remote and unassigned classes, capacity warnings, revisions, seven-run validation and lossless large-roster continuation.
- The new API tests cover authentication, Class Assignments scope, invalid IDs, uncached responses, concurrent-edit conflicts and sanitized upstream failures.
- `room-profiles.integration.test.ts` passed all three tests against a newly created local scratch Postgres database. Its print case verifies selected saved runs, minimal student-name output, roster revision changes and rejection of assignment edits during roster loading. No production database was used.
- Full unit suite: **4,851 tests in 422 files passed**, including the two follow-up class-ID regressions. Typecheck, changed-file lint and the production build passed.
- Browser regression: `node scripts/verify-classroom-print.mjs` bundles the actual print component/CSS with synthetic fixtures and local Sarabun/Cormorant fonts. Only Next Link is replaced by a plain anchor. It calls no application database, authenticated app endpoint or Wise API. Set `CHROME_PATH` if Chrome is installed elsewhere; optionally supply an output directory as the first argument.
- Chrome verified both views for one and seven days, 90 long mixed Thai/English student names in a single class, identical names, busy-room continuation, an empty room, a remote class and labelled exceptions. It checked refreshed pagination, failed-refresh retry, blocked concurrent edits, direct-browser-print protection, every student occurrence, 11pt timetable text and clearance above footers.
- Synthetic PDF exports contained 8 tutor pages / 9 room pages for one day and 56 / 63 for seven days. PDF extraction verified all 90 group names exactly once per class, both students with an identical name, and roster-check timestamps on every page. PDF page sizes were A4 landscape. Rendered tutor/room first and continuation pages, an empty-room page and the exceptions page were visually inspected: no clipping or overlapping footers.

## Operational timing

The accompanying cron changes prepare the next day's assignments starting at **17:00 Bangkok**, and begin tutor/admin schedule delivery at **19:00 Bangkok** on the preceding day, with failed-delivery retries through **19:46**. Preparation still projects seven days ahead; delivery uses tomorrow's saved plan and does not regenerate rooms. A missing preparation since 17:00 blocks delivery of an older provisional plan. These are configured job start times; actual completion depends on Wise and email processing.

This verification does not deploy the changes or send any schedules.

## Safari margin correction — 11 September 2026

The supplied Safari export used the app's general 14 mm / 12 mm print margins instead of the classroom named-page margins. The room content was scaled and shifted, and the last footer line spilled onto a second physical page. The downloaded file contained only the first 24 of Safari's 48 physical pages, ending at OMG and omitting Think Outside the Box and the remaining rooms.

The classroom report now mounts its own unnamed A4 landscape, zero-margin rule alongside its existing named rule. Keeping that fallback in the mounted component prevents it from changing other reports after navigation. Footer line height is explicit and the footer avoids internal page breaks.

Verification used the actual component with the global print-margin default and production line height. WebKit and Chromium passed both views, one/seven days, large Thai/English rosters, refresh failures, revision conflicts, all student occurrences, 11 pt timetable text and footer clearance. Chromium exports also assert physical page count and landscape paper dimensions with named-page support removed. Native Safari's print dialog could not be completed through the UI automation; the delivered PDF was exported with Chromium and independently inspected.

The complete 12 September report, run `04b86cce-4a04-4ed4-b3e4-4ef82ab3d66b`, revision `3ba53b02`, was refreshed from Wise at 17:46 Bangkok. Its PDF contains 24 landscape pages, all 152 room assignments and all nine Kevin classes on page 16 (Think Outside the Box). Every page contains its room heading, correct page number and roster-check footer. All pages were rendered for visual review. Release verification passed 4,941 unit tests in 430 files, typechecks, production build and the 244-route guard; lint had zero errors and 19 existing warnings.
