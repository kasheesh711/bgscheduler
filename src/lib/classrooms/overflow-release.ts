import { createHash } from "node:crypto";
import type { AssignmentSession } from "./assignment-engine";
import { isOnlineSessionType } from "./session-mode";
import type { OverflowPlan } from "./overflow-types";

/** Identical occurrence and roster required; tutor account twins share a canonical key. */
export function overflowLessonKey(row: Pick<AssignmentSession, "wiseSessionId" | "wiseClassId" | "canonicalKey" | "wiseTeacherId" | "startTime" | "endTime" | "studentIds">): string {
  return createHash("sha256").update(JSON.stringify([row.wiseSessionId, row.wiseClassId,
    row.canonicalKey || row.wiseTeacherId, new Date(row.startTime).toISOString(), new Date(row.endTime).toISOString(),
    row.studentIds ? [...row.studentIds].sort() : null])).digest("hex").slice(0, 24);
}

export function carriedOverflowRelease(session: AssignmentSession, previous?: AssignmentSession): string | null {
  return previous?.overflowReleaseRoom && isOnlineSessionType(previous.sessionType) && isOnlineSessionType(session.sessionType)
    && overflowLessonKey(previous) === overflowLessonKey(session) ? previous.overflowReleaseRoom : null;
}

/** A suggestion has no effect until both the snapshot and a complete live read confirm ONLINE. */
export function confirmedSuggestedRelease(session: AssignmentSession, plan: OverflowPlan | null, verifiedOnline: ReadonlySet<string>): string | null {
  if (!isOnlineSessionType(session.sessionType) || !verifiedOnline.has(session.wiseSessionId)) return null;
  return plan?.proposedActions.find(action => action.kind === "switch_to_online" && action.wiseSessionId === session.wiseSessionId
    && action.lessonKey === overflowLessonKey(session))?.room ?? null;
}
