import { revalidateTag } from "next/cache";
import { and, desc, eq, inArray, or, sql } from "drizzle-orm";
import type { Database } from "@/lib/db";
import * as schema from "@/lib/db/schema";
import { topWisePaths, type WiseClient } from "@/lib/wise/client";
import {
  CHURN_INACTIVITY_DAYS,
  CREDIT_CONTROL_CACHE_TAG,
  CREDIT_SYSTEM_ACTOR_EMAIL,
  CREDIT_SYSTEM_ACTOR_NAME,
  EXCLUDED_PACKAGE_KEYWORDS,
} from "@/lib/credit-control/config";
import { aggregateStudentRemaining, computeChurnTransitions } from "@/lib/credit-control/churn";
import { buildDashboardStudentKey, buildStudentPackageKey, normalizeText } from "@/lib/credit-control/helpers";
import {
  decidePairRefresh,
  getCreditRefreshMaxAgeMinutes,
  type PriorPairCredits,
} from "@/lib/credit-control/refresh-policy";
import {
  creditSessionTeacher,
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

/**
 * One `sessionCreditHistory` movement, normalized so a freshly fetched Wise
 * entry and a row carried forward from the previous snapshot are the same
 * shape downstream (CRED-01).
 */
interface PairHistoryEntry {
  wiseCreditHistoryId: string;
  credit: number;
  type: string | null;
  meetingStatus: string | null;
  durationMinutes: number;
  createdAtWise: Date | null;
  raw: Record<string, unknown>;
}

interface PairCreditRecord extends PairRecord {
  credits: WiseSessionCredits["credits"];
  history: PairHistoryEntry[];
  /** When the balance was OBSERVED, not when the row was written. */
  creditsObservedAt: Date;
}

/** The previous snapshot's row for one pair, plus its carry-forward payload. */
interface PriorPairRow extends PriorPairCredits {
  credits: WiseSessionCredits["credits"];
}

interface PriorSnapshotCredits {
  snapshotId: string;
  byPair: Map<string, PriorPairRow>;
}

interface CarriedPair {
  pair: PairRecord;
  prior: PriorPairRow;
  /** "reuse" = quiet pair aged forward; "skip" = excluded, never read. */
  action: "reuse" | "skip";
}

interface PairRefreshPlan {
  refetch: PairRecord[];
  carried: CarriedPair[];
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

/** Days of past sessions each snapshot retains; the report's queryable floor. */
export const PAST_WINDOW_DAYS = 120;
/** Days of future sessions each snapshot retains; the report's queryable ceiling. */
export const FUTURE_WINDOW_DAYS = 180;
/** Matches the WiseClient limiter (`createWiseClient` maxConcurrency 15), so
 *  the pair fan-out saturates the client instead of throttling below it. */
const CREDIT_PAIR_CONCURRENCY = 15;
const FEEDBACK_CONCURRENCY = 6;
/** Pair keys per carried-history SELECT, so the IN list stays a sane statement size. */
const CARRIED_HISTORY_KEY_CHUNK_SIZE = 400;
/** credit_control_sessions has 22 columns, so 500 rows is ~11k bind
 *  parameters per statement — well under the Postgres 65,535 ceiling. */
export const CREDIT_CONTROL_INSERT_CHUNK_SIZE = 500;
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

/** Identity of a (class, student) pair everywhere in this module. */
function pairKey(wiseClassId: string, wiseStudentId: string): string {
  return `${wiseClassId}|${wiseStudentId}`;
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
    const key = pairKey(wiseClassId, student._id);
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
      // NOTE: deliberately NOT gated on `student.activated`, unlike the roster
      // branch above. Measured 2026-09-04: 770 of 1,271 students in the active
      // snapshot are de-activated, and 120 of them still have future sessions
      // (3,529 rows). Those rows are the ONLY source for the parent monthly
      // schedule (student-schedule/data.ts builds the calendar from
      // credit_control_sessions), so gating here blanks a real parent-facing
      // page to save a few hundred Wise calls. The pair still costs one
      // sessionCredits GET; the dirty-pair policy is what narrows that.
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
      creditsObservedAt: pair.creditsObservedAt,
    };
  });
}

