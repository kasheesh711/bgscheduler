-- Payout deductions append to the shared master ledger, not to tutor sheets.
--
-- A tutor's payout workbook is a `QUERY(IMPORTRANGE(...))` view over
-- `Begifted Payouts` → `Begifted Payouts Detailed`, filtered by that tutor's
-- identity strings. Writing into the view breaks its array formula; the ledger
-- is the only writable target, and one appended row reaches every view.
--
-- Two things follow. Identity is now the exact ledger name string rather than a
-- spreadsheet id, and because the ledger is periodically refreshed by a process
-- we do not control, each line has to record whether its row is still there.

CREATE TABLE IF NOT EXISTS "post_class_payout_tutor_names" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"canonical_key" text NOT NULL,
	-- The two strings the ledger uses for one tutor: the onsite identity and
	-- its " Online" twin. Copied from the ledger, never constructed — the
	-- tutor's view filters on an exact string match.
	"onsite_name" text NOT NULL,
	"online_name" text,
	"active" boolean DEFAULT true NOT NULL,
	"updated_by_email" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "pc_payout_tutor_names_key_idx"
	ON "post_class_payout_tutor_names" ("canonical_key");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "pc_payout_tutor_names_onsite_idx"
	ON "post_class_payout_tutor_names" ("onsite_name");--> statement-breakpoint

-- Reconcile bookkeeping. `marker_miss_count` is why reconcile cannot cause a
-- double deduction on its own: one miss is never enough to re-append, because a
-- read can race the ledger refresh. Two consecutive misses are required, and
-- the promotion happens under the finance lock, not in the scan.
ALTER TABLE "post_class_payout_run_lines"
	ADD COLUMN IF NOT EXISTS "marker_miss_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "post_class_payout_run_lines"
	ADD COLUMN IF NOT EXISTS "last_seen_in_master_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "post_class_payout_run_lines"
	ADD COLUMN IF NOT EXISTS "reappend_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
-- The ledger row number an append landed on, so a human can find it.
ALTER TABLE "post_class_payout_run_lines"
	ADD COLUMN IF NOT EXISTS "master_row_number" integer;
