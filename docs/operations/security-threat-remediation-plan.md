# Security Threat Remediation Plan

This page is the working remediation plan for the security threats identified
during the 2026-06-15 repository review and npm audit. It is intentionally a
plan, not a closure report: keep each item open until the listed verification
has passed and the relevant code or operational control is live.

## Executive summary

BGScheduler's highest-value assets are the Wise-derived scheduling snapshot,
admin-only workflows, Wise write paths, stored Google OAuth refresh tokens,
LINE message data, AI scheduler inputs/outputs, cron endpoints, and uploaded
spreadsheet data. The main trust boundaries are:

| Boundary | Current protection | Primary risk |
| --- | --- | --- |
| Browser session to app routes | Auth.js session, middleware, in-handler `auth()` checks | Middleware bypass advisories and inconsistent handler-level authorization |
| Public integrations | LINE HMAC signatures, cron bearer secret, OA resolver bearer token | Abuse, replay, invalid-token probing, and route inventory drift |
| Admin uploads | Session auth | Unbounded workbook parsing and vulnerable `xlsx` dependency |
| App to Wise, Google, LINE, OpenAI, Apify/DataForSEO | Server-side credentials and provider clients | Raw upstream errors, data overexposure, SSRF-like provider fetch risk |
| Repo and local workstation | Git ignore rules and developer discipline | Sensitive operational extracts and loose local secret file permissions |

Priority definitions:

| Priority | Meaning |
| --- | --- |
| `P0` | Active exploitable production risk or known vulnerable dependency on a production path |
| `P1` | Defense-in-depth gap that materially reduces blast radius or abuse potential |
| `P2` | Governance, documentation, or hardening work that should follow the urgent fixes |

## Audit baseline

Commands run on 2026-06-15 from the repository root:

```bash
npm audit --omit=dev --json
npm audit --json
```

Production audit baseline:

| Package | Severity | Finding | Fix status |
| --- | --- | --- | --- |
| `next@16.2.2` | High | Multiple Next.js 16 advisories including Server Components DoS, App Router middleware/proxy bypass, cache poisoning, CSP nonce XSS, Image Optimization DoS, and WebSocket SSRF | `next@16.2.9` available |
| `postcss` via `next` | Moderate | CSS stringify XSS advisory | Fixed through `next@16.2.9` |
| `uuid@13.0.0` | Moderate | Missing buffer bounds check in v3/v5/v6 when `buf` is provided | Patched update available |
| `xlsx@0.18.5` | High | SheetJS prototype pollution and ReDoS advisories | No npm-audit fix available |

Full audit baseline: 22 total vulnerabilities, including dev/tooling findings
through `drizzle-kit`, `testcontainers`, `tsx`, `esbuild`, `hono`,
`@grpc/grpc-js`, `tmp`, `qs`, and transitive `uuid`. Treat production
dependency fixes as release-blocking. Treat dev-only fixes as separate tooling
hardening unless a vulnerable package is bundled into the deployed app.

## Threat register

