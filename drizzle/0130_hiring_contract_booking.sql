ALTER TABLE hiring_bookings DROP CONSTRAINT hiring_bookings_kind_check;
--> statement-breakpoint
ALTER TABLE hiring_bookings ADD CONSTRAINT hiring_bookings_kind_check CHECK (kind IN ('paper', 'mock', 'call', 'contract'));
--> statement-breakpoint
ALTER TABLE hiring_bookings ADD CONSTRAINT hiring_contract_window CHECK (kind <> 'contract' OR (interviewer_key IS NOT NULL AND interviewer_key = 'hr-call' AND interviewer_email IS NOT NULL AND visit_id IS NULL AND end_time = start_time + interval '30 minutes'));
--> statement-breakpoint
CREATE UNIQUE INDEX hiring_one_contract_booking ON hiring_bookings (candidate_id) WHERE kind = 'contract' AND status = 'confirmed';
