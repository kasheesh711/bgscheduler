# AI Scheduler Replay Evaluation - 2026-05-21

## Summary

Replayed the same 7 production AI scheduler turns read-only against the current scheduler conversation flow using `gpt-5.4-mini`, active Wise snapshot `950a2867-3c55-49c4-97df-c6063c0e15d7`, and search index profile version `67:2026-05-21 16:21:35.042+00`. OpenAI calls used `store:false`; no production rows were inserted or updated.

Tutor profile seed state: 67 active profiles, latest update 2026-05-21T16:21:35 UTC.

Production total score: 45/70. Replay total score: 70/70. Improved: 5. Regressed: 0. Replay remaining critical: 0.

Raw replay JSON artifact: `/tmp/bgscheduler/ai-scheduler-replay-2026-05-21.json`.

## Comparison Table

| Run | Admin | Request | Production | Replay | Delta | Replay Status | Replay Concerns |
| --- | --- | --- | --- | --- | ---: | --- | --- |
| `22ae7e92` | Care KT | Writing Y6, first week of July | 2 (bad) | 10 (accurate) | +8 | parent-ready | None |
| `1d7e8733` | Care KT | Writing Y6, Mon-Sun 10:00-18:00 in July | 4 (bad) | 10 (accurate) | +6 | parent-ready | None |
| `64b87983` | Care KT | Writing Y6, Mon-Sun 10:00-18:00 in July, 90 minutes | 4 (bad) | 10 (accurate) | +6 | parent-ready | None |
| `07f84f99` | Panida | Ellen Emma onsite Math/English/Science, 30 May-3 June 09:00-12:00 | 10 (accurate) | 10 (accurate) | 0 | clarify | None |
| `e760661c` | Panida | Ellen Emma explicit date list Math/English/Science, 09:00-12:00 | 8 (accurate) | 10 (accurate) | +2 | clarify | None |
| `def92a2f` | Natchasmith | Maze 11+/13+ English 13:00-14:00, no day | 10 (accurate) | 10 (accurate) | 0 | clarify | None |
| `12bfcf0e` | Kevin | Maze follow-up: Saturday | 7 (mixed) | 10 (accurate) | +3 | parent-ready | None |

## Remaining Concerns

- None.

## Run Details

### 22ae7e92 - Writing Y6, first week of July

- Production score: 2/10 (bad); replay score: 10/10 (accurate); delta: +8.
- Replay status: parent_ready.
- Replay assistant: I searched EFL, ESL, Literature Y2-8 International and found 13 qualified tutors with proven availability from 2026-07-01 to 2026-07-07: Eng, Fay, Fen, Jennie, Key, +8 more.
- Replay availability summary: 2026-07-01 to 2026-07-07; searched EFL Y2-8 International, ESL Y2-8 International, Literature Y2-8 International; 13 tutor(s): Eng (50 windows); Fay (26 windows); Fen (64 windows); Jennie (3 windows); Key (29 windows); Lukas (32 windows); Menika (50 windows); Nacha (Poi) (11 windows); +5 tutors.
- Replay suggestions: None.
- Replay questions: None.
- Notes: Expected date range was preserved. First week of July should be interpreted as July 1-7 and answered with a broad proven availability summary, not only a day/time clarification. Rubric components: extraction 2/2, constraints 2/2, qualification/tutor/profile 2/2, safety 2/2, usefulness 2/2.
- Concerns: None.
### 1d7e8733 - Writing Y6, Mon-Sun 10:00-18:00 in July

- Production score: 4/10 (bad); replay score: 10/10 (accurate); delta: +6.
- Replay status: parent_ready.
- Replay assistant: I found proven options across 3 subjects. Best fit: every Monday, 2:30pm-3:30pm (Nithit).
- Replay availability summary: None.
- Replay suggestions: EFL: Monday 14:30-15:30 (Nithit); ESL: Monday 14:30-15:30 (Nithit); Literature: Tuesday 12:00-13:00 (Fen); EFL: Monday 15:00-16:00 (Nithit); EFL: Monday 15:30-16:30 (Nithit); EFL: Monday 16:00-17:00 (Eng, Key, Nithit); EFL: Monday 16:30-17:30 (Key, Nithit); EFL: Monday 17:00-18:00 (Key, Lukas, Win).
- Replay questions: None.
- Notes: Explicit date/day/time constraints were preserved. After Mon-Sun and a time range are supplied, the stale first-week day/time question should be cleared. Rubric components: extraction 2/2, constraints 2/2, qualification/tutor/profile 2/2, safety 2/2, usefulness 2/2.
- Concerns: None.
### 64b87983 - Writing Y6, Mon-Sun 10:00-18:00 in July, 90 minutes