| ID | Priority | Evidence | Impact | Resolution | Verification | Owner / Status |
| --- | --- | --- | --- | --- | --- | --- |
| `SEC-001` | `P0` | `package.json` pins `next` to `16.2.2`; `npm audit --omit=dev` reports multiple high Next.js advisories and a transitive PostCSS advisory fixed by `16.2.9`. | Middleware/proxy bypass, denial of service, cache poisoning, XSS, or SSRF issues could affect protected App Router routes or production availability. | Read the relevant Next 16 guidance under `node_modules/next/dist/docs/`, upgrade `next` and `eslint-config-next` together to the audited fixed version, and keep `cacheComponents` behavior unchanged unless the docs require a migration. | `npm audit --omit=dev`, `npm run typecheck`, `npm test`, `npm run build`, middleware tests, and production route surface guard. | Unassigned / Open |
| `SEC-002` | `P0` | `xlsx@0.18.5` is a direct production dependency with no npm-audit fix; `src/app/api/tutor-profiles/import-preview/route.ts` reads uploaded workbooks into memory before parsing. | A malicious or oversized workbook could trigger prototype pollution, ReDoS, memory pressure, or CPU exhaustion from an admin session. | Replace `xlsx` with a maintained parser or isolate parsing behind strict limits. Add max file size, MIME, extension, sheet count, row count, column count, cell length, and formula/external-link policy checks before parsing. | Upload tests for wrong MIME, oversized file, too many sheets/rows/cells, formula/external-link handling, and malicious workbook fixtures where practical. `npm audit --omit=dev` must either be clean or document the temporary parser isolation exception. | Unassigned / Open |
| `SEC-003` | `P0` | `src/middleware.ts` enforces sessions and `allowedPages`, but many API handlers only check `auth()` and rely on middleware for role/page authorization. `npm audit` also reports Next middleware/proxy bypass advisories. | A framework bypass or handler mounted outside expected middleware coverage could expose admin data or write paths to any signed-in user. | Add centralized Node-runtime guards such as `requireAdminSession`, `requirePageAccess`, `requireTeacherSession`, and `requireCronSecret`. Use them in route handlers for admin-only and page-scoped APIs. Add stale-access handling for role or `allowedPages` changes, such as short JWT refresh windows or an access-version check. | Route auth matrix tests for representative GET/POST/PATCH/DELETE handlers, public-route self-auth tests, and middleware bypass regression tests. | Unassigned / Open |
| `SEC-004` | `P0` | Root-level operational extracts are tracked or present, including workbook/CSV/JSON files, and local `.env.production.local` was observed with permissive file permissions during planning. `graphify-out/` is untracked and not ignored. | PII, scheduling data, Wise operational data, or local secrets could be committed, retained in history, or readable by other local users. | Inventory and classify root data extracts. Remove or migrate sensitive artifacts to protected storage. Purge git history if secrets or high-risk PII are confirmed. Add ignore rules for generated graph/security output. Set local production env files to mode `600`. | Secret scan, PII review sign-off, `git status --short` clean of generated artifacts, and documented decision for each retained data file. | Unassigned / Open |
| `SEC-005` | `P0` | Several routes return raw `error.message` or `detail`; `src/lib/wise/client.ts` includes upstream response text and URL in thrown errors; provider clients include slices of upstream error bodies. | Admin/API responses may leak provider payloads, internal URLs, request details, student/tutor identifiers, or operational data. | Add a shared safe error mapper returning generic messages plus a request ID. Log detailed server-side errors after redacting credentials, bearer tokens, API keys, Basic auth, cookies, email addresses where not needed, and long provider payloads. | Tests for Wise, Google Sheets, OpenAI, LINE, and competitor-provider failure paths proving responses are generic and logs are redacted. | Unassigned / Open |
| `SEC-006` | `P1` | Mutating session-authenticated routes rely on session cookies and route code; no shared same-origin guard was found. | Cross-site requests could hit state-changing endpoints if browser cookie policy or future route behavior weakens. | Add a shared `assertSameOrigin` helper for session-authenticated `POST`, `PUT`, `PATCH`, and `DELETE` routes. Exempt only signed webhooks, cron-secret routes, and extension bearer-token endpoints. | Tests for missing, same-origin, cross-origin, and exempt integration requests. | Unassigned / Open |
| `SEC-007` | `P1` | `next.config.ts` currently has no security headers beyond default Next/Vercel behavior. | Missing browser hardening allows unnecessary framing, MIME sniffing, broad referrer leakage, and weaker future CSP posture. | Add headers for HSTS in production, `X-Content-Type-Options: nosniff`, frame denial or `frame-ancestors 'none'`, `Referrer-Policy`, `Permissions-Policy`, and a staged CSP report-only policy before enforcement. | Header assertions against app pages and API responses; manual verification for login/OAuth and embedded assets. | Unassigned / Open |
| `SEC-008` | `P1` | Public and expensive routes exist for LINE webhook ingest, OA resolver token access, AI scheduling, imports/OCR, manual syncs, and cron-like admin operations. No shared app-level rate limiting was identified. | Attackers or misconfigured clients could exhaust provider quotas, increase OpenAI/LINE/Google/Wise costs, or create noisy operational backlogs. | Add a shared rate-limit helper with per-IP, per-user, per-token, and per-route budgets. Start with public integrations and expensive admin operations. Fail closed for mutation and provider-cost routes; fail open with logging only where availability is more important. | Unit tests for limit keys, reset behavior, authenticated versus anonymous quotas, and route-specific responses. Production logs must show limit decisions without PII. | Unassigned / Open |
| `SEC-009` | `P1` | Competitor intelligence website fetches use server-side `fetch` against URLs from source records. Current defaults are seeded, but future edit paths or DB changes could make URLs attacker-controlled. | SSRF could reach internal metadata services, localhost, private networks, or unexpected protocols if a source URL becomes editable or compromised. | Add `safeFetchExternalUrl`: HTTPS only, allowed content types, response-size cap, redirect cap, DNS resolution with private/link-local/loopback/reserved IP denial, and timeout enforcement. Use it for competitor website fetches and any future URL-configured source. | Tests for `http://`, `file:`, localhost, `127.0.0.1`, `::1`, private ranges, `169.254.169.254`, redirects to private IPs, oversized bodies, and valid public HTTPS. | Unassigned / Open |
| `SEC-010` | `P1` | Google OAuth refresh tokens are encrypted using material derived from `AUTH_SECRET`; Auth.js sessions also depend on `AUTH_SECRET`. | A single secret compromise affects both sessions and stored Google refresh tokens; rotation and revocation are operationally unclear. | Add versioned token encryption with a dedicated `GOOGLE_OAUTH_TOKEN_ENCRYPTION_KEY` or managed key, support decrypt-old/encrypt-new rotation, add purge/revoke workflow for removed users, and document scope minimization. | Unit tests for v1/v2 decrypt, rotate-on-read or rotate job, removed-user purge, and missing-scope diagnostics with sanitized errors. | Unassigned / Open |
| `SEC-011` | `P1` | `/api/internal/*` is middleware-public and protected by `CRON_SECRET`; shared cron auth exists but some routes still use inline checks. Route inventory and cron docs have drifted over time. | An internal route can be added without consistent auth, audit, docs, or Vercel schedule awareness. Invalid secret probing may go unnoticed. | Use one shared cron-auth helper everywhere, log invalid attempts with request metadata that excludes secrets, add light rate limiting, document every internal route, and add a route inventory check comparing code, docs, and `vercel.json`. | Cron auth tests for valid, invalid, missing-secret, missing-header, and malformed-header cases across representative routes. Docs audit must fail on undocumented internal routes. | Unassigned / Open |
| `SEC-012` | `P2` | AI Scheduler, LINE classifier, and competitor intelligence send operational text to model/provider APIs. Some routes already use structured validation, but there is no cross-feature LLM data-handling policy. | Prompt injection, over-sharing PII, or unreviewed model output could create privacy, correctness, or reputational risk. | Document and enforce minimum-necessary prompts, provider retention expectations, structured output validation, no model authority over availability, and human review for write paths. Add redaction where full text is not needed. | Tests for schema validation failures, prompt-injection examples, and human-gated write paths. Review provider settings and logging. | Unassigned / Open |
| `SEC-013` | `P2` | Runtime and migration database privilege separation is not documented; current operations emphasize a single `DATABASE_URL`. | A runtime credential compromise could allow broader schema or data changes than the app needs. | Split Neon credentials into runtime and migration roles where practical. Runtime should have only app-required DML/DDL permissions; migrations use a separate secret. Document backup/export retention and sensitive write/read audit expectations. | Production env review, migration dry run with migration role, runtime smoke test with runtime role, and documented rollback. | Unassigned / Open |
| `SEC-014` | `P2` | `docs/operations/auth-and-access.md`, API counts, cron docs, and older project summaries have drifted from current admin/teacher roles and route surface. | Engineers may make security decisions from stale documentation and miss newer public routes or role behavior. | Update auth/access docs to match the current admin/teacher model, refresh API inventory counts, reconcile cron docs with `vercel.json`, and document environment variables consumed outside `src/lib/env.ts`. | `npm run docs:audit`, route inventory script, and manual review of auth, API, cron, and env docs. | Unassigned / Open |

