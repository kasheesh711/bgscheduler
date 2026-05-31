"use client";

import {
  AlertTriangle,
  CalendarDays,
  Clock,
  Eye,
  FileText,
  RefreshCw,
  Save,
  Search,
  ShieldAlert,
} from "lucide-react";
import { signIn } from "next-auth/react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";

const SHEETS_WRITE_SCOPE = "openid email profile https://www.googleapis.com/auth/spreadsheets";

type WorkflowStatus = "new" | "needs_review" | "in_progress" | "done" | "ignored" | "canceled_by_tutor";

interface LeaveRequestRow {
  id: string;
  sourceRowNumber: number;
  sourceSubmittedAt: string | null;
  tutorName: string;
  tutorEmail: string | null;
  tutorDisplayName: string | null;
  matchConfidence: string;
  startDate: string | null;
  endDate: string | null;
  timePeriod: string | null;
  specificTimeText: string | null;
  normalizationStatus: string;
  normalizationError: string | null;
  reportedAffectedClasses: string | null;
  sourceSheetStatus: string | null;
  workflowStatus: WorkflowStatus;
  staffNote: string | null;
  sheetWriteStatus: "not_required" | "pending" | "success" | "failed";
  sheetWriteError: string | null;
  affectedClassCount: number;
  cancellationPreviewCount: number;
  unread: boolean;
}

interface LeaveListResponse {
  cards: {
    total: number;
    new: number;
    needsReview: number;
    sheetWriteFailed: number;
    affectedClasses: number;
  };
  unreadActionCount: number;
  timeline: Array<{ date: string; total: number; needsAction: number; affectedClasses: number }>;
  requests: LeaveRequestRow[];
  googleSheets?: { connected: boolean; writeConnected?: boolean; email: string | null; lastError: string | null };
}

interface AffectedSession {
  id: string;
  wiseClassId: string | null;
  wiseSessionId: string;
  startTime: string;
  endTime: string;
  startMinute: number;
  endMinute: number;
  wiseStatus: string;
  sessionType: string | null;
  location: string | null;
  studentName: string | null;
  studentCount: number | null;
  subject: string | null;
  classType: string | null;
  title: string | null;
  overlapMinutes: number;
  cancelPreviewSelected: boolean;
}

interface ActivityLog {
  id: string;
  actionType: string;
  status: string;
  message: string | null;
  errorMessage: string | null;
  createdByEmail: string | null;
  createdAt: string;
  requestPayload: Record<string, unknown>;
}

interface LeaveRequestDetail {
  request: LeaveRequestRow & {
    rawValues: Record<string, unknown>;
    reason: string | null;
    makeupOptions: string | null;
    certificateUrl: string | null;
    situationText: string | null;
    daysNotice: number | null;
    lateNotice: string | null;
    adminFee: number | null;
    emergencyUsed: number | null;
    matchReason: string | null;
  };
  affectedSessions: AffectedSession[];
  activityLog: ActivityLog[];
}

const STATUS_OPTIONS: Array<{ value: WorkflowStatus | "all"; label: string }> = [
  { value: "all", label: "All" },
  { value: "new", label: "New" },
  { value: "needs_review", label: "Needs review" },
  { value: "in_progress", label: "In progress" },
  { value: "done", label: "Done" },
  { value: "ignored", label: "Ignored" },
  { value: "canceled_by_tutor", label: "Canceled by tutor" },
];

function statusLabel(status: string): string {
  return STATUS_OPTIONS.find((item) => item.value === status)?.label ?? status;
}

function timeLabel(minute: number): string {
  const hours = Math.floor(minute / 60);
  const minutes = minute % 60;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
}

function dateRange(row: Pick<LeaveRequestRow, "startDate" | "endDate">): string {
  if (!row.startDate) return "Needs review";
  if (!row.endDate || row.endDate === row.startDate) return row.startDate;
  return `${row.startDate} - ${row.endDate}`;
}

