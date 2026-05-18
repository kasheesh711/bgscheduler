"use client";

import Image from "next/image";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  CalendarDays,
  Grid3X3,
  Mail,
  Map as MapIcon,
  Play,
  RefreshCw,
  Send,
  Table2,
  UploadCloud,
  Users,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { formatBangkokShortDateTime } from "@/lib/bangkok-time";
import { buildTimelineBounds, minuteToTimeLabel, snapTimelinePlaybackMinute } from "@/lib/classrooms/visualization";
import { AssignmentTimelineControls } from "./assignment-timeline-controls";
import { FloorPlanOccupancy } from "./floor-plan-occupancy";
import { RoomCalendarView } from "./room-calendar-view";
import { RoomOccupancyHeatmap } from "./room-occupancy-heatmap";
import type { AssignmentDetail, ClassroomRow } from "./types";

const NO_ROOM_AVAILABLE = "NO_ROOM_AVAILABLE";
const REMOTE_NO_ROOM_NEEDED = "REMOTE_NO_ROOM_NEEDED";

interface ScheduleEmailPreview {
  ready: boolean;
  sendable: boolean;
  assignmentRunId: string;
  assignmentDate: string;
  subject: string;
  hardBlockers: Array<{ type: string; message: string; tutorDisplayName?: string }>;
  blockers: Array<{ type: string; message: string; tutorDisplayName?: string }>;
  readyCount: number;
  blockedCount: number;
  recipients: Array<{
    groupId: string;
    canonicalKey: string;
    tutorDisplayName: string;
    email: string | null;
    status: "ready" | "blocked";
    blockReason: string | null;
  }>;
  previews: Array<{
    recipient: {
      groupId: string;
      tutorDisplayName: string;
      email: string | null;
      status: "ready" | "blocked";
      blockReason: string | null;
    };
    subject: string;
    text: string;
    roomSteps: Array<{
      order: number;
      time: string;
      room: string;
    }>;
    mapImageUrl: string;
    blocks: Array<{
      rowId: string;
      time: string;
      studentOrClass: string;
      subject: string;
      mode: string;
      room: string;
    }>;
  }>;
}

interface PublishJobProgress {
  jobId: string;
  runId: string;
  status: "pending" | "running" | "succeeded" | "partial" | "failed";
  totalCount: number;
  eligibleCount: number;
  completedCount: number;
  successCount: number;
  failedCount: number;
  skippedCount: number;
  remainingCount: number;
  elapsedMs: number | null;
  estimatedRemainingMs: number | null;
  lastError: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

interface ScheduleEmailSendResult {
  summary: { attempted: number; success: number; failed: number; blocked: number };
  recipients: Array<{
    tutorDisplayName: string;
    email: string | null;
    sendStatus: "sent" | "failed" | "blocked";
    resendEmailId: string | null;
    error: string | null;
  }>;
  preview: ScheduleEmailPreview;
}

interface PublishStartResult {
  jobId: string;
  progress: PublishJobProgress;
}

interface PublishPollResult {
  progress: PublishJobProgress;
  detail?: AssignmentDetail;
}

interface WiseSyncResult {
  success?: boolean;
  promotedSnapshotId?: string | null;
  error?: string;
  errorSummary?: string | null;
}

function todayBangkok(): string {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Bangkok",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const byType = new Map(parts.map((part) => [part.type, part.value]));
  return `${byType.get("year")}-${byType.get("month")}-${byType.get("day")}`;
}

function formatRowTime(row: Pick<ClassroomRow, "startMinute" | "endMinute">): string {
  return `${minuteToTimeLabel(row.startMinute)}-${minuteToTimeLabel(row.endMinute)}`;
}

function classLabel(row: ClassroomRow): string {
  return row.subject || row.classType || row.title || "";
}

function roomLabel(row: ClassroomRow): string {
  if (row.status === "remote" || row.assignedRoom === REMOTE_NO_ROOM_NEEDED) {
    return "Remote / no room needed";
  }
  return row.assignedRoom;
}

function isPublishJobTerminal(status: PublishJobProgress["status"]): boolean {
  return status === "succeeded" || status === "partial" || status === "failed";
}

function formatDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return "-";
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes === 0) return `${seconds}s`;
  return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
}