## Remediation roadmap

### 1. Dependency and framework fixes

1. Read the applicable Next 16 docs under `node_modules/next/dist/docs/`, with
   attention to App Router, middleware/proxy, cache components, and config
   migration notes.
2. Upgrade `next` and `eslint-config-next` together to the fixed `16.2.x`
   release identified by audit.
3. Upgrade direct `uuid` to a patched version.
4. Re-run prod audit before release. Do not accept production audit findings
   except for a time-boxed, documented parser-isolation exception if `xlsx`
   replacement cannot land in the same change.
5. Triage full-audit dev findings separately. Prioritize anything that can run
   a local dev server, parse untrusted files, or execute package install hooks.

### 2. Authorization and request integrity

1. Add shared route guard helpers and migrate high-risk routes first: Wise
   write paths, admin imports, AI/LINE admin actions, payroll, credit control,
   sales dashboard, and internal crons.
2. Add same-origin enforcement for session-authenticated mutations.
3. Add route matrix tests that prove public routes are intentionally public and
   protected routes enforce the correct role/page access in the handler itself.
4. Define a stale-access policy. Recommended default: keep JWT sessions, but
   add an access-version or timestamp check for role/page changes and shorten
   refresh windows if versioning is deferred.

### 3. Input, parsing, and upload controls

