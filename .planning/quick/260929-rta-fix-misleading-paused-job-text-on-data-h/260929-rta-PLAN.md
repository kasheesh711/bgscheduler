---
phase: quick-260929-rta
plan: "01"
type: execute
wave: 1
depends_on: []
files_modified:
  - src/lib/data-health/status.ts
  - src/lib/data-health/__tests__/status.test.ts
  - src/lib/internal/cron-watchdog.ts
  - src/lib/internal/__tests__/cron-watchdog.test.ts
autonomous: true
requirements:
  - RTA-PAUSED-DETAIL
  - RTA-SYNTHETIC-NO-RUN
quick_id: 260929-rta
branch: fix/data-health-paused-detail
base: origin/main 19e6c26
worktree: /Users/kevinhsieh/Developer/Scheduling-paused-detail
must_haves:
  truths:
    - "Every paused job except LINE Credit Digest shows '<its effectiveCronJob cadenceLabel>; no run is expected until it is re-enabled.' on Data Health, never the credit-alert sentence (e.g. Wise Snapshot shows 'Paused by owner; …', Feedback Autowriter 'Feedback autowriter disabled; …', Tutor Sit-ins 'Tutor Sit-ins disabled; …')"
    - "A paused LINE Credit Digest still shows 'Automatic credit alerts are paused; saved preferences are retained.' verbatim; manual-only and not-yet-activated texts are unchanged"
    - "The watchdog's synthetic Payout Window Finalize and Feedback Deadline Coverage rows carry canRunManually: false even when the source registry definition is missing or manual-only"
  artifacts:
    - path: "src/lib/data-health/status.ts"
      provides: "private pausedHealthDetail(job) used by the paused arm of evaluateCronJobStatus"
      contains: "no run is expected until it is re-enabled."
    - path: "src/lib/internal/cron-watchdog.ts"
      provides: "fail-closed canRunManually on both synthetic health rows"
      contains: "canRunManually: false"
  key_links:
    - from: "src/lib/data-health/status.ts"
      to: "effectiveCronJob pause labels (cron-registry.ts:515-519)"
      via: "effective job (status.ts:196) passed to pausedHealthDetail; shown at data-health-dashboard.tsx:219 as job.healthDetail"
      pattern: "pausedHealthDetail\\(job\\)"
---

<objective>
`evaluateCronJobStatus` shows "Automatic credit alerts are paused; saved preferences are retained." for EVERY paused job. The sentence was written in ea66403 (2026-09-11), when `line_credit_digest` was the only paused job; later pauses (fb779b4 Wise/classroom, de9be21 feedback autowriter, 908e6e4 Tutor Sit-ins) inherited it. Make each paused job say its own reason, and fail-close `canRunManually` on the watchdog's two synthetic rows. Output: 2 commits, no push or PR.
</objective>

<execution_context>
@$HOME/.claude/get-shit-done/workflows/execute-plan.md
@$HOME/.claude/get-shit-done/templates/summary.md
</execution_context>

<context>
- Work ONLY in /Users/kevinhsieh/Developer/Scheduling-paused-detail; never touch /Users/kevinhsieh/Developer/Scheduling, -run-dispatch or -post-class-run-parity. Prefix every Bash call with `cd /Users/kevinhsieh/Developer/Scheduling-paused-detail && export PATH="/opt/homebrew/opt/node@22/bin:$PATH" &&`.
- Do NOT edit src/lib/data-health/cron-registry.ts. It is CODEOWNERS-protected, and the unpushed DEF-3 branch edits its interface and tail. DEF-3 touches none of this plan's 4 files and keeps the pause labels. src/lib/internal/ is CODEOWNERS-protected (Kevin reviews); status.ts is not.
- Facts verified at 19e6c26; a planner probe ran both test designs against this code:
  - Pause labels live in cron-registry.ts:515-519. WISE_CLASSROOM_JOBS (wise_snapshot, classroom_morning, classroom_publish_recovery, classroom_admin_email, classroom_weekend_check) get "Paused by owner" unless WISE_CLASSROOM_AUTOMATION_ENABLED is "true". feedback_autowriter gets "Feedback autowriter disabled" unless FEEDBACK_AUTOWRITER_ENABLED is "true". tutor_sit_ins* gets "Tutor Sit-ins disabled" unless TUTOR_SIT_INS_ENABLED is "true".
  - vitest.config.ts sets WISE_CLASSROOM_AUTOMATION_ENABLED="true" and CREDIT_CONTROL_MODE="active" at load, so tests must call `vi.stubEnv(name, undefined)` explicitly, as operations-pause.test.ts:29 does.
  - cron-watchdog.ts:128 and :188 use `canRunManually: <def>?.manualOnly ?? true`. Both source jobs are registered with manualOnly: false, so today both rows already return false. They return true only if the definition goes missing (fail-open) or becomes manual-only (wrong field). No non-test code reads canRunManually; registry rows use `!job.paused` (dashboard.ts:498).
