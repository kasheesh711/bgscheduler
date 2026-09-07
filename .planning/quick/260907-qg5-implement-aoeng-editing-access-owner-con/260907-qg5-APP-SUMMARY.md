---
phase: quick-260907-qg5
plan: "01"
task: 1
subsystem: auth
tags: [next-auth, jwt, proxy, postgres, owner-access, preview]
requires:
  - phase: existing application
    provides: Admin allowlist, Google OAuth, capability grants and Postgres transaction support
provides:
  - Owner-only website account management with audited concurrent updates
  - Fresh shared authorization in server auth and the Next.js Node Proxy
  - Preview identity-only Google scopes, no integration-token persistence and a preview banner
affects: [application-auth, production-rollout, aoeng-preview]
tech-stack:
  added: []
  patterns: [immutable login access version, fresh account validation, transactional audit append]
key-files:
  created:
    - src/lib/auth-session.ts
    - src/lib/admin-users/data.ts
    - src/app/api/admin/users/route.ts
    - src/app/(app)/admin/users/page.tsx
    - src/lib/preview-policy.ts
    - src/proxy.ts
    - drizzle/0078_admin_access_controls.sql
  modified: [src/lib/auth.ts, src/lib/auth-access.ts, src/lib/auth-edge.ts, src/lib/db/schema.ts]
key-decisions:
  - Unversioned legacy admin JWTs must sign in again after rollout; a normal JWT refresh never copies a new database version.
  - Every configured owner row is immutable through the account-management API, including re-enable and no-op requests.
  - Preview behavior activates on VERCEL_ENV=preview or PREVIEW_SANDBOX_ENABLED=true.
requirements-completed: [OWNER-REVOCATION]
duration: not separately recorded
completed: 2026-09-07
---

# Task 1: Owner controls and preview authentication

**Kevin-only account controls atomically record access changes and revoke old admin sessions across pages, APIs and manual cron fallbacks.**

## Accomplishments

- Added `admin_users.disabled` (enabled by default through `false`) and `access_version` (starts at `0`). Each actual enable/disable toggle increments the version. Existing page and feature grants remain untouched.
- Added append-only `admin_user_access_audit_log`, with normalized actor/target, before/after state and a unique target/version pair. A Postgres trigger rejects audit updates and deletes. Account changes and audit inserts share a transaction and row locks; stale writes return 409.
- Added owner-only `/admin/users`, `/api/admin/users` GET/PATCH, navigation and accessible pending/error/conflict/success states. Both owner configuration and a current enabled admin row are required. Every configured owner is protected from changes through this API.
- Shared `validateSessionAccess` between server `auth()` and the Node `proxy.ts`. Missing/deleted/disabled admin accounts, stale versions and unversioned legacy admin cookies are denied. Disabled admins cannot fall through to teacher/admissions roles. Database failures deny access.
- Kept public routes, maintenance ordering and cron-secret behavior. Public routes do not perform fresh account lookups; no-session requests do not initialize the database. Manual cron session fallbacks use the independently checked server `auth()`.
- Preview Google login requests `openid email profile` only, without offline scopes. Preview sign-in skips integration-token storage. A visible preview banner explains the test workspace.

## Task commits

- `8174ce7` — `test(260907-qg5): specify owner and session revocation guards` (RED: three new suites failed because their implementation modules did not yet exist).
- `1efd552` — `feat(260907-qg5): add owner controls and revoke stale admin sessions` (GREEN: implementation, migration, regression and integration tests).

## Verification

- 136 targeted unit tests passed across 10 suites, including owner authorization, session revocation, preview OAuth, existing maintenance/page rules, viewer-only Unearned Revenue grants, navigation and API validation.
- Eight Postgres 16 integration tests passed on an ephemeral Docker database: audited updates, concurrent stale-write rejection, disable/re-enable token invalidation, owner immutability, actor revalidation, transaction rollback on failed audit insertion, database-enforced append-only history, and no-op behavior.
- A test using the real server auth guard and the manual Wise sync route proves revoked sessions cannot invoke sync. Valid cron-secret requests do not read sessions or account tables.
- Full `npm run typecheck` passed. Targeted ESLint and `git diff --check` passed without warnings in the owned changes.
- Drizzle snapshot check confirmed `0078.prevId` matches `0077.id`; only `admin_users` and the new audit table changed; enum definitions are unchanged.
- Stub scan found no unfinished implementation or mock data feeding the new user interface.

## Interfaces and rollout notes

- `SUPER_ADMIN_EMAILS` is a comma-separated normalized owner list; root configures `kevhsh7@gmail.com`.
- GET `/api/admin/users` returns `{ rows: [{ email, name, disabled, accessVersion, isOwner }] }` with private/no-store caching.
- PATCH accepts exactly `{ email, disabled, expectedVersion }`, derives the actor from authentication, and returns `{ row }`. Malformed requests return 400; unauthenticated/unauthorized actors 401/403; missing accounts 404; stale edits 409.
- **All existing admins need one fresh Google login after the application rollout.** Legacy tokens are rejected even when the current account version is still zero. Re-enabling an account does not revive earlier tokens.
- `VERCEL_ENV=preview` or `PREVIEW_SANDBOX_ENABLED=true` enables the preview login policy/banner. Root owns preview database isolation, credential scrubbing, integrations, OAuth-client provisioning and preview sharing.
- Root confirmed migration 0078 was applied successfully to production and preview, with columns and append-only trigger verified. This executor did not mutate live data/settings or deploy the application.
- Full CI, browser verification and production/preview release validation remain root-owned rollout work.

## Deviations from plan

- Used migration `0078` because `0074`–`0077` already exist, as required by the plan's next-unoccupied-migration instruction.
- Added a dedicated `auth-session.ts` so Proxy authorization does not import the server auth graph, and a small admin transaction module for Neon HTTP's missing transaction support. Added the audit table to integration cleanup and a real-auth manual-sync regression test. These are within the assigned authorization responsibility.

## Issues encountered

- Started the installed OrbStack application so the existing Testcontainers infrastructure could run. No dependency changes were needed.
- Initial typecheck caught TypeScript weak-type incompatibility between the injectable environment interfaces and `process.env`; the interfaces now extend the established string/undefined environment record shape. Typecheck passed afterward.

## Remaining task-level work

None. Root owns live rollout, the remaining accepted plan responsibilities, and aggregate planning-state updates.

## Self-Check: PASSED

Verified all 35 current task-owned files exist (the former `middleware.ts` is intentionally renamed to `proxy.ts`), and both implementation-history commits exist. Owned application and migration paths are clean after the implementation commit.
