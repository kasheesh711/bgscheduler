# Progress Tests workspace API

Application endpoints require `PROGRESS_TEST_WORKSPACE_ENABLED=true`. Every request validates the session and freshly resolves an active tutor contact or authorized admin grant. Teachers must resolve to exactly one canonical tutor. Disabled, revoked or ambiguous bindings fail closed. Papers, cycles, jobs, file downloads and upload authorization are owner-scoped. Responses use `Cache-Control: private, no-store`.

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/progress-tests/workspace` | Scoped assessments, current versions/actions/publication state, papers and jobs; admin tutor filters, identity queue and legacy history |
| GET/PATCH | `/api/progress-tests/workspace/guide` | Account-scoped guide version/status/last step; PATCH checks expectedRevision |
| POST | `/api/progress-tests/workspace` | Strict command union below with transactional version/ownership checks |
| GET | `/api/progress-tests/workspace/assessments/{id}` | Preparation, qualifying classes, paper versions, submissions, reviews, feedback references, PDFs and publication history |
| GET | `/api/progress-tests/workspace/papers/{id}` | Paper and immutable versions |
| GET | `/api/progress-tests/workspace/jobs/{id}` | Authorized job and per-attempt model/prompt/input/result audit |
| POST | `/api/progress-tests/workspace/sync` | Fresh authorized admin only; manually synchronize attendance |
| POST | `/api/progress-tests/workspace/uploads` | Vercel Blob client-upload token request |
| PATCH | `/api/progress-tests/workspace/files/{id}` | Authenticated completion fallback and byte validation |
| GET | `/api/progress-tests/workspace/files/{id}` | Authenticated private-file stream |
| POST | `/api/internal/progress-tests/uploads` | SDK-signed upload-completed callback only; cannot issue tokens |
| GET | `/api/internal/progress-tests/process` | Cron-secret protected worker, 300s maximum |

IDs are UUIDs. Invalid input returns 400; no session 401; missing grant 403; inaccessible records 404; stale revisions/unmet prerequisites 409; disabled workspace 503. Mutations check request origin and cap JSON at 3.5 MB. Binary scans use direct Blob upload. Unknown command fields and unauthorized owner selections are rejected.

## Commands

Each body has `action`. Paper and assessment commands require `id` and `expectedRevision`, obtained from the latest read. State changes return the new `revision`. Processing returns 202 with `jobId`; poll the overview or job. Stale results never overwrite newer edits.

| Action | Additional fields | Behavior |
|---|---|---|
| `create-paper` | `title`, optional admin `ownerKey` | New tutor-owned paper |
| `save-paper` | `paper`, nullable `sourceFileId`/`keyFileId`, `approved` | Immutable version; readiness requires a PDF of the exact saved draft and resolved warnings/rubrics |
| `process-paper` | `sourceFileId`, nullable `keyFileId` | Formatting job creating a draft |
| `preview-paper` | — | Saved paper PDF with original illustrations |
| `prepare` | `paperVersionId`, `topics`, `studentInformed` | Approved owned paper, frozen once submitted |
| `submit` | `sessionId`, `fileIds`, optional `pageOrder: [{fileId,page}]` | New submission; actual class belongs to this relationship from this cycle onward, every page exactly once |
| `grade` | — | Grade against the approved paper/rubric |
| `save-review` | `marks`, `report` | New reviewed draft; bounded per-question marks, empty report bullets removed |
| `report` | — | Separate report job with saved/resolved marks and frozen context |
| `preview-review` | — | Both PDFs for the current saved review |
| `approve` | `confirmed: true` | Resolved marks, explanations/references, completed report and both PDFs required; creates immutable approval plus a durable publication job for both PDFs |
| `publish` | optional `publicationId` | Reconcile or retry an approved publication; original immutable review remains bound |
| `upload-intent` | `name`, `mime`, `size`, `purpose: paper\|key\|work`, optional admin `ownerKey` | Returns `id` and immutable `pathname`; no expected revision |
| `retry-job` | `id` | Failed jobs only; retries original input/revision, which can be superseded by newer work |
| `activate` | — | Admin only; verified integrations/identity snapshot required; insert immutable launch and enable publishing atomically; repeat calls preserve pause state |
| `publishing` | `enabled`, `expectedRevision` | Admin publishing pause/resume independent of launch |

Full strict schemas live in `workspace/model.ts` and `commands.ts`. Question IDs must be unique; exactly one mark per approved question is required. Class feedback never changes numerical marks.

## Cutover

Assessment stages are `prepare`, `ready`, `awaiting_submission`, `tutor_review`, `approved`; publication is separate. Passing a date never approves an assessment. Cadence depends on qualifying relationship attendance, independently of completion.

A stored launch row retires legacy `/api/progress-tests` reads and old admin mutation guards with 410. Manual `POST /api/internal/sync-progress-tests` requires an admin role; cron GET requires its secret. Historical records remain stored and accessible to admins in History.

Read the [rollout and native Wise contract record](../../operations/progress-tests-workspace.md) before enabling integrations.

Guide PATCH accepts `status: started|skipped|completed`, `step: 0..8`, and `expectedRevision`. It never persists sample work. Overview exposes publishing readiness, pause/revision and admin source issues. Assessment details expose destination course/section identifiers and per-document names, hashes, status, attempts, errors and Wise IDs; private source URLs are never returned. Background jobs enforce current ownership before external writes.
