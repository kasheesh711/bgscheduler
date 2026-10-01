---
phase: quick-261001-sy2
plan: 01
type: execute
wave: 1
depends_on: []
autonomous: true
requirements: [PILOT-01, PILOT-02, PILOT-03]
files_modified:
  - src/lib/class-capture/sessions.ts
  - src/lib/class-capture/__tests__/access.test.ts
  - src/lib/class-capture/__tests__/http.test.ts
  - src/app/(app)/layout.tsx
  - .env.example
  - docs/operations/class-capture.md
  - docs/operations/class-capture-pilot-2026-10-02.md
must_haves:
  truths:
    - Exactly one configured pilot email can access capture and only while it is a designated owner with current enabled admin access.
    - Every page and API uses the same fail-closed pilot gate and navigation cannot expose the feature to other users.
    - Missing configuration or production prerequisites keep capture and paid processing disabled.
    - Release uses the protected main branch after exact-commit checks without weakening branch protection.
    - Migration 0108 and verified independent retention precede production capture activation.
  artifacts:
    - src/lib/class-capture/sessions.ts
    - src/lib/class-capture/__tests__/access.test.ts
    - docs/operations/class-capture-pilot-2026-10-02.md
  key_links:
    - exact CLASS_CAPTURE_PILOT_EMAIL intersects existing SUPER_ADMIN_EMAILS designation and a fresh admin row/accessVersion
    - canUseClassCapture and all capture handlers share the current server gate
    - production deployment is traced to protected main and its exact checked commit
    - independent retention remains enabled when capture or paid processing is paused
---

# Owner-only Class Capture pilot and production release

**Goal:** Make the existing Class Capture workflow available only to the explicitly configured owner for the **2026-10-02 Asia/Bangkok** pilot, if verified production prerequisites permit activation.

**Authorization:** The user has now explicitly authorized an owner-only pilot and going live. The root executor may carry out the normal protected-branch merge, production migration/deployment, and existing-service activation required for that release. This supersedes the earlier implementation-only release boundary; it does not authorize new credentials, OAuth grants, subscriptions, weaker security settings, automatic feedback submission, parent messages, payroll changes, or real student material in development tests. The planner edits this document only. No optional approval pause is needed for work already authorized.

