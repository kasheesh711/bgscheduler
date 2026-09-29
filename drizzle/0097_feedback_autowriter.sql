CREATE TABLE feedback_autowriter_control (
  id text PRIMARY KEY DEFAULT 'default' CHECK (id = 'default'),
  mode text NOT NULL DEFAULT 'shadow' CHECK (mode IN ('off','shadow','live')),
  disabled_tutors jsonb NOT NULL DEFAULT '[]'::jsonb,
  halted_at timestamptz,
  halt_reason text,
  lease_token uuid,
  lease_until timestamptz,
  updated_by text,
  updated_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
INSERT INTO feedback_autowriter_control (id, mode) VALUES ('default', 'shadow') ON CONFLICT (id) DO NOTHING;
--> statement-breakpoint
CREATE TABLE feedback_autowriter_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  wise_session_id text NOT NULL,
  wise_class_id text,
  wise_teacher_user_id text,
  scheduled_end_at timestamptz,
  deadline_at timestamptz,
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','generating','would_submit','posting','awaiting_event','verified','held','skipped_human','skipped_scope','expired','rejected','unknown_outcome','verify_failed')),
  reason text,
  attempts integer NOT NULL DEFAULT 0,
  retry_count integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz,
  lease_token uuid,
  lease_until timestamptz,
  arm text CHECK (arm IS NULL OR arm IN ('glm','luna')),
  fields jsonb,
  fields_sha256 text,
  billing jsonb,
  body_hash text,
  post_started_at timestamptz,
  verified_event jsonb,
  alerts_sent jsonb NOT NULL DEFAULT '{}'::jsonb,
  last_trigger text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX feedback_autowriter_sessions_wise_session_idx ON feedback_autowriter_sessions(wise_session_id);
CREATE INDEX feedback_autowriter_sessions_state_idx ON feedback_autowriter_sessions(state, next_attempt_at);
-- At most one feedback POST in flight institution-wide: a second claim waits until the
-- first POST's outcome is known (or reconciled), so a halt always lands before the next POST.
CREATE UNIQUE INDEX feedback_autowriter_sessions_single_posting_idx ON feedback_autowriter_sessions(state) WHERE state = 'posting';
--> statement-breakpoint
CREATE TABLE feedback_autowriter_calls (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  wise_session_id text NOT NULL,
  role text NOT NULL CHECK (role IN ('writer','judge')),
  arm text NOT NULL CHECK (arm IN ('glm','luna')),
  requested_model text NOT NULL,
  resolved_model text,
  provider text,
  ok boolean NOT NULL,
  error text,
  finish_reason text,
  prompt_tokens integer,
  completion_tokens integer,
  reasoning_tokens integer,
  cached_tokens integer,
  cost_usd numeric(12,8),
  latency_ms integer,
  result jsonb,
  prompt_version integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX feedback_autowriter_calls_session_idx ON feedback_autowriter_calls(wise_session_id, created_at);
CREATE INDEX feedback_autowriter_calls_created_idx ON feedback_autowriter_calls(created_at);
--> statement-breakpoint
CREATE TABLE wise_webhook_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  dedupe_key text NOT NULL,
  event_name text,
  wise_session_id text,
  payload jsonb NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz,
  outcome text
);
--> statement-breakpoint
CREATE UNIQUE INDEX wise_webhook_events_dedupe_idx ON wise_webhook_events(dedupe_key);
CREATE INDEX wise_webhook_events_session_idx ON wise_webhook_events(wise_session_id, received_at);
