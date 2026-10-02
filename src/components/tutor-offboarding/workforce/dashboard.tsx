"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import type {
  WorkforceReport,
  WorkforceQuery,
  WorkforceDrilldown,
  WorkforceDrilldownQuery,
  WorkforceExportSection,
} from "@/lib/tutor-offboarding/workforce/types";
import { Button } from "@/components/ui/button";
import { Panel, Tag } from "../atoms";
import { WorkforceFilters } from "./filters";
import { TurnoverChart } from "./turnover-chart";
import { DemandView } from "./demand-view";
import { UtilizationTable } from "./utilization-table";
import { WorkforceDetailDrawer } from "./detail-drawer";
import { QualityPanel } from "./quality-panel";
import { GrowthView } from "./growth-view";
import { SubjectCapacity, OverallTrend } from "./overview";
import { Sparkline, INK } from "./charts";
import {
  ReadCache,
  workforceReadKey,
  workforceReportDeadline,
} from "@/lib/tutor-offboarding/workforce/read-cache";
import {
  formatMetric,
  metricReason,
  monthLabel,
  bangkokTime,
} from "./presentation";
import {
  fetchWorkforceReport,
  fetchWorkforceDrilldown,
  fetchWorkforceExport,
  downloadWorkforceCsv,
  LatestRequest,
  withFreshRevision,
} from "./requests";
export interface WorkforceDashboardProps {
  report: WorkforceReport;
  onQueryChange: (query: WorkforceQuery) => void;
  onRefresh?: () => Promise<WorkforceReport>;
  busy?: boolean;
}
type Selection = {
  kind: WorkforceDrilldownQuery["kind"];
  key: string;
  title: string;
};
export function WorkforceDashboard({
  report,
  onQueryChange,
  onRefresh,
  busy = false,
}: WorkforceDashboardProps) {
  const [view, setView] = useState("Overview");
  const [hiringVisited, setHiringVisited] = useState(false);
  const [demandVisited, setDemandVisited] = useState(false);
  const [selection, setSelection] = useState<Selection | null>(null);
  const [detail, setDetail] = useState<WorkforceDrilldown | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [detailBusy, setDetailBusy] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);
  const [exportSection, setExportSection] =
    useState<WorkforceExportSection>("people");
  const detailGate = useRef(new LatestRequest());
  const exportGate = useRef(new LatestRequest());
  const queryKey = JSON.stringify(report.query);
  const [initialSubjects] = useState(report.subjects);
  const refresh =
    onRefresh ??
    (async () => {
      throw new Error(
        "Refresh the workforce report before retrying this detail or export.",
      );
    });
  useEffect(() => {
    setSelection(null);
    setDetail(null);
    detailGate.current.cancel();
    exportGate.current.cancel();
    setExporting(false);
    setExportError(null);
  }, [queryKey]);
  useEffect(
    () => () => {
      detailGate.current.cancel();
      exportGate.current.cancel();
    },
    [],
  );
  const loadDetail = async (selected: Selection, cursor?: string) => {
    const ticket = detailGate.current.begin();
    setDetailBusy(true);
    setDetailError(null);
    if (!cursor) setDetail(null);
    try {
      const next = await withFreshRevision(
        report.reportRevision,
        (revision) =>
          fetchWorkforceDrilldown(
            {
              ...report.query,
              kind: selected.kind,
              key: selected.key,
              reportRevision: revision,
              ...(cursor ? { cursor } : {}),
            },
            ticket.signal,
          ),
        refresh,
      );
      if (!detailGate.current.isCurrent(ticket)) return;
      setDetail((previous) =>
        cursor && previous && previous.reportRevision === next.reportRevision
          ? {
              ...next,
              sessions: [
                ...new Map(
                  [...previous.sessions, ...next.sessions].map((row) => [
                    row.wiseSessionId,
                    row,
                  ]),
                ).values(),
              ],
              people: [
                ...new Map(
                  [...previous.people, ...next.people].map((row) => [
                    row.canonicalKey,
                    row,
                  ]),
                ).values(),
              ],
              observations: [
                ...new Map(
                  [...previous.observations, ...next.observations].map(
                    (row) => [row.id, row],
                  ),
                ).values(),
              ],
            }
          : next,
      );
    } catch (error) {
      if (detailGate.current.isCurrent(ticket))
        setDetailError(
          error instanceof Error
            ? error.message
            : "Contributor evidence could not load.",
        );
    } finally {
      if (detailGate.current.isCurrent(ticket)) setDetailBusy(false);
    }
  };
  const select = (selected: Selection) => {
    if (busy) return;
    setSelection(selected);
    void loadDetail(selected);
  };
  const exportCsv = async () => {
    if (busy || exporting) return;
    const ticket = exportGate.current.begin();
    setExporting(true);
    setExportError(null);
    try {
      const blob = await withFreshRevision(
        report.reportRevision,
        (revision) =>
          fetchWorkforceExport(
            report.query,
            exportSection,
            revision,
            ticket.signal,
          ),
        refresh,
      );
      if (exportGate.current.isCurrent(ticket))
        downloadWorkforceCsv(blob, exportSection);
    } catch (error) {
      if (exportGate.current.isCurrent(ticket))
        setExportError(
          error instanceof Error ? error.message : "Export could not load.",
        );
    } finally {
      if (exportGate.current.isCurrent(ticket)) setExporting(false);
    }
  };
  const month = report.months.find(
    (month) => month.month === report.query.viewMonth,
  );
  const selectMonth = useCallback(
    (month: string) => onQueryChange({ ...report.query, viewMonth: month }),
    [onQueryChange, report.query],
  );
  return (
    <div className="min-w-0 space-y-4" aria-busy={busy}>
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-xl font-semibold">Tutor workforce & growth</h2>
          <p className="mt-1 text-xs text-muted-foreground">
            {report.query.from}–{report.query.to} ·{" "}
            {report.quality.completeness} evidence · updated{" "}
            {bangkokTime(report.generatedAt)}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <label className="text-xs">
            Month{" "}
            <select
              aria-label="Dashboard selected month"
              value={report.query.viewMonth}
              disabled={busy}
              onChange={(e) => selectMonth(e.target.value)}
              className="ml-1 rounded border bg-background p-2"
            >
              {report.months.map((m) => (
                <option key={m.month} value={m.month}>
                  {monthLabel(m.month)}
                </option>
              ))}
            </select>
          </label>
          <QualityPanel report={report} onRefresh={refresh} />
          {view !== "Hiring" && (
            <>
              <select
                aria-label="Export section"
                value={exportSection}
                onChange={(e) =>
                  setExportSection(e.target.value as WorkforceExportSection)
                }
                className="max-w-36 rounded border bg-background p-2 text-xs"
                disabled={exporting || busy}
              >
                {(["months", "subjects", "week", "people"] as const).map(
                  (section) => (
                    <option value={section} key={section}>
                      {section}
                    </option>
                  ),
                )}
              </select>
              <Button
                variant="outline"
                size="sm"
                onClick={() => void exportCsv()}
                disabled={exporting || busy}
              >
                {exporting ? "Preparing…" : "Export CSV"}
              </Button>
            </>
          )}
        </div>
      </header>
      {exportError && (
        <p role="alert" className="text-sm text-conflict">
          {exportError}
        </p>
      )}
      <div className="flex flex-wrap items-center gap-3 border-b pb-3">
        <div
          role="tablist"
          aria-label="Workforce views"
          className="flex min-w-0 flex-wrap gap-1"
        >
          {["Overview", "Demand", "Tutor capacity", "Hiring"].map(
            (tab, i, tabs) => (
              <button
                key={tab}
                id={`workforce-tab-${i}`}
                role="tab"
                aria-selected={view === tab}
                aria-controls="workforce-view"
                tabIndex={view === tab ? 0 : -1}
                className={`rounded-md px-3 py-2 text-sm font-medium focus-visible:outline-2 focus-visible:outline-primary ${view === tab ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-muted"}`}
                onClick={() => {
                  setView(tab);
                  if (tab === "Hiring") setHiringVisited(true);
                  if (tab === "Demand") setDemandVisited(true);
                }}
                onKeyDown={(e) => {
                  if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
                    e.preventDefault();
                    const next =
                      (i + (e.key === "ArrowRight" ? 1 : tabs.length - 1)) %
                      tabs.length;
                    setView(tabs[next]);
                    if (tabs[next] === "Hiring") setHiringVisited(true);
                    if (tabs[next] === "Demand") setDemandVisited(true);
                    document.getElementById(`workforce-tab-${next}`)?.focus();
                  }
                  if (e.key === "Home" || e.key === "End") {
                    e.preventDefault();
                    const next = e.key === "Home" ? 0 : tabs.length - 1;
                    setView(tabs[next]);
                    if (tabs[next] === "Hiring") setHiringVisited(true);
                    if (tabs[next] === "Demand") setDemandVisited(true);
                    document.getElementById(`workforce-tab-${next}`)?.focus();
                  }
                }}
              >
                {tab}
              </button>
            ),
          )}
        </div>
        {month?.partialMonth && <Tag tone="amber">Partial month</Tag>}
      </div>
      <details className="group rounded-lg border bg-card px-4 py-2">
        <summary className="cursor-pointer text-xs font-medium">
          Filters ·{" "}
          {[
            report.query.subject,
            report.query.curriculum,
            report.query.level,
            view === "Hiring"
              ? "All teaching staff · all modes"
              : `${report.query.role.replaceAll("_", " ")} · ${report.query.modality}`,
          ]
            .filter(Boolean)
            .join(" / ")}
        </summary>
        <div className="mt-3">
          <WorkforceFilters
            key={`${queryKey}:${view === "Hiring"}`}
            query={report.query}
            subjects={[...initialSubjects, ...report.subjects]}
            growthScope={view === "Hiring"}
            onChange={onQueryChange}
            busy={busy || exporting}
          />
        </div>
      </details>
      {busy && (
        <p role="status" className="text-xs text-muted-foreground">
          Loading selected filters. Previous report remains visible.
        </p>
      )}
      <div
        id="workforce-view"
        role="tabpanel"
        aria-labelledby={`workforce-tab-${["Overview", "Demand", "Tutor capacity", "Hiring"].indexOf(view)}`}
        className="space-y-4"
      >
        {view === "Overview" && (
          <>
            <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
              {(
                [
                  [
                    "Opening roster",
                    month?.openingRosterCount,
                    report.months.map((m) => m.openingRosterCount),
                    "Opening Wise roster reconstructed from retained history.",
                  ],
                  [
                    "Departures",
                    month?.departuresCount,
                    report.months.map((m) => m.departuresCount),
                    "Owner-confirmed departures, dated to the last recorded class. Future classes stay pending.",
                  ],
                  [
                    "Turnover",
                    month?.turnoverPercent,
                    report.months.map((m) => m.turnoverPercent),
                    "Completed departures ÷ opening roster × 100.",
                  ],
                  [
                    "Pending",
                    month?.pendingCount,
                    report.months.map((m) => m.pendingCount),
                    "Classes remain or completion is unverified.",
                  ],
                ] as const
              ).map(([label, metric, trend, definition]) => (
                <Panel className="p-4" key={label}>
                  <div className="flex items-center justify-between gap-2">
                    <p className="text-xs text-muted-foreground">{label}</p>
                    <details className="relative text-xs text-muted-foreground">
                      <summary
                        aria-label={`${label} definition`}
                        className="cursor-pointer list-none rounded focus-visible:outline-2 focus-visible:outline-primary"
                      >
                        ⓘ
                      </summary>
                      <p className="absolute right-0 z-20 mt-1 w-56 rounded border bg-popover p-3 text-popover-foreground shadow-md">
                        {definition} {metricReason(metric)}
                      </p>
                    </details>
                  </div>
                  <div className="mt-2 flex flex-wrap items-end justify-between gap-2">
                    <strong className="text-2xl tabular-nums">
                      {formatMetric(metric, label === "Turnover" ? "%" : "")}
                    </strong>
                    {metric?.completeness === "partial" && (
                      <Tag tone="amber">Partial</Tag>
                    )}
                    <Sparkline
                      values={[...trend]}
                      color={label === "Departures" ? INK.loss : INK.supply}
                    />
                  </div>
                </Panel>
              ))}
            </div>
            <div className="grid items-start gap-4 xl:grid-cols-[1.6fr_1fr]">
              <TurnoverChart
                months={report.months}
                selectedMonth={report.query.viewMonth}
                onSelect={selectMonth}
                onPeople={(m) =>
                  select({
                    kind: "turnover",
                    key: m,
                    title: `People counted · ${monthLabel(m)}`,
                  })
                }
              />
              <SubjectCapacity
                report={report}
                onSelect={(r) =>
                  select({
                    kind: "subject_cell",
                    key: r.key,
                    title: `${r.subject} · ${monthLabel(r.month)}`,
                  })
                }
              />
            </div>
            <OverallTrend report={report} />
          </>
        )}
        {demandVisited && (
          <div hidden={view !== "Demand"}>
            <DemandView
              report={report}
              onSelect={(r) =>
                select({
                  kind: "subject_cell",
                  key: r.key,
                  title: `${[r.subject, r.curriculum, r.level].filter(Boolean).join(" / ")} · ${monthLabel(r.month)}`,
                })
              }
              onWeekSelect={(c) =>
                select({
                  kind: "subject_cell",
                  key: c.key,
                  title: `Average week · ${monthLabel(c.month)}`,
                })
              }
            />
          </div>
        )}
        {view === "Tutor capacity" && (
          <UtilizationTable
            people={report.people}
            selectedMonth={report.query.viewMonth}
            onSelect={(p) =>
              select({
                kind: "person",
                key: p.canonicalKey,
                title: p.displayName,
              })
            }
          />
        )}
        {hiringVisited && (
          <div hidden={view !== "Hiring"}>
            <GrowthView
              filters={report.query}
              sourceUpdatedAt={report.generatedAt}
            />
          </div>
        )}
      </div>
      <WorkforceDetailDrawer
        open={selection !== null}
        title={selection?.title ?? "Workforce evidence"}
        detail={detail}
        error={detailError}
        busy={detailBusy}
        onClose={() => {
          detailGate.current.cancel();
          setSelection(null);
          setDetail(null);
        }}
        onLoadMore={() => {
          if (selection && detail?.nextCursor)
            void loadDetail(selection, detail.nextCursor);
        }}
      />
    </div>
  );
}
const DEFAULT_QUERY: WorkforceQuery = {
  from: "2026-03-01",
  to: new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Bangkok",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date()),
  viewMonth: new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Bangkok",
    year: "numeric",
    month: "2-digit",
  }).format(new Date()),
  role: "all",
  modality: "all",
};
export function WorkforceTab({
  initial,
  initialError = null,
}: {
  initial?: WorkforceReport;
  initialError?: string | null;
}) {
  const [report, setReport] = useState<WorkforceReport | null>(initial ?? null);
  const [error, setError] = useState<string | null>(initialError);
  const [busy, setBusy] = useState(false);
  const gate = useRef(new LatestRequest());
  const selectedQuery = useRef(initial?.query ?? DEFAULT_QUERY);
  // This cache lives only for this mounted dashboard; it never persists staff evidence.
  const reports = useRef(new ReadCache<WorkforceReport>(60_000, 3, false));
  const load = useCallback(async (query: WorkforceQuery, refresh = false) => {
    if (refresh) reports.current.clear();
    selectedQuery.current = query;
    const ticket = gate.current.begin();
    setBusy(true);
    try {
      const next = await reports.current.read(
        workforceReadKey(query),
        () => fetchWorkforceReport(query, ticket.signal, refresh),
        refresh,
        workforceReportDeadline,
      );
      if (!gate.current.isCurrent(ticket))
        throw new DOMException("Superseded report request", "AbortError");
      setReport(next);
      setError(null);
      return next;
    } catch (failure) {
      if (gate.current.isCurrent(ticket))
        setError(
          failure instanceof Error
            ? failure.message
            : "Workforce evidence could not load.",
        );
      throw failure;
    } finally {
      if (gate.current.isCurrent(ticket)) setBusy(false);
    }
  }, []);
  useEffect(() => {
    if (initial === undefined) void load(selectedQuery.current).catch(() => {});
    const requestGate = gate.current;
    return () => requestGate.cancel();
  }, [initial, load]);
  return (
    <section className="min-w-0" aria-label="Workforce analytics">
      <div className="mb-2 flex justify-end">
        <Button
          variant="outline"
          size="sm"
          disabled={busy}
          onClick={() => void load(selectedQuery.current, true).catch(() => {})}
        >
          {busy ? "Loading workforce…" : "Refresh workforce"}
        </Button>
      </div>
      {error ? (
        <p
          role="alert"
          className="mb-4 rounded border border-conflict/30 p-3 text-sm text-conflict"
        >
          {error}
          {report ? " The previous report remains visible." : ""}
        </p>
      ) : null}
      {report ? (
        <WorkforceDashboard
          report={report}
          busy={busy}
          onQueryChange={(query) => void load(query).catch(() => {})}
          onRefresh={() => load(selectedQuery.current, true)}
        />
      ) : !error ? (
        <Panel className="p-5 text-sm text-muted-foreground">
          Loading retained workforce evidence…
        </Panel>
      ) : null}
    </section>
  );
}
