"use client";

import { type buildInsights, RESULTS, type CriterionResult } from "@/lib/hiring/insights";
import { onsiteMeters, preScreenMeters, type LimitUsage, type Meter } from "@/lib/hiring/limits";
import { localDate, type HiringConfig } from "@/lib/hiring/model";
import type { PreScreenState } from "@/lib/hiring/status";
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
export const PILL_CLASS: Record<PreScreenState, string> = {
  "Not sent": css.pillNone,
  Queued: css.pillQueued,
  Sent: css.pillSent,
  Reminded: css.pillReminded,
  Replied: css.pillReplied,
  "No reply": css.pillNoReply,
  "Earlier contact": css.pillNoReply,
};
const percent = (part: number, whole: number) => (whole ? Math.round((part / whole) * 100) : 0);

function MeterCard({ title, lede, meters, children }: { title: string; lede: string; meters: Meter[]; children?: React.ReactNode }) {
  return (
    <section className={css.limitCard}>
      <h2 className={css.panelTitle}>{title}</h2>
      <p className={css.panelLede}>{lede}</p>
      <div className={css.meterGrid}>
        {meters.map((m) => (
          <div key={m.label}>
            <p className={css.tileLabel}>{m.label}</p>
            <p className={css.meterValue}>
              {m.over > 0 ? (
                <>Over by {m.over}</>
              ) : (
                <>
                  {m.used}
                  <span className={css.meterMax}>{` of ${m.max}${m.max ? ` · ${m.pct}%` : ""}`}</span>
                </>
              )}
            </p>
            <div className={css.meter} aria-hidden="true">
              <span data-full={m.full} style={{ width: `${m.pct}%` }} />
            </div>
            {/* Words, not only colour, so a full limit shows for colour-blind users. */}
            {m.full && <span className={css.meterFull}>Full</span>}
          </div>
        ))}
      </div>
      {children}
    </section>
  );
}

/** The sending limits as they stand now. The numbers come from Postgres through the same counts the worker uses. */
export function LimitMeters({
  usage,
  headMocks,
  config,
  tutors,
}: {
  usage: { preScreen: LimitUsage; onsite: LimitUsage };
  headMocks: Record<string, number>;
  config: HiringConfig;
  tutors: { canonicalKey: string; name: string }[];
}) {
  const names = Object.fromEntries(tutors.map((t) => [t.canonicalKey, t.name]));
  return (
    <div className={css.limitCards}>
      <MeterCard
        title="Pre-screen emails"
        lede="The app stops at each limit. Others wait in the queue, in your subject order."
        meters={preScreenMeters(usage.preScreen, config)}
      />
      <MeterCard
        title="Onsite invitations"
        lede="One visit: 2-hour exam, then 1-hour mock with the head."
        meters={onsiteMeters(usage.onsite, headMocks, config, names)}
      >
        {config.preScreenThreshold === null && (
          <p className={css.warnWord}>No pass score: automatic onsite invitations cannot run.</p>
        )}
      </MeterCard>
      {!(config.enabled && config.deliveryEnabled) && (
        <p className={`${css.railMeta} ${css.limitNote}`}>Automation or messages are paused, so nothing is sent.</p>
      )}
    </div>
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
        <div className={css.thresholdLine} data-start={threshold < 50 ? "" : undefined} style={{ left: `${threshold}%` }}>
          <span>Pass {threshold}</span>
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
      <details className={css.scoreRanges}>
        <summary>Score ranges and candidate counts</summary>
        <ul>{i.histogram.map(bucket => <li key={bucket.min}>Score {bucket.min}–{bucket.min === 90 ? 100 : bucket.min + 9} · {bucket.count} {bucket.count === 1 ? "candidate" : "candidates"}</li>)}</ul>
      </details>
    </section>
  );
}

export function EvidenceChart({ insights: i }: { insights: Insights }) {
  return (
    <section className={css.panel}>
      <h2 className={css.panelTitle}>Evidence in profiles</h2>
      <p className={css.panelLede}>
        {i.weakest
          ? `${CRITERION_LABELS[i.weakest.id]} has the lowest share met (${i.weakest.counts.met} of ${i.weakest.total}).`
          : "No recorded criterion results yet"}
      </p>
      <p className={css.panelLede}>Loaded profiles on {localDate(new Date(i.observedAt))}, Bangkok. Each share divides “Met” results by all recorded results for that criterion.</p>
      <div className={css.evidenceRows}>
        {i.evidence.map((row) => (
          <div
            key={row.id}
            className={css.evidenceRow}
            role="img"
            aria-label={`${CRITERION_LABELS[row.id]}: ${row.counts.met} of ${row.total} met. ${RESULTS.map((r) => `${RESULT_LABELS[r]} ${row.counts[r]}`).join(", ")}`}
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
            <span className={css.num}>{row.total ? `${row.counts.met}/${row.total} · ${percent(row.counts.met, row.total)}%` : "No results"}</span>
            {row.total > 0 && <span className={css.evidenceCounts}>
              {RESULTS.map((result) => <span key={result}><i className={RESULT_CLASS[result]} aria-hidden />{RESULT_LABELS[result]} {row.counts[result]}</span>)}
            </span>}
          </div>
        ))}
      </div>
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
    <section className={`${css.panel} ${css.subjectPanel}`}>
      <h2 className={css.panelTitle}>Subject supply</h2>
      <p className={css.panelLede}>
        {i.uncoveredSubjects
          ? `${i.uncoveredSubjects} subject${i.uncoveredSubjects === 1 ? " has" : "s have"} no interviewer`
          : "Every subject has an interviewer"}
      </p>
      <p className={css.panelLede}>Supply counts candidates who list the subject in every stage except Stopped, Hired and Rejected. It includes No reply, No booking and Soft rejected. Paper passed counts candidates in those same stages with a recorded pass in the subject. Select a subject to see all matching records under the current table filters.</p>
      <div className={css.subjectRows}>
        {i.subjects.map((row) => (
          <button
            key={row.subject}
            type="button"
            className={css.subjectRow}
            aria-pressed={filter.subject === row.subject}
            onClick={() => setFilter({ ...filter, subject: filter.subject === row.subject ? null : row.subject })}
          >
            <span className={css.subjectLabel}>
              <span className={css.subjectName}>{row.subject}</span>
              {!row.interviewers.length && <span className={css.subjectTag}>No head</span>}
            </span>
            <span className={css.subjectTrack}>
              {row.candidates > 0 && <span style={{ width: `${(row.candidates / max) * 100}%` }} />}
            </span>
            <span className={css.subjectFacts}>Supply {row.candidates} · Paper passed {row.passed} · {row.interviewers.length === 1 ? "Interviewer" : "Interviewers"} {row.interviewers.join(", ") || "none"}</span>
          </button>
        ))}
      </div>
    </section>
  );
}
