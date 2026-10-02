# Design appendix: in-app parts of the autowriter operating loop

This is a design review (read-only), 2026-09-29. The owner decisions it relies on are in `260929-lop-PLAN.md`.

## 0. What the code already establishes
- **First shots can be proven even where they were overwritten.** `.feedback-autowriter/nickname-fix.ts` rewrote
  `fields`/`fields_sha256` but never touched `feedback_autowriter_sessions.body_hash`. That hash is
  `sha256(JSON.stringify({answers:[…form order…], sessionStatus, creditsConsumed}))` (`submit.ts` `feedbackBodyHash`,
  `session.ts` `buildFeedbackPostBody`), so it pins the exact first-shot POST body for every posted row, including
  Gift's `6aba30a97d4c21cce9b574d1`.
- **The single-POST lock:**
  - The claim is one UPDATE with `not exists (… p.state in ('posting','awaiting_event'))` (store.ts ~291), backed by
    the partial unique index `feedback_autowriter_sessions_single_posting_idx ON (state) WHERE state='posting'`.
  - `isUniqueViolation` maps any 23505 to `post_in_flight` (store.ts ~180), so new unique indexes must never be part
    of the claim statement.
- **Tutors can't fix our posts in Wise** (`allowTeacherFeedbackUpdate=false`). Measured fixes are therefore almost all
  admin saves or our own re-posts.
- **Two identity caveats:**
  - The API actor `69366668…a4` is Kem (OWNER); her own web saves look identical to API posts.
  - Kevin's web ADMIN id `695369c0…986` is also his main roster account, so on his main-account classes an owner fix
    and a tutor edit can't be told apart. Both count as a fix.
- **Refresh rates:** `credit_control_*` refreshes only daily (06:20 Bangkok) while Credit Control is retired;
  `future_session_blocks` refreshes every 30 min.
- **Timezone helper exists:** `snapshotInstant` in `src/lib/tutor-sit-ins/sources.ts` converts `future_session_blocks`
  times (Bangkok clock labelled UTC) with `fromZonedTime`. Hoist it to `src/lib/bangkok-time.ts` and reuse it.
- **Conventions to follow:**
  - hand-written SQL migrations plus `_journal.json` entries;
  - append-only triggers that raise `55000` (the pattern from 0055 `post_class_reject_immutable_mutation`);
  - `withDatabaseTransaction` (pg-pool with a neon-http fallback);
  - the single-running partial unique index used by `sync_runs`.

## 1. Data model (four migrations, one per phase)

