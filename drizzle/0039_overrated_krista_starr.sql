ALTER TABLE "progress_test_cycle_state" ADD COLUMN "schedule_method" text;--> statement-breakpoint
ALTER TABLE "progress_test_cycle_state" ADD COLUMN "booked_test_location" text;--> statement-breakpoint
ALTER TABLE "progress_test_cycle_state" ADD COLUMN "at_home_selected_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "progress_test_cycle_state" ADD COLUMN "at_home_submitted_at" timestamp with time zone;