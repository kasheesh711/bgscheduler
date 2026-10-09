-- Apply this additive control before the final transfer. Keep source data.
CREATE TABLE progress_transfer_control (
 id text PRIMARY KEY CHECK(id='writer'),
 phase text NOT NULL DEFAULT 'source' CHECK(phase IN ('source','paused','moved')),
 target_url text, receipt jsonb, updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO progress_transfer_control(id,phase) VALUES('writer','source');

-- Keep the source phase stable through each progress transaction.
CREATE FUNCTION progress_source_writer_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE state text;
BEGIN
 IF current_setting('progress.transfer_maintenance',true) IS DISTINCT FROM 'true' THEN
  SELECT phase INTO state FROM progress_transfer_control WHERE id='writer' FOR SHARE;
  IF state IS NULL OR state<>'source' THEN RAISE EXCEPTION 'Progress writes have a pause for transfer.' USING ERRCODE='55000'; END IF;
 END IF;
 IF TG_OP='DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
END $$;
REVOKE ALL ON FUNCTION progress_source_writer_guard() FROM PUBLIC;
CREATE TRIGGER progress_source_writer BEFORE INSERT OR UPDATE OR DELETE ON progress_test_attendance_ledger FOR EACH ROW EXECUTE FUNCTION progress_source_writer_guard();
CREATE TRIGGER progress_source_writer BEFORE INSERT OR UPDATE OR DELETE ON progress_test_cycle_state FOR EACH ROW EXECUTE FUNCTION progress_source_writer_guard();
CREATE TRIGGER progress_source_writer BEFORE INSERT OR UPDATE OR DELETE ON progress_test_bookings FOR EACH ROW EXECUTE FUNCTION progress_source_writer_guard();
CREATE TRIGGER progress_source_writer BEFORE INSERT OR UPDATE OR DELETE ON progress_test_email_runs FOR EACH ROW EXECUTE FUNCTION progress_source_writer_guard();
CREATE TRIGGER progress_source_writer BEFORE INSERT OR UPDATE OR DELETE ON progress_test_notifications FOR EACH ROW EXECUTE FUNCTION progress_source_writer_guard();
CREATE TRIGGER progress_source_writer BEFORE INSERT OR UPDATE OR DELETE ON progress_test_admin_digest_runs FOR EACH ROW EXECUTE FUNCTION progress_source_writer_guard();
CREATE TRIGGER progress_source_writer BEFORE INSERT OR UPDATE OR DELETE ON progress_test_admin_digest_recipients FOR EACH ROW EXECUTE FUNCTION progress_source_writer_guard();
CREATE TRIGGER progress_source_writer BEFORE INSERT OR UPDATE OR DELETE ON progress_test_sync_runs FOR EACH ROW EXECUTE FUNCTION progress_source_writer_guard();
CREATE TRIGGER progress_source_writer BEFORE INSERT OR UPDATE OR DELETE ON pt_workspace_config FOR EACH ROW EXECUTE FUNCTION progress_source_writer_guard();
CREATE TRIGGER progress_source_writer BEFORE INSERT OR UPDATE OR DELETE ON pt_series FOR EACH ROW EXECUTE FUNCTION progress_source_writer_guard();
CREATE TRIGGER progress_source_writer BEFORE INSERT OR UPDATE OR DELETE ON pt_files FOR EACH ROW EXECUTE FUNCTION progress_source_writer_guard();
CREATE TRIGGER progress_source_writer BEFORE INSERT OR UPDATE OR DELETE ON pt_papers FOR EACH ROW EXECUTE FUNCTION progress_source_writer_guard();
CREATE TRIGGER progress_source_writer BEFORE INSERT OR UPDATE OR DELETE ON pt_paper_versions FOR EACH ROW EXECUTE FUNCTION progress_source_writer_guard();
CREATE TRIGGER progress_source_writer BEFORE INSERT OR UPDATE OR DELETE ON pt_paper_artifacts FOR EACH ROW EXECUTE FUNCTION progress_source_writer_guard();
CREATE TRIGGER progress_source_writer BEFORE INSERT OR UPDATE OR DELETE ON pt_paper_approvals FOR EACH ROW EXECUTE FUNCTION progress_source_writer_guard();
CREATE TRIGGER progress_source_writer BEFORE INSERT OR UPDATE OR DELETE ON pt_rubric_approvals FOR EACH ROW EXECUTE FUNCTION progress_source_writer_guard();
CREATE TRIGGER progress_source_writer BEFORE INSERT OR UPDATE OR DELETE ON pt_assessments FOR EACH ROW EXECUTE FUNCTION progress_source_writer_guard();
CREATE TRIGGER progress_source_writer BEFORE INSERT OR UPDATE OR DELETE ON pt_submissions FOR EACH ROW EXECUTE FUNCTION progress_source_writer_guard();
CREATE TRIGGER progress_source_writer BEFORE INSERT OR UPDATE OR DELETE ON pt_reviews FOR EACH ROW EXECUTE FUNCTION progress_source_writer_guard();
CREATE TRIGGER progress_source_writer BEFORE INSERT OR UPDATE OR DELETE ON pt_jobs FOR EACH ROW EXECUTE FUNCTION progress_source_writer_guard();
CREATE TRIGGER progress_source_writer BEFORE INSERT OR UPDATE OR DELETE ON pt_artifacts FOR EACH ROW EXECUTE FUNCTION progress_source_writer_guard();
CREATE TRIGGER progress_source_writer BEFORE INSERT OR UPDATE OR DELETE ON pt_job_attempts FOR EACH ROW EXECUTE FUNCTION progress_source_writer_guard();
CREATE TRIGGER progress_source_writer BEFORE INSERT OR UPDATE OR DELETE ON pt_publications FOR EACH ROW EXECUTE FUNCTION progress_source_writer_guard();
CREATE TRIGGER progress_source_writer BEFORE INSERT OR UPDATE OR DELETE ON pt_attendance_evidence FOR EACH ROW EXECUTE FUNCTION progress_source_writer_guard();
CREATE TRIGGER progress_source_writer BEFORE INSERT OR UPDATE OR DELETE ON pt_workspace_settings FOR EACH ROW EXECUTE FUNCTION progress_source_writer_guard();
CREATE TRIGGER progress_source_writer BEFORE INSERT OR UPDATE OR DELETE ON pt_wise_destinations FOR EACH ROW EXECUTE FUNCTION progress_source_writer_guard();
CREATE TRIGGER progress_source_writer BEFORE INSERT OR UPDATE OR DELETE ON pt_publication_files FOR EACH ROW EXECUTE FUNCTION progress_source_writer_guard();
CREATE TRIGGER progress_source_writer BEFORE INSERT OR UPDATE OR DELETE ON pt_guide_progress FOR EACH ROW EXECUTE FUNCTION progress_source_writer_guard();
CREATE TRIGGER progress_source_writer BEFORE INSERT OR UPDATE OR DELETE ON pt_source_issues FOR EACH ROW EXECUTE FUNCTION progress_source_writer_guard();
CREATE TRIGGER progress_source_writer BEFORE INSERT OR UPDATE OR DELETE ON pt_preparation_publications FOR EACH ROW EXECUTE FUNCTION progress_source_writer_guard();
