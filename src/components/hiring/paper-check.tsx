"use client";

import { useEffect, useState } from "react";
import type { paperCheckView } from "@/lib/hiring/paper-check";
import { tellHiringList } from "./brief";
import { PdfPages } from "./pdf-pages";
import c from "./booking.module.css";
import k from "./paper-check.module.css";

type View = Awaited<ReturnType<typeof paperCheckView>>;
type Outcome = "passed" | "rejected" | "held" | "none" | "check";

/** The best level's percent, the same rule the server uses: one passed level is a pass. */
function bestPercent(questions: View["questions"], marks: Record<string, string>) {
  const levels = new Map<string, { scored: number; max: number; tried: boolean }>();
  for (const q of questions) {
    const level = levels.get(q.level) ?? { scored: 0, max: 0, tried: false };
    const value = Number(marks[q.id]);
    levels.set(q.level, { scored: level.scored + (Number.isFinite(value) ? value : 0), max: level.max + q.max, tried: level.tried || marks[q.id] !== "" });
  }
  return Math.max(0, ...[...levels.values()].filter((l) => l.tried && l.max > 0).map((l) => (l.scored / l.max) * 100));
}

const RESULT: Record<Outcome, string> = {
  passed: "Pass. The candidate goes on to mock teaching. Admin is told in LINE.",
  rejected: "Not passed. The rejection email is on its way to the candidate.",
  held: "Not passed. Admin sends the result, because the candidate has another open step.",
  none: "Your marks are saved.",
  check: "Your marks are saved.",
};

