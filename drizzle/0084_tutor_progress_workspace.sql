CREATE TABLE pt_workspace_config (id text PRIMARY KEY CHECK(id = 'launch'), activated_at timestamptz NOT NULL, activated_by text NOT NULL);
CREATE TABLE pt_series (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), owner_key text NOT NULL, wise_class_id text NOT NULL, wise_student_id text NOT NULL, student_name text NOT NULL, course_name text NOT NULL, tutor_name text NOT NULL, class_type text, count integer NOT NULL DEFAULT 0 CHECK(count >= 0), session_ids jsonb NOT NULL DEFAULT '[]', upcoming_sessions jsonb NOT NULL DEFAULT '[]', updated_at timestamptz NOT NULL DEFAULT now());
CREATE UNIQUE INDEX pt_series_owner_course_student_idx ON pt_series(owner_key,wise_class_id,wise_student_id);
CREATE TABLE pt_files (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), owner_key text NOT NULL, name text NOT NULL, mime text NOT NULL, size integer NOT NULL, page_count integer, pathname text NOT NULL, sha256 text, status text NOT NULL DEFAULT 'pending', purpose text NOT NULL, created_at timestamptz NOT NULL DEFAULT now());
CREATE UNIQUE INDEX pt_files_path_idx ON pt_files(pathname);
CREATE INDEX pt_files_owner_idx ON pt_files(owner_key);
CREATE TABLE pt_papers (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), owner_key text NOT NULL, title text NOT NULL, revision integer NOT NULL DEFAULT 0, created_at timestamptz NOT NULL DEFAULT now());
CREATE INDEX pt_papers_owner_idx ON pt_papers(owner_key);
CREATE TABLE pt_paper_versions (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), paper_id uuid NOT NULL REFERENCES pt_papers(id), revision integer NOT NULL, source_file_id uuid REFERENCES pt_files(id), key_file_id uuid REFERENCES pt_files(id), paper jsonb NOT NULL, approved boolean NOT NULL DEFAULT false, created_by text NOT NULL, model text, created_at timestamptz NOT NULL DEFAULT now());
CREATE UNIQUE INDEX pt_paper_version_idx ON pt_paper_versions(paper_id,revision);
CREATE TABLE pt_assessments (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), series_id uuid NOT NULL REFERENCES pt_series(id), cycle integer NOT NULL CHECK(cycle > 0), revision integer NOT NULL DEFAULT 0, preparation jsonb NOT NULL DEFAULT '{"paperVersionId":null,"topics":"","studentInformed":false}', notified_at timestamptz, notification_error text, current_submission_id uuid, current_review_id uuid, approved_review_id uuid, publication_status text NOT NULL DEFAULT 'not_ready', publication_error text, updated_at timestamptz NOT NULL DEFAULT now());
CREATE UNIQUE INDEX pt_assessment_series_cycle_idx ON pt_assessments(series_id,cycle);
CREATE TABLE pt_submissions (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), assessment_id uuid NOT NULL REFERENCES pt_assessments(id), data jsonb NOT NULL, created_by text NOT NULL, created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE pt_reviews (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), assessment_id uuid NOT NULL REFERENCES pt_assessments(id), data jsonb NOT NULL, approved boolean NOT NULL DEFAULT false, created_by text NOT NULL, created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE pt_jobs (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), owner_key text NOT NULL, kind text NOT NULL, target_id uuid NOT NULL, expected_revision integer NOT NULL, input jsonb NOT NULL DEFAULT '{}', result jsonb, status text NOT NULL DEFAULT 'queued', attempts integer NOT NULL DEFAULT 0, lease_token uuid, lease_until timestamptz, available_at timestamptz NOT NULL DEFAULT now(), error text, created_by text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), finished_at timestamptz);
CREATE INDEX pt_jobs_due_idx ON pt_jobs(status,available_at);
CREATE UNIQUE INDEX pt_jobs_active_target_idx ON pt_jobs(kind,target_id) WHERE status in ('queued','running');
CREATE TABLE pt_artifacts (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), review_id uuid NOT NULL REFERENCES pt_reviews(id), kind text NOT NULL, file_id uuid NOT NULL REFERENCES pt_files(id));
CREATE UNIQUE INDEX pt_artifact_review_kind_idx ON pt_artifacts(review_id,kind);
CREATE TABLE pt_publications (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), review_id uuid NOT NULL REFERENCES pt_reviews(id), status text NOT NULL, remote_ids jsonb NOT NULL DEFAULT '[]', error text, created_at timestamptz NOT NULL DEFAULT now());
CREATE UNIQUE INDEX pt_publication_review_idx ON pt_publications(review_id);

CREATE TABLE pt_attendance_evidence (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), wise_session_id text NOT NULL, wise_student_id text NOT NULL, content_hash text NOT NULL, data jsonb NOT NULL, observed_at timestamptz NOT NULL DEFAULT now());
CREATE UNIQUE INDEX pt_attendance_evidence_version_idx ON pt_attendance_evidence(wise_session_id,wise_student_id,content_hash);
CREATE TABLE pt_job_attempts (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), job_id uuid NOT NULL REFERENCES pt_jobs(id), attempt integer NOT NULL, model text, prompt text, input jsonb NOT NULL DEFAULT '{}', result jsonb, status text NOT NULL DEFAULT 'running', error text, started_at timestamptz NOT NULL DEFAULT now(), finished_at timestamptz);
CREATE UNIQUE INDEX pt_job_attempt_number_idx ON pt_job_attempts(job_id,attempt);

-- Review evidence and the launch instant are append-only. Corrections insert versions.
CREATE FUNCTION pt_reject_evidence_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Progress Test evidence is append-only; create a new version'; END;
$$;
CREATE TRIGGER pt_launch_immutable BEFORE UPDATE OR DELETE ON pt_workspace_config FOR EACH ROW EXECUTE FUNCTION pt_reject_evidence_mutation();
CREATE TRIGGER pt_paper_versions_immutable BEFORE UPDATE OR DELETE ON pt_paper_versions FOR EACH ROW EXECUTE FUNCTION pt_reject_evidence_mutation();
CREATE TRIGGER pt_submissions_immutable BEFORE UPDATE OR DELETE ON pt_submissions FOR EACH ROW EXECUTE FUNCTION pt_reject_evidence_mutation();
CREATE TRIGGER pt_reviews_immutable BEFORE UPDATE OR DELETE ON pt_reviews FOR EACH ROW EXECUTE FUNCTION pt_reject_evidence_mutation();
CREATE TRIGGER pt_attendance_evidence_immutable BEFORE UPDATE OR DELETE ON pt_attendance_evidence FOR EACH ROW EXECUTE FUNCTION pt_reject_evidence_mutation();