**Starting point:** Reuse the current isolated worktree and [PR #133](https://github.com/kasheesh711/bgscheduler/pull/133). Capture schema is now [migration 0108](../../../drizzle/0108_class_capture.sql); 0107 belongs to another feature. Read the [capture runbook](../../../docs/operations/class-capture.md), `AGENTS.md`, and current auth code. Root owns hosted service inspection and production release; the implementation executor owns the narrow access change and tests. Record facts from hosted reads without printing secret values; local configuration absence is not evidence of hosted absence.

<objective>
Deliver a verified owner-only release or a precise blocked-activation result with capture safely disabled, preserving the existing consent, review, storage, retention, and payroll boundaries.
</objective>

<tasks>
<task type="auto" tdd="true">
  <name>1. Enforce one current owner pilot across server access and navigation</name>
  <files>src/lib/class-capture/sessions.ts, src/lib/class-capture/__tests__/access.test.ts, src/lib/class-capture/__tests__/http.test.ts, src/app/(app)/layout.tsx, .env.example</files>
  <behavior>A signed-in normalized email must match exactly one valid CLASS_CAPTURE_PILOT_EMAIL and the existing SUPER_ADMIN_EMAILS designation. Missing, malformed, or multi-address pilot configuration denies everyone. The actor must have admin role, a fresh enabled admin row, matching integer adminAccessVersion, and existing full or explicit capture page scope. Other owners, unrestricted/scoped admins, and tutors are denied. Stale/deleted/disabled admin access cannot fall back to tutor identity.</behavior>
  <action>
    - [ ] Write targeted tests red for exact owner allow, case/whitespace normalization, unset/invalid/multiple pilot value, wrong owner, non-owner admin, tutor, missing/disabled admin row, missing/stale accessVersion, missing page grant, and database failure.
    - [ ] Reuse the existing owner designation policy in `src/lib/admin-users/policy.ts` and fresh access-version pattern in `src/lib/admin-users/access.ts`/`auth-session.ts`; avoid a new name/domain or broad allowlist rule. Apply the stricter gate through `requireCaptureScope` so all routes, private media, upload tokens/finalization, and the page use it before sensitive work.
    - [ ] Make `canUseClassCapture` and existing server navigation capability use that same gate. Keep the feature/readiness flags and current capture ownership, class freshness, consent, review, and deletion rules intact. Do not widen unrelated admin/tutor access or alter cleanup's independence from user grants.
    - [ ] Document the one-email configuration without a real secret/example identity. Run focused access/HTTP/auth-session/proxy/navigation tests and applicable type/lint checks. Root reviews the final diff before release.
  </action>
  <verify><automated>npx vitest run --project unit src/lib/class-capture/__tests__/access.test.ts src/lib/class-capture/__tests__/http.test.ts src/lib/__tests__/auth-session.test.ts; npm run typecheck</automated></verify>
  <done>Only the exact configured current owner can pass page/API/navigation gates; every listed denied case fails closed and existing feature tests remain green.</done>
</task>

<task type="auto">
  <name>2. Verify existing production prerequisites and prepare the protected release</name>
  <files>drizzle/0108_class_capture.sql, drizzle/meta/_journal.json, docs/operations/class-capture.md, docs/operations/class-capture-pilot-2026-10-02.md</files>
  <behavior>Account access, credentials, private storage, schema, and cleanup readiness are verified facts before activation. Existing services may be inspected without displaying values or creating resources. Any missing required private-store/provider credential blocks activation rather than producing a simulated success.</behavior>
  <action>
    - [ ] Root inspects the existing deployment/project, production environment presence, private Blob store mode, Soniox/OpenRouter model/service capabilities, limits, and existing owner/admin identity using authorized reads. Pin one confirmed owner email; do not guess it or broaden SUPER_ADMIN_EMAILS.
    - [ ] Inspect the production migration ledger and 0108 journal ordering. Prepare only the necessary class-capture schema change through the normal release mechanism; do not accidentally run unrelated pending migrations. Keep capture and paid processing disabled until prerequisites pass.
    - [ ] Update PR #133 around the final owner-only scope. Push reviewed changes, run required checks, inspect every check for the exact PR head, and resolve scoped failures. Preserve branch protection and required approvals; user authorization does not bypass repository requirements.
    - [ ] Merge through the normal protected main workflow only after exact-head CI and required review gates pass. Record merged/main SHA, checks, and the production deployment tied to that SHA. Apply migration 0108 in the approved release order before exposing capture; verify tables/columns and journal state without printing student data.
    - [ ] If a required service, credential, approval, migration prerequisite, or CI gate is unavailable, record the precise blocker and keep capture/paid flags disabled. Continue independent safe work; never invent successful processing or create credentials/subscriptions to unblock it.
  </action>
  <verify><automated>git diff --check; npm run typecheck; targeted unit/integration checks and exact PR-head CI recorded by root</automated></verify>
  <done>Release evidence identifies the exact checked and deployed commit and schema state, or explicitly records the genuine blocker with activation still disabled.</done>
</task>

<task type="auto">
  <name>3. Activate retention first, verify the owner pilot, and record rollback evidence</name>
  <files>docs/operations/class-capture.md, docs/operations/class-capture-pilot-2026-10-02.md</files>
  <behavior>Capture exposure follows verified independent retention and bounded synthetic checks. The final result distinguishes deployed code, configured flags, actual service success, and unverified mobile behavior. No new submit/send capability is introduced.</behavior>
  <action>
    - [ ] Confirm migration 0108 and the deployed retention hook before enabling CLASS_CAPTURE_RETENTION_ENABLED. Verify the existing authenticated scheduler's cadence, a successful captureRetention result, backlog/uncertainty state, and synthetic private-object/provider deletion. Keep unrelated autowriter/payout policy and flags unchanged.
    - [ ] Use fictional text and synthetic media only for bounded storage/transcription/draft checks through existing authorized services. Verify private access and removal, expected model routing, and server denied-access cases before exposure. Do not bypass application authorization or use real student material to fabricate a pilot result.
    - [ ] After prerequisites pass, configure the exact CLASS_CAPTURE_PILOT_EMAIL and enable paid processing/capture through the normal deployment process. Confirm only that owner sees navigation and can use the authenticated workflow, while another admin/tutor is denied. Inspect the final production deployment/environment, not merely local values.
    - [ ] Verify consent → foreground record/stop or synthetic upload → explicit transcription/draft → edit/review → copy/open Wise. Do not submit feedback or send parent messages during the smoke test. Record whether real iOS/Android hardware was exercised; otherwise retain explicit phone-call/lockscreen/background/OS-termination and true resumability limitations.
    - [ ] Write dated rollout evidence: release/merge/deployment IDs and SHAs, schema state, flags without secrets, owner gate results, synthetic checks/costs, cleanup observation, remaining blockers, and Oct 2 Bangkok readiness. If activation fails, disable capture/paid processing, retain retention plus deletion access, and verify the pause. Never remove cleanup identifiers while evidence remains.
  </action>
  <verify><automated>node scripts/dev/verify-class-capture.mjs; production metadata and bounded synthetic smoke/retention results recorded by root without secrets</automated></verify>
  <done>The exact owner-only production pilot is verified ready for Oct 2 Bangkok, or the record clearly states which prerequisite blocks activation and confirms capture remains paused. Physical deletion and mobile limitations are reported honestly.</done>
</task>
</tasks>

<output>
Root writes SUMMARY.md in this quick directory, updates the quick-task state entry without changing ROADMAP.md, and reports the PR/release URL, production readiness, checks, and any genuine blocker promptly. Do not call the pilot live based solely on a successful code deployment or configured flags.
</output>
