"use client";

import { useEffect, useRef, useState } from "react";
import { STAGE_LABELS } from "@/lib/hiring/insights";
import { SUBJECTS, type HiringConfig, type Subject } from "@/lib/hiring/model";
import type { Assessment } from "@/lib/hiring/scoring";
import type { Command, HiringCandidate } from "./dashboard";
import { CRITERION_LABELS, RESULT_CLASS, RESULT_LABELS } from "./pipeline-charts";
import css from "./dashboard.module.css";

const POINTS = { met: 1, partial: 0.5, not_met: 0, unknown: 0 };
// Mirrors the stages reviewCandidate accepts; the server still enforces them.
const ADVANCE_STAGES = ["new", "review", "pre_screen"];
const PAPER_PASS_STAGES = ["paper_booked", "paper_invited", "paper_passed", "mock_booked"];

function AssessmentBlock({
  title,
  score,
  assessment,
  weights,
}: {
  title: string;
  score: number | null;
  assessment: Assessment;
  weights: HiringConfig["profileWeights"];
}) {
  return (
    <section className={css.inspectorSection}>
      <h3 className={css.inspectorHeading}>
        {title}
        <span className={css.num}>{score === null ? "" : `${Math.round(score * 10) / 10}/100`}</span>
      </h3>
      <p className={css.inspectorText}>{assessment.summary}</p>
      {assessment.criteria.map((c) => (
        <details key={c.id} className={css.criterion}>
          <summary>
            <i className={RESULT_CLASS[c.result]} aria-hidden="true" />
            <span>{CRITERION_LABELS[c.id]}</span>
            <span className={css.criterionResult}>{RESULT_LABELS[c.result]}</span>
            <span className={css.num}>
              {weights[c.id] * POINTS[c.result]}/{weights[c.id]}
            </span>
          </summary>
          <p className={css.inspectorText}>{c.reason}</p>
          <blockquote>{c.evidence || "No evidence in source."}</blockquote>
        </details>
      ))}
    </section>
  );
}