### 0099_feedback_autowriter_review.sql (Phase 0/1)
```sql
feedback_autowriter_posts            -- immutable record of every POST that landed or was attempted
  id uuid pk, wise_session_id text not null,
  kind text check (kind in ('first_shot','correction')), correction_id uuid,  -- FK added in 0101
  fields jsonb not null, fields_sha256 text not null, body_hash text, billing jsonb not null,
  arm text, evidence text, pipeline jsonb,            -- commit sha, prompt/judge versions, model, evidence kind
  actor_kind text check (in ('autowriter','owner','agent','script')), actor text not null, reason text,
  post_started_at, post_finished_at timestamptz,
  outcome text check (in ('posting','awaiting_event','verified','not_sent','rejected','unknown_outcome','verify_failed')),
  verification jsonb not null default '{}',  -- problems[], submissionId, teacherSubmissions, creditsBefore/After, eventAt, fieldOrder
  provenance text check (in ('snapshot','live','backfill')), reconstruction jsonb,
  recorded_at, settled_at
  UNIQUE (wise_session_id) WHERE kind = 'first_shot'
  -- trigger: content columns immutable; outcome/verification/settled_at mutable only while outcome in ('posting','awaiting_event'); no DELETE

feedback_autowriter_verdicts         -- append-only log
  id, wise_session_id, target_kind check (in ('post','dry_run')) default 'post', post_id fk posts, dry_run_id,
  verdict check (in ('approve','needs_fix')), severity check (in ('cosmetic','factual','critical')),
  critical_category check (in ('wrong_person','billing_status','invented_content','should_not_have_posted')),
  note, reviewer not null, source check (in ('dashboard','backfill')), supersedes_id, created_at
  CHECK ((verdict='approve') = (severity is null)), CHECK ((severity='critical') = (critical_category is not null))

feedback_autowriter_reviews          -- one per posted class; the "current view"
  wise_session_id pk, first_post_id unique fk, tutor_key, class_ended_at, bangkok_date date,
  inclusion_reason check (in ('new_tutor','random_sample','not_sampled')),
  inclusion_probability numeric(4,3), sample_draw double precision not null,  -- uniform [0,1), crypto RNG, drawn once
  sampling_policy text,                                                       -- 'v1: 100% until gate; proven tutors 0.30'
  flagged_at, flag_sources text[] default '{}',
  current_verdict_id fk verdicts, reviewed_at, measured_fix_count int, corrections_verified int
  -- trigger: inclusion_reason/probability/sample_draw set-once; current_verdict_id updated in the same tx as the verdict insert

feedback_autowriter_flags
  id, wise_session_id, source check (in ('measured_fix','agent','owner','api_unmatched','system')),
  suggested_severity, suggested_category, note, created_by, idempotency_key UNIQUE, resolved_by_verdict_id

feedback_autowriter_fix_events       -- derived from wise_activity_events; can be re-derived
  wise_event_id text pk, wise_activity_event_id fk (on delete set null), wise_session_id, event_at,
  actor_wise_user_id, actor_role, auto_submitted,
  actor_kind check (in ('autowriter_first','autowriter_correction','api_actor_unmatched','owner_web',
                        'tutor','other_staff','student','auto')),
  post_id fk posts, counts_as_fix bool, classifier_version int

feedback_autowriter_incidents        -- outbox
  id, dedupe_key UNIQUE,
  kind check (in ('halt','correction_failed','critical_verdict','critical_flag','credit_entries_changed',
                  'api_actor_unmatched','first_shot_unverified','scan_failed')),
  severity check (in ('critical','info')), wise_session_id, summary, detail jsonb,
  push_status check (in ('pending','sent','failed','not_required')), push_attempts, pushed_at,
  last_push_error, acknowledged_at/by
  CHECK (severity='critical' OR push_status='not_required')

feedback_autowriter_daily_metrics    -- cache that can be recomputed; upserted
  PK (metric_date date, tutor_key text /* '*' = all */),
  posted, reviewed_required, accurate, cosmetic, factual, critical, eligible, excluded_tutor_first,
  excluded_absent, unseen, held, expired, failed, measured_fix_classes, corrections_verified,
  required_pending, policy_version, computed_at

feedback_autowriter_gate_evaluations -- append-only
  id, eval_kind check (in ('daily','on_demand','expansion_confirm')), bangkok_date, window_start, window_end,
  roster_tutors text[], reviewed, accurate, wilson_lower numeric(5,4), critical, pending_critical_flags,
  pending_flagged_reviews, coverage_num, coverage_den,
  status check (in ('insufficient_data','below_head_start','head_start','pass','blocked_critical')),
  reasons text[], thresholds jsonb
  UNIQUE (bangkok_date) WHERE eval_kind = 'daily'
```

