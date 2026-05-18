"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  BarChart3,
  CalendarDays,
  Clock3,
  Database,
  DoorOpen,
  RefreshCw,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { minuteToTimeLabel, weekdayName } from "@/lib/room-capacity/dates";
import type {
  RoomUtilizationDailyRow,
  RoomUtilizationMetric,
  RoomUtilizationMonthlyRow,
  RoomUtilizationResponse,
  RoomUtilizationRoomRow,
} from "@/lib/room-capacity/types";

const WEEKDAY_FILTER_OPTIONS = [
  { value: 1, label: "Mon" },
  { value: 2, label: "Tue" },
  { value: 3, label: "Wed" },
  { value: 4, label: "Thu" },
  { value: 5, label: "Fri" },
  { value: 6, label: "Sat" },
  { value: 0, label: "Sun" },
];
const ALL_WEEKDAY_FILTER_VALUES = [0, 1, 2, 3, 4, 5, 6];

function formatPercent(value: number): string {
  return `${value.toLocaleString("en-US", { maximumFractionDigits: 1 })}%`;
}

function formatHours(minutes: number): string {
  return `${(minutes / 60).toLocaleString("en-US", { maximumFractionDigits: 1 })}h`;
}

function formatWhole(value: number): string {
  return value.toLocaleString("en-US");
}

function formatDate(date: string): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Bangkok",
    day: "numeric",
    month: "short",
  }).format(new Date(`${date}T00:00:00+07:00`));
}

function formatMonth(month: string): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Bangkok",
    month: "short",
    year: "numeric",
  }).format(new Date(`${month}-01T00:00:00+07:00`));
}

