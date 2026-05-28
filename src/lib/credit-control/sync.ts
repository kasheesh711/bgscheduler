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
export const CREDIT_CONTROL_INSERT_CHUNK_SIZE = 100;
const ERROR_MESSAGE_MAX_LENGTH = 2_000;
const ERROR_SUMMARY_MAX_LENGTH = 2_000;
const DB_ERROR_FIELDS = [
  "code",
  "severity",
  "detail",
  "hint",
  "constraint",
  "schema",
  "table",
  "column",
] as const;

interface CreditControlInsertContext {
  tableName: string;
  totalRows: number;
  chunkIndex: number;
  chunkStart: number;
  chunkSize: number;
}

interface SerializedErrorNode {
  name: string;
  message: string;
  insert?: CreditControlInsertContext;
  fields?: Partial<Record<typeof DB_ERROR_FIELDS[number], string>>;
  cause?: SerializedErrorNode;
}

export class CreditControlInsertError extends Error {
  readonly context: CreditControlInsertContext;
  readonly cause: unknown;

  constructor(context: CreditControlInsertContext, cause: unknown) {
    super(
      `Credit control insert failed for ${context.tableName} chunk ${context.chunkIndex + 1} `
      + `(rows ${context.chunkStart + 1}-${context.chunkStart + context.chunkSize} of ${context.totalRows})`,
    );
    this.name = "CreditControlInsertError";
    this.context = context;
    this.cause = cause;
  }
}

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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function truncateText(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  return `${value.slice(0, maxLength - 3)}...`;
}

function errorName(error: unknown): string {
  if (error instanceof Error) return error.name || "Error";
  if (isRecord(error) && typeof error.name === "string") return error.name;
  return "Error";
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message || "Credit control sync failed";
  if (isRecord(error) && typeof error.message === "string") return error.message;
  return String(error || "Credit control sync failed");
}

function errorCause(error: unknown): unknown {
  if (!isRecord(error) || !("cause" in error)) return undefined;
  return error.cause;
}

function serializeDbErrorFields(error: unknown): SerializedErrorNode["fields"] | undefined {
  if (!isRecord(error)) return undefined;
  const fields: SerializedErrorNode["fields"] = {};
  for (const field of DB_ERROR_FIELDS) {
    const value = error[field];
    if (typeof value === "string" || typeof value === "number") {
      fields[field] = String(value);
    }
  }
  return Object.keys(fields).length > 0 ? fields : undefined;
}

function serializeErrorNode(error: unknown, depth = 0): SerializedErrorNode {
  const node: SerializedErrorNode = {
    name: errorName(error),
    message: truncateText(errorMessage(error), ERROR_MESSAGE_MAX_LENGTH),
  };

  if (error instanceof CreditControlInsertError) {
    node.insert = error.context;
  }

  const fields = serializeDbErrorFields(error);
  if (fields) {
    node.fields = fields;
  }

  const cause = errorCause(error);
  if (cause !== undefined && depth < 4) {
    node.cause = serializeErrorNode(cause, depth + 1);
  }

  return node;
}

function findFirstDbFields(node: SerializedErrorNode): SerializedErrorNode["fields"] | undefined {
  if (node.fields) return node.fields;
  return node.cause ? findFirstDbFields(node.cause) : undefined;
}

export function serializeCreditControlSyncError(error: unknown): {
  errorSummary: string;
  error: SerializedErrorNode;
} {
  const serialized = serializeErrorNode(error);
  const parts = [`${serialized.name}: ${serialized.message}`];

  if (serialized.insert) {
    const context = serialized.insert;
    parts.push(
      `${context.tableName} chunk ${context.chunkIndex + 1} `
      + `(rows ${context.chunkStart + 1}-${context.chunkStart + context.chunkSize} of ${context.totalRows})`,
    );
  }

  const fields = findFirstDbFields(serialized);
  if (fields?.code) {
    parts.push(`db code ${fields.code}`);
  }
  if (fields?.constraint) {
    parts.push(`constraint ${fields.constraint}`);
  }
  if (fields?.detail) {
    parts.push(fields.detail);
  }

  return {
    errorSummary: truncateText(parts.join(" | "), ERROR_SUMMARY_MAX_LENGTH),
    error: serialized,
  };
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
  const seenSessionRows = new Set<string>();
  function addSessions(sessions: WiseCreditSession[], kind: "past" | "future") {
    for (const session of sessions) {
      const durationMinutes = durationMsToMinutes(session.duration);
      for (const studentId of session.students) {
        const pair = pairsByKey.get(`${session.classId._id}|${studentId}`);
        if (!pair) continue;
        const rowKey = `${session._id}|${pair.wiseStudentId}`;
        if (seenSessionRows.has(rowKey)) continue;
        seenSessionRows.add(rowKey);
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
  tableName: string,
): Promise<void> {
  const parts = chunk(rows, CREDIT_CONTROL_INSERT_CHUNK_SIZE);
  for (let chunkIndex = 0; chunkIndex < parts.length; chunkIndex += 1) {
    const part = parts[chunkIndex];
    if (part.length === 0) continue;
    try {
      await db.insert(table).values(part as never);
    } catch (error) {
      throw new CreditControlInsertError({
        tableName,
        totalRows: rows.length,
        chunkIndex,
        chunkStart: chunkIndex * CREDIT_CONTROL_INSERT_CHUNK_SIZE,
        chunkSize: part.length,
      }, error);
    }
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
  let snapshotId: string | undefined;

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
    snapshotId = snapshot.id;

    await db
      .update(schema.creditControlSyncRuns)
      .set({ snapshotId })
      .where(sql`${schema.creditControlSyncRuns.id} = ${run.id}`);

    const studentRows = buildStudentsRows(snapshot.id, students);
    const packageRows = buildPackageRows(snapshot.id, creditPairs);
    const { sessions: sessionRows, histories } = await buildSessionRows(
      client,
      snapshot.id,
      creditPairs,
      pastSessions,
      futureSessions,
    );

    await insertChunks(db, schema.creditControlStudents, studentRows, "credit_control_students");
    await insertChunks(db, schema.creditControlPackages, packageRows, "credit_control_packages");
    await insertChunks(db, schema.creditControlSessions, sessionRows, "credit_control_sessions");
    await insertChunks(db, schema.creditControlCreditHistory, histories, "credit_control_credit_history");

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
    const serialized = serializeCreditControlSyncError(error);
    await db
      .update(schema.creditControlSyncRuns)
      .set({
        status: "failed",
        finishedAt: new Date(),
        errorSummary: serialized.errorSummary,
        metadata: sql`${schema.creditControlSyncRuns.metadata} || ${JSON.stringify({ error: serialized.error })}::jsonb`,
      })
      .where(sql`${schema.creditControlSyncRuns.id} = ${run.id}`);
    return {
      success: false,
      snapshotId,
      studentCount: 0,
      packageCount: 0,
      sessionCount: 0,
      failedCreditPairs: 0,
      errorSummary: serialized.errorSummary,
    };
  }
}
