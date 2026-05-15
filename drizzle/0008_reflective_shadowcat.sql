CREATE TABLE "room_capacity_package_mix" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"model_run_id" uuid NOT NULL,
	"package_hour_bucket" text NOT NULL,
	"package_hours" double precision NOT NULL,
	"average_revenue_thb" double precision NOT NULL,
	"share" double precision NOT NULL,
	"observed_sale_count" integer DEFAULT 0 NOT NULL,
	"observed_student_count" double precision DEFAULT 0 NOT NULL,
	"source_label" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "room_capacity_package_mix" ADD CONSTRAINT "room_capacity_package_mix_model_run_id_room_capacity_model_runs_id_fk" FOREIGN KEY ("model_run_id") REFERENCES "public"."room_capacity_model_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "rcpm_model_run_idx" ON "room_capacity_package_mix" USING btree ("model_run_id");--> statement-breakpoint
CREATE INDEX "rcpm_bucket_idx" ON "room_capacity_package_mix" USING btree ("model_run_id","package_hour_bucket");