# Claude Code Collaborator Setup

These guardrails are for the collaborator account `aoengnatchasmith-spec`.

To activate them on a collaborator machine:

```bash
cp .claude/collaborator-settings.local.template.json .claude/settings.local.json
```

Do not commit `.claude/settings.local.json`. It is intentionally ignored so each developer can keep their own Claude Code permissions.

The template blocks edits outside Sales Dashboard paths, protects local secrets, and prevents production deploy/sync commands from Claude Code. GitHub Actions still enforces Sales Dashboard scope on pull requests from `aoengnatchasmith-spec`.
