-- Durable, append-only payout publishing.
--
-- Raw payout data is now read-only. The app owns a separate append-only
-- `Feedback Deductions` tab, so rows cannot disappear when finance refreshes
-- the raw export and the reconciliation-only columns from 0059 are obsolete.

-- 0059 scoped deduction uniqueness to one run. A deduction copied into two
-- all-skipped runs is safe to inspect, but cannot be assigned the one global
-- durable source identity introduced below. Abort before any schema or payout
-- data mutation so finance can choose and audit the canonical legacy row.
DO $$
BEGIN
	IF EXISTS (
		SELECT 1
		FROM "post_class_payout_run_lines"
		GROUP BY "deduction_id"
		HAVING count(*) > 1
	) THEN
		RAISE EXCEPTION
			'0060 requires an audited legacy payout bootstrap before migration: the same deduction exists in multiple payout runs; choose and audit one canonical row before proceeding'
			USING ERRCODE = '55000';
	END IF;
END $$;--> statement-breakpoint

ALTER TYPE "public"."post_class_payout_run_status"
	ADD VALUE IF NOT EXISTS 'publishing';--> statement-breakpoint
ALTER TYPE "public"."post_class_payout_run_status"
	ADD VALUE IF NOT EXISTS 'partial';--> statement-breakpoint
ALTER TYPE "public"."post_class_payout_run_status"
	ADD VALUE IF NOT EXISTS 'closed';--> statement-breakpoint

-- 0059 wrote into a mutable raw-export tab. Those historical rows cannot be
-- relabelled as durable dedicated-tab writes without first copying them and
-- proving their markers in Google Sheets. Abort before changing payout data;
-- the rollout operator must complete and audit that bootstrap separately.
DO $$
BEGIN
	IF EXISTS (
		SELECT 1
		FROM "post_class_payout_run_lines"
		-- A 0059 lost response could leave a landed append as `failed`, and a
		-- worker death could leave it `pending`. Only `skipped` proves no old
		-- mutable-tab append was attempted.
		WHERE "write_status" <> 'skipped'
	) THEN
		RAISE EXCEPTION
			'0060 requires an audited legacy payout bootstrap before migration: reconcile every potentially attempted 0059 row in the dedicated Feedback Deductions tab before proceeding'
			USING ERRCODE = '55000';
	END IF;
END $$;--> statement-breakpoint

-- A processed deduction remains immutable except for the explicit finance
-- reversal transition. The offset/action/correction rows are written in the
-- same transaction, while this trigger proves the source row changed only in
-- status, optimistic version, and audit timestamp.
CREATE OR REPLACE FUNCTION "post_class_protect_processed_deduction"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
	IF TG_OP = 'DELETE' THEN
		RAISE EXCEPTION 'processed deduction records are immutable'
			USING ERRCODE = '55000';
	END IF;
	IF OLD."status" = 'processed' THEN
		IF NEW."status" = 'reversed'
			AND NEW."version" = OLD."version" + 1
			AND (
				to_jsonb(NEW) - 'status' - 'version' - 'updated_at'
			) = (
				to_jsonb(OLD) - 'status' - 'version' - 'updated_at'
			)
		THEN
			RETURN NEW;
		END IF;
		RAISE EXCEPTION 'processed deduction records are immutable'
			USING ERRCODE = '55000';
	END IF;
	RETURN NEW;
END;
$$;--> statement-breakpoint

ALTER TABLE "post_class_payout_runs"
	ADD COLUMN IF NOT EXISTS "lease_token" uuid;--> statement-breakpoint
ALTER TABLE "post_class_payout_runs"
	ADD COLUMN IF NOT EXISTS "lease_expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "post_class_payout_runs"
	ADD COLUMN IF NOT EXISTS "publishing_by_email" text;--> statement-breakpoint
ALTER TABLE "post_class_payout_runs"
	ADD COLUMN IF NOT EXISTS "publish_started_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "post_class_payout_runs"
	ADD COLUMN IF NOT EXISTS "publish_acknowledgements" jsonb;--> statement-breakpoint
ALTER TABLE "post_class_payout_runs"
	ADD COLUMN IF NOT EXISTS "csv_status" text DEFAULT 'pending' NOT NULL;--> statement-breakpoint
