CREATE TABLE tutor_attendance_enrollments (
  canonical_key text PRIMARY KEY, login_email text NOT NULL, start_date date NOT NULL, end_date date,
  active boolean NOT NULL DEFAULT true, updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ta_enrollment_dates CHECK (end_date IS NULL OR end_date >= start_date)
);
CREATE UNIQUE INDEX ta_enrollment_email_idx ON tutor_attendance_enrollments (lower(btrim(login_email))) WHERE active = true;
--> statement-breakpoint
CREATE TABLE tutor_attendance_schedules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), canonical_key text NOT NULL REFERENCES tutor_attendance_enrollments(canonical_key),
  effective_from date NOT NULL, week jsonb NOT NULL, revision integer NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ta_schedule_key_date_idx ON tutor_attendance_schedules(canonical_key, effective_from);
CREATE TABLE tutor_attendance_exceptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), canonical_key text REFERENCES tutor_attendance_enrollments(canonical_key), date date NOT NULL,
  kind text NOT NULL CHECK (kind IN ('hours', 'excused', 'reset')), start text, "end" text, reason text NOT NULL,
  revision integer NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ta_exception_date_idx ON tutor_attendance_exceptions(date);
--> statement-breakpoint
CREATE TABLE tutor_attendance_config (
  id text PRIMARY KEY DEFAULT 'office', networks jsonb NOT NULL DEFAULT '[]', revision integer NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE tutor_attendance_days (
  canonical_key text NOT NULL REFERENCES tutor_attendance_enrollments(canonical_key), date date NOT NULL,
  recorded_in timestamptz, recorded_out timestamptz, effective_in timestamptz, effective_out timestamptz,
  corrected boolean NOT NULL DEFAULT false, revision integer NOT NULL DEFAULT 0, PRIMARY KEY(canonical_key, date),
  CONSTRAINT ta_effective_order CHECK (effective_out IS NULL OR effective_in IS NULL OR effective_out >= effective_in)
);
--> statement-breakpoint
CREATE TABLE tutor_attendance_corrections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), canonical_key text NOT NULL REFERENCES tutor_attendance_enrollments(canonical_key),
  date date NOT NULL, proposed_in timestamptz, proposed_out timestamptz, reason text NOT NULL, expected_revision integer NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  requested_by text NOT NULL, request_key uuid NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
  reviewed_by text, review_reason text, reviewed_at timestamptz
);
CREATE UNIQUE INDEX ta_correction_request_idx ON tutor_attendance_corrections(requested_by, request_key);
CREATE INDEX ta_correction_status_idx ON tutor_attendance_corrections(status, date);
CREATE TABLE tutor_attendance_audit (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), actor text NOT NULL, action text NOT NULL, canonical_key text,
  date date, data jsonb NOT NULL, request_key uuid, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX ta_audit_request_idx ON tutor_attendance_audit(actor, request_key) WHERE request_key IS NOT NULL;
CREATE INDEX ta_audit_key_date_idx ON tutor_attendance_audit(canonical_key, date);
--> statement-breakpoint
CREATE FUNCTION tutor_attendance_immutable_evidence() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Office attendance evidence is append-only'; END;
$$;
CREATE TRIGGER ta_audit_immutable BEFORE UPDATE OR DELETE ON tutor_attendance_audit FOR EACH ROW EXECUTE FUNCTION tutor_attendance_immutable_evidence();
CREATE TRIGGER ta_schedule_immutable BEFORE UPDATE OR DELETE ON tutor_attendance_schedules FOR EACH ROW EXECUTE FUNCTION tutor_attendance_immutable_evidence();
CREATE TRIGGER ta_exception_immutable BEFORE UPDATE OR DELETE ON tutor_attendance_exceptions FOR EACH ROW EXECUTE FUNCTION tutor_attendance_immutable_evidence();