function formatDateTime(value: string | null): string {
  if (!value) return "Not synced";
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Bangkok",
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(value));
}

function statusClass(status: string) {
  if (status === "new") return "border-sky-200 bg-sky-50 text-sky-800";
  if (status === "needs_review") return "border-amber-200 bg-amber-50 text-amber-900";
  if (status === "done") return "border-emerald-200 bg-emerald-50 text-emerald-800";
  if (status === "ignored") return "border-slate-200 bg-slate-50 text-slate-700";
  if (status === "canceled_by_tutor") return "border-purple-200 bg-purple-50 text-purple-800";
  return "border-blue-200 bg-blue-50 text-blue-800";
}

function Kpi({ label, value, detail, tone }: { label: string; value: number | string; detail: string; tone: string }) {
  return (
    <Card className="rounded-lg px-4 py-3">
      <div className={cn("mb-2 h-1 w-10 rounded-full", tone)} />
      <div className="text-[10px] font-semibold uppercase text-muted-foreground">{label}</div>
      <div className="mt-1 text-2xl font-semibold tracking-tight">{value}</div>
      <div className="truncate text-xs text-muted-foreground">{detail}</div>
    </Card>
  );
}

async function checkedJson<T>(response: Response, fallback: string): Promise<T> {
  const payload = await response.json().catch(() => null) as { error?: string } | T | null;
  if (!response.ok) {
    throw new Error(payload && typeof payload === "object" && "error" in payload && payload.error ? payload.error : fallback);
  }
  return payload as T;
}

function AffectedSessionRow({
  session,
  selected,
  onToggle,
}: {
  session: AffectedSession;
  selected: boolean;
  onToggle: (checked: boolean) => void;
}) {
  return (
    <label className="grid grid-cols-[20px_minmax(0,1fr)_80px] gap-2 rounded-md border border-border bg-background px-3 py-2 text-xs">
      <input
        type="checkbox"
        checked={selected}
        onChange={(event) => onToggle(event.currentTarget.checked)}
        className="mt-0.5"
      />
      <span className="min-w-0">
        <span className="block truncate font-medium">
          {session.title || session.studentName || session.subject || "Class"}
        </span>
        <span className="block truncate text-muted-foreground">
          {formatDateTime(session.startTime)} / {timeLabel(session.startMinute)}-{timeLabel(session.endMinute)}
        </span>
        <span className="block truncate text-muted-foreground">
          {session.wiseClassId ?? "No class ID"} / {session.wiseSessionId}
        </span>
      </span>
      <span className="text-right text-muted-foreground">
        {session.overlapMinutes}m
      </span>
    </label>
  );
}

