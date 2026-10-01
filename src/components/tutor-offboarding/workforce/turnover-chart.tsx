"use client";
import { line, scaleBand, scaleLinear } from "d3";
import type { WorkforceMonth } from "@/lib/tutor-offboarding/workforce/types";
import { activate, ChartPanel, INK, useChartWidth } from "./charts";
import { formatMetric, monthLabel, metricReason } from "./presentation";
export function TurnoverChart({
  months,
  selectedMonth,
  onSelect,
  onPeople,
}: {
  months: WorkforceMonth[];
  selectedMonth: string;
  onSelect: (month: string) => void;
  onPeople?: (month: string) => void;
}) {
  const { ref, width } = useChartWidth();
  const mobile = width < 480;
  const x = scaleBand()
    .domain(months.map((m) => m.month))
    .range([38, width - 16])
    .padding(0.25);
  const middle = (month: string) => x(month)! + x.bandwidth() / 2;
  const y = scaleLinear()
    .domain([
      0,
      Math.max(1, ...months.map((m) => m.turnoverPercent.value ?? 0)),
    ])
    .nice()
    .range([142, 26]);
  const bars = scaleLinear()
    .domain([
      0,
      Math.max(
        1,
        ...months.flatMap((m) => [
          m.joinsCount.value ?? 0,
          m.departuresCount.value ?? 0,
        ]),
      ),
    ])
    .nice()
    .range([245, 188]);
  const path = line<WorkforceMonth>()
    .defined((m) => m.turnoverPercent.value !== null)
    .x((m) => middle(m.month))
    .y((m) => y(m.turnoverPercent.value!))(months);
  return (
    <ChartPanel
      title="Workforce movement"
      subtitle="Turnover % above · joins and completed departures below"
    >
      <div ref={ref}>
        <svg
          width="100%"
          height="290"
          viewBox={`0 0 ${width} 290`}
          role="group"
          aria-label="Monthly turnover percentages and separately aligned people counts"
          style={{ fontSize: 11 }}
        >
          <title>Monthly workforce movement</title>
          {y.ticks(3).map((t) => (
            <g key={t}>
              <line
                x1="38"
                x2={width - 16}
                y1={y(t)}
                y2={y(t)}
                stroke={INK.grid}
                strokeWidth=".7"
              />
              <text x="30" y={y(t) + 4} textAnchor="end" fill="currentColor">
                {t}%
              </text>
            </g>
          ))}
          <path
            d={path ?? ""}
            fill="none"
            stroke={INK.supply}
            strokeWidth="2.5"
          />
          {months.map((m, index) => (
            <g key={m.month}>
              {selectedMonth === m.month && (
                <rect
                  x={x(m.month)! - 4}
                  y="15"
                  width={x.bandwidth() + 8}
                  height="240"
                  fill={INK.supply}
                  opacity=".07"
                />
              )}
              {m.turnoverPercent.value !== null ? (
                <>
                  <circle
                    cx={middle(m.month)}
                    cy={y(m.turnoverPercent.value)}
                    r={selectedMonth === m.month ? 5 : 3.5}
                    fill={INK.supply}
                  />
                  {(!mobile || selectedMonth === m.month || index === 0 || index === months.length - 1) && <text
                    x={middle(m.month)}
                    y={y(m.turnoverPercent.value) - 10}
                    textAnchor="middle"
                    fill={INK.supply}
                  >
                    {formatMetric(m.turnoverPercent, "%")}
                  </text>}
                </>
              ) : (
                <text
                  x={middle(m.month)}
                  y="85"
                  textAnchor="middle"
                  fill="currentColor"
                >
                  ?
                </text>
              )}
              {[
                { metric: m.joinsCount, color: INK.supply, offset: -0.26 },
                { metric: m.departuresCount, color: INK.loss, offset: 0.02 },
              ].map((b, i) =>
                b.metric.value === null ? null : (
                  <g key={i}>
                    <rect
                      x={middle(m.month) + x.bandwidth() * b.offset}
                      y={bars(b.metric.value)}
                      width={Math.max(3, x.bandwidth() * 0.24)}
                      height={245 - bars(b.metric.value)}
                      fill={b.color}
                      rx="2"
                    />
                    <text
                      x={middle(m.month) + x.bandwidth() * (b.offset + 0.12)}
                      y={bars(b.metric.value) - 5}
                      textAnchor="middle"
                      fill={b.color}
                    >
                      {formatMetric(b.metric)}
                    </text>
                  </g>
                ),
              )}
              {(!mobile ||
                index % Math.ceil(months.length / 4) === 0 ||
                index === months.length - 1) && (
                <text
                  x={middle(m.month)}
                  y="273"
                  textAnchor="middle"
                  fill="currentColor"
                >
                  {monthLabel(m.month).split(" ")[0]}
                </text>
              )}
              <rect
                x={x(m.month)! - 4}
                y="0"
                width={Math.max(28, x.bandwidth() + 8)}
                height="250"
                fill="transparent"
                tabIndex={0}
                role="button"
                aria-current={m.month === selectedMonth ? "true" : undefined}
                aria-label={`Select ${monthLabel(m.month)}: turnover ${formatMetric(m.turnoverPercent, "%")}, ${formatMetric(m.joinsCount)} joined, ${formatMetric(m.departuresCount)} departed${m.partialMonth ? ", partial month" : ""}`}
                onClick={() => onSelect(m.month)}
                onKeyDown={(e) => activate(e, () => onSelect(m.month))}
                className="cursor-pointer focus:stroke-primary"
              >
                <title>{metricReason(m.turnoverPercent)}</title>
              </rect>
            </g>
          ))}
          <text x="38" y="178" fill={INK.supply}>
            Joined · people
          </text>
          <text x="160" y="178" fill={INK.loss}>
            Departed · people
          </text>
        </svg>
      </div>
      <details className="text-xs">
        <summary className="cursor-pointer text-muted-foreground">
          View data & definition
        </summary>
        <p className="mt-3">
          Completed sheet-marked departures ÷ opening reconstructed Wise roster
          × 100. Remaining classes stay pending.
        </p>
        <div className="overflow-x-auto">
          <table className="mt-3 w-full text-left">
            <thead>
              <tr>
                {[
                  "Month",
                  "Opening roster",
                  "Joined",
                  "Departed",
                  "Pending",
                  "Turnover",
                ].map((s) => (
                  <th key={s} className="p-2 font-medium">
                    {s}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {months.map((m) => (
                <tr key={m.month} className="border-t">
                  <th className="p-2">
                    <button onClick={() => onSelect(m.month)}>
                      {monthLabel(m.month)}
                      {m.partialMonth ? " · Partial" : ""}
                    </button>
                  </th>
                  {[
                    m.openingRosterCount,
                    m.joinsCount,
                    m.departuresCount,
                    m.pendingCount,
                  ].map((v, i) => (
                    <td key={i} className="p-2">
                      {formatMetric(v)}
                    </td>
                  ))}
                  <td className="p-2">
                    {`${formatMetric(m.departuresCount)} ÷ ${formatMetric(m.openingRosterCount)} × 100 = ${formatMetric(m.turnoverPercent, "%")}`}
                    <button
                      className="ml-2 text-primary underline"
                      onClick={() => onPeople?.(m.month)}
                    >
                      See people counted
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
      {!months.length && (
        <p className="text-sm text-muted-foreground">
          No monthly evidence is available.
        </p>
      )}
    </ChartPanel>
  );
}
