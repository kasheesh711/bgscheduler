"use client";
import { scaleLinear } from "d3";
import type {
  WorkforceReport,
  WorkforceSubjectRow,
} from "@/lib/tutor-offboarding/workforce/types";
import { ChartPanel, INK, LinesChart, activate, useChartWidth } from "./charts";
import { formatMetric, metricReason, monthLabel } from "./presentation";
export function SubjectCapacity({
  report,
  onSelect,
}: {
  report: WorkforceReport;
  onSelect: (row: WorkforceSubjectRow) => void;
}) {
  const { ref, width } = useChartWidth(400);
  const rows = report.subjects.filter(
      (r) => r.month === report.query.viewMonth && r.depth === 0,
    ),
    left = width < 480 ? 90 : 125;
  const max = Math.max(
    1,
    ...rows.flatMap((r) => [
      r.usableHours.value ?? 0,
      r.bookedHours.value ?? 0,
    ]),
  );
  const x = scaleLinear()
    .domain([0, max])
    .range([left, width - 45]);
  return (
    <ChartPanel
      title="Capacity by subject"
      subtitle={`${monthLabel(report.query.viewMonth)} · tutor-hours · pools overlap`}
    >
      <div ref={ref}>
        <svg
          width="100%"
          height={Math.max(100, rows.length * 65 + 30)}
          viewBox={`0 0 ${width} ${Math.max(100, rows.length * 65 + 30)}`}
          role="group"
          aria-label="Subject usable capacity compared with booked tutor-hours, shared pools overlap"
          style={{ fontSize: 11 }}
        >
          {rows.map((r, i) => (
            <g
              key={r.key}
              tabIndex={0}
              role="button"
              aria-label={`${r.subject}: usable ${formatMetric(r.usableHours, "h")}, booked ${formatMetric(r.bookedHours, "h")}`}
              onClick={() => onSelect(r)}
              onKeyDown={(e) => activate(e, () => onSelect(r))}
              className="cursor-pointer focus:outline-2 focus:outline-primary"
            >
              <rect
                x="0"
                y={i * 65}
                width={width}
                height="62"
                fill="transparent"
              />
              <text x="0" y={24 + i * 65} fontWeight="600" fill="currentColor">
                {r.subject.slice(0, width < 480 ? 13 : 20)}
              </text>
              <rect
                x={left}
                y={10 + i * 65}
                width={width - 45 - left}
                height="13"
                fill={INK.unknown}
                rx="2"
              />
              {r.usableHours.value !== null ? (
                <rect
                  x={left}
                  y={10 + i * 65}
                  width={x(r.usableHours.value) - left}
                  height="13"
                  fill={INK.supply}
                  rx="2"
                />
              ) : (
                <text x={left + 5} y={21 + i * 65} fill="currentColor">
                  ?
                </text>
              )}
              {r.bookedHours.value !== null ? (
                <rect
                  x={left}
                  y={29 + i * 65}
                  width={x(r.bookedHours.value) - left}
                  height="13"
                  fill={INK.credit}
                  rx="2"
                />
              ) : (
                <text x={left + 5} y={41 + i * 65} fill="currentColor">
                  ?
                </text>
              )}
              <text x={width - 39} y={21 + i * 65} fill={INK.supply}>
                {formatMetric(r.usableHours)}
              </text>
              <text x={width - 39} y={40 + i * 65} fill={INK.credit}>
                {formatMetric(r.bookedHours)}
              </text>
            </g>
          ))}
        </svg>
      </div>
      <div className="flex gap-4 text-xs">
        <span style={{ color: INK.supply }}>■ Usable hours</span>
        <span style={{ color: INK.credit }}>■ Booked hours</span>
      </div>
      {!rows.length && (
        <p className="mt-3 text-xs text-muted-foreground">
          Mapped subject capacity unavailable.
        </p>
      )}
    </ChartPanel>
  );
}
export function OverallTrend({ report }: { report: WorkforceReport }) {
  return (
    <ChartPanel
      title="Overall supply & booked demand"
      subtitle="Monthly tutor-hours · each tutor’s capacity counted once"
    >
      <LinesChart
        label="Overall usable capacity, booked tutor-hours and credit-consumed hours"
        selectedMonth={report.query.viewMonth}
        rows={report.months.map((r) => ({
          month: r.month,
          usable: r.usableHours,
          booked: r.bookedHours,
          credit: r.creditConsumedHours,
        }))}
        series={[
          { key: "usable", label: "Usable capacity", color: INK.supply },
          { key: "booked", label: "Booked demand", color: INK.actual },
          { key: "credit", label: "Credit-consumed", color: INK.credit },
        ]}
      />
      <details className="mt-3 text-xs">
        <summary className="cursor-pointer text-muted-foreground">
          Shared capacity · range totals & definition
        </summary>
        <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
          {[
            ["Gross offered", report.totals.offeredHours],
            ["Approved leave", report.totals.leaveHours],
            ["Usable", report.totals.usableHours],
            ["Shared free", report.totals.freeHours],
          ].map(([label, metric]) => (
            <p key={String(label)}>
              {String(label)}:{" "}
              <strong
                title={metricReason(metric as typeof report.totals.freeHours)}
              >
                {formatMetric(metric as typeof report.totals.freeHours, "h")}
              </strong>
            </p>
          ))}
        </div>
        <p className="mt-3">
          Usable = offered hours − approved leave. Shared free = usable hours
          after blocking commitments. Booked demand does not establish unmet
          demand.
        </p>
        <p className="mt-2">
          Student bookings: {formatMetric(report.totals.studentBookings)} ·
          unique students: {formatMetric(report.totals.uniqueStudents)} ·
          classes: {formatMetric(report.totals.distinctClasses)}
        </p>
      </details>
    </ChartPanel>
  );
}
export function SharedPoolDiagram() {
  return (
    <figure className="rounded border bg-primary/5 p-4">
      <figcaption className="mb-2 text-xs font-semibold">
        Illustration · one physical tutor pool
      </figcaption>
      <svg
        width="100%"
        height="145"
        viewBox="0 0 340 145"
        role="img"
        aria-label="Illustration: eight usable hours split into one booked Physics hour and seven shared free hours. The seven free hours can serve Maths OR Physics."
        style={{ fontSize: 12 }}
      >
        <text x="5" y="16" fill="currentColor">
          8 usable hours
        </text>
        <rect x="5" y="26" width="40" height="29" rx="3" fill={INK.credit} />
        <rect x="47" y="26" width="280" height="29" rx="3" fill={INK.supply} />
        <text x="25" y="46" textAnchor="middle" fill="white">
          1 h
        </text>
        <text x="187" y="46" textAnchor="middle" fill="white">
          7 shared free hours
        </text>
        <text x="5" y="75" fill="currentColor" fontSize="11">
          Physics booked
        </text>
        <path
          d="M187 56V85H95V103M187 85H275V103"
          fill="none"
          stroke={INK.supply}
        />
        <text x="95" y="124" textAnchor="middle" fill="currentColor">
          Maths
        </text>
        <text x="186" y="124" textAnchor="middle" fill="currentColor">
          OR
        </text>
        <text x="275" y="124" textAnchor="middle" fill="currentColor">
          Physics
        </text>
      </svg>
      <details className="mt-2 text-xs text-muted-foreground">
        <summary className="cursor-pointer">
          Shared capacity explanation
        </summary>
        <p className="mt-2">
          A tutor qualified in Maths and Physics with eight usable hours and one
          Physics booking has seven shared free hours eligible for either
          subject. The overall pool is seven hours. The booking occupies the
          same tutor-time in every eligible subject.
        </p>
      </details>
    </figure>
  );
}
export function GroupCreditDiagram() {
  return (
    <figure className="rounded border p-4">
      <figcaption className="mb-3 text-xs font-semibold">
        Illustration · one-hour group credit
      </figcaption>
      <svg
        width="100%"
        height="110"
        viewBox="0 0 340 110"
        role="img"
        aria-label="Illustration: two students charged 100 percent and 50 percent. Mean charged fraction is 75 percent, yielding 0.75 tutor-hour or 45 minutes."
        style={{ fontSize: 12 }}
      >
        <text x="0" y="20" fill="currentColor">
          Student A
        </text>
        <rect x="80" y="6" width="125" height="22" rx="3" fill={INK.supply} />
        <text x="142" y="22" textAnchor="middle" fill="white">
          100%
        </text>
        <text x="0" y="55" fill="currentColor">
          Student B
        </text>
        <rect x="80" y="41" width="125" height="22" rx="3" fill={INK.unknown} />
        <rect x="80" y="41" width="62.5" height="22" rx="3" fill={INK.credit} />
        <text x="158" y="57" fill="currentColor">
          50%
        </text>
        <path d="M210 17H225V52H245" fill="none" stroke={INK.actual} />
        <text x="250" y="48" fill="currentColor" fontWeight="600">
          0.75 h
        </text>
        <text x="250" y="68" fill="currentColor">
          45 minutes
        </text>
        <text x="0" y="95" fill="currentColor">
          1 class · 2 bookings · mean charge 75%
        </text>
      </svg>
      <details className="mt-2 text-xs text-muted-foreground">
        <summary className="cursor-pointer">Credit calculation</summary>
        <p className="mt-2">
          Example: a one-hour group class with two students charged 100% and 50%
          uses 60 × mean(1, 0.5) = 45 minutes of credit-consumed tutor-time. It
          remains one class and two student bookings. Credit consumption and
          recorded teaching are separate measures.
        </p>
      </details>
    </figure>
  );
}
