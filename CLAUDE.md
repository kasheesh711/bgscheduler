@AGENTS.md

## Quick Reference

- **Production URL**: https://bgscheduler.vercel.app
- **Repo**: https://github.com/kasheesh711/bgscheduler
- **Database**: Neon Postgres (ap-southeast-1)
- **Wise API**: https://api.wiseapp.live/api/v1 (Basic Auth + x-api-key)
- **Wise namespace**: `begifted-education`
- **Wise institute**: `696e1f4d90102225641cc413`

## Current Blocker

Wise API returns "Namespace mismatch" despite confirmed namespace `begifted-education`. Auth headers (Basic Auth base64 of userId:apiKey, x-api-key, user-agent VendorIntegrations/namespace) pass authentication (401→400) but namespace validation fails. Waiting on Wise admin to resolve credential-namespace binding.

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
