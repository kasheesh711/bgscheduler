"use client";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { line, scaleLinear, scalePoint } from "d3";
import type { WorkforceMetric } from "@/lib/tutor-offboarding/workforce/types";
import { Panel } from "../atoms";
import { formatMetric, monthLabel } from "./presentation";
export const INK = {
  supply: "#0284c7",
  credit: "#d97706",
  actual: "#64748b",
  loss: "#be5160",
  grid: "#dce3e8",
  unknown: "#e9edf0",
};
export function useChartWidth(initial = 680) {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(initial);
  useEffect(() => {
    if (!ref.current || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(([entry]) =>
      setWidth(Math.max(260, Math.round(entry.contentRect.width))),
    );
    observer.observe(ref.current);
    return () => observer.disconnect();
  }, []);
  return { ref, width };
}
export function activate(
  event: Pick<React.KeyboardEvent<SVGElement>, "key" | "preventDefault">,
  action: () => void,
) {
  if (event.key === "Enter" || event.key === " ") {
    event.preventDefault();
    action();
  }
}
export function ChartPanel({
  title,
  subtitle,
  children,
  action,
  className = "",
}: {
  title: string;
  subtitle?: string;
  children: ReactNode;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <Panel className={`min-w-0 overflow-hidden ${className}`}>
      <header className="flex flex-wrap items-center justify-between gap-2 px-5 pt-4">
        <div>
          <h3 className="text-sm font-semibold">{title}</h3>
          {subtitle && (
            <p className="mt-1 text-xs text-muted-foreground">{subtitle}</p>
          )}
        </div>
        {action}
      </header>
      <div className="p-4">{children}</div>
    </Panel>
  );
}
export function Sparkline({
  values,
  color = INK.supply,
}: {
  values: WorkforceMetric[];
  color?: string;
}) {
  const x = scaleLinear()
    .domain([0, Math.max(1, values.length - 1)])
    .range([2, 86]);
  const y = scaleLinear()
    .domain([0, Math.max(1, ...values.map((v) => v.value ?? 0))])
    .range([27, 3]);
  const path = line<WorkforceMetric>()
    .defined((d) => d.value !== null)
    .x((_, i) => x(i))
    .y((d) => y(d.value!))(values);
  return (
    <svg width="88" height="30" aria-hidden="true">
      <path d={path ?? ""} stroke={color} strokeWidth="2" fill="none" />
    </svg>
  );
}
export interface TrendRow {
  month: string;
  [key: string]: string | WorkforceMetric;
}
export function LinesChart({
  rows,
  series,
  label,
  onSelect,
  selectedMonth,
  unit = "h",
  partialMonths = [],
}: {
  rows: TrendRow[];
  series: { key: string; label: string; color: string; dash?: string }[];
  label: string;
  onSelect?: (month: string) => void;
  selectedMonth?: string;
  unit?: string;
  partialMonths?: string[];
}) {
  const { ref, width } = useChartWidth();
  const mobile = width < 480,
    left = 38,
    right = mobile ? 14 : 128,
    bottom = 210;
  const x = scalePoint<string>()
    .domain(rows.map((d) => d.month))
    .range([left, width - right])
    .padding(0.15);
  const y = scaleLinear()
    .domain([
      0,
      Math.max(
        1,
        ...rows.flatMap((d) =>
          series.map((s) => (d[s.key] as WorkforceMetric).value ?? 0),
        ),
      ),
    ])
    .nice()
    .range([bottom, 20]);
  const endLabels = series
    .map((s) => {
      const last = rows.findLast(
        (d) => (d[s.key] as WorkforceMetric).value !== null,
      );
      return {
        key: s.key,
        last,
        position: last ? y((last[s.key] as WorkforceMetric).value!) : 20,
      };
    })
    .sort((a, b) => a.position - b.position);
  for (let i = 1; i < endLabels.length; i++)
    endLabels[i].position = Math.max(
      endLabels[i].position,
      endLabels[i - 1].position + 17,
    );
  if (endLabels.length && endLabels[endLabels.length - 1].position > bottom) {
    const shift = endLabels[endLabels.length - 1].position - bottom;
    endLabels.forEach((l) => (l.position -= shift));
  }
  return (
    <div ref={ref}>
      <svg
        role={onSelect ? "group" : "img"}
        aria-label={label}
        width="100%"
        height="250"
        viewBox={`0 0 ${width} 250`}
        className="text-foreground"
        style={{ fontSize: 11 }}
      >
        <title>{label}</title>
        {y.ticks(4).map((t) => (
          <g key={t}>
            <line
              x1={left}
              x2={width - right}
              y1={y(t)}
              y2={y(t)}
              stroke={INK.grid}
              strokeWidth=".7"
            />
            <text
              x={left - 7}
              y={y(t) + 4}
              textAnchor="end"
              fill="currentColor"
            >
              {t}
            </text>
          </g>
        ))}
        {rows.map((d, i) => (
          <g key={d.month}>
            {(!mobile ||
              i % Math.ceil(rows.length / 4) === 0 ||
              i === rows.length - 1) && (
              <text x={x(d.month)} y={233} textAnchor="middle">
                {monthLabel(d.month).split(" ")[0]}
                {partialMonths.includes(d.month) ? "*" : ""}
              </text>
            )}
            {selectedMonth === d.month && (
              <line
                x1={x(d.month)}
                x2={x(d.month)}
                y1="15"
                y2={bottom}
                stroke={INK.supply}
                strokeDasharray="3 4"
                opacity=".35"
              />
            )}
          </g>
        ))}
        {series.map((s) => {
          const path = line<TrendRow>()
            .defined(
              (d) =>
                (d[s.key] as WorkforceMetric).value !== null &&
                !partialMonths.includes(d.month),
            )
            .x((d) => x(d.month)!)
            .y((d) => y((d[s.key] as WorkforceMetric).value!))(rows);
          const last = rows.findLast(
            (d) => (d[s.key] as WorkforceMetric).value !== null,
          );
          return (
            <g key={s.key}>
              <path
                d={path ?? ""}
                fill="none"
                stroke={s.color}
                strokeWidth="2.5"
                strokeDasharray={s.dash}
              />
              {rows.map((row, i) => {
                if (!partialMonths.includes(row.month) || i === 0) return null;
                const previous = rows[i - 1];
                const currentValue = (row[s.key] as WorkforceMetric).value;
                const previousValue = (previous[s.key] as WorkforceMetric)
                  .value;
                return currentValue === null ||
                  previousValue === null ? null : (
                  <line
                    key={row.month}
                    x1={x(previous.month)}
                    x2={x(row.month)}
                    y1={y(previousValue)}
                    y2={y(currentValue)}
                    stroke={s.color}
                    strokeWidth="2"
                    strokeDasharray="4 5"
                    opacity=".5"
                  />
                );
              })}
              {rows.map((d) => {
                const value = d[s.key] as WorkforceMetric;
                return value.value === null ? null : (
                  <circle
                    key={d.month}
                    cx={x(d.month)}
                    cy={y(value.value)}
                    r="3.5"
                    fill={
                      value.completeness === "partial" ? "var(--card)" : s.color
                    }
                    stroke={s.color}
                    strokeWidth="1.5"
                  >
                    <title>{`${monthLabel(d.month)} · ${s.label}: ${formatMetric(value, unit)}${partialMonths.includes(d.month) ? " · Month to date" : ""}${value.completeness === "partial" ? " · Partial evidence" : ""}`}</title>
                  </circle>
                );
              })}
              {!mobile && last && (
                <text
                  x={width - right + 8}
                  y={
                    (endLabels.find((l) => l.key === s.key)?.position ?? 20) + 4
                  }
                  fill={s.color}
                >
                  {s.label}
                </text>
              )}
            </g>
          );
        })}
        {onSelect &&
          rows.map((d) => (
            <rect
              key={d.month}
              x={Math.max(left - 16, x(d.month)! - 18)}
              y="0"
              width="36"
              height={bottom + 3}
              fill="transparent"
              tabIndex={0}
              role="button"
              aria-label={`Select ${monthLabel(d.month)}`}
              onClick={() => onSelect(d.month)}
              onKeyDown={(e) => activate(e, () => onSelect(d.month))}
              className="cursor-pointer focus:stroke-primary"
            />
          ))}
      </svg>
      <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs">
        {partialMonths.length > 0 && (
          <span className="text-muted-foreground">
            * Month to date · dashed line
          </span>
        )}
        {series.map((s) => (
          <span key={s.key} style={{ color: s.color }}>
            ● {s.label}
          </span>
        ))}
        {rows.some((d) =>
          series.some(
            (s) => (d[s.key] as WorkforceMetric).completeness === "partial",
          ),
        ) && <span className="text-muted-foreground">○ Partial evidence</span>}
        {rows.some((d) =>
          series.some((s) => (d[s.key] as WorkforceMetric).value === null),
        ) && (
          <span className="text-muted-foreground">
            Gaps = unavailable evidence
          </span>
        )}
      </div>
    </div>
  );
}
