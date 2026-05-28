CREATE TYPE "public"."line_contact_student_link_status" AS ENUM('suggested', 'verified', 'rejected');
--> statement-breakpoint
ALTER TABLE "line_messages" ADD COLUMN "classification_reviewed_category" "line_scheduler_classifier_category";
--> statement-breakpoint
ALTER TABLE "line_messages" ADD COLUMN "classification_reviewed_correct" boolean;
--> statement-breakpoint
ALTER TABLE "line_messages" ADD COLUMN "classification_reviewed_by_email" text;
--> statement-breakpoint
ALTER TABLE "line_messages" ADD COLUMN "classification_reviewed_by_name" text;
--> statement-breakpoint
ALTER TABLE "line_messages" ADD COLUMN "classification_reviewed_at" timestamp with time zone;
--> statement-breakpoint
CREATE TABLE "line_contact_student_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"contact_id" uuid NOT NULL,
	"wise_student_id" text NOT NULL,
	"student_key" text NOT NULL,
	"student_name" text NOT NULL,
	"parent_name" text DEFAULT '' NOT NULL,
	"status" "line_contact_student_link_status" DEFAULT 'suggested' NOT NULL,
	"confidence" double precision,
	"evidence" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"reviewed_by_email" text,
	"reviewed_by_name" text,
	"reviewed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "line_contact_student_links" ADD CONSTRAINT "line_contact_student_links_contact_id_line_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."line_contacts"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "line_scheduler_reviews" ADD COLUMN "reason_category" text;
--> statement-breakpoint
ALTER TABLE "line_scheduler_reviews" ADD COLUMN "selected_tutor_ids" jsonb DEFAULT '[]'::jsonb NOT NULL;
--> statement-breakpoint
ALTER TABLE "line_scheduler_reviews" ADD COLUMN "student_link_override" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
ALTER TABLE "line_scheduler_reviews" ADD COLUMN "verified_student_keys" jsonb DEFAULT '[]'::jsonb NOT NULL;
--> statement-breakpoint
CREATE INDEX "line_messages_classification_review_idx" ON "line_messages" USING btree ("classification_reviewed_category","classification_reviewed_at");
--> statement-breakpoint
CREATE UNIQUE INDEX "line_contact_student_links_contact_student_idx" ON "line_contact_student_links" USING btree ("contact_id","student_key");
--> statement-breakpoint
CREATE INDEX "line_contact_student_links_contact_status_idx" ON "line_contact_student_links" USING btree ("contact_id","status");
--> statement-breakpoint
CREATE INDEX "line_contact_student_links_student_key_idx" ON "line_contact_student_links" USING btree ("student_key");
