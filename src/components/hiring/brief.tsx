"use client";

import { useEffect, useRef, useState, useTransition, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { ITEM_MAX, RUBRIC_ITEMS, rubricTotals } from "@/lib/hiring/marking-sheet";
import { ANSWER_LABELS } from "@/lib/hiring/model";
import { QUESTION_BANK, STRESS_ELEMENTS, STRESS_SCENARIO, STRESS_STEPS } from "@/lib/hiring/rubric-guide";
import type { briefView } from "@/lib/hiring/service";
import { BriefDecision } from "./brief-decision";
import { BriefRubric } from "./brief-rubric";
import { PdfPages } from "./pdf-pages";
import c from "./booking.module.css";
import b from "./brief.module.css";

type Brief = Awaited<ReturnType<typeof briefView>>;
export type BriefPending = "scores" | "recommendation" | null;

/** The brief has its own wide page. The booking pages keep the narrow card. */
export const BriefShell = ({ children, bare = false }: { children: ReactNode; bare?: boolean }) => (
  <main className={c.page} data-brief="" data-bare={bare ? "" : undefined}>
    <div className={b.wrap}>{children}</div>
  </main>
);

/** From a LINE link to the head's whole list (Kevin, 24 Nov 2026). /hiring asks for a sign-in first. */
export const ScheduleLink = () => (
  <a className={b.back} href="/hiring?view=heads">
    ← My hiring list
  </a>
);

/** Inside the head's Hiring screen (a frame), a save tells the list beside it to reload. Same origin only. */
export function tellHiringList() {
  if (window.parent !== window) window.parent.postMessage({ type: "hiring-saved" }, window.location.origin);
}

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

type Doc = "resume" | "paper" | "answers" | "guide";
// "Application", not "Answers": a head read it as the paper's answers (Sol review, round 19).
const DOCS: [Doc, string][] = [["resume", "Résumé"], ["paper", "Paper"], ["answers", "Application"], ["guide", "Guide"]];
const points = (value: number) => String(Math.round(value * 10) / 10);

/**
 * The interviewer's page: the score sheet for the mock, with the candidate's résumé and graded paper beside it and the
 * résumé score in parts. No contact details outside the résumé itself.
 */
export function InterviewerBrief({ brief, resumeUrl, rubricUrl, decisionUrl, pdfRuntime, compact = false }: { brief: Brief; resumeUrl: string; rubricUrl: string; decisionUrl: string; /** The demo gives the staff copy of the pdf.js files: its link has no real token. */ pdfRuntime?: string;
  /** Inside the head's Hiring screen: a short header, so the scores and the résumé lead (Kevin, 24 Nov 2026). */ compact?: boolean }) {
  const [pending, setPending] = useState<BriefPending>(null);
  const [editCount, setEditCount] = useState(0);
  const [lastSent, setLastSent] = useState(() => brief.rubric ? { total: rubricTotals(brief.rubric).total, max: rubricTotals(brief.rubric).max, editCount: 0 } : null);
  const [decision, setDecision] = useState(brief.decision);
  // An in-place refresh can bring scores or a recommendation sent from another device (the phone). They replace what
  // this page showed, so it never asks for scores again over sent ones (code review, round 20).
  const serverRubric = brief.rubric ? JSON.stringify(brief.rubric) : null;
  const [seenRubric, setSeenRubric] = useState(serverRubric);
  if (serverRubric !== seenRubric) {
    setSeenRubric(serverRubric);
    if (brief.rubric && !lastSent) {
      const sent = rubricTotals(brief.rubric);
      setLastSent({ total: sent.total, max: sent.max, editCount });
    }
  }
  if (brief.decision && !decision) setDecision(brief.decision);
  const [doc, setDoc] = useState<Doc>("resume");
  const [paperOpened, setPaperOpened] = useState(false);
  const unsent = lastSent !== null && lastSent.editCount !== editCount;
  // A check for the recommendation fetches the brief again in place: the open file tab and unsent score edits stay
  // (Sol review, round 17). The head's list asks the same when its row now names another part.
  // The refresh runs as a transition, so "Checking…" shows until the new brief is on screen; then the part asked for
  // opens, or the check says the recommendation is not open yet (Sol review, round 18).
  const router = useRouter();
  const [checking, startCheck] = useTransition();
  const [checked, setChecked] = useState(false);
  const asked = useRef<string | null>(null);
  const refresh = (part: string) => {
    asked.current = part;
    setChecked(true);
    startCheck(() => router.refresh());
  };
  useEffect(() => {
    if (checking || asked.current === null) return;
    const target = asked.current ? document.getElementById(asked.current) : null;
    asked.current = null;
    target?.scrollIntoView({ block: "start" });
    target?.focus({ preventScroll: true });
  }, [checking]);
  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      if (event.origin !== window.location.origin || event.source !== window.parent || event.data?.type !== "hiring-refresh") return;
      asked.current = typeof event.data.part === "string" ? event.data.part : "";
      // A refresh at mock start is not a question about the recommendation, so it says nothing (critic review, round 19).
      if (asked.current === "recommendation") setChecked(true);
      startCheck(() => router.refresh());
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [router]);
  const blocked = brief.form === "closed" && brief.mockEnded && !brief.recommendationReady && !decision;
  const earlyRecommendation = brief.form === "closed" && brief.recommendationReady;
  const paperUrl = resumeUrl.replace(/resume$/, "paper");
  const runtime = pdfRuntime ?? resumeUrl.replace(/resume$/, "pdf-runtime");
  // The head is the interviewer and the place does not change, so the short header keeps the subject and the time.
  const facts: [string, string][] = [
    ["Subject", brief.subject],
    // The label says whether the mock is still to come or under way (Sol review, round 17). Each instruction sits where it
    // is used: before the mock under the facts, sending with the scores, recommending by its check (Sol review, round 18).
    [brief.mockEnded || brief.decision ? "Mock teaching" : brief.mockStarted ? "Mock now" : "Upcoming mock", compact ? brief.mock : `${brief.mock} (Bangkok)`],
    ...(brief.exam && !compact ? ([["Exam", brief.exam]] as [string, string][]) : []),
    ...(compact ? [] : ([["Place", brief.location], ["Interviewer", brief.interviewer ?? "To be confirmed"]] as [string, string][])),
  ];
  const recommendation = (
    <section id="recommendation" className={b.panel} tabIndex={-1}>
      <h2 className={decision ? "sr-only" : b.panelTitle}>Your recommendation</h2>
      <BriefDecision
        sent={decision}
        onSent={(sent) => {
          setDecision(sent);
          tellHiringList();
        }}
        url={decisionUrl}
        hasScores={lastSent !== null || brief.form === "closed"}
        unsent={unsent}
        pending={pending}
        setPending={setPending}
      />
    </section>
  );
  const wait = !brief.mockEnded && !decision;
  const fileUrl = doc === "resume" && brief.resume ? resumeUrl : doc === "paper" ? paperUrl : null;
  return (
    <>
      <header className={b.top} data-compact={compact ? "" : undefined}>
        <div>
          {!compact && <p className={b.eyebrow}>Interview brief</p>}
          <h1 className={b.name}>{brief.name}</h1>
          <dl className={b.facts}>
            {facts.map(([label, value]) => (
              <div key={label}>
                <dt>{label}</dt>
                <dd>{value}</dd>
              </div>
            ))}
          </dl>
          {!brief.mockStarted && !brief.mockEnded && !decision && <p className={`${c.note} ${b.prep}`}>Review the résumé and guide before the mock.</p>}
        </div>
        {brief.ats && (
          <section className={b.ats} aria-label="ATS score">
            <p className={b.atsHead}>
              <span className={b.eyebrow}>ATS score</span>
              <strong>{points(brief.ats.score)}/100</strong>
            </p>
            <ul className={b.atsParts}>
              {brief.ats.parts.map(({ name, earned, max }) => (
                <li key={name}>
                  <span>{name}</span>
                  <span className={b.atsBar} aria-hidden="true"><span style={{ width: `${max ? (earned / max) * 100 : 0}%` }} /></span>
                  <span className={b.num}>{points(earned)}/{points(max)}</span>
                </li>
              ))}
              {brief.ats.penalty > 0 && (
                <li className={b.penalty}>
                  <span>Work rights</span>
                  <span />
                  <span className={b.num}>−{points(brief.ats.penalty)}</span>
                </li>
              )}
            </ul>
          </section>
        )}
      </header>
      <div className={b.cols}>
        <div className={b.sheet}>
          {blocked && (
            <div className={`${b.panel} ${c.field}`}>
              <p role="status">{checking ? "Checking scores…" : brief.recommendationBlock === "checking" ? "Scores are being checked."
                : "Ask BeGifted admin to check the scores."}</p>
              {/* Stays focusable while it checks; when the recommendation opens, focus moves to it (Sol review, round 19). */}
              {brief.recommendationBlock === "checking" && (
                <button type="button" className={c.button} aria-disabled={checking || undefined} onClick={() => { if (!checking) refresh("recommendation"); }}>Check again</button>
              )}
            </div>
          )}
          {earlyRecommendation && recommendation}
          {!blocked && (
            <section id="scores" className={b.panel} tabIndex={-1}>
              <h2 className={b.panelTitle}>Mock scores</h2>
              {!brief.mockEnded && brief.form !== "closed" && !decision && <p className={c.note}>Send scores during the mock.</p>}
              <BriefRubric
                key={brief.rubric ? "sent" : "new"}
                saved={brief.rubric}
                form={brief.form}
                url={rubricUrl}
                editCount={editCount}
                lastSent={lastSent}
                decisionSent={!!decision}
                pending={pending}
                setPending={setPending}
                onEdit={() => setEditCount((count) => count + 1)}
                onSent={(total) => {
                  setLastSent({ total, max: RUBRIC_ITEMS.length * ITEM_MAX, editCount });
                  tellHiringList();
                }}
              />
            </section>
          )}
          {brief.mockEnded && !blocked && !earlyRecommendation && recommendation}
          {wait && (
            <div className={`${b.panel} ${c.field}`}>
              <p role="status">{checking ? "Checking…" : checked ? "Not open yet. Recommend after the mock ends." : "Recommend after the mock ends."}</p>
              <button type="button" className={c.button} aria-disabled={checking || undefined} onClick={() => { if (!checking) refresh("recommendation"); }}>Check recommendation</button>
            </div>
          )}
        </div>
        <aside className={`${b.panel} ${b.docs}`} aria-label="Candidate files">
          <div className={b.tabs}>
            {DOCS.filter(([key]) => key !== "paper" || brief.gradedPaper).map(([key, label]) => (
              <button key={key} type="button" className={b.tab} aria-pressed={doc === key} onClick={() => {
                setDoc(key);
                if (key === "paper") setPaperOpened(true);
              }}>{label}</button>
            ))}
            {fileUrl && (
              <a className={b.open} href={fileUrl} target="_blank" rel="noreferrer" aria-label={doc === "paper" ? "Open paper (graded PDF)" : brief.resume === "pdf" ? "Open résumé (PDF)" : undefined}>
                {/* Names the file, so it does not read as a second "open" for the brief (Sol review, round 16). */}
                {doc === "resume" && brief.resume !== "pdf" ? "Download résumé (Word)" : doc === "paper" ? "Open paper" : "Open résumé"}
              </a>
            )}
          </div>
          {/* Every tab stays in the page while hidden, so a file is fetched once. */}
          <div className={`${b.pane} ${doc === "answers" || doc === "guide" ? b.text : ""}`}>
            {(doc === "resume" || doc === "paper") && (brief.resume || brief.gradedPaper) && <p className={c.note}>Personal data. Do not share.</p>}
            <div hidden={doc !== "resume"}>
              {brief.resume === "pdf" ? <PdfPages src={resumeUrl} title="Résumé" runtime={runtime} />
                : <p className={c.note}>{brief.resume ? "A Word résumé has no preview. Use the download link." : "No résumé file is stored for this candidate."}</p>}
            </div>
            {/* The server builds the graded paper on each request, so it is fetched once, on the first open of its tab. */}
            {paperOpened && <div hidden={doc !== "paper"}><PdfPages src={paperUrl} title="Graded paper" runtime={runtime} /></div>}
            <div hidden={doc !== "answers"}>{brief.answers ? (
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
            )}</div>
            <div hidden={doc !== "guide"}>
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
            </div>
          </div>
        </aside>
      </div>
    </>
  );
}
