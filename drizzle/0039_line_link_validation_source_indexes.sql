ALTER TABLE "line_contact_student_links" ADD COLUMN "source_kind" text;
--> statement-breakpoint
ALTER TABLE "line_contact_student_links" ADD COLUMN "source_run_id" uuid;
--> statement-breakpoint
UPDATE "line_contact_student_links"
SET
  "source_kind" = NULLIF("evidence"->>'source', ''),
  "source_run_id" = CASE
    WHEN "evidence"->>'runId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
      THEN ("evidence"->>'runId')::uuid
    ELSE NULL
  END
WHERE "source_kind" IS NULL;
--> statement-breakpoint
CREATE INDEX "line_contact_student_links_source_run_status_sort_idx"
  ON "line_contact_student_links" USING btree ("source_run_id","status","parent_name","student_name","student_key")
  WHERE "source_kind" = 'line_oa_resolver';
--> statement-breakpoint
CREATE INDEX "line_contact_student_links_source_assignee_status_sort_idx"
  ON "line_contact_student_links" USING btree ("validation_assigned_to_email","status","source_run_id","parent_name","student_name","student_key")
  WHERE "source_kind" = 'line_oa_resolver';
--> statement-breakpoint
CREATE INDEX "line_contact_student_links_source_reviewed_idx"
  ON "line_contact_student_links" USING btree ("source_run_id","status","reviewed_at","updated_at")
  WHERE "source_kind" = 'line_oa_resolver' AND "status" IN ('verified', 'rejected');
