"use client";

import { CalendarPlus, CheckCircle2, ChevronDown, ChevronRight, FileCheck2, House, LogOut, Mail, MessageCircle, RefreshCw, Search } from "lucide-react";
import { startTransition, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
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
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { formatBangkokDateTime, formatBangkokShortDateTime } from "@/lib/bangkok-time";
import type {
  AppSessionUser,
  ProgressTestRow,
  ProgressTestsPayload,
  ProgressTestStatus,
  ProgressTestsSummary,
} from "@/lib/progress-tests/types";
import { cn } from "@/lib/utils";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const STATUS_FILTERS = ["all", "approaching", "due", "scheduled", "completed"] as const;
type StatusFilter = (typeof STATUS_FILTERS)[number];

const ALL_SUBJECTS = "__all__";

/** Bangkok-modality choices for booking; the location heuristic is unreliable so the admin picks. */
type BookingModality = "online" | "offline";

// ---------------------------------------------------------------------------
// Pure helpers (exported for unit tests — no base-ui context required)
// ---------------------------------------------------------------------------

/**
 * Maps a lifecycle status to its sky-blue palette badge tone classes.
 *
 * @returns Tailwind classes (semantic tokens) for the status badge.
 */
export function statusTone(status: ProgressTestStatus): string {
  if (status === "completed") return "border-available/30 bg-available/10 text-available";
  if (status === "scheduled") return "border-sky-200 bg-sky-50 text-sky-800";
  if (status === "due") return "border-destructive/30 bg-destructive/10 text-destructive";
  if (status === "approaching") return "border-amber-200 bg-amber-50 text-amber-900";
  return "border-slate-200 bg-slate-50 text-slate-700";
}

/** Renders a status pill in the dashboard's sky-blue palette. */
export function StatusBadge({ status }: { status: ProgressTestStatus }) {
  return (
    <Badge variant="outline" className={cn("capitalize", statusTone(status))}>
      {status}
    </Badge>
  );
}

/**
 * Filters dashboard rows by status tab, subject, and a free-text search.
 *
 * 1. Status: keep all when the tab is "all", else exact-match the row status.
 * 2. Subject: keep all when "all" subjects, else exact-match the subject.
 * 3. Search: case-insensitive substring over student, parent, and teacher.
 *
 * @returns the subset of rows matching every active filter.
 */
export function filterRows(
  rows: ProgressTestRow[],
  status: StatusFilter,
  subject: string,
  search: string,
): ProgressTestRow[] {
  const needle = search.trim().toLowerCase();
  return rows.filter((row) => {
    if (status !== "all" && row.status !== status) return false;
    if (subject !== ALL_SUBJECTS && row.subject !== subject) return false;
    if (needle) {
      const haystack = [
        row.studentName,
        row.parentName,
        row.mostFrequentTutorDisplayName ?? "",
      ]
        .join(" ")
        .toLowerCase();
      if (!haystack.includes(needle)) return false;
    }
    return true;
  });
}

/** Formats a nullable ISO timestamp as a short Bangkok date-time, or a dash. */
export function shortTime(value: string | null): string {
  return value ? formatBangkokShortDateTime(value) : "-";
}

/** A short sub-label describing how a scheduled test is being run, or null. */
export function methodLabel(row: ProgressTestRow): string | null {
  if (row.scheduleMethod === "at_home") {
    return row.atHomeSelectedAt ? `At home · selected ${shortTime(row.atHomeSelectedAt)}` : "At home";
  }
  if (row.scheduleMethod === "after_class") {
    return row.bookedTestLocation ? `After class · ${row.bookedTestLocation}` : "After class";
  }
  if (row.scheduleMethod === "parent_pick") {
    return row.bookedTestLocation ? `Parent's time · ${row.bookedTestLocation}` : "Parent's time";
  }
  return null;
}

/** True when this row is an at-home test that's been selected but not yet submitted. */
export function isAtHomeAwaitingSubmission(row: ProgressTestRow): boolean {
  return row.scheduleMethod === "at_home" && row.atHomeSelectedAt !== null && row.atHomeSubmittedAt === null;
}

/** Builds a one-line plain-text preview of a structured AI summary, or null when absent. */
export function aiSummaryPreview(row: ProgressTestRow): string | null {
  const summary = row.lastAiSummary;
  if (!summary) return null;
  const parts = [summary.headline, ...summary.strengths, ...summary.focusAreas, summary.recommendation]
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  const joined = parts.join(" — ");
  return joined.length > 0 ? joined : null;
}

// ---------------------------------------------------------------------------
// Presentational sub-components (exported for unit tests)
// ---------------------------------------------------------------------------

/** A thin progress bar showing `count / threshold` filled width. */
export function ProgressBar({ count, threshold }: { count: number; threshold: number }) {
  const pct = threshold > 0 ? Math.min(100, Math.max(0, (count / threshold) * 100)) : 0;
  return (
    <div className="flex items-center gap-2">
      <span className="w-8 text-xs font-medium tabular-nums text-foreground">
        {count}/{threshold}
      </span>
      <div className="h-2 w-20 overflow-hidden rounded-full bg-muted">
        <div className="h-full rounded-full bg-primary" style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

/** One summary count card (Approaching / Due / Scheduled / Completed). */
export function SummaryCard({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone: string;
}) {
  return (
    <Card size="sm" className="px-4 py-3">
      <div className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className={cn("mt-1 text-2xl font-semibold tracking-tight", tone)}>{value}</div>
    </Card>
  );
}

/** The four-card summary strip. */
export function SummaryCards({ summary }: { summary: ProgressTestsSummary }) {
  return (
    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
      <SummaryCard label="Approaching" value={summary.approaching} tone="text-amber-700" />
      <SummaryCard label="Due" value={summary.due} tone="text-destructive" />
      <SummaryCard label="Scheduled" value={summary.scheduled} tone="text-sky-700" />
      <SummaryCard label="Completed" value={summary.completed} tone="text-available" />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Book test dialog
// ---------------------------------------------------------------------------

/**
 * Modal for booking a progress test into Wise (admin-confirmed).
 *
 * Collects a Bangkok date/time (native datetime-local), a modality, and — for
 * offline tests — a location. On confirm it converts the local wall-clock value
 * to a Bangkok-anchored ISO instant and hands it to the parent, which POSTs to
 * /api/progress-tests/book. Fail-closed: confirm stays disabled until a date is
 * set and (for offline) a location is provided.
 */
function BookTestDialog({
  row,
  open,
  busy,
  onOpenChange,
  onConfirm,
  onSelectAtHome,
}: {
  row: ProgressTestRow | null;
  open: boolean;
  busy: boolean;
  onOpenChange: (next: boolean) => void;
  onConfirm: (input: { testDate: string; modality: BookingModality; location: string | null; scheduleMethod: "after_class" | "parent_pick" }) => void;
  onSelectAtHome: () => void;
}) {
  const [localDateTime, setLocalDateTime] = useState("");
  const [modality, setModality] = useState<BookingModality>("offline");
  const [location, setLocation] = useState("");

  const offlineMissingLocation = modality === "offline" && location.trim().length === 0;
  const canConfirm = !busy && localDateTime.length > 0 && !offlineMissingLocation;
  const slots = row?.recommendedSlots ?? [];

  function handleCustomConfirm() {
    if (!canConfirm) return;
    // datetime-local has no zone; treat the entered wall-clock as Bangkok time.
    const testDate = new Date(`${localDateTime}:00+07:00`).toISOString();
    onConfirm({
      testDate,
      modality,
      location: modality === "offline" ? location.trim() : null,
      scheduleMethod: "parent_pick",
    });
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <CalendarPlus className="size-4 text-primary" aria-hidden />
            Book progress test
          </DialogTitle>
          <DialogDescription>
            {row
              ? `${row.studentName} · ${row.subject} (${row.currentCount}/${row.threshold})`
              : "Schedule the progress test for this student."}
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-4">
          {slots.length ? (
            <div className="flex flex-col gap-1.5">
              <div className="text-xs font-medium text-muted-foreground">Recommended times (room-checked)</div>
              {slots.map((slot) => (
                <button
                  key={`${slot.start}-${slot.room}`}
                  type="button"
                  disabled={busy}
                  onClick={() =>
                    onConfirm({ testDate: slot.start, modality: "offline", location: slot.room, scheduleMethod: "after_class" })
                  }
                  className="flex items-center justify-between gap-2 rounded-lg border border-input px-3 py-2 text-left text-sm hover:border-ring hover:bg-muted disabled:opacity-50"
                >
                  <span>{slot.label}</span>
                  <span className="shrink-0 text-[10px] uppercase tracking-wide text-muted-foreground">
                    {slot.kind === "after_class" ? "after class" : "gap"}
                  </span>
                </button>
              ))}
            </div>
          ) : (
            <p className="text-xs text-muted-foreground">
              No room-verified after-class slots in the next few class days — use at-home or a custom time.
            </p>
          )}

          <Button
            variant="outline"
            size="sm"
            className="justify-center gap-1.5"
            disabled={busy}
            onClick={onSelectAtHome}
          >
            <House className="size-3.5" /> Take the test at home (no booking)
          </Button>

          <div className="border-t border-border pt-3 text-xs font-medium text-muted-foreground">
            Or pick a custom time (parent&apos;s choice)
          </div>

          <div className="flex flex-col gap-1.5">
            <label className="text-xs font-medium text-muted-foreground" htmlFor="progress-test-date">
              Date &amp; time (Bangkok)
            </label>
            <input
              id="progress-test-date"
              type="datetime-local"
              value={localDateTime}
              onChange={(event) => setLocalDateTime(event.target.value)}
              className="h-8 w-full rounded-lg border border-input bg-transparent px-2.5 py-1 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <label className="text-xs font-medium text-muted-foreground">Modality</label>
            <Select value={modality} onValueChange={(value) => setModality((value as BookingModality | null) ?? "offline")}>
              <SelectTrigger className="w-full bg-background">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="online">Online</SelectItem>
                <SelectItem value="offline">Offline</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {modality === "offline" ? (
            <div className="flex flex-col gap-1.5">
              <label className="text-xs font-medium text-muted-foreground" htmlFor="progress-test-location">
                Location
              </label>
              <Input
                id="progress-test-location"
                value={location}
                onChange={(event) => setLocation(event.target.value)}
                placeholder="e.g. Tesla"
              />
            </div>
          ) : null}
        </div>

        <DialogFooter>
          <Button variant="outline" size="sm" onClick={() => onOpenChange(false)} disabled={busy}>
            Close
          </Button>
          <Button size="sm" onClick={handleCustomConfirm} disabled={!canConfirm}>
            {busy ? <RefreshCw className="size-3.5 animate-spin" /> : <CalendarPlus className="size-3.5" />}
            Book custom time
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Type guard
// ---------------------------------------------------------------------------

function isProgressTestsPayload(value: unknown): value is ProgressTestsPayload {
  return (
    typeof value === "object" &&
    value !== null &&
    "rows" in value &&
    "summary" in value &&
    "subjects" in value
  );
}

// ---------------------------------------------------------------------------
// Dashboard shell
// ---------------------------------------------------------------------------

export function ProgressTestsDashboard({ sessionUser }: { sessionUser: AppSessionUser }) {
  const [data, setData] = useState<ProgressTestsPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [refreshing, setRefreshing] = useState(false);
  const [message, setMessage] = useState<{ text: string; tone: "success" | "error" } | null>(null);

  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [subjectFilter, setSubjectFilter] = useState<string>(ALL_SUBJECTS);
  const [search, setSearch] = useState("");
  const [expandedKeys, setExpandedKeys] = useState<Set<string>>(new Set());

  // The enrollment whose action is in flight (busyJob-style disable + spinner).
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [bookingRow, setBookingRow] = useState<ProgressTestRow | null>(null);
  const bookingBusy = bookingRow !== null && busyKey === bookingRow.enrollmentKey;

  // Keep the latest load callable from both mount + interval without re-binding.
  const loadRef = useRef<(initial: boolean) => Promise<void>>(() => Promise.resolve());

  // -------------------------------------------------------------------------
  // Data loading + focus-gated polling (mirrors credit-control)
  // -------------------------------------------------------------------------
  useEffect(() => {
    let cancelled = false;

    async function load(initial: boolean) {
      if (initial) {
        setLoading(true);
        setError("");
      } else {
        if (!document.hasFocus()) return;
        setRefreshing(true);
      }

      try {
        const response = await fetch("/api/progress-tests", { cache: "no-store" });
        const payload = (await response.json().catch(() => null)) as unknown;
        if (!response.ok || !isProgressTestsPayload(payload)) {
          const text =
            typeof payload === "object" && payload !== null && "error" in payload && typeof payload.error === "string"
              ? payload.error
              : `HTTP ${response.status}`;
          throw new Error(text);
        }
        if (cancelled) return;
        startTransition(() => setData(payload));
      } catch (loadError) {
        if (!cancelled && initial) {
          setError(loadError instanceof Error ? loadError.message : "Failed to load progress tests.");
        }
      } finally {
        if (!cancelled) {
          if (initial) setLoading(false);
          setRefreshing(false);
        }
      }
    }

    loadRef.current = load;
    void load(true);

    const interval = window.setInterval(() => {
      void load(false);
    }, 60_000);

    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, []);

  const refresh = useCallback(async () => {
    await loadRef.current(false);
  }, []);

  // -------------------------------------------------------------------------
  // Derived data
  // -------------------------------------------------------------------------
  const filteredRows = useMemo(() => {
    if (!data) return [];
    return filterRows(data.rows, statusFilter, subjectFilter, search);
  }, [data, statusFilter, subjectFilter, search]);

  // -------------------------------------------------------------------------
  // Row patch (after a successful action, before the background refetch)
  // -------------------------------------------------------------------------
  const patchRow = useCallback((row: ProgressTestRow) => {
    setData((current) => {
      if (!current) return current;
      const nextRows = current.rows.map((existing) =>
        existing.enrollmentKey === row.enrollmentKey ? row : existing,
      );
      const summary: ProgressTestsSummary = {
        accumulating: 0,
        approaching: 0,
        due: 0,
        scheduled: 0,
        completed: 0,
        total: nextRows.length,
      };
      for (const item of nextRows) summary[item.status] += 1;
      return { ...current, rows: nextRows, summary };
    });
  }, []);

  function toggleExpanded(enrollmentKey: string) {
    setExpandedKeys((current) => {
      const next = new Set(current);
      if (next.has(enrollmentKey)) {
        next.delete(enrollmentKey);
      } else {
        next.add(enrollmentKey);
      }
      return next;
    });
  }

  // -------------------------------------------------------------------------
  // Actions — each disables its row, patches the returned row, then refetches.
  // -------------------------------------------------------------------------
  async function runAction(
    enrollmentKey: string,
    request: () => Promise<Response>,
    successLabel: string,
  ) {
    setBusyKey(enrollmentKey);
    setMessage(null);
    try {
      const response = await request();
      const payload = (await response.json().catch(() => null)) as
        | { row?: ProgressTestRow; message?: string; error?: unknown }
        | null;
      if (!response.ok) {
        const text =
          payload && typeof payload.error === "string" ? payload.error : `HTTP ${response.status}`;
        throw new Error(text);
      }
      if (payload?.row) patchRow(payload.row);
      setMessage({ text: payload?.message ?? successLabel, tone: "success" });
      await refresh();
    } catch (actionError) {
      const text = actionError instanceof Error ? actionError.message : "Action failed.";
      setMessage({ text, tone: "error" });
    } finally {
      setBusyKey(null);
    }
  }

  function handleBookConfirm(input: {
    testDate: string;
    modality: BookingModality;
    location: string | null;
    scheduleMethod: "after_class" | "parent_pick";
  }) {
    if (!bookingRow) return;
    const enrollmentKey = bookingRow.enrollmentKey;
    void runAction(
      enrollmentKey,
      () =>
        fetch("/api/progress-tests/book", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            enrollmentKey,
            testDate: input.testDate,
            modality: input.modality,
            scheduleMethod: input.scheduleMethod,
            ...(input.location ? { location: input.location } : {}),
          }),
        }),
      "Progress test booked.",
    ).then(() => setBookingRow(null));
  }

  function handleSelectAtHome(row: ProgressTestRow) {
    void runAction(
      row.enrollmentKey,
      () =>
        fetch("/api/progress-tests/select-at-home", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ enrollmentKey: row.enrollmentKey }),
        }),
      "Logged: test will be taken at home.",
    ).then(() => setBookingRow(null));
  }

  function handleMarkSubmitted(row: ProgressTestRow) {
    void runAction(
      row.enrollmentKey,
      () =>
        fetch("/api/progress-tests/mark-at-home-submitted", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ enrollmentKey: row.enrollmentKey }),
        }),
      "At-home test marked submitted; cycle reset.",
    );
  }

  /**
   * One-click parent outreach: copy the prebuilt bilingual message to the clipboard
   * AND open the parent's LINE chat. Both run synchronously in the click handler so
   * the clipboard write keeps its user-gesture (no async before writeText).
   */
  function copyAndOpenLine(row: ProgressTestRow) {
    const contact = row.parentLineContact;
    if (!contact?.chatUrl) return;
    if (row.parentMessage) {
      void navigator.clipboard.writeText(row.parentMessage).catch(() => {});
    }
    window.open(contact.chatUrl, "_blank", "noopener,noreferrer");
    setMessage({
      text: row.parentMessage
        ? `Message copied — paste into ${contact.displayName ?? "the parent"}'s LINE chat and send.`
        : `Opened ${contact.displayName ?? "the parent"}'s LINE chat.`,
      tone: "success",
    });
  }

  function handleMarkComplete(row: ProgressTestRow) {
    void runAction(
      row.enrollmentKey,
      () =>
        fetch("/api/progress-tests/mark-complete", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ enrollmentKey: row.enrollmentKey }),
        }),
      "Progress test marked complete.",
    );
  }

  function handleResendEmail(row: ProgressTestRow) {
    void runAction(
      row.enrollmentKey,
      () =>
        fetch("/api/progress-tests/resend-email", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ enrollmentKey: row.enrollmentKey }),
        }),
      "Teacher email resent.",
    );
  }

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-auto pb-8">
      {/* Header */}
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Progress Tests</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {data?.lastSyncedAt ? `Last sync ${formatBangkokDateTime(data.lastSyncedAt)}` : "Awaiting first sync"}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Badge variant="outline" className="font-normal">
            {refreshing
              ? "Refreshing…"
              : data
                ? `Updated ${formatBangkokShortDateTime(data.generatedAt)}`
                : "Loading"}
          </Badge>
          <Badge variant="outline" className="font-normal text-muted-foreground">
            {sessionUser.name}
          </Badge>
          <Button variant="outline" size="sm" onClick={refresh} disabled={refreshing} className="gap-2">
            <RefreshCw className={cn("size-4", refreshing && "animate-spin")} />
            Refresh
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              window.location.href = "/api/auth/signout?callbackUrl=/login";
            }}
            className="gap-2"
          >
            <LogOut className="size-4" />
            Sign out
          </Button>
        </div>
      </div>

      {message ? (
        <div
          role="status"
          className={cn(
            "rounded-lg border px-4 py-2 text-sm",
            message.tone === "error"
              ? "border-destructive/30 bg-destructive/10 text-destructive"
              : "border-available/30 bg-available/10 text-available",
          )}
        >
          {message.text}
        </div>
      ) : null}

      {loading ? <LoadingState /> : null}
      {!loading && error ? <ErrorState message={error} /> : null}

      {!loading && !error && data ? (
        <>
          <SummaryCards summary={data.summary} />

          {/* Filter bar */}
          <div className="flex flex-wrap items-center gap-3 rounded-lg border bg-card px-3 py-2">
            <Tabs value={statusFilter} onValueChange={(value) => setStatusFilter((value as StatusFilter | null) ?? "all")}>
              <TabsList>
                {STATUS_FILTERS.map((filter) => (
                  <TabsTrigger key={filter} value={filter} className="capitalize">
                    {filter}
                  </TabsTrigger>
                ))}
              </TabsList>
            </Tabs>

            <Select value={subjectFilter} onValueChange={(value) => setSubjectFilter(value ?? ALL_SUBJECTS)}>
              <SelectTrigger size="sm" className="w-44 bg-background">
                <SelectValue placeholder="All subjects" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL_SUBJECTS}>All subjects</SelectItem>
                {data.subjects.map((subject) => (
                  <SelectItem key={subject} value={subject}>
                    {subject}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>

            <div className="relative flex-1 sm:max-w-xs">
              <Search aria-hidden className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                aria-label="Search students"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="Search student, parent, teacher"
                className="pl-8"
              />
            </div>

            <Badge variant="outline" className="ml-auto font-normal">
              {filteredRows.length} {filteredRows.length === 1 ? "student" : "students"}
            </Badge>
          </div>

          {/* Table */}
          <section className="rounded-lg border bg-card">
            <div className="overflow-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Student</TableHead>
                    <TableHead>Subject</TableHead>
                    <TableHead>Progress</TableHead>
                    <TableHead>Teacher</TableHead>
                    <TableHead>Parent (LINE)</TableHead>
                    <TableHead>Notified</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Last class</TableHead>
                    <TableHead>AI summary</TableHead>
                    <TableHead className="text-right">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filteredRows.length ? (
                    filteredRows.map((row) => {
                      const expanded = expandedKeys.has(row.enrollmentKey);
                      const preview = aiSummaryPreview(row);
                      const rowBusy = busyKey === row.enrollmentKey;
                      return (
                        <TableRow key={row.enrollmentKey}>
                          <TableCell>
                            <div className="font-medium">{row.studentName}</div>
                            {row.parentName ? (
                              <div className="text-xs text-muted-foreground">{row.parentName}</div>
                            ) : null}
                          </TableCell>
                          <TableCell className="text-sm">{row.subject || "-"}</TableCell>
                          <TableCell>
                            <ProgressBar count={row.currentCount} threshold={row.threshold} />
                          </TableCell>
                          <TableCell className="text-sm">{row.mostFrequentTutorDisplayName ?? "-"}</TableCell>
                          <TableCell>
                            {row.parentLineContact ? (
                              row.parentLineContact.chatUrl ? (
                                <Button
                                  variant="outline"
                                  size="sm"
                                  className="gap-1.5"
                                  disabled={rowBusy}
                                  onClick={() => copyAndOpenLine(row)}
                                  title={row.parentMessage ? "Copy message + open LINE chat" : "Open LINE chat"}
                                >
                                  <MessageCircle className="size-3.5" />
                                  <span className="max-w-28 truncate">{row.parentLineContact.displayName ?? "LINE"}</span>
                                </Button>
                              ) : (
                                <span className="text-xs text-muted-foreground">
                                  {row.parentLineContact.displayName ?? "Linked"} (no chat)
                                </span>
                              )
                            ) : (
                              <span className="text-xs text-muted-foreground">No LINE link</span>
                            )}
                          </TableCell>
                          <TableCell>
                            {row.teacherNotifiedAt ? (
                              <Badge variant="outline" className="border-available/30 bg-available/10 text-available">
                                {shortTime(row.teacherNotifiedAt)}
                              </Badge>
                            ) : (
                              <Badge variant="outline" className="text-muted-foreground">
                                Not notified
                              </Badge>
                            )}
                          </TableCell>
                          <TableCell>
                            <StatusBadge status={row.status} />
                            {methodLabel(row) ? (
                              <div className="mt-0.5 text-[10px] text-muted-foreground">{methodLabel(row)}</div>
                            ) : null}
                          </TableCell>
                          <TableCell className="text-sm text-muted-foreground">{shortTime(row.lastClassDate)}</TableCell>
                          <TableCell className="max-w-72">
                            {preview ? (
                              <button
                                type="button"
                                onClick={() => toggleExpanded(row.enrollmentKey)}
                                className="flex items-start gap-1 text-left text-xs text-muted-foreground hover:text-foreground"
                                aria-expanded={expanded}
                              >
                                {expanded ? (
                                  <ChevronDown className="mt-0.5 size-3.5 shrink-0" aria-hidden />
                                ) : (
                                  <ChevronRight className="mt-0.5 size-3.5 shrink-0" aria-hidden />
                                )}
                                <span className={cn(expanded ? "" : "line-clamp-2")}>{preview}</span>
                              </button>
                            ) : (
                              <span className="text-xs text-muted-foreground">-</span>
                            )}
                          </TableCell>
                          <TableCell>
                            <div className="flex items-center justify-end gap-1.5">
                              <Button
                                variant="outline"
                                size="sm"
                                className="gap-1.5"
                                disabled={rowBusy}
                                onClick={() => setBookingRow(row)}
                              >
                                <CalendarPlus className="size-3.5" />
                                Schedule
                              </Button>
                              {isAtHomeAwaitingSubmission(row) ? (
                                <Button
                                  variant="secondary"
                                  size="sm"
                                  className="gap-1.5"
                                  disabled={rowBusy}
                                  onClick={() => handleMarkSubmitted(row)}
                                >
                                  {rowBusy ? <RefreshCw className="size-3.5 animate-spin" /> : <FileCheck2 className="size-3.5" />}
                                  Mark submitted
                                </Button>
                              ) : (
                                <Button
                                  variant="secondary"
                                  size="sm"
                                  className="gap-1.5"
                                  disabled={rowBusy || row.status !== "scheduled"}
                                  onClick={() => handleMarkComplete(row)}
                                >
                                  {rowBusy ? <RefreshCw className="size-3.5 animate-spin" /> : <CheckCircle2 className="size-3.5" />}
                                  Mark complete
                                </Button>
                              )}
                              <Button
                                variant="ghost"
                                size="sm"
                                className="gap-1.5"
                                disabled={rowBusy}
                                onClick={() => handleResendEmail(row)}
                              >
                                {rowBusy ? <RefreshCw className="size-3.5 animate-spin" /> : <Mail className="size-3.5" />}
                                Resend email
                              </Button>
                            </div>
                          </TableCell>
                        </TableRow>
                      );
                    })
                  ) : (
                    <TableRow>
                      <TableCell colSpan={10} className="h-24 text-center text-sm text-muted-foreground">
                        No students match the current filters.
                      </TableCell>
                    </TableRow>
                  )}
                </TableBody>
              </Table>
            </div>
          </section>
        </>
      ) : null}

      <BookTestDialog
        key={bookingRow?.enrollmentKey ?? "none"}
        row={bookingRow}
        open={bookingRow !== null}
        busy={bookingBusy}
        onOpenChange={(next) => {
          if (!next && !bookingBusy) setBookingRow(null);
        }}
        onConfirm={handleBookConfirm}
        onSelectAtHome={() => {
          if (bookingRow) handleSelectAtHome(bookingRow);
        }}
      />
    </div>
  );
}

function LoadingState() {
  return (
    <div className="flex flex-col gap-4">
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <div className="h-24 animate-pulse rounded-lg border bg-card" />
        <div className="h-24 animate-pulse rounded-lg border bg-card" />
        <div className="h-24 animate-pulse rounded-lg border bg-card" />
        <div className="h-24 animate-pulse rounded-lg border bg-card" />
      </div>
      <div className="h-10 animate-pulse rounded-lg border bg-card" />
      <div className="min-h-0 flex-1 animate-pulse rounded-lg border bg-card" />
    </div>
  );
}

function ErrorState({ message }: { message: string }) {
  return (
    <section className="rounded-lg border border-destructive/30 bg-destructive/10 px-4 py-6 text-center">
      <h2 className="text-sm font-semibold text-destructive">Progress tests unavailable</h2>
      <p className="mt-1 text-sm text-destructive/80">{message}</p>
    </section>
  );
}
