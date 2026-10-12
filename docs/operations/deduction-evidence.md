# Daily deductions and Wise evidence

## Setup

Apply migration `0115_deduction_evidence.sql` before the code reaches production. It adds one notification kind and one evidence table. It does not change financial rows. Use the existing private Blob store and outbound sender. Do not create new access grants for the email recipients.

Install `skills/begifted-deduction-evidence` under the operator's Codex skills directory. Its format check must pass. Keep the Kevin daily-feedback skill and automation unchanged.

The two Mac heartbeat jobs are **Prepare Wise deduction evidence** at 23:30 and **Capture Wise deduction evidence** at 00:00 Bangkok. Keep both paused until a real Wise multi-view test and image upload/read-back pass. The report server cron is `0 1 * * *` UTC, which is 08:00 Bangkok. It runs in production after deployment.

## Pilot and release

1. Run the report, timing, access, upload, retry, and real-Postgres tests. Run the source type check, build, and production route guard. Review the change.
2. Verify the serving production commit and the applied migration.
3. Use a current-state pilot for an existing deduction. Open more than one exact class view in signed-in Safari. Refresh one view and verify that it gives fresh data, including after a dialog closes.
4. Save original Wise images with actual times. Upload them as **Later check**. Reopen each saved image. Check the private image path without viewer access. It must fail.
5. Run the report once deliberately. Verify each recipient's persisted provider receipt and frozen content. Repeat the same date and verify that no email is sent again. Do not describe provider acceptance as confirmed inbox delivery.
6. Enable the two Mac heartbeat jobs after the pilot passes. Verify their first scheduled preparation and midnight capture separately. A later manual pilot does not prove scheduled deadline execution.

## Failures

A missing or unavailable Mac leaves missing deadline evidence. An expired Wise or dashboard session is an incomplete check. Record the failure and report it here. Never substitute zero attendance, student feedback, a dashboard image, or a later screenshot for deadline proof.

A failed image upload retains a failure row. Retry the same file and metadata, then reopen the image. Identical concurrent uploads retain a ready result. An uncertain save requires inspection before retry.

For an uncertain email, inspect the sending mailbox and saved attempts. Do not reset the delivery to pending or change sender automatically. Known pre-acceptance rejections can retry. The shared retry worker uses the same strict staff sender as the first send. Report counts are updated under a run lock.

Pause the two heartbeat jobs to stop browser checks. To stop the report, remove only its cron schedule and redeploy. Keep evidence, report history, and financial records.
