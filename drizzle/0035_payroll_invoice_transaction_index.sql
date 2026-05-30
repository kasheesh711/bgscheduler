DROP INDEX IF EXISTS "payroll_payout_invoices_transaction_idx";--> statement-breakpoint
CREATE INDEX "payroll_payout_invoices_transaction_idx" ON "payroll_payout_invoices" USING btree ("transaction_id");
