"use client";
import { useId } from "react";
import { scaleBand, scaleLinear, scaleSequential, interpolateRgb } from "d3";
import type {
  GrowthMonthlyRow,
  GrowthSubjectAverages,
  GrowthAllocationCell,
  GrowthHiringEstimate,
  GrowthDetailQuery,
} from "@/lib/tutor-offboarding/workforce/growth/types";
import { activate, ChartPanel, INK, useChartWidth } from "./charts";
import { formatMetric, metricReason, monthLabel } from "./presentation";
import { minuteLabel } from "./week-heatmap";
export type GrowthSelection = {
  kind: GrowthDetailQuery["kind"];
  key: string;
  title: string;
};
export function GrowthFlowChart({
  rows,
  onSelect,
}: {
  rows: GrowthMonthlyRow[];
  onSelect: (selection: GrowthSelection) => void;
}) {
  const { ref, width } = useChartWidth();
  const mobile = width < 480,
    x = scaleBand()
      .domain(rows.map((r) => r.month))
      .range([40, width - 10])
      .padding(0.25);
  const extent = Math.max(
    1,
    ...rows.map((r) =>
      Math.max(
        (r.newStudentHours.value ?? 0) + (r.reactivatedStudentHours.value ?? 0),
        r.churnStudentHours.value ?? 0,
      ),
    ),
  );
  const y = scaleLinear().domain([-extent, extent]).nice().range([220, 25]);
  const zero = y(0);
  return (
    <ChartPanel
      title="New and lost course demand"
      subtitle="Student-hours per month · recent churn remains provisional"
    >
      <div ref={ref}>
        <svg
          width="100%"
          height="260"
          viewBox={`0 0 ${width} 260`}
          role="group"
          aria-label="New and returning demand above zero, lost demand below"
          style={{ fontSize: 11 }}
        >
          {y.ticks(5).map((t) => (
            <g key={t}>
              <line
                x1="40"
                x2={width - 10}
                y1={y(t)}
                y2={y(t)}
                stroke={t === 0 ? INK.actual : INK.grid}
                strokeWidth={t === 0 ? 1 : 0.7}
              />
              <text x="33" y={y(t) + 4} textAnchor="end" fill="currentColor">
                {t < 0 ? `−${Math.abs(t)}` : t}
              </text>
            </g>
          ))}
          {rows.map((r, i) => {
            const newV = r.newStudentHours.value,
              reV = r.reactivatedStudentHours.value,
              churn = r.churnStudentHours.value;
            const start = () =>
                onSelect({
                  kind: "cohort",
                  key: r.key,
                  title: `Starts · ${monthLabel(r.month)}`,
                }),
              lost = () =>
                onSelect({
                  kind: "churn",
                  key: r.key,
                  title: `Lost demand · ${monthLabel(r.month)}`,
                });
            return (
              <g key={r.key}>
                {newV !== null && reV !== null ? (
                  <g
                    role="button"
                    tabIndex={0}
                    aria-label={`${r.startingCohortExcluded ? "Starting cohort · excluded from growth averages. " : ""}${monthLabel(r.month)}: newly observed ${formatMetric(r.newStudentHours, "student-hours")}, reactivated ${formatMetric(r.reactivatedStudentHours, "student-hours")}`}
                    onClick={start}
                    onKeyDown={(e) => activate(e, start)}
                    className="cursor-pointer focus:outline-2 focus:outline-primary"
                  >
                    <rect
                      x={x(r.month)}
                      y={y(newV)}
                      width={x.bandwidth()}
                      height={zero - y(newV)}
                      fill={r.startingCohortExcluded ? INK.actual : INK.supply}
                      stroke={r.startingCohortExcluded ? INK.actual : "none"}
                      strokeDasharray="3 2"
                      rx="2"
                    />
                    <rect
                      x={x(r.month)}
                      y={y(newV + reV)}
                      width={x.bandwidth()}
                      height={y(newV) - y(newV + reV)}
                      fill={INK.credit}
                    />
                    <text
                      x={x(r.month)! + x.bandwidth() / 2}
                      y={y(newV + reV) - 6}
                      textAnchor="middle"
                      fill="currentColor"
                    >
                      {Math.round((newV + reV) * 10) / 10}
                    </text>
                  </g>
                ) : (
                  <text
                    x={x(r.month)! + x.bandwidth() / 2}
                    y="70"
                    textAnchor="middle"
                    fill="currentColor"
                  >
                    ?
                  </text>
                )}
                {churn !== null ? (
                  <g
                    role="button"
                    tabIndex={0}
                    aria-label={`${monthLabel(r.month)}: lost demand ${formatMetric(r.churnStudentHours, "student-hours")}${r.provisional ? ", provisional" : ""}`}
                    onClick={lost}
                    onKeyDown={(e) => activate(e, lost)}
                    className="cursor-pointer focus:outline-2 focus:outline-primary"
                  >
                    <rect
                      x={x(r.month)}
                      y={zero}
                      width={x.bandwidth()}
                      height={y(-churn) - zero}
                      fill={INK.loss}
                      opacity={r.provisional ? 0.45 : 1}
                      stroke={r.provisional ? INK.loss : "none"}
                      strokeDasharray="3 2"
                    />
                    <text
                      x={x(r.month)! + x.bandwidth() / 2}
                      y={y(-churn) + 14}
                      textAnchor="middle"
                      fill={INK.loss}
                    >
                      {formatMetric(r.churnStudentHours)}
                    </text>
                  </g>
                ) : (
                  <text
                    x={x(r.month)! + x.bandwidth() / 2}
                    y={zero + 25}
                    textAnchor="middle"
                    fill="currentColor"
                  >
                    ?
                  </text>
                )}
                {(!mobile ||
                  i % Math.ceil(rows.length / 4) === 0 ||
                  i === rows.length - 1) && (
                  <text
                    x={x(r.month)! + x.bandwidth() / 2}
                    y="251"
                    textAnchor="middle"
                    fill="currentColor"
                  >
                    {monthLabel(r.month).split(" ")[0]}
                    {r.provisional ? "*" : ""}
                  </text>
                )}
              </g>
            );
          })}
          <text x="40" y="14" fill="currentColor">
            Student-hours
          </text>
        </svg>
      </div>
      <div className="flex flex-wrap gap-3 text-xs">
        <span style={{ color: INK.supply }}>■ Newly observed</span>
        <span style={{ color: INK.credit }}>■ Returning</span>
        <span style={{ color: INK.loss }}>■ Lost demand</span>
        <span style={{ color: INK.actual }}>
          ■ Starting cohort · excluded from growth averages
        </span>
        <span className="text-muted-foreground">
          * Provisional · ? Unavailable
        </span>
      </div>
      <details className="mt-3 text-xs">
        <summary className="cursor-pointer text-muted-foreground">
          View data & cohort counts
        </summary>
        <table className="mt-3 w-full text-left">
          <thead>
            <tr>
              {[
                "Month",
                "New",
                "Returning",
                "Lost demand",
                "Trial / pretest h",
              ].map((l) => (
                <th key={l} className="p-2">
                  {l}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.key} className="border-t">
                <th className="p-2">{monthLabel(r.month)}</th>
                {[
                  r.newlyObservedStudents,
                  r.reactivatedStudents,
                  r.churnedStudents,
                ].map((v, i) => (
                  <td key={i} className="p-2">
                    {formatMetric(v)} students
                  </td>
                ))}
                <td className="p-2">
                  {formatMetric(r.trialStudentHours)} /{" "}
                  {formatMetric(r.pretestStudentHours)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="mt-2">
          March starting cohorts are excluded from new-demand averages. Lost
          demand follows 60 days without taught classes and no future subject
          booking.
        </p>
      </details>
    </ChartPanel>
  );
}
export function AveragesChart({ row }: { row?: GrowthSubjectAverages }) {
  const { ref, width } = useChartWidth(380);
  const keys = [
      "newStudentHours",
      "reactivatedStudentHours",
      "churnStudentHours",
    ] as const,
    labels = ["New", "Returning", "Lost demand"],
    colors = [INK.supply, INK.credit, INK.loss];
  const x = scaleLinear()
    .domain([0, Math.max(1, ...keys.map((k) => row?.[k].value ?? 0))])
    .range([90, width - 55]);
  return (
    <ChartPanel
      title="Three-month monthly mean"
      subtitle={
        row
          ? row.months.map(monthLabel).join(" · ")
          : "Mature window unavailable"
      }
    >
      <div ref={ref}>
        <svg
          width="100%"
          height="180"
          viewBox={`0 0 ${width} 180`}
          role="group"
          aria-label="Monthly mean of new, reactivated and lost student-hours"
          style={{ fontSize: 12 }}
        >
          {keys.map((k, i) => (
            <g key={k}>
              <text x="0" y={37 + i * 49} fill="currentColor">
                {labels[i]}
              </text>
              <rect
                x="90"
                y={20 + i * 49}
                width={width - 145}
                height="24"
                fill={INK.unknown}
                rx="3"
              />
              {row?.[k].value != null && (
                <rect
                  x="90"
                  y={20 + i * 49}
                  width={x(row[k].value!) - 90}
                  height="24"
                  fill={colors[i]}
                  rx="3"
                />
              )}
              <text x={width - 45} y={37 + i * 49} fill="currentColor">
                {formatMetric(row?.[k])}
              </text>
            </g>
          ))}
        </svg>
      </div>
      <p className="text-xs text-muted-foreground">
        Student-hours / month · all flows use the same mature window.
      </p>
    </ChartPanel>
  );
}
export function GrowthGapChart({
  cells,
  onSelect,
}: {
  cells: GrowthAllocationCell[];
  onSelect: (selection: GrowthSelection) => void;
}) {
  const { ref, width } = useChartWidth(),
    pattern = useId().replaceAll(":", "");
  const days = [1, 2, 3, 4, 5, 6, 0],
    names = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"],
    times = [...new Set(cells.map((c) => c.startMinute))].sort((a, b) => a - b);
  const x = scaleBand<number>()
      .domain(days)
      .range([52, width - 8])
      .padding(0.06),
    y = scaleBand<number>()
      .domain(times)
      .range([30, times.length * 44 + 30])
      .padding(0.08),
    max = Math.max(
      1,
      ...cells.map((c) => c.bufferedAdditionalWeeklyHours.value ?? 0),
    ),
    color = scaleSequential(interpolateRgb("#fff4df", "#c86b12")).domain([
      0,
      max,
    ]);
  return (
    <ChartPanel
      title="Additional weekly hours by time"
      subtitle="Selected course · buffer included · unavailable cells stay unknown"
    >
      <div ref={ref} className="max-h-[430px] overflow-auto">
        <svg
          width={width}
          height={Math.max(80, times.length * 44 + 40)}
          role="group"
          aria-label="Course shortage in additional weekly tutor-hours by weekday and time"
          style={{ fontSize: 11 }}
        >
          <defs>
            <pattern
              id={pattern}
              width="6"
              height="6"
              patternUnits="userSpaceOnUse"
            >
              <rect width="6" height="6" fill="#edf0f2" />
              <path d="M0 6L6 0" stroke="#cbd3db" />
            </pattern>
          </defs>
          {days.map((d) => (
            <text
              key={d}
              x={x(d)! + x.bandwidth() / 2}
              y="18"
              textAnchor="middle"
              fill="currentColor"
            >
              {names[d]}
            </text>
          ))}
          {times.map((t) => (
            <g key={t}>
              <text
                x="45"
                y={y(t)! + y.bandwidth() / 2 + 4}
                textAnchor="end"
                fill="currentColor"
              >
                {minuteLabel(t)}
              </text>
              {days.map((d) => {
                const cell = cells.find(
                    (c) => c.startMinute === t && c.weekday === d,
                  ),
                  v = cell?.bufferedAdditionalWeeklyHours,
                  action = () =>
                    cell &&
                    onSelect({
                      kind: "capacity",
                      key: cell.key,
                      title: `Additional hours · ${names[d]} ${minuteLabel(t)}`,
                    });
                return (
                  <g
                    key={d}
                    role={cell ? "button" : undefined}
                    tabIndex={cell ? 0 : undefined}
                    aria-label={`${names[d]} ${minuteLabel(t)}: ${formatMetric(v, "h/week")}`}
                    onClick={action}
                    onKeyDown={(e) => activate(e, action)}
                    className="cursor-pointer focus:outline-2 focus:outline-primary"
                  >
                    <rect
                      x={x(d)}
                      y={y(t)}
                      width={x.bandwidth()}
                      height={y.bandwidth()}
                      rx="3"
                      fill={
                        v?.value == null ? `url(#${pattern})` : color(v.value)
                      }
                    />
                    <text
                      x={x(d)! + x.bandwidth() / 2}
                      y={y(t)! + y.bandwidth() / 2 + 4}
                      textAnchor="middle"
                      fill={
                        v?.value != null && v.value > max * 0.65
                          ? "white"
                          : "#334155"
                      }
                    >
                      {v?.value == null ? "?" : formatMetric(v)}
                    </text>
                  </g>
                );
              })}
            </g>
          ))}
        </svg>
      </div>
      {!cells.length && (
        <p className="text-sm text-muted-foreground">
          Time allocation is unavailable. Review missing availability or
          observed time patterns.
        </p>
      )}
      <p className="mt-2 text-xs text-muted-foreground">
        Fixed selected-month scale 0–{max.toFixed(1)} h/week · ? Unknown
      </p>
    </ChartPanel>
  );
}
export function HiringChart({ rows }: { rows: GrowthHiringEstimate[] }) {
  const { ref, width } = useChartWidth();
  const max = Math.max(
    1,
    ...rows.map((r) => r.bufferedTutorEquivalents.value ?? 0),
  );
  const left = width < 480 ? 100 : 180,
    right = 100,
    x = scaleLinear()
      .domain([0, max])
      .range([left, width - right]);
  return (
    <ChartPanel
      title="Course hiring estimates"
      subtitle="Fractional tutor equivalents → rounded hires · course estimates overlap"
    >
      <div ref={ref}>
        <svg
          width="100%"
          height={Math.max(80, rows.length * 94 + 15)}
          viewBox={`0 0 ${width} ${Math.max(80, rows.length * 94 + 15)}`}
          role="group"
          aria-label="Course-level fractional equivalents and rounded hiring estimates"
          style={{ fontSize: 11 }}
        >
          {rows.map((r, i) => (
            <g key={r.courseKey}>
              <text x="0" y={22 + i * 94} fontWeight="600" fill="currentColor">
                {r.subject.slice(0, width < 480 ? 14 : 25)}
              </text>
              <text x="0" y={39 + i * 94} fill="currentColor">
                {[r.curriculum, r.level]
                  .filter(Boolean)
                  .join(" · ")
                  .slice(0, width < 480 ? 16 : 28) || "All recorded levels"}
              </text>
              <rect
                x={left}
                y={12 + i * 94}
                width={Math.max(0, width - left - right)}
                height="26"
                rx="3"
                fill={INK.unknown}
              />
              {r.bufferedTutorEquivalents.value != null && (
                <rect
                  x={left}
                  y={12 + i * 94}
                  width={x(r.bufferedTutorEquivalents.value) - left}
                  height="26"
                  rx="3"
                  fill={INK.credit}
                />
              )}
              <text x={width - right + 8} y={29 + i * 94} fill="currentColor">
                {r.bufferedTutorEquivalents.value == null
                  ? "Unknown"
                  : `${formatMetric(r.bufferedTutorEquivalents)} → ${formatMetric(r.bufferedRoundedHiringEstimate)}`}
              </text>
              <text
                x={left}
                y={57 + i * 94}
                fill="currentColor"
              >{`${formatMetric(r.extraWeeklyHours)} extra h/week · n=${r.knownAvailabilityTutors}/${r.eligibleTutors}`}</text>
              <text
                x={0}
                y={74 + i * 94}
                fill="currentColor"
              >{`Mean matching ${formatMetric(r.averageMatchingWeeklyHours)} · total offered ${formatMetric(r.averageOfferedWeeklyHours)} h/week`}</text>
              <title>{`${r.subject}: matching ${formatMetric(r.averageMatchingWeeklyHours, "h/week")}, total offered ${formatMetric(r.averageOfferedWeeklyHours, "h/week")}. ${metricReason(r.bufferedTutorEquivalents)}`}</title>
            </g>
          ))}
        </svg>
      </div>
      {rows
        .filter(
          (r) =>
            (r.extraWeeklyHours.value ?? 0) > 0 &&
            (r.averageMatchingWeeklyHours.value === null ||
              r.averageMatchingWeeklyHours.value === 0),
        )
        .map((r) => (
          <p
            key={r.courseKey}
            className="mb-2 text-xs text-amber-800 dark:text-amber-200"
          >
            {r.subject}:{" "}
            {r.averageMatchingWeeklyHours.value === 0
              ? "a tutor offering different hours is needed."
              : "matching offered availability is unavailable; review source coverage."}
          </p>
        ))}
      <details className="mt-2 text-xs">
        <summary className="cursor-pointer text-muted-foreground">
          View benchmark and unbuffered estimates
        </summary>
        <div className="overflow-x-auto">
          <table className="mt-3 w-full min-w-[650px] text-left">
            <thead>
              <tr>
                {[
                  "Course",
                  "Extra h/week",
                  "Mean total offered",
                  "Mean matching offered",
                  "Known / eligible",
                  "Equivalent → hires",
                ].map((l) => (
                  <th key={l} className="p-2">
                    {l}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.courseKey} className="border-t">
                  <th className="p-2">
                    {[r.subject, r.curriculum, r.level]
                      .filter(Boolean)
                      .join(" · ")}
                  </th>
                  <td className="p-2">{formatMetric(r.extraWeeklyHours)}</td>
                  <td className="p-2">
                    {formatMetric(r.averageOfferedWeeklyHours, "h/week")}
                  </td>
                  <td className="p-2">
                    {formatMetric(r.averageMatchingWeeklyHours, "h/week")}
                  </td>
                  <td className="p-2">
                    {r.knownAvailabilityTutors} / {r.eligibleTutors}
                  </td>
                  <td className="p-2">
                    {formatMetric(r.tutorEquivalents)} →{" "}
                    {formatMetric(r.roundedHiringEstimate)}
                    {r.tutorEquivalents.value === null && (
                      <p className="mt-1">
                        {(r.extraWeeklyHours.value ?? 0) > 0 &&
                        r.averageMatchingWeeklyHours.value === 0
                          ? "A tutor offering different hours is needed."
                          : "Matching availability is unavailable."}
                      </p>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
      {!rows.length && (
        <p className="text-sm text-muted-foreground">
          Hiring benchmarks unavailable. Review qualified tutors and offered
          availability.
        </p>
      )}
    </ChartPanel>
  );
}
