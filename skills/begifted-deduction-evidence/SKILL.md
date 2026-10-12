---
name: begifted-deduction-evidence
description: Check the exact tutor and class on Wise for post-class feedback deductions. Prepare class views before the deadline, capture fresh feedback screenshots after the deadline, and upload evidence to the Class Feedback dashboard. Use for a scheduled deadline check or a later check of an existing deduction.
---

# BeGifted Deduction Evidence

Use Asia/Bangkok for all dates and times. Use Computer Use for Wise and the dashboard. Use the signed-in Safari session. This workflow reads Wise and writes screenshot evidence to the dashboard. It does not submit feedback, change attendance or billing, approve deductions, or publish payouts.

Dashboard: https://bgscheduler.vercel.app/post-class-feedback/evidence
Wise: https://learn.begiftededucation.com/get-started

The class feedback deadline is 23:59:59.999 Bangkok on the second calendar day after the class end date. Read the stored deadline for each class. Do not apply Kevin's rolling 72-hour scope or select Kevin by default.

## Prepare at 23:30

1. Open the dashboard evidence page with `?date=YYYY-MM-DD` for tonight's Bangkok deadline date. Read the full queue of eligible classes. If access, loading, or coverage fails, report an incomplete check. Do not report zero classes after a failure.
2. Record each dashboard class id, Wise session id, exact tutor profile name and key, students, subject, start and end times, and deadline. The queue includes submitted classes because feedback can change before the deadline.
3. Use **Open this class in Wise** on each dashboard row. The dashboard uses the existing Wise link builder with the stored class and session ids. Confirm the full class identity after the link opens. If the link fails or the host is uncertain, use **Search students, sessions, tutors → Tutors** on Wise. Search for the tutor from the queue. Confirm the full profile name and the class host. Online and onsite aliases must belong to the same verified tutor. Do not select a similar name.
4. Use the tutor's **Sessions → Past** list. Match the exact students, subject, date, and start/end time. Check **View Profile → Preferences → Your Timezone** once; read the setting and do not change it.
5. Open one owned Safari tab or window per class. Use separate prepared views so pages can load in parallel. Keep the class identity visible with the tutor feedback state. In the exact class menu, use **Copy session link**. Save the link with the class identity. Open it in a separate tab and confirm the full class match before you use it. Keep the original copied `/links?...` address; the final address can lose the session id. If the copied link fails, use the tutor search and exact class match. Use the dashboard link or the verified copied link. Do not invent a class or session id.
6. Save the queue, verified copied class links, and the prepared tab/window identities under this chat's `work/deduction-evidence/YYYY-MM-DD/`. Do not store cookies, tokens, or fixed accessibility element indices. Record any class that could not be prepared.
7. End the preparation run. Do not wait in an active tool call until midnight. Leave only the owned prepared views open. The capture automation is a separate run.

## Capture from 00:00 to 00:15

1. Use the previous Bangkok date as the deadline date. Read the dashboard queue again. Add new classes, identify changed deadlines, and exclude classes that are no longer eligible from this deadline run.
2. Read fresh Computer Use state to identify the prepared views. Refresh each class view after the deadline. If refresh closes a dialog, open the verified original copied class link again. Confirm the full class match and current feedback state. If that link fails or shows a different class, reopen the exact tutor and class through search. An already-open tab is not proof of current data.
3. Check the full **TUTOR FEEDBACK** state. Use `missing` only if the class confirms pending or no submitted tutor comment. Use `present` for submitted tutor feedback. Use `uncheckable` if identity, access, or feedback state is uncertain. Student feedback and zero attendance do not prove tutor feedback.
4. Record the actual observation time and capture time. Capture the class identity and feedback state together. If they need two views, capture both with their own times and explain the shared class identity. Do not submit a local draft or replace comments.
5. Use the Computer Use screenshot method for the selected view. Save the returned image bytes as an unchanged PNG or JPEG under this run's `work/` folder. Do not substitute a screenshot of the dashboard for Wise evidence. Do not alter pixels or add a false timestamp.
6. Prioritize all class captures before uploading. Stop deadline captures at 00:15. A later image is late evidence. Classes not checked within the window have missing deadline evidence; this does not prove missing feedback.
7. Upload the images after the captures, within one hour of capture. On the evidence page, open **Add screenshot or failed-check result** for the exact class. Select **Deadline capture**, set the observed state, enter the actual Bangkok observation/capture times, select the matching image, and save. If no image was possible, use **Cannot check** with a clear failure note.
8. Reopen **Open screenshot** on the saved row. Confirm the actual image, class binding, timestamps, and upload result. An upload response alone does not prove that the image can be read. Retry a failed upload with the same image and metadata. Inspect the existing result before retrying an uncertain save.
9. Read any staff-event conflict, submission-during-capture warning, or changed-deadline notice. A non-automatic TEACHER or ADMIN event can conflict with a missing-feedback observation. Student, automatic, and unidentified events cannot prove staff submission. A staff event between observation and capture can show a state change during capture. Keep the screenshot and event records separate. Do not change the deduction to resolve a conflict.
10. Report total due classes, checked classes, missing/present/uncheckable states, late captures, failed uploads, and conflicts. Stay quiet after a complete run with no problem. Report access failures, missing coverage, late captures, conflicts, or failed uploads here.

## Later check of an existing deduction

Open `https://bgscheduler.vercel.app/post-class-feedback/evidence?sessionId=THE_DASHBOARD_CLASS_ID`. Match the exact class on Wise, refresh it, inspect tutor feedback, and capture the current view. Select **Later check** and use the actual times. Do not label an old class's current view as deadline evidence. The image cannot establish its earlier state.

## Dashboard contract and report

- `GET /api/post-class-feedback/captures?date=YYYY-MM-DD`: viewer access; complete due-class queue.
- `GET /api/post-class-feedback/captures?sessionId=UUID`: viewer access; exact class binding and capture history.
- `POST /api/post-class-feedback/captures`: reviewer access and same origin; multipart fields `sessionId`, JSON `metadata`, and optional `image`. Metadata uses the queue binding plus `mode`, `state`, `observedAt`, `capturedAt`, and `note`. Times are ISO UTC strings. An image is required for a checked state; a failed check requires a note.
- Private images are PNG or JPEG, maximum 4 MB. Ready images have an authenticated preview link. Missing, failed, late, and conflicting evidence remain visible.
- The server sends the previous Bangkok day's new `candidate_created` records at 08:00. Recipients are Kevin (`kevhsh7@gmail.com`), Aya (`pakwalaan@gmail.com`), and `k.waritpariya@gmail.com`. It retains changed statuses and separates pending amounts from confirmed deductions. The skill does not send a duplicate report.

## Limits

The Mac must be available, with valid Wise and dashboard sessions. Refresh and capture actions remain controlled one at a time, even when prepared pages load in parallel. Record actual times; do not claim simultaneous or exact-deadline captures. The dashboard stores evidence only. No screenshot changes approval or payout rules. Report missing evidence without attributing fault to a tutor.