ALTER TABLE "post_class_payout_runs"
	ADD COLUMN IF NOT EXISTS "csv_error" text;--> statement-breakpoint
ALTER TABLE "post_class_payout_runs"
	ADD COLUMN IF NOT EXISTS "csv_attempted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "post_class_payout_runs"
	ADD COLUMN IF NOT EXISTS "closed_by_email" text;--> statement-breakpoint
ALTER TABLE "post_class_payout_runs"
	ADD COLUMN IF NOT EXISTS "closed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "post_class_payout_runs"
	ADD COLUMN IF NOT EXISTS "close_reason" text;--> statement-breakpoint
ALTER TABLE "post_class_payout_runs"
	ADD COLUMN IF NOT EXISTS "date_roll_status" text DEFAULT 'not_started' NOT NULL;--> statement-breakpoint
ALTER TABLE "post_class_payout_runs"
	ADD COLUMN IF NOT EXISTS "date_roll_started_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "post_class_payout_runs"
	ADD COLUMN IF NOT EXISTS "date_rolled_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "post_class_payout_runs"
	ADD COLUMN IF NOT EXISTS "date_rolled_by_email" text;--> statement-breakpoint
ALTER TABLE "post_class_payout_runs"
	ADD COLUMN IF NOT EXISTS "rolled_to_anchor_month" date;--> statement-breakpoint

UPDATE "post_class_payout_runs"
SET "csv_status" = CASE WHEN "csv_file_id" IS NULL THEN 'failed' ELSE 'uploaded' END,
	"csv_attempted_at" = COALESCE("published_at", "updated_at")
WHERE "status" = 'published';--> statement-breakpoint

ALTER TABLE "post_class_payout_runs"
	ADD CONSTRAINT "pc_payout_runs_csv_status_check"
	CHECK ("csv_status" IN ('pending', 'uploaded', 'failed'));--> statement-breakpoint
ALTER TABLE "post_class_payout_runs"
	ADD CONSTRAINT "pc_payout_runs_date_roll_status_check"
	CHECK ("date_roll_status" IN ('not_started', 'running', 'partial', 'completed'));--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "pc_payout_runs_lease_idx"
	ON "post_class_payout_runs" ("status", "lease_expires_at");--> statement-breakpoint

-- Neutral ledger-name terminology. The values remain exact strings copied
-- from the raw payout export.
ALTER TABLE "post_class_payout_tutor_names"
	RENAME COLUMN "onsite_name" TO "primary_ledger_name";--> statement-breakpoint
ALTER TABLE "post_class_payout_tutor_names"
	RENAME COLUMN "online_name" TO "alternate_ledger_name";--> statement-breakpoint
DROP INDEX IF EXISTS "pc_payout_tutor_names_onsite_idx";--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "pc_payout_tutor_names_primary_idx"
	ON "post_class_payout_tutor_names" ("primary_ledger_name");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "pc_payout_tutor_names_alternate_idx"
	ON "post_class_payout_tutor_names" ("alternate_ledger_name")
	WHERE "alternate_ledger_name" IS NOT NULL;--> statement-breakpoint

-- Enforce uniqueness across both columns, including concurrent writes. The
-- advisory locks serialize only the exact normalized names being claimed.
DO $$
BEGIN
	IF EXISTS (
		SELECT 1
		FROM (
			SELECT lower(btrim(name)) AS normalized_name
			FROM "post_class_payout_tutor_names",
			LATERAL unnest(ARRAY["primary_ledger_name", "alternate_ledger_name"]) AS name
			WHERE name IS NOT NULL
			GROUP BY lower(btrim(name))
			HAVING count(*) > 1
		) duplicate
	) THEN
		RAISE EXCEPTION 'Existing payout tutor ledger names collide across primary/alternate columns'
			USING ERRCODE = '23505';
	END IF;
END $$;--> statement-breakpoint

CREATE OR REPLACE FUNCTION "pc_enforce_payout_ledger_name_uniqueness"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
	normalized_name text;
	wanted_names text[];
