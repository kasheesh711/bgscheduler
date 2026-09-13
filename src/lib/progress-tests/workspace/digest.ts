import { and, eq, gte, isNull } from "drizzle-orm";
import type { Database } from "@/lib/db";
import * as s from "@/lib/db/schema";
import { cyclePosition } from "./model";

export async function workspaceDigest(db: Database, launchedAt: Date) {
  const rows = await db.select({ a: s.ptAssessments, series: s.ptSeries }).from(s.ptAssessments).innerJoin(s.ptSeries,eq(s.ptAssessments.seriesId,s.ptSeries.id)).where(eq(s.ptSeries.classType,"ONE_TO_ONE"));
  const unresolved = await db.select({ student: s.progressTestAttendanceLedger.studentName, course:s.progressTestAttendanceLedger.subject }).from(s.progressTestAttendanceLedger)
    .where(and(gte(s.progressTestAttendanceLedger.scheduledStartTime,launchedAt),isNull(s.progressTestAttendanceLedger.tutorCanonicalKey),eq(s.progressTestAttendanceLedger.countsTowardCycle,true)));
  const outstanding = rows.filter(({ a }) => !(a.approvedReviewId && a.approvedReviewId === a.currentReviewId));
  const view = ({ a,series }: typeof rows[number]) => ({ studentName:series.studentName,subject:`${series.courseName} · cycle ${a.cycle}, class ${a.cycle*8}`,currentCount:cyclePosition(series.count,a.cycle),tutorDisplayName:series.tutorName });
  return { approaching:outstanding.filter(({ a,series }) => { const pos=cyclePosition(series.count,a.cycle);return pos>=6 && pos<8; }).map(view),
    due:outstanding.filter(({ a,series }) => cyclePosition(series.count,a.cycle)>=8).map(view),
    unresolvedEmails:[...unresolved.map(r => `Instructor identity unresolved: ${r.student} · ${r.course}`),
      ...rows.filter(r => r.a.notificationError).map(r => `Reminder delivery needs review: ${r.series.studentName} · ${r.series.tutorName}`),
      ...rows.filter(r => ["failed","blocked"].includes(r.a.publicationStatus)).map(r => `Publication ${r.a.publicationStatus}: ${r.series.studentName} · cycle ${r.a.cycle}`)],
    tutorWorkflow:true,
  };
}
