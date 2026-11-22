"use client";

import { useMemo, useState } from "react";
import {
  buildFunnel,
  FUNNEL_STEPS,
  STEP_TIMING,
  PAYLOAD_ROW_CAP,
  STUCK_RULES,
  WEEKS,
  type FunnelInput,
  type FunnelReport,
  type GroupFunnel,
  type Stat,
} from "@/lib/hiring/funnel";
import type { Stage } from "@/lib/hiring/model";
import { FirstUseHint } from "./first-use-hint";
import css from "./dashboard.module.css";

type Campaign = { jobId: string; label: string };
const pct = (value: number | null) => (value === null ? "No one at the step before" : `${roundPct(value * 100)}%`);
const roundPct = (value: number) => Math.round(value * 10) / 10;
const dateText = (iso: string) =>
  new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "Asia/Bangkok" });

/** "0.8 d median · p90 1.5 d (3 cases)". Few cases are named, because the median then moves a lot. */
export function daysText(stat: Stat | undefined) {
  if (!stat) return "No timed cases yet";
  return `${stat.median} d median · p90 ${stat.p90} d (${stat.n} ${stat.n === 1 ? "case" : "cases"}${stat.n < 5 ? ", few" : ""})`;
}

/** The same figures as `daysText`, short enough for a table cell. */
const daysShort = (stat: Stat | undefined) =>
  stat ? `${stat.median} d · p90 ${stat.p90} d (n=${stat.n}${stat.n < 5 ? ", few" : ""})` : "No timed cases yet";

/** The break-down choices: all, each campaign (most applied first), each month and each ISO week (newest first). */
export function groupOptions(report: FunnelReport, campaigns: Campaign[]) {
  const keys = Object.keys(report.groups);
  const applied = (g: string) => report.groups[g].reached.applied;
  const campaignLabel = (id: string) => {
    if (id === "tracker-only") return "Tracker only (no SEEK job)";
    const job = campaigns.find((c) => c.jobId === id);
    return job ? `${job.label} (SEEK ${id})` : `SEEK ${id}`;
  };
  return [
    { value: "all", label: "All candidates" },
    ...keys
      .filter((g) => g.startsWith("campaign:"))
      .sort((a, b) => applied(b) - applied(a))
      .map((g) => ({ value: g, label: `Campaign: ${campaignLabel(g.slice(9))}` })),
    ...keys
      .filter((g) => g.startsWith("month:"))
      .sort()
      .reverse()
      .map((g) => ({
        value: g,
        label: `Applied in ${new Date(`${g.slice(6)}-01`).toLocaleDateString("en-GB", { month: "short", year: "numeric", timeZone: "UTC" })}`,
      })),
    ...keys
      .filter((g) => g.startsWith("week:"))
      .sort()
      .reverse()
      .map((g) => {
        const [year, week] = g.slice(5).split("-W");
        return { value: g, label: `Applied in week ${Number(week)} of ${year}` };
      }),
  ];
}

/** A campaign or week can drop out on the next load: then "all", for both the select and the table. */
export const pickGroup = (report: FunnelReport, group: string) => (report.groups[group] ? group : "all");

