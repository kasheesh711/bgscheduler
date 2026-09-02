"use client";

import { useMemo, useState } from "react";
import {
  AlertTriangle,
  CalendarClock,
  CheckCircle2,
  Download,
  Play,
  RefreshCw,
  ShieldCheck,
  XCircle,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import type { StudentPromotionReadbackResult, StudentPromotionRunDetail } from "@/lib/student-promotions/data";

type Detail = StudentPromotionRunDetail | null;
type GradeAction = StudentPromotionRunDetail["gradeActions"][number];
type CourseAction = StudentPromotionRunDetail["courseActions"][number];
type FutureSessionAction = StudentPromotionRunDetail["futureSessionActions"][number];
type GraduationAction = StudentPromotionRunDetail["graduationActions"][number];
type PayRateImpact = StudentPromotionRunDetail["payRateImpacts"][number];

export const ALL_TARGET_GRADES_FILTER = "__all_target_grades__";
export const NO_TARGET_GRADE_FILTER = "__no_target_grade__";

export interface TargetGradeFilterOption {
  value: string;
  label: string;
  count: number;
}

interface Props {
  initialDetail: Detail;
}

function formatDateTime(value: Date | string | null): string {
  if (!value) return "-";
  return new Intl.DateTimeFormat("en-GB", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "Asia/Bangkok",
  }).format(new Date(value));
}

function statusBadge(status: string) {
  if (status === "verified" || status === "applied") return "default";
  if (status === "failed" || status === "applied_with_errors") return "destructive";
  if (status === "applying") return "secondary";
  return "outline";
}

function csvValue(value: unknown): string {
  const text = Array.isArray(value) ? value.join("; ") : String(value ?? "");
  return `"${text.replace(/"/g, '""')}"`;
}

