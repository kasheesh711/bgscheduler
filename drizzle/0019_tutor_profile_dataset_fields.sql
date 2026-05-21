ALTER TABLE "tutor_business_profiles" ADD COLUMN "young_learner_fit" text DEFAULT 'unknown' NOT NULL;--> statement-breakpoint
ALTER TABLE "tutor_business_profiles" ADD COLUMN "youngest_comfortable_age" integer;--> statement-breakpoint
ALTER TABLE "tutor_business_profiles" ADD COLUMN "young_learner_notes" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "tutor_business_profiles" ADD COLUMN "teaching_style_tags" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "tutor_business_profiles" ADD COLUMN "teaching_style_notes" text DEFAULT '' NOT NULL;
