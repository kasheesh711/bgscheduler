-- Feedback autowriter operating loop, Phase 1: measurement (quick 260929-lop, DESIGN-INAPP rollout step 0).
-- Records every text the autowriter put in Wise, the owner's verdicts on it, the fixes measured from Wise
-- activity events, quality metrics and the expansion gate. Nothing here writes to Wise, and the POST path is
-- unchanged: first shots are snapshotted from settled `feedback_autowriter_sessions` rows and proven against
-- the `body_hash` pinned by the POST claim.

CREATE FUNCTION feedback_autowriter_reject_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME USING ERRCODE = '55000';
END;
$$;
--> statement-breakpoint
-- One row per text the autowriter (or a person/script on its behalf) put in Wise: the first shot and every re-post.
CREATE TABLE feedback_autowriter_posts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  wise_session_id text NOT NULL,
  wise_class_id text,
  wise_teacher_user_id text,
  kind text NOT NULL CHECK (kind IN ('first_shot','correction')),
  -- Foreign key to feedback_autowriter_corrections arrives with that table (Phase 2).
  correction_id uuid,
  fields jsonb NOT NULL,
  fields_sha256 text NOT NULL,
  body_hash text,
  billing jsonb NOT NULL,
  arm text,
  evidence text,
  pipeline jsonb,
  actor_kind text NOT NULL CHECK (actor_kind IN ('autowriter','owner','agent','script')),
  actor text NOT NULL,
  reason text,
  post_started_at timestamptz,
  post_finished_at timestamptz,
  outcome text NOT NULL CHECK (outcome IN ('posting','awaiting_event','verified','not_sent','rejected','unknown_outcome','verify_failed')),
  verification jsonb NOT NULL DEFAULT '{}'::jsonb,
  provenance text NOT NULL CHECK (provenance IN ('snapshot','live','backfill')),
  reconstruction jsonb,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  settled_at timestamptz,
  CHECK (kind = 'first_shot' OR reason IS NOT NULL)
);
--> statement-breakpoint
CREATE UNIQUE INDEX feedback_autowriter_posts_first_shot_idx ON feedback_autowriter_posts (wise_session_id) WHERE kind = 'first_shot';
--> statement-breakpoint
CREATE INDEX feedback_autowriter_posts_session_idx ON feedback_autowriter_posts (wise_session_id, recorded_at);
--> statement-breakpoint
-- Content is immutable; the outcome, its verification and settle time may change only while unsettled.
CREATE FUNCTION feedback_autowriter_protect_post() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION '% is append-only', TG_TABLE_NAME USING ERRCODE = '55000';
  END IF;
  IF ROW(OLD.id, OLD.wise_session_id, OLD.wise_class_id, OLD.wise_teacher_user_id, OLD.kind, OLD.correction_id,
         OLD.fields, OLD.fields_sha256, OLD.body_hash, OLD.billing, OLD.arm, OLD.evidence, OLD.pipeline,
         OLD.actor_kind, OLD.actor, OLD.reason, OLD.post_started_at, OLD.post_finished_at, OLD.provenance,
         OLD.reconstruction, OLD.recorded_at)
     IS DISTINCT FROM
     ROW(NEW.id, NEW.wise_session_id, NEW.wise_class_id, NEW.wise_teacher_user_id, NEW.kind, NEW.correction_id,
         NEW.fields, NEW.fields_sha256, NEW.body_hash, NEW.billing, NEW.arm, NEW.evidence, NEW.pipeline,
         NEW.actor_kind, NEW.actor, NEW.reason, NEW.post_started_at, NEW.post_finished_at, NEW.provenance,
         NEW.reconstruction, NEW.recorded_at)
  THEN
    RAISE EXCEPTION 'post content in % is immutable', TG_TABLE_NAME USING ERRCODE = '55000';
  END IF;
  IF OLD.outcome NOT IN ('posting','awaiting_event')
     AND ROW(OLD.outcome, OLD.verification, OLD.settled_at) IS DISTINCT FROM ROW(NEW.outcome, NEW.verification, NEW.settled_at)
  THEN
    RAISE EXCEPTION 'a settled post in % is immutable', TG_TABLE_NAME USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER feedback_autowriter_posts_protect
  BEFORE UPDATE OR DELETE ON feedback_autowriter_posts
  FOR EACH ROW EXECUTE FUNCTION feedback_autowriter_protect_post();
