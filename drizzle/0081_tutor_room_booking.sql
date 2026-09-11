CREATE TABLE room_tutor_links (
 line_user_id text PRIMARY KEY, canonical_key text, display_name text NOT NULL,
 status text NOT NULL DEFAULT 'pending', reviewed_by text,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 CONSTRAINT room_tutor_approved_key CHECK (status <> 'approved' OR canonical_key IS NOT NULL)
);
CREATE UNIQUE INDEX room_tutor_active_key_idx ON room_tutor_links(canonical_key) WHERE status = 'approved';
CREATE TABLE room_booking_groups (group_id text PRIMARY KEY, enabled boolean NOT NULL DEFAULT false, updated_by text NOT NULL, updated_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE room_day_states (date date PRIMARY KEY, revision integer NOT NULL DEFAULT 0, refresh_owner text, refresh_until timestamptz, lease_owner text, lease_until timestamptz, checked_at timestamptz, evidence jsonb NOT NULL DEFAULT '{"blocks":[],"uncertain":[]}', last_error text);
CREATE TABLE room_reservations (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), date date NOT NULL, room_id uuid NOT NULL REFERENCES classroom_rooms(id),
 line_user_id text NOT NULL REFERENCES room_tutor_links(line_user_id), canonical_key text NOT NULL,
 start_minute integer NOT NULL, end_minute integer NOT NULL, status text NOT NULL DEFAULT 'confirmed',
 idempotency_key text NOT NULL, source text NOT NULL, reason text, changed_by text,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 CONSTRAINT room_reservation_interval CHECK (start_minute >= 420 AND end_minute <= 1260 AND end_minute - start_minute >= 15)
);
CREATE UNIQUE INDEX room_reservation_request_idx ON room_reservations(line_user_id, idempotency_key);
CREATE INDEX room_reservation_day_idx ON room_reservations(date, status);
CREATE TABLE room_access_grants (token_hash text PRIMARY KEY, line_user_id text NOT NULL REFERENCES room_tutor_links(line_user_id), expires_at timestamptz NOT NULL, created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE room_actions (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), line_user_id text NOT NULL, scope text NOT NULL, command text NOT NULL, expires_at timestamptz NOT NULL);
CREATE TABLE room_command_events (event_id text PRIMARY KEY, payload jsonb NOT NULL, status text NOT NULL DEFAULT 'pending', claimed_until timestamptz, attempts integer NOT NULL DEFAULT 0, last_error text, created_at timestamptz NOT NULL DEFAULT now());
CREATE INDEX room_event_pending_idx ON room_command_events(status, claimed_until);
CREATE TABLE room_notifications (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), reservation_id uuid NOT NULL REFERENCES room_reservations(id), line_user_id text NOT NULL, text text NOT NULL, sent_at timestamptz, attempts integer NOT NULL DEFAULT 0, last_error text);
CREATE UNIQUE INDEX room_notification_reservation_idx ON room_notifications(reservation_id);
