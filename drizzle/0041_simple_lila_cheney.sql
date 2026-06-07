CREATE TABLE "credit_control_zero_balance_tracking" (
	"student_key" text PRIMARY KEY NOT NULL,
	"student_name" text NOT NULL,
	"parent_name" text NOT NULL,
	"zero_since" timestamp with time zone DEFAULT now() NOT NULL,
	"last_remaining" double precision DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "credit_control_inactive_students" ADD COLUMN "source" text DEFAULT 'manual' NOT NULL;--> statement-breakpoint
ALTER TABLE "credit_control_inactive_students" ADD COLUMN "removed_at_remaining" double precision;