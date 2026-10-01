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
import { SubjectMatrix } from "./subject-matrix";
import { WeekHeatmap } from "./week-heatmap";
import { UtilizationTable } from "./utilization-table";
import { WorkforceDetailDrawer } from "./detail-drawer";
import { QualityPanel } from "./quality-panel";
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
    <div className="min-w-0 space-y-5" aria-busy={busy}>
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-xl font-semibold">Tutor workforce</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Workforce movement, shared teaching capacity and observed demand.
          </p>
          <p className="mt-2 text-xs text-muted-foreground">
            Report generated {bangkokTime(report.generatedAt)} ·{" "}
            {report.query.from}–{report.query.to}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <QualityPanel report={report} onRefresh={refresh} />
          <label className="sr-only" htmlFor="workforce-export">
            Export section
          </label>
          <select
            id="workforce-export"
            value={exportSection}
            onChange={(e) =>
              setExportSection(e.target.value as WorkforceExportSection)
            }
            className="h-8 max-w-full rounded border bg-background px-2 text-xs"
            disabled={exporting || busy}
          >
            {(["months", "subjects", "week", "people"] as const).map(
              (section) => (
                <option value={section} key={section}>
                  Export {section}
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
            {exporting ? "Preparing CSV…" : "Download CSV"}
          </Button>
        </div>
      </header>
      {exportError ? (
        <p role="alert" className="text-sm text-conflict">
          {exportError}
        </p>
      ) : null}
      <WorkforceFilters
        key={queryKey}
        query={report.query}
        subjects={[...initialSubjects, ...report.subjects]}
        onChange={onQueryChange}
        busy={busy || exporting}
      />
      {busy ? (
        <p role="status" className="rounded border bg-primary/5 p-3 text-sm">
          Loading the selected filters. Values below remain the previous report
          until the new evidence arrives.
        </p>
      ) : null}
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="text-sm font-semibold">
          {monthLabel(report.query.viewMonth)}
        </h3>
        {month?.partialMonth ? <Tag tone="amber">Partial month</Tag> : null}
        <span className="text-xs text-muted-foreground">
          Selected-month workforce counts
        </span>
      </div>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {(
          [
            ["Opening Wise roster", month?.openingRosterCount],
            ["Joined", month?.joinsCount],
            ["Completed departures", month?.departuresCount],
            ["Pending departure", month?.pendingCount],
          ] as const
        ).map(([label, metric]) => (
          <Panel className="p-4" key={label}>
            <p className="text-xs text-muted-foreground">{label}</p>
            <p
              className="mt-2 text-2xl font-semibold"
              title={metricReason(metric)}
            >
              {formatMetric(metric)}
            </p>
            <p className="mt-2 text-[11px] text-muted-foreground">
              {label === "Opening Wise roster"
                ? "Reconstructed from retained Wise history"
                : label === "Completed departures"
                  ? "Sheet-marked, after final taught class"
                  : label === "Pending departure"
                    ? "Classes remain or completion unverified"
                    : "Earliest retained Wise account join date"}
            </p>
          </Panel>
        ))}
      </div>
      <TurnoverChart
        months={report.months}
        selectedMonth={report.query.viewMonth}
        onSelect={selectMonth}
        onPeople={(month) =>
          select({
            kind: "turnover",
            key: month,
            title: `People counted · ${monthLabel(month)}`,
          })
        }
      />
      <Panel className="p-4">
        <h3 className="text-sm font-semibold">
          Shared capacity · overall selected range
        </h3>
        <div className="mt-3 grid grid-cols-2 gap-4 sm:grid-cols-4">
          {(
            [
              ["Gross offered hours", report.totals.offeredHours],
              ["Approved leave", report.totals.leaveHours],
              ["Usable hours", report.totals.usableHours],
              ["Shared free hours", report.totals.freeHours],
            ] as const
          ).map(([label, metric]) => (
            <div key={label}>
              <p className="text-xs text-muted-foreground">{label}</p>
              <p
                className="mt-1 text-lg font-semibold"
                title={metricReason(metric)}
              >
                {formatMetric(metric, "h")}
              </p>
            </div>
          ))}
        </div>
        <p className="mt-3 text-xs text-muted-foreground">
          Usable = offered hours − approved leave. Shared free = usable hours
          after blocking commitments. Each tutor’s time is counted once in
          overall totals. Booked demand is not a measure of unmet demand.
        </p>
        <div className="mt-3 flex flex-wrap gap-x-5 gap-y-2 text-xs">
          <span>
            Unique students: {formatMetric(report.totals.uniqueStudents)}
          </span>
          <span>
            Student bookings: {formatMetric(report.totals.studentBookings)}
          </span>
          <span>Classes: {formatMetric(report.totals.distinctClasses)}</span>
          <span>
            Booked tutor-hours: {formatMetric(report.totals.bookedHours, "h")}
          </span>
        </div>
      </Panel>
      <SubjectMatrix
        rows={report.subjects}
        months={report.months.map((month) => month.month)}
        onSelect={(row) =>
          select({
            kind: "subject_cell",
            key: row.key,
            title: `${[row.subject, row.curriculum, row.level].filter(Boolean).join(" / ")} · ${monthLabel(row.month)}`,
          })
        }
      />
      <WeekHeatmap
        cells={report.weekCells}
        month={report.query.viewMonth}
        onSelect={(cell) =>
          select({
            kind: "subject_cell",
            key: cell.key,
            title: `Average-week evidence · ${monthLabel(cell.month)}`,
          })
        }
      />
      <UtilizationTable
        people={report.people}
        onSelect={(person) =>
          select({
            kind: "person",
            key: person.canonicalKey,
            title: person.displayName,
          })
        }
      />
      <Panel className="p-4">
        <h3 className="text-sm font-semibold">Source quality</h3>
        <p className="mt-2 text-xs text-muted-foreground">
          {report.quality.completeness} supporting evidence · Historical
          capacity remains unavailable wherever availability was not retained.
          Review exact class labels and coverage before making staffing
          decisions.
        </p>
      </Panel>
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
  const load = useCallback(async (query: WorkforceQuery) => {
    selectedQuery.current = query;
    const ticket = gate.current.begin();
    setBusy(true);
    try {
      const next = await fetchWorkforceReport(query, ticket.signal);
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
    <section className="mt-5 min-w-0" aria-label="Workforce analytics">
      <div className="mb-4 flex justify-end">
        <Button
          variant="outline"
          size="sm"
          disabled={busy}
          onClick={() => void load(selectedQuery.current).catch(() => {})}
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
          onRefresh={() => load(selectedQuery.current)}
        />
      ) : !error ? (
        <Panel className="p-5 text-sm text-muted-foreground">
          Loading retained workforce evidence…
        </Panel>
      ) : null}
    </section>
  );
}
