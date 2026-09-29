---
quick_id: 260929-lop
status: approved
source_plan: ~/.claude/plans/for-online-classes-i-inherited-moonbeam.md (approved 2026-09-29 ~22:20 Bangkok)
appendices: [DESIGN-INAPP.md, DESIGN-AGENTS.md]
---

# Autowriter operating loop: measure → forward-scan → interview → auto-fix → expand

## Context
The autowriter went live on 29 Sep 2026. It covers 5 tutors, each on both of their Wise accounts, and handles online 1:1 classes. It works from Wise's AI summary, or from a Soniox transcript when that summary can't be used.

**What happened on day 1:** 9 classes posted and were verified in Wise. The owner found several issues by hand, all shipped the same evening as PRs #92 and #94–#98:
- ISEB/NVR class terms;
- main accounts not being covered;
- a tutor joining twice counted as a second student;
- a student joining as a guest;
- nicknames;
- Zoom's transcript arriving after the recording.

**Goal:** first-shot accuracy of at least 80% before adding tutors. The daily loop that gets there:
1. Measure every post.
2. Scan the next 30 days of classes for risks before they happen.
3. Interview the owner on the edge cases found.
4. Fix root causes, with limited autonomy.
5. Grow the roster by 50% at a time, starting with the tutors who have the most online 1:1 hours, once a statistical gate passes.

This plan comes from a six-round owner interview, three code explorations and three design reviews, one of them adversarial. Everything below the `---` line is the history of the earlier phases.

