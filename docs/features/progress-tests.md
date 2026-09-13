# Progress Tests

**Status: tutor workspace — one-to-one release.** Tutors prepare, administer, grade and publish their own topic tests within ordinary teaching sessions. Group courses are deferred. [Rollout evidence and recovery](../operations/progress-tests-workspace.md) · [API](../reference/api/progress-tests-workspace.md) · [Legacy history](progress-tests-legacy.md).

## Tutor workflow

My students shows separate student × course × verified tutor counters. The launch timestamp starts every counter at zero. A reminder follows six qualifying classes, the tutor explains the topics in class seven, and gives the test within class eight. Tests remain due at 8, 16, 24 and onward even when an earlier test is late. Only ended sessions with positive student-credit consumption count, including the test lesson. Existing teaching sessions are used; this feature never creates Wise sessions.

Test library accepts PDF/DOCX papers and marking keys. Tutors review editable questions, topics, marks and rubrics, preview the formatted paper and mark a version ready. Preparation records topics and whether the student was informed. Grading queue accepts PDF/JPG/PNG responses and their page order, tied to the actual administered class. AI suggests marks against the approved rubric; uncertain responses require tutor review. Code calculates the total. The separate report uses reviewed marks, the same tutor's verified cycle feedback and earlier approved reports. Missing context is explicit.

Tutors edit marks and report text, inspect both PDFs and choose **Approve and publish**. Native Wise Content files go into the verified student's one-to-one course under **Progress Tests**. Only the graded test and progress report are published. Original uploads and keys remain private. Corrections create new labelled versions, retaining previous PDFs. History shows separate publication checkpoints and recovery actions.

## Access and practice

Every request freshly resolves active account/contact ownership. Tutors see only their own series, papers, jobs and files. Authorized admins can filter tutors and review unknown course types, unresolved identities, overdue work and failed publication. Unknown/group course types cannot grant workspace access through a series. Manual sync is admin-only.

Every account receives a first-use welcome. **Help / Practise** remains available and does not replace mounted real forms. Eight interactive steps reuse the real editors with a local sample adapter; admins get a ninth oversight/pause step. Sample uploads, AI, previews and publication stay local. Only guide version, status, last step and revision are stored per account. Skip, resume and replay work across devices. The sample banner remains visible throughout.

## Persistence and processing

Additive migrations **0084** and **0085** preserve legacy tables. Immutable launch, papers, submissions, reviews and attendance evidence are enforced in PostgreSQL. Mutable commands check expected revisions; jobs use leases and bounded retries. Approved publication jobs reference immutable reviews independently of subsequent drafts.

After launch, the existing half-hour sync reads Wise sessions and per-student credit history directly; it no longer waits for the retired Credit Control dashboard's daily snapshot. Active Wise identity groups resolve instructors by verified IDs. Source corrections update counts and retain evidence/obligations. No unresolved instructor grants tutor access. The once-per-minute processing cron recovers document and publication work after browser closure. Reminders reuse the email relay with per-cycle idempotency; the daily admin digest summarizes current obligations.

## Operations

`PROGRESS_TEST_WORKSPACE_ENABLED` controls the workspace/processor. The immutable launch row permanently retires legacy mutations and behavior. Turning the feature off after cutover shows a paused surface, never the old workflow. A separate admin **Pause publishing** setting preserves counters, drafts, approvals and queued work while preventing external writes. Resume reuses saved checkpoints. Uncertain attachment outcomes require reconciliation or admin review; non-idempotent attachment requests are never blindly retried.
