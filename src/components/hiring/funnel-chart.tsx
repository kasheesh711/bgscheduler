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

// Keep each subject's color when candidate counts reorder the subjects.
const subjectColors: Record<string, string> = {
  Mathematics: "#a092ff",
  Physics: "#f3929e",
  Chemistry: "#cc93e5",
  Biology: "#efb87e",
  "Computer Science": "#a9c5ff",
  ICT: "#858bd9",
  "EFL/ESL": "#d1b2ff",
  "English Language": "#7fa8ff",
  "English Literature": "#a5b9ed",
  IELTS: "#ebabbf",
  Economics: "#d5ce84",
  "Business Studies": "#efac84",
  Psychology: "#e7a6e0",
  Geography: "#d3d8ab",
  History: "#e7c1a4",
  Thai: "#c3b3e8",
  French: "#f5cab8",
  "Art & Design Technology": "#f29fc6",
  "Subject unknown": "#aaa4b6",
};
const dropStages: Partial<Record<Milestone, FunnelStage>> = {
  Prescreen: "Pre-screen",
  Test: "Paper assessment",
  Interview: "Mock teaching",
  "Final review": "Final review",
  "Offer letter": "Offer and contract",
};

const days = (value: number | null) => value === null ? "—" : value.toFixed(1) + " d";

