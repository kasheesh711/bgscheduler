"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import { contractTestAllowed } from "@/lib/hiring/model";
import css from "./dashboard.module.css";

type Review = {
  access: { hr: boolean; gift: boolean };
  stage: string;
  callNotes: string;
  appointment: string | null;
  packet: { id: string; behavioral: string; offer: string } | null;
};

export function reviewBlocks(writeGate: boolean, config: Parameters<typeof contractTestAllowed>[0], id: string) {
  const paused = !config.enabled && !config.deliveryEnabled ? "Automation and Messages are off."
    : !config.enabled ? "Automation is off." : !config.deliveryEnabled ? "Messages are off." : undefined;
  const live = writeGate ? undefined : "Sign-off works only on the live site.";
  return { approveBlock: live ?? (contractTestAllowed(config, id) ? undefined : paused), rejectBlock: live ?? paused };
}

type ReviewAction = { action: "submit"; behavioral: string; offer: string }
  | { action: "sign"; packetId: string; decision: "hire" | "reject"; reason: string };

export function FinalReview({ id, signing = false, autoLoad = false, approveBlock, rejectBlock, onChanged }: {
  id: string;
  signing?: boolean;
  autoLoad?: boolean;
  approveBlock?: string;
  rejectBlock?: string;
  onChanged?: (signed: boolean) => Promise<void>;
}) {
  const url = `/api/hiring/review/${id}`;
  const controlId = useId();
  const readButton = useRef<HTMLButtonElement>(null);
  const [review, setReview] = useState<Review>();
  const [behavioral, setBehavioral] = useState("");
  const [offer, setOffer] = useState("");
  const [reason, setReason] = useState("");
  const [packetPage, setPacketPage] = useState<{ id: string; html: string; title: string }>();
  const [viewedId, setViewedId] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [signedStage, setSignedStage] = useState<"hired" | "rejected">();
  const [error, setError] = useState<{ text: string; retry?: boolean }>();
  const packet = review?.packet;
  const openPage = packetPage?.id === packet?.id ? packetPage : undefined;
  const viewed = !!packet && packet.id === viewedId;

  const load = useCallback(async (afterSave = false, previousPacket?: string) => {
    try {
      const response = await fetch(url, { cache: "no-store" });
      const data: Review | { error?: string } | null = await response.json().catch(() => null);
      if (!response.ok || !data || !("access" in data)) throw new Error(data && "error" in data ? data.error : undefined);
      setReview(data);
      if (!previousPacket || previousPacket !== data.packet?.id) {
        setBehavioral(data.packet?.behavioral ?? data.callNotes ?? "");
        setOffer(data.packet?.offer ?? "");
      }
      return data;
    } catch (error) {
      setError({ text: afterSave ? "Could not refresh the review." : (error instanceof Error && error.message) || "Could not open the review.", retry: true });
    }
  }, [url]);

  const loadStarted = useRef(false);
  useEffect(() => {
    if (!autoLoad || signing || loadStarted.current) return;
    loadStarted.current = true;
    void load();
  }, [autoLoad, load, signing]);

  async function act(body?: ReviewAction) {
    setBusy(true);
    setError(undefined);
    try {
      if (body) {
        setSaved(false);
        const response = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
        if (!response.ok) throw new Error((await response.json()).error ?? "Could not save the review.");
        setSaved(true);
        if (body.action === "sign") setSignedStage(body.decision === "hire" ? "hired" : "rejected");
      }
      await load(!!body);
      if (body) await onChanged?.(body.action === "sign").catch(() => {
        setError((current) => current ?? { text: "Could not refresh the dashboard." });
      });
    } catch (error) {
      setError({ text: error instanceof Error ? error.message : "Could not save the review." });
    } finally {
      setBusy(false);
    }
  }

  async function readPacket(packetId: string) {
    setBusy(true);
    setError(undefined);
    setViewedId(undefined);
    try {
      const response = await fetch(`${url}?file=html`, { cache: "no-store" });
      if (!response.ok) throw new Error();
      const html = await response.text();
      const head = /<head\b[^>]*>/i;
      const base = '<base target="_blank">';
      const source = head.test(html) ? html.replace(head, `$&${base}`) : html.replace(/<html\b[^>]*>/i, `$&<head>${base}`);
      if (source === html) throw new Error();
      const titleTag = html.match(/<title>[^<]*<\/title>/i)?.[0] ?? "";
      const name = new DOMParser().parseFromString(titleTag, "text/html").title.replace(/^Hiring review \| /, "");
      setPacketPage({ id: packetId, html: source, title: `Review packet for ${name || "candidate"}` });
    } catch {
      setError({ text: "Could not open the packet. Try again." });
    } finally {
      setBusy(false);
    }
  }

  function closePacket() {
    setPacketPage(undefined);
    readButton.current?.focus();
  }

  async function checkPacket(packetId: string) {
    if (busy || viewed) return;
    setBusy(true);
    const current = await load(false, packetId);
    if (current?.packet?.id === packetId) setViewedId(packetId);
    else {
      closePacket();
      if (current) setError({ text: "HR sent a new packet. Read it again." });
    }
    setBusy(false);
  }

  const stage = signedStage ?? review?.stage;
  const closed = stage === "hired" || stage === "rejected" || stage === "stopped";
  const instruction = `${controlId}-instruction`;
  const sharedReason = approveBlock && approveBlock === rejectBlock ? `${controlId}-block` : undefined;
  const approveReason = sharedReason ?? (approveBlock && `${controlId}-approve`);
  const rejectReason = sharedReason ?? (rejectBlock && `${controlId}-reject`);
  const rejectHint = viewed && reason.trim().length < 5 ? `${controlId}-note` : undefined;
  const signOffDisabled = busy || !viewed || !!error?.retry;
  const awaitingSignOff = !signing && review?.access.gift && !closed;
  return (
    <section className={signing ? css.finalReview : `${css.inspectorSection} ${css.finalReview}`} id={`review-${id}`} aria-label={signing ? "Contract signing" : "Final hiring review"}>
      {!signing && <h3 className={css.inspectorHeading}>Final hiring review</h3>}
      {!review && !error && (autoLoad || busy
        ? <p className={css.inspectorMeta} role="status">Loading the review…</p>
        : <button type="button" className={css.secondary} onClick={() => void act()}>{signing ? "Check contract signing" : "Open final review"}</button>)}
      {awaitingSignOff && packet && <>
        <p className={css.reviewStatus}>Waiting for your sign-off</p>
        <p id={instruction} className={css.inspectorMeta}>{viewed ? "Approve, or write a note and reject." : "Read the packet first."}</p>
      </>}
      {!signing && review && packet && (
        <div className={`${css.decisionActions} ${css.packetActions}`}>
          {review.access.gift ? (
            <button type="button" className={css.primary} ref={readButton} aria-expanded={!!openPage} aria-disabled={busy || !!openPage}
              aria-controls={openPage ? `${controlId}-packet` : undefined}
              onClick={() => { if (!busy && !openPage) void readPacket(packet.id); }}>Read review packet</button>
          ) : <a className={css.secondary} href={`${url}?file=html`} target="_blank" rel="noreferrer">Read review packet</a>}
          {openPage && (
            <div className={css.packetPanel} id={`${controlId}-packet`}>
              <button type="button" className={css.secondary} onClick={closePacket}>Close packet</button>
              <iframe title={openPage.title} srcDoc={openPage.html} sandbox="allow-popups allow-popups-to-escape-sandbox" onLoad={() => void checkPacket(openPage.id)} />
            </div>
          )}
          <a className={css.secondary} href={`${url}?file=zip`}>Download packet and files</a>
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
      {awaitingSignOff && (packet ? (
        <>
          <label className={css.fieldLabel}>Sign-off note (optional for approval)
            <textarea className={css.textarea} aria-describedby={rejectHint} rows={2} maxLength={2000} value={reason} onChange={(event) => setReason(event.target.value)} />
          </label>
          {sharedReason && <p id={sharedReason} className={css.inspectorMeta}>{approveBlock}</p>}
          <div className={css.signOffActions}>
            <div>
              <button type="button" className={css.primary} disabled={signOffDisabled || !!approveBlock} aria-describedby={[instruction, approveReason].filter(Boolean).join(" ")} onClick={() => {
                if (window.confirm("Approve this offer letter and send it to the candidate?"))
                  void act({ action: "sign", packetId: packet.id, decision: "hire", reason });
              }}>Approve and send offer</button>
              {!sharedReason && approveReason && <p id={approveReason} className={css.inspectorMeta}>{approveBlock}</p>}
            </div>
            <div>
              <button type="button" className={css.secondary} disabled={signOffDisabled || reason.trim().length < 5 || !!rejectBlock} aria-describedby={[instruction, rejectReason, rejectHint].filter(Boolean).join(" ")} onClick={() => {
                if (window.confirm("Reject this application and inform the candidate?"))
                  void act({ action: "sign", packetId: packet.id, decision: "reject", reason });
              }}>Reject and inform candidate</button>
              {!sharedReason && rejectReason && <p id={rejectReason} className={css.inspectorMeta}>{rejectBlock}</p>}
              {rejectHint && <p id={rejectHint} className={css.inspectorMeta}>Write at least 5 characters to reject.</p>}
            </div>
          </div>
        </>
      ) : <p>Waiting for HR to send the packet. <button type="button" className={css.secondary} disabled={busy} onClick={() => void act()}>Check again</button></p>)}
      <p role="status">{closed && (stage === "hired" ? (review?.appointment
        ? `Contract signing booked for ${new Date(review.appointment).toLocaleString("en-GB", { timeZone: "Asia/Bangkok", dateStyle: "medium", timeStyle: "short" })} (Bangkok).`
        : packet ? "Offer queued." : "There is no contract booking on record.") : `Application ${stage}.`)}</p>
      {saved && !signedStage && <p role="status">Saved.</p>}
      {error && <div role="alert" className={css.errorText}>
        <p>{error.text}</p>
        {error.retry && <button type="button" className={css.secondary} disabled={busy} onClick={() => void act()}>Retry</button>}
      </div>}
    </section>
  );
}
