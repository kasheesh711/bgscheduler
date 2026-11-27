ALTER TABLE hiring_candidates ADD COLUMN paper_waiver jsonb;
--> statement-breakpoint
ALTER TABLE hiring_candidates DROP CONSTRAINT hiring_stage;
--> statement-breakpoint
ALTER TABLE hiring_candidates ADD CONSTRAINT hiring_stage CHECK (stage IN ('new','review','pre_screen','paper_invited','paper_booked','paper_passed','mock_invited','mock_booked','onsite_invited','onsite_booked','no_reply','no_booking','stopped','hired','rejected','soft_rejected'));
--> statement-breakpoint
CREATE TABLE hiring_stage_entries (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  candidate_id uuid NOT NULL REFERENCES hiring_candidates(id) ON DELETE CASCADE,
  stage text NOT NULL,
  entered_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX hiring_stage_entries_candidate ON hiring_stage_entries(candidate_id, entered_at);
--> statement-breakpoint
CREATE FUNCTION hiring_record_funnel_stage() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' OR OLD.stage IS DISTINCT FROM NEW.stage THEN
    INSERT INTO hiring_stage_entries (candidate_id, stage) VALUES (NEW.id, NEW.stage);
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER hiring_funnel_stage AFTER INSERT OR UPDATE OF stage ON hiring_candidates
  FOR EACH ROW EXECUTE FUNCTION hiring_record_funnel_stage();
