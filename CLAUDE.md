@AGENTS.md

## Quick Reference

- **Production URL**: https://bgscheduler.vercel.app
- **Repo**: https://github.com/kasheesh711/bgscheduler
- **Database**: Neon Postgres (ap-southeast-1)
- **Wise API**: https://api.wiseapp.live
- **Wise namespace**: `begifted-education`
- **Wise institute**: `696e1f4d90102225641cc413`

## Current Status

Production sync is live. First successful sync completed 2026-04-07 (commit `c673999`), promoting snapshot `d70608b0` with 131 teachers and 72 identity groups. Daily cron runs at midnight UTC.

UX/UI refresh deployed 2026-04-08 (commit `70cfa06`): warm teal/amber color palette, integrated compare into search page as tabbed workspace, shared AppNav, full-width layout. `/compare` now redirects to `/search`.

## Running Commands

```bash
# Deploy to production
npx vercel --prod

# Run tests
npm test

# Generate migrations
npm run db:generate

# Run migrations
DATABASE_URL=... npm run db:migrate

# Seed data
DATABASE_URL=... SEED_ADMIN_EMAILS=email1,email2 npm run db:seed

# Trigger sync manually
curl -X POST https://bgscheduler.vercel.app/api/internal/sync-wise \
  -H "Authorization: Bearer $CRON_SECRET"
```
