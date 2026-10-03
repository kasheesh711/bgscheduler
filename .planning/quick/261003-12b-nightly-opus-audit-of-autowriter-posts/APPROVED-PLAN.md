# Nightly Opus 5.5 max audit + self-correcting loop for autowriter posts

## Context

The feedback autowriter (`src/lib/feedback-autowriter/`) posts Wise teacher feedback for ~27 roster tutors' online
1:1 classes (36 posts on 2 Oct). Errors still reach parents (29–30 Sep: another student's exam credited to ours,
invented homework, padded praise). The production GLM dual judge catches ~47% of real errors (1 Oct
bake-off) and Kevin reviews every post by hand. The 29 Sep operating-loop design (`.planning/quick/260929-lop-…/
DESIGN-AGENTS.md`, `DESIGN-INAPP.md`) planned an Opus triage agent and a guarded correction path; neither exists:
no scheduled task, no loop script, no way to edit an already-posted class except the 30 Sep one-off
`slot-a/.feedback-autowriter/correct-posts.ts`, and no AI audit of posted facts.

Goal: every night, on this Mac, Opus 5.5 at max effort re-checks the day's AI posts, logs failure modes, writes a
long-term improvement plan, fixes the root cause, proves the fix on the failed class, and corrects the post in
Wise — cheaply, with no runaway loops, and with production model changes only when they lower cost per accurate
post.

