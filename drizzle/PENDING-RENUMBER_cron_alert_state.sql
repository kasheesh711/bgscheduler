-- renumber at merge (expected 0043)
CREATE TABLE "cron_alert_state" (
	"job_key" text PRIMARY KEY NOT NULL,
	"episode_key" text NOT NULL,
	"last_status" text NOT NULL,
	"last_alert_outcome" text DEFAULT 'alerted' NOT NULL,
	"last_alerted_at" timestamp with time zone NOT NULL,
	"last_recovered_at" timestamp with time zone,
	"error_summary" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
