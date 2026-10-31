"use client";

import { type buildInsights, RESULTS, STAGE_LABELS, type CriterionResult } from "@/lib/hiring/insights";
import type { CandidateFilter } from "./dashboard";
import css from "./dashboard.module.css";

export type Insights = ReturnType<typeof buildInsights>;
export const CRITERION_LABELS = {
  degree: "Degree",
  subject: "Subject",
  curriculum: "Curriculum",
  teaching: "Teaching",
  english: "English",
};
export const RESULT_LABELS: Record<CriterionResult, string> = {
  met: "Met",
  partial: "Partial",
  not_met: "Not met",
  unknown: "No evidence",
};
export const RESULT_CLASS: Record<CriterionResult, string> = {
  met: css.resultMet,
  partial: css.resultPartial,
  not_met: css.resultNotMet,
  unknown: css.resultUnknown,
};
const percent = (part: number, whole: number) => (whole ? Math.round((part / whole) * 100) : 0);
const round = (value: number) => Math.round(value * 10) / 10;

function Tile({ label, value, note, meter }: { label: string; value: string | number; note: string; meter?: number }) {
  return (
    <div className={css.tile}>
      <p className={css.tileLabel}>{label}</p>
      <p className={css.tileValue}>{value}</p>
      {meter !== undefined && (
        <div className={css.meter} aria-hidden="true">
          <span style={{ width: `${meter}%` }} />
        </div>
      )}
      <p className={css.tileNote}>{note}</p>
    </div>
  );
}

export function KpiStrip({
  insights: i,
  threshold,
  onShowReady,
}: {
  insights: Insights;
  threshold: number;
  onShowReady: () => void;
}) {
  return (
    <section className={css.kpis} aria-label="Hiring summary">
      <div className={css.hero}>
        <p className={css.heroLabel}>Ready to invite</p>
        <p className={css.heroValue}>{i.ready}</p>
        <button type="button" className={css.heroLink} onClick={onShowReady} disabled={!i.ready}>
          Show them <span aria-hidden="true">→</span>
        </button>
      </div>
      <Tile label="Candidates" value={i.total} note={`${i.active} active`} />
      <Tile
        label="Scored"
        value={`${percent(i.scored, i.total)}%`}
        meter={percent(i.scored, i.total)}
        note={`${i.scored} of ${i.total}`}
      />
      <Tile
        label={`At or above ${threshold}`}
        value={i.aboveThreshold}
        note={`Median ${i.median === null ? "none" : round(i.median)}`}
      />
      <Tile label="Past review" value={i.pastReview} note={`${percent(i.pastReview, i.active)}% of active`} />
      <Tile
        label="Next 7 days"
        value={i.appointmentsThisWeek}
        note={i.bookedWithoutAppointment ? `${i.bookedWithoutAppointment} not held here` : "Appointments"}
      />
      <Tile
        label="Message issues"
        value={i.messages.problems}
        note={`${i.messages.sent} sent`}
      />
    </section>
  );
}

export function StageChart({
  insights: i,
  filter,
  setFilter,
}: {
  insights: Insights;
  filter: CandidateFilter;
  setFilter: (filter: CandidateFilter) => void;
}) {
  const max = Math.max(1, i.stages[0]?.reached ?? 0);
  return (
    <section className={css.panel}>
      <h2 className={css.panelTitle}>Stages</h2>
      <p className={css.panelLede}>
        {i.pastReview} of {i.active} active are past review
      </p>
      <div className={css.stageRows}>
        {i.stages.map((row) => (
          <button
            key={row.stage}
            type="button"
            className={css.stageRow}
            aria-pressed={filter.stage === row.stage}
            aria-label={`${row.label}: ${row.at} at this stage, ${row.reached} at this stage or later. Filter the table.`}
            onClick={() => setFilter({ ...filter, stage: filter.stage === row.stage ? "all" : row.stage })}
          >
            <span className={css.stageLabel}>{row.label}</span>
            <span className={css.stageTrack}>
              <span className={css.stageReached} style={{ width: `${(row.reached / max) * 100}%` }} />
              <span className={css.stageAt} style={{ width: `${(row.at / max) * 100}%` }} />
            </span>
            <span className={css.num}>{row.at}</span>
          </button>
        ))}
      </div>
      <p className={css.legend}>
        <span><i className={css.keyAt} />At this stage</span>
        <span><i className={css.keyReached} />This stage or later</span>
        <button
          type="button"
          className={css.inlineLink}
          aria-pressed={filter.stage === "stopped"}
          onClick={() => setFilter({ ...filter, stage: filter.stage === "stopped" ? "all" : "stopped" })}
        >
          {STAGE_LABELS.stopped} {i.stopped}
        </button>
      </p>
    </section>
  );
}