BEGIN
	wanted_names := ARRAY[
		lower(btrim(NEW."primary_ledger_name")),
		CASE WHEN NEW."alternate_ledger_name" IS NULL
			THEN NULL
			ELSE lower(btrim(NEW."alternate_ledger_name"))
		END
	];
	IF wanted_names[2] IS NOT NULL AND wanted_names[1] = wanted_names[2] THEN
		RAISE EXCEPTION 'Primary and alternate payout ledger names must be different'
			USING ERRCODE = '23505';
	END IF;
	FOR normalized_name IN
		SELECT DISTINCT value
		FROM unnest(wanted_names) AS value
		WHERE value IS NOT NULL
		ORDER BY value
	LOOP
		PERFORM pg_advisory_xact_lock(hashtextextended(normalized_name, 60760));
	END LOOP;
	IF EXISTS (
		SELECT 1
		FROM "post_class_payout_tutor_names" existing
		WHERE existing."canonical_key" <> NEW."canonical_key"
			AND (
				lower(btrim(existing."primary_ledger_name")) = ANY(wanted_names)
				OR (
					existing."alternate_ledger_name" IS NOT NULL
					AND lower(btrim(existing."alternate_ledger_name")) = ANY(wanted_names)
				)
			)
	) THEN
		RAISE EXCEPTION 'Payout ledger name is already assigned'
			USING ERRCODE = '23505';
	END IF;
	RETURN NEW;
END;
$$;--> statement-breakpoint
DROP TRIGGER IF EXISTS "pc_payout_ledger_name_uniqueness" ON "post_class_payout_tutor_names";--> statement-breakpoint
CREATE TRIGGER "pc_payout_ledger_name_uniqueness"
	BEFORE INSERT OR UPDATE OF "primary_ledger_name", "alternate_ledger_name"
	ON "post_class_payout_tutor_names"
	FOR EACH ROW
	EXECUTE FUNCTION "pc_enforce_payout_ledger_name_uniqueness"();--> statement-breakpoint

ALTER TABLE "post_class_payout_run_lines"
	ADD COLUMN IF NOT EXISTS "line_kind" text DEFAULT 'deduction' NOT NULL;--> statement-breakpoint
ALTER TABLE "post_class_payout_run_lines"
	ADD COLUMN IF NOT EXISTS "source_identity" text;--> statement-breakpoint
ALTER TABLE "post_class_payout_run_lines"
	ADD COLUMN IF NOT EXISTS "row_signature" text;--> statement-breakpoint
ALTER TABLE "post_class_payout_run_lines"
	ADD COLUMN IF NOT EXISTS "retired_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "post_class_payout_run_lines"
	ADD COLUMN IF NOT EXISTS "retired_reason" text;--> statement-breakpoint
ALTER TABLE "post_class_payout_run_lines"
	ADD COLUMN IF NOT EXISTS "class_name" text;--> statement-breakpoint
ALTER TABLE "post_class_payout_run_lines"
	ADD COLUMN IF NOT EXISTS "scheduled_end_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "post_class_payout_run_lines"
	ADD COLUMN IF NOT EXISTS "finance_month" date;--> statement-breakpoint
ALTER TABLE "post_class_payout_run_lines"
	ADD COLUMN IF NOT EXISTS "pass_token" uuid;--> statement-breakpoint

UPDATE "post_class_payout_run_lines" AS line
SET "source_identity" = 'deduction:' || line."deduction_id"::text,
	"row_signature" = 'BGS-PAYOUT ' || to_char(run."anchor_month", 'YYYY-MM') || ' '
		|| substring(replace(line."deduction_id"::text, '-', '') from 1 for 12),
	"amount_minor" = -abs(line."amount_minor"),
	"class_name" = session."class_name",
	"scheduled_end_at" = session."scheduled_end_at",
	"finance_month" = deduction."default_finance_month"
FROM "post_class_payout_runs" AS run,
	"post_class_sessions" AS session,
	"post_class_deductions" AS deduction
WHERE run."id" = line."run_id"
	AND session."id" = line."session_id"
	AND deduction."id" = line."deduction_id";--> statement-breakpoint