function formatDateTime(value: string | null): string {
  if (!value) return "Never synced";
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Bangkok",
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

function utilizationTone(value: number): string {
  if (value >= 100) return "text-conflict";
  if (value >= 75) return "text-amber-700";
  if (value >= 45) return "text-primary";
  return "text-available";
}

function barColor(value: number): string {
  if (value >= 100) return "bg-conflict";
  if (value >= 75) return "bg-blocked";
  if (value >= 45) return "bg-primary";
  if (value > 0) return "bg-available";
  return "bg-muted";
}

function StatCard({
  icon: Icon,
  label,
  value,
  detail,
  tone = "default",
}: {
  icon: typeof BarChart3;
  label: string;
  value: string;
  detail: string;
  tone?: "default" | "warn" | "danger";
}) {
  return (
    <div className="rounded-lg border bg-card px-4 py-3">
      <div className="flex items-center justify-between gap-3">
        <div className="text-xs font-medium text-muted-foreground">{label}</div>
        <Icon className={`size-4 ${tone === "danger" ? "text-conflict" : tone === "warn" ? "text-amber-600" : "text-primary"}`} />
      </div>
      <div className="mt-2 text-2xl font-semibold tracking-tight">{value}</div>
      <div className="mt-1 text-xs text-muted-foreground">{detail}</div>
    </div>
  );
}

function UtilizationBar({ value }: { value: number }) {
  return (
    <div className="h-2.5 overflow-hidden rounded-full bg-muted">
      <div
        className={`h-full rounded-full ${barColor(value)}`}
        style={{ width: `${Math.min(Math.max(value, 0), 100)}%` }}
      />
    </div>
  );
}

function metricRangeLabel(data: RoomUtilizationResponse): string {
  const selectedWeekdays = new Set(data.range.weekdays);
  const dayLabel = data.range.weekdays.length === 7
    ? "All days"
    : WEEKDAY_FILTER_OPTIONS.filter((option) => selectedWeekdays.has(option.value)).map((option) => option.label).join(", ");
  return `${formatDate(data.range.startDate)} to ${formatDate(data.range.endDate)} · ${minuteToTimeLabel(data.range.openStartMinute)}-${minuteToTimeLabel(data.range.openEndMinute)} · ${dayLabel}`;
}

export function DailyTrend({ rows }: { rows: RoomUtilizationDailyRow[] }) {
  const recentRows = rows.slice(-90);
  return (
    <section className="rounded-lg border bg-card">
      <div className="flex items-center justify-between gap-3 border-b px-4 py-3">
        <div>
          <h2 className="text-sm font-semibold">Daily utilization</h2>
          <p className="text-xs text-muted-foreground">Room-time utilization by Bangkok date</p>
        </div>
        <Badge variant="outline">{recentRows.length} days</Badge>
      </div>
      <div className="overflow-x-auto p-4">
        <div className="flex min-w-[760px] items-end gap-1.5">
          {recentRows.map((row) => (
            <div key={row.date} className="flex min-w-7 flex-1 flex-col items-center gap-2">
              <div className="flex h-40 w-full items-end rounded-md bg-muted/55 p-1">
                <div
                  className={`w-full rounded-sm ${barColor(row.utilizationPct)}`}
                  style={{ height: `${Math.min(Math.max(row.utilizationPct, 2), 100)}%` }}
                  title={`${row.date}: ${formatPercent(row.utilizationPct)} (${formatHours(row.occupiedMinutes)})`}
                />
              </div>
              <div className="h-8 text-center text-[10px] leading-tight text-muted-foreground">
                <div>{formatDate(row.date)}</div>
                <div>{weekdayName(row.weekday).slice(0, 3)}</div>
              </div>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

export function MonthlySummary({ rows }: { rows: RoomUtilizationMonthlyRow[] }) {
  return (
    <section className="rounded-lg border bg-card">
      <div className="border-b px-4 py-3">
        <h2 className="text-sm font-semibold">Monthly utilization</h2>
        <p className="text-xs text-muted-foreground">Macro utilization across all active rooms</p>
      </div>
      <div className="overflow-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Month</TableHead>
              <TableHead className="text-right">Utilization</TableHead>
              <TableHead>Trend</TableHead>
              <TableHead className="text-right">Occupied</TableHead>
              <TableHead className="text-right">Available</TableHead>
              <TableHead className="text-right">Sessions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((row) => (
              <TableRow key={row.month}>
                <TableCell>
                  <div className="font-medium">{formatMonth(row.month)}</div>
                  <div className="text-xs text-muted-foreground">{formatDate(row.startDate)}-{formatDate(row.endDate)}</div>
                </TableCell>
                <TableCell className={`text-right font-semibold ${utilizationTone(row.utilizationPct)}`}>
                  {formatPercent(row.utilizationPct)}
                </TableCell>
                <TableCell className="min-w-36">
                  <UtilizationBar value={row.utilizationPct} />
                </TableCell>
                <TableCell className="text-right font-mono text-xs">{formatHours(row.occupiedMinutes)}</TableCell>
                <TableCell className="text-right font-mono text-xs">{formatHours(row.availableMinutes)}</TableCell>
                <TableCell className="text-right">{formatWhole(row.sessionCount)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </section>
  );
}

export function RoomTable({ rows }: { rows: RoomUtilizationRoomRow[] }) {
  return (
    <section className="rounded-lg border bg-card">
      <div className="flex items-center justify-between gap-3 border-b px-4 py-3">
        <div>
          <h2 className="text-sm font-semibold">Per-room utilization</h2>
          <p className="text-xs text-muted-foreground">Sorted by utilization across the selected range</p>
        </div>
        <Badge variant="outline">{rows.length} rooms</Badge>
      </div>
      <div className="max-h-[420px] overflow-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Room</TableHead>
              <TableHead>Type</TableHead>
              <TableHead className="text-right">Utilization</TableHead>
              <TableHead>Trend</TableHead>
              <TableHead className="text-right">Occupied</TableHead>
              <TableHead className="text-right">Sessions</TableHead>
              <TableHead className="text-right">Overlap</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((row) => (
              <TableRow key={row.roomName}>
                <TableCell className="font-medium">{row.roomName}</TableCell>
                <TableCell>
                  <Badge variant="secondary" className="capitalize">{row.category.replace("_", " ")}</Badge>
                </TableCell>
                <TableCell className={`text-right font-semibold ${utilizationTone(row.utilizationPct)}`}>
                  {formatPercent(row.utilizationPct)}
                </TableCell>
                <TableCell className="min-w-36">
                  <UtilizationBar value={row.utilizationPct} />
                </TableCell>
                <TableCell className="text-right font-mono text-xs">{formatHours(row.occupiedMinutes)}</TableCell>
                <TableCell className="text-right">{formatWhole(row.sessionCount)}</TableCell>
                <TableCell className="text-right font-mono text-xs">{formatHours(row.overlapMinutes)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </section>
  );
}

function EmptyState() {
  return (
    <div className="rounded-lg border bg-card p-8 text-center">
      <div className="text-sm font-semibold">No utilization sessions loaded</div>
      <div className="mt-2 text-sm text-muted-foreground">
        Run the Wise room-utilization sync to backfill sessions from March 2026.
      </div>
    </div>
  );
}

function overallDetail(metric: RoomUtilizationMetric): string {
  return `${formatHours(metric.occupiedMinutes)} used of ${formatHours(metric.availableMinutes)}`;
}

function sortWeekdays(values: number[]): number[] {
  return [...new Set(values)].sort((left, right) => left - right);
}

export function WeekdayFilter({
  selectedWeekdays,
  onChange,
  disabled = false,
}: {
  selectedWeekdays: number[];
  onChange: (weekdays: number[]) => void;
  disabled?: boolean;
}) {
  const selected = new Set(selectedWeekdays);
  const allSelected = selected.size === 7;

  function toggleWeekday(weekday: number) {
    if (selected.has(weekday)) {
      const next = selectedWeekdays.filter((value) => value !== weekday);
      onChange(next.length ? sortWeekdays(next) : ALL_WEEKDAY_FILTER_VALUES);
    } else {
      onChange(sortWeekdays([...selectedWeekdays, weekday]));
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-1.5 rounded-lg border bg-card px-2 py-1.5">
      <span className="px-1 text-xs font-medium text-muted-foreground">Days</span>
      <Button
        type="button"
        size="xs"
        variant={allSelected ? "default" : "outline"}
        aria-pressed={allSelected}
        disabled={disabled}
        onClick={() => onChange(ALL_WEEKDAY_FILTER_VALUES)}
      >
        All
      </Button>
      {WEEKDAY_FILTER_OPTIONS.map((option) => {
        const isSelected = selected.has(option.value);
        return (
          <Button
            key={option.value}
            type="button"
            size="xs"
            variant={isSelected && !allSelected ? "secondary" : "outline"}
            aria-pressed={isSelected}
            disabled={disabled}
            onClick={() => toggleWeekday(option.value)}
          >
            {option.label}
          </Button>
        );
      })}
    </div>
  );
}

export function RoomCapacityDashboard() {
  const [data, setData] = useState<RoomUtilizationResponse | null>(null);
  const [selectedWeekdays, setSelectedWeekdays] = useState<number[]>(ALL_WEEKDAY_FILTER_VALUES);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadData = useCallback(async () => {
    setError(null);
    const params = new URLSearchParams();
    if (selectedWeekdays.length !== 7) {
      params.set("weekdays", selectedWeekdays.join(","));
    }
    const query = params.toString();
    const response = await fetch(`/api/room-capacity/utilization${query ? `?${query}` : ""}`);
    const body = await response.json();
    if (!response.ok) throw new Error(body.error ?? `HTTP ${response.status}`);
    setData(body as RoomUtilizationResponse);
  }, [selectedWeekdays]);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      await loadData();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load room utilization");
    } finally {
      setLoading(false);
    }
  }, [loadData]);

  const syncHistory = useCallback(async () => {
    setSyncing(true);
    setError(null);
    try {
      const response = await fetch("/api/internal/sync-room-utilization", { method: "POST" });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error ?? `HTTP ${response.status}`);
      await loadData();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to sync room utilization");
    } finally {
      setSyncing(false);
    }
  }, [loadData]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const hasRows = useMemo(() => Boolean(data?.summary.sessionCount), [data]);

  if (loading && !data) {
    return (
      <div className="flex min-h-0 flex-1 flex-col gap-4">
        <div className="h-16 animate-pulse rounded-lg bg-muted" />
        <div className="grid grid-cols-5 gap-3">
          {Array.from({ length: 5 }, (_, index) => (
            <div key={index} className="h-24 animate-pulse rounded-lg bg-muted" />
          ))}
        </div>
        <div className="h-80 animate-pulse rounded-lg bg-muted" />
      </div>
    );
  }

  if (error && !data) {
    return (
      <div className="rounded-lg border bg-card p-6">
        <div className="text-sm font-semibold text-conflict">Room utilization failed to load</div>
        <div className="mt-2 text-sm text-muted-foreground">{error}</div>
        <Button type="button" className="mt-4" onClick={() => void refresh()}>
          Retry
        </Button>
      </div>
    );
  }

  if (!data) return null;

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-hidden">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Room Utilization</h1>
          <div className="mt-1 flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
            <CalendarDays className="size-4" />
            <span>{metricRangeLabel(data)}</span>
            <span>Last synced {formatDateTime(data.lastSyncedAt)}</span>
          </div>
        </div>
        <div className="flex flex-wrap items-center justify-end gap-2">
          <WeekdayFilter
            selectedWeekdays={selectedWeekdays}
            onChange={setSelectedWeekdays}
            disabled={loading || syncing}
          />
          <Button type="button" variant="outline" size="sm" onClick={() => void refresh()} disabled={loading || syncing}>
            <RefreshCw className={`mr-2 size-4 ${loading ? "animate-spin" : ""}`} />
            Refresh
          </Button>
          <Button type="button" size="sm" onClick={() => void syncHistory()} disabled={syncing}>
            <Database className={`mr-2 size-4 ${syncing ? "animate-spin" : ""}`} />
            Refresh history
          </Button>
        </div>
      </div>

      {error ? (
        <div className="rounded-md border border-conflict/30 bg-conflict/5 px-4 py-3 text-sm text-conflict">
          {error}
        </div>
      ) : null}

      <div className="grid gap-3 md:grid-cols-5">
        <StatCard
          icon={BarChart3}
          label="Overall utilization"
          value={formatPercent(data.summary.utilizationPct)}
          detail={overallDetail(data.summary)}
          tone={data.summary.utilizationPct >= 100 ? "danger" : data.summary.utilizationPct >= 75 ? "warn" : "default"}
        />
        <StatCard
          icon={Clock3}
          label="Occupied room-hours"
          value={formatHours(data.summary.occupiedMinutes)}
          detail={`${formatWhole(data.summary.sessionCount)} counted sessions`}
        />
        <StatCard
          icon={DoorOpen}
          label="Available room-hours"
          value={formatHours(data.summary.availableMinutes)}
          detail={`${data.summary.activeRoomCount} active rooms`}
        />
        <StatCard
          icon={AlertTriangle}
          label="Missing / unknown"
          value={formatWhole(data.dataQuality.missingLocationCount + data.dataQuality.unknownRoomCount)}
          detail={`${formatHours(data.dataQuality.missingLocationMinutes + data.dataQuality.unknownRoomMinutes)} excluded`}
          tone={data.dataQuality.missingLocationCount + data.dataQuality.unknownRoomCount ? "warn" : "default"}
        />
        <StatCard
          icon={AlertTriangle}
          label="Overlap minutes"
          value={formatHours(data.dataQuality.overlapMinutes)}
          detail="Double-counted room pressure"
          tone={data.dataQuality.overlapMinutes ? "danger" : "default"}
        />
      </div>

      {!hasRows ? <EmptyState /> : null}

      <div className="min-h-0 flex-1 overflow-auto">
        <div className="grid gap-4 xl:grid-cols-[1.15fr_0.85fr]">
          <div className="xl:col-span-2">
            <DailyTrend rows={data.daily} />
          </div>
          <MonthlySummary rows={data.monthly} />
          <RoomTable rows={data.rooms} />
          <section className="rounded-lg border bg-card xl:col-span-2">
            <div className="border-b px-4 py-3">
              <h2 className="text-sm font-semibold">Data quality</h2>
              <p className="text-xs text-muted-foreground">Excluded from utilization unless they map to an active room and counted status</p>
            </div>
            <div className="grid gap-3 p-4 md:grid-cols-4">
              <StatCard
                icon={AlertTriangle}
                label="Missing room"
                value={formatWhole(data.dataQuality.missingLocationCount)}
                detail={formatHours(data.dataQuality.missingLocationMinutes)}
                tone={data.dataQuality.missingLocationCount ? "warn" : "default"}
              />
              <StatCard
                icon={AlertTriangle}
                label="Unknown room"
                value={formatWhole(data.dataQuality.unknownRoomCount)}
                detail={formatHours(data.dataQuality.unknownRoomMinutes)}
                tone={data.dataQuality.unknownRoomCount ? "warn" : "default"}
              />
              <StatCard
                icon={AlertTriangle}
                label="Excluded statuses"
                value={formatWhole(data.dataQuality.excludedStatusCount)}
                detail={formatHours(data.dataQuality.excludedStatusMinutes)}
              />
              <StatCard
                icon={AlertTriangle}
                label="Overlap"
                value={formatHours(data.dataQuality.overlapMinutes)}
                detail="Can push utilization over 100%"
                tone={data.dataQuality.overlapMinutes ? "danger" : "default"}
              />
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}
