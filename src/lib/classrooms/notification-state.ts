import { and, eq } from "drizzle-orm";
import type { Database } from "@/lib/db";
import * as schema from "@/lib/db/schema";
import { bangkokDateKey } from "@/lib/room-capacity/dates";
import { getLocalMinuteOfDay } from "@/lib/normalization/timezone";
import type { AssignmentSession } from "./assignment-engine";

/** Date-wide, canonical identity check survives both run and snapshot rotation. */
export async function notifiedTutorKeys(db: Database, date: string): Promise<Set<string>> {
  const rows = await db.select({ canonicalKey: schema.classroomScheduleEmailRecipients.canonicalKey })
    .from(schema.classroomScheduleEmailRecipients)
    .innerJoin(schema.classroomAssignmentRuns, eq(schema.classroomScheduleEmailRecipients.assignmentRunId, schema.classroomAssignmentRuns.id))
    .where(and(eq(schema.classroomAssignmentRuns.assignmentDate, date), eq(schema.classroomScheduleEmailRecipients.status, "sent")));
  return new Set(rows.map(row => row.canonicalKey.toLowerCase()));
}

export function preferenceFrozenSessionIds(sessions: AssignmentSession[], date: string, notified: ReadonlySet<string>, now = new Date()): Set<string> {
  const today = bangkokDateKey(now);
  const cutoff = date < today ? Infinity : date > today ? -Infinity : getLocalMinuteOfDay(now);
  return new Set(sessions.filter(row => row.startMinute <= cutoff || (row.canonicalKey && notified.has(row.canonicalKey.toLowerCase()))).map(row => row.wiseSessionId));
}
