"use client";

import { useMemo, useState } from "react";
import { isDecided } from "@/lib/hiring/model";
import { PRE_SCREEN_FILTERS, matchesPreScreenList, preScreenFinalScore, visitEmail, wasSentForm, type PreScreenListFilter, type VisitEmail } from "@/lib/hiring/prescreen-view";
import { preScreenNote, type CandidateExtras } from "@/lib/hiring/status";
import { ANSWER_LABELS, AssessmentBlock, ONSITE_STAGES } from "./candidate-inspector";
import type { Command, HiringCandidate, HiringData } from "./dashboard";
import { PILL_CLASS } from "./pipeline-charts";
import css from "./dashboard.module.css";

const round = (n: number) => Math.round(n * 10) / 10;
const toneClass = (tone: VisitEmail["tone"]) =>
  tone === "good" ? css.goodWord : tone === "bad" ? css.errorText : tone === "wait" ? css.warnWord : css.mutedCell;

export function ScoreText({ candidate }: { candidate: Pick<HiringCandidate, "preScreenScore" | "preScreenOverride"> }) {
  const final = preScreenFinalScore(candidate);
  if (final === null) return <span className={css.mutedCell}>Not scored</span>;
  return (
    <span className={css.num}>
      {round(final)}
      {candidate.preScreenOverride && (
        <span className={css.points} title={`Changed by ${candidate.preScreenOverride.by}: ${candidate.preScreenOverride.reason}`}>
          AI {candidate.preScreenScore === null ? "–" : round(candidate.preScreenScore)}
        </span>
      )}
    </span>
  );
}

