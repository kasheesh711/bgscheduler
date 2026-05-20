# AI Scheduler Replay Evaluation - 2026-05-20

## Summary

Replayed all 16 production AI scheduler runs read-only against the current scheduler conversation flow using `gpt-5.4-mini` and the active Wise snapshot `260248bb-7c0d-46fa-8ff1-f5834bf3984a`. OpenAI calls used `store:false`; no production rows were inserted or updated.

Old total score: 79/160. New total score: 147/160. Improved: 14. Regressed: 2. Remaining critical: 0.

Care KT Econ regression: new output status is parent_ready; suggestions are Friday 18:30-19:30, Saturday 13:00-14:00. Monday/Tuesday leakage: NO.

Raw replay JSON artifact: `/tmp/bgscheduler/ai-scheduler-replay-2026-05-20.json`.

## Comparison Table

| Run | Admin | Request | Old | New | Delta | New Status | Concerns |
| --- | --- | --- | --- | --- | ---: | --- | --- |
| `6950b017` | Kevin | Physics, Sundays, 5-7pm | 6 (mixed) | 9 (accurate) | +3 | parent-ready | None |
| `407a50cc` | Kevin | Physics tutor Sunday around 1pm | 8 (accurate) | 5 (mixed) | -3 | parent-ready | Clarification case still returned tentative suggestions.; Marked parent-ready when clarification was expected. |
| `241e185f` | Kevin | Physics, 24 May Sunday, recurring, 60 min | 8 (accurate) | 10 (accurate) | +2 | parent-ready | None |
| `caf4c429` | Kevin | Thai urgent Chemistry tonight/tomorrow | 9 (accurate) | 7 (mixed) | -2 | clarify | Clarification case still returned tentative suggestions. |
| `841efaff` | Kevin | Chemistry follow-up, 60 min, onsite, 24 May 6pm | 7 (mixed) | 8 (accurate) | +1 | clarify | Missing/wrong extraction: level Y9-11. |
| `05bd5e6e` | Kevin | N' Rita, every Sunday at 6pm | 4 (critical) | 10 (accurate) | +6 | parent-ready | None |
| `643f05ad` | Suphitsara | Henry Year 5 Math, Saturday 10-11 | 7 (mixed) | 9 (accurate) | +2 | parent-ready | Missing/wrong extraction: level Year 5. |
| `2649f228` | Suphitsara | Henry follow-up: on site only | 5 (mixed) | 9 (accurate) | +4 | parent-ready | Missing/wrong extraction: level Year 5. |
| `50edd166` | Suphitsara | Ing Ing English writing, Sat/Sun 9-12 onsite | 2 (critical) | 10 (accurate) | +8 | parent-ready | None |
| `9aa6bcf6` | Natchasmith | Maze 11+/13+ English, 13-14 | 6 (mixed) | 10 (accurate) | +4 | clarify | None |
| `ccccb44a` | Natchasmith | Maze follow-up: recurring | 5 (mixed) | 10 (accurate) | +5 | clarify | None |
| `4ec80617` | Suphitsara | Thames.Te Math replacing June, Thu 5-6 online | 7 (mixed) | 10 (accurate) | +3 | parent-ready | None |
| `91b86850` | Suphitsara | Deenoh/Deenah NonVR replacing June, Saturday onsite | 2 (critical) | 10 (accurate) | +8 | clarify | None |
| `2b6a0a0c` | Suphitsara | Praad Math Sunday 12:00 | 1 (critical) | 10 (accurate) | +9 | parent-ready | None |
| `e41c2a25` | Care KT | Econ Y10 for เอิง, Fri 18:30-19:30 and Sat 13:00-14:00 | 1 (critical) | 10 (accurate) | +9 | parent-ready | None |
| `0a56281f` | Care KT | Care KT negative feedback: ไม่เริ่ด | 1 (critical) | 10 (accurate) | +9 | clarify | None |

## Remaining Concerns

- No replayed run scored as critical under the audit rubric.

Other cases that remain below accurate:
- `407a50cc` Physics tutor Sunday around 1pm: 5/10 (mixed). Clarification case still returned tentative suggestions.
- `caf4c429` Thai urgent Chemistry tonight/tomorrow: 7/10 (mixed). Clarification case still returned tentative suggestions.

## Run Details

### 6950b017 - Physics, Sundays, 5-7pm

- Old score: 6 (mixed); new score: 9 (accurate); delta: +3.
- New status: parent_ready.
- Assistant: I could not find a proven available option yet. Could you share another day or time range?
- Suggestions: None.
- Questions: None.
- Notes: Explicit day/time constraints were preserved. Rubric components: extraction 2/2, constraints 2/2, qualification/tutor 2/2, safety 2/2, usefulness 1/2.
- Concerns: None.
### 407a50cc - Physics tutor Sunday around 1pm