@src/lib/data-health/status.ts
@src/lib/data-health/__tests__/status.test.ts
@src/lib/internal/cron-watchdog.ts
@src/lib/internal/__tests__/cron-watchdog.test.ts
</context>

<tasks>
<task type="auto" tdd="true">
  <name>Task 1: Paused jobs state their own reason (status.ts)</name>
  <files>src/lib/data-health/__tests__/status.test.ts, src/lib/data-health/status.ts</files>
  <behavior>Paused line_credit_digest keeps the exact credit sentence. wise_snapshot and classroom_morning give "Paused by owner; no run is expected until it is re-enabled."; feedback_autowriter and tutor_sit_ins give their own label with the same suffix. None of these mention "credit".</behavior>
  <action>
RED:
- In the existing "reports paused alerts without stale or failure alarms" case, add `expect(result.healthDetail).toBe("Automatic credit alerts are paused; saved preferences are retained.");`.
- Append `describe("paused job health detail", …)` with its own `afterEach(() => vi.unstubAllEnvs())`; only the credit describe has one today. Inside it, add an `it.each` over `[key, envName, label]` rows: [wise_snapshot, WISE_CLASSROOM_AUTOMATION_ENABLED, "Paused by owner"], [classroom_morning, WISE_CLASSROOM_AUTOMATION_ENABLED, "Paused by owner"], [feedback_autowriter, FEEDBACK_AUTOWRITER_ENABLED, "Feedback autowriter disabled"], [tutor_sit_ins, TUTOR_SIT_INS_ENABLED, "Tutor Sit-ins disabled"].
- Each row: call `vi.stubEnv(envName, undefined)`, then `evaluateCronJobStatus` with `job(key)`, `now: new Date("2026-06-01T01:20:00.000Z")` and all six evidence fields null. Assert status "paused", healthDetail toBe `${label}; no run is expected until it is re-enabled.`, and `healthDetail.toLowerCase()` not containing "credit".
- Run the file. Exactly the 4 new rows must fail, with Received "Automatic credit alerts are paused; saved preferences are retained.". Never commit RED.
GREEN:
- Just above `evaluateCronJobStatus`, add a private `function pausedHealthDetail(job: CronJobDefinition): string`. Give it a short JSDoc saying the reason is the effective job's cadenceLabel set by effectiveCronJob (single source of truth), and that the LINE credit digest keeps its original sentence because pausing it retains saved preferences.
- Body: `if (job.key === "line_credit_digest") return "Automatic credit alerts are paused; saved preferences are retained.";`, then return `` `${job.cadenceLabel}; no run is expected until it is re-enabled.` ``.
- At status.ts:215, replace only the paused arm with `job.paused ? pausedHealthDetail(job) : disabled ? …`, keeping the weekend and manual-only sentences. Pass the effective `job` (status.ts:196), never `input.job`, whose cadenceLabel is the schedule text. No new imports.
COMMIT after <verify> passes: `git add src/lib/data-health/status.ts src/lib/data-health/__tests__/status.test.ts && git commit -m "fix(260929-rta): say why each paused job is paused on Data Health" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"`.
  </action>
  <verify><automated>npm run typecheck && npm run lint && npx vitest run --project unit src/lib/data-health/__tests__/status.test.ts</automated></verify>
  <done>The 4 new rows and the extended credit assertion pass, all pre-existing status tests pass, and one commit contains exactly these 2 files.</done>
</task>
<task type="auto" tdd="true">
  <name>Task 2: Synthetic watchdog rows never offer a Run action (fail-closed)</name>
  <files>src/lib/internal/__tests__/cron-watchdog.test.ts, src/lib/internal/cron-watchdog.ts</files>
  <behavior>payoutWindowJobHealth and deadlineCoverageJobHealth both return canRunManually false, whether the source registry definition is actual, missing (null) or manual-only.</behavior>
  <action>
