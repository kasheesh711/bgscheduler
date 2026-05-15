"use client";

import type { CSSProperties } from "react";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  CalendarDays,
  ChevronLeft,
  ChevronRight,
  Gauge,
  Layers3,
  type LucideIcon,
  RefreshCw,
  UsersRound,
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
import { addBangkokDays, bangkokWeekday, minuteToTimeLabel, weekdayName } from "@/lib/room-capacity/dates";
import type {
  RoomCapacityForecastResponse,
  RoomCapacityHeatmapCell,
  RoomCapacityMonthResponse,
  RoomCapacitySource,
  WeekendDemandCaptureReadiness,
  WeekendDemandCaptureReadinessReasonCode,
  WeekendDemandBreakpointResult,
  WeekendDemandSlotSummary,
} from "@/lib/room-capacity/types";

const SCENARIO_ORDER = ["Base", "Bear", "Bull"];

function formatRatio(value: number): string {
  return `${Math.round(value * 100)}%`;
}

function formatDate(date: string): string {
  const parsed = new Date(`${date}T00:00:00+07:00`);
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Bangkok",
    day: "numeric",
    month: "short",
  }).format(parsed);
}

function formatDateLong(date: string | null): string {
  if (!date) return "-";
  const parsed = new Date(`${date}T00:00:00+07:00`);
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Bangkok",
    weekday: "short",
    day: "numeric",
    month: "short",
    year: "numeric",
  }).format(parsed);
}

function formatMonth(date: string | null): string {
  if (!date) return "-";
  const parsed = new Date(`${date}T00:00:00+07:00`);
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Bangkok",
    month: "short",
    year: "numeric",
  }).format(parsed);
}

function formatCurrencyThb(value: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "THB",
    maximumFractionDigits: 0,
  }).format(value);
}

function formatPercentDecimal(value: number): string {
  return `${Math.round(value * 100)}%`;
}

function ratioColor(loadRatio: number): string {
  if (loadRatio > 1) return "bg-conflict text-white";
  if (loadRatio >= 0.85) return "bg-blocked text-amber-950";
  if (loadRatio >= 0.55) return "bg-sky-500 text-white";
  if (loadRatio > 0) return "bg-available text-white";
  return "bg-muted text-muted-foreground";
}

function cellStyle(loadRatio: number): CSSProperties {
  if (loadRatio > 1) return { backgroundColor: "var(--conflict)", opacity: 0.95 };
  if (loadRatio >= 0.85) return { backgroundColor: "var(--blocked)", opacity: 0.9 };
  if (loadRatio >= 0.55) return { backgroundColor: "oklch(0.68 0.14 230)", opacity: 0.85 };
  if (loadRatio > 0) return { backgroundColor: "var(--available)", opacity: 0.65 };
  return { backgroundColor: "var(--muted)", opacity: 0.45 };
}

function StatCard({
  icon: Icon,
  label,
  value,
  tone = "default",
}: {
  icon: LucideIcon;
  label: string;
  value: string;
  tone?: "default" | "warn" | "danger";
}) {
  return (
    <div className="rounded-lg border bg-card px-4 py-3">
      <div className="flex items-center justify-between gap-3">
        <div className="text-xs font-medium text-muted-foreground">{label}</div>
        <Icon
          className={`size-4 ${
            tone === "danger" ? "text-conflict" : tone === "warn" ? "text-amber-600" : "text-primary"
          }`}
        />
      </div>
      <div className="mt-2 text-2xl font-semibold tracking-tight">{value}</div>
    </div>
  );
}

function currentWeekDates(range: RoomCapacityMonthResponse["range"], offset: number): string[] {
  const allDates: string[] = [];
  for (let date = range.startDate; date <= range.endDate; date = addBangkokDays(date, 1)) {
    allDates.push(date);
  }
  return allDates.slice(offset * 7, offset * 7 + 7);
}

