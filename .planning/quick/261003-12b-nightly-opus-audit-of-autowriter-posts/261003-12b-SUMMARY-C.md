---
status: complete
quick_id: 261003-12b
part: C (integration: verify, correct, recover)
branch: feat/autowriter-nightly-correct (slot-a), not pushed
base: feat/autowriter-nightly-audit e62bb5d2 + PR B (8fdc2f5a 8f7b1432 13a4e03f d8a699ab, then its 15 review-fix commits 09057c85..4d8a7ffb, cherry-picked) + PR A merged at da249460, then at 6bcfccde
subsystem: feedback-autowriter
tags: [nightly, opus, glm-judge, hmac, wise, postgres, autowriter, correction]
requires:
  - "PR A: nightly audit path (bundles, cached AuditRecords, ledger, claude runner, text-problems, flags)"
  - "PR B: correctPostGuarded + pgCorrectionStore + recoverStaleCorrections + releaseStaleCorrectionLock"
provides:
  - "verify: checked correction candidates (replay draft or exact minimal fixes) as HMAC-signed proposals"
  - "correct: signed proposals through the guarded executor, plan from the database, one class at a time, windows and caps"
  - "recover: settle what a dead correction run left, lift its stale lock; preflight refuses while anything is unsettled"
affects: [scripts/feedback-autowriter-nightly.ts, replay.ts (shared judge helper), runbook §10]
key-files:
  created:
    - src/lib/feedback-autowriter/judge-draft.ts
    - src/lib/feedback-autowriter/nightly/judge-candidate.ts
    - src/lib/feedback-autowriter/nightly/minimal-fix.ts
    - src/lib/feedback-autowriter/nightly/proposals.ts
    - src/lib/feedback-autowriter/nightly/verify.ts
    - src/lib/feedback-autowriter/nightly/correct-step.ts
    - src/lib/feedback-autowriter/__tests__/judge-draft.test.ts
    - src/lib/feedback-autowriter/nightly/__tests__/judge-candidate.test.ts
    - src/lib/feedback-autowriter/nightly/__tests__/minimal-fix.test.ts
    - src/lib/feedback-autowriter/nightly/__tests__/proposals.test.ts
    - src/lib/feedback-autowriter/nightly/__tests__/verify.test.ts
    - src/lib/feedback-autowriter/nightly/__tests__/correct-step.test.ts
    - src/lib/feedback-autowriter/nightly/__tests__/correct.integration.test.ts
  modified:
    - scripts/feedback-autowriter-nightly.ts
    - src/lib/feedback-autowriter/replay.ts
    - src/lib/feedback-autowriter/nightly/flags.ts
    - src/lib/feedback-autowriter/nightly/steps.ts
    - src/lib/feedback-autowriter/nightly/paths.ts
    - src/lib/feedback-autowriter/nightly/retention.ts
    - docs/operations/feedback-autowriter.md
key-decisions:
  - "correction.ts, correction-store.ts and validate.ts untouched (PR B's own): the read-only unsettled check lives in nightly/correct-step.ts and mirrors the reviewed release rules"
  - "correct runs the executor's own dry run (reads only) before each apply: a refused class never waits for a window or takes the cap"
  - "every paid call of verify is reserved first and recorded under verify/calls as started (before) and done (after): one re-audit per candidate, ever, also after a crash; PR A's ledger no longer says whether a call was made"
  - "a proposal must carry every verify check, passed (critical_confirmation for a critical), or correct refuses it"
  - "proposals keep only the posted stamp's versions and ids: a stamp's factualVerdicts can quote the draft"
  - "the correction flag is raised by the correction's own actor, so PR A's database-counted audit flag cap never counts it"
  - "an ISEB candidate is judged with the Atom evidence its writer had (redacted, with the judge's Atom rules); candidate A stays refused for every guided post"
duration: ~70 min (round 1) + ~50 min (round 2)
completed: 2026-10-03
---

# 261003-12b PR C: the nightly corrects what it finds — verify, correct, recover

**`verify` turns each audited class with a real, text-fixable error into a corrected text that passed production's
validators, both GLM judge levels and an Opus 5.5 max re-audit, and signs it; `correct` sends only signed proposals,
one class at a time in the correction windows, through PR B's guarded executor with a plan read from the database;
`recover` settles whatever a dead run left. Nothing is retried in a loop, every paid call is reserved first.**

