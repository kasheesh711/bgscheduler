---
status: complete
quick_id: 261003-12b
part: B
branch: feat/autowriter-agent-correct
subsystem: feedback-autowriter
tags: [wise, postgres, drizzle, testcontainers, autowriter, correction]
requires:
  - "0101 posts/fix-events/flags/incidents tables; 0110 incident kinds (correction_failed)"
provides:
  - "correctPostGuarded: guarded, once-per-class agent correction of a verified autowriter post in Wise"
  - "pgCorrectionStore: lock (sweep lease + exact-reason halt), conditional posts-row claim, transactional settle"
  - "recoverStaleCorrections (reads only) and releaseStaleCorrectionLock for scripts/feedback-autowriter-nightly.ts recover"
affects: [feedback-autowriter review job, fix-event classification, nightly agent script (PR C)]
key-files:
  created:
    - src/lib/feedback-autowriter/correction.ts
    - src/lib/feedback-autowriter/correction-store.ts
    - src/lib/feedback-autowriter/__tests__/correction.test.ts
    - src/lib/feedback-autowriter/__tests__/correction-store.integration.test.ts
    - src/lib/feedback-autowriter/__tests__/correction-fixtures.ts
  modified:
    - src/lib/feedback-autowriter/submit.ts
    - src/lib/feedback-autowriter/validate.ts
key-decisions:
  - "The lock is the existing sweep lease plus a halt whose reason is the lock; the production POST path is unchanged"
  - "recordPostStart is a conditional INSERT … SELECT that re-checks lock ownership, the base text, owner flags and in-flight POSTs on the DB clock"
  - "releaseStaleCorrectionLock un-halts only an exact lock reason whose lease is no longer live, with nothing unsettled"
  - "Built-in text guards (untidy whitespace, Wise 5000-char limit, Class Feedback content bar) on top of the caller's textProblems"
commits: [8fdc2f5a, 8f7b1432, 13a4e03f]
review_fix_commits: [09057c85, 6d88a43e, 96fd801a, f7d3318b, 918f6a59, 80b245f6, dd212d2b, 13c9bb6d, c15ed8be, 3329632f, 2276e37e, 8d317a19, 3096fb38, b178bf4a]
duration: 34min
completed: 2026-10-03
---

# 261003-12b PR B: guarded agent correction of posted autowriter feedback

**`correctPostGuarded` replaces the text of one verified autowriter post in Wise, once per class, ever. Every guard
runs before a single, never-retried POST, made under a lock that stops every other autowriter POST. Any doubt after
the POST halts first, then settles, then pages; the lock is never lifted on a problem.**

> The independent review's fixes ([Review fixes](#review-fixes), below) supersede several details in the sections
> before it: the text checks, the lease (now 20 min), the event wait (now 5 min, lock kept if our event is unseen),
> the recovery threshold (now 25 min), the clocks the POST window uses, and the store interface.

## Performance

- Started 2026-10-02T18:13Z, completed 2026-10-02T18:47Z (01:47 Bangkok, 3 Oct): about 34 min. 3 commits, 7 files.

## What was built

- **`correction.ts`** (pure apart from the injected Wise ops and store):
  - **Public API:** `AGENT_CORRECTION_ACTOR`, `agentCorrectionDedupeKey`, `inCorrectionWindow` (UTC minutes 10–15 and
    40–45), `CorrectionPlan`, `CorrectionWiseOps`, `CorrectionStore`, `CorrectionOutcome`,
    `CorrectionRefusedError`, `correctionTextProblems`, `correctPostGuarded`.
  - **Guard order:**
    1. Plan.
    2. Window. A dry run reports it rather than enforcing it.
    3. `store.preconditions`.
    4. A read-only Wise read before the lock, with the same state checks as under the lock, so a doomed correction
       never halts the autowriter; then the one billed student and the credit baseline.
    5. `store.lock`.
    6. A fresh read after the lock: the same checks again, the same student, no save since the first shot except our
       own, the lock budget (180 s), and STOP.
    7. `recordPostStart`, then exactly one POST with the current billing in form order.
    8. Read-back after 3 s: text, submission, billing and credit identity. Then `waitForSubmitEvents` (90 s) for our
       own event, a stranger's save, or a second API save in the window.
  - **Settle outcomes:**
    - Verified, or awaiting the event: the posts row and session text change, then the lock is released.
    - 429 with the base text still in Wise: `not_sent`, released, no retry.
    - Read failures only: the lock is kept while Wise is re-read every 30 s, up to 8 times or 4 min. If reads still
      fail, it becomes a safety outcome.
    - Anything else: halt, then settle `rejected`, `unknown_outcome` or `verify_failed`, then the
      `correction_failed:<sid>` incident. No release.
  - **Dry run:** never locks, records or posts. Its guard labels mark the fresh read as "without the lock".
