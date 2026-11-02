"use client";

import { useEffect, useRef, useState, type ComponentProps } from "react";
import { criterionValues, STAGE_LABELS } from "@/lib/hiring/insights";
import { DEFAULT_PRE_SCREEN_WEIGHTS, isDecided, RESUME_TYPES, SUBJECTS, type HiringConfig, type Subject } from "@/lib/hiring/model";
import type { Assessment, PreScreenAssessment } from "@/lib/hiring/scoring";
import { preScreenNote, visitText, type CandidateExtras } from "@/lib/hiring/status";
import type { Command, HiringCandidate } from "./dashboard";
import { CRITERION_LABELS, PILL_CLASS, RESULT_CLASS, RESULT_LABELS } from "./pipeline-charts";
import { Pentagon } from "./pentagon";
import css from "./dashboard.module.css";

const POINTS = { met: 1, partial: 0.5, not_met: 0, unknown: 0 };
// Mirrors the stages reviewCandidate accepts; the server still enforces them.
const FORM_STAGES = ["new", "review"];
export const ONSITE_STAGES = ["new", "review", "pre_screen", "no_reply", "stopped"];
const PAPER_PASS_STAGES = ["paper_booked", "paper_invited", "paper_passed", "mock_booked"];
const SUBJECT_ACTIONS = ["advance", "paper_pass"];

