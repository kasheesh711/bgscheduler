import type { FeedbackEventEvidence } from "./types";

// ── Wise feedback activity events ───────────────────────────────────────
//
// Pure projection of a persisted `SessionFeedbackSubmittedEvent` row. Kept
// out of `repository.ts` so it stays importable without the `server-only`
// database dependency chain.

export interface PostClassActivityEventRow {
  rowId: string;
  eventId: string;
  eventTimestamp: Date;
  actorWiseUserId: string | null;
  actorName: string | null;
  actorRole: string | null;
  payload: Record<string, unknown>;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function nestedValue(value: unknown, path: string[]): unknown {
  let current = value;
  for (const part of path) {
    if (!current || typeof current !== "object" || Array.isArray(current)) return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function nestedString(value: unknown, paths: string[][]): string | null {
  for (const path of paths) {
    const result = nonEmptyString(nestedValue(value, path));
    if (result) return result;
    const object = asRecord(nestedValue(value, path));
    const objectId = nonEmptyString(object._id) ?? nonEmptyString(object.id);
    if (objectId) return objectId;
  }
  return null;
}

function nestedBoolean(value: unknown, paths: string[][]): boolean | null {
  for (const path of paths) {
    const result = nestedValue(value, path);
    if (typeof result === "boolean") return result;
  }
  return null;
}

/**
 * Project a persisted `SessionFeedbackSubmittedEvent` row into timing and
 * authorship evidence.
 *
 * Wise emits the auto-submission flag at `payload.session.autoSubmitted` and
 * omits the actor object entirely for auto-submissions. No production row has
 * ever carried a submission id, so `submissionId` is almost always null and
 * event-to-submission binding must not be relied on for timing.
 */
export function toFeedbackEventEvidence(
  sessionId: string,
  row: PostClassActivityEventRow,
): FeedbackEventEvidence {
  return {
    activityEventRowId: row.rowId,
    eventId: row.eventId,
    sessionId,
    submissionId: nestedString(row.payload, [
      ["submissionId"],
      ["feedbackSubmissionId"],
      ["feedbackSubmission", "id"],
      ["feedbackSubmission", "_id"],
    ]),
    eventTimestamp: row.eventTimestamp,
    // `payload.session.autoSubmitted` is the only path Wise actually uses. The
    // rest are defensive fallbacks that have never matched a production row.
    autoSubmitted: nestedBoolean(row.payload, [
      ["session", "autoSubmitted"],
      ["autoSubmitted"],
      ["feedback", "autoSubmitted"],
      ["feedbackSubmission", "autoSubmitted"],
    ]),
    actorWiseUserId: row.actorWiseUserId,
    actorName: row.actorName,
    actorRole: row.actorRole,
  };
}
