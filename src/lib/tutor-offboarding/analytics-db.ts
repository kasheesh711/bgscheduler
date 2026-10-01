import { and, eq, gte, lt } from "drizzle-orm";
import { getDb, type Database } from "@/lib/db";
import * as s from "@/lib/db/schema";
import { HISTORY_START } from "./calibration";
import { loadOffboardingSignals } from "./signals";
import {
  compileAnalyticsEvidence,
  type AnalyticsCompiledEvidence,
} from "./analytics";
import type { AnalyticsSession } from "./analytics-types";
import type { OffboardingAccount, PersonSignals } from "./types";

/** Postgres SELECT only. History contains confirmed ENDED rows; blocking past schedules are deliberately absent. */
export async function loadAnalyticsEvidence(
  db: Database = getDb(),
  expectedSnapshotId?: string,
  now = new Date(),
): Promise<AnalyticsCompiledEvidence | null> {
  const signals = await loadOffboardingSignals(db, now);
  if (
    !signals ||
    (expectedSnapshotId && signals.snapshotId !== expectedSnapshotId)
  )
    return null;
  const [qualifications, ledger, postClass, upcoming, accounts] =
    await Promise.all([
      db
        .select({
          canonicalKey: s.tutorIdentityGroups.canonicalKey,
          subject: s.subjectLevelQualifications.subject,
          curriculum: s.subjectLevelQualifications.curriculum,
          level: s.subjectLevelQualifications.level,
          examPrep: s.subjectLevelQualifications.examPrep,
        })
        .from(s.subjectLevelQualifications)
        .innerJoin(
          s.tutorIdentityGroups,
          eq(s.tutorIdentityGroups.id, s.subjectLevelQualifications.groupId),
        )
        .where(eq(s.subjectLevelQualifications.snapshotId, signals.snapshotId)),
      db
        .selectDistinct({
          wiseSessionId: s.progressTestAttendanceLedger.wiseSessionId,
          canonicalKey: s.progressTestAttendanceLedger.tutorCanonicalKey,
          wiseClassId: s.progressTestAttendanceLedger.wiseClassId,
          wiseCourseCategory: s.progressTestAttendanceLedger.subject,
          start: s.progressTestAttendanceLedger.scheduledStartTime,
        })
        .from(s.progressTestAttendanceLedger)
        .where(
          and(
            eq(s.progressTestAttendanceLedger.meetingStatus, "ENDED"),
            gte(
              s.progressTestAttendanceLedger.scheduledStartTime,
              HISTORY_START,
            ),
            lt(s.progressTestAttendanceLedger.scheduledStartTime, now),
          ),
        ),
      db
        .select({
          wiseSessionId: s.postClassSessions.wiseSessionId,
          canonicalKey: s.postClassSessions.canonicalTutorKey,
          wiseClassId: s.postClassSessions.wiseClassId,
          title: s.postClassSessions.className,
          start: s.postClassSessions.scheduledStartAt,
          end: s.postClassSessions.scheduledEndAt,
        })
        .from(s.postClassSessions)
        .where(
          and(
            eq(s.postClassSessions.finalStatus, "ENDED"),
            gte(s.postClassSessions.scheduledStartAt, HISTORY_START),
            lt(s.postClassSessions.scheduledStartAt, now),
          ),
        ),
      db
        .select({
          wiseSessionId: s.futureSessionBlocks.wiseSessionId,
          canonicalKey: s.tutorIdentityGroups.canonicalKey,
          wiseClassId: s.futureSessionBlocks.wiseClassId,
          title: s.futureSessionBlocks.title,
          wiseCourseCategory: s.futureSessionBlocks.subject,
          start: s.futureSessionBlocks.startTime,
          end: s.futureSessionBlocks.endTime,
        })
        .from(s.futureSessionBlocks)
        .innerJoin(
          s.tutorIdentityGroups,
          eq(s.tutorIdentityGroups.id, s.futureSessionBlocks.groupId),
        )
        .where(
          and(
            eq(s.futureSessionBlocks.snapshotId, signals.snapshotId),
            eq(s.futureSessionBlocks.isBlocking, true),
          ),
        ),
      db.select().from(s.tutorWiseAccounts),
    ]);
  const catalog = new Map<string, PersonSignals>();
  for (const a of accounts) {
    const account: OffboardingAccount = {
      wiseTeacherId: a.wiseTeacherId,
      wiseUserId: a.wiseUserId,
      displayName: a.displayName,
      isOnlineVariant: a.isOnlineVariant,
      email: a.email,
      status: a.status,
      relation: a.wiseRelation,
      joinedOn: a.wiseJoinedOn?.toISOString() ?? null,
      courseCount: a.wiseCourseCount,
      activated: a.wiseActivated,
      availabilityKnown: false,
      workingHourWindows: 0,
    };
    const p = catalog.get(a.canonicalKey) ?? {
      canonicalKey: a.canonicalKey,
      displayName: a.canonicalKey,
      accounts: [],
      lastTaughtAt: null,
      lastTaughtBySource: { ledger: null, pastBlocks: null, postClass: null },
      upcomingSessions: 0,
      nextSessionAt: null,
      upcomingLeaveUntil: null,
      lastTeacherActionAt: null,
      lastAdminActionAt: null,
      fullTime: false,
    };
    p.accounts.push(account);
    catalog.set(a.canonicalKey, p);
  }
  const history: AnalyticsSession[] = [
    ...ledger.map((r) => ({
      wiseSessionId: r.wiseSessionId,
      canonicalKey: r.canonicalKey,
      wiseClassId: r.wiseClassId,
      title: null,
      wiseCourseCategory: r.wiseCourseCategory || null,
      startAt: r.start.toISOString(),
      endAt: null,
    })),
    ...postClass.map((r) => ({
      wiseSessionId: r.wiseSessionId,
      canonicalKey: r.canonicalKey,
      wiseClassId: r.wiseClassId,
      title: r.title,
      wiseCourseCategory: null,
      startAt: r.start.toISOString(),
      endAt: r.end.toISOString(),
    })),
  ];
  return compileAnalyticsEvidence({
    signals,
    catalog: [...catalog.values()],
    qualifications,
    history,
    upcoming: upcoming.map((r) => ({
      wiseSessionId: r.wiseSessionId,
      canonicalKey: r.canonicalKey,
      wiseClassId: r.wiseClassId,
      title: r.title,
      wiseCourseCategory: r.wiseCourseCategory,
      startAt: r.start.toISOString(),
      endAt: r.end.toISOString(),
    })),
  });
}
