# Aoeng's Windows setup and publishing guide

Aoeng, you can use Claude Code to improve BGScheduler, check your work in a browser, and publish everyday changes. You describe the result; Claude handles the code, tests, and pull request.

Your computer needs the code and development tools. The preview runs on Vercel with its own database. You do not need a local database, a local website server, or production passwords.

## Your accounts and links

| Use | Account or link |
|---|---|
| Sign into BGScheduler with Google | `aoengnatchasmith@gmail.com` |
| Sign into GitHub | **`aoengnatchasmith-spec`** — this is your GitHub username, not your email |
| Live website | [bgscheduler.vercel.app](https://bgscheduler.vercel.app) |
| Code and pull requests | [kasheesh711/bgscheduler](https://github.com/kasheesh711/bgscheduler) |
| Your working branch | `codex/aoeng-preview` |
| Your browser preview | [Open Aoeng's preview](https://bgscheduler-git-codex-aoeng-preview-kevins-projects-6ebb4efc.vercel.app) — bookmark this link |
| Claude Code | Sign in with your own Claude account and plan that includes Claude Code |

Your Unearned Revenue permission is **viewer**. Editing the website's code is a separate GitHub permission. Kevin owns the repository and hosting, manages website access, and approves changes to security, database structure, and publishing controls.

For a protected preview, accept Kevin's Vercel preview invitation using `aoengnatchasmith@gmail.com`. Vercel may ask you to sign into your own account first; then BGScheduler asks you to sign in with Google. These are two separate sign-ins. You do not need to join Kevin's Vercel team.

An invitation is not proof that you have signed in successfully. Complete the first-preview check below after Kevin confirms the preview is ready.

## 1. Install the tools once

These instructions use **Windows PowerShell**, which comes with Windows. Press **Win + X → Terminal** or **Windows PowerShell**. The prompt should start with `PS`. Paste one command at a time, press Enter, and wait for it to finish.

### Git and GitHub CLI

Run these two commands. Accept the Windows installation prompt if one appears:

```powershell
winget install --id Git.Git -e --source winget
winget install --id GitHub.cli -e --source winget
```

Git saves versions of your work; GitHub CLI lets Claude prepare and publish pull requests. These are the official [Git for Windows](https://git-scm.com/install/windows) and [GitHub CLI Windows](https://github.com/cli/cli/blob/trunk/docs/install_windows.md) installation methods. If `winget` is unavailable, use the installers linked on those pages.

### Node.js 24

Open the [official Node.js download page](https://nodejs.org/en/download). Choose **Node.js 24.x**, **Windows**, and **Windows Installer (.msi)**. Use x64 for a typical Windows computer or ARM64 if Windows Settings → System → About identifies an ARM processor. Run the installer with its default options; extra native build tools are not needed for this setup.

Close PowerShell and open a new window so it can find the installed tools. Check:

```powershell
git --version
gh --version
node --version
npm.cmd --version
```

Each command should print a version. Node must start with **`v24.`**. The `.cmd` spelling for npm avoids PowerShell's script-policy error without changing your computer's security settings.

### Claude Code

If Claude Code already works on your computer, keep your existing installation. Otherwise, run the native installer from the [official Claude Code Windows setup guide](https://code.claude.com/docs/en/installation):

```powershell
irm https://claude.ai/install.ps1 | iex
```

Close and reopen PowerShell, then check:

```powershell
claude --version
```

It should print a version. You will sign in when you start Claude in the project below. Git for Windows gives Claude its Bash tool; you can still launch Claude from PowerShell.

## 2. Sign into GitHub and download the project

In PowerShell:

```powershell
gh auth login --hostname github.com --git-protocol https --web
```

Follow the browser instructions. If it shows a one-time code, copy it into GitHub's page. Sign in as **`aoengnatchasmith-spec`**. Agree to authenticate Git if prompted. Then run:

```powershell
gh auth setup-git
gh api user --jq .login
```

The last command must print `aoengnatchasmith-spec`. If another username appears, stop here and use the account-switching step in the troubleshooting table.

Create a folder outside OneDrive and download the code:

```powershell
New-Item -ItemType Directory -Force "$env:USERPROFILE\Developer" | Out-Null
Set-Location "$env:USERPROFILE\Developer"
gh repo clone kasheesh711/bgscheduler
Set-Location bgscheduler
git config user.name "Aoeng Natchasmith"
git config user.email "aoengnatchasmith@gmail.com"
git fetch origin
git switch --track origin/codex/aoeng-preview
npm.cmd ci
```

The clone creates `Developer\bgscheduler`. Git should say your branch tracks `origin/codex/aoeng-preview`. `npm.cmd ci` installs the project's exact dependency versions; it can take several minutes. Success returns you to the `PS` prompt without an `npm error`.

This download is a one-time step. On later days, open the existing folder instead of cloning again. If you already have this project locally, use `git switch codex/aoeng-preview`; do not overwrite your existing folder.

## 3. Set up Claude's project workflow

This project uses **GSD** to keep a small plan, the changes, and a record of what was checked. Install the pinned GSD version used by this guide into your own Claude configuration:

```powershell
npx.cmd get-shit-done-cc@1.42.3 --claude --global
```

If npm asks to install `get-shit-done-cc`, answer `y`. This installs Claude skills globally, outside the repository. The [GSD package](https://www.npmjs.com/package/get-shit-done-cc/v/1.42.3) supports the `--claude --global` options. This guide uses that version's **hyphen** commands, such as `/gsd-quick`. Older installations may show colon commands such as `/gsd:quick`; use the pinned installation and restart Claude to follow this guide consistently.

Start Claude **from the project folder**:

```powershell
claude
```

Complete Claude's own sign-in and trust this repository when asked. Claude automatically reads `CLAUDE.md`, which points to the project instructions and handbook. In the Claude prompt, enter:

```text
/gsd-help
```

You should see GSD's available commands. Do not run `/gsd-new-project`: BGScheduler already has its project plan.

Then paste:

```text
Read CLAUDE.md and docs/operations/aoeng-windows-setup.md. I am Aoeng, GitHub aoengnatchasmith-spec, working on Windows on codex/aoeng-preview. Use this project's GSD workflow for edits. I check the website through the protected browser preview. Explain decisions in plain English. Keep credentials off my computer, preserve my work, and ask me to review the preview before publishing.
```

If you previously installed the Sales Dashboard-only setup, tell Claude to follow the migration note in [`.claude/README.md`](../../.claude/README.md). It should remove only the obsolete local scope hook and keep your GSD hooks and other preferences.

## 4. Your everyday routine

The same branch is reused for each finished change. A **commit** saves work, a **push** uploads it, and a **pull request (PR)** is the page where checks run before the change joins the live version on `main`.

### A. Bring in the latest version

Open PowerShell:

```powershell
Set-Location "$env:USERPROFILE\Developer\bgscheduler"
claude
```

Ask Claude:

```text
Prepare codex/aoeng-preview for today's change. Check for unfinished work or an open PR first and preserve it. If the branch is clean and my last PR is merged, fetch origin, switch to codex/aoeng-preview, pull that branch with --ff-only, and merge origin/main using --no-edit. Run npm.cmd ci if dependencies changed. Tell me if a conflict needs a decision. Never reset or force-push my work.
```

This brings in Kevin's and other contributors' changes before you start. Finish or deliberately close the previous PR before starting an unrelated change on the same branch.

### B. Describe one improvement

For a small, clear change, start a GSD quick task. Replace the example description:

```text
/gsd-quick On the Unearned Revenue dashboard, make the month selector easier to find and explain the selected month clearly. Keep the calculations and access rules unchanged. First tell me what you will change, then implement it, check it, and prepare my browser preview. Stay on codex/aoeng-preview. Do not publish to production yet.
```

For a larger idea, describe it and ask Claude to help plan it through GSD first. You can say what feels wrong, include the page name, and describe what a staff member should be able to do. You do not need to name code files.

### C. Prepare and review the preview

```text
Prepare my preview for this change. Review the diff, run the relevant local checks without real service credentials, commit only this work, and push codex/aoeng-preview. Create or update its PR to main with a clear explanation and test results. Show me the latest Vercel preview link and the five required GitHub checks. Tell me whether any files need Kevin's approval. Wait for me to test the preview before merging.
```

After the PR reports that its latest Vercel deployment is ready, open [your stable preview](https://bgscheduler-git-codex-aoeng-preview-kevins-projects-6ebb4efc.vercel.app). Use this bookmarked address for Google sign-in; temporary deployment addresses on the PR do not have their own Google callback. Confirm the **preview banner** is visible. If it is missing, stop and check the URL with Claude. Check the page you changed, try the main buttons, and check a nearby page still works.

Preview data is a separate copy and may be older than live data. Sending messages, writing to Wise/Google Sheets, and other external actions are disabled there. Ask Kevin to coordinate tests of those integrations.

### D. Publish the version you approved

Before publishing, the latest commit needs five successful checks:

| Check | What it checks |
|---|---|
| `lint` | Code-quality rules |
| `typecheck` | The pieces of the code fit together |
| `unit-tests` | Automated behavior checks |
| `build` | The website can be built |
| `release-guards` | Existing routes remain present and the changes are clean |

If your preview looks right, tell Claude:

```text
I tested and approve this preview. Publish this exact version only after all five required checks pass and any required Kevin approval is present. Confirm the PR contains only my intended work and the approved commit has not changed. Merge with a merge commit, keep codex/aoeng-preview, and wait for Vercel production to be ready. Then give me the live link and help me check the changed page. Do not bypass a protection rule.
```

The merge uses `gh pr merge --merge` for this branch's PR, **without** `--delete-branch` or `--admin`. Merging into `main` triggers the production deployment. Keep `codex/aoeng-preview` so your stable preview link and next editing session continue working. After deployment, open the [live site](https://bgscheduler.vercel.app) and check the change once more.

Changes to login/access controls, database structure, dependencies, deployment/cron settings, CI, release guards, and agent instructions require Kevin's approval. Ordinary feature changes can merge after the checks pass. GitHub states when a code-owner review is required; Claude should explain which file triggered it.

## 5. When something goes wrong

| What you see | What to do |
|---|---|
| `git`, `node`, `gh`, or `claude` is not recognized | Close all terminal windows and reopen PowerShell. Retry the version check. For Claude, follow the [official PATH troubleshooting](https://code.claude.com/docs/en/terminal-guide). |
| `npm.ps1 cannot be loaded` | Use `npm.cmd` and `npx.cmd` as shown here. No execution-policy change is needed. |
| Node's version is not `v24...` | Install Node 24 from the official download page, reopen PowerShell, and check again. |
| GitHub says the repository is unavailable or denies a push | Run `gh api user --jq .login`. If needed, run `gh auth switch --hostname github.com --user aoengnatchasmith-spec`, or repeat `gh auth login` for that account. Ask Kevin to check the repository invitation if access is still denied. |
| `/gsd-help` is unknown | Exit Claude, rerun the pinned GSD install, and start Claude again in `Developer\bgscheduler`. |
| Claude says edits must stay in Sales Dashboard | Use the old-setup migration note in `.claude/README.md`, then restart Claude. |
| `codex/aoeng-preview` is missing | Run `git fetch origin`. If it is still missing, ask Kevin to restore the shared preview branch; do not create a different Vercel project. |
| Git reports a merge conflict | Ask Claude to explain both versions and preserve the intended behavior. Review its resolution and rerun checks. Avoid “discard everything,” hard reset, or force push. |
| A check is red | Use the repair prompt below. A red check means the change should be fixed before publishing. |
| GitHub says Kevin's review is required | Ask Claude which protected controls changed and give Kevin the PR link. Approval may need renewing after another push. |
| Vercel asks for access | Use the invited email. Accept the preview invitation or ask Kevin to check the sharing setting. This is separate from Google sign-in inside BGScheduler. |
| Google says `redirect_uri_mismatch`, or preview login fails | Give Kevin the error text and preview URL. The separate preview OAuth client is owner-managed. Do not copy production secrets to fix it. |
| BGScheduler asks you to sign in again | Sign in with `aoengnatchasmith@gmail.com`. Existing admins need one fresh login after the access-controls release. If access was disabled, Kevin must re-enable it first. |
| The live change causes a problem | Give Kevin the PR link, affected page, and what happened. Ask Claude to prepare a revert PR; Kevin can restore a previous deployment using the owner runbook. |

Repair prompt:

```text
/gsd-debug My BGScheduler PR has a failing check. Read the actual failed job output, explain the cause simply, and fix the problem through GSD. Preserve unrelated work and the existing access/publishing rules. Push the fix to codex/aoeng-preview and show me the new preview and checks. Do not merge until I review the changed version.
```

## First-preview check

After Kevin confirms the preview setup is ready, complete these steps yourself:

- Accept the protected-preview invitation and sign in with the invited account.
- Open the preview, complete its Google sign-in, and confirm the preview banner.
- Open Unearned Revenue and confirm the dashboard loads.
- Make one small change through GSD, open its PR, and view that commit's preview.
- After reviewing it and passing checks, publish it and check the live page.

Installation commands were checked against the vendors' instructions and GSD's published installer. They have not been executed on your Windows computer; your first run verifies the machine-specific setup. Kevin's [owner access runbook](./owner-access-runbook.md) records the separate live setup and revocation steps.