1. Replace or isolate workbook parsing before accepting arbitrary workbook
   content in production.
2. Add upload limits at the route boundary before `arrayBuffer()` conversion.
3. Add parser-level caps so a valid container cannot expand into excessive
   sheets, rows, columns, strings, formulas, or shared strings.
4. Treat formula cells, external links, macros, hidden sheets, and very large
   shared-string tables as explicit policy decisions. Recommended default:
   reject for admin import previews unless a feature requires them.

### 4. Outbound calls and error handling

1. Centralize safe external fetch behavior for configurable URLs.
2. Standardize provider error handling so external payloads never flow directly
   to JSON responses.
3. Add redaction before logs. Redact bearer tokens, Basic auth, API keys,
   cookies, refresh tokens, provider request IDs when sensitive, and oversized
   upstream bodies.
4. Add request IDs to errors so admins can report failures without exposing raw
   provider details.

### 5. Data protection and local artifact hygiene

1. Classify each root-level workbook, CSV, JSON, and generated output directory
   as either public test fixture, non-sensitive operational artifact, PII, or
   secret-bearing.
2. Remove sensitive files from git, move them to an approved private store, and
   purge history if needed.
3. Add `.gitignore` entries for generated graph/security outputs and any local
   export conventions.
4. Set local production env files to `0600` and verify `.env*` remains ignored.
5. Add a lightweight secret/PII scan to release checks or pre-commit workflow.

### 6. Operations, observability, and docs

1. Add shared cron-auth usage and invalid-attempt logging for all internal
   routes.
2. Add rate limiting around public integrations, provider-cost routes, and
   manual sync triggers.
3. Add security headers in `next.config.ts` and verify OAuth/login behavior.
4. Refresh auth, API, cron, and env docs after code changes, then make docs
   drift detectable in CI.

## Acceptance checklist

Use this checklist before marking this remediation program complete:

- [ ] `npm audit --omit=dev` is clean, or the only remaining production finding
      has a documented, time-boxed exception with compensating controls.
- [ ] Full `npm audit` dev findings are triaged, with upgrade tickets or accepted
      local-only risk notes.
- [ ] Next.js is on the fixed version and all Next 16 migration notes relevant
      to this app have been applied or documented as not applicable.
- [ ] Workbook import routes reject oversized and malformed input before heavy
      parsing.
- [ ] Protected route handlers enforce role/page access without depending only
      on middleware.
- [ ] Mutating session-authenticated routes reject cross-origin requests.
- [ ] Public integration routes have signature, bearer, cron-secret, or explicit
      public-asset justification tests.
- [ ] Provider errors returned to clients are generic and correlated with
      redacted server logs.
- [ ] External URL fetches cannot reach localhost, private ranges, link-local
      addresses, unsupported schemes, excessive redirects, or oversized bodies.
- [ ] Google OAuth token encryption has rotation and removed-user purge paths.
- [ ] Internal cron routes share one auth helper and are fully documented.
- [ ] Security headers are present in production responses.
- [ ] Sensitive local/tracked artifacts have been removed, justified, or moved
      to approved storage.
- [ ] Auth/access, API, cron, and environment-variable docs match the current
      code.
- [ ] Release verification passes: `npm run docs:audit`, `npm run typecheck`,
      `npm test`, `npm run build`, `git diff --check`, and
      `npm run guard:production-route-surface`.

## Notes for implementers

- Do not weaken the strict-fidelity rule while fixing security issues. Unknown
  Wise identity, modality, qualification, or availability must continue to route
  to review rather than available.
- Do not add a Google Sheets fallback for production scheduling data.
- Do not make LINE or Leave Requests Wise mutations live while resolving these
  findings unless the relevant feature flag, dry-run policy, and human review
  controls are deliberately changed.
- Keep remediation commits narrow enough that each verification failure points
  to a specific control.

_Verified against HEAD + uncommitted WIP on 2026-06-15._
