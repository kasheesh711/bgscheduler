import { revalidateTag } from "next/cache";
import { sql } from "drizzle-orm";
import type { Database } from "@/lib/db";
import * as schema from "@/lib/db/schema";
import type { WiseClient } from "@/lib/wise/client";
import { CREDIT_CONTROL_CACHE_TAG, EXCLUDED_PACKAGE_KEYWORDS } from "@/lib/credit-control/config";
import { buildDashboardStudentKey, buildStudentPackageKey, normalizeText } from "@/lib/credit-control/helpers";
import {
  durationMsToMinutes,
  fetchCreditSessions,
  fetchCreditStudents,
  fetchSessionCredits,
  fetchSessionTeacherFeedback,
  type WiseCreditSession,
  type WiseCreditStudent,
  type WiseSessionCredits,
} from "@/lib/credit-control/wise";

interface PairRecord {
  wiseStudentId: string;
  wiseClassId: string;
  studentName: string;
  parentName: string;
  email?: string;
  activated: boolean;
  packageName: string;
  subject: string;
  classType?: string;
}

interface PairCreditRecord extends PairRecord {
  credits: WiseSessionCredits["credits"];
  history: WiseSessionCredits["sessionCreditHistory"];
}

interface SessionCreditRows {
  sessions: Array<typeof schema.creditControlSessions.$inferInsert>;
  histories: Array<typeof schema.creditControlCreditHistory.$inferInsert>;
}

export interface CreditControlSyncResult {
  success: boolean;
  snapshotId?: string;
  promotedSnapshotId?: string;
  studentCount: number;
  packageCount: number;
  sessionCount: number;
  failedCreditPairs: number;
  errorSummary?: string;
}

const PAST_WINDOW_DAYS = 120;
const FUTURE_WINDOW_DAYS = 180;
const CREDIT_PAIR_CONCURRENCY = 8;
const FEEDBACK_CONCURRENCY = 6;

function addDays(date: Date, days: number): Date {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
}

function chunk<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) chunks.push(items.slice(i, i + size));
  return chunks;
}

