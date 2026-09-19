import type { Database } from "@/lib/db";
import { createWiseClient } from "@/lib/wise/client";
import { fetchWiseSessionsForBangkokDates } from "@/lib/wise/day-sessions";
import type { WiseSession } from "@/lib/wise/types";
import { reservationRoomBlocks } from "@/lib/room-booking/service";
import { CLASSROOM_ASSIGNMENT_FRESHNESS_MS, getFreshClassroomSnapshotForAssignment, runIncrementalClassroomAssignment } from "./data";
import { loadClassroomRecoveryContext, prepareClassroomRecoveryDay, recoveryRoomPolicies } from "./recovery-data";
import { previewClassroomRecovery } from "./recovery-preview";
import { classroomContinuityEnabled, physicalRoom } from "./room-policy";
import { assignmentReadinessFindings, readinessForFindings, type WeekendReport, type WeekendDayReport } from "./weekend-readiness";
import { improveOverflowAllocation, liveVerifiedOnlineIds, sessionMatchesLive } from "./overflow-service";
import { confirmedSuggestedRelease } from "./overflow-release";
import { readOverflowPlan } from "./overflow-types";
import { isOnsiteSessionType } from "./session-mode";
import type { AssignmentSession } from "./assignment-engine";
import type { WeekendAllocationCheckpoint } from "./weekend-config";

export interface WeekendEvaluationOptions {
  checkpoint?: WeekendAllocationCheckpoint;
  assertActive?: () => Promise<void>;
}

/** Only current Wise read-back counts as publication evidence. */
export function weekendPublication(rows: Array<AssignmentSession & { status: string; assignedRoom: string; publishStatus?: string }>,
  live: WiseSession[], checkedAt: string): NonNullable<WeekendDayReport["publication"]> {
  const byId = new Map(live.map(row => [row._id, row]));
  let verified = 0, pending = 0, failed = 0;
  for (const row of rows.filter(row => row.status === "assigned" && isOnsiteSessionType(row.sessionType))) {
    const source = byId.get(row.wiseSessionId);
    if (source?.location && physicalRoom(source.location) === physicalRoom(row.assignedRoom) && sessionMatchesLive(row, source)) verified++;
    else if (row.publishStatus === "failed") failed++;
    else pending++;
  }
  return { state: verified + pending + failed === 0 ? "not_applicable" : pending + failed === 0 ? "verified"
    : verified ? "partial" : "not_published", verified, pending, failed, checkedAt };
}

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

