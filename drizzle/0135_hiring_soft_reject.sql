-- Soft reject (Kevin, 25 Nov 2026): a candidate under the pass score who was never emailed is set aside, not stuck.
-- They stay visible (hidden gems) and come back by a click or when a subject runs out of candidates at the pass score.
ALTER TABLE "hiring_candidates" DROP CONSTRAINT "hiring_stage";
--> statement-breakpoint
ALTER TABLE "hiring_candidates" ADD CONSTRAINT "hiring_stage" CHECK (stage IN ('new','review','pre_screen','paper_invited','paper_booked','paper_passed','mock_booked','onsite_invited','onsite_booked','no_reply','no_booking','stopped','hired','rejected','soft_rejected'));
--> statement-breakpoint
ALTER TABLE "hiring_candidates" ADD COLUMN "soft_rejected_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "hiring_candidates" ADD COLUMN "brought_back_at" timestamp with time zone;
