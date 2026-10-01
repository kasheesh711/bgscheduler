---
phase: quick-261001-ulx
plan: 01
type: execute
wave: 1
depends_on: []
autonomous: true
requirements: [TUTOR-PILOT-01, TUTOR-PILOT-02, TUTOR-PILOT-03]
files_modified:
  - src/lib/class-capture/sessions.ts
  - src/lib/class-capture/store.ts
  - src/lib/class-capture/handlers.ts
  - src/lib/class-capture/__tests__/access.test.ts
  - src/lib/class-capture/__tests__/sessions.test.ts
  - src/lib/class-capture/__tests__/http.test.ts
  - src/lib/class-capture/__tests__/store.integration.test.ts
  - src/components/class-capture/class-capture-workspace.tsx
  - src/components/class-capture/__tests__/class-capture-workspace.test.tsx
  - scripts/dev/verify-class-capture.mjs
  - .env.example
  - docs/operations/class-capture.md
must_haves:
  truths:
    - Exact pilot email membership and one fresh active tutor-contact canonical key are required for every actor including admin Kevin.
    - Each pilot can see and use only their own tutor's classes and captures; null or unscoped access always fails closed.
    - Peat and Ek use existing teacher accounts without new admin grants or owner designation.
    - New list, selection, and capture creation are restricted to the server's current Bangkok day.
    - Existing owned unexpired captures remain recoverable after midnight under the same strict tutor scope.
    - The UI has no date picker and refreshes today's choices at Bangkok midnight and on focus without overwriting active work.
  artifacts:
    - src/lib/class-capture/sessions.ts
    - src/lib/class-capture/__tests__/access.test.ts
    - src/lib/class-capture/__tests__/sessions.test.ts
    - src/components/class-capture/class-capture-workspace.tsx
    - docs/operations/class-capture.md
  key_links:
    - plural pilot email membership plus exact active contact email yields exactly one canonical key
    - page and all APIs share requireCaptureScope while navigation uses the same fresh capability
    - server todayBangkok constrains list and create independently of existing-artifact authorization
    - midnight and focus refresh discard stale selections while preserving an existing capture
---

# Each pilot's own classes, today in Bangkok

**Workspace:** Only `/Users/kevinhsieh/Documents/Codex/2026-10-01/task-8/bgscheduler-tutor-pilot`, branch `codex/class-capture-tutor-pilot`, base `fe791ff0636d10dcc98829d7ff47690c2c5cea49`. Planner writes this document only; no implementation or commit. Root owns release and verified production email configuration.

**Context:** Read `AGENTS.md`, `.planning/STATE.md`, capture access/sessions/store/handlers/http/UI, auth-session/auth-access, Proxy and fresh navigation capability. No `.agents` folders exist in the inspected checkouts. Implementation workers read applicable bundled Next.js guides and follow TDD. The current owner gate returns `keys: null`; replace that behavior. Root verified Kevin, Peat, and Ek each have one active exact onsite email binding and one onsite Wise identity. Peat/Ek have teacher accounts and no admin rows. Do not hardcode real emails, use display-name bridges, change `admin_users`/`SUPER_ADMIN_EMAILS`/general sign-in rules, or modify provider, retention, or payroll behavior. Tests use synthetic identities/media. Optional planning ceremony must not delay authorized implementation.

<objective>
Allow the three configured tutor pilots to use only their own classes scheduled today, preserving safe recovery of existing unexpired same-tutor captures across midnight.
</objective>

<tasks>
<task type="auto" tdd="true">
  <name>1. Enforce exact pilot membership, one own tutor key, and server-side today</name>
  <files>src/lib/class-capture/sessions.ts, src/lib/class-capture/store.ts, src/lib/class-capture/handlers.ts, src/lib/class-capture/__tests__/access.test.ts, src/lib/class-capture/__tests__/sessions.test.ts, src/lib/class-capture/__tests__/http.test.ts, src/lib/class-capture/__tests__/store.integration.test.ts</files>
  <behavior>Every pilot, including an admin, requires exact normalized email membership and exactly one canonical key from fresh active onsite/online contact emails. No null scope or admin bypass remains. Teachers need no admin row. Existing admin role/version/page-grant revocation remains enforced. List/create reject non-today dates and other tutors' IDs; existing owned capture authorization is independent of selection day.</behavior>
  <action>
    - [ ] Write failing tests from the matrix below, including admin Kevin scoped like a tutor, two teacher pilots, null/multiple keys, cross-tutor capture/media, date tampering, and cross-midnight recovery.
    - [ ] Add bounded comma-separated `CLASS_CAPTURE_PILOT_EMAILS` with complete normalized email matching and strict configuration validation. If singular compatibility is retained, use `CLASS_CAPTURE_PILOT_EMAIL` only when plural is absent; present empty/invalid plural fails closed. Both paths resolve the same strict tutor scope. Remove capture's owner designation requirement without changing global owner policy.
    - [ ] Resolve active tutor contacts by exact onsite/online email only, never `resolveTeacherCanonicalKeys` name bridging. Return one non-null key and enforce that invariant at runtime in all session/storage access, including direct-call malformed scopes. Match both creator email and tutor key for stored captures; older owner-created captures for other tutors remain inaccessible. Reuse existing Proxy and fresh navigation wiring; teacher `allowedPages` containing only progress-tests must not defeat the capture-specific fresh grant.
    - [ ] Restrict new listing and creation to server `todayBangkok()` using the scheduled start's Bangkok day. Reject supplied different/malformed dates and forged old/future session IDs. Keep fresh snapshots, onsite/one-to-one, cancellation, student, and tutor checks. No live Wise fallback.
    - [ ] Keep existing-ID read/edit/upload/transcribe/draft recovery separate from today-only creation. Existing same-tutor unexpired captures survive midnight; changed/reassigned/deleted/expired or cross-tutor artifacts remain denied. Do not change retention or cleanup.
  </action>
  <verify><automated>npx vitest run --project unit src/lib/class-capture/__tests__/access.test.ts src/lib/class-capture/__tests__/sessions.test.ts src/lib/class-capture/__tests__/http.test.ts src/lib/__tests__/auth-session.test.ts; npx vitest run --project integration src/lib/class-capture/__tests__/store.integration.test.ts</automated></verify>
  <done>Three synthetic pilots each receive one own key and today's eligible sessions only; forged scope/date/IDs are denied and prior-day own capture recovery remains valid.</done>
