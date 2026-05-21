CREATE TABLE "tutor_business_profiles" (
	"canonical_key" text PRIMARY KEY NOT NULL,
	"display_name" text NOT NULL,
	"parent_safe_summary" text DEFAULT '' NOT NULL,
	"internal_notes" text DEFAULT '' NOT NULL,
	"education" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"languages" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"english_proficiency" text DEFAULT 'unknown' NOT NULL,
	"strength_tags" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"curriculum_experience" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"student_fit_notes" text DEFAULT '' NOT NULL,
	"do_not_use_for_notes" text DEFAULT '' NOT NULL,
	"verified_by" text,
	"last_reviewed_at" timestamp with time zone,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "tutor_business_profiles_display_name_idx" ON "tutor_business_profiles" USING btree ("display_name");--> statement-breakpoint
CREATE INDEX "tutor_business_profiles_active_idx" ON "tutor_business_profiles" USING btree ("active");