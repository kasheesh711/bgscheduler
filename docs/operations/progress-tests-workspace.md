# Progress Tests launch and recovery

## Original launch scope (historical)

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

## Original files, AI and guide (historical)

PDF/DOCX papers and keys; PDF/JPG/PNG responses; page ordering/preview before processing. DOCX uses docx-preview in network-isolated Chromium. Unsupported equations, drawings, charts, active content or tracked changes require a PDF exported from Word; conversion never silently discards them. Visual inputs and all prompt/model/input/review references are preserved. Marks are calculated in code and feedback cannot affect numerical grading. Manual editing remains available when AI fails.

The first-use guide uses actual workspace editors with an isolated local data adapter. Practice IDs are invalid for real mutation schemas. It cannot trigger upload, AI, reminders, attendance or Wise operations. Only guide version/status/step/revision persist against the authenticated account. Real mounted forms remain untouched when Help opens or closes.

## Original rollout and recovery (historical)

1. Run complete release verification, integration checks, lint, browser practice and PDF inspection on the isolated release branch. Provision separate private Blob stores and the feature-specific OpenAI credential. Keep workflow/publishing disabled.
2. Apply additive 0084/0085 migrations to production. Push/merge the reviewed release; deploy clean `main` exactly matching `origin/main`, preserving the production route guard.
3. Verify deployed routes/configuration and worker health. Record validated integration time in `pt_workspace_settings.verified_at`. Enable the workspace, then use the admin activation transaction to insert the immutable launch timestamp and enable publishing. Repeated activation is idempotent and does not resume a paused publisher.
4. Verify live first-use guide, authenticated downloads, independent synchronization and worker recovery. There must be no pre-launch counts. Legacy mutations return 410 after cutover.
5. For a publication incident use the admin **Pause publishing** control. Counters, submissions, approvals and queued work remain. Resume reconciles checkpoints. Never reset or backdate launch. If disabling the workspace environment flag is necessary, retain a compatible post-cutover deployment; legacy behavior must not return.

The publication pause is database-backed and independent of the environment flag. Fresh account/contact access and the active worker lease are checked before every external write. Sources remain in private Blob and authenticated application routes. Forged callbacks fail SDK signature validation.

## Verification results

Disposable PostgreSQL integration: 18 tests passed, including ownership revocation, group exclusion, fixed cycles/corrections, reviewed versions, partial failures, uncertain attachment reconciliation, pause/resume and account-scoped guide revisions. Full unit suite: 438 files / 4,986 tests passed. Complete release verification and production checks are recorded below.

Local release verification completed: typecheck, 438 unit files / 4,986 tests, production build, post-build typecheck, diff checks and preservation of all 254 existing source route entries. Full ESLint completed with zero errors (19 existing warnings). Guide browser checks passed all sample actions, account persistence/replay, light/dark phone layouts, keyboard focus and preservation of an unsaved real paper draft.

## Production launch — 2026-09-13

