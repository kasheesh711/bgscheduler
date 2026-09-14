CREATE TABLE "pt_preparation_publications" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "assessment_id" uuid NOT NULL REFERENCES "pt_assessments"("id"),
  "assessment_revision" integer NOT NULL,
  "operation" text NOT NULL CHECK (operation IN ('upload', 'remove')),
  "paper_version_id" uuid REFERENCES "pt_paper_versions"("id"),
  "file_id" uuid REFERENCES "pt_files"("id"),
  "sha256" text, "name" text, "previous_id" uuid REFERENCES "pt_preparation_publications"("id"),
  "status" text NOT NULL DEFAULT 'queued', "phase" text NOT NULL DEFAULT 'pending',
  "section_id" text, "resource_id" text, "wise_file_id" text, "error" text,
  "verified_at" timestamptz, "created_by" text NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(), "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "pt_preparation_file_shape" CHECK (
    (operation = 'upload' AND paper_version_id IS NOT NULL AND file_id IS NOT NULL AND sha256 IS NOT NULL AND name IS NOT NULL)
    OR (operation = 'remove' AND paper_version_id IS NULL AND file_id IS NULL AND sha256 IS NULL AND name IS NULL)
  )
);
--> statement-breakpoint
CREATE UNIQUE INDEX "pt_preparation_assessment_revision_idx" ON "pt_preparation_publications" ("assessment_id", "assessment_revision");
--> statement-breakpoint
CREATE UNIQUE INDEX "pt_preparation_name_idx" ON "pt_preparation_publications" ("name");
--> statement-breakpoint
CREATE FUNCTION pt_preparation_preserve_evidence() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'Preparation publication history is immutable'; END IF;
  IF (NEW.assessment_id, NEW.assessment_revision, NEW.operation, NEW.paper_version_id, NEW.file_id, NEW.sha256, NEW.name, NEW.previous_id, NEW.created_by, NEW.created_at)
    IS DISTINCT FROM
    (OLD.assessment_id, OLD.assessment_revision, OLD.operation, OLD.paper_version_id, OLD.file_id, OLD.sha256, OLD.name, OLD.previous_id, OLD.created_by, OLD.created_at)
  THEN RAISE EXCEPTION 'Preparation publication evidence is immutable'; END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER pt_preparation_preserve_evidence BEFORE UPDATE OR DELETE ON pt_preparation_publications FOR EACH ROW EXECUTE FUNCTION pt_preparation_preserve_evidence();