function downloadCsv(filename: string, rows: Array<Record<string, unknown>>) {
  if (rows.length === 0) return;
  const columns = Object.keys(rows[0]);
  const csv = [
    columns.map(csvValue).join(","),
    ...rows.map((row) => columns.map((column) => csvValue(row[column])).join(",")),
  ].join("\n");
  const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

function promotedYearFromTargetGrade(targetGrade: string): number {
  return Number(targetGrade.match(/\byear\s*(\d{1,2})\b/i)?.[1] ?? Number.MAX_SAFE_INTEGER);
}

function normalizedTargetGrade(row: GradeAction): string {
  return row.targetGrade?.trim() || NO_TARGET_GRADE_FILTER;
}

export function buildTargetGradeFilterOptions(rows: GradeAction[]): TargetGradeFilterOption[] {
  const counts = new Map<string, number>();
  for (const row of rows) {
    const targetGrade = normalizedTargetGrade(row);
    counts.set(targetGrade, (counts.get(targetGrade) ?? 0) + 1);
  }

  const targetOptions = [...counts.entries()]
    .filter(([value]) => value !== NO_TARGET_GRADE_FILTER)
    .sort(([left], [right]) => {
      const yearDiff = promotedYearFromTargetGrade(left) - promotedYearFromTargetGrade(right);
      return yearDiff || left.localeCompare(right);
    })
    .map(([value, count]) => ({ value, label: value, count }));

  return [
    { value: ALL_TARGET_GRADES_FILTER, label: "All target grades", count: rows.length },
    ...targetOptions,
    ...(counts.has(NO_TARGET_GRADE_FILTER)
      ? [{
          value: NO_TARGET_GRADE_FILTER,
          label: "No target / needs review",
          count: counts.get(NO_TARGET_GRADE_FILTER) ?? 0,
        }]
      : []),
  ];
}

export function buildStudentTargetGradeMap(rows: GradeAction[]): Map<string, string> {
  return new Map(rows.map((row) => [row.wiseStudentId, normalizedTargetGrade(row)]));
}

export function filterGradeActionsByTargetGrade(rows: GradeAction[], targetGradeFilter: string): GradeAction[] {
  if (targetGradeFilter === ALL_TARGET_GRADES_FILTER) return rows;
  return rows.filter((row) => normalizedTargetGrade(row) === targetGradeFilter);
}

export function filterCourseActionsByTargetGrade(
  rows: CourseAction[],
  targetGradeFilter: string,
  studentTargetGrades: Map<string, string>,
): CourseAction[] {
  if (targetGradeFilter === ALL_TARGET_GRADES_FILTER) return rows;
  return rows.filter((row) => {
    const studentIds = new Set([...row.studentIds, ...row.qualifyingStudentIds]);
    return [...studentIds].some((studentId) => studentTargetGrades.get(studentId) === targetGradeFilter);
  });
}

export function gradeRowsForCsv(detail: StudentPromotionRunDetail): StudentPromotionRunDetail["gradeActions"] {
  return detail.gradeActions;
}

export function courseRowsForCsv(detail: StudentPromotionRunDetail): StudentPromotionRunDetail["courseActions"] {
  return detail.courseActions;
}

export function futureSessionRowsForCsv(detail: StudentPromotionRunDetail): StudentPromotionRunDetail["futureSessionActions"] {
  return detail.futureSessionActions;
}

export function graduationRowsForCsv(detail: StudentPromotionRunDetail): StudentPromotionRunDetail["graduationActions"] {
  return detail.graduationActions;
}

export function payRateImpactRowsForCsv(detail: StudentPromotionRunDetail): Array<Record<string, unknown>> {
  return detail.payRateImpacts.map((row) => ({
    teacherName: row.teacherName,
    teacherWiseUserId: row.teacherWiseUserId,
    normalizedTier: row.normalizedTier,
    wiseClassId: row.wiseClassId,
    affectedStudents: row.affectedStudentNames,
    affectedStudentIds: row.affectedStudentIds,
    futureSessionCount: row.futureSessionCount,
    firstSessionStartTime: row.firstSessionStartTime,
    lastSessionStartTime: row.lastSessionStartTime,
    studentBand: row.studentBand,
    currentSubject: row.currentSubject,
    targetSubject: row.targetSubject,
    currentNormalizedCourseKey: row.currentNormalizedCourseKey,
    targetNormalizedCourseKey: row.targetNormalizedCourseKey,
    beforeExpectedHourlyRate: row.beforeExpectedHourlyRate,
    afterExpectedHourlyRate: row.afterExpectedHourlyRate,
    rateDelta: row.rateDelta,
    reviewStatus: row.reviewStatus,
    blockerReason: row.blockerReason,
    reviewNote: row.reviewNote,
  }));
}

export function readbackRowsForCsv(readback: StudentPromotionReadbackResult): Array<Record<string, unknown>> {
  return [
    ...readback.gradeRows.map((row) => ({
      kind: "grade",
      id: row.wiseStudentId,
      name: row.studentName,
      status: row.status,
      expected: row.expectedTargetGrade,
      current: row.currentGradeRaw,
      detail: row.detail,
    })),
    ...readback.courseRows.map((row) => ({
      kind: "course",
      id: row.wiseClassId,
      name: "",
      status: row.status,
      expected: row.expectedTargetSubject,
      current: row.liveSubject,
      detail: row.detail,
    })),
    ...readback.futureSessionRows.map((row) => ({
      kind: "future_session",
      id: row.wiseSessionId,
      name: row.wiseClassId,
      status: row.status,
      expected: row.expectedTargetSubject,
      current: row.liveSubject,
      currentNormalizedCourseKey: row.currentNormalizedCourseKey,
      targetNormalizedCourseKey: row.targetNormalizedCourseKey,
      payrollCourseKeyMatches: row.payrollCourseKeyMatches,
      scheduledStartTime: row.scheduledStartTime,
      detail: row.detail,
    })),
  ];
}

export function freshnessWarningsForDetail(detail: StudentPromotionRunDetail): string[] {
  const warnings: string[] = [];
  const freshness = detail.freshness;

  if (freshness.activeSnapshotIsNewer) {
    warnings.push(
      `This audit used the ${formatDateTime(freshness.sourceSnapshotGeneratedAt)} Credit Control snapshot `
      + `(${freshness.sourceSnapshotStudentCount.toLocaleString()} students). The active snapshot is `
      + `${formatDateTime(freshness.activeCreditControlSnapshotGeneratedAt)} `
      + `(${freshness.activeCreditControlStudentCount.toLocaleString()} students). Run a fresh audit before verification or apply.`,
    );
  }

  if (freshness.runIsOlderThan24Hours) {
    warnings.push("This audit is more than 24 hours old. Run a fresh audit before relying on these counts.");
  }

  return warnings;
}

function metric(label: string, value: number, tone = "default") {
  return (
    <Card size="sm" className={tone === "warning" ? "ring-amber-200" : undefined}>
      <CardHeader>
        <CardTitle className="text-xs text-muted-foreground">{label}</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="text-2xl font-semibold tabular-nums">{value.toLocaleString()}</div>
      </CardContent>
    </Card>
  );
}

function summaryLine(label: string, value: number, tone: "default" | "warning" = "default") {
  return (
    <div className="flex items-center justify-between gap-3 rounded border px-2 py-1.5">
      <span className="text-muted-foreground">{label}</span>
      <span className={tone === "warning" ? "font-medium text-amber-700 dark:text-amber-300" : "font-medium"}>
        {value.toLocaleString()}
      </span>
    </div>
  );
}

function formatRate(value: number | null): string {
  if (value === null) return "-";
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "THB",
    maximumFractionDigits: 0,
  }).format(value);
}

