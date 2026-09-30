-- Record the rule used by existing financial evidence before changing defaults.
ALTER TABLE "post_class_payout_run_lines"
  ADD COLUMN "submission_evidence_version" integer NOT NULL DEFAULT 1;
--> statement-breakpoint
ALTER TABLE "post_class_payout_run_lines"
  ALTER COLUMN "submission_evidence_version" SET DEFAULT 2;
--> statement-breakpoint
ALTER TABLE "post_class_payout_run_lines"
  ADD CONSTRAINT "pc_payout_run_lines_evidence_check"
  CHECK ("submission_evidence_version" IN (1, 2));
--> statement-breakpoint
ALTER TABLE "post_class_payout_tutor_names"
  ADD COLUMN "identity_changed_at" timestamp with time zone;
--> statement-breakpoint
UPDATE "post_class_payout_tutor_names" SET "identity_changed_at" = "updated_at";
--> statement-breakpoint
ALTER TABLE "post_class_payout_tutor_names"
  ALTER COLUMN "identity_changed_at" SET DEFAULT now(),
  ALTER COLUMN "identity_changed_at" SET NOT NULL;
