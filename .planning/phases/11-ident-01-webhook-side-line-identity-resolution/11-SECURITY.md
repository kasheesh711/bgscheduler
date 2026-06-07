---
phase: 11
slug: ident-01-webhook-side-line-identity-resolution
status: verified
threats_open: 0
asvs_level: 1
created: 2026-06-07
---

# Phase 11 — Security

> Per-phase security contract: threat register, accepted risks, and audit trail.
> LINE webhook-side identity resolution: name matcher, isPhantom quarantine, followers re-anchor, re-pointed Mapping Validation worklist, inline recompute.

---

## Trust Boundaries

| Boundary | Description | Data Crossing |
|----------|-------------|---------------|
| schema.ts → Drizzle migration → production Neon | DDL change applied to live DB via `db:migrate` | Schema mutation (is_phantom column + index) |
| psql data migration WHERE clause | One-time UPDATE quarantining OA-resolver rows | 696 production link rows (flag-only, no delete) |
| AI-extracted names → matcher → DB insert | LLM-extracted studentName/parentName scored against directory | Untrusted message-derived strings → scored suggestions |
| LINE `GET /v2/bot/followers/ids` → re-anchor → lineContacts | Bulk follower enumeration seeding correct-namespace contacts | OA follower user IDs (correct Messaging-API namespace) |
| Admin browser → re-anchor / verify / list routes | Authenticated admin actions over HTTP | Admin session (Auth.js) gated mutations |
| phantom archive scope → worklist query | Read-only view of quarantined legacy rows | is_phantom=true rows (admin-only, labeled "legacy") |

---

## Threat Register

| Threat ID | Category | Component | Disposition | Mitigation (verified evidence) | Status |
|-----------|----------|-----------|-------------|--------------------------------|--------|
| T-11-01 | Tampering | Drizzle migration file | mitigate | `drizzle/0040_nifty_mercury.sql` = exactly 2 DDL stmts (ADD COLUMN + CREATE INDEX); blocking human-verify checkpoint, no trim needed (11-01-SUMMARY) | closed |
| T-11-02 | Tampering | psql data-migration WHERE | mitigate | `WHERE source_kind='line_oa_resolver'` exact match → UPDATE 696; post-verify 0 OA-resolver rows unquarantined, 703 total unchanged (zero deletes) | closed |
| T-11-03 | Information Disclosure | is_phantom archive view | accept | Phantom rows reachable only via explicit `scope=phantom` ("Legacy / needs re-match"); admin-only routes (auth() gate) | closed |
| T-11-04 | Tampering | accidental un-quarantine | mitigate | No `set({isPhantom:false})` anywhere in `src/lib/line/`; only schema default (`schema.ts:1747`) sets false for new rows | closed |
| T-11-05 | Tampering | matcher output → verified | mitigate | `matchNamesToDirectory` (name-matcher.ts:146) returns `NameMatchCandidate[]` (student/score/matchBasis only); no `status` field, zero DB imports | closed |
| T-11-06 | Tampering | wrong-student low-precision match | mitigate | `SUGGEST_SINGLE_MIN_SCORE=70`; eval gate `expect(precision).toBeGreaterThanOrEqual(0.90)` (name-matcher.eval.test.ts:625); measured 0.905/1.0 | closed |
| T-11-07 | Information Disclosure | Thai PII in test fixtures | accept | Synthetic non-identifying fixtures; no real student PII committed | closed |
| T-11-08 | Tampering | suggestion insert → verified | mitigate | `student-links.ts:476,508` hard-code `status:"suggested"` ("ALWAYS suggested — NEVER verified from content (IDENT-02)") | closed |
| T-11-09 | Tampering | extractedState JSONB coercion | mitigate | `review-service.ts:149-151` `typeof state.studentName==="string"` / parentName guards before use | closed |
| T-11-10 | Elevation of Privilege | approve gate approves phantom contact | mitigate | `listVerifiedLineStudentKeys` filters `isPhantom=false` (student-links.ts:721-724); `hasVerifiedLineStudentLink` + approve gate inherit | closed |
| T-11-11 | Information Disclosure | followers/ids bulk harvest | mitigate | `followers-reanchor/route.ts:9-12` `auth()` → 401 without session; no unauthenticated path to `runLineFollowersReanchor` | closed |
| T-11-12 | Spoofing | crafted follower userId conflict | accept | `upsertLineContactFromFollower` `.onConflictDoNothing(target: lineUserId)` (student-links.ts:821); insert-only | closed |
| T-11-13 | Information Disclosure | access-token leak via error | mitigate | `client.ts` errors use `payload.message` / HTTP status only; `lineAccessToken()` value never logged; no console.* | closed |
| T-11-14 | Denial of Service | re-anchor tight loop | accept | Admin-only route; `maxDuration=60` upper bound (followers-reanchor/route.ts:6) | closed |
| T-11-15 | Tampering | patch status with phantom linkId | mitigate | `patchLineLinkValidationTaskStatus` WHERE `id=linkId AND isPhantom=false` (link-validation.ts:735-738) → null → route 404 | closed |
| T-11-16 | Information Disclosure | inflated verified count | mitigate | `getLineLinkValidationSummary` base condition `realContactCondition()` (isPhantom=false) on all aggregates (link-validation.ts:499) | closed |
| T-11-17 | Tampering | phantom scope bulk un-quarantine | mitigate | phantom scope is SELECT-only; PATCH path enforces isPhantom=false (T-11-15); no update wired to phantom scope | closed |
| T-11-18 | Tampering | recompute for wrong contact | mitigate | recompute WHERE uses `row.contactId` from the verified link's UPDATE `.returning()`, not caller input (link-validation.ts:739,762) | closed |
| T-11-19 | Denial of Service | recompute throw blocks verify | mitigate | `buildLineOperationalReviewPlan(...).catch(()=>null)` + `patchLineSchedulerOperationalPlan(...).catch(()=>undefined)`; verify returns regardless (link-validation.ts:776-794) | closed |
| T-11-20 | Tampering | recompute resets adminSelectedSessionIds | accept | Intentional fresh base plan; matches existing operational-plan route behavior (link-validation.ts:791) | closed |
| T-11-21 | Information Disclosure | re-anchor fetch visible in network tab | accept | Admin-only UI; OA's own follower audience | closed |
| T-11-22 | Tampering | archive toggle hides real contacts | mitigate | Default scopes `"all"`/`"my"`, never phantom (mapping-validation-workspace.tsx:31-32; panel defaultScope="my"); phantom requires explicit selection | closed |
| T-11-23 | Denial of Service | re-anchor rapid re-click | mitigate | `disabled={Boolean(busy)}` while busy="reanchor"; server idempotency (mapping-validation-workspace.tsx:230) | closed |

