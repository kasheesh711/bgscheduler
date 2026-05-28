"use client";

import Chart from "chart.js/auto";
import type { ChartConfiguration, ChartDataset } from "chart.js";
import {
  AlertCircle,
  CalendarDays,
  CheckCircle2,
  ChevronDown,
  Coins,
  Eye,
  Filter,
  ListChecks,
  RefreshCw,
  Search,
  ShieldAlert,
  X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import {
  formatBangkokDateTime,
  formatWiseAmount,
  isWiseFinanceEvent,
  wiseActivityEventLabel,
  wiseActivityTypeLabel,
} from "@/lib/wise-activity/format";
import type {
  ReconciliationCandidate,
  ReconciliationSaleRow,
  ReconciliationStudentGroup,
  WisePackageSalesReconciliation,
} from "@/lib/wise-activity/reconciliation";

interface WiseActivityEventDto {
  id: string;
  eventId: string;
  eventType: string;
  eventName: string;
  eventTimestamp: string;
  actorWiseUserId: string | null;
  actorName: string | null;
  actorRole: string | null;
  classroomId: string | null;
  classroomName: string | null;
  classroomSubject: string | null;
  sessionId: string | null;
  sessionStartTime: string | null;
  sessionEndTime: string | null;
  transactionId: string | null;
  transactionType: string | null;
  transactionStatus: string | null;
  transactionAmount: number | null;
  transactionCurrency: string | null;
  payload: Record<string, unknown>;
  raw: Record<string, unknown>;
}

interface WiseActivityListResponse {
  events: WiseActivityEventDto[];
  pagination: {
    page: number;
    pageSize: number;
    total: number;
    pageCount: number;
  };
}

interface WiseActivitySummaryResponse {
  cards: {
    totalEvents: number;
    sessionMutationEvents: number;
    financeEvents: number;
    lastSyncAt: string | null;
    lastSyncStatus: string | null;
    lastSyncInsertedCount: number | null;
  };
  activityByDate: Array<Record<string, string | number>>;
  financeTrend: Array<{ date: string; count: number; amount: number }>;
  eventTypeCounts: Record<string, number>;
  eventNameCounts: Record<string, number>;
  sessionMutationCounts: Record<string, number>;
  topActors: Array<[string, number]>;
  topClassrooms: Array<[string, number]>;
}

const EVENT_TYPE_COLORS: Record<string, string> = {
  BILLING: "#e67e22",
  CLASSROOM: "#7c3aed",
  CONTENT: "#14b8a6",
  CREDIT: "#0ea5e9",
  SESSION: "#2563eb",
  SETTING: "#dc2626",
  USER: "#16a34a",
  unknown: "#64748b",
};

const MUTATION_COLORS: Record<string, string> = {
  SessionCreatedEvent: "#16a34a",
  SessionUpdatedEvent: "#2563eb",
  SessionCancelledEvent: "#e67e22",
  SessionDeletedEvent: "#dc2626",
};

function bangkokToday(): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Bangkok",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const byType = new Map(parts.map((part) => [part.type, part.value]));
  return `${byType.get("year")}-${byType.get("month")}-${byType.get("day")}`;
}

function addDays(date: string, days: number): string {
  const [year, month, day] = date.split("-").map(Number);
  const value = new Date(Date.UTC(year, month - 1, day + days, 12, 0, 0, 0));
  return value.toISOString().slice(0, 10);
}

function queryString(filters: {
  startDate: string;
  endDate: string;
  eventType: string;
  eventName: string;
  query: string;
  financeOnly: boolean;
  page?: number;
}) {
  const params = new URLSearchParams({
    startDate: filters.startDate,
    endDate: filters.endDate,
  });
  if (filters.page) params.set("page", String(filters.page));
  params.set("pageSize", "50");
  if (filters.eventType) params.set("type", filters.eventType);
  if (filters.eventName) params.set("eventName", filters.eventName);
  if (filters.query.trim()) params.set("q", filters.query.trim());
  if (filters.financeOnly) params.set("financeOnly", "true");
  return params.toString();
}

function reconciliationQueryString(filters: { sourceId: string }) {
  const params = new URLSearchParams();
  if (filters.sourceId) params.set("sourceId", filters.sourceId);
  return params.toString();
}

async function checkedJson<T>(response: Response, fallback: string): Promise<T> {
  const payload = await response.json().catch(() => null) as { error?: string } | T | null;
  if (!response.ok) {
    throw new Error(payload && typeof payload === "object" && "error" in payload && payload.error ? payload.error : fallback);
  }
  return payload as T;
}

function sourceMonthLabel(value: string): string {
  return value.slice(0, 7);
}

function confidenceBadgeClass(confidence: ReconciliationCandidate["confidence"]) {
  if (confidence === "high") return "border-emerald-200 bg-emerald-50 text-emerald-800";
  if (confidence === "medium") return "border-sky-200 bg-sky-50 text-sky-800";
  return "border-amber-200 bg-amber-50 text-amber-800";
}

