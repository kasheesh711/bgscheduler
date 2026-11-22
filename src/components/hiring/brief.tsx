"use client";

import { useState } from "react";
import { ITEM_MAX, RUBRIC_ITEMS, rubricTotals } from "@/lib/hiring/marking-sheet";
import { ANSWER_LABELS } from "@/lib/hiring/model";
import { QUESTION_BANK, STRESS_ELEMENTS, STRESS_SCENARIO, STRESS_STEPS } from "@/lib/hiring/rubric-guide";
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
  const [lastSent, setLastSent] = useState(() => brief.rubric ? { total: rubricTotals(brief.rubric).total, max: rubricTotals(brief.rubric).max, editCount: 0 } : null);
  const [decision, setDecision] = useState(brief.decision);
  const unsent = lastSent !== null && lastSent.editCount !== editCount;
  const jumpToRecommendation = lastSent !== null && !unsent;
  const blocked = brief.form === "closed" && !brief.recommendationReady && !decision;
  const earlyRecommendation = brief.form === "closed" && brief.recommendationReady;
  const facts: [string, string][] = [
    ["Subject", brief.subject],
    ...(brief.exam ? ([["Exam", brief.exam]] as [string, string][]) : []),
    ["Interviewer", brief.interviewer ?? "To be confirmed"],
  ];
  const recommendation = (
    <section id="recommendation" className={c.facts} tabIndex={-1}>
      <h2 className={decision ? "sr-only" : c.stepTitle}>Your recommendation</h2>
      <BriefDecision
        sent={decision}
        onSent={setDecision}
        url={decisionUrl}
        hasScores={lastSent !== null || brief.form === "closed"}
        unsent={unsent}
        pending={pending}
        setPending={setPending}
      />
    </section>
  );
  const wait = brief.form === "wait" && !decision;
  return (
    <>
      <section className={c.facts}>
        <h2 className={c.subject}>{brief.name}</h2>
        <dl className={`${c.answers} ${c.briefVisit}`}>
          <div>
            <dt className={c.factLabel}>Mock teaching</dt>
            <dd>{brief.mock}</dd>
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
        {brief.form === "open" && !decision && (
          <a className={`${c.button} ${c.jumpLink}`} href={jumpToRecommendation ? "#recommendation" : "#scores"}>
            {jumpToRecommendation ? "Go to recommendation" : "Go to mock scores"}
          </a>
        )}
      </section>
      {(wait || blocked) && (
        <div className={c.field}>
          <p role="status">{wait ? "Scores open after the mock."
            : brief.recommendationBlock === "checking" ? "Scores are being checked."
            : "Ask BeGifted admin to check the scores."}</p>
          {(wait || brief.recommendationBlock === "checking") && (
            <button type="button" className={c.button} onClick={() => window.location.reload()}>Check again</button>
          )}
        </div>
      )}
      {earlyRecommendation && recommendation}
      <section className={c.facts}>
        <h2 className={c.stepTitle}>Candidate files</h2>
        {brief.gradedPaper && <a className={`${c.ghost} ${c.jumpLink}`} href={resumeUrl.replace(/resume$/, "paper")} target="_blank" rel="noreferrer" aria-label="Open the graded paper">Graded paper</a>}
        {brief.resume ? (
          <a className={`${c.ghost} ${c.jumpLink}`} href={resumeUrl} target="_blank" rel="noreferrer" aria-label={brief.resume === "pdf" ? "Open the résumé (PDF)" : undefined}>
            {brief.resume === "pdf" ? "Résumé (PDF)" : "Download résumé (Word)"}
          </a>
        ) : (
          <p className={c.note}>No résumé file is stored for this candidate.</p>
        )}
        {(brief.resume || brief.gradedPaper) && <p className={c.note}>Personal data. Do not share.</p>}
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
      <details className={c.preScreen}>
        <summary className={c.stepTitle}><h2 className={c.summaryHeading}>Interviewer guide</h2></summary>
        <h3 className={c.factLabel}>Stress Test: parent role-play</h3>
        <ul className={c.note}>
          {STRESS_STEPS.map((step) => <li key={step}>{step}</li>)}
        </ul>
        <p><strong>Scenario:</strong> <em>&ldquo;{STRESS_SCENARIO}&rdquo;</em></p>
        <dl className={c.answers}>
          {STRESS_ELEMENTS.map(({ key, label, detail }) => (
            <div key={key}>
              <dt className={c.factLabel}>{label}</dt>
              <dd>{detail}</dd>
            </div>
          ))}
        </dl>
        <h3 className={c.factLabel}>Question bank</h3>
        <p className={c.note}>Use any of these during or after the mock. The answers are evidence for the linked item. They are not scored separately.</p>
        <ol className={c.answers}>
          {QUESTION_BANK.map(({ question, informs, good }) => (
            <li key={question}>
              <p><strong>{question}</strong></p>
              <p className={c.note}>Informs: {informs}</p>
              <p>A good answer: {good}</p>
            </li>
          ))}
        </ol>
      </details>
      {!wait && !blocked && (
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
            onSent={(total) => setLastSent({ total, max: RUBRIC_ITEMS.length * ITEM_MAX, editCount })}
          />
        </section>
      )}
      {brief.form !== "wait" && !blocked && !earlyRecommendation && recommendation}
    </>
  );
}
