---
phase: quick-260907-qg5
plan: "01-task-2"
subsystem: infra
tags: [github, codeowners, node24, claude-code, windows, onboarding]
requires:
  - phase: quick-260907-qg5-task-1
    provides: Owner API, current-session checks, preview OAuth policy
provides:
  - Scoped protected-file ownership and removal of Sales Dashboard-only restrictions
  - Five unchanged required-check names on Node.js 24 with matching package engines
  - Aoeng's Windows Claude/GSD browser-preview publishing guide
  - Kevin's independent website, GitHub, and preview revocation runbook
affects: [collaborator-publishing, owner-access, preview-provisioning]
tech-stack:
  added: []
  patterns: [persistent-preview-branch, code-owner-review-for-sensitive-controls]
key-files:
  created: [docs/operations/aoeng-windows-setup.md, docs/operations/owner-access-runbook.md]
  modified: [.github/CODEOWNERS, .github/workflows/ci.yml, package.json, package-lock.json, .claude/README.md, docs/operations/auth-and-access.md, docs/reference/env.md]
key-decisions:
  - "Protect the route-surface baseline as well as its release-guard script."
  - "Use native Windows PowerShell with npm.cmd/npx.cmd and browser-hosted previews; no production credentials or local app/database."
  - "Pin GSD 1.42.3 and its verified global Claude /gsd-quick routing; explain older colon commands only as migration context."
requirements-completed: []
requirements-supported: [INDEPENDENT-PUBLISHING, WINDOWS-SETUP, OWNER-REVOCATION, PREVIEW-ISOLATION]
duration: tracked by root execution
completed: 2026-09-07
---

# Task 2: Aoeng publishing controls and Windows handbook

**Scoped Kevin-only ownership replaces blanket review and Sales Dashboard restrictions; Aoeng's guide covers native Windows Claude/GSD setup and persistent-preview publishing.**

## Task commit

- `b178b3c` — `chore(260907-qg5): enable cross-feature publishing and document Aoeng setup`
- 18 owned source/configuration/documentation files changed. No task-1 source, root preview script, PLAN, STATE, or live settings were committed by this task.

## Delivered

- CODEOWNERS protects auth/session/Proxy/owner controls, feature access/API guards, schema/migrations, dependencies, hosting/configuration, all GitHub controls/scripts, route-surface baseline, preview/env/cron controls, and agent instructions. Ordinary feature files have no blanket owner rule.
- All five existing check names remain `lint`, `typecheck`, `unit-tests`, `build`, and `release-guards`; each uses Node 24. Package and lockfile root metadata specify `24.x`, without dependency changes.
- Removed the Sales Dashboard scope workflow, npm script, checker, local Claude hook, and obsolete hook configuration. Updated the local migration instructions to preserve existing GSD hooks/settings, and removed the stale rule from the handbook-generation notes.
- Added the Windows guide with own-account login, Git/Node24/gh/native-Claude installation, pinned GSD setup, startup checks, branch refresh, reusable change/preview/repair/publish prompts, five-check explanation, merge commits with branch retention, and troubleshooting.
- Added the owner runbook for current-session revocation, versioned API and audit, owner recovery, distinct GitHub/preview revocation, database/secret isolation, protected rules, rollout, and rollback.
- Updated handbook entry points, README/CLAUDE publishing instructions, auth model, Node Proxy references, environment reference, and deployment runbook.

## Verification

- `git diff --check` passed.
- `npm run guard:production-route-surface` passed: 232 source routes present at verification time.
- Contributor-control assertions passed: 28 protected control paths, 6 ordinary example paths, owner identity, five exact CI job names/Node24 setup, package-lock engine consistency, and removal of all three obsolete restrictions. The CI workflow was parsed as YAML.
- Both new guides' local links were checked: seven resolve; the linked root completion record is intentionally pending root's final summary creation.
- `npm run lint` found five pre-existing errors in ignored local `.payout-ops/fen-2026` artifacts. They were not changed. `npm run lint -- --ignore-pattern '.payout-ops/**'` passed with 0 errors and 19 existing warnings. See `deferred-items.md`.
- Installation guidance checked against official Git, GitHub CLI, Node, and Anthropic documentation. GSD 1.42.3's published npm installer was inspected for `--claude --global` and global skill routing; the installed Claude 1.38.3 GSD help/skill names also use hyphens.
- Windows commands were not executed on a Windows host. The local shell is Node 20.20.2; root owns Node24/full-release execution and live GitHub rule verification.
- Stub scan found no new executable/UI placeholders. This task adds no network endpoint or new trust-boundary schema; its ownership controls address T-QG5-04 from the plan.

## Deviations from Plan

**[Rule 3 - Blocking] Removed inherited local scope restrictions and regeneration references.** The plan's explicit files omitted the Claude hook, local settings template, and documentation generator's scope-guard note. Leaving them would keep Aoeng's older setup restricted or regenerate incorrect instructions. Removed only the obsolete Sales Dashboard hook entries/script and updated the associated docs; preserved local secret/destructive-command restrictions and left private local settings untouched. Included in `b178b3c`.

## Remaining root-owned work

- Insert the actual verified stable preview URL into the Windows guide after deployment; it currently points readers to the PR's deployment link and Kevin's shared stable link without inventing a hostname.
- Confirm live branch protection/rulesets, preview sharing, separate OAuth, production deployment, and all integration/preview-isolation checks. Source changes do not attest these live settings.
- Create the final execution record linked from the owner runbook and include this DOCS-SUMMARY plus `deferred-items.md` in the final metadata commit.
- Record invitation acceptance and Aoeng's first Google login/Windows run separately from automated setup evidence.

## Deferred Issues

Ignored local payout-operation lint errors and unrelated baseline warnings remain unchanged; details are in `deferred-items.md`.

## Self-Check: PASSED

Both created guides and this summary exist. Commit `b178b3c` exists and contains the 18 owned changes. No source placeholders prevent the task-2 deliverables; live preview URL/settings and final metadata remain explicitly root-owned.
