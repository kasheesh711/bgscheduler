CREATE TABLE feedback_atom_links (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), wise_student_id text NOT NULL, atom_student_id text NOT NULL,
 wise_name text NOT NULL, atom_name text NOT NULL, revision integer NOT NULL CHECK (revision > 0),
 active boolean NOT NULL DEFAULT true, approved_by text NOT NULL, approved_at timestamptz NOT NULL DEFAULT now(), note text NOT NULL
);
CREATE UNIQUE INDEX feedback_atom_link_revision_idx ON feedback_atom_links (wise_student_id, revision);
CREATE UNIQUE INDEX feedback_atom_link_wise_active_idx ON feedback_atom_links (wise_student_id) WHERE active;
CREATE UNIQUE INDEX feedback_atom_link_atom_active_idx ON feedback_atom_links (atom_student_id) WHERE active;
CREATE TABLE feedback_atom_sync_runs (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), status text NOT NULL DEFAULT 'running' CHECK (status IN ('running','succeeded','failed')),
 trigger_source text NOT NULL, started_at timestamptz NOT NULL DEFAULT now(), finished_at timestamptz,
 deployment_id text, counts jsonb NOT NULL DEFAULT '{}', error_code text
);
CREATE UNIQUE INDEX feedback_atom_single_sync_idx ON feedback_atom_sync_runs (status) WHERE status = 'running';
CREATE TABLE feedback_atom_snapshots (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), run_id uuid NOT NULL REFERENCES feedback_atom_sync_runs(id),
 atom_student_id text NOT NULL, source_hash text NOT NULL, schema_version integer NOT NULL DEFAULT 1,
 collected_at timestamptz NOT NULL DEFAULT now(), activities jsonb NOT NULL
);
CREATE INDEX feedback_atom_snapshot_student_idx ON feedback_atom_snapshots (atom_student_id, collected_at);
CREATE TABLE feedback_atom_timetables (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), run_id uuid NOT NULL REFERENCES feedback_atom_sync_runs(id),
 bangkok_date text NOT NULL, observed_at timestamptz NOT NULL DEFAULT now(), lessons jsonb NOT NULL
);
CREATE INDEX feedback_atom_timetable_date_idx ON feedback_atom_timetables (bangkok_date, observed_at);
CREATE TABLE feedback_iseb_evidence (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), wise_session_id text NOT NULL, evidence_hash text NOT NULL,
 atom jsonb, lesson_record text NOT NULL, evidence_kind text NOT NULL CHECK (evidence_kind IN ('summary','transcript')),
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX feedback_iseb_evidence_hash_idx ON feedback_iseb_evidence (wise_session_id, evidence_hash);
CREATE TABLE feedback_iseb_style_reviews (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), post_id uuid NOT NULL REFERENCES feedback_autowriter_posts(id),
 fields_sha256 text NOT NULL, status text NOT NULL CHECK (status IN ('passed','flagged','unavailable')),
 review_version integer NOT NULL DEFAULT 1, result jsonb NOT NULL, model text, cost_usd numeric(12,8),
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX feedback_iseb_style_post_idx ON feedback_iseb_style_reviews (post_id, created_at);
CREATE TABLE feedback_iseb_rollouts (
 id text PRIMARY KEY, approved_by text, approved_at timestamptz, comparison_hash text,
 cloud_proof_run_id uuid REFERENCES feedback_atom_sync_runs(id), unattended_confirmed_by text, activated_at timestamptz,
 receipt jsonb NOT NULL DEFAULT '{}'
);
CREATE FUNCTION feedback_iseb_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'ISEB evidence is immutable' USING ERRCODE = '55000'; END $$;
CREATE TRIGGER feedback_atom_snapshots_immutable BEFORE UPDATE OR DELETE ON feedback_atom_snapshots FOR EACH ROW EXECUTE FUNCTION feedback_iseb_immutable();
CREATE TRIGGER feedback_atom_timetables_immutable BEFORE UPDATE OR DELETE ON feedback_atom_timetables FOR EACH ROW EXECUTE FUNCTION feedback_iseb_immutable();
CREATE TRIGGER feedback_iseb_evidence_immutable BEFORE UPDATE OR DELETE ON feedback_iseb_evidence FOR EACH ROW EXECUTE FUNCTION feedback_iseb_immutable();
CREATE TRIGGER feedback_iseb_style_reviews_immutable BEFORE UPDATE OR DELETE ON feedback_iseb_style_reviews FOR EACH ROW EXECUTE FUNCTION feedback_iseb_immutable();