- **`correction-store.ts`:** `pgCorrectionStore(db, { actor, now?, sleep? })` with:
  - preconditions in 4 round trips;
  - the lock;
  - a conditional claim;
  - a transactional settle;
  - `recoverStaleCorrections(db, ops, { apiActorId, olderThanMs = 10 min, … })`;
  - `releaseStaleCorrectionLock(db)`;
  - helpers `correctionLockReason`, `isCorrectionLockReason`, `CorrectionStoreError`, `CORRECTION_LOCK_LEASE_MS` (8 min),
    `CORRECTION_LOCK_SETTLE_MS` (2 s), `CORRECTION_STALE_AFTER_MS` (10 min).
- **Verified in code and by tests:**
  - Halting writes no `feedback_autowriter_control_history` row, because the trigger fires only on mode or
    disabled_tutors changes.
  - While the lock is held, the real `runSweep` returns `skipped` (lease first). The webhook path returns `halted`.
    `claimPost` refuses with `conditions`.
- **`submit.ts`:** `waitForSubmitEvents` now takes `Pick<WiseFeedbackOps, "findFeedbackEvents">` and also returns the
  `events` it read. This is backward compatible with the first-post path.
- **`validate.ts`:** `tidy` is exported as `tidyFeedbackText`, with no behaviour change.

## Verification

- **Unit:**
  - `correction.test.ts`: 81 tests, one per refusal code. They also cover:
    - the dry run;
    - exactly one POST on every path;
    - halt → settle → incident ordering with no release;
    - 429 handling;
    - the read-failure loop;
    - form order and current billing;
    - window edges.
  - Autowriter suite: 36 files, 821 tests, all passing.
  - Whole unit project: 7,362 tests pass and 0 fail. 20 files fail to load only because `d3` (7) and `highs` (13)
    are missing from this worktree's `node_modules`. That is a stale clone (see Deferred) and unrelated.
- **Integration (Testcontainers, OrbStack):**
  - `correction-store.integration.test.ts`: 48 tests, all passing. All 8 autowriter integration files: 274 tests, all
    passing (job, review, store, dashboard, replay, trends, atom included).
  - **Lock, claim and settle:**
    - The lock against the real claimPost, runSweep and processSession.
    - Refusals: halted, not live, live lease, posting session, awaiting correction.
    - An owner pause survives `release()` and the stale-lock release.
    - Claim row shape on the DB clock; session row untouched; 55000 on a content change.
    - Refusal while in flight, then 23505 after settle.
    - Lock-loss refusals: resume, pause, mode, lease, tutor, row, owner flag, in-flight.
    - Settle rolls back when the session sha moved.
    - Every precondition code. An owner verdict does not block.
  - **Recovery:** verified, not_sent, safety, read_failed, and the 2 h limit for an awaiting event.
  - **End to end through the real store:**
    - `ingestFixEvents` gives `autowriter_first` and `autowriter_correction` (countsAsFix, post_id = ours), with no
      `api_actor_unmatched`.
    - `raiseFixFlags` gives 0 flags and 0 incidents.
    - `refreshReviewCounts` gives corrections_verified = 1.
    - `snapshotFirstShots` records 0 and leaves 0 unverified.
- **Mutation checks:**
  - **Executor (8), each caught by 1–13 failing tests:** squashed whitespace; dropped foreign-save check; no halt
    before settle; release on safety; dry run taking the lock; POST retried after 429; credit identity unchecked;
    window not enforced.
  - **Store (8), each caught:** halting when already halted; no in-flight check; release without CAS; claim ignoring
    the lock; settle keeping a failed CAS; loose stale-lock pattern; owner flags ignored; recovery calling anything
    `not_sent`.
- **Static checks:** `tsc --noEmit` is clean for every changed file; the only errors are the pre-existing `d3`/`highs`
  imports. `eslint src/lib/feedback-autowriter` is clean.

