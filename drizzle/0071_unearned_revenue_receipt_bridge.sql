ALTER TABLE "unearned_revenue_lot_periods" ADD COLUMN "match_confidence" text DEFAULT 'RESIDUAL' NOT NULL;--> statement-breakpoint
ALTER TABLE "unearned_revenue_lot_periods" ADD COLUMN "match_rule_id" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "unearned_revenue_lot_periods" ADD COLUMN "match_evidence" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "unearned_revenue_lot_periods" ADD COLUMN "candidate_receipt_ids" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "unearned_revenue_lot_periods" ADD COLUMN "credit_event_spreadsheet_id" text;--> statement-breakpoint
ALTER TABLE "unearned_revenue_lot_periods" ADD COLUMN "credit_event_sheet_id" integer;--> statement-breakpoint
ALTER TABLE "unearned_revenue_lot_periods" ADD COLUMN "credit_event_row" integer;--> statement-breakpoint
ALTER TABLE "unearned_revenue_lot_periods" ADD COLUMN "credit_event_a1" text;--> statement-breakpoint
ALTER TABLE "unearned_revenue_lot_periods" ADD COLUMN "receipt_spreadsheet_id" text;--> statement-breakpoint
ALTER TABLE "unearned_revenue_lot_periods" ADD COLUMN "receipt_sheet_id" integer;--> statement-breakpoint
ALTER TABLE "unearned_revenue_lot_periods" ADD COLUMN "receipt_row" integer;--> statement-breakpoint
ALTER TABLE "unearned_revenue_lot_periods" ADD COLUMN "receipt_a1" text;--> statement-breakpoint
ALTER TABLE "unearned_revenue_lot_periods" ADD COLUMN "receipt_id" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "unearned_revenue_lot_periods" ADD COLUMN "receipt_type" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "unearned_revenue_lot_periods" ADD COLUMN "receipt_status" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "unearned_revenue_lot_periods" ADD COLUMN "receipt_charged_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "unearned_revenue_lot_periods" ADD COLUMN "receipt_amount_thb" numeric(20, 8) DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE "unearned_revenue_lot_periods" ADD COLUMN "receipt_currency" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "unearned_revenue_lot_periods" ADD COLUMN "receipt_note" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "unearned_revenue_lot_periods" ADD COLUMN "receipt_student_id" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "unearned_revenue_lot_periods" ADD COLUMN "receipt_class_id" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "unearned_revenue_periods" ADD COLUMN "composite_verified_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "unearned_revenue_periods" ADD COLUMN "receipt_candidate_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "unearned_revenue_periods" ADD COLUMN "reversal_conflict_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "unearned_revenue_periods" ADD COLUMN "missing_receipt_evidence_count" integer DEFAULT 0 NOT NULL;