function PreScreenPanel({
  candidate,
  extra,
  email,
  data,
  command,
  busy,
  error,
  notice,
  onClose,
}: {
  candidate: HiringCandidate;
  extra?: CandidateExtras;
  email: VisitEmail;
  data: HiringData;
  command: Command;
  busy: boolean;
  error: string;
  notice: string;
  onClose: () => void;
}) {
  const [reason, setReason] = useState("");
  const [score, setScore] = useState("");
  const threshold = data.config.preScreenThreshold;
  const final = preScreenFinalScore(candidate);
  const below = threshold !== null && final !== null && final < threshold;
  const visit = extra?.visit;
  // The server refuses a stop while a visit is ahead.
  const ahead = !!visit?.visitId && new Date(visit.startTime) > new Date();
  const scoreValue = Number(score);
  const scoreValid = score.trim() !== "" && scoreValue >= 0 && scoreValue <= 100;
  const hasReason = reason.trim().length >= 5;
  const act = async (action: string) => {
    if (await command({ action, id: candidate.id, revision: candidate.revision, subjects: candidate.subjects, reason })) setReason("");
  };
  const buttons = [
    {
      action: "invite_onsite",
      label: below ? "Invite despite low score" : "Invite to visit",
      allowed: !!candidate.preScreenAssessment && ONSITE_STAGES.includes(candidate.stage),
    },
    {
      action: "send_new_link",
      label: "Resend with a new link",
      allowed: candidate.stage === "no_booking" || candidate.stage === "onsite_invited",
    },
    { action: "stop", label: "Stop", allowed: !ahead && !isDecided(candidate.stage) },
  ].filter((button) => button.allowed);
  return (
    <aside className={`${css.inspector} ${css.seekPanel}`} aria-label={`Pre-screen of ${candidate.name}`}>
      <header className={css.inspectorHead}>
        <div>
          <h2 className={css.inspectorName}>{candidate.name}</h2>
          <p className={css.inspectorMeta}>{candidate.email || "Email needs review"}</p>
        </div>
        <button type="button" className={css.inlineLink} onClick={onClose}>
          Close
        </button>
      </header>
      <div className={css.inspectorBody}>
        <p className={css.inspectorScore}>
          {final === null ? "Not scored" : round(final)}
          {final !== null && <span>/100 pre-screen{threshold !== null && ` · pass score ${threshold}`}</span>}
        </p>
        {candidate.preScreenOverride && (
          <p className={css.inspectorNote}>
            {candidate.preScreenOverride.by} changed the AI score of {candidate.preScreenScore === null ? "–" : round(candidate.preScreenScore)}: {candidate.preScreenOverride.reason}
          </p>
        )}
        <dl className={css.facts}>
          <div>
            <dt>Visit email</dt>
            <dd className={toneClass(email.tone)}>{email.label}</dd>
          </div>
          {extra && (
            <div>
              <dt>Form</dt>
              <dd>{preScreenNote(extra.pre, true) || extra.pre.status}</dd>
            </div>
          )}
          {extra?.visitFacts.map(([label, value]) => (
            <div key={label}>
              <dt>{label}</dt>
              <dd>{value}</dd>
            </div>
          ))}
        </dl>
        {email.error && <p className={css.errorText}>{email.error}</p>}
        {candidate.preScreen && candidate.preScreenHash && !candidate.preScreenAssessment && (
          <p className={css.inspectorNote}>The AI could not verify the evidence in this response, so it has no score.</p>
        )}
        {candidate.preScreenAssessment && (
          <AssessmentBlock
            title="Why the AI scored it this way"
            score={candidate.preScreenScore}
            assessment={candidate.preScreenAssessment}
            weights={data.config.preScreenWeights}
            points={candidate.preScreenParts ?? undefined}
          />
        )}
        <section className={css.inspectorSection}>
          <h3 className={css.inspectorHeading}>Their answers</h3>
          {candidate.preScreen ? (
            <dl className={css.answers}>
              {ANSWER_LABELS.map(([key, label]) => (
                <div key={key}>
                  <dt>{label}</dt>
                  <dd>{candidate.preScreen?.[key] || <span className={css.mutedCell}>No answer</span>}</dd>
                </div>
              ))}
            </dl>
          ) : (
            <p className={css.inspectorText}>No reply yet.</p>
          )}
        </section>
      </div>
      <footer className={css.decision}>
        {error && <p role="alert" className={css.errorText}>{error}</p>}
        {notice && <p role="status" className={css.goodWord}>{notice}</p>}
        <label className={css.fieldLabel}>
          Reason
          <textarea className={css.textarea} rows={2} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Why you are doing this" />
        </label>
        <div className={css.decisionActions}>
          {buttons.map(({ action, label }, index) => (
            <button
              key={action}
              type="button"
              className={action === "stop" ? css.stopButton : index === 0 ? css.primary : css.secondary}
              disabled={busy || !hasReason}
              onClick={() => void act(action)}
            >
              {label}
            </button>
          ))}
        </div>
        {candidate.preScreenAssessment && (
          <div className={css.decisionActions}>
            <label className={css.filterSelect}>
              New score
              <input className={css.numberInput} type="number" min={0} max={100} value={score} onChange={(e) => setScore(e.target.value)} />
            </label>
            <button
              type="button"
              className={css.secondary}
              disabled={busy || !hasReason || !scoreValid}
              onClick={async () => {
                if (await command({ action: "pre_screen_score", id: candidate.id, revision: candidate.revision, score: scoreValue, reason })) {
                  setReason("");
                  setScore("");
                }
              }}
            >
              Change score
            </button>
          </div>
        )}
        <p className={css.inspectorMeta}>
          {!hasReason && "Write a reason of at least 5 characters to enable these actions. "}
          Changing the score sends nothing. After a change, only a person can invite this candidate to a visit.
        </p>
      </footer>
    </aside>
  );
}