### 0100_feedback_autowriter_forward_scan.sql
```sql
feedback_autowriter_scan_runs
  id, kind check (in ('full','delta')), status check (in ('running','succeeded','failed','skipped')),
  snapshot_id, snapshot_created_at, credit_snapshot_id, credit_generated_at,
  source_fresh bool not null, window_start/end, counts jsonb, error_summary, started_at, finished_at
  UNIQUE (status) WHERE status = 'running'   -- single-flight; a run stuck over 15 min can be taken over

feedback_autowriter_scan_classes     -- one row per class occurrence
  occurrence_key text pk,            -- wise_class_id|start_at_utc_iso (survives delete-and-recreate)
  wise_class_id, wise_session_id, previous_session_ids text[], tutor_key, wise_teacher_user_id,
  cohort check (in ('roster','candidate')), start_at, end_at (real UTC), student_wise_id,
  predicted_display_name,
  predicted_disposition check (in ('post','transcript_pass','hold','skip_scope','tutor_first_likely','tutor_off')),
  predicted_reasons text[], input_hash, priors jsonb, first_seen_run_id, last_seen_run_id,
  status check (in ('open','closed')),
  closed_reason check (in ('cancelled','deleted','moved_onsite','moved_time','ended','tutor_removed')), closed_at,
  outcome_state, outcome_reason, outcome_linked_at, prediction_match bool

feedback_autowriter_scan_findings
  finding_key text pk,               -- check_code|wise_class_id (series) or check_code|occurrence_key
  check_code, level check (in ('occurrence','series')), wise_class_id, occurrence_key, tutor_key,
  severity check (in ('info','warn','block')), summary, evidence jsonb, evidence_hash,
  proposed_handling check (in ('auto_rule','hold_for_human','ignore')), proposed_rule, predicted_outcome,
  status check (in ('open','closed')),
  closed_reason check (in ('cancelled','deleted','moved_onsite','moved_time','ended','resolved','series_ended','tutor_removed')),
  first_seen_at, last_seen_at, first_run_id, last_run_id, seen_count, reopened_count,
  next_occurrence_at, affected_occurrences
  CHECK ((level='occurrence') = (occurrence_key is not null))

feedback_autowriter_edge_case_decisions  -- append-only; decisions attach to the key, so re-scans never re-ask
  id, finding_key, check_code, scope check (in ('occurrence','series','check')),
  decision check (in ('auto_handle','hold_for_human','ignore')), note, decided_by,
  recorded_via check (in ('dashboard','interview_agent')),
  owner_confirmed_at,                -- set-once; required before an interview decision is enforced
  supersedes_id, created_at
```

### 0101_feedback_autowriter_corrections.sql (touches the safety lock)
```sql
-- sessions: add state 'correcting' to the state CHECK; add correction_id uuid, correction_started_at timestamptz
CREATE UNIQUE INDEX feedback_autowriter_sessions_single_write_idx
  ON feedback_autowriter_sessions ((true)) WHERE state IN ('posting','correcting');  -- create first …
DROP INDEX feedback_autowriter_sessions_single_posting_idx;                         -- … then drop the old one
-- control: corrections_enabled bool default false, agent_corrections_enabled bool default false

feedback_autowriter_corrections
  id, wise_session_id, base_post_id fk posts, base_fields_sha256,
  proposed_fields jsonb, proposed_sha256,
  method check (in ('recipe_rename','model_revise','manual','agent')),
  severity not null, critical_category, reason not null,
  initiator_kind check (in ('owner','agent','system')), initiated_by, idempotency_key UNIQUE,
  root_cause_ref,
  status check (in ('proposed','approved','executing','awaiting_event','verified','not_applied','refused',
                    'rejected','unknown_outcome','verify_failed','cancelled','superseded')),
  approved_by, approved_at, approved_sha256, post_id fk posts, refusal_reason,
  outcome jsonb, attempts, next_attempt_at
  CHECK (initiator_kind <> 'agent' OR root_cause_ref IS NOT NULL)
  CHECK (severity <> 'critical' OR status IN ('proposed','cancelled','superseded')
         OR (approved_by IS NOT NULL AND approved_by NOT LIKE 'agent:%' AND approved_by NOT LIKE 'policy:%'))
  CHECK (status NOT IN ('approved','executing','awaiting_event','verified') OR approved_sha256 = proposed_sha256)
  UNIQUE (wise_session_id) WHERE status IN ('proposed','approved','executing','awaiting_event')
```

### 0102_feedback_autowriter_expansion.sql
- **`expansion_rounds`:** `round_no` unique, `from_size`/`to_size`, `status` (`head_start`/`ready`/`confirmed`/`live`/`abandoned`),
  `head_start_eval_id`, `pass_eval_id`, `confirmed_by`/`at`. A partial unique index `ON ((true)) WHERE status IN ('head_start','ready','confirmed')`
  allows only one open round.
- **`tutor_enrollments`:** `tutor_key`, `display_name`, `wise_user_ids text[]`, `round_id`, `rank`, `online_1to1_hours_30d`.
  - Status runs `candidate` → `head_start` → `confirmed` → `notice_sent` → `roster_pending` → `live`, with
    `declined`/`dropped` as exits; timestamps and `live_review_until`.
  - Round 0 holds the current five tutors.
