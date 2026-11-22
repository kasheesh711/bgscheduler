-- R1: HR Interview is 30 minutes on Google Meet (Kevin, 22 Nov 2026). Calls booked before this change keep 15 minutes,
-- so both lengths are allowed.
ALTER TABLE "hiring_bookings" DROP CONSTRAINT "hiring_call_window";
--> statement-breakpoint
ALTER TABLE "hiring_bookings" ADD CONSTRAINT "hiring_call_window" CHECK (kind<>'call' OR (interviewer_key='hr-call' AND interviewer_email IS NOT NULL AND visit_id IS NULL AND end_time IN (start_time+interval '15 minutes', start_time+interval '30 minutes')));
