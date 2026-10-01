# Course demand growth and capacity planning

Date: 1 October 2026. Extension to the approved [workforce analytics design](2026-10-01-tutor-workforce-analytics-design.md).

## Purpose

Show which subjects are gaining or losing demand, then project the extra weekly tutor availability needed over the next twelve months. Include the owner's subsequently approved hiring estimate by subject, curriculum and level; the owner makes the hiring decision. This feature changes no Wise bookings, student statuses, or tutor accounts.

Keep this view inside Tutor Offboarding → Analytics, alongside the workforce, subject coverage, and tutor utilization views. Reuse their Bangkok dates, academic subject mappings, evidence indicators, and export conventions.

## Selected approach

Use a transparent model driven by three months of observed demand flows. The owner can inspect the arithmetic and change assumptions.

| Approach | Benefit | Limit |
| --- | --- | --- |
| Three-month demand flows — selected | Connects new enrolments, churn, and cancellations directly to staffing needs | Assumes recent monthly flows continue |
| Flat demand | Useful comparison scenario | Does not model business growth |
| Seasonal/statistical forecast | Could capture annual patterns with enough history | The available history does not establish a complete annual cycle |

Show a flat-demand comparison. Do not invent seasonality or a statistical confidence interval.

## 1. New-course demand

The cohort key is **student × academic subject**. A new level or curriculum within an existing subject does not create a new cohort. Starting Physics after studying Maths does.

- Start at the student's first regular booking in that subject. Show trials and pretests separately; they do not start a regular-course cohort. Use recorded booking/course classification, not a zero-credit assumption, to identify trials.
- Owner-approved source rule: when Wise has no explicit lesson-purpose field, identify whole-word `trial` or `pretest`/`pre-test` markers in the title. Other academically mapped lessons count as regular; unmapped lessons remain for review. Conflicting explicit purpose/title evidence stays unresolved. Record this policy as owner-confirmed, and recalculate after an academic mapping changes.
- Sum that student's regular booked hours in the starting calendar month. Keep cancelled bookings and no-shows in gross booked demand, consistent with the existing dashboard.
- A student new to the business and an existing student starting a subject both contribute.
- Example: John starts Maths and books four hours; Evan already studies another subject and starts Maths with eight hours. New Maths demand is twelve **student-hours**.
- Retain the earliest cohort date across the available history when filters change. Filtering to September must not turn every September learner into a new enrolment.
- The history starts on 1 March 2026. Label first appearances **newly observed**. Exclude the March starting cohort from new-demand averages because it includes people already studying before collection began.
- Returning after a recorded churn event is a **reactivation**, shown separately from first-time new demand.

Show student counts, student-hours, and corresponding class/tutor-hours. A student joining an existing one-hour group adds one student-hour; the whole class still consumes one tutor-hour. Use the observed student-hour/tutor-hour mix when converting projected demand into tutor capacity, and show its source coverage.

## 2. Churn and lost demand

Apply the owner's rule to each student–subject pair: **60 days without a taught class and no future uncancelled booking in that subject**. A future Maths booking does not prevent a Physics departure. Use the same recorded-teaching rule as workforce analytics; cancelled classes and student no-shows do not reset the taught-class date.

After the rule is met, assign the loss to the month after the last taught class. Record both the effective month and the later confirmation date.

**Baseline example:** last taught class on 20 August → lost demand starts in September → average the student's booked subject hours in **May, June, and July**. Exclude August, their partly active final month, and exclude the sixty-day waiting period.

Divide the sum by three. A confirmed zero month counts as zero; unavailable history does not. Preserve missing baselines visibly rather than quietly using a smaller denominator.

Retain confirmed events so a later return creates a reactivation instead of erasing the past departure. Historical evidence may not establish what future bookings existed on an earlier date. Label such reconstructed events as inferred and preserve this limitation; a class gap alone must not masquerade as a verified historical no-booking check. Do not reuse Credit Control's balance-based inactive flag as subject churn.

### Cancellation losses

The owner confirmed that **one Wise credit always equals one scheduled teaching hour**, including group and historical bookings. Normal per-student credits are therefore scheduled minutes divided by sixty.

Show gross booked hours, net credit-consumed hours, and the hours lost to cancellation/refund separately. A one-hour cancelled booking charged at half its normal credits loses half a student-hour of credit demand. In a group, add student losses for student-hour reporting and use the mean charged fraction for tutor-hour reporting.

Keep credit-adjusted demand distinct from recorded teaching: a refunded lesson can still have been taught. Unknown net deductions or historical participants remain unknown.

Do not subtract the same loss twice. The recurring churn flow changes the size of the projected active demand base. The cancellation/refund adjustment applies to bookings in that projected base; it is not another recurring subtraction of the departed student's baseline every month on top of that flow.

## 3. Three-month averages and maturity

Use **the same older, fully observed three months** for new demand, reactivations, and churn in the forecast. A churn month is mature only after the latest possible last-class date for that loss month has passed the sixty-day confirmation period. Show the exact model window and the reason for its lag.

The dashboard can still show newer monthly observations, marked provisional where churn has not matured.

The simple mean is the sum of the three monthly values divided by three. The owner's example gives:

| Subject | Month 1 | Month 2 | Month 3 | Monthly mean |
| --- | ---: | ---: | ---: | ---: |
| Maths | 1 | 2 | 3 | 2 |
| Physics | 1 | 2 | 6 | 3 |
| Chemistry | 1 | 2 | 12 | 5 |

