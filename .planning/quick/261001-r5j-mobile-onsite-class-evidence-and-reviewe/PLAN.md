---
phase: quick-261001-r5j
plan: 01
type: execute
wave: 1
depends_on: []
autonomous: true
requirements: [CAPTURE-01, CAPTURE-02, CAPTURE-03, CAPTURE-04, CAPTURE-05, CAPTURE-06]
files_modified:
  - src/lib/class-capture/model.ts
  - src/lib/class-capture/sessions.ts
  - src/lib/class-capture/store.ts
  - src/lib/class-capture/files.ts
  - src/lib/class-capture/providers.ts
  - src/lib/class-capture/evidence.ts
  - src/lib/class-capture/processing.ts
  - src/lib/class-capture/cleanup.ts
  - src/lib/class-capture/handlers.ts
  - src/lib/class-capture/http.ts
  - src/lib/class-capture/local-recovery.ts
  - src/lib/class-capture/recorder.ts
  - src/components/class-capture/class-capture-workspace.tsx
  - src/app/(app)/class-capture/page.tsx
  - src/app/api/class-capture/route.ts
  - src/app/api/class-capture/uploads/route.ts
  - src/app/api/class-capture/[id]/route.ts
  - src/app/api/class-capture/[id]/assets/route.ts
  - src/app/api/class-capture/[id]/assets/[assetId]/route.ts
  - src/app/api/class-capture/[id]/transcribe/route.ts
  - src/app/api/class-capture/[id]/draft/route.ts
  - src/app/api/internal/feedback-autowriter/route.ts
  - src/lib/db/schema.ts
  - drizzle/0108_class_capture.sql
  - src/lib/auth-access.ts
  - src/proxy.ts
  - src/lib/navigation/tools.ts
  - docs/operations/class-capture.md
  - scripts/dev/verify-class-capture.mjs
must_haves:
  truths:
    - Only the current authorized tutor or scoped admin can use an existing onsite session and its evidence.
    - Recording requires runtime consent, remains visible, and reports browser interruptions honestly.
    - Private uploads retry from saved bytes and uncertain paid provider requests are never replayed automatically.
    - Draft claims cite current transcript or tutor debrief, and never infer silent work or unsupported mastery.
    - A tutor reviews and edits before manually submitting in Wise; this feature cannot submit or affect payroll.
    - Expired and cancelled evidence is inaccessible and cleanup retries its deletion.
  artifacts:
    - src/lib/class-capture/model.ts
    - src/components/class-capture/class-capture-workspace.tsx
    - src/app/(app)/class-capture/page.tsx
    - docs/operations/class-capture.md
  key_links:
    - class-capture page and routes use fresh access plus exact session/student binding
    - private upload intents and authenticated explicit finalization bind bytes to stored file ownership
    - asynchronous provider IDs and processing claims persist before the next request
    - internal feedback-autowriter cron invokes cleanup independently of autowriter enablement
    - reviewed text opens the existing Wise session feedback flow without a feedback POST
---

# Onsite Class Evidence Implementation Plan

> **For agentic workers:** Use the already selected GSD executor workflow, with the brainstorming, writing-plans, and test-driven-development skill guidance. Track each step below. The user's autonomous implementation instruction supersedes optional review pauses; no production activation is authorized.

**Goal:** Let an authorized onsite tutor record consented class evidence on a phone and prepare a reviewed, editable feedback draft for explicit submission through Wise.

**Architecture:** Add an isolated `/class-capture` workspace, session-scoped API, private direct uploads, durable provider work, and expiry cleanup. Reuse existing provider and design-system interfaces while keeping the online autowriter submission and payroll paths untouched.

**Tech stack:** Existing Next.js 16.2/React 19/TypeScript/Drizzle/Neon, `@vercel/blob` 2.8, browser MediaRecorder/IndexedDB, existing Soniox/OpenRouter adapters, Vitest.

**Spec:** [Onsite class evidence design](../../../docs/superpowers/specs/2026-10-01-onsite-class-evidence-design.md). Read it together with `AGENTS.md`, `docs/handbook/conventions.md`, and relevant installed Next.js documentation. Existing patterns: `src/lib/progress-tests/workspace/files.ts`, `src/lib/feedback-autowriter/{soniox,openrouter,config,submit}.ts`, `src/lib/auth-access.ts`, and `src/proxy.ts`.