function coverageClass(status: WisePackageSalesReconciliation["coverage"]["status"]) {
  if (status === "complete") return "border-emerald-200 bg-emerald-50 text-emerald-900";
  if (status === "empty") return "border-red-200 bg-red-50 text-red-900";
  return "border-amber-200 bg-amber-50 text-amber-900";
}

function ChartCanvas({ config }: { config: ChartConfiguration }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    if (!canvasRef.current) return;
    const chart = new Chart(canvasRef.current, config);
    return () => chart.destroy();
  }, [config]);

  return (
    <div className="relative min-h-0 flex-1">
      <canvas ref={canvasRef} />
    </div>
  );
}

function KpiCard({ label, value, detail, tone }: {
  label: string;
  value: string;
  detail: string;
  tone: "sky" | "amber" | "green" | "red";
}) {
  const toneClass = {
    sky: "bg-sky-500",
    amber: "bg-amber-500",
    green: "bg-emerald-500",
    red: "bg-red-500",
  }[tone];
  return (
    <Card className="relative overflow-hidden rounded-lg px-4 py-3">
      <div className={cn("absolute inset-x-0 top-0 h-1", toneClass)} />
      <div className="text-[10px] font-semibold uppercase text-muted-foreground">{label}</div>
      <div className="mt-2 text-2xl font-semibold tracking-tight">{value}</div>
      <div className="mt-1 truncate text-xs text-muted-foreground">{detail}</div>
    </Card>
  );
}

function formatPercent(value: number | null | undefined): string {
  if (typeof value !== "number" || Number.isNaN(value)) return "-";
  return `${value > 0 ? "+" : ""}${value.toFixed(1)}%`;
}

function differenceClass(value: number): string {
  if (Math.abs(value) < 0.01) return "text-emerald-700";
  return value > 0 ? "text-amber-700" : "text-sky-700";
}

function JsonBlock({ value }: { value: unknown }) {
  return (
    <pre className="max-h-72 overflow-auto rounded-md bg-muted p-3 text-[11px] leading-relaxed text-muted-foreground">
      {JSON.stringify(value, null, 2)}
    </pre>
  );
}

function typeBadgeClass(type: string) {
  if (type === "BILLING") return "border-amber-200 bg-amber-50 text-amber-800";
  if (type === "SESSION") return "border-sky-200 bg-sky-50 text-sky-800";
  if (type === "CLASSROOM") return "border-purple-200 bg-purple-50 text-purple-800";
  if (type === "USER") return "border-emerald-200 bg-emerald-50 text-emerald-800";
  return "border-slate-200 bg-slate-50 text-slate-700";
}

function RevenueVarianceTable({ data }: { data: WisePackageSalesReconciliation }) {
  const variance = data.revenueVariance;
  const coverageTone = data.coverage.status === "complete"
    ? "border-emerald-200 bg-emerald-50 text-emerald-800"
    : data.coverage.status === "empty"
      ? "border-red-200 bg-red-50 text-red-800"
      : "border-amber-200 bg-amber-50 text-amber-800";

  return (
    <section className="rounded-lg border bg-card">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b px-3 py-2">
        <div className="text-sm font-semibold">Revenue Variance</div>
        <div className="text-xs text-muted-foreground">Sheet - Wise from persisted Wise Activity events</div>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[860px] text-left text-sm">
          <thead className="bg-muted/50 text-[10px] uppercase text-muted-foreground">
            <tr>
              <th className="px-3 py-2 font-semibold">Period</th>
              <th className="px-3 py-2 font-semibold">Sheet Package Sales</th>
              <th className="px-3 py-2 font-semibold">Wise Revenue</th>
              <th className="px-3 py-2 font-semibold">Sheet - Wise</th>
              <th className="px-3 py-2 font-semibold">Difference %</th>
              <th className="px-3 py-2 font-semibold">Wise Transactions</th>
              <th className="px-3 py-2 font-semibold">Coverage</th>
            </tr>
          </thead>
          <tbody>
            <tr className="border-t">
              <td className="px-3 py-3">
                <div className="font-medium">{variance.periodLabel}</div>
                <div className="text-xs text-muted-foreground">{variance.startDate} to {variance.endDate}</div>
              </td>
              <td className="px-3 py-3 font-medium">
                {formatWiseAmount(variance.sheetPackageSalesTotal, variance.currency)}
              </td>
              <td className="px-3 py-3 font-medium">
                <div>{formatWiseAmount(variance.wiseRevenueTotal, variance.currency)}</div>
                <div className="text-xs font-normal text-muted-foreground">
                  {data.coverage.status === "complete" ? "Persisted total" : "Partial persisted total"}
                </div>
              </td>
              <td className={cn("px-3 py-3 font-semibold", differenceClass(variance.difference))}>
                {formatWiseAmount(variance.difference, variance.currency)}
              </td>
              <td className={cn("px-3 py-3 font-medium", differenceClass(variance.difference))}>
                {formatPercent(variance.differencePct)}
              </td>
              <td className="px-3 py-3">
                <div className="font-medium">
                  {variance.wiseRevenueTransactionCount} transaction{variance.wiseRevenueTransactionCount === 1 ? "" : "s"}
                </div>
                <div className="text-xs text-muted-foreground">
                  {variance.wiseRevenueEventCount} revenue event{variance.wiseRevenueEventCount === 1 ? "" : "s"}
                  {variance.skippedEventCount > 0 ? ` | ${variance.skippedEventCount} skipped` : ""}
                </div>
              </td>
              <td className="px-3 py-3">
                <Badge variant="outline" className={cn("rounded-md capitalize", coverageTone)}>
                  {data.coverage.status}
                </Badge>
                {data.coverage.status !== "complete" ? (
                  <div className="mt-1 text-xs text-muted-foreground">Backfill before trusting variance.</div>
                ) : null}
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>
  );
}

