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
import type { StudentPromotionRunDetail } from "@/lib/student-promotions/data";

type Detail = StudentPromotionRunDetail | null;
type GradeAction = StudentPromotionRunDetail["gradeActions"][number];
type CourseAction = StudentPromotionRunDetail["courseActions"][number];

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
        {rows.slice(0, 500).map((row) => (
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

export function StudentPromotionsWorkspace({ initialDetail }: Props) {
  const [detail, setDetail] = useState<Detail>(initialDetail);
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
  const courseActions = detail?.courseActions ?? [];
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

  async function mutate(label: string, url: string, init?: RequestInit) {
    setBusy(label);
    setError(null);
    try {
      const response = await fetch(url, init);
      const payload = await response.json();
      if (!response.ok) throw new Error(payload?.error ?? `${label} failed`);
      setDetail(payload.detail);
    } catch (err) {
      setError(err instanceof Error ? err.message : `${label} failed`);
    } finally {
      setBusy(null);
    }
  }

  const canVerify = detail?.run.status === "draft" && verificationNote.trim().length > 0;
  const canApply = detail?.run.status === "verified";

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

      {!detail ? (
        <div className="flex min-h-[360px] items-center justify-center rounded-lg border bg-card text-sm text-muted-foreground">
          No promotion audit has been created yet.
        </div>
      ) : (
        <>
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
            {metric("Wise accepted", detail.run.wiseAcceptedStudentCount)}
            {metric("Grade only", detail.run.gradeOnlyCount)}
            {metric("Year 8 course moves", detail.run.year8CourseMoveCount)}
            {metric("Year 11 course moves", detail.run.year11CourseMoveCount)}
            {metric("Skipped grades", detail.run.skippedGradeCount, "warning")}
            {metric("Pending courses", detail.run.pendingCourseActionCount)}
            {metric("Skipped courses", detail.run.skippedCourseActionCount, "warning")}
            {metric("Website snapshot", detail.run.websiteSnapshotStudentCount)}
          </div>

          <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_360px]">
            <Tabs defaultValue="pending-grades" className="min-h-0 overflow-hidden">
              <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
                <TabsList>
                  <TabsTrigger value="pending-grades">Pending Grades</TabsTrigger>
                  <TabsTrigger value="courses">Courses</TabsTrigger>
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
                </CardContent>
              </Card>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
