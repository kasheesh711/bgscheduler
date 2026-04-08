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

UX/UI refresh v2 deployed 2026-04-08 (commits `38b4688`–`b11734d`): side-by-side layout (search left, compare right), sky blue palette, Inter font, GCal-style week view, searchable tutor combobox, discovery modal. `/compare` redirects to `/search`.

Week view QA fixes deployed 2026-04-08: GCal-style overlap detection (sub-columns for overlapping sessions), consistent card styling (28% bg opacity, solid borders), sticky day headers with vertical scrolling.

### Known Issues (open)
- **Online/onsite detection heuristic**: uses `location` field pattern matching (http/online/learn./zoom/meet.google/virtual). Most sessions have venue names like "Think Outside the Box", "Tesla", "Nerd" which don't match → all treated as onsite. Needs a more reliable data source (possibly `sessionType` from Wise or the `isOnlineVariant` flag on the tutor's underlying Wise records). Visual distinction (dashed vs solid border) removed from cards pending reliable detection; modality info still shown in popover.

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