## Owner decisions (29 Sep interview)
| Topic | Decision |
|---|---|
| Accuracy | A post counts as accurate if it needed no real fix; cosmetic edits are fine. Severities are cosmetic, major and critical |
| Critical | Wrong person, billing/status error, invented content, or a post that should not have happened. Critical errors push to the owner at any hour, are never auto-fixed and block expansion |
| Numbers | Accuracy = accurate ÷ reviewed posts. Coverage = posted ÷ (eligible − classes the tutor wrote first), with a floor of 70% |
| Gate | Rolling 14 days: Wilson 95% lower bound ≥ 80%, zero critical errors, coverage ≥ 70% |
| Expansion | +50% tutors, rounded up (5→8→12→18), both Wise accounts each, ranked by 1:1 online hours. Head start (dry-run drafts plus forward scan of candidates) begins at a lower bound of 70%. Owner confirms, then tutors get a notice and go live |
| Review | The owner reviews 100% of posts until each gate passes. New tutors are always reviewed at 100%; tutors who have already passed a gate drop to a random 30% sample plus flagged posts. The gate counts only owner-reviewed posts, and the sample is drawn before any flag |
| Triage | An Opus 5.5 agent at max effort reviews every post. For non-critical issues it fixes both the post and the root cause, never a patch-over. It sees full, unredacted evidence (owner's choice) |
| Verdicts | Dashboard buttons: Approve / Needs fix, with severity and a note. Fixes are measured from Wise activity events, not remembered |
| Fix flow | Post first, fix afterwards (owner's choice). Owner-requested fixes: the system proposes the text, the owner approves, the system re-posts and verifies it |
| Autonomy | Tiered: data-only fixes merge automatically; prompt, judge, gate, redaction or roster changes need a replay plus one-tap owner approval; the money path is never merged by an agent. Rollout is observe → propose → ship |
| Holds | The tutor is told immediately and every hold is tracked until someone writes it. An alert fires 6 hours before the deadline if it is still open |
| Schedule (Bangkok, every day) | 22:00–07:00 log only, but critical errors still push. 07:00–09:30 and 13:00–14:00 everything pauses except the autowriter. Interviews at 09:30 and 14:00 (scheduled session plus phone push). 09:30–13:00 forward-scan triage. Every class is reported as it posts. Nightly tabulation at 22:00 |
| Forward scan | Deterministic, in the app: the full 30 days nightly plus re-scans every 2 hours, read from our DB only. AI triage of new findings only |
| Runtime and credentials | Agents run on this Mac as desktop scheduled tasks, kept awake, using the full `.env.local` (owner's choice; risks and mitigations are under Security) |
| Transcripts | The Soniox job is kept until the class is triaged, 72 hours at most |

## Architecture
- **The app on Vercel is the only thing that writes to Wise:** the autowriter, re-posts, retries, the forward scan, metrics, the dashboard, the watchdog, and the deterministic critical checks.
- **The agents on the Mac** read, judge, report, interview, and open or merge PRs within their tier. Anything else they need done goes into DB queues that the app carries out through its guarded paths. They never run the CLI's `--sweep`, `--process`, `--mode`, `--resume` or `--tutor-on`.
- **Handover between the two** goes through DB tables with leases, a run ledger and version checks.
- **Kill switches:** a DB `autonomy` level (off / observe / propose / ship), a STOP file on the Mac, and the autowriter's own pause.

## Phase 0: immediate hardening (first, before any loop work)
1. **Timeouts during response-body reads escape as untyped errors** (found tonight, Ek's 20:00 class). `soniox.ts` calls `response.text()` outside its try block, and the OpenRouter client has the same pattern.
   - Wrap body reads so they return typed infra errors.
   - Cap the generic catch in `processSession` so the third consecutive `error:` becomes `held` with an alert. Today it retries until the deadline.
2. **Stamp every POST claim with `metadata.pipeline`:** `VERCEL_GIT_COMMIT_SHA`, prompt and judge versions, model, and evidence kind. The nickname and guest changes did not bump `PROMPT_VERSION`.
3. **Transcript retention:** keep the Soniox job until the class is triaged, 72 hours at most. This changes `finishJob` and the cleanup/reaper rules in `job.ts` and `store.ts`.
4. **Code owners:** add a CODEOWNERS entry for the deny-listed autowriter files. `src/lib/feedback-autowriter/` has no code owner today.
5. **Spin off a separate task:** in Class Feedback, `policy.ts:367-371` counts STUDENT feedback events as proof the tutor was on time. 39 sessions may have had late deductions waived as a result.

## Phase 1: measurement foundation (in-app, migration 0099)
- **Immutable post log `feedback_autowriter_posts`**, append-only. One row per text we put in Wise: the first post, every re-post, and the one-time nickname edits.
  - Columns: fields, `fields_sha256`, origin (autowriter / agent / owner / one-time), pipeline stamp, billing, verification result, and when it was written.
  - Written inside the POST claim (`sessionSubmitStore` in `store.ts`) and by the re-post path.
- **Owner verdicts `autowriter_class_reviews`**, append-only and pinned to `fields_sha256`: ok / cosmetic / needs_fix / critical, a category, a note, the reason review was required, and the actor.
- **Fix counting from `wise_activity_events`:**
  - Actor `69366668c05630afe5d8a2a4` (API user, role OWNER) = our posts and re-posts.
  - Kevin's web app = `695369c028118f629edcb986`.
  - Tutors appear under their own ids; auto-submit events have no actor; STUDENT events are ignored.
  - "Fixes until satisfied" = saves after our first post, per actor, up to the owner's final `ok` verdict.
  - Don't use `post_class_feedback_versions` for this: it collapses saves and records the tutor as the actor.
- **Metrics:**
  - The pure function `buildAutowriterDashboard` gains daily accuracy and coverage, a fix-rounds histogram (0 / 1 / 2 / 3+ / unresolved) and a gate panel. The gate panel shows the 14-day Wilson lower bound on owner-reviewed posts (agent fixes count as misses), critical errors, coverage, and the state: below / head start / expansion ready.
  - Coverage is taken from Wise/Class Feedback sessions for the roster *people*, not the autowriter's own rows, so classes the autowriter never saw still count. Holds are labelled correct or false.
  - The nightly job writes `autowriter_daily_stats` and `autowriter_gate_snapshots`.
- **Dashboard additions** (`feedback-autowriter-dashboard.tsx`, owner-gated like `control/route.ts`):
  - verdict controls in each expanded class;
  - an unreviewed-posts inventory;
  - accuracy/coverage by day;
  - the gate panel;
  - a hold tracker;
  - the edge-case decision queue (Phase 4);
  - expansion candidates (Phase 6).
  In-person classes stay hidden, as now.
- **Backfill day 1:**
  - First-shot text for 5 of the 6 renamed posts comes from their first stored Class Feedback version. Gift's (`6aba30a9`) is rebuilt by reversing the Bas→Worawut rename.
  - The one-time renames are logged as origin `one-time`. Whether they count as fixes is interview decision D-01.

## Phase 2: guarded correction path (productises `.feedback-autowriter/nickname-fix.ts`)
A new in-app re-post path. Each re-post:
- Shares the one-POST-in-flight lock through a `reposting` state added to `UNSETTLED_POST_STATES`, and follows the same halt rules.
- Re-posts only if Wise's stored text still hashes to our last `feedback_autowriter_posts` row and nobody other than the API user has saved since.
- Re-sends the same `sessionStatus`/`creditsConsumed`, then verifies the new text is stored on the same submission id, there is still exactly 1 teacher submission, and the credit entries are unchanged.
- Appends a posts row.

Origins and limits:
- **Owner request:** proposal → approve / edit / reject in the dashboard.
- **Agent:** major issues only. Only if the owner has no verdict on the current text, at most 1 per class, at most 5 a day, none at night.
- **Never:** after a critical, or on `skipped_human` rows.

## Phase 3: held classes
- **When a class is held:**
  - Tell the tutor immediately (the nightly-reminder email path, `post-class-feedback/nightly-reminders.ts`), with the reason and the deadline.
  - Track the hold until someone writes the class (Wise events).
  - Alert the owner if it is still unwritten 6 hours before the deadline.
- **Deduction policy for autowriter-held classes:** open decision D-04.

## Phase 4: forward scan (in-app cron)
- **Schedule:** an internal route, run nightly at 22:30 Bangkok for the full next 30 days, plus delta re-scans every 2 hours. Pick free UTC minutes from 19, 27, 39, 42, 48, 58 and 59. Register it in `cron-registry.ts`, `vercel.json` and `vercel-crons.test.ts`.
- **Reads our DB only:**
  - `future_session_blocks` on the active snapshot. Its times are stored 7 hours ahead: use one tested helper to correct them.
  - `credit_control_sessions` and `credit_control_packages`.
  - Past outcomes for each class series.
- **Drops** cancelled, deleted and moved-to-onsite classes. Moves are matched by `wise_class_id` plus start time, because Wise may delete and recreate a moved class.
- **Checks:**
  - onsite vs online, using type and title (disagreements are flagged, not dropped);
  - one-to-one vs group;
  - the student has a Wise account;
  - a usable nickname;
  - scheduled length vs the billing credits rule;
  - a credit balance of zero or less;
  - which tutor account the class is on.
- **Per-series risk profile from history:** Thai-summary share, guest joins, tutor double-joins, holds, tutor-writes-first timing.
- **Findings:** each has a stable key and a lifecycle (open → decided → closed when the class is cancelled or has ended). Each finding proposes a handling: auto-handle rule / hold / ignore.
- **Backtest:** replay old `credit_control_snapshots` predictions against what actually happened.

## Phase 5: agent loop on this Mac (desktop scheduled tasks, Bangkok local time, every day)
- **Gate script at the start of every run** (`scripts/autowriter-loop.ts gate`): uses the DB clock, checks the window table and the STOP file, the autonomy level, and a per-task lease.
  - It exits inside pauses.
  - A catch-up run for an interview whose slot has passed is skipped, and its decisions roll over.
  - Every write carries the run's lease token.

**Scheduled tasks:**

| Task | Cron | Job |
|---|---|---|
| `bgs-loop-tick` | `*/10 9-12,14-21` | Triage new posts, holds and expiries; per-class report (one batched push per tick); unreviewed inventory; post-merge watch |
| `bgs-loop-night` | `5-55/20 22-23,0-6` | Triage and log only; push critical errors only |
| `bgs-loop-forward` | `50 0-5,9-11,22,23` | AI triage of new forward findings; head-start dry-runs |
| `bgs-loop-interview-am` / `-pm` | `30 9` / `0 14` | Walk the decision queue: ≤4 questions a round, ≤3 rounds, each with a fail-closed default; answers become rules |
| `bgs-loop-nightly` | `0 22` | Tabulate the day (re-compute the last 3 days), gate snapshot, summary push, expansion checks |
| `bgs-loop-fix` / `bgs-loop-review` | day windows | Root-cause fix pipeline and an independent-review session |

**Triage of each post:**
1. Deterministic checks first; the model cannot downgrade their critical results.
   - identity: the name used matches the billed student, and no other roster student's name appears;
   - billing: `sessionStatus`/credits and exactly one credit entry;
   - scope;
   - policy.
2. Then an Opus judgement, claim by claim with evidence quotes. The agent can only *raise* severity. Anything touching names, attendance or billing, or any unsupported fact, stays critical until the owner downgrades it.
3. Wise reads are rate-limited: concurrency 1, at most 1 read per 5 seconds, at most 200 a day. Avoid the minutes when the sync and backstop run, and back off for 30 minutes after a 429.

**Fix tiers:**
- **ALLOW (auto-merge):**
  - data files: glossary terms and nickname exceptions;
  - new or stricter validator reasons;
  - gates that fail closed.
  - Each needs:
    - a root-cause note;
    - a regression test built from the failing class, using synthetic names, that fails on the base commit;
    - a replay of the last 20 posts plus a golden set with no new failures;
    - an independent reviewer session's APPROVE as a commit status;
    - CI green;
    - a merge through `loop merge`: in the merge window, no unsettled POST, and `gh pr merge --merge`.
- **Owner approval (one tap):** prompt, judge, redaction, transcript and roster changes, plus the same evidence and a replay of about 100 classes.
- **DENY (draft PR only):** `submit.ts`, `billing.ts`, `store.ts`, `job.ts`, `run.ts`, `config.ts`, `openrouter.ts`, `soniox.ts`, `roster.ts`, `webhook.ts`, `src/app/api/**`, `src/lib/post-class-feedback/**`, DB/migrations, `vercel.json`, env, CI, and any change that makes a gate fail open.
- **Enforcement:** CODEOWNERS plus a required CI scope check (`scripts/loop/check-autofix-scope.ts`), not prompt wording.
- **Caps:** 2 merges a day, 1 prompt change a day, 1 change in flight.
- **Rollback:** any critical error or a regression spike after a merge triggers a revert PR, autonomy drops to propose for 48 hours, and the owner gets a push.

**Rollout:**
1. Observe for about a week, measuring how well triage agrees with the owner's verdicts.
2. Propose: draft PRs plus owner-approved re-posts.
3. Ship, starting at 1 merge a day, once triage catches at least 90% of the owner's real fixes and has missed no critical error.

**In-app watchdog (`cron-watchdog.ts`):** alerts by email and LINE when:
- no loop heartbeat for 40 minutes during an active window;
- a triage backlog builds up;
- the nightly run is missing by 23:30.

## Phase 6: expansion pipeline
- **Ranking view:** tutors by one-to-one online hours over the last 30 days, both accounts grouped through the identity groups.
  - Current order: Aey, Mikki, Sagotty by past hours; Aey, Ohm, Mint/Ras by upcoming hours.
- **Head start (lower bound ≥ 70%):** backtest each candidate on their last 30 days of classes with dry-run drafts, never posted. This needs the eval path in `run.ts` to accept tutors not on the roster. Also forward-scan their upcoming classes.
- **Gate passes:**
  1. A proposal for +50% rounded up.
  2. An owner-approved `roster.ts` PR.
  3. A tutor notice, sent by the owner.
  4. New tutors on probation: 100% review for their first 15 posts, no critical errors, at most 2 real fixes.
- **Before the 12→18 step:** measure how the one-POST lock and the sweep throughput hold up.

## Security (owner accepted)
The owner chose to give the agents the full `.env.local` and full, unredacted evidence. Risks: production DB write access; a Wise key that belongs to an OWNER account and can write; merge rights; children's names reaching Opus through the owner's Claude account, not the zero-retention route.

**Mitigations that still hold:**
- The agents never run the CLI write commands.
- All their writes go through the loop script's allow-listed operations.
- They get a tool deny-list: no Gmail or other MCP tools, no `curl` to arbitrary hosts, no `vercel`, no `--admin`.
- No real lesson text goes into GitHub; tests use synthetic names.
- Logs hold metadata only.
- The STOP file and the autonomy level.

**To revisit:** move to a scoped DB role plus an in-app evidence route after the observe week.

## Seeded interview decisions (first 09:30 session)
- **D-01:** do tonight's one-time nickname renames count as fixes or as a policy change?
- **D-02:** where is the line between "invented" (critical) and "overstated" (major)? Tonight's examples: "treated sound as transverse" and "handled rotation questions confidently".
- **D-03:** confirm the coverage definition: which holds are correct.
- **D-04:** how are late deductions handled for classes the autowriter held?
- **D-05:** does a new tutor's style go into the prompt as few-shot examples, or is one generic voice used?

## Verification
- **Per phase:** unit tests and Postgres integration tests (Testcontainers), typecheck, lint, build, and an independent review before each merge, as for #91–#98.
- **Phase 1:** the dashboard renders tonight's backfilled day correctly: 9 posts, first shots stored, fix counts from events matching what actually happened (6 one-time renames, 0 owner edits).
- **Phase 2:** a controlled re-post on one class, checked in Wise: same submission id, credit entries unchanged.
- **Phase 4:** the scan's counts match the explorer's measurements (about 185 online one-to-one roster classes in the next 30 days), and the backtest reports its prediction hit rate.
- **Phase 5:**
  - the gate exits inside pauses;
  - triage of 3 of tonight's posts reproduces the owner's findings;
  - a dry-run of the fix pipeline on a synthetic issue;
  - the watchdog fires when the loop's heartbeat is stopped.

## Tonight's status (29 Sep, 22:15)
- 9 posts, each checked in Wise with one credit entry. The six posted before #97 were renamed to nicknames, each verified.
- Ek's 20:00 class is correctly **held**: the judge caught an overstatement in the transcript draft. Ek needs to write it; the deadline is 1 Oct 23:59.
- Mimi's 19:00 and 20:00 classes are now `on_time` in Class Feedback.
- **Owner items still open:**
  - rotate or delete `.playwright-mcp/wise-trends-request-headers.txt`;
  - add alert recipients;
  - ask Wise about recording URLs being downloadable without authentication, and about a dedicated API user.
