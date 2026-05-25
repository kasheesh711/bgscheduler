# AI Scheduler Evaluation

Generated: 2026-05-22T07:47:02.858Z
Model: `gpt-5.5`
Reasoning effort: `low`
Snapshot: `c8fa92f5-b9a4-4d0a-9263-8d58ff285625`
Score: 223/260
Critical failures: 3
Latency: p50 4459ms · p95 11353ms · max 14224ms

| Case | Score | Latency | Parent-ready | Critical | Concerns |
| --- | ---: | ---: | --- | --- | --- |
| Audit May 20: Physics Sundays 17:00-19:00 | 5/10 | 3917ms | yes | no | Expected parentReady=false, got true.; Expected a clarification question. |
| Audit May 20: Physics Sunday around 13:00 needs precision | 3/10 | 3355ms | yes | no | Expected parentReady=false, got true.; Expected a clarification question.; Expected no tentative suggestions. |
| Audit May 20: Physics 24 May recurring 60 minutes | 6/10 | 4488ms | yes | yes | Expected a clarification question.; Expected date range 2026-05-24 to 2026-05-24. |
| Audit May 20: urgent Chemistry tonight/tomorrow should clarify | 8/10 | 4773ms | no | no | Expected no tentative suggestions. |
| Audit May 20: Chemistry follow-up with exact onsite recurring slot | 8/10 | 14224ms | no | no | Expected date range 2026-05-24 to 2026-05-24. |
| Audit May 20: N' Student Alpha exact Sunday 18:00 | 10/10 | 3584ms | yes | no | None |
| Audit May 20: Student Beta Year 5 Math Saturday 10-11 | 10/10 | 3692ms | yes | no | None |
| Audit May 20: Student Beta follow-up onsite only | 10/10 | 7133ms | yes | no | None |
| Audit May 20: new Student Gamma English writing request should reset stale Math state | 10/10 | 11839ms | yes | no | None |
| Audit May 20: Student Delta 11+/13+ English missing weekday | 10/10 | 4008ms | no | no | None |
| Audit May 20: Student Delta recurring follow-up still needs day | 8/10 | 11353ms | no | no | Missing expected slot 13:00-14:00. |
| Audit May 20: Student Epsilon Math replacing Teacher One | 10/10 | 4399ms | yes | no | None |
| Audit May 20: Student Zeta NonVR replacing Teacher One | 8/10 | 4130ms | no | no | Missing expected slot 15:00-20:00. |
| Audit May 20: Student Eta Math Sunday reset from stale Teacher One replacement | 10/10 | 6961ms | yes | no | None |
| Audit May 20: Econ Y10 exact Friday and Saturday slots | 10/10 | 4225ms | yes | no | None |
| Audit May 20: negative feedback asks for correction | 10/10 | 9938ms | no | no | None |
| Audit May 21: Writing Y6 first week of July broad summary | 10/10 | 4695ms | yes | no | None |
| Audit May 21: Writing Y6 July Mon-Sun 10:00-18:00 | 5/10 | 6884ms | yes | yes | Expected an availability summary.; Missing expected slot 10:00-18:00. |
| Audit May 21: Writing Y6 July Mon-Sun 10:00-18:00 90 minutes | 7/10 | 5868ms | yes | no | Expected an availability summary. |
| Audit May 21: Students Iota and Kappa onsite Math English Science date range | 10/10 | 4459ms | yes | no | None |
| Audit May 21: Students Iota and Kappa explicit date list Math English Science | 8/10 | 8487ms | yes | yes | Expected date range 2026-05-30 to 2026-06-03. |
| Audit May 21: Student Delta 11+/13+ English no day | 10/10 | 3989ms | no | no | None |
| Audit May 21: Student Delta Saturday follow-up clears stale question | 7/10 | 8683ms | no | no | Expected parentReady=true, got false. |
| New failure target: Year 5 English writing uses academic mapping and tutor evidence | 10/10 | 4445ms | yes | no | None |
| New failure target: IGCSE Econ profile-fit ranking evidence | 10/10 | 4165ms | yes | no | None |
| New failure target: Thai grade Science and Math multi-subject | 10/10 | 3701ms | yes | no | None |

Raw JSON: `/tmp/bgscheduler/ai-scheduler-eval-latest.json`
