import type { Database } from "@/lib/db";
import { createWiseClient } from "@/lib/wise/client";
import { fetchAllFutureSessions } from "@/lib/wise/fetchers";
import { CLASSROOM_ASSIGNMENT_FRESHNESS_MS, getFreshClassroomSnapshotForAssignment } from "./data";
import { loadClassroomRecoveryContext, prepareClassroomRecoveryDay, recoveryRoomPolicies } from "./recovery-data";
import { previewClassroomRecovery } from "./recovery-preview";
import { classroomContinuityEnabled } from "./room-policy";
import { assignmentReadinessFindings, readinessForFindings, type WeekendReport } from "./weekend-readiness";

/** Wait for the scheduled snapshot; this monitor never starts a second Wise sync. */
export async function waitForWeekendSnapshot(db: Database, waitMs = 6 * 60_000) {
  const until = Date.now() + waitMs;
  for (;;) {
    try { return await getFreshClassroomSnapshotForAssignment(db); }
    catch (error) {
      if (Date.now() >= until) throw error;
      await new Promise(resolve => setTimeout(resolve, Math.min(5_000, until - Date.now())));
    }
  }
}

export async function previewWeekendReadiness(db: Database, dates: [string, string]): Promise<WeekendReport> {
  const deadlineAt = Date.now() + 10 * 60_000;
  const { snapshotId, snapshotMeta } = await waitForWeekendSnapshot(db);
  const context = await loadClassroomRecoveryContext(db, dates, snapshotId);
  if (!context.rooms.length) throw new Error("No active classroom catalog is available");
  const client = createWiseClient();
  const live = await fetchAllFutureSessions(client, process.env.WISE_INSTITUTE_ID ?? "696e1f4d90102225641cc413", { strict: true, deadlineAt });
  const enabled = classroomContinuityEnabled();
  const roomPolicies = enabled ? recoveryRoomPolicies(context, live, dates[0]).policies : new Map();
  const report: WeekendReport = { checkedAt: new Date().toISOString(), dates, snapshotId,
    snapshotFinishedAt: snapshotMeta.latestSyncFinishedAt, readiness: "clear", days: [], findings: [] };
  if (snapshotMeta.syncErrorSummary) report.findings.push({ date: dates[0], kind: "unverified",
    message: `Wise refresh reported incomplete data: ${snapshotMeta.syncErrorSummary}` });
  for (const date of dates) {
    const prepared = await prepareClassroomRecoveryDay(context, live, date, client, new Date(), deadlineAt);
    const preview = previewClassroomRecovery({ assignmentDate: date, now: new Date(), liveSessions: prepared.sessions,
      previousRows: prepared.previousRows, rooms: context.rooms, externalRoomBlocks: prepared.externalRoomBlocks,
      confirmedInactiveSessionIds: prepared.confirmedInactiveSessionIds, frozenSessionIds: prepared.frozenSessionIds, roomPolicies, optimizeContinuity: enabled });
    report.days.push({ date, liveSessions: prepared.day.length, plannedSessions: preview.rows.length,
      noRoomCount: preview.rows.filter(row => row.status === "no_room").length });
    report.findings.push(...prepared.findings, ...assignmentReadinessFindings({ date, rows: preview.rows, rooms: context.rooms,
      externalRoomBlocks: preview.externalRoomBlocks, liveRoomBlocks: prepared.liveRoomBlocks }));
  }
  if (!snapshotMeta.latestSyncFinishedAt || Date.now() - Date.parse(snapshotMeta.latestSyncFinishedAt) > CLASSROOM_ASSIGNMENT_FRESHNESS_MS) {
    report.findings.push({ date: dates[0], kind: "unverified", message: "The Wise snapshot exceeded the 15-minute freshness limit during verification." });
  }
  report.readiness = readinessForFindings(report.findings);
  report.checkedAt = new Date().toISOString();
  return report;
}
