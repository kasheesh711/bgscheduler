// ----------------------------------------------------------------------------
// Parent class report — snapshot-scoped loader.
//
// Reads exclusively from the ACTIVE credit-control snapshot. Every query
// filters on snapshotId first: credit_control_sessions retains every rotated
// snapshot (tens of millions of rows), so an unscoped predicate would scan
// history that is never meant to be queried (see schema.ts near the sessions
// table for the retention note). Read-only — never writes, never calls Wise.
//
// Missing student keys fail closed with the full missing list; nothing is
// silently dropped. Credit-history rows with a null createdAtWise cannot be
// placed inside the window and are excluded from movement by the range
// predicate itself.
// ----------------------------------------------------------------------------

import { and, asc, eq, gte, inArray, lt } from "drizzle-orm";

import { getActiveCreditSnapshot } from "@/lib/credit-control/db";
import * as schema from "@/lib/db/schema";
import { parseStudentDisplay } from "@/lib/student-schedule/data";
import { buildParentReportPayload } from "./build";
import { resolveReportWindow } from "./window";

import type { Database } from "@/lib/db";
import type { ReportSessionInput } from "./build";
import type { ParentReportResult, ReportPackageRow, ReportStudent } from "./types";

/**
 * Loads the parent class report for 1..N students over an inclusive Bangkok
 * date range, from the active credit-control snapshot.
 *
 * 1. Resolve the active snapshot; without one nothing can be reported.
 * 2. Resolve every requested studentKey on that snapshot; any miss fails
 *    closed with the complete missing list.
 * 3. Fetch window-scoped sessions, point-in-time packages, and window-scoped
 *    credit-history movement in parallel, all keyed by snapshotId first.
 * 4. Assemble the payload with the pure builder.
 */
export async function getParentClassReport(
  db: Database,
  input: {
    studentKeys: readonly string[];
    from: string;
    to: string;
    now?: Date;
  },
): Promise<ParentReportResult> {
  const snapshot = await getActiveCreditSnapshot(db);
  if (!snapshot) return { status: "no-snapshot" };

  const requestedKeys = [...new Set(input.studentKeys)];
  const studentRows = await db
    .select({
      studentKey: schema.creditControlStudents.studentKey,
      wiseStudentId: schema.creditControlStudents.wiseStudentId,
      studentName: schema.creditControlStudents.studentName,
      parentName: schema.creditControlStudents.parentName,
      activated: schema.creditControlStudents.activated,
    })
    .from(schema.creditControlStudents)
    .where(
      and(
        eq(schema.creditControlStudents.snapshotId, snapshot.id),
        inArray(schema.creditControlStudents.studentKey, requestedKeys),
      ),
    );

  const byKey = new Map(studentRows.map((row) => [row.studentKey, row]));
  const missing = requestedKeys.filter((key) => !byKey.has(key));
  if (missing.length > 0) return { status: "students-not-found", missing };

  const students: ReportStudent[] = requestedKeys.map((key) => {
    const row = byKey.get(key)!;
    const display = parseStudentDisplay(row.studentName);
    return {
      studentKey: row.studentKey,
      wiseStudentId: row.wiseStudentId,
      studentName: row.studentName,
      parentName: row.parentName,
      code: display.code,
      shortName: display.shortName,
      activated: row.activated,
    };
  });

  const window = resolveReportWindow(input.from, input.to);
  const studentIds = students.map((student) => student.wiseStudentId);

  const [sessionRows, packageRows, historyRows] = await Promise.all([
    db
      .select({
        wiseSessionId: schema.creditControlSessions.wiseSessionId,
        wiseStudentId: schema.creditControlSessions.wiseStudentId,
        studentKey: schema.creditControlSessions.studentKey,
        title: schema.creditControlSessions.title,
        subject: schema.creditControlSessions.subject,
        packageName: schema.creditControlSessions.packageName,
        scheduledStartTime: schema.creditControlSessions.scheduledStartTime,
        durationMinutes: schema.creditControlSessions.durationMinutes,
        meetingStatus: schema.creditControlSessions.meetingStatus,
        sessionKind: schema.creditControlSessions.sessionKind,
        creditApplied: schema.creditControlSessions.creditApplied,
        teacherName: schema.creditControlSessions.teacherName,
        teacherFeedback: schema.creditControlSessions.teacherFeedback,
      })
      .from(schema.creditControlSessions)
      .where(
        and(
          eq(schema.creditControlSessions.snapshotId, snapshot.id),
          inArray(schema.creditControlSessions.wiseStudentId, studentIds),
          gte(schema.creditControlSessions.scheduledStartTime, window.startUtc),
          lt(schema.creditControlSessions.scheduledStartTime, window.endUtc),
        ),
      )
      .orderBy(asc(schema.creditControlSessions.scheduledStartTime)),
    db
      .select({
        wiseStudentId: schema.creditControlPackages.wiseStudentId,
        packageName: schema.creditControlPackages.packageName,
        subject: schema.creditControlPackages.subject,
        classType: schema.creditControlPackages.classType,
        totalCredits: schema.creditControlPackages.totalCredits,
        consumedCredits: schema.creditControlPackages.consumedCredits,
        remainingCredits: schema.creditControlPackages.remainingCredits,
        availableCredits: schema.creditControlPackages.availableCredits,
        bookedSessions: schema.creditControlPackages.bookedSessions,
        excludedReason: schema.creditControlPackages.excludedReason,
      })
      .from(schema.creditControlPackages)
      .where(
        and(
          eq(schema.creditControlPackages.snapshotId, snapshot.id),
          inArray(schema.creditControlPackages.wiseStudentId, studentIds),
        ),
      ),
    db
      .select({
        wiseStudentId: schema.creditControlCreditHistory.wiseStudentId,
        credit: schema.creditControlCreditHistory.credit,
      })
      .from(schema.creditControlCreditHistory)
      .where(
        and(
          eq(schema.creditControlCreditHistory.snapshotId, snapshot.id),
          inArray(schema.creditControlCreditHistory.wiseStudentId, studentIds),
          gte(schema.creditControlCreditHistory.createdAtWise, window.startUtc),
          lt(schema.creditControlCreditHistory.createdAtWise, window.endUtc),
        ),
      ),
  ]);

  const sessionsByStudentId = new Map<string, ReportSessionInput[]>();
  for (const row of sessionRows) {
    const existing = sessionsByStudentId.get(row.wiseStudentId);
    if (existing) existing.push(row);
    else sessionsByStudentId.set(row.wiseStudentId, [row]);
  }

  const packagesByStudentId = new Map<string, ReportPackageRow[]>();
  for (const { wiseStudentId, ...pkg } of packageRows) {
    const existing = packagesByStudentId.get(wiseStudentId);
    if (existing) existing.push(pkg);
    else packagesByStudentId.set(wiseStudentId, [pkg]);
  }

  const ledgerByStudentId = new Map<string, { entries: number; netCredit: number }>();
  for (const row of historyRows) {
    const current = ledgerByStudentId.get(row.wiseStudentId) ?? { entries: 0, netCredit: 0 };
    current.entries += 1;
    current.netCredit += row.credit;
    ledgerByStudentId.set(row.wiseStudentId, current);
  }
  for (const totals of ledgerByStudentId.values()) {
    totals.netCredit = Math.round(totals.netCredit * 100) / 100;
  }

  return {
    status: "ok",
    payload: buildParentReportPayload({
      snapshot,
      window,
      students,
      sessionsByStudentId,
      packagesByStudentId,
      ledgerByStudentId,
      generatedAt: input.now ?? new Date(),
    }),
  };
}
