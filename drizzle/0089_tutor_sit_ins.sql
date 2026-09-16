CREATE TABLE "tutor_sit_in_assignments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"quarter" text NOT NULL,
	"department" text NOT NULL,
	"canonical_key" text NOT NULL,
	"tutor_name" text NOT NULL,
	"observer_email" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"reason" text,
	"revision" integer DEFAULT 0 NOT NULL,
	"suggestions" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"suggestion_error" text,
	"checked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sit_in_assignment_status" CHECK ("tutor_sit_in_assignments"."status" in ('pending','scheduled','needs_rescheduling','completed','exempt'))
);
--> statement-breakpoint
CREATE TABLE "tutor_sit_in_audit" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"actor" text NOT NULL,
	"action" text NOT NULL,
	"entity_id" text NOT NULL,
	"detail" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tutor_sit_in_calendar_connections" (
	"email" text PRIMARY KEY NOT NULL,
	"google_email" text NOT NULL,
	"google_subject" text NOT NULL,
	"access_token_ciphertext" text NOT NULL,
	"refresh_token_ciphertext" text,
	"expires_at" timestamp with time zone NOT NULL,
	"scope" text NOT NULL,
	"calendar_id" text DEFAULT 'primary' NOT NULL,
	"busy_calendar_ids" jsonb DEFAULT '["primary"]'::jsonb NOT NULL,
	"revision" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tutor_sit_in_communications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"observation_id" uuid NOT NULL,
	"family_key" text NOT NULL,
	"kind" text NOT NULL,
	"participants" jsonb NOT NULL,
	"unresolved" boolean DEFAULT false NOT NULL,
	"parent_informed_at" timestamp with time zone,
	"parent_informed_by" text,
	"student_informed_at" timestamp with time zone,
	"student_informed_by" text,
	"superseded_at" timestamp with time zone,
	"revision" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tutor_sit_in_grants" (
	"email" text PRIMARY KEY NOT NULL,
	"role" text DEFAULT 'observer' NOT NULL,
	"departments" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"canonical_key" text,
	"active" boolean DEFAULT true NOT NULL,
	"revision" integer DEFAULT 0 NOT NULL,
	"operation_owner" text,
	"operation_until" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sit_in_grant_role" CHECK ("tutor_sit_in_grants"."role" in ('observer', 'coordinator', 'manager'))
);
--> statement-breakpoint
CREATE TABLE "tutor_sit_in_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"key" text NOT NULL,
	"kind" text NOT NULL,
	"observation_id" uuid,
	"recipient" text,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"retry_at" timestamp with time zone DEFAULT now() NOT NULL,
	"lease_owner" text,
	"lease_until" timestamp with time zone,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tutor_sit_in_mappings" (
	"class_id" text PRIMARY KEY NOT NULL,
	"departments" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"revision" integer DEFAULT 0 NOT NULL,
	"updated_by" text NOT NULL,
	"reason" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tutor_sit_in_observations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"assignment_id" uuid NOT NULL,
	"observer_email" text NOT NULL,
	"observer_canonical_key" text NOT NULL,
	"lesson" jsonb NOT NULL,
	"start_time" timestamp with time zone NOT NULL,
	"end_time" timestamp with time zone NOT NULL,
	"current" boolean DEFAULT true NOT NULL,
	"invalid_reason" text,
	"calendar_id" text NOT NULL,
	"event_id" text NOT NULL,
	"event_etag" text,
	"event_url" text,
	"calendar_status" text DEFAULT 'pending' NOT NULL,
	"calendar_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tutor_sit_in_reports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"assignment_id" uuid NOT NULL,
	"observation_id" uuid NOT NULL,
	"author_email" text NOT NULL,
	"report_version" integer NOT NULL,
	"revision" integer DEFAULT 0 NOT NULL,
	"rubric" jsonb NOT NULL,
	"data" jsonb NOT NULL,
	"score" integer,
	"submitted_at" timestamp with time zone,
	"late" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tutor_sit_in_worker_state" (
	"key" text PRIMARY KEY NOT NULL,
	"owner" text,
	"lease_until" timestamp with time zone,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "tutor_sit_in_communications" ADD CONSTRAINT "tutor_sit_in_communications_observation_id_tutor_sit_in_observations_id_fk" FOREIGN KEY ("observation_id") REFERENCES "public"."tutor_sit_in_observations"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "tutor_sit_in_jobs" ADD CONSTRAINT "tutor_sit_in_jobs_observation_id_tutor_sit_in_observations_id_fk" FOREIGN KEY ("observation_id") REFERENCES "public"."tutor_sit_in_observations"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "tutor_sit_in_observations" ADD CONSTRAINT "tutor_sit_in_observations_assignment_id_tutor_sit_in_assignments_id_fk" FOREIGN KEY ("assignment_id") REFERENCES "public"."tutor_sit_in_assignments"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "tutor_sit_in_reports" ADD CONSTRAINT "tutor_sit_in_reports_assignment_id_tutor_sit_in_assignments_id_fk" FOREIGN KEY ("assignment_id") REFERENCES "public"."tutor_sit_in_assignments"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "tutor_sit_in_reports" ADD CONSTRAINT "tutor_sit_in_reports_observation_id_tutor_sit_in_observations_id_fk" FOREIGN KEY ("observation_id") REFERENCES "public"."tutor_sit_in_observations"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "sit_in_quarter_tutor_department" ON "tutor_sit_in_assignments" USING btree ("quarter","canonical_key","department");
