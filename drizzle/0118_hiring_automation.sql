CREATE TABLE hiring_settings (id text PRIMARY KEY DEFAULT 'default', config jsonb NOT NULL, revision integer NOT NULL DEFAULT 0, updated_by text NOT NULL, updated_at timestamptz NOT NULL DEFAULT now(), worker_at timestamptz, worker_summary jsonb, worker_error text);
--> statement-breakpoint
CREATE TABLE hiring_candidates (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), seek_application_id text UNIQUE, source_ids jsonb NOT NULL DEFAULT '[]', applicant_id text UNIQUE, tracker_hash text, name text NOT NULL, email text UNIQUE,
 stage text NOT NULL DEFAULT 'new', previously_contacted boolean NOT NULL DEFAULT false, work_rights_confirmed boolean, profile_text text NOT NULL DEFAULT '', profile_hash text, profile_assessment jsonb, university_assessment jsonb,
 pre_screen jsonb, pre_screen_hash text, pre_screen_assessment jsonb, subjects jsonb NOT NULL DEFAULT '[]', paper_passed_subjects jsonb NOT NULL DEFAULT '[]',
 paper_passed_at timestamptz, paper_recorded_by text, invite_expires_at timestamptz, review_note text, revision integer NOT NULL DEFAULT 0, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 CONSTRAINT hiring_stage CHECK (stage IN ('new','review','pre_screen','paper_invited','paper_booked','paper_passed','mock_booked','stopped'))
);
--> statement-breakpoint
CREATE TABLE hiring_bookings (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), candidate_id uuid NOT NULL REFERENCES hiring_candidates(id), kind text NOT NULL CHECK (kind IN ('paper','mock')), subjects jsonb NOT NULL,
 interviewer_key text, interviewer_email text, line_group_id text, calendar_owner text NOT NULL, start_time timestamptz NOT NULL, end_time timestamptz NOT NULL,
 status text NOT NULL DEFAULT 'confirmed' CHECK (status IN ('confirmed','cancelled')), evidence jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
 CONSTRAINT hiring_booking_time_order CHECK (end_time>start_time),
 CONSTRAINT hiring_subject_count CHECK (jsonb_typeof(subjects)='array' AND jsonb_array_length(subjects) BETWEEN 1 AND 5),
 CONSTRAINT hiring_mock_window CHECK (kind<>'mock' OR (interviewer_key IS NOT NULL AND interviewer_email IS NOT NULL AND line_group_id IS NOT NULL AND jsonb_array_length(subjects)=1 AND end_time=start_time+interval '1 hour' AND (start_time AT TIME ZONE 'Asia/Bangkok')::date=(end_time AT TIME ZONE 'Asia/Bangkok')::date AND extract(isodow FROM start_time AT TIME ZONE 'Asia/Bangkok') BETWEEN 1 AND 5 AND (start_time AT TIME ZONE 'Asia/Bangkok')::time>='10:00'::time AND (end_time AT TIME ZONE 'Asia/Bangkok')::time<='16:00'::time))
);
--> statement-breakpoint
CREATE INDEX hiring_booking_time ON hiring_bookings(interviewer_key,start_time);
--> statement-breakpoint
CREATE TABLE hiring_outbox (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), key text NOT NULL UNIQUE, candidate_id uuid NOT NULL REFERENCES hiring_candidates(id), booking_id uuid REFERENCES hiring_bookings(id), kind text NOT NULL,
 payload jsonb NOT NULL, status text NOT NULL DEFAULT 'pending', attempts integer NOT NULL DEFAULT 0, first_attempt_at timestamptz, lease_until timestamptz, next_attempt_at timestamptz,
 receipt jsonb, error text, created_at timestamptz NOT NULL DEFAULT now(), sent_at timestamptz,
 CONSTRAINT hiring_outbox_status CHECK (status IN ('pending','processing','sent','failed','uncertain','cancelled')),
 CONSTRAINT hiring_outbox_kind CHECK (kind IN ('email','line','calendar','calendar_cancel'))
);
--> statement-breakpoint
CREATE INDEX hiring_outbox_work ON hiring_outbox(status,next_attempt_at);
--> statement-breakpoint
CREATE TABLE hiring_audit (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), candidate_id uuid REFERENCES hiring_candidates(id), actor text NOT NULL, action text NOT NULL, detail jsonb NOT NULL DEFAULT '{}', created_at timestamptz NOT NULL DEFAULT now());
--> statement-breakpoint
CREATE FUNCTION guard_hiring_booking() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.status='confirmed' THEN
  PERFORM pg_advisory_xact_lock(hashtextextended('hiring-candidate:' || NEW.candidate_id,0));
  IF EXISTS (SELECT 1 FROM hiring_bookings b WHERE b.id<>NEW.id AND b.status='confirmed' AND b.candidate_id=NEW.candidate_id AND b.start_time<NEW.end_time AND NEW.start_time<b.end_time) THEN
   RAISE EXCEPTION 'The candidate is already booked' USING ERRCODE='23P01';
  END IF;
 END IF;
 IF NEW.status='confirmed' AND NEW.interviewer_key IS NOT NULL THEN
  PERFORM pg_advisory_xact_lock(hashtextextended('sit-in:' || NEW.interviewer_key,0));
  IF EXISTS (SELECT 1 FROM hiring_bookings b WHERE b.id<>NEW.id AND b.status='confirmed' AND b.interviewer_key=NEW.interviewer_key AND b.start_time<NEW.end_time AND NEW.start_time<b.end_time)
   OR EXISTS (SELECT 1 FROM tutor_sit_in_observations o WHERE o.observer_canonical_key=NEW.interviewer_key AND o.current AND o.start_time<NEW.end_time AND NEW.start_time<o.end_time) THEN
   RAISE EXCEPTION 'The interviewer is already booked' USING ERRCODE='23P01';
  END IF;
 END IF;
 RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER hiring_booking_guard BEFORE INSERT OR UPDATE ON hiring_bookings FOR EACH ROW EXECUTE FUNCTION guard_hiring_booking();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION sit_in_protect_booking() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.current THEN
  PERFORM pg_advisory_xact_lock(hashtextextended('sit-in:' || NEW.observer_canonical_key,0));
  IF EXISTS (SELECT 1 FROM tutor_sit_in_assignments WHERE id=NEW.assignment_id AND canonical_key=NEW.observer_canonical_key) THEN
   RAISE EXCEPTION 'Self-observation is prohibited' USING ERRCODE='23514';
  END IF;
  IF EXISTS (SELECT 1 FROM tutor_sit_in_observations o WHERE o.current AND o.id<>NEW.id AND o.observer_canonical_key=NEW.observer_canonical_key AND o.start_time<NEW.end_time AND NEW.start_time<o.end_time)
   OR EXISTS (SELECT 1 FROM hiring_bookings b WHERE b.status='confirmed' AND b.interviewer_key=NEW.observer_canonical_key AND b.start_time<NEW.end_time AND NEW.start_time<b.end_time) THEN
   RAISE EXCEPTION 'Observer already booked' USING ERRCODE='23514';
  END IF;
 END IF;
 RETURN NEW;
END $$;
