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
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import type { StudentPromotionRunDetail } from "@/lib/student-promotions/data";

type Detail = StudentPromotionRunDetail | null;

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

  const pendingGrades = useMemo(
    () => detail?.gradeActions.filter((row) => row.status === "pending") ?? [],
    [detail],
  );
  const skippedGrades = useMemo(
    () => detail?.gradeActions.filter((row) => row.status === "skipped") ?? [],
    [detail],
  );
  const courseActions = detail?.courseActions ?? [];
  const skippedCourseActions = courseActions.filter((row) => row.status === "skipped");

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
                onClick={() => downloadCsv("student-promotion-grade-actions.csv", detail.gradeActions)}
              >
                <Download />
                Grades CSV
              </Button>
              <Button
                variant="outline"
                onClick={() => downloadCsv("student-promotion-course-actions.csv", detail.courseActions)}
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
              <TabsList>
                <TabsTrigger value="pending-grades">Pending Grades</TabsTrigger>
                <TabsTrigger value="courses">Courses</TabsTrigger>
                <TabsTrigger value="skipped-grades">Skipped Grades</TabsTrigger>
                <TabsTrigger value="skipped-courses">Skipped Courses</TabsTrigger>
              </TabsList>
              <TabsContent value="pending-grades" className="mt-3 max-h-[520px] overflow-auto rounded-lg border bg-card">
                <GradeTable rows={pendingGrades} />
              </TabsContent>
              <TabsContent value="courses" className="mt-3 max-h-[520px] overflow-auto rounded-lg border bg-card">
                <CourseTable rows={courseActions} />
              </TabsContent>
              <TabsContent value="skipped-grades" className="mt-3 max-h-[520px] overflow-auto rounded-lg border bg-card">
                <GradeTable rows={skippedGrades} />
              </TabsContent>
              <TabsContent value="skipped-courses" className="mt-3 max-h-[520px] overflow-auto rounded-lg border bg-card">
                <CourseTable rows={skippedCourseActions} />
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
