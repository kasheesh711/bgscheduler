ALTER TABLE pt_jobs ADD COLUMN stage text NOT NULL DEFAULT 'queued', ADD COLUMN stage_started_at timestamptz, ADD COLUMN checkpoint jsonb NOT NULL DEFAULT '{}', ADD COLUMN timings jsonb NOT NULL DEFAULT '{}';
ALTER TABLE pt_papers ADD COLUMN assessment_id uuid REFERENCES pt_assessments(id);
ALTER TABLE pt_files ADD COLUMN assessment_id uuid REFERENCES pt_assessments(id);
ALTER TABLE pt_paper_versions ADD COLUMN source_version_id uuid REFERENCES pt_paper_versions(id);
ALTER TABLE pt_workspace_settings ADD COLUMN formatting_enabled boolean NOT NULL DEFAULT true;
CREATE TABLE pt_rubric_approvals (version_id uuid PRIMARY KEY REFERENCES pt_paper_versions(id), created_by text NOT NULL, created_at timestamptz NOT NULL DEFAULT now());
INSERT INTO pt_rubric_approvals(version_id,created_by,created_at) SELECT id,created_by,created_at FROM pt_paper_versions WHERE approved;
CREATE TRIGGER pt_rubric_approvals_immutable BEFORE UPDATE OR DELETE ON pt_rubric_approvals FOR EACH ROW EXECUTE FUNCTION pt_reject_evidence_mutation();
CREATE TABLE pt_paper_artifacts (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), version_id uuid NOT NULL REFERENCES pt_paper_versions(id), kind text NOT NULL CHECK(kind IN ('paper','key')), file_id uuid NOT NULL REFERENCES pt_files(id), renderer_version text NOT NULL, created_at timestamptz NOT NULL DEFAULT now());
CREATE UNIQUE INDEX pt_paper_artifact_kind_idx ON pt_paper_artifacts(version_id,kind);
CREATE TABLE pt_paper_approvals (version_id uuid PRIMARY KEY REFERENCES pt_paper_versions(id), created_by text NOT NULL, created_at timestamptz NOT NULL DEFAULT now());
INSERT INTO pt_paper_approvals(version_id,created_by,created_at) SELECT id,created_by,created_at FROM pt_paper_versions WHERE approved;
-- Recover exact version bindings, independent of the mutable paper revision.
INSERT INTO pt_paper_artifacts(version_id,kind,file_id,renderer_version,created_at)
SELECT DISTINCT ON (v.id) v.id,'paper',f.id,'legacy-v1',coalesce(j.finished_at,j.created_at)
FROM pt_jobs j JOIN pt_paper_versions v ON v.id::text=j.input->>'versionId' AND v.paper_id=j.target_id
JOIN pt_files f ON f.id::text=j.result->>'fileId' AND f.owner_key=j.owner_key AND f.status='ready'
WHERE j.kind='render-paper' AND j.status IN ('completed','superseded')
ORDER BY v.id,j.created_at DESC ON CONFLICT DO NOTHING;
-- Legacy approval copied identical content to a new version. Preserve its PDF too.
INSERT INTO pt_paper_artifacts(version_id,kind,file_id,renderer_version,created_at)
SELECT DISTINCT ON (approved.id) approved.id,'paper',a.file_id,a.renderer_version,a.created_at
FROM pt_paper_versions approved JOIN pt_paper_versions draft ON draft.paper_id=approved.paper_id AND draft.revision<approved.revision AND draft.paper=approved.paper AND draft.source_file_id IS NOT DISTINCT FROM approved.source_file_id AND draft.key_file_id IS NOT DISTINCT FROM approved.key_file_id
JOIN pt_paper_artifacts a ON a.version_id=draft.id AND a.kind='paper'
WHERE approved.approved ORDER BY approved.id,draft.revision DESC ON CONFLICT DO NOTHING;
CREATE TRIGGER pt_paper_approvals_immutable BEFORE UPDATE OR DELETE ON pt_paper_approvals FOR EACH ROW EXECUTE FUNCTION pt_reject_evidence_mutation();
CREATE TRIGGER pt_paper_artifacts_immutable BEFORE UPDATE OR DELETE ON pt_paper_artifacts FOR EACH ROW EXECUTE FUNCTION pt_reject_evidence_mutation();
-- Frozen file metadata is part of every original and marked-review binding.
CREATE TRIGGER pt_ready_files_immutable BEFORE UPDATE OR DELETE ON pt_files FOR EACH ROW WHEN (OLD.status = 'ready') EXECUTE FUNCTION pt_reject_evidence_mutation();
