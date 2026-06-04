import {
  AlertTriangle,
  CalendarDays,
  ChevronRight,
  Clock3,
  ExternalLink,
  FileText,
  Filter,
  History,
  Link2,
  RefreshCw,
  Save,
  Search,
  ShieldAlert,
  Trash2,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import type {
  AffectedLineContact,
  AffectedSession,
  LeaveListResponse,
  LeaveRequestDetail,
  LeaveRequestRow,
  TimelineBucket,
  WorkflowStatus,
} from "./types";
import {
  DATE_PRESETS,
  QUEUE_FILTERS,
  STATUS_OPTIONS,
  affectedSessionClassLabel,
  affectedSessionFallbackText,
  affectedSessionStudentLabel,
  dateRange,
  formatTimelineDay,
  formatDateTime,
  isTimelineDateSelected,
  isTimelineDateToday,
  isActionNeeded,
  latestUpdatedAt,
  leaveTimeLabel,
  pressureLabel,
  pressureTone,
  requestAlerts,
  sheetStatusMeta,
  statusLabel,
  statusToneClass,
  studentContactState,
  timeLabel,
  timelineRangeLabel,
  type DatePreset,
  type QueueFilter,
} from "./view-model";

function SectionLabel({
  icon: Icon,
  children,
}: {
  icon: React.ComponentType<{ className?: string }>;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
      <Icon className="size-3.5" />
      {children}
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  return (
    <Badge variant="outline" className={cn("h-5 px-2", statusToneClass(status))}>
      {statusLabel(status)}
    </Badge>
  );
}

function LineContactPill({ contact }: { contact: AffectedLineContact }) {
  const label = contact.displayName ?? contact.linkedParentLabel ?? contact.lineUserId;
  return (
    <span className="inline-flex min-w-0 max-w-full items-center gap-1.5 rounded-md border border-emerald-200 bg-emerald-50 px-2 py-0.5 text-[11px] font-medium text-emerald-800">
      <span className="min-w-0 truncate">LINE: {label}</span>
      {contact.lineChatUrl ? (
        <a
          href={contact.lineChatUrl}
          target="_blank"
          rel="noreferrer"
          onClick={(event) => event.stopPropagation()}
          className="inline-flex shrink-0 items-center gap-1 text-emerald-900 underline-offset-2 hover:underline"
        >
          Open <ExternalLink className="size-3" />
        </a>
      ) : (
        <span className="shrink-0 text-amber-700">No direct chat</span>
      )}
    </span>
  );
}

function ContactStatePill({ state }: { state: string }) {
  const verified = state === "Verified LINE link";
  const parentMissing = state === "Parent not found in Credit Control snapshot";
  return (
    <span className={cn(
      "inline-flex rounded-md border px-2 py-0.5 text-[11px] font-medium",
      verified && "border-emerald-200 bg-emerald-50 text-emerald-800",
      parentMissing && "border-red-200 bg-red-50 text-red-700",
      !verified && !parentMissing && "border-amber-200 bg-amber-50 text-amber-800",
    )}>
      {state}
    </span>
  );
}

function AffectedStudentsSummary({
  session,
  compact = false,
}: {
  session: AffectedSession;
  compact?: boolean;
}) {
  const fallback = affectedSessionFallbackText(session);
  if (fallback) {
    return (
      <div className="min-w-0">
        <div className="truncate font-semibold">{affectedSessionStudentLabel(session)}</div>
        <div className="mt-1 text-[11px] font-medium text-amber-700">{fallback}</div>
      </div>
    );
  }

  return (
    <div className={cn("grid min-w-0 gap-2", compact && "gap-1.5")}>
      {session.students.map((student) => {
        const state = studentContactState(student);
        return (
          <div key={student.studentKey || student.wiseStudentId} className="min-w-0">
            <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
              <span className="min-w-0 truncate font-semibold">{student.studentName}</span>
              <span className="min-w-0 max-w-full truncate text-[11px] text-muted-foreground">
                Parent: {student.parentName || "Not found"}
              </span>
            </div>
            <div className="mt-1 flex min-w-0 flex-wrap gap-1">
              {!student.parentName && (
                <ContactStatePill state="Parent not found in Credit Control snapshot" />
              )}
              {student.lineContacts.length > 0 ? (
                student.lineContacts.map((contact) => (
                  <LineContactPill key={contact.linkId} contact={contact} />
                ))
              ) : (
                <ContactStatePill state={state} />
              )}
              {student.parentName && student.lineContacts.length > 0 && !student.lineContacts.some((contact) => contact.lineChatUrl) && (
                <ContactStatePill state={state} />
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function WiseClassDetail({ session, compact = false }: { session: AffectedSession; compact?: boolean }) {
  return (
    <div className="min-w-0 text-muted-foreground">
      <div className={cn("truncate font-medium text-foreground", compact && "text-[11px]")}>
        {affectedSessionClassLabel(session)}
      </div>
      <div className="truncate text-[11px]">
        {[session.subject, session.sessionType, session.location].filter(Boolean).join(" / ") || "Class details unavailable"}
      </div>
      <div className="truncate font-mono text-[10px]">
        {session.wiseClassId ?? "No class ID"} / {session.wiseSessionId}
      </div>
    </div>
  );
}

function MetricCard({
  label,
  value,
  detail,
  tone,
  selected,
}: {
  label: string;
  value: number;
  detail: string;
  tone: string;
  selected?: boolean;
}) {
  return (
    <div
      className={cn(
        "group rounded-lg border bg-card px-4 py-3 shadow-[0_1px_0_rgba(15,23,42,0.03)] transition-colors",
        selected ? "border-primary/30 bg-primary/5" : "border-border",
      )}
    >
      <div className="flex items-start justify-between gap-3">
        <div className={cn("h-1 w-9 rounded-full", tone)} />
        {selected && <ChevronRight className="size-4 text-primary" />}
      </div>
      <div className="mt-3 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className="mt-1 text-2xl font-semibold tracking-tight text-foreground">{value}</div>
      <div className="mt-1 truncate text-xs text-muted-foreground">{detail}</div>
    </div>
  );
}

export function LeaveRequestsCommandHeader({
  data,
  syncing,
  onSync,
  onReconnectSheets,
}: {
  data: LeaveListResponse | null;
  syncing: boolean;
  onSync: () => void;
  onReconnectSheets: () => void;
}) {
  const googleSheets = data?.googleSheets;
  const latestUpdate = latestUpdatedAt(data?.requests ?? []);

  return (
    <header className="flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
      <div className="min-w-0">
        <h1 className="text-2xl font-semibold tracking-tight text-foreground">Leave Requests</h1>
        <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2 text-xs text-muted-foreground">
          <span className="inline-flex items-center gap-2">
            <FileText className="size-3.5 text-emerald-700" />
            Source: Google Form Responses 1
          </span>
          {googleSheets && (
            <Badge
              variant="outline"
              className={cn(
                "h-6 gap-1.5 px-2.5",
                googleSheets.writeConnected
                  ? "border-emerald-200 bg-emerald-50 text-emerald-800"
                  : "border-amber-200 bg-amber-50 text-amber-900",
              )}
            >
              <span className={cn("size-1.5 rounded-full", googleSheets.writeConnected ? "bg-emerald-500" : "bg-amber-500")} />
              Sheets {googleSheets.writeConnected ? "write connected" : "write scope needed"}
            </Badge>
          )}
          <span className="inline-flex items-center gap-2">
            <Clock3 className="size-3.5" />
            Latest row update: {latestUpdate ? formatDateTime(latestUpdate) : "Not loaded"}
          </span>
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Button onClick={onSync} disabled={syncing} variant="outline" className="h-9 gap-2 border-primary/30 text-primary hover:bg-primary/10">
          <RefreshCw className={cn("size-4", syncing && "animate-spin")} />
          {syncing ? "Syncing" : "Sync now"}
        </Button>
        {googleSheets && !googleSheets.writeConnected && (
          <Button onClick={onReconnectSheets} variant="outline" className="h-9 gap-2">
            <Link2 className="size-4" />
            Reconnect Sheets
          </Button>
        )}
      </div>
    </header>
  );
}

export function LeaveKpiStrip({
  data,
  activeFilter,
}: {
  data: LeaveListResponse | null;
  activeFilter: QueueFilter;
}) {
  const cards = data?.cards;
  return (
    <section className="grid grid-cols-2 gap-3 xl:grid-cols-5">
      <MetricCard
        label="Action queue"
        value={data?.unreadActionCount ?? 0}
        detail="Needs your attention"
        tone="bg-primary"
        selected={activeFilter === "action"}
      />
      <MetricCard
        label="New"
        value={cards?.new ?? 0}
        detail="Untriaged"
        tone="bg-sky-500"
        selected={activeFilter === "new"}
      />
      <MetricCard
        label="Needs review"
        value={cards?.needsReview ?? 0}
        detail="Match or timing issue"
        tone="bg-amber-500"
        selected={activeFilter === "review"}
      />
      <MetricCard
        label="Wise overlaps"
        value={cards?.affectedClasses ?? 0}
        detail="Classes affected"
        tone="bg-violet-500"
      />
      <MetricCard
        label="Sheet issues"
        value={cards?.sheetWriteFailed ?? 0}
        detail="Write failures"
        tone="bg-red-500"
      />
    </section>
  );
}

export function RequestQueue({
  rows,
  loading,
  filter,
  query,
  datePreset,
  selectedId,
  onFilterChange,
  onQueryChange,
  onDatePresetChange,
  onSelect,
}: {
  rows: LeaveRequestRow[];
  loading: boolean;
  filter: QueueFilter;
  query: string;
  datePreset: DatePreset;
  selectedId: string | null;
  onFilterChange: (filter: QueueFilter) => void;
  onQueryChange: (query: string) => void;
  onDatePresetChange: (preset: DatePreset) => void;
  onSelect: (id: string) => void;
}) {
  return (
    <section className="flex min-h-[520px] min-w-0 flex-col overflow-hidden rounded-lg border border-border bg-card shadow-[0_1px_0_rgba(15,23,42,0.03)]">
      <div className="border-b border-border">
        <div className="flex overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          {QUEUE_FILTERS.map((item) => (
            <button
              key={item.key}
              type="button"
              aria-pressed={filter === item.key}
              onClick={() => onFilterChange(item.key)}
              className={cn(
                "h-11 shrink-0 border-b-2 px-4 text-sm font-medium transition-colors",
                filter === item.key
                  ? "border-primary text-primary"
                  : "border-transparent text-muted-foreground hover:text-foreground",
              )}
            >
              {item.label}
            </button>
          ))}
        </div>
      </div>

      <div className="grid gap-3 border-b border-border p-3">
        <div className="flex gap-2">
          <div className="relative min-w-0 flex-1">
            <Search className="pointer-events-none absolute left-2.5 top-2 size-4 text-muted-foreground" />
            <Input
              value={query}
              onChange={(event) => onQueryChange(event.currentTarget.value)}
              className="h-9 pl-8"
              placeholder="Search tutor, reason, email..."
            />
          </div>
          <Button type="button" variant="outline" size="icon-lg" aria-label="Filter queue">
            <Filter className="size-4" />
          </Button>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button type="button" variant="outline" size="icon-sm" aria-label="Date filters">
            <CalendarDays className="size-4" />
          </Button>
          {DATE_PRESETS.map((preset) => (
            <button
              key={preset.key}
              type="button"
              aria-pressed={datePreset === preset.key}
              onClick={() => onDatePresetChange(preset.key)}
              className={cn(
                "h-7 rounded-lg border px-3 text-xs font-medium transition-colors",
                datePreset === preset.key
                  ? "border-primary/25 bg-primary/10 text-primary"
                  : "border-border bg-background text-muted-foreground hover:text-foreground",
              )}
            >
              {preset.label}
            </button>
          ))}
        </div>
      </div>

      <div className="grid grid-cols-[minmax(0,1.4fr)_minmax(90px,0.7fr)_72px_72px_72px] gap-2 border-b border-border bg-muted/30 px-3 py-2 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground max-md:hidden">
        <span>Tutor / Leave</span>
        <span>Reason</span>
        <span>Status</span>
        <span className="text-right">Classes</span>
        <span>Sheet</span>
      </div>

      <div className="min-h-0 flex-1 overflow-auto">
        {loading ? (
          <div className="grid gap-2 p-3">
            {Array.from({ length: 7 }).map((_, index) => (
              <div key={index} className="h-[58px] animate-pulse rounded-md bg-muted/60" />
            ))}
          </div>
        ) : rows.length === 0 ? (
          <div className="grid min-h-72 place-items-center p-6 text-center">
            <div>
              <div className="mx-auto grid size-10 place-items-center rounded-full bg-muted text-muted-foreground">
                <Search className="size-4" />
              </div>
              <div className="mt-3 text-sm font-medium">No leave requests in this view</div>
              <p className="mt-1 max-w-xs text-xs text-muted-foreground">
                Try a different status, date range, or search term.
              </p>
            </div>
          </div>
        ) : (
          <div className="divide-y divide-border">
            {rows.map((row) => (
              <RequestQueueRow
                key={row.id}
                row={row}
                selected={selectedId === row.id}
                onSelect={() => onSelect(row.id)}
              />
            ))}
          </div>
        )}
      </div>

      <div className="flex items-center justify-between border-t border-border px-3 py-2 text-xs text-muted-foreground">
        <span>Showing {loading ? "..." : rows.length} request{rows.length === 1 ? "" : "s"}</span>
        <span>Synced rows stay in source order</span>
      </div>
    </section>
  );
}

function RequestQueueRow({
  row,
  selected,
  onSelect,
}: {
  row: LeaveRequestRow;
  selected: boolean;
  onSelect: () => void;
}) {
  const actionNeeded = isActionNeeded(row);
  const sheetMeta = sheetStatusMeta(row.sheetWriteStatus);
  return (
    <button
      type="button"
      onClick={onSelect}
      className={cn(
        "grid w-full gap-2 px-3 py-3 text-left text-sm transition-colors hover:bg-muted/50 md:grid-cols-[minmax(0,1.4fr)_minmax(90px,0.7fr)_72px_72px_72px]",
        selected && "bg-primary/10 ring-1 ring-inset ring-primary/20",
      )}
    >
      <span className="min-w-0">
        <span className="flex min-w-0 items-center gap-2">
          <span className={cn("size-2 shrink-0 rounded-full", actionNeeded ? "bg-primary" : "bg-muted-foreground/40")} />
          <span className="truncate font-semibold">{row.tutorDisplayName ?? row.tutorName}</span>
        </span>
        <span className="mt-1 block truncate pl-4 text-xs text-muted-foreground">
          {dateRange(row)} - {leaveTimeLabel(row)}
        </span>
        <span className="mt-0.5 block truncate pl-4 text-[11px] text-muted-foreground">
          Row {row.sourceRowNumber} - {formatDateTime(row.sourceSubmittedAt)}
        </span>
      </span>
      <span className="truncate text-xs text-muted-foreground md:pt-0.5">
        {row.normalizationStatus !== "ok" ? row.normalizationError ?? "Needs normalization" : row.matchConfidence === "unmatched" ? "Unmatched tutor" : row.sourceSheetStatus ?? "No sheet status"}
      </span>
      <span>
        <StatusBadge status={row.workflowStatus} />
      </span>
      <span className="text-xs font-semibold md:text-right">{row.affectedClassCount}</span>
      <span className={cn("text-[11px] font-medium", sheetMeta.className)}>{sheetMeta.label}</span>
    </button>
  );
}

export function LeaveTimelinePanel({
  buckets,
  selectedDate,
}: {
  buckets: TimelineBucket[];
  selectedDate: string | null;
}) {
  const visible = buckets.slice(0, 14);
  const totals = visible.reduce(
    (accumulator, bucket) => ({
      requests: accumulator.requests + bucket.total,
      classes: accumulator.classes + bucket.affectedClasses,
      actions: accumulator.actions + bucket.needsAction,
    }),
    { requests: 0, classes: 0, actions: 0 },
  );

  return (
    <section className="min-w-0 overflow-x-hidden rounded-lg border border-border bg-card p-4 shadow-[0_1px_0_rgba(15,23,42,0.03)]">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-sm font-semibold">Next 14 days</h2>
          <p className="mt-1 text-xs text-muted-foreground">{timelineRangeLabel(visible)}</p>
        </div>
        <div className="flex shrink-0 items-center gap-1.5 text-[11px] text-muted-foreground">
          <Badge variant="outline" className="h-6 border-border bg-background px-2">
            {totals.requests} Req
          </Badge>
          <Badge variant="outline" className="h-6 border-border bg-background px-2">
            {totals.classes} Cls
          </Badge>
        </div>
      </div>

      {visible.length === 0 ? (
        <div className="mt-4 rounded-md border border-dashed border-border p-6 text-center text-sm text-muted-foreground">
          Timeline is loading.
        </div>
      ) : (
        <div className="mt-4 min-w-0 max-w-full overflow-x-auto pb-1 [scrollbar-width:thin]">
          <div
            className="grid min-w-full gap-1"
            style={{ gridTemplateColumns: `repeat(${visible.length}, minmax(3.25rem, 1fr))` }}
          >
            {visible.map((bucket) => {
              const { weekday, dateLabel } = formatTimelineDay(bucket.date);
              const selected = isTimelineDateSelected(bucket, selectedDate);
              const today = isTimelineDateToday(bucket);
              const pressure = pressureTone(bucket.affectedClasses);
              const empty = bucket.total === 0;
              return (
                <div
                  key={bucket.date}
                  className={cn(
                    "grid h-[86px] min-w-0 grid-rows-[auto_1fr_auto] overflow-hidden rounded-md border px-1.5 py-1.5 text-[11px] transition-colors",
                    selected ? "border-primary/40 bg-primary/10 shadow-[inset_0_0_0_1px_rgba(14,165,233,0.18)]" : "border-border bg-background",
                    today && !selected && "border-sky-200 bg-sky-50/70",
                  )}
                  aria-label={`${dateLabel}: ${bucket.total} requests, ${bucket.affectedClasses} affected classes, ${bucket.needsAction} need action`}
                >
                  <div className="min-w-0 text-center leading-tight">
                    <div className="truncate text-[9px] font-semibold uppercase text-muted-foreground">{weekday}</div>
                    <div className="truncate font-semibold text-foreground">{dateLabel}</div>
                    {today && (
                      <Badge variant="outline" className="mt-0.5 h-4 border-sky-200 bg-sky-100 px-1 text-[9px] leading-none text-sky-800">
                        Today
                      </Badge>
                    )}
                  </div>
                  {empty ? (
                    <div className="grid place-items-center rounded bg-muted/35 px-1 text-center text-[10px] font-medium leading-tight text-muted-foreground">
                      No leave
                    </div>
                  ) : (
                    <div className="grid min-w-0 gap-0.5 self-center leading-tight">
                      <div className="flex min-w-0 items-center justify-between gap-1 rounded bg-muted/45 px-1 py-0.5">
                        <span className="text-[10px] text-muted-foreground">Req</span>
                        <span className="font-semibold text-foreground">{bucket.total}</span>
                      </div>
                      <div className="flex min-w-0 items-center justify-between gap-1 rounded bg-muted/45 px-1 py-0.5">
                        <span className="text-[10px] text-muted-foreground">Cls</span>
                        <span className="font-semibold text-foreground">{bucket.affectedClasses}</span>
                      </div>
                      {bucket.needsAction > 0 && (
                        <div className="truncate rounded border border-primary/20 bg-primary/10 px-1 py-0.5 text-center text-[10px] font-medium leading-none text-primary">
                          {bucket.needsAction} Action
                        </div>
                      )}
                    </div>
                  )}
                  <div className="self-end">
                    <span
                      className="block w-full rounded-full bg-muted"
                      aria-label={`${pressureLabel(bucket.affectedClasses)}: ${bucket.affectedClasses} affected classes`}
                    >
                      <span
                        className={cn(
                          "block h-1 rounded-full",
                          pressure === "high" && "bg-red-500",
                          pressure === "medium" && "bg-amber-500",
                          pressure === "low" && "bg-emerald-500",
                          pressure === "none" && "bg-muted-foreground/20",
                        )}
                        style={{ width: `${empty ? 12 : 100}%` }}
                      />
                    </span>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      <div className="mt-3 flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 rounded-md border border-border bg-background px-3 py-2 text-[11px] text-muted-foreground">
        <span><span className="font-medium text-foreground">Req</span> = requests</span>
        <span><span className="font-medium text-foreground">Cls</span> = affected classes</span>
        <span><span className="font-medium text-foreground">Action</span> = needs admin work</span>
        {totals.actions > 0 && <span className="font-medium text-primary">{totals.actions} action needed</span>}
      </div>
    </section>
  );
}

export function AffectedClassesPanel({
  detail,
  loading,
  selectedAffected,
  onToggle,
}: {
  detail: LeaveRequestDetail | null;
  loading: boolean;
  selectedAffected: Set<string>;
  onToggle: (id: string, checked: boolean) => void;
}) {
  return (
    <section className="rounded-lg border border-border bg-card p-4 shadow-[0_1px_0_rgba(15,23,42,0.03)]">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold">
            Affected Wise classes{detail ? ` for ${detail.request.tutorDisplayName ?? detail.request.tutorName}` : ""}
          </h2>
          <p className="mt-1 text-xs text-muted-foreground">
            {detail ? `${dateRange(detail.request)} (${leaveTimeLabel(detail.request)})` : "Select a request to review overlaps"}
          </p>
        </div>
        <Badge variant="outline" className="border-primary/20 bg-primary/10 text-primary">
          {selectedAffected.size} selected
        </Badge>
      </div>

      {loading ? (
        <div className="mt-4 h-28 animate-pulse rounded-md bg-muted/60" />
      ) : !detail ? (
        <div className="mt-4 rounded-md border border-dashed border-border p-6 text-center text-sm text-muted-foreground">
          Select a request to see Wise overlaps.
        </div>
      ) : detail.affectedSessions.length === 0 ? (
        <div className="mt-4 rounded-md bg-muted/50 p-4 text-sm text-muted-foreground">
          No Wise sessions overlap this leave window.
        </div>
      ) : (
        <div className="mt-4 overflow-hidden rounded-lg border border-border">
          <div className="grid grid-cols-[32px_minmax(0,1fr)_64px] gap-2 bg-muted/30 px-3 py-2 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground md:grid-cols-[32px_78px_minmax(0,1.25fr)_minmax(0,0.8fr)_64px_72px]">
            <span />
            <span className="max-md:hidden">Time</span>
            <span>Student / Parent</span>
            <span className="max-md:hidden">Class</span>
            <span>Overlap</span>
            <span className="max-md:hidden">Status</span>
          </div>
          <div className="divide-y divide-border">
            {detail.affectedSessions.map((session) => (
              <AffectedSessionCompactRow
                key={session.id}
                session={session}
                selected={selectedAffected.has(session.id)}
                onToggle={(checked) => onToggle(session.id, checked)}
              />
            ))}
          </div>
        </div>
      )}

      <div className="mt-3 rounded-md border border-border bg-background px-3 py-2 text-xs text-muted-foreground">
        Showing overlap with leave time only. Wise cancellation remains manual.
      </div>
    </section>
  );
}

function AffectedSessionCompactRow({
  session,
  selected,
  onToggle,
}: {
  session: AffectedSession;
  selected: boolean;
  onToggle: (checked: boolean) => void;
}) {
  return (
    <div className="grid min-w-0 grid-cols-[32px_minmax(0,1fr)_64px] gap-2 overflow-hidden px-3 py-3 text-xs hover:bg-muted/40 md:grid-cols-[32px_78px_minmax(0,1.25fr)_minmax(0,0.8fr)_64px_72px]">
      <span>
        <input
          type="checkbox"
          checked={selected}
          onChange={(event) => onToggle(event.currentTarget.checked)}
          className="mt-0.5 size-4 rounded border-input"
        />
      </span>
      <span className="text-muted-foreground max-md:hidden">{timeLabel(session.startMinute)}-{timeLabel(session.endMinute)}</span>
      <span className="min-w-0">
        <AffectedStudentsSummary session={session} compact />
        <span className="mt-1 block truncate text-[11px] text-muted-foreground md:hidden">
          {timeLabel(session.startMinute)}-{timeLabel(session.endMinute)} / {affectedSessionClassLabel(session)}
        </span>
      </span>
      <span className="min-w-0 max-md:hidden">
        <WiseClassDetail session={session} compact />
      </span>
      <span>
        <Badge variant="outline" className="border-red-200 bg-red-50 text-red-700">{session.overlapMinutes}m</Badge>
      </span>
      <span className="truncate text-muted-foreground max-md:hidden">{session.wiseStatus}</span>
    </div>
  );
}

export function PreviewOnlyNotice({ selectedCount }: { selectedCount: number }) {
  return (
    <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900">
      <div className="flex items-start gap-2">
        <AlertTriangle className="mt-0.5 size-4 shrink-0" />
        <div>
          <div className="font-semibold">Preview only - no Wise mutation is sent.</div>
          <div className="mt-0.5 text-amber-800">
            This logs the manual Wise cancellation endpoints for {selectedCount} selected session{selectedCount === 1 ? "" : "s"}.
          </div>
        </div>
      </div>
    </div>
  );
}

export function RequestInspector({
  detail,
  loading,
  saving,
  detailStatus,
  sheetText,
  staffNote,
  selectedAffected,
  onStatusChange,
  onSheetTextChange,
  onStaffNoteChange,
  onSave,
  onRetrySheet,
  onToggleAffected,
  onPreviewCancel,
}: {
  detail: LeaveRequestDetail | null;
  loading: boolean;
  saving: boolean;
  detailStatus: WorkflowStatus;
  sheetText: string;
  staffNote: string;
  selectedAffected: Set<string>;
  onStatusChange: (status: WorkflowStatus) => void;
  onSheetTextChange: (value: string) => void;
  onStaffNoteChange: (value: string) => void;
  onSave: () => void;
  onRetrySheet: () => void;
  onToggleAffected: (id: string, checked: boolean) => void;
  onPreviewCancel: () => void;
}) {
  if (loading) {
    return (
      <aside className="min-h-[520px] rounded-lg border border-border bg-card p-4">
        <div className="h-8 w-40 animate-pulse rounded bg-muted" />
        <div className="mt-4 grid gap-3">
          {Array.from({ length: 8 }).map((_, index) => (
            <div key={index} className="h-12 animate-pulse rounded-md bg-muted/70" />
          ))}
        </div>
      </aside>
    );
  }

  if (!detail) {
    return (
      <aside className="grid min-h-[520px] place-items-center rounded-lg border border-border bg-card p-6 text-center">
        <div>
          <div className="mx-auto grid size-11 place-items-center rounded-full bg-muted text-muted-foreground">
            <FileText className="size-5" />
          </div>
          <div className="mt-3 text-sm font-medium">Select a leave request</div>
          <p className="mt-1 max-w-xs text-xs text-muted-foreground">
            The decision panel will show matching, Wise overlaps, Sheet writeback, and the audit trail.
          </p>
        </div>
      </aside>
    );
  }

  const alerts = requestAlerts(detail);
  const request = detail.request;

  return (
    <aside className="min-h-0 overflow-hidden rounded-lg border border-border bg-card shadow-[0_1px_0_rgba(15,23,42,0.03)]">
      <div className="max-h-full overflow-auto">
        <div className="border-b border-border p-4">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="flex min-w-0 items-center gap-2">
                <h2 className="truncate text-xl font-semibold tracking-tight">{request.tutorDisplayName ?? request.tutorName}</h2>
                <StatusBadge status={request.workflowStatus} />
              </div>
              <div className="mt-1 text-xs text-muted-foreground">
                {dateRange(request)} ({leaveTimeLabel(request)}) - Form submitted {formatDateTime(request.sourceSubmittedAt)}
              </div>
              <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
                <Badge variant="outline" className="border-emerald-200 bg-emerald-50 text-emerald-800">
                  Match confidence: {request.matchConfidence}
                </Badge>
                {request.unread && (
                  <Badge variant="outline" className="border-primary/25 bg-primary/10 text-primary">
                    Unread
                  </Badge>
                )}
              </div>
            </div>
          </div>

          {alerts.length > 0 && (
            <div className="mt-3 grid gap-2">
              {alerts.map((alert) => (
                <div key={alert} className="flex items-center justify-between gap-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900">
                  <span className="flex min-w-0 items-center gap-2">
                    <AlertTriangle className="size-4 shrink-0" />
                    <span className="min-w-0 truncate">{alert}</span>
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="grid gap-5 p-4">
          <section className="grid gap-3">
            <SectionLabel icon={FileText}>Request summary</SectionLabel>
            <div className="grid grid-cols-2 gap-2 text-xs sm:grid-cols-4">
              <SummaryField label="Reason" value={request.reason ?? "Blank"} />
              <SummaryField label="Make-up" value={request.makeupOptions ?? "Blank"} />
              <SummaryField label="Certificate" value={request.certificateUrl ? "Provided" : "Blank"} />
              <SummaryField label="Emergency" value={request.emergencyUsed === null ? "Blank" : String(request.emergencyUsed)} />
            </div>
          </section>

          <section className="grid gap-3 border-t border-border pt-4">
            <SectionLabel icon={Save}>Workflow decision</SectionLabel>
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="grid gap-1.5 text-xs">
                <span className="font-medium text-muted-foreground">Status</span>
                <Select value={detailStatus} onValueChange={(value) => value && onStatusChange(value as WorkflowStatus)}>
                  <SelectTrigger className="h-9 w-full bg-background">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent align="start">
                    {STATUS_OPTIONS.map((option) => (
                      <SelectItem key={option.value} value={option.value}>
                        {option.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </label>
              <label className="grid gap-1.5 text-xs">
                <span className="font-medium text-muted-foreground">Sheet status text</span>
                <Input
                  value={sheetText}
                  onChange={(event) => onSheetTextChange(event.currentTarget.value)}
                  placeholder="Leave blank to keep current"
                  className="h-9"
                />
              </label>
            </div>
            <label className="grid gap-1.5 text-xs">
              <span className="font-medium text-muted-foreground">Staff note</span>
              <Textarea
                value={staffNote}
                onChange={(event) => onStaffNoteChange(event.currentTarget.value)}
                placeholder="Add an internal note..."
                rows={3}
              />
            </label>
            <div className="flex flex-wrap gap-2">
              <Button onClick={onSave} disabled={saving} className="h-9 gap-2">
                <Save className="size-4" />
                Save changes
              </Button>
              {request.sheetWriteStatus === "failed" && (
                <Button onClick={onRetrySheet} disabled={saving} variant="outline" className="h-9 gap-2">
                  <RefreshCw className="size-4" />
                  Retry Sheet
                </Button>
              )}
            </div>
          </section>

          <section className="grid gap-3 border-t border-border pt-4">
            <div className="flex items-center justify-between gap-3">
              <SectionLabel icon={ShieldAlert}>Affected Wise</SectionLabel>
              <Badge variant="outline" className="border-border bg-background">{selectedAffected.size} selected</Badge>
            </div>
            {detail.affectedSessions.length === 0 ? (
              <div className="rounded-md bg-muted/50 p-3 text-xs text-muted-foreground">No Wise sessions overlap this leave.</div>
            ) : (
              <div className="grid max-h-64 gap-2 overflow-auto pr-1">
                {detail.affectedSessions.map((session) => (
                  <AffectedSessionCard
                    key={session.id}
                    session={session}
                    selected={selectedAffected.has(session.id)}
                    onToggle={(checked) => onToggleAffected(session.id, checked)}
                  />
                ))}
              </div>
            )}
            <PreviewOnlyNotice selectedCount={selectedAffected.size} />
            <Button
              onClick={onPreviewCancel}
              disabled={saving || selectedAffected.size === 0}
              variant="outline"
              className="h-9 gap-2 border-red-200 text-red-700 hover:bg-red-50"
            >
              <Trash2 className="size-4" />
              Preview cancellation ({selectedAffected.size} session{selectedAffected.size === 1 ? "" : "s"})
            </Button>
          </section>

          <section className="grid gap-3 border-t border-border pt-4">
            <SectionLabel icon={FileText}>Form notes</SectionLabel>
            <div className="grid gap-2 rounded-lg bg-muted/50 p-3 text-xs">
              <div><span className="text-muted-foreground">Reason:</span> {request.reason ?? "Blank"}</div>
              <div><span className="text-muted-foreground">Make-up:</span> {request.makeupOptions ?? "Blank"}</div>
              <div><span className="text-muted-foreground">Certificate:</span> {request.certificateUrl ? (
                <span className="inline-flex items-center gap-1 text-primary">Provided <ExternalLink className="size-3" /></span>
              ) : "Blank"}</div>
              <div><span className="text-muted-foreground">Emergency:</span> {request.emergencyUsed ?? "Blank"}</div>
              {request.situationText && <div><span className="text-muted-foreground">Situation:</span> {request.situationText}</div>}
            </div>
          </section>

          <section className="grid gap-3 border-t border-border pt-4">
            <SectionLabel icon={History}>Action history</SectionLabel>
            <div className="grid max-h-64 gap-2 overflow-auto pr-1 text-xs">
              {detail.activityLog.length === 0 ? (
                <div className="rounded-md bg-muted/50 p-3 text-muted-foreground">No actions logged yet.</div>
              ) : detail.activityLog.slice(0, 8).map((log) => (
                <div key={log.id} className="rounded-lg border border-border bg-background p-3">
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-semibold">{log.actionType}</span>
                    <span className="text-muted-foreground">{formatDateTime(log.createdAt)}</span>
                  </div>
                  <div className="mt-1 text-muted-foreground">{log.message ?? log.errorMessage ?? log.status}</div>
                </div>
              ))}
            </div>
          </section>

          <details className="rounded-lg border border-border bg-background p-3 text-xs">
            <summary className="cursor-pointer font-medium">Raw form payload</summary>
            <pre className="mt-3 max-h-64 overflow-auto rounded bg-muted p-3 text-[11px] text-muted-foreground">
              {JSON.stringify(request.rawValues, null, 2)}
            </pre>
          </details>
        </div>
      </div>
    </aside>
  );
}

function SummaryField({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0 rounded-lg bg-muted/45 p-3">
      <div className="text-[11px] font-medium text-muted-foreground">{label}</div>
      <div className="mt-1 line-clamp-2 font-medium text-foreground">{value}</div>
    </div>
  );
}

function AffectedSessionCard({
  session,
  selected,
  onToggle,
}: {
  session: AffectedSession;
  selected: boolean;
  onToggle: (checked: boolean) => void;
}) {
  return (
    <div className={cn(
      "grid min-w-0 grid-cols-[22px_minmax(0,1fr)_52px] gap-2 overflow-hidden rounded-lg border px-3 py-2 text-xs transition-colors",
      selected ? "border-primary/25 bg-primary/10" : "border-border bg-background hover:bg-muted/40",
    )}>
      <input
        type="checkbox"
        checked={selected}
        onChange={(event) => onToggle(event.currentTarget.checked)}
        className="mt-1 size-4 rounded border-input"
      />
      <div className="grid min-w-0 gap-2">
        <AffectedStudentsSummary session={session} />
        <div className="rounded-md bg-muted/40 px-2 py-1.5">
          <div className="text-[11px] text-muted-foreground">
            {formatDateTime(session.startTime)} / {timeLabel(session.startMinute)}-{timeLabel(session.endMinute)}
          </div>
          <WiseClassDetail session={session} />
        </div>
      </div>
      <div className="text-right">
        <div className="font-medium text-red-700">{session.overlapMinutes}m</div>
        <div className="mt-1 truncate text-[10px] text-muted-foreground">{session.wiseStatus}</div>
      </div>
    </div>
  );
}

export function ErrorBanner({ message }: { message: string }) {
  return (
    <div className="flex items-center gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">
      <AlertTriangle className="size-4 shrink-0" />
      <span className="min-w-0 truncate">{message}</span>
    </div>
  );
}