- Old score: 8 (accurate); new score: 5 (mixed); delta: -3.
- New status: parent_ready.
- Assistant: I found 1 proven option. Best fit: every Sunday, 1pm-2pm (Hansri, June).
- Suggestions: Sunday 13:00-14:00 (Hansri, June).
- Questions: None.
- Notes: Rubric components: extraction 2/2, constraints 1/2, qualification/tutor 2/2, safety 0/2, usefulness 0/2.
- Concerns: Clarification case still returned tentative suggestions. Marked parent-ready when clarification was expected.
### 241e185f - Physics, 24 May Sunday, recurring, 60 min

- Old score: 8 (accurate); new score: 10 (accurate); delta: +2.
- New status: parent_ready.
- Assistant: I found 1 proven option. Best fit: every Sunday, 1pm-2pm (Hansri, June).
- Suggestions: Sunday 13:00-14:00 (Hansri, June).
- Questions: None.
- Notes: Explicit day/time constraints were preserved. Rubric components: extraction 2/2, constraints 2/2, qualification/tutor 2/2, safety 2/2, usefulness 2/2.
- Concerns: None.
### caf4c429 - Thai urgent Chemistry tonight/tomorrow

- Old score: 9 (accurate); new score: 7 (mixed); delta: -2.
- New status: needs_clarification.
- Assistant: I found tentative timing options, but one detail still needs confirmation. Best fit: 2026-05-24, 10pm-11pm (Ras). What exact time tomorrow morning do you want to book?
- Suggestions: 2026-05-24 22:00-23:00 (Ras).
- Questions: What exact time tomorrow morning do you want to book?.
- Notes: Rubric components: extraction 2/2, constraints 1/2, qualification/tutor 2/2, safety 1/2, usefulness 1/2.
- Concerns: Clarification case still returned tentative suggestions.
### 841efaff - Chemistry follow-up, 60 min, onsite, 24 May 6pm

- Old score: 7 (mixed); new score: 8 (accurate); delta: +1.
- New status: needs_clarification.
- Assistant: I found tentative timing options, but one detail still needs confirmation. Best fit: 2026-05-24, 6pm-7pm (Ras, Kavin). Should I also search for a separate online slot tonight or tomorrow morning?
- Suggestions: 2026-05-24 18:00-19:00 (Ras, Kavin).
- Questions: Should I also search for a separate online slot tonight or tomorrow morning? / Level "Y10" is not an active Wise qualification. Please clarify the exact requirement..
- Notes: Explicit day/time constraints were preserved. Output stayed tentative despite finding matching slot(s). Rubric components: extraction 1/2, constraints 2/2, qualification/tutor 2/2, safety 1/2, usefulness 2/2.
- Concerns: Missing/wrong extraction: level Y9-11.
### 05bd5e6e - N' Rita, every Sunday at 6pm

- Old score: 4 (critical); new score: 10 (accurate); delta: +6.
- New status: parent_ready.
- Assistant: I found 1 proven option. Best fit: every Sunday, 6pm-7pm (Ras, Win-Bordin, Petch-Than).
- Suggestions: Sunday 18:00-19:00 (Ras, Win-Bordin, Petch-Than, Sand).
- Questions: None.
- Notes: Explicit day/time constraints were preserved. Rubric components: extraction 2/2, constraints 2/2, qualification/tutor 2/2, safety 2/2, usefulness 2/2.
- Concerns: None.
### 643f05ad - Henry Year 5 Math, Saturday 10-11

- Old score: 7 (mixed); new score: 9 (accurate); delta: +2.
- New status: parent_ready.
- Assistant: I found 1 proven option. Best fit: every Saturday, 10am-11am (Fluke-Supha, Pawin, Nithit).
- Suggestions: Saturday 10:00-11:00 (Fluke-Supha, Pawin, Nithit, Bank).
- Questions: None.
- Notes: Explicit day/time constraints were preserved. Rubric components: extraction 1/2, constraints 2/2, qualification/tutor 2/2, safety 2/2, usefulness 2/2.
- Concerns: Missing/wrong extraction: level Year 5.
### 2649f228 - Henry follow-up: on site only

- Old score: 5 (mixed); new score: 9 (accurate); delta: +4.
- New status: parent_ready.
- Assistant: I found 1 proven option. Best fit: every Saturday, 10am-11am (Fluke-Supha, Pawin, Nithit).
- Suggestions: Saturday 10:00-11:00 (Fluke-Supha, Pawin, Nithit, Bank).
- Questions: None.
- Notes: Explicit day/time constraints were preserved. Rubric components: extraction 1/2, constraints 2/2, qualification/tutor 2/2, safety 2/2, usefulness 2/2.
- Concerns: Missing/wrong extraction: level Year 5.
### 50edd166 - Ing Ing English writing, Sat/Sun 9-12 onsite