async function mapLimit<T, R>(
  items: T[],
  limit: number,
  mapper: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await mapper(items[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}

function parentNameFor(student: WiseCreditStudent): string {
  return student.parents.find((parent) => parent.name)?.name?.trim() ?? "";
}

function packageExclusionReason(packageName: string, subject: string): string | null {
  const haystack = `${normalizeText(packageName)} ${normalizeText(subject)}`;
  return EXCLUDED_PACKAGE_KEYWORDS.find((keyword) => haystack.includes(keyword)) ?? null;
}

function sessionClass(session: WiseCreditSession) {
  return {
    id: session.classId._id,
    name: session.classId.name ?? session.classId.subject ?? session.classId._id,
    subject: session.classId.subject ?? "",
    classType: session.classId.classType,
  };
}

function collectPairs(
  students: WiseCreditStudent[],
  pastSessions: WiseCreditSession[],
  futureSessions: WiseCreditSession[],
): PairRecord[] {
  const studentsById = new Map(students.map((student) => [student._id, student]));
  const pairs = new Map<string, PairRecord>();

  function addPair(student: WiseCreditStudent, wiseClassId: string, packageName: string, subject: string, classType?: string) {
    const parentName = parentNameFor(student);
    const key = `${wiseClassId}|${student._id}`;
    const existing = pairs.get(key);
    pairs.set(key, {
      wiseStudentId: student._id,
      wiseClassId,
      studentName: student.name,
      parentName,
      email: student.email,
      activated: student.activated,
      packageName: existing?.packageName && existing.packageName !== wiseClassId ? existing.packageName : packageName,
      subject: existing?.subject || subject,
      classType: existing?.classType ?? classType,
    });
  }

  for (const student of students) {
    if (!student.activated) continue;
    for (const classroom of student.classrooms) {
      addPair(
        student,
        classroom._id,
        classroom.name ?? classroom.subject ?? classroom._id,
        classroom.subject ?? "",
        classroom.classType,
      );
    }
  }

  for (const session of [...pastSessions, ...futureSessions]) {
    const classroom = sessionClass(session);
    for (const studentId of session.students) {
      const student = studentsById.get(studentId);
      if (!student) continue;
      addPair(student, classroom.id, classroom.name, classroom.subject, classroom.classType);
    }
  }

  return [...pairs.values()];
}

function buildStudentsRows(
  snapshotId: string,
  students: WiseCreditStudent[],
): Array<typeof schema.creditControlStudents.$inferInsert> {
  return students.map((student) => {
    const parentName = parentNameFor(student);
    return {
      snapshotId,
      wiseStudentId: student._id,
      studentKey: buildDashboardStudentKey(student.name, parentName),
      studentName: student.name,
      parentName,
      email: student.email,
      activated: student.activated,
    };
  });
}

function buildPackageRows(
  snapshotId: string,
  pairs: PairCreditRecord[],
): Array<typeof schema.creditControlPackages.$inferInsert> {
  return pairs.map((pair) => {
    const studentKey = buildDashboardStudentKey(pair.studentName, pair.parentName);
    const packageKey = buildStudentPackageKey(pair.studentName, pair.packageName);
    return {
      snapshotId,
      wiseStudentId: pair.wiseStudentId,
      wiseClassId: pair.wiseClassId,
      studentKey,
      packageKey,
      studentName: pair.studentName,
      parentName: pair.parentName,
      packageName: pair.packageName,
      subject: pair.subject,
      classType: pair.classType,
      totalCredits: pair.credits.total,
      consumedCredits: pair.credits.consumed,
      remainingCredits: pair.credits.remaining,
      availableCredits: pair.credits.available,
      bookedSessions: pair.credits.bookedSessions,
      excludedReason: packageExclusionReason(pair.packageName, pair.subject),
    };
  });
}

async function fetchPairCredits(
  client: WiseClient,
  instituteId: string,
  pairs: PairRecord[],
): Promise<{ records: PairCreditRecord[]; failed: number }> {
  let failed = 0;
  const results = await mapLimit(pairs, CREDIT_PAIR_CONCURRENCY, async (pair) => {
    try {
      const credits = await fetchSessionCredits(client, instituteId, pair.wiseClassId, pair.wiseStudentId);
      return { ...pair, credits: credits.credits, history: credits.sessionCreditHistory } satisfies PairCreditRecord;
    } catch {
      failed += 1;
      return null;
    }
  });
  return {
    records: results.filter((record): record is PairCreditRecord => Boolean(record)),
    failed,
  };
}

async function buildSessionRows(
  client: WiseClient,
  snapshotId: string,
  creditPairs: PairCreditRecord[],
  pastSessions: WiseCreditSession[],
  futureSessions: WiseCreditSession[],
): Promise<SessionCreditRows> {
  const pairsByKey = new Map(creditPairs.map((pair) => [`${pair.wiseClassId}|${pair.wiseStudentId}`, pair]));
  const positiveCreditByPairSession = new Map<string, number>();
  const histories: Array<typeof schema.creditControlCreditHistory.$inferInsert> = [];

  for (const pair of creditPairs) {
    const packageKey = buildStudentPackageKey(pair.studentName, pair.packageName);
    for (const history of pair.history) {
      const credit = Number(history.credit) || 0;
      if (credit > 0) {
        positiveCreditByPairSession.set(`${pair.wiseClassId}|${pair.wiseStudentId}|${history._id}`, credit);
      }
      histories.push({
        snapshotId,
        wiseCreditHistoryId: history._id,
        wiseStudentId: pair.wiseStudentId,
        wiseClassId: pair.wiseClassId,
        packageKey,
        credit,
        type: history.type,
        meetingStatus: history.meetingStatus,
        durationMinutes: durationMsToMinutes(history.duration),
        createdAtWise: history.createdAt,
        raw: JSON.parse(JSON.stringify(history)) as Record<string, unknown>,
      });
    }
  }

  const feedbackCandidates = new Map<string, { classId: string; sessionId: string }>();
  for (const session of pastSessions) {
    if (session.meetingStatus.toUpperCase() !== "ENDED") continue;
    for (const studentId of session.students) {
      const classId = session.classId._id;
      if (!pairsByKey.has(`${classId}|${studentId}`)) continue;
      if (positiveCreditByPairSession.has(`${classId}|${studentId}|${session._id}`)) continue;
      feedbackCandidates.set(session._id, { classId, sessionId: session._id });
    }
  }

  const feedbackEntries = await mapLimit([...feedbackCandidates.values()], FEEDBACK_CONCURRENCY, async (candidate) => {
    try {
      return [candidate.sessionId, await fetchSessionTeacherFeedback(client, candidate.classId, candidate.sessionId)] as const;
    } catch {
      return [candidate.sessionId, ""] as const;
    }
  });
  const feedbackBySessionId = new Map(feedbackEntries);

  const rows: Array<typeof schema.creditControlSessions.$inferInsert> = [];
  function addSessions(sessions: WiseCreditSession[], kind: "past" | "future") {
    for (const session of sessions) {
      const durationMinutes = durationMsToMinutes(session.duration);
      for (const studentId of session.students) {
        const pair = pairsByKey.get(`${session.classId._id}|${studentId}`);
        if (!pair) continue;
        const packageKey = buildStudentPackageKey(pair.studentName, pair.packageName);
        rows.push({
          snapshotId,
          wiseSessionId: session._id,
          wiseClassId: pair.wiseClassId,
          wiseStudentId: pair.wiseStudentId,
          studentKey: buildDashboardStudentKey(pair.studentName, pair.parentName),
          packageKey,
          studentName: pair.studentName,
          packageName: pair.packageName,
          subject: pair.subject,
          scheduledStartTime: session.scheduledStartTime,
          scheduledEndTime: session.scheduledEndTime,
          durationMinutes,
          meetingStatus: session.meetingStatus.toUpperCase(),
          sessionKind: kind,
          teacherFeedback: kind === "past" ? feedbackBySessionId.get(session._id) ?? "" : null,
          creditApplied: kind === "past"
            ? positiveCreditByPairSession.get(`${pair.wiseClassId}|${pair.wiseStudentId}|${session._id}`) ?? 0
            : 0,
        });
      }
    }
  }

  addSessions(pastSessions, "past");
  addSessions(futureSessions, "future");
  return { sessions: rows, histories };
}

async function insertChunks<T extends Record<string, unknown>>(
  db: Database,
  table: Parameters<Database["insert"]>[0],
  rows: T[],
): Promise<void> {
  for (const part of chunk(rows, 500)) {
    if (part.length > 0) await db.insert(table).values(part as never);
  }
}

export async function runCreditControlSync(
  db: Database,
  client: WiseClient,
  instituteId: string,
  now = new Date(),
  options: { syncRunId?: string } = {},
): Promise<CreditControlSyncResult> {
  const run = options.syncRunId
    ? { id: options.syncRunId }
    : (await db
      .insert(schema.creditControlSyncRuns)
      .values({ status: "running", startedAt: now })
      .returning({ id: schema.creditControlSyncRuns.id }))[0];

  try {
    const pastStart = addDays(now, -PAST_WINDOW_DAYS);
    const futureEnd = addDays(now, FUTURE_WINDOW_DAYS);
    const [students, pastSessions, futureSessions] = await Promise.all([
      fetchCreditStudents(client, instituteId),
      fetchCreditSessions(client, instituteId, "PAST", pastStart, now),
      fetchCreditSessions(client, instituteId, "FUTURE", now, futureEnd),
    ]);

    const pairs = collectPairs(students, pastSessions, futureSessions);
    const { records: creditPairs, failed: failedCreditPairs } = await fetchPairCredits(client, instituteId, pairs);

    const [snapshot] = await db
      .insert(schema.creditControlSnapshots)
      .values({
        active: false,
        source: "wise",
        generatedAt: now,
        metadata: {
          pastWindowDays: PAST_WINDOW_DAYS,
          futureWindowDays: FUTURE_WINDOW_DAYS,
          rawStudents: students.length,
          rawPastSessions: pastSessions.length,
          rawFutureSessions: futureSessions.length,
          candidatePairs: pairs.length,
          failedCreditPairs,
        },
      })
      .returning({ id: schema.creditControlSnapshots.id });

    const studentRows = buildStudentsRows(snapshot.id, students);
    const packageRows = buildPackageRows(snapshot.id, creditPairs);
    const { sessions: sessionRows, histories } = await buildSessionRows(
      client,
      snapshot.id,
      creditPairs,
      pastSessions,
      futureSessions,
    );

    await insertChunks(db, schema.creditControlStudents, studentRows);
    await insertChunks(db, schema.creditControlPackages, packageRows);
    await insertChunks(db, schema.creditControlSessions, sessionRows);
    await insertChunks(db, schema.creditControlCreditHistory, histories);

    await db
      .update(schema.creditControlSnapshots)
      .set({ active: sql`(${schema.creditControlSnapshots.id} = ${snapshot.id})` });

    await db
      .update(schema.creditControlSyncRuns)
      .set({
        status: "success",
        finishedAt: new Date(),
        snapshotId: snapshot.id,
        promotedSnapshotId: snapshot.id,
        studentCount: studentRows.length,
        packageCount: packageRows.length,
        sessionCount: sessionRows.length,
        metadata: {
          failedCreditPairs,
          creditHistoryRows: histories.length,
        },
      })
      .where(sql`${schema.creditControlSyncRuns.id} = ${run.id}`);

    revalidateTag(CREDIT_CONTROL_CACHE_TAG, { expire: 0 });
    return {
      success: true,
      snapshotId: snapshot.id,
      promotedSnapshotId: snapshot.id,
      studentCount: studentRows.length,
      packageCount: packageRows.length,
      sessionCount: sessionRows.length,
      failedCreditPairs,
    };
  } catch (error) {
    const errorSummary = error instanceof Error ? error.message : "Credit control sync failed";
    await db
      .update(schema.creditControlSyncRuns)
      .set({
        status: "failed",
        finishedAt: new Date(),
        errorSummary,
      })
      .where(sql`${schema.creditControlSyncRuns.id} = ${run.id}`);
    return {
      success: false,
      studentCount: 0,
      packageCount: 0,
      sessionCount: 0,
      failedCreditPairs: 0,
      errorSummary,
    };
  }
}
