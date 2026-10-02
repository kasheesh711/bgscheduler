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
duration: 34min
completed: 2026-10-03
---

# 261003-12b PR B: guarded agent correction of posted autowriter feedback

**`correctPostGuarded` replaces the text of one verified autowriter post in Wise, once per class, ever. Every guard
runs before a single, never-retried POST, made under a lock that stops every other autowriter POST. Any doubt after
the POST halts first, then settles, then pages; the lock is never lifted on a problem.**

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
