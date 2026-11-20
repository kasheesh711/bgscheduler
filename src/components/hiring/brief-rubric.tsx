import { useId, useState } from "react";
import { ITEM_MAX, RUBRIC, RUBRIC_ITEMS, rubricTotals, type MockRubric, type RubricItem } from "@/lib/hiring/marking-sheet";
import c from "./booking.module.css";

const TILE_SCORES = [10, 7, 4, 1];
const OTHER_SCORES = [9, 8, 6, 5, 3, 2];

/** The interviewer's score form for one mock. The server checks the scores again and calculates the total. */
export function BriefRubric({ saved, form, url, onSent }: { saved: MockRubric | null; form: "wait" | "open" | "closed"; url: string; onSent: () => void }) {
  const rubricId = useId();
  const [items, setItems] = useState<Partial<Record<RubricItem, number>>>(() => Object.fromEntries(RUBRIC_ITEMS.flatMap((id) => (saved?.items[id] ? [[id, saved.items[id]]] : []))));
  const [comments, setComments] = useState(saved?.comments ?? "");
  const [state, setState] = useState<"idle" | "sending">("idle");
  const [sentTotal, setSentTotal] = useState<number | null>(saved ? rubricTotals(saved).total : null);
  const [error, setError] = useState("");
  if (form === "wait") return <p className={c.note}>The score form is here after the mock lesson ends. Refresh this page then.</p>;
  if (form === "closed") return <p className={c.note}>Scores for this mock are already recorded. Ask BeGifted admin to change them.</p>;
  const scored = RUBRIC_ITEMS.filter((id) => items[id]).length;
  const complete = scored === RUBRIC_ITEMS.length;
  const disabled = !complete || state === "sending" || sentTotal !== null;
  function selectScore(id: RubricItem, score: number) {
    setItems({ ...items, [id]: score });
    setSentTotal(null);
  }
  async function send() {
    setState("sending");
    setError("");
    try {
      const response = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ items, comments }) });
      const body = (await response.json().catch(() => ({}))) as { total?: number; error?: string };
      if (!response.ok || typeof body.total !== "number") setError(body.error ?? "The scores were not saved. Try again.");
      else {
        setSentTotal(body.total);
        onSent();
      }
    } catch {
      setError("The scores were not saved. Check your connection, then try again.");
    }
    setState("idle");
  }
  return (
    <form
      className={c.field}
      onSubmit={(event) => {
        event.preventDefault();
        if (!disabled) void send();
      }}
    >
      <p className={c.note}>Tap a score. Use Other for 9, 8, 6, 5, 3 or 2.</p>
      {RUBRIC.map(({ part, items: partItems }) => (
        <fieldset key={part} className={c.field}>
          <legend className={c.factLabel}>{part}</legend>
          {partItems.map(([id, label]) => {
            const labelId = `${rubricId}-${id}`;
            const selected = items[id] ?? 0;
            return (
              <div key={id} className={c.field}>
                <span id={labelId}>{label}</span>
                <div className={c.scoreRow}>
                  <div className={c.scoreTiles} role="radiogroup" aria-labelledby={labelId}>
                    {TILE_SCORES.map((score) => (
                      <label key={score} className={c.scoreTile}>
                        <input
                          type="radio"
                          role="radio"
                          name={labelId}
                          className={c.hidden}
                          checked={selected === score}
                          aria-checked={selected === score}
                          onChange={() => selectScore(id, score)}
                        />
                        {score}
                      </label>
                    ))}
                  </div>
                  <select
                    className={`${c.input} ${c.otherScore}`}
                    aria-label={`Other score for ${label}`}
                    value={OTHER_SCORES.includes(selected) ? selected : ""}
                    onChange={(event) => selectScore(id, Number(event.target.value))}
                  >
                    <option value="" disabled>Other</option>
                    {OTHER_SCORES.map((score) => (
                      <option key={score}>{score}</option>
                    ))}
                  </select>
                </div>
              </div>
            );
          })}
        </fieldset>
      ))}
      <label className={c.field}>
        Comments
        <textarea
          className={c.input}
          rows={5}
          maxLength={4000}
          value={comments}
          onChange={(event) => {
            setComments(event.target.value);
            setSentTotal(null);
          }}
        />
      </label>
      {error && (
        <p role="alert" className={c.alert}>
          {error}
        </p>
      )}
      {sentTotal !== null && (
        <p role="status" className={c.success}>
          Scores sent. Total {sentTotal} / {RUBRIC_ITEMS.length * ITEM_MAX}. You can change a score and send again while this link works.
        </p>
      )}
      <p className={c.note}>{scored} of {RUBRIC_ITEMS.length} scored</p>
      <progress className={c.scoreProgress} aria-label="Scores entered" value={scored} max={RUBRIC_ITEMS.length} />
      <button type="submit" className={c.button} disabled={disabled}>
        {state === "sending" ? "Sending…" : "Send scores"}
      </button>
      {!complete && <p className={c.note}>Score all {RUBRIC_ITEMS.length} items to send.</p>}
    </form>
  );
}
