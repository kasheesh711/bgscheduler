# Future classroom preview — September 6–12, 2026

Read-only production validation before deployment. No assignment runs, Wise locations or emails were changed. A single live Wise read and read-only Postgres transaction were shared across all seven dates.

Generated 2026-09-05T05:17:17.503Z. Results are a planning snapshot; future runs must fetch fresh data.

| Date | Live sessions | Planned | No room | Unmatched identities | Invalid proposed placements |
|---|---:|---:|---:|---:|---:|
| 2026-09-06 | 121 | 121 | 0 | 0 | 0 |
| 2026-09-07 | 38 | 38 | 0 | 0 | 0 |
| 2026-09-08 | 53 | 53 | 0 | 0 | 0 |
| 2026-09-09 | 50 | 49 | 0 | 1 | 0 |
| 2026-09-10 | 45 | 45 | 0 | 0 | 0 |
| 2026-09-11 | 31 | 31 | 0 | 0 | 0 |
| 2026-09-12 | 182 | 182 | 4 | 0 | 0 |

## Findings

- September 6–11: every matched session needing a room receives a valid placement. Two unverified saved September 6 sessions remain frozen with their known occupancy retained.
- September 9: Kem has an online (`SCHEDULED`) session at 18:45 whose Wise user is absent from the active identity snapshot. Do not infer a replacement identity or send to a guessed recipient. The repair now persists unmanaged live session IDs/counts in assignment-run metadata and reports them in cron failure summaries and admin alerts.
- September 12, 10:30: 22 onsite classes plus Kevin’s online class fixed in a standard room require 23 standard rooms; only 22 exist. The second online-only room cannot resolve this under the approved fixed-room constraint.
- September 12, 13:30: 23 onsite classes require the 22 onsite rooms. At least one class cannot fit, regardless of search depth.
- Four rows remain unresolved in the safe preview: Kavin and Shop at 10:30, Lukas and Ras at 13:30. Each pair currently shares one Wise room (Focus / Never Ever). Retaining actual occupancy prevents proposing a partial placement that hides those existing conflicts. The bounded solver reports search exhaustion; the independent simultaneous-demand counts above establish a real shortage.
- No rooms, times, tutor identities, fixed-room policies or recipients were changed to conceal these conditions. Staff must resolve these scheduling constraints before September 12; the automated run will surface failures until they are resolved.

## Rollout boundary

Deploy code for the next scheduled run only. Do not invoke September 5 automation, apply its historical recovery preview, or resend its operational emails. First-run verification is scheduled in this task for September 6 at 07:45 Asia/Bangkok, after the 06:41 morning run and 07:04–07:36 admin window. Verification is read-only.
