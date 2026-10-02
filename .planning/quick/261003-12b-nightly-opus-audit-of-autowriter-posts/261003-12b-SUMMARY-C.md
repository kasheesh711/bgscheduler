---
status: complete
quick_id: 261003-12b
part: C (integration: verify, correct, recover)
branch: feat/autowriter-nightly-correct (slot-a), not pushed
base: feat/autowriter-nightly-audit e62bb5d2 + PR B (8fdc2f5a 8f7b1432 13a4e03f d8a699ab cherry-picked) + PR A 59d9df96 (cherry-picked)
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
  - "correction.ts, correction-store.ts and validate.ts untouched (PR B's fixer owns them): the read-only unsettled check lives in nightly/correct-step.ts"
  - "correct runs the executor's own dry run (reads only) before each apply: a refused class never waits for a window or takes the cap"
  - "every paid call of verify is reserved first and cached by key under verify/calls: one re-audit per candidate, ever"
  - "a proposal must carry every verify check, passed (critical_confirmation for a critical), or correct refuses it"
  - "proposals keep only the posted stamp's versions and ids: a stamp's factualVerdicts can quote the draft"
duration: ~70 min
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

Exit codes: 0 ok · 1 error (`db_error`, `flag_failed`) · 2 usage (`root_cause_ref_missing`) · 3 caps (`cap:…`,
`cap:daily_db`) · 4 Claude usage/auth · 5 Wise (`wise_429`, `wise_cooldown`) · 6 guard (`not_origin_main`, `dirty_tree`,
`code_unknown`, `proposal_invalid`, `unsettled_correction`, `clock_skew`, `hmac_key_*`) · 7 STOP/deadline/
`outside_window`/`awaiting_event_locked` (next `recover`) · 10 safety (`safety`, `correction_error`, `breach:…`; STOP
written).

## Verification

- `npx vitest run --project unit src/lib/feedback-autowriter`: **61 files, 1060 tests passed** (baseline after the
  cherry-picks: 55 files, 977). New: judge-draft 5, judge-candidate 8, minimal-fix 12, proposals 6, verify 21,
  correct-step 26; flags +1, steps +3 assertions, retention +1.
- Integration (Testcontainers on OrbStack, `TEST_DATABASE_URL` unset): `correction-store.integration` 48,
  `nightly.integration` 5, new `correct.integration` 6, `replay.integration` 3 — **4 files, 62 passed**, re-run after
  the last code commit.
- `npm run typecheck` (`tsc --noEmit`): 27 errors, all pre-existing in files this branch never touches
  (`tutor-offboarding/workforce/*` — `d3`; `classrooms/overflow-planner*` — `highs`); none in changed files.
- `npx eslint src/lib/feedback-autowriter scripts/feedback-autowriter-nightly.ts scripts/autowrite-online-feedback.ts`:
  clean. `git diff --check` over the branch: clean.
- Real-data shape (local, read-only, codes printed only, never committed): the 14 bundles of 2 Oct (8 `retranscribed`
  transcript posts, 5 `exact` summary posts, 1 `exact` ISEB record) and the first five v2 audits load through
  `cachedAudit`; judge evidence modes, blocked reasons and needs-Kevin reasons compute; the one major issue so far
  (M05, `replace_span`) applies exactly (1% of words, length 1.00) and passes `correctionTextProblems`.
- No production command was run: no nightly CLI subcommand, no `--replay`, no Wise, Soniox, OpenRouter or production
  database access.

## Deviations

1. **[Orchestrator]** `correction.ts`, `correction-store.ts`, `validate.ts` not edited (PR B's fixer owns them). The
   dry runs of `recover` and of `releaseStaleCorrectionLock` are read-only SQL in `correct-step.ts`
   (`unsettledCorrections`, `releasable`), cross-checked against the real release in the integration test.
2. **[Orchestrator]** Coded for the PR B fix: `awaiting_event_locked` (stop, `next: "recover"`, flag raised),
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
7. **[Rule 2]** Paid calls of `verify` cached under `verify/calls/` and never repeated per key (a dead run's reservation
   counts as attempted); usage-limit/auth outcomes are not cached, so a later run may make the call.
8. **[Rule 2]** `recover --apply` follows `correct --apply`'s checkout rule (or `--supervised`) and refuses under STOP
   (it can lift a lock); its dry run reads only the database.
9. **[Rule 2]** Safety outcomes (and an executor that throws while holding the lock) write `~/.bgscheduler-nightly/STOP`
   as the approved plan's anomaly path says; `awaiting_event_locked` does not (recover must still run).
10. **[Rule 2]** Per-class database read failure in `correct` ends the run (`db_error`, exit 1) before any Wise access.
11. Over-cap classes are left undecided (no record): a later night's run cannot reach them anyway (one night per run).

## Hand-over notes for the PR B fix cherry-pick

- The executor input is built once, in `correct-step.ts` (`const input: CorrectPostInput = {…}`). The prior feedback
  the new required AI-suspect check needs is already loaded there (`extra.priorFeedback`, `loadTutorPriorFeedback` per
  tutor), with the bundle's names in `context`.
- `scripts/feedback-autowriter-nightly.ts` `recover()` calls `recoverStaleCorrections(db, reads, { apiActorId, actor })`
  and `releaseStaleCorrectionLock(db, { actor })`; adapt if their signatures change.
- `unsettledCorrections` parses `correction-lock:<uuid> … nightly agent correcting <sid>` and uses the exported
  `isCorrectionLockReason` for exactness: update its two regexes if the lock reason changes.
- The one real-executor test ("stepCorrect with the real executor (dry run)") uses PR B's `correction-fixtures` and a
  store with `preconditions` only; add any new required store method there.

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
- The candidate judge has no Atom evidence for Atom/ISEB posts: such candidates likely fail the judge (fail closed) and
  the class is reported without a proposal.
- A summary-route post's candidate is judged against the bundle's best record (transcript when collected, else the
  summary), which can be stricter than what the writer saw.
- `verify` decides a class once per night (records and paid calls cached); to redo one, delete `verify/<sid>.json` and
  its proposal — an identical candidate is still never re-audited.
- `run` does not chain `verify`/`correct`; the scheduled task calls them.
- Corrections must wait for PR B's reviewed fix (the executor on this branch is the pre-review version).

## Self-Check: PASSED
