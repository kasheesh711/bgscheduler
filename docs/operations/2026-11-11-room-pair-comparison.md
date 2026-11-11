# Room-pair algorithm comparison — 11 November 2026

The draft performs better overall on this snapshot. It removes the remaining two connected-lesson room changes and puts 108 more lessons in the teacher's primary room. It has trade-offs: nine teachers have lower primary-room use, four dates use more rooms per teacher, and computation takes about 30% longer.

## Equal-input comparison

- Current engine: main `27af82be` with the room preferences saved on 11 November.
- Draft allocator: `f4a340d4`; the polish adds a Joy preference guard and clearer controls without changing allocation results.
- Input captured: `2026-11-11T04:05:31.017Z`. Period: 14 November–11 December 2026, 28 days.
- Same 55 stored profiles, room catalog, 2,440 session records, saved explicit overrides and recorded reservations in both engines. No profile regeneration during comparison. No confirmed room reservations in this snapshot.
- Input SHA-256: `54ecf1c2e8bfb46d34ef1a344f7ccec59e6d56206b52afdd749b36c9dcd3420a`.
- Fresh-generation simulation, not a Wise publication or a guarantee against later schedule changes.

| Measure | Current engine | Draft |
|---|---:|---:|
| Lessons | 2,440 | 2,440 |
| Assigned a room | 2,119 | 2,119 |
| Remote lessons | 321 | 321 |
| Unassigned lessons | 0 | 0 |
| Room overlaps | 0 | 0 |
| Connected-lesson room changes | 2 | 0 |
| Lessons in primary room | 1,798 | 1,906 |
| Lessons in reserve room | 131 | 75 |
| Total distinct rooms per teacher, summed across days | 624 | 619 |
| Last-resort room assignments | 0 | 0 |

Primary-room use rises from 84.9% to 89.9% of room-assigned lessons. All Gift, Kevin, Mek and Ras assignments match the current engine; capacity, mandatory TV, active-room and overlap checks pass. The two removed connected-lesson room changes are on 28 November and 5 December. Both engines have zero such changes on 14–15 November.

## Trade-offs

Initial local replay time was 28.9 seconds for the current engine and 37.4 seconds for the draft across all 28 dates. This is a local timing sample, not a production latency guarantee. A second run made during the full test suite reproduced allocation counts exactly; its timings were affected by the shared CPU load.

| Teacher | Current primary-room lessons | Draft primary-room lessons |
|---|---:|---:|
| Amy | 54 | 49 |
| Art | 11 | 8 |
| Aya | 3 | 2 |
| Celeste | 90 | 87 |
| Mikki | 60 | 58 |
| Peat | 65 | 53 |
| Shop | 25 | 22 |
| Sunday | 33 | 32 |
| Win | 11 | 8 |

Dates with a higher sum of distinct rooms per teacher: 2026-11-14 (40 → 41), 2026-11-28 (45 → 46), 2026-11-29 (31 → 32), 2026-12-05 (46 → 48). The sum across all 28 dates still falls from 624 to 619. These counts sum each teacher's distinct rooms on each date; they are not counts of physical rooms in the building.

## Existing saved plans

The frozen-plan replay preserves all 337 valid saved rows and their publication state. Both engines reject the same 7 Ohm lessons saved in inactive Eureka on 15 November. This is an existing saved-plan issue, not a draft regression. No saved rows were changed.

## Polish and validation

- Reject Joy as a non-Gift teacher's primary or reserve preference. Keep explicit lesson overrides unchanged.
- Keep a legacy invalid choice visible but disabled in the form. Clarify the correction message and save button.
- Extend the existing PostgreSQL test with the concrete forbidden-reserve case; it failed before the fix and passed after.
- Four room-profile integration tests pass, including concurrent refresh, admin-profile preservation and saved-row preservation.
- Full unit run: 8,815 pass; one sandbox-blocked process-start lookup passes in the six-test rerun outside the sandbox. CI repeats the complete suite.
- Type-check, full lint and production route-surface guard pass.
- Actual settings component checked in a local browser with a mock API: Gift has one control, Joy is excluded for Da, Glai's legacy Joy remains visible and disabled, save succeeds, and no page errors. This does not verify signed-in production UI use.
- Production build passes locally on Node 24. Remote CI status is attached to PR #281.

No deployment, merge, production profile change, saved-plan regeneration, Wise write or external message was performed during this comparison.
