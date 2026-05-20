# AI Scheduler Accuracy Audit - 2026-05-20

## Summary

This audit reviewed all 16 production AI scheduler runs logged in `ai_scheduler_runs` through 2026-05-20 08:08 UTC, joined to persisted scheduler conversations/messages where available. Scoring uses a strict 10-point rubric:

- 2 points: extracted subject/student/mode/duration correctly
- 2 points: preserved explicit day/date/time constraints
- 2 points: mapped qualifications and tutor constraints safely
- 2 points: clarified when parent-ready output was unsafe
- 2 points: returned useful, non-misleading output

Overall result: 4 accurate/mixed-safe legacy runs, 5 mixed runs with over-clarification or state cleanup issues, and 7 bad/critical runs. The most serious regression is Care KT's Econ request: the model recognized Friday/Saturday times in prose but omitted structured `dayOfWeek`, `startTime`, and `endTime`, so the solver broad-searched and returned Monday/Tuesday options.

## Scored Runs

| Run | Admin | Request | Status | Score | Verdict | Notes |
| --- | --- | --- | --- | ---: | --- | --- |
| `6950b017` | Kevin | Physics, Sundays, 5-7pm | needs clarification | 6 | mixed | Safe clarification, but "Sundays" likely implied recurring and the flow asked unnecessary mode confirmation. |
| `407a50cc` | Kevin | Physics tutor Sunday around 1pm | needs clarification | 8 | accurate | Correctly treated bare Sunday/around 1pm/duration as ambiguous. |
| `241e185f` | Kevin | Physics, 24 May Sunday, recurring, 60 min | solved | 8 | accurate | Preserved recurring Sunday 13:00-14:00. Minor issue: both date and recurring state were retained. |
| `caf4c429` | Kevin | Thai urgent Chemistry tonight/tomorrow | needs clarification | 9 | accurate | Correctly avoided choosing between multiple urgent alternatives. |
| `841efaff` | Kevin | Chemistry follow-up, 60 min, onsite, 24 May 6pm, continuous | needs clarification | 7 | mixed | Safe conflict handling, but over-clarified after enough fields were supplied. |
| `05bd5e6e` | Kevin | N' Rita, every Sunday at 6pm | solved | 4 | critical | Exact 18:00 request was not protected; assistant ranked 19:00 as "Best fit" and parent-ready. |
| `643f05ad` | Suphitsara | Henry Year 5 Math, Saturday 10-11 | needs clarification | 7 | mixed | Correct slot and subject, but retained unnecessary delivery/contact questions and failed Year 5 mapping. |
| `2649f228` | Suphitsara | "on site only" | needs clarification | 5 | mixed | Mode updated to onsite, but stale "confirm delivery mode" question remained. |
| `50edd166` | Suphitsara | Ing Ing English writing, Sat/Sun 9-12 onsite | needs clarification | 2 | critical | New independent request was merged into stale Henry Math state, producing Saturday 10-11 Math suggestions. |
| `9aa6bcf6` | Natchasmith | Maze 11+/13+ English, 13-14 | needs clarification | 6 | mixed | Correctly asked for weekday and English subtype, but broad tentative suggestions risked admin confusion. |
| `ccccb44a` | Natchasmith | "recurring" | needs clarification | 5 | mixed | Recurring answer was captured, but the old "is this recurring?" question and broad suggestions remained. |
| `4ec80617` | Suphitsara | Thames.Te Math replacing June, Thu 5-6 online | needs clarification | 7 | mixed | Correct day/time/mode/subject and did not suggest June, but over-clarified metadata before usable output. |
| `91b86850` | Suphitsara | Deenoh/Deenah NonVR replacing June, Saturday onsite | needs clarification | 2 | critical | Replacement wording was treated as tutor preference; assistant suggested June, the tutor to replace. |
| `2b6a0c0c` | Suphitsara | Praad Math Sunday 12:00 | needs clarification | 1 | critical | New Praad request was merged into stale Deenoh/June/NonVR/Saturday state and suggested June. |
| `e41c2a25` | Care KT | Econ Y10 for เอิง, Fri 18:30-19:30 and Sat 13:00-14:00 | solved | 1 | critical | Parsed prose captured the right slots, but structured state missed day/time fields; solver returned Monday/Tuesday. |
| `0a56281f` | Care KT | "ไม่เริ่ด" feedback | solved | 1 | critical | Negative feedback repeated the same bad suggestions instead of asking what was wrong or changing constraints. |

## Areas Of Concern

- Missing structured constraints: extracted prose/assumptions can mention exact days/times while structured state omits them. The solver then broad-searches all availability.
- Broad fallback is too permissive: missing `dayOfWeek`, `date`, or `startTime` can still generate "proven" options across the week.
- Exact-start requests are not protected: "at 6pm" can return 7pm first because candidate generation searches the containing availability window.
- Conversation state is sticky across independent requests: new students/classes inherit stale subject, mode, day, tutor, and unresolved questions.
- Replacement language is unsafe: "แทนครูจูน" must exclude June, not restrict to June.
- Negative feedback is ignored: messages like "ไม่เริ่ด" should force clarification or alternative strategy, not repeat the previous answer.
- Parent-ready status is over-trusted: `parentReady=true` currently means "no questions were generated," not "all explicit constraints are represented and respected."

## Fix Plan

1. Add structured `requestedSlots[]` to scheduler extraction and resolved state. Each slot must carry `searchMode`, `dayOfWeek` or `date`, `startTime`, `endTime`, and `durationMinutes`.
2. Generate candidate slots from `requestedSlots[]` when present. Multi-slot requests must search only those exact slots and return suggestions grouped by requested slot.
3. Add parent-ready guardrails: if explicit day/time constraints exist but no structured slot is available, return clarification/no-match instead of broad suggestions.
4. Derive exact end time from start plus known/default duration when an admin gives an exact start without an end time.
5. Reset stale state for independent new requests by replacing subject/day/time/student/tutor fields when the newest message introduces a different student or class.
6. Add `tutorExclusions[]` and parse replacement wording as exclusions.
7. Treat negative feedback as a clarification turn that blocks repeated parent-ready output.
8. Add regression tests for the Care KT Thai Econ request, exact-start behavior, multi-slot grouping, new-request reset, tutor exclusion, and negative feedback.
