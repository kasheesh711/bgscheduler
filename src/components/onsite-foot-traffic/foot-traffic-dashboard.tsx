"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import {
  AlertTriangle,
  CalendarDays,
  CheckCircle2,
  Download,
  FileChartColumn,
  RefreshCw,
  Users,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import type {
  FootTrafficBreakdownRow,
  FootTrafficDashboardPayload,
  FootTrafficPeriodRow,
} from "@/lib/onsite-foot-traffic/types";

const RESEARCH_START = "2026-03-01";
const RESEARCH_END = "2026-09-30";
const WEEKDAYS = [
  { value: 1, short: "Mon" }, { value: 2, short: "Tue" }, { value: 3, short: "Wed" },
  { value: 4, short: "Thu" }, { value: 5, short: "Fri" }, { value: 6, short: "Sat" },
  { value: 0, short: "Sun" },
];

interface ReportLinks {
  reportId: string;
  htmlUrl: string;
  pdfUrl: string;
  expiresAt: string;
}

function formatNumber(value: number, digits = 0): string {
  return value.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Bangkok",
    day: "numeric",
    month: "short",
    year: "numeric",
  }).format(new Date(`${value}T00:00:00+07:00`));
}

function formatDateTime(value: string | null): string {
  if (!value) return "Not yet synced";
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Bangkok",
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

export function isStale(value: string | null, now = Date.now()): boolean {
  return !value || now - new Date(value).getTime() > 36 * 60 * 60 * 1_000;
}

export function KpiCard({ label, value, detail, primary = false }: {
  label: string;
  value: string;
  detail: string;
  primary?: boolean;
}) {
  return (
    <div className={`rounded-xl border px-4 py-4 shadow-begifted-sm ${primary ? "border-begifted-orange-200 bg-begifted-orange-50" : "border-begifted-neutral-200 bg-white"}`}>
      <div className={`h-1 w-10 rounded-full ${primary ? "bg-begifted-orange-500" : "bg-[#126DCE]"}`} />
      <div className="digits mt-3 text-3xl font-semibold tracking-tight text-begifted-neutral-900">{value}</div>
      <div className="mt-1 text-sm font-semibold text-begifted-neutral-800">{label}</div>
      <div className="mt-1 text-xs text-begifted-neutral-500">{detail}</div>
    </div>
  );
}

export function WeeklyVisitsChart({ rows }: { rows: FootTrafficPeriodRow[] }) {
  if (!rows.length) return <ChartEmpty />;
  const width = Math.max(820, rows.length * 54);
  const height = 270;
  const left = 45;
  const right = 24;
  const top = 32;
  const bottom = 52;
  const usableWidth = width - left - right;
  const usableHeight = height - top - bottom;
  const max = Math.max(1, ...rows.map((row) => row.studentVisits));
  const x = (index: number) => left + (rows.length === 1 ? usableWidth / 2 : index * usableWidth / (rows.length - 1));
  const y = (value: number) => top + usableHeight - value / max * usableHeight;
  const points = rows.map((row, index) => `${x(index)},${y(row.studentVisits)}`).join(" ");
  return (
    <div className="overflow-x-auto" tabIndex={0} aria-label="Scrollable weekly foot-traffic chart">
      <svg className="h-[270px]" style={{ minWidth: width }} viewBox={`0 0 ${width} ${height}`} role="img" aria-labelledby="weekly-chart-title weekly-chart-desc">
        <title id="weekly-chart-title">Weekly student visits</title>
        <desc id="weekly-chart-desc">Monday through Sunday student-visit totals. Every orange point is directly labelled, and partial boundary weeks are noted with an asterisk.</desc>
        {[0, .25, .5, .75, 1].map((ratio) => {
          const gridY = top + usableHeight - ratio * usableHeight;
          return <g key={ratio}><line x1={left} y1={gridY} x2={width - right} y2={gridY} stroke="#DFE5EC" /><text x={left - 8} y={gridY + 4} textAnchor="end" className="fill-begifted-neutral-500 text-[10px]">{Math.round(max * ratio)}</text></g>;
        })}
        <polyline points={points} fill="none" stroke="#126DCE" strokeWidth="3" strokeLinejoin="round" strokeLinecap="round" />
        {rows.map((row, index) => (
          <g key={row.key}>
            <circle cx={x(index)} cy={y(row.studentVisits)} r="4.5" fill="#FF7518"><title>{`${row.label}: ${row.studentVisits} visits`}</title></circle>
            <text x={x(index)} y={Math.max(13, y(row.studentVisits) - 9)} textAnchor="middle" className="fill-begifted-orange-600 text-[10px] font-semibold">{row.studentVisits}</text>
            <text x={x(index)} y={height - 22} textAnchor="middle" className="fill-begifted-neutral-500 text-[10px]">{row.periodStart.slice(5)}{row.isPartial ? "*" : ""}</text>
          </g>
        ))}
      </svg>
    </div>
  );
}

export function MonthlyVisitsChart({ rows, septemberMtd }: { rows: FootTrafficPeriodRow[]; septemberMtd: boolean }) {
  if (!rows.length) return <ChartEmpty />;
  const width = 800;
  const height = 285;
  const left = 42;
  const right = 24;
  const top = 28;
  const bottom = 54;
  const usableHeight = height - top - bottom;
  const gap = 22;
  const barWidth = (width - left - right - gap * (rows.length + 1)) / rows.length;
  const max = Math.max(1, ...rows.map((row) => row.studentVisits));
  return (
    <div className="overflow-x-auto" tabIndex={0} aria-label="Scrollable monthly foot-traffic chart">
      <svg className="min-w-[720px]" viewBox={`0 0 ${width} ${height}`} role="img" aria-labelledby="monthly-chart-title monthly-chart-desc">
        <title id="monthly-chart-title">Monthly student visits</title>
        <desc id="monthly-chart-desc">March through September student-visit totals. Orange bars are directly labelled. Partial periods are marked with an asterisk.</desc>
        <line x1={left} y1={top + usableHeight} x2={width - right} y2={top + usableHeight} stroke="#A6B2C2" />
        {rows.map((row, index) => {
          const barHeight = row.studentVisits / max * usableHeight;
          const x = left + gap + index * (barWidth + gap);
          const y = top + usableHeight - barHeight;
          const label = row.label.replace(/ 2026$/, "");
          const partial = row.isPartial || (septemberMtd && row.key === "2026-09");
          return <g key={row.key}><rect x={x} y={y} width={barWidth} height={barHeight} rx="5" fill="#FF7518"><title>{`${row.label}: ${row.studentVisits} visits`}</title></rect><text x={x + barWidth / 2} y={Math.max(15, y - 8)} textAnchor="middle" className="fill-begifted-orange-600 text-[12px] font-semibold">{row.studentVisits}</text><text x={x + barWidth / 2} y={height - 23} textAnchor="middle" className="fill-begifted-neutral-600 text-[11px]">{label}{partial ? "*" : ""}</text></g>;
        })}
      </svg>
    </div>
  );
}

export function BreakdownChart({ rows, label }: { rows: FootTrafficBreakdownRow[]; label: string }) {
  if (!rows.length) return <ChartEmpty />;
  const visible = rows.slice(0, 16);
  const width = 800;
  const labelWidth = 155;
  const usableWidth = width - labelWidth - 70;
  const rowHeight = 30;
  const height = visible.length * rowHeight + 14;
  const max = Math.max(1, ...visible.map((row) => row.studentVisits));
  return (
    <div className="overflow-x-auto" tabIndex={0} aria-label={`Scrollable ${label.toLowerCase()} foot-traffic chart`}>
      <svg className="min-w-[720px]" viewBox={`0 0 ${width} ${height}`} role="img" aria-label={`Student visits by ${label.toLowerCase()}, directly labelled`}>
        {visible.map((row, index) => {
          const y = index * rowHeight + 4;
          const barWidth = row.studentVisits / max * usableWidth;
          return <g key={row.key}><text x={labelWidth - 10} y={y + 16} textAnchor="end" className="fill-begifted-neutral-800 text-[11px]">{row.label}</text><rect x={labelWidth} y={y} width={Math.max(1, barWidth)} height="20" rx="4" fill="#126DCE" /><circle cx={labelWidth + barWidth} cy={y + 10} r="5" fill="#FF7518" /><text x={labelWidth + barWidth + 11} y={y + 15} className="fill-begifted-orange-600 text-[11px] font-semibold">{row.studentVisits}</text></g>;
        })}
      </svg>
    </div>
  );
}

function ChartEmpty() {
  return <div className="rounded-lg border border-dashed border-begifted-neutral-300 px-4 py-12 text-center text-sm text-begifted-neutral-500">No qualifying observations for these filters.</div>;
}

export function MetricTable({ rows, monthly = false }: { rows: FootTrafficPeriodRow[]; monthly?: boolean }) {
  return (
    <div className="max-h-[390px] overflow-auto border-t border-begifted-neutral-200">
      <table className="w-full min-w-[740px] border-collapse text-sm">
        <thead className="sticky top-0 bg-begifted-neutral-900 text-white"><tr><th className="px-3 py-2 text-left">Period</th><th className="px-3 py-2 text-left">Boundaries</th><th className="px-3 py-2 text-right">Visits</th><th className="px-3 py-2 text-right">Unique</th><th className="px-3 py-2 text-right">Classes</th><th className="px-3 py-2 text-right">Visits/class</th></tr></thead>
        <tbody>{rows.map((row) => <tr key={row.key} className="border-b border-begifted-neutral-200 even:bg-begifted-neutral-50"><td className="px-3 py-2 font-medium text-begifted-neutral-900">{row.label}{row.isPartial ? <span className="ml-2 rounded-full bg-begifted-orange-50 px-2 py-0.5 text-[10px] font-semibold uppercase text-begifted-orange-600">{monthly && row.key === "2026-09" ? "MTD" : "Partial"}</span> : null}</td><td className="digits px-3 py-2 text-xs text-begifted-neutral-500">{row.periodStart} – {row.periodEnd}</td><td className="digits px-3 py-2 text-right">{formatNumber(row.studentVisits)}</td><td className="digits px-3 py-2 text-right">{formatNumber(row.uniqueStudents)}</td><td className="digits px-3 py-2 text-right">{formatNumber(row.onsiteClasses)}</td><td className="digits px-3 py-2 text-right">{formatNumber(row.averageVisitsPerClass, 2)}</td></tr>)}</tbody>
      </table>
    </div>
  );
}

export function BreakdownTable({ rows, label }: { rows: FootTrafficBreakdownRow[]; label: string }) {
  return (
    <div className="max-h-[390px] overflow-auto border-t border-begifted-neutral-200">
      <table className="w-full min-w-[620px] border-collapse text-sm"><thead className="sticky top-0 bg-begifted-neutral-900 text-white"><tr><th className="px-3 py-2 text-left">{label}</th><th className="px-3 py-2 text-right">Visits</th><th className="px-3 py-2 text-right">Unique</th><th className="px-3 py-2 text-right">Classes</th><th className="px-3 py-2 text-right">Visits/class</th></tr></thead><tbody>{rows.map((row) => <tr key={row.key} className="border-b border-begifted-neutral-200 even:bg-begifted-neutral-50"><td className="px-3 py-2 font-medium text-begifted-neutral-900">{row.label}</td><td className="digits px-3 py-2 text-right">{formatNumber(row.studentVisits)}</td><td className="digits px-3 py-2 text-right">{formatNumber(row.uniqueStudents)}</td><td className="digits px-3 py-2 text-right">{formatNumber(row.onsiteClasses)}</td><td className="digits px-3 py-2 text-right">{formatNumber(row.averageVisitsPerClass, 2)}</td></tr>)}</tbody></table>
    </div>
  );
}

function ChartSection({ title, subtitle, chart, table, badge }: { title: string; subtitle: string; chart: React.ReactNode; table: React.ReactNode; badge?: string }) {
  return <section className="overflow-hidden rounded-xl border border-begifted-neutral-200 bg-white shadow-begifted-sm"><div className="flex flex-wrap items-start justify-between gap-3 border-b border-begifted-neutral-200 px-4 py-3"><div><h2 className="begifted-display text-2xl">{title}</h2><p className="mt-1 text-sm text-begifted-neutral-500">{subtitle}</p></div>{badge ? <span className="rounded-full bg-begifted-orange-50 px-3 py-1 text-xs font-semibold text-begifted-orange-600">{badge}</span> : null}</div><div className="p-4">{chart}</div>{table}</section>;
}

export function filtersFromSearchParams(searchParams: URLSearchParams) {
  const tokens = (names: string[]) => names
    .flatMap((name) => searchParams.getAll(name))
    .flatMap((value) => value.split(","))
    .map((value) => value.trim())
    .filter(Boolean);
  const rooms = [...new Set(tokens(["room", "rooms"]))];
  const weekdays = [...new Set(tokens(["weekday", "weekdays"]).map(Number))].sort((a, b) => a - b);
  return {
    startDate: searchParams.get("startDate") ?? RESEARCH_START,
    endDate: searchParams.get("endDate") ?? RESEARCH_END,
    rooms,
    weekdays,
  };
}

export function withGrain(query: string, grain: string): string {
  const params = new URLSearchParams(query);
  params.set("grain", grain);
  return `/api/onsite-foot-traffic/export?${params.toString()}`;
}

export function DashboardErrorState({ error, onRetry }: { error: string; onRetry: () => void }) {
  return <div className="begifted rounded-xl border border-red-200 bg-white p-8"><h1 className="begifted-display text-3xl">Foot traffic unavailable</h1><p className="mt-3 text-sm text-red-700">{error}</p><Button className="mt-5" onClick={onRetry}>Retry</Button></div>;
}

export function FootTrafficDashboard() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const query = searchParams.toString();
  const currentFilters = useMemo(() => filtersFromSearchParams(new URLSearchParams(query)), [query]);
  const [startDate, setStartDate] = useState(currentFilters.startDate);
  const [endDate, setEndDate] = useState(currentFilters.endDate);
  const [room, setRoom] = useState(currentFilters.rooms[0] ?? "");
  const [weekdays, setWeekdays] = useState(currentFilters.weekdays);
  const [data, setData] = useState<FootTrafficDashboardPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reporting, setReporting] = useState(false);
  const [reportLinks, setReportLinks] = useState<ReportLinks | null>(null);

  useEffect(() => {
    setStartDate(currentFilters.startDate);
    setEndDate(currentFilters.endDate);
    setRoom(currentFilters.rooms[0] ?? "");
    setWeekdays(currentFilters.weekdays);
  }, [currentFilters]);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await fetch(`/api/onsite-foot-traffic${query ? `?${query}` : ""}`, { cache: "no-store" });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error ?? `HTTP ${response.status}`);
      setData(body as FootTrafficDashboardPayload);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Failed to load foot traffic");
    } finally {
      setLoading(false);
    }
  }, [query]);

  useEffect(() => { void load(); }, [load]);

  function applyFilters() {
    const params = new URLSearchParams();
    params.set("startDate", startDate);
    params.set("endDate", endDate);
    if (room) params.set("rooms", room);
    if (weekdays.length) params.set("weekdays", [...weekdays].sort((a, b) => a - b).join(","));
    router.replace(`${pathname}?${params.toString()}`);
    setReportLinks(null);
  }

  function toggleWeekday(value: number) {
    setWeekdays((selected) => selected.includes(value)
      ? selected.filter((item) => item !== value)
      : [...selected, value]);
  }

  async function generateReport() {
    setReporting(true);
    setError(null);
    try {
      const response = await fetch("/api/onsite-foot-traffic/reports", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          startDate: data?.meta.requestedStartDate ?? currentFilters.startDate,
          endDate: data?.meta.requestedEndDate ?? currentFilters.endDate,
          rooms: data?.meta.rooms ?? currentFilters.rooms,
          weekdays: data?.meta.weekdays ?? currentFilters.weekdays,
        }),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error ?? `HTTP ${response.status}`);
      setReportLinks(body as ReportLinks);
    } catch (reportError) {
      setError(reportError instanceof Error ? reportError.message : "Failed to generate report");
    } finally {
      setReporting(false);
    }
  }

  const exports = ["weekly", "monthly", "weekday", "room", "visits"];
  const qualityTotal = data ? data.dataQuality.unknownRoomSessions + data.dataQuality.missingLocationSessions + data.dataQuality.participantsWithoutAttendanceEvidence + data.dataQuality.unidentifiedVisits : 0;
  const stale = isStale(data?.meta.lastSuccessfulSyncAt ?? null);

  if (loading && !data) {
    return <div className="begifted flex flex-1 flex-col gap-4 overflow-hidden rounded-xl bg-white p-4"><div className="h-28 animate-pulse rounded-xl bg-begifted-neutral-100" /><div className="grid gap-3 md:grid-cols-4">{Array.from({ length: 4 }, (_, i) => <div key={i} className="h-28 animate-pulse rounded-xl bg-begifted-neutral-100" />)}</div><div className="h-80 animate-pulse rounded-xl bg-begifted-neutral-100" /></div>;
  }

  if (!data && error) {
    return <DashboardErrorState error={error} onRetry={() => void load()} />;
  }
  if (!data) return null;

  return (
    <div className="begifted flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl bg-begifted-neutral-50">
      <div className="min-h-0 flex-1 overflow-auto">
        <div className="mx-auto flex max-w-[1500px] flex-col gap-4 p-3 md:p-5">
          <header className="rounded-xl border border-begifted-neutral-200 bg-white px-5 py-5 shadow-begifted-sm">
            <div className="flex flex-wrap items-start justify-between gap-5">
              <div><div className="eyebrow">Onsite research · Wise actuals</div><h1 className="begifted-display mt-1 text-4xl md:text-5xl">Foot Traffic</h1><p className="mt-2 max-w-3xl text-sm text-begifted-neutral-600">A de-identified class-attendance proxy: one qualifying attended onsite class per student equals one student-visit.</p></div>
              <div className="flex flex-wrap gap-2"><Button type="button" variant="outline" onClick={() => void load()} disabled={loading}><RefreshCw className={`mr-2 size-4 ${loading ? "animate-spin" : ""}`} />Refresh</Button><Button type="button" onClick={() => void generateReport()} disabled={reporting}><FileChartColumn className="mr-2 size-4" />{reporting ? "Building…" : "Create analytics pack"}</Button></div>
            </div>
            <div className="mt-5 grid gap-3 rounded-lg border border-begifted-neutral-200 bg-begifted-neutral-50 p-3 lg:grid-cols-[1fr_1fr_1.4fr_1.25fr_auto]">
              <label className="text-xs font-semibold text-begifted-neutral-600">Start date<input className="digits mt-1 block h-9 w-full rounded-md border border-begifted-neutral-300 bg-white px-2 text-sm" type="date" value={startDate} min={RESEARCH_START} onChange={(event) => setStartDate(event.target.value)} /></label>
              <label className="text-xs font-semibold text-begifted-neutral-600">End date<input className="digits mt-1 block h-9 w-full rounded-md border border-begifted-neutral-300 bg-white px-2 text-sm" type="date" value={endDate} min={RESEARCH_START} onChange={(event) => setEndDate(event.target.value)} /></label>
              <label className="text-xs font-semibold text-begifted-neutral-600">Room<select className="mt-1 block h-9 w-full rounded-md border border-begifted-neutral-300 bg-white px-2 text-sm" value={room} onChange={(event) => setRoom(event.target.value)}><option value="">All physical rooms</option>{data.meta.availableRooms.map((name) => <option key={name} value={name}>{name}</option>)}</select></label>
              <div><div className="text-xs font-semibold text-begifted-neutral-600">Weekdays</div><div className="mt-1 flex flex-wrap gap-1"><button type="button" onClick={() => setWeekdays([])} className={`rounded-md border px-2 py-1 text-xs font-semibold ${weekdays.length === 0 ? "border-[#126DCE] bg-[#EEF6FF] text-[#0B4685]" : "border-begifted-neutral-300 bg-white"}`}>All</button>{WEEKDAYS.map((day) => <button key={day.value} type="button" aria-pressed={weekdays.includes(day.value)} onClick={() => toggleWeekday(day.value)} className={`rounded-md border px-2 py-1 text-xs font-semibold ${weekdays.includes(day.value) ? "border-begifted-orange-500 bg-begifted-orange-50 text-begifted-orange-600" : "border-begifted-neutral-300 bg-white"}`}>{day.short}</button>)}</div></div>
              <Button type="button" className="self-end" onClick={applyFilters}>Apply</Button>
            </div>
            <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2 text-xs text-begifted-neutral-500"><span className="flex items-center gap-1.5"><CalendarDays className="size-4 text-[#126DCE]" />Effective {formatDate(data.meta.effectiveStartDate)} – {formatDate(data.meta.effectiveEndDate)}</span><span className="flex items-center gap-1.5">{stale ? <AlertTriangle className="size-4 text-begifted-orange-500" /> : <CheckCircle2 className="size-4 text-emerald-600" />} Last successful sync {formatDateTime(data.meta.lastSuccessfulSyncAt)}</span></div>
          </header>

          {error ? <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div> : null}
          {data.meta.isSeptemberMonthToDate ? <div className="rounded-lg border border-begifted-orange-200 bg-begifted-orange-50 px-4 py-3 text-sm text-begifted-neutral-700"><strong>September MTD:</strong> actuals run through the latest fully synced Bangkok day, {formatDate(data.meta.effectiveEndDate)}.</div> : null}
          {data.meta.isEndDateCapped && !data.meta.isSeptemberMonthToDate ? <div className="rounded-lg border border-begifted-orange-200 bg-begifted-orange-50 px-4 py-3 text-sm text-begifted-neutral-700">The requested end date was capped to source coverage through {formatDate(data.meta.effectiveEndDate)}.</div> : null}
          {stale ? <div className="rounded-lg border border-begifted-orange-200 bg-begifted-orange-50 px-4 py-3 text-sm"><strong>Freshness warning:</strong> the daily Wise PAST-session sync is missing or more than 36 hours old.</div> : null}

          <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4" aria-label="Foot traffic summary">
            <KpiCard primary label="Student-visits" value={formatNumber(data.summary.studentVisits)} detail={`${formatNumber(data.summary.unidentifiedVisits)} without a stable ID`} />
            <KpiCard label="Unique students" value={formatNumber(data.summary.uniqueStudents)} detail="Distinct HMAC fingerprints" />
            <KpiCard label="Onsite classes" value={formatNumber(data.summary.onsiteClasses)} detail="At least one qualifying visit" />
            <KpiCard label="Visits per class" value={formatNumber(data.summary.averageVisitsPerClass, 2)} detail="Student-visits ÷ onsite classes" />
          </section>

          {data.summary.studentVisits === 0 ? <div className="rounded-xl border border-dashed border-begifted-neutral-300 bg-white p-8 text-center"><Users className="mx-auto size-8 text-begifted-neutral-400" /><h2 className="begifted-display mt-3 text-2xl">No qualifying visits</h2><p className="mt-2 text-sm text-begifted-neutral-500">This can mean there is no synced coverage yet, or the selected filters contain no ended onsite sessions with positive-credit attendance.</p></div> : null}

          <ChartSection title="Weekly visits" subtitle="Monday–Sunday student attendance, with every orange point labelled." badge={`${data.weekly.length} weeks`} chart={<WeeklyVisitsChart rows={data.weekly} />} table={<MetricTable rows={data.weekly} />} />
          <ChartSection title={data.meta.isSeptemberMonthToDate ? "Monthly visits · September MTD" : "Monthly visits"} subtitle="March–September comparison; asterisks and badges identify partial periods." badge={`${data.monthly.length} months`} chart={<MonthlyVisitsChart rows={data.monthly} septemberMtd={data.meta.isSeptemberMonthToDate} />} table={<MetricTable rows={data.monthly} monthly />} />
          <div className="grid gap-4 xl:grid-cols-2"><ChartSection title="By weekday" subtitle="Bangkok weekdays in Monday-first order." chart={<BreakdownChart rows={data.byWeekday} label="Weekday" />} table={<BreakdownTable rows={data.byWeekday} label="Weekday" />} /><ChartSection title="By room" subtitle="Active physical classrooms ranked by visits." badge={`${data.byRoom.length} rooms`} chart={<BreakdownChart rows={data.byRoom} label="Room" />} table={<BreakdownTable rows={data.byRoom} label="Room" />} /></div>

          <section className="rounded-xl border border-begifted-neutral-200 bg-white shadow-begifted-sm"><div className="border-b border-begifted-neutral-200 px-4 py-3"><h2 className="begifted-display text-2xl">Data quality</h2><p className="mt-1 text-sm text-begifted-neutral-500">Transparent exclusions and identity limitations within the filtered scope.</p></div><div className="grid gap-3 p-4 sm:grid-cols-2 lg:grid-cols-5"><KpiCard label="PAST sessions" value={formatNumber(data.dataQuality.totalPastSessions)} detail={`${formatNumber(data.dataQuality.countedOnsiteSessions)} counted onsite`} /><KpiCard label="Unknown rooms" value={formatNumber(data.dataQuality.unknownRoomSessions)} detail={`${formatNumber(data.dataQuality.missingLocationSessions)} missing location`} /><KpiCard label="No attendance evidence" value={formatNumber(data.dataQuality.sessionsWithoutAttendanceEvidence)} detail={`${formatNumber(data.dataQuality.participantsWithoutAttendanceEvidence)} participant rows`} /><KpiCard label="Cancelled / missed" value={formatNumber(data.dataQuality.cancelledSessions + data.dataQuality.missedSessions)} detail="Excluded from visits" /><KpiCard label="Review signals" value={formatNumber(qualityTotal)} detail="May overlap across categories" /></div><div className="overflow-auto border-t border-begifted-neutral-200"><table className="w-full min-w-[760px] border-collapse text-sm"><thead className="bg-begifted-neutral-900 text-white"><tr><th className="px-3 py-2 text-left">Signal</th>{["Cancelled", "Missed", "Not ended", "Non-onsite", "Missing room", "Unknown room", "Online-only room", "Unidentified visits"].map((label) => <th key={label} className="px-3 py-2 text-right">{label}</th>)}</tr></thead><tbody><tr>{["Count", data.dataQuality.cancelledSessions, data.dataQuality.missedSessions, data.dataQuality.notEndedSessions, data.dataQuality.nonOnsiteSessions, data.dataQuality.missingLocationSessions, data.dataQuality.unknownRoomSessions, data.dataQuality.onlineOnlyRoomSessions, data.dataQuality.unidentifiedVisits].map((value, index) => index === 0 ? <td key={index} className="px-3 py-2 font-medium">{value}</td> : <td key={index} className="digits px-3 py-2 text-right">{formatNumber(value as number)}</td>)}</tr></tbody></table></div></section>

          <section className="rounded-xl border border-begifted-neutral-200 bg-white px-4 py-4 shadow-begifted-sm"><div className="flex flex-wrap items-center justify-between gap-4"><div><h2 className="begifted-display text-2xl">Exports</h2><p className="mt-1 text-sm text-begifted-neutral-500">UTF-8 CSVs use the current URL-backed filters. Visit rows are de-identified.</p></div><div className="flex flex-wrap gap-2">{exports.map((grain) => <Button key={grain} render={<a href={withGrain(query, grain)} />} variant="outline" size="sm"><Download className="mr-1.5 size-3.5" />{grain[0].toUpperCase() + grain.slice(1)} CSV</Button>)}</div></div>{reportLinks ? <div className="mt-4 flex flex-wrap items-center gap-2 rounded-lg border border-[#CFE1F7] bg-[#EEF6FF] p-3 text-sm"><CheckCircle2 className="size-4 text-[#126DCE]" /><span className="mr-2 text-begifted-neutral-700">Immutable analytics pack captured.</span><Button render={<a href={reportLinks.htmlUrl} />} size="sm" variant="outline">Download HTML</Button><Button render={<a href={reportLinks.pdfUrl} />} size="sm">Download PDF</Button><span className="text-xs text-begifted-neutral-500">Snapshot expires {formatDateTime(reportLinks.expiresAt)}</span></div> : null}</section>

          <footer className="px-2 pb-3 text-xs leading-relaxed text-begifted-neutral-500">Source: Wise PAST sessions. This is a class-attendance proxy for foot traffic, not a physical door-counter measurement. Student names, raw student IDs, session titles, and class names are excluded from storage and exports.</footer>
        </div>
      </div>
    </div>
  );
}
