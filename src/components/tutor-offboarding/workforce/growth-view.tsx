"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import type { WorkforceQuery } from "@/lib/tutor-offboarding/workforce/types";
import type {
  GrowthAssumptions,
  GrowthDrilldown,
  GrowthExportSection,
  GrowthReport,
  GrowthSubjectOverrides,
} from "@/lib/tutor-offboarding/workforce/growth/types";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Panel, Tag } from "../atoms";
import { ChartPanel, INK, LinesChart } from "./charts";
import {
  AveragesChart,
  GrowthFlowChart,
  GrowthGapChart,
  HiringChart,
  type GrowthSelection,
} from "./growth-charts";
import {
  fetchGrowthDetail,
  fetchGrowthExport,
  fetchGrowthReport,
} from "./growth-requests";
import { LatestRequest, WorkforceRequestError } from "./requests";
import { EvidenceIssueSummary } from "./evidence-issue-summary";
import {
  bangkokTime,
  formatMetric,
  metricReason,
  monthLabel,
} from "./presentation";
export function growthFilters(filters: WorkforceQuery): WorkforceQuery {
  return { ...filters, role: "all", modality: "all" };
}
const OVERRIDES = [
  ["newStudentHours", "Monthly new student-hours"],
  ["reactivatedStudentHours", "Monthly reactivated student-hours"],
  ["churnStudentHours", "Monthly soft churn loss · student-hours"],
  ["cancellationFraction", "Cancellation / refund fraction · 0–1"],
  ["studentHoursPerTutorHour", "Student-hours per tutor-hour"],
] as const;
export function updateCourseOverride(
  current: GrowthAssumptions,
  courseKey: string,
  key: keyof GrowthSubjectOverrides,
  value: string,
): GrowthAssumptions {
  const subjects = { ...current.subjects },
    overrides = { ...subjects[courseKey] };
  if (value === "") delete overrides[key];
  else overrides[key] = Number(value);
  if (Object.keys(overrides).length) subjects[courseKey] = overrides;
  else delete subjects[courseKey];
  return { ...current, subjects };
}
export function GrowthView({
  filters,
  initial,
}: {
  filters: WorkforceQuery;
  initial?: GrowthReport;
}) {
  const [report, setReport] = useState<GrowthReport | null>(initial ?? null),
    [error, setError] = useState<string | null>(null),
    [busy, setBusy] = useState(false),
    [course, setCourse] = useState(""),
    [forecastMonth, setForecastMonth] = useState(""),
    [draft, setDraft] = useState<GrowthAssumptions>(
      initial?.query.assumptions ?? { bufferPercent: 0 },
    ),
    [selection, setSelection] = useState<GrowthSelection | null>(null),
    [detail, setDetail] = useState<GrowthDrilldown | null>(null),
    [detailBusy, setDetailBusy] = useState(false),
    [detailError, setDetailError] = useState<string | null>(null),
    [exportSection, setExportSection] =
      useState<GrowthExportSection>("forecast"),
    [exporting, setExporting] = useState(false);
  const gate = useRef(new LatestRequest()),
    detailGate = useRef(new LatestRequest()),
    exportGate = useRef(new LatestRequest());
  const stableFilters = JSON.stringify(growthFilters(filters));
  const load = useCallback(
    async (assumptions: GrowthAssumptions, measured = false) => {
      const ticket = gate.current.begin();
      setBusy(true);
      setError(null);
      try {
        const next = await fetchGrowthReport(
          { filters: JSON.parse(stableFilters), assumptions },
          ticket.signal,
          measured,
        );
        if (!gate.current.isCurrent(ticket))
          throw new DOMException("Superseded scenario", "AbortError");
        setReport(next);
        setDraft(next.query.assumptions);
        return next;
      } catch (failure) {
        if (gate.current.isCurrent(ticket))
          setError(
            failure instanceof Error
              ? failure.message
              : "Growth evidence could not load.",
          );
        throw failure;
      } finally {
        if (gate.current.isCurrent(ticket)) setBusy(false);
      }
    },
    [stableFilters],
  );
  useEffect(() => {
    setSelection(null);
    setDetail(null);
    setDetailBusy(false);
    setExporting(false);
    if (
      !initial ||
      JSON.stringify(growthFilters(initial.query.filters)) !== stableFilters
    )
      void load({ bufferPercent: 0 }, true).catch(() => {});
    const requestGate = gate.current,
      details = detailGate.current,
      exports = exportGate.current;
    return () => {
      requestGate.cancel();
      details.cancel();
      exports.cancel();
    };
  }, [stableFilters, initial, load]);
  const courses = report
    ? [
        ...new Map(
          [
            ...report.flows.averages,
            ...report.flows.months,
            ...report.forecast.inputs,
          ].map((r) => [r.courseKey, r]),
        ).values(),
      ]
    : [];
  const selectedCourse =
    courses.find((c) => c.courseKey === course)?.courseKey ??
    courses[0]?.courseKey ??
    "";
  const selectedLabel = courses.find((c) => c.courseKey === selectedCourse);
  const months = report
    ? [...new Set(report.forecast.months.map((m) => m.month))].sort()
    : [];
  const selectedMonth = months.includes(forecastMonth)
    ? forecastMonth
    : (months[0] ?? "");
  const refreshedAction = async <T,>(
    action: (current: GrowthReport) => Promise<T>,
  ): Promise<T> => {
    if (!report) throw new Error("Load growth evidence first.");
    try {
      return await action(report);
    } catch (failure) {
      if (!(failure instanceof WorkforceRequestError) || failure.status !== 409)
        throw failure;
      const fresh = await load(report.query.assumptions);
      return action(fresh);
    }
  };
  const openDetail = async (selected: GrowthSelection, cursor?: string) => {
    setSelection(selected);
    if (!cursor) setDetail(null);
    setDetailBusy(true);
    setDetailError(null);
    const ticket = detailGate.current.begin();
    try {
      const next = await refreshedAction((current) =>
        fetchGrowthDetail(
          {
            ...current.query,
            reportRevision: current.reportRevision,
            kind: selected.kind,
            key: selected.key,
            ...(cursor ? { cursor } : {}),
          },
          ticket.signal,
        ),
      );
      if (!detailGate.current.isCurrent(ticket)) return;
      setDetail((previous) =>
        cursor && previous && previous.reportRevision === next.reportRevision
          ? {
              ...next,
              sessions: [
                ...new Map(
                  [...previous.sessions, ...next.sessions].map((s) => [
                    s.wiseSessionId,
                    s,
                  ]),
                ).values(),
              ],
              events: [
                ...new Map(
                  [...previous.events, ...next.events].map((e) => [
                    e.eventKey,
                    e,
                  ]),
                ).values(),
              ],
              observations: [
                ...new Map(
                  [...previous.observations, ...next.observations].map((o) => [
                    o.id,
                    o,
                  ]),
                ).values(),
              ],
            }
          : next,
      );
    } catch (failure) {
      if (detailGate.current.isCurrent(ticket))
        setDetailError(
          failure instanceof Error
            ? failure.message
            : "Evidence could not load.",
        );
    } finally {
      if (detailGate.current.isCurrent(ticket)) setDetailBusy(false);
    }
  };
  const exportCsv = async () => {
    setExporting(true);
    setError(null);
    const ticket = exportGate.current.begin();
    try {
      const blob = await refreshedAction((current) =>
        fetchGrowthExport(
          current.query,
          current.reportRevision,
          exportSection,
          ticket.signal,
        ),
      );
      if (exportGate.current.isCurrent(ticket)) {
        const url = URL.createObjectURL(blob);
        const link = document.createElement("a");
        link.href = url;
        link.download = `tutor-growth-${exportSection}.csv`;
        link.click();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
      }
    } catch (failure) {
      if (exportGate.current.isCurrent(ticket))
        setError(
          failure instanceof Error ? failure.message : "Export could not load.",
        );
    } finally {
      if (exportGate.current.isCurrent(ticket)) setExporting(false);
    }
  };
  const input = report?.forecast.inputs.find(
      (r) => r.courseKey === selectedCourse,
    ),
    overrideCount = Object.values(
      report?.query.assumptions.subjects ?? {},
    ).reduce((n, s) => n + Object.keys(s).length, 0);
  const onSelect = (s: GrowthSelection) => {
    if (!busy && !exporting) void openDetail(s);
  };
  return (
    <div className="space-y-4" aria-busy={busy}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap gap-2">
          <Tag>All teaching staff · all modes</Tag>
          {report && (
            <Tag tone={overrideCount ? "amber" : "neutral"}>
              {overrideCount
                ? `${overrideCount} explicit overrides`
                : "Measured model"}
            </Tag>
          )}
          <span className="self-center text-xs text-muted-foreground">
            {report
              ? `Updated ${bangkokTime(report.generatedAt)}`
              : "Three-month model · twelve-month projection"}
          </span>
        </div>
        <div className="flex items-center gap-2">
          <select
            aria-label="Growth export section"
            value={exportSection}
            onChange={(e) =>
              setExportSection(e.target.value as GrowthExportSection)
            }
            className="rounded border bg-background p-2 text-xs"
          >
            {["months", "averages", "forecast", "gaps"].map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
          <Button
            variant="outline"
            size="sm"
            onClick={() => void exportCsv()}
            disabled={!report || busy || exporting}
          >
            {exporting ? "Preparing…" : "Export growth CSV"}
          </Button>
        </div>
      </div>
      {error && (
        <p
          role="alert"
          className="rounded border border-conflict/30 p-3 text-sm text-conflict"
        >
          {error}
          {report ? " Previous scenario remains visible." : ""}
        </p>
      )}
      {busy && (
        <p role="status" className="text-xs text-muted-foreground">
          Loading growth evidence. Displayed values remain the previous
          scenario.
        </p>
      )}
      {!report && !busy && (
        <Panel className="p-5">
          <p className="text-sm">Growth evidence is unavailable.</p>
          <Button
            variant="outline"
            className="mt-3"
            onClick={() =>
              void load({ bufferPercent: 0 }, true).catch(() => {})
            }
          >
            Retry measured model
          </Button>
        </Panel>
      )}
      {report && (
        <>
          <div className="flex flex-wrap items-center gap-3">
            <label className="text-xs">
              Course{" "}
              <select
                aria-label="Growth course"
                value={selectedCourse}
                onChange={(e) => {
                  setCourse(e.target.value);
                  setSelection(null);
                  detailGate.current.cancel();
                }}
                className="mt-1 block max-w-full rounded border bg-background p-2 sm:ml-2 sm:mt-0 sm:inline-block"
              >
                {courses.map((c) => (
                  <option key={c.courseKey} value={c.courseKey}>
                    {[c.subject, c.curriculum, c.level]
                      .filter(Boolean)
                      .join(" · ")}
                  </option>
                ))}
              </select>
            </label>
            <label className="text-xs">
              Projection month{" "}
              <select
                aria-label="Projection month"
                className="ml-2 rounded border bg-background p-2"
                value={selectedMonth}
                onChange={(e) => setForecastMonth(e.target.value)}
              >
                {months.map((m) => (
                  <option key={m} value={m}>
                    {monthLabel(m)}
                  </option>
                ))}
              </select>
            </label>
            <span className="text-xs text-muted-foreground">
              {report.quality.completeness} evidence ·{" "}
              {report.forecast.bufferPercent}% buffer
            </span>
          </div>
          <div className="grid items-start gap-4 xl:grid-cols-[1.7fr_1fr]">
            <GrowthFlowChart
              rows={report.flows.months.filter(
                (r) => r.courseKey === selectedCourse,
              )}
              onSelect={onSelect}
            />
            <AveragesChart
              row={report.flows.averages.find(
                (r) => r.courseKey === selectedCourse,
              )}
            />
          </div>
          <ChartPanel
            title={`Twelve-month projection · ${selectedLabel?.subject ?? "course"}`}
            subtitle={`Tutor-hours / month · base ${monthLabel(report.forecast.baseMonth)} · scenario estimate`}
          >
            <LinesChart
              label="Projected booked and credit-adjusted tutor-hours, flat demand and current commitments"
              selectedMonth={selectedMonth}
              onSelect={setForecastMonth}
              rows={report.forecast.months
                .filter((r) => r.courseKey === selectedCourse)
                .map((r) => ({
                  month: r.month,
                  booked: r.bookedTutorHours,
                  credit: r.creditTutorHours,
                  committed: r.knownCommittedTutorHours,
                  flat: {
                    ...r.flatStudentHours,
                    value:
                      input?.studentHoursPerTutorHour.value &&
                      r.flatStudentHours.value !== null
                        ? r.flatStudentHours.value /
                          input.studentHoursPerTutorHour.value
                        : null,
                  },
                }))}
              series={[
                { key: "booked", label: "Booked forecast", color: INK.supply },
                { key: "credit", label: "Credit-adjusted", color: INK.credit },
                {
                  key: "committed",
                  label: "Commitments",
                  color: INK.actual,
                  dash: "4 3",
                },
                {
                  key: "flat",
                  label: "Flat demand",
                  color: "#8a8291",
                  dash: "2 4",
                },
              ]}
            />
            {input &&
              [
                ...OVERRIDES.map(([k]) => input[k]),
                input.baseStudentHours,
              ].some((v) => v.value === null) && (
                <p className="mt-3 rounded border border-amber-300/40 p-3 text-xs text-amber-800 dark:text-amber-200">
                  Automatic forecast unavailable:{" "}
                  {OVERRIDES.filter(([k]) => input[k].value === null)
                    .map(([, l]) => l)
                    .join(", ") || "starting demand"}
                  . Enter explicit assumptions below or review missing source
                  evidence.
                </p>
              )}
            <details className="mt-3 text-xs">
              <summary className="cursor-pointer text-muted-foreground">
                View forecast data & flat comparison
              </summary>
              <div className="overflow-x-auto">
                <table className="mt-3 w-full min-w-[700px] text-left">
                  <thead>
                    <tr>
                      {[
                        "Month",
                        "Booked tutor h",
                        "Credit tutor h",
                        "Current commitments h",
                        "Required capacity h",
                        "Flat student h",
                        "Extra h/week",
                      ].map((l) => (
                        <th className="p-2" key={l}>
                          {l}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {report.forecast.months
                      .filter((r) => r.courseKey === selectedCourse)
                      .map((r) => (
                        <tr key={r.key} className="border-t">
                          <th className="p-2">{monthLabel(r.month)}</th>
                          {[
                            r.bookedTutorHours,
                            r.creditTutorHours,
                            r.knownCommittedTutorHours,
                            r.capacityRequiredTutorHours,
                            r.flatStudentHours,
                            r.bufferedAdditionalWeeklyHours,
                          ].map((m, i) => (
                            <td key={i} className="p-2" title={metricReason(m)}>
                              {formatMetric(m)}
                            </td>
                          ))}
                        </tr>
                      ))}
                  </tbody>
                </table>
              </div>
            </details>
          </ChartPanel>
          <div className="flex flex-wrap items-baseline justify-between gap-3 rounded border bg-primary/5 px-5 py-3">
            <p className="text-sm font-medium">
              Shared overall additional availability ·{" "}
              {selectedMonth
                ? monthLabel(selectedMonth)
                : "Projection unavailable"}
            </p>
            <strong className="text-xl tabular-nums">
              {formatMetric(
                report.forecast.allocations.find(
                  (a) => a.month === selectedMonth,
                )?.bufferedAdditionalWeeklyHours,
                "h/week",
              )}
            </strong>
            {report.forecast.allocations.find((a) => a.month === selectedMonth)
              ?.bufferedAdditionalWeeklyHours.completeness === "partial" && (
              <Tag tone="amber">Partial</Tag>
            )}
            <p className="w-full text-xs text-muted-foreground">
              One physical tutor pool. This overall gap is calculated
              independently; course hiring estimates overlap.
            </p>
          </div>
          <GrowthGapChart
            cells={
              report.forecast.allocations
                .find((a) => a.month === selectedMonth)
                ?.cells.filter((c) => c.courseKey === selectedCourse) ?? []
            }
            onSelect={onSelect}
          />
          <HiringChart
            rows={report.forecast.hiring.filter(
              (r) => r.month === selectedMonth,
            )}
          />
          <details className="rounded-[10px] border bg-card p-4">
            <summary className="cursor-pointer text-sm font-semibold">
              Model assumptions & sources
            </summary>
            <form
              className="mt-4 space-y-4"
              onSubmit={(e) => {
                e.preventDefault();
                void load(draft).catch(() => {});
              }}
            >
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {OVERRIDES.map(([key, label]) => (
                  <label key={key} className="text-xs">
                    {label}
                    <input
                      aria-label={label}
                      type="number"
                      min={key === "studentHoursPerTutorHour" ? 0.001 : 0}
                      max={key === "cancellationFraction" ? 1 : undefined}
                      step="any"
                      placeholder={String(
                        input?.[key].measured.value ?? "Unavailable",
                      )}
                      value={draft.subjects?.[selectedCourse]?.[key] ?? ""}
                      onChange={(e) =>
                        setDraft((current) =>
                          updateCourseOverride(
                            current,
                            selectedCourse,
                            key,
                            e.target.value,
                          ),
                        )
                      }
                      className="mt-1 block w-full rounded border bg-background p-2"
                    />
                    <span className="mt-1 block text-muted-foreground">
                      Measured: {formatMetric(input?.[key].measured)} ·{" "}
                      {input?.[key].source ?? "unavailable"}
                    </span>
                  </label>
                ))}
                <label className="text-xs">
                  Spare-capacity buffer %
                  <input
                    aria-label="Spare-capacity buffer percent"
                    type="number"
                    min="0"
                    max="100"
                    value={draft.bufferPercent}
                    onChange={(e) =>
                      setDraft((current) => ({
                        ...current,
                        bufferPercent: Number(e.target.value),
                      }))
                    }
                    className="mt-1 block w-full rounded border bg-background p-2"
                  />
                </label>
              </div>
              <div className="flex gap-2">
                <Button
                  size="sm"
                  type="submit"
                  disabled={busy || exporting || !selectedCourse}
                >
                  Apply scenario
                </Button>
                <Button
                  size="sm"
                  type="button"
                  variant="outline"
                  disabled={busy || exporting}
                  onClick={() =>
                    void load({ bufferPercent: 0 }, true).catch(() => {})
                  }
                >
                  Reset to measured model
                </Button>
              </div>
            </form>
            <div className="mt-4 space-y-2 text-xs text-muted-foreground">
              <p>
                Booked student-hours at month k = max(0, base + k × (new +
                reactivated − soft churn)). Apply the cancellation/refund
                fraction once, then divide by the observed group mix to obtain
                tutor-hours.
              </p>
              <p>
                A 20% buffer adds 20% to the minimum additional availability.
                Future commitments are covered when they exceed the model.
                Offered availability and academic qualifications are assumed to
                continue.
              </p>
              {report.forecast.assumptions.map((a, i) => (
                <p key={i}>{a}</p>
              ))}
              {report.quality.issueCodes.map((c, i) => (
                <p key={i}>{c.replaceAll("_", " ")}</p>
              ))}
              <p>
                Benchmark: current qualified tutors and teaching admins with
                known offered availability, excluding departure marks. Matching
                hours overlap shortage times. Course estimates must not be
                summed.
              </p>
              {report.quality.sourceCoverage.map((s, i) => (
                <p key={i}>
                  {s.source} · {s.completeness} · observed{" "}
                  {bangkokTime(s.observedAt ?? "")}
                </p>
              ))}
            </div>
          </details>
        </>
      )}
      <Dialog
        open={selection !== null}
        onOpenChange={(open) => {
          if (!open) {
            detailGate.current.cancel();
            setSelection(null);
            setDetail(null);
          }
        }}
      >
        <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-[700px]">
          <DialogTitle>{selection?.title ?? "Growth evidence"}</DialogTitle>
          <DialogDescription>
            Contributing bookings, lifecycle events and retained source
            evidence.
          </DialogDescription>
          {detailBusy && <p role="status">Loading evidence…</p>}
          {detailError && (
            <p role="alert" className="text-sm text-conflict">
              {detailError}
            </p>
          )}
          {detail && (
            <div className="space-y-4 text-xs">
              <p>
                {detail.contributors.studentIds.length} students ·{" "}
                {detail.contributors.sessionIds.length} bookings ·{" "}
                {detail.contributors.eventKeys.length} events
              </p>
              <div className="divide-y">
                {detail.sessions.map((s) => (
                  <div key={s.wiseSessionId} className="py-3">
                    <p className="font-semibold">
                      {s.classTitle ?? "Class title unavailable"}
                    </p>
                    <p>
                      {bangkokTime(s.startAt)} · {s.scheduledMinutes} minutes ·{" "}
                      {s.attendanceStatus ?? "Attendance unavailable"}
                    </p>
                    <p>
                      {s.completeness} · {s.reasonCodes.join(", ")}
                    </p>
                  </div>
                ))}
              </div>
              {detail.events.map((e) => (
                <div key={e.eventKey} className="rounded border p-3">
                  <p>
                    {e.kind} · effective {monthLabel(e.effectiveMonth)} ·{" "}
                    {e.certainty}
                  </p>
                  <p>
                    Confirmed {bangkokTime(e.confirmedAt)} · baseline{" "}
                    {e.baselineMonths.map(monthLabel).join(", ")}:{" "}
                    {formatMetric(e.baselineStudentHours, "student-hours")}
                  </p>
                </div>
              ))}
              <EvidenceIssueSummary issues={detail.exceptions} />
              {detail.nextCursor && (
                <Button
                  variant="outline"
                  size="sm"
                  disabled={detailBusy}
                  onClick={() =>
                    selection && void openDetail(selection, detail.nextCursor!)
                  }
                >
                  Load more evidence
                </Button>
              )}
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