export function ScoreChart({
  insights: i,
  threshold,
  filter,
  setFilter,
}: {
  insights: Insights;
  threshold: number;
  filter: CandidateFilter;
  setFilter: (filter: CandidateFilter) => void;
}) {
  const max = Math.max(1, ...i.histogram.map((b) => b.count));
  return (
    <section className={css.panel}>
      <h2 className={css.panelTitle}>Profile score</h2>
      <p className={css.panelLede}>
        {i.aboveThreshold} of {i.scored} reach {threshold} · {i.unscored} unscored
      </p>
      <div className={css.histogram}>
        <div className={css.thresholdLine} style={{ left: `${threshold}%` }}>
          <span>{threshold}</span>
        </div>
        {i.histogram.map((bucket) => {
          const label = `${bucket.min}–${bucket.min === 90 ? 100 : bucket.min + 9}`;
          return (
            <button
              key={bucket.min}
              type="button"
              className={css.bucket}
              data-tip={`Score ${label}: ${bucket.count}`}
              aria-label={`Score ${label}: ${bucket.count} candidates. Filter the table.`}
              aria-pressed={filter.bucket === bucket.min}
              data-dim={filter.bucket !== null && filter.bucket !== bucket.min ? "" : undefined}
              onClick={() => setFilter({ ...filter, bucket: filter.bucket === bucket.min ? null : bucket.min })}
            >
              <span className={css.bucketCount}>{bucket.count || ""}</span>
              <span
                className={bucket.min >= threshold ? css.barPass : css.barBelow}
                style={{ height: `calc((100% - 18px) * ${bucket.count / max})` }}
              />
            </button>
          );
        })}
      </div>
      <div className={css.axis} aria-hidden="true">
        {[0, 20, 40, 60, 80, 100].map((tick) => (
          <span key={tick}>{tick}</span>
        ))}
      </div>
    </section>
  );
}

export function EvidenceChart({ insights: i }: { insights: Insights }) {
  return (
    <section className={css.panel}>
      <h2 className={css.panelTitle}>Evidence in profiles</h2>
      <p className={css.panelLede}>
        {i.weakest
          ? `${CRITERION_LABELS[i.weakest.id]} is weakest: ${percent(i.weakest.counts.met, i.weakest.total)}% met`
          : "No scored profiles yet"}
      </p>
      <div className={css.evidenceRows}>
        {i.evidence.map((row) => (
          <div
            key={row.id}
            className={css.evidenceRow}
            role="img"
            aria-label={`${CRITERION_LABELS[row.id]}: ${RESULTS.map((r) => `${RESULT_LABELS[r]} ${row.counts[r]}`).join(", ")}`}
          >
            <span className={css.stageLabel}>{CRITERION_LABELS[row.id]}</span>
            <span className={css.stack}>
              {RESULTS.filter((r) => row.counts[r]).map((r) => (
                <span
                  key={r}
                  className={`${RESULT_CLASS[r]} ${css.tipTarget}`}
                  data-tip={`${RESULT_LABELS[r]}: ${row.counts[r]}`}
                  style={{ flexGrow: row.counts[r] }}
                />
              ))}
            </span>
            <span className={css.num}>{percent(row.counts.met, row.total)}%</span>
          </div>
        ))}
      </div>
      <p className={css.legend}>
        {RESULTS.map((r) => (
          <span key={r}><i className={RESULT_CLASS[r]} />{RESULT_LABELS[r]}</span>
        ))}
      </p>
    </section>
  );
}

export function SubjectChart({
  insights: i,
  filter,
  setFilter,
}: {
  insights: Insights;
  filter: CandidateFilter;
  setFilter: (filter: CandidateFilter) => void;
}) {
  const max = Math.max(1, ...i.subjects.map((s) => s.candidates));
  return (
    <section className={css.panel}>
      <h2 className={css.panelTitle}>Subject supply</h2>
      <p className={css.panelLede}>
        {i.uncoveredSubjects
          ? `${i.uncoveredSubjects} subjects have no interviewer`
          : "Every subject has an interviewer"}
      </p>
      <div className={css.subjectRows}>
        {i.subjects.map((row) => (
          <button
            key={row.subject}
            type="button"
            className={css.subjectRow}
            aria-pressed={filter.subject === row.subject}
            title={`${row.candidates} active, ${row.passed} paper passed. Interviewers: ${row.interviewers.join(", ") || "none"}`}
            onClick={() => setFilter({ ...filter, subject: filter.subject === row.subject ? null : row.subject })}
          >
            <span className={css.subjectName}>{row.subject}</span>
            <span className={css.subjectTrack}>
              <span style={{ width: `${(row.candidates / max) * 100}%` }} />
            </span>
            <span className={css.num}>{row.candidates}</span>
            {!row.interviewers.length && <span className={css.warnWord}>No interviewer</span>}
          </button>
        ))}
      </div>
    </section>
  );
}
