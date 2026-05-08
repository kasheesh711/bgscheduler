# Phase 09 Density Verification

## Automated Evidence

| Check | Command | Status |
|-------|---------|--------|
| Density unit tests | `./node_modules/.bin/vitest run --project unit src/components/compare/__tests__/density-overview.test.tsx` | PASS |
| Full unit suite | `npm test` | PASS |
| Lint | `npm run lint` | PASS with existing warnings |
| Forbidden server/cache/schema diff | `git diff --exit-code -- src/app/api src/lib/search/index.ts src/lib/db/schema.ts src/lib/search/cache-version.ts` | PASS |
| Cache version | `rg -n 'export const CACHE_VERSION = "v2"' src/lib/search/cache-version.ts` | PASS |

Density tests: PASS
Full test suite: PASS
Lint: PASS
Forbidden server/cache/schema diff: PASS
CACHE_VERSION unchanged: PASS
Manual visual verification: PASS
VoiceOver segment labels: PASS
Reduced motion: PASS

## Notes

- `npm test` passed with 30 test files and 235 tests.
- `npm run lint` exited 0 after fixing blocking existing lint errors; remaining findings are warnings.
- The pre-existing deleted API test file was restored with approval before the forbidden-diff gate was rerun.
- No environment variables, cookies, auth tokens, or full command logs are included.

## Manual Browser Checklist

1. Week view placement below day tabs and above the calendar body: PASS
2. One selected tutor compactness and seven Monday-Sunday segments: PASS
3. Two selected tutors fixed tutor colors plus non-color density encoding: PASS
4. Three selected tutors total strip height at or below 120px with no overlap: PASS
5. Segment click opens existing day drill-down only: PASS
6. Day drill-down keeps density above `CalendarGrid`: PASS
7. Tab plus Enter/Space activates a density segment: PASS
8. Reduced-motion mode has no density-specific animation, pulse, shimmer, delayed reveal, or transition: PASS
9. VoiceOver segment label includes day, tutor, booked hours, session count, and Open day view: PASS
10. Copy uses booked hours/session count only, with no availability, capacity, percentage, recommended, or free claim: PASS