**Operations:** [Activation and recovery runbook](../../../docs/operations/class-capture.md). This plan now names the implemented routes/files; checkboxes remain execution handoff items, not an assertion that final CI or production validation has passed. The [synthetic report](../../../docs/assets/class-capture/acceptance-results.json) records 13 passing browser checks with zero provider calls.

## Global constraints

- D-01–D-12 in the design are binding. `ENABLE_CLASS_CAPTURE` defaults off; APIs also require `CLASS_CAPTURE_RETENTION_ENABLED`, and paid work requires `CLASS_CAPTURE_PROCESSING_APPROVED` plus existing provider credentials. Do not change real environment values.
- Active bounds: class audio totals 100 MiB across eight sections, one 10 MiB debrief, four JPG/PNG worksheets at 8 MiB/24 megapixels each. Browser debrief recording stops at three minutes; imported bytes do not establish a pre-spend duration limit. Replacements retain a lifetime 20-intent/200 MiB budget per capture. Evidence/recovery expires logically after 24 hours; photos are tutor-review-only.
- Use fictional fixtures and mocked providers/synthetic media only. No real student data, live provider spending, production writes/migrations, credentials, deployment, merge, or outbound messages.
- Existing teacher/admin feedback and payroll behavior remains unchanged. No new feedback submit endpoint or imported autowriter submit capability.
- Migration `0108_class_capture.sql` adds capture/assets tables and remains unapplied in production. File decomposition and contracts below match the implementation; update them if names change.
- Root owns shared schema/model/backend/cron; the access executor owns scoped session discovery and auth/navigation wiring; the UI executor owns components/browser recovery. Shared contract changes go through root.

## Review focus

1. A contact/session grant is revoked after the upload token was minted: finalization and later processing must deny access and still delete staged bytes (Task 1/2).
2. A provider accepts a create request whose response is lost: an uncertain result blocks automatic replay, preserves cleanup metadata, and lets the operator review the attempt. Reference-prefixed orphan deletion does not reconstruct lost success or guarantee exactly-once billing (Task 2).
3. Safari/Android suspends recording without delivering the final chunk: show an interruption and recover only saved bytes, never an uninterrupted-success state (Task 3).
4. A plausible mastery claim cites a real but irrelevant quote or an unknown speaker: membership validation does not imply truth; conservative output and tutor review are required (Task 2/3).
5. Cleanup runs while capture/autowriting is disabled or access has been revoked: expired evidence stays inaccessible, deletion still runs, and failed object IDs remain retryable. Capped provider scans surface failure; busy-project backlog needs operator remediation (Task 2).

## Shared interfaces and execution order

The client sends identifiers and commands, never authoritative student/tutor ownership, prior feedback, arbitrary URLs, or provider credentials. The session list and capture payload contain the server-derived selected session/student, capability/readiness state, evidence/upload status, expiry, and reviewed draft.

The root-owned model defines: capture scope, selected class/session/student identity, consent record, source kind (`recording`, `debrief`, `worksheet`), file intent, capture lifecycle, four draft sections, source references/quotes, and typed safe errors. The API exposes list/load, create-with-consent, upload-intent/finalize, process/poll, save-reviewed-draft, and cancel/delete commands under the new namespace. It has no submit/send operation.

Task 1 establishes access/session contracts first. Task 2 backend and Task 3 client can develop in parallel against the root-owned model and synthetic API fixtures, then integrate sequentially. Root resolves shared-file edits and runs final verification. No commits from planning; implementation commits follow completed verification.

<objective>
Deliver the guarded onsite capture-to-reviewed-draft path and a review-ready draft PR, with honest operational prerequisites and mobile limitations.
</objective>

