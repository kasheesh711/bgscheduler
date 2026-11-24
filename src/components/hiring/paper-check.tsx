"use client";

import { useEffect, useRef, useState } from "react";
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
  // On a wide pane the questions scroll in their own area; the cue shows while some are still below it.
  const questionList = useRef<HTMLDivElement>(null);
  // Submit leaves the page with the result, so focus moves to it.
  const result = useRef<HTMLParagraphElement>(null);
  useEffect(() => {
    if (outcome) result.current?.focus();
  }, [outcome]);
  const [more, setMore] = useState<string | null>(null);
  const checkMore = () => {
    const list = questionList.current;
    if (!list) return setMore(null);
    // The first question whose box ends below the visible area, else the comment if it is below it; nothing when all show.
    const bottom = list.getBoundingClientRect().bottom + 1;
    // A question counts as hidden only when its mark field is cut off, not its card's padding (reviews, round 14).
    const next = [...list.querySelectorAll<HTMLLIElement>("li[data-question]")].find((item) => (item.querySelector("input") ?? item).getBoundingClientRect().bottom > bottom);
    if (next) return setMore(next.dataset.question ?? null);
    const comment = list.querySelector("textarea");
    // Only when the comment's label and first line are hidden, not for a box that is nearly all in view.
    setMore(comment && comment.getBoundingClientRect().top + 32 > bottom ? "" : null);
  };
  useEffect(() => {
    checkMore();
    // The area also changes size when the facts above it wrap, not only with the window.
    if (typeof ResizeObserver === "undefined" || !questionList.current) return;
    const observer = new ResizeObserver(checkMore);
    observer.observe(questionList.current);
    return () => observer.disconnect();
  }, []);
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
        {outcome && <div><dt className={c.factLabel}>Your score</dt><dd>{percent}%</dd></div>}
        <div><dt className={c.factLabel}>Mock teaching</dt><dd>{view.mock ?? "Not booked yet"}</dd></div>
      </dl>
      <p className={c.note}>Personal data. Do not share.</p>
    </section>
  );

  if (outcome || view.done)
    return (
      <>
        {header}
        <p role="status" tabIndex={-1} ref={result} className={outcome === "rejected" || view.done?.passed === false ? c.notice : c.success}>
          {outcome ? `${outcome === "none" || outcome === "check" ? "" : "Marks saved. "}${RESULT[outcome]}` : `${view.done!.head}'s check is recorded: ${view.done!.percent}%, ${view.done!.passed ? "pass" : "not passed"}.`}
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
        <h2 className={`${c.stepTitle} ${k.paperHead}`}>Marked paper
          <a className={k.fullPaper} href={`/api/hiring/paper-check/${token}/paper`} target="_blank" rel="noreferrer">View full paper ↗</a>
        </h2>
        <PdfPages src={`/api/hiring/paper-check/${token}/paper`} runtime={`/api/hiring/paper-check/${token}/runtime`} title={`Marked paper of ${view.name}`} maxPages={40} />
      </section>
      <section className={`${c.facts} ${k.marks}`}>
        <h2 className={c.stepTitle}>Your marks <span className={c.note}>{view.questions.length} questions · half marks allowed</span></h2>
        {/* The questions and the comment scroll together, so the score and Submit below them stay in view. */}
        <div className={k.questions} ref={questionList} onScroll={checkMore}>
        <ol className={k.questionList}>
          {view.questions.map((q) => (
            <li key={q.id} className={k.question} data-question={q.id}>
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
          {/* A comment already on the result is the marker's; the head may keep or change it, and it saves with the marks. */}
          <span>{view.comment ? "Existing marking comment" : "Comment (optional)"}</span>
          <textarea className={c.input} rows={3} maxLength={4000} value={comment} onChange={(event) => setComment(event.target.value)} />
        </label>
        </div>
        {more !== null && (
          <button type="button" className={k.more} onClick={() => {
            // The question, or the comment field's label (Sol review, round 17); focus goes to its field.
            const target = more ? questionList.current?.querySelector<HTMLElement>(`li[data-question="${CSS.escape(more)}"]`) : questionList.current?.querySelector("textarea")?.closest("label");
            target?.scrollIntoView({ block: "nearest" });
            target?.querySelector<HTMLElement>("input, textarea")?.focus({ preventScroll: true });
          }}>{more ? `Go to question ${more} ↓` : "Go to the comment ↓"}</button>
        )}
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