- Old score: 2 (critical); new score: 10 (accurate); delta: +8.
- New status: parent_ready.
- Assistant: I found 8 proven options. Best fit: every Saturday, 9am-10am (Samantha).
- Suggestions: Saturday 09:00-10:00 (Samantha); Saturday 09:30-10:30 (Samantha); Saturday 10:00-11:00 (Samantha, Jennie, Lukas); Saturday 10:30-11:30 (Samantha); Saturday 11:00-12:00 (Samantha, Fay); Sunday 09:00-10:00 (Key, Eng); Sunday 09:30-10:30 (Key); Sunday 10:00-11:00 (Key).
- Questions: None.
- Notes: Explicit day/time constraints were preserved. Rubric components: extraction 2/2, constraints 2/2, qualification/tutor 2/2, safety 2/2, usefulness 2/2.
- Concerns: None.
### 9aa6bcf6 - Maze 11+/13+ English, 13-14

- Old score: 6 (mixed); new score: 10 (accurate); delta: +4.
- New status: needs_clarification.
- Assistant: I could not find a proven available option yet. Which weekday or exact date should I search for that time?
- Suggestions: None.
- Questions: Which weekday or exact date should I search for that time? / Level "11+" is not an active Wise qualification. Please clarify the exact requirement..
- Notes: Rubric components: extraction 2/2, constraints 2/2, qualification/tutor 2/2, safety 2/2, usefulness 2/2.
- Concerns: None.
### ccccb44a - Maze follow-up: recurring

- Old score: 5 (mixed); new score: 10 (accurate); delta: +5.
- New status: needs_clarification.
- Assistant: I could not find a proven available option yet. Which weekday or exact date should I search for that time?
- Suggestions: None.
- Questions: Which weekday or exact date should I search for that time? / Level "11+" is not an active Wise qualification. Please clarify the exact requirement. / Which weekday should I search for that recurring 13:00-14:00 slot? / Confirm the exact level if not 11+..
- Notes: Rubric components: extraction 2/2, constraints 2/2, qualification/tutor 2/2, safety 2/2, usefulness 2/2.
- Concerns: None.
### 4ec80617 - Thames.Te Math replacing June, Thu 5-6 online

- Old score: 7 (mixed); new score: 10 (accurate); delta: +3.
- New status: parent_ready.
- Assistant: I found 1 proven option. Best fit: every Thursday, 5pm-6pm (Fluke-Supha, Kevin, Sand).
- Suggestions: Thursday 17:00-18:00 (Fluke-Supha, Kevin, Sand, Pech).
- Questions: None.
- Notes: Explicit day/time constraints were preserved. Excluded tutor(s) were not suggested: June. Rubric components: extraction 2/2, constraints 2/2, qualification/tutor 2/2, safety 2/2, usefulness 2/2.
- Concerns: None.
### 91b86850 - Deenoh/Deenah NonVR replacing June, Saturday onsite

- Old score: 2 (critical); new score: 10 (accurate); delta: +8.
- New status: needs_clarification.
- Assistant: I could not find a proven available option yet. What start time should I search for that day?
- Suggestions: None.
- Questions: What start time should I search for that day?.
- Notes: Excluded tutor(s) were not suggested: June. Rubric components: extraction 2/2, constraints 2/2, qualification/tutor 2/2, safety 2/2, usefulness 2/2.
- Concerns: None.
### 2b6a0a0c - Praad Math Sunday 12:00

- Old score: 1 (critical); new score: 10 (accurate); delta: +9.
- New status: parent_ready.
- Assistant: I found 1 proven option. Best fit: every Sunday, 12pm-1pm (A, Win-Bordin, Fluke-Supha).
- Suggestions: Sunday 12:00-13:00 (A, Win-Bordin, Fluke-Supha, Fluke).
- Questions: None.
- Notes: Explicit day/time constraints were preserved. Excluded tutor(s) were not suggested: June. Rubric components: extraction 2/2, constraints 2/2, qualification/tutor 2/2, safety 2/2, usefulness 2/2.
- Concerns: None.
### e41c2a25 - Econ Y10 for เอิง, Fri 18:30-19:30 and Sat 13:00-14:00

- Old score: 1 (critical); new score: 10 (accurate); delta: +9.
- New status: parent_ready.
- Assistant: I found 2 proven options. Best fit: every Friday, 6:30pm-7:30pm (Jan).
- Suggestions: Friday 18:30-19:30 (Jan); Saturday 13:00-14:00 (Jan, Celeste).
- Questions: None.
- Notes: Explicit day/time constraints were preserved. Rubric components: extraction 2/2, constraints 2/2, qualification/tutor 2/2, safety 2/2, usefulness 2/2.
- Concerns: None.
### 0a56281f - Care KT negative feedback: ไม่เริ่ด

- Old score: 1 (critical); new score: 10 (accurate); delta: +9.
- New status: needs_clarification.
- Assistant: I could not find a proven available option yet. What should be changed about the suggested class options?
- Suggestions: None.
- Questions: What should be changed about the suggested class options? / What should I change about the previous options: day/time, subject/level, tutor, or mode?.
- Notes: Rubric components: extraction 2/2, constraints 2/2, qualification/tutor 2/2, safety 2/2, usefulness 2/2.
- Concerns: None.
