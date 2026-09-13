# Progress Tests launch and recovery

## Release scope

One-to-one courses only. The release combines the tutor workspace, native Wise publication, private documents, durable processing and account-scoped guided practice. Groups and unknown course types cannot produce counts, reminders or publication. Existing uncommitted work was preserved in the original checkout; the release branch starts from current production `origin/main` (`295db668`). Unpublished migrations are **0084** (workspace) and **0085** (publication/guide), after production's existing 0082/0083.

## Native Wise contract — verified 2026-09-13

The [published Wise collection](https://documenter.getpostman.com/view/17903053/2sA3XPChyE) and [GitBook](https://wise-app.gitbook.io/wise-app) do not fully document binary upload. The signed-in Content interface and its loaded client bundle established the sequence, subsequently verified with the existing server integration credentials. Browser credentials were not extracted.

1. GET `/user/v2/classes/{classId}?full=true`: require exact course, `ONE_TO_ONE`, exactly the expected joined student, no archive/hide/suspension/open-classroom/access locks.
2. GET `/user/classes/{classId}/contentTimeline?showSequentialLearningDisabledSections=true`: require unrestricted drip/sequential settings and an enabled Progress Tests section. Find/create the top-level section once via POST `/teacher/classes/{classId}/sections` with `{name:"Progress Tests"}`.
3. GET `/user/uploadURL?filename=...&type=application/pdf&size=...`: returns `data.uploadURL` and `data.uploadToken`. Observed authorization expires in 300 seconds. The token's own lifetime is not a vendor guarantee.
4. PUT exact PDF bytes with PDF Content-Type to the returned S3 URL, **without Wise authentication headers**.
5. POST `/teacher/createResourceInBulk` with `{classId,sectionId,resources:[{name,uploadTokens:[token],type:"file"}]}`.
6. Read Content back; match unique deterministic filename/resource ID, course and native file metadata. Wise reports `file.type: "pdf"`. Download its bytes and compare SHA-256 to the immutable approved artifact. Complete only when both documents verify.

Allowlisted hosts are the observed `wise-app-s3-bucket.s3.ap-south-1.amazonaws.com` upload host and `files.wiseapp.live` readback host. Redirects are rejected. Non-idempotent Wise POSTs have automatic retries disabled. Files are capped at 25 MB. No external-link substitution or separate test-session creation exists.

Destination bindings persist expected student and section. Each document persists filename, artifact/hash, attempts, Wise resource/file IDs, verification time and error. Upload authorization is ephemeral. Intent is saved before an attachment or section creation. A lost response reconciles remote state before retry; an ambiguous/missing uncertain outcome enters admin review rather than repeating the write. Completed documents survive a partial failure. Approved jobs are bound to immutable reviews, independent of newer draft edits. Original sources and marking keys are never published.

## Live validation evidence

The user-authorized one-to-one course `6990f14e2f5bc252039abf3b` with expected student `696e2a2043579bbada1ff78f` was used for labelled technical PDFs only. No student answers, grades or report content were published. The adapter created/reused Progress Tests section `6aa6843f7239362dd4959a26`.

- Two native PDFs verified byte-for-byte, followed by a clearly labelled revised pair; all four remained available.
- A successful attachment with an initially rejected metadata interpretation was reconciled from its persisted checkpoint without duplication, then the unfinished report resumed.
- One-to-one membership, intended student inclusion, enabled section and unrestricted Content settings passed fresh reads. **A separate student-account login was not available**; visibility evidence is the course membership and Content access contract, not a claimed student-session screenshot.
- Private validation Blob storage round-trip passed. Separate private sin1 stores were provisioned for production and validation.
- Live OpenAI `gpt-5.4-mini` extracted a sample PDF/key, awarded the expected partial-credit 4/5 and generated a separate report with explicit absent-feedback limitations.
- Fresh Wise attendance preflight passed independently of the daily shared snapshot; 2,544 source rows were read, with zero post-launch completed classes for a launch-at-now preflight. Unknown types remain excluded for admin review.
- Fourteen synthetic PDF pages were rendered and visually inspected: five formatted paper pages, six graded pages with original responses/diagram retained, one report, two DOCX conversion pages. No clipping or missing source-page sentinels.

Operator scripts under `scripts/verify-progress-*` require an explicit local `*_test` database where applicable. The live native test additionally requires `--live-wise`, explicit course/student IDs and a credentials environment file. Credentials, signed URLs and private source URLs are never logged. Detailed synthetic evidence remains in ignored `output/progress-tests-verification/`.

## Files, AI and guide

PDF/DOCX papers and keys; PDF/JPG/PNG responses; page ordering/preview before processing. DOCX uses docx-preview in network-isolated Chromium. Unsupported equations, drawings, charts, active content or tracked changes require a PDF exported from Word; conversion never silently discards them. Visual inputs and all prompt/model/input/review references are preserved. Marks are calculated in code and feedback cannot affect numerical grading. Manual editing remains available when AI fails.

The first-use guide uses actual workspace editors with an isolated local data adapter. Practice IDs are invalid for real mutation schemas. It cannot trigger upload, AI, reminders, attendance or Wise operations. Only guide version/status/step/revision persist against the authenticated account. Real mounted forms remain untouched when Help opens or closes.

## Rollout and recovery

1. Run complete release verification, integration checks, lint, browser practice and PDF inspection on the isolated release branch. Provision separate private Blob stores and the feature-specific OpenAI credential. Keep workflow/publishing disabled.
2. Apply additive 0084/0085 migrations to production. Push/merge the reviewed release; deploy clean `main` exactly matching `origin/main`, preserving the production route guard.
3. Verify deployed routes/configuration and worker health. Record validated integration time in `pt_workspace_settings.verified_at`. Enable the workspace, then use the admin activation transaction to insert the immutable launch timestamp and enable publishing. Repeated activation is idempotent and does not resume a paused publisher.
4. Verify live first-use guide, authenticated downloads, independent synchronization and worker recovery. There must be no pre-launch counts. Legacy mutations return 410 after cutover.
5. For a publication incident use the admin **Pause publishing** control. Counters, submissions, approvals and queued work remain. Resume reconciles checkpoints. Never reset or backdate launch. If disabling the workspace environment flag is necessary, retain a compatible post-cutover deployment; legacy behavior must not return.

The publication pause is database-backed and independent of the environment flag. Fresh account/contact access and the active worker lease are checked before every external write. Sources remain in private Blob and authenticated application routes. Forged callbacks fail SDK signature validation.

## Verification results

Disposable PostgreSQL integration: 18 tests passed, including ownership revocation, group exclusion, fixed cycles/corrections, reviewed versions, partial failures, uncertain attachment reconciliation, pause/resume and account-scoped guide revisions. Full unit suite: 438 files / 4,986 tests passed. Complete release verification and production checks are recorded below when the deployment finishes.

Local release verification completed: typecheck, 438 unit files / 4,986 tests, production build, post-build typecheck, diff checks and preservation of all 254 existing source route entries. Full ESLint completed with zero errors (19 existing warnings). Guide browser checks passed all sample actions, account persistence/replay, light/dark phone layouts, keyboard focus and preservation of an unsaved real paper draft.
