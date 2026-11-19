"use client";

import { useState } from "react";
import c from "./booking.module.css";

type Decision = "hire" | "reject";
const LABEL: Record<Decision, string> = { hire: "Yes", reject: "No" };

/** The tutor recommends Yes for HR review or No to queue a rejection. */
export function BriefDecision({ sent, url }: { sent: Decision | null; url: string }) {
  const [done, setDone] = useState<Decision | null>(sent);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
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
  return (
    <div className={c.field}>
      {done && (
        <p role="status" className={c.note}>
          Recommendation recorded: <strong>{LABEL[done]}</strong>. {done === "hire" ? "HR will prepare the review for Gift." : "The candidate’s rejection email is queued."}
        </p>
      )}
      {!done && <><p className={c.note}>Submit the rubric first. Yes sends the application to HR. No queues a rejection email to the candidate.</p>
      <label className={c.field}>
        Reason (required for No)
        <textarea className={c.input} rows={2} maxLength={1000} value={reason} onChange={(event) => setReason(event.target.value)} />
      </label>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        <button type="button" className={c.button} disabled={busy} onClick={() => void send("hire")}>
          {LABEL.hire}
        </button>
        <button type="button" className={c.button} disabled={busy || reason.trim().length < 5} onClick={() => void send("reject")}>
          {LABEL.reject}
        </button>
      </div>
      </>}
      {error && (
        <p role="alert" className={c.alert}>
          {error}
        </p>
      )}
    </div>
  );
}
