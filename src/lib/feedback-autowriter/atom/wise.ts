import type { WiseClient } from "@/lib/wise/client";
import { fetchWiseSessionsForBangkokDates } from "@/lib/wise/day-sessions";
import { fetchAllFutureSessions } from "@/lib/wise/fetchers";
import type { WiseSession } from "@/lib/wise/types";
import { bangkokDate, evidenceHash } from "./evidence";

const refId = (ref: unknown) => typeof ref === "string" ? ref
  : ref && typeof ref === "object" && "_id" in ref ? ref._id : null;

/** The statuses `lessonsFromWise` drops. Both must use this one rule, or the PAST/FUTURE check below stops failing closed. */
export const isCancelledWiseSession = (session: Pick<WiseSession, "meetingStatus">) =>
  /^CANCELL?ED$/iu.test(session.meetingStatus ?? "");

/** Who and when. The meeting status is compared separately: it legitimately moves as a class ends. */
function ownership(session: WiseSession) {
  return evidenceHash({
    start: session.scheduledStartTime, end: session.scheduledEndTime,
    teacher: refId(session.userId), students: session.students?.map(refId).sort(),
    title: session.title, type: session.type,
    classId: refId(session.classId),
    programme: typeof session.classId === "object" ? session.classId.subject : null,
  });
}

/** FUTURE ignores DATE boundaries in live Wise responses. Read its complete COUNT
 * listing, then select exact Bangkok dates. PAST retains its strict day reader. */
export async function fetchAtomLessonTimetable(client: WiseClient, instituteId: string, dates: string[],
  options: { now?: Date; deadlineAt: number }) {
  const today = bangkokDate((options.now ?? new Date()).toISOString());
  const unique = [...new Set(dates)].sort();
  if (unique.some(date => !/^\d{4}-\d{2}-\d{2}$/u.test(date) || !Number.isFinite(Date.parse(date + "T00:00:00Z"))
    || new Date(date + "T00:00:00Z").toISOString().slice(0, 10) !== date)) throw new Error("Invalid Wise calendar date");
  const past = await fetchWiseSessionsForBangkokDates(client, instituteId, unique.filter(date => date <= today),
    { ...options, pastOnly: true });
  const futureDates = new Set(unique.filter(date => date >= today));
  const future = futureDates.size ? await fetchAllFutureSessions(client, instituteId,
    { strict: true, deadlineAt: options.deadlineAt }) : [];
  const result = new Map(past.map(session => [session._id, session]));
  for (const session of future) {
    if (!futureDates.has(bangkokDate(session.scheduledStartTime))) continue;
    const previous = result.get(session._id);
    // A class may appear in both statuses as it ends, with FUTURE still showing its
    // earlier meeting status for some minutes (likely cause of the 2 Oct 2026 17:36
    // BKK collection failure). The PAST
    // record is retained. Conflicting ownership or timing, or a cancellation on
    // only one side, must still fail closed.
    if (previous && (ownership(previous) !== ownership(session) || isCancelledWiseSession(previous) !== isCancelledWiseSession(session))) {
      throw new Error("Wise timetable occurrences conflict");
    }
    if (!previous) result.set(session._id, session);
  }
  return [...result.values()];
}
