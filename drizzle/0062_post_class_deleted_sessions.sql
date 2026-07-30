-- REC-03: record that Wise deleted a session, so the collector stops chasing it.
--
-- Wise answers a detail fetch for a deleted session with HTTP 400 "Session not
-- found!". The collector recorded that as a `session_not_found` source issue and
-- re-queued the session on the next run, forever: a deleted session's feedback
-- event can never become linked (linking requires a successful fetch), so it
-- never leaves the highest-priority candidate lane. Production accumulated 230
-- open issues from 121 deleted sessions, burning ~30 of each run's 50 Wise calls
-- and pinning every run's outcome at "partial".
--
-- `wise_deleted_at` is a fact of its own rather than a `source_status` value.
-- Deletion is a legitimate Wise lifecycle transition, not a source-health
-- defect, and every `source_status <> 'ready'` reader treats its subject as
-- blocking — which would park deleted sessions in the payout coverage
-- denominator permanently, the exact drag this removes. The proof lives in the
-- activity mirror: a `SessionDeletedEvent` row in `wise_activity_events`.
--
-- Additive and nullable, so the currently-deployed build ignores it.
ALTER TABLE "post_class_sessions" ADD COLUMN "wise_deleted_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "pc_sessions_wise_deleted_idx" ON "post_class_sessions" USING btree ("wise_deleted_at") WHERE "post_class_sessions"."wise_deleted_at" IS NOT NULL;
