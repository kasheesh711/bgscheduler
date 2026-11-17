# Hiring job aids

One printed page for each role. Each page gives numbered steps for that role's top 3 daily tasks on https://bgscheduler.vercel.app/hiring.

| Role | Job aid | Main view (has a first-use hint) |
|---|---|---|
| HR (people@) | [hr.md](hr.md) | **2 Calls**, **Visit day → Run sheet** |
| Head of department | [head-of-department.md](head-of-department.md) | **Visit day → Heads: upcoming mocks** |
| Admin (Aya, Thea) | [admin-aya-thea.md](admin-aya-thea.md) | **Visit day → Aya: print list** |
| Kevin (owner) | [kevin.md](kevin.md) | **Overview → Hiring funnel and pipeline** |

Two limits apply to every role today:
- Rooms are not stored. Every visit shows "Needs review: no room is booked for this visit".
- **Message previews** are previews only. The app sends nothing from the Visit day tab.

A hint closes when you click **Got it**. The browser remembers it. A private window shows it again.

## Maintainer note

Do not print this section. Each task maps to one check script in the local, git-ignored task harness (`roles.mjs`):

| Job aid | Task 1 | Task 2 | Task 3 |
|---|---|---|---|
| HR | `hr-1-call-next` | `hr-2-next-visits` | `hr-3-candidate-stage` |
| Head of department | `hod-1-next-mock` | `hod-2-week-mocks` | `hod-3-paper-result` |
| Admin (Aya, Thea) | `aya-1-print-tomorrow` | `aya-2-room` | `aya-3-no-paper-today` |
| Kevin | `kevin-1-conversion` | `kevin-2-stuck` | `kevin-3-time-in-stage` |

When a UI label changes, update the aid text to the exact visible label. The hints in the app point to "the printed <Role> job aid", never to a file path.
