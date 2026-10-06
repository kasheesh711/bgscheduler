ALTER TABLE class_capture_assets ADD COLUMN transcript_segments jsonb;
ALTER TABLE class_capture_assets ADD COLUMN photo_findings jsonb;
ALTER TABLE class_capture_assets ADD COLUMN analysis_attempted_at timestamptz;
ALTER TABLE class_capture_assets ADD COLUMN analysis_uncertain boolean NOT NULL DEFAULT false;
--> statement-breakpoint
CREATE TABLE class_capture_jobs (
 capture_id uuid PRIMARY KEY REFERENCES class_captures(id) ON DELETE CASCADE,
 consented_at timestamptz NOT NULL DEFAULT now(), authorized_admin_version integer,
 revision integer NOT NULL DEFAULT 0, completed_revision integer NOT NULL DEFAULT -1,
 status text NOT NULL DEFAULT 'waiting' CHECK (status IN ('waiting','processing','writing','ready','attention')),
 draft_uncertain boolean NOT NULL DEFAULT false, settle_until timestamptz NOT NULL DEFAULT now(),
 recording boolean NOT NULL DEFAULT false, expected_uploads jsonb NOT NULL DEFAULT '[]'::jsonb,
 due_at timestamptz NOT NULL DEFAULT now(), lease_until timestamptz, attempts integer NOT NULL DEFAULT 0,
 error text, proposal jsonb, evidence jsonb, updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX class_capture_jobs_due_idx ON class_capture_jobs(due_at);
