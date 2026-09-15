# Tutor Office Attendance

**Status: implemented; new clocking requires explicit enablement.**

`/tutor-attendance` records full-time tutors' first arrival and final departure at the
office. Enrollment is explicit. The initial rollout is Tito, Ek, and Peat after their
identities, Google accounts, individual schedules and office connection are verified.

## Tutor flow

Sign in with the administrator-approved Google account, connect to office Wi-Fi, and tap
Clock in / Clock out. The server confirms a saved time. Normal lunch and short breaks stay
within the attendance span. History and correction requests work from any connection,
including while new clocking is disabled. A forgotten arrival does not prevent recording
a departure. Each Bangkok date starts independently; missing punches never create inferred
times or completed hours. Unscheduled office days can still be recorded.

The network check establishes use of the approved office internet connection at each tap.
It does not continuously track presence, identify a Wi-Fi name, or establish who holds the
phone. Attendance spans include breaks and do not calculate payroll/worked hours.

## Administration

- **Today:** required tutors, recorded visits, exact times and late/early flags.
- **History:** tutor/date filters, original and effective times, completed spans and CSV.
- **Corrections:** tutor-proposed times and reasons; approval/rejection with reviewer and
  decision history. Approval retains raw punches. A changed record blocks stale approval.
  An enrolled administrator cannot approve their own request.
- **Setup:** explicit enrollment, individual weekly hours, date exceptions and networks.

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