function reviewBadge(status: string) {
  if (status === "verified_correct") return "default";
  if (status === "incorrect" || status === "blocked") return "destructive";
  return "outline";
}

function GradeTable({ rows }: { rows: StudentPromotionRunDetail["gradeActions"] }) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Student</TableHead>
          <TableHead>Current</TableHead>
          <TableHead>Target</TableHead>
          <TableHead>Action</TableHead>
          <TableHead>Status</TableHead>
          <TableHead>Reason</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((row) => (
          <TableRow key={row.id}>
            <TableCell className="max-w-[260px] truncate font-medium">{row.studentName || row.wiseStudentId}</TableCell>
            <TableCell>{row.currentGradeRaw || "-"}</TableCell>
            <TableCell>{row.targetGrade || "-"}</TableCell>
            <TableCell>{row.actionType.replaceAll("_", " ")}</TableCell>
            <TableCell>
              <Badge variant={statusBadge(row.status)}>{row.status}</Badge>
            </TableCell>
            <TableCell className="max-w-[260px] truncate">{row.skipReason || row.errorMessage || "-"}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

function CourseTable({ rows }: { rows: StudentPromotionRunDetail["courseActions"] }) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Current Subject</TableHead>
          <TableHead>Target Subject</TableHead>
          <TableHead>Students</TableHead>
          <TableHead>Qualifying</TableHead>
          <TableHead>Status</TableHead>
          <TableHead>Reason</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((row) => (
          <TableRow key={row.id}>
            <TableCell className="max-w-[320px] truncate font-medium">{row.currentSubject}</TableCell>
            <TableCell className="max-w-[320px] truncate">{row.targetSubject || "-"}</TableCell>
            <TableCell>{row.studentIds.length}</TableCell>
            <TableCell>{row.qualifyingStudentIds.length}</TableCell>
            <TableCell>
              <Badge variant={statusBadge(row.status)}>{row.status}</Badge>
            </TableCell>
            <TableCell className="max-w-[260px] truncate">{row.skipReason || row.errorMessage || "-"}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

function FutureSessionTable({ rows }: { rows: FutureSessionAction[] }) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Start</TableHead>
          <TableHead>Current Subject</TableHead>
          <TableHead>Target Subject</TableHead>
          <TableHead>Payroll Key</TableHead>
          <TableHead>Status</TableHead>
          <TableHead>Reason</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((row) => (
          <TableRow key={row.id}>
            <TableCell className="whitespace-nowrap">{formatDateTime(row.scheduledStartTime)}</TableCell>
            <TableCell className="max-w-[300px] truncate font-medium">{row.currentSubject || "-"}</TableCell>
            <TableCell className="max-w-[300px] truncate">{row.targetSubject}</TableCell>
            <TableCell className="max-w-[220px] truncate">{row.targetNormalizedCourseKey || "-"}</TableCell>
            <TableCell>
              <Badge variant={statusBadge(row.status)}>{row.status}</Badge>
            </TableCell>
            <TableCell className="max-w-[260px] truncate">{row.skipReason || row.errorMessage || "-"}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

function GraduationTable({
  rows,
  draft,
  busy,
  onDisposition,
}: {
  rows: GraduationAction[];
  draft: boolean;
  busy: boolean;
  onDisposition: (row: GraduationAction, disposition: "inactive" | "university") => void;
}) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Student</TableHead>
          <TableHead>Current Grade</TableHead>
          <TableHead>Disposition</TableHead>
          <TableHead>Status</TableHead>
          <TableHead>Review</TableHead>
          <TableHead className="text-right">Choose</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((row) => (
          <TableRow key={row.id}>
            <TableCell className="max-w-[260px] truncate font-medium">{row.studentName || row.wiseStudentId}</TableCell>
            <TableCell>{row.currentGradeRaw || "-"}</TableCell>
            <TableCell>{row.disposition ? row.disposition.replaceAll("_", " ") : "Unresolved"}</TableCell>
            <TableCell>
              <Badge variant={statusBadge(row.status)}>{row.status}</Badge>
            </TableCell>
            <TableCell className="max-w-[240px] truncate">
              {row.reviewedByName ? `${row.reviewedByName} · ${formatDateTime(row.reviewedAt)}` : row.errorMessage || "-"}
            </TableCell>
            <TableCell>
              <div className="flex justify-end gap-2">
                <Button
                  size="sm"
                  variant={row.disposition === "inactive" ? "default" : "outline"}
                  disabled={!draft || busy}
                  onClick={() => onDisposition(row, "inactive")}
                >
                  Inactive
                </Button>
                <Button
                  size="sm"
                  variant={row.disposition === "university" ? "default" : "outline"}
                  disabled={!draft || busy}
                  onClick={() => onDisposition(row, "university")}
                >
                  University
                </Button>
              </div>
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

function PayRateImpactTable({
  rows,
  draft,
  busy,
  onReview,
}: {
  rows: PayRateImpact[];
  draft: boolean;
  busy: boolean;
  onReview: (row: PayRateImpact, status: "verified_correct" | "incorrect") => void;
}) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Teacher</TableHead>
          <TableHead>Class</TableHead>
          <TableHead>Affected Students</TableHead>
          <TableHead>Sessions</TableHead>
          <TableHead>Band</TableHead>
          <TableHead>Current</TableHead>
          <TableHead>Target</TableHead>
          <TableHead>Before</TableHead>
          <TableHead>After</TableHead>
          <TableHead>Delta</TableHead>
          <TableHead>Status</TableHead>
          <TableHead className="text-right">Review</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((row) => (
          <TableRow key={row.id}>
            <TableCell className="min-w-[180px]">
              <div className="font-medium">{row.teacherName || row.teacherWiseUserId || "Unknown teacher"}</div>
              <div className="text-xs text-muted-foreground">{row.normalizedTier}</div>
            </TableCell>
            <TableCell className="max-w-[140px] truncate">{row.wiseClassId}</TableCell>
            <TableCell className="max-w-[260px] truncate">{row.affectedStudentNames.join("; ") || "-"}</TableCell>
            <TableCell className="min-w-[170px]">
              <div>{row.futureSessionCount.toLocaleString()}</div>
              <div className="text-xs text-muted-foreground">
                {formatDateTime(row.firstSessionStartTime)} - {formatDateTime(row.lastSessionStartTime)}
              </div>
            </TableCell>
            <TableCell>{row.studentBand}</TableCell>
            <TableCell className="max-w-[240px] truncate">{row.currentSubject}</TableCell>
            <TableCell className="max-w-[240px] truncate">{row.targetSubject}</TableCell>
            <TableCell>{formatRate(row.beforeExpectedHourlyRate)}</TableCell>
            <TableCell>{formatRate(row.afterExpectedHourlyRate)}</TableCell>
            <TableCell className={row.rateDelta && row.rateDelta !== 0 ? "font-medium" : undefined}>
              {formatRate(row.rateDelta)}
            </TableCell>
            <TableCell className="min-w-[150px]">
              <Badge variant={reviewBadge(row.reviewStatus)}>{row.reviewStatus}</Badge>
              {row.blockerReason && (
                <div className="mt-1 text-xs text-destructive">{row.blockerReason.replaceAll("_", " ")}</div>
              )}
            </TableCell>
            <TableCell>
              <div className="flex justify-end gap-2">
                <Button
                  size="sm"
                  variant={row.reviewStatus === "verified_correct" ? "default" : "outline"}
                  disabled={!draft || busy || Boolean(row.blockerReason) || row.reviewStatus === "blocked"}
                  onClick={() => onReview(row, "verified_correct")}
                >
                  <CheckCircle2 />
                  Correct
                </Button>
                <Button
                  size="sm"
                  variant={row.reviewStatus === "incorrect" ? "destructive" : "outline"}
                  disabled={!draft || busy}
                  onClick={() => onReview(row, "incorrect")}
                >
                  <XCircle />
                  Incorrect
                </Button>
              </div>
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

export function StudentPromotionsWorkspace({ initialDetail }: Props) {
  const [detail, setDetail] = useState<Detail>(initialDetail);
  const [readback, setReadback] = useState<StudentPromotionReadbackResult | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [verificationNote, setVerificationNote] = useState("");
  const [targetGradeFilter, setTargetGradeFilter] = useState(ALL_TARGET_GRADES_FILTER);

  const targetGradeOptions = useMemo(
    () => buildTargetGradeFilterOptions(detail?.gradeActions ?? []),
    [detail],
  );

  const effectiveTargetGradeFilter = targetGradeOptions.some((option) => option.value === targetGradeFilter)
    ? targetGradeFilter
    : ALL_TARGET_GRADES_FILTER;

  const studentTargetGrades = useMemo(
    () => buildStudentTargetGradeMap(detail?.gradeActions ?? []),
    [detail],
  );
  const courseActions = useMemo(() => detail?.courseActions ?? [], [detail]);
  const filteredGradeActions = useMemo(
    () => filterGradeActionsByTargetGrade(detail?.gradeActions ?? [], effectiveTargetGradeFilter),
    [detail, effectiveTargetGradeFilter],
  );
  const filteredCourseActions = useMemo(
    () => filterCourseActionsByTargetGrade(courseActions, effectiveTargetGradeFilter, studentTargetGrades),
    [courseActions, effectiveTargetGradeFilter, studentTargetGrades],
  );
  const pendingGrades = useMemo(
    () => filteredGradeActions.filter((row) => row.status === "pending"),
    [filteredGradeActions],
  );
  const skippedGrades = useMemo(
    () => filteredGradeActions.filter((row) => row.status === "skipped"),
    [filteredGradeActions],
  );
  const filteredSkippedCourseActions = useMemo(
    () => filteredCourseActions.filter((row) => row.status === "skipped"),
    [filteredCourseActions],
  );
  const futureSessionActions = useMemo(
    () => [...(detail?.futureSessionActions ?? [])].sort((left, right) => (
      new Date(left.scheduledStartTime).getTime() - new Date(right.scheduledStartTime).getTime()
    )),
    [detail],
  );
  const graduationActions = useMemo(
    () => [...(detail?.graduationActions ?? [])].sort((left, right) => left.studentName.localeCompare(right.studentName)),
    [detail],
  );
  const payRateImpacts = useMemo(
    () => [...(detail?.payRateImpacts ?? [])].sort((left, right) => (
      left.reviewStatus.localeCompare(right.reviewStatus)
      || left.teacherName.localeCompare(right.teacherName)
      || left.currentSubject.localeCompare(right.currentSubject)
    )),
    [detail],
  );
  const freshnessWarnings = useMemo(
    () => detail ? freshnessWarningsForDetail(detail) : [],
    [detail],
  );

  async function mutate(label: string, url: string, init?: RequestInit) {
    setBusy(label);
    setError(null);
    try {
      const response = await fetch(url, init);
      const payload = await response.json();
      if (!response.ok) throw new Error(payload?.error ?? `${label} failed`);
      setDetail(payload.detail);
      setReadback(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : `${label} failed`);
    } finally {
      setBusy(null);
    }
  }

  async function runReadback() {
    if (!detail) return;
    setBusy("readback");
    setError(null);
    try {
      const response = await fetch(`/api/student-promotions/runs/${detail.run.id}/readback`, { method: "POST" });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload?.error ?? "readback failed");
      setReadback(payload.readback);
    } catch (err) {
      setError(err instanceof Error ? err.message : "readback failed");
    } finally {
      setBusy(null);
    }
  }

  function updateGraduationDisposition(row: GraduationAction, disposition: "inactive" | "university") {
    if (!detail) return;
    void mutate(
      "graduation",
      `/api/student-promotions/runs/${detail.run.id}/graduation-actions/${row.id}`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ disposition }),
      },
    );
  }

  function reviewPayRateImpact(row: PayRateImpact, status: "verified_correct" | "incorrect") {
    if (!detail) return;
    void mutate(
      "pay-rate",
      `/api/student-promotions/runs/${detail.run.id}/pay-rate-impacts/${row.id}/review`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status }),
      },
    );
  }

  const staleRunBlocked = Boolean(detail && freshnessWarnings.length > 0);
  const reviewBlocked = Boolean(
    detail
      && (
        detail.summary.pendingGraduationActions > 0
        || detail.summary.pendingPayRateImpacts > 0
        || detail.summary.blockedPayRateImpacts > 0
        || detail.summary.incorrectPayRateImpacts > 0
      ),
  );
  const canVerify = detail?.run.status === "draft"
    && verificationNote.trim().length > 0
    && !staleRunBlocked
    && !reviewBlocked;
  const canApply = detail?.run.status === "verified" && !staleRunBlocked;
  const gradeReadbackExceptions = readback
    ? readback.gradeSummary.missing_from_run
      + readback.gradeSummary.skipped_needs_review
      + readback.gradeSummary.wrong_grade
      + readback.gradeSummary.unparseable_grade
      + readback.gradeSummary.fetch_failed
    : 0;
  const courseReadbackExceptions = readback
    ? readback.courseSummary.skipped_needs_review
      + readback.courseSummary.subject_drift
      + readback.courseSummary.roster_drift
      + readback.courseSummary.fetch_failed
    : 0;
  const futureSessionReadbackExceptions = readback
    ? readback.futureSessionSummary.manual_required
      + readback.futureSessionSummary.subject_drift
      + readback.futureSessionSummary.missing_class_id
      + readback.futureSessionSummary.missing_session_id
      + readback.futureSessionSummary.failed
    : 0;
  const canApplyFutureSessions = Boolean(
    detail
      && (detail.run.status === "applied" || detail.run.status === "applied_with_errors")
      && detail.summary.pendingFutureSessionActions > 0
      && !busy,
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-hidden">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Student Promotions</h1>
          <div className="mt-1 flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
            <span>Target: July 1, 2026</span>
            {detail && (
              <>
                <span>Run: {formatDateTime(detail.run.createdAt)}</span>
                <Badge variant={statusBadge(detail.run.status)}>{detail.run.status}</Badge>
              </>
            )}
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button
            variant="outline"
            onClick={() => mutate("audit", "/api/student-promotions/runs", { method: "POST" })}
            disabled={Boolean(busy)}
          >
            <RefreshCw className={busy === "audit" ? "animate-spin" : undefined} />
            Run Audit
          </Button>
          {detail && (
            <>
              <Button
                variant="outline"
                onClick={() => downloadCsv("student-promotion-grade-actions.csv", gradeRowsForCsv(detail))}
              >
                <Download />
                Grades CSV
              </Button>
              <Button
                variant="outline"
                onClick={() => downloadCsv("student-promotion-course-actions.csv", courseRowsForCsv(detail))}
              >
                <Download />
                Courses CSV
              </Button>
              <Button
                variant="outline"
                onClick={() => downloadCsv("student-promotion-future-session-actions.csv", futureSessionRowsForCsv(detail))}
              >
                <Download />
                Future Sessions CSV
              </Button>
              <Button
                variant="outline"
                onClick={() => downloadCsv("student-promotion-graduation-actions.csv", graduationRowsForCsv(detail))}
              >
                <Download />
                Graduation CSV
              </Button>
              <Button
                variant="outline"
                onClick={() => downloadCsv("student-promotion-pay-rate-impacts.csv", payRateImpactRowsForCsv(detail))}
              >
                <Download />
                Pay Rates CSV
              </Button>
            </>
          )}
        </div>
      </div>

      {error && (
        <div className="flex items-center gap-2 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          <AlertTriangle className="size-4" />
          {error}
        </div>
      )}

      {freshnessWarnings.length > 0 && (
        <div className="rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-950 dark:border-amber-800 dark:bg-amber-950/30 dark:text-amber-100">
          <div className="flex gap-2">
            <AlertTriangle className="mt-0.5 size-4 shrink-0" />
            <div className="space-y-1">
              {freshnessWarnings.map((warning) => (
                <div key={warning}>{warning}</div>
              ))}
            </div>
          </div>
        </div>
      )}

      {!detail ? (
        <div className="flex min-h-[360px] items-center justify-center rounded-lg border bg-card text-sm text-muted-foreground">
          No promotion audit has been created yet.
        </div>
      ) : (
        <>
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
            {metric("Wise accepted at audit time", detail.run.wiseAcceptedStudentCount)}
            {metric("Grade only", detail.run.gradeOnlyCount)}
            {metric("Year 8 course moves", detail.run.year8CourseMoveCount)}
            {metric("Year 11 course moves", detail.run.year11CourseMoveCount)}
            {metric("Skipped grades", detail.run.skippedGradeCount, "warning")}
            {metric("Pending courses", detail.run.pendingCourseActionCount)}
            {metric("Skipped courses", detail.run.skippedCourseActionCount, "warning")}
            {metric("Pending future sessions", detail.summary.pendingFutureSessionActions)}
            {metric("Future session matched", detail.summary.appliedFutureSessionActions)}
            {metric("Year 13 unresolved", detail.summary.pendingGraduationActions, detail.summary.pendingGraduationActions > 0 ? "warning" : "default")}
            {metric("University graduates", detail.summary.universityGraduationActions)}
            {metric("Inactive graduates", detail.summary.inactiveGraduationActions)}
            {metric("Pay rates pending", detail.summary.pendingPayRateImpacts, detail.summary.pendingPayRateImpacts > 0 ? "warning" : "default")}
            {metric("Pay rates blocked", detail.summary.blockedPayRateImpacts + detail.summary.incorrectPayRateImpacts, detail.summary.blockedPayRateImpacts + detail.summary.incorrectPayRateImpacts > 0 ? "warning" : "default")}
          </div>

          <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_360px]">
            <Tabs defaultValue="pending-grades" className="min-h-0 overflow-hidden">
              <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
                <TabsList>
                  <TabsTrigger value="pending-grades">Pending Grades</TabsTrigger>
                  <TabsTrigger value="courses">Courses</TabsTrigger>
                  <TabsTrigger value="future-sessions">Future Sessions</TabsTrigger>
                  <TabsTrigger value="graduation">Graduation</TabsTrigger>
                  <TabsTrigger value="pay-rates">Pay Rates</TabsTrigger>
                  <TabsTrigger value="skipped-grades">Skipped Grades</TabsTrigger>
                  <TabsTrigger value="skipped-courses">Skipped Courses</TabsTrigger>
                </TabsList>
                <div className="flex flex-wrap items-center gap-3 text-sm">
                  <div className="text-muted-foreground">
                    Showing {filteredGradeActions.length.toLocaleString()} of {detail.gradeActions.length.toLocaleString()} grade actions
                  </div>
                  <label className="flex items-center gap-2">
                    <span className="text-muted-foreground">Target grade</span>
                    <Select
                      value={effectiveTargetGradeFilter}
                      onValueChange={(value) => setTargetGradeFilter(value ?? ALL_TARGET_GRADES_FILTER)}
                    >
                      <SelectTrigger className="h-8 w-[240px] bg-background">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent align="end">
                        {targetGradeOptions.map((option) => (
                          <SelectItem key={option.value} value={option.value}>
                            {option.label} ({option.count.toLocaleString()})
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </label>
                </div>
              </div>
              <TabsContent value="pending-grades" className="mt-3 max-h-[520px] overflow-auto rounded-lg border bg-card">
                <GradeTable rows={pendingGrades} />
              </TabsContent>
              <TabsContent value="courses" className="mt-3 max-h-[520px] overflow-auto rounded-lg border bg-card">
                <CourseTable rows={filteredCourseActions} />
              </TabsContent>
              <TabsContent value="future-sessions" className="mt-3 max-h-[520px] overflow-auto rounded-lg border bg-card">
                <FutureSessionTable rows={futureSessionActions} />
              </TabsContent>
              <TabsContent value="graduation" className="mt-3 max-h-[520px] overflow-auto rounded-lg border bg-card">
                <GraduationTable
                  rows={graduationActions}
                  draft={detail.run.status === "draft"}
                  busy={Boolean(busy)}
                  onDisposition={updateGraduationDisposition}
                />
              </TabsContent>
              <TabsContent value="pay-rates" className="mt-3 max-h-[520px] overflow-auto rounded-lg border bg-card">
                <PayRateImpactTable
                  rows={payRateImpacts}
                  draft={detail.run.status === "draft"}
                  busy={Boolean(busy)}
                  onReview={reviewPayRateImpact}
                />
              </TabsContent>
              <TabsContent value="skipped-grades" className="mt-3 max-h-[520px] overflow-auto rounded-lg border bg-card">
                <GradeTable rows={skippedGrades} />
              </TabsContent>
              <TabsContent value="skipped-courses" className="mt-3 max-h-[520px] overflow-auto rounded-lg border bg-card">
                <CourseTable rows={filteredSkippedCourseActions} />
              </TabsContent>
            </Tabs>

            <div className="flex flex-col gap-4">
              <Card>
                <CardHeader>
                  <CardTitle className="flex items-center gap-2">
                    <ShieldCheck className="size-4" />
                    Verification
                  </CardTitle>
                </CardHeader>
                <CardContent className="space-y-3">
                  <Textarea
                    value={verificationNote}
                    onChange={(event) => setVerificationNote(event.target.value)}
                    placeholder="Endpoint verification note"
                    disabled={detail.run.status !== "draft"}
                  />
                  <div className="grid gap-2 text-sm">
                    {summaryLine("Year 13 decisions pending", detail.summary.pendingGraduationActions, detail.summary.pendingGraduationActions > 0 ? "warning" : "default")}
                    {summaryLine("Pay-rate rows pending", detail.summary.pendingPayRateImpacts, detail.summary.pendingPayRateImpacts > 0 ? "warning" : "default")}
                    {summaryLine("Pay-rate rows blocked/incorrect", detail.summary.blockedPayRateImpacts + detail.summary.incorrectPayRateImpacts, detail.summary.blockedPayRateImpacts + detail.summary.incorrectPayRateImpacts > 0 ? "warning" : "default")}
                  </div>
                  <Button
                    className="w-full"
                    disabled={!canVerify || Boolean(busy)}
                    onClick={() => mutate("verify", `/api/student-promotions/runs/${detail.run.id}/verify`, {
                      method: "POST",
                      headers: { "Content-Type": "application/json" },
                      body: JSON.stringify({
                        endpointVerificationConfirmed: true,
                        endpointVerificationNote: verificationNote,
                      }),
                    })}
                  >
                    <CheckCircle2 />
                    Verify Run
                  </Button>
                </CardContent>
              </Card>

              <Card>
                <CardHeader>
                  <CardTitle className="flex items-center gap-2">
                    <CalendarClock className="size-4" />
                    Apply
                  </CardTitle>
                </CardHeader>
                <CardContent className="space-y-3 text-sm text-muted-foreground">
                  <div>Verified: {formatDateTime(detail.run.verifiedAt)}</div>
                  <div>Applied: {formatDateTime(detail.run.applyFinishedAt)}</div>
                  <div>Future session pending: {detail.summary.pendingFutureSessionActions.toLocaleString()}</div>
                  <Button
                    variant="destructive"
                    className="w-full"
                    disabled={!canApply || Boolean(busy)}
                    onClick={() => mutate("apply", `/api/student-promotions/runs/${detail.run.id}/apply`, {
                      method: "POST",
                      headers: { "Content-Type": "application/json" },
                      body: JSON.stringify({ confirm: "apply-student-promotions" }),
                    })}
                  >
                    <Play />
                    Apply Verified Run
                  </Button>
                  <Button
                    variant="outline"
                    className="w-full"
                    disabled={!canApplyFutureSessions}
                    onClick={() => mutate("future-sessions", `/api/student-promotions/runs/${detail.run.id}/future-sessions/apply`, {
                      method: "POST",
                      headers: { "Content-Type": "application/json" },
                      body: JSON.stringify({ confirm: "apply-future-session-subjects" }),
                    })}
                  >
                    <Play />
                    Apply Future Session Subjects
                  </Button>
                </CardContent>
              </Card>

              <Card>
                <CardHeader>
                  <CardTitle className="flex items-center gap-2">
                    <ShieldCheck className="size-4" />
                    Readback
                  </CardTitle>
                </CardHeader>
                <CardContent className="space-y-3 text-sm">
                  <Button
                    variant="outline"
                    className="w-full"
                    disabled={!detail || Boolean(busy)}
                    onClick={runReadback}
                  >
                    <RefreshCw className={busy === "readback" ? "animate-spin" : undefined} />
                    Run Readback Check
                  </Button>
                  {readback && (
                    <div className="space-y-3">
                      <div className="text-muted-foreground">
                        Checked: {formatDateTime(readback.checkedAt)}
                      </div>
                      <div className="grid gap-2">
                        {summaryLine("Live accepted", readback.liveAcceptedStudentCount)}
                        {summaryLine("Promoted exact", readback.gradeSummary.promoted_exact)}
                        {summaryLine("Promoted equivalent", readback.gradeSummary.promoted_equivalent, "warning")}
                        {summaryLine("Grade exceptions", gradeReadbackExceptions, gradeReadbackExceptions > 0 ? "warning" : "default")}
                        {summaryLine("Course target matched", readback.courseSummary.target_matched)}
                        {summaryLine("Course exceptions", courseReadbackExceptions, courseReadbackExceptions > 0 ? "warning" : "default")}
                        {summaryLine("Future sessions checked", readback.futureSessionRows.length)}
                        {summaryLine("Future target matched", readback.futureSessionSummary.target_matched)}
                        {summaryLine("Future pending update", readback.futureSessionSummary.pending_update)}
                        {summaryLine("Future manual required", readback.futureSessionSummary.manual_required, readback.futureSessionSummary.manual_required > 0 ? "warning" : "default")}
                        {summaryLine("Future exceptions", futureSessionReadbackExceptions, futureSessionReadbackExceptions > 0 ? "warning" : "default")}
                      </div>
                      <Button
                        variant="outline"
                        className="w-full"
                        onClick={() => downloadCsv("student-promotion-readback.csv", readbackRowsForCsv(readback))}
                      >
                        <Download />
                        Readback CSV
                      </Button>
                    </div>
                  )}
                </CardContent>
              </Card>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
