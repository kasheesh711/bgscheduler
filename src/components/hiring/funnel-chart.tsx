"use client";
import { Fragment, type DragEvent } from "react";
import type { CurrentFunnel, FunnelPerson, FunnelStage } from "@/lib/hiring/current-funnel";
import styles from "./current-funnel.module.css";

export const stageColors = ["#9b91ee", "#9982dd", "#a27ad2", "#ae71bd", "#b569a4", "#bd6f91", "#c77c88"];
export type ChartMode = "Funnel" | "Sankey";
export function chartSubjects(person: FunnelPerson): string[] {
  const subjects = [...new Set([...person.appliedSubjects, ...person.subjects])];
  return subjects.length ? subjects : ["Subject unknown"];
}

type ChartProps = {
  stages: CurrentFunnel["stages"];
  highlight: FunnelStage | null;
  onHighlight: (stage: FunnelStage | null) => void;
  onSelect: (stage: FunnelStage | null, subject?: string) => void;
  onDrop: (event: DragEvent, stage: FunnelStage) => void;
};
function ribbon(x0: number, x1: number, radius0: number, radius1: number) {
  const mid = (x0 + x1) / 2;
  return `M ${x0} ${50 - radius0} C ${mid} ${50 - radius0} ${mid} ${50 - radius1} ${x1} ${50 - radius1}
    L ${x1} ${50 + radius1} C ${mid} ${50 + radius1} ${mid} ${50 + radius0} ${x0} ${50 + radius0} Z`;
}

export function FunnelChart({ stages, highlight, onHighlight, onSelect, onDrop }: ChartProps) {
  const total = stages.reduce((sum, s) => sum + s.count, 0);
  if (!total) return <div className={styles.emptyChart}>No active candidates</div>;
  // These boundaries give each person equal area under the point-symmetric taper.
  const boundary = (fraction: number) => (1 - Math.sqrt(1 - (1 - 0.18 ** 2) * fraction)) / 0.82;
  let seen = 0;
  const bands = stages.flatMap((s, index) => {
    if (!s.count) return [];
    const start = boundary(seen / total) * 100;
    seen += s.count;
    const end = boundary(seen / total) * 100;
    return [{ ...s, start, end, share: s.count / total, index }];
  });
  return (
    <div className={styles.chart}>
      <svg
        className={styles.figure}
        viewBox="0 0 100 100"
        preserveAspectRatio="none"
        role="img"
        aria-label="Funnel area by current stage"
        onMouseLeave={() => onHighlight(null)}
      >
        {bands.map((b) => {
          const r0 = 42 * (1 - (0.82 * b.start) / 100),
            r1 = 42 * (1 - (0.82 * b.end) / 100);
          return (
            <g
              key={b.stage}
              data-drop-stage={b.stage}
              data-value={b.count}
              fill={stageColors[b.index]}
              opacity={highlight && highlight !== b.stage ? 0.42 : 1}
              onMouseEnter={() => onHighlight(b.stage)}
              onClick={() => onSelect(b.stage)}
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => onDrop(e, b.stage)}
            >
              <title>
                {b.stage} · {b.count} candidates · {(b.share * 100).toFixed(1)}%
              </title>
              <path data-footprint="" d={ribbon(b.start, b.end, r0, r1)} opacity=".34" />
              <path d={ribbon(b.start, b.end, r0 * 0.93, r1 * 0.93)} opacity=".6" />
              <path d={ribbon(b.start, b.end, r0 * 0.84, r1 * 0.84)} />
              <line
                x1={b.start}
                x2={b.start}
                y1="0"
                y2="100"
                stroke="#221e30"
                strokeWidth={1.4}
                vectorEffect="non-scaling-stroke"
              />
            </g>
          );
        })}
      </svg>
      {bands
        .filter((b) => b.end - b.start >= 10)
        .map((b) => {
          const left = 3 + (0.94 * (b.start + b.end)) / 2 + "%";
          return (
            <Fragment key={b.stage}>
              <span className={styles.bandLabel} style={{ left }}>
                {Number((100 * b.share).toFixed(1))}%
              </span>
              {b.end - b.start >= 15 && (
                <>
                  <span className={styles.chartCount} style={{ left }}>
                    {b.count}
                  </span>
                  <span className={styles.chartStage} style={{ left }}>
                    {
                      ["Screening", "HR call", "Pre-screen", "Paper", "Mock", "Final review", "Offer"][
                        b.index
                      ]
                    }
                  </span>
                </>
              )}
            </Fragment>
          );
        })}
    </div>
  );
}