## Deviations from the spec

1. **Rule 2, safety: `recordPostStart` is a conditional claim.** It inserts only while the lock is still ours, which
   means:
   - mode live;
   - the halt reason is exactly the lock;
   - the lease token is ours and live;
   - the tutor is not disabled;
   - the session still has the base text and its deadline is more than 30 min away;
   - no open owner flag;
   - nothing in flight.

   Otherwise it throws `CorrectionRefusedError` (`lock:lost`, `row_changed`, `owner_flag_open`, `post_in_flight`,
   `control:tutor_disabled`). Without this, an owner pause or resume during the up to 3 minutes before the POST would
   not stop the POST. A resume would even let a first post run alongside ours. The interface is unchanged: refusal
   is by exception, and the input gains optional `freshReadAt`, `studentWiseUserId` and `baselineCredits` for
   recovery.
2. **Rule 2, `releaseStaleCorrectionLock` is stricter.** "halt_reason starts with `correction-lock:`" would un-halt a
   safety halt, because `haltAutowriter` appends ` | then: …` after the lock reason. It now requires:
   - the exact lock reason, with nothing appended;
   - the lease named in the reason no longer live, so a live correction is never un-halted;
   - no unsettled correction.
3. **Extra, fail-closed codes:**
   - plan: `fields_malformed`, `base_hash_mismatch`, `reason_missing`, `reason_too_long`, `api_actor_missing`,
     `text:untidy:*`, `text:too_long:*`, `text:policy:*`;
   - DB: `row_missing`, `row_mismatch`, `deadline_unknown`, `base_not_first_shot`, `first_shot_time_mismatch`
     (60 s tolerance), `base_billing_mismatch`;
   - Wise: `form:existing_answers_not_in_form_order`, `student_id_missing`, `student_count_N`, `student_changed`,
     `first_shot_save_missing`, `events_read_failed`;
   - after the POST: `extra_api_save_in_post_window`.

   `already_corrected` also covers policy re-posts, script corrections and the re-post metadata keys. The lock's
   in-flight check covers any posts row, not just corrections.
4. **Students are ignored** in the "saves since the first shot" check, as in `classifySubmitEvents` and the fix
   classifier: their form is not the teacher's text.
5. **Dry run outside the window** returns `preflight_ok` with the guard labelled "not enforced". It is not refused.
6. **`pgCorrectionStore` accepts `now` but does not use it.** Every comparison it makes is on the database clock.
   It also accepts an injectable `sleep`.

## Open risks / follow-ups

- **Webhooks during the lock.** Webhooks arriving while the lock is held are marked `halted` and are picked up by the
  next backstop sweep, up to about 15 minutes later. The same is true of any halt.
- **A lock that outlives its run stays halted.** If the process dies, the autowriter stays halted until
  `recoverStaleCorrections` and `releaseStaleCorrectionLock` run (PR C's `recover`) or the owner resumes.
- **Unread first-shot save.** `findFeedbackEvents` reads only the 50 most recent feedback events of the class. A very
  busy class whose first-shot save falls off that page is refused (`first_shot_save_missing`).
- **STOP file after the POST.** A STOP file that appears after the POST makes every Wise read fail. That ends in a
  safety halt after 4 min, which is fail-closed but reported as "did not verify".
- **Caller's text checks.** The caller's `textProblems` should include `validateFeedbackDraft`'s field checks,
  especially AI-suspect and copy-similarity against prior feedback, which need context the executor lacks. Class
  Feedback runs an AI review on suspect versions.
- **No automatic flag.** Design §2 asks for an automatic flag when an agent corrects. This PR raises none, and
  `raiseFixFlags` never flags `autowriter_correction`. PR A's audit should raise the `agent` flag; `agent` flags do
  not block a correction, only `owner` ones do.
- **Nothing calls this yet.** The nightly script (PR C) must build the plan from the first-shot posts row:
  - `base.firstShotPostedAt = post_started_at`;
  - `submissionId` from `sessions.metadata.expected.submissionId`;
  - `billing` from the first shot.

## Deferred (out of scope)

- This worktree's `node_modules` (and the main checkout's) lacks `d3` and `highs`. Run
  `scripts/dev/worktrees.sh deps slot-a`, but note it clones the first matching checkout, which is the stale main
  one. `slot-b` has a complete install. CI's fresh `npm ci` is unaffected.

