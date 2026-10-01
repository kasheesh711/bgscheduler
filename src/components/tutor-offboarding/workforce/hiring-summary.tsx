"use client";
import { useState } from "react";
import { scaleLinear } from "d3";
import type { GrowthReport } from "@/lib/tutor-offboarding/workforce/growth/types";
import { ChartPanel, INK, LinesChart } from "./charts";
import { formatMetric, monthLabel, metricReason } from "./presentation";

const number = (value: number | null | undefined) =>
  value == null
    ? "Unavailable"
    : new Intl.NumberFormat("en", { maximumFractionDigits: 2 }).format(value);

export function HiringSummary({
  report,
  month,
  course,
  onCourse,
  onMonth,
  onEditAssumptions,
}: {
  report: GrowthReport;
  month: string;
  course: string;
  onCourse: (key: string) => void;
  onMonth: (month: string) => void;
  onEditAssumptions: () => void;
}) {
  const [showAll, setShowAll] = useState(false);
  const rows = report.forecast.hiring
    .filter((r) => r.month === month)
    .sort(
      (a, b) =>
        (b.extraWeeklyHours.value ?? -1) - (a.extraWeeklyHours.value ?? -1),
    );
  const chosen = rows.find((r) => r.courseKey === course);
  const input = report.forecast.inputs.find((r) => r.courseKey === course);
  const forecast = report.forecast.months.find(
    (r) => r.courseKey === course && r.month === month,
  );
  const total = report.forecast.allocations.find((r) => r.month === month);
  const width = scaleLinear()
    .domain([0, Math.max(1, ...rows.map((r) => r.extraWeeklyHours.value ?? 0))])
    .range([0, 100]);
  const monthIndex = (m: string) =>
    Number(m.slice(0, 4)) * 12 + Number(m.slice(5, 7));
  const steps = month
    ? monthIndex(month) - monthIndex(report.forecast.baseMonth)
    : 0;
  const window = report.flows.commonWindow.map(monthLabel).join(" · ");
  const incompleteCourses = report.forecast.inputs.filter((r) =>
    [
      r.baseStudentHours,
      r.newStudentHours,
      r.reactivatedStudentHours,
      r.churnStudentHours,
      r.cancellationFraction,
      r.studentHoursPerTutorHour,
    ].some((v) => v.value === null),
  ).length;
  return (
    <div className="space-y-4">
      <ChartPanel
        title="Where do we need more tutors?"
        subtitle={`${month ? monthLabel(month) : "Projection unavailable"} · extra hours per week at the times students need`}
      >
        <div className="mb-5 flex flex-wrap items-baseline gap-x-3 gap-y-1 border-b pb-4">
          <strong className="text-3xl tabular-nums">
            {total?.bufferedAdditionalWeeklyHours.value != null
              ? formatMetric(total.bufferedAdditionalWeeklyHours, "h/week")
              : rows.filter((r) => (r.extraWeeklyHours.value ?? 0) > 0).length}
          </strong>
          <span className="text-sm text-muted-foreground">
            {total?.bufferedAdditionalWeeklyHours.value != null
              ? "additional tutor availability across BeGifted"
              : "courses with extra hours needed · total awaits complete data"}
          </span>
          {total?.bufferedAdditionalWeeklyHours.completeness === "partial" && (
            <span className="text-xs text-amber-700 dark:text-amber-300">
              Estimate from partial records
            </span>
          )}
        </div>
        {incompleteCourses > 0 && (
          <div className="mb-4 rounded-lg bg-amber-50/60 p-3 text-sm dark:bg-amber-900/15">
            <strong>
              {incompleteCourses} course
              {incompleteCourses === 1 ? " still needs" : "s still need"} a
              growth assumption.
            </strong>{" "}
            Their gaps use scheduled classes only.{" "}
            <button
              onClick={onEditAssumptions}
              className="text-primary underline underline-offset-4"
            >
              Review assumptions
            </button>
          </div>
        )}
        <div
          role="group"
          aria-label="Extra weekly availability needed by course"
          className="space-y-1"
        >
          {(showAll ? rows : rows.slice(0, 8)).map((row) => (
            <button
              key={row.courseKey}
              onClick={() => onCourse(row.courseKey)}
              aria-pressed={row.courseKey === course}
              className={`grid w-full grid-cols-[minmax(100px,1fr)_minmax(70px,1.5fr)_80px] items-center gap-3 rounded-lg px-3 py-3 text-left text-sm hover:bg-muted/40 ${row.courseKey === course ? "bg-primary/5 ring-1 ring-primary/25" : ""}`}
            >
              <span>
                <strong className="block font-medium">
                  {row.subject ?? "Course"}
                </strong>
                <span className="block text-xs text-muted-foreground">
                  {[row.curriculum, row.level].filter(Boolean).join(" · ") ||
                    "Level not yet recorded"}
                </span>
              </span>
              <span className="h-3 rounded-full bg-muted">
                <span
                  className="block h-3 rounded-full"
                  style={{
                    width: `${width(row.extraWeeklyHours.value ?? 0)}%`,
                    background: INK.supply,
                  }}
                />
              </span>
              <span className="text-right tabular-nums">
                {row.extraWeeklyHours.value === null
                  ? "Needs data"
                  : `${number(row.extraWeeklyHours.value)} h`}
              </span>
            </button>
          ))}
        </div>
        {!rows.length && (
          <p className="text-sm text-muted-foreground">
            No course forecast matches these filters.
          </p>
        )}
        {rows.length > 8 && (
          <button
            className="mt-3 text-sm text-primary"
            onClick={() => setShowAll(!showAll)}
          >
            {showAll
              ? "Show largest shortages"
              : `Show all ${rows.length} courses`}
          </button>
        )}
        <p className="mt-4 text-xs text-muted-foreground">
          Subject estimates share tutors. The BeGifted total counts each tutor’s
          availability once.
        </p>
      </ChartPanel>
      {chosen && (
        <div className="rounded-xl border bg-card p-5">
          <p className="mb-4 text-sm font-medium">
            {[chosen.subject, chosen.curriculum, chosen.level]
              .filter(Boolean)
              .join(" · ")}{" "}
            · hiring estimate
          </p>
          <div className="flex flex-wrap items-center gap-4 text-center">
            <div>
              <strong className="block text-2xl">
                {formatMetric(chosen.extraWeeklyHours)}
              </strong>
              <span className="text-xs text-muted-foreground">
                hours short / week
              </span>
            </div>
            <span className="text-xl text-muted-foreground">÷</span>
            <div>
              <strong className="block text-2xl">
                {formatMetric(chosen.averageMatchingWeeklyHours)}
              </strong>
              <span className="text-xs text-muted-foreground">
                matching hours / tutor
              </span>
            </div>
            <span className="text-xl text-muted-foreground">=</span>
            <div>
              <strong className="block text-2xl text-primary">
                {formatMetric(chosen.tutorEquivalents)}
              </strong>
              <span className="text-xs text-muted-foreground">
                tutor equivalents
              </span>
            </div>
            <span className="rounded-lg bg-primary/5 px-4 py-3 text-sm">
              Rounded up:{" "}
              <strong>{formatMetric(chosen.roundedHiringEstimate)}</strong>{" "}
              tutors
            </span>
          </div>
          <p className="mt-4 text-xs text-muted-foreground">
            {chosen.knownAvailabilityTutors} of {chosen.eligibleTutors}{" "}
            comparable tutors have recorded schedules. Average total offered:{" "}
            {formatMetric(chosen.averageOfferedWeeklyHours, "h/week")}.
          </p>
          {report.forecast.bufferPercent > 0 && (
            <p className="mt-2 text-sm">
              With {report.forecast.bufferPercent}% spare capacity:{" "}
              <strong>
                {formatMetric(chosen.bufferedRoundedHiringEstimate)} tutors
              </strong>
              .
            </p>
          )}
          <details className="mt-4 border-t pt-3 text-sm">
            <summary className="cursor-pointer font-medium">
              How calculated · step by step
            </summary>
            <ol className="mt-4 list-decimal space-y-3 pl-5">
              <li>
                Start with{" "}
                <strong>
                  {number(input?.baseStudentHours.value)} student-hours
                </strong>{" "}
                booked in {monthLabel(report.forecast.baseMonth)}.
              </li>
              <li>
                Each month add{" "}
                <strong>{number(input?.newStudentHours.value)} new</strong> +{" "}
                <strong>
                  {number(input?.reactivatedStudentHours.value)} returning
                </strong>{" "}
                − <strong>{number(input?.churnStudentHours.value)} lost</strong>{" "}
                student-hours. These monthly averages use{" "}
                {window || "an unavailable observation window"}.
              </li>
              <li>
                After {steps} month{steps === 1 ? "" : "s"}:{" "}
                <strong>
                  {formatMetric(
                    forecast?.bookedStudentHours,
                    "booked student-hours",
                  )}
                </strong>
                . Allow for recorded cancellations and refunds (
                {number(
                  input?.cancellationFraction.value == null
                    ? null
                    : input.cancellationFraction.value * 100,
                )}
                %) →{" "}
                <strong>
                  {formatMetric(
                    forecast?.creditStudentHours,
                    "credit-consumed student-hours",
                  )}
                </strong>
                .
                {forecast?.bookedStudentHours.value === null &&
                  " Growth remains unavailable until the missing assumptions are supplied; the displayed shortage uses scheduled classes only."}
              </li>
              <li>
                Divide by the observed class mix (
                {number(input?.studentHoursPerTutorHour.value)} student-hours
                per tutor-hour) →{" "}
                <strong>
                  {formatMetric(forecast?.creditTutorHours, "tutor-hours")}
                </strong>
                . Retain any greater requirement from classes already scheduled.
              </li>
              <li>
                Match that demand to qualified tutors at the required times.
                Each tutor’s time can serve one class. The remaining gap is{" "}
                <strong>
                  {formatMetric(chosen.extraWeeklyHours, "h/week")}
                </strong>
                .
              </li>
              <li>
                Divide the gap by comparable tutors’ offered hours that match
                those shortage times. Round up only after showing the fractional
                estimate.
              </li>
            </ol>
            <p className="mt-3 text-xs text-muted-foreground">
              {metricReason(chosen.tutorEquivalents)}
            </p>
          </details>
        </div>
      )}
      <details className="rounded-xl border bg-card p-4">
        <summary className="cursor-pointer text-sm font-medium">
          Twelve-month outlook · selected course
        </summary>
        <div className="mt-4">
          <LinesChart
            rows={report.forecast.months
              .filter((r) => r.courseKey === course)
              .map((r) => ({ month: r.month, gap: r.additionalWeeklyHours }))}
            series={[{ key: "gap", label: "Extra h/week", color: INK.supply }]}
            label="Projected extra weekly tutor availability over twelve months"
            unit="h/week"
            selectedMonth={month}
            onSelect={onMonth}
          />
        </div>
      </details>
    </div>
  );
}
