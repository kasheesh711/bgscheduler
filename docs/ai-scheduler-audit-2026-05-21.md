# AI Scheduler Accuracy Audit - 2026-05-21

## Summary

This audit scored the 7 production AI scheduler runs logged on 2026-05-21 in Asia/Bangkok (UTC range 2026-05-20T17:00:00.000Z to 2026-05-21T17:00:00.000Z). It evaluates what admins actually saw in production, without changing production rows.

Production total score: 45/70. Verdict mix: 3 accurate, 1 mixed, 3 bad, 0 critical.

Tutor profile seed state at evaluation time: 67 active profiles, latest update 2026-05-21T16:21:35 UTC.

Scoring uses the same 10-point rubric as the May 20 audit: extraction, explicit constraints, qualification/tutor/profile safety, parent-ready safety, and usefulness.

## Scored Runs

| Run | Admin | Request | Status | Score | Verdict | Notes |
| --- | --- | --- | --- | ---: | --- | --- |
| `22ae7e92` | Care KT | Writing Y6, first week of July | clarify | 2/10 | bad | Missing/wrong extraction: subject family English-family, searched subjects EFL/ESL/Literature.; Expected date range 2026-07-01 to 2026-07-07 was not preserved.; Required broad availability summary was not returned.; Expected English-family subject-family search was not represented.; Stayed in clarification mode after all required constraints were supplied. |
| `1d7e8733` | Care KT | Writing Y6, Mon-Sun 10:00-18:00 in July | clarify | 4/10 | bad | Missing/wrong extraction: subject family English-family, searched subjects EFL/ESL/Literature.; Expected English-family subject-family search was not represented.; Stale clarification question remained after the missing information was supplied. |
| `64b87983` | Care KT | Writing Y6, Mon-Sun 10:00-18:00 in July, 90 minutes | clarify | 4/10 | bad | Missing/wrong extraction: subject family English-family, searched subjects EFL/ESL/Literature.; Expected English-family subject-family search was not represented.; Stale clarification question remained after the missing information was supplied. |
| `07f84f99` | Panida | Ellen Emma onsite Math/English/Science, 30 May-3 June 09:00-12:00 | parent-ready | 10/10 | accurate | None |
| `e760661c` | Panida | Ellen Emma explicit date list Math/English/Science, 09:00-12:00 | clarify | 8/10 | accurate | English/Science remained in explicit unknown filters instead of being handled as subject-specific searches. |
| `def92a2f` | Natchasmith | Maze 11+/13+ English 13:00-14:00, no day | clarify | 10/10 | accurate | None |
| `12bfcf0e` | Kevin | Maze follow-up: Saturday | clarify | 7/10 | mixed | Stayed in clarification mode after all required constraints were supplied.; Stale clarification question remained after the missing information was supplied. |

## Areas Of Concern

- Missing/wrong extraction: subject family English-family, searched subjects EFL/ESL/Literature.
- Expected date range 2026-07-01 to 2026-07-07 was not preserved.
- Required broad availability summary was not returned.
- Expected English-family subject-family search was not represented.
- Stayed in clarification mode after all required constraints were supplied.
- Stale clarification question remained after the missing information was supplied.
- English/Science remained in explicit unknown filters instead of being handled as subject-specific searches.

## Run Details

### 22ae7e92 - Writing Y6, first week of July

- Admin: Care KT.
- Input: หาครูสอนวิชา writing y6 ช่วง Week แรกของ July
- Score: 2/10 (bad); status: needs_clarification.
- Assistant: I could not find a proven available option yet. Which day/time in the first week of July?
- Availability summary: None.
- Suggestions: None.
- Questions: Which day/time in the first week of July?.
- Notes: First week of July should be interpreted as July 1-7 and answered with a broad proven availability summary, not only a day/time clarification. Rubric components: extraction 1/2, constraints 0/2, qualification/tutor/profile 0/2, safety 1/2, usefulness 0/2.
- Concerns: Missing/wrong extraction: subject family English-family, searched subjects EFL/ESL/Literature. Expected date range 2026-07-01 to 2026-07-07 was not preserved. Required broad availability summary was not returned. Expected English-family subject-family search was not represented. Stayed in clarification mode after all required constraints were supplied.
### 1d7e8733 - Writing Y6, Mon-Sun 10:00-18:00 in July

- Admin: Care KT.
- Input: หาครูสอนวิชา writing y6 ช่วง Mon- Sun 10.00 AM- 6.00 PM  July
- Score: 4/10 (bad); status: needs_clarification.
- Assistant: I could not find a proven available option yet. Which day/time in the first week of July?
- Availability summary: None.
- Suggestions: None.
- Questions: Which day/time in the first week of July?.
- Notes: Explicit date/day/time constraints were preserved. After Mon-Sun and a time range are supplied, the stale first-week day/time question should be cleared. Rubric components: extraction 1/2, constraints 2/2, qualification/tutor/profile 0/2, safety 1/2, usefulness 0/2.
- Concerns: Missing/wrong extraction: subject family English-family, searched subjects EFL/ESL/Literature. Expected English-family subject-family search was not represented. Stale clarification question remained after the missing information was supplied.
### 64b87983 - Writing Y6, Mon-Sun 10:00-18:00 in July, 90 minutes

