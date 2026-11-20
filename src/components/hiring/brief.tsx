"use client";

import { useState } from "react";
import { rubricTotals } from "@/lib/hiring/marking-sheet";
import { ANSWER_LABELS } from "@/lib/hiring/model";
import type { briefView } from "@/lib/hiring/service";
import { BriefDecision } from "./brief-decision";
import { BriefRubric } from "./brief-rubric";
import c from "./booking.module.css";

type Brief = Awaited<ReturnType<typeof briefView>>;
export type BriefPending = "scores" | "recommendation" | null;

export const BriefLoading = () => (
  <p role="status" className={c.note}>
    Loading the candidate…
  </p>
);

/** One message for every failure, so a link tells nothing about a booking. */
export const BriefGone = () => (
  <p role="alert" className={c.alert}>
    This link is invalid or has expired. Ask BeGifted admin for the candidate&apos;s details.
  </p>
);

/** The interviewer's page: who they will meet, the résumé, the form answers, and the interviewer's own score form. No contact details and no AI scores. */
export function InterviewerBrief({ brief, resumeUrl, rubricUrl, decisionUrl }: { brief: Brief; resumeUrl: string; rubricUrl: string; decisionUrl: string }) {
  const [pending, setPending] = useState<BriefPending>(null);
  const [editCount, setEditCount] = useState(0);
  const [lastSent, setLastSent] = useState(() => brief.rubric ? { total: rubricTotals(brief.rubric).total, editCount: 0 } : null);
  const [decision, setDecision] = useState(brief.decision);
  const facts: [string, string][] = [
    ["Subject", brief.subject],
    ...(brief.exam ? ([["Exam", `${brief.exam} (Bangkok)`]] as [string, string][]) : []),
    ["Interviewer", brief.interviewer ?? "To be confirmed"],
  ];
  return (
    <>
      <section className={c.facts}>
        <h2 className={c.subject}>{brief.name}</h2>
        <dl className={`${c.answers} ${c.briefVisit}`}>
          <div>
            <dt className={c.factLabel}>Mock teaching</dt>
            <dd>{brief.mock} (Bangkok)</dd>
          </div>
          <div>
            <dt className={c.factLabel}>Place</dt>
            <dd>{brief.location}</dd>
          </div>
        </dl>
        <dl className={`${c.answers} ${c.briefDetails}`}>
          {facts.map(([label, value]) => (
            <div key={label}>
              <dt className={c.factLabel}>{label}</dt>
              <dd>{value}</dd>
            </div>
          ))}
        </dl>
        {brief.form === "open" && <a className={`${c.ghost} ${c.jumpLink}`} href="#scores">Go to mock scores</a>}
      </section>
      <section className={c.facts}>
        <h2 className={c.stepTitle}>Candidate files</h2>
        {brief.gradedPaper && <a className={`${c.ghost} ${c.jumpLink}`} href={resumeUrl.replace(/resume$/, "paper")} target="_blank" rel="noreferrer">Open the graded paper</a>}
        {brief.resume ? (
          <>
            <a className={c.button} href={resumeUrl} target="_blank" rel="noreferrer">
              {brief.resume === "pdf" ? "Open the résumé (PDF)" : "Download the résumé (Word file)"}
            </a>
            <p className={c.note}>The résumé holds personal data. Do not share this page or the file.</p>
          </>
        ) : (
          <p className={c.note}>No résumé file is stored for this candidate.</p>
        )}
      </section>
      <details className={c.preScreen}>
        <summary className={c.stepTitle}><h2 className={c.summaryHeading}>Pre-screen answers</h2></summary>
        {brief.answers ? (
          <dl className={c.answers}>
            {ANSWER_LABELS.map(([key, label]) => (
              <div key={key}>
                <dt className={c.factLabel}>{label}</dt>
                <dd>{brief.answers?.[key] || "No answer"}</dd>
              </div>
            ))}
          </dl>
        ) : (
          <p className={c.note}>This candidate has no pre-screen reply.</p>
        )}
      </details>
      <section id="scores" className={c.facts} tabIndex={-1}>
        <h2 className={c.stepTitle}>Mock lesson scores</h2>
        <BriefRubric
          saved={brief.rubric}
          form={brief.form}
          url={rubricUrl}
          editCount={editCount}
          lastSent={lastSent}
          decisionSent={!!decision}
          pending={pending}
          setPending={setPending}
          onEdit={() => setEditCount((count) => count + 1)}
          onSent={(total) => setLastSent({ total, editCount })}
        />
      </section>
      {brief.form !== "wait" && (
        <section id="recommendation" className={c.facts} tabIndex={-1}>
          <h2 className={c.stepTitle}>Your recommendation</h2>
          <BriefDecision
            sent={decision}
            onSent={setDecision}
            url={decisionUrl}
            scores={lastSent ? "own" : brief.form === "closed" ? "recorded" : null}
            unsent={lastSent !== null && lastSent.editCount !== editCount}
            pending={pending}
            setPending={setPending}
          />
        </section>
      )}
    </>
  );
}
