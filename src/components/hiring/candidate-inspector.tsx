"use client";

import { useEffect, useRef, useState, type ComponentProps } from "react";
import { criterionValues, STAGE_LABELS } from "@/lib/hiring/insights";
import { DEFAULT_PRE_SCREEN_WEIGHTS, SUBJECTS, type HiringConfig, type Subject } from "@/lib/hiring/model";
import type { Assessment, PreScreenAssessment } from "@/lib/hiring/scoring";
import { preScreenNote, visitText, type CandidateExtras } from "@/lib/hiring/status";
import type { Command, HiringCandidate } from "./dashboard";
import { CRITERION_LABELS, PILL_CLASS, RESULT_CLASS, RESULT_LABELS } from "./pipeline-charts";
import { Pentagon } from "./pentagon";
import css from "./dashboard.module.css";

const POINTS = { met: 1, partial: 0.5, not_met: 0, unknown: 0 };
// Mirrors the stages reviewCandidate accepts; the server still enforces them.
const FORM_STAGES = ["new", "review"];
const ONSITE_STAGES = ["new", "review", "pre_screen", "no_reply", "stopped"];
const PAPER_PASS_STAGES = ["paper_booked", "paper_invited", "paper_passed", "mock_booked"];
const SUBJECT_ACTIONS = ["advance", "paper_pass"];

const ANSWER_LABELS: [keyof NonNullable<HiringCandidate["preScreen"]>, string][] = [
  ["degree", "Degree"],
  ["field", "Field of study"],
  ["subjects", "Subjects"],
  ["curricula", "Curricula"],
  ["yearGroups", "Year groups"],
  ["english", "English level"],
  ["englishEvidence", "English evidence"],
  ["experience", "Teaching experience"],
  ["portfolio", "Portfolio"],
  ["availability", "Availability"],
  ["weeklyHours", "Weekly hours"],
  ["motivation", "Motivation"],
  ["teachingApproach", "Teaching approach"],
];

const PRE_SCREEN_PARTS: [Exclude<keyof NonNullable<HiringCandidate["preScreenParts"]>, "total">, string][] = [
  ["degree", "Degree"],
  ["subject", "Subject"],
  ["curriculum", "Curriculum"],
  ["teaching", "Teaching"],
  ["english", "English"],
  ["prestige", "University prestige"],
  ["written", "Written answers"],
  ["availability", "Availability"],
];
const round = (n: number) => Math.round(n * 10) / 10;

function CandidatePentagon({ profile, pre }: { profile: Assessment | null; pre: PreScreenAssessment | null }) {
  const result = (a: { criteria: { id: string; result: keyof typeof RESULT_LABELS }[] }, id: string) => a.criteria.find((c) => c.id === id)?.result ?? "unknown";
  const shapes: ComponentProps<typeof Pentagon>["shapes"] = [];
  if (profile) shapes.push({ label: "Profile", values: criterionValues(profile), tone: "profile" });
  if (pre) shapes.push({ label: "Pre-screen", values: criterionValues(pre), tone: "preScreen" });
  const both = !!(profile && pre);
  const title = both
    ? "DSCTE pentagon with a Profile shape and a Pre-screen shape. Where a corner reads one result then an arrow then another, the first is the Profile result and the second is the Pre-screen result"
    : pre
      ? "DSCTE pentagon for the Pre-screen"
      : "DSCTE pentagon";
  return (
    <>
      <Pentagon
        shapes={shapes}
        size={300}
        title={title}
        labels={Object.entries(CRITERION_LABELS).map(([id, name]) => {
          const before = profile ? RESULT_LABELS[result(profile, id)] : null;
          const after = pre ? RESULT_LABELS[result(pre, id)] : null;
          const value = before === null ? after! : after === null || before === after ? before : `${before} → ${after}`;
          return { name, value };
        })}
      />
      {both && (
        <ul className={css.pentagonKey}>
          <li>
            <i className={css.keyProfile} aria-hidden="true" />
            Profile (grey)
          </li>
          <li>
            <i className={css.keyPre} aria-hidden="true" />
            Pre-screen (orange outline)
          </li>
          <li>A change reads Profile → Pre-screen</li>
        </ul>
      )}
    </>
  );
}

