---
phase: "12"
plan: "04"
subsystem: line-identity
tags: [line, backlog-recovery, identity-resolution, ident-07, human-gate, production]
dependency_graph:
  requires: ["12-03"]
  provides: ["production dry-run verification", "owner approval", "446 live follower_profile suggestions"]
  affects: ["production line_contact_student_links"]
tech_stack:
  added: []
  patterns: ["local tsx runner with NODE_ENV=production env layering instead of session-cookie curl"]
key_files:
  created: ["scripts/backlog-recovery-dry-run.ts"]
  modified: []
decisions:
  - "Ran the gate via a local tsx script (scripts/backlog-recovery-dry-run.ts) calling runLineBacklogRecovery directly with production env (vercel env pull), per 12-RESEARCH Option B — avoids needing an admin session cookie"
  - "Owner approved FULL write (450) including ambiguous matches — ambiguity is dominated by multi-child families (one parent matching 2-3 siblings), which is desired linkage, not noise"
  - "Live write executed same day after approval; --live flag added to the runner"
metrics:
  duration: "gate opened + approved + executed 2026-06-10"
  completed_date: "2026-06-10"
  tasks: 1
  files: 1
requirements: [IDENT-07]
---

# 12-04: Production dry-run gate — APPROVED + EXECUTED

## Dry-run (read-only, before approval)

- 1,966 followers scanned (full roster), 666 verified resolver targets
- 450 matches: **229 high-confidence (exactly the UAT-predicted count)** + 221 ambiguous
- All 450 carried real `https://chat.line.biz/...` URLs
- Ambiguity analysis: 324 distinct userIds; 95 userIds matched >1 student — predominantly
  multi-child families (e.g., one parent → 3 Phota siblings); 154/221 ambiguous rows were
  single-token matches
- Full dry-run JSON: `/tmp/12-04-dryrun.json`; review CSV delivered to owner

## Gate

Owner inspected the 450-row CSV and approved the **full write** (not high-only) on 2026-06-10.

## Live write + verification

- `npx tsx scripts/backlog-recovery-dry-run.ts --live` (NODE_ENV=production): matched 449,
  insert attempts 449 (1 follower delta vs dry-run — roster drift between runs)
- Prod DB verification (read-only psql):
  - `line_contact_student_links` with `evidence->>'source'='follower_profile'`: **446 rows**
    (3 deduped by `onConflictDoNothing` — pre-existing contact×student pairs)
  - 322 distinct contacts; status `suggested` = 446 (100% — IDENT-02 fail-closed held);
    218 flagged `ambiguous`; 446/446 carry `chat.line.biz` originalUrl (LINE button wired)

## Deviation

- Plan's "~94 ambiguous" estimate was low (actual 221); investigated before the gate — the
  excess is multi-child-family fan-out, accepted by owner as desired behavior.
