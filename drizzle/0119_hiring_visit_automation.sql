ALTER TABLE hiring_candidates DROP CONSTRAINT hiring_stage;
--> statement-breakpoint
ALTER TABLE hiring_candidates ADD CONSTRAINT hiring_stage CHECK (stage IN ('new','review','pre_screen','paper_invited','paper_booked','paper_passed','mock_booked','onsite_invited','onsite_booked','no_reply','no_booking','stopped'));
--> statement-breakpoint
ALTER TABLE hiring_bookings DROP CONSTRAINT hiring_mock_window;
--> statement-breakpoint
ALTER TABLE hiring_bookings ADD CONSTRAINT hiring_mock_window CHECK (kind<>'mock' OR (interviewer_key IS NOT NULL AND interviewer_email IS NOT NULL AND line_group_id IS NOT NULL AND jsonb_array_length(subjects)=1 AND end_time=start_time+interval '1 hour' AND (start_time AT TIME ZONE 'Asia/Bangkok')::date=(end_time AT TIME ZONE 'Asia/Bangkok')::date));
--> statement-breakpoint
ALTER TABLE hiring_bookings DROP CONSTRAINT hiring_bookings_status_check;
--> statement-breakpoint
ALTER TABLE hiring_bookings ADD CONSTRAINT hiring_bookings_status_check CHECK (status IN ('confirmed','cancelled','no_show'));
--> statement-breakpoint
ALTER TABLE hiring_bookings ADD COLUMN visit_id uuid, ADD COLUMN reschedule_of uuid REFERENCES hiring_bookings(id);
--> statement-breakpoint
CREATE INDEX hiring_booking_visit ON hiring_bookings(visit_id);
--> statement-breakpoint
ALTER TABLE hiring_candidates ADD COLUMN work_rights_answer text, ADD COLUMN visit_subject text, ADD COLUMN pre_screen_replied_at timestamptz, ADD COLUMN pre_screen_resubmitted boolean NOT NULL DEFAULT false, ADD COLUMN resume_path text, ADD COLUMN resume_name text, ADD COLUMN resume_type text, ADD COLUMN resume_sha256 text, ADD COLUMN resume_size integer, ADD COLUMN resume_stored_at timestamptz;
--> statement-breakpoint
UPDATE hiring_candidates SET work_rights_answer='I have permanent work rights with no restrictions' WHERE work_rights_confirmed IS TRUE;