export function SubjectSankey({
  rows,
  stages,
  subject,
  highlight,
  onHighlight,
  onSelect,
  onDrop,
}: ChartProps & {
  rows: FunnelPerson[];
  subject: string | null;
}) {
  if (!rows.length) return <div className={styles.emptyChart}>No active candidates</div>;
  const groups = new Map<
    string,
    {
      people: number;
      weight: number;
      links: Map<FunnelStage, { people: number; weight: number }>;
    }
  >();
  for (const person of rows) {
    const names = chartSubjects(person);
    for (const name of names) {
      const group = groups.get(name) ?? {
        people: 0,
        weight: 0,
        links: new Map(),
      };
      const link = group.links.get(person.stage) ?? { people: 0, weight: 0 };
      group.people++;
      group.weight += 1 / names.length;
      link.people++;
      link.weight += 1 / names.length;
      group.links.set(person.stage, link);
      groups.set(name, group);
    }
  }
  const subjects = [...groups.entries()].sort(
    ([a, ga], [b, gb]) => gb.people - ga.people || a.localeCompare(b),
  );
  const active = stages.filter((s) => s.count);
  const gap = 20,
    ink = 92,
    scale = ink / rows.length;
  const height = ink + (Math.max(subjects.length, active.length) - 1) * gap + 20;
  let sourceY = (height - ink - (subjects.length - 1) * gap) / 2;
  let targetY = (height - ink - (active.length - 1) * gap) / 2;
  const targets = active.map((s) => {
    const y = targetY,
      size = s.count * scale;
    targetY += size + gap;
    return {
      ...s,
      y,
      size,
      used: 0,
      color: stageColors[stages.findIndex((a) => a.stage === s.stage)],
    };
  });
  const sources = subjects.map(([name, group]) => {
    const y = sourceY,
      size = group.weight * scale;
    sourceY += size + gap;
    let from = y;
    const links = targets.flatMap((target) => {
      const link = group.links.get(target.stage);
      if (!link) return [];
      const width = link.weight * scale,
        to = target.y + target.used;
      const path = `M32 ${from} C48 ${from} 52 ${to} 68 ${to} v${width} C52 ${to + width} 48 ${from + width} 32 ${from + width} Z`;
      target.used += width;
      from += width;
      return [{ ...link, path, stage: target.stage, color: target.color }];
    });
    return { name, y, size, people: group.people, links };
  });
  return (
    <div className={styles.sankey} aria-label="Subject to current stage">
      <div className={styles.sankeyHead}>
        <span>Teaching subject</span>
        <span>Current stage</span>
      </div>
      <div className={styles.sankeyPlot} style={{ height }}>
        <svg
          viewBox={`0 0 100 ${height}`}
          preserveAspectRatio="none"
          role="group"
          aria-label="Candidates by subject and stage"
          onMouseLeave={() => onHighlight(null)}
        >
          {sources.map((s) => (
            <g key={s.name}>
              <rect x="30.8" y={s.y} width="1.2" height={s.size} rx=".4" fill="#c3b4f1" />
              {s.links.map((l) => {
                const label = `${s.name} → ${l.stage} · ${l.people} ${l.people === 1 ? "candidate" : "candidates"}`;
                return (
                  <path
                    key={l.stage}
                    d={l.path}
                    fill={l.color}
                    role="button"
                    tabIndex={0}
                    aria-label={label}
                    data-drop-stage={l.stage}
                    data-weight={l.weight}
                    opacity={
                      (!subject || subject === s.name) && (!highlight || highlight === l.stage) ? 0.82 : 0.2
                    }
                    onClick={() => onSelect(l.stage, s.name)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        onSelect(l.stage, s.name);
                      }
                    }}
                    onMouseEnter={() => onHighlight(l.stage)}
                    onDragOver={(e) => e.preventDefault()}
                    onDrop={(e) => onDrop(e, l.stage)}
                  >
                    <title>{label}</title>
                  </path>
                );
              })}
            </g>
          ))}
          {targets.map((t) => (
            <rect
              key={t.stage}
              x="68"
              y={t.y}
              width="1.2"
              height={t.size}
              rx=".4"
              fill={t.color}
              data-drop-stage={t.stage}
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => onDrop(e, t.stage)}
            />
          ))}
        </svg>
        {sources.map((s) => (
          <button
            key={s.name}
            type="button"
            className={styles.subjectNode}
            style={{ top: s.y + s.size / 2 }}
            onClick={() => onSelect(null, s.name)}
            aria-pressed={s.name === subject}
            title={s.name}
          >
            {s.name} <b>{s.people}</b>
          </button>
        ))}
        {targets.map((t) => (
          <button
            key={t.stage}
            type="button"
            className={styles.stageNode}
            style={{ top: t.y + t.size / 2 }}
            onClick={() => onSelect(t.stage)}
            data-drop-stage={t.stage}
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => onDrop(e, t.stage)}
            title={t.stage}
          >
            {t.stage} <b>{t.count}</b>
          </button>
        ))}
      </div>
    </div>
  );
}