function CandidateList({ candidates }: { candidates: ReconciliationCandidate[] }) {
  if (candidates.length === 0) {
    return <div className="rounded-md border border-dashed px-3 py-2 text-xs text-muted-foreground">No Wise invoice/payment candidates.</div>;
  }

  return (
    <div className="space-y-2">
      {candidates.map((candidate) => (
        <details key={`${candidate.id}-${candidate.score}`} className="rounded-md border bg-background p-3">
          <summary className="flex cursor-pointer list-none items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <Badge variant="outline" className={cn("rounded-md", confidenceBadgeClass(candidate.confidence))}>
                  {candidate.confidence} confidence
                </Badge>
                <span className="text-sm font-medium">{wiseActivityEventLabel(candidate.eventName)}</span>
                <span className="text-xs text-muted-foreground">{formatBangkokDateTime(candidate.eventTimestamp)}</span>
              </div>
              <div className="mt-1 truncate text-xs text-muted-foreground">
                {[candidate.classroomName, candidate.transactionId].filter(Boolean).join(" | ") || candidate.eventId}
              </div>
            </div>
            <div className="shrink-0 text-right">
              <div className="text-sm font-semibold">{formatWiseAmount(candidate.transactionAmount, candidate.transactionCurrency)}</div>
              <div className="text-xs text-muted-foreground">score {candidate.score}</div>
            </div>
          </summary>
          <div className="mt-3 space-y-3 border-t pt-3">
            <ul className="space-y-1 text-xs text-muted-foreground">
              {candidate.reasons.map((reason) => <li key={reason}>- {reason}</li>)}
            </ul>
            <details className="rounded-md bg-muted/60 p-2">
              <summary className="cursor-pointer text-xs font-medium">Wise raw details</summary>
              <JsonBlock value={{ payload: candidate.payload, raw: candidate.raw }} />
            </details>
          </div>
        </details>
      ))}
    </div>
  );
}

function SaleRowReview({ row }: { row: ReconciliationSaleRow }) {
  return (
    <div className="space-y-3 border-t px-3 py-3 first:border-t-0">
      <div className="grid grid-cols-1 gap-3 lg:grid-cols-[120px_1fr_130px_160px]">
        <div>
          <div className="text-[10px] font-semibold uppercase text-muted-foreground">Row</div>
          <div className="font-medium">#{row.rowNumber}</div>
          <div className="text-xs text-muted-foreground">{row.paymentDate}</div>
        </div>
        <div className="min-w-0">
          <div className="truncate font-medium">{row.packageName || row.program || row.packageHours || "Package sale"}</div>
          <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
            <span>Parent: {row.parentAccount || "-"}</span>
            <span>Transaction: {row.transactionNo || "-"}</span>
            <span>WISE: {row.recordedInWise || "-"}</span>
          </div>
        </div>
        <div>
          <div className="text-[10px] font-semibold uppercase text-muted-foreground">Sheet Amount</div>
          <div className="font-medium">{formatWiseAmount(row.paymentAmount, "THB")}</div>
        </div>
        <div>
          <div className="text-[10px] font-semibold uppercase text-muted-foreground">Review</div>
          <div className={cn("font-medium", row.reviewFlags.length > 0 ? "text-amber-700" : "text-emerald-700")}>
            {row.reviewFlags.length > 0 ? `${row.reviewFlags.length} flag${row.reviewFlags.length === 1 ? "" : "s"}` : "Candidates available"}
          </div>
        </div>
      </div>
      {row.reviewFlags.length > 0 ? (
        <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900">
          {row.reviewFlags.join(" ")}
        </div>
      ) : null}
      <CandidateList candidates={row.candidates} />
    </div>
  );
}