**Owner decisions (2–3 Oct):**
- Full loop overnight; code fixes wait in a draft PR for Kevin; morning summary. (Replaces the 29 Sep rules "nights
  are log-only" and "agent re-posts need owner OK".)
- AI-written posts only; tutor-written feedback is never read or touched.
- The Mac makes the Wise edit, through a reviewed, guarded command (overrides "the Mac never writes to Wise").
- Real (major or critical) errors are corrected even in posts Kevin already approved, and flagged for re-review.
- Opus runs only on Kevin's Claude Code subscription (`claude -p`, OAuth; never an API key or OpenRouter). Each run
  audits every AI post of ONE Bangkok day (the day just ended). First run, now: 2 Oct only.
- Local evidence kept 7 days in 0600 files, then auto-deleted.
- Cost conscious; no repeating loops; upgrade models only when accuracy per dollar improves.

**Facts that shape the design** (exploration + 3 design reviews):
- 2 Oct: 36 verified posts (17 transcript, 19 summary), 28 already approved by Kevin. Production spend ≈ $2.2/day
  (Soniox $1.87, writer $0.22, judge $0.08).
- Opus max audit ≈ $0.44/class at API prices (~$11–20/night) — runs on subscription quota, capped.
- Evidence is mostly not stored: Soniox job kept ≤72 h but deleted early once Kevin approves (`triagedAt`);
  recordings vanish ~24 h after class; Zoom VTT re-fetched from Wise. **The replay tool deletes the Soniox job it
  uses — it must never be pointed at a production job.**
- `kasheesh711/bgscheduler` is PUBLIC: no student names or lesson text in any commit, PR, or doc.
- Feedback deadline is 23:59 BKK on D+2 and on-time is proven by the earliest save, so a D+1 correction cannot make a
  class late — but the LATEST version is what the payout content policy assesses (`post-class-feedback/policy.ts`
  :533, :601–653), so a correction must itself be policy-compliant.
- Installed CLI 2.1.287: `claude -p --safe-mode` keeps subscription auth while disabling CLAUDE.md, hooks, plugins,
  MCP; plus `--model claude-opus-5-5 --effort max --tools "" --json-schema --max-budget-usd
  --no-session-persistence --permission-prompts none --strict-mcp-config`. Desktop scheduled tasks store only cron +
  cwd (no model/effort/permission mode), so every reasoning step pins Opus 5.5 max itself and logs proof.
- Auto mode blocked a production DB read during planning → the unattended run needs explicit allow rules.

## Architecture

A thin scheduled session runs a resumable, scripted state machine; all reasoning is pinned `claude -p` calls;
the only Wise writer is a deterministic executor running reviewed code from `origin/main`.

| Step | Runs as | Sees real data | Has prod credentials |
|---|---|---|---|
| preflight, collect, report, correct | `scripts/feedback-autowriter-nightly.ts <step>` (main's code) | yes | yes |
| audit (per class), analyse/plan, verification re-audits | `claude -p --safe-mode … --model claude-opus-5-5 --effort max --tools ""` | yes (stdin) | no tools at all |
| fix | `claude -p` Opus 5.5 max, edit tools in the slot only, `--strict-mcp-config --disallowedTools "mcp__*"`, scrubbed env | **no** (sanitised brief + synthetic fixtures) | no |
| verify replay | branch code, offline from the night's bundles, scrubbed env (OpenRouter key only) | bundles | no |

Every step prints one JSON line `{ok, stop, next, summary}` and checkpoints to `run.json`, so a resumed run never
repeats a completed step. Every `claude -p` call logs argv, CLI version, `modelUsage`, tokens and
`total_cost_usd`; an output without `claude-opus-5-5` usage is discarded (fail closed) — that is the proof Opus 5.5
max ran.

## The nightly run (D = the Bangkok day that just ended)

Desktop scheduled task `bgs-autowriter-nightly`, cron `30 1 * * *` (01:30 BKK + app jitter), cwd
`.claude/worktrees/slot-eval`, under `caffeinate`.

0. **preflight**: STOP files absent (`~/.bgscheduler-loop/STOP` and the main checkout's
   `.feedback-autowriter/STOP`); O_EXCL lockfile with PID (stale only if the PID is dead); slot clean on
   `origin/main`; `.env.local` present; node 22; budget file present; settle any leftover `posting` correction row
   by Wise reads only (never re-send).
1. **collect** (main's code): D's verified AI posts with a first-shot post row, skipping any `(session,
   fields_sha256, AUDIT_VERSION)` already in the ledger; cap 60. Per class: one paced Wise session-detail GET
   (≤0.2 req/s, ≤200 reads/night, first 429 → stop + 30-min cooldown); the production Soniox transcript read-only
   (`get` + `transcript`, never `remove`) while it exists, else Zoom VTT; Wise summary; class details; posted text
   and Wise's current text. Writes a 0600 bundle and runs deterministic floors that the model can only raise:
   another student/the tutor named (critical/major), billing or credit-entry drift (critical), attendance/scope
   (critical), Thai/placeholder/meta words (major); plus hints (numbers not in evidence, homework cues, judgement
   words, third-party names, speaker-label sanity).
2. **audit**: one `claude -p` per bundle (concurrency 2, `--max-budget-usd 1.5`, cwd an empty temp dir, bundle on
   stdin, rubric via `--system-prompt-file`, JSON schema enforced, zod re-validation, one retry for infra/schema
   errors only). Wrapper post-checks fail closed: every quoted claim and evidence quote must be an exact substring
   of the post/bundle. Two-stage evidence: if a major/critical finding rests on weak evidence (transcript gone) and
   the recording still exists, one Soniox re-transcription (≤$2/night) and one re-audit.
3. **report**: per-class findings, failure-mode table vs the last 14 days, cost ledger, and the production
   spend-and-retry watchdog (SQL over `feedback_autowriter_calls`; outliers = mode `M16 cost_runaway`). Writes
   `report.md`, appends `ledger.jsonl`/`costs.jsonl`, inserts one `feedback_autowriter_flags` row (source `agent`,
   key `agent-audit:<sid>:<sha>:<mode>`) per major/critical issue — open flags put the class back in Kevin's review
   list — and a `critical_flag` incident for criticals (the app's hourly job pushes it).
4. **analyse/plan** (`claude -p` Opus max, no tools): reads the night's audits + ledger + registry; writes
   `plan.md` (per mode: mechanism, why the judge/validators missed it, fix, regression test, replay set, expected
   effect) and a **sanitised fix brief** (mode id, mechanism in words, synthetic fixture spec — no real names or
   quotes); picks at most ONE mode to fix tonight (backlog score = frequency × severity, not attempted in the last
   72 h, root cause in an allowed file, no open PR for that mode — an open PR is reused, not duplicated).
5. **fix** (`claude -p` Opus max fixer, ≤45 min, `--max-budget-usd 8`, ≤2 iterations): branch
   `fix/autowriter-audit-<mode>`; allowed files only (below); regression test from the synthetic fixture that fails
   on base and passes on the branch; `PROMPT_VERSION`/`JUDGE_PROMPT_VERSION` bumped when prompt text changes; unit
   tests, typecheck, lint. Then the script (not the fixer) runs the **scope check** (deny-listed paths, test and
   `reasons.push` counts never drop, `classifyGateReason` unchanged, no `.only`/`.skip`, size limits) and the
   **sanitisation check** (no real name from the bundles in Latin or Thai, no ≥8-word verbatim span).
6. **verify** (offline replay of the branch from the bundles; no Wise, DB or Soniox): the failed classes (≤3) +
   8 stratified clean posts of D + the committed synthetic golden set. Acceptance: target issue gone and no
   major/critical in an Opus max re-audit; no new issue on the sample (Opus pairwise compare); validator/judge
   rejections ≤ baseline + 1; names unchanged; projected coverage ≥ 75%; cost/draft ≤ 1.2× baseline. Pass → the
   script opens/updates the **draft PR** (sanitised root-cause note, replay table, registry update; label
   `audit-mode:<id>`). Never merged, never marked ready.
7. **correct** at 06:10–06:15 and 06:40–06:45 BKK only (≤6 per night, one at a time, see Guarded correction).
8. **summary**: local `summary.md`, one ≤200-char `PushNotification` (posts audited, errors by severity,
   corrections, PR, "Opus5.5max n/n", night cost), release lock, delete bundles older than 7 days.

Stop conditions (partial report, never a retry loop): STOP file, budget breach (also writes STOP), usage-limit or
two consecutive Claude errors, any Wise 429, DB unreachable, control row changed mid-run, 06:50 BKK.

## Guarded correction (the only Wise write)

New `src/lib/feedback-autowriter/agent-correct.ts` (pure guards + executor with injected Wise ops/store, movable
in-app later) and its DB store (`withDatabaseTransaction`, `src/lib/db/transaction.ts`). Dry run unless `--apply`.
It refuses to send from anything but a clean `origin/main` checkout, so unattended corrections start only after
Kevin merges PR B. The one exception is `--supervised`, for tonight's first run from the reviewed PR B branch with
this session watching; the scheduled task's allow rules exclude that flag.

**Which text**: the fixed pipeline's replay draft for that class (the test of the long-term fix), if it passed
step 6; otherwise a surgical edit from the audit's `minimalFix` (deletion first, ≤25% of words changed). Either
must pass main's `validateFeedbackDraft` (excluding the class's own prior post from the copy check), the style/
format validators of the first shot's pipeline stamp, both GLM judge levels on main, an Opus max re-audit with no
major/critical issue or omission, the payout content policy (`assessFeedbackContent` compliant, ≥350 chars, no
absence/exemption wording), and identical student nickname with no other student's name. **Criticals** additionally
need two independent Opus audits agreeing on the exact wrong span. `billing_status` / `should_not_have_posted`
are never edited — alert only. ISEB-format/Atom classes: surgical edit only (replay can't reproduce Atom evidence).

**Preconditions, re-read immediately before the POST:**
1. No STOP file (absolute paths); control row: mode `live`, not halted, tutor on; quiet check: no session in
   `posting`/`awaiting_event`, no `generating` row with a live lease, `stuckPostInFlight` false.
2. Session exactly `verified`; first-shot post row exists; `fields_sha256` equals the audited hash; no open
   owner-sourced flag; deadline more than 30 min away.
3. Fresh Wise read: ids match the DB row (never ids from model output); exactly one teacher submission (id kept);
   Wise's text exactly equals our last verified text; events show exactly one non-auto save since the first shot
   (ours) and no `owner_web`/`tutor`/`other_staff`/`api_actor_unmatched` fix events; status and credits equal the
   stored billing and the first shot's; exactly one credit entry equal to the billing (raw entries kept).

**Record first, then send**: insert the posts row (kind `correction`, actor_kind `agent`, actor
`agent:nightly-audit`, reason `<mode>: <one line>`, outcome `posting`, provenance `live`, `body_hash`, billing,
`post_started_at` from the DB clock, deterministic dedupe key `agent-correction:<sid>` → the database allows one
agent correction per class ever) in a conditional insert that re-checks the preconditions. Never write
`metadata.corrections[]` (the backfill would count it twice). One POST, never retried, same sessionStatus/credits.
**Verify**: read back after 3 s — new text, same submission id, one teacher submission, billing unchanged, credit
entries identical; exactly one API-actor save in the window and no foreign save. **Settle** (one transaction):
post row `verified`; session `fields`/`fields_sha256` updated by compare-and-swap; `body_hash`,
`post_started_at`, `verified_event` untouched.

**Anomaly** (unknown outcome, 4xx, read-back mismatch, credit/billing/submission change, foreign or extra save, 429
with changed text, no event within 2 h) → halt the autowriter first, settle the row, record a `correction_failed`
incident, write STOP, push. 429 with the old text intact → `not_sent`, no retry tonight. The Mac never resumes the
autowriter or changes its mode/tutor switches. **Money tripwire**: next night's preflight checks that no corrected
class gained a `post_class_deductions` row (else critical incident).

## Failure modes and logging

Taxonomy (enum in `src/lib/feedback-autowriter/audit/modes.ts`; the auditor rubric is generated from it, so they
never drift): M01 wrong_person (critical, owner precedent P1), M02 wrong student/lesson (critical), M03
homework_not_set (major, precedent P2; critical only inside M01), M04 invented_event (critical), M05
misheard_detail, M06 overstated_judgement, M07 tutor_work_as_student, M08 wrong_subject_content, M09
material_omission (major), M10 generic_padding (cosmetic), M11 naming_policy, M12 meta_or_format_leak (major), M13
billing_status_drift, M14 should_not_have_posted (critical), M15 false_hold, M16 cost_runaway; new modes are
provisional until seen twice in 14 days. Each issue also records the stage at fault (evidence / redaction / writer /
judge / validator / gate / style / renderer) and which existing defence should have caught it.

- **Local, real data** (0600, 7-day delete): `slot-eval/.feedback-autowriter/audit/<D>/` bundles, audits, `plan.md`,
  `report.md`, replay records, `claude-calls.jsonl`.
- **Local, metadata only** (kept): `ledger.jsonl` (ids, hashes, modes, verdicts, cost — no text), `costs.jsonl`.
- **Committed, sanitised**: `docs/operations/feedback-autowriter-failure-modes.md` — per mode: definition, synthetic
  example, detection, counts, root cause, fix PRs, status (open → pr_open → merged → monitoring → resolved /
  regressed / needs_owner) and the long-term improvement plan; status changes ride in fix PRs, counts in one weekly
  PR.
- **Database**: agent flags + critical incidents (above). Opus never writes owner verdicts.

## Guardrails for the fixer

- Allowed: `prompt.ts`, `judge.ts`, `validate.ts` (stricter only), `session.ts` gates (fail-closed only),
  `transcript.ts` thresholds, `pipeline.ts`, `style.ts`, `replay.ts`, `audit/modes.ts`, tests, fixtures, the
  registry doc.
- Denied (scope check + deny rules): `submit.ts billing.ts store.ts job.ts run.ts config.ts types.ts openrouter.ts
  soniox.ts roster.ts webhook.ts dispatch.ts ab.ts fix-events.ts review-job.ts quality.ts`, `src/app/api/**`,
  `src/lib/db/**`, `drizzle/**`, `src/lib/post-class-feedback/**`, `.github/**`, `scripts/**`, env, package files.
  A root cause there → `needs_owner` entry in the plan, no auto-fix.
- No merge/ready/deploy/push to main; no `--sweep/--process/--mode/--resume`; no MCP tools; no Wise or DB access.

## Cost and anti-runaway controls

| Scope | Cap |
|---|---|
| Per Claude call (`--max-budget-usd`, API-eq) | audit 1.5 · re-audit 1.5 · plan 2 · fixer 8; wall clock 10 / 45 min; >60k output tokens → discard |
| Per class | 1 audit (+1 infra retry), 1 re-transcription, 1 replay, 1 agent correction ever (DB-enforced) |
| Per night | Claude ≤ $25 API-eq · OpenRouter ≤ $3 · Soniox ≤ $2 (first night ≤ $4: 28 approved posts already lost their transcripts; ≈ $0 once PR C lands) · Wise ≤ 200 reads, ≤ 6 POSTs · 1 fix mode · 1 new PR · ≤ 10 flags |
| Per week | Claude ≤ $120 API-eq; at 80% fixes stop, audits continue · ≤ 15 corrections · ≤ 3 open loop PRs |

- Single flight (lockfile), one cron run a day, no self-scheduling (deny scheduled-task tools, `/loop`, `--resume`),
  no catch-up runs; idempotency keys for audits, flags, fixes (one open PR per mode), corrections, pushes.
- The nightly's own spend is kept out of `feedback_autowriter_calls` (local ledger), so production dashboards stay
  true. Push warns when a night exceeds 1.5× its 7-day average.
- The watchdog also covers production loops the review found: summary-path judge/infra retries every 10 min until
  the deadline with no count cap (`job.ts:336-353, 704-711, 1175-1204`), immediate `style_guide_changed` /
  `iseb_evidence_changed` retries with no counter (`job.ts:755, 763`), Soniox re-jobs on 404/timeout, ISEB style
  review retrying every 6 h forever, Atom opening a browser 4×/h when idle, and timed-out OpenRouter calls recorded
  with no cost (`openrouter.ts:175-193`).

## Weekly model review (accuracy per dollar)

Sunday after the nightly run; ≤ $8 OpenRouter, ≤ 25 Opus calls. Inputs: the week's bundles, Opus + owner labels.
Judges first (pre-post catching is the cheapest win), ZDR-probed routes only:
`z-ai/glm-5.3` high (~$0.037/draft, same pinned Together route), `google/gemini-3.8-flash` high (~$0.026),
`xiaomi/mimo-v2.6-pro` (~$0.010), `anthropic/claude-sonnet-5.5` high (~$0.068; check against owner labels, since
Opus grading Claude risks family bias); plus judge prompt v6 (one evidence quote per claim + deterministic quote
check). Writers later: Sol medium, `gemini-3.8-flash` high, `claude-sonnet-5.5` medium. Excluded: Fable 5.1 (not
ZDR), GLM/DeepSeek as writers (35% / 0-of-4 in bake-offs). Decision rule: lowest expected cost per accurate post
(model $ + escaped errors × downstream cost + holds × hold cost; defaults major $3, critical $300, hold $2), subject
to the 80% gate; adopt only on ≥10% improvement; one change per week, as a draft PR to `config.ts` for Kevin.
Key number to watch: the critical rate — at ~1.15% critical per post, a 14-day window with zero criticals (the
gate's rule) has only ~3% chance, so critical-mode recall matters more than average accuracy.

## Build order (via `/gsd-quick`, one builder + one independent reviewer per PR)

Time-critical: 2 Oct transcripts of approved posts are already gone and morning recordings vanish ~24 h after
class, so the audit path is built and run first.

1. **Slot**: dedicate `slot-eval` (clean; branch merged): `scripts/dev/worktrees.sh deps slot-eval`, copy
   `.env.local` from slot-a (0600), add `.keep-worktree`, node 22. Other sessions keep slot-a/slot-b. Update the
   `worktree-policy` memory.
2. **PR A — audit path** (`feat/autowriter-nightly-audit`, draft; `/scripts/` is CODEOWNERS):
   `src/lib/feedback-autowriter/audit/` (`modes.ts`, `schema.ts`, `rubric.ts`, `bundle.ts`, `floors.ts`,
   `claude.ts` runner + proof, `ledger.ts`, `report.ts` + watchdog SQL, `flags.ts`, `budget.ts`, `lock.ts`,
   `retention.ts`), read-only Soniox fetch, CLI `scripts/feedback-autowriter-nightly.ts` (preflight / collect /
   audit / report / prune), registry doc, tests. **→ first run on 2 Oct right after it is green.**
3. **PR B — fix + verify + correct**: offline replay from bundles (`--bundles=<dir>`, style/format from the posted
   stamp, no Soniox job creation), analyst/fixer prompts + `claude -p` wrappers, scope and sanitisation checks,
   acceptance runner, PR opener, `agent-correct.ts` + store, CLI steps analyse / fix / verify / correct, tests
   (unit guard matrix with a failing case per guard; Testcontainers: intent row + review-job functions → event
   classified `autowriter_correction`, no incident; second insert → 23505; first-shot snapshot unaffected).
4. **Local config** (not in git, approved with this plan): scheduled task (prompt = steps 0–8 + stop conditions);
   `slot-eval/.claude/settings.local.json` allow rules for exactly the nightly CLI, `claude -p`, `npx vitest run`,
   `npm run typecheck`, `npx eslint`, git in the slot, `gh pr create --draft|view|list|edit`; deny rules for `gh pr
   merge|ready`, `vercel`, `curl`, `psql`, `--sweep`, `--process`, `--mode=`, `--resume`, `git push --force`,
   pushes to `main`, `mcp__scheduled-tasks__*`.
5. **PR C — production cost & loop caps** (CODEOWNERS files; draft for Kevin): keep the production Soniox job until
   the nightly audit marks the class audited (the original 29 Sep rule "kept until triaged, ≤72 h") instead of
   deleting it when Kevin approves — removes the audit's ~$2–4/night re-transcription; per-class caps on judge/infra
   retries (e.g. 8 runs or $1 → hold); counters for the immediate style/evidence retries; price timed-out calls;
   Atom skip-when-idle; daily OpenRouter spend breaker.
6. **Follow-ups** (separate PRs): stamp `lessonRecordHash`; DI §2 in-app lock (`correcting` state) to replace the
   quiet check; replay model overrides for the weekly review; dedicated Wise API user (removes Kem ambiguity).

## First run tonight (2 Oct, supervised by this session)

1. Build PR A; review; tests green. Run `collect --date=2026-10-02` as soon as that piece is green, even before the
   audit runner, to capture evidence before the morning classes' recordings expire (~24 h after class). Then audit
   (≤36 Opus max calls) → report → analyse/plan. Send Kevin the report and plan.
2. Build PR B; review; fix the top mode (up to 2 on this first night) on a branch; verify offline on the failed
   classes + sample.
3. `correct` dry run with before/after for each class (sent to Kevin), then `--apply --supervised` in the
   06:10/06:40 windows or the first window after PR B is green — under the standing authorisation given tonight, no
   further wait if Kevin is asleep. Watch the first one end to end: read-back; event attributed after the :27
   review job with no incident; agent flag on the dashboard; next post-class sync shows no deduction change.
   Fixed modes only stop recurring in production once Kevin merges the fix PR; until then each night corrects them
   again (one correction per class, capped).
4. Open the draft PRs; create the scheduled task; "Run now" once as a zero-cost smoke test (D = 2 Oct is already
   in the ledger, so it audits nothing and proves lock, paths, permissions and push). First real unattended run:
   4 Oct 01:30 for 3 Oct. Unattended corrections switch on only once PR B is on `origin/main`; until then nightly
   corrections stay proposals in the report.

## Verification

- Unit + integration suites above; `npm run typecheck`; `npx eslint` on touched dirs; `git diff --check`; scope and
  sanitisation checks on our own PRs.
- First `claude -p` audit: JSON shows `claude-opus-5-5`, subscription auth (no `ANTHROPIC_API_KEY` in env), effort
  recorded; a trivial call measures context overhead under `--safe-mode`.
- Correction dry run prints each guard per class; the first live correction is verified in Wise, the DB, the
  review job's classification and the dashboard; the money tripwire runs the next night.
- Scheduled task: `get_session` on the smoke-test run shows cwd, permission mode and the logged proof;
  `list_task_runs` checked after the first real night.

## Risks accepted / open

- The Mac writes outside the app's single-POST lock (owner chose the Mac); mitigated by the quiet check, one
  correction at a time, record-first intent rows and halt-on-anomaly; residual risk: a rare overlap with one app
  post. The in-app lock is a follow-up.
- Kem's web-app saves look like ours (known limit; dedicated API user recommended).
- Unknown whether Wise notifies parents on edits — corrections run at 06:10–06:45, not mid-night.
- Security hygiene items seen during exploration were handed to a separate task (not tracked here).
