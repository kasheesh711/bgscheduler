import { createHash } from "node:crypto";
import { and, desc, gte, inArray, sql } from "drizzle-orm";
import type { Database } from "@/lib/db";
import * as schema from "@/lib/db/schema";
import { sessionStudentIds } from "@/lib/normalization/sessions";
import type { WiseSession } from "@/lib/wise/types";
import { getClassroomSessionMode } from "./session-mode";
import { studentModeEvidence, type ModeObservation } from "./mode-history";
import { attendedWiseStudentIds } from "@/lib/onsite-foot-traffic/model";
import { classroomTimestampToWiseIso } from "./timestamps";

const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

export function observationsFromWise(sessions: WiseSession[], observedAt: Date): ModeObservation[] {
  return sessions.flatMap(session => {
    const ids = sessionStudentIds(session);
    if (!ids?.length || !Number.isFinite(Date.parse(session.scheduledStartTime))
      || !Number.isFinite(Date.parse(session.scheduledEndTime))) return [];
    if (typeof session.studentCount === "number" && session.studentCount !== ids.length) return [];
    const status = String(session.meetingStatus ?? "").toUpperCase();
    const ended = ["ENDED", "COMPLETED"].includes(status) && Date.parse(session.scheduledEndTime) < observedAt.getTime();
    const attendedIds = attendedWiseStudentIds(session);
    return ids.map(studentId => {
      return { wiseSessionId: session._id, studentId, rosterKey: digest([...ids].sort()),
        mode: getClassroomSessionMode(session.type), scheduledStartAt: new Date(session.scheduledStartTime).toISOString(),
        scheduledEndAt: new Date(session.scheduledEndTime).toISOString(), observedAt: observedAt.toISOString(),
        attended: ended && attendedIds.has(studentId), cancelled: ["CANCELLED", "CANCELED", "NO_SHOW", "MISSED"].includes(status) };
    });
  });
}

/** Append only real evidence changes. Idempotent source IDs also fence concurrent duplicate writes. */
export async function recordModeObservations(db: Database, observations: ModeObservation[], source: string): Promise<number> {
  if (!observations.length) return 0;
  let inserted = 0;
  for (let offset = 0; offset < observations.length; offset += 250) {
    const chunk = observations.slice(offset, offset + 250);
    const latest = await db.selectDistinctOn([schema.classroomModeHistory.wiseSessionId, schema.classroomModeHistory.studentId])
      .from(schema.classroomModeHistory).where(inArray(schema.classroomModeHistory.wiseSessionId, [...new Set(chunk.map(row => row.wiseSessionId))]))
      .orderBy(schema.classroomModeHistory.wiseSessionId, schema.classroomModeHistory.studentId, desc(schema.classroomModeHistory.observedAt));
    const known = new Map(latest.map(row => [`${row.wiseSessionId}:${row.studentId}`, row.stateHash]));
    const rows = chunk.flatMap(row => {
      const { observedAt, ...state } = row;
      const stateHash = digest(state), key = `${row.wiseSessionId}:${row.studentId}`;
      if (known.get(key) === stateHash) return [];
      known.set(key, stateHash);
      return [{ ...row, scheduledStartAt: new Date(row.scheduledStartAt), scheduledEndAt: new Date(row.scheduledEndAt),
        observedAt: new Date(observedAt), source, stateHash, evidenceKey: digest([source, key, observedAt, stateHash]) }];
    });
    if (rows.length) inserted += (await db.insert(schema.classroomModeHistory).values(rows).onConflictDoNothing()
      .returning({ id: schema.classroomModeHistory.id })).length;
  }
  return inserted;
}

