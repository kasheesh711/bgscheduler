ALTER TABLE "classroom_assignment_rows" ADD COLUMN "canonical_key" text;
--> statement-breakpoint
UPDATE classroom_assignment_rows r SET canonical_key = g.canonical_key
FROM tutor_identity_groups g WHERE r.group_id = g.id AND r.canonical_key IS NULL;