## Self-Check: PASSED

- Files: all 5 created files and both modified files exist on the branch.
- Commits: 8fdc2f5a, 8f7b1432 and 13a4e03f are in `git log`.

## Review fixes

Fourteen commits on top of d8a699ab, one per finding where practical, each with its tests green, so they
cherry-pick in order. Files: `correction.ts`, `correction-store.ts`, `validate.ts` (extraction only), their tests and
`__tests__/correction-fixtures.ts`.

| Commit | Finding | Fix |
| --- | --- | --- |
| 09057c85 | H1 | `feedbackTextChecks` is the context-free half of `validateFeedbackDraft`: placeholder tokens and text, Thai, Wise's limit, markdown, content bar, `attendance_wording:*`. `validateFeedbackDraft` keeps its exact reasons and their order; its tests are unchanged and pass. `correctionTextProblems` runs these checks plus AI-suspect and copy checks. Their context (`aiSuspect`: student names, tutor names, prior feedback) is a required input, and an incomplete one is refused as `ai_suspect_input_missing`. |
| 6d88a43e | M4 | Refusal `root_cause_missing`. `CORRECTION_DAILY_CAP = 6`: agent corrections other than `not_sent` in 24 h, refused as `daily_cap` in `preconditions` and inside the conditional insert. |
| 96fd801a | L7 | Extra keys on the corrected or base text are refused (`fields_extra_keys`). `exactFeedbackFields` strips to the four fields before anything is hashed, posted or stored, in both the executor and the store. |
| f7d3318b | L3 | `preconditions` returns `{ problems, firstShotPostedAt }`, the first shot's own `post_started_at`. The events are read from that time, never the plan's. `first_shot_time_unknown` if there is none. |
| 918f6a59 | L1 | Under the lock the events are read first and the session last (`freshReadAt` is taken at that read). The POST window starts at the events read (`eventsReadAt`, stored for recovery), so a save between the two reads is never outside both. |
| 80b245f6 | H2 | The store's lock reads the database clock from the halt update (`RETURNING now()`), between two readings of the local clock. It refuses `clock_skew` beyond 2 s either way, whatever the round trip, and leaves nothing behind. `databaseNow()` timestamps the events read, the session read and the POST's end. The POST's start is the posts row's `post_started_at`. Recovery reuses these database times. If the database clock can't be read, the correction is refused before the POST; after the POST, the window ends at the POST time-out instead. |
| dd212d2b | M2 | Lease 20 min (pinned by a test above the longest run plus 5 min). Stale threshold is the lease plus 5 min. `recoverStaleCorrections` returns `lease_live` and touches nothing while a correction lease is live; the stale release already waited. After the claim, `CorrectionLock.isHeld()` (on the database clock) and then the lock budget are checked, with nothing in between, so a machine that slept never posts (`not_sent`: `lock_lost`, `lock_budget`, `lock_check_failed:*`). |
| 13c9bb6d | M1 | Events are polled every 20 s for up to 5 min. If our event is still unseen, the row settles `awaiting_event` and the lock is kept: the outcome is `awaiting_event_locked`, and the old `awaiting_event` outcome is gone. The `recover` command then runs `recoverStaleCorrections`, which settles it by reads only, then `releaseStaleCorrectionLock`, which lifts the lock. |
| c15ed8be | M3 | Recovery of an `awaiting_event` row checks only the events, like `reconcileRow`. The second-API-save window ends at the POST's end (or start plus the POST time-out) plus 5 s, in both recovery and the executor. |
| 3329632f | L4 | Both releases also require `updated_at = halted_at` (nothing has written the control row since the lock) and no ` \| then: `. |
| 2276e37e | L5 | `productionStillHalted: true` on `refused`, `not_sent` and `verified` when the release's compare-and-swap did not fire. |
| 8d317a19 | L8, L10 | New tests: the stale release with a `posting` row left unsettled, and an incident write failing on the safety path. The fixture comment now says `API_ACTOR` is the real, public API user id. The other L8 tests landed with H1, M2 and M3. |
| 3096fb38 | L2 | Documented, not changed: a `not_sent` correction still uses up the class's one correction. |
| b178bf4a | — | JSDoc reflow. |

### Interface changes PR C must follow