export async function previewWeekendReadiness(db: Database, dates: [string, string], options: WeekendEvaluationOptions = {}): Promise<WeekendReport> {
  const deadlineAt = Date.now() + 10 * 60_000;
  const { snapshotId, snapshotMeta } = await waitForWeekendSnapshot(db);
  const context = await loadClassroomRecoveryContext(db, dates, snapshotId);
  if (!context.rooms.length) throw new Error("No active classroom catalog is available");
  const client = createWiseClient();
  const live = await fetchWiseSessionsForBangkokDates(client, process.env.WISE_INSTITUTE_ID ?? "696e1f4d90102225641cc413", dates, { deadlineAt });
  const sourceCheckedAt = new Date().toISOString();
  const enabled = classroomContinuityEnabled();
  const roomPolicies = enabled ? recoveryRoomPolicies(context, live, dates[0]).policies : new Map();
  const report: WeekendReport = { version: 2, checkedAt: sourceCheckedAt, dates, snapshotId,
    snapshotFinishedAt: snapshotMeta.latestSyncFinishedAt, readiness: "clear", days: [], findings: [] };
  if (snapshotMeta.syncErrorSummary) report.findings.push({ date: dates[0], kind: "unverified",
    message: `Wise refresh reported incomplete data: ${snapshotMeta.syncErrorSummary}` });
  for (const date of dates) {
    const day: WeekendDayReport = { date, liveSessions: 0, plannedSessions: 0, noRoomCount: 0,
      allocation: options.checkpoint ? "blocked" : "not_requested", runId: null, overflowPlan: null, sourceCheckedAt };
    report.days.push(day);
    try {
      await options.assertActive?.();
      const prepared = await prepareClassroomRecoveryDay(context, live, date, client, new Date(), deadlineAt);
      day.liveSessions = prepared.day.length;
      report.findings.push(...prepared.findings);
      const reservations = await reservationRoomBlocks(db, date);
      const externalRoomBlocks = [...prepared.externalRoomBlocks, ...reservations];
      if (options.checkpoint) {
        if (snapshotMeta.syncErrorSummary || prepared.findings.some(finding => finding.kind === "unverified")) {
          day.allocationError = "Allocation withheld because the source data could not be fully verified.";
          report.findings.push({ date, kind: "unverified", message: day.allocationError });
          continue;
        }
        await options.assertActive?.();
        const detail = await runIncrementalClassroomAssignment(db, { date, forceReassign: false, liveSessions: live,
          snapshotId, trustedSnapshotMeta: snapshotMeta, weekendCheckpoint: options.checkpoint });
        if (!detail.run) throw new Error("Wednesday allocation did not return a saved run");
        Object.assign(day, { runId: detail.run.id, allocation: detail.allocationReused ? "reused" : "saved",
          allocationCreatedAt: detail.run.createdAt.toISOString(), plannedSessions: detail.rows.length,
          noRoomCount: detail.rows.filter(row => row.status === "no_room").length, overflowPlan: detail.overflowPlan ?? null,
          publication: weekendPublication(detail.rows, live, sourceCheckedAt) });
        report.findings.push(...assignmentReadinessFindings({ date, rows: detail.rows, rooms: context.rooms,
          externalRoomBlocks, liveRoomBlocks: prepared.liveRoomBlocks }));
      } else {
        const previous = context.latestRuns.find(run => run.assignmentDate === date);
        const verifiedOnline = liveVerifiedOnlineIds(prepared.sessions, live);
        const preview = previewClassroomRecovery({ assignmentDate: date, now: new Date(),
          liveSessions: prepared.sessions.map(row => ({ ...row,
            overflowReleaseRoom: confirmedSuggestedRelease(row, readOverflowPlan(previous?.changeSummary), verifiedOnline) })),
          previousRows: prepared.previousRows, rooms: context.rooms, externalRoomBlocks,
          confirmedInactiveSessionIds: prepared.confirmedInactiveSessionIds, frozenSessionIds: prepared.frozenSessionIds, roomPolicies, optimizeContinuity: enabled });
        const improved = await improveOverflowAllocation(db, { reconciliation: preview, rooms: context.rooms, assignmentDate: date,
          snapshotId, snapshotFinishedAt: snapshotMeta.latestSyncFinishedAt, liveSessions: live,
          externalRoomBlocks: preview.externalRoomBlocks, frozenSessionIds: prepared.frozenSessionIds,
          unverifiedReasons: [snapshotMeta.syncErrorSummary, ...prepared.findings.map(finding => finding.message)].filter((value): value is string => Boolean(value)) });
        const rows = improved.reconciliation.rows;
        Object.assign(day, { runId: previous?.id ?? null, allocationCreatedAt: previous?.createdAt.toISOString() ?? null,
          plannedSessions: rows.length, noRoomCount: rows.filter(row => row.status === "no_room").length, overflowPlan: improved.plan,
          publication: weekendPublication(rows, live, sourceCheckedAt) });
        report.findings.push(...assignmentReadinessFindings({ date, rows, rooms: context.rooms,
          externalRoomBlocks: preview.externalRoomBlocks, liveRoomBlocks: prepared.liveRoomBlocks }));
      }
      if (day.publication && day.publication.pending + day.publication.failed > 0) report.findings.push({ date, kind: "review",
        message: `${day.publication.pending + day.publication.failed} planned onsite room assignments are not confirmed in Wise. Saved or previewed room choices are not verified publication.` });
    } catch (error) {
      day.allocation = options.checkpoint ? "failed" : "not_requested";
      day.allocationError = error instanceof Error ? error.message : "Weekend allocation failed";
      report.findings.push({ date, kind: "unverified", message: day.allocationError });
    }
  }
  if (!snapshotMeta.latestSyncFinishedAt || Date.now() - Date.parse(snapshotMeta.latestSyncFinishedAt) > CLASSROOM_ASSIGNMENT_FRESHNESS_MS) {
    report.findings.push({ date: dates[0], kind: "unverified", message: "The Wise snapshot exceeded the 15-minute freshness limit during verification." });
  }
  report.readiness = readinessForFindings(report.findings);
  report.checkedAt = new Date().toISOString();
  return report;
}
