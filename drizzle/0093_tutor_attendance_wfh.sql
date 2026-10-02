CREATE TABLE tutor_attendance_wfh_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  canonical_key text NOT NULL REFERENCES tutor_attendance_enrollments(canonical_key),
  date date NOT NULL, reason text NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected', 'cancelled')),
  revision integer NOT NULL DEFAULT 0,
  requested_by text NOT NULL, request_key uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  reviewed_by text, review_reason text, reviewed_at timestamptz,
  cancelled_by text, cancellation_reason text, cancelled_at timestamptz
);
CREATE UNIQUE INDEX ta_wfh_request_idx ON tutor_attendance_wfh_requests(requested_by, request_key);
CREATE UNIQUE INDEX ta_wfh_active_date_idx ON tutor_attendance_wfh_requests(canonical_key, date) WHERE status IN ('pending', 'approved');
CREATE INDEX ta_wfh_status_date_idx ON tutor_attendance_wfh_requests(status, date);
--> statement-breakpoint
ALTER TABLE tutor_attendance_days
  ADD COLUMN work_mode text NOT NULL DEFAULT 'office',
  ADD COLUMN wfh_request_id uuid REFERENCES tutor_attendance_wfh_requests(id),
  ADD CONSTRAINT ta_day_work_mode CHECK (
    (work_mode = 'office' AND wfh_request_id IS NULL) OR
    (work_mode = 'wfh' AND wfh_request_id IS NOT NULL)
  );
