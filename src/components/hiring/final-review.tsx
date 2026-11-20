"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import css from "./dashboard.module.css";

type Review = {
  access: { hr: boolean; gift: boolean };
  stage: string;
  callNotes: string;
  appointment: string | null;
  packet: { id: string; behavioral: string; offer: string } | null;
};

export function FinalReview({ id, signing = false, autoLoad = false, pauseNote, onChanged }: {
  id: string;
  signing?: boolean;
  autoLoad?: boolean;
  /** Why sign-off would be refused now, from the dashboard payload; the server still decides. */
  pauseNote?: string;
  onChanged?: () => Promise<void>;
}) {
  const url = `/api/hiring/review/${id}`;
  const [review, setReview] = useState<Review>();
  const [behavioral, setBehavioral] = useState("");
  const [offer, setOffer] = useState("");
  const [reason, setReason] = useState("");
  const [viewed, setViewed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");

  const load = useCallback(async () => {
    const response = await fetch(url, { cache: "no-store" });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error ?? "Could not open the review.");
    setReview(data);
    setBehavioral(data.packet?.behavioral ?? data.callNotes ?? "");
    setOffer(data.packet?.offer ?? "");
  }, [url]);

  const loadStarted = useRef(false);
  useEffect(() => {
    if (!autoLoad || loadStarted.current) return;
    loadStarted.current = true;
    void load().catch((error) => setMessage(error instanceof Error ? error.message : "Could not open the review."));
  }, [autoLoad, load]);

  async function act(body?: object) {
    setBusy(true);
    setMessage("");
    try {
      if (body) {
        const response = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
        if (!response.ok) throw new Error((await response.json()).error ?? "Could not save the review.");
        setViewed(false);
      }
      await load();
      if (body) {
        setMessage("Saved.");
        await onChanged?.();
      }
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Could not save the review.");
    } finally {
      setBusy(false);
    }
  }

  const closed = review && ["hired", "rejected", "stopped"].includes(review.stage);
  return (
    <section className={signing ? css.finalReview : `${css.inspectorSection} ${css.finalReview}`} id={`review-${id}`} aria-label={signing ? "Contract signing" : "Final hiring review"}>
      {!signing && <h3 className={css.inspectorHeading}>Final hiring review</h3>}
      {!review && (autoLoad && !message
        ? <p className={css.inspectorMeta} role="status">Loading the review…</p>
        : <button type="button" className={css.secondary} disabled={busy} onClick={() => void act()}>{signing ? "Check contract signing" : "Open final review"}</button>)}
      {!signing && review?.packet && (
        <div className={review.access.gift ? `${css.decisionActions} ${css.packetActions}` : css.decisionActions}>
          <a className={review.access.gift ? css.primary : css.inlineLink} href={`${url}?file=html`} target="_blank" rel="noreferrer" onClick={() => setViewed(true)}>Read review packet</a>
          <a className={review.access.gift ? css.secondary : css.inlineLink} href={`${url}?file=zip`}>Download packet and files</a>
        </div>
      )}
      {!signing && review?.access.hr && !closed && (
        <>
          <label className={css.fieldLabel}>Behavioral assessment from the pre-screen call
            <textarea className={css.textarea} rows={5} maxLength={10000} value={behavioral} onChange={(event) => setBehavioral(event.target.value)} />
          </label>
          <label className={css.fieldLabel}>Offer letter
            <textarea className={css.textarea} rows={6} maxLength={10000} value={offer} onChange={(event) => setOffer(event.target.value)} />
          </label>
          <p className={css.inspectorMeta}>Enter the offer terms. Scheduling adds the contract booking link after approval.</p>
          <button type="button" className={css.primary} disabled={busy || behavioral.trim().length < 10 || offer.trim().length < 10}
            onClick={() => void act({ action: "submit", behavioral, offer })}>Send to Gift</button>
        </>
      )}
      {!signing && review?.access.gift && !closed && (review.packet ? (
        <>
          <label className={css.fieldLabel}>Sign-off note (required to reject)
            <textarea className={css.textarea} rows={2} maxLength={2000} value={reason} onChange={(event) => setReason(event.target.value)} />
          </label>
          {!viewed && <p className={css.inspectorMeta}>Open the review packet first.</p>}
          {pauseNote && <p className={css.warnWord}>{pauseNote}</p>}
          <div className={css.signOffActions}>
            <button type="button" className={css.primary} disabled={busy || !viewed} onClick={() => {
              if (window.confirm("Approve this offer letter and send it to the candidate?"))
                void act({ action: "sign", packetId: review.packet!.id, decision: "hire", reason });
            }}>Approve and send offer</button>
            <div>
              <button type="button" className={css.secondary} disabled={busy || !viewed || reason.trim().length < 5} onClick={() => {
                if (window.confirm("Reject this application and inform the candidate?"))
                  void act({ action: "sign", packetId: review.packet!.id, decision: "reject", reason });
              }}>Reject and inform candidate</button>
              {viewed && reason.trim().length < 5 && <p className={css.inspectorMeta}>Write at least 5 characters to reject.</p>}
            </div>
          </div>
        </>
      ) : <p>Waiting for HR to send the packet. <button type="button" className={css.secondary} disabled={busy} onClick={() => void act()}>Check again</button></p>)}
      {closed && <p>{review.stage === "hired" ? (review.appointment
        ? `Contract signing booked for ${new Date(review.appointment).toLocaleString("en-GB", { timeZone: "Asia/Bangkok", dateStyle: "medium", timeStyle: "short" })} (Bangkok).`
        : review.packet ? "Offer approved. Waiting for the contract booking." : "There is no contract booking on record.") : `Application ${review.stage}.`}</p>}
      {message && <p role="status">{message}</p>}
    </section>
  );
}
