# Kevin's access and publishing runbook

Kevin remains the BGScheduler owner: website identity `kevhsh7@gmail.com`, GitHub owner `kasheesh711`, and existing Vercel project/team owner. Aoeng develops as GitHub `aoengnatchasmith-spec` and signs into the website and protected preview as `aoengnatchasmith@gmail.com`.

This page describes operating the new controls. Deployment, invitation, and first-login evidence belongs in the [setup execution record](../../.planning/quick/260907-qg5-implement-aoeng-editing-access-owner-con/260907-qg5-SUMMARY.md); a documented procedure is not proof that an external setup step has completed. Aoeng's instructions are in the [Windows guide](./aoeng-windows-setup.md).

## Three independent permissions

| Permission | Current intended access | Where Kevin controls it |
|---|---|---|
| Website | Existing admin accounts preserved; Aoeng and `k.waritpariya@gmail.com` receive Unearned Revenue `viewer`; Kevin retains `viewer` and is its sole `access_manager` | **Manage Access** for website enable/disable; Unearned Revenue's access control for feature grants |
| Code and publishing | Aoeng retains GitHub **Write**; ordinary PRs can merge after checks, protected files require Kevin's review | [Repository collaborators](https://github.com/kasheesh711/bgscheduler/settings/access), branch protection, and `CODEOWNERS` |
| Protected preview | Aoeng receives access to her protected preview, without broad Vercel team membership | Vercel deployment **Share** settings |

Disable all three when removing the collaboration completely. Website access does not confer repository ownership, and disabling a website account does not revoke its GitHub or Vercel permissions. This setup grants trusted application-code publishing: CODEOWNERS makes sensitive changes reviewable, but is not a sandbox for arbitrary code.

## Disable or restore website access

