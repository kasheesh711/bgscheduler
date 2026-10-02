# Office attendance enablement and verification

## Release

1. Apply additive migration `0088_tutor_office_attendance.sql` before deploying code
   that resolves attendance login bindings. The migration enrolls nobody.
2. Deploy with `TUTOR_ATTENDANCE_ENABLED` absent or `false`. Full-access admins and
   admins with `/tutor-attendance` permission can configure Setup.
3. Verify Tito, Ek and Peat's current active tutor identities and Google sign-in accounts.
   Ek's repository seed contacts use Hotmail: confirm his actual Google account.
4. Save each enrollment date and individually confirmed schedule. The Mon–Thu 10:00–16:00
   template is not automatic. Add agreed date exceptions and office closures.
5. From actual office Wi-Fi, inspect the detected public address. Confirm that it belongs
   to the office and whether it changes. Register the office's IPv4 address(es) and verified
   IPv6 prefix if applicable. Do not register a shared ISP range, VPN, or private router IP.
6. Verify recognized/unrecognized status on representative phones using office Wi-Fi versus
   mobile data. A public address shared outside the office cannot establish exclusive office
   access; resolve that before relying on it for clocking.
7. Set `TUTOR_ATTENDANCE_ENABLED=true` for the intended deployment and redeploy. Verify each
   initial tutor's real Google sign-in and authorized arrival/departure.

The network guard trusts only `x-vercel-forwarded-for` with Vercel's `VERCEL=1` environment.
No arbitrary forwarded-header or local-development fallback exists. Deploy directly behind
Vercel ingress; proxies/VPNs change the observed connection. Phone VPN/privacy-relay routing
may prevent recognition of legitimate office traffic.

## Acceptance

- Office Wi-Fi accepts new punches; mobile data/home internet rejects them unless the
  tutor has approved WFH for that Bangkok date.
- Duplicate taps and lost-response retries keep the first saved time.
- Tutors cannot choose another identity or read another person's records.
- Missing departure remains incomplete next day; no time/duration is invented.
- Offsite correction requests work. Approval preserves raw punches; stale approval fails.
- New schedules preserve historical dates; dated exceptions retain their reasons/history.
- Mobile controls and both themes work; history and CSV agree on flags and complete spans.

## WFH rollout

Apply additive migration `0093_tutor_attendance_wfh.sql` before deploying the WFH code.
It preserves all existing dates as office attendance and approves nobody automatically.
The existing `TUTOR_ATTENDANCE_ENABLED` switch controls both office and WFH punches.

Verify a tutor requests a date from home, sees pending status, and cannot clock remotely.
An attendance administrator must approve it; after refresh the tutor can clock in/out from
home and sees WFH in Today and History. Confirm CSV carries WFH and the request ID.
Cancellation before the first punch restores office-only clocking. After any punch or
approved time correction, cancellation and location changes must fail. Check rejection,
duplicate submission, self-approval denial and the next day's independent office restriction.

Rollback to the previous code pauses remote WFH punches; keep the additive schema and
history intact. The shared clocking switch can pause all new punches while requests,
reviews, history and corrections remain available.

## Recovery

Confirm and replace a changed office IP in Setup, removing obsolete entries. During outages,
tutors submit corrections when service returns; device/offline timestamps are not trusted
punch evidence. Reject stale correction requests so tutors can resubmit against current times.

Deactivate enrollment/contact to revoke access. Deactivation closes open-ended enrollment
on today's date while retaining history. To pause new punches, set
`TUTOR_ATTENDANCE_ENABLED=false` and redeploy; setup, history and review continue.
Keep the additive schema and evidence intact.

Browser checks with sample accounts and a simulated ingress address do not verify the
physical office connection or a real tutor's Google login. No outbound messages, Wise writes,
pay calculations or automatic leave synchronization are part of this feature.
