-- The HR pre-screen call that a candidate books: a hiring_bookings row of kind 'call', and the phone number to call.
ALTER TABLE "hiring_candidates" ADD COLUMN IF NOT EXISTS "phone" text;
--> statement-breakpoint
ALTER TABLE "hiring_bookings" DROP CONSTRAINT "hiring_bookings_kind_check";
--> statement-breakpoint
ALTER TABLE "hiring_bookings" ADD CONSTRAINT "hiring_bookings_kind_check" CHECK (kind IN ('paper','mock','call'));
--> statement-breakpoint
-- One fixed interviewer key, so the existing overlap trigger (guard_hiring_booking) stops two candidates taking one slot.
ALTER TABLE "hiring_bookings" ADD CONSTRAINT "hiring_call_window" CHECK (kind<>'call' OR (interviewer_key='hr-call' AND interviewer_email IS NOT NULL AND visit_id IS NULL AND end_time=start_time+interval '15 minutes'));