function AssessmentBlock({
  title,
  score,
  assessment,
  weights,
  points,
}: {
  title: string;
  score: number | null;
  assessment: Assessment | PreScreenAssessment;
  weights: Record<string, number>;
  // Pre-screen points are calculated by the server. The profile score is weight times result.
  points?: Record<string, number>;
}) {
  return (
    <section className={css.inspectorSection}>
      <h3 className={css.inspectorHeading}>
        {title}
        <span className={css.num}>{score === null ? "" : `${round(score)}/100`}</span>
      </h3>
      {/* Older assessments have no short summary, so they keep the long one. */}
      <p className={css.inspectorText}>{assessment.briefSummary ?? assessment.summary}</p>
      {assessment.criteria.map((c) => (
        <details key={c.id} className={css.criterion}>
          <summary>
            <i className={RESULT_CLASS[c.result]} aria-hidden="true" />
            <span>{(CRITERION_LABELS as Record<string, string>)[c.id] ?? "Written answers"}</span>
            {c.brief && <span className={css.inspectorText}>{c.brief}</span>}
            <span className={css.criterionResult}>{RESULT_LABELS[c.result]}</span>
            <span className={css.num}>
              {round(points?.[c.id] ?? (weights[c.id] ?? 0) * POINTS[c.result])}/{weights[c.id] ?? 0}
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
  extras,
  seekJobId,
  weights,
  preWeights = DEFAULT_PRE_SCREEN_WEIGHTS,
  busy,
  error,
  notice,
  command,
  onClose,
}: {
  candidate: HiringCandidate;
  extras?: CandidateExtras;
  seekJobId: string;
  weights: HiringConfig["profileWeights"];
  preWeights?: HiringConfig["preScreenWeights"];
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
  const applicationIds = [...new Set([candidate.seekApplicationId, ...candidate.sourceIds].filter((id): id is string => !!id))];
  const visit = extras?.visit;
  // A visit that has ended no longer shows, and it counts as started.
  const started = !visit || new Date(visit.startTime) <= new Date();
  const ahead = !!visit?.visitId && !started;
  const actions = [
    {
      action: "advance",
      label: "Invite to pre-screen",
      allowed: !candidate.preScreen && FORM_STAGES.includes(candidate.stage),
    },
    {
      action: "invite_onsite",
      label: "Invite to onsite visit",
      allowed: !!candidate.preScreen && ONSITE_STAGES.includes(candidate.stage),
    },
    { action: "send_new_link", label: "Send new link", allowed: candidate.stage === "no_booking" },
    { action: "cancel_visit", label: "Cancel visit", allowed: ahead },
    { action: "mark_no_show", label: "Mark no-show", allowed: candidate.stage === "onsite_booked" && started },
    {
      action: "paper_pass",
      label: "Record paper pass and invite to mock",
      allowed: PAPER_PASS_STAGES.includes(candidate.stage),
    },
    // The server refuses a stop while a visit is ahead.
    { action: "stop", label: "Stop processing", allowed: !ahead },
  ].filter((a) => a.allowed);
  const usesSubjects = actions.some((a) => SUBJECT_ACTIONS.includes(a.action));

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
          {applicationIds.map((id, index) => (
            <a
              key={id}
              className={css.sourceLink}
              href={`https://th.employer.seek.com/candidates/?jobid=${encodeURIComponent(seekJobId)}&selected=${encodeURIComponent(id)}&tab=profile`}
              target="_blank"
              rel="noopener noreferrer"
              aria-label={`View ${applicationIds.length > 1 ? `application ${index + 1} on SEEK` : "on SEEK"} for ${candidate.name} (opens in a new tab)`}
            >
              {applicationIds.length > 1 ? `View application ${index + 1} on SEEK` : "View on SEEK"}
            </a>
          ))}
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
        {candidate.preScreen && candidate.preScreenHash && !candidate.preScreenAssessment && (
          <p className={css.inspectorNote}>Pre-screen could not be scored. Its evidence could not be verified.</p>
        )}
        <dl className={css.facts}>
          <div>
            <dt>Work rights</dt>
            <dd>
              {candidate.workRightsAnswer
                ? `${candidate.workRightsAccepted ? "Accepted" : "Not accepted"}: ${candidate.workRightsAnswer}`
                : "No answer on file"}
            </dd>
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
        {(candidate.profileAssessment || candidate.preScreenAssessment) && (
          <CandidatePentagon profile={candidate.profileAssessment} pre={candidate.preScreenAssessment} />
        )}
        {candidate.profileAssessment && (
          <AssessmentBlock
            title="Profile evidence"
            score={candidate.profileScore}
            assessment={candidate.profileAssessment}
            weights={weights}
          />
        )}
        {candidate.preScreenAssessment && (
          <>
            <AssessmentBlock
              title="Pre-screen evidence"
              score={candidate.preScreenScore}
              assessment={candidate.preScreenAssessment}
              weights={preWeights}
              points={candidate.preScreenParts ?? undefined}
            />
            {candidate.preScreenParts && (
              <section className={css.inspectorSection}>
                <h3 className={css.inspectorHeading}>
                  Pre-screen score parts
                  <span className={css.num}>{round(candidate.preScreenParts.total)}/100</span>
                </h3>
                <dl className={css.facts}>
                  {PRE_SCREEN_PARTS.map(([key, label]) => (
                    <div key={key}>
                      <dt>{label}</dt>
                      <dd className={css.num}>
                        {round(candidate.preScreenParts![key])}/{preWeights[key]}
                      </dd>
                    </div>
                  ))}
                </dl>
              </section>
            )}
          </>
        )}
        {extras && (extras.pre.status !== "Not sent" || extras.visit) && (
          <section className={css.inspectorSection}>
            <h3 className={css.inspectorHeading}>
              Pre-screen
              <span className={`${css.pill} ${PILL_CLASS[extras.pre.status]}`}>{extras.pre.status}</span>
            </h3>
            <p className={css.inspectorText}>{preScreenNote(extras.pre, true)}</p>
            {extras.visit && <p className={css.inspectorText}>Booked: {visitText(extras.visit)}</p>}
            {candidate.preScreen && (
              <details>
                <summary className={css.inlineLink}>Read the full response</summary>
                <dl className={css.answers}>
                  {ANSWER_LABELS.map(([key, label]) => (
                    <div key={key}>
                      <dt>{label}</dt>
                      <dd>{candidate.preScreen?.[key] || <span className={css.mutedCell}>No answer</span>}</dd>
                    </div>
                  ))}
                </dl>
              </details>
            )}
          </section>
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
        {usesSubjects && (
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
        )}
        <label className={css.fieldLabel}>
          Decision evidence or reason
          <textarea
            className={css.textarea}
            rows={2}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="Why you are doing this. For a paper pass, identify the marked assessment and the passed subjects."
          />
        </label>
        {candidate.stage === "stopped" && candidate.preScreen && (
          <p className={css.inspectorMeta}>Move this candidate out of Not Suitable in SEEK first.</p>
        )}
        <div className={css.decisionActions}>
          {actions.map(({ action, label }, index) => (
            <button
              key={action}
              type="button"
              className={action === "stop" ? css.stopButton : index === 0 ? css.primary : css.secondary}
              disabled={busy || reason.trim().length < 5 || (SUBJECT_ACTIONS.includes(action) && !subjects.length)}
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
          These actions record a human decision. A click can pass a score below the pass score. It cannot pass a limit or a hard stop. Stopping processing sends no rejection message.
        </p>
      </footer>
    </aside>
  );
}
