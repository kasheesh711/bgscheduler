CREATE TABLE "classroom_weekend_checks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"check_date" date NOT NULL,
	"weekend_date" date NOT NULL,
	"status" text DEFAULT 'running' NOT NULL,
	"claimed_at" timestamp with time zone NOT NULL,
	"report" jsonb,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "classroom_weekend_notifications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"check_id" uuid NOT NULL,
	"weekend_date" date NOT NULL,
	"kind" text NOT NULL,
	"recipient" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"subject" text NOT NULL,
	"text" text NOT NULL,
	"html" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"provider_message_id" text,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"sent_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "classroom_weekend_notifications" ADD CONSTRAINT "classroom_weekend_notifications_check_id_classroom_weekend_checks_id_fk" FOREIGN KEY ("check_id") REFERENCES "public"."classroom_weekend_checks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "cwc_check_date_idx" ON "classroom_weekend_checks" USING btree ("check_date");--> statement-breakpoint
CREATE INDEX "cwc_weekend_idx" ON "classroom_weekend_checks" USING btree ("weekend_date");--> statement-breakpoint
CREATE UNIQUE INDEX "cwn_check_idx" ON "classroom_weekend_notifications" USING btree ("check_id");--> statement-breakpoint
CREATE UNIQUE INDEX "cwn_idempotency_idx" ON "classroom_weekend_notifications" USING btree ("idempotency_key");--> statement-breakpoint
CREATE INDEX "cwn_weekend_sent_idx" ON "classroom_weekend_notifications" USING btree ("weekend_date","sent_at");