</task>

<task type="auto" tdd="true">
  <name>2. Replace date selection with today's list and safe rollover</name>
  <files>src/components/class-capture/class-capture-workspace.tsx, src/components/class-capture/__tests__/class-capture-workspace.test.tsx, scripts/dev/verify-class-capture.mjs</files>
  <behavior>No editable date picker remains. Midnight/focus refresh removes stale uncreated choices and prevents old responses from restoring yesterday's list. Active capture, media, notes, draft and review state survive a list refresh.</behavior>
  <action>
    - [ ] Write controlled-clock/browser tests for today's label, no date input, midnight refresh, focus/visible return after suspended timers, stale response ordering, and existing-capture preservation.
    - [ ] Fetch the server's today-only list without a user-controlled date. Schedule refresh at Bangkok midnight and refresh on focus/visible return. Clear stale uncreated selection/consent/create-attempt state, ignore obsolete responses, and expose retryable refresh errors. Do not reset active capture state or interrupt recording merely because the calendar day changed.
    - [ ] Preserve BeGifted styling, recovery and review/handoff behavior. Update empty-state text to today's own eligible classes. Extend the existing synthetic harness with the scoped-list/rollover cases; no live media or provider calls.
  </action>
  <verify><automated>npx vitest run --project unit src/components/class-capture; node scripts/dev/verify-class-capture.mjs</automated></verify>
  <done>Today's list refreshes correctly at midnight and after a suspended tab returns, while an existing capture and its edits remain intact.</done>
</task>

<task type="auto">
  <name>3. Document configuration and validate the scoped release</name>
  <files>.env.example, docs/operations/class-capture.md</files>
  <behavior>Documentation reflects plural tutor pilots and today-only selection, while preserving existing recovery, consent, provider, retention and payroll boundaries.</behavior>
  <action>
    - [ ] Update env/runbook guidance without real emails or secrets: exact plural membership, singular fallback semantics if retained, one current tutor key for everyone, today-only selection, and separate unexpired recovery.
    - [ ] Run focused access/session/HTTP/storage/UI tests, relevant existing auth/navigation/Proxy regressions, typecheck, scoped lint, synthetic harness, and diff check. Fix scoped failures; record actual results and unavailable dependencies.
    - [ ] Root checks the plan/execution, configures only verified onsite pilot emails, and follows the existing protected release process with exact-commit CI. No new accounts, admin grants, owner designations, credentials, or provider/retention/payroll settings are required by this change.
  </action>
  <verify><automated>npx vitest run --project unit src/lib/class-capture src/components/class-capture src/lib/__tests__/auth-session.test.ts src/__tests__/middleware.test.ts; npm run typecheck; git diff --check</automated></verify>
  <done>The matrix passes, docs match implementation, and root has the exact scoped diff and verification evidence for release.</done>
</task>
</tasks>

## Focused verification matrix

| Boundary | Required result |
| --- | --- |
| Admin pilot plus one exact active contact | One own key; another tutor's list/session/capture/media denied |
| Two teacher pilots without admin rows | Each receives own list/navigation; no owner designation needed |
| Non-pilot, inactive/unbound contact, multiple keys, null/malformed scope | Denied before private data/provider work |
| Missing/invalid plural configuration | Denied; singular fallback only if plural absent, always tutor-scoped |
| Disabled/deleted/stale-version admin | Denied without stale-session teacher fallback |
| Yesterday/tomorrow/malformed date or forged create IDs | Denied server-side regardless of UI |
| `2026-10-01T16:59:59Z` → `17:00:00Z` | Oct 2 Bangkok begins; no new Oct 1 capture; list refreshes |
| Focus after midnight / late previous response | Current list wins; stale selection cannot create |
| Existing own unexpired capture after midnight | Recovery and evidence/edit workflow preserved with fresh same-tutor checks |
| Old owner capture for another tutor / reassigned or expired capture | Denied; existing cleanup proceeds independently |

<output>
Root records plan-check/execution results and exact-commit CI in this quick directory, updates quick-task state as appropriate, and reports release outcome. Planner does not edit implementation or commit.
</output>