function formatAge(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return "unknown";
  const minutes = Math.max(0, Math.round(ms / 60000));
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

function isPublishEligible(row: ClassroomRow): boolean {
  return (
    row.status === "assigned" &&
    row.assignedRoom !== NO_ROOM_AVAILABLE &&
    row.assignedRoom !== REMOTE_NO_ROOM_NEEDED &&
    row.sessionType?.toUpperCase() === "OFFLINE" &&
    Boolean(row.wiseClassId) &&
    !row.warnings.includes("needs_review_missing_capacity")
  );
}

function StatusBadge({ status }: { status: ClassroomRow["status"] }) {
  if (status === "assigned") return <Badge className="bg-available text-white">Assigned</Badge>;
  if (status === "remote") return <Badge variant="secondary">Remote</Badge>;
  if (status === "no_room") return <Badge variant="destructive">No room</Badge>;
  return <Badge className="bg-amber-100 text-amber-900">Needs review</Badge>;
}

function PublishBadge({ status }: { status: ClassroomRow["publishStatus"] }) {
  if (status === "success") return <Badge className="bg-available text-white">Published</Badge>;
  if (status === "failed") return <Badge variant="destructive">Failed</Badge>;
  if (status === "skipped") return <Badge variant="secondary">Skipped</Badge>;
  return <Badge variant="outline">Local only</Badge>;
}

export function ClassAssignmentsWorkspace() {
  const [date, setDate] = useState("");
  const [forceReassign, setForceReassign] = useState(false);
  const [detail, setDetail] = useState<AssignmentDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [running, setRunning] = useState(false);
  const [runStep, setRunStep] = useState<"idle" | "syncing" | "assigning">("idle");
  const [publishing, setPublishing] = useState(false);
  const [loadingSchedulePreview, setLoadingSchedulePreview] = useState(false);
  const [sendingScheduleEmails, setSendingScheduleEmails] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [publishOpen, setPublishOpen] = useState(false);
  const [publishProgress, setPublishProgress] = useState<PublishJobProgress | null>(null);
  const [scheduleEmailOpen, setScheduleEmailOpen] = useState(false);
  const [scheduleEmailPreview, setScheduleEmailPreview] = useState<ScheduleEmailPreview | null>(null);
  const [scheduleEmailResult, setScheduleEmailResult] = useState<ScheduleEmailSendResult | null>(null);
  const [selectedScheduleEmailGroupIds, setSelectedScheduleEmailGroupIds] = useState<Set<string>>(new Set());
  const [scheduleSendStartedAt, setScheduleSendStartedAt] = useState<number | null>(null);
  const [operationTick, setOperationTick] = useState(0);
  const [selectedTutors, setSelectedTutors] = useState<Set<string>>(new Set());
  const [currentMinute, setCurrentMinute] = useState(7 * 60);
  const [playing, setPlaying] = useState(false);
  const [playbackSpeed, setPlaybackSpeed] = useState(15);
  const playbackMinuteRef = useRef(currentMinute);
  const frameRef = useRef<number | null>(null);
  const lastFrameAtRef = useRef<number | null>(null);

  const loadAssignments = useCallback(async (targetDate: string, showLoading = false) => {
    if (showLoading) setLoading(true);
    setError(null);
    try {
      const response = await fetch(`/api/class-assignments?date=${encodeURIComponent(targetDate)}`);
      const body = (await response.json()) as AssignmentDetail | { error?: string };
      if (!response.ok) throw new Error("error" in body ? body.error : `HTTP ${response.status}`);
      setDetail(body as AssignmentDetail);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load assignments");
    } finally {
      if (showLoading) setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!date) {
      setDate(todayBangkok());
      return;
    }
    void loadAssignments(date, true);
  }, [date, loadAssignments]);

  const rooms = useMemo(() => (detail?.rooms ?? []).filter((room) => room.active), [detail?.rooms]);
  const rows = useMemo(() => detail?.rows ?? [], [detail?.rows]);
  const run = detail?.run ?? null;
  const timelineBounds = useMemo(() => buildTimelineBounds(rows), [rows]);
  const timelineResetKey = `${run?.id ?? "no-run"}:${timelineBounds.initialMinute}:${timelineBounds.endMinute}`;

  useEffect(() => {
    setPlaying(false);
    setCurrentMinute(timelineBounds.initialMinute);
    playbackMinuteRef.current = timelineBounds.initialMinute;
  }, [timelineResetKey, timelineBounds.initialMinute]);

  useEffect(() => {
    playbackMinuteRef.current = currentMinute;
  }, [currentMinute]);

  useEffect(() => {
    if (!playing || rows.length === 0) return;

    lastFrameAtRef.current = null;

    const tick = (timestamp: number) => {
      if (lastFrameAtRef.current === null) {
        lastFrameAtRef.current = timestamp;
      }
      const elapsedSeconds = (timestamp - lastFrameAtRef.current) / 1000;
      lastFrameAtRef.current = timestamp;

      const nextMinute = Math.min(
        timelineBounds.endMinute,
        playbackMinuteRef.current + elapsedSeconds * playbackSpeed,
      );
      playbackMinuteRef.current = nextMinute;
      setCurrentMinute(snapTimelinePlaybackMinute(nextMinute, timelineBounds));

      if (nextMinute >= timelineBounds.endMinute) {
        setPlaying(false);
        frameRef.current = null;
        return;
      }

      frameRef.current = requestAnimationFrame(tick);
    };

    frameRef.current = requestAnimationFrame(tick);
    return () => {
      if (frameRef.current !== null) {
        cancelAnimationFrame(frameRef.current);
        frameRef.current = null;
      }
    };
  }, [playing, playbackSpeed, rows.length, timelineBounds]);

  useEffect(() => {
    setPublishProgress(null);
    setScheduleEmailPreview(null);
    setScheduleEmailResult(null);
  }, [run?.id]);

  const publishActive = Boolean(publishProgress && !isPublishJobTerminal(publishProgress.status));
  useEffect(() => {
    if (!publishActive && !sendingScheduleEmails) return;
    setOperationTick(Date.now());
    const interval = window.setInterval(() => setOperationTick(Date.now()), 1000);
    return () => window.clearInterval(interval);
  }, [publishActive, sendingScheduleEmails]);

  const publishCounts = useMemo(() => {
    const eligible = rows.filter(isPublishEligible).length;
    return {
      eligible,
      skipped: rows.length - eligible,
      success: rows.filter((row) => row.publishStatus === "success").length,
      failed: rows.filter((row) => row.publishStatus === "failed").length,
    };
  }, [rows]);

  const tutors = useMemo(() => {
    return [...new Set(rows.map((row) => row.tutorDisplayName))].sort((a, b) => a.localeCompare(b));
  }, [rows]);

  useEffect(() => {
    setSelectedTutors((current) => {
      const next = new Set([...current].filter((name) => tutors.includes(name)));
      if (next.size === 0 && tutors.length > 0) {
        for (const tutor of tutors.slice(0, 4)) next.add(tutor);
      }
      return next;
    });
  }, [tutors]);

  async function runAssignments() {
    setRunning(true);
    setRunStep("syncing");
    setError(null);
    setMessage("Syncing Wise before assignment generation...");
    try {
      const syncResponse = await fetch("/api/admin/sync-wise", { method: "POST" });
      const syncBody = (await syncResponse.json()) as WiseSyncResult;
      if (!syncResponse.ok) {
        throw new Error(syncBody.error || `Wise sync failed with HTTP ${syncResponse.status}`);
      }
      if (!syncBody.success || !syncBody.promotedSnapshotId) {
        throw new Error(syncBody.errorSummary || "Wise sync did not promote a fresh snapshot.");
      }

      setRunStep("assigning");
      setMessage("Generating assignments from the fresh Wise snapshot...");
      const response = await fetch("/api/class-assignments/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ date, forceReassign }),
      });
      const body = (await response.json()) as AssignmentDetail | { error?: string };
      if (!response.ok) throw new Error("error" in body ? body.error : `HTTP ${response.status}`);
      setDetail(body as AssignmentDetail);
      const liveBlockCount = (body as AssignmentDetail).liveRoomBlocks.length;
      setMessage(
        liveBlockCount > 0
          ? `Assignments generated from fresh Wise data. ${liveBlockCount} live Wise room blockers were reserved.`
          : "Assignments generated from fresh Wise data. Wise has not been updated.",
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to run assignments");
    } finally {
      setRunning(false);
      setRunStep("idle");
    }
  }

  async function updateOverride(row: ClassroomRow, overrideRoom: string) {
    if (!run) return;
    setError(null);
    setMessage(null);
    try {
      const response = await fetch(`/api/class-assignments/runs/${run.id}/rows/${row.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ overrideRoom: overrideRoom || null }),
      });
      const body = (await response.json()) as AssignmentDetail | { error?: string };
      if (!response.ok) throw new Error("error" in body ? body.error : `HTTP ${response.status}`);
      setDetail(body as AssignmentDetail);
      setMessage("Override saved and the run was recalculated.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to update override");
    }
  }

  async function publishToWise() {
    if (!run) return;
    setPublishing(true);
    setPublishProgress(null);
    setError(null);
    setMessage(null);
    try {
      const response = await fetch(`/api/class-assignments/runs/${run.id}/publish`, {
        method: "POST",
      });
      const body = (await response.json()) as
        | PublishStartResult
        | { error?: string };
      if (!response.ok) throw new Error("error" in body ? body.error : `HTTP ${response.status}`);
      if ("progress" in body) {
        setPublishProgress(body.progress);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to publish to Wise");
      setPublishing(false);
      setPublishProgress(null);
    }
  }

  const pollPublishProgress = useCallback(async (runId: string, jobId: string) => {
    try {
      const response = await fetch(`/api/class-assignments/runs/${runId}/publish/${jobId}`);
      const body = (await response.json()) as PublishPollResult | { error?: string };
      if (!response.ok) throw new Error("error" in body ? body.error : `HTTP ${response.status}`);
      if ("progress" in body) {
        setPublishProgress(body.progress);
        if (body.detail) setDetail(body.detail);
        if (isPublishJobTerminal(body.progress.status)) {
          setPublishing(false);
          setMessage(
            `Publish complete: ${body.progress.successCount} succeeded, ${body.progress.failedCount} failed, ${body.progress.skippedCount} skipped.`,
          );
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load publish progress");
      setPublishing(false);
    }
  }, []);

  const publishJobId = publishProgress?.jobId;
  const publishStatus = publishProgress?.status;
  useEffect(() => {
    if (!run?.id || !publishJobId || !publishStatus || isPublishJobTerminal(publishStatus)) return;
    void pollPublishProgress(run.id, publishJobId);
    const interval = window.setInterval(() => {
      void pollPublishProgress(run.id, publishJobId);
    }, 1500);
    return () => window.clearInterval(interval);
  }, [pollPublishProgress, publishJobId, publishStatus, run?.id]);

  useEffect(() => {
    if (!publishProgress || !isPublishJobTerminal(publishProgress.status)) return;
    setPublishing(false);
  }, [publishProgress]);

  useEffect(() => {
    if (sendingScheduleEmails && scheduleSendStartedAt === null) {
      setScheduleSendStartedAt(Date.now());
    }
    if (!sendingScheduleEmails && scheduleSendStartedAt !== null) {
      setScheduleSendStartedAt(null);
    }
  }, [scheduleSendStartedAt, sendingScheduleEmails]);

  async function openScheduleEmailPreview() {
    if (!run) return;
    setLoadingSchedulePreview(true);
    setError(null);
    setMessage(null);
    setScheduleEmailResult(null);
    try {
      const response = await fetch(`/api/class-assignments/runs/${run.id}/schedule-email/preview`);
      const body = (await response.json()) as ScheduleEmailPreview | { error?: string };
      if (!response.ok) throw new Error("error" in body ? body.error : `HTTP ${response.status}`);
      const preview = body as ScheduleEmailPreview;
      setScheduleEmailPreview(preview);
      setSelectedScheduleEmailGroupIds(new Set(
        preview.previews
          .filter((item) => item.recipient.status === "ready")
          .map((item) => item.recipient.groupId),
      ));
      setScheduleEmailOpen(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load schedule email preview");
    } finally {
      setLoadingSchedulePreview(false);
    }
  }

  async function sendScheduleEmails() {
    if (!run || !scheduleEmailPreview) return;
    const recipientGroupIds = [...selectedScheduleEmailGroupIds];
    if (recipientGroupIds.length === 0) {
      setError("Select at least one ready teacher schedule to send.");
      return;
    }
    setSendingScheduleEmails(true);
    setError(null);
    setMessage(null);
    try {
      const response = await fetch(`/api/class-assignments/runs/${run.id}/schedule-email/send`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ recipientGroupIds }),
      });
      const body = (await response.json()) as ScheduleEmailSendResult | { error?: string };
      if (!response.ok && !("summary" in body)) {
        throw new Error("error" in body ? body.error : `HTTP ${response.status}`);
      }
      if ("summary" in body) {
        setScheduleEmailResult(body);
        setScheduleEmailPreview(body.preview);
        setSelectedScheduleEmailGroupIds(new Set(recipientGroupIds));
        if (response.ok) {
          setMessage(
            `Schedule emails sent: ${body.summary.success} succeeded, ${body.summary.failed} failed, ${body.summary.blocked} skipped.`,
          );
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to send schedule emails");
    } finally {
      setSendingScheduleEmails(false);
    }
  }

  function toggleScheduleEmailRecipient(groupId: string, checked: boolean) {
    setSelectedScheduleEmailGroupIds((current) => {
      const next = new Set(current);
      if (checked) next.add(groupId);
      else next.delete(groupId);
      return next;
    });
  }

  function selectAllScheduleEmailRecipients() {
    if (!scheduleEmailPreview) return;
    setSelectedScheduleEmailGroupIds(new Set(
      scheduleEmailPreview.previews
        .filter((item) => item.recipient.status === "ready")
        .map((item) => item.recipient.groupId),
    ));
  }

  function clearScheduleEmailRecipients() {
    setSelectedScheduleEmailGroupIds(new Set());
  }

  function toggleTutor(tutor: string, checked: boolean) {
    setSelectedTutors((current) => {
      const next = new Set(current);
      if (checked) next.add(tutor);
      else next.delete(tutor);
      return next;
    });
  }

  const selectedTutorRows = rows.filter((row) => selectedTutors.has(row.tutorDisplayName));
  const hasRows = rows.length > 0;
  const publishPercent = publishProgress?.totalCount
    ? Math.round((publishProgress.completedCount / publishProgress.totalCount) * 100)
    : 0;
  const publishElapsedMs = publishProgress?.startedAt && !isPublishJobTerminal(publishProgress.status)
    ? operationTick > 0
      ? operationTick - new Date(publishProgress.startedAt).getTime()
      : publishProgress.elapsedMs
    : publishProgress?.elapsedMs ?? null;
  const publishEtaMs = publishProgress && !isPublishJobTerminal(publishProgress.status)
    ? publishProgress.estimatedRemainingMs
    : null;
  const scheduleSendElapsedMs = sendingScheduleEmails && scheduleSendStartedAt
    ? operationTick - scheduleSendStartedAt
    : null;
  const scheduleReadyCount = scheduleEmailPreview?.readyCount ?? 0;
  const scheduleBlockedCount = scheduleEmailPreview?.blockedCount ?? 0;
  const selectedScheduleReadyCount = scheduleEmailPreview
    ? scheduleEmailPreview.previews.filter((item) =>
      item.recipient.status === "ready" && selectedScheduleEmailGroupIds.has(item.recipient.groupId)
    ).length
    : 0;
  const allScheduleReadySelected = scheduleEmailPreview
    ? scheduleReadyCount > 0 && scheduleEmailPreview.previews
      .filter((item) => item.recipient.status === "ready")
      .every((item) => selectedScheduleEmailGroupIds.has(item.recipient.groupId))
    : false;
  const schedulePendingCount = sendingScheduleEmails ? selectedScheduleReadyCount : 0;
  const scheduleSentCount = scheduleEmailResult?.summary.success ?? 0;
  const scheduleFailedCount = scheduleEmailResult?.summary.failed ?? 0;
  const scheduleSkippedCount = scheduleEmailResult?.summary.blocked ?? scheduleBlockedCount;
  const runButtonLabel =
    runStep === "syncing"
      ? "Syncing Wise"
      : runStep === "assigning"
        ? "Generating"
        : "Sync Wise, then run";
  const snapshotMeta = detail?.snapshotMeta ?? null;
  const liveRoomBlocks = detail?.liveRoomBlocks ?? [];
  const roomConflictWarnings = detail?.roomConflictWarnings ?? [];

  function handleTimelineMinuteChange(minute: number) {
    const nextMinute = Math.min(timelineBounds.endMinute, Math.max(timelineBounds.startMinute, minute));
    playbackMinuteRef.current = nextMinute;
    setCurrentMinute(nextMinute);
  }

  function resetTimeline() {
    setPlaying(false);
    playbackMinuteRef.current = timelineBounds.initialMinute;
    setCurrentMinute(timelineBounds.initialMinute);
  }

  return (
    <div className="flex h-full min-h-0 flex-col gap-4 overflow-x-hidden overflow-y-auto p-4 lg:p-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="space-y-1">
          <h1 className="text-xl font-semibold tracking-tight">Class Assignments</h1>
          <p className="text-sm text-muted-foreground">
            Sync Wise first, generate local room assignments, then publish eligible OFFLINE locations.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <label className="grid gap-1 text-xs font-medium text-muted-foreground">
            Date
            <Input
              type="date"
              value={date}
              onChange={(event) => setDate(event.target.value)}
              className="w-[150px]"
            />
          </label>
          <label className="flex h-8 items-center gap-2 rounded-lg border px-3 text-sm">
            <input
              type="checkbox"
              checked={forceReassign}
              onChange={(event) => setForceReassign(event.target.checked)}
            />
            Force reassign
          </label>
          <Button variant="outline" onClick={() => loadAssignments(date, true)} disabled={loading || !date}>
            <RefreshCw />
            Refresh
          </Button>
          <Button onClick={runAssignments} disabled={running || !date}>
            <Play />
            {runButtonLabel}
          </Button>
          <Button
            variant="secondary"
            onClick={() => setPublishOpen(true)}
            disabled={!run || rows.length === 0 || publishing}
          >
            <UploadCloud />
            Publish to Wise
          </Button>
          <Button
            variant="secondary"
            onClick={openScheduleEmailPreview}
            disabled={!run || rows.length === 0 || loadingSchedulePreview}
          >
            <Mail />
            {loadingSchedulePreview ? "Loading email" : "Email schedules"}
          </Button>
        </div>
      </div>

      {(error || message) && (
        <div
          className={`rounded-lg border px-3 py-2 text-sm ${
            error
              ? "border-destructive/30 bg-destructive/5 text-destructive"
              : "border-available/30 bg-available/5 text-foreground"
          }`}
        >
          {error || message}
        </div>
      )}

      {snapshotMeta && (
        <div className="flex flex-wrap items-center gap-2 rounded-lg border bg-card px-3 py-2 text-sm">
          <Badge variant={snapshotMeta.fresh ? "default" : "destructive"}>
            {snapshotMeta.fresh ? "Fresh Wise data" : "Stale Wise data"}
          </Badge>
          <span className="text-muted-foreground">
            Last sync{" "}
            {snapshotMeta.latestSyncFinishedAt
              ? `${formatBangkokShortDateTime(snapshotMeta.latestSyncFinishedAt)} (${formatAge(snapshotMeta.staleAgeMs)} ago)`
              : "unknown"}
          </span>
          {snapshotMeta.snapshotId && (
            <span className="font-mono text-xs text-muted-foreground">
              {snapshotMeta.snapshotId.slice(0, 8)}
            </span>
          )}
        </div>
      )}

      {(liveRoomBlocks.length > 0 || roomConflictWarnings.length > 0) && (
        <div className="rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-950">
          <div className="font-medium">
            {liveRoomBlocks.length} live Wise room blockers detected
            {roomConflictWarnings.length > 0 ? `, ${roomConflictWarnings.length} conflicts still visible` : ""}
          </div>
          <div className="mt-1 grid gap-1 text-xs">
            {liveRoomBlocks.slice(0, 4).map((block) => (
              <div key={block.wiseSessionId}>
                {minuteToTimeLabel(block.startMinute)}-{minuteToTimeLabel(block.endMinute)} · {block.location} ·{" "}
                {block.className || block.wiseSessionId}
              </div>
            ))}
            {liveRoomBlocks.length > 4 && (
              <div>{liveRoomBlocks.length - 4} more live blockers reserved during assignment.</div>
            )}
          </div>
        </div>
      )}

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-7">
        <div className="rounded-lg border bg-card p-3">
          <div className="text-xs text-muted-foreground">Run</div>
          <div className="mt-1 text-sm font-medium">{run ? run.status : "Not generated"}</div>
        </div>
        <div className="rounded-lg border bg-card p-3">
          <div className="text-xs text-muted-foreground">Sessions</div>
          <div className="mt-1 text-lg font-semibold">{run?.totalSessions ?? 0}</div>
        </div>
        <div className="rounded-lg border bg-card p-3">
          <div className="text-xs text-muted-foreground">Assigned</div>
          <div className="mt-1 text-lg font-semibold">{run?.assignedCount ?? 0}</div>
        </div>
        <div className="rounded-lg border bg-card p-3">
          <div className="text-xs text-muted-foreground">Needs review</div>
          <div className="mt-1 text-lg font-semibold">{run?.needsReviewCount ?? 0}</div>
        </div>
        <div className="rounded-lg border bg-card p-3">
          <div className="text-xs text-muted-foreground">No room</div>
          <div className="mt-1 text-lg font-semibold">{run?.noRoomCount ?? 0}</div>
        </div>
        <div className="rounded-lg border bg-card p-3">
          <div className="text-xs text-muted-foreground">Remote</div>
          <div className="mt-1 text-lg font-semibold">{run?.remoteCount ?? 0}</div>
        </div>
        <div className="rounded-lg border bg-card p-3">
          <div className="text-xs text-muted-foreground">Wise publish</div>
          <div className="mt-1 text-sm font-medium">
            {run ? `${run.publishedCount} ok / ${run.failedPublishCount} failed` : "No run"}
          </div>
        </div>
      </div>

      <Tabs defaultValue="floor-plan" className="min-h-0 flex-1 overflow-hidden">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <TabsList>
            <TabsTrigger value="floor-plan">
              <MapIcon />
              Floor Plan
            </TabsTrigger>
            <TabsTrigger value="room-calendar">
              <CalendarDays />
              Room Calendar
            </TabsTrigger>
            <TabsTrigger value="rows">
              <Table2 />
              Rows
            </TabsTrigger>
            <TabsTrigger value="tutors" disabled={!hasRows}>
              <Users />
              Tutor Schedule
            </TabsTrigger>
          </TabsList>
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <Grid3X3 className="size-4" />
            {hasRows ? `${rows.length} sessions from local run` : "No generated run"}
          </div>
        </div>

        <TabsContent value="floor-plan" className="min-h-0 overflow-hidden">
          <div className="flex h-full min-h-0 flex-col gap-3">
            <AssignmentTimelineControls
              bounds={timelineBounds}
              currentMinute={currentMinute}
              playing={playing}
              speed={playbackSpeed}
              disabled={!hasRows}
              onMinuteChange={handleTimelineMinuteChange}
              onPlayingChange={setPlaying}
              onReset={resetTimeline}
              onSpeedChange={setPlaybackSpeed}
            />
            <div className="grid min-h-0 flex-1 gap-3 2xl:grid-cols-[minmax(0,1fr)_minmax(420px,0.55fr)]">
              <FloorPlanOccupancy
                rows={rows}
                rooms={rooms}
                currentMinute={currentMinute}
                onUpdateOverride={updateOverride}
              />
              <RoomOccupancyHeatmap
                rows={rows}
                rooms={rooms}
                bounds={timelineBounds}
                currentMinute={currentMinute}
                onMinuteSelect={handleTimelineMinuteChange}
              />
            </div>
          </div>
        </TabsContent>

        <TabsContent value="room-calendar" className="min-h-0 overflow-hidden">
          <RoomCalendarView
            rows={rows}
            rooms={rooms}
            bounds={timelineBounds}
            onUpdateOverride={updateOverride}
          />
        </TabsContent>

        <TabsContent value="rows" className="min-h-0 overflow-hidden rounded-lg border bg-card">
          <div className="flex items-center gap-2 border-b px-3 py-2 text-sm font-medium">
            <CalendarDays className="size-4" />
            Assignment rows
          </div>
          <div className="h-full overflow-auto">
            <Table className="min-w-[1320px]">
              <TableHeader>
                <TableRow>
                  <TableHead>Time</TableHead>
                  <TableHead>Tutor</TableHead>
                  <TableHead>Student/Class</TableHead>
                  <TableHead>Mode</TableHead>
                  <TableHead>Wise location</TableHead>
                  <TableHead>Min cap</TableHead>
                  <TableHead>TV</TableHead>
                  <TableHead>Preferred</TableHead>
                  <TableHead>Override</TableHead>
                  <TableHead>Assigned</TableHead>
                  <TableHead>Warnings</TableHead>
                  <TableHead>Publish</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {loading ? (
                  <TableRow>
                    <TableCell colSpan={12} className="py-10 text-center text-muted-foreground">
                      Loading assignments...
                    </TableCell>
                  </TableRow>
                ) : rows.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={12} className="py-10 text-center text-muted-foreground">
                      No assignment run for this date yet.
                    </TableCell>
                  </TableRow>
                ) : (
                  rows.map((row) => (
                    <TableRow key={row.id}>
                      <TableCell className="font-mono text-xs">
                        {formatRowTime(row)}
                      </TableCell>
                      <TableCell className="max-w-[220px] whitespace-normal font-medium">
                        {row.tutorDisplayName}
                      </TableCell>
                      <TableCell className="max-w-[220px] whitespace-normal">
                        <div>{row.studentName || row.title || "Untitled class"}</div>
                        <div className="text-xs text-muted-foreground">{classLabel(row)}</div>
                      </TableCell>
                      <TableCell>
                        <Badge variant="outline">{row.sessionType || "Unknown"}</Badge>
                      </TableCell>
                      <TableCell>{row.currentWiseLocation || "-"}</TableCell>
                      <TableCell>{row.minCapacity}</TableCell>
                      <TableCell>{row.needsTv ? "YES" : "NO"}</TableCell>
                      <TableCell>{row.preferredRoom || "-"}</TableCell>
                      <TableCell>
                        <select
                          className="h-8 w-[180px] rounded-md border bg-background px-2 text-sm"
                          value={row.overrideRoom ?? ""}
                          onChange={(event) => updateOverride(row, event.target.value)}
                        >
                          <option value="">No override</option>
                          {rooms.map((room) => (
                            <option key={room.id} value={room.name}>
                              {room.name}
                            </option>
                          ))}
                        </select>
                      </TableCell>
                      <TableCell>
                        <div className="flex flex-col gap-1">
                          <span className="font-medium">{roomLabel(row)}</span>
                          <StatusBadge status={row.status} />
                        </div>
                      </TableCell>
                      <TableCell className="max-w-[220px] whitespace-normal text-xs text-muted-foreground">
                        {row.warnings.length ? row.warnings.join(", ") : "-"}
                      </TableCell>
                      <TableCell className="max-w-[220px] whitespace-normal">
                        <div className="flex flex-col gap-1">
                          <PublishBadge status={row.publishStatus} />
                          {row.publishError && (
                            <span className="text-xs text-destructive">{row.publishError}</span>
                          )}
                        </div>
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </div>
        </TabsContent>

        <TabsContent value="tutors" className="min-h-0 overflow-hidden">
          {rows.length > 0 && (
            <div className="grid h-full min-h-0 grid-cols-[280px_1fr] gap-3">
              <div className="rounded-lg border bg-card p-3">
                <div className="mb-2 text-sm font-medium">Teacher schedule</div>
                <div className="max-h-[56vh] space-y-1 overflow-auto pr-1">
                  {tutors.map((tutor) => (
                    <label key={tutor} className="flex items-center gap-2 text-sm">
                      <input
                        type="checkbox"
                        checked={selectedTutors.has(tutor)}
                        onChange={(event) => toggleTutor(tutor, event.target.checked)}
                      />
                      <span className="truncate">{tutor}</span>
                    </label>
                  ))}
                </div>
              </div>
              <div className="min-h-0 overflow-auto rounded-lg border bg-card p-3">
                <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
                  {[...selectedTutors].sort((a, b) => a.localeCompare(b)).map((tutor) => {
                    const tutorRows = selectedTutorRows
                      .filter((row) => row.tutorDisplayName === tutor)
                      .sort((a, b) => {
                        if (a.startMinute !== b.startMinute) return a.startMinute - b.startMinute;
                        if (a.endMinute !== b.endMinute) return a.endMinute - b.endMinute;
                        return a.id.localeCompare(b.id);
                      });
                    return (
                      <div key={tutor} className="rounded-lg border p-3">
                        <div className="mb-2 text-sm font-semibold">{tutor}</div>
                        <div className="space-y-2">
                          {tutorRows.map((row) => (
                            <div key={row.id} className="rounded-md border-l-4 border-primary bg-muted/40 p-2 text-xs">
                              <div className="font-mono">
                                {formatRowTime(row)} - {roomLabel(row)}
                              </div>
                              <div className="mt-1 font-medium">{row.studentName || row.title || "Untitled class"}</div>
                              <div className="text-muted-foreground">
                                {[classLabel(row), row.sessionType].filter(Boolean).join(" - ")}
                              </div>
                            </div>
                          ))}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>
          )}
        </TabsContent>
      </Tabs>

      <Dialog open={publishOpen} onOpenChange={setPublishOpen}>
        <DialogContent className="flex max-h-[82vh] flex-col overflow-hidden">
          <DialogHeader>
            <DialogTitle>Publish locations to Wise?</DialogTitle>
            <DialogDescription>
              This writes location only for eligible OFFLINE rows. Live Wise room conflicts fail closed per row.
              Online room assignments remain local.
            </DialogDescription>
          </DialogHeader>
          <div className="min-h-0 flex-1 space-y-3 overflow-auto pr-1">
            <div className="rounded-lg border bg-muted/40 p-3 text-sm">
              <div>{publishCounts.eligible} rows eligible for Wise location update.</div>
              <div>{publishCounts.skipped} rows will be skipped.</div>
              <div>{publishCounts.success} rows are already marked published; publishing will retry eligible rows.</div>
              <div>{publishCounts.failed} rows currently show a failed publish status.</div>
            </div>

            {publishProgress && (
              <div className="space-y-3 rounded-lg border bg-card p-3 text-sm">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <div className="text-xs text-muted-foreground">Publish status</div>
                    <div className="font-medium capitalize">{publishProgress.status}</div>
                  </div>
                  <div className="text-right">
                    <div className="text-xs text-muted-foreground">Elapsed / ETA</div>
                    <div className="font-medium">
                      {formatDuration(publishElapsedMs)} / {formatDuration(publishEtaMs)}
                    </div>
                  </div>
                </div>
                <div className="h-2 overflow-hidden rounded-full bg-muted">
                  <div
                    className="h-full rounded-full bg-primary transition-all"
                    style={{ width: `${publishPercent}%` }}
                  />
                </div>
                <div className="grid grid-cols-2 gap-2 text-xs md:grid-cols-5">
                  <div className="rounded-md border bg-muted/30 p-2">
                    <div className="text-muted-foreground">Done</div>
                    <div className="font-semibold">{publishProgress.completedCount}/{publishProgress.totalCount}</div>
                  </div>
                  <div className="rounded-md border bg-muted/30 p-2">
                    <div className="text-muted-foreground">Eligible</div>
                    <div className="font-semibold">{publishProgress.eligibleCount}</div>
                  </div>
                  <div className="rounded-md border bg-muted/30 p-2">
                    <div className="text-muted-foreground">Succeeded</div>
                    <div className="font-semibold text-available">{publishProgress.successCount}</div>
                  </div>
                  <div className="rounded-md border bg-muted/30 p-2">
                    <div className="text-muted-foreground">Failed</div>
                    <div className="font-semibold text-destructive">{publishProgress.failedCount}</div>
                  </div>
                  <div className="rounded-md border bg-muted/30 p-2">
                    <div className="text-muted-foreground">Skipped</div>
                    <div className="font-semibold">{publishProgress.skippedCount}</div>
                  </div>
                </div>
                {publishProgress.lastError && (
                  <div className="rounded-md border border-destructive/30 bg-destructive/5 p-2 text-xs text-destructive">
                    {publishProgress.lastError}
                  </div>
                )}
              </div>
            )}
          </div>
          <DialogFooter className="shrink-0">
            <Button variant="outline" onClick={() => setPublishOpen(false)}>
              Close
            </Button>
            <Button
              onClick={publishToWise}
              disabled={publishing || publishCounts.eligible === 0 || Boolean(publishProgress && !isPublishJobTerminal(publishProgress.status))}
            >
              {publishing || publishActive ? "Publishing" : "Publish to Wise"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={scheduleEmailOpen} onOpenChange={setScheduleEmailOpen}>
        <DialogContent className="flex max-h-[86vh] max-w-4xl flex-col overflow-hidden">
          <DialogHeader>
            <DialogTitle>Email teacher schedules</DialogTitle>
            <DialogDescription>
              Sends each tutor one combined onsite and online schedule to their non-online email address.
            </DialogDescription>
          </DialogHeader>

          <div className="min-h-0 flex-1 space-y-3 overflow-auto pr-1">
            {scheduleEmailPreview && (
              <>
                <div className="grid gap-2 rounded-lg border bg-muted/30 p-3 text-sm md:grid-cols-3">
                  <div>
                    <div className="text-xs text-muted-foreground">Status</div>
                    <div className="font-medium">
                      {scheduleEmailPreview.sendable
                        ? scheduleEmailPreview.ready
                          ? "Ready to send"
                          : "Partially ready"
                        : "Blocked"}
                    </div>
                  </div>
                  <div>
                    <div className="text-xs text-muted-foreground">Ready / blocked</div>
                    <div className="font-medium">
                      {scheduleEmailPreview.readyCount} / {scheduleEmailPreview.blockedCount}
                    </div>
                  </div>
                  <div>
                    <div className="text-xs text-muted-foreground">Subject</div>
                    <div className="font-medium">{scheduleEmailPreview.subject}</div>
                  </div>
                </div>

                <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border bg-card p-3 text-sm">
                  <div>
                    <div className="font-medium">Recipients</div>
                    <div className="text-xs text-muted-foreground">
                      {selectedScheduleReadyCount} selected / {scheduleReadyCount} ready
                    </div>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={selectAllScheduleEmailRecipients}
                      disabled={sendingScheduleEmails || scheduleReadyCount === 0 || allScheduleReadySelected}
                    >
                      Select all ready
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={clearScheduleEmailRecipients}
                      disabled={sendingScheduleEmails || selectedScheduleReadyCount === 0}
                    >
                      Clear
                    </Button>
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-2 text-xs md:grid-cols-4">
                  <div className="rounded-md border bg-card p-2">
                    <div className="text-muted-foreground">Pending</div>
                    <div className="font-semibold">{schedulePendingCount}</div>
                  </div>
                  <div className="rounded-md border bg-card p-2">
                    <div className="text-muted-foreground">Sent</div>
                    <div className="font-semibold text-available">{scheduleSentCount}</div>
                  </div>
                  <div className="rounded-md border bg-card p-2">
                    <div className="text-muted-foreground">Failed</div>
                    <div className="font-semibold text-destructive">{scheduleFailedCount}</div>
                  </div>
                  <div className="rounded-md border bg-card p-2">
                    <div className="text-muted-foreground">Skipped</div>
                    <div className="font-semibold">{scheduleSkippedCount}</div>
                  </div>
                </div>

                {sendingScheduleEmails && (
                  <div className="rounded-lg border bg-primary/5 p-3 text-sm">
                    Sending {selectedScheduleReadyCount} schedule{selectedScheduleReadyCount === 1 ? "" : "s"} · elapsed {formatDuration(scheduleSendElapsedMs)}
                  </div>
                )}

                {scheduleEmailPreview.blockers.length > 0 && (
                  <div className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-950 dark:bg-amber-950/30 dark:text-amber-100">
                    <div className="font-medium">
                      {scheduleEmailPreview.sendable ? "Skipped until resolved" : "Resolve before sending"}
                    </div>
                    <ul className="mt-2 list-disc space-y-1 pl-5">
                      {scheduleEmailPreview.blockers.map((blocker, index) => (
                        <li key={`${blocker.type}-${index}`}>{blocker.message}</li>
                      ))}
                    </ul>
                  </div>
                )}

                {scheduleEmailResult && (
                  <div className="rounded-lg border bg-card p-3 text-sm">
                    <div className="font-medium">
                      {scheduleEmailResult.summary.success} sent / {scheduleEmailResult.summary.failed} failed
                    </div>
                    <div className="mt-2 grid gap-1">
                      {scheduleEmailResult.recipients.map((recipient) => (
                        <div key={`${recipient.tutorDisplayName}-${recipient.email}`} className="flex items-center justify-between gap-3">
                          <span>{recipient.tutorDisplayName}</span>
                          <span className={recipient.sendStatus === "failed" ? "text-destructive" : "text-muted-foreground"}>
                            {recipient.sendStatus}
                            {recipient.error ? ` - ${recipient.error}` : ""}
                          </span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                <div className="space-y-3">
                  {scheduleEmailPreview.previews.map((preview) => (
                    <div key={preview.recipient.tutorDisplayName} className="rounded-lg border bg-card p-3">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <div>
                          <div className="text-sm font-semibold">{preview.recipient.tutorDisplayName}</div>
                          <div className="text-xs text-muted-foreground">
                            {preview.recipient.email || "Missing non-online email"}
                          </div>
                        </div>
                        <div className="flex flex-wrap items-center justify-end gap-2">
                          {preview.recipient.status === "blocked" && preview.recipient.blockReason && (
                            <span className="text-xs text-muted-foreground">{preview.recipient.blockReason}</span>
                          )}
                          <Badge variant={preview.recipient.status === "ready" ? "outline" : "secondary"}>
                            {preview.recipient.status === "ready" ? "Ready" : "Blocked"}
                          </Badge>
                          <Button
                            type="button"
                            size="sm"
                            variant={selectedScheduleEmailGroupIds.has(preview.recipient.groupId) ? "default" : "outline"}
                            disabled={sendingScheduleEmails || preview.recipient.status !== "ready"}
                            onClick={() =>
                              toggleScheduleEmailRecipient(
                                preview.recipient.groupId,
                                !selectedScheduleEmailGroupIds.has(preview.recipient.groupId),
                              )
                            }
                          >
                            {selectedScheduleEmailGroupIds.has(preview.recipient.groupId) ? "Selected" : "Select"}
                          </Button>
                        </div>
                      </div>
                      <div className="mt-3 grid gap-3 md:grid-cols-[220px_1fr]">
                        <div className="rounded-md border bg-muted/20 p-2">
                          <div className="text-xs font-medium text-muted-foreground">Room route</div>
                          <div className="mt-2 space-y-1">
                            {preview.roomSteps.length > 0 ? (
                              preview.roomSteps.map((step) => (
                                <div key={`${step.order}-${step.room}-${step.time}`} className="flex items-center gap-2 text-xs">
                                  <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-primary text-[11px] font-semibold text-primary-foreground">
                                    {step.order}
                                  </span>
                                  <span>
                                    <span className="font-medium">{step.room}</span>
                                    <span className="text-muted-foreground"> · {step.time}</span>
                                  </span>
                                </div>
                              ))
                            ) : (
                              <div className="text-xs text-muted-foreground">No physical room needed.</div>
                            )}
                          </div>
                        </div>
                        <Image
                          src={preview.mapImageUrl}
                          alt={`BeGifted floor plan for ${preview.recipient.tutorDisplayName}`}
                          width={640}
                          height={360}
                          unoptimized
                          className="w-full rounded-md border bg-white"
                        />
                      </div>
                      <div className="mt-3 overflow-auto rounded-md border">
                        <Table>
                          <TableHeader>
                            <TableRow>
                              <TableHead>Time</TableHead>
                              <TableHead>Student/Class</TableHead>
                              <TableHead>Subject</TableHead>
                              <TableHead>Mode</TableHead>
                              <TableHead>Room</TableHead>
                            </TableRow>
                          </TableHeader>
                          <TableBody>
                            {preview.blocks.map((block) => (
                              <TableRow key={block.rowId}>
                                <TableCell className="font-mono text-xs">{block.time}</TableCell>
                                <TableCell>{block.studentOrClass}</TableCell>
                                <TableCell>{block.subject}</TableCell>
                                <TableCell>{block.mode}</TableCell>
                                <TableCell className="font-medium">{block.room}</TableCell>
                              </TableRow>
                            ))}
                          </TableBody>
                        </Table>
                      </div>
                    </div>
                  ))}
                </div>
              </>
            )}
          </div>

          <DialogFooter className="shrink-0">
            <Button variant="outline" onClick={() => setScheduleEmailOpen(false)} disabled={sendingScheduleEmails}>
              Close
            </Button>
            <Button
              onClick={sendScheduleEmails}
              disabled={!scheduleEmailPreview?.sendable || sendingScheduleEmails || selectedScheduleReadyCount === 0}
            >
              <Send />
              {sendingScheduleEmails ? `Sending ${selectedScheduleReadyCount}` : "Send selected"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