export const ANSWER_LABELS: [keyof NonNullable<HiringCandidate["preScreen"]>, string][] = [
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

export function AssessmentBlock({
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

const RESUME_FAILED = "The résumé could not be opened. Try again.";
type ResumeCheck = { status: "checking" | "ready" } | { status: "failed"; message: string };
/** An iframe cannot read a 404, so the route is asked first. Its message reaches the panel in place of raw JSON. */
export async function checkResume(src: string): Promise<ResumeCheck> {
  try {
    const response = await fetch(src, { cache: "no-store" });
    // A session that ended redirects to the login page, which is a 200.
    if (response.redirected || response.ok) {
      await response.body?.cancel();
      return response.redirected ? { status: "failed", message: "Sign in again to open this file." } : { status: "ready" };
    }
    const value = await response.json();
    return { status: "failed", message: value.error || RESUME_FAILED };
  } catch {
    return { status: "failed", message: RESUME_FAILED };
  }
}

/** Asks the route about the file once the viewer opens, and again for each candidate. */
export function useResumeCheck(id: string, open: boolean, hasFile: boolean) {
  const [check, setCheck] = useState<ResumeCheck>({ status: "checking" });
  useEffect(() => {
    if (!open || !hasFile) return;
    let active = true;
    checkResume(`/api/hiring/resume/${encodeURIComponent(id)}`).then((result) => {
      if (active) setCheck(result);
    });
    return () => {
      active = false;
      setCheck({ status: "checking" });
    };
  }, [open, hasFile, id]);
  return check;
}

/** The extracted profile and résumé text, read on demand because the dashboard data leaves it out. */
export function useSourceText(id: string, load = true) {
  const [source, setSource] = useState<{ id: string; profileText: string } | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    if (!load) return;
    let active = true;
    fetch(`/api/hiring?candidateId=${encodeURIComponent(id)}`, { cache: "no-store" })
      .then(async (response) => {
        const value = await response.json();
        if (!response.ok) throw new Error(value.error);
        if (active) setSource(value);
      })
      .catch((e) => {
        if (active) setError(e.message);
      });
    return () => {
      active = false;
    };
  }, [id, load]);
  return { source, error };
}

export function SourceTextBody({ id, source, error }: { id: string } & ReturnType<typeof useSourceText>) {
  if (error) return <p role="alert" className={css.errorText}>{error}</p>;
  if (source?.id !== id) return <p role="status" className={css.inspectorMeta}>Loading source text…</p>;
  if (source.profileText) return <pre>{source.profileText}</pre>;
  return <p className={css.inspectorMeta}>No extracted profile or résumé text is available for this record.</p>;
}

export function SeekLinks({ candidate, seekJobId }: { candidate: Pick<HiringCandidate, "name" | "seekApplicationId" | "sourceIds">; seekJobId: string }) {
  const applicationIds = [...new Set([candidate.seekApplicationId, ...candidate.sourceIds].filter((id): id is string => !!id))];
  return applicationIds.map((id, index) => (
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
  ));
}

export function ResumeBody({
  id,
  name,
  state,
  type,
  months,
  check,
}: {
  id: string;
  name: string;
  state: HiringCandidate["resumeState"];
  type: string | null;
  months: number;
  check: ResumeCheck;
}) {
  if (state === "deleted")
    return (
      <p className={css.inspectorMeta}>
        Original résumé deleted after {months} month{months === 1 ? "" : "s"} with no activity. The extracted text stays below.
      </p>
    );
  if (state !== "available") return <p className={css.inspectorMeta}>No original file is stored yet. The extracted text stays below.</p>;
  if (check.status === "checking") return <p role="status" className={css.inspectorMeta}>Opening the file…</p>;
  if (check.status === "failed") return <p role="alert" className={css.errorText}>{check.message}</p>;
  const src = `/api/hiring/resume/${encodeURIComponent(id)}`;
  return (
    <>
      {/* No sandbox attribute: Chrome blocks its PDF viewer in any sandboxed iframe, with every allow token. The route sends the sandbox as a CSP header, which the viewer accepts. */}
      {type === RESUME_TYPES.pdf && (
        <>
          <p className={css.inspectorMeta}>A link in a résumé can open another site. Do not sign in on a page that opens from a résumé.</p>
          <iframe className={css.resumeFrame} src={src} title={`Original résumé of ${name}`} />
        </>
      )}
      <a className={css.sourceLink} href={src} download>
        Download
      </a>
    </>
  );
}

export function CandidateInspector({
  candidate,
  extras,
  hold,
  seekJobId,
  weights,
  preWeights = DEFAULT_PRE_SCREEN_WEIGHTS,
  busy,
  error,
  notice,
  command,
  onClose,
  resumeOpen = false,
  onResumeToggle,
  retentionMonths = 12,
}: {
  candidate: HiringCandidate;
  extras?: CandidateExtras;
  /** Queue place and limit, or the profile gate reasons. */
  hold?: { short: string; long: string[] } | null;
  seekJobId: string;
  weights: HiringConfig["profileWeights"];
  preWeights?: HiringConfig["preScreenWeights"];
  busy: boolean;
  error: string;
  notice: string;
  command: Command;
  onClose: () => void;
  resumeOpen?: boolean;
  onResumeToggle?: (open: boolean) => void;
  retentionMonths?: number;
}) {
  const [subjects, setSubjects] = useState<Subject[]>(candidate.subjects);
  const [reason, setReason] = useState("");
  const sourceText = useSourceText(candidate.id);
  const resumeCheck = useResumeCheck(candidate.id, resumeOpen, candidate.resumeState === "available");
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

  const university = candidate.universityAssessment;
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
    { action: "send_new_link", label: "Send new link", allowed: candidate.stage === "no_booking" || candidate.stage === "onsite_invited" },
    { action: "cancel_visit", label: "Cancel visit", allowed: ahead },
    { action: "mark_no_show", label: "Mark no-show", allowed: candidate.stage === "onsite_booked" && started },
    {
      action: "paper_pass",
      label: "Record paper pass and invite to mock",
      allowed: PAPER_PASS_STAGES.includes(candidate.stage),
    },
    // The server refuses a stop while a visit is ahead.
    { action: "stop", label: "Stop processing", allowed: !ahead && !isDecided(candidate.stage) },
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
          <SeekLinks candidate={candidate} seekJobId={seekJobId} />
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
        {candidate.hasSourceText === false && <p className={css.inspectorNote}>No source text</p>}
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
        {hold && (
          <section className={css.inspectorSection} aria-label="Why this is waiting">
            <h3 className={css.inspectorHeading}>Waiting to send</h3>
            <ul className={css.holdList}>
              {hold.long.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          </section>
        )}
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
            {extras.visitFacts.length > 0 ? (
              <dl className={css.facts} aria-label="Booked visit">
                {extras.visitFacts.map(([label, value]) => (
                  <div key={label}>
                    <dt>{label}</dt>
                    <dd>{value}</dd>
                  </div>
                ))}
              </dl>
            ) : (
              extras.visit && <p className={css.inspectorText}>Booked: {visitText(extras.visit)}</p>
            )}
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
        <details
          className={css.sourceText}
          open={resumeOpen}
          onToggle={(e) => {
            // The browser also fires this after a re-render, with the same value.
            if (e.currentTarget.open !== resumeOpen) onResumeToggle?.(e.currentTarget.open);
          }}
        >
          <summary>
            Original résumé{candidate.resumeState === "deleted" ? " (deleted)" : candidate.resumeState === "available" ? "" : " (no file yet)"}
          </summary>
          {resumeOpen && (
            <ResumeBody
              id={candidate.id}
              name={candidate.name}
              state={candidate.resumeState}
              type={candidate.resumeType}
              months={retentionMonths}
              check={resumeCheck}
            />
          )}
        </details>
        <details className={css.sourceText}>
          <summary>Extracted profile and résumé</summary>
          <p className={css.inspectorMeta}>
            Source text from SEEK. Some personal details are removed during extraction.
          </p>
          <SourceTextBody id={candidate.id} {...sourceText} />
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
