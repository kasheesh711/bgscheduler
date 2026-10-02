# Tutor Attendance

**Status: implemented; new clocking requires explicit enablement.**

`/tutor-attendance` records full-time tutors' first clock-in and final clock-out at the
office or on an approved work-from-home (WFH) day. Enrollment is explicit.
The initial rollout is Tito, Ek, and Peat after their
identities, Google accounts, individual schedules and office connection are verified.

## Tutor flow

Sign in with the administrator-approved Google account, connect to office Wi-Fi, and tap
Clock in / Clock out. The server confirms a saved time. Normal lunch and short breaks stay
within the attendance span. History and correction requests work from any connection,
including while new clocking is disabled. A forgotten arrival does not prevent recording
a departure. Each Bangkok date starts independently; missing punches never create inferred
times or completed hours. Unscheduled office days can still be recorded.

### Working from home

In **WFH**, an enrolled tutor requests one whole Bangkok date (today or later) and gives
a reason. An attendance administrator approves or rejects it with a reason; enrolled
administrators need another administrator to review their own request. Pending, rejected
and cancelled requests do not permit remote clocking. Approval allows clocking from any
connection on that date using server-recorded times. It does not verify a physical home
address. The usual schedule, late/early rules, dated hour overrides and excused dates still
apply. Approval never creates attendance times or completed hours.

Tutors can cancel their own pending requests. Tutors or administrators can cancel approved
WFH before attendance is recorded and before the date passes, restoring office-only
clocking. Raw punches or approved time corrections lock the day's work location. There is
no mixed office/WFH day or retrospective WFH approval. All requests, review reasons and
cancellations remain in the audit history. Requests and reviews work while clocking is paused.

For office attendance, the network check establishes use of the approved office internet connection at each tap.
It does not continuously track presence, identify a Wi-Fi name, or establish who holds the
phone. Attendance spans include breaks and do not calculate payroll/worked hours.

## Administration

- **Today:** required tutors, recorded visits, exact times and late/early flags.
- **History:** tutor/date filters, original and effective times, completed spans and CSV.
- **Corrections:** tutor-proposed times and reasons; approval/rejection with reviewer and
  decision history. Approval retains raw punches. A changed record blocks stale approval.
  An enrolled administrator cannot approve their own request.
- **Setup:** explicit enrollment, individual weekly hours, date exceptions and networks.
- **WFH:** pending and future requests, approval/rejection, cancellation and decision history.
  Today, History and CSV identify each date as Office or WFH; CSV also includes the approval
  request ID. Future requests are visible without widening the history range.

Each tutor can use a separately approved Google email without changing delivery addresses
or gaining unrelated tutor tools. The underlying tutor contact and enrollment must remain
active. Administrators require fresh current admin status and attendance page permission.

Weekly schedules are versioned by effective date, with one same-day interval or no
requirement per weekday. The Mon–Thu 10:00–16:00 template requires confirmation. New
recurring versions begin today or later; dated overrides handle retrospective corrections,
replacement/extra hours and excused absence. Office closures take precedence over individual
hours. Removing an exception appends a reset version. Every change carries a reason.

No lateness grace period applies; positive partial late/early minutes round up. No clocking
evidence is labelled **No record**. Original punches, schedule versions, exceptions and
the audit trail remain available. No messages, Wise writes or payroll changes are made.

See [API and persistence](../reference/api/tutor-attendance.md) and the
[enablement runbook](../operations/tutor-attendance.md).
