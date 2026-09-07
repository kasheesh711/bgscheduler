# Claude Code collaborator setup

Start with [Aoeng's Windows guide](../docs/operations/aoeng-windows-setup.md) for installation, accounts, GSD, browser previews, and publishing.

The optional `collaborator-settings.local.template.json` retains local secret-reading and destructive-command restrictions. It allows changes across the application. GitHub's required checks and protected `CODEOWNERS` paths enforce publishing rules; local Claude settings are not an authorization boundary.

For a fresh local setup, copy the template from PowerShell only if no settings file exists:

```powershell
if (-not (Test-Path .claude/settings.local.json)) {
  Copy-Item .claude/collaborator-settings.local.template.json .claude/settings.local.json
}
```

Keep `.claude/settings.local.json` private; it is ignored by Git. If you used the older Sales Dashboard setup, ask Claude to remove only the hook entries whose command references `sales-dashboard-guard.mjs` from your existing local settings. Preserve the GSD hooks and your other settings. Restart Claude afterward.