- Admin: Care KT.
- Input: หาครูสอนวิชา writing y6 ช่วง Mon- Sun 10.00 AM- 6.00 PM  July จะเรียนประมาณ 1.5
- Score: 4/10 (bad); status: needs_clarification.
- Assistant: I could not find a proven available option yet. Which day/time in the first week of July?
- Availability summary: None.
- Suggestions: None.
- Questions: Which day/time in the first week of July?.
- Notes: Explicit date/day/time constraints were preserved. Once duration is known, the system should search or safely explain no match, not repeat the stale question. Rubric components: extraction 1/2, constraints 2/2, qualification/tutor/profile 0/2, safety 1/2, usefulness 0/2.
- Concerns: Missing/wrong extraction: subject family English-family, searched subjects EFL/ESL/Literature. Expected English-family subject-family search was not represented. Stale clarification question remained after the missing information was supplied.
### 07f84f99 - Ellen Emma onsite Math/English/Science, 30 May-3 June 09:00-12:00

- Admin: Panida.
- Input: Ellen Emma จะมา Onsite วันที่ 30 May - 3 June อยากได้ตารางครูสอนวิชา Math English Science เวลา 9:00 - 12:00 น.
- Score: 10/10 (accurate); status: parent_ready.
- Assistant: I found 8 proven options. Best fit: 2026-05-30, 9am-10am (Bank, Eng, Mookie).
- Availability summary: None.
- Suggestions: 2026-05-30 09:00-10:00 (Bank, Eng, Mookie, Pawin); 2026-05-30 09:30-10:30 (Bank, Pawin, Win-Bordin); 2026-05-30 10:00-11:00 (Bank, Fluke, Fluke-Supha, Linn); 2026-05-30 10:30-11:30 (Bank, Fluke-Supha, Linn, Nithit); 2026-05-30 11:00-12:00 (Bank, Fluke-Supha, Linn, Nithit); 2026-05-31 09:00-10:00 (Celeste, Eng, Kavin, Mookie); 2026-05-31 09:30-10:30 (Celeste, Kavin, Sand, Win-Bordin); 2026-05-31 10:00-11:00 (Celeste, Copter, Fluke-Supha, Kavin).
- Questions: None.
- Notes: Explicit date/day/time constraints were preserved. The request asks for Math, English, and Science; Math-only parent-ready output is unsafe. Rubric components: extraction 2/2, constraints 2/2, qualification/tutor/profile 2/2, safety 2/2, usefulness 2/2.
- Concerns: None.
### e760661c - Ellen Emma explicit date list Math/English/Science, 09:00-12:00

- Admin: Panida.
- Input: Ellen Emma จะมา Onsite วันที่ 30 May , 31 May , 1 June, 2 June , 3 June อยากได้ตารางครูสอนวิชา Math English Science เวลา 9:00 - 12:00 น.
- Score: 8/10 (accurate); status: needs_clarification.
- Assistant: I found tentative timing options, but one detail still needs confirmation. Best fit: 2026-05-30, 9am-10am (Bank, Eng, Mookie). English is not mapped to an active Wise qualification. Please clarify.
- Availability summary: None.
- Suggestions: 2026-05-30 09:00-10:00 (Bank, Eng, Mookie, Pawin); 2026-05-30 09:30-10:30 (Bank, Pawin, Win-Bordin); 2026-05-30 10:00-11:00 (Bank, Fluke, Fluke-Supha, Linn); 2026-05-30 10:30-11:30 (Bank, Fluke-Supha, Linn, Nithit); 2026-05-30 11:00-12:00 (Bank, Fluke-Supha, Linn, Nithit); 2026-05-31 09:00-10:00 (Celeste, Eng, Kavin, Mookie); 2026-05-31 09:30-10:30 (Celeste, Kavin, Sand, Win-Bordin); 2026-05-31 10:00-11:00 (Celeste, Copter, Fluke-Supha, Kavin).
- Questions: English is not mapped to an active Wise qualification. Please clarify..
- Notes: Explicit date/day/time constraints were preserved. The system should preserve all explicit dates and run subject-specific searches instead of treating English/Science as unmapped or suggesting Math-only options. Rubric components: extraction 2/2, constraints 2/2, qualification/tutor/profile 1/2, safety 2/2, usefulness 1/2.
- Concerns: English/Science remained in explicit unknown filters instead of being handled as subject-specific searches.
### def92a2f - Maze 11+/13+ English 13:00-14:00, no day

- Admin: Natchasmith.
- Input: maze 11+ english ว่าง 13.00-14.00 มีครูไรบ้าง
- Score: 10/10 (accurate); status: needs_clarification.
- Assistant: I could not find a proven available option yet. Which weekday or exact date should I search for that time?
- Availability summary: None.
- Suggestions: None.
- Questions: Which weekday or exact date should I search for that time?.
- Notes: Missing weekday/date should block broad search and ask for the day/date. Rubric components: extraction 2/2, constraints 2/2, qualification/tutor/profile 2/2, safety 2/2, usefulness 2/2.
- Concerns: None.
### 12bfcf0e - Maze follow-up: Saturday

- Admin: Kevin.
- Input: Saturday
- Score: 7/10 (mixed); status: needs_clarification.
- Assistant: I found tentative timing options, but one detail still needs confirmation. Best fit: every Saturday, 1pm-2pm (Fay, Nacha (Poi), Samantha). Which weekday or exact date should I search for that time?
- Availability summary: None.
- Suggestions: Saturday 13:00-14:00 (Fay, Nacha (Poi), Samantha).
- Questions: Which weekday or exact date should I search for that time?.
- Notes: Explicit date/day/time constraints were preserved. Saturday supplies the missing day; the prior clarification question should be cleared. Rubric components: extraction 2/2, constraints 2/2, qualification/tutor/profile 2/2, safety 1/2, usefulness 0/2.
- Concerns: Stayed in clarification mode after all required constraints were supplied. Stale clarification question remained after the missing information was supplied.