[Release PR #68](https://github.com/kasheesh711/bgscheduler/pull/68) merged as clean main commit `790f9382cf6f2a4cf4d94f0a19074e1a89177623`. All required GitHub checks and the Vercel preview passed. Additive migrations 0084/0085 were applied before activation.

- First deployed with the workflow disabled: `dpl_6MJZ4a7VKskRNV4HgBGZfAM9i15a`; the worker returned HTTP 200 with `paused:true`.
- Enabled production deployment: `dpl_FfGCVPs5m94KbYMqp5KpYcxGqQTt`, built from that same main commit and assigned to `bgscheduler.vercel.app`.
- The authenticated admin activation recorded **2026-09-13T11:36:37.162Z** (18:36 Bangkok) as the immutable launch time and enabled publishing in the same transaction. Never reset this timestamp.
- Initial independent attendance synchronization returned HTTP 200, success, **559 one-to-one student/course/tutor series**, every count zero, no group/unknown series, no unresolved instructors, and no reminders sent. Run ID: `4e8a1310-d572-4dbd-806a-55a761e84669`.
- The live pause/resume controls advanced the settings revision to 3 and preserved the exact launch timestamp. Publishing was left enabled.
- The authenticated production worker returned HTTP 200 with `paused:false`. Unauthenticated worker access and public upload-token requests returned 401; the guide required login. A forged upload completion was rejected and created no file records (the generic error response was 500).
- Production private Blob upload/read returned identical bytes; an unauthenticated direct download returned 403. Original submissions retain private storage and authenticated application downloads.
- The production first-use welcome, skip, replay, all nine admin practice steps, sample formatting, document previews, simulated approval/publication and history completed successfully. Only guide progress persisted; no real processing or publication jobs were created. The permanent Help / Practise button remained available.
- A real private browser upload and AI job were also verified in the isolated database: processing completed after the browser was closed. A raster-only synthetic handwriting-style answer was read correctly; the missing second page was flagged for review and embedded instructions to award full marks were ignored. This is not a claim about the accuracy of arbitrary student handwriting.

Detailed operator evidence is retained in ignored `output/progress-tests-verification/production-*.json`, alongside the native publication, document and AI checks. The intended-student visibility limitation stated above remains explicit: membership and access settings were verified, but no separate student-account login was available.

## Earlier upload-to-PDF revision — historical validation

The current revision removes the question editor and onboarding. Prepare and Test library share one upload/format action with authenticated PDF.js previews and durable progress. Additive migration 0086 adds processing stages/checkpoints, assessment-linked paper drafts, immutable version/artifact bindings and separate readiness approvals. Existing approved versions and completed rendering jobs are reconciled without changing their evidence.

Conversion and AI results survive render retries. The immutable launch remains **2026-09-13T11:36:37.162Z**; this upgrade must not call activation, reset counters or rewrite approvals/publication history. Apply the additive migration before deploying the compatible application.

`scripts/verify-progress-paper-pipeline.ts` exercises real private Blob and OpenAI against a disposable local database. `scripts/progress-paper-benchmark/run.ts --run` performs an explicit paid 23-setting model/effort comparison using local private fixtures; `render.ts` validates saved outputs without additional AI calls. All private sources, responses, images and PDFs are ignored under `output/progress-tests-pdf/`.

The API comparison captured 163 evaluable matrix outcomes before the account returned `credit_balance_exhausted`. The user declined an API top-up and requested continued testing through Codex. `codex.ts --run` uses the desktop app's signed-in, ephemeral, read-only runtime with attached page images and tools disabled; the completed 108-outcome comparison produced 95 complete responses and 190 PDFs. Its 25 source-check failures and 13 capture timeouts are separate from API billing or latency evidence. See the [model analysis](progress-paper-model-benchmark-2026-09-13.md).

Manual benchmark review identified a remaining document-quality release gate: Sol and other models omitted printed subpart marks; those failures are now included in all final scores. Some outputs also count only printed dotted lines and compress the blank space students need for their workings; source-check scores do not cover working-space suitability. Keep the fixed benchmark prompt for comparable measurements; validate explicit subpart-mark and working-area contracts and the final live long-paper pipeline before deploying this revision. The production launch timestamp, configuration and published history are untouched by the benchmark.

Release checks passed with 438 unit files / 4,991 tests, typecheck, production build, post-build typecheck, cron consistency and preservation of 255 existing route entries. Disposable PostgreSQL integration checks passed 25 tests across three suites. Private browser upload, automatic preview, approval persistence, tutor isolation and mobile overflow fixes were verified in isolation. DOCX visual conversion preserved the sample diagram/table; unsupported equations returned an actionable request for an exported PDF. Renderer v3 keeps subpart labels with their equations, verified by replaying saved finalist responses without AI charges. API-derived short-paper timing samples supplement recent comparable jobs; Codex timings never drive website estimates.

The final long-paper live API/browser validation and production deployment remain pending. This revision has not changed production's launch timestamp, counters, approved artifacts or Wise publication records.

## Original-paper release — 2026-09-14

The approved release defaults to **Use my uploaded paper**, with **Format with BeGifted — Beta** enabled by explicit opt-in. Formatting uses `OPENAI_PROGRESS_TEST_FORMAT_MODEL=gpt-6-astra` and `OPENAI_PROGRESS_TEST_FORMAT_EFFORT=low`. The benchmark favored checked content preservation; historical estimates of about $0.51 across its paper mix and $1.00 for the 17-page paper are neither pricing guarantees nor reliability claims. No paid AI tests or credit purchases are authorized for this release.

Original PDFs retain their bytes. DOCX conversion is independent of AI and rejects unsupported content with an export-to-PDF instruction. Original readiness does not require extraction, a marking key or rubric approval. New original assessments use uploaded tutor-marked PDFs and manually entered scores/reports. Structured papers also offer that recovery route. Each saved review binds immutable paper, submission, marked-file hash, score and report; approval checks the marked artifact hash before the existing native Wise publisher receives only the graded test and report.

Migration `0086_progress_paper_pipeline` remains additive. It adds immutable paper/artifact/readiness/rubric records, source-version links, marked-file assessment binding, frozen ready-file metadata, job stages/checkpoints and `formatting_enabled=true`. Legacy approvals are backfilled without rewriting existing evidence. Production preflight found migration 0085 last applied, 560 series, two qualifying classes, five paper versions and no approved reviews/publications; the launch is exactly **2026-09-13T11:36:37.162Z**. Never rerun activation.

The formatting request alone has a 180-second timeout inside the 300-second worker. Stages check the remaining invocation and lease budget. A successful response is saved before rendering, including when formatting is paused during extraction. Render retries reuse it. Interrupted calls, quota failures and timeouts require explicit retry, with no automatic model replacement. The original remains usable throughout.

Offline verification uses `scripts/verify-progress-original-documents.ts` and `scripts/progress-paper-benchmark/replay-layout.ts`. Source annotations exercise 166.32 mm unruled and 136.62 mm ruled areas, explicit 2/3 subpart marks, an original diagram, a continued question and a blank working page. The visual DOCX fixture converts; an equation fixture requests Word PDF export. Saved Astra-low long-paper output retains the older response's inadequate working-space metadata; the revised prompt has not been tested live. This is why beta output requires explicit review and adoption.

Release validation: `npm run verify:release` passed on Node 24 with 438 unit files / 4,996 tests, typechecks, production build, diff checks and all 255 source routes preserved. Fresh disposable PostgreSQL checks passed 29 integration files / 301 tests. ESLint had zero errors and 19 existing warnings. No paid AI requests were made.

A real local production-build browser run used the separate validation Blob store and synthetic records. Original upload/readback matched exactly, readiness survived reload, the complete marked-PDF/score/report flow generated both previews and reached approval while publishing was paused, and the approved marked artifact matched the upload hash. Another tutor received 404 for the assessment and source file. Desktop and 390px dark-mode phone views had no browser errors, failed requests or horizontal overflow. Regular installed Playwright was used because the testing skill's browser plugin was unavailable; its console, interaction, screenshot and responsive checks were retained. This run also found and fixed JSONB key-order comparisons that could leave a saved report looking unsaved.

Private browser/document evidence is in ignored `output/progress-tests-pdf/original-release/`. The operator script `scripts/verify-progress-original-publication.ts --live-wise` exercises the same commands with labelled synthetic files and the documented validation course; it clears AI credentials and cannot call AI. Deployment and native publication completion are recorded below.

Rollback must retain support for original-paper and uploaded-review records. For a formatting incident, pause **Formatting**; original use and manual grading remain available. For a publication incident, pause **Wise publishing** independently. Keep migration 0086 and immutable versions, launch, counters, approvals and publication checkpoints. Use a compatible forward fix or compatible release; do not restore the pre-original application against these new records.

### Migration and native publication verification

Migration 0086 was applied at 2026-09-13T17:57Z (00:57 Bangkok, 14 September), hash `e91daaaf9da5d8eaf9aac706a32c34c547eab96b31490b35c3ac160e35bd48c8`. The launch, 560 series/two classes and fingerprints of all existing paper versions, reviews and publications matched before/after. Publishing and formatting remained enabled at settings revision 3.

The complete original → submission → marked PDF → score/report → preview → approval → native Wise route passed with labelled synthetic documents at 2026-09-13T18:00Z. Course `6990f14e2f5bc252039abf3b` / student `696e2a2043579bbada1ff78f` and existing section `6aa6843f7239362dd4959a26` were verified. Publication `d5993baa-2200-40ee-bc02-02fd39c43892` has exactly two verified files: graded resource `6aa6e49d10595e9dd0b55140` and report resource `6aa6e4a07239362dd4a27113`. Exact Wise readback matched both hashes, including the uploaded marked PDF. Only the disposable local database stored synthetic assessment records; production counters/reviews were not altered. Evidence is in ignored `output/progress-tests-verification/original-release/`. No student-login impersonation test was performed; native course membership, Content visibility and byte readback were verified.

A separate browser beta-failure check exposed only the client capability for testing while server AI credentials remained empty. The real failed formatting job left original readiness available; replacement upload and two-version history passed. No paid requests were possible in that check.

### Production release verification

[Release PR #70](https://github.com/kasheesh711/bgscheduler/pull/70) passed all GitHub checks and its Vercel preview, then merged as main commit `aa05f6bd0d208842a9a06e6caece60e06055c260`. Production deployment `dpl_ACmmZn3k5QE43oA3Y6R8pKcZDgk2` reached Ready and serves [Progress Tests](https://bgscheduler.vercel.app/progress-tests). The production environment explicitly sets `OPENAI_PROGRESS_TEST_FORMAT_MODEL=gpt-6-astra` and `OPENAI_PROGRESS_TEST_FORMAT_EFFORT=low`.

The production browser check completed at 2026-09-13T18:09Z (01:09 Bangkok, 14 September). A clearly labelled private synthetic library paper preserved the uploaded three-page PDF byte-for-byte, rendered its authenticated preview, and became ready after review. Replacing it with a DOCX created a second immutable version; the production conversion job completed, its one-page PDF retained the diagram and table, and readiness succeeded. Formatting beta was enabled throughout. Anonymous source access required login, and no browser errors or paid AI requests occurred. The two synthetic library versions remain private and were not assigned to a real assessment.

The postflight at 2026-09-13T18:13Z confirmed the exact launch **2026-09-13T11:36:37.162Z**, 560 series/two qualifying classes, and unchanged fingerprints for every pre-existing paper version, review and publication. Migration 0086's ledger hash matches the deployed source. Both formatting and publishing remain enabled independently at settings revision 3. Activation was not called. Private evidence is retained in `output/progress-tests-verification/original-release/production-browser.json`, `production-postflight.json`, their screenshots and the converted PDF.

The revised formatting prompt remains untested against the live API under the no-paid-testing constraint. Saved-response replay and source-annotated renderer checks establish offline behavior only; tutors must review and explicitly adopt beta output, and approve its private rubric separately before AI grading.
