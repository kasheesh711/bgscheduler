CREATE TABLE hiring_onboarding (
  candidate_id uuid PRIMARY KEY REFERENCES hiring_candidates(id) ON DELETE CASCADE,
  decision_id uuid NOT NULL REFERENCES hiring_decisions(id) ON DELETE CASCADE,
  intake jsonb NOT NULL,
  submitted_at timestamptz NOT NULL DEFAULT now(),
  line_user_id text UNIQUE,
  line_name text,
  signed_at timestamptz,
  invited_at timestamptz,
  joined_at timestamptz,
  tutor_key text UNIQUE REFERENCES tutor_contacts(canonical_key),
  tutor_group_ready_at timestamptz
);
--> statement-breakpoint
CREATE TABLE experts_baselines (
  group_id text PRIMARY KEY,
  tutor_bot boolean NOT NULL,
  app_count integer NOT NULL,
  captured_at timestamptz NOT NULL,
  captured_by text NOT NULL
);
--> statement-breakpoint
CREATE TABLE experts_members (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  group_id text NOT NULL REFERENCES experts_baselines(group_id),
  line_user_id text,
  label text,
  source text NOT NULL,
  approved_at timestamptz NOT NULL,
  approved_by text NOT NULL,
  revoked_at timestamptz,
  CONSTRAINT experts_members_group_user_unique UNIQUE (group_id, line_user_id)
);
--> statement-breakpoint
CREATE TABLE experts_cases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  group_id text NOT NULL REFERENCES experts_baselines(group_id),
  event_key text NOT NULL UNIQUE,
  line_user_id text,
  reason text NOT NULL,
  occurred_at timestamptz NOT NULL,
  resolved_at timestamptz,
  resolved_by text,
  resolution text,
  alert_status text NOT NULL DEFAULT 'pending',
  alert_attempt_at timestamptz
);
--> statement-breakpoint
CREATE UNIQUE INDEX experts_cases_one_open_user ON experts_cases (group_id, line_user_id) WHERE resolved_at IS NULL;
--> statement-breakpoint
CREATE INDEX experts_cases_pending_alert ON experts_cases (group_id, occurred_at) WHERE resolved_at IS NULL AND alert_status = 'pending';
--> statement-breakpoint
ALTER TABLE progress_line_groups ADD COLUMN tutor_bot boolean;
