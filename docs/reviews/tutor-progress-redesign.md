# Tutor progress workspace redesign — 30 September 2026

## Delivery

- MagicPath project: `456039307564699648`.
- Component: `456045128780513280` (`wondrous-park-9499`).
- Saved revision: `456062339066773504`.
- App presentation: selected by the existing `teacher` role, with the admin branch preserved.
- Brand release: BeGifted 3.2.0; scope and token digest recorded in `public/brand/tutor-progress/release.json`.
- No changes to API routes, schema, cadence, private-file authorization, Wise contracts or application navigation. No production deployment.

## Automated verification

- 50 focused workspace unit tests pass, including task membership, overdue ordering, distinct cycles, missing dates, empty results and publication waiting/failure distinctions.
- 48 workspace integration tests pass in disposable PostgreSQL containers. These cover immutable originals, manual marked-PDF reviews, private marking keys, revision conflicts, publication and paused preparation uploads; AI, Blob and Wise are mocked.
- TypeScript and the production build pass.
- `npm run verify:release` was run twice. Both runs report 5,880 passing unit tests and one timeout in the existing classroom-continuity historical fixture (`src/lib/classrooms/__tests__/continuity.test.ts:109`, 30-second limit). The same test also times out alone with one worker. No classroom code or test was changed. This release gate is **not green**.

## Browser verification

A localhost preview renders the actual workspace components against synthetic overview/detail records and mocked private uploads, jobs, AI and Wise. It does not connect to the production database or publish to Wise. The MagicPath source was also exercised locally and its saved revision was rendered through the plugin.

Verified:

- Tasks opens by default; filters and search work; each assessment appears once, with overdue work first. My students retains early and multiple cycles, including unscheduled assessments.
- Preparation selection, revision topics, student confirmation and queued paper upload.
- Student-work upload and page order; submission progresses to Review while Wise is paused.
- Manual marked-PDF upload and score entry; saving advances to Report & approve.
- Report edits, private PDF generation, page navigation, zoom, review confirmation and queued approval.
- Submitted papers remain locked; ordinary publication queues leave Tasks after approval, while failed publication exposes recovery.
- Drafts survive step navigation, refresh and job polling. Stale-revision errors retain edits. Discard dialogs, Escape and keyboard activation work.
- Replacement paper versions, readiness, history, private key controls and availability of originals after optional AI failure.
- Desktop (1440px), tablet (820px) and phone (390px) in light, dark and system themes; system preference changes; no page-wide horizontal overflow. Phone Details/PDF controls, native dialog focus and scoped control colors inspected.
- The admin preview retains My students, Grading queue, tutor filters and administration controls.

The embedded MagicPath website requires the user's sign-in to display the project there. Plugin creation/editing and rendered revision verification succeeded independently. Synthetic previews and passing checks do not attest production delivery or human acceptance.
