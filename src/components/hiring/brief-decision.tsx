"use client";

import { useEffect, useId, useRef, useState } from "react";
import c from "./booking.module.css";

type Decision = "hire" | "reject";
const LABEL: Record<Decision, string> = { hire: "Yes", reject: "No" };

/** The tutor recommends Yes for HR review or No to queue a rejection. */
export function BriefDecision({ sent, url, scores, unsent }: { sent: Decision | null; url: string; scores: "own" | "recorded" | null; unsent: boolean }) {
  const [done, setDone] = useState<Decision | null>(sent);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const reasonHintId = useId();
  const recorded = useRef<HTMLParagraphElement>(null);
  const reasonTooShort = reason.trim().length < 5;
  useEffect(() => {
    if (done && !sent) recorded.current?.focus();
  }, [done, sent]);
  async function send(decision: Decision) {
    setBusy(true);
    setError("");
    try {
      const response = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ decision, reason }) });
      const body = (await response.json().catch(() => ({}))) as { error?: string };
      if (response.ok) setDone(decision);
      else setError(body.error ?? "The decision was not saved. Try again.");
    } catch {
      setError("The decision was not saved. Check your connection, then try again.");
    }
    setBusy(false);
  }
  if (!scores) return <p className={c.note}>Send your scores first.</p>;
  return (
    <div className={c.field}>
      {unsent && (
        <p className={`${c.note} ${c.scoreChanges}`}>
          <span role="status">You have unsent score changes.</span>{" "}
          <a href="#scores">Go to scores</a>
        </p>
      )}
      <p className={c.note}>{scores === "own"
        ? "Your recommendation uses your last sent scores."
        : "Your recommendation uses the scores on record."}</p>
      {done && (
        <p ref={recorded} role="status" className={c.note} tabIndex={-1}>
          Recommendation recorded: <strong>{LABEL[done]}</strong>. {done === "hire" ? "HR will prepare the review for Gift." : "The candidate’s rejection email is queued."}
        </p>
      )}
      {!done && (
        <>
          <p className={c.note}>Yes sends the application to HR. No queues a rejection email.</p>
          <label className={c.field}>
            Reason (required for No)
            <textarea className={c.input} rows={2} maxLength={1000} value={reason} aria-describedby={reasonTooShort ? reasonHintId : undefined} onChange={(event) => setReason(event.target.value)} />
          </label>
          {reasonTooShort && <p id={reasonHintId} className={c.note}>Write at least 5 characters to choose No.</p>}
          <div className={c.decisionActions}>
            <button type="button" className={c.button} disabled={busy} onClick={() => void send("hire")}>
              Yes, send to HR
            </button>
            <button type="button" className={`${c.ghost} ${c.reject}`} disabled={busy || reasonTooShort} onClick={() => void send("reject")}>
              No, reject
            </button>
          </div>
        </>
      )}
      {error && (
        <p role="alert" className={c.alert}>
          {error}
        </p>
      )}
    </div>
  );
}