- **`dry_runs`:** `enrollment_id`, `wise_session_id` UNIQUE, gate result, predicted state, `arm`, `fields`, `judge`, `held_reasons`,
  `human_fields` (from `post_class_feedback_versions`), `cost_usd`, `status`.
- **Other changes:** `feedback_autowriter_calls.purpose` CHECK `('production','dry_run','correction')`, and a verdicts FK to
  `dry_run_id`. Dry-run verdicts never count toward the gate.

## 2. Guarded "correct posted feedback" path
Replaces `nickname-fix.ts` with `correct.ts` (the guarded path plus a `CorrectionStore`) and `correction-policy.ts`.

**Preconditions, all checked before the claim:**
1. The correction is `approved`, and `approved_sha256 = proposed_sha256 = sha(fields to send)`.
2. The session state is exactly `verified`, never `awaiting_event`.
3. A first-shot record exists, and `sessions.fields_sha256 = base_fields_sha256`.
4. The control row allows it:
   - not halted, `mode <> 'off'`, `corrections_enabled`;
   - for an agent correction, also `mode='live'`, `agent_corrections_enabled` and the tutor switched on.
5. The environment allows it: not a preview deployment, `WISE_USER_ID` set, no stuck post in flight.
6. The corrected text passes `validateFeedbackDraft`'s field checks: placeholders, Thai, the 5000-character limit,
   markdown, `assessFeedbackContent` compliance, and `assessAiSuspect` against prior feedback. A correction must
   never create a deduction.
7. The credit baseline holds: exactly one credit entry for the session, equal to the billed credits. Keep the raw
   entries for later comparison.
8. A fresh detail GET shows:
   - exactly one teacher submission (store its id as `metadata.expected.submissionId`);
   - not auto-flagged, meeting `ENDED`, and the form plan plus `existingAnswersMatchForm` pass;
   - the stored teacher, sessionStatus and credits all unchanged from the stored billing;
   - **Wise's stored text exactly equals the base post's text.** If anyone edited it, refuse with
     `wise_text_differs_from_last_post` and raise a flag. A human's text is never overwritten.

**Claim** (in `withDatabaseTransaction`):
- `UPDATE sessions SET state='correcting', correction_id, correction_started_at=now() WHERE state='verified' AND fields_sha256=$base AND teacher=$fresh AND <control predicate> AND NOT EXISTS (… state IN ('posting','awaiting_event','correcting'))`.
- In the same transaction, the correction moves to `executing` and a posts row is inserted (`kind='correction'`, `outcome='posting'`).
- The constant-key partial unique index settles a race between a first-post claim and a correction claim; both map to `post_in_flight`.

**Changes to the existing path, in the same PR:**
- `unsettledPostSql` and `UNSETTLED_POST_STATES` gain `'correcting'`.
- `stuckPostInFlight` uses `correction_started_at` for `correcting` rows. Otherwise it would read the old first-post
  `post_started_at` and see a permanently stuck post.
- The dashboard's `POSTED` set and `recentAutowriterPosts` include `correcting`.

**POST and verification:**
1. One POST, never retried. The body re-sends the current billing unchanged, so there is never a new charge.
2. Read back after 3 seconds. Check:
   - the text equals the new text;
   - one submission with the same id;
   - billing unchanged and not auto-flagged;
   - credit entries identical to the baseline, in count and values.
3. `waitForSubmitEvents`: our event appears after `postStartedAt`, and no foreign save falls inside
   [fresh read − 5 s, POST end + 5 s].

**Settling:**
- **Verified:** the posts row moves to verified; `sessions.fields`/`fields_sha256` become the new text; the state
  returns to `verified`; the correction moves to `verified`.
- **Problems found:** halt first, then release the lock (the existing order), and record an incident with a push.
- **Read failures only:** stay `correcting`.
- **Our event not seen yet:** the correction goes to `awaiting_event` while the session stays `correcting`.
- **429 with the old text still in Wise:** back to `approved`, retry after 10 minutes, at most 3 attempts.

**Sweep reconcile** (runSweep step 1, reads only) for stale `correcting` rows:
- the new text landed and verifies: verified;
- the base text is still there: `not_applied`, then release;
- anything else: halt, then release;
- no event within 2 hours: `verify_failed` and halt.

