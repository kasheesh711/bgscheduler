ALTER TABLE "line_contact_student_links" ADD COLUMN "validation_assigned_to_email" text;
--> statement-breakpoint
ALTER TABLE "line_contact_student_links" ADD COLUMN "validation_assigned_to_name" text;
--> statement-breakpoint
ALTER TABLE "line_contact_student_links" ADD COLUMN "validation_assigned_run_id" uuid;
--> statement-breakpoint
ALTER TABLE "line_contact_student_links" ADD COLUMN "validation_assigned_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "line_contact_student_links" ADD COLUMN "validation_note" text;
--> statement-breakpoint
CREATE INDEX "line_contact_student_links_validation_assignee_idx" ON "line_contact_student_links" USING btree ("validation_assigned_to_email","status");
--> statement-breakpoint
CREATE INDEX "line_contact_student_links_validation_run_idx" ON "line_contact_student_links" USING btree ("validation_assigned_run_id","status");