--> statement-breakpoint
-- Owner verdicts, append-only; each pinned to the fields_sha256 of the text judged.
CREATE TABLE feedback_autowriter_verdicts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  wise_session_id text NOT NULL,
  target_kind text NOT NULL DEFAULT 'post' CHECK (target_kind IN ('post','dry_run')),
  post_id uuid REFERENCES feedback_autowriter_posts(id),
  dry_run_id uuid,
  fields_sha256 text NOT NULL,
  verdict text NOT NULL CHECK (verdict IN ('approve','needs_fix')),
  severity text CHECK (severity IN ('cosmetic','factual','critical')),
  critical_category text CHECK (critical_category IN ('wrong_person','billing_status','invented_content','should_not_have_posted')),
  note text,
  reviewer text NOT NULL,
  source text NOT NULL CHECK (source IN ('dashboard','backfill')),
  supersedes_id uuid REFERENCES feedback_autowriter_verdicts(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((verdict = 'approve') = (severity IS NULL)),
  CHECK ((coalesce(severity, '') = 'critical') = (critical_category IS NOT NULL)),
  CHECK ((target_kind = 'post') = (post_id IS NOT NULL))
);
--> statement-breakpoint
CREATE INDEX feedback_autowriter_verdicts_session_idx ON feedback_autowriter_verdicts (wise_session_id, created_at);
--> statement-breakpoint
CREATE TRIGGER feedback_autowriter_verdicts_immutable
  BEFORE UPDATE OR DELETE ON feedback_autowriter_verdicts
  FOR EACH ROW EXECUTE FUNCTION feedback_autowriter_reject_mutation();
