"use client";
import { useState } from "react";
import type {
  WorkforceReport,
  WorkforceSubjectRow,
  WorkforceWeekCell,
} from "@/lib/tutor-offboarding/workforce/types";
import { ChartPanel, INK, LinesChart } from "./charts";
import {
  formatMetric,
  monthLabel,
  metricReason,
  creditCoverageSummary,
} from "./presentation";
import { SubjectMatrix } from "./subject-matrix";
import { WeekHeatmap } from "./week-heatmap";
import { GrowthView } from "./growth-view";

export function DemandView({
  report,
  onSelect,
  onWeekSelect,
}: {
  report: WorkforceReport;
  onSelect: (row: WorkforceSubjectRow) => void;
  onWeekSelect: (row: WorkforceWeekCell) => void;
}) {
  const [subject, setSubject] = useState("");
  const [curriculum, setCurriculum] = useState("");
  const [level, setLevel] = useState("");
  const [view, setView] = useState<"total" | "change">("total");
  const choices = [
    ...new Map(
      report.subjects
        .filter((r) => r.depth === 0 && r.subject !== "Unmapped")
        .sort((a, b) => (b.bookedHours.value ?? 0) - (a.bookedHours.value ?? 0))
        .map((r) => [r.subject, r]),
    ).values(),
  ];
  const selected = choices.some((r) => r.subject === subject)
    ? subject
    : (choices[0]?.subject ?? "");
  const curricula = [
    ...new Set(
      report.subjects
        .filter((r) => r.subject === selected && r.depth === 1)
        .map((r) => r.curriculum)
        .filter((v): v is string => Boolean(v)),
    ),
  ];
  const levels = [
    ...new Set(
      report.subjects
        .filter(
          (r) =>
            r.subject === selected &&
            r.curriculum === curriculum &&
            r.depth === 2,
        )
        .map((r) => r.level)
        .filter((v): v is string => Boolean(v)),
    ),
  ];
  const activeCurriculum = curricula.includes(curriculum) ? curriculum : "";
  const activeLevel = activeCurriculum && levels.includes(level) ? level : "";
  const depth = activeLevel ? 2 : activeCurriculum ? 1 : 0;
  const rows = report.subjects.filter(
    (r) =>
      r.subject === selected &&
      r.depth === depth &&
      (!activeCurriculum || r.curriculum === activeCurriculum) &&
      (!activeLevel || r.level === activeLevel),
  );
  const month = rows.find((r) => r.month === report.query.viewMonth);
  const unmapped = report.subjects.find(
    (r) =>
      r.depth === 0 &&
      r.subject === "Unmapped" &&
      r.month === report.query.viewMonth,
  );
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h3 className="text-lg font-semibold">What demand is changing?</h3>
          <p className="text-sm text-muted-foreground">
            Choose a subject, then narrow to a curriculum and level.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <select
            aria-label="Demand subject"
            value={selected}
            onChange={(e) => {
              setSubject(e.target.value);
              setCurriculum("");
              setLevel("");
            }}
            className="rounded-md border bg-background px-3 py-2 text-sm"
          >
            {choices.map((r) => (
              <option key={r.subject}>{r.subject}</option>
            ))}
          </select>
          <select
            aria-label="Demand curriculum"
            value={activeCurriculum}
            onChange={(e) => {
              setCurriculum(e.target.value);
              setLevel("");
            }}
            className="rounded-md border bg-background px-3 py-2 text-sm"
          >
            <option value="">All curricula</option>
            {curricula.map((c) => (
              <option key={c}>{c}</option>
            ))}
          </select>
          <select
            aria-label="Demand level"
            value={activeLevel}
            disabled={!activeCurriculum}
            onChange={(e) => setLevel(e.target.value)}
            className="rounded-md border bg-background px-3 py-2 text-sm disabled:opacity-50"
          >
            <option value="">All levels</option>
            {levels.map((l) => (
              <option key={l}>{l}</option>
            ))}
          </select>
        </div>
      </div>
      <div
        className="flex gap-1 rounded-lg bg-muted/50 p-1 w-fit"
        aria-label="Demand view"
      >
        <button
          aria-pressed={view === "total"}
          onClick={() => setView("total")}
          className={`rounded-md px-4 py-2 text-sm ${view === "total" ? "bg-background shadow-sm" : "text-muted-foreground"}`}
        >
          Total demand
        </button>
        <button
          aria-pressed={view === "change"}
          onClick={() => setView("change")}
          className={`rounded-md px-4 py-2 text-sm ${view === "change" ? "bg-background shadow-sm" : "text-muted-foreground"}`}
        >
          New &amp; lost demand
        </button>
      </div>
      {view === "total" ? (
        <ChartPanel
          title={`${selected || "Subject"} demand over time`}
          subtitle="Tutor-hours per month · a group class uses one tutor’s time"
        >
          <div className="mb-5 grid grid-cols-3 gap-3 border-b pb-4">
            {[
              ["Booked hours", month?.bookedHours, "h"],
              ["Credit-consumed", month?.creditConsumedHours, "h"],
              ["Students", month?.uniqueStudents, ""],
            ].map(([label, value, unit]) => {
              const metric = value as
                | WorkforceSubjectRow["bookedHours"]
                | undefined;
              return (
                <div key={String(label)}>
                  <p className="text-xs text-muted-foreground">
                    {String(label)} · {monthLabel(report.query.viewMonth)}
                  </p>
                  <strong className="mt-1 block text-xl tabular-nums">
                    {formatMetric(metric, String(unit))}
                  </strong>
                  {metric?.completeness === "partial" && (
                    <span className="text-xs text-amber-700 dark:text-amber-300">
                      Partial records
                    </span>
                  )}
                </div>
              );
            })}
          </div>
          {creditCoverageSummary(month?.creditConsumedHours) && (
            <p className="mb-3 text-xs text-muted-foreground">
              {creditCoverageSummary(month?.creditConsumedHours)}{" "}
              {month?.creditConsumedHours.completeness === "partial"
                ? "The credit figure is a partial estimate."
                : ""}
            </p>
          )}
          <LinesChart
            rows={rows.map((r) => ({
              month: r.month,
              booked: r.bookedHours,
              consumed: r.creditConsumedHours,
            }))}
            series={[
              { key: "booked", label: "Booked", color: INK.supply },
              { key: "consumed", label: "Credit-consumed", color: INK.credit },
            ]}
            label={`${selected} booked and credit-consumed tutor-hours over time`}
            partialMonths={report.months
              .filter((m) => m.partialMonth)
              .map((m) => m.month)}
            selectedMonth={report.query.viewMonth}
            onSelect={(m) => {
              const row = rows.find((r) => r.month === m);
              if (row) onSelect(row);
            }}
          />
          <details className="mt-4 rounded-lg border p-3 text-sm">
            <summary className="cursor-pointer font-medium">
              How calculated
            </summary>
            <ol className="mt-3 list-decimal space-y-2 pl-5">
              <li>
                <strong>{formatMetric(month?.distinctClasses)} classes</strong>{" "}
                total{" "}
                <strong>{formatMetric(month?.bookedHours, "hours")}</strong> of
                booked tutor time. Cancellations and no-shows remain in booked
                demand.
              </li>
              <li>
                <strong>{formatMetric(month?.uniqueStudents)} students</strong>{" "}
                made{" "}
                <strong>
                  {formatMetric(month?.studentBookings)} student bookings
                </strong>
                . A group class counts once for tutor time.
              </li>
              <li>
                One credit is one teaching hour. Net charges after refunds
                determine credit-consumed time; a group uses the average charged
                fraction of its students.
              </li>
              <li className="text-muted-foreground">
                {metricReason(month?.creditConsumedHours)}
              </li>
            </ol>
            {month && (
              <button
                className="mt-3 text-primary underline underline-offset-4"
                onClick={() => onSelect(month)}
              >
                See the classes behind these numbers
              </button>
            )}
          </details>
        </ChartPanel>
      ) : (
        <GrowthView
          sourceUpdatedAt={report.generatedAt}
          filters={{
            ...report.query,
            subject: selected || undefined,
            curriculum: activeCurriculum || undefined,
            level: activeLevel || undefined,
          }}
          display="demand"
        />
      )}
      {unmapped && (unmapped.bookedHours.value ?? 0) > 0 && (
        <button
          onClick={() => onSelect(unmapped)}
          className="w-full rounded-lg border border-amber-200 bg-amber-50/40 px-4 py-3 text-left text-sm dark:border-amber-800 dark:bg-amber-900/10"
        >
          <strong>{formatMetric(unmapped.bookedHours, "h")}</strong> still need
          a subject assignment in {monthLabel(report.query.viewMonth)}.{" "}
          <span className="text-primary">Review classes →</span>
        </button>
      )}
      <details className="rounded-lg border bg-card p-4">
        <summary className="cursor-pointer text-sm font-medium">
          Compare subjects across months
        </summary>
        <div className="mt-3">
          <SubjectMatrix
            rows={report.subjects}
            months={report.months.map((m) => m.month)}
            onSelect={onSelect}
          />
        </div>
      </details>
      <details className="rounded-lg border bg-card p-4">
        <summary className="cursor-pointer text-sm font-medium">
          See weekday and time patterns · dashboard filters
        </summary>
        <div className="mt-3">
          <WeekHeatmap
            cells={report.weekCells}
            month={report.query.viewMonth}
            onSelect={onWeekSelect}
          />
        </div>
      </details>
    </div>
  );
}
