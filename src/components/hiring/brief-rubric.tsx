"use client";

import { useState } from "react";
import { ITEM_MAX, RUBRIC, RUBRIC_ITEMS, rubricTotals, type MockRubric, type RubricItem } from "@/lib/hiring/marking-sheet";
import c from "./booking.module.css";

const SCORES = Array.from({ length: ITEM_MAX }, (_, i) => ITEM_MAX - i);

/** The interviewer's score form for one mock. The server checks the scores again and calculates the total. */
export function BriefRubric({ saved, formOpen, url }: { saved: MockRubric | null; formOpen: boolean; url: string }) {
  const [items, setItems] = useState<Partial<Record<RubricItem, number>>>(() => Object.fromEntries(RUBRIC_ITEMS.flatMap((id) => (saved?.items[id] ? [[id, saved.items[id]]] : []))));
  const [comments, setComments] = useState(saved?.comments ?? "");
  const [state, setState] = useState<"idle" | "sending">("idle");
  const [sentTotal, setSentTotal] = useState<number | null>(saved ? rubricTotals(saved).total : null);
  const [error, setError] = useState("");
  if (!formOpen) return <p className={c.note}>The score form opens here when the mock lesson starts.</p>;
  const complete = RUBRIC_ITEMS.every((id) => items[id]);
  async function send() {
    setState("sending");
    setError("");
    try {
      const response = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ items, comments }) });
      const body = (await response.json().catch(() => ({}))) as { total?: number; error?: string };
      if (!response.ok || typeof body.total !== "number") setError(body.error ?? "The scores were not saved. Try again.");
      else setSentTotal(body.total);
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
        void send();
      }}
    >
      <p className={c.note}>Give each item a score from 1 to {ITEM_MAX}. The usual scores are 10, 7, 4 and 1.</p>
      {RUBRIC.map(({ part, items: partItems }) => (
        <fieldset key={part} className={c.field}>
          <legend className={c.factLabel}>{part}</legend>
          {partItems.map(([id, label]) => (
            <label key={id} className={c.field}>
              {label}
              <select
                className={c.input}
                required
                value={items[id] ?? ""}
                onChange={(event) => {
                  setItems({ ...items, [id]: Number(event.target.value) });
                  setSentTotal(null);
                }}
              >
                <option value="" disabled>
                  Choose a score
                </option>
                {SCORES.map((score) => (
                  <option key={score}>{score}</option>
                ))}
              </select>
            </label>
          ))}
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
      <button type="submit" className={c.button} disabled={!complete || state === "sending" || sentTotal !== null}>
        {state === "sending" ? "Sending…" : "Send scores"}
      </button>
    </form>
  );
}
