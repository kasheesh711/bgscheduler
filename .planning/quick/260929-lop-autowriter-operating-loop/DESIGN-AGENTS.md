# Design appendix: agent side of the autowriter operating loop (Mac, desktop scheduled tasks)

This is a design review (read-only), 2026-09-29, with the adversarial critique's points folded in. Owner decisions are in `260929-lop-PLAN.md`.

## Principles
- **The Mac never writes to Wise.** The app on Vercel is the only Wise writer. The agents read, judge, open or merge PRs within their tier, and put requests into DB queues that the app carries out through its guarded paths. If the Mac sleeps, triage and fixes stop, but a bad post can never come from the Mac.
- **State moves through the DB.** Each run is a fresh Claude session and runs can overlap, so the loop relies on DB leases, a run ledger and version checks on every write. Local files hold only the STOP file, logs and git worktrees.
- **Guardrails are enforced by the platform where possible.** That means CODEOWNERS, a CI scope check and a bot GitHub identity. Anything that only a prompt enforces is marked as weak.

## Windows (Bangkok, computed from the DB clock, not the Mac clock)
| Window | Policy |
|---|---|
| 22:00–07:00 | Night: triage and log only; push criticals only; no fixes, merges or re-runs |
| 07:00–09:30 | Pause: every agent task exits |
| 09:30–13:00 | Forward: forward analysis, triage and fixes. The interview slot opens at 09:30 (valid 09:25–12:30) |
| 13:00–14:00 | Pause |
| 14:00–15:00 | The interview slot (valid 13:55–14:50); triage and fixes continue |
| 15:00–22:00 | Class window: triage, reporting and fixes |

Merges only happen 10:00–12:00 and 14:00–19:30, so there is at least one hour of watching after every merge before a pause or night.

## Scheduled tasks
| taskId | Local cron | Job |
|---|---|---|
| `bgs-loop-tick` | `*/10 9-12,14-21 * * *` | Day triage and class reporting; post-merge watch; re-run requests |
| `bgs-loop-night` | `5-55/20 22-23,0-6 * * *` | Night triage, log only; push criticals only |
| `bgs-loop-forward` | `50 0-5,9-11,22,23 * * *` | Triage of forward-scan findings (batched, with a cursor); head-start dry runs |
| `bgs-loop-interview-am` | `30 9 * * *` | Interview, starting with the overnight digest |
| `bgs-loop-interview-pm` | `0 14 * * *` | Interview |
| `bgs-loop-interview-now` | ad hoc | Started by the tick (`run_scheduled_task`) when a flagged class needs the owner during the class window |
| `bgs-loop-nightly` | `0 22 * * *` | Tabulate the day; gate snapshot; summary push; forward epoch; expansion checks |
| `bgs-loop-fix` | `15,45 10-11,14-19 * * *` | Claim one fix item and run the root-cause pipeline; work stops at 21:30 |
| `bgs-loop-review` | `0,30 10-12,14-19 * * *` | Independent review of `loop:needs-review` PRs, then a scripted merge if every check passes |

**How every run starts:**
1. `cd ~/Developer/Scheduling-loop-ops && git fetch -q && git checkout -q --detach origin/main`
2. `npx tsx scripts/autowriter-loop.ts gate --task=<id>` returns JSON: `RUN` or `EXIT`, plus `window`, `slotKey`, `softDeadline`, `hardDeadline`, `runId` and `leaseToken`.
3. On `EXIT`, reply with one line and call no other tool.

**The gate:**
- **Checks, in order:** the DB clock, the STOP file (`~/.bgscheduler-loop/STOP`), `autowriter_loop_control.autonomy`, the schema version, and a per-task single-flight lease.
- **Catch-up after the Mac sleeps:**
  - An interview whose slot has passed exits as `skipped_late`, and its decisions roll over.
  - Ticks drain the backlog.
  - A missed nightly is run (as `loop nightly --date=D`, which is deterministic) by the next tick in an allowed window, and marked late.
- **Staying inside the window:**
  - Crons skip pause hours, and the gate exits inside a pause.
  - `loop heartbeat --run` returns STOP when any of these hold:
    - the soft deadline (window end minus 10 min) has passed;
    - the STOP file exists;
    - autonomy has been lowered;
    - the lease was lost.
  - Every write carries the lease token, and writes from expired runs are rejected.
  - A long fix saves its progress (branch plus DB state) and continues in the next window.