ALTER TABLE "post_class_payout_run_lines"
	ALTER COLUMN "source_identity" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "post_class_payout_run_lines"
	ALTER COLUMN "row_signature" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "post_class_payout_run_lines"
	ALTER COLUMN "scheduled_end_at" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "post_class_payout_run_lines"
	ADD CONSTRAINT "pc_payout_run_lines_signed_check"
	CHECK ("amount_minor" < 0);--> statement-breakpoint
ALTER TABLE "post_class_payout_run_lines"
	ADD CONSTRAINT "pc_payout_run_lines_kind_check"
	CHECK ("line_kind" = 'deduction');--> statement-breakpoint
DROP INDEX IF EXISTS "pc_payout_run_lines_run_deduction_idx";--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "pc_payout_run_lines_source_identity_idx"
	ON "post_class_payout_run_lines" ("source_identity");--> statement-breakpoint
DO $$
BEGIN
	IF EXISTS (
		SELECT 1
		FROM "post_class_payout_run_lines"
		GROUP BY "row_signature"
		HAVING count(*) > 1
	) THEN
		RAISE EXCEPTION 'Existing payout deduction row signatures collide'
			USING ERRCODE = '23505';
	END IF;
END $$;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "pc_payout_run_lines_row_signature_idx"
	ON "post_class_payout_run_lines" ("row_signature");--> statement-breakpoint

-- These columns existed only to detect rows lost from a mutable raw tab. The
-- dedicated tab is machine-owned and append-only, so keeping them would imply
-- a recovery protocol which no longer exists.
UPDATE "post_class_payout_run_lines"
SET "inserted_row_number" = COALESCE("inserted_row_number", "master_row_number")
WHERE "master_row_number" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "post_class_payout_run_lines"
	DROP COLUMN IF EXISTS "marker_miss_count";--> statement-breakpoint
ALTER TABLE "post_class_payout_run_lines"
	DROP COLUMN IF EXISTS "last_seen_in_master_at";--> statement-breakpoint
ALTER TABLE "post_class_payout_run_lines"
	DROP COLUMN IF EXISTS "reappend_count";--> statement-breakpoint
ALTER TABLE "post_class_payout_run_lines"
	DROP COLUMN IF EXISTS "master_row_number";--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "post_class_payout_adjustments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"deduction_id" uuid NOT NULL,
	"source_line_id" uuid,
	"run_id" uuid,
	"kind" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"amount_minor" integer DEFAULT 10000 NOT NULL,
	"currency" text DEFAULT 'THB' NOT NULL,
	"reason" text NOT NULL,
	"actor_email" text NOT NULL,
	"source_identity" text NOT NULL,
	"row_signature" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"pass_token" uuid,
	"sheet_row_number" integer,
	"write_error" text,
	"written_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pc_payout_adjustments_kind_check" CHECK ("kind" IN ('waiver', 'reversal')),
	CONSTRAINT "pc_payout_adjustments_status_check" CHECK ("status" IN ('pending', 'written', 'failed', 'exception')),
	CONSTRAINT "pc_payout_adjustments_amount_check" CHECK ("amount_minor" > 0)
);--> statement-breakpoint