function toHistoryEntries(history: WiseSessionCredits["sessionCreditHistory"]): PairHistoryEntry[] {
  return history.map((entry) => ({
    wiseCreditHistoryId: entry._id,
    credit: Number(entry.credit) || 0,
    type: entry.type ?? null,
    meetingStatus: entry.meetingStatus ?? null,
    durationMinutes: durationMsToMinutes(entry.duration),
    createdAtWise: entry.createdAt ?? null,
    raw: JSON.parse(JSON.stringify(entry)) as Record<string, unknown>,
  }));
}

async function fetchPairCredits(
  client: WiseClient,
  instituteId: string,
  pairs: PairRecord[],
  observedAt: Date,
): Promise<{ records: PairCreditRecord[]; failed: number }> {
  let failed = 0;
  const results = await mapLimit(pairs, CREDIT_PAIR_CONCURRENCY, async (pair) => {
    try {
      const credits = await fetchSessionCredits(client, instituteId, pair.wiseClassId, pair.wiseStudentId);
      return {
        ...pair,
        credits: credits.credits,
        history: toHistoryEntries(credits.sessionCreditHistory),
        creditsObservedAt: observedAt,
      } satisfies PairCreditRecord;
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

/** The instant a PAST-feed session finished, however Wise described it. */
function sessionEndInstant(session: WiseCreditSession): Date {
  if (session.scheduledEndTime) return session.scheduledEndTime;
  const durationMs = Number(session.duration);
  if (Number.isFinite(durationMs) && durationMs > 0) {
    return new Date(session.scheduledStartTime.getTime() + durationMs);
  }
  return session.scheduledStartTime;
}

/**
 * Latest end instant per pair across the PAST feed already fetched this run.
 * Attendance is the only way credits fall, so this is the free change signal
 * that lets a quiet pair be carried forward (CRED-01). Deliberately ignores
 * `meetingStatus`: a cancellation can also move credits, so any past session
 * counts.
 */
function buildLastSessionEndMap(pastSessions: WiseCreditSession[]): Map<string, Date> {
  const lastEndByPair = new Map<string, Date>();
  for (const session of pastSessions) {
    const endedAt = sessionEndInstant(session);
    for (const studentId of session.students) {
      const key = pairKey(session.classId._id, studentId);
      const current = lastEndByPair.get(key);
      if (!current || endedAt.getTime() > current.getTime()) {
        lastEndByPair.set(key, endedAt);
      }
    }
  }
  return lastEndByPair;
}

/**
 * Reads the active (i.e. previous) snapshot's per-pair balances plus the
 * pending deductions the dashboard would subtract from them, so the reuse
 * decision runs on the same adjusted figure a human sees. Returns null on any
 * failure — the caller then refetches every pair rather than carrying nothing
 * forward, because a package row with zeroed credits reads as a drained
 * balance and triggers false follow-up.
 */
async function loadPriorSnapshotCredits(db: Database): Promise<PriorSnapshotCredits | null> {
  try {
    const [snapshot] = await db
      .select({ id: schema.creditControlSnapshots.id })
      .from(schema.creditControlSnapshots)
      .where(eq(schema.creditControlSnapshots.active, true))
      .orderBy(desc(schema.creditControlSnapshots.generatedAt))
      .limit(1);
    if (!snapshot) return null;

    const [packages, pendingSessions] = await Promise.all([
      db
        .select({
          wiseClassId: schema.creditControlPackages.wiseClassId,
          wiseStudentId: schema.creditControlPackages.wiseStudentId,
          totalCredits: schema.creditControlPackages.totalCredits,
          consumedCredits: schema.creditControlPackages.consumedCredits,
          remainingCredits: schema.creditControlPackages.remainingCredits,
          availableCredits: schema.creditControlPackages.availableCredits,
          bookedSessions: schema.creditControlPackages.bookedSessions,
          excludedReason: schema.creditControlPackages.excludedReason,
          creditsObservedAt: schema.creditControlPackages.creditsObservedAt,
        })
        .from(schema.creditControlPackages)
        .where(eq(schema.creditControlPackages.snapshotId, snapshot.id)),
      // Mirrors shouldCountAsPendingDeduction (packages.ts:212): an ENDED past
      // session with no applied credit and blank teacher feedback.
      db
        .select({
          wiseClassId: schema.creditControlSessions.wiseClassId,
          wiseStudentId: schema.creditControlSessions.wiseStudentId,
          durationMinutes: schema.creditControlSessions.durationMinutes,
        })
        .from(schema.creditControlSessions)
        .where(and(
          eq(schema.creditControlSessions.snapshotId, snapshot.id),
          eq(schema.creditControlSessions.sessionKind, "past"),
          eq(schema.creditControlSessions.meetingStatus, "ENDED"),
          eq(schema.creditControlSessions.creditApplied, 0),
          sql`coalesce(btrim(${schema.creditControlSessions.teacherFeedback}), '') in ('', '0')`,
        )),
    ]);

    const pendingMinutesByPair = new Map<string, number>();
    for (const row of pendingSessions) {
      const key = pairKey(row.wiseClassId, row.wiseStudentId);
      pendingMinutesByPair.set(key, (pendingMinutesByPair.get(key) ?? 0) + (row.durationMinutes ?? 0));
    }

    const byPair = new Map<string, PriorPairRow>();
    for (const row of packages) {
      const key = pairKey(row.wiseClassId, row.wiseStudentId);
      byPair.set(key, {
        remainingCredits: row.remainingCredits ?? 0,
        pendingDeductionCredits: (pendingMinutesByPair.get(key) ?? 0) / 60,
        excludedReason: row.excludedReason,
        creditsObservedAt: row.creditsObservedAt,
        credits: {
          total: row.totalCredits ?? 0,
          consumed: row.consumedCredits ?? 0,
          remaining: row.remainingCredits ?? 0,
          available: row.availableCredits ?? 0,
          bookedSessions: row.bookedSessions ?? 0,
        },
      });
    }

    return { snapshotId: snapshot.id, byPair };
  } catch (error) {
    console.error("[credit-control] prior snapshot read failed; refetching every pair", error);
    return null;
  }
}

/** Splits this run's pairs into the ones Wise must be asked about and the ones carried forward. */
function planPairRefresh(options: {
  pairs: PairRecord[];
  prior: PriorSnapshotCredits | null;
  lastSessionEnds: Map<string, Date>;
  now: Date;
  maxAgeMinutes: number;
}): PairRefreshPlan {
  const plan: PairRefreshPlan = { refetch: [], carried: [] };
  for (const pair of options.pairs) {
    const key = pairKey(pair.wiseClassId, pair.wiseStudentId);
    const prior = options.prior?.byPair.get(key) ?? null;
    const decision = decidePairRefresh({
      prior,
      currentlyExcluded: packageExclusionReason(pair.packageName, pair.subject) !== null,
      lastSessionEndAt: options.lastSessionEnds.get(key) ?? null,
      now: options.now,
      maxAgeMinutes: options.maxAgeMinutes,
    });

    if (decision.action === "refetch" || !prior) {
      plan.refetch.push(pair);
      continue;
    }
    plan.carried.push({ pair, prior, action: decision.action });
  }
  return plan;
}

/**
 * Loads the previous snapshot's credit-history rows for the carried pairs so
 * they can be re-inserted under the new snapshot id. History is never
 * fabricated: `creditApplied` on past sessions is derived from it, so a
 * missing row would turn an already-charged session back into a pending
 * deduction and understate the balance.
 */
async function loadCarriedHistory(
  db: Database,
  priorSnapshotId: string,
  keys: string[],
): Promise<Map<string, PairHistoryEntry[]>> {
  const historyByPair = new Map<string, PairHistoryEntry[]>();
  for (const part of chunk(keys, CARRIED_HISTORY_KEY_CHUNK_SIZE)) {
    const rows = await db
      .select({
        wiseCreditHistoryId: schema.creditControlCreditHistory.wiseCreditHistoryId,
        wiseClassId: schema.creditControlCreditHistory.wiseClassId,
        wiseStudentId: schema.creditControlCreditHistory.wiseStudentId,
        credit: schema.creditControlCreditHistory.credit,
        type: schema.creditControlCreditHistory.type,
        meetingStatus: schema.creditControlCreditHistory.meetingStatus,
        durationMinutes: schema.creditControlCreditHistory.durationMinutes,
        createdAtWise: schema.creditControlCreditHistory.createdAtWise,
        raw: schema.creditControlCreditHistory.raw,
      })
      .from(schema.creditControlCreditHistory)
      .where(and(
        eq(schema.creditControlCreditHistory.snapshotId, priorSnapshotId),
        inArray(
          sql`${schema.creditControlCreditHistory.wiseClassId} || '|' || ${schema.creditControlCreditHistory.wiseStudentId}`,
          part,
        ),
      ));

    for (const row of rows) {
      const key = pairKey(row.wiseClassId, row.wiseStudentId);
      const entries = historyByPair.get(key) ?? [];
      entries.push({
        wiseCreditHistoryId: row.wiseCreditHistoryId,
        credit: row.credit ?? 0,
        type: row.type,
        meetingStatus: row.meetingStatus,
        durationMinutes: row.durationMinutes ?? 0,
        createdAtWise: row.createdAtWise,
        raw: row.raw ?? {},
      });
      historyByPair.set(key, entries);
    }
  }
  return historyByPair;
}

async function buildSessionRows(
  client: WiseClient,
  snapshotId: string,
  creditPairs: PairCreditRecord[],
  pastSessions: WiseCreditSession[],
  futureSessions: WiseCreditSession[],
): Promise<SessionCreditRows> {
  const pairsByKey = new Map(creditPairs.map((pair) => [pairKey(pair.wiseClassId, pair.wiseStudentId), pair]));
  const positiveCreditByPairSession = new Map<string, number>();
  const histories: Array<typeof schema.creditControlCreditHistory.$inferInsert> = [];

  for (const pair of creditPairs) {
    // Recomputed from THIS run's names, so a carried-forward history row keys
    // to the same package as the pair's fresh session rows.
    const packageKey = buildStudentPackageKey(pair.studentName, pair.packageName);
    for (const history of pair.history) {
      if (history.credit > 0) {
        positiveCreditByPairSession.set(
          `${pairKey(pair.wiseClassId, pair.wiseStudentId)}|${history.wiseCreditHistoryId}`,
          history.credit,
        );
      }
      histories.push({
        snapshotId,
        wiseCreditHistoryId: history.wiseCreditHistoryId,
        wiseStudentId: pair.wiseStudentId,
        wiseClassId: pair.wiseClassId,
        packageKey,
        credit: history.credit,
        type: history.type,
        meetingStatus: history.meetingStatus,
        durationMinutes: history.durationMinutes,
        createdAtWise: history.createdAtWise,
        raw: history.raw,
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
      const teacher = creditSessionTeacher(session);
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
          title: session.title?.trim() ?? "",
          scheduledStartTime: session.scheduledStartTime,
          scheduledEndTime: session.scheduledEndTime,
          durationMinutes,
          meetingStatus: session.meetingStatus.toUpperCase(),
          sessionKind: kind,
          wiseTeacherUserId: teacher.wiseTeacherUserId,
          wiseTeacherId: teacher.wiseTeacherId,
          teacherName: teacher.teacherName,
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

/**
 * Maintain the churn lifecycle from the freshly-promoted snapshot's package rows.
 * Runs at sync time (the only point balances change): advances each student's
 * zero-credit streak, auto-removes students past CHURN_INACTIVITY_DAYS at <= 0
 * remaining credits, and reactivates removed students on a genuine top-up. Uses
 * raw Drizzle ops (consistent with this module) so the pure churn logic in
 * churn.ts stays free of DB/env imports. Best-effort: the caller swallows errors
 * so churn never rolls back the promoted snapshot.
 */
async function applyChurnMaintenance(
  db: Database,
  packageRows: Array<typeof schema.creditControlPackages.$inferInsert>,
  now: Date,
): Promise<void> {
  const students = aggregateStudentRemaining(
    packageRows.map((row) => ({
      studentKey: row.studentKey,
      studentName: row.studentName,
      parentName: row.parentName ?? "",
      remainingCredits: row.remainingCredits ?? 0,
      excludedReason: row.excludedReason ?? null,
    })),
  );

  const [tracking, inactive] = await Promise.all([
    db
      .select({
        studentKey: schema.creditControlZeroBalanceTracking.studentKey,
        zeroSince: schema.creditControlZeroBalanceTracking.zeroSince,
      })
      .from(schema.creditControlZeroBalanceTracking),
    db
      .select({
        studentKey: schema.creditControlInactiveStudents.studentKey,
        studentName: schema.creditControlInactiveStudents.studentName,
        parentName: schema.creditControlInactiveStudents.parentName,
        source: schema.creditControlInactiveStudents.source,
        removedAtRemaining: schema.creditControlInactiveStudents.removedAtRemaining,
      })
      .from(schema.creditControlInactiveStudents),
  ]);

  const transitions = computeChurnTransitions({
    students,
    tracking,
    inactive: inactive.map((row) => ({
      studentKey: row.studentKey,
      source: row.source,
      removedAtRemaining: row.removedAtRemaining,
    })),
    now,
    thresholdDays: CHURN_INACTIVITY_DAYS,
  });

  for (const upsert of transitions.zeroUpserts) {
    await db
      .insert(schema.creditControlZeroBalanceTracking)
      .values({
        studentKey: upsert.studentKey,
        studentName: upsert.studentName,
        parentName: upsert.parentName,
        zeroSince: upsert.zeroSince,
        lastRemaining: upsert.lastRemaining,
      })
      .onConflictDoUpdate({
        target: schema.creditControlZeroBalanceTracking.studentKey,
        set: {
          studentName: upsert.studentName,
          parentName: upsert.parentName,
          zeroSince: upsert.zeroSince,
          lastRemaining: upsert.lastRemaining,
          updatedAt: now,
        },
      });
  }

  for (const row of transitions.toInactivate) {
    await db
      .insert(schema.creditControlInactiveStudents)
      .values({
        studentKey: row.studentKey,
        studentName: row.studentName,
        parentName: row.parentName,
        markedByEmail: CREDIT_SYSTEM_ACTOR_EMAIL,
        source: "auto-churn",
        removedAtRemaining: row.removedAtRemaining,
      })
      .onConflictDoUpdate({
        target: schema.creditControlInactiveStudents.studentKey,
        set: {
          studentName: row.studentName,
          parentName: row.parentName,
          markedAt: now,
          markedByEmail: CREDIT_SYSTEM_ACTOR_EMAIL,
          source: "auto-churn",
          removedAtRemaining: row.removedAtRemaining,
        },
      });
    await db.insert(schema.creditControlFollowUpLog).values({
      studentKey: row.studentKey,
      studentName: row.studentName,
      parentName: row.parentName,
      actionType: "auto-remove",
      status: null,
      actorEmail: CREDIT_SYSTEM_ACTOR_EMAIL,
      actorName: CREDIT_SYSTEM_ACTOR_NAME,
    });
  }

  if (transitions.toReactivate.length > 0) {
    const inactiveByKey = new Map(inactive.map((row) => [row.studentKey, row]));
    await db
      .delete(schema.creditControlInactiveStudents)
      .where(inArray(schema.creditControlInactiveStudents.studentKey, transitions.toReactivate));
    for (const studentKey of transitions.toReactivate) {
      const row = inactiveByKey.get(studentKey);
      await db.insert(schema.creditControlFollowUpLog).values({
        studentKey,
        studentName: row?.studentName ?? studentKey,
        parentName: row?.parentName ?? "",
        actionType: "auto-reactivate",
        status: null,
        actorEmail: CREDIT_SYSTEM_ACTOR_EMAIL,
        actorName: CREDIT_SYSTEM_ACTOR_NAME,
      });
    }
  }

  // Clear tracking rows LAST — both recovered students and just-inactivated ones.
  // Running this after the inactive-table writes means a partial failure earlier
  // leaves tracking rows intact, so a still-qualifying student is re-processed on the
  // next sync without resetting their zero-credit streak (Neon HTTP has no transactions).
  if (transitions.zeroClears.length > 0) {
    await db
      .delete(schema.creditControlZeroBalanceTracking)
      .where(inArray(schema.creditControlZeroBalanceTracking.studentKey, transitions.zeroClears));
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

    // CRED-01: ask Wise only about the pairs whose balance could matter this
    // run; carry the quiet ones forward from the previous snapshot.
    const prior = await loadPriorSnapshotCredits(db);
    const plan = planPairRefresh({
      pairs,
      prior,
      lastSessionEnds: buildLastSessionEndMap(pastSessions),
      now,
      maxAgeMinutes: getCreditRefreshMaxAgeMinutes(),
    });

    let refetchPairs = plan.refetch;
    let carriedPairs = plan.carried;
    let carriedRecords: PairCreditRecord[] = [];
    if (carriedPairs.length > 0 && prior) {
      try {
        const historyByPair = await loadCarriedHistory(
          db,
          prior.snapshotId,
          carriedPairs.map(({ pair }) => pairKey(pair.wiseClassId, pair.wiseStudentId)),
        );
        carriedRecords = carriedPairs.map(({ pair, prior: priorRow }) => ({
          ...pair,
          credits: priorRow.credits,
          history: historyByPair.get(pairKey(pair.wiseClassId, pair.wiseStudentId)) ?? [],
          creditsObservedAt: priorRow.creditsObservedAt,
        }));
      } catch (historyError) {
        console.error("[credit-control] carried history read failed; refetching those pairs", historyError);
        refetchPairs = [...refetchPairs, ...carriedPairs.map(({ pair }) => pair)];
        carriedPairs = [];
        carriedRecords = [];
      }
    }

    const pairsReused = carriedPairs.filter(({ action }) => action === "reuse").length;
    const pairsSkippedExcluded = carriedPairs.filter(({ action }) => action === "skip").length;

    const { records: fetchedPairs, failed: failedCreditPairs } = await fetchPairCredits(
      client,
      instituteId,
      refetchPairs,
      now,
    );
    const creditPairs = [...fetchedPairs, ...carriedRecords];

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

    // Atomic promotion via a single UPDATE: PostgreSQL MVCC + the row-level
    // lock held for the duration of one statement guarantee that concurrent
    // readers see either the prior-active row or the new-active row — never a
    // moment with zero matches on `active = true`. The bounded WHERE restricts
    // the rewrite to (a) the previous active row(s) and (b) the candidate
    // snapshot, avoiding a full-table rewrite per promote (REL-01).
    await db
      .update(schema.creditControlSnapshots)
      .set({ active: sql`(${schema.creditControlSnapshots.id} = ${snapshot.id})` })
      .where(
        or(
          eq(schema.creditControlSnapshots.active, true),
          eq(schema.creditControlSnapshots.id, snapshot.id),
        ),
      );

    // Churn lifecycle (best-effort; never roll back the promoted snapshot).
    try {
      await applyChurnMaintenance(db, packageRows, now);
    } catch (churnError) {
      console.error("[credit-control] churn maintenance failed", churnError);
    }

    const wiseStats = client.getStats();
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
          // EFF-00: how much of this run was Wise, recorded per run so the
          // API cost of a sync is measurable instead of inferred.
          wiseCallCount: wiseStats.requests,
          wiseTopPaths: topWisePaths(wiseStats),
          // CRED-01: the sessionCredits fan-out, split into what it cost and
          // what it saved, so the reuse rule is measurable next to the call
          // count it is meant to cut.
          pairsRefetched: refetchPairs.length,
          pairsReused,
          pairsSkippedExcluded,
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
