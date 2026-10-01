# Tutor Offboarding — dashboard design for review

Status: approved by the user on 1 October 2026. Implementation planning is in progress; no application changes or ongoing collection have been deployed for this redesign.

## Recommended layout

Keep the dashboard in **Tutor Offboarding → Analytics**, with three sections on one page:

1. **Workforce over time** — monthly turnover and the people joining, leaving or awaiting their final class.
2. **Subject supply and demand** — monthly comparisons, followed by a weekday/time-of-day view for a selected month.
3. **Tutor utilization** — compare individual workloads, credit-consumed hours, available hours and teaching records.

A shared date range starts on 1 March 2026. Month, role, subject, curriculum, level and delivery mode filters remain consistent across the relevant charts. The current month is marked as partial. Tutors and teaching administrators are included; linked Wise accounts count as one person.

### Alternatives considered

| Layout | Best use | Tradeoff |
| --- | --- | --- |
| Workforce → subjects → tutors (recommended) | Monthly management review followed by staffing investigation | A staffing-only user scrolls to the second section |
| Subjects first | Deciding which subjects need more available teaching time | Gives turnover less prominence |
| Tutors first | Reviewing individual workload and availability | Makes broad changes in subject coverage harder to spot |

## 1. Workforce over time

- Monthly joins and departures as bars, with turnover as a line.
- Selecting a month shows the calculation and a list of the people counted.
- **Turnover = departures during the month ÷ roster at the start of that month.**
- Join date is the earliest retained Wise account-join date for that person, including people awaiting their first class.
- Count a departure only for a sheet-marked person after their last actually taught class and after remaining future classes are cleared. Cancelled classes and student no-shows do not extend the last day. People still scheduled are pending departures.
- Keep departure status separate from any owner-operated removal controls. Analytics does not remove people or change Wise.
- Historical opening rosters are labelled **reconstructed Wise rosters**. Show missing dates, unmatched identities and the possibility of accounts removed before collection began. Do not present this as an exhaustive HR record.

## 2. Subject supply and demand

### Monthly comparison

Subjects are rows and months are columns. Start with broad subjects; expand into curriculum and level. Supply and demand have separate metric selectors and clear units.

**Supply measures**

- Qualified people.
- Offered hours before leave.
- Usable hours after approved leave.
- Remaining shared hours after blocking bookings.

**Demand measures**

- Unique students.
- Student bookings.
- Distinct classes.
- Booked teaching hours.

Booked demand includes cancelled bookings and student no-shows, with a visible status breakdown. Count by scheduled class date in Bangkok time. A one-hour class with five students contributes five student bookings, one class and one tutor-hour. A student taking two subjects appears in each subject but once in the overall unique-student total.

### Time-of-day view

Selecting a month reveals weekday/time-of-day heat maps for supply and demand. Use 30-minute display buckets with exact interval overlap, rather than rounding classes to whole buckets. Default to an average week for comparing months of different lengths; tooltips show the monthly total and number of covered dates. Keep color scales consistent when comparing months. A cell opens the contributing tutors and classes; unknown values remain visibly different from zero.

### Shared capacity

A tutor who offers eight hours and teaches Maths and Physics has eight hours in one shared pool. A one-hour Physics booking leaves seven hours eligible for either subject. Subject rows can each show those seven hours; the overall total remains seven.

Show the selected subject's classes, commitments to other subjects, and remaining eligible time in drilldowns. Do not add subject supply rows together. Do not label booked demand minus remaining free time as an unmet-demand or shortage figure.

### Academic subject quality

Wise pricing/year bands are not academic subjects. Use a reviewed mapping from actual courses/classes to the subject hierarchy. Keep unmapped and ambiguous classes visible with their hours; do not guess a class subject from its tutor's qualifications.

## 3. Tutor utilization

Show a sortable tutor comparison and a detail drawer with monthly trends and the selected week's schedule. Include role, usable offered hours, bookings, credit-consumed hours, teaching records, remaining shared hours and data coverage.

**Capacity denominator:** offered hours minus approved leave. Also show original offered hours and leave hours.

**Consumed time:** scale the scheduled class duration by net credits deducted as a fraction of the normal credit charge. A one-hour class charged half its normal credits contributes half an hour; a full refund contributes zero. For a group class, use the arithmetic mean of the charged fractions across its booked students, then multiply by scheduled duration. One full charge and one half charge in a one-hour class means 0.75 credit-consumed tutor-hours. Credit amount is per student and must not be summed directly into tutor hours.

For each booked student, the fraction is **net credits deducted ÷ normal credits for that student's class**. A missing credit record or unknown normal charge is not the same as a confirmed zero charge. Reconcile refunds and flag unexplained charges above the expected amount before including them. Do not silently substitute today's price for a historical expected charge.

**Consumed utilization:** credit-consumed tutor-hours divided by usable availability. Include hours outside the tutor's declared availability. Rates may exceed 100%; flag outside-hours work and overlapping bookings. A zero or unknown denominator displays an unavailable rate with its reason. Keep booked utilization and recorded teaching comparisons alongside it.

The supporting **reserved utilization** is non-cancelled scheduled tutor-hours divided by usable availability. **Recorded teaching utilization** is the duration of classes established as taught under the rule below, divided by usable availability. Cancelled volume remains in demand and any verified charged portion remains in consumed hours. These are different measures and must have distinct labels.

