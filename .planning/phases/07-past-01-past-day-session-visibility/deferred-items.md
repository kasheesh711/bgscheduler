# Phase 7 Deferred Items

Pre-existing issues NOT caused by Phase 7 plans but observed during execution.
Logged per GSD deviation rule scope-boundary ("only auto-fix issues DIRECTLY caused by the current task's changes").

## Discovered during Plan 07-05 (2026-04-22)

### 1. Vitest environmental failure — `tinyglobby/picomatch` incompatibility

**Observed:** `npm test --run` fails with:
```
TypeError: parse.fastpaths is not a function
 ❯ Function.picomatch.makeRe node_modules/tinyglobby/node_modules/picomatch/lib/picomatch.js:301:27
 ...
 ❯ TestProject.globFiles node_modules/vitest/dist/chunks/cli-api.Bxr1Nn49.js:10811:17
```

**Scope:** Pre-existing — this is the same environmental issue flagged in `07-RESEARCH.md` §Assumption A9: "Environmental vitest/node issue (per STATE.md anti-pattern #3) prevented direct confirmation during research." File-targeted `npx vitest run src/lib/search/__tests__/compare.test.ts` fails with the same glob-level error before reaching our file, confirming this is NOT caused by Plan 07-05.

**Out of scope for 07-05** — not caused by `src/app/api/compare/route.ts` edits. Recommendation: reinstall `node_modules` with `npm ci` OR pin `picomatch` in the repo, tracked separately.

### 2. TypeScript — `next/navigation` / `next/link` declaration-file gaps

**Observed:** `npx tsc --noEmit` emits TS7016 errors in:
- `src/app/(app)/compare/page.tsx:3`
- `src/app/login/page.tsx:4`
- `src/app/page.tsx:1`
- `src/components/layout/app-nav.tsx:3,4`
- `src/components/search/search-workspace.tsx:4`

**Scope:** Pre-existing — these files were NOT modified by Plan 07-05. The issue is Next.js 16 internal module declaration-file resolution under the current TS config.

**Out of scope for 07-05** — not caused by `route.ts` edits. Verified via `grep "src/app/api/compare/route.ts" /tmp/tsc-run2.log` = 0 matches (zero errors in the file I modified).

### 3. TypeScript — Plan 02 test file type mismatch

**Observed:** `npx tsc --noEmit` emits in `src/lib/sync/__tests__/past-sessions-diff-hook.test.ts`:
- Line 185: `Property 'groupCanonicalKey' does not exist on type 'PriorBlock'`
- Line 186: `Property 'capturedInSnapshotId' does not exist on type 'PriorBlock'`

**Scope:** Belongs to Plan 07-02 (orchestrator diff-hook). Out of scope for Plan 07-05 (`/api/compare` route). Plan 07-02 summary should be re-checked by its owner.

**Out of scope for 07-05** — different file, different plan.
