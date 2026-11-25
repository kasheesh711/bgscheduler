"use client";

import { useEffect, useId, useRef, useState } from "react";
import { OFFER_LETTERS, OFFER_TYPES, type OfferType } from "@/lib/hiring/offer-letters";
import type { BriefPending } from "./brief";
import c from "./booking.module.css";
import b from "./brief.module.css";

type Decision = "hire" | "reject";
const LABEL: Record<Decision, string> = { hire: "Yes", reject: "No" };

/** The tutor recommends Yes for HR review or No to queue a rejection. On Gift's own mock, Hire sends the offer at once. */
export function BriefDecision({ owner = false, offerSent = false, signIn, sent, onSent, url, hasScores, unsent, pending, setPending }: {
  owner?: boolean;
  /** The recorded Hire sent the offer. A recommendation Gift gave before 25 Nov 2026 did not. */
  offerSent?: boolean;
  signIn?: string;
  sent: Decision | null;
  onSent: (decision: Decision) => void;
  url: string;
  hasScores: boolean;
  unsent: boolean;
  pending: BriefPending;
  setPending: (pending: BriefPending) => void;
}) {
  const [reason, setReason] = useState("");
  const [offerType, setOfferType] = useState<OfferType | null>(null);
  const [justSent, setJustSent] = useState(false);
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
      const response = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ decision, reason, ...(owner && decision === "hire" ? { offerType } : {}) }) });
      const body = (await response.json().catch(() => ({}))) as { error?: string };
      if (response.ok) {
        sentHere.current = true;
        setJustSent(true);
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
          {owner && (sent === "reject" || offerSent || justSent) ? <>Decision recorded: <strong>{sent === "hire" ? "Hire" : "Reject"}</strong>. {sent === "hire" ? "The offer letter and contract-signing link are emailed to the candidate." : "The rejection email is queued."}</>
            : <>Recommendation recorded: <strong>{LABEL[sent]}</strong>. {sent === "hire" ? "Kevin prepares the review for Gift." : "The rejection email is queued."}</>}
        </p>
      )}
      {!sent && (
        <>
          {owner && (
            <fieldset className={`${b.choices} ${b.offerChoices}`} disabled={!!pending}>
              <legend>Offer letter</legend>
              {OFFER_TYPES.map((type) => (
                <label key={type} className={b.choice}>
                  <input type="radio" name="offer-type" className={b.choiceInput} checked={offerType === type} onChange={() => setOfferType(type)} />
                  {OFFER_LETTERS[type].label}
                </label>
              ))}
            </fieldset>
          )}
          {owner && offerType && <p className={c.note}>{OFFER_LETTERS[offerType].terms}</p>}
          <p className={c.note}>{owner ? "Hire emails the offer letter and the contract-signing link now. No emails a rejection." : "No queues a rejection email to the candidate."}</p>
          <label className={c.field}>
            <span id={reasonHintId}>Reason for No (5+ characters)</span>
            <textarea className={c.input} rows={2} maxLength={1000} value={reason} disabled={pending === "recommendation"} onChange={(event) => setReason(event.target.value)} />
          </label>
          <div className={c.decisionActions}>
            {signIn ? <a className={c.button} href={signIn}>Sign in to send the offer</a> : (
              <button type="button" className={c.button} disabled={!!pending || (owner && !offerType)} onClick={() => void send("hire")}>
                {owner ? "Hire, send offer" : "Yes, send for final review"}
              </button>
            )}
            <button type="button" className={`${c.ghost} ${c.reject}`} disabled={!!pending || reasonTooShort} aria-describedby={reasonTooShort ? reasonHintId : undefined} onClick={() => void send("reject")}>
              No, reject
            </button>
          </div>
          {pending === "recommendation" && <p role="status" className={c.note}>{owner ? "Sending decision…" : "Sending recommendation…"}</p>}
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