ALTER TABLE "post_class_payout_adjustments"
	ADD CONSTRAINT "pc_payout_adjustments_deduction_fk"
	FOREIGN KEY ("deduction_id") REFERENCES "public"."post_class_deductions"("id")
	ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "post_class_payout_adjustments"
	ADD CONSTRAINT "pc_payout_adjustments_source_line_fk"
	FOREIGN KEY ("source_line_id") REFERENCES "public"."post_class_payout_run_lines"("id")
	ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "post_class_payout_adjustments"
	ADD CONSTRAINT "pc_payout_adjustments_run_fk"
	FOREIGN KEY ("run_id") REFERENCES "public"."post_class_payout_runs"("id")
	ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "pc_payout_adjustments_idempotency_idx"
	ON "post_class_payout_adjustments" ("idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "pc_payout_adjustments_source_identity_idx"
	ON "post_class_payout_adjustments" ("source_identity");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "pc_payout_adjustments_row_signature_idx"
	ON "post_class_payout_adjustments" ("row_signature");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "pc_payout_adjustments_deduction_idx"
	ON "post_class_payout_adjustments" ("deduction_id", "status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "pc_payout_adjustments_run_idx"
	ON "post_class_payout_adjustments" ("run_id", "status");--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "post_class_payout_exceptions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"deduction_id" uuid,
	"adjustment_id" uuid,
	"kind" text NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"source_identity" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"reason" text NOT NULL,
	"resolution_note" text,
	"resolution_reference" text,
	"resolved_by_email" text,
	"resolved_at" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pc_payout_exceptions_status_check" CHECK ("status" IN ('open', 'resolved'))
);--> statement-breakpoint

ALTER TABLE "post_class_payout_exceptions"
	ADD CONSTRAINT "pc_payout_exceptions_run_fk"
	FOREIGN KEY ("run_id") REFERENCES "public"."post_class_payout_runs"("id")
	ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "post_class_payout_exceptions"
	ADD CONSTRAINT "pc_payout_exceptions_deduction_fk"
	FOREIGN KEY ("deduction_id") REFERENCES "public"."post_class_deductions"("id")
	ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "post_class_payout_exceptions"
	ADD CONSTRAINT "pc_payout_exceptions_adjustment_fk"
	FOREIGN KEY ("adjustment_id") REFERENCES "public"."post_class_payout_adjustments"("id")
	ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "pc_payout_exceptions_run_idx"
	ON "post_class_payout_exceptions" ("run_id", "status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "pc_payout_exceptions_deduction_idx"
	ON "post_class_payout_exceptions" ("deduction_id", "status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "pc_payout_exceptions_adjustment_idx"
	ON "post_class_payout_exceptions" ("adjustment_id", "status");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "pc_payout_exceptions_source_identity_idx"
	ON "post_class_payout_exceptions" ("source_identity");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "pc_payout_exceptions_idempotency_idx"
	ON "post_class_payout_exceptions" ("idempotency_key");--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "post_class_payout_roll_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"payout_run_id" uuid NOT NULL,
	"target_anchor_month" date NOT NULL,
	"target_window_start" date NOT NULL,
	"target_window_end" date NOT NULL,
	"manifest_hash" text NOT NULL,
	"status" text DEFAULT 'running' NOT NULL,
	"lease_token" uuid NOT NULL,
	"lease_expires_at" timestamp with time zone NOT NULL,
	"started_by_email" text NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	"total_workbooks" integer DEFAULT 0 NOT NULL,
	"succeeded_workbooks" integer DEFAULT 0 NOT NULL,
	"failed_workbooks" integer DEFAULT 0 NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pc_payout_roll_runs_status_check"
		CHECK ("status" IN ('running', 'partial', 'completed', 'failed'))
);--> statement-breakpoint
ALTER TABLE "post_class_payout_roll_runs"
	ADD CONSTRAINT "pc_payout_roll_runs_payout_fk"
	FOREIGN KEY ("payout_run_id") REFERENCES "public"."post_class_payout_runs"("id")
	ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "pc_payout_roll_runs_source_idx"
	ON "post_class_payout_roll_runs" ("payout_run_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "pc_payout_roll_runs_status_idx"
	ON "post_class_payout_roll_runs" ("status", "lease_expires_at");--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "post_class_payout_roll_outcomes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"roll_run_id" uuid NOT NULL,
	"workbook_id" text NOT NULL,
	"workbook_name" text NOT NULL,
	"canonical_tutor_key" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"before_start_serial" double precision,
	"before_end_serial" double precision,
	"after_start_serial" double precision,
	"after_end_serial" double precision,
	"previous_window_start" date,
	"previous_window_end" date,
	"applied_window_start" date,
	"applied_window_end" date,
	"error" text,
	"attempted_at" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pc_payout_roll_outcomes_status_check"
		CHECK ("status" IN ('pending', 'already_target', 'verified', 'failed'))
);--> statement-breakpoint
ALTER TABLE "post_class_payout_roll_outcomes"
	ADD CONSTRAINT "pc_payout_roll_outcomes_roll_fk"
	FOREIGN KEY ("roll_run_id") REFERENCES "public"."post_class_payout_roll_runs"("id")
	ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "pc_payout_roll_outcomes_workbook_idx"
	ON "post_class_payout_roll_outcomes" ("roll_run_id", "workbook_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "pc_payout_roll_outcomes_status_idx"
	ON "post_class_payout_roll_outcomes" ("roll_run_id", "status");
