---
quick_id: 261003-12b
part: A (audit path)
branch: feat/autowriter-nightly-audit (slot-eval), not pushed
base: origin/main 43a47dd7
completed: 2026-10-03 ~01:56 BKK
---

# Quick 261003-12b — PR A: nightly Opus 5.5 max audit path — Summary

A resumable, scripted nightly audit of the autowriter's verified posts of one Bangkok day: SELECT-only target
selection, cache-first read-only evidence collection (one paced Wise GET per class, production Soniox transcript via a
get/transcript-only facade, Zoom captions, retained ISEB records, optional capped re-transcription on our own deleted
Soniox job), deterministic prechecks, one pinned `claude -p` Opus 5.5 max audit per class with proof of model, a merged
report + M16 spend/retry watchdog + one synthesis call (plan + sanitised fix brief), agent flags (dry run unless
`--apply`), 7-day retention, and a cache-only replay mode.

## Commits (17, oldest first)

| Commit | What |
|---|---|
| f0c1022c | Orchestrator's `modes.ts`, `audit-schema.ts`, `audit-prompt.ts` + tests (unchanged), with `types.ts` |
| b5277f03 | `paths.ts`, `caps.ts`, `ledger.ts`, `lock.ts` |
| 84ad22e0 | `select.ts` + pg-proxy fake DB for unit tests |
| 152acb69 | `evidence.ts`, `exit.ts`, `wise-reader.ts` |
| a97798f2 | `text-problems.ts`, `prechecks.ts` |
| 742dc7b3 | CLI `status/preflight/select/collect` + `steps.ts` (then COLLECT_READY written) |
| 02858e75 | `claude-runner.ts` |
| 6b2243e7 | `audit.ts`, `stepAudit`, CLI `audit [--smoke|--plan]` |
| 831e1379 | `review-job.ts`: export `insertFlag` (source `agent`, optional `createdBy`) |
| 9363257d | `report.ts`, `synthesis.ts`, `flags.ts`, `retention.ts`, CLI `report/flag/run/prune/costs` |
| b37b635a | Replay cache (A1): `replay.ts` + `--replay --transcripts-from/--out/--no-summary-draft/--no-posted-judge/--max-model-usd` |
| 1b024aae | Docs: failure-mode registry + runbook § 10 (+ doc/code sync test) |
| ddab17e0 | Postgres integration test for all nightly SQL |
| ceddc552 | Wise reader / exit-code tests (reader methods async) |
| ec0e2557 | `run` ends with prune (not after STOP) |
| ba40fa16 | LEFT JOIN on first-shot rows (orchestrator request), `noFirstShotRow` |
| e62bb5d2 | Synthesis reused when the audits have not changed |

## Commands

```sh
npx tsx --tsconfig scripts/tsconfig.json scripts/feedback-autowriter-nightly.ts <command> [--night=YYYY-MM-DD] [--json] [--no-deadline]
  status | preflight | select [--sessions=a,b] [--force]
  collect [--retranscribe] [--soniox-usd=n] [--sessions=a,b]
  audit [--smoke] [--plan] [--sessions=a,b]
  report [--no-synthesis] | flag [--apply]
  run [--apply-flags] [--retranscribe] [--soniox-usd=n] [--no-synthesis]
  prune [--dry-run] | costs [--days=7]
npx tsx --tsconfig scripts/tsconfig.json scripts/autowrite-online-feedback.ts --replay \
  --transcripts-from=~/.bgscheduler-nightly/nightly/cache [--sessions=a,b] [--out=<dir>] \
  [--no-summary-draft] [--no-posted-judge] [--max-model-usd=n]
```

State root `$BGS_NIGHTLY_ROOT` or `~/.bgscheduler-nightly/nightly` (0700/0600); STOP files
`~/.bgscheduler-nightly/STOP` and `/Users/kevinhsieh/Developer/Scheduling/.feedback-autowriter/STOP`; owner config
`~/.bgscheduler-nightly/config.json` (tighten only). Exit codes 0/1/2/3/4/5/6/7/10 as specified.

## Verification

- `npx vitest run --project unit src/lib/feedback-autowriter`: 52 → 54 files, **896 passed** (nightly: 17 files, 151 tests).
- Integration (Testcontainers Postgres, all migrations): `nightly.integration` (5), plus the existing `review.integration`
  and `replay.integration` suites touched by this change — **55 passed**.
- `npm run typecheck`: zero errors in changed files; the only errors are pre-existing (`d3`/`highs` missing from this
  machine's `node_modules` — every local checkout predates #129/#82; not reinstalled, disk at 97 %).
- `npx eslint src/lib/feedback-autowriter scripts/feedback-autowriter-nightly.ts scripts/autowrite-online-feedback.ts`: clean.
- `git diff --check` over the branch: clean.
- CLI smoke on a scratch state root: `status`, `preflight`, `audit --plan`, `audit` (no bundles), `prune --dry-run`,
  `costs`, `flag` (dry run) — JSON lines and exit codes as specified. No production DB/Wise/Soniox command was run by
  the builder; no real `claude -p` call was made by the builder.

## Deviations

1. **[Orchestrator change]** State root outside the worktree (`~/.bgscheduler-nightly/nightly`); COLLECT_READY at
   `~/.bgscheduler-nightly/nightly/COLLECT_READY`.
2. **[Orchestrator change]** First-shot rows LEFT-joined; `NightlyTarget.firstShotPostId: string | null`; `select`
   summary `noFirstShotRow`; info precheck `no_first_shot_row`.
3. **[Rule 2]** Extra modules: `exit.ts` (exit codes + `NightlyStop`), `wise-reader.ts` (GET-only Wise client with
   `maxRetries: 0, stopOnRateLimit` — `createWiseFeedbackOps` retries 429s three times and exposes the POST),
   `steps.ts` (testable step logic; the CLI is thin).
4. **[Rule 2]** `replay.ts` keeps `soniox: SonioxClient` required (existing tests type against it); cache-only replays
   pass `refusingSoniox()` — a stand-in with no key and no network that refuses every call.
5. **[Rule 2]** Postgres integration test for every nightly SQL path (only fakes were planned) — caught nothing, but
   the select/watchdog/flags SQL is now proven before production use.
6. **[Rule 2]** `run` ends with prune (plan step 8); synthesis cached by input hash (a report re-run never pays twice);
   a breach (cap passed after the fact) writes STOP and outranks other stage stops.
7. **[Rule 1]** Re-transcription only when the production job is gone (`missing`/`no_job`), never on a transient
   read error of a job that may still exist.

## Open risks / notes for the orchestrator

- **Re-select 2 Oct**: `select` was cached before the LEFT JOIN fix — run `select --night=2026-10-02 --force` to pick up
  verified posts without a first-shot row (collect is cache-first, so re-collecting is cheap).
- Posts verified after `select` ran (late transcript-first classes) are not picked up by later nights (one Bangkok day
  per run). Consider `select --force` before `audit` on a resumed night.
- A summary-route post is graded `exact` on Wise's current AI summary (assumed unchanged since writing; no hash was
  stored for non-guided posts).
- The scheduled task's environment must have `claude` on PATH (`~/.local/bin`) and node ≥ 22.
- `other_student_named` / `meta_word` / `other_person_named` are heuristics by design (candidates the audit confirms);
  the synthesis brief check may reject a legitimate brief that uses a word equal to a real nickname (fail closed:
  plan.md is still written).
- `flag` is a dry run unless `--apply`; `run` flags only with `--apply-flags`.

## Self-Check: PASSED

All 17 commits present on `feat/autowriter-nightly-audit`; tracked tree clean; files listed above exist.