**Counting fixes:** each correction is a posts row, and its API-actor activity event is matched to it
(`actor_kind='autowriter_correction'`). `reviews.measured_fix_count` = verified corrections plus human events with
`counts_as_fix`.

**Owner-approved vs agent-initiated:**
- **Owner:** Needs fix → the system proposes a text. The `recipe_rename` recipe comes from the nickname logic, with
  `manual` alongside; `model_revise` comes later, with names redacted, the Wise summary re-read as evidence, and the judge.
  The owner edits it if needed and approves; execution runs via `after()`. The approval route has `maxDuration = 800`,
  and the hourly review cron is the backstop, with at most 2 per invocation. Corrections never run inside the
  deadline-bound sweep.
- **Agent:** `authorizeAgentCorrection` allows only cosmetic or factual severity. It also requires:
  - a `root_cause_ref`;
  - a diff cap: at most 25% of words, no billing fields;
  - at most 1 per session and 5 per day;
  - an automatic flag so the class is reviewed.
  - A critical agent proposal stays `proposed` and raises a `critical_flag` incident. The approver of an agent's
    non-critical correction is `policy:agent-auto`.

**API surface:**
- **Owner routes** (`requireClassroomOperationsOwner`):
  - `POST /api/feedback-autowriter/verdicts`;
  - `POST /api/feedback-autowriter/corrections` (propose);
  - `POST /api/feedback-autowriter/corrections/[id]`: `approve` with `approvedSha256` and optional edited fields
    (an edit creates a superseding row), or `cancel`;
  - `POST /api/feedback-autowriter/edge-cases`, `/expansion` and `/incidents` (acknowledge);
  - `GET /api/feedback-autowriter/review` (admin read).
- **Agent routes:** `/api/internal/feedback-autowriter/agent/{queue,flags,corrections,edge-cases,incidents}`, with an
  idempotency key on every write.

**Agent authentication (recommended):** an internal API with a dedicated bearer token, `FEEDBACK_AUTOWRITER_AGENT_TOKEN`,
production only, compared timing-safe in a new `agent-auth.ts` modelled on `cron-auth.ts`. Never reuse `CRON_SECRET`.
- The server then enforces severity, diff caps, rate limits and kill switches.
- Writes use Vercel's production Wise credentials and share the lock and executor.
- Rotating the environment variable revokes access.
- A CLI with a database URL would make every rule advisory. The owner chose full `.env.local` on the Mac, so the
  agent's instructions must still call only these routes and the loop script, and never write to Wise or the DB
  directly.
- **Catch unmatched writes:** any API-actor submit event that matches no post becomes an `api_actor_unmatched` fix
  event plus an incident. This also catches future one-off scripts.
- **Retire `nickname-fix.ts`:** it bypasses the lock.

## 3. Metrics, gate and UI
**Pure module `quality.ts`:**
- `wilsonLowerBound(x, n, z = 1.959964)`. With zero errors, n ≥ 9 reaches 0.70 and n ≥ 16 reaches 0.80. One factual
  error raises the n needed for 0.80 to 25.
- `isAccurate(verdict)`: approve, or needs-fix with cosmetic severity.
- `coverageClass(row)`:
  - **excluded:** `excluded_scope`; `excluded_absent` (held for absence); `excluded_tutor_off`; `excluded_tutor_first`
    (a human submit event before our first ok writer call); `pending`;
  - **counted as posted:** `posted`;
  - **counted as misses:** `miss_held`, `miss_expired`, `miss_failed`, `miss_unseen`. Unseen means roster
    `post_class_sessions` with no autowriter row, only when proven online 1:1 via `past_session_blocks` or the
    credit-control title/type.
  - Only days in live mode count.
- `evaluateGate`: `pass` requires all of:
  - lower bound ≥ 0.80;
  - zero critical verdicts;
  - no unresolved critical flag;
  - coverage ≥ 0.70;
  - **zero unreviewed flagged posts.**

  `head_start` means the lower bound is ≥ 0.70.
- `reviewInclusion(tutorProven, draw)`: probability 1.0 until the tutor's cohort has passed a gate, then `draw < 0.30`.
  Flags never change the draw.
