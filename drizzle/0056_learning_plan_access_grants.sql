CREATE TABLE "learning_plan_access_grants" (
	"email" text PRIMARY KEY NOT NULL,
	"granted_by_email" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "learning_plan_access_email_normalized_check" CHECK ("learning_plan_access_grants"."email" = lower(btrim("learning_plan_access_grants"."email")) AND "learning_plan_access_grants"."email" <> ''),
	CONSTRAINT "learning_plan_access_granted_by_nonblank_check" CHECK (btrim("learning_plan_access_grants"."granted_by_email") <> '')
);
--> statement-breakpoint
INSERT INTO "learning_plan_access_grants" ("email", "granted_by_email") VALUES
	('m.giftwan@gmail.com', 'system:migration'),
	('gift.m@begiftededucation.com', 'system:migration'),
	('tudda.tudsirivoravat@gmail.com', 'system:migration')
ON CONFLICT ("email") DO NOTHING;