function StudentReconciliationGroup({ group }: { group: ReconciliationStudentGroup }) {
  return (
    <details className="rounded-lg border bg-card" open={group.rowsNeedingReview > 0}>
      <summary className="grid cursor-pointer list-none grid-cols-1 gap-3 px-4 py-3 md:grid-cols-[1fr_120px_150px_150px_auto]">
        <div className="min-w-0">
          <div className="truncate font-semibold">{group.studentNickname}</div>
          <div className="text-xs text-muted-foreground">{group.rowCount} sale row{group.rowCount === 1 ? "" : "s"}</div>
        </div>
        <div>
          <div className="text-[10px] font-semibold uppercase text-muted-foreground">Sheet Total</div>
          <div className="font-medium">{formatWiseAmount(group.totalAmount, "THB")}</div>
        </div>
        <div>
          <div className="text-[10px] font-semibold uppercase text-muted-foreground">Candidate Rows</div>
          <div className="font-medium">{group.rowsWithCandidates} / {group.rowCount}</div>
        </div>
        <div>
          <div className="text-[10px] font-semibold uppercase text-muted-foreground">Needs Review</div>
          <div className={cn("font-medium", group.rowsNeedingReview > 0 ? "text-amber-700" : "text-emerald-700")}>{group.rowsNeedingReview}</div>
        </div>
        <ChevronDown className="size-4 self-center justify-self-end text-muted-foreground" />
      </summary>
      <div className="border-t">
        {group.rows.map((row) => <SaleRowReview key={row.id} row={row} />)}
      </div>
    </details>
  );
}

function ReconciliationPanel({
  data,
  selectedSourceId,
  loading,
  backfilling,
  onSourceChange,
  onReload,
  onBackfill,
}: {
  data: WisePackageSalesReconciliation | null;
  selectedSourceId: string;
  loading: boolean;
  backfilling: boolean;
  onSourceChange: (sourceId: string) => void;
  onReload: () => void;
  onBackfill: () => void;
}) {
  const summary = data?.summary;
  return (
    <div className="space-y-3">
      <section className="rounded-lg border bg-card p-3">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
          <label className="w-full text-xs font-medium text-muted-foreground lg:max-w-md">
            <span className="mb-1 block">Sales Dashboard source</span>
            <select
              className="h-9 w-full rounded-md border bg-background px-2 text-sm text-foreground"
              value={selectedSourceId}
              onChange={(event) => onSourceChange(event.target.value)}
            >
              {(data?.sources ?? []).map((source) => (
                <option key={source.id} value={source.id}>
                  {source.label} ({sourceMonthLabel(source.sourceMonth)})
                </option>
              ))}
            </select>
          </label>
          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant="outline" onClick={onReload} disabled={loading}>
              <RefreshCw className={cn("mr-2 size-4", loading && "animate-spin")} />
              Reload
            </Button>
            <Button size="sm" onClick={onBackfill} disabled={!data || backfilling}>
              <RefreshCw className={cn("mr-2 size-4", backfilling && "animate-spin")} />
              Backfill selected range
            </Button>
          </div>
        </div>
      </section>

      {data ? (
        <section className={cn("flex items-start gap-2 rounded-lg border px-3 py-2 text-sm", coverageClass(data.coverage.status))}>
          {data.coverage.status === "complete" ? <CheckCircle2 className="mt-0.5 size-4" /> : <ShieldAlert className="mt-0.5 size-4" />}
          <div>
            <div className="font-medium">
              Coverage: {data.coverage.status} for {data.dateRange.startDate} to {data.dateRange.endDate}
            </div>
            <div className="text-xs">{data.coverage.message}</div>
          </div>
        </section>
      ) : null}

      <section className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-4">
        <KpiCard label="Package Sale Rows" value={String(summary?.saleRows ?? 0)} detail="Sales Dashboard normal rows" tone="sky" />
        <KpiCard label="Sheet Total" value={formatWiseAmount(summary?.sheetTotal ?? 0, "THB")} detail={`${summary?.students ?? 0} students`} tone="green" />
        <KpiCard label="Rows With Candidates" value={String(summary?.rowsWithCandidates ?? 0)} detail={`${summary?.candidateCount ?? 0} Wise candidates`} tone="amber" />
        <KpiCard label="Needs Review" value={String(summary?.rowsNeedingReview ?? 0)} detail={`${summary?.wiseInboundEvents ?? 0} inbound Wise events`} tone="red" />
      </section>

      {data ? <RevenueVarianceTable data={data} /> : null}

      <section className="space-y-2">
        <div className="flex items-center gap-2 text-sm font-semibold">
          <ListChecks className="size-4" />
          Student Package Sales
        </div>
        {loading ? (
          <div className="rounded-lg border bg-card px-4 py-8 text-center text-sm text-muted-foreground">Loading reconciliation...</div>
        ) : data && data.students.length > 0 ? (
          data.students.map((group) => <StudentReconciliationGroup key={group.studentKey} group={group} />)
        ) : (
          <div className="rounded-lg border bg-card px-4 py-8 text-center text-sm text-muted-foreground">No package sales found for this source.</div>
        )}
      </section>
    </div>
  );
}