- `nextExpansionSize = n + ceil(n/2)`.
- `rankCandidates`: `past_session_blocks` over 30 days, grouped by identity group so both accounts count;
  `ONE_TO_ONE` only; not OFFLINE, not an in-person title, not cancelled.

**Loader:** `review-data.ts` has `loadAutowriterReview` and the pure `buildAutowriterReview`, mirroring `dashboard.ts`
and reusing its onsite filter.

**Review cron** `/api/internal/feedback-autowriter/review` (`review-job.ts`), in order:
1. Snapshot first shots of settled posted rows, verified against `body_hash` across the 24 field-order permutations.
2. Ingest fix events.
3. Assign inclusion.
4. Raise flags.
5. Persist metrics and the daily gate evaluation.
6. Drain the incident outbox.
7. Execute backstop corrections.
8. Run bounded dry runs.

**Incidents:** pushed to LINE via `pushLineTextMessage({to: FEEDBACK_AUTOWRITER_LINE_TO, retryKey: incident.id})`, and
the desktop agent also reads them from `GET …/agent/incidents`.

**UI** (Tabs in `feedback-autowriter-dashboard.tsx`):
- **Overview:** today's view.
- **Quality** (`…-quality-panel.tsx`):
  - the gate badge, and the three criteria against their thresholds;
  - a lower-bound bar marked at 70 and 80;
  - coverage breakdown chips;
  - pending flagged reviews;
  - daily and per-tutor tables with the review phase.
- **Review** (`…-review-queue.tsx`):
  - filters: required unreviewed / flagged / all;
  - the immutable first shot (with a "reconstructed · hash-verified" badge) next to the current text, and a diff;
  - measured fix events by actor;
  - owner Approve / Needs fix, with severity, category and note;
  - the verdict log;
  - a correction panel with an editable proposal, a "billing unchanged" confirmation and a timeline.
- **Edge cases** (`…-edge-cases.tsx`): needs decision / decided / closed; decisions by scope; "confirm interview decisions".
- **Forward scan** (`…-forward-scan.tsx`):
  - freshness;
  - 30-day counts per tutor;
  - the next 7 days with their predicted disposition;
  - the backtest confusion table;
  - holds that weren't predicted.
- **Expansion** (`…-expansion.tsx`):
  - the ranking;
  - head-start dry runs next to what each tutor actually wrote;
  - Confirm / Notice sent / Live buttons, disabled until the gate passes.

In-person classes stay hidden everywhere.

## 4. Forward scan
**Crons** (UTC in `vercel.json`; minutes 19, 39 and 27 are free every hour):

| Cron | UTC schedule | Bangkok time | Job |
|---|---|---|---|
| `…/forward-scan` | `19 */2 * * *` | 07:19, 09:19, 13:19, … | Delta scan, landing just before the 09:30 and 14:00 interviews |
| `…/forward-scan-full` | `39 15 * * *` | 22:39 | Full scan, after the 22:30 Wise snapshot |
| `…/review` | `27 * * * *` | every hour | Runs after the :17 activity sync |

- **Registration:**
  - add them to `CronJobKey` in `cron-registry.ts`; the nightly one gets `expectedBangkokMinute: 1359`;
  - they pause when `FEEDBACK_AUTOWRITER_ENABLED` is not true;
  - `vercel-crons.test.ts` goes from 27 to 30 pinned schedules.
- **Wise calls:** zero. The scan reads the DB only.

**Pure core** (`forward-scan.ts`): `scanOccurrence(input) → {inScope, dropReason, predictedDisposition, findings[]}`.
- **Inputs:**
  - the active `future_session_blocks` row, converted with `snapshotInstant`;
  - the latest `credit_control_sessions`/`credit_control_packages`, joined by session id, or by class id plus real UTC
    start;
  - priors per `wise_class_id`.