export function LeaveRequestsWorkspace() {
  const [status, setStatus] = useState("all");
  const [query, setQuery] = useState("");
  const [data, setData] = useState<LeaveListResponse | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<LeaveRequestDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [detailLoading, setDetailLoading] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [staffNote, setStaffNote] = useState("");
  const [sheetText, setSheetText] = useState("");
  const [detailStatus, setDetailStatus] = useState<WorkflowStatus>("new");
  const [selectedAffected, setSelectedAffected] = useState<Set<string>>(new Set());

  const loadList = useCallback(async () => {
    setLoading(true);
    setError(null);
    const params = new URLSearchParams();
    if (status !== "all") params.set("status", status);
    if (query.trim()) params.set("q", query.trim());
    try {
      const result = await checkedJson<LeaveListResponse>(
        await fetch(`/api/leave-requests?${params.toString()}`),
        "Leave request list failed",
      );
      setData(result);
      setSelectedId((current) => current ?? result.requests[0]?.id ?? null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Leave request list failed");
    } finally {
      setLoading(false);
    }
  }, [query, status]);

  const loadDetail = useCallback(async (id: string | null) => {
    if (!id) {
      setDetail(null);
      return;
    }
    setDetailLoading(true);
    try {
      const result = await checkedJson<LeaveRequestDetail>(
        await fetch(`/api/leave-requests/${id}`),
        "Leave request detail failed",
      );
      setDetail(result);
      setDetailStatus(result.request.workflowStatus);
      setStaffNote(result.request.staffNote ?? "");
      setSheetText(result.request.sourceSheetStatus ?? statusLabel(result.request.workflowStatus));
      setSelectedAffected(new Set(result.affectedSessions.filter((row) => row.cancelPreviewSelected).map((row) => row.id)));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Leave request detail failed");
    } finally {
      setDetailLoading(false);
    }
  }, []);

  useEffect(() => {
    loadList();
  }, [loadList]);

  useEffect(() => {
    loadDetail(selectedId);
  }, [loadDetail, selectedId]);

  const maxTimeline = useMemo(() => Math.max(1, ...(data?.timeline.map((row) => row.affectedClasses) ?? [1])), [data]);

  async function runSync() {
    setSyncing(true);
    setError(null);
    try {
      await checkedJson(await fetch("/api/leave-requests/sync", { method: "POST" }), "Leave request sync failed");
      await loadList();
      if (selectedId) await loadDetail(selectedId);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Leave request sync failed");
    } finally {
      setSyncing(false);
    }
  }

  async function saveStatus(retrySheetWrite = false) {
    if (!detail) return;
    setSaving(true);
    setError(null);
    try {
      const result = await checkedJson<{ warning?: string | null; detail: LeaveRequestDetail }>(
        await fetch(`/api/leave-requests/${detail.request.id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            workflowStatus: detailStatus,
            staffNote,
            sheetStatusText: sheetText,
            retrySheetWrite,
          }),
        }),
        "Leave request update failed",
      );
      setDetail(result.detail);
      await loadList();
      if (result.warning) setError(result.warning);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Leave request update failed");
    } finally {
      setSaving(false);
    }
  }

  async function logCancelPreview() {
    if (!detail || selectedAffected.size === 0) return;
    setSaving(true);
    setError(null);
    try {
      const result = await checkedJson<{ detail: LeaveRequestDetail }>(
        await fetch(`/api/leave-requests/${detail.request.id}/wise-cancel-preview`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ affectedSessionIds: [...selectedAffected] }),
        }),
        "Wise cancel preview failed",
      );
      setDetail(result.detail);
      await loadList();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Wise cancel preview failed");
    } finally {
      setSaving(false);
    }
  }

  return (
    <main className="flex min-h-0 flex-1 flex-col gap-3 overflow-hidden bg-background px-4 py-3 lg:px-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-xl font-semibold tracking-tight">Leave Requests</h1>
          <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            <span>Form Responses 1</span>
            {data?.googleSheets && (
              <Badge variant="outline" className={data.googleSheets.writeConnected ? "border-emerald-200 bg-emerald-50 text-emerald-800" : "border-amber-200 bg-amber-50 text-amber-900"}>
                Sheets {data.googleSheets.writeConnected ? "write connected" : "write scope needed"}
              </Badge>
            )}
          </div>
        </div>
        <Button onClick={runSync} disabled={syncing} size="sm" className="gap-2">
          <RefreshCw className={cn("size-4", syncing && "animate-spin")} />
          Sync
        </Button>
        {data?.googleSheets && !data.googleSheets.writeConnected && (
          <Button
            variant="outline"
            size="sm"
            onClick={() => signIn("google", { callbackUrl: "/leave-requests" }, {
              prompt: "consent",
              access_type: "offline",
              scope: SHEETS_WRITE_SCOPE,
            })}
          >
            <ShieldAlert className="size-4" />
            Reconnect Sheets
          </Button>
        )}
      </div>

      {error && (
        <div className="flex items-center gap-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">
          <AlertTriangle className="size-4 shrink-0" />
          <span className="min-w-0 truncate">{error}</span>
        </div>
      )}

      <section className="grid grid-cols-2 gap-3 lg:grid-cols-5">
        <Kpi label="Requests" value={data?.cards.total ?? 0} detail="Synced rows" tone="bg-sky-500" />
        <Kpi label="New" value={data?.cards.new ?? 0} detail="Untriaged" tone="bg-blue-500" />
        <Kpi label="Review" value={data?.cards.needsReview ?? 0} detail="Match or timing issue" tone="bg-amber-500" />
        <Kpi label="Classes" value={data?.cards.affectedClasses ?? 0} detail="Wise overlaps" tone="bg-purple-500" />
        <Kpi label="Sheet Errors" value={data?.cards.sheetWriteFailed ?? 0} detail="Retryable writes" tone="bg-red-500" />
      </section>

      <section className="grid min-h-0 flex-1 gap-3 overflow-hidden lg:grid-cols-[minmax(0,1fr)_430px]">
        <div className="flex min-h-0 flex-col gap-3 overflow-hidden">
          <div className="grid gap-2 rounded-lg border border-border bg-card p-3 lg:grid-cols-[170px_minmax(0,1fr)]">
            <select
              value={status}
              onChange={(event) => setStatus(event.target.value)}
              className="h-9 rounded-md border border-input bg-background px-2 text-sm"
            >
              {STATUS_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>{option.label}</option>
              ))}
            </select>
            <div className="relative min-w-0">
              <Search className="pointer-events-none absolute left-2 top-2.5 size-4 text-muted-foreground" />
              <Input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                className="pl-8"
                placeholder="Tutor, email, reason, sheet status"
              />
            </div>
          </div>

          <div className="rounded-lg border border-border bg-card p-3">
            <div className="mb-2 flex items-center gap-2 text-xs font-semibold uppercase text-muted-foreground">
              <CalendarDays className="size-3.5" />
              Timeline
            </div>
            <div className="grid gap-1">
              {(data?.timeline ?? []).slice(0, 12).map((bucket) => (
                <div key={bucket.date} className="grid grid-cols-[82px_minmax(0,1fr)_72px] items-center gap-2 text-xs">
                  <span className="text-muted-foreground">{bucket.date.slice(5)}</span>
                  <span className="h-2 rounded-full bg-muted">
                    <span
                      className="block h-2 rounded-full bg-sky-500"
                      style={{ width: `${Math.max(4, (bucket.affectedClasses / maxTimeline) * 100)}%` }}
                    />
                  </span>
                  <span className="text-right text-muted-foreground">{bucket.affectedClasses} classes</span>
                </div>
              ))}
            </div>
          </div>

          <div className="min-h-0 flex-1 overflow-auto rounded-lg border border-border bg-card">
            <div className="sticky top-0 z-10 grid grid-cols-[82px_minmax(0,1.2fr)_110px_100px_64px] gap-2 border-b bg-card px-3 py-2 text-[10px] font-semibold uppercase text-muted-foreground max-md:hidden">
              <span>Submitted</span>
              <span>Tutor</span>
              <span>Leave</span>
              <span>Status</span>
              <span className="text-right">Wise</span>
            </div>
            {loading ? (
              <div className="p-6 text-sm text-muted-foreground">Loading...</div>
            ) : (data?.requests.length ?? 0) === 0 ? (
              <div className="p-6 text-sm text-muted-foreground">No leave requests found.</div>
            ) : (
              <div className="divide-y divide-border">
                {data!.requests.map((row) => (
                  <button
                    key={row.id}
                    type="button"
                    onClick={() => setSelectedId(row.id)}
                    className={cn(
                      "grid w-full grid-cols-1 gap-1 px-3 py-2 text-left text-sm hover:bg-muted/50 md:grid-cols-[82px_minmax(0,1.2fr)_110px_100px_64px] md:gap-2",
                      selectedId === row.id && "bg-primary/8",
                    )}
                  >
                    <span className="truncate text-xs text-muted-foreground">{formatDateTime(row.sourceSubmittedAt)}</span>
                    <span className="min-w-0">
                      <span className="block truncate font-medium">{row.tutorDisplayName ?? row.tutorName}</span>
                      <span className="block truncate text-xs text-muted-foreground">
                        {row.matchConfidence === "unmatched" ? "Unmatched" : row.tutorName}
                      </span>
                    </span>
                    <span className="truncate text-xs text-muted-foreground">{dateRange(row)}</span>
                    <span>
                      <Badge variant="outline" className={statusClass(row.workflowStatus)}>
                        {statusLabel(row.workflowStatus)}
                      </Badge>
                    </span>
                    <span className="text-right text-xs font-medium">{row.affectedClassCount}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>

        <aside className="min-h-0 overflow-auto rounded-lg border border-border bg-card">
          {!detail || detailLoading ? (
            <div className="p-4 text-sm text-muted-foreground">Select a request.</div>
          ) : (
            <div className="grid gap-4 p-4">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="truncate text-base font-semibold">{detail.request.tutorDisplayName ?? detail.request.tutorName}</div>
                  <div className="mt-1 text-xs text-muted-foreground">{dateRange(detail.request)} / {detail.request.timePeriod ?? "Full day"}</div>
                </div>
                <Badge variant="outline" className={statusClass(detail.request.workflowStatus)}>
                  {statusLabel(detail.request.workflowStatus)}
                </Badge>
              </div>

              {(detail.request.normalizationStatus !== "ok" || detail.request.matchConfidence === "unmatched" || detail.request.sheetWriteStatus === "failed") && (
                <div className="grid gap-1 rounded-md border border-amber-200 bg-amber-50 p-3 text-xs text-amber-900">
                  {detail.request.normalizationError && <span>{detail.request.normalizationError}</span>}
                  {detail.request.matchConfidence === "unmatched" && <span>{detail.request.matchReason}</span>}
                  {detail.request.sheetWriteStatus === "failed" && <span>{detail.request.sheetWriteError}</span>}
                </div>
              )}

              <div className="grid grid-cols-2 gap-2 text-xs">
                <div className="rounded-md bg-muted/50 p-2">
                  <div className="text-muted-foreground">Submitted count</div>
                  <div className="font-medium">{detail.request.reportedAffectedClasses ?? "Blank"}</div>
                </div>
                <div className="rounded-md bg-muted/50 p-2">
                  <div className="text-muted-foreground">Wise overlaps</div>
                  <div className="font-medium">{detail.affectedSessions.length}</div>
                </div>
                <div className="rounded-md bg-muted/50 p-2">
                  <div className="text-muted-foreground">Sheet Status</div>
                  <div className="truncate font-medium">{detail.request.sourceSheetStatus ?? "Blank"}</div>
                </div>
                <div className="rounded-md bg-muted/50 p-2">
                  <div className="text-muted-foreground">Writeback</div>
                  <div className="truncate font-medium">{detail.request.sheetWriteStatus}</div>
                </div>
              </div>

              <section className="grid gap-2">
                <div className="flex items-center gap-2 text-xs font-semibold uppercase text-muted-foreground">
                  <Save className="size-3.5" />
                  Workflow
                </div>
                <select
                  value={detailStatus}
                  onChange={(event) => setDetailStatus(event.target.value as WorkflowStatus)}
                  className="h-9 rounded-md border border-input bg-background px-2 text-sm"
                >
                  {STATUS_OPTIONS.filter((option) => option.value !== "all").map((option) => (
                    <option key={option.value} value={option.value}>{option.label}</option>
                  ))}
                </select>
                <Input value={sheetText} onChange={(event) => setSheetText(event.target.value)} placeholder="Sheet Status text" />
                <Textarea value={staffNote} onChange={(event) => setStaffNote(event.target.value)} placeholder="Staff note" rows={3} />
                <div className="flex gap-2">
                  <Button onClick={() => saveStatus(false)} disabled={saving} size="sm" className="gap-2">
                    <Save className="size-4" />
                    Save
                  </Button>
                  {detail.request.sheetWriteStatus === "failed" && (
                    <Button onClick={() => saveStatus(true)} disabled={saving} variant="outline" size="sm" className="gap-2">
                      <RefreshCw className="size-4" />
                      Retry Sheet
                    </Button>
                  )}
                </div>
              </section>

              <section className="grid gap-2">
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-2 text-xs font-semibold uppercase text-muted-foreground">
                    <ShieldAlert className="size-3.5" />
                    Affected Classes
                  </div>
                  <Badge variant="outline">{selectedAffected.size} selected</Badge>
                </div>
                <div className="grid max-h-72 gap-2 overflow-auto">
                  {detail.affectedSessions.length === 0 ? (
                    <div className="rounded-md bg-muted/50 p-3 text-xs text-muted-foreground">No Wise sessions overlap.</div>
                  ) : detail.affectedSessions.map((session) => (
                    <AffectedSessionRow
                      key={session.id}
                      session={session}
                      selected={selectedAffected.has(session.id)}
                      onToggle={(checked) => {
                        setSelectedAffected((current) => {
                          const next = new Set(current);
                          if (checked) next.add(session.id);
                          else next.delete(session.id);
                          return next;
                        });
                      }}
                    />
                  ))}
                </div>
                <Button
                  onClick={logCancelPreview}
                  disabled={saving || selectedAffected.size === 0}
                  variant="outline"
                  size="sm"
                  className="gap-2 border-red-200 text-red-700 hover:bg-red-50"
                >
                  <Eye className="size-4" />
                  Log Wise Cancel Preview
                </Button>
              </section>

              <section className="grid gap-2 text-xs">
                <div className="flex items-center gap-2 font-semibold uppercase text-muted-foreground">
                  <FileText className="size-3.5" />
                  Form Notes
                </div>
                <div className="grid gap-2 rounded-md bg-muted/50 p-3">
                  <div><span className="text-muted-foreground">Reason:</span> {detail.request.reason ?? "Blank"}</div>
                  <div><span className="text-muted-foreground">Make-up:</span> {detail.request.makeupOptions ?? "Blank"}</div>
                  <div><span className="text-muted-foreground">Certificate:</span> {detail.request.certificateUrl ?? "Blank"}</div>
                  <div><span className="text-muted-foreground">Emergency:</span> {detail.request.emergencyUsed ?? "Blank"}</div>
                </div>
              </section>

              <section className="grid gap-2">
                <div className="flex items-center gap-2 text-xs font-semibold uppercase text-muted-foreground">
                  <Clock className="size-3.5" />
                  Action History
                </div>
                <div className="grid max-h-56 gap-2 overflow-auto text-xs">
                  {detail.activityLog.map((log) => (
                    <div key={log.id} className="rounded-md border border-border p-2">
                      <div className="flex items-center justify-between gap-2">
                        <span className="font-medium">{log.actionType}</span>
                        <span className="text-muted-foreground">{formatDateTime(log.createdAt)}</span>
                      </div>
                      <div className="mt-1 text-muted-foreground">{log.message ?? log.errorMessage ?? log.status}</div>
                    </div>
                  ))}
                </div>
              </section>

              <details className="rounded-md border border-border p-2 text-xs">
                <summary className="cursor-pointer font-medium">Raw form payload</summary>
                <pre className="mt-2 max-h-64 overflow-auto rounded bg-muted p-2 text-[11px] text-muted-foreground">
                  {JSON.stringify(detail.request.rawValues, null, 2)}
                </pre>
              </details>
            </div>
          )}
        </aside>
      </section>
    </main>
  );
}
