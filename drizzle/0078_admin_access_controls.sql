CREATE TABLE "admin_user_access_audit_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"target_email" text NOT NULL,
	"actor_email" text NOT NULL,
	"before_value" jsonb NOT NULL,
	"after_value" jsonb NOT NULL,
	"version" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "admin_user_access_audit_version_positive_check" CHECK ("admin_user_access_audit_log"."version" > 0),
	CONSTRAINT "admin_user_access_audit_target_normalized_check" CHECK ("admin_user_access_audit_log"."target_email" = lower(btrim("admin_user_access_audit_log"."target_email")) AND "admin_user_access_audit_log"."target_email" <> ''),
	CONSTRAINT "admin_user_access_audit_actor_normalized_check" CHECK ("admin_user_access_audit_log"."actor_email" = lower(btrim("admin_user_access_audit_log"."actor_email")) AND "admin_user_access_audit_log"."actor_email" <> '')
);
--> statement-breakpoint
ALTER TABLE "admin_users" ADD COLUMN "disabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "admin_users" ADD COLUMN "access_version" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "admin_user_access_audit_target_version_idx" ON "admin_user_access_audit_log" USING btree ("target_email","version");--> statement-breakpoint
ALTER TABLE "admin_users" ADD CONSTRAINT "admin_users_access_version_nonnegative_check" CHECK ("admin_users"."access_version" >= 0);
--> statement-breakpoint
CREATE FUNCTION "reject_admin_access_audit_mutation"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Admin access audit records are append-only';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "admin_access_audit_append_only"
BEFORE UPDATE OR DELETE ON "admin_user_access_audit_log"
FOR EACH ROW EXECUTE FUNCTION "reject_admin_access_audit_mutation"();