export function WeeklyHeatmap({
  data,
  source,
  weekOffset,
  onWeekOffsetChange,
}: {
  data: RoomCapacityMonthResponse;
  source: RoomCapacitySource;
  weekOffset: number;
  onWeekOffsetChange: (value: number) => void;
}) {
  const dates = currentWeekDates(data.range, weekOffset);
  const cells = source === "current" ? data.current.heatmapCells : data.projected.heatmapCells;
  const minutes = Array.from({ length: 28 }, (_, index) => 7 * 60 + index * 30);
  const maxWeekOffset = Math.floor((data.current.daySummaries.length - 1) / 7);

  function peakFor(date: string, startMinute: number): RoomCapacityHeatmapCell | null {
    return cells
      .filter((cell) => cell.date === date && cell.startMinute === startMinute)
      .reduce<RoomCapacityHeatmapCell | null>((best, cell) => (!best || cell.loadRatio > best.loadRatio ? cell : best), null);
  }

  return (
    <section className="flex min-h-0 flex-col rounded-lg border bg-card">
      <div className="flex items-center justify-between gap-3 border-b px-4 py-3">
        <div>
          <h2 className="text-sm font-semibold">Weekly heatmap</h2>
          <p className="text-xs text-muted-foreground">Peak room load by 30-minute bin</p>
        </div>
        <div className="flex items-center gap-1">
          <Button
            type="button"
            size="icon"
            variant="ghost"
            className="size-8"
            onClick={() => onWeekOffsetChange(Math.max(0, weekOffset - 1))}
            disabled={weekOffset === 0}
          >
            <ChevronLeft className="size-4" />
          </Button>
          <Button
            type="button"
            size="icon"
            variant="ghost"
            className="size-8"
            onClick={() => onWeekOffsetChange(Math.min(maxWeekOffset, weekOffset + 1))}
            disabled={weekOffset >= maxWeekOffset}
          >
            <ChevronRight className="size-4" />
          </Button>
        </div>
      </div>
      <div className="min-h-0 overflow-auto p-3">
        <div className="grid min-w-[760px] gap-1" style={{ gridTemplateColumns: "56px repeat(7, minmax(88px, 1fr))" }}>
          <div />
          {dates.map((date) => (
            <div key={date} className="rounded-md bg-muted/50 px-2 py-1 text-center text-xs font-medium">
              {weekdayName(bangkokWeekday(date)).slice(0, 3)} {formatDate(date)}
            </div>
          ))}
          {minutes.map((minute) => (
            <div key={minute} className="contents">
              <div className="pr-1 text-right font-mono text-[11px] text-muted-foreground">
                {minuteToTimeLabel(minute)}
              </div>
              {dates.map((date) => {
                const peak = peakFor(date, minute);
                return (
                  <div
                    key={`${date}-${minute}`}
                    className="h-5 rounded-[3px] border border-background"
                    style={cellStyle(peak?.loadRatio ?? 0)}
                    title={peak ? `${date} ${minuteToTimeLabel(minute)} ${peak.load}/${peak.capacity}` : `${date} ${minuteToTimeLabel(minute)}`}
                  />
                );
              })}
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

export function MonthlyHeatmap({ data, source }: { data: RoomCapacityMonthResponse; source: RoomCapacitySource }) {
  const summaries = source === "current" ? data.current.daySummaries : data.projected.daySummaries;
  return (
    <section className="rounded-lg border bg-card">
      <div className="border-b px-4 py-3">
        <h2 className="text-sm font-semibold">Monthly heatmap</h2>
        <p className="text-xs text-muted-foreground">Peak room pressure from today through month end</p>
      </div>
      <div className="grid grid-cols-2 gap-2 p-3 sm:grid-cols-3 xl:grid-cols-5">
        {summaries.map((summary) => (
          <div key={summary.date} className="rounded-md border bg-background p-3">
            <div className="flex items-center justify-between gap-2">
              <div>
                <div className="text-xs font-medium">{formatDate(summary.date)}</div>
                <div className="text-[11px] text-muted-foreground">{weekdayName(summary.weekday)}</div>
              </div>
              <Badge className={ratioColor(summary.peakLoadRatio)}>{formatRatio(summary.peakLoadRatio)}</Badge>
            </div>
            <div className="mt-3 grid grid-cols-3 gap-2 text-center text-[11px]">
              <div>
                <div className="font-semibold">{summary.totalSessions}</div>
                <div className="text-muted-foreground">classes</div>
              </div>
              <div>
                <div className="font-semibold text-conflict">{summary.overcapIntervals}</div>
                <div className="text-muted-foreground">overcap</div>
              </div>
              <div>
                <div className="font-semibold text-amber-700">{summary.projectedNoRoom}</div>
                <div className="text-muted-foreground">no room</div>
              </div>
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

export function OvercapTable({ data }: { data: RoomCapacityMonthResponse }) {
  const rows = data.current.overcaps;
  return (
    <section className="min-h-0 rounded-lg border bg-card">
      <div className="flex items-center justify-between gap-3 border-b px-4 py-3">
        <div>
          <h2 className="text-sm font-semibold">Current Wise overcaps</h2>
          <p className="text-xs text-muted-foreground">Tutor and class/title only</p>
        </div>
        <Badge variant={rows.length ? "destructive" : "secondary"}>{rows.length}</Badge>
      </div>
      <div className="max-h-[360px] overflow-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Date</TableHead>
              <TableHead>Room</TableHead>
              <TableHead>Time</TableHead>
              <TableHead>Load</TableHead>
              <TableHead>Tutors</TableHead>
              <TableHead>Classes</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.length === 0 ? (
              <TableRow>
                <TableCell colSpan={6} className="h-20 text-center text-sm text-muted-foreground">
                  No current room overcaps in this range.
                </TableCell>
              </TableRow>
            ) : (
              rows.map((row) => (
                <TableRow key={row.id}>
                  <TableCell className="whitespace-nowrap">{formatDate(row.date)}</TableCell>
                  <TableCell className="font-medium">{row.roomName}</TableCell>
                  <TableCell className="font-mono text-xs">
                    {minuteToTimeLabel(row.startMinute)}-{minuteToTimeLabel(row.endMinute)}
                  </TableCell>
                  <TableCell>
                    <Badge variant="destructive">{row.load}/{row.capacity}</Badge>
                  </TableCell>
                  <TableCell className="max-w-[220px] truncate" title={row.tutors.join(", ")}>
                    {row.tutors.join(", ")}
                  </TableCell>
                  <TableCell className="max-w-[280px] truncate" title={row.classes.join(", ")}>
                    {row.classes.join(", ")}
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>
    </section>
  );
}

export function NoRoomTable({ data }: { data: RoomCapacityMonthResponse }) {
  const rows = data.projected.noRoomRows;
  return (
    <section className="min-h-0 rounded-lg border bg-card">
      <div className="flex items-center justify-between gap-3 border-b px-4 py-3">
        <div>
          <h2 className="text-sm font-semibold">Projected no-room classes</h2>
          <p className="text-xs text-muted-foreground">Assignment engine projection, not saved</p>
        </div>
        <Badge variant={rows.length ? "destructive" : "secondary"}>{rows.length}</Badge>
      </div>
      <div className="max-h-[360px] overflow-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Date</TableHead>
              <TableHead>Time</TableHead>
              <TableHead>Tutor</TableHead>
              <TableHead>Class</TableHead>
              <TableHead>Warnings</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.length === 0 ? (
              <TableRow>
                <TableCell colSpan={5} className="h-20 text-center text-sm text-muted-foreground">
                  Assignment projection found a room for every center-required class.
                </TableCell>
              </TableRow>
            ) : (
              rows.map((row) => (
                <TableRow key={row.id}>
                  <TableCell className="whitespace-nowrap">{formatDate(row.date)}</TableCell>
                  <TableCell className="font-mono text-xs">
                    {minuteToTimeLabel(row.startMinute)}-{minuteToTimeLabel(row.endMinute)}
                  </TableCell>
                  <TableCell className="font-medium">{row.tutorDisplayName}</TableCell>
                  <TableCell className="max-w-[260px] truncate" title={row.classLabel}>
                    {row.classLabel}
                  </TableCell>
                  <TableCell className="max-w-[220px] truncate" title={row.warnings.join(", ")}>
                    {row.warnings.join(", ") || "no_room_available"}
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>
    </section>
  );
}

function ForecastMetric({
  label,
  value,
  tone = "default",
}: {
  label: string;
  value: string;
  tone?: "default" | "danger" | "warn";
}) {
  return (
    <div className="rounded-md border bg-background p-3">
      <div className="text-xs font-medium text-muted-foreground">{label}</div>
      <div className={`mt-2 text-xl font-semibold ${tone === "danger" ? "text-conflict" : tone === "warn" ? "text-amber-700" : ""}`}>
        {value}
      </div>
    </div>
  );
}

const READINESS_MESSAGES: Record<WeekendDemandCaptureReadinessReasonCode, string> = {
  missing_package_mix: "Package mix rows are missing. Re-run the room-capacity model import from the salesrecord workbooks.",
  missing_scenario_drivers: "No forecast drivers exist for the selected scenario.",
  no_active_physical_rooms: "No active physical rooms are available for the weekend capture simulation.",
  missing_seed_sessions: "No current Wise/projected schedule rows were loaded for the forecast window.",
  no_weekend_onsite_schedule: "No Saturday/Sunday onsite schedule frequency was found in the current Wise/projected schedule.",
  zero_weekend_preference_distribution: "Weekend schedule rows were found, but the weighted preference distribution is zero.",
};

function ModelInputsRow({ readiness }: { readiness: WeekendDemandCaptureReadiness | null | undefined }) {
  if (!readiness) return null;
  return (
    <div className="rounded-md border bg-background p-3 text-xs">
      <div className="font-semibold">Model inputs</div>
      <div className="mt-2 grid gap-2 md:grid-cols-4">
        <div>
          <div className="text-muted-foreground">Package mix rows</div>
          <div className="font-semibold">{readiness.packageMixRows}</div>
        </div>
        <div>
          <div className="text-muted-foreground">Weekend buckets</div>
          <div className="font-semibold">{readiness.weekendPreferenceBuckets}</div>
        </div>
        <div>
          <div className="text-muted-foreground">Weekend onsite rows</div>
          <div className="font-semibold">{readiness.weekendOnsiteSessionRows}</div>
        </div>
        <div>
          <div className="text-muted-foreground">Weekend demand share</div>
          <div className="font-semibold">{formatPercentDecimal(readiness.weekendDemandShare)}</div>
        </div>
      </div>
    </div>
  );
}

function ReadinessFallback({ readiness }: { readiness: WeekendDemandCaptureReadiness | null | undefined }) {
  const reasonCodes = readiness?.reasonCodes ?? [];
  return (
    <div className="space-y-3 p-4 text-sm">
      <div>
        <div className="font-semibold">Weekend demand capture is not ready</div>
        <div className="mt-1 text-muted-foreground">
          The forecast needs package mix, scenario drivers, active physical rooms, and Saturday/Sunday onsite schedule frequency.
        </div>
      </div>
      {reasonCodes.length > 0 ? (
        <div className="rounded-md border bg-background">
          {reasonCodes.map((code) => (
            <div key={code} className="border-b px-3 py-2 last:border-b-0">
              {READINESS_MESSAGES[code]}
            </div>
          ))}
        </div>
      ) : (
        <div className="rounded-md border bg-background px-3 py-2 text-muted-foreground">
          No readiness details were returned by the forecast API.
        </div>
      )}
      <ModelInputsRow readiness={readiness} />
    </div>
  );
}

function SlotList({ title, rows, empty }: { title: string; rows: WeekendDemandSlotSummary[]; empty: string }) {
  return (
    <div className="rounded-md border bg-background">
      <div className="border-b px-3 py-2 text-xs font-semibold">{title}</div>
      {rows.length === 0 ? (
        <div className="px-3 py-5 text-center text-xs text-muted-foreground">{empty}</div>
      ) : (
        <div className="divide-y">
          {rows.slice(0, 5).map((row) => (
            <div key={`${row.weekday}-${row.startMinute}-${row.endMinute}`} className="grid grid-cols-[1fr_auto] gap-3 px-3 py-2 text-xs">
              <div>
                <div className="font-medium">{row.label}</div>
                <div className="text-muted-foreground">
                  {row.lostStudents > 0
                    ? `${row.lostStudents} lost students`
                    : `${row.remainingOpenCapacityMinutes ?? 0} open capacity-min`}
                </div>
              </div>
              <div className="text-right font-semibold">
                {row.lostRevenueThb > 0 ? formatCurrencyThb(row.lostRevenueThb) : `${row.remainingOpenCapacityMinutes ?? 0}`}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function DayBreakpointCard({ result }: { result: WeekendDemandBreakpointResult }) {
  return (
    <div className="rounded-md border bg-background p-3">
      <div className="flex items-center justify-between gap-2">
        <div className="text-sm font-semibold">{result.weekdayName ?? "Weekend"}</div>
        <Badge variant={result.status === "reached" ? "destructive" : result.status === "reached_extrapolated" ? "secondary" : "outline"}>
          {result.status === "reached_extrapolated" ? "extrapolated" : result.status.replace("_", " ")}
        </Badge>
      </div>
      <div className="mt-3 grid grid-cols-2 gap-2 text-xs">
        <div>
          <div className="text-muted-foreground">Breakpoint</div>
          <div className="font-medium">{formatMonth(result.breakpointMonth)}</div>
        </div>
        <div>
          <div className="text-muted-foreground">Lost demand</div>
          <div className="font-medium text-conflict">{formatPercentDecimal(result.lostRevenuePct)}</div>
        </div>
        <div>
          <div className="text-muted-foreground">Captured</div>
          <div className="font-medium">{formatCurrencyThb(result.capturedRevenueThb)}</div>
        </div>
        <div>
          <div className="text-muted-foreground">Lost</div>
          <div className="font-medium text-conflict">{formatCurrencyThb(result.lostRevenueThb)}</div>
        </div>
      </div>
    </div>
  );
}

export function ForecastPanel({
  forecast,
  scenario,
  onScenarioChange,
}: {
  forecast: RoomCapacityForecastResponse | null;
  scenario: string;
  onScenarioChange: (scenario: string) => void;
}) {
  const availableScenarios = forecast?.scenarios.length ? forecast.scenarios : SCENARIO_ORDER;
  const breakpoint = forecast?.weekendDemandBreakpoint;
  const readiness = forecast?.weekendDemandCaptureReadiness;
  const combined = breakpoint?.combined;
  return (
    <section className="rounded-lg border bg-card">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b px-4 py-3">
        <div>
          <h2 className="text-sm font-semibold">Weekend demand capture</h2>
          <p className="text-xs text-muted-foreground">
            Revenue lost when preferred Saturday/Sunday slots cannot be fulfilled exactly
          </p>
        </div>
        <div className="flex items-center gap-1">
          {availableScenarios.map((item) => (
            <Button
              key={item}
              type="button"
              variant={scenario === item ? "default" : "outline"}
              size="sm"
              onClick={() => onScenarioChange(item)}
            >
              {item}
            </Button>
          ))}
        </div>
      </div>
      {forecast?.model.status === "missing" ? (
        <div className="p-4 text-sm text-muted-foreground">
          Forecast aggregates have not been imported yet. Import a projection JSON with
          <span className="font-mono"> scripts/import-room-capacity-model.ts</span>.
        </div>
      ) : !breakpoint || !combined ? (
        <ReadinessFallback readiness={readiness} />
      ) : (
        <div className="space-y-3 p-3">
          <ModelInputsRow readiness={readiness} />
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-5">
            <ForecastMetric label="Breakpoint month" value={formatMonth(combined.breakpointMonth)} tone={combined.status === "reached" ? "danger" : "warn"} />
            <ForecastMetric label="Lost demand" value={formatPercentDecimal(combined.lostRevenuePct)} tone={combined.lostRevenuePct > 0.5 ? "danger" : "default"} />
            <ForecastMetric label="Captured revenue" value={formatCurrencyThb(combined.capturedRevenueThb)} />
            <ForecastMetric label="Lost revenue" value={formatCurrencyThb(combined.lostRevenueThb)} tone={combined.lostRevenueThb > 0 ? "danger" : "default"} />
            <ForecastMetric label="Open capacity-min" value={String(combined.remainingOpenCapacityMinutes)} />
          </div>
          <div className="grid gap-3 lg:grid-cols-2">
            {(breakpoint.byDay ?? []).map((result) => (
              <DayBreakpointCard key={result.weekdayName ?? result.breakpointMonth ?? result.status} result={result} />
            ))}
          </div>
          <div className="grid gap-3 lg:grid-cols-2">
            <SlotList
              title="Preferred slots losing the most revenue"
              rows={combined.topLostPreferredSlots}
              empty="No lost preferred slots in the reported month."
            />
            <SlotList
              title="Open capacity not captured"
              rows={combined.topOpenNonCapturedSlots}
              empty="No unmatched open weekend capacity in the reported month."
            />
          </div>
          <div className="rounded-md border bg-background p-3 text-xs text-muted-foreground">
            Monthly heatmap percentage is peak room pressure in an occupied 30-minute bin. Weekend breakpoint is the month when preferred-slot revenue lost is greater than preferred-slot revenue captured.
          </div>
          <div className="grid gap-2 md:grid-cols-2 xl:grid-cols-4">
            {(forecast?.weekdayResults ?? []).map((row) => (
              <div key={row.weekday} className="rounded-md border bg-background p-3">
                <div className="text-xs font-semibold">{row.weekdayName}</div>
                <div className="mt-2 flex items-center justify-between gap-2 text-[11px]">
                  <span className="text-muted-foreground">Room slot full</span>
                  <span className="font-medium">{formatDateLong(row.roomSlotFullDate)}</span>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </section>
  );
}

export function RoomCapacityDashboard() {
  const [monthData, setMonthData] = useState<RoomCapacityMonthResponse | null>(null);
  const [forecast, setForecast] = useState<RoomCapacityForecastResponse | null>(null);
  const [source, setSource] = useState<RoomCapacitySource>("current");
  const [scenario, setScenario] = useState("Base");
  const [weekOffset, setWeekOffset] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const loadMonth = useCallback(async () => {
    setError(null);
    const response = await fetch("/api/room-capacity/month");
    const body = await response.json();
    if (!response.ok) throw new Error(body.error ?? `HTTP ${response.status}`);
    setMonthData(body as RoomCapacityMonthResponse);
  }, []);

  const loadForecast = useCallback(async (targetScenario: string) => {
    const response = await fetch(`/api/room-capacity/forecast?scenario=${encodeURIComponent(targetScenario)}`);
    const body = await response.json();
    if (!response.ok) throw new Error(body.error ?? `HTTP ${response.status}`);
    setForecast(body as RoomCapacityForecastResponse);
    setScenario((body as RoomCapacityForecastResponse).scenario || targetScenario);
  }, []);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      await Promise.all([loadMonth(), loadForecast(scenario)]);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load room capacity");
    } finally {
      setLoading(false);
    }
  }, [loadForecast, loadMonth, scenario]);

  useEffect(() => {
    void refresh();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!loading) void loadForecast(scenario).catch((err) => setError(err instanceof Error ? err.message : "Failed to load forecast"));
  }, [scenario]); // eslint-disable-line react-hooks/exhaustive-deps

  const weekendBreakpointMonth = useMemo(() => {
    return forecast?.weekendDemandBreakpoint?.combined.breakpointMonth ?? null;
  }, [forecast]);

  if (loading && !monthData) {
    return (
      <div className="flex min-h-0 flex-1 flex-col gap-4">
        <div className="h-16 animate-pulse rounded-lg bg-muted" />
        <div className="grid grid-cols-5 gap-3">
          {Array.from({ length: 5 }, (_, index) => (
            <div key={index} className="h-24 animate-pulse rounded-lg bg-muted" />
          ))}
        </div>
        <div className="grid min-h-0 flex-1 grid-cols-2 gap-4">
          <div className="animate-pulse rounded-lg bg-muted" />
          <div className="animate-pulse rounded-lg bg-muted" />
        </div>
      </div>
    );
  }

  if (error || !monthData) {
    return (
      <div className="rounded-lg border bg-card p-6">
        <div className="text-sm font-semibold text-conflict">Room capacity failed to load</div>
        <div className="mt-2 text-sm text-muted-foreground">{error ?? "No data returned"}</div>
        <Button type="button" className="mt-4" onClick={() => void refresh()}>
          Retry
        </Button>
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-hidden">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Room Capacity</h1>
          <div className="mt-1 flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
            <CalendarDays className="size-4" />
            <span>{formatDateLong(monthData.range.startDate)} to {formatDateLong(monthData.range.endDate)}</span>
            <span>Snapshot {monthData.snapshotMeta.snapshotId.slice(0, 8)}</span>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <div className="flex rounded-md border bg-card p-1">
            {(["current", "projected"] as const).map((item) => (
              <Button
                key={item}
                type="button"
                size="sm"
                variant={source === item ? "default" : "ghost"}
                onClick={() => setSource(item)}
                className="h-8 capitalize"
              >
                {item}
              </Button>
            ))}
          </div>
          <Button type="button" variant="outline" size="sm" onClick={() => void refresh()}>
            <RefreshCw className="mr-2 size-4" />
            Refresh
          </Button>
        </div>
      </div>

      <div className="grid gap-3 md:grid-cols-5">
        <StatCard icon={AlertTriangle} label="Current overcaps" value={String(monthData.kpis.currentOvercapIntervals)} tone={monthData.kpis.currentOvercapIntervals ? "danger" : "default"} />
        <StatCard icon={Layers3} label="Impacted rooms" value={String(monthData.kpis.impactedRooms)} tone={monthData.kpis.impactedRooms ? "warn" : "default"} />
        <StatCard icon={UsersRound} label="Projected no-room" value={String(monthData.kpis.projectedNoRoomSessions)} tone={monthData.kpis.projectedNoRoomSessions ? "danger" : "default"} />
        <StatCard icon={Gauge} label="Peak current load" value={formatRatio(monthData.kpis.peakLoadRatio)} tone={monthData.kpis.peakLoadRatio > 1 ? "danger" : "default"} />
        <StatCard icon={CalendarDays} label="Weekend breakpoint" value={weekendBreakpointMonth ? formatMonth(weekendBreakpointMonth) : "-"} tone={weekendBreakpointMonth ? "warn" : "default"} />
      </div>

      <div className="min-h-0 flex-1 overflow-auto">
        <div className="grid gap-4 xl:grid-cols-[1.25fr_0.75fr]">
          <WeeklyHeatmap data={monthData} source={source} weekOffset={weekOffset} onWeekOffsetChange={setWeekOffset} />
          <MonthlyHeatmap data={monthData} source={source} />
          <OvercapTable data={monthData} />
          <NoRoomTable data={monthData} />
          <div className="xl:col-span-2">
            <ForecastPanel forecast={forecast} scenario={scenario} onScenarioChange={setScenario} />
          </div>
        </div>
      </div>
    </div>
  );
}
