-- The call-skip test (Kevin, 24 Nov 2026): the route of each new qualified applicant in the test.
-- `call` = HR call first. `direct` = the form and the visit with no call. Read only by the queue and the report script.
CREATE TABLE "hiring_call_test" (
	"candidate_id" uuid PRIMARY KEY NOT NULL,
	"arm" text NOT NULL,
	"assigned_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "hiring_call_test_arm" CHECK ("hiring_call_test"."arm" in ('call','direct'))
);
--> statement-breakpoint
ALTER TABLE "hiring_call_test" ADD CONSTRAINT "hiring_call_test_candidate_id_hiring_candidates_id_fk" FOREIGN KEY ("candidate_id") REFERENCES "public"."hiring_candidates"("id") ON DELETE cascade ON UPDATE no action;