export function WiseActivityWorkspace() {
  const defaultEnd = useMemo(() => bangkokToday(), []);
  const defaultStart = useMemo(() => addDays(defaultEnd, -6), [defaultEnd]);
  const [view, setView] = useState<"activity" | "reconciliation">("activity");
  const [startDate, setStartDate] = useState(defaultStart);
  const [endDate, setEndDate] = useState(defaultEnd);
  const [eventType, setEventType] = useState("");
  const [eventName, setEventName] = useState("");
  const [query, setQuery] = useState("");
  const [financeOnly, setFinanceOnly] = useState(false);
  const [page, setPage] = useState(1);
  const [summary, setSummary] = useState<WiseActivitySummaryResponse | null>(null);
  const [list, setList] = useState<WiseActivityListResponse | null>(null);
  const [selected, setSelected] = useState<WiseActivityEventDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [reconciliation, setReconciliation] = useState<WisePackageSalesReconciliation | null>(null);
  const [selectedSourceId, setSelectedSourceId] = useState("");
  const [reconciliationLoading, setReconciliationLoading] = useState(false);
  const [backfilling, setBackfilling] = useState(false);

  const loadData = useCallback((targetPage: number) => {
    const controller = new AbortController();
    const filters = { startDate, endDate, eventType, eventName, query, financeOnly, page: targetPage };
    setLoading(true);
    setError(null);
    Promise.all([
      fetch(`/api/wise-activity/summary?${queryString(filters)}`, { signal: controller.signal }),
      fetch(`/api/wise-activity?${queryString(filters)}`, { signal: controller.signal }),
    ])
      .then(async ([summaryResponse, listResponse]) => {
        if (!summaryResponse.ok) throw new Error((await summaryResponse.json()).error ?? "Summary failed");
        if (!listResponse.ok) throw new Error((await listResponse.json()).error ?? "Activity query failed");
        const [summaryJson, listJson] = await Promise.all([
          summaryResponse.json() as Promise<WiseActivitySummaryResponse>,
          listResponse.json() as Promise<WiseActivityListResponse>,
        ]);
        setSummary(summaryJson);
        setList(listJson);
        setPage(targetPage);
      })
      .catch((loadError) => {
        if (loadError instanceof DOMException && loadError.name === "AbortError") return;
        setError(loadError instanceof Error ? loadError.message : "Wise activity load failed");
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [endDate, eventName, eventType, financeOnly, query, startDate]);

  useEffect(() => loadData(1), [loadData]);

  const loadReconciliation = useCallback((sourceId = selectedSourceId) => {
    const controller = new AbortController();
    setReconciliationLoading(true);
    setError(null);
    fetch(`/api/wise-activity/reconciliation?${reconciliationQueryString({ sourceId })}`, { signal: controller.signal })
      .then((response) => checkedJson<WisePackageSalesReconciliation>(response, "Wise reconciliation load failed"))
      .then((json) => {
        setReconciliation(json);
        if (json.selectedSource?.id && json.selectedSource.id !== selectedSourceId) {
          setSelectedSourceId(json.selectedSource.id);
        }
      })
      .catch((loadError) => {
        if (loadError instanceof DOMException && loadError.name === "AbortError") return;
        setError(loadError instanceof Error ? loadError.message : "Wise reconciliation load failed");
      })
      .finally(() => {
        if (!controller.signal.aborted) setReconciliationLoading(false);
      });
    return () => controller.abort();
  }, [selectedSourceId]);

  useEffect(() => {
    if (view !== "reconciliation") return;
    return loadReconciliation();
  }, [loadReconciliation, view]);

  const eventTypes = useMemo(
    () => Object.keys(summary?.eventTypeCounts ?? {}).sort(),
    [summary],
  );
  const eventNames = useMemo(
    () => Object.keys(summary?.eventNameCounts ?? {}).sort((left, right) => wiseActivityEventLabel(left).localeCompare(wiseActivityEventLabel(right))),
    [summary],
  );

  const activityConfig = useMemo<ChartConfiguration>(() => {
    const rows = summary?.activityByDate ?? [];
    const labels = rows.map((row) => String(row.date).slice(5));
    const types = Object.keys(summary?.eventTypeCounts ?? {}).sort();
    const datasets: ChartDataset<"bar">[] = types.map((type) => ({
      label: wiseActivityTypeLabel(type),
      data: rows.map((row) => Number(row[type] ?? 0)),
      backgroundColor: EVENT_TYPE_COLORS[type] ?? "#64748b",
      borderRadius: 3,
    }));
    return {
      type: "bar",
      data: { labels, datasets },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        scales: {
          x: { stacked: true, grid: { display: false } },
          y: { stacked: true, beginAtZero: true, grid: { color: "rgba(15, 23, 42, 0.06)" } },
        },
        plugins: { legend: { position: "bottom" } },
      },
    };
  }, [summary]);

  const mutationConfig = useMemo<ChartConfiguration>(() => {
    const entries = Object.entries(summary?.sessionMutationCounts ?? {});
    return {
      type: "bar",
      data: {
        labels: entries.map(([name]) => wiseActivityEventLabel(name)),
        datasets: [{
          label: "Events",
          data: entries.map(([, count]) => count),
          backgroundColor: entries.map(([name]) => MUTATION_COLORS[name] ?? "#64748b"),
          borderRadius: 4,
        }],
      },
      options: {
        indexAxis: "y",
        responsive: true,
        maintainAspectRatio: false,
        scales: {
          x: { beginAtZero: true, grid: { color: "rgba(15, 23, 42, 0.06)" } },
          y: { grid: { display: false } },
        },
        plugins: { legend: { display: false } },
      },
    };
  }, [summary]);

  const financeConfig = useMemo<ChartConfiguration>(() => {
    const rows = summary?.financeTrend ?? [];
    return {
      type: "line",
      data: {
        labels: rows.map((row) => row.date.slice(5)),
        datasets: [{
          label: "Finance events",
          data: rows.map((row) => row.count),
          borderColor: "#e67e22",
          backgroundColor: "rgba(230, 126, 34, 0.18)",
          fill: true,
          tension: 0.35,
          pointRadius: 3,
        }],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        scales: {
          x: { grid: { display: false } },
          y: { beginAtZero: true, grid: { color: "rgba(15, 23, 42, 0.06)" } },
        },
        plugins: { legend: { display: false } },
      },
    };
  }, [summary]);

  async function runManualSync() {
    setSyncing(true);
    setError(null);
    try {
      const response = await fetch("/api/wise-activity/sync", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ lookbackDays: 30, maxPages: 500 }),
      });
      if (!response.ok) throw new Error((await response.json()).error ?? "Wise activity sync failed");
      loadData(1);
    } catch (syncError) {
      setError(syncError instanceof Error ? syncError.message : "Wise activity sync failed");
    } finally {
      setSyncing(false);
    }
  }

  async function runReconciliationBackfill() {
    if (!reconciliation) return;
    setBackfilling(true);
    setError(null);
    try {
      const response = await fetch("/api/wise-activity/reconciliation/backfill", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          startDate: reconciliation.dateRange.startDate,
          endDate: reconciliation.dateRange.endDate,
          maxPages: 1_000,
        }),
      });
      await checkedJson<{ ok: true }>(response, "Wise reconciliation backfill failed");
      loadReconciliation(selectedSourceId);
    } catch (backfillError) {
      setError(backfillError instanceof Error ? backfillError.message : "Wise reconciliation backfill failed");
    } finally {
      setBackfilling(false);
    }
  }

  const rows = list?.events ?? [];
  const cards = summary?.cards;

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-auto pb-6">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Wise Audit</h1>
          <p className="text-xs text-muted-foreground">Ops and finance activity from persisted Wise logs.</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex rounded-md border bg-muted p-1">
            <Button size="sm" variant={view === "activity" ? "default" : "ghost"} onClick={() => setView("activity")}>
              <Eye className="mr-2 size-4" />
              Activity
            </Button>
            <Button size="sm" variant={view === "reconciliation" ? "default" : "ghost"} onClick={() => setView("reconciliation")}>
              <Coins className="mr-2 size-4" />
              Reconciliation
            </Button>
          </div>
          <Button size="sm" onClick={runManualSync} disabled={syncing}>
            <RefreshCw className={cn("mr-2 size-4", syncing && "animate-spin")} />
            Sync
          </Button>
        </div>
      </header>

      {error ? (
        <div className="flex items-center gap-2 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">
          <AlertCircle className="size-4" />
          {error}
        </div>
      ) : null}

      {view === "reconciliation" ? (
        <ReconciliationPanel
          data={reconciliation}
          selectedSourceId={selectedSourceId}
          loading={reconciliationLoading}
          backfilling={backfilling}
          onSourceChange={(sourceId) => {
            setSelectedSourceId(sourceId);
            loadReconciliation(sourceId);
          }}
          onReload={() => loadReconciliation(selectedSourceId)}
          onBackfill={runReconciliationBackfill}
        />
      ) : (
        <>
      <section className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-4">
        <KpiCard label="Total Events" value={String(cards?.totalEvents ?? 0)} detail={`${startDate} to ${endDate} BKK`} tone="sky" />
        <KpiCard label="Session Mutations" value={String(cards?.sessionMutationEvents ?? 0)} detail="Created, updated, cancelled, deleted" tone="green" />
        <KpiCard label="Finance Events" value={String(cards?.financeEvents ?? 0)} detail="Billing, payments, invoices, payouts" tone="amber" />
        <KpiCard
          label="Last Activity Sync"
          value={cards?.lastSyncStatus ?? "-"}
          detail={cards?.lastSyncAt ? `${formatBangkokDateTime(cards.lastSyncAt)} | +${cards.lastSyncInsertedCount ?? 0}` : "No sync run recorded"}
          tone={cards?.lastSyncStatus === "failed" ? "red" : "sky"}
        />
      </section>

      <section className="rounded-lg border bg-card p-3">
        <div className="grid grid-cols-1 gap-2 lg:grid-cols-[repeat(6,minmax(0,1fr))_auto]">
          <label className="text-xs font-medium text-muted-foreground">
            <span className="mb-1 flex items-center gap-1"><CalendarDays className="size-3" /> Start</span>
            <Input type="date" value={startDate} onChange={(event) => setStartDate(event.target.value)} />
          </label>
          <label className="text-xs font-medium text-muted-foreground">
            <span className="mb-1 block">End</span>
            <Input type="date" value={endDate} onChange={(event) => setEndDate(event.target.value)} />
          </label>
          <label className="text-xs font-medium text-muted-foreground">
            <span className="mb-1 block">Type</span>
            <select className="h-9 w-full rounded-md border bg-background px-2 text-sm text-foreground" value={eventType} onChange={(event) => setEventType(event.target.value)}>
              <option value="">All types</option>
              {eventTypes.map((type) => <option key={type} value={type}>{wiseActivityTypeLabel(type)}</option>)}
            </select>
          </label>
          <label className="text-xs font-medium text-muted-foreground">
            <span className="mb-1 block">Action</span>
            <select className="h-9 w-full rounded-md border bg-background px-2 text-sm text-foreground" value={eventName} onChange={(event) => setEventName(event.target.value)}>
              <option value="">All actions</option>
              {eventNames.map((name) => <option key={name} value={name}>{wiseActivityEventLabel(name)}</option>)}
            </select>
          </label>
          <label className="text-xs font-medium text-muted-foreground lg:col-span-2">
            <span className="mb-1 flex items-center gap-1"><Search className="size-3" /> Search</span>
            <Input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Actor, class, session, transaction" />
          </label>
          <div className="flex items-end gap-2">
            <Button size="sm" onClick={() => loadData(1)} disabled={loading}>
              <Filter className="mr-2 size-4" />
              Apply
            </Button>
            <Button
              size="sm"
              variant={financeOnly ? "default" : "outline"}
              aria-pressed={financeOnly}
              onClick={() => setFinanceOnly((value) => !value)}
            >
              Finance
            </Button>
            <Button
              size="icon"
              variant="ghost"
              aria-label="Clear filters"
              onClick={() => {
                setEventType("");
                setEventName("");
                setQuery("");
                setFinanceOnly(false);
                setStartDate(defaultStart);
                setEndDate(defaultEnd);
              }}
            >
              <X className="size-4" />
            </Button>
          </div>
        </div>
      </section>

      <section className="grid min-h-[260px] grid-cols-1 gap-3 xl:grid-cols-3">
        <Card className="flex min-h-[260px] flex-col p-4 xl:col-span-2">
          <div className="mb-3">
            <h2 className="text-sm font-semibold">Activity by Day</h2>
            <p className="text-xs text-muted-foreground">Stacked by Wise event type.</p>
          </div>
          <ChartCanvas config={activityConfig} />
        </Card>
        <div className="grid grid-cols-1 gap-3">
          <Card className="flex min-h-[180px] flex-col p-4">
            <h2 className="mb-3 text-sm font-semibold">Session Mutations</h2>
            <ChartCanvas config={mutationConfig} />
          </Card>
          <Card className="flex min-h-[180px] flex-col p-4">
            <h2 className="mb-3 text-sm font-semibold">Finance Trend</h2>
            <ChartCanvas config={financeConfig} />
          </Card>
        </div>
      </section>

      <section className="min-h-0 flex-1 overflow-hidden rounded-lg border bg-card">
        <div className="flex items-center justify-between border-b px-3 py-2">
          <div className="text-sm font-semibold">Activity Log</div>
          <div className="text-xs text-muted-foreground">
            {loading ? "Loading" : list ? `${list.pagination.total} events | page ${list.pagination.page} of ${Math.max(1, list.pagination.pageCount)}` : "No data"}
          </div>
        </div>
        <div className="max-h-[42vh] overflow-auto">
          <table className="w-full table-fixed text-left text-sm">
            <thead className="sticky top-0 z-10 bg-muted text-[11px] uppercase text-muted-foreground">
              <tr>
                <th className="w-28 px-3 py-2">Time</th>
                <th className="w-48 px-3 py-2">Actor</th>
                <th className="w-28 px-3 py-2">Type</th>
                <th className="w-56 px-3 py-2">Action</th>
                <th className="px-3 py-2">Class / Session</th>
                <th className="w-40 px-3 py-2">Finance</th>
                <th className="w-16 px-3 py-2 text-right">Open</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.id} className="border-t align-top hover:bg-muted/40">
                  <td className="px-3 py-2 text-xs font-medium">{formatBangkokDateTime(row.eventTimestamp)}</td>
                  <td className="px-3 py-2">
                    <div className="truncate font-medium">{row.actorName ?? "-"}</div>
                    <div className="truncate text-xs text-muted-foreground">{row.actorRole ?? row.actorWiseUserId ?? ""}</div>
                  </td>
                  <td className="px-3 py-2">
                    <Badge variant="outline" className={cn("rounded-md", typeBadgeClass(row.eventType))}>
                      {wiseActivityTypeLabel(row.eventType)}
                    </Badge>
                  </td>
                  <td className="px-3 py-2">
                    <div className="truncate font-medium">{wiseActivityEventLabel(row.eventName)}</div>
                    <div className="truncate text-xs text-muted-foreground">{row.eventName}</div>
                  </td>
                  <td className="px-3 py-2">
                    <div className="truncate font-medium">{row.classroomName ?? "-"}</div>
                    <div className="truncate text-xs text-muted-foreground">
                      {[row.classroomSubject, row.sessionId].filter(Boolean).join(" | ")}
                    </div>
                  </td>
                  <td className="px-3 py-2">
                    {isWiseFinanceEvent(row) ? (
                      <>
                        <div className="font-medium">{formatWiseAmount(row.transactionAmount, row.transactionCurrency)}</div>
                        <div className="truncate text-xs text-muted-foreground">{row.transactionStatus ?? row.transactionType ?? row.transactionId}</div>
                      </>
                    ) : (
                      <span className="text-xs text-muted-foreground">-</span>
                    )}
                  </td>
                  <td className="px-3 py-2 text-right">
                    <Button size="icon" variant="ghost" aria-label="Open event details" onClick={() => setSelected(row)}>
                      <Eye className="size-4" />
                    </Button>
                  </td>
                </tr>
              ))}
              {rows.length === 0 ? (
                <tr>
                  <td className="px-3 py-10 text-center text-sm text-muted-foreground" colSpan={7}>
                    No Wise activity found for the selected filters.
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
        <div className="flex items-center justify-end gap-2 border-t px-3 py-2">
          <Button size="sm" variant="outline" disabled={!list || list.pagination.page <= 1} onClick={() => loadData(Math.max(1, page - 1))}>
            Previous
          </Button>
          <Button size="sm" variant="outline" disabled={!list || list.pagination.page >= list.pagination.pageCount} onClick={() => loadData(page + 1)}>
            Next
          </Button>
        </div>
      </section>
        </>
      )}

      {selected ? (
        <div className="fixed inset-y-0 right-0 z-50 flex w-full max-w-xl flex-col border-l bg-background shadow-xl">
          <div className="flex items-start justify-between border-b px-4 py-3">
            <div>
              <h2 className="text-base font-semibold">{wiseActivityEventLabel(selected.eventName)}</h2>
              <p className="text-xs text-muted-foreground">{selected.eventId}</p>
            </div>
            <Button size="icon" variant="ghost" aria-label="Close details" onClick={() => setSelected(null)}>
              <X className="size-4" />
            </Button>
          </div>
          <div className="min-h-0 flex-1 space-y-4 overflow-auto p-4">
            <div className="grid grid-cols-2 gap-3 text-sm">
              <div><div className="text-xs text-muted-foreground">Time</div><div className="font-medium">{formatBangkokDateTime(selected.eventTimestamp)}</div></div>
              <div><div className="text-xs text-muted-foreground">Type</div><div className="font-medium">{wiseActivityTypeLabel(selected.eventType)}</div></div>
              <div><div className="text-xs text-muted-foreground">Actor</div><div className="font-medium">{selected.actorName ?? "-"}</div></div>
              <div><div className="text-xs text-muted-foreground">Role</div><div className="font-medium">{selected.actorRole ?? "-"}</div></div>
              <div><div className="text-xs text-muted-foreground">Class</div><div className="font-medium">{selected.classroomName ?? "-"}</div></div>
              <div><div className="text-xs text-muted-foreground">Session</div><div className="font-medium">{selected.sessionId ?? "-"}</div></div>
              <div><div className="text-xs text-muted-foreground">Transaction</div><div className="font-medium">{selected.transactionId ?? "-"}</div></div>
              <div><div className="text-xs text-muted-foreground">Amount</div><div className="font-medium">{formatWiseAmount(selected.transactionAmount, selected.transactionCurrency)}</div></div>
            </div>
            <div>
              <h3 className="mb-2 text-sm font-semibold">Payload</h3>
              <JsonBlock value={selected.payload} />
            </div>
            <div>
              <h3 className="mb-2 text-sm font-semibold">Raw Event</h3>
              <JsonBlock value={selected.raw} />
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