Source retrieval must cover every contributing month. Incomplete history, an unresolved subject, or an unavailable churn baseline must remain visible. Show known subtotals and missing-record counts. Do not call a two-month mean a three-month mean. If a required model input is unavailable, keep the corresponding automatic forecast unavailable until the owner enters an explicit assumption.

## 4. Twelve-month projection

The starting base is the last completed month's booked demand. For each subject, show this bridge:

1. Starting monthly booked student-hours.
2. Average monthly hours from newly observed subject starts.
3. Average monthly reactivated hours.
4. Average monthly recurring hours lost through churn.
5. Expected cancellation/refund loss, applied once.
6. Projected net demand and the corresponding tutor-hours.

Before cancellation adjustment, month `k` is:

`max(0, starting monthly demand + k × (average new + average reactivated − average churn loss))`.

Apply the observed cancellation/refund fraction to that projected booked demand to obtain the credit-adjusted series. Expose the fraction, its numerator/denominator, and the source window. This assumes first-month cohort hours represent a continuing monthly contribution; label that assumption and allow an override.

Display twelve monthly points beginning with the month after the base month. Label them as projections. Controls may override monthly additions, churn loss, cancellation/refund fraction, and group mix. Every override is visibly distinguished from a measured input. Reset restores the measured model. No automatic annual seasonality is applied.

Show already-booked future demand alongside the forecast. It is part of projected total demand, not an extra amount to add on top. A staffing requirement must still cover current uncancelled booking commitments when they exceed the model's estimate.

## 5. Extra weekly availability

Translate projected tutor-hours into an average week using the observed subject/weekday/time pattern, accounting for calendar occurrences. Compare with projected capacity from the latest recorded tutor availability, qualifications, and approved leave. Show when those source facts were observed and that future capacity assumes they continue.

Keep each tutor's availability as one shared pool. A Maths/Physics tutor's eight hours cannot satisfy eight Maths hours and eight Physics hours simultaneously. Allocate overlapping supply once when calculating the overall gap; explain allocation assumptions in subject-level results. Unmapped subjects or unknown availability cannot create an assumed zero gap.

Show:

- Extra usable tutor-hours required per average week, by subject and time window.
- The shared overall gap, calculated independently rather than by summing overlapping subject rows.
- A minimum requirement with a **0% buffer** initially, plus an optional editable spare-capacity buffer. Define a 20% buffer as twenty percent extra availability above the minimum, so it is not confused with an 80% utilization target.

### Hiring estimate — approved addition, 1 October

Break demand and shortages down by subject, curriculum and level. Cohort identity remains student × subject: changing level does not create new subject demand. Attribute booked hours to their recorded course dimensions; distribute churn baseline hours across the course dimensions present in its three baseline months. Do not invent future level promotions.

For each course dimension, use the arithmetic mean of offered weekly availability from all current qualified tutors and teaching administrators, including people awaiting their first assigned class. Exclude anyone marked for departure and anyone with unknown availability. Include known zero schedules and show eligible/known counts and observation dates.

The benchmark for a new hire is the average offered time that overlaps that course's forecast shortage windows. Show the full offered average alongside it. Example: comparable tutors offer eight hours weekly but only three at shortage times; use three in the hiring calculation and display both. Current bookings and individual leave do not reduce this offered-time benchmark for a prospective new hire; they already affect the existing workforce's shortage.

For each projected month, show `extra weekly hours / average matching offered weekly hours`, both as fractional tutor equivalents and rounded up to whole hires. Apply the optional buffer to the hours before converting. If the matching average is zero or unavailable, show that a tutor offering different hours is needed and leave the numeric estimate unavailable. Show the benchmark sample size; estimates based on a small or incomplete sample remain visibly limited.

Calculate the shortage using shared capacity first. Course-level estimates overlap and must not be added into an overall hiring total. This is a planning estimate, not an automatic recruitment or employment decision.

## Interface and evidence

Add a Growth view with a monthly new/lost-demand chart, a three-month average table, a twelve-month booked/credit-adjusted forecast, and a subject/time coverage-gap heat map. Link each source month to the contributing students/bookings and each override to its measured default. Provide matching CSV exports with dates, units, completeness, and assumptions.

Use the existing authenticated admin boundary. Store analytics lifecycle/observation records locally in the application's database. Any source collection is GET-only toward Wise. Preserve the existing offboarding/removal controls and permissions.

## Acceptance checks

- Reproduce the three-subject averages above and John's/Evan's twelve Maths student-hours.
- Moving a student to a higher level does not create new subject demand; returning after churn creates reactivation.
- A trial followed by a regular course starts the regular cohort on the regular booking.
- A future subject booking prevents current churn; an unrelated subject booking does not.
- An August final class uses May–July for its baseline and assigns loss to September only after sixty days.
- The model uses the same mature three-month window for additions and losses; recent provisional months cannot silently enter it.
- A half-charged one-hour cancellation loses half an hour. Refund/cancellation losses are not subtracted twice.
- Group student-hours and tutor-hours remain distinct; shared multi-subject supply is allocated only once.
- Incomplete baselines and unknown source fields remain visible in tables, charts, detail, and exports.
- All twelve projected months reconcile to the displayed formula and assumptions. No Wise writes or removals occur.