- **Checks:**
  - **Scope:** onsite or group classes are dropped (used for move detection).
  - **Student:**
    - `student_count_mismatch`: `student_count` or ids ≠ 1 → hold;
    - `student_no_wise_id`: no student ids → hold;
    - `nickname_unusable` (series): `chooseStudentDisplayName` falls back → ignore, or add a rule.
  - **Billing and credits:**
    - `billing_length_mismatch`: `scheduledDurationCredits(min)` ≠ the credits on this series' past
      `post_class_sessions`, or minutes not a multiple of 15 → predicts `held billing:`;
    - `credit_balance_nonpositive`: the package has ≤ 0 available; the finding shows when that was observed.
  - **Accounts:** `main_account_online` (info); `tutor_switched_off` (info).
  - **Priors from history:**
    - `prior_thai_summary` → transcript pass (auto; already handled);
    - `prior_guest_join` (auto; already handled);
    - `prior_holds`: ≥ 2 of the last 5 held for the same reason;
    - `prior_multi_part_recording`;
    - `prior_tutor_first`: ≥ 50% human-first, from `post_class_feedback_event_links` timing → ignore.
  - **Double-joins** aren't recorded today. Add a `participantsSummary` to the `postDraft` metadata; it is off the safety
    path.
- **Delta vs full:** the full scan recomputes priors; deltas reuse the stored priors and compute them only for new
  class ids.

**Lifecycle** (pure `planScanChanges(prev, current, {sourceFresh, deletedSessionIds})`):
- Findings are upserted by key. `evidence_hash` suppresses writes when nothing changed, and a closed finding that
  fires again is reopened.
- **Same occurrence, new data:**
  - a new session id at the same class and start is the same occurrence: update the session id and append the old one
    to `previous_session_ids`;
  - the same occurrence now onsite closes `moved_onsite`;
  - the same session id at a new start closes `moved_time` and opens a new occurrence.
- **Closure reasons:** Wise status cancelled closes `cancelled`; a `SessionDeletedEvent` in `wise_activity_events`
  closes `deleted`; a past start closes `ended`; series findings close as `resolved` or `series_ended`.
- **Closure because something is absent** happens only when `source_fresh`: the snapshot is newer than the previous
  run's and under 2 hours old.

**Backtest:**
- Ended occurrences link to their terminal `feedback_autowriter_sessions` row, or count as unseen.
- An `OUTCOME_REASON_TO_CHECK` map gives per-check precision and lists holds nothing predicted.
- `scripts/backtest-forward-scan.ts` replays the last 14 days from `past_session_blocks`, using the priors as they were
  on each date.

**Decisions:**
- Advisory until the enforcement phase.
- Enforcement is then a `class_rules` check in `processSession` before `claimGeneration`:
  - `hold` → `held` with reason `owner_rule:hold` and an alert;
  - `leave_to_tutor` → `skipped_scope`.
- Only owner-confirmed decisions are enforced, and a rule-read failure fails closed as a retry.

## 5. First-day backfill
`scripts/feedback-autowriter-backfill-review.ts`: a dry run by default (`--apply` writes), and it never writes to Wise.
1. **Candidate first shots** for every row with `post_started_at`:
   - the current `fields`;
   - for `metadata.nicknameFix` rows, the earliest `post_class_feedback_versions` text plus every 2^k reverse-rename
     variant (e.g. Tom → Somchai at each occurrence).
2. **Proof:** accept only the candidate whose rebuilt body (one of the 24 field-order permutations plus the stored
   billing) hashes to `body_hash`. Record the method (`unchanged` / `pc_first_version` / `reverse_rename`) and the
   proof.
3. **No candidate matches:** record an info incident (`first_shot_unverified`) and ask the owner.
4. **The six renames:** insert six `kind='correction'` posts rows and `verified` corrections:
   - actor `script:nickname-fix (kevhsh7@gmail.com)`;
   - reason "owner naming policy: nickname";
   - time taken from `nicknameFix.at`.

   Fix-event ingestion then matches the six API-actor events to them.
5. **Inclusion:** all day-one posts get `inclusion_reason='new_tutor'`, since every tutor went live on 29 Sep.

**Verdicts wait for the owner's answers** (interview D-01).
- **Recommended:**
  - approve the posts whose text wasn't faulted;
  - record the six renames as Needs fix, cosmetic, with the note "nickname policy change". They still count as accurate,
    with a measured fix count of 1.
- **Questions to ask:**
  - Did you read every post from tonight?
  - Was any name fault a wrong person (critical)?
  - Should tonight count toward the first 14-day window?