export function PreScreenScreen({
  data,
  extras,
  holds,
  command,
  busy,
  error,
  notice,
}: {
  data: HiringData;
  extras: Map<string, CandidateExtras>;
  holds: Map<string, { short: string; long: string[] }>;
  command: Command;
  busy: boolean;
  error: string;
  notice: string;
}) {
  const [filter, setFilter] = useState<PreScreenListFilter>("All");
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<string | null>(null);
  const threshold = data.config.preScreenThreshold;

  const pool = useMemo(() => {
    const jobs = new Map<string, HiringData["inviteOutbox"]>();
    for (const job of data.inviteOutbox) if (job.candidateId) jobs.set(job.candidateId, [...(jobs.get(job.candidateId) ?? []), job]);
    return data.candidates.flatMap((candidate) => {
      const rows = jobs.get(candidate.id) ?? [];
      return wasSentForm(candidate, rows)
        ? [{ candidate, email: visitEmail(candidate, rows, threshold, holds.get(candidate.id)?.short) }]
        : [];
    });
  }, [data.candidates, data.inviteOutbox, threshold, holds]);
  const counts = PRE_SCREEN_FILTERS.map((name) => pool.filter((row) => matchesPreScreenList(row.candidate, name, threshold, row.email)).length);
  const needle = query.trim().toLowerCase();
  const rows = pool
    .filter((row) => matchesPreScreenList(row.candidate, filter, threshold, row.email))
    .filter((row) => !needle || `${row.candidate.name} ${row.candidate.email ?? ""}`.toLowerCase().includes(needle))
    // Replies first, by score. Then the people still waiting.
    .sort((a, b) => (preScreenFinalScore(b.candidate) ?? -1) - (preScreenFinalScore(a.candidate) ?? -1) || Number(!!b.candidate.preScreen) - Number(!!a.candidate.preScreen));
  const open = pool.find((row) => row.candidate.id === selected);

  return (
    <div className={css.layout}>
      <div className={css.main}>
        <section className={css.tableSection} aria-label="Pre-screen responses">
          <div className={css.tableTools}>
            <input className={css.search} type="search" placeholder="Search name or email" aria-label="Search pre-screen responses" value={query} onChange={(e) => setQuery(e.target.value)} />
            <div className={css.tabs} role="group" aria-label="Filter pre-screen responses">
              {PRE_SCREEN_FILTERS.map((name, index) => (
                <button key={name} type="button" aria-pressed={filter === name} onClick={() => setFilter(name)}>
                  {name} <span className={css.tabCount}>{counts[index]}</span>
                </button>
              ))}
            </div>
          </div>
          {threshold === null && <p className={css.activeFilters}>No pass score is set in Rules and setup, so Passed and Below pass score stay empty.</p>}
          <div className={css.tableScroll}>
            <table className={css.table}>
              <thead>
                <tr>
                  <th>Candidate</th>
                  <th>Form</th>
                  <th>Score</th>
                  <th>Visit email</th>
                </tr>
              </thead>
              <tbody>
                {rows.map(({ candidate: c, email }) => {
                  const extra = extras.get(c.id);
                  return (
                    <tr key={c.id} data-selected={selected === c.id ? "" : undefined} onClick={() => setSelected(c.id)}>
                      <td className={css.candidateCell}>
                        <button
                          type="button"
                          className={css.nameButton}
                          onClick={(e) => {
                            e.stopPropagation();
                            setSelected(c.id);
                          }}
                        >
                          {c.name}
                        </button>
                        <span className={css.email}>{c.subjects.join(", ") || "No subject yet"}</span>
                      </td>
                      <td className={css.preCell}>
                        {extra && <span className={`${css.pill} ${PILL_CLASS[extra.pre.status]}`}>{extra.pre.status}</span>}
                        {extra && <span className={css.pillNote}>{preScreenNote(extra.pre)}</span>}
                      </td>
                      <td>
                        <ScoreText candidate={c} />
                      </td>
                      <td className={css.preCell}>
                        <span className={toneClass(email.tone)}>{email.label}</span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            {!rows.length && <p className={css.empty}>{pool.length ? "No candidates match this filter." : "No pre-screen forms sent yet."}</p>}
          </div>
        </section>
      </div>
      {open && (
        <PreScreenPanel
          key={open.candidate.id}
          candidate={open.candidate}
          extra={extras.get(open.candidate.id)}
          email={open.email}
          data={data}
          command={command}
          busy={busy}
          error={error}
          notice={notice}
          onClose={() => setSelected(null)}
        />
      )}
    </div>
  );
}
