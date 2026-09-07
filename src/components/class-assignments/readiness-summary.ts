import { assignmentReadinessFindings, type WeekendFinding, type WeekendReport } from "@/lib/classrooms/weekend-readiness";
import type { AssignmentDetail } from "./types";

export type ReadinessSeverity = "danger" | "warning" | "neutral";
export interface FindingGroup {
  key: string;
  date: string;
  wiseSessionId?: string;
  tutor?: string;
  className?: string;
  findings: WeekendFinding[];
}
export interface ReadinessSummary {
  label: string;
  severity: ReadinessSeverity;
  affectedClasses: number;
  groups: FindingGroup[];
}
export interface WeekendCheckView {
  id: string;
  checkDate: string;
  status: string;
  report: WeekendReport | null;
  lastError: string | null;
  delivery: { status: string; kind: string; sentAt: string | null } | null;
}
export interface WeekendView {
  check: WeekendCheckView | null;
  dates: string[];
  error: string | null;
  loading: boolean;
}

export function groupReadinessFindings(findings: WeekendFinding[]): FindingGroup[] {
  const groups = new Map<string, FindingGroup>();
  for (const finding of findings) {
    const key = JSON.stringify([finding.date, finding.wiseSessionId ?? null,
      finding.wiseSessionId ? null : finding.message]);
    let group = groups.get(key);
    if (!group) {
      group = { key, date: finding.date, wiseSessionId: finding.wiseSessionId, tutor: finding.tutor,
        className: finding.className, findings: [] };
      groups.set(key, group);
    }
    group.tutor ||= finding.tutor;
    group.className ||= finding.className;
    if (!group.findings.some(existing => existing.message === finding.message && existing.startMinute === finding.startMinute
      && existing.endMinute === finding.endMinute && existing.room === finding.room)) group.findings.push(finding);
  }
  return [...groups.values()].sort((a, b) => a.date.localeCompare(b.date)
    || Math.min(...a.findings.map(f => f.startMinute ?? Infinity)) - Math.min(...b.findings.map(f => f.startMinute ?? Infinity))
    || (a.tutor ?? "").localeCompare(b.tutor ?? ""));
}

export function getSyncReview(detail: AssignmentDetail | null) {
  const rawCount = detail?.run?.changeSummary?.unmanagedWiseSessionCount;
  const excludedCount = typeof rawCount === "number" && Number.isInteger(rawCount) && rawCount >= 0 ? rawCount : null;
  const savedSummary = detail?.run?.changeSummary?.syncErrorSummary;
  const activeSummary = detail?.activeSnapshotMeta?.syncErrorSummary;
  const runSummary = typeof savedSummary === "string" ? savedSummary : detail?.snapshotMeta?.syncErrorSummary;
  const snapshot = detail?.activeSnapshotMeta ?? detail?.snapshotMeta ?? null;
  return { excludedCount, activeSummary, runSummary, snapshot,
    needsReview: Boolean(activeSummary || runSummary || excludedCount) };
}

const countLabel = (count: number) => `${count} class${count === 1 ? "" : "es"}`;
const isBlocker = (finding: WeekendFinding) => finding.kind === "no_room" || finding.kind === "conflict";

export function summarizeAssignmentReadiness(detail: AssignmentDetail | null, date: string, loading = false): ReadinessSummary {
  const empty = { affectedClasses: 0, groups: [] };
  if (loading) return { ...empty, label: "Loading…", severity: "neutral" };
  if (!detail || (detail.run && detail.run.assignmentDate !== date)) return { ...empty, label: "Unavailable", severity: "warning" };
  if (!detail.run) return { ...empty, label: "Not checked", severity: "neutral" };
  const findings = assignmentReadinessFindings({ date, rows: detail.rows, rooms: detail.rooms, externalRoomBlocks: detail.liveRoomBlocks });
  const rows = new Map(detail.rows.map(row => [row.wiseSessionId, row]));
  for (const warning of detail.roomConflictWarnings) {
    const row = rows.get(warning.wiseSessionId);
    findings.push({ date, kind: "conflict", wiseSessionId: warning.wiseSessionId, tutor: row?.tutorDisplayName,
      className: row?.studentName || row?.title || undefined, startMinute: row?.startMinute, endMinute: row?.endMinute,
      room: warning.assignedRoom, message: warning.message });
  }
  const { excludedCount } = getSyncReview(detail);
  if (excludedCount) findings.push({ date, kind: "unverified", message: `${excludedCount} live class${excludedCount === 1 ? " is" : "es are"} missing from this saved assignment plan and ${excludedCount === 1 ? "requires" : "require"} review.` });
  // Preserve run-level evidence when a saved response does not include all its rows.
  const missingNoRoom = Math.max(0, detail.run.noRoomCount - detail.rows.filter(row => row.status === "no_room").length);
  const missingReview = Math.max(0, detail.run.needsReviewCount - detail.rows.filter(row => row.status === "needs_review").length);
  if (missingNoRoom) findings.push({ date, kind: "no_room", message: `The saved run records ${missingNoRoom} additional class${missingNoRoom === 1 ? "" : "es"} without a room. Refresh the assignments to review the missing details.` });
  if (missingReview) findings.push({ date, kind: "unverified", message: `The saved run records ${missingReview} additional class${missingReview === 1 ? "" : "es"} requiring review. Refresh the assignments to load the details.` });
  if (detail.run.status === "failed") findings.push({ date, kind: "unverified", message: "Assignment generation failed; classroom coverage has not been verified." });
  const groups = groupReadinessFindings(findings);
  const affectedClasses = groups.filter(group => group.wiseSessionId).length + (excludedCount ?? 0) + missingNoRoom + missingReview;
  const confirmedProblem = findings.some(finding => isBlocker(finding)
    || (finding.kind === "review" && rows.get(finding.wiseSessionId ?? "")?.status === "assigned"));
  return { groups, affectedClasses, label: affectedClasses ? countLabel(affectedClasses) : findings.length ? "Needs review" : "No issues",
    severity: confirmedProblem ? "danger" : findings.length ? "warning" : "neutral" };
}

export function summarizeWeekendReadiness(view: WeekendView): ReadinessSummary {
  const groups = groupReadinessFindings(view.check?.report?.findings ?? []);
  const affectedClasses = groups.filter(group => group.wiseSessionId).length;
  const base = { groups, affectedClasses };
  if (view.error) return { ...base, label: "Unavailable", severity: "warning" };
  if (view.loading) return { ...base, label: "Loading…", severity: "neutral" };
  const report = view.check?.report;
  const blocker = groups.some(group => group.findings.some(isBlocker));
  if (view.check?.status === "failed") return { ...base, label: "Check failed", severity: blocker ? "danger" : "warning" };
  if (!report) return { ...base, label: view.check?.status === "running" ? "Checking…" : "Not checked", severity: "neutral" };
  if (report.readiness !== "clear") return { ...base, label: affectedClasses ? countLabel(affectedClasses) : report.readiness === "attention" ? "Needs review" : "Unverified",
    severity: blocker || report.readiness === "attention" ? "danger" : "warning" };
  return { ...base, label: "No issues", severity: "neutral" };
}

export function summarizeWiseReadiness(detail: AssignmentDetail | null) {
  const { snapshot, needsReview } = getSyncReview(detail);
  const stale = Boolean(snapshot?.snapshotId && !snapshot.fresh);
  return { label: stale ? needsReview ? "Stale · review" : "Stale" : needsReview ? "Needs review" : snapshot?.fresh ? "Fresh" : "Not checked",
    severity: (stale || needsReview ? "warning" : "neutral") as ReadinessSeverity };
}