/** One row per current stage: count, days in stage, stuck count (opens the table on them), next action and owner. */
export function PipelineBoard({ g, onShowStuck }: { g: GroupFunnel; onShowStuck: (stage: Stage, ids: string[]) => void }) {
  const applied = g.reached.applied;
  const fromImport = Object.values(g.currentStage).reduce((sum, s) => sum + s.sinceIsImportTime, 0);
  return (
    <div className={css.tableScroll}>
      <table className={css.table}>
        <caption className={css.tableCaption}>Candidates by current stage</caption>
        <thead>
          <tr>
            <th scope="col">Stage now</th>
            <th scope="col">Count</th>
            <th scope="col">Days in stage</th>
            <th scope="col">Stuck</th>
            <th scope="col">Next action</th>
            <th scope="col">Owner</th>
          </tr>
        </thead>
        <tbody>
          {STUCK_RULES.filter((r) => g.currentStage[r.key]).map((r) => {
            const s = g.currentStage[r.key];
            return (
              <tr key={r.key} data-stuck={s.stuck > 0 || undefined}>
                <th scope="row">{r.label}</th>
                <td className={css.num}>
                  {s.n} ({applied ? Math.round((s.n / applied) * 100) : 0}%)
                </td>
                <td className={css.num}>
                  {s.medianDays} median, {s.p90Days} p90
                </td>
                <td>
                  {r.days === null ? (
                    "Not counted"
                  ) : s.stuck > 0 ? (
                    <button
                      type="button"
                      className={css.inlineLink}
                      title={r.why}
                      aria-label={`Show the ${s.stuck} stuck candidates in ${r.label}`}
                      onClick={() => {
                        onShowStuck(r.stage as Stage, s.stuckIds);
                        // The table sits further down the Overview, so bring it into view or the click looks dead.
                        globalThis.document?.querySelector('[aria-label="Candidates"]')?.scrollIntoView({ behavior: "smooth", block: "start" });
                      }}
                    >
                      {s.stuck} stuck ({Math.round((s.stuck / s.n) * 100)}%)
                    </button>
                  ) : (
                    "0 stuck"
                  )}
                  {r.days !== null && <span className={css.funnelRule}> after {r.days} days</span>}
                </td>
                <td>{r.next}</td>
                <td>{r.owner}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {fromImport > 0 && (
        <p className={css.funnelNote}>
          {fromImport} candidates have no event for their current stage. Their time starts at the import, so their days
          are a lower bound.
        </p>
      )}
    </div>
  );
}

/** One bar on its track. A share of zero draws the empty track; `flag` marks the bottleneck. */
const Bar = ({ share, flag }: { share: number; flag?: boolean }) => (
  <div className={css.funnelTrack} data-flag={flag || undefined}>
    {share > 0 && <span style={{ width: `${Math.min(100, share * 100)}%` }} />}
  </div>
);

/**
 * The funnel as bars: one bar of the furthest step each candidate reached, then per step the volume, the
 * conversion from the step before and the wait. The step that loses the most candidates and the slowest step get a flag.
 */
export function FunnelBars({ g }: { g: GroupFunnel }) {
  const applied = g.reached.applied;
  const steps = FUNNEL_STEPS.map(([step, label], i) => {
    const before = i ? g.reached[FUNNEL_STEPS[i - 1][0]] : 0;
    const next = FUNNEL_STEPS[i + 1];
    return {
      step,
      label,
      n: g.reached[step],
      lost: i ? Math.max(0, before - g.reached[step]) : 0,
      // A later step can count a candidate that an earlier step has no proof for, so never below zero.
      stoppedHere: next ? Math.max(0, g.reached[step] - g.reached[next[0]]) : g.reached[step],
      conv: step === "applied" ? null : g.conv[step],
      time: step === "applied" ? undefined : g.stepDays[STEP_TIMING[step]],
    };
  });
  const mostLost = Math.max(...steps.map((s) => s.lost));
  // A median of fewer than 5 cases moves a lot, so it is the slowest step only when no step has 5.
  const timed = steps.filter((s) => s.time);
  const steady = timed.filter((s) => s.time!.n >= 5);
  const slowest = Math.max(0, ...(steady.length ? steady : timed).map((s) => s.time!.median));
  const longest = Math.max(0, ...timed.map((s) => s.time!.median));
  const shade = (i: number) =>
    i === steps.length - 1 ? "var(--good)" : `color-mix(in srgb, var(--primary) ${25 + i * 13}%, transparent)`;
  return (
    <>
      {applied > 0 && (
        <>
          <p className={css.funnelNote}>Furthest step each of the {applied} candidates reached</p>
          <div className={css.funnelStack} role="img" aria-label={steps.map((s) => `${s.label} ${s.stoppedHere}`).join(", ")}>
            {steps.map((s, i) => s.stoppedHere > 0 && <span key={s.step} title={`${s.label}: ${s.stoppedHere}`} style={{ flexGrow: s.stoppedHere, background: shade(i) }} />)}
          </div>
          <ul className={css.funnelLegend} aria-hidden="true">
            {steps.map((s, i) => (
              <li key={s.step}>
                <i style={{ background: shade(i) }} />
                {s.label} {s.stoppedHere}
              </li>
            ))}
          </ul>
        </>
      )}
      <table className={`${css.table} ${css.funnelBars}`}>
        <caption className={css.tableCaption}>Funnel steps</caption>
        <thead>
          <tr>
            <th scope="col">Step</th>
            <th scope="col">Reached</th>
            <th scope="col">From step before</th>
            <th scope="col">Time from step before</th>
          </tr>
        </thead>
        <tbody>
          {steps.map((s) => {
            const worst = s.lost > 0 && s.lost === mostLost;
            const slow = !!s.time && slowest > 0 && s.time.median === slowest && (steady.length === 0 || s.time.n >= 5);
            return (
              <tr key={s.step}>
                <th scope="row">
                  <span className={css.funnelCount}>{s.n}</span>
                  {s.label}
                </th>
                <td>
                  <Bar share={applied ? s.n / applied : 0} />
                  {applied ? `${roundPct((s.n / applied) * 100)}% of applied` : "No candidates"}
                </td>
                <td>
                  {s.step === "applied" ? (
                    `${roundPct(applied / g.weeks)} a week`
                  ) : (
                    <>
                      <Bar share={s.conv ?? 0} flag={worst} />
                      {pct(s.conv)}
                      {s.conv !== null && <span className={css.funnelRule}> {s.lost} did not</span>}
                      {worst && <span className={css.funnelFlag}>Most lost</span>}
                    </>
                  )}
                </td>
                <td>
                  {s.step === "applied" ? (
                    "Start"
                  ) : (
                    <>
                      <Bar share={s.time && longest ? s.time.median / longest : 0} flag={slow} />
                      {daysShort(s.time)}
                      {slow && <span className={css.funnelFlag}>Slowest</span>}
                    </>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </>
  );
}

export function FunnelView({
  report,
  campaigns,
  onShowStuck,
}: {
  report: FunnelReport;
  campaigns: Campaign[];
  onShowStuck: (stage: Stage, ids: string[]) => void;
}) {
  const [group, setGroup] = useState("all");
  const options = groupOptions(report, campaigns);
  const value = pickGroup(report, group);
  const g: GroupFunnel = report.groups[value];
  const applied = g.reached.applied;
  return (
    <section className={`${css.panel} ${css.funnelPanel}`} aria-labelledby="funnel-title">
      <FirstUseHint id="kevin-funnel">
        Kevin: in Funnel steps, read From step before (conversion) and Time from step before. In Candidates by current stage,
        click a Stuck count to list those candidates. Full steps: the printed Kevin job aid.
      </FirstUseHint>
      <div className={css.funnelHead}>
        <div>
          <h2 id="funnel-title" className={css.panelTitle}>
            Hiring funnel and pipeline
          </h2>
          <p className={css.panelLede}>
            Candidates first seen from {dateText(report.windowStart)} to now ({WEEKS} weeks). A step counts when a message, booking
            or record proves it, or when the current stage needs it.
          </p>
          {report.capped && (
            <p className={css.funnelNote} role="note">
              Needs review: the page reads only the {PAYLOAD_ROW_CAP} most recently updated candidates, so these counts can be
              low.
            </p>
          )}
        </div>
        <label className={css.filterSelect}>
          Show
          <select value={value} onChange={(e) => setGroup(e.target.value)} aria-label="Break down the funnel">
            {options.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </label>
      </div>
      <div className={css.funnelGrid}>
        <div className={css.tableScroll}>
          <FunnelBars g={g} />
          <p className={css.funnelNote}>
            Applied to offer: {applied ? `${roundPct((g.reached.offer / applied) * 100)}%` : "no candidates"}. Applied to visit:{" "}
            {daysText(g.stepDays.applied_to_visit)}. The applied date is the first known event: SEEK does not give it.
          </p>
        </div>
        <PipelineBoard g={g} onShowStuck={onShowStuck} />
      </div>
    </section>
  );
}

export function FunnelPanel({
  data,
  campaigns,
  onShowStuck,
}: {
  data: FunnelInput;
  campaigns: Campaign[];
  onShowStuck: (stage: Stage, ids: string[]) => void;
}) {
  // "now" moves with each load of the data, not with each render.
  const report = useMemo(() => buildFunnel(data, new Date()), [data]);
  return <FunnelView report={report} campaigns={campaigns} onShowStuck={onShowStuck} />;
}
