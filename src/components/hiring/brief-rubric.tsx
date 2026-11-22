import { useEffect, useId, useRef, useState } from "react";
import { ITEM_MAX, RUBRIC, RUBRIC_ITEMS, stressSuggestion, type MockRubric, type RubricItem, type StressTicks } from "@/lib/hiring/marking-sheet";
import { BAND_LABELS, RUBRIC_GUIDE, STRESS_ELEMENTS } from "@/lib/hiring/rubric-guide";
import type { BriefPending } from "./brief";
import c from "./booking.module.css";

const TILE_SCORES = Array.from({ length: ITEM_MAX }, (_, index) => ITEM_MAX - index);
const BAND_SCORES = [10, 7, 4, 1];

/** The interviewer's score form for one mock. The server checks the scores again and calculates the total. */
export function BriefRubric({ saved, form, url, editCount, lastSent, decisionSent, pending, setPending, onEdit, onSent }: {
  saved: MockRubric | null;
  form: "wait" | "open" | "closed";
  url: string;
  editCount: number;
  lastSent: { total: number; max: number; editCount: number } | null;
  decisionSent: boolean;
  pending: BriefPending;
  setPending: (pending: BriefPending) => void;
  onEdit: () => void;
  onSent: (total: number) => void;
}) {
  const rubricId = useId();
  const [items, setItems] = useState<Partial<Record<RubricItem, number>>>(() => Object.fromEntries(RUBRIC_ITEMS.flatMap((id) => (saved?.items[id] ? [[id, saved.items[id]]] : []))));
  const [comments, setComments] = useState(saved?.comments ?? "");
  const [ticks, setTicks] = useState<StressTicks>(() => saved?.stressTest ?? { listens: false, explains: false, plan: false });
  const [checksDone, setChecksDone] = useState<boolean | null>(saved?.checksDone ?? null);
  const [state, setState] = useState<"idle" | "sent">("idle");
  const [editing, setEditing] = useState(!lastSent);
  const [error, setError] = useState("");
  const feedback = useRef<HTMLParagraphElement>(null);
  const summary = useRef<HTMLDivElement>(null);
  const firstScore = useRef<HTMLInputElement>(null);
  const sendBar = useRef<HTMLDivElement>(null);
  const sentTotal = lastSent?.editCount === editCount ? lastSent.total : null;
  useEffect(() => {
    if (state !== "sent" && !error) {
      if (editing && sentTotal !== null) firstScore.current?.focus();
      return;
    }
    const message = summary.current ?? feedback.current;
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    message?.scrollIntoView({ block: error ? "center" : "start", behavior: error && !reducedMotion ? "smooth" : "instant" });
    message?.focus({ preventScroll: true });
  }, [state, error, editing, sentTotal]);
  if (!decisionSent && form === "closed") return <p className={c.note}>Scores for this mock are already recorded. Ask BeGifted admin to change them.</p>;
  const scored = RUBRIC_ITEMS.filter((id) => items[id]).length;
  const checksMissing = scored === RUBRIC_ITEMS.length && checksDone === null;
  const complete = scored === RUBRIC_ITEMS.length && checksDone !== null;
  const disabled = !complete || !!pending || sentTotal !== null;
  // An old 10-item send is out of 100.
  const percent = (sent: { total: number; max: number }) => Math.round((sent.total / sent.max) * 100);
  const sentMessage = lastSent ? `Scores sent. ${lastSent.total}/${lastSent.max} (${percent(lastSent)}%).` : "";
  const saveError = error && <p ref={feedback} role="alert" className={c.alert} tabIndex={-1}>{error}</p>;
  function selectScore(id: RubricItem, score: number) {
    if (items[id] === score) return;
    setItems({ ...items, [id]: score });
    onEdit();
    if (state === "sent") setState("idle");
  }
  function changed() {
    onEdit();
    if (state === "sent") setState("idle");
  }
  async function send() {
    setPending("scores");
    setError("");
    try {
      const response = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ items, comments, stressTest: ticks, checksDone }) });
      const body = (await response.json().catch(() => ({}))) as { total?: number; error?: string };
      if (!response.ok || typeof body.total !== "number") setError(body.error ?? "The scores were not saved. Try again.");
      else {
        setEditing(false);
        setState("sent");
        onSent(body.total);
      }
    } catch {
      setError("The scores were not saved. Check your connection, then try again.");
    } finally {
      setPending(null);
    }
  }
  if (decisionSent || (!editing && sentTotal !== null)) {
    return (
      <div ref={summary} role="group" aria-labelledby={lastSent ? `${rubricId}-receipt` : undefined}
        aria-describedby={decisionSent ? undefined : `${rubricId}-next`} className={c.scoreSummary} tabIndex={-1}>
        {lastSent && <p id={`${rubricId}-receipt`}>Scores sent · <strong>{lastSent.total} / {lastSent.max}</strong> · {percent(lastSent)}%</p>}
        {decisionSent ? <p className={c.note}>Scores and recommendation are recorded. Ask BeGifted admin to change them.</p> : <div className={c.scoreActions}>
          <p id={`${rubricId}-next`}>Now choose Yes or No below.</p>
          <button type="button" className={c.ghost} disabled={!!pending} onClick={() => {
            setEditing(true);
            setState("idle");
          }}>
            Edit scores
          </button>
        </div>}
        {saveError}
      </div>
    );
  }
  return (
    <form
      className={c.field}
      onFocus={(event) => {
        const bar = sendBar.current;
        if (!bar || bar.contains(event.target)) return;
        const row = event.target.closest(`.${c.scoreRow}, label`) ?? event.target;
        const bounds = row.getBoundingClientRect();
        const sticky = bar.getBoundingClientRect();
        // A browser can skip its focus scroll when a control is already in the viewport.
        if (bounds.bottom > sticky.top && bounds.top < sticky.bottom) {
          row.scrollIntoView({ block: "center", behavior: "instant" });
        }
      }}
      onSubmit={(event) => {
        event.preventDefault();
        if (!disabled) void send();
      }}
    >
      <p className={`${c.note} ${c.scoreHint}`}>Tap a score.</p>
      {RUBRIC.map(({ part, items: partItems }) => (
        <fieldset key={part} className={c.rubricPart} disabled={!!pending}>
          <legend className={c.factLabel}>{part}</legend>
          {partItems.map(([id, label]) => {
            const labelId = `${rubricId}-${id}`;
            const selected = items[id] ?? 0;
            return (
              <fieldset key={id} className={c.criterionScore}>
                <legend>{label}</legend>
                <details className={c.note}>
                  <summary>What each score means</summary>
                  {RUBRIC_GUIDE[id].hint && <p><em>{RUBRIC_GUIDE[id].hint}</em></p>}
                  <dl>
                    {RUBRIC_GUIDE[id].bands.map((band, index) => (
                      <div key={BAND_LABELS[index]}>
                        <dt className={c.factLabel}>{BAND_LABELS[index]}</dt>
                        <dd>{band}</dd>
                      </div>
                    ))}
                  </dl>
                </details>
                {id === "stress" && (
                  <div className={c.field}>
                    {STRESS_ELEMENTS.map(({ key, label: element }) => (
                      <label key={key}>
                        <input
                          type="checkbox"
                          checked={ticks[key]}
                          onChange={(event) => {
                            setTicks({ ...ticks, [key]: event.target.checked });
                            changed();
                          }}
                        />{" "}
                        {element}
                      </label>
                    ))}
                    <p className={c.note} aria-live="polite">Suggested score: {stressSuggestion(ticks)}. You choose the score.</p>
                  </div>
                )}
                <div className={`${c.scoreRow} ${c.scoreTiles}`}>
                  {TILE_SCORES.map((score) => (
                    <label key={score} className={c.scoreTile} data-band={BAND_SCORES.includes(score) ? "" : undefined}>
                      <input
                        type="radio"
                        ref={id === RUBRIC_ITEMS[0] && score === ITEM_MAX ? firstScore : undefined}
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
              </fieldset>
            );
          })}
        </fieldset>
      ))}
      <fieldset className={c.rubricPart} disabled={!!pending}>
        <legend className={c.factLabel}>School&apos;s required checks completed</legend>
        <p className={c.note}>Not scored. The candidate cannot be hired until this is Yes.</p>
        <div className={c.scoreTiles}>
          {([[true, "Yes"], [false, "No"]] as const).map(([value, text]) => (
            <label key={text} className={c.scoreTile}>
              <input
                type="radio"
                name={`${rubricId}-checks`}
                className={c.hidden}
                checked={checksDone === value}
                onChange={() => {
                  setChecksDone(value);
                  changed();
                }}
              />
              {text}
            </label>
          ))}
        </div>
      </fieldset>
      <label className={c.field}>
        Comments
        <textarea
          className={c.input}
          rows={3}
          maxLength={4000}
          disabled={!!pending}
          value={comments}
          onChange={(event) => {
            setComments(event.target.value);
            onEdit();
            if (state === "sent") setState("idle");
          }}
        />
      </label>
      {state === "sent" && <p ref={feedback} role="status" className={c.success} tabIndex={-1}>{sentMessage}</p>}
      {saveError}
      <div ref={sendBar} className={c.field} data-sticky="">
        {sentTotal !== null ? (
          <>
            <p className={c.note}>Scores are up to date.</p>
            <button type="button" className={c.ghost} onClick={() => {
              setEditing(false);
              setState("sent");
            }}>
              Back to sent scores
            </button>
          </>
        ) : (
          <>
            <div className={c.field}>
              <p role="status" className={checksMissing || lastSent ? undefined : c.note}>{checksMissing
                ? "Answer the required checks to send."
                : lastSent ? "Score changes are unsent. Send scores again."
                  : `${scored} of ${RUBRIC_ITEMS.length} scored${checksDone === null ? " · required checks not answered" : ""}`}</p>
              <progress className={c.scoreProgress} aria-label="Scores entered" value={scored} max={RUBRIC_ITEMS.length} />
            </div>
            <button type="submit" className={c.button} disabled={disabled}>
              {pending === "scores" ? "Sending…" : "Send scores"}
            </button>
          </>
        )}
      </div>
    </form>
  );
}