1. Sign into the [live website](https://bgscheduler.vercel.app) as `kevhsh7@gmail.com`.
2. Open [Manage Access](https://bgscheduler.vercel.app/admin/users). The navigation link is owner-only.
3. Find the exact email and choose **Disable access**. Wait for the saved state.
4. The next protected request from that account is denied, including an existing browser session or a manual-sync endpoint using session authentication. An already-running request or content already downloaded cannot be recalled.
5. To restore access, choose **Enable access**. The user must sign in again; their old session remains invalid.

The page labels configured owners **Website owner** and offers no toggle for them. `SUPER_ADMIN_EMAILS=kevhsh7@gmail.com` is the production owner designation; it only works together with a current, enabled `admin_users` row. The API rejects attempts to edit any configured owner.

Both Proxy and server `auth()` reread admin status and compare the session's `adminAccessVersion` with `admin_users.access_version`. An actual toggle increments the version. Database errors deny protected access. All admins need one fresh login after the initial release because older cookies contain no version.

Changing website status preserves feature grants and `allowedPages`. If the same email also has a tutor or admissions membership, a disabled admin row denies sign-in instead of falling through to that role. To revoke only Unearned Revenue viewing, use that feature's audited access mechanism instead of disabling the entire website account.

### API and audit evidence

The owner page calls these authenticated endpoints:

| Endpoint | Contract |
|---|---|
| `GET /api/admin/users` | `{rows:[{email,name,disabled,accessVersion,isOwner}]}` |
| `PATCH /api/admin/users` | Body `{email,disabled,expectedVersion}`; success `{row}` |

An absent session returns `401`, a nonowner or owner target returns `403`, unknown target `404`, invalid input `400`, and a stale expected version `409`. On `409`, reload before making a new decision. An exact-version no-op for a nonowner leaves the row unchanged. Other server errors are denied, not treated as success.

An actual toggle updates the row and appends `admin_user_access_audit_log` in one transaction. The audit records `target_email`, `actor_email`, before/after `{disabled,accessVersion}`, the new version, and time. The actor comes from the validated session, never the submitted body. Do not edit or remove audit entries.

### Owner recovery

If Manage Access is unavailable, first sign out and back in as Kevin, then check the deployed `SUPER_ADMIN_EMAILS` value and the enabled owner row using an owner-controlled environment. Correcting a missing environment variable requires a new deployment. Do not run the general seed script to repair one account; it may reapply unrelated page restrictions.

If someone changed the owner row directly outside the application, use Kevin's database-owner connection to repair only that row in a transaction: preserve its existing `allowed_pages`, set `disabled=false`, increment `access_version`, and append the corresponding before/after record to `admin_user_access_audit_log`. Review the transaction against the current schema before applying it. Do not lower/reset the version or erase history. Kevin then signs in again. Database credentials stay with Kevin.

## Revoke publishing and preview access

### GitHub

Open [repository collaborators](https://github.com/kasheesh711/bgscheduler/settings/access), locate **`aoengnatchasmith-spec`**, and remove that collaborator's Write access. Confirm there is no separate team grant. Preserve your ownership, other collaborators, and repository visibility.

Review and close any unmerged PR from `codex/aoeng-preview` that should no longer ship. Check for an in-progress deployment separately; removing GitHub permissions does not cancel a deployment already started. Removing collaboration prevents new authorized pushes and merges, but does not erase downloaded code or make a public repository private.

### Protected preview

In the BGScheduler Vercel project, open the latest `codex/aoeng-preview` deployment and its **Share** settings. Remove `aoengnatchasmith@gmail.com` from the deployment/branch-domain access list and cancel a pending invitation if present. Review older deployments and any shareable links or protection-bypass links created for this collaboration; revoke those too. Verify the branch URL again while signed out. [Vercel deployment sharing](https://vercel.com/docs/deployments/sharing-deployments) describes the sharing controls.

If ending access completely, also disable Aoeng's website account in the **preview database**. Production and preview have separate admin state. Disable it before revoking the preview's sharing grant if you need access to the preview owner page. Do not remove unrelated Vercel team members or grants.

## Keep the publishing rules intact

The policy for `main` is:

- Pull requests required; **0** blanket human approvals for ordinary files.
- **Required code-owner review enabled**. [`.github/CODEOWNERS`](../../.github/CODEOWNERS) names `@kasheesh711` for auth/access/owner controls, database and migrations, dependency manifests, hosting/cron configuration, CI/scripts/release guards, preview policy, and agent instructions. It protects itself through `/.github/`.
- Required checks: **`lint`, `typecheck`, `unit-tests`, `build`, `release-guards`**. CI and package metadata use **Node.js 24**.
- Dismiss stale approvals on changed code. **Require approval of the most recent reviewable push disabled**. No force pushes or branch deletion.
- Merge commits enabled. Preserve the persistent **`codex/aoeng-preview`** branch; automatic branch deletion must not remove it.

Check both classic branch protection and any repository rulesets, including bypass lists. Adding a new access or release-control file should include a matching CODEOWNERS rule in the same PR if the existing patterns do not cover it. An ordinary feature change and a protected-file change must demonstrate the intended merge behavior before loosening blanket review settings. [GitHub protection reference](https://docs.github.com/en/rest/branches/branch-protection).

The old Sales Dashboard-only CI workflow, script, and Claude scope hook are removed. Aoeng's installed local settings may still reference the deleted hook; the [Claude migration note](../../.claude/README.md) explains how to remove only those obsolete entries.

## Maintain the isolated preview

The [stable preview](https://bgscheduler-git-codex-aoeng-preview-kevins-projects-6ebb4efc.vercel.app) belongs to **`codex/aoeng-preview`**; production deploys from **`main`**. Keep the existing repository visibility and Vercel ownership. Share this preview directly rather than adding a Vercel team role spanning other projects.

Provisioning and refreshes are owner operations:

1. Use a distinct preview database and a restricted login with a distinct password. A separate database on the same Neon project/endpoint is acceptable only after verifying that the preview login cannot read or write production tables or create objects in production. Existing cluster-level connection permission is not permission to access production data. Do not change unrelated production grants to make the preview work.
2. Copy a consistent slice of active snapshots and representative feature data with valid references. Production contains extensive historical data; copying all old snapshots is unnecessary. Preserve the data needed to render Unearned Revenue and the pages being tested.
3. Remove copied Google OAuth/access/refresh tokens, integration credentials, resolver tokens, and public capability links before use. Check database-stored credentials as well as environment variables. Keep any representative personal data inside the protected preview.
4. Configure isolated Preview environment values on the existing Vercel project. This setup isolates all new preview deployments on the project; the shared Google login callback belongs to Aoeng's stable branch. `DATABASE_URL`, `AUTH_SECRET`, `CRON_SECRET`, and Google OAuth credentials must be distinct from production. Remove production Wise, LINE, email, Sheets/Drive, AI, and other external integration credentials, including inherited/shared values.
5. Keep `PREVIEW_SANDBOX_ENABLED=true` for this preview and disable every external-write/messaging flag. `VERCEL_ENV=preview` also activates the runtime policy. Preview OAuth requests only `openid email profile` and never stores integration tokens. There must be no credential fallback to a production secret or copied database token.
6. Use a **separate Google OAuth web client**. Its authorized redirect URI is the verified stable preview origin plus `/api/auth/callback/google`. Configure the preview's authentication/base URLs to that same stable origin. Do not use an ephemeral per-deployment hostname as the shared callback.
7. Before sharing, verify preview login, the visible preview banner, representative dashboard data, and rejection of outbound integrations without performing a real send. Verify production and preview credentials differ without printing them. Recheck separation after every data refresh.

The [environment reference](../reference/env.md#owner-controls-and-collaborator-preview) lists the runtime variables. Never download production environment values to Aoeng's computer or place secrets in the setup guide, issues, screenshots, PRs, or Git.

Preview sharing and Google OAuth creation may require an owner account's browser login or consent. Record any incomplete step explicitly and finish it before inviting Aoeng to test; do not substitute production OAuth credentials to hide a setup gap.

## Rollout and rollback

For the initial release, apply the additive admin migration before deploying the code that queries its new columns. Set the owner environment variable, establish preview database/secret isolation, and land protected CODEOWNERS/configuration before relaxing blanket review requirements. Verify the two Unearned Revenue viewer grants through the existing audited capability service while preserving Kevin as the sole access manager.

After each ordinary PR merges, verify the production deployment is ready and inspect the changed page. The preview's merge commit should contain the same change Aoeng approved. If a newer push arrives after review, check that preview again before publishing.

If production breaks, use Vercel's **Instant Rollback** on a known-good deployment of the existing BGScheduler project. Then prepare and merge a revert PR so `main` matches the restored behavior; otherwise the next deployment can reintroduce the fault. [Vercel rollback documentation](https://vercel.com/docs/instant-rollback).

A deployment rollback changes code, not database data or audit history. Retain additive columns/tables; inspect compatibility before choosing a release older than the access-controls migration. In particular, old authentication code may not honor disabled accounts. For an access incident, prefer restoring a known-good release that includes immediate revocation, or keep the site in owner-only maintenance while the fix is reviewed. See the [general runbook](./runbook.md) for the guarded manual deploy path and maintenance procedure.

## Record the handoff accurately

Track these independently in the execution record: production rollout; viewer grants and audits; branch protection; preview database/secret isolation; separate OAuth client and working callback; stable preview URL; preview invitation sent; invitation accepted; Aoeng's first Google login; and first successful preview-to-production change.

Record Windows verification accurately. Vendor-reviewed commands and passing CI are useful evidence; they do not establish that Aoeng completed the installation on her own computer.