## State tables (added by the app in 0099+; see DESIGN-INAPP.md for the table shapes)
| Table | Purpose |
|---|---|
| `autowriter_loop_control` | Autonomy level (off/observe/propose/ship), caps, `wise_cooldown_until`; owner-only toggle on the dashboard |
| `autowriter_loop_runs` | Run ledger and leases; partial unique index on `status='running'` |
| triage rows per posted text version | Unique on (session, `fields_sha256`, triage version) |
| owner reviews (verdicts), corrections/re-post requests, decisions, rules, fix items, loop changes (one per PR), forward findings, notifications ledger (`dedupe_key` unique), daily stats, gate snapshots | — |

The app also stamps `metadata.pipeline = {sha, promptVersion, judgeVersion, model, evidence}` on every POST claim (Phase 0).

## Per-class triage
**Trigger:** polling. Each tick picks up:
- rows that are `verified`, or `awaiting_event` for more than 10 min, whose current `fields_sha256` has no triage row;
- rows that became `held`/`expired`/`no_recording` (these feed coverage: was the class really absent, or was it a pipeline defect?).

Oldest first and critical-risk first, at most 4 per run and 2 subagents at a time.

**Evidence** (`loop evidence --session`, read-only):
- one Wise session detail, one credit-entries read and one feedback-events read;
- the Zoom VTT from its link (not a Wise API call);
- for transcript-pass posts, the Soniox transcript, now kept until triage and for at most 72 hours.

**Wise read limits:**
- concurrency 1, at most 1 read per 5 s, at most 200 reads a day;
- skip minutes :00–:04 and :30–:34 (`sync-wise`) and ±1 min around :08, :22, :38 and :52 (the backstop);
- any 429 sets `wise_cooldown_until = now()+30 min` for all tasks and ends the run.

**Deterministic pre-checks run first** (a script, no LLM). The model can't downgrade their critical results.

| Check | What it verifies |
|---|---|
| Identity | The name used equals the chosen name for the billed Wise student; the teacher is on the roster; exactly one student, or a valid guest stand-in; no other roster student's name appears |
| Billing | Stored sessionStatus/credits equal the plan; exactly 1 credit entry; one teacher submission; no non-API submit event after ours. Wise text that differs from our fields means someone edited it: flag it and never re-post |
| Scope | `SCHEDULED`, `ONE_TO_ONE`, not an in-person title, meeting `ENDED`, attendance at least 50% on the fresh read, tutor switched on |
| Policy | Placeholders, Thai text, markdown, meta words (Zoom, recording, transcript, AI, summary, late, absent), lengths |

**Then an Opus 5.5 subagent at max effort** judges each claim against evidence quotes. It has no tools; its output is JSON that `zod` validates. The owner chose full, unredacted evidence.

| Severity | Examples |
|---|---|
| **Critical** | Wrong person (another student's name, content from another lesson, the tutor treated as the student); billing/status drift; an invented concrete fact (homework not set, a score or result, a topic, material, event or date not in the evidence); should not have posted (absence or under 50%, no lesson, group, in-person, cancelled, a person's text overwritten, tutor not on the roster or switched off) |
| **Major** (a real fix) | Unsupported judgement words or "mastered" where it was only covered; wrong programme or subject; main topic missed; homework omitted when it was clearly set; meta leak; the nickname rule broken but the right person; generic improvement advice; copy-like text |
| **Cosmetic** | Grammar, style, wording, paragraphing. Still counts as first-shot OK |

The line between invented (critical) and overstated (major) is decision D-02 in the first interview.

