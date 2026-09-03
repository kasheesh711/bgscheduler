CREATE TABLE "wise_teacher_availability_cache" (
	"teacher_user_id" text PRIMARY KEY NOT NULL,
	"far_leaves" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"far_horizon_days" integer NOT NULL,
	"far_window_start_day" integer NOT NULL,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL,
	"fetch_error" text
);
--> statement-breakpoint
ALTER TABLE "credit_control_packages" ADD COLUMN "credits_observed_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "tutor_identity_groups" ADD COLUMN "leaves_complete_through" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "wtac_fetched_at_idx" ON "wise_teacher_availability_cache" USING btree ("fetched_at");