- `CorrectPostInput.aiSuspect` is required: `{ studentNames, tutorNames, priorFeedback, styleGuided? }`. It needs at least one student name and one tutor name. Prior feedback is keyed by Wise session id; the class's own entry is ignored.
- `correctionTextProblems(fields, { wiseSessionId, aiSuspect, textProblems })`.
- `CorrectionStore.preconditions` returns `{ problems, firstShotPostedAt }`.
- New methods: `CorrectionStore.databaseNow()` and `CorrectionLock.isHeld()`. Any fake store needs both.
- `CorrectionOutcome`:
  - `awaiting_event` is replaced by `awaiting_event_locked`. The lock is still held, so run `recover` after the lease.
  - `productionStillHalted?` is added on `refused`, `not_sent` and `verified`.
- `CorrectionRecoveryResult` gains `lease_live`.
- Constants:
  - `CORRECTION_EVENT_WAIT_MS` is now 5 min.
  - `CORRECTION_LOCK_LEASE_MS` is now 20 min.
  - `CORRECTION_STALE_AFTER_MS` is now 25 min.
  - New: `CORRECTION_EVENT_POLL_MS`, `CORRECTION_MAX_CLOCK_SKEW_MS`, `CORRECTION_DAILY_CAP`.
- Pass the executor and `pgCorrectionStore` the same `now`, or neither. The clock check compares the store's clock
  with the database's.

### Decisions beyond the review's wording

- **H1, Thai check.** A draft's Thai check reads the model's text before the student's name is restored. A correction
  has no such text, so the student's names from `aiSuspect` are removed before the check. A Thai Wise name passes;
  Thai anywhere else is refused.
- **H2, where the clock check lives.** The store's lock compares its own clock with the database clock. The executor's
  `now` then drives only the window, the budgets and the waits. This keeps the integration tests possible: their
  executor clock sits at minute 11, while the database clock is real time.
- **L1, window start.** Starting the POST window at the session read (`freshReadAt`) alone would open a gap after the
  events read, so the window starts at the events read instead.
- **L4, the nonce.** The lock reason already carried a nonce: its lease token, a fresh UUID. A nonce cannot stop a
  *new* reason that is a substring of the lock reason from being folded in by `haltAutowriter`. Only the
  `updated_at = halted_at` guard can. The cost: an owner write during the lock (for example, switching a tutor)
  leaves the autowriter halted until an owner resumes. The outcome says so (`productionStillHalted`).
- **M4, `rootCauseRef` type.** It stays `string | null` for compatibility and is refused at runtime.
- **M1, recover command.** `recoverStaleCorrections` and `releaseStaleCorrectionLock` stay separate calls; together
  they make the `recover` command. The return type is unchanged.

### Verification

- **Unit** (`npx vitest run --project unit src/lib/feedback-autowriter`): 36 files, 855 tests, all passing. Before
  the fixes: 821.
- **Integration** (`correction-store.integration.test.ts` and `job.integration.test.ts`, OrbStack): 186 tests, all
  passing. Before the fixes: 161. All eight autowriter integration files: 299 tests, all passing (before: 274).
- **Static checks:** `eslint src/lib/feedback-autowriter` is clean. `tsc --noEmit` shows 27 errors, all from the
  missing `d3` and `highs` packages (the tutor-offboarding workforce charts and the classrooms overflow planner).
- **Mutation checks.** Each fix was broken, a failing test was seen, and the fix was restored.
  - **H1:**
    - Dropping the shared checks: 6 tests fail.
    - Dropping the name masking: 1 fails.
    - Dropping the AI-suspect check and the required input: 2 fail.
  - **H2:**
    - No clock check: 2 fail (the ±20 s integration tests).
    - Windows on the local clock: 9 unit tests fail, plus the end-to-end integration test.
  - **M2:**
    - No `isHeld` before the POST: 3 unit and 1 integration fail.
    - No budget re-check: 1 fails.
    - Recovery under a live lease: 1 fails.
    - An 8-minute lease: the lease invariant test fails.
  - **M4:**
    - The claim ignores the cap: 1 fails.
    - The preconditions ignore the cap: 1 fails.
    - No `root_cause_missing`: 2 fail.
  - **Also caught:**
    - L1's window anchor.
    - M1's kept lock (unit and integration).
    - M3's bounded window (unit and integration).
    - Both L4 guards.