## 6. Tests and rollout
**Unit tests:**
- **`quality.test.ts`:**
  - Wilson values: 20/20 → 0.839, 0/0 → 0, and the n thresholds above;
  - coverage classes;
  - every gate status, including a pending flagged review blocking `pass`;
  - the growth sequence 5→8→12→18;
  - ranking counts both accounts and excludes onsite classes.
- **`fix-events.test.ts`:** every actor kind; the matching windows; Kevin's shared id.
- **`correct.test.ts`:**
  - each precondition refusal;
  - exactly one POST;
  - a 429 goes back to `approved`;
  - rejected, unknown or mismatch outcomes halt before releasing the lock;
  - read failures stay `correcting`;
  - a foreign event halts;
  - changed credits halt.
- **`correction-policy.test.ts`:** an agent critical proposal stays proposed; the diff cap; rate limits; `root_cause_ref`
  required.
- **`forward-scan.test.ts`:**
  - the −7 hour conversion;
  - each check;
  - stable keys across three scans;
  - delete-and-recreate;
  - `moved_onsite`, cancelled, and ended with an outcome link;
  - no closure on a stale source;
  - series dedupe.
- **Backfill reconstruction,** including an original text that already contained "Tom".
- **Review builder and component:** owner-only controls; onsite classes hidden.
- **`vercel-crons.test.ts`** updated.
- **Routes:** 403 for a non-owner admin; 401 for a missing or wrong agent token; refused on preview deployments.

**Postgres integration tests:**
- the triggers raise `55000` on content changes to posts, verdicts, decisions and inclusion;
- 12 concurrent mixed first-post and correction claims → exactly one wins;
- a first-post claim is refused while a row is `correcting`, and a correction claim is refused while one is
  `posting` or `awaiting_event`;
- `stuckPostInFlight` detects a stale `correcting` row;
- an end-to-end correction with fake Wise, with the halt row existing before release;
- the sweep reconciles `correcting` for each outcome: landed, not applied, mismatch;
- the snapshotter;
- fix-event ingestion is idempotent;
- the scan is single-flight and never duplicates findings;
- exactly one daily gate row;
- the incident outbox retries.

**Rollout:**

| Step | Contents | Writes to Wise | Changes the POST path |
|---|---|---|---|
| 0 | 0099; backfill; review cron; Quality and Review tabs | no | no |
| 1 | 0100; forward scan; Edge cases and Forward scan tabs; agent read/flag/decision endpoints | no | no |
| 2 | 0101; owner corrections (`corrections_enabled` off by default) | yes | yes |
| 3 | agent non-critical corrections | yes | no new change |
| 4 | 0102; head start and expansion; enforced class rules | no | adds a gate in `processSession` |

## Conflicts with safety invariants
1. **Corrections must join the single-write lock.** That touches the unique index, `unsettledPostSql`,
   `UNSETTLED_POST_STATES`, `stuckPostInFlight` and the sweep reconcile. Any Wise write outside this path breaks the
   invariant.
2. **A re-post can't fix everything.** Billing/status errors, "should not have posted", and classes an admin already
   edited need a manual fix in Wise; the app records and verifies them.
3. **Agent severity is self-declared.** The server can enforce only the billing freeze, the diff cap, the validators
   and the rate limits. A dedicated Wise API user is recommended.
4. **Keep the roster a code-reviewed constant.** Expansion is an owner confirmation followed by a roster PR. New tutors
   can deploy switched off: the control route accepts disable-only ids for enrolled candidates.
5. **Dry runs read candidates' lessons before those tutors are told.** Restrict them to the zero-retention route,
   summary-only evidence and a small bound.
6. **Decisions from the outside agent aren't owner consent.** Enforcing a decision, approving a critical fix and
   confirming an expansion all need the owner's session.
7. **Sampling and definitions:**
   - Exclude voluntary reviews of posts that weren't sampled from the gate.
   - "Tutor wrote first" means a human submit event before our first ok draft.
   - The Wilson bound is two-sided with z = 1.96.
8. **Freshness and attribution:** credit balances can be up to about 24 hours stale, and Kevin's shared ADMIN/tutor id
   makes attribution ambiguous on his own classes.
9. **Payout period:** consider refusing corrections after the payout or finance period closes.
