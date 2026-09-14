# Progress Tests

**Status: tutor workspace — one-to-one release.** Tutors prepare, administer, grade and publish their own topic tests within ordinary teaching sessions. Group courses are deferred. [Rollout evidence and recovery](../operations/progress-tests-workspace.md) · [API](../reference/api/progress-tests-workspace.md) · [Legacy history](progress-tests-legacy.md).

The workspace uses a compact BeGifted title bar, tabs and one filter/action toolbar. Summary cards and the large banner have been removed. Assessments show their paper controls beside the PDF on desktop, with a Details/PDF switch on phones; feedback and history are collapsed.

## Tutor workflow

My students shows separate student × course × verified tutor counters. The launch timestamp starts every counter at zero. A reminder follows six qualifying classes, the tutor explains the topics in class seven, and gives the test within class eight. Tests remain due at 8, 16, 24 and onward even when an earlier test is late. Only ended sessions with positive student-credit consumption count, including the test lesson. Existing teaching sessions are used; this feature never creates Wise sessions.

Prepare and Test library default to **Use my uploaded paper**. PDFs keep their exact bytes; DOCX uses visual PDF conversion and requests a Word PDF export when content cannot be preserved. Tutors can preview, download and mark an original ready without AI, a key or a rubric. Optional marking keys stay private.

**Format with BeGifted — Beta** is enabled by explicit tutor opt-in. It formats the uploaded questions using `gpt-6-astra` with `low` reasoning effort; it never authors new questions. The job records the exact original version, hashes, model, effort and prompt. Originals remain usable and replaceable while formatting runs or fails. A completed branded PDF is a separate draft: tutors must review and adopt it. Private rubric approval is separate and required for AI grading. Missing marks or rubric information blocks AI grading while original/manual use remains available.

**Upload to Wise** saves revision topics and whether the student was informed, then immediately queues the selected reviewed paper PDF into the course’s **Content → Progress Tests** section. Status and retry actions appear beside the preparation controls. **Replace** uploads and verifies the replacement before withdrawing the previous app-managed paper; **Remove** clears only this assessment’s selection and Wise attachment, preserving topics, library versions and local history. Submitted assessments keep their paper. Grading queue accepts PDF/JPG/PNG responses and their page order, tied to the actual administered class. Original-paper assessments use a tutor-uploaded marked PDF, earned/possible marks and an editable report. Structured papers retain question-based grading and also offer marked-PDF recovery. Code validates the entered score and computes the percentage. Reports use saved results and verified tutor feedback where available; missing context is explicit.

Tutors edit marks and report text, inspect both PDFs, confirm that the entered score matches the marked paper and choose **Approve and publish**. A marked-PDF review preserves the uploaded marked PDF bytes exactly; report text and every paper/submission/file reference are frozen in that review. Native Wise Content files go into the verified student's one-to-one course under **Progress Tests**. Final-result approval publishes the graded test and progress report separately from preparation. Original student responses and marking keys remain private. Corrections create new labelled versions, retaining previous PDFs. History shows separate publication checkpoints and recovery actions.

## Access

Every request freshly resolves active account/contact ownership. Tutors see only their own series, papers, jobs and files. Authorized admins can filter tutors and review unknown course types, unresolved identities, overdue work and failed publication. Unknown/group course types cannot grant workspace access through a series. Manual sync is admin-only.

The previous onboarding and Help / Practise interface are removed. Its authenticated API returns 410; historical account guide records remain stored.

## Persistence and processing

Additive migrations **0084–0086** preserve legacy tables. Paper PDFs are bound directly to immutable content versions; readiness is a separate immutable approval and does not invalidate the preview. Immutable launch, papers, submissions, reviews and attendance evidence are enforced in PostgreSQL. Mutable commands check expected revisions; jobs use leases and bounded retries. Approved publication jobs reference immutable reviews independently of subsequent drafts.

After launch, the existing half-hour sync reads Wise sessions and per-student credit history directly; it no longer waits for the retired Credit Control dashboard's daily snapshot. Active Wise identity groups resolve instructors by verified IDs. Source corrections update counts and retain evidence/obligations. No unresolved instructor grants tutor access. New jobs dispatch immediately by ID. The once-per-minute processing cron recovers document and publication work after browser closure. Formatting has a 180-second request timeout within the 300-second worker. Stages defer when insufficient invocation or lease time remains. Successful extraction is saved before rendering, and renderer retries reuse it. Interrupted requests, timeouts and exhausted credits require an explicit retry; no model is automatically substituted. Reminders reuse the email relay with per-cycle idempotency; the daily admin digest summarizes current obligations.

## Operations

`PROGRESS_TEST_WORKSPACE_ENABLED` controls the workspace/processor. The immutable launch row permanently retires legacy mutations and behavior. Turning the feature off after cutover shows a paused surface, never the old workflow. Independent admin **Pause formatting** and **Pause publishing** settings preserves counters, drafts, approvals and queued work while preventing external writes. Resume reuses saved checkpoints. Uncertain attachment outcomes require reconciliation or admin review; non-idempotent attachment requests are never blindly retried.

## Paper progress and preview

Uploads show their actual transferred percentage. Persisted stages are Queued, Reading paper, Formatting, Building PDF, Checking and Ready. Job details expose elapsed time, retry state and estimates only when comparable timing evidence exists. PDF.js fetches private authenticated bytes and provides page navigation, zoom and download. Completed PDFs appear automatically; polling preserves unsaved preparation, marks and report text.

BeGifted 3.1 A4 documents use local brand fonts, logos and colors, KaTeX mathematics, tables and source illustration crops beside their questions. The internal question structure is not editable. The format contract includes explicit subpart marks, source-measured working regions, original diagram crops and a page coverage ledger including continuations and blank working pages. Missing source content blocks adoption; incomplete marks or rubric data block AI grading. Saved-response replays validate rendering, not the live reliability of the revised AI prompt. Tutor review remains required.

A queued or paused preparation upload does not block submission or grading. Submission freezes the selected paper while its existing Wise job can finish; replacement and removal remain unavailable after submission.
