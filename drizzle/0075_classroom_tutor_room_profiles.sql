CREATE TABLE "classroom_tutor_room_profiles" (
	"canonical_key" text PRIMARY KEY NOT NULL,
	"tutor_display_name" text NOT NULL,
	"primary_room_id" uuid NOT NULL,
	"secondary_room_id" uuid,
	"third_room_id" uuid,
	"revision" integer DEFAULT 1 NOT NULL,
	"source" text DEFAULT 'automatic' NOT NULL,
	"provenance" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"updated_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "classroom_tutor_room_profiles" ADD CONSTRAINT "classroom_tutor_room_profiles_primary_room_id_classroom_rooms_id_fk" FOREIGN KEY ("primary_room_id") REFERENCES "public"."classroom_rooms"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "classroom_tutor_room_profiles" ADD CONSTRAINT "classroom_tutor_room_profiles_secondary_room_id_classroom_rooms_id_fk" FOREIGN KEY ("secondary_room_id") REFERENCES "public"."classroom_rooms"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "classroom_tutor_room_profiles" ADD CONSTRAINT "classroom_tutor_room_profiles_third_room_id_classroom_rooms_id_fk" FOREIGN KEY ("third_room_id") REFERENCES "public"."classroom_rooms"("id") ON DELETE no action ON UPDATE no action;