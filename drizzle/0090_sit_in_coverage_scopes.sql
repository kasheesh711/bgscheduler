ALTER TABLE "tutor_sit_in_assignments" DROP CONSTRAINT "sit_in_assignment_status";--> statement-breakpoint
ALTER TABLE "tutor_sit_in_assignments" DROP CONSTRAINT "sit_in_department_check";--> statement-breakpoint
DROP INDEX "sit_in_quarter_tutor_department";--> statement-breakpoint
ALTER TABLE "future_session_blocks" ADD COLUMN "student_ids" jsonb;--> statement-breakpoint
ALTER TABLE "tutor_sit_in_assignments" ADD COLUMN "coverage_scope" text;--> statement-breakpoint
ALTER TABLE "tutor_sit_in_assignments" ADD COLUMN "allocation_mode" text DEFAULT 'automatic' NOT NULL;--> statement-breakpoint
ALTER TABLE "tutor_sit_in_assignments" ADD COLUMN "readiness_issues" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "tutor_sit_in_grants" ADD COLUMN "scopes" jsonb;--> statement-breakpoint
ALTER TABLE "tutor_sit_in_mappings" ADD COLUMN "scopes" jsonb;--> statement-breakpoint
CREATE UNIQUE INDEX "sit_in_quarter_tutor_scope" ON "tutor_sit_in_assignments" USING btree ("quarter","canonical_key",coalesce("coverage_scope", case when "department" = 'iseb' then 'iseb_other' else "department" end)) WHERE "tutor_sit_in_assignments"."status" <> 'superseded';--> statement-breakpoint
ALTER TABLE "tutor_sit_in_assignments" ADD CONSTRAINT "sit_in_scope_check" CHECK ("tutor_sit_in_assignments"."coverage_scope" IS NULL OR ("tutor_sit_in_assignments"."department" <> 'iseb' AND "tutor_sit_in_assignments"."coverage_scope" = "tutor_sit_in_assignments"."department") OR ("tutor_sit_in_assignments"."department" = 'iseb' AND "tutor_sit_in_assignments"."coverage_scope" IN ('iseb_english_vr','iseb_maths_vr','iseb_other')));--> statement-breakpoint
ALTER TABLE "tutor_sit_in_assignments" ADD CONSTRAINT "sit_in_allocation_mode" CHECK ("tutor_sit_in_assignments"."allocation_mode" IN ('automatic','manual'));--> statement-breakpoint
ALTER TABLE "tutor_sit_in_assignments" ADD CONSTRAINT "sit_in_assignment_status" CHECK ("tutor_sit_in_assignments"."status" in ('pending','scheduled','needs_rescheduling','completed','exempt','superseded'));--> statement-breakpoint
ALTER TABLE "tutor_sit_in_assignments" ADD CONSTRAINT "sit_in_department_check" CHECK ("tutor_sit_in_assignments"."department" IN ('physics','maths','english','chemistry','iseb','science'));
--> statement-breakpoint
-- Backfill legacy rows without widening the old ISEB grant to new strands.
UPDATE tutor_sit_in_assignments SET coverage_scope = CASE WHEN department = 'iseb' THEN 'iseb_other' ELSE department END;
--> statement-breakpoint
UPDATE tutor_sit_in_assignments a SET allocation_mode = 'manual'
WHERE reason IS NOT NULL OR EXISTS (SELECT 1 FROM tutor_sit_in_audit e WHERE e.entity_id = a.id::text AND e.action IN ('assignment_added','reassign'));
--> statement-breakpoint
UPDATE tutor_sit_in_grants g SET scopes = (SELECT coalesce(jsonb_agg(CASE WHEN d = 'iseb' THEN 'iseb_other' ELSE d END), '[]'::jsonb) FROM jsonb_array_elements_text(g.departments) AS d);
--> statement-breakpoint
UPDATE tutor_sit_in_mappings m SET scopes = (SELECT coalesce(jsonb_agg(CASE WHEN d = 'iseb' THEN 'iseb_other' ELSE d END), '[]'::jsonb) FROM jsonb_array_elements_text(m.departments) AS d);
--> statement-breakpoint
-- Only extend untouched initial grants. Explicit edits, account disables and
-- feature revocations remain authoritative and are never reversed by a deploy.
WITH ownership(email, departments, scopes) AS (VALUES
 ('apivit.s@hotmail.com', '["physics","science"]'::jsonb, '["physics","science"]'::jsonb),
 ('kasidej.ju@gmail.com', '["maths","science","iseb"]'::jsonb, '["maths","science","iseb_maths_vr"]'::jsonb),
 ('drxiox@gmail.com', '["english","iseb"]'::jsonb, '["english","iseb_english_vr"]'::jsonb),
 ('miieiiem@gmail.com', '["chemistry","science"]'::jsonb, '["chemistry","science"]'::jsonb),
 ('gift.m@begiftededucation.com', '["iseb"]'::jsonb, '["iseb_other"]'::jsonb)
), updated AS (
 UPDATE tutor_sit_in_grants g SET departments = o.departments, scopes = o.scopes, revision = g.revision + 1, updated_at = now()
 FROM ownership o WHERE g.email = o.email AND g.active AND g.role = 'observer' AND g.revision = 0
 AND NOT EXISTS (SELECT 1 FROM admin_users a WHERE lower(btrim(a.email)) = g.email AND a.disabled)
 RETURNING g.email, g.scopes
)
INSERT INTO tutor_sit_in_audit(actor, action, entity_id, detail)
SELECT 'migration:0090', 'coverage_grant_initialized', email, jsonb_build_object('scopes', scopes, 'reason', 'Approved ISEB strand and shared Science ownership') FROM updated;