/** Existing per-student attendance joined by exact session ID, never by class/student name. */
export async function loadAttendanceObservations(db: Database, studentIds: string[], now: Date): Promise<ModeObservation[]> {
  if (!studentIds.length) return [];
  const cutoff = new Date(now.getTime() - 180 * 86_400_000);
  const result = await db.execute(sql`
    SELECT c.wise_session_id, c.wise_student_id, c.scheduled_start_time, c.scheduled_end_time,
      f.session_type, f.synced_at,
      (SELECT jsonb_agg(roster.wise_student_id ORDER BY roster.wise_student_id)
       FROM credit_control_sessions roster WHERE roster.snapshot_id = c.snapshot_id
       AND roster.wise_session_id = c.wise_session_id) AS roster
    FROM credit_control_sessions c
    JOIN credit_control_snapshots snap ON snap.id = c.snapshot_id AND snap.active = true
    JOIN onsite_foot_traffic_sessions f ON f.wise_session_id = c.wise_session_id
    WHERE c.wise_student_id IN (${sql.join(studentIds.map(id => sql`${id}`), sql`, `)})
      AND c.scheduled_start_time >= ${cutoff.toISOString()}::timestamptz
      AND c.scheduled_end_time < ${now.toISOString()}::timestamptz
      AND c.session_kind = 'past' AND c.credit_applied > 0
      AND UPPER(c.meeting_status) IN ('ENDED','COMPLETED')
      AND UPPER(f.wise_status) IN ('ENDED','COMPLETED')
      AND c.scheduled_start_time = f.scheduled_start_at AND c.scheduled_end_time = f.scheduled_end_at
      AND EXISTS (SELECT 1 FROM credit_control_sync_runs cs
        WHERE cs.promoted_snapshot_id = c.snapshot_id AND cs.status = 'success')
      AND EXISTS (SELECT 1 FROM onsite_foot_traffic_sync_runs fs
        WHERE fs.id = f.last_sync_run_id AND fs.status = 'success')
  `);
  const rows = (Array.isArray(result) ? result : result.rows) as Array<Record<string, unknown>>;
  return rows.flatMap(row => {
    const mode = getClassroomSessionMode(String(row.session_type ?? ""));
    if (mode === "unknown" || !Array.isArray(row.roster)) return [];
    return [{ wiseSessionId: String(row.wise_session_id), studentId: String(row.wise_student_id),
      // Credit Control is a per-student source, not a complete authoritative class roster.
      // This fallback may establish attendance, but can never establish a modality transition.
      rosterKey: `attendance-only:${digest([...new Set(row.roster)].sort())}`, mode,
      scheduledStartAt: new Date(String(row.scheduled_start_time)).toISOString(),
      scheduledEndAt: new Date(String(row.scheduled_end_time)).toISOString(),
      observedAt: new Date(String(row.synced_at)).toISOString(), attended: true, cancelled: false }];
  });
}

export async function loadStudentModeEvidence(db: Database, studentIds: string[], now: Date) {
  const unique = [...new Set(studentIds)].sort();
  if (!unique.length) return studentModeEvidence([], [], now);
  const history = await db.select().from(schema.classroomModeHistory).where(and(
    inArray(schema.classroomModeHistory.studentId, unique),
    gte(schema.classroomModeHistory.scheduledStartAt, new Date(now.getTime() - 180 * 86_400_000)),
  ));
  const observations: ModeObservation[] = history.map(row => ({ ...row, mode: getClassroomSessionMode(row.mode),
    scheduledStartAt: row.scheduledStartAt.toISOString(), scheduledEndAt: row.scheduledEndAt.toISOString(), observedAt: row.observedAt.toISOString() }));
  const attended = await loadAttendanceObservations(db, unique, now);
  // At the same observation time the attendance-backed row supplies stronger positive evidence.
  const byKey = new Map(observations.map(row => [`${row.studentId}:${row.wiseSessionId}:${row.observedAt}`, row]));
  for (const row of attended) {
    const key = `${row.studentId}:${row.wiseSessionId}:${row.observedAt}`;
    if (!byKey.get(key)?.attended) byKey.set(key, row);
  }
  return studentModeEvidence([...byKey.values()], unique, now);
}

/** Read existing successful snapshots and attended records. No activity-event/name inference. */
export async function loadBootstrapModeObservations(db: Database, now = new Date()): Promise<ModeObservation[]> {
  const result = await db.execute(sql`
    SELECT f.wise_session_id, f.student_ids, f.session_type, f.start_time, f.end_time,
      f.wise_status, s.finished_at
    FROM future_session_blocks f
    JOIN sync_runs s ON s.promoted_snapshot_id = f.snapshot_id AND s.status = 'success'
    WHERE f.student_ids IS NOT NULL AND s.finished_at IS NOT NULL
      AND f.end_time >= ${new Date(now.getTime() - 180 * 86_400_000).toISOString()}::timestamp
    ORDER BY s.finished_at, f.wise_session_id
  `);
  const rows = (Array.isArray(result) ? result : result.rows) as Array<Record<string, unknown>>;
  const observations = rows.flatMap(row => observationsFromWise([{
    _id: String(row.wise_session_id), students: row.student_ids as string[],
    type: String(row.session_type ?? ""), meetingStatus: String(row.wise_status ?? ""),
    scheduledStartTime: classroomTimestampToWiseIso(new Date(String(row.start_time))),
    scheduledEndTime: classroomTimestampToWiseIso(new Date(String(row.end_time))),
  }], new Date(String(row.finished_at))));
  const students = await db.execute(sql`SELECT DISTINCT wise_student_id FROM credit_control_sessions c
    JOIN credit_control_snapshots s ON s.id = c.snapshot_id AND s.active = true
    WHERE c.scheduled_start_time >= ${new Date(now.getTime() - 180 * 86_400_000).toISOString()}::timestamptz`);
  const ids = ((Array.isArray(students) ? students : students.rows) as Array<{ wise_student_id: string }>).map(row => row.wise_student_id);
  for (let offset = 0; offset < ids.length; offset += 250) observations.push(...await loadAttendanceObservations(db, ids.slice(offset, offset + 250), now));
  return observations.sort((a, b) => a.observedAt.localeCompare(b.observedAt));
}
