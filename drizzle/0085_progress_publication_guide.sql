CREATE TABLE pt_workspace_settings (
 id text PRIMARY KEY DEFAULT 'workspace', revision integer NOT NULL DEFAULT 0,
 publishing_enabled boolean NOT NULL DEFAULT false, verified_at timestamptz,
 updated_by text, updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO pt_workspace_settings (id) VALUES ('workspace');
CREATE TABLE pt_wise_destinations (
 wise_class_id text PRIMARY KEY, wise_student_id text NOT NULL,
 section_id text, status text NOT NULL DEFAULT 'new', updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE pt_publications ADD COLUMN version integer NOT NULL DEFAULT 1;
ALTER TABLE pt_publications ADD COLUMN section_id text;
ALTER TABLE pt_publications ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now();
CREATE TABLE pt_publication_files (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), publication_id uuid NOT NULL REFERENCES pt_publications(id),
 kind text NOT NULL CHECK (kind IN ('graded','report')), file_id uuid NOT NULL REFERENCES pt_files(id),
 name text NOT NULL, sha256 text NOT NULL, status text NOT NULL DEFAULT 'pending',
 resource_id text, wise_file_id text, attempts integer NOT NULL DEFAULT 0,
 error text, verified_at timestamptz, updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(publication_id,kind), UNIQUE(name)
);
CREATE TABLE pt_guide_progress (
 email text NOT NULL, guide_version integer NOT NULL, status text NOT NULL CHECK (status IN ('new','started','skipped','completed')),
 step integer NOT NULL DEFAULT 0 CHECK (step BETWEEN 0 AND 8), revision integer NOT NULL DEFAULT 0,
 updated_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(email,guide_version)
);
CREATE TABLE pt_source_issues (
 source_key text PRIMARY KEY, student_name text NOT NULL, course_name text NOT NULL,
 reason text NOT NULL, observed_at timestamptz NOT NULL DEFAULT now()
);
