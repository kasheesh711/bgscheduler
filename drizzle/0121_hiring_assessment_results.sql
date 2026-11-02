ALTER TABLE hiring_candidates DROP CONSTRAINT hiring_stage;
--> statement-breakpoint
ALTER TABLE hiring_candidates ADD CONSTRAINT hiring_stage CHECK (stage IN ('new','review','pre_screen','paper_invited','paper_booked','paper_passed','mock_booked','onsite_invited','onsite_booked','no_reply','no_booking','stopped','hired','rejected'));
--> statement-breakpoint
CREATE TABLE hiring_assessment_files (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind text NOT NULL CHECK (kind IN ('question_paper','mark_scheme','paper_scan','mock_rubric')),
  candidate_id uuid REFERENCES hiring_candidates(id) ON DELETE CASCADE,
  subject text,
  name text NOT NULL,
  path text NOT NULL UNIQUE,
  size integer NOT NULL,
  sha256 text,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','ready')),
  active boolean NOT NULL DEFAULT false,
  uploaded_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT hiring_file_owner CHECK ((kind IN ('question_paper','mark_scheme') AND candidate_id IS NULL AND subject IS NOT NULL) OR (kind IN ('paper_scan','mock_rubric') AND candidate_id IS NOT NULL))
);
--> statement-breakpoint
CREATE UNIQUE INDEX hiring_file_one_active ON hiring_assessment_files (subject, kind) WHERE active;
--> statement-breakpoint
CREATE TABLE hiring_paper_results (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  candidate_id uuid NOT NULL REFERENCES hiring_candidates(id) ON DELETE CASCADE,
  booking_id uuid REFERENCES hiring_bookings(id) ON DELETE SET NULL,
  subject text NOT NULL,
  source text NOT NULL CHECK (source IN ('ai','person','tracker')),
  status text NOT NULL CHECK (status IN ('uploaded','marking','done','needs_check','failed')),
  file_id uuid REFERENCES hiring_assessment_files(id) ON DELETE SET NULL,
  ai_marks jsonb,
  marks jsonb,
  mark_scheme_used boolean,
  history jsonb,
  model text,
  prompt_version text,
  cost_usd double precision,
  cost_known boolean NOT NULL DEFAULT true,
  error text,
  checked_by text,
  checked_at timestamptz,
  changed_by text,
  changed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT hiring_paper_one_subject UNIQUE (candidate_id, subject)
);
--> statement-breakpoint
CREATE TABLE hiring_mock_results (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  candidate_id uuid NOT NULL REFERENCES hiring_candidates(id) ON DELETE CASCADE,
  booking_id uuid REFERENCES hiring_bookings(id) ON DELETE SET NULL,
  subject text NOT NULL,
  source text NOT NULL CHECK (source IN ('ai','person','tracker')),
  status text NOT NULL CHECK (status IN ('uploaded','marking','done','needs_check','failed')),
  file_id uuid REFERENCES hiring_assessment_files(id) ON DELETE SET NULL,
  ai_rubric jsonb,
  rubric jsonb,
  history jsonb,
  model text,
  prompt_version text,
  cost_usd double precision,
  cost_known boolean NOT NULL DEFAULT true,
  error text,
  checked_by text,
  checked_at timestamptz,
  changed_by text,
  changed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT hiring_mock_one_subject UNIQUE (candidate_id, subject)
);
--> statement-breakpoint
CREATE TABLE hiring_decisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  candidate_id uuid NOT NULL REFERENCES hiring_candidates(id) ON DELETE CASCADE,
  decision text NOT NULL CHECK (decision IN ('hire','reject')),
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','sent','replaced')),
  reason text NOT NULL,
  email_subject text NOT NULL,
  email_body text NOT NULL,
  outbox_key text,
  decided_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  sent_at timestamptz
);
--> statement-breakpoint
CREATE UNIQUE INDEX hiring_decision_one_draft ON hiring_decisions (candidate_id) WHERE status = 'draft';