export function CandidateInspector({
  candidate,
  weights,
  busy,
  error,
  notice,
  command,
  onClose,
}: {
  candidate: HiringCandidate;
  weights: HiringConfig["profileWeights"];
  busy: boolean;
  error: string;
  notice: string;
  command: Command;
  onClose: () => void;
}) {
  const [subjects, setSubjects] = useState<Subject[]>(candidate.subjects);
  const [reason, setReason] = useState("");
  const [source, setSource] = useState<{ id: string; profileText: string } | null>(null);
  const [sourceError, setSourceError] = useState("");
  const heading = useRef<HTMLHeadingElement>(null);
  const opener = useRef<HTMLElement | null>(null);
  useEffect(() => {
    // ??= keeps the row button when Strict Mode runs this effect twice.
    opener.current ??= document.activeElement as HTMLElement | null;
    heading.current?.focus();
  }, []);
  function close() {
    onClose();
    opener.current?.focus();
  }
  useEffect(() => {
    let active = true;
    fetch(`/api/hiring?candidateId=${encodeURIComponent(candidate.id)}`, { cache: "no-store" })
      .then(async (response) => {
        const value = await response.json();
        if (!response.ok) throw new Error(value.error);
        if (active) setSource(value);
      })
      .catch((error) => {
        if (active) setSourceError(error.message);
      });
    return () => {
      active = false;
    };
  }, [candidate.id]);

  const university = candidate.universityAssessment;
  const actions = [
    {
      action: "advance",
      label: candidate.preScreen ? "Invite to paper assessment" : "Invite to pre-screen",
      allowed: ADVANCE_STAGES.includes(candidate.stage),
    },
    {
      action: "paper_pass",
      label: "Record paper pass and invite to mock",
      allowed: PAPER_PASS_STAGES.includes(candidate.stage),
    },
    { action: "stop", label: "Stop processing", allowed: true },
  ].filter((a) => a.allowed);

  return (
    <aside
      className={css.inspector}
      aria-label={`Candidate ${candidate.name}`}
      onKeyDown={(e) => {
        // A drafted reason must not vanish on a stray key.
        if (e.key === "Escape" && !reason) close();
      }}
    >
      <header className={css.inspectorHead}>
        <div>
          <h2 className={css.inspectorName} ref={heading} tabIndex={-1}>{candidate.name}</h2>
          <p className={css.inspectorMeta}>
            {STAGE_LABELS[candidate.stage]} · {candidate.email || "Email needs review"}
          </p>
        </div>
        <button type="button" className={css.inlineLink} onClick={close}>
          Close
        </button>
      </header>
      <div className={css.inspectorBody}>
        <p className={css.inspectorScore}>
          {candidate.profileScore === null ? "Not scored" : Math.round(candidate.profileScore * 10) / 10}
          {candidate.profileScore !== null && <span>/100 profile</span>}
        </p>
        {candidate.reviewNote && <p className={css.inspectorNote}>{candidate.reviewNote}</p>}
        <dl className={css.facts}>
          <div>
            <dt>Work rights</dt>
            <dd>{candidate.workRightsConfirmed ? "Confirmed" : candidate.workRightsConfirmed === false ? "Not confirmed" : "Unknown"}</dd>
          </div>
          <div>
            <dt>Earlier contact</dt>
            <dd>{candidate.previouslyContacted ? "Yes" : "No"}</dd>
          </div>
          <div>
            <dt>Paper passed</dt>
            <dd>{candidate.paperPassedSubjects.join(", ") || "None"}</dd>
          </div>
        </dl>
        {candidate.profileAssessment && (
          <AssessmentBlock
            title="Profile evidence"
            score={candidate.profileScore}
            assessment={candidate.profileAssessment}
            weights={weights}
          />
        )}
        {candidate.preScreenAssessment && (
          <AssessmentBlock
            title="Pre-screen evidence"
            score={candidate.preScreenScore}
            assessment={candidate.preScreenAssessment}
            weights={weights}
          />
        )}
        {university && (
          <section className={css.inspectorSection}>
            <h3 className={css.inspectorHeading}>
              University prestige
              <span className={css.num}>
                {Math.round(university.fraction * weights.prestige * 100) / 100}/{weights.prestige}
              </span>
            </h3>
            <p className={css.inspectorText}>{university.name ?? "University not confirmed"}</p>
            <p className={css.inspectorText}>{university.reason}</p>
            {university.sources.map((href) => (
              <a className={css.sourceLink} href={href} key={href} target="_blank" rel="noreferrer">
                Source
              </a>
            ))}
          </section>
        )}
        <details className={css.sourceText}>
          <summary>Extracted profile and résumé</summary>
          <p className={css.inspectorMeta}>
            Source text from SEEK. Some personal details are removed during extraction.
          </p>
          {sourceError ? (
            <p role="alert" className={css.errorText}>{sourceError}</p>
          ) : source?.id !== candidate.id ? (
            <p role="status" className={css.inspectorMeta}>Loading source text…</p>
          ) : source.profileText ? (
            <pre>{source.profileText}</pre>
          ) : (
            <p className={css.inspectorMeta}>No extracted profile or résumé text is available for this record.</p>
          )}
        </details>
      </div>
      <footer className={css.decision}>
        {error && <p role="alert" className={css.errorText}>{error}</p>}
        {notice && <p role="status" className={css.goodWord}>{notice}</p>}
        <fieldset className={css.subjectPicker}>
          <legend>Subjects</legend>
          {SUBJECTS.map((subject) => (
            <label key={subject}>
              <input
                type="checkbox"
                checked={subjects.includes(subject)}
                onChange={(e) =>
                  setSubjects(e.target.checked ? [...subjects, subject] : subjects.filter((v) => v !== subject))
                }
              />
              {subject}
            </label>
          ))}
        </fieldset>
        <label className={css.fieldLabel}>
          Decision evidence or reason
          <textarea
            className={css.textarea}
            rows={2}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="For a paper pass, identify the marked assessment and the passed subjects."
          />
        </label>
        <div className={css.decisionActions}>
          {actions.map(({ action, label }, index) => (
            <button
              key={action}
              type="button"
              className={action === "stop" ? css.stopButton : index === 0 ? css.primary : css.secondary}
              disabled={busy || reason.trim().length < 5 || (action !== "stop" && !subjects.length)}
              onClick={async () => {
                const saved = await command({
                  action,
                  id: candidate.id,
                  revision: candidate.revision,
                  subjects,
                  reason,
                });
                // Each decision needs its own reason, so a second click cannot send a second invitation.
                if (saved) setReason("");
              }}
            >
              {label}
            </button>
          ))}
        </div>
        <p className={css.inspectorMeta}>
          {reason.trim().length < 5 && "Write a reason of at least 5 characters to enable these actions. "}
          These actions record a human decision. Stopping processing sends no rejection message.
        </p>
      </footer>
    </aside>
  );
}