--> statement-breakpoint
CREATE INDEX "sit_in_assignment_observer" ON "tutor_sit_in_assignments" USING btree ("observer_email","quarter");
--> statement-breakpoint
CREATE UNIQUE INDEX "sit_in_communication_family" ON "tutor_sit_in_communications" USING btree ("observation_id","family_key","kind");
--> statement-breakpoint
CREATE UNIQUE INDEX "sit_in_job_key" ON "tutor_sit_in_jobs" USING btree ("key");
--> statement-breakpoint
CREATE INDEX "sit_in_job_pending" ON "tutor_sit_in_jobs" USING btree ("status","retry_at");
--> statement-breakpoint
CREATE UNIQUE INDEX "sit_in_one_current_observation" ON "tutor_sit_in_observations" USING btree ("assignment_id") WHERE "tutor_sit_in_observations"."current" = true;
--> statement-breakpoint
CREATE UNIQUE INDEX "sit_in_calendar_event" ON "tutor_sit_in_observations" USING btree ("observer_email","calendar_id","event_id");
--> statement-breakpoint
CREATE INDEX "sit_in_observer_times" ON "tutor_sit_in_observations" USING btree ("observer_email","start_time");
--> statement-breakpoint
CREATE UNIQUE INDEX "sit_in_report_version" ON "tutor_sit_in_reports" USING btree ("assignment_id","report_version");
--> statement-breakpoint
-- Bind only unambiguous existing contact emails. Unbound heads require review.
INSERT INTO tutor_sit_in_grants (email, role, departments, canonical_key)
SELECT h.email, 'observer', jsonb_build_array(h.department),
  (SELECT CASE WHEN count(*) = 1 THEN min(canonical_key) ELSE NULL END
   FROM tutor_contacts c WHERE c.active AND
    (lower(btrim(c.onsite_email)) = h.email OR lower(btrim(c.online_email)) = h.email))
FROM (VALUES
 ('apivit.s@hotmail.com', 'physics'), ('kasidej.ju@gmail.com', 'maths'),
 ('drxiox@gmail.com', 'english'), ('miieiiem@gmail.com', 'chemistry'),
 ('gift.m@begiftededucation.com', 'iseb')
) AS h(email, department) ON CONFLICT DO NOTHING;
--> statement-breakpoint
INSERT INTO tutor_sit_in_grants (email, role) VALUES
 ('panida.wiya@gmail.com', 'coordinator'), ('kittiya.carekt@gmail.com', 'coordinator'),
 ('chiraya.work@gmail.com', 'coordinator'), ('pakwalaan@gmail.com', 'coordinator'),
 ('suphitsaramanosamrit@gmail.com', 'coordinator') ON CONFLICT DO NOTHING;
--> statement-breakpoint
ALTER TABLE tutor_sit_in_assignments ADD CONSTRAINT sit_in_quarter_check
 CHECK (quarter ~ '^[0-9]{4}-Q[1-4]$' AND quarter >= '2026-Q4' AND quarter <= '2100-Q4');
--> statement-breakpoint
ALTER TABLE tutor_sit_in_assignments ADD CONSTRAINT sit_in_department_check
 CHECK (department IN ('physics','maths','english','chemistry','iseb'));
--> statement-breakpoint
ALTER TABLE tutor_sit_in_observations ADD CONSTRAINT sit_in_time_order CHECK (end_time > start_time);
--> statement-breakpoint
ALTER TABLE tutor_sit_in_reports ADD CONSTRAINT sit_in_score_check CHECK (score IS NULL OR score BETWEEN 10 AND 100);
--> statement-breakpoint
CREATE FUNCTION sit_in_protect_booking() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.current THEN
    -- Canonical identity also serializes different Google emails for one person.
    PERFORM pg_advisory_xact_lock(hashtextextended('sit-in:' || NEW.observer_canonical_key, 0));
    IF EXISTS (SELECT 1 FROM tutor_sit_in_assignments WHERE id = NEW.assignment_id AND canonical_key = NEW.observer_canonical_key) THEN
      RAISE EXCEPTION 'Self-observation is prohibited' USING ERRCODE = '23514';
    END IF;
    IF EXISTS (SELECT 1 FROM tutor_sit_in_observations o WHERE o.current AND o.id <> NEW.id
      AND o.observer_canonical_key = NEW.observer_canonical_key
      AND o.start_time < NEW.end_time AND NEW.start_time < o.end_time) THEN
      RAISE EXCEPTION 'Observer already booked' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER sit_in_booking_guard BEFORE INSERT OR UPDATE ON tutor_sit_in_observations
 FOR EACH ROW EXECUTE FUNCTION sit_in_protect_booking();
--> statement-breakpoint
CREATE FUNCTION sit_in_protect_report() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.submitted_at IS NOT NULL THEN
    RAISE EXCEPTION 'Submitted reports are immutable; create a revision';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  IF NEW.rubric <> OLD.rubric OR NEW.assignment_id <> OLD.assignment_id OR NEW.observation_id <> OLD.observation_id
    OR NEW.author_email <> OLD.author_email OR NEW.report_version <> OLD.report_version THEN
    RAISE EXCEPTION 'Report provenance and rubric are immutable';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER sit_in_report_guard BEFORE UPDATE OR DELETE ON tutor_sit_in_reports
 FOR EACH ROW EXECUTE FUNCTION sit_in_protect_report();
--> statement-breakpoint
CREATE FUNCTION sit_in_protect_audit() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Sit-in audit records are append-only';
END $$;
--> statement-breakpoint
CREATE TRIGGER sit_in_audit_guard BEFORE UPDATE OR DELETE ON tutor_sit_in_audit
 FOR EACH ROW EXECUTE FUNCTION sit_in_protect_audit();
