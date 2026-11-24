"use client";

import { useEffect, useId, useRef, useState } from "react";
import type { BriefPending } from "./brief";
import c from "./booking.module.css";

type Decision = "hire" | "reject";
const LABEL: Record<Decision, string> = { hire: "Yes", reject: "No" };

/** The tutor recommends Yes for HR review or No to queue a rejection. */
export function BriefDecision({ sent, onSent, url, hasScores, unsent, pending, setPending }: {
  sent: Decision | null;
  onSent: (decision: Decision) => void;
  url: string;
  hasScores: boolean;
  unsent: boolean;
  pending: BriefPending;
  setPending: (pending: BriefPending) => void;
}) {
  const [reason, setReason] = useState("");
  const [error, setError] = useState("");
  const reasonHintId = useId();
  const recorded = useRef<HTMLParagraphElement>(null);
  const sentHere = useRef(false);
  const reasonTooShort = reason.trim().length < 5;
  useEffect(() => {
    if (sent && sentHere.current) recorded.current?.focus();
  }, [sent]);
  async function send(decision: Decision) {
    setPending("recommendation");
    setError("");
    try {
      const response = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ decision, reason }) });
      const body = (await response.json().catch(() => ({}))) as { error?: string };
      if (response.ok) {
        sentHere.current = true;
        onSent(decision);
      } else setError(body.error ?? "The decision was not saved. Try again.");
    } catch {
      setError("The decision was not saved. Check your connection, then try again.");
    } finally {
      setPending(null);
    }
  }
  if (!hasScores && !sent) return <p className={c.note}>Send your scores first.</p>;
  return (
    <div className={c.field}>
      {!sent && unsent && (
        <p className={c.note} role="status">Recommendation uses sent scores.</p>
      )}
      {sent && (
        <p ref={recorded} role="status" className={c.success} tabIndex={-1}>
          Recommendation recorded: <strong>{LABEL[sent]}</strong>. {sent === "hire" ? "Kevin prepares the review for Gift." : "The rejection email is queued."}
        </p>
      )}
      {!sent && (
        <>
          <p className={c.note}>No queues a rejection email to the candidate.</p>
          <label className={c.field}>
            <span id={reasonHintId}>Reason for No (5+ characters)</span>
            <textarea className={c.input} rows={2} maxLength={1000} value={reason} disabled={pending === "recommendation"} onChange={(event) => setReason(event.target.value)} />
          </label>
          <div className={c.decisionActions}>
            <button type="button" className={c.button} disabled={!!pending} onClick={() => void send("hire")}>
              Yes, send for final review
            </button>
            <button type="button" className={`${c.ghost} ${c.reject}`} disabled={!!pending || reasonTooShort} aria-describedby={reasonTooShort ? reasonHintId : undefined} onClick={() => void send("reject")}>
              No, reject
            </button>
          </div>
          {pending === "recommendation" && <p role="status" className={c.note}>Sending recommendation…</p>}
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