**Rules the agent follows** (the critic's points):
- The agent may only raise a severity. Anything touching names, attendance or billing, or any unsupported fact, stays critical until the owner downgrades it.
- Only owner verdicts and deterministic checks feed the gate.
- Every agent fix counts as a miss unless the owner labels it cosmetic.
- Re-runs never touch a post labelled critical.

**Review sampling is deterministic, so the agent can't cherry-pick.** A class needs owner review if any of these hold:
- the cohort hasn't passed its gate yet (100%);
- it is a new tutor's class;
- `sha256(sessionId) mod 100 < 30` (the 30% sample for proven tutors).

The sample is drawn at post time, before any flag. Flagged classes are reviewed in addition, and they don't feed the gate unless they were in the sample.

**What happens to each class:**

| Outcome | Action |
|---|---|
| Critical | Push immediately, any window (dedupe key `critical:<session>:<code>`); never auto-fixed; blocks expansion. For billing, identity or scope criticals, recommend `loop_halt` (the safe direction) |
| Major, fixable, high confidence | Fix item; the owner is told afterwards |
| Major, uncertain, or a policy question | Flag plus a decision for the owner |

Each tick sends at most one batched push in the class window, with one line per class plus the count of unreviewed classes. At night only criticals are pushed; everything else goes into the 09:30 digest.

## Autonomous root-cause fix pipeline (tiered, as the owner chose)
**ALLOW: may auto-merge with full evidence.** Everything must be under `src/lib/feedback-autowriter/`:
- data-only changes: glossary terms (class terms the owner has authorised) and nickname exceptions;
- `validate.ts`: new or stricter rejection reasons only;
- `session.ts` gates: new checks that fail closed and route to `person`;
- `transcript.ts`: stricter speaker-confidence thresholds only;
- tests, fixtures and docs.

Size limit: at most 3 non-test files, at most 120 changed non-test lines, one issue signature per PR.

**Owner one-tap approval required,** with the same evidence plus a replay of about 100 classes:
- `prompt.ts` and `judge.ts` wording;
- redaction changes;
- `transcript.ts` logic beyond thresholds;
- `roster.ts`.

**DENY: draft PR for the owner only.**
- **Files:** `submit.ts`, `billing.ts`, `store.ts`, `job.ts`, `run.ts`, `config.ts`, `types.ts` constants, `openrouter.ts`, `soniox.ts`, `roster.ts` (expansion), `webhook.ts`, `dispatch.ts`, `ab.ts`, `src/app/api/**`, `src/lib/internal/**`, `src/lib/post-class-feedback/**` (it drives payouts).
- **Infrastructure:** `src/lib/db/**`, `drizzle/**`, `vercel.json`, env, `package*.json`, `.github/**`, `scripts/**`, `.claude/**`, CODEOWNERS, AGENTS.md/CLAUDE.md.
- **Kinds of change:**
  - any deleted file or test, removed assertion, `.skip`/`.only`, or removed validator reason or gate;
  - any `classifyGateReason` change that moves a reason to `scope`/`retry` (fail-open);
  - any fix that came from a critical.

**Enforcement:**
- CODEOWNERS on the deny paths (Phase 0).
- A required CI job, `scripts/loop/check-autofix-scope.ts`, for `loop:autofix` PRs. It checks:
  - the paths;
  - that per-file test counts don't drop;
  - that `reasons.push`/`ok: false` counts don't drop;
  - that gate-mapping lines are unchanged;
  - the size limits.
- A bot GitHub identity opens the PRs, so review stays independent of the author.

**Evidence required before any merge:**
1. **Root-cause note:** the mechanism, why the change fixes the mechanism and not just this one class, and any sibling cases.
2. **Regression test from the failing class.** It uses synthetic names and a paraphrase, never real lesson text, and must fail on the base commit. For prompt changes, instead: 3 of 3 live dry runs pass the judge and the rubric.
3. **Replay** of the last 20 posted classes (stratified by tutor and evidence kind), plus the failing class, plus a golden set, through the changed pipeline as a dry run with no POST. It must show:
   - no new validator or judge failures;
   - at most 1 newly held class;
   - unchanged names;
   - no new major or critical issue in an Opus comparison of old and new text;
   - the target issue gone.
4. **Independent reviewer** (the `bgs-loop-review` session): fresh context and an adversarial prompt. It re-runs the tests, re-checks the scope, looks for fail-open or POST/billing impact, and spot-checks 3 replay classes. Its verdict is a commit status, `loop/independent-review`, bound to the head SHA.
5. **CI green:** the 5 required checks plus the scope check.
6. **Merge only via `loop merge`,** which checks all of:
   - autonomy is `ship`;
   - no STOP file;
   - inside the merge window;
   - under the daily cap;
   - no unsettled POST;
   - the autowriter is not halted;
   - the reviewed SHA equals the head SHA.

   Then `gh pr merge --merge`, never `--admin`.

**Caps:** at most 2 merges a day, 5 in any 7 days, 1 prompt change a day, 1 change in flight. The next merge waits until the previous deploy has shown 2 clean posts or 3 hours have passed.

**Kill switches:** the DB autonomy level (checked at the gate, the heartbeat, and right before any merge, retry or re-post), the STOP file, disabling the scheduled tasks, and the app's own `--pause`.

**Rollback:**
1. After a merge, the tick waits for the Vercel production deploy of that SHA, then triages the posts stamped with it first.
2. The trigger is any of: a critical; 2 or more new majors; held rate or judge rejections more than 2 above baseline.
3. The response:
   - the bot opens a `git revert -m 1` PR (merged on CI green);
   - autonomy drops to `propose` for 48 hours;
   - the owner gets a push;
   - `loop_halt` as well, if the trigger was a critical.

The agent never uses Vercel promote or rollback.

**Re-running affected classes after a deploy:**
- **Held, expired, or `skipped_scope` for a non-onsite reason:** only rows whose reason the fix addresses, created in the last 72 hours, with more than 30 minutes left before the deadline. At most 10 per fix. Retries go through the app's retry path, which re-runs every gate.
- **Already-posted classes:** re-posted only through the app's guarded re-post path, and only when all of these hold:
  - no owner verdict on the current text;
  - Wise's text still hashes to ours;
  - no non-API submit event since;
  - major severity only;
  - the new text passes the validators, the judge and the Opus rubric;
  - it is the agent's first re-post of that class;
  - at most 5 re-posts a day, none at night.
- **Classes a tutor wrote themselves** (`skipped_human`) are never touched.
- **Every re-post counts as one real fix.**

## Interviews
- **Order of the queue:** critical-linked decisions first, then those blocking a class within 48 hours (`due_by`), then those blocking a fix, then the oldest. The session opens with a short digest.
- **Format:** AskUserQuestion, at most 4 questions a round and at most 3 rounds. Each question gives:
  - context: the class, what happened, how often, the risk;
  - 2–4 options with their consequences, the recommended one first;
  - a fail-closed default.
- **Recording answers:** `loop decision answer --id --version --choice --via=interview`, with a version check. The dashboard buttons write the same row and are the main path, because AskUserQuestion has no timeout. Answers recorded after the window closes still count, but start no new work.
- **When the owner doesn't answer:** the decision stays open, and `asked_count` goes up only when it was actually presented. When `due_by` passes, the fail-closed default applies (hold for the tutor), never a permissive one. After 3 missed slots in a row, one push: "N decisions waiting, defaulting to hold".
- **Load control** (the critic's point):
  - skip the session when the queue is empty;
  - every answer becomes a stored rule, so the same question is never asked twice;
  - decisions recorded by an agent aren't owner consent: enforcing them needs owner confirmation in the dashboard.
- **How an answer takes effect:**
  - `ignore` → a triage suppression, immediate;
  - `hold rule` → a rule row the app's gates read (only adds holds);
  - `new deterministic check` / `prompt guidance` → a fix item;
  - `scope` / `expansion` → an owner draft PR only.

## Nightly review (22:00)
**Daily stats,** upserted per Bangkok date and per tutor. The last 3 days are recomputed each night to catch late posts and late reviews.
- volume: posted, eligible, coverage;
- review: triage verdict counts, reviewed, first-shot OK;
- the fix-rounds histogram (0, 1, 2, 3+, unresolved);
- fix activity: cosmetic edits, criticals, agent fixes, re-posts, merges, reverts;
- cost and Wise reads.

**Gate snapshot** over 14 days:
- the Wilson 95% lower bound over owner-reviewed classes in the sample, where agent real fixes count as misses;
- criticals and coverage;
- the state: below / head_start (queue candidate dry runs) / expansion_ready.
  - expansion_ready creates an expansion decision: the next +50% of tutors, rounded up and ranked by 1:1 online hours;
  - it also opens a draft `roster.ts` PR and drafts a tutor notice for the owner to send.

**After the snapshot:**
- a push of at most 6 lines;
- a new forward epoch.

**Extra gate conditions:**
- at least 15 owner-reviewed posts since the last prompt-affecting merge;
- only days where at least 90% of the sample was reviewed within 48 hours count.

## Failure modes on a single Mac
| Failure | Mitigation |
|---|---|
| The Mac sleeps or the app is closed | Posting is unaffected (it runs on Vercel), and missed tasks run once when the app is back. The in-app watchdog (`loadAgentLoopHealth` in `cron-watchdog.ts`, episode-deduped) emails and LINE-pushes when: no heartbeat for 40 min in an active window; triage backlog over 60 min by day or over 10 h overnight (pauses excluded); a lease stuck over 2 h; nightly missing by 23:30 |
| Critical detection pauses when the Mac does | The deterministic critical checks also run in the app (name, Thai text, billing drift, attendance or cancellation changing after the post) and auto-halt through the existing halt, then push |
| Overlapping runs | Per-task single-flight leases, per-item leases, version checks |
| Running past a window boundary | Soft and hard deadlines, heartbeat STOP, saved progress, stale runs rejected |
| Duplicate pushes | Ledger row first, then send, then mark sent; unique `dedupe_key`; at most 3 attempts |
| Claude usage limits hit | The deterministic checks are cheap and run first; the watchdog catches the backlog |
| DB or network unreachable | The gate fails and the run does nothing; the STOP file still works offline |
| Prompt injection through lesson text | The triage subagent has no tools and its output is schema-validated. Loop sessions are denied: unneeded MCP tools (Gmail etc.), `curl`, `vercel`, `--admin`, the CLI's `--mode`/`--resume`/`--tutor-on`/`--sweep`/`--process`, and editing scheduled tasks |
| The Mac's time zone changes | The gate uses the DB clock |

## Volume and cost (Opus 5.5 at API price: $4 in, $20 out, $0.20 cached per million tokens)
**Runs per day:** about 72 ticks, 27 night ticks, 8 forward runs, 2 interviews, 1 nightly, and up to 16 fix and 18 review runs (most of which exit at once).

| Cost item | Estimate |
|---|---|
| Triage | about $0.25 per class from a summary, $0.45 from a transcript |
| Each fix (fixer, reviewer and replay) | about $5–8 |
| Total per day | about $15–30, and up to about $45 on days with fixes |

**Wise reads:** about 3 per class, about 20 per fix replay, and about 30 once per expansion. Capped at 200 a day.

## Rollout
| Phase | Scope | Exit condition |
|---|---|---|
| 0 | Prerequisites (owner PRs): CODEOWNERS, the scope-check CI job, migrations, `scripts/autowriter-loop.ts`, a bot identity, the watchdog check, the dashboard sections, the pipeline stamp | — |
| 1: observe (about 1 week) | Ticks, night ticks, nightly, forward runs, interviews and critical pushes; measure triage agreement against owner verdicts | Triage catches at least 90% of the owner's real fixes with no missed critical |
| 2: propose | Draft PRs; the reviewer and replay working; re-posts the owner approves | The owner approves at least 5 agent PRs without changes |
| 3: ship | Auto-merge (1 a day at first); autonomous retries; agent re-posts (at most 3 a day at first) | — |
| 4: expansion | Head-start dry runs (the `--generate` path must accept tutors not on the roster) | — |

## Known conflicts and safety notes
1. **`.env.local` gives full production power** (the owner's choice). The agents must still write only through the loop script and the app's routes, and never through raw psql writes or Wise POSTs; that restriction lives in prompts and is weak. Revisit a scoped DB role after the observe week.
2. **One GitHub account can't approve its own PR.** Use a bot identity plus a commit status for the independent review.
3. **Re-posting breaks "exactly one POST per session".** The app's re-post path shares the lock and halt rules and checks by hash that Wise still holds our text. Kem's manual saves look like ours, so a dedicated Wise API user is recommended.
4. **Agent fixes made before the owner reviews** count as real fixes, owner verdicts are pinned to a text version, and the agent never re-posts once a verdict exists.
5. **Pauses stop the Mac's critical detection,** so the deterministic critical checks also run in the app.
6. **Night work is limited to triage and logging.** Fixes wait for the morning, which is safe because the deadline is 2 days out.
7. **Owner-chosen privacy trade-off:** Opus triage on the owner's Claude account sees raw student data. Never commit real lesson text.
8. **Validators and the judge depend on post-class policy functions that drive payouts,** so `post-class-feedback` is on the deny list.
9. **Stricter fail-closed gates can starve coverage below the 70% floor.** The replay's coverage check guards against this.
10. **Expansion** is an owner PR to `roster.ts`; the agent drafts the tutor notice and the owner sends it.
11. **The Mac never writes to Wise:** `--sweep`/`--process` from the Mac would POST, so both are denied.
