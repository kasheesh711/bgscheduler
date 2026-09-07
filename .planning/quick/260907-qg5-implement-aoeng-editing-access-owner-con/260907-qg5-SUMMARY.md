---
phase: quick-260907-qg5
plan: "01"
subsystem: auth-and-collaboration
status: deployed-handoff-pending
requirements-completed: [AOENG-ACCESS, OWNER-REVOCATION, WINDOWS-SETUP]
requirements-partially-completed: [PREVIEW-ISOLATION, INDEPENDENT-PUBLISHING]
completed: 2026-09-07
---

# Aoeng access and Windows setup — execution record

Owner controls and both Unearned Revenue viewer grants are live. The isolated preview works, including Google login. The remaining external handoff is verification of Aoeng's Vercel sharing invitation; her invitation acceptance, own-account login, and Windows installation are separate user steps.

## Delivered release

[PR #49](https://github.com/kasheesh711/bgscheduler/pull/49) merged to `main` as `44f7190cfdc53b2a52aec762a150b40d96f0bad0`. Production deployment `dpl_9xUNHe8ERNBvkTBpYvFLctwwx9Pu` is Ready and owns [bgscheduler.vercel.app](https://bgscheduler.vercel.app).

- `8174ce7` — owner/auth test contracts.
- `1efd552` — owner controls, additive migration, immediate session revocation, preview auth policy and banner.
- `e7c7948` — application verification record.
- `b178b3c` — scoped publishing, Node 24 CI, removal of Sales Dashboard restrictions, Windows guide and owner runbook.
- `b08b6cc` — isolated preview data provisioning script and verified stable preview link.

The additive `0078_admin_access_controls.sql` migration was applied to production and preview before the owner-control release. It adds `admin_users.disabled`, `access_version`, and the append-only `admin_user_access_audit_log` with an update/delete rejection trigger.

## Live access

| Account | Verified state |
|---|---|
| `aoengnatchasmith@gmail.com` | Existing unrestricted website admin preserved; Unearned Revenue `viewer` added through the audited capability service |
| `k.waritpariya@gmail.com` | Existing unrestricted website admin preserved; Unearned Revenue `viewer` added through the audited capability service |
| `kevhsh7@gmail.com` | Existing website admin preserved; sole configured super-admin and sole Unearned Revenue `access_manager`, also retains `viewer` |
| GitHub `aoengnatchasmith-spec` | Existing repository Write permission preserved |
| GitHub `kasheesh711` / existing Vercel owner | Ownership preserved; no broad Vercel team membership added |

The two new revenue grant versions are `1788782688`; Kevin's existing grant version remains `1788467016`. Audits attribute the grants to Kevin with the authorized onboarding purpose. Existing page scopes and unrelated grants were retained.

[Manage Access](https://bgscheduler.vercel.app/admin/users) uses owner-only GET/PATCH APIs and optimistic versions. State change and audit append are atomic. Owners cannot be disabled through the interface/API. Proxy and server authentication check current admin state and version on protected requests, including manual cron routes using session fallback. Database errors deny access. Re-enabling never revives an old session. Existing admins must sign in once after this release because legacy cookies have no access version.

## Isolated preview

Bookmark [Aoeng's preview](https://bgscheduler-git-codex-aoeng-preview-kevins-projects-6ebb4efc.vercel.app), backed by persistent branch `codex/aoeng-preview`. Working deployment verified before production rollout: `dpl_8AGBsR16NQzeb74AXLfhD5E87Eqe`, commit `b08b6cc`.

- Distinct database `bgscheduler_aoeng_preview_20260907` and login `bgscheduler_aoeng_preview`, with distinct credentials and no superuser/create-role/create-database/bypass-RLS powers.
- Preview login cannot read or modify production tables or create production objects. Existing cluster-level CONNECT permission was preserved; it grants no table access.
- Copied a consistent current snapshot and representative dashboard data through an explicit allowlist of 41 tables. Production's extensive historical snapshots were not copied. The provisioning script refuses to refresh an already populated preview.
- OAuth/integration tokens, resolver tokens and public capability links were excluded. `google_oauth_tokens` remained empty after an actual owner Google login.
- Preview database, auth, cron and Google OAuth credentials differ from production. Preview targets were removed from shared production integration credentials; production/development targets were preserved. All new project preview deployments use the isolated values.
- External-write/messaging/AI flags are disabled. Preview has no usable production Wise, LINE, email, Google Sheets/Drive or other external integration credentials. Required Wise environment fields contain unusable preview-only placeholders.
- A separate Google web OAuth client named **BGScheduler Aoeng Preview** has only the stable preview callback. Google login requests `openid email profile` and stores no integration tokens. Actual Kevin Google login completed successfully.
- Preview banner is visible. Production renders without it. Temporary per-deployment URLs are not alternate Google callbacks; use the stable bookmark.

Credentials are held only in owner-controlled environment/private operator storage. No secrets are included in Git, these guides, PR descriptions, or Aoeng's local setup.

## Publishing controls

`main` requires pull requests and `lint`, `typecheck`, `unit-tests`, `build`, and `release-guards`, with up-to-date branches. CI and production use Node.js 24. Required blanket approval count is zero; required code-owner review and stale-review dismissal are enabled; last-push approval is disabled. Force-pushing and deleting `main` remain prohibited. Merge commits and persistent branch retention are preserved. No other rulesets apply.

CODEOWNERS protects authentication/access/owner-management, schema/migrations, dependencies, hosting/cron configuration, CI/scripts/release guards, preview policy and agent instructions, including CODEOWNERS itself. GitHub's CODEOWNERS validation returned no errors. Ordinary feature paths have no blanket owner rule. The old Sales Dashboard-only CI and Claude hook restrictions were removed.

Protected-file enforcement was tested with [PR #51](https://github.com/kasheesh711/bgscheduler/pull/51), created by the automation account rather than Kevin. After its own five checks passed, merge state remained `BLOCKED`. Kevin's approval changed it to `CLEAN`. The probe changed only a CODEOWNERS comment and was closed without merging. Owner-authored probe PR #50 was also closed; both temporary probe branches were deleted. The temporary permission allowing Actions to create the probe PR was restored to its original disabled value, with read-only default workflow permissions preserved.

The final documentation handoff is published through the persistent preview branch using an ordinary pull request and a merge commit, without `--admin` and without deleting the branch. Its final outcome is recorded in the task completion response.

## Verification

- Full unit suite: **415 files, 4,786 tests passed**.
- Full database integration suite: **22 files, 208 tests passed**, against ephemeral PostgreSQL.
- Node 24 typecheck and production build passed. Production route-surface guard passed for 232 source routes. `git diff --check` passed.
- [PR #49 CI](https://github.com/kasheesh711/bgscheduler/actions/runs/34121517832): all five required checks passed, including clean-checkout lint.
- Local full lint also scans ignored `.payout-ops` operational artifacts and reports five pre-existing errors there. Tracked-source lint passed with existing warnings; those unrelated files were preserved. See [deferred items](./deferred-items.md).
- Deployed preview: both revenue viewers received 200 for dashboard data and 403 for both revenue access-management and website owner-management APIs. Kevin alone is the owner. Owner self-edit was denied.
- A synthetic preview-only admin was disabled, denied on a page/API/manual-sync fallback using its existing session, and re-enabled. Its old session remained denied; a fresh versioned session succeeded. Stale update returned 409. Exactly two correct actor/before/after audit entries were retained; the synthetic admin was removed.
- Production read-only smoke: both viewer dashboard APIs returned 200; both access-management APIs returned 403. Kevin's owner API/page returned 200, completed rendering, and displayed no preview banner. Legacy sessions were denied at the API and manual sync fallback and redirected from the page.
- Automated identity tests use short-lived test session tokens; they do not claim either invited person has personally signed in.

## Guides and handoff tracking

- [Aoeng's Windows guide](../../../docs/operations/aoeng-windows-setup.md): native Git/Node24/GitHub CLI/Claude Code, own accounts, pinned GSD 1.42.3, no local server/database, stable preview, reusable prompts, five checks, merge commits and recovery.
- [Kevin's owner runbook](../../../docs/operations/owner-access-runbook.md): website/GitHub/preview revocation, owner recovery, isolation maintenance and rollback.

| Item | Status |
|---|---|
| Production controls and audited viewer grants | Verified live |
| Preview database, secret separation, callback and owner Google login | Verified live |
| Vercel sharing invitation for Aoeng | API request submitted; successful response contains no verifiable grant. Browser verification pending because the Mac is locked. Do not count this as a confirmed invitation. |
| Aoeng invitation acceptance | Not verified; requires her action |
| Aoeng first preview Google login | Not verified; requires her action |
| Windows installation on Aoeng's computer | Vendor/package instructions validated; not executed on a Windows host |
| Aoeng first independently authored publish | Not verified; requires her first change |

The owner browser handoff is the remaining external setup gate. Unlocking the Mac is required to inspect/complete Vercel's Share dialog. No automatic unlock or team-membership substitute was attempted.
