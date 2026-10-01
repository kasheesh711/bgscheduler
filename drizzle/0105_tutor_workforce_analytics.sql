-- Durable history: source_snapshot_id is evidence, deliberately not a snapshot FK.
CREATE TABLE workforce_capture_runs (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), source_key text NOT NULL, kind text NOT NULL,
 source_snapshot_id text, observed_at timestamptz NOT NULL, complete boolean NOT NULL, coverage jsonb NOT NULL,
 CONSTRAINT workforce_capture_kind CHECK (kind in ('roster','history'))
);
CREATE UNIQUE INDEX workforce_capture_source_idx ON workforce_capture_runs(source_key);
CREATE INDEX workforce_capture_time_idx ON workforce_capture_runs(observed_at);
--> statement-breakpoint
CREATE TABLE workforce_person_versions (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), version_order bigserial NOT NULL,
 canonical_key text NOT NULL, content_hash text NOT NULL, observed_at timestamptz NOT NULL, payload jsonb NOT NULL
);
CREATE INDEX workforce_person_version_key_idx ON workforce_person_versions(canonical_key,observed_at);
--> statement-breakpoint
CREATE TABLE workforce_person_observations (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), run_id uuid NOT NULL REFERENCES workforce_capture_runs(id),
 canonical_key text NOT NULL, version_id uuid REFERENCES workforce_person_versions(id), observed_at timestamptz NOT NULL, quality jsonb NOT NULL
);
CREATE UNIQUE INDEX workforce_person_observation_run_idx ON workforce_person_observations(run_id,canonical_key);
CREATE INDEX workforce_person_observation_time_idx ON workforce_person_observations(canonical_key,observed_at);
--> statement-breakpoint
CREATE TABLE workforce_session_versions (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), version_order bigserial NOT NULL,
 wise_session_id text NOT NULL, content_hash text NOT NULL, observed_at timestamptz NOT NULL,
 start_at timestamptz NOT NULL, run_id uuid NOT NULL REFERENCES workforce_capture_runs(id), payload jsonb NOT NULL
);
CREATE INDEX workforce_session_version_key_idx ON workforce_session_versions(wise_session_id,observed_at);
CREATE INDEX workforce_session_version_start_idx ON workforce_session_versions(start_at);
--> statement-breakpoint
CREATE TABLE workforce_credit_versions (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), version_order bigserial NOT NULL,
 wise_session_id text NOT NULL, wise_student_id text NOT NULL, content_hash text NOT NULL,
 observed_at timestamptz NOT NULL, run_id uuid NOT NULL REFERENCES workforce_capture_runs(id), payload jsonb NOT NULL
);
CREATE INDEX workforce_credit_version_key_idx ON workforce_credit_versions(wise_session_id,wise_student_id,observed_at);
--> statement-breakpoint
CREATE TABLE workforce_subject_mappings (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), class_id text, source_value text NOT NULL,
 subject text NOT NULL, curriculum text, level text, revision integer NOT NULL,
 reviewed_by text, reviewed_at timestamptz, CONSTRAINT workforce_mapping_revision CHECK(revision>0)
);
CREATE INDEX workforce_subject_mapping_class_idx ON workforce_subject_mappings(class_id);