<tasks>
<task type="auto" tdd="true">
  <name>1. Bind capture to current authorized tutor, scheduled session, and student</name>
  <files>src/lib/class-capture/sessions.ts, src/lib/class-capture/__tests__/access.test.ts, src/lib/class-capture/__tests__/sessions.test.ts, src/lib/auth-access.ts, src/proxy.ts, src/lib/navigation/tools.ts</files>
  <behavior>Unknown/disabled users, stale grants/snapshots, name-only bridges, unrelated tutors, unresolved modality, cancelled sessions, and ambiguous students are denied. Exact active tutor contacts see only their authorized onsite classes. Scoped admins still access only their creator-owned captures. An owned ended capture may leave the future feed, while known reassignment/cancellation/deletion still denies use. Feature-off makes no new access available.</behavior>
  <action>
    - [ ] Write synthetic access/session tests and run them red before implementation.
    - [ ] Implement fresh scope resolution and exact canonical-key/session binding (D-01–D-03), with a current snapshot no older than two hours. Use authorized stored scheduled records and bounded same-student/class/tutor feedback history; no live Wise tutor-read fallback or client-provided history.
    - [ ] Wire the authenticated page/API namespace and navigation only for eligible users, preserving existing page scoping and teacher entry points. Preserve no-store behavior for private payloads.
    - [ ] Run the focused tests and existing auth/proxy regression suites; reconcile model exports with root.
  </action>
  <verify><automated>npx vitest run --project unit src/lib/class-capture/__tests__/access.test.ts src/lib/class-capture/__tests__/sessions.test.ts src/lib/__tests__/auth-access.test.ts</automated></verify>
  <done>Capture selection is reachable only through a current authorized exact session/student identity. Cross-session access and ambiguity fail closed before request payload processing.</done>
</task>

<task type="auto" tdd="true">
  <name>2. Implement private evidence lifecycle, durable transcription, grounded drafts, and deletion</name>
  <files>src/lib/class-capture/model.ts, src/lib/class-capture/store.ts, src/lib/class-capture/files.ts, src/lib/class-capture/providers.ts, src/lib/class-capture/evidence.ts, src/lib/class-capture/processing.ts, src/lib/class-capture/cleanup.ts, src/lib/class-capture/handlers.ts, src/lib/class-capture/http.ts, src/lib/class-capture/__tests__/, src/app/api/class-capture/, src/app/api/internal/feedback-autowriter/route.ts, src/lib/db/schema.ts, drizzle/0108_class_capture.sql, docs/operations/class-capture.md</files>
  <behavior>Consent precedes tokens/provider processing. Only private bounded intent-bound audio/photos can finalize. Durable claims protect against concurrent attempts; unknown paid outcomes block automatic replay. Transcript/debrief citations must match current evidence and cannot cite history/photos. Expiry/cancel hides evidence immediately and retries deletion of Blob, Soniox job/file, and sensitive DB content even when capture/autowriting is off.</behavior>
  <action>
    - [ ] Write failing model, upload, provider, draft, and cleanup tests with fictional English/Thai/mixed evidence. Include wrong-owner finalization, revoked grant, content sniffing, active/lifetime count/size limits, stale intent, cancellation during finalization, concurrent claims, lost provider response, and retryable deletion.
    - [ ] Add migration source and typed records for capture/consent/draft, file intents, expiries/revisions, processing claims, provider IDs, and cleanup state. Do not run production migration commands.
    - [ ] Implement private Blob multipart intents using the existing progress-tests pattern, exact server paths, five-minute tokens, authenticated explicit finalization, byte/container validation, scoped reads, idempotent finalization, and cancellation (D-04/D-06–D-08). No Blob callback endpoint is needed.
    - [ ] Add Soniox file-based asynchronous processing with th/en hints, durable status/IDs/reference prefix, bounded deadlines, and safe unavailable/error states. Reuse OpenRouter ZDR routing with strict section/source/quote schema. Treat transcripts as data; validate current-source quote membership and conservatively avoid identity/mastery inference (D-09–D-11).
    - [ ] Wire independent expiry/orphan cleanup alongside the internal autowriter job without shortening its existing budget. Use a 90-second sweep budget, 25-capture batch, attempt-time fairness, 15-minute cooldown, and failed/deferred reporting. Keep failed cleanup identifiers and tombstones at least one hour beyond original expiry; clear old uncertainty only after a complete orphan scan and the 24-hour-plus-three-minute cutoff. Gate new work on feature/readiness; never gate scheduled deletion on a user's remaining access (D-01/D-08).
    - [ ] Document flag/schema/private-store/provider-budget/cleanup prerequisites, costs by audio duration/model tokens/Blob operations, deletion timing, and limits. Run focused unit and ephemeral-Postgres integration tests, recording any unavailable local dependency.
  </action>
  <verify><automated>npx vitest run --project unit src/lib/class-capture src/app/api/class-capture; npx vitest run --project integration src/lib/class-capture</automated></verify>
  <done>Only consented, current, authorized evidence reaches mocked providers in tests; attempts and deletion survive retries; generated claims expose source provenance; the feature has no Wise feedback POST or parent-send capability.</done>
</task>