export function SubjectSankey({
  journeys,
  timings,
  selection,
  onSelect,
  onDrop,
}: {
  journeys: HiringJourney[];
  timings: CurrentFunnel["seekTimings"];
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
  const allSubjects = [...new Set(journeys.flatMap((j) => j.subjects))]
    .map((name) => {
      const members = journeys.filter((j) => j.subjects.includes(name));
      return { name, members, weight: members.reduce((sum, j) => sum + 1 / j.subjects.length, 0) };
    })
    .sort((a, b) => b.weight - a.weight || a.name.localeCompare(b.name));
  const focusedSubject = selection?.subject;
  const subjects = focusedSubject ? allSubjects.filter((s) => s.name === focusedSubject) : allSubjects;
  const stageTimes = timings.find((group) => group.subject === (focusedSubject ?? null))?.stages;
  const hrCall = stageTimes?.find((s) => s.stage === "HR call");
  const cohort = focusedSubject ? (subjects[0]?.members ?? []) : journeys;
  const share = (j: HiringJourney) => (focusedSubject ? 1 : 1 / j.subjects.length);
  const total = cohort.length,
    gap = 3;
  const mainHeight = 75 + Math.max(0, subjects.length - 1) * gap + 12;
  const scale = 75 / Math.max(total, 1);
  const reviewGroups = subjects
    .map((s) => s.members.filter((j) => matchesJourney(j, { subject: s.name, to: "Human review" })))
    .filter((group) => group.length);
  const reviewHeight =
    reviewGroups.reduce((sum, group) => sum + group.reduce((n, j) => n + scale * share(j), 0), 0) +
    Math.max(0, reviewGroups.length - 1) * gap;
  const initialExits = cohort.filter((j) => j.scoreExit);
  const held = initialExits.filter((j) => j.scoreExit!.held).length;
  const returned = initialExits.filter((j) => j.scoreExit!.returned).length;
  const cutoffs = [...new Set(initialExits.map((j) => j.scoreExit!.cutoff).filter((n) => n !== null))];
  const exitHeight = held * scale;
  const plotHeight = mainHeight + Math.max(reviewHeight, exitHeight) + (reviewHeight || exitHeight ? 8 : 0);
  const x = milestones.map((_, i) => 3 + (i * 92) / (milestones.length - 1));
  const columns = milestones.map((label, i) => {
    const members = cohort.filter((j) => matchesJourney(j, { subject: focusedSubject, to: label }));
    const lanes = subjects.map((s) => {
      const people = s.members.filter((j) => matchesJourney(j, { subject: s.name, to: label }));
      return {
        subject: s.name,
        people,
        weight: people.reduce((sum, j) => sum + share(j), 0),
        color: subjectColors[s.name] ?? "#aaa4b6",
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
    const stage = label === "SEEK" ? "Application screening" : label === "Human review" ? label : dropStages[label];
    const timing = stageTimes?.find((s) => s.stage === stage);
    return { label, x: x[i], members, lanes, timing };
  });
  const originY = (mainHeight - total * scale) / 2;
  const outgoingSeek = originY + (total - held) * scale;
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
          size = people.reduce((sum, j) => sum + share(j), 0) * scale;
        const start =
            from.label === "SEEK"
              ? originY + to.lanes.slice(0, index).reduce((sum, lane) => sum + lane.weight * scale, 0)
              : a.y + a.outgoing,
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
        const description = `${a.subject} · ${from.label} → ${to.label} · ${people.length} ${people.length === 1 ? "candidate" : "candidates"}${waiver ? " · Test waived" : ""}`;
        return [
          {
            description,
            filter,
            people,
            size,
            path,
            waiver,
            markerX: middle,
            markerY: (start + end) / 2 - 0.75 * lift,
          },
        ];
      });
    });
  });
  const waiver = edges.filter((e) => e.waiver).sort((a, b) => b.size - a.size)[0];
  const activeSubject = hover ?? selection?.subject;
  const waiting = cohort.filter((j) =>
    matchesJourney(j, { to: "Human review", subject: focusedSubject, pending: true }),
  ).length;
  function choose(filter: JourneyFilter) {
    const same =
      filter.subject === selection?.subject &&
      filter.from === selection?.from &&
      filter.to === selection?.to &&
      filter.pending === selection?.pending &&
      filter.scoreExit === selection?.scoreExit;
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
            <stop offset="0" stopColor={subjectColors[s.name] ?? "#aaa4b6"} stopOpacity=".96" />
            <stop offset=".48" stopColor={subjectColors[s.name] ?? "#aaa4b6"} stopOpacity=".68" />
            <stop offset="1" stopColor={subjectColors[s.name] ?? "#aaa4b6"} stopOpacity=".94" />
          </linearGradient>
        ))}
      </defs>
      {edges
        .filter((e) => e.size / plotHeight < 0.015)
        .map((e) => (
          <path
            key={"hit-" + e.description}
            d={e.path}
            fill="transparent"
            stroke="transparent"
            strokeWidth={12}
            vectorEffect="non-scaling-stroke"
            aria-hidden="true"
            onClick={() => choose(e.filter)}
            onMouseEnter={() => trace(e.filter.subject, e.description)}
            {...dropProps(e.filter.to)}
          />
        ))}
      {edges.map((e) => {
        const label = e.description;
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
            stroke={e.size / plotHeight < 0.005 ? subjectColors[e.filter.subject] : undefined}
            strokeWidth={1.3}
            vectorEffect="non-scaling-stroke"
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
      {total > 0 && (
        <rect
          x={x[0] - 0.65}
          width="1.3"
          y={originY}
          height={total * scale}
          fill="#d5caff"
          role="button"
          aria-label={`SEEK intake · ${total} candidates`}
          tabIndex={0}
          onClick={() => choose({ subject: focusedSubject, to: "SEEK" })}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              choose({ subject: focusedSubject, to: "SEEK" });
            }
          }}
        />
      )}
      {held > 0 && (
        <g
          role="button"
          tabIndex={0}
          aria-label={`Still filtered at intake · ${held} candidates`}
          onClick={() => choose({ subject: focusedSubject, scoreExit: "held" })}
          onFocus={() => trace(null, `${held} still below the intake cutoff`)}
          onMouseEnter={() => trace(null, `${held} still below the intake cutoff`)}
          onBlur={() => trace(null)}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              choose({ subject: focusedSubject, scoreExit: "held" });
            }
          }}
        >
          <path
            d={`M${x[0] + 0.65} ${outgoingSeek} C9 ${outgoingSeek} 9 ${mainHeight} ${x[1] - 0.65} ${mainHeight} v${exitHeight} C9 ${mainHeight + exitHeight} 9 ${outgoingSeek + exitHeight} ${x[0] + 0.65} ${outgoingSeek + exitHeight} Z`}
            fill="#dc8590"
            fillOpacity=".68"
          />
          <rect x={x[1] - 0.65} y={mainHeight} width="1.3" height={exitHeight} fill="#ffa3a9" />
          <title>{`${held} still filtered at intake`}</title>
        </g>
      )}
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
          {col.label !== "SEEK" &&
            col.lanes
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
      <div className={styles.timingKey}>Stage averages · Wait / Stay</div>
      <div className={styles.journeyHeaders}>
        {columns.map((col) => (
          <button
            type="button"
            key={col.label}
            style={
              {
                "--col": col.x + "%",
                "--row": 4 + ((col.x - x[0]) * 90) / (x.at(-1)! - x[0]) + "%",
              } as CSSProperties
            }
            data-review={col.label === "Human review"}
            title={col.timing
              ? `${col.timing.stage} · Average wait from ${col.timing.dated} dated waits · Average stay from ${col.timing.completed} exits in the past 12 weeks`
              : "Candidates grouped by subject"}
            aria-label={
              col.label +
              " · " +
              col.members.length +
              (col.members.length === 1 ? " candidate" : " candidates")
            }
            aria-describedby={col.timing ? `stage-timing-${col.x}` : undefined}
            onClick={() => choose({ subject: selection?.subject, to: col.label })}
            {...dropProps(col.label)}
          >
            <span>{col.label}</span>
            <b>{col.members.length}</b>
            {col.timing && (
              <small className={styles.nodeTimes} id={`stage-timing-${col.x}`}>
                <strong><em>Wait </em>{days(col.timing.current)}</strong>
                <i> / </i>
                <strong><em>Stay </em>{days(col.timing.history)}</strong>
                <span className="sr-only">Average wait from {col.timing.dated} dated waits. Average stay from {col.timing.completed} dated exits in the past 12 weeks.</span>
              </small>
            )}
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
          <g transform="matrix(0 .97826 1 0 0 1.06522)">{draw("phone")}</g>
        </svg>
        {waiver && (
          <button
            type="button"
            className={styles.waiverTag}
            style={{
              left: waiver.markerX + "%",
              top: Math.max(2, (waiver.markerY / plotHeight) * 100) + "%",
            }}
            onClick={() => choose({ from: "Prescreen", to: "Interview" })}
          >
            Test waived
          </button>
        )}
        {reviewHeight > 0 && (
          <button
            className={styles.reviewTag}
            type="button"
            style={{
              left: columns[milestones.indexOf("Human review")].x + "%",
              top: ((mainHeight + reviewHeight + 3) / plotHeight) * 100 + "%",
            }}
            onClick={() =>
              choose({ subject: focusedSubject, to: "Human review", pending: waiting > 0 || undefined })
            }
          >
            Head recheck{waiting ? " · " + waiting + " waiting" : ""}
          </button>
        )}
        {held > 0 && (
          <button
            type="button"
            className={styles.scoreTag}
            style={{ left: x[1] + 2 + "%", top: ((mainHeight + exitHeight / 2) / plotHeight) * 100 + "%" }}
            onClick={() => choose({ subject: focusedSubject, scoreExit: "held" })}
          >
            Below cutoff · {held}
          </button>
        )}
        <div className={styles.subjectKey} aria-label="SEEK candidates by subject">
          <span className={styles.keyTitle}>SEEK subjects</span>
          {subjects.map((s) => (
            <button
              type="button"
              className={styles.journeySubject}
              key={s.name}
              title={s.name}
              style={{ "--subject-color": subjectColors[s.name] ?? "#aaa4b6" } as CSSProperties}
              aria-pressed={selection?.subject === s.name && !selection.from && !selection.to}
              onClick={() => choose({ subject: s.name })}
              onMouseEnter={() => trace(s.name)}
              onMouseLeave={() => trace(null)}
              onFocus={() => trace(s.name)}
              onBlur={() => trace(null)}
            >
              <i aria-hidden="true" />
              <span>{s.name}</span>
              <b>{s.members.length}</b>
            </button>
          ))}
        </div>
      </div>
      {hrCall && (hrCall.dated > 0 || hrCall.completed > 0) && (
        <p className={styles.hrTiming} title={`${hrCall.dated} dated waits · ${hrCall.completed} dated exits`}>
          HR call before pre-screen · Avg. wait {days(hrCall.current)} · Avg. stay {days(hrCall.history)}
        </p>
      )}
      <div className={styles.intakeStats} aria-label="SEEK intake scoring">
        <button
          type="button"
          aria-pressed={selection?.scoreExit === "initial"}
          onClick={() => choose({ subject: focusedSubject, scoreExit: "initial" })}
        >
          <b>{initialExits.length}</b> initially filtered{" "}
          <span>({total ? ((100 * initialExits.length) / total).toFixed(1) : "0"}%)</span>
        </button>
        <button
          type="button"
          aria-pressed={selection?.scoreExit === "held"}
          onClick={() => choose({ subject: focusedSubject, scoreExit: "held" })}
        >
          <b>{held}</b> still filtered
        </button>
        <button
          type="button"
          aria-pressed={selection?.scoreExit === "returned"}
          onClick={() => choose({ subject: focusedSubject, scoreExit: "returned" })}
        >
          <b>{returned}</b> returned
        </button>
        {cutoffs.length === 1 && <span>Cutoff {cutoffs[0]}/100</span>}
      </div>
      <div className={styles.chartFooter}>
        <div className={styles.mobileChartTools}>
          <select
            style={{
              borderInlineStart: "4px solid " + (subjectColors[selection?.subject ?? ""] ?? "#9a96a8"),
            }}
            className={styles.mobileSubject}
            aria-label="Filter hiring journey by subject"
            value={selection?.subject ?? ""}
            onChange={(e) => onSelect(e.target.value ? { subject: e.target.value } : null)}
          >
            <option value="">All subjects</option>
            {allSubjects.map((s) => (
              <option key={s.name}>{s.name}</option>
            ))}
          </select>
          {waiver && (
            <button
              type="button"
              className={styles.mobileWaiver}
              aria-pressed={selection?.from === "Prescreen" && selection?.to === "Interview"}
              onClick={() => choose({ subject: selection?.subject, from: "Prescreen", to: "Interview" })}
            >
              Test waived
            </button>
          )}
          {reviewHeight > 0 && (
            <button
              type="button"
              className={styles.mobileReview}
              aria-pressed={selection?.to === "Human review"}
              onClick={() => choose({ subject: selection?.subject, to: "Human review" })}
            >
              Head recheck
            </button>
          )}
        </div>
        <div className={styles.chartReadout}>
          {inspect ||
            (selection
              ? [
                  selection.subject,
                  selection.scoreExit ? "Intake score" : null,
                  [selection.from, selection.to].filter(Boolean).join(" → "),
                ]
                  .filter(Boolean)
                  .join(" · ")
              : "Near-pass papers branch to Human review. Select a ribbon to see its candidates.")}
        </div>
      </div>
    </div>
  );
}