/** The head's page: the marked paper, the AI's marks, and one mark for each question. Built for a phone. */
export function PaperCheck({ view, token }: { view: View; token: string }) {
  const [marks, setMarks] = useState<Record<string, string>>(() => Object.fromEntries(view.questions.map((q) => [q.id, q.marks === null ? "" : String(q.marks)])));
  const [comment, setComment] = useState(view.comment);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  // Marks not sent yet stay in this browser, so opening another row and coming back loses nothing. The link token is
  // signed again on each list load, so the draft is keyed by the result, and kept only while the AI marks are the same.
  const draftKey = `hiring-paper-draft:${view.id}`;
  const [restored, setRestored] = useState(false);
  useEffect(() => {
    try {
      if (!restored) {
        setRestored(true);
        const draft = JSON.parse(localStorage.getItem(draftKey) ?? "null") as { updatedAt?: string; marks?: Record<string, string>; comment?: string } | null;
        if (draft?.updatedAt === view.updatedAt && draft.marks) {
          setMarks((current) => Object.fromEntries(Object.keys(current).map((id) => [id, typeof draft.marks?.[id] === "string" ? draft.marks[id] : current[id]])));
          if (typeof draft.comment === "string") setComment(draft.comment);
        }
      } else if (outcome || view.done || !view.open) localStorage.removeItem(draftKey);
      else localStorage.setItem(draftKey, JSON.stringify({ updatedAt: view.updatedAt, marks, comment }));
    } catch {
      // Private mode or a full store: the page still works, without the copy.
    }
  }, [draftKey, restored, outcome, view.done, view.open, view.updatedAt, marks, comment]);
  const bad = view.questions.filter((q) => {
    const value = Number(marks[q.id]);
    return marks[q.id] === "" || !Number.isFinite(value) || value < 0 || value > q.max;
  });
  const percent = Math.round(bestPercent(view.questions, marks) * 10) / 10;
  const passes = view.passMark !== null && percent >= view.passMark;

  async function send() {
    setPending(true);
    setError("");
    try {
      const response = await fetch(`/api/hiring/paper-check/${token}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ updatedAt: view.updatedAt, comment, marks: Object.fromEntries(view.questions.map((q) => [q.id, Number(marks[q.id])])) }),
      });
      const body = (await response.json().catch(() => ({}))) as { error?: string; outcome?: Outcome };
      if (response.ok && body.outcome) {
        setOutcome(body.outcome);
        tellHiringList();
      }
      else setError(body.error ?? "Your marks were not saved. Try again.");
    } catch {
      setError("Your marks were not saved. Check your connection, then try again.");
    } finally {
      setPending(false);
    }
  }

  const header = (
    <section className={c.facts}>
      <h2 className={c.subject}>{view.name}</h2>
      <dl className={`${c.answers} ${c.briefDetails}`}>
        <div><dt className={c.factLabel}>Subject</dt><dd>{view.subject}</dd></div>
        <div><dt className={c.factLabel}>AI score</dt><dd>{view.aiPercent}%{view.passMark !== null && ` (pass mark ${view.passMark}%)`}</dd></div>
        <div><dt className={c.factLabel}>Mock teaching</dt><dd>{view.mock ?? "Not booked yet"}</dd></div>
      </dl>
      <a className={`${c.ghost} ${c.jumpLink}`} href={`/api/hiring/paper-check/${token}/paper`} target="_blank" rel="noreferrer">Open marked paper</a>
      <p className={c.note}>Personal data. Do not share.</p>
    </section>
  );

  if (outcome || view.done)
    return (
      <>
        {header}
        <p role="status" className={outcome === "rejected" || view.done?.passed === false ? c.notice : c.success}>
          {outcome ? `Marks saved: ${percent}%. ${RESULT[outcome]}` : `${view.done!.head}'s check is recorded: ${view.done!.percent}%, ${view.done!.passed ? "pass" : "not passed"}.`}
        </p>
      </>
    );
  if (!view.open)
    return (
      <>
        {header}
        <p role="status" className={c.note}>This paper no longer needs a check. Admin changed the marks or closed the application.</p>
      </>
    );
  return (
    <>
      {header}
      <div className={k.split}>
      {/* The paper beside the marks on a wide screen, above them on a phone. Drawn on the page: a PDF frame is blank on Safari and phones. */}
      <section className={k.paper} aria-label="Marked paper">
        <h2 className={c.stepTitle}>Marked paper</h2>
        <PdfPages src={`/api/hiring/paper-check/${token}/paper`} runtime={`/api/hiring/paper-check/${token}/runtime`} title={`Marked paper of ${view.name}`} maxPages={40} />
      </section>
      <section className={`${c.facts} ${k.marks}`}>
        <h2 className={c.stepTitle}>Your marks <span className={c.note}>{view.questions.length} questions · half marks allowed</span></h2>
        <ol className={k.questions}>
          {view.questions.map((q) => (
            <li key={q.id} className={k.question}>
              <div className={k.head}>
                <label htmlFor={`q-${q.id}`} className={k.label}>Question {q.id}</label>
                <span className={k.level}>{q.level}</span>
              </div>
              {q.reason && <p id={`q-${q.id}-ai`} className={k.reason}>AI: {q.reason}</p>}
              <div className={k.markRow}>
                <input
                  id={`q-${q.id}`}
                  className={`${c.input} ${k.mark}`}
                  type="number"
                  inputMode="decimal"
                  min={0}
                  max={q.max}
                  step={0.5}
                  value={marks[q.id]}
                  aria-invalid={bad.includes(q) || undefined}
                  aria-describedby={[q.reason && `q-${q.id}-ai`, `q-${q.id}-max`].filter(Boolean).join(" ")}
                  onChange={(event) => setMarks({ ...marks, [q.id]: event.target.value })}
                />
                <span id={`q-${q.id}-max`} className={k.max}>of {q.max}{q.marks !== null && ` · AI gave ${q.marks}`}</span>
              </div>
            </li>
          ))}
        </ol>
        <label className={c.field}>
          <span>Comment (optional)</span>
          <textarea className={c.input} rows={3} maxLength={4000} value={comment} onChange={(event) => setComment(event.target.value)} />
        </label>
        {/* The score and the send stay in view while the head works down the questions. */}
        <div className={k.submit}>
          <p className={k.total} role="status">
            Score with these marks: <strong>{percent}%</strong>
            {view.passMark !== null && <> — {passes ? "pass: goes on to mock teaching" : "not passed: the candidate gets the rejection email"}</>}
          </p>
          {bad.length > 0 && <p className={c.note}>Give a mark from 0 to the maximum for question {bad.map((q) => q.id).join(", ")}.</p>}
          <button type="button" className={c.button} disabled={pending || bad.length > 0} onClick={() => void send()}>
            {pending ? "Saving…" : "Submit my marks"}
          </button>
          <p className={c.note}>Your marks are final.</p>
          {error && <p role="alert" className={c.alert}>{error}</p>}
        </div>
      </section>
      </div>
    </>
  );
}