Keep future reserved time, time counted through credit deductions, and recorded teaching separate. A cancelled booking releases future availability even when it remains part of demand or has a credit charge. A free class can occupy a tutor's time while contributing zero credit-consumed hours.

**Recorded teaching:** use direct teaching evidence when available. Where it is missing, use Wise's ended status plus credit consumption, excluding known cancellations and no-shows. This user-approved fallback applies to recorded teaching hours and final-class departure dates. Use scheduled duration where actual duration is unavailable and label the measure as based on recorded class data, not measured teaching time. Unresolved status or credit evidence remains visible. A credit refund does not erase teaching independently established by direct evidence.

Selected online classes have participant-presence evidence; this is not a universal attendance ledger. Recording length or an office attendance punch alone does not establish that a class was taught, and aggregate participant durations do not prove exact overlapping teaching minutes.

## Historical coverage

**Owner-confirmed credit rule, 1 October 2026:** one Wise credit always represents one scheduled teaching hour, including historical and group bookings. The normal per-student charge is therefore scheduled minutes divided by 60. Record this business-rule provenance separately from verification of the actual net deduction. Missing net deductions or historical participants remain unknown.

- Show verified class and demand history from March. Validate that backfill pagination and dates cover the requested period.
- Do not estimate old availability using today's schedule. Historical capacity and utilization remain unavailable where offered-hours history is missing.
- For partial recorded periods, align utilization's numerator and denominator to the same supported time span and show its coverage. Never divide a full month's class hours by only a few days of recorded availability.
- Begin durable observations of availability, leave, qualifications and identity/role facts. Preserve source timestamps, data-quality issues and successful observation boundaries.
- Current qualifications cannot silently become historical subject supply.
- Historical class and credit figures reflect the latest verified source state, including refunds and corrections, rather than claiming to reproduce what an administrator saw at an earlier date. Show the data's observation time.
- One private baseline from the 1 October 15:30 Bangkok snapshot has been saved. Continuous capture is not yet deployed.
- Future capacity based on recurring schedules is a projection; it must be labelled separately from observed history.

## Delivery and verification

After the design and implementation plan are agreed, create the MagicPath design and review the main dashboard, expanded subject view and tutor detail. Match the existing BeGifted application styling and support smaller screens and keyboard use.

Use read-only Wise retrieval for source validation and backfill. Verify credit units, the expected charge, refunds and partial deductions before calculating consumed time. Ambiguous credit histories are a data-quality state, not a zero.

Validate the business rules with focused cases: month boundaries, linked accounts, pending departures, teaching admins, group classes, partial charges/refunds, overlapping subject capacity, leave, missing observations and rates above 100%. Compare exported totals with chart drilldowns. Review the working interface and verify the deployed revision before reporting it live.

## Acceptance examples

| Case | Expected result |
| --- | --- |
| September opens with 60 people; 3 leave and 2 join | Turnover 3 ÷ 60 = 5% |
| A marked tutor has future uncancelled classes | Pending; no completed departure yet |
| 8 offered hours, 2 hours leave, 3 credit-consumed hours | 6 usable hours; 50% consumed utilization |
| 8 usable hours, 10 consumed hours including outside-hours classes | 125% utilization, with the outside-hours explanation |
| One hour, one student charged half the normal credits | 0.5 credit-consumed tutor-hours |
| One hour, two students charged full and half respectively | 0.75 credit-consumed tutor-hours; one class, two student bookings |
| One hour, five students charged fully | One tutor-hour consumed; five student bookings |
| A full refund is verified | Zero credit-consumed hours; retain the booking in demand |
| A cancelled class still has a charge | Include in demand and credit consumption; do not block future free time or count as taught |
| One Maths/Physics tutor offers 8 hours and books 1 hour of Physics | 7 remaining shared hours for either subject; 7 overall, never 14 |
| March has classes but no retained availability | Show verified demand; capacity/utilization unavailable, not zero |

## Data implementation boundaries

- Extend the existing Wise sync with durable, versioned observations; do not retain history only in snapshot tables that are pruned.
- Retain canonical identity, account membership, qualifications, offered windows, leaves and source quality together. An availability-fetch error is not evidence of zero availability or lost qualifications.
- Retain lesson facts at session/tutor grain and student credit evidence at session/student grain. Preserve source IDs and observation timestamps for deduplication and correction.
- Add a reviewed class-to-academic-subject mapping, with explicit unmapped states.
- Keep existing page access rules and owner-only removal controls intact. Analytics and its source collection make no Wise mutations.
- Show source timestamps, coverage and exceptional records through drilldowns. CSV exports use the selected filters and the same calculation results as the charts.

## Existing implementation references

- `src/lib/sync/snapshot-pruning.ts`: current rolling snapshot retention.
- `src/lib/wise/fetchers.ts`: teacher and availability GET contracts.
- `src/lib/tutor-onboarding/planner.ts` and `roster-facts.ts`: durable identities, account status and current join/role facts.
- `src/lib/tutor-offboarding/analytics-db.ts`: existing analytics data loading.
- `src/lib/credit-control/wise.ts` and `sync.ts`: historical session and per-student credit-history retrieval.
- `src/lib/progress-tests/workspace/attendance.ts`: existing current-credit reconciliation behavior.
- `src/lib/feedback-autowriter/session.ts`: selective online participation evidence.

These are discovery anchors, not proof of complete historical coverage. The implementation plan must verify the source contracts required by each calculation.