--> statement-breakpoint
-- One per posted class: review inclusion (drawn once, before any flag) and the current verdict.
CREATE TABLE feedback_autowriter_reviews (
  wise_session_id text PRIMARY KEY,
  first_post_id uuid NOT NULL UNIQUE REFERENCES feedback_autowriter_posts(id),
  tutor_key text NOT NULL,
  wise_teacher_user_id text,
  class_ended_at timestamptz,
  bangkok_date date NOT NULL,
  inclusion_reason text NOT NULL CHECK (inclusion_reason IN ('new_tutor','random_sample','not_sampled')),
  inclusion_probability numeric(4,3) NOT NULL CHECK (inclusion_probability >= 0 AND inclusion_probability <= 1),
  sample_draw double precision NOT NULL CHECK (sample_draw >= 0 AND sample_draw < 1),
  sampling_policy text NOT NULL,
  flagged_at timestamptz,
  flag_sources text[] NOT NULL DEFAULT '{}',
  current_verdict_id uuid REFERENCES feedback_autowriter_verdicts(id),
  reviewed_at timestamptz,
  measured_fix_count integer NOT NULL DEFAULT 0,
  corrections_verified integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX feedback_autowriter_reviews_date_idx ON feedback_autowriter_reviews (bangkok_date, tutor_key);
--> statement-breakpoint
CREATE FUNCTION feedback_autowriter_protect_review() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION '% is append-only', TG_TABLE_NAME USING ERRCODE = '55000';
  END IF;
  IF ROW(OLD.wise_session_id, OLD.first_post_id, OLD.tutor_key, OLD.bangkok_date, OLD.inclusion_reason,
         OLD.inclusion_probability, OLD.sample_draw, OLD.sampling_policy, OLD.created_at)
     IS DISTINCT FROM
     ROW(NEW.wise_session_id, NEW.first_post_id, NEW.tutor_key, NEW.bangkok_date, NEW.inclusion_reason,
         NEW.inclusion_probability, NEW.sample_draw, NEW.sampling_policy, NEW.created_at)
  THEN
    RAISE EXCEPTION 'review inclusion in % is set once', TG_TABLE_NAME USING ERRCODE = '55000';
  END IF;
  IF NEW.current_verdict_id IS NOT NULL AND NEW.current_verdict_id IS DISTINCT FROM OLD.current_verdict_id
     AND NOT EXISTS (SELECT 1 FROM feedback_autowriter_verdicts v
                     WHERE v.id = NEW.current_verdict_id AND v.wise_session_id = NEW.wise_session_id)
  THEN
    RAISE EXCEPTION 'current verdict belongs to another class' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER feedback_autowriter_reviews_protect
  BEFORE UPDATE OR DELETE ON feedback_autowriter_reviews
  FOR EACH ROW EXECUTE FUNCTION feedback_autowriter_protect_review();
--> statement-breakpoint
-- Reasons a post needs the owner's eyes (a measured fix, an unmatched API write, later: agent and owner flags).
CREATE TABLE feedback_autowriter_flags (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  wise_session_id text NOT NULL,
  source text NOT NULL CHECK (source IN ('measured_fix','agent','owner','api_unmatched','system')),
  suggested_severity text CHECK (suggested_severity IN ('cosmetic','factual','critical')),
  suggested_category text CHECK (suggested_category IN ('wrong_person','billing_status','invented_content','should_not_have_posted')),
  note text,
  created_by text NOT NULL,
  idempotency_key text NOT NULL UNIQUE,
  resolved_by_verdict_id uuid REFERENCES feedback_autowriter_verdicts(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX feedback_autowriter_flags_open_idx ON feedback_autowriter_flags (wise_session_id) WHERE resolved_by_verdict_id IS NULL;
--> statement-breakpoint
CREATE FUNCTION feedback_autowriter_protect_flag() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION '% is append-only', TG_TABLE_NAME USING ERRCODE = '55000';
  END IF;
  IF ROW(OLD.id, OLD.wise_session_id, OLD.source, OLD.suggested_severity, OLD.suggested_category, OLD.note,
         OLD.created_by, OLD.idempotency_key, OLD.created_at)
     IS DISTINCT FROM
     ROW(NEW.id, NEW.wise_session_id, NEW.source, NEW.suggested_severity, NEW.suggested_category, NEW.note,
         NEW.created_by, NEW.idempotency_key, NEW.created_at)
     OR (OLD.resolved_by_verdict_id IS NOT NULL AND NEW.resolved_by_verdict_id IS DISTINCT FROM OLD.resolved_by_verdict_id)
  THEN
    RAISE EXCEPTION 'flags in % are immutable once resolved', TG_TABLE_NAME USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER feedback_autowriter_flags_protect
  BEFORE UPDATE OR DELETE ON feedback_autowriter_flags
  FOR EACH ROW EXECUTE FUNCTION feedback_autowriter_protect_flag();
--> statement-breakpoint
-- Feedback saves on autowriter classes, derived from wise_activity_events (re-derivable, keyed by the Wise event).
CREATE TABLE feedback_autowriter_fix_events (
  wise_event_id text PRIMARY KEY,
  wise_activity_event_id uuid REFERENCES wise_activity_events(id) ON DELETE SET NULL,
  wise_session_id text NOT NULL,
  event_at timestamptz NOT NULL,
  actor_wise_user_id text,
  actor_role text,
  auto_submitted boolean,
  actor_kind text NOT NULL CHECK (actor_kind IN ('autowriter_first','autowriter_correction','api_actor_unmatched','owner_web','tutor','other_staff','student','auto')),
  post_id uuid REFERENCES feedback_autowriter_posts(id),
  counts_as_fix boolean NOT NULL,
  classifier_version integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX feedback_autowriter_fix_events_session_idx ON feedback_autowriter_fix_events (wise_session_id, event_at);
--> statement-breakpoint
-- Outbox of things a person must know; critical ones are pushed (email, optional LINE) and retried.
CREATE TABLE feedback_autowriter_incidents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  dedupe_key text NOT NULL UNIQUE,
  kind text NOT NULL CHECK (kind IN ('halt','correction_failed','critical_verdict','critical_flag','credit_entries_changed','api_actor_unmatched','first_shot_unverified','scan_failed')),
  severity text NOT NULL CHECK (severity IN ('critical','info')),
  wise_session_id text,
  summary text NOT NULL,
  detail jsonb NOT NULL DEFAULT '{}'::jsonb,
  push_status text NOT NULL CHECK (push_status IN ('pending','sent','failed','not_required')),
  push_attempts integer NOT NULL DEFAULT 0,
  pushed_channels text[] NOT NULL DEFAULT '{}',
  pushed_at timestamptz,
  last_push_error text,
  next_push_at timestamptz,
  acknowledged_at timestamptz,
  acknowledged_by text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (severity = 'critical' OR push_status = 'not_required')
);
--> statement-breakpoint
CREATE INDEX feedback_autowriter_incidents_pending_idx ON feedback_autowriter_incidents (next_push_at) WHERE push_status = 'pending';
--> statement-breakpoint
-- Per Bangkok date and tutor ('*' = all): a cache recomputed by the review job.
CREATE TABLE feedback_autowriter_daily_metrics (
  metric_date date NOT NULL,
  tutor_key text NOT NULL,
  live_mode boolean NOT NULL DEFAULT false,
  posted integer NOT NULL DEFAULT 0,
  required integer NOT NULL DEFAULT 0,
  reviewed integer NOT NULL DEFAULT 0,
  required_pending integer NOT NULL DEFAULT 0,
  accurate integer NOT NULL DEFAULT 0,
  cosmetic integer NOT NULL DEFAULT 0,
  factual integer NOT NULL DEFAULT 0,
  critical integer NOT NULL DEFAULT 0,
  eligible integer NOT NULL DEFAULT 0,
  excluded_scope integer NOT NULL DEFAULT 0,
  excluded_tutor_first integer NOT NULL DEFAULT 0,
  excluded_absent integer NOT NULL DEFAULT 0,
  excluded_tutor_off integer NOT NULL DEFAULT 0,
  pending integer NOT NULL DEFAULT 0,
  unseen integer NOT NULL DEFAULT 0,
  held integer NOT NULL DEFAULT 0,
  expired integer NOT NULL DEFAULT 0,
  failed integer NOT NULL DEFAULT 0,
  measured_fix_classes integer NOT NULL DEFAULT 0,
  corrections_verified integer NOT NULL DEFAULT 0,
  policy_version integer NOT NULL,
  computed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (metric_date, tutor_key)
);
--> statement-breakpoint
-- Expansion-gate evaluations, append-only; one 'daily' row per Bangkok date.
CREATE TABLE feedback_autowriter_gate_evaluations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  eval_kind text NOT NULL CHECK (eval_kind IN ('daily','on_demand','expansion_confirm')),
  bangkok_date date NOT NULL,
  window_start date NOT NULL,
  window_end date NOT NULL,
  roster_tutors text[] NOT NULL,
  reviewed integer NOT NULL,
  accurate integer NOT NULL,
  wilson_lower numeric(5,4) NOT NULL,
  critical integer NOT NULL,
  pending_critical_flags integer NOT NULL,
  pending_flagged_reviews integer NOT NULL,
  coverage_num integer NOT NULL,
  coverage_den integer NOT NULL,
  status text NOT NULL CHECK (status IN ('insufficient_data','below_head_start','head_start','pass','blocked_critical')),
  reasons text[] NOT NULL DEFAULT '{}',
  thresholds jsonb NOT NULL,
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX feedback_autowriter_gate_evaluations_daily_idx ON feedback_autowriter_gate_evaluations (bangkok_date) WHERE eval_kind = 'daily';
--> statement-breakpoint
CREATE TRIGGER feedback_autowriter_gate_evaluations_immutable
  BEFORE UPDATE OR DELETE ON feedback_autowriter_gate_evaluations
  FOR EACH ROW EXECUTE FUNCTION feedback_autowriter_reject_mutation();
--> statement-breakpoint
-- Run ledger of the hourly review job; the partial unique index makes it single-flight.
CREATE TABLE feedback_autowriter_review_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  status text NOT NULL DEFAULT 'running' CHECK (status IN ('running','succeeded','failed')),
  trigger_source text NOT NULL,
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  counts jsonb NOT NULL DEFAULT '{}'::jsonb,
  error_summary text
);
--> statement-breakpoint
CREATE UNIQUE INDEX feedback_autowriter_review_runs_single_running_idx ON feedback_autowriter_review_runs (status) WHERE status = 'running';
--> statement-breakpoint
CREATE INDEX feedback_autowriter_review_runs_started_idx ON feedback_autowriter_review_runs (started_at);
