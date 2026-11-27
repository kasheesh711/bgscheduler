"use client";
import { Fragment, useState, type CSSProperties, type DragEvent } from "react";
import type { CurrentFunnel, FunnelPerson, FunnelStage } from "@/lib/hiring/current-funnel";
import {
  milestones,
  matchesJourney,
  type Milestone,
  type HiringJourney,
  type JourneyFilter,
} from "@/lib/hiring/funnel-journey";
import styles from "./current-funnel.module.css";

export const stageColors = [
  "#968aff",
  "#898af6",
  "#b998ee",
  "#cb84dd",
  "#ffbc75",
  "#ed89b2",
  "#f79b93",
  "#f6bb81",
];
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
  const bands = stages.flatMap((s, index) => {
    if (!s.count) return [];
    const before = stages.slice(0, index).reduce((sum, step) => sum + step.count, 0);
    const start = boundary(before / total) * 100;
    const end = boundary((before + s.count) / total) * 100;
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
              <title>{`${b.stage} · ${b.count} ${b.count === 1 ? "candidate" : "candidates"} · ${(b.share * 100).toFixed(1)}%`}</title>
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
                      [
                        "Screening",
                        "HR call",
                        "Pre-screen",
                        "Paper",
                        "Human review",
                        "Mock",
                        "Final review",
                        "Offer",
                      ][b.index]
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

const subjectColors = [
  "#a092ff",
  "#f3929e",
  "#7fa8ff",
  "#efb87e",
  "#cc93e5",
  "#d5ce84",
  "#c28de3",
  "#8ba3df",
];
const dropStages: Partial<Record<Milestone, FunnelStage>> = {
  Prescreen: "Pre-screen",
  Test: "Paper assessment",
  Interview: "Mock teaching",
  "Final review": "Final review",
  "Offer letter": "Offer and contract",
};

export function SubjectSankey({
  journeys,
  selection,
  onSelect,
  onDrop,
}: {
  journeys: HiringJourney[];
  selection: JourneyFilter | null;
  onSelect: (filter: JourneyFilter | null) => void;
  onDrop: ChartProps["onDrop"];
}) {
  const [hover, setHover] = useState<string | null>(null);
  const [inspect, setInspect] = useState("");
  function trace(subject: string | null, detail = "") {
    setHover(subject);
    setInspect(detail);
  }
  const subjects = [...new Set(journeys.flatMap((j) => j.subjects))]
    .map((name) => {
      const members = journeys.filter((j) => j.subjects.includes(name));
      return { name, members, weight: members.reduce((sum, j) => sum + 1 / j.subjects.length, 0) };
    })
    .sort((a, b) => b.weight - a.weight || a.name.localeCompare(b.name));
  const total = journeys.length,
    gap = subjects.length > 7 ? 9 : 3;
  const mainHeight = 75 + Math.max(0, subjects.length - 1) * gap + 12;
  const scale = 75 / Math.max(total, 1);
  const reviewGroups = subjects
    .map((s) => s.members.filter((j) => matchesJourney(j, { subject: s.name, to: "Human review" })))
    .filter((group) => group.length);
  const reviewHeight =
    reviewGroups.reduce((sum, group) => sum + group.reduce((n, j) => n + scale / j.subjects.length, 0), 0) +
    Math.max(0, reviewGroups.length - 1) * gap;
  const plotHeight = mainHeight + (reviewHeight ? reviewHeight + 8 : 0);
  const x = milestones.map((_, i) => 17 + (i * 78) / (milestones.length - 1));
  const columns = milestones.map((label, i) => {
    const members = journeys.filter((j) => j.reached.includes(label));
    const lanes = subjects.map((s, colorIndex) => {
      const people = s.members.filter((j) => matchesJourney(j, { subject: s.name, to: label }));
      return {
        subject: s.name,
        people,
        weight: people.reduce((sum, j) => sum + 1 / j.subjects.length, 0),
        color: subjectColors[colorIndex % subjectColors.length],
        y: 0,
        incoming: 0,
        outgoing: 0,
      };
    });
    const visible = lanes.filter((l) => l.people.length);
    const size = members.length * scale + Math.max(0, visible.length - 1) * gap;
    let y = label === "Human review" ? mainHeight : (mainHeight - size) / 2;
    for (const lane of visible) {
      lane.y = y;
      y += lane.weight * scale + gap;
    }
    return { label, x: x[i], members, lanes };
  });
  const edges = columns.flatMap((from, i) => {
    const next: Milestone[] =
      from.label === "Prescreen"
        ? ["Test", "Interview"]
        : from.label === "Test"
          ? ["Interview", "Human review"]
          : milestones.slice(i + 1, i + 2);
    return next.flatMap((label) => {
      const to = columns[milestones.indexOf(label)];
      if (!to) return [];
      return from.lanes.flatMap((a, index) => {
        const filter = { subject: a.subject, from: from.label, to: to.label };
        const people = a.people.filter((j) => matchesJourney(j, filter));
        if (!people.length) return [];
        const b = to.lanes[index],
          size = people.reduce((sum, j) => sum + 1 / j.subjects.length, 0) * scale;
        const start = a.y + a.outgoing,
          end = b.y + b.incoming;
        a.outgoing += size;
        b.incoming += size;
        const left = from.x + 0.65,
          right = to.x - 0.65,
          middle = (left + right) / 2;
        // A paper waiver bypasses the test node.
        const waiver = from.label === "Prescreen" && to.label === "Interview";
        const lift = waiver ? Math.max(start, end) + gap : 0;
        const path = `M${left} ${start} C${middle} ${start - lift} ${middle} ${end - lift} ${right} ${end} v${size} C${middle} ${end + size - lift} ${middle} ${start + size - lift} ${left} ${start + size} Z`;
        return [{ filter, people, size, path, waiver }];
      });
    });
  });
  const activeSubject = hover ?? selection?.subject;
  const waiting = journeys.filter((j) => j.reviews.some((r) => !r.decidedAt)).length;
  function choose(filter: JourneyFilter) {
    const same =
      filter.subject === selection?.subject &&
      filter.from === selection?.from &&
      filter.to === selection?.to &&
      filter.pending === selection?.pending;
    onSelect(same ? null : filter);
  }
  const dropProps = (label: Milestone) => {
    const stage = dropStages[label];
    return stage
      ? {
          "data-drop-stage": stage,
          onDragOver: (e: DragEvent) => e.preventDefault(),
          onDrop: (e: DragEvent) => onDrop(e, stage),
        }
      : {};
  };
  const draw = (orientation: string) => (
    <>
      <defs>
        {subjects.map((s, i) => (
          <linearGradient key={s.name} id={orientation + "-strand-" + i} x1="0" x2="1" y1="0" y2="0">
            <stop offset="0" stopColor={subjectColors[i % subjectColors.length]} stopOpacity=".96" />
            <stop offset=".48" stopColor={subjectColors[i % subjectColors.length]} stopOpacity=".68" />
            <stop offset="1" stopColor={subjectColors[i % subjectColors.length]} stopOpacity=".94" />
          </linearGradient>
        ))}
      </defs>
      {edges.map((e) => {
        const label = `${e.filter.subject} · ${e.filter.from} → ${e.filter.to} · ${e.people.length} ${e.people.length === 1 ? "candidate" : "candidates"}${e.waiver ? " · Test waived" : ""}`;
        return (
          <path
            key={label}
            d={e.path}
            fill={
              "url(#" +
              orientation +
              "-strand-" +
              subjects.findIndex((s) => s.name === e.filter.subject) +
              ")"
            }
            opacity={!activeSubject || activeSubject === e.filter.subject ? 1 : 0.15}
            data-weight={e.size / scale}
            role="button"
            tabIndex={0}
            aria-label={label}
            onMouseEnter={() => trace(e.filter.subject, label)}
            onFocus={() => trace(e.filter.subject, label)}
            onBlur={() => trace(null)}
            onClick={() => choose(e.filter)}
            onKeyDown={(e2) => {
              if (e2.key === "Enter" || e2.key === " ") {
                e2.preventDefault();
                choose(e.filter);
              }
            }}
            {...dropProps(e.filter.to)}
          >
            <title>{label}</title>
          </path>
        );
      })}
      {columns.map((col) => (
        <g key={col.label}>
          <line
            x1={col.x}
            x2={col.x}
            y1="0"
            y2={plotHeight}
            stroke="#443f55"
            vectorEffect="non-scaling-stroke"
            strokeDasharray="2 5"
          />
          {col.lanes
            .filter((l) => l.weight > 0)
            .map((l) => {
              const label = `${l.subject} · ${col.label} · ${l.people.length}`;
              return (
                <rect
                  key={l.subject}
                  x={col.x - 0.65}
                  y={l.y}
                  width={1.3}
                  height={l.weight * scale}
                  rx=".3"
                  fill={l.color}
                  opacity={!activeSubject || activeSubject === l.subject ? 1 : 0.24}
                  role="button"
                  tabIndex={0}
                  aria-label={label}
                  onMouseEnter={() => trace(l.subject, label)}
                  onFocus={() => trace(l.subject, label)}
                  onBlur={() => trace(null)}
                  onClick={() => choose({ subject: l.subject, to: col.label })}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      choose({ subject: l.subject, to: col.label });
                    }
                  }}
                  {...dropProps(col.label)}
                >
                  <title>{label}</title>
                </rect>
              );
            })}
        </g>
      ))}
    </>
  );
  return (
    <div className={styles.journey} onMouseLeave={() => trace(null)}>
      <div className={styles.journeyHeaders}>
        {columns.map((col, i) => (
          <button
            type="button"
            key={col.label}
            style={
              {
                "--col": (i === 0 ? 8 : col.x) + "%",
                "--row": 4 + (i * 90) / (milestones.length - 1) + "%",
              } as CSSProperties
            }
            data-review={col.label === "Human review"}
            title={col.label === "Human review" ? "Subject head’s recheck of a near-pass paper" : col.label}
            aria-label={col.label + " · " + col.members.length + " candidates"}
            onClick={() => choose({ subject: selection?.subject, to: col.label })}
            {...dropProps(col.label)}
          >
            <span>{col.label}</span>
            <b>{col.members.length}</b>
          </button>
        ))}
      </div>
      <div
        className={styles.journeyBody}
        data-dense={subjects.length > 7}
        style={{ "--subject-rows": subjects.length } as CSSProperties}
      >
        <svg
          className={styles.horizontalJourney}
          viewBox={`0 0 100 ${plotHeight}`}
          preserveAspectRatio="none"
          role="group"
          aria-label="Hiring journey by subject"
        >
          {draw("desktop")}
        </svg>
        <svg
          className={styles.verticalJourney}
          viewBox={`0 0 ${plotHeight} 100`}
          preserveAspectRatio="none"
          role="group"
          aria-label="Hiring journey by subject"
        >
          <g transform="matrix(0 1.15385 1 0 0 -15.6154)">{draw("phone")}</g>
        </svg>
        {waiting > 0 && (
          <button
            className={styles.reviewTag}
            type="button"
            style={{
              left: columns[3].x + "%",
              top: ((mainHeight + reviewHeight + 3) / plotHeight) * 100 + "%",
            }}
            onClick={() => choose({ to: "Human review", pending: true })}
          >
            {waiting} waiting for review
          </button>
        )}
        {columns[0].lanes.map((l) => (
          <button
            type="button"
            className={styles.journeySubject}
            key={l.subject}
            title={l.subject}
            style={{ top: ((l.y + (l.weight * scale) / 2) / plotHeight) * 100 + "%" }}
            aria-pressed={selection?.subject === l.subject && !selection.from && !selection.to}
            onClick={() => choose({ subject: l.subject })}
            onMouseEnter={() => setHover(l.subject)}
            onMouseLeave={() => setHover(null)}
          >
            {l.subject} <b>{l.people.length}</b>
          </button>
        ))}
      </div>
      <select
        style={{
          borderInlineStart:
            "4px solid " +
            (subjects.findIndex((s) => s.name === selection?.subject) >= 0
              ? subjectColors[subjects.findIndex((s) => s.name === selection?.subject) % subjectColors.length]
              : "#9a96a8"),
        }}
        className={styles.mobileSubject}
        aria-label="Filter hiring journey by subject"
        value={selection?.subject ?? ""}
        onChange={(e) => onSelect(e.target.value ? { subject: e.target.value } : null)}
      >
        <option value="">All subjects</option>
        {subjects.map((s) => (
          <option key={s.name}>{s.name}</option>
        ))}
      </select>
      <div className={styles.chartReadout}>
        {inspect ||
          (selection
            ? [selection.subject, [selection.from, selection.to].filter(Boolean).join(" → ")]
                .filter(Boolean)
                .join(" · ")
            : "Near-pass papers branch to Human review. Select a ribbon to see its candidates.")}
      </div>
    </div>
  );
}
