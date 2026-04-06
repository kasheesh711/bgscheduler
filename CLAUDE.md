@AGENTS.md

## Quick Reference

- **Production URL**: https://bgscheduler.vercel.app
- **Repo**: https://github.com/kasheesh711/bgscheduler
- **Database**: Neon Postgres (ap-southeast-1)
- **Wise API**: https://api.wiseapp.live
- **Wise namespace**: `begifted-education`
- **Wise institute**: `696e1f4d90102225641cc413`

## Current Status

Wise credentials and namespace are valid. The previous blocker was client-side contract drift: the app was using the wrong base path, outdated header names, outdated availability/session query params, and outdated response parsing. The remaining task is to verify a repaired live sync and confirm snapshot promotion.

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
