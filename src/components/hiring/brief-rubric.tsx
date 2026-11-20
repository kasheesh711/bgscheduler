import { useEffect, useId, useRef, useState } from "react";
import { ITEM_MAX, RUBRIC, RUBRIC_ITEMS, type MockRubric, type RubricItem } from "@/lib/hiring/marking-sheet";
import c from "./booking.module.css";

const TILE_SCORES = [10, 7, 4, 1];
const OTHER_SCORES = [9, 8, 6, 5, 3, 2];

/** The interviewer's score form for one mock. The server checks the scores again and calculates the total. */
export function BriefRubric({ saved, form, url, editCount, lastSent, decisionSent, onEdit, onSent }: {
  saved: MockRubric | null;
  form: "wait" | "open" | "closed";
  url: string;
  editCount: number;
  lastSent: { total: number; editCount: number } | null;
  decisionSent: boolean;
  onEdit: () => void;
  onSent: (total: number) => void;
}) {
  const rubricId = useId();
  const [items, setItems] = useState<Partial<Record<RubricItem, number>>>(() => Object.fromEntries(RUBRIC_ITEMS.flatMap((id) => (saved?.items[id] ? [[id, saved.items[id]]] : []))));
  const [comments, setComments] = useState(saved?.comments ?? "");
  const [state, setState] = useState<"idle" | "sending" | "sent">("idle");
  const [editing, setEditing] = useState(!lastSent);
  const [error, setError] = useState("");
  const feedback = useRef<HTMLParagraphElement>(null);
  const summary = useRef<HTMLDivElement>(null);
  const firstScore = useRef<HTMLInputElement>(null);
  const sentTotal = lastSent?.editCount === editCount ? lastSent.total : null;
  useEffect(() => {
    if (state !== "sent" && !error) {
      if (editing && sentTotal !== null) firstScore.current?.focus();
      return;
    }
    const message = summary.current ?? feedback.current;
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    message?.scrollIntoView({ block: "center", behavior: reducedMotion ? "auto" : "smooth" });
    message?.focus({ preventScroll: true });
  }, [state, error, editing, sentTotal]);
  if (!decisionSent && form === "wait") return <p className={c.note}>The score form is here after the mock lesson ends. Refresh this page then.</p>;
  if (!decisionSent && form === "closed") return <p className={c.note}>Scores for this mock are already recorded. Ask BeGifted admin to change them.</p>;
  const scored = RUBRIC_ITEMS.filter((id) => items[id]).length;
  const complete = scored === RUBRIC_ITEMS.length;
  const disabled = !complete || state === "sending" || sentTotal !== null;
  const max = RUBRIC_ITEMS.length * ITEM_MAX;
  const sentMessage = lastSent ? `Scores sent. ${lastSent.total}/${max}.` : "";
  function selectScore(id: RubricItem, score: number) {
    if (items[id] === score) return;
    setItems({ ...items, [id]: score });
    onEdit();
    if (state === "sent") setState("idle");
  }
  async function send() {
    setState("sending");
    setError("");
    try {
      const response = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ items, comments }) });
      const body = (await response.json().catch(() => ({}))) as { total?: number; error?: string };
      if (!response.ok || typeof body.total !== "number") setError(body.error ?? "The scores were not saved. Try again.");
      else {
        setEditing(false);
        setState("sent");
        onSent(body.total);
        return;
      }
    } catch {
      setError("The scores were not saved. Check your connection, then try again.");
    }
    setState("idle");
  }
  if (decisionSent || (!editing && sentTotal !== null)) {
    return (
      <div ref={summary} role="group" aria-label={sentMessage || undefined} className={c.scoreSummary} tabIndex={-1}>
        {lastSent && <p aria-hidden="true">Scores sent · <strong>{lastSent.total} / {max}</strong></p>}
        {decisionSent ? <p className={c.note}>Scores and recommendation are recorded. Ask BeGifted admin to change them.</p> : <div className={c.scoreActions}>
          <a className={c.button} href="#recommendation">Go to recommendation</a>
          <button type="button" className={c.ghost} onClick={() => {
            setEditing(true);
            setState("idle");
          }}>
            Edit scores
          </button>
        </div>}
      </div>
    );
  }
  return (
    <form
      className={c.field}
      onSubmit={(event) => {
        event.preventDefault();
        if (!disabled) void send();
      }}
    >
      <p className={`${c.note} ${c.scoreHint}`}>Tap a score. Use Other for more scores.</p>
      {RUBRIC.map(({ part, items: partItems }) => (
        <fieldset key={part} className={c.rubricPart}>
          <legend className={c.factLabel}>{part}</legend>
          {partItems.map(([id, label]) => {
            const labelId = `${rubricId}-${id}`;
            const selected = items[id] ?? 0;
            const otherSelected = OTHER_SCORES.includes(selected);
            return (
              <fieldset key={id} className={c.criterionScore}>
                <legend>{label}</legend>
                <div className={c.scoreRow}>
                  <div className={c.scoreTiles}>
                    {TILE_SCORES.map((score) => (
                      <label key={score} className={c.scoreTile}>
                        <input
                          type="radio"
                          ref={id === RUBRIC_ITEMS[0] && score === TILE_SCORES[0] ? firstScore : undefined}
                          name={labelId}
                          value={score}
                          className={c.hidden}
                          checked={selected === score}
                          onChange={() => selectScore(id, score)}
                        />
                        {score}
                      </label>
                    ))}
                  </div>
                  <label className={c.hidden} htmlFor={labelId}>Other score for {label}</label>
                  <select
                    id={labelId}
                    className={`${c.input} ${c.otherScore}`}
                    data-selected={otherSelected ? "" : undefined}
                    value={otherSelected ? selected : ""}
                    onChange={(event) => selectScore(id, Number(event.target.value))}
                  >
                    <option value="" disabled>Other</option>
                    {OTHER_SCORES.map((score) => (
                      <option key={score}>{score}</option>
                    ))}
                  </select>
                </div>
              </fieldset>
            );
          })}
        </fieldset>
      ))}
      <label className={c.field}>
        Comments
        <textarea
          className={c.input}
          rows={3}
          maxLength={4000}
          value={comments}
          onChange={(event) => {
            setComments(event.target.value);
            onEdit();
            if (state === "sent") setState("idle");
          }}
        />
      </label>
      {state === "sent" && <p ref={feedback} role="status" className={c.success} tabIndex={-1}>{sentMessage}</p>}
      {error && <p ref={feedback} role="alert" className={c.alert} tabIndex={-1}>{error}</p>}
      {lastSent && sentTotal === null && <p className={c.note} role="status">Unsaved changes. Send again to update your scores.</p>}
      <div className={c.field} data-sticky="">
        <div className={c.field}>
          <p className={c.note}>{scored} of {RUBRIC_ITEMS.length} scored</p>
          <progress className={c.scoreProgress} aria-label="Scores entered" value={scored} max={RUBRIC_ITEMS.length} />
        </div>
        <button type="submit" className={c.button} disabled={disabled}>
          {state === "sending" ? "Sending…" : "Send scores"}
        </button>
      </div>
    </form>
  );
}
