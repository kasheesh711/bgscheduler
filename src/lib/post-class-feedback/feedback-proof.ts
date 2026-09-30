import { sql, type AnyColumn, type SQL } from "drizzle-orm";

import type { FeedbackEventEvidence, FeedbackSubmitterRole } from "./types";

export const STAFF_SUBMISSION_EVIDENCE_VERSION = 2;
export type FeedbackProofExclusion = "auto_submitted" | "student_feedback" | "unverified_actor";
type ActorEvidence = Pick<FeedbackEventEvidence, "autoSubmitted" | "actorRole">;

export function feedbackSubmitterRole(event: ActorEvidence): FeedbackSubmitterRole {
  if (event.autoSubmitted === true) return "AUTO";
  const role = event.actorRole?.trim().toUpperCase();
  return role === "TEACHER" || role === "ADMIN" || role === "STUDENT" ? role : "UNKNOWN";
}

/** Only a non-automatic staff event can prove tutor submission. NULL is accepted. */
export function feedbackProofExclusion(event: ActorEvidence): FeedbackProofExclusion | null {
  const role = feedbackSubmitterRole(event);
  if (role === "AUTO") return "auto_submitted";
  if (role === "STUDENT") return "student_feedback";
  if (role === "UNKNOWN") return "unverified_actor";
  return null;
}

const AUTO_FLAG_PATHS = [
  ["session", "autoSubmitted"], ["autoSubmitted"],
  ["feedback", "autoSubmitted"], ["feedbackSubmission", "autoSubmitted"],
] as const;

export function feedbackAutoSubmittedFlag(payload: Record<string, unknown>): boolean | null {
  for (const path of AUTO_FLAG_PATHS) {
    let value: unknown = payload;
    for (const key of path) {
      value = value && typeof value === "object" && !Array.isArray(value)
        ? (value as Record<string, unknown>)[key] : undefined;
    }
    if (typeof value === "boolean") return value;
  }
  return null;
}

/** SQL projection of the same first-boolean flag extraction used by the collector. */
export function feedbackAutoSubmittedSql(payload: AnyColumn | SQL): SQL {
  return sql`case
    when jsonb_typeof(${payload} #> '{session,autoSubmitted}') = 'boolean'
      then ${payload} #>> '{session,autoSubmitted}' = 'true'
    when jsonb_typeof(${payload} -> 'autoSubmitted') = 'boolean'
      then ${payload} ->> 'autoSubmitted' = 'true'
    when jsonb_typeof(${payload} #> '{feedback,autoSubmitted}') = 'boolean'
      then ${payload} #>> '{feedback,autoSubmitted}' = 'true'
    when jsonb_typeof(${payload} #> '{feedbackSubmission,autoSubmitted}') = 'boolean'
      then ${payload} #>> '{feedbackSubmission,autoSubmitted}' = 'true'
    else null end`;
}

export function staffFeedbackEventSql(autoSubmitted: AnyColumn | SQL, actorRole: AnyColumn | SQL): SQL {
  return sql`(${autoSubmitted}) is distinct from true
    and upper(trim(coalesce(${actorRole}, ''))) in ('TEACHER', 'ADMIN')`;
}