## What was built

- **`judge-draft.ts`** — `judgeDraftAtEveryLevel`: replay's private `judgePostedDraft` made reusable (production's
  messages and redaction, both levels on byte-identical messages, summary mode gets production's `otherPeopleNamed`
  list, optional pinned-route check). `replay.ts` delegates to it; its tests are unchanged and green.
- **`nightly/judge-candidate.ts`** — `judgeCandidate(deps, { fields, bundle })`: both levels against the bundle's
  transcript (else Wise's summary), production's pinned route required, every call (rate-limit retries included)
  reserved as `openrouter` before it is sent; a refused reservation is never sent (`capStop`), a billed cost over a cap
  is reported (`breached`).
- **`nightly/minimal-fix.ts`** — `applyMinimalFixes` (exact, in order, once each; `fix_no_match`/`fix_ambiguous`/
  `no_minimal_fix`/`fix_without_replacement`; gap tidy; `too_many_words_changed:N%` above 25%), `changedWordShare`,
  `lengthRatio`.
- **`nightly/proposals.ts`** — the HMAC key (`~/.bgscheduler-nightly/hmac.key`, 32 random bytes, 0600, `wx`, refused when
  group/other-readable or not 32 bytes), canonical JSON, `signProposal`/`verifyProposal` (unsigned, mismatched, malformed,
  empty `rootCauseRef` refused), `writeProposal`/`readProposalFiles`.
- **`nightly/verify.ts`** — `stepVerify`: per class needs-Kevin (M13/M14, `billing_status`, `should_not_have_posted`, a
  mode no text fixes, a non-candidate M13/M14 precheck floor) and blocked (no first-shot row, Wise text edited, person's
  save, owner flag, student unknown, posted-hash mismatch) at no cost; criticals confirmed by a second fresh Opus audit
  of the post on an overlapping quote (else needs Kevin); candidate A from `<replay-dir>/records.json` (never guided),
  candidate B from the minimal fixes; checks cheapest first; signed proposal; per-class record `verify/<sid>.json`;
  concurrency = `auditConcurrency`; at most `maxCorrectionsPerNight` proposals.
- **`nightly/correct-step.ts`** — `loadCorrectionRows`/`loadDisabledTutors` (SELECTs), `planFromRows` (ids, base text,
  submission, billing, `post_started_at` from the rows; text and stamps from the proposal), `missingProposalChecks`,
  `unsettledCorrections` (in-flight rows, live/stale/halted-on-top lock, `releasable`), `guardedWiseOps` (both STOP files
  before every read, 429s noted, POST passes through), `msUntilCorrectionWindow`, `runStopForRefusal`, `stepCorrect`,
  `stepRecover`, `preflightCorrections`.
- **`nightly/flags.ts`** — `correctionFlagItem` / `agentCorrectionFlagKey` (`agent-correction:<sid>`, "corrected by the
  nightly agent: <mode codes>", the original severity, no incident).
- **`nightly/steps.ts`** — `PreflightFacts.corrections`; preflight stops `unsettled_correction` (or
  `corrections_unreadable:<name>`), exit 6.
- **`nightly/paths.ts` / `retention.ts`** — `proposals/`, `verify/`, `replay/` (deleted after 7 days) and
  `corrections.jsonl` (kept: ids and codes only).
- **CLI** — `verify`, `correct`, `recover`; `preflight` now async with the dry-run recover; `status` shows the proposals.

## Commands

```sh
npx tsx --tsconfig scripts/tsconfig.json scripts/feedback-autowriter-nightly.ts <command> --night=YYYY-MM-DD [--json]
  verify --root-cause-ref=<fix branch|PR> [--replay-dir=<dir>] [--sessions=a,b]
  correct [--apply] [--supervised] [--max=n] [--sessions=a,b] [--no-deadline]
  recover [--apply] [--supervised]
# Candidate A (optional): the fixed pipeline replayed from the night's cache into the night's folder
npx tsx --tsconfig scripts/tsconfig.json scripts/autowrite-online-feedback.ts --replay \
  --transcripts-from=~/.bgscheduler-nightly/nightly/cache --sessions=<failed classes> \
  --out=~/.bgscheduler-nightly/nightly/<night>/replay --no-posted-judge
```

`verify` needs `OPENROUTER_API_KEY` (the judge) and the database (prior feedback, other students: SELECTs). `correct`
needs `WISE_USER_ID`/`WISE_API_KEY`/`WISE_INSTITUTE_ID` and the database; `--apply` only from a clean checkout whose
HEAD equals `refs/remotes/origin/main` (fetch first), or with `--supervised` (recorded on every outcome).

Exit codes: 0 ok · 1 error (`db_error`, `flag_failed`, recover `read_failed`) · 2 usage (`root_cause_ref_missing`) ·
3 caps (`cap:…`, `cap:daily_db`) · 4 Claude usage/auth · 5 Wise (`wise_429`, `wise_cooldown`) · 6 guard
(`not_origin_main`, `dirty_tree`, `code_unknown`, `proposal_invalid`, `unsettled_correction`, `clock_skew`, `hmac_key_*`,
recover `still_unsettled`) · 7 STOP/deadline/`outside_window`/`awaiting_event_locked` (next `recover --apply`, with
`recoverNotBefore`)/`not_sent:<reason>`/`production_halted`/`lease_live` · 10 safety (`safety`, `correction_error`,
`breach:…`; STOP written).

## Verification (round 2, at the final head)

- `npx vitest run --project unit src/lib/feedback-autowriter`: **61 files, 1135 tests passed**. This round's new or
  changed tests: judge-draft 6 (Atom evidence), judge-candidate 9 (Atom evidence), verify 21 (call records, PR A's caps,
  the ISEB judge gets the Atom evidence), correct-step 29 (aiSuspect and shared clock, `awaiting_event_locked` with
  `recoverNotBefore`, the not_sent kinds, `production_halted`, `lease_live`, and one apply end to end through the real
  reviewed executor with PR B's fake Wise), flags (the correction flag's own actor).
- Integration (Testcontainers on OrbStack, `TEST_DATABASE_URL` unset), every suite asked for: `correction-store`,
  new `correct` (7), `nightly` (6), `job`, `review`, `replay` — **6 files, 249 tests passed**, at ad798e5b and again at
  20bf4648 (after the 6bcfccde merge).
- `npm run typecheck` (`tsc --noEmit`): 27 errors, all pre-existing in files this branch never touches
  (`tutor-offboarding/workforce/*` — `d3`; `classrooms/overflow-planner*` — `highs`); none in changed files.
- `npx eslint src/lib/feedback-autowriter scripts/feedback-autowriter-nightly.ts scripts/autowrite-online-feedback.ts`:
  clean. `git diff --check feat/autowriter-nightly-audit..HEAD`: clean.
- Round 1: unit 61 files / 1060 tests; integration correction-store, nightly, correct, replay — 62 passed. Real 2 Oct
  data shape (local, read-only, codes only, never committed): 14 bundles (8 `retranscribed`, 5 `exact` summary, 1 `exact`
  ISEB) and the first v2 audits load; the one major issue then (M05, `replace_span`) applied exactly (1% of words, length
  1.00) and passed `correctionTextProblems`.
- No production command was run: no nightly CLI subcommand, no `--replay`, no Wise, Soniox, OpenRouter or production
  database access.

## Round 2 (PR B review fixes, PR A merged, Atom evidence)

1. **PR B review fixes cherry-picked** (15 commits, clean): `f0e4e858 … 135f5784`.
2. **`22b3c3cd` correct and recover adopt the reviewed executor:**
   - `aiSuspect` (required) built from the class's bundle: the student's full, display and guest names, the tutor's
     names, the tutor's prior feedback (`loadTutorPriorFeedback`), `styleGuided` from the post's stamp;
   - the CLI hands `pgCorrectionStore` the executor's own clock (`now: ctx.now`) for the `clock_skew` check;
   - `awaiting_event_locked` stops the night's corrections (exit 7, `next: "recover --apply"`, `recoverNotBefore` =
     now + 25 min); a released outcome with `productionStillHalted` stops the run (`production_halted`, exit 7);
   - `not_sent`: only `wise_rate_limited` parks Wise (30 min, exit 5); `lock_lost`/`lock_budget`/`lock_check_failed`
     stop the run (`not_sent:<reason>`, exit 7);
   - `recover --apply` answers `lease_live` (exit 7) and releases nothing while a correction lease is live;
   - `unsettledCorrections` mirrors the stricter release: a halt appended to or folded into the lock (control row written
     since: `updated_at <> halted_at`) is `halted_on_top`, never releasable; any unsettled correction keeps the lock.
3. **`0e1334bb` merge of PR A at da249460.** Conflicts resolved in `steps.ts`/`steps.test.ts` (PR A's runner checks plus
   the unsettled-correction check), `flags.ts` (PR A's `countAgentFlags`/capped `applyAgentFlags` plus the correction
   flag), `nightly-fixtures.ts`, the CLI (PR A's killable claude children, `ledgerOutcome`, `runnerSha`, plus
   verify/correct/recover), `audit-prompt.ts` (PR A's), the runbook outputs paragraph.
4. **`3eb41765` verify after the merge:** PR A's ledger now counts a crashed reservation and every `infra:*` outcome as
   `other`, so verify records each paid call itself (`verify/calls/<sha256(key)>.json`: `started` before the call,
   `done` with its result after; a usage limit or login failure drops the record); Opus calls settle with
   `ledgerOutcome` (`invalid` when `parseAuditResult` rejects the answer). The correction flag is raised by
   `AGENT_CORRECTION_FLAG_ACTOR` (= the correction's actor), so `countAgentFlags` never counts it toward the audit's
   nightly flag cap.
5. **`fa5c432b` Atom evidence for the candidate judge:** `judgeDraftAtEveryLevel` takes the post's `atomModelEvidence`,
   redacts it and hands it to `buildJudgeMessages` exactly as production's pipeline does (Atom rules and the
   SOURCE_CONTRADICTION instruction come with it); `judgeCandidate` passes `bundle.atomEvidence`. The replay passes none
   (unchanged). Candidate A stays refused for every guided post.
6. **`7327cf08`** runbook and CLI usage; **`5abc24e3`** a trailing blank line in SUMMARY-B (`git diff --check`);
   **`ad798e5b`** PR A's nightly Postgres test expected the ISEB record without its new `atom` column (it fails on the
   PR A head too); **`638aa1df`** an apply end to end through the real reviewed executor.
7. **`f3a6ab2f` merge of PR A at 6bcfccde** (clean); **`20bf4648`** declares `thinkingTokens` on `ModelUsageEntry`:
   6bcfccde reads it but `tsc --noEmit` failed in `claude-runner.ts` (fails on the PR A head too; vitest does not
   typecheck).

## Deviations

1. **[Orchestrator]** `correction.ts`, `correction-store.ts`, `validate.ts` not edited (PR B's fixer owns them). The
   dry runs of `recover` and of `releaseStaleCorrectionLock` are read-only SQL in `correct-step.ts`
   (`unsettledCorrections`, `releasable`), cross-checked against the real release in the integration test.
2. **[Orchestrator]** Coded for the PR B fix: `awaiting_event_locked` (stop, `next: "recover --apply"`, flag raised),
   `productionStillHalted` read loosely from any outcome, `daily_cap` and `clock_skew` refusals end the run
   (`runStopForRefusal`), `rootCauseRef` required end to end.
3. **[Rule 3]** Cherry-picked PR A's 59d9df96 (AUDIT_VERSION 2): the night's audits are `.a2.`; one test keyed on a1
   fixed.
4. **[Rule 2]** `correct` runs the executor's dry run before each apply (≈4 extra Wise GETs a class): a refused class
   never waits for a window or consumes the night/week cap.
5. **[Rule 2]** `missingProposalChecks`: a proposal must carry every verify check, passed, plus `word_change` (minimal
   fix) and `critical_confirmation` (critical) — defence in depth against a signed but incomplete proposal.
6. **[Rule 2]** Proposals keep only the posted stamp's versions and ids (`postedStampOf`): `factualVerdicts` can quote
   the draft, and the stamp lands on the posts row.
7. **[Rule 2]** Paid calls of `verify` recorded under `verify/calls/` (`started` before, `done` after) and never
   repeated per key, also after a crash mid-call; a usage-limit or auth outcome drops its record, so a later run may
   make the call.
8. **[Rule 2]** `recover --apply` follows `correct --apply`'s checkout rule (or `--supervised`) and refuses under STOP
   (it can lift a lock); its dry run reads only the database.
9. **[Rule 2]** Safety outcomes (and an executor that throws while holding the lock) write `~/.bgscheduler-nightly/STOP`
   as the approved plan's anomaly path says; `awaiting_event_locked` does not (recover must still run).
10. **[Rule 2]** Per-class database read failure in `correct` ends the run (`db_error`, exit 1) before any Wise access.
11. Over-cap classes are left undecided (no record): a later night's run cannot reach them anyway (one night per run).
12. **[Rule 1, round 2]** A `not_sent` is no longer always a 429 (the reviewed executor also abandons before the POST
    when the lock is lost or its budget spent): only `wise_rate_limited` writes the Wise cooldown.
13. **[Rule 1, round 2]** Verify's never-repeat rule no longer reads the ledger (PR A changed what `attempts` counts);
    it records each call itself.
14. **[Rule 2, round 2]** The correction flag carries its own `createdBy` (`FlagPlanItem.createdBy`, optional, default
    `AGENT_FLAG_ACTOR`), so a night's corrections never use up the audit's flag cap.
15. **[Rule 3, round 2]** Fixes on PR A's and PR B's files: `nightly.integration.test.ts` (ISEB record now has
    `atom`), `claude-runner.ts` (`thinkingTokens` type), and the trailing blank line in PR B's SUMMARY-B. Apply the same
    on those branches, or merge this one.

## Hand-over notes

- `correct --apply` requires HEAD == `refs/remotes/origin/main` exactly (not merely reachable, as PR A's preflight
  accepts, and not PR A's pinned `runnerSha`): the scheduled task must fetch and reset the slot to `origin/main` first,
  or the owner passes `--supervised`.
- A correction can now take up to ~13 minutes (3 min under the lock before the POST, read-back retries up to 4 min, 5 min
  for our event), so the 06:10 window usually fits one or two classes; the next window is 06:40.
- `awaiting_event_locked` keeps the autowriter halted for up to the 20-minute lease: schedule `recover --apply` for
  `recoverNotBefore` (it answers `lease_live`, exit 7, before that).
- Tonight: `verify --night=2026-10-02 --root-cause-ref=fix/autowriter-repeated-answer
  --replay-dir=~/.bgscheduler-nightly/nightly/2026-10-02/replay`. The replay's drafts come from the fix branch (writer
  and judge prompts v6); verify checks every candidate with the production judge on this branch (v5) and an Opus
  re-audit, and the proposal records `rootCauseRef` as the fix's provenance (a `ReplayRecord` carries no prompt
  version). Classes the replay did not cover get candidate B only.

## Known stubs

None.

## Threat flags

| Flag | File | Description |
|------|------|-------------|
| threat_flag: secret_at_rest | nightly/proposals.ts | New local signing key `~/.bgscheduler-nightly/hmac.key` (0600). It stops edits by anything without it (the sandboxed fixer, a hand edit); it does not stop a process running as the owner. |
| threat_flag: wise_write | nightly/correct-step.ts | `correct --apply` is the nightly's only Wise write (planned): signed proposals only, database plan, PR B's guards. |

## Open risks / deferred

- `correct`'s Wise reads are not counted in the nightly `wise_read` cap (bounded: ≤ 6 corrections × ~10 reads; the
  first 429 stops the run and parks Wise for 30 min).
- A summary-route post's candidate is judged against the bundle's best record (transcript when collected, else the
  summary), which can be stricter than what the writer saw.
- `verify` decides a class once per night (records and paid calls cached); to redo one, delete `verify/<sid>.json` and
  its proposal — an identical candidate is still never re-audited.
- `run` does not chain `verify`/`correct`; the scheduled task calls them.
- The executor on this branch is PR B's reviewed version (15 fixes); `correct --apply` from it still needs
  `--supervised` until this branch (or PR B and PR C) is on `origin/main`.

## Self-Check: PASSED