<task type="auto" tdd="true">
  <name>3. Build the phone capture/recovery/review flow and verify the exact PR commit</name>
  <files>src/components/class-capture/class-capture-workspace.tsx, src/components/class-capture/recording-panel.tsx, src/components/class-capture/asset-card.tsx, src/components/class-capture/client-helpers.ts, src/components/class-capture/__tests__/, src/lib/class-capture/local-recovery.ts, src/lib/class-capture/recorder.ts, src/lib/class-capture/__tests__/local-recovery.test.ts, src/lib/class-capture/__tests__/recorder.test.ts, src/app/(app)/class-capture/page.tsx, scripts/dev/verify-class-capture.mjs, docs/operations/class-capture.md, docs/assets/class-capture/</files>
  <behavior>Unconfirmed consent never requests microphone access. Stop/interruption releases tracks. Permission denial, unavailable IndexedDB, expired recovery, offline upload, duplicate taps, and cancellation leave honest actionable states. Polling does not replace edited draft text. Copy/open-Wise requires explicit review and never reports submission.</behavior>
  <action>
    - [ ] Write failing recording/recovery state and interaction tests with fake devices, emitted synthetic blobs, mocked IndexedDB/API/providers, and controllable clock/network events.
    - [ ] Build the selected-class header, runtime consent, visible recording/elapsed time/Stop controls, playback, optional three-minute tutor debrief, and worksheet review with BeGifted components (D-02/D-04–D-06).
    - [ ] Persist emitted chunks with actor/session/expiry binding; handle quota failures, hidden/page-exit and track interruption, local recovery/delete, upload progress/abort, and retry from saved bytes (D-05/D-07/D-08). Do not advertise guaranteed background recording or cross-reload multipart continuation.
    - [ ] Render source-labelled transcripts and four editable draft sections, insufficient-evidence guidance, expiry/status/errors, explicit review acknowledgment, Copy reviewed draft, and Open Wise to submit (D-10–D-12). Keep mutable edits stable during polling and invalidate review acknowledgment after edits.
    - [ ] Run the synthetic mobile acceptance path at 390px and a desktop viewport, including consent, recording, recovery, and review screenshots. Check keyboard/focus/status labels/touch targets and absence of horizontal overflow. Record hardware/vendor/Wise checks not performed.
    - [ ] Root runs typecheck, unit tests, supported ephemeral integration tests, build, and diff checks; fixes scoped failures, creates/pushes a draft PR with screenshots/acceptance/cost notes, and verifies CI for its exact SHA. Report blockers without merging or deploying.
  </action>
  <verify><automated>npx vitest run --project unit src/components/class-capture src/lib/class-capture; npm run typecheck; npm test; npm run build; git diff --check</automated></verify>
  <done>A synthetic user completes the phone workflow through reviewed Wise handoff; failure/recovery states are tested; screenshots and honest limits accompany a draft PR whose exact-commit checks are recorded.</done>
</task>
</tasks>

## Decision coverage

| Decision | Task | Coverage |
| --- | --- | --- |
| D-01 feature/readiness gate | 1, 2 | Full |
| D-02 selection and D-03 current scope | 1, 3 | Full |
| D-04 consent | 2, 3 | Full |
| D-05 foreground recording | 3 | Full, with browser limitations explicit |
| D-06 source/file bounds | 2, 3 | Full |
| D-07 private upload/retry | 2, 3 | Full; saved-byte retry is the reload recovery contract |
| D-08 expiry/deletion | 2, 3 | Full; physical cleanup retries are reported honestly |
| D-09 multilingual transcription | 2, 3 | Full via existing services; live validation outside test scope |
| D-10 grounded draft and D-11 uncertainty | 2, 3 | Full with explicit semantic/attribution review |
| D-12 tutor review and existing submit | 3 | Full through explicit Wise handoff |

## Delivery evidence

- [ ] Spec/plan and implementation are consistent; no placeholder success claims.
- [ ] Design and operational documentation describe actual final routes/config/table names.
- [ ] Acceptance checks distinguish automated mocks, synthetic browser checks, and unverified hardware/provider/production behavior.
- [ ] Draft PR includes screenshot paths, test results, exact SHA/CI status, provider/account/spend prerequisites, and no production mutation or deployment.

<output>
Root executor writes SUMMARY.md and verification evidence in this quick directory, updates the quick-task state entry without changing ROADMAP.md, and reports the draft PR plus remaining blockers.
</output>
