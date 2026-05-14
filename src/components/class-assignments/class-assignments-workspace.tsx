"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CalendarDays, Grid3X3, Map as MapIcon, Play, RefreshCw, Table2, UploadCloud, Users } from "lucide-react";
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
import { buildTimelineBounds } from "@/lib/classrooms/visualization";
import { AssignmentTimelineControls } from "./assignment-timeline-controls";
import { FloorPlanOccupancy } from "./floor-plan-occupancy";
import { RoomCalendarView } from "./room-calendar-view";
import { RoomOccupancyHeatmap } from "./room-occupancy-heatmap";
import type { AssignmentDetail, ClassroomRow } from "./types";

const NO_ROOM_AVAILABLE = "NO_ROOM_AVAILABLE";

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

function formatTime(value: string): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Bangkok",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(value));
}

function classLabel(row: ClassroomRow): string {
  return row.subject || row.classType || row.title || "";
}

function isPublishEligible(row: ClassroomRow): boolean {
  return (
    row.status === "assigned" &&
    row.assignedRoom !== NO_ROOM_AVAILABLE &&
    row.sessionType?.toUpperCase() === "OFFLINE" &&
    Boolean(row.wiseClassId) &&
    !row.warnings.includes("needs_review_missing_capacity")
  );
}

function StatusBadge({ status }: { status: ClassroomRow["status"] }) {
  if (status === "assigned") return <Badge className="bg-available text-white">Assigned</Badge>;
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
  const [publishing, setPublishing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [publishOpen, setPublishOpen] = useState(false);
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
      setCurrentMinute(Math.round(nextMinute));

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
  }, [playing, playbackSpeed, rows.length, timelineBounds.endMinute]);

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
    setError(null);
    setMessage(null);
    try {
      const response = await fetch("/api/class-assignments/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ date, forceReassign }),
      });
      const body = (await response.json()) as AssignmentDetail | { error?: string };
      if (!response.ok) throw new Error("error" in body ? body.error : `HTTP ${response.status}`);
      setDetail(body as AssignmentDetail);
      setMessage("Assignments generated locally. Wise has not been updated.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to run assignments");
    } finally {
      setRunning(false);
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
    setError(null);
    setMessage(null);
    try {
      const response = await fetch(`/api/class-assignments/runs/${run.id}/publish`, {
        method: "POST",
      });
      const body = (await response.json()) as
        | { detail: AssignmentDetail; summary: { attempted: number; success: number; skipped: number; failed: number } }
        | { error?: string };
      if (!response.ok) throw new Error("error" in body ? body.error : `HTTP ${response.status}`);
      if ("detail" in body) {
        setDetail(body.detail);
        setMessage(
          `Publish complete: ${body.summary.success} succeeded, ${body.summary.failed} failed, ${body.summary.skipped} skipped.`,
        );
      }
      setPublishOpen(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to publish to Wise");
    } finally {
      setPublishing(false);
    }
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
            Generate local room assignments first, then publish eligible OFFLINE locations to Wise.
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
            {running ? "Running" : "Run assignments"}
          </Button>
          <Button
            variant="secondary"
            onClick={() => setPublishOpen(true)}
            disabled={!run || rows.length === 0 || publishing}
          >
            <UploadCloud />
            Publish to Wise
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

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-6">
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
                        {formatTime(row.startTime)}-{formatTime(row.endTime)}
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
                          <span className="font-medium">{row.assignedRoom}</span>
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
                      .sort((a, b) => a.startTime.localeCompare(b.startTime));
                    return (
                      <div key={tutor} className="rounded-lg border p-3">
                        <div className="mb-2 text-sm font-semibold">{tutor}</div>
                        <div className="space-y-2">
                          {tutorRows.map((row) => (
                            <div key={row.id} className="rounded-md border-l-4 border-primary bg-muted/40 p-2 text-xs">
                              <div className="font-mono">
                                {formatTime(row.startTime)}-{formatTime(row.endTime)} - {row.assignedRoom}
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
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Publish locations to Wise?</DialogTitle>
            <DialogDescription>
              This writes Wise location only for eligible OFFLINE rows. Online room assignments remain local.
            </DialogDescription>
          </DialogHeader>
          <div className="rounded-lg border bg-muted/40 p-3 text-sm">
            <div>{publishCounts.eligible} rows eligible for Wise location update.</div>
            <div>{publishCounts.skipped} rows will be skipped.</div>
            <div>{publishCounts.success} rows are already marked published; publishing will retry eligible rows.</div>
            <div>{publishCounts.failed} rows currently show a failed publish status.</div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setPublishOpen(false)} disabled={publishing}>
              Cancel
            </Button>
            <Button onClick={publishToWise} disabled={publishing || publishCounts.eligible === 0}>
              {publishing ? "Publishing" : "Publish to Wise"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