- Production score: 4/10 (bad); replay score: 10/10 (accurate); delta: +6.
- Replay status: parent_ready.
- Replay assistant: I found proven options across 3 subjects. Best fit: every Monday, 2:30pm-3:30pm (Nithit).
- Replay availability summary: None.
- Replay suggestions: EFL: Monday 14:30-15:30 (Nithit); ESL: Monday 14:30-15:30 (Nithit); Literature: Tuesday 12:00-13:00 (Fen); EFL: Monday 15:00-16:00 (Nithit); EFL: Monday 15:30-16:30 (Nithit); EFL: Monday 16:00-17:00 (Eng, Key, Nithit); EFL: Monday 16:30-17:30 (Key, Nithit); EFL: Monday 17:00-18:00 (Key, Lukas, Win).
- Replay questions: None.
- Notes: Explicit date/day/time constraints were preserved. Once duration is known, the system should search or safely explain no match, not repeat the stale question. Rubric components: extraction 2/2, constraints 2/2, qualification/tutor/profile 2/2, safety 2/2, usefulness 2/2.
- Concerns: None.
### 07f84f99 - Ellen Emma onsite Math/English/Science, 30 May-3 June 09:00-12:00

- Production score: 10/10 (accurate); replay score: 10/10 (accurate); delta: 0.
- Replay status: needs_clarification.
- Replay assistant: I found tentative timing options, but one detail still needs confirmation. Best fit: 2026-05-30, 9am-10am (Eng, Samantha). Which tutor did the parent mean by "เพชร"?
- Replay availability summary: None.
- Replay suggestions: EFL: 2026-05-30 09:00-10:00 (Eng, Samantha); ESL: 2026-05-30 09:00-10:00 (Eng); Literature: 2026-05-30 10:00-11:00 (Fen); EnglishVR: 2026-05-30 09:00-10:00 (Eng, Samantha); Math: 2026-05-30 09:00-10:00 (Bank, Eng, Mookie, Pawin); Science: 2026-05-30 09:00-10:00 (Eng, Mookie); EFL: 2026-05-30 09:30-10:30 (Samantha); EFL: 2026-05-30 10:00-11:00 (Fen, Jennie, Lukas, Nithit).
- Replay questions: Which tutor did the parent mean by "เพชร"?.
- Notes: Explicit date/day/time constraints were preserved. The request asks for Math, English, and Science; Math-only parent-ready output is unsafe. Rubric components: extraction 2/2, constraints 2/2, qualification/tutor/profile 2/2, safety 2/2, usefulness 2/2.
- Concerns: None.
### e760661c - Ellen Emma explicit date list Math/English/Science, 09:00-12:00

- Production score: 8/10 (accurate); replay score: 10/10 (accurate); delta: +2.
- Replay status: needs_clarification.
- Replay assistant: I found tentative timing options, but one detail still needs confirmation. Best fit: 2026-05-30, 9am-10am (Eng, Samantha). Which tutor did the parent mean by "เพชร"?
- Replay availability summary: None.
- Replay suggestions: EFL: 2026-05-30 09:00-10:00 (Eng, Samantha); ESL: 2026-05-30 09:00-10:00 (Eng); Literature: 2026-05-30 10:00-11:00 (Fen); EnglishVR: 2026-05-30 09:00-10:00 (Eng, Samantha); Math: 2026-05-30 09:00-10:00 (Bank, Eng, Mookie, Pawin); Science: 2026-05-30 09:00-10:00 (Eng, Mookie); EFL: 2026-05-30 09:30-10:30 (Samantha); EFL: 2026-05-30 10:00-11:00 (Fen, Jennie, Lukas, Nithit).
- Replay questions: Which tutor did the parent mean by "เพชร"?.
- Notes: Explicit date/day/time constraints were preserved. The system should preserve all explicit dates and run subject-specific searches instead of treating English/Science as unmapped or suggesting Math-only options. Rubric components: extraction 2/2, constraints 2/2, qualification/tutor/profile 2/2, safety 2/2, usefulness 2/2.
- Concerns: None.
### def92a2f - Maze 11+/13+ English 13:00-14:00, no day

- Production score: 10/10 (accurate); replay score: 10/10 (accurate); delta: 0.
- Replay status: needs_clarification.
- Replay assistant: I could not find a proven available option yet. Which weekday or exact date should I search for that time?
- Replay availability summary: None.
- Replay suggestions: None.
- Replay questions: Which weekday or exact date should I search for that time?.
- Notes: Missing weekday/date should block broad search and ask for the day/date. Rubric components: extraction 2/2, constraints 2/2, qualification/tutor/profile 2/2, safety 2/2, usefulness 2/2.
- Concerns: None.
### 12bfcf0e - Maze follow-up: Saturday

- Production score: 7/10 (mixed); replay score: 10/10 (accurate); delta: +3.
- Replay status: parent_ready.
- Replay assistant: I found 1 proven option. Best fit: every Saturday, 1pm-2pm (Fay, Nacha (Poi), Samantha).
- Replay availability summary: None.
- Replay suggestions: Saturday 13:00-14:00 (Fay, Nacha (Poi), Samantha).
- Replay questions: None.
- Notes: Explicit date/day/time constraints were preserved. Saturday supplies the missing day; the prior clarification question should be cleared. Rubric components: extraction 2/2, constraints 2/2, qualification/tutor/profile 2/2, safety 2/2, usefulness 2/2.
- Concerns: None.
