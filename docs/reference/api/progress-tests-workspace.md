# Progress Tests workspace API

Application endpoints require `PROGRESS_TEST_WORKSPACE_ENABLED=true`. Every request validates the session and freshly resolves an active tutor contact or authorized admin grant. Teachers must resolve to exactly one canonical tutor. Disabled, revoked or ambiguous bindings fail closed. Papers, cycles, jobs, file downloads and upload authorization are owner-scoped. Responses use `Cache-Control: private, no-store`.

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/progress-tests/workspace` | Scoped assessments, current versions/actions/publication state, papers and jobs; admin tutor filters, identity queue and legacy history |
| GET/PATCH | `/api/progress-tests/workspace/guide` | Retired: authenticated 410; historical records retained |
| POST | `/api/progress-tests/workspace` | Strict command union below with transactional version/ownership checks |
| GET | `/api/progress-tests/workspace/assessments/{id}` | Preparation, qualifying classes, paper versions, submissions, reviews, feedback references, PDFs and publication history |
| GET | `/api/progress-tests/workspace/papers/{id}` | Paper, immutable content versions, separate approvals, direct artifact references and its processing jobs |
| GET | `/api/progress-tests/workspace/jobs/{id}` | Scoped stage, elapsed/estimated time, retries, artifact IDs and per-attempt audit metadata |
| POST | `/api/progress-tests/workspace/sync` | Fresh authorized admin only; manually synchronize attendance |
| POST | `/api/progress-tests/workspace/uploads` | Vercel Blob client-upload token request |
| PATCH | `/api/progress-tests/workspace/files/{id}` | Authenticated completion fallback and byte validation |
| GET | `/api/progress-tests/workspace/files/{id}` | Authenticated private-file stream; `?download=1` requests attachment disposition |
| GET | `/api/progress-tests/workspace/pdf-runtime/{asset}` | Authenticated allowlisted PDF.js worker/font assets |
| POST | `/api/internal/progress-tests/uploads` | SDK-signed upload-completed callback only; cannot issue tokens |
| GET | `/api/internal/progress-tests/process` | Cron-secret protected worker, 300s maximum |

IDs are UUIDs. Invalid input returns 400; no session 401; missing grant 403; inaccessible records 404; stale revisions/unmet prerequisites 409; disabled workspace 503. Mutations check request origin and cap JSON at 3.5 MB. Binary scans use direct Blob upload. Unknown command fields and unauthorized owner selections are rejected.

## Commands

Each body has `action`. Paper and assessment commands require `id` and `expectedRevision`, obtained from the latest read. State changes return the new `revision`. Processing returns 202 with `jobId`; poll the overview or job. Stale results never overwrite newer edits.

| Action | Additional fields | Behavior |
|---|---|---|
| `create-paper` | `title`, optional `assessmentId` or admin `ownerKey` | Assessment ownership is derived freshly on the server; standalone admins explicitly select a tutor |
| `attach-original` | `sourceFileId`, nullable `keyFileId` | New immutable original version; exact PDF artifact or independent visual DOCX conversion |
| `format-paper` | `sourceFileId`, nullable `keyFileId` | Explicit opt-in bound to the saved original version/hashes and frozen Astra-low prompt settings; produces a separate draft, never adopts it |
| `approve-paper` | `versionId`, `confirmed: true` | Reviewed paper PDF required; original needs no extraction, key or rubric. Structured content warnings block adoption |
| `approve-rubric` | `versionId`, `confirmed: true` | Separate immutable private rubric approval after paper readiness; complete marks and criteria required |
| `save-paper`, `process-paper`, `preview-paper` | — | Retired; returns 410 |
| `prepare` | `paperVersionId`, `topics`, `studentInformed` | Save and enqueue exact reviewed paper PDF for Wise; frozen once submitted |
| `remove-preparation-paper` | — | Clear selection and informed checkbox, retain topics, withdraw only the recorded preparation attachment |
| `submit` | `sessionId`, `fileIds`, optional `pageOrder: [{fileId,page}]` | New submission; actual class belongs to this relationship from this cycle onward, every page exactly once |
| `grade` | — | Grade against the approved paper/rubric |
| `save-review` | `marks`, `report` | New reviewed draft; bounded per-question marks, empty report bullets removed |
| `save-marked-review` | `markedFileId`, `earned`, `possible`, `report` | New immutable review bound to this assessment, paper, submission and marked-file hash; finite valid scores, percentage calculated in code |
| `report` | — | Structured reviews only: separate report job with saved/resolved marks and frozen context; uploaded reviews use edited reports |
| `preview-review` | — | Both PDFs for the current saved review |
| `approve` | `confirmed: true` | Resolved marks, explanations/references, completed report and both PDFs required; creates immutable approval plus a durable publication job for both PDFs |
| `publish` | optional `publicationId` | Reconcile or retry an approved publication; original immutable review remains bound |
| `upload-intent` | `name`, `mime`, `size`, `purpose: paper\|key\|work\|marked`, optional `assessmentId` or admin `ownerKey` | `marked` requires `assessmentId` and PDF MIME; assessment-derived ownership; returns `id` and immutable `pathname`; no expected revision |
| `retry-job` | `id` | Failed jobs only; formatting resumes its immutable version and saved conversion/AI/PDF checkpoints |
| `activate` | — | Admin only; verified integrations/identity snapshot required; insert immutable launch and enable publishing atomically; repeat calls preserve pause state |
| `formatting` | `enabled`, `expectedRevision` | Admin beta pause/resume; independent of publishing and original conversion/readiness |
| `publishing` | `enabled`, `expectedRevision` | Admin publishing pause/resume independent of launch |

Full strict schemas live in `workspace/model.ts` and `commands.ts`. Question IDs must be unique; exactly one mark per approved question is required. Class feedback never changes numerical marks.

## Cutover

Assessment stages are `prepare`, `ready`, `awaiting_submission`, `tutor_review`, `approved`; publication is separate. Passing a date never approves an assessment. Cadence depends on qualifying relationship attendance, independently of completion.

A stored launch row retires legacy `/api/progress-tests` reads and old admin mutation guards with 410. Manual `POST /api/internal/sync-progress-tests` requires an admin role; cron GET requires its secret. Historical records remain stored and accessible to admins in History.

Read the [rollout and native Wise contract record](../../operations/progress-tests-workspace.md) before enabling integrations.

Overview exposes publishing readiness, pause/revision and admin source issues. Assessment details expose destination course/section identifiers and per-document names, hashes, status, attempts, errors and Wise IDs; private source URLs are never returned. Background jobs enforce current ownership before external writes.

Paper job status is polled independently of the overview. `artifact` contains authenticated `fileId`/`keyFileId`/`versionId`, never Blob URLs. Estimates are omitted without enough comparable evidence. The active upload/source tuple deduplicates repeated format commands; concurrent replacement uploads require the latest expected revision.

Original content has `{kind: "original", title}` plus immutable version/file metadata and no synthetic questions. Existing structured paper records remain compatible. Uploaded reviews have `kind: "uploaded"`, `markedFileId`, `markedSha256`, `earned` and `possible` instead of per-question marks. Every review binds exact `paperVersionId` and `submissionId`. Corrections create new reviews; stale jobs cannot change them. Approved marked artifacts must match the saved marked-file hash, and native publishing still accepts only the approved graded/report pair.

`format-paper` requires the latest saved original source/key tuple. Processing input freezes `sourceVersionId`, source/key hashes, `model`, `reasoningEffort`, `promptVersion` and the prompt text. Successful extraction precedes rendering. Timeouts, interrupted calls and quota failures become explicit-retry failures; renderer retries reuse saved extraction. The overview exposes independent `formatting.enabled` and `formatting.revision`.

### Preparation upload and removal

`prepare` retains its existing fields and revision guard; it saves the preparation and returns a durable `jobId`/`preparationPublicationId` (202) for immediate Wise dispatch. An unchanged active paper is reused. `remove-preparation-paper` takes `id` and `expectedRevision`, clears the selection and student-informed flag, preserves topics, and queues withdrawal when needed. An operation with an uncertain remote attachment must be reconciled before changing its selection. Both commands reject submitted assessments.

Assessment and overview reads include preparation-publication state separately from final-result publication. The existing `retry-job` command supports failed preparation jobs. Only approved paper artifacts are uploaded; rubric and marking-key artifacts are excluded. Publishing pause preserves queued work. Migration 0087 adds the preparation ledger; no existing preparation triggers a bulk upload.
