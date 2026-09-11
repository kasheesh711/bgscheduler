import { createWiseClient } from "@/lib/wise/client";
import { fetchAllFutureSessions, fetchWiseSessionDetail } from "@/lib/wise/fetchers";
import { fetchCreditStudents } from "@/lib/credit-control/wise";
import { getWiseSessionClassId, getWiseSessionTeacherUserId, type WiseSession } from "@/lib/wise/types";
import { getClassroomSessionMode } from "./session-mode";
import { classroomTimestampToWiseIso } from "./timestamps";

export interface PrintRosterSource {
  id: string;
  wiseSessionId: string;
  wiseClassId: string | null;
  wiseTeacherUserId?: string | null;
  /** Database timestamps encode Bangkok wall-clock time in UTC Date fields. */
  startTime: Date;
  endTime: Date;
  sessionType: string | null;
}
export interface PrintRoster {
  students: string[];
  studentCount: number;
  rosterStatus: "verified" | "incomplete" | "unavailable";
  sessionState: "current" | "cancelled" | "rescheduled" | "unverified";
  warnings: string[];
}

function studentRefs(session?: WiseSession) {
  const refs = new Map<string, string>();
  let invalid = false;
  for (const ref of Array.isArray(session?.students) ? session.students : []) {
    const id = (typeof ref === "string" ? ref : ref?._id)?.trim();
    if (!id) { invalid = true; continue; }
    const name = typeof ref === "object" && typeof ref.name === "string" ? ref.name.trim() : "";
    if (!refs.has(id) || name) refs.set(id, name);
  }
  return { refs, invalid };
}

/** Only a session's explicit student membership establishes who attends it. */
export function projectPrintRoster(source: PrintRosterSource, session: WiseSession | undefined, names: ReadonlyMap<string, string>): PrintRoster {
  if (!session || session._id !== source.wiseSessionId) return { students: [], studentCount: 0, rosterStatus: "unavailable", sessionState: "unverified", warnings: ["Session could not be verified in Wise. Retry before printing."] };
  const warnings: string[] = [];
  const start = Date.parse(session.scheduledStartTime), end = Date.parse(session.scheduledEndTime);
  const cancelled = ["CANCELLED", "CANCELED"].includes(session.meetingStatus?.trim().toUpperCase() ?? "");
  const validTimes = Number.isFinite(start) && Number.isFinite(end) && end > start;
  const classChanged = Boolean(source.wiseClassId && getWiseSessionClassId(session) && source.wiseClassId !== getWiseSessionClassId(session));
  const teacherChanged = Boolean(source.wiseTeacherUserId && getWiseSessionTeacherUserId(session) && source.wiseTeacherUserId !== getWiseSessionTeacherUserId(session));
  const savedMode = getClassroomSessionMode(source.sessionType), liveMode = getClassroomSessionMode(session.type);
  const changed = validTimes && (start !== Date.parse(classroomTimestampToWiseIso(source.startTime)) || end !== Date.parse(classroomTimestampToWiseIso(source.endTime)) || classChanged || teacherChanged
    || (savedMode !== "unknown" && liveMode !== "unknown" && savedMode !== liveMode));
  const sessionState = cancelled ? "cancelled" : !validTimes ? "unverified" : changed ? "rescheduled" : "current";
  if (cancelled) warnings.push("Cancelled in Wise. Regenerate assignments.");
  else if (changed) warnings.push("Session changed in Wise. Saved time, tutor or room may be outdated; regenerate assignments.");
  else if (!validTimes) warnings.push("Session time could not be verified in Wise. Retry before printing.");

  const { refs, invalid } = studentRefs(session);
  const resolved = [...refs].map(([id, name]) => ({ id, name: name || names.get(id)?.trim() || "" }));
  const students = resolved.filter(student => student.name).sort((a, b) => a.name.localeCompare(b.name, "th") || a.id.localeCompare(b.id)).map(student => student.name);
  const expectedCount = typeof session.studentCount === "number" && Number.isFinite(session.studentCount) ? Math.max(0, session.studentCount) : refs.size;
  const incomplete = !Array.isArray(session.students) || invalid || students.length !== refs.size || expectedCount > refs.size;
  if (incomplete) warnings.push(`Student list incomplete: ${students.length} named${expectedCount > students.length ? ` of at least ${expectedCount}` : ""}. Check with the team.`);
  return { students, studentCount: Math.max(expectedCount, refs.size), rosterStatus: incomplete ? "incomplete" : "verified", sessionState, warnings };
}

export async function loadPrintRosters(rows: PrintRosterSource[]) {
  const checkedAt = new Date().toISOString();
  if (!rows.length) return { checkedAt, refreshFailed: false, byRow: new Map<string, PrintRoster>() };
  const client = createWiseClient();
  const instituteId = process.env.WISE_INSTITUTE_ID ?? "696e1f4d90102225641cc413";
  const deadlineAt = Date.now() + 90_000;
  // One strict, uncached institute sweep for the entire one-to-seven-day report.
  const future = await fetchAllFutureSessions(client, instituteId, { strict: true, deadlineAt });
  const sessions = new Map(future.map(session => [session._id, session]));
  let refreshFailed = false;
  const uniqueRows = [...new Map(rows.map(row => [row.wiseSessionId, row])).values()];
  const needsDetail = uniqueRows.filter(row => {
    const session = sessions.get(row.wiseSessionId);
    return Date.parse(classroomTimestampToWiseIso(row.startTime)) <= Date.now() || !session || !Array.isArray(session.students) || studentRefs(session).invalid
      || (typeof session.studentCount === "number" && session.studentCount > studentRefs(session).refs.size);
  });
  // Bound fallback concurrency and stop queued work once the overall deadline expires.
  let index = 0;
  await Promise.all(Array.from({ length: Math.min(5, needsDetail.length) }, async () => {
    while (index < needsDetail.length) {
      const row = needsDetail[index++];
      const liveSession = sessions.get(row.wiseSessionId);
      // An exact session match can supply a missing or changed class ID. It
      // only locates the detail endpoint; membership still comes from students.
      const classId = (liveSession && getWiseSessionClassId(liveSession)) || row.wiseClassId;
      if (!classId) { sessions.delete(row.wiseSessionId); continue; }
      try {
        if (Date.now() >= deadlineAt) throw new Error("Roster refresh timed out");
        sessions.set(row.wiseSessionId, await fetchWiseSessionDetail(client, classId, row.wiseSessionId, { deadlineAt }));
      } catch {
        refreshFailed = true;
        sessions.delete(row.wiseSessionId);
      }
    }
  }));
  const names = new Map<string, string>();
  if (uniqueRows.some(row => [...studentRefs(sessions.get(row.wiseSessionId)).refs.values()].some(name => !name))) {
    try {
      for (const student of await fetchCreditStudents(client, instituteId, { deadlineAt })) names.set(student._id, student.name);
    } catch { refreshFailed = true; }
  }
  return { checkedAt, refreshFailed, byRow: new Map(rows.map(row => [row.id, projectPrintRoster(row, sessions.get(row.wiseSessionId), names)])) };
}