RED. The real registry already yields false, so the test must drive the fallback paths:
- Below `vi.mock("server-only", () => ({}));`, add a one-line comment explaining why, then mirror src/lib/post-class-feedback/__tests__/deadline-coverage.test.ts:15-28 with `const registry = vi.hoisted(() => ({ mode: "actual" as "actual" | "missing" | "manual-only" }));` and `vi.mock("@/lib/data-health/cron-registry", async (importOriginal) => { const actual = await importOriginal<typeof import("@/lib/data-health/cron-registry")>(); return { ...actual, getCronJobDefinition: (key: string) => { const definition = actual.getCronJobDefinition(key); if (registry.mode === "missing") return null; return registry.mode === "manual-only" && definition ? { ...definition, manualOnly: true } : definition; } }; });`.
- Add `afterEach` to the vitest import, and import `deadlineCoverageJobHealth` and `payoutWindowJobHealth`. Append `describe("synthetic watchdog rows", …)` with `afterEach(() => { registry.mode = "actual"; })`.
- Inside it, add `it.each(["actual", "missing", "manual-only"] as const)("never offer a Run action when the source definition is %s", …)`. Set `registry.mode`, then assert `payoutWindowJobHealth(payoutWindow()).canRunManually` and `deadlineCoverageJobHealth(deadlineCoverage()).canRunManually` are both `false`, reusing the existing fixtures.
- Run the file. "missing" and "manual-only" must fail (Received true); "actual" and all 31 existing tests must pass. Never commit RED.
GREEN: at cron-watchdog.ts:128 and :188, set `canRunManually: false,` with `// A synthetic health row has no Run action of its own (fail-closed).` above each. Change no other field.
COMMIT after <verify> passes: `git add src/lib/internal/cron-watchdog.ts src/lib/internal/__tests__/cron-watchdog.test.ts && git commit -m "fix(260929-rta): synthetic watchdog rows never offer a Run action" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"`.
  </action>
  <verify><automated>npm run typecheck && npm run lint && npx vitest run --project unit src/lib/data-health src/lib/internal src/components/data-health src/app/api/data-health</automated></verify>
  <done>The 3 new rows and all 31 existing watchdog tests pass, typecheck, lint and the 4 unit suites are green, and one commit contains exactly these 2 files.</done>
</task>
</tasks>

<threat_model>
Trust boundary: registry code → admin UI and watchdog email. Only static label strings cross it; there is no user input.
| Threat ID | Category | Component | Disposition | Mitigation Plan |
|---|---|---|---|---|
| T-rta-01 | I | status.ts pausedHealthDetail | accept | Echoes only static cadenceLabel constants, never env values. Paused jobs are not alertable, and the email path already runs escapeHtml. |
| T-rta-02 | E | cron-watchdog.ts synthetic rows | mitigate | Unconditional `canRunManually: false`: a non-registry key is never offered a Run action, even if its source definition disappears. |
</threat_model>

<verification>
- `git log --oneline 19e6c26..HEAD` shows exactly the 2 fix(260929-rta) commits. `git show --stat --format= HEAD~1` and `git show --stat --format= HEAD` each list only their task's 2 files.
- `grep -c "manualOnly ?? true" src/lib/internal/cron-watchdog.ts` returns 0, and `grep -c "canRunManually: false"` on the same file returns 2.
- `git diff 19e6c26 --stat -- src/lib/data-health/cron-registry.ts` is empty, and `git status --short` shows only the SUMMARY file.
</verification>

<success_criteria>All must_haves truths hold, the Task 2 verify command is green, cron-registry.ts is untouched, and nothing is pushed.</success_criteria>

<source_audit>
- GOAL → Task 1. REQ RTA-PAUSED-DETAIL → Task 1; RTA-SYNTHETIC-NO-RUN → Task 2. CONTEXT Bug 1 (helper, credit sentence kept, `${cadenceLabel}; no run is expected…`, no registry edit) → Task 1. Bug 2 (`canRunManually: false` plus fail-closed comment) → Task 2. Tests (extend the credit case, it.each with env stubs and unstub, builders return false) → Tasks 1 and 2. Nothing unplanned; no deferred items.
</source_audit>

<output>After completion, create `.planning/quick/260929-rta-fix-misleading-paused-job-text-on-data-h/260929-rta-SUMMARY.md`.</output>
