ALTER TYPE "public"."sales_dashboard_source_status" ADD VALUE 'archived';--> statement-breakpoint
ALTER TABLE "sales_dashboard_sources" ADD COLUMN "archived_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "sales_dashboard_sources" ADD COLUMN "archived_by_email" text;--> statement-breakpoint
ALTER TABLE "sales_dashboard_sources" ADD COLUMN "status_before_archive" "sales_dashboard_source_status";--> statement-breakpoint
DROP INDEX IF EXISTS "sds_source_month_idx";--> statement-breakpoint
CREATE UNIQUE INDEX "sds_source_month_active_idx" ON "sales_dashboard_sources" USING btree ("source_month") WHERE "status"::text <> 'archived';