*Status: open · closed*
*Disposition: mitigate (implementation required) · accept (documented risk) · transfer (third-party)*

---

## Accepted Risks Log

| Risk ID | Threat Ref | Rationale | Accepted By | Date |
|---------|------------|-----------|-------------|------|
| AR-11-01 | T-11-03 | Quarantined phantom rows visible only in an explicit admin-only "Legacy" scope; no PII beyond what's already stored | gsd-secure-phase (user-approved verify) | 2026-06-07 |
| AR-11-02 | T-11-07 | Eval fixtures are synthetic non-identifying Thai/English name patterns; not linked to real DB rows | gsd-secure-phase | 2026-06-07 |
| AR-11-03 | T-11-12 | `onConflictDoNothing` makes a crafted-userId collision a silent no-op (insert-only); never overwrites webhook contact data | gsd-secure-phase | 2026-06-07 |
| AR-11-04 | T-11-14 | Re-anchor is admin-only and bounded by `maxDuration=60`; ~300 followers in ~60s | gsd-secure-phase | 2026-06-07 |
| AR-11-05 | T-11-20 | Recompute intentionally resets `adminSelectedSessionIds=[]` to a fresh base plan; admin re-selects; matches existing route | gsd-secure-phase | 2026-06-07 |
| AR-11-06 | T-11-21 | Re-anchor network call exposes only the OA's own follower list to an authenticated admin | gsd-secure-phase | 2026-06-07 |

*Accepted risks do not resurface in future audit runs.*

---

## Security Audit Trail

| Audit Date | Threats Total | Closed | Open | Run By |
|------------|---------------|--------|------|--------|
| 2026-06-07 | 23 | 23 | 0 | gsd-security-auditor (verify-all, user-approved) |

---

## Sign-Off

- [x] All threats have a disposition (mitigate / accept / transfer)
- [x] Accepted risks documented in Accepted Risks Log
- [x] `threats_open: 0` confirmed
- [x] `status: verified` set in frontmatter

**Approval:** verified 2026-06-07
