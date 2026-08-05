CREATE TABLE "line_group_settings" (
	"group_id" text PRIMARY KEY NOT NULL,
	"audience" text NOT NULL,
	"set_by_line_user_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
