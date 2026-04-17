# Deferred Items — Phase 03

## Pre-existing build warning (not caused by Plan 03-01)

**File:** `src/app/(app)/compare/page.tsx`
**Symptom:** `npm run build` emits type error during next build worker type check:
`Type error: Could not find a declaration file for module 'next/navigation'.`

**Analysis:**
- `npx tsc --noEmit` reports zero errors (exit code 0) — the project's TS config is clean.
- The failure only occurs in Next.js 16 build-time worker type check, which uses a stricter resolver than the IDE/`tsc`.
- File was unmodified in this plan; pre-exists on commit b0576e02.

**Out of scope for Plan 03-01** — bug is unrelated to calendar readability changes.
