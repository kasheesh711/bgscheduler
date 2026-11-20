"use client";

import { useCallback, useEffect, useId, useRef, useState, useSyncExternalStore } from "react";
import { contractTestAllowed } from "@/lib/hiring/model";
import css from "./dashboard.module.css";

type Review = {
  access: { hr: boolean; gift: boolean };
  stage: string;
  callNotes: string;
  appointment: string | null;
  packet: { id: string; behavioral: string; offer: string } | null;
  packetValid: boolean;
};

export function reviewBlocks(writeGate: boolean, config: Parameters<typeof contractTestAllowed>[0], id: string) {
  const paused = !config.enabled && !config.deliveryEnabled ? "Automation and Messages are off."
    : !config.enabled ? "Automation is off." : !config.deliveryEnabled ? "Messages are off." : undefined;
  const live = writeGate ? undefined : "Sign-off works only on the live site.";
  return { approveBlock: live ?? (contractTestAllowed(config, id) ? undefined : paused), rejectBlock: live ?? paused };
}

type ReviewAction = { action: "submit"; behavioral: string; offer: string }
  | { action: "sign"; packetId: string; decision: "hire" | "reject"; reason: string };

async function fetchReview(url: string) {
  const response = await fetch(url, { cache: "no-store" });
  const data: Review | { error?: string } | null = await response.json().catch(() => null);
  if (!response.ok || !data || !("access" in data)) {
    throw new Error((data && "error" in data && data.error) || "Could not open the review.");
  }
  return data;
}

const phoneReader = "(width < 720px)";
function subscribeToPhoneReader(change: () => void) {
  const query = window.matchMedia(phoneReader);
  query.addEventListener("change", change);
  return () => query.removeEventListener("change", change);
}

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
  const packetDialog = useRef<HTMLDialogElement>(null);
  const outcome = useRef<HTMLParagraphElement>(null);
  const phone = useSyncExternalStore(subscribeToPhoneReader, () => window.matchMedia(phoneReader).matches, () => false);
  const [review, setReview] = useState<Review>();
  const [behavioral, setBehavioral] = useState("");
  const [offer, setOffer] = useState("");
  const [reason, setReason] = useState("");
  const [packetPage, setPacketPage] = useState<{ id: string; html: string; name: string }>();
  const [viewedId, setViewedId] = useState<string>();
  const [busy, setBusy] = useState<"review" | "packet" | "sign" | null>(null);
  const [saved, setSaved] = useState(false);
  const [signedStage, setSignedStage] = useState<"hired" | "rejected">();
  const [error, setError] = useState<{ text: string; retry?: boolean; packetLoad?: boolean }>();
  const packet = review?.packet;
  const openPage = packetPage?.id === packet?.id ? packetPage : undefined;
  const stale = !!packet && review?.packetValid !== true;
  const viewed = !!packet && !stale && packet.id === viewedId;

  const load = useCallback(async (afterSave = false, previousPacket?: string) => {
    try {
      const data = await fetchReview(url);
      setReview(data);
      setViewedId((id) => data.packetValid && id === data.packet?.id ? id : undefined);
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
  useEffect(() => {
    if (signedStage) outcome.current?.focus();
  }, [signedStage]);
  useEffect(() => {
    if (openPage && phone) packetDialog.current?.showModal();
  }, [openPage, phone]);

  const closeReader = useCallback(() => {
    packetDialog.current?.close();
    setPacketPage(undefined);
    readButton.current?.focus();
  }, []);

  const closePacket = useCallback(() => {
    if (!openPage) return;
    if (window.history.state?.hiringReviewPacket === controlId) window.history.back();
    closeReader();
  }, [closeReader, controlId, openPage]);

  useEffect(() => {
    if (!openPage) return;
    function onKeyDown(event: KeyboardEvent) {
      if (!phone && event.key === "Escape" && !event.defaultPrevented) {
        event.preventDefault();
        closePacket();
      }
    }
    window.addEventListener("popstate", closeReader);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("popstate", closeReader);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [openPage, phone, closeReader, closePacket]);

  async function act(body?: ReviewAction) {
    setBusy(body?.action === "sign" ? "sign" : "review");
    setError(undefined);
    try {
      if (body) {
        setSaved(false);
        if (body.action === "sign") {
          const current = await fetchReview(url);
          if (current.packet?.id !== body.packetId || current.packetValid !== true) {
            if (current.packet && current.packetValid === true) {
              setReview(current);
              setBehavioral(current.packet.behavioral);
              setOffer(current.packet.offer);
              setError({ text: "HR sent a new packet. Read it again." });
            } else {
              setReview((previous) => previous && { ...previous, packetValid: false });
            }
            setViewedId(undefined);
            closePacket();
            return;
          }
        }
        const response = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
        if (!response.ok) {
          const data = await response.json().catch(() => null);
          const text = data?.error ?? "Could not save the review.";
          if (body.action === "sign") {
            const current = await load(false, body.packetId);
            if (current && (!current.packetValid || current.packet?.id !== body.packetId)) {
              closePacket();
              if (current.packet && !current.packetValid) return;
            }
            setError({ text, retry: !current });
            return;
          }
          throw new Error(text);
        }
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
      setBusy(null);
    }
  }

  async function readPacket(packetId: string) {
    setBusy("packet");
    setError(undefined);
    try {
      const response = await fetch(`${url}?file=html`, { cache: "no-store" });
      if (response.status === 409) {
        const current = await load(false, packetId);
        if (!current || (current.packet && !current.packetValid)) return;
      }
      if (!response.ok) {
        const data = await response.json().catch(() => null);
        throw new Error(data?.error ?? "Could not open the packet. Try again.");
      }
      const html = await response.text();
      const head = /<head\b[^>]*>/i;
      const base = '<base target="_blank">';
      const source = head.test(html) ? html.replace(head, `$&${base}`) : html.replace(/<html\b[^>]*>/i, `$&<head>${base}`);
      if (source === html) throw new Error();
      const titleTag = html.match(/<title>[^<]*<\/title>/i)?.[0] ?? "";
      const name = new DOMParser().parseFromString(titleTag, "text/html").title.replace(/^Hiring review \| /, "");
      window.history.pushState({ hiringReviewPacket: controlId }, "");
      setPacketPage({ id: packetId, html: source, name: name || "candidate" });
    } catch (error) {
      setError({ text: (error instanceof Error && error.message) || "Could not open the packet. Try again.", packetLoad: true });
    } finally {
      setBusy(null);
    }
  }

  async function checkPacket(packetId: string) {
    if (busy || stale) return;
    setBusy("review");
    const current = await load(false, packetId);
    if (current?.packet?.id === packetId) {
      if (current.packetValid) setViewedId(packetId);
      else closePacket();
    } else {
      closePacket();
      if (current) setError({ text: "HR sent a new packet. Read it again." });
    }
    setBusy(null);
  }

  const stage = signedStage ?? review?.stage;
  const closed = stage === "hired" || stage === "rejected" || stage === "stopped";
  const instruction = `${controlId}-instruction`;
  const sharedBlock = approveBlock === rejectBlock ? approveBlock : undefined;
  const approveReason = !sharedBlock && approveBlock ? `${controlId}-approve` : undefined;
  const rejectReason = !sharedBlock && rejectBlock ? `${controlId}-reject` : undefined;
  const rejectHint = viewed && reason.trim().length < 5 ? `${controlId}-note` : undefined;
  const signOffDisabled = !!busy || !viewed || !!error?.retry;
  const awaitingSignOff = !signing && review?.access.gift && !closed;
  const packetTitle = openPage && `Review packet for ${openPage.name}`;
  const packetFrame = openPage && (
    <iframe title={packetTitle} srcDoc={openPage.html}
      className={phone ? "block h-full min-h-0 w-full border-0" : undefined}
      sandbox="allow-popups allow-popups-to-escape-sandbox"
      onLoad={() => void checkPacket(openPage.id)} />
  );
  return (
    <section className={signing ? css.finalReview : `${css.inspectorSection} ${css.finalReview}`} id={`review-${id}`} aria-label={signing ? "Contract signing" : "Final hiring review"}>
      {!signing && <h3 className={css.inspectorHeading}>Final hiring review</h3>}
      {!review && !error && (autoLoad || busy
        ? <p className={css.inspectorMeta} role="status">Loading the review…</p>
        : <button type="button" className={css.secondary} onClick={() => void act()}>{signing ? "Check contract signing" : "Open final review"}</button>)}
      {(awaitingSignOff || stale) && packet && <>
        {awaitingSignOff && <p className={css.reviewStatus}>{stale ? "Waiting for a new packet from HR" : "Waiting for your sign-off"}</p>}
        <p id={instruction} className={css.inspectorMeta} role={stale ? "alert" : undefined}>{stale ? "The evidence changed. Ask HR to send a new packet."
          : sharedBlock ?? (viewed ? "Approve, or write a note and reject." : "Read the packet first.")}</p>
        {stale && <button type="button" className={`${css.secondary} min-h-11 min-w-11`} disabled={!!busy} onClick={() => void act()}>Check again</button>}
      </>}
      {!signing && review && packet && (
        <div className={`${css.decisionActions} ${css.packetActions}`}>
          {review.access.gift ? (
            <button type="button" className={css.primary} ref={readButton} disabled={stale && awaitingSignOff} aria-expanded={!!openPage} aria-disabled={!!busy || !!openPage || (stale && awaitingSignOff)}
              aria-controls={openPage ? `${controlId}-packet` : undefined}
              onClick={() => { if (!busy && !openPage) void readPacket(packet.id); }}>Read review packet</button>
          ) : <a className={css.secondary} href={`${url}?file=html`} target="_blank" rel="noreferrer">Read review packet</a>}
          {busy === "packet" && <p role="status" className={css.inspectorMeta}>Opening packet…</p>}
          {error?.packetLoad && <p role="alert" className={css.errorText}>{error.text}</p>}
          {openPage && (phone ? (
            <dialog ref={packetDialog} id={`${controlId}-packet`} aria-label={packetTitle}
              className="fixed inset-0 m-0 h-dvh max-h-none w-full max-w-none grid-rows-[auto_minmax(0,1fr)] overflow-hidden border-0 bg-white p-0 open:grid"
              onCancel={(event) => { event.preventDefault(); closePacket(); }}>
              <div className="flex items-center justify-between gap-2 border-b px-3 py-2">
                <span className="min-w-0 [overflow-wrap:anywhere]">{openPage.name}</span>
                <button type="button" className={`${css.secondary} min-h-11 min-w-11 shrink-0`} onClick={closePacket}>Close packet</button>
              </div>
              {packetFrame}
            </dialog>
          ) : (
            <div className={css.packetPanel} id={`${controlId}-packet`}>
              <button type="button" className={css.secondary} onClick={closePacket}>Close packet</button>
              {packetFrame}
            </div>
          ))}
          {stale ? (
            <button type="button" className={css.secondary} disabled aria-disabled="true" aria-describedby={instruction}>Download packet and files</button>
          ) : <a className={css.secondary} href={`${url}?file=zip`}>Download packet and files</a>}
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
          <button type="button" className={css.primary} disabled={!!busy || behavioral.trim().length < 10 || offer.trim().length < 10}
            onClick={() => void act({ action: "submit", behavioral, offer })}>Send to Gift</button>
        </>
      )}
      {awaitingSignOff && (packet ? (
        <>
          <label className={css.fieldLabel}>Sign-off note (optional for approval)
            <textarea className={css.textarea} aria-describedby={rejectHint} rows={2} maxLength={2000} value={reason} readOnly={busy === "sign"} onChange={(event) => setReason(event.target.value)} />
          </label>
          <div className={css.signOffActions}>
            <div>
              <button type="button" className={css.primary} disabled={signOffDisabled || !!approveBlock} aria-describedby={[instruction, approveReason].filter(Boolean).join(" ")} onClick={() => {
                if (window.confirm("Approve this offer letter and send it to the candidate?"))
                  void act({ action: "sign", packetId: packet.id, decision: "hire", reason });
              }}>Approve and send offer</button>
              {approveReason && <p id={approveReason} className={css.inspectorMeta}>{approveBlock}</p>}
            </div>
            <div>
              <button type="button" className={css.secondary} disabled={signOffDisabled || reason.trim().length < 5 || !!rejectBlock} aria-describedby={[instruction, rejectReason, rejectHint].filter(Boolean).join(" ")} onClick={() => {
                if (window.confirm("Reject this application and inform the candidate?"))
                  void act({ action: "sign", packetId: packet.id, decision: "reject", reason });
              }}>Reject and inform candidate</button>
              {rejectReason && <p id={rejectReason} className={css.inspectorMeta}>{rejectBlock}</p>}
              {rejectHint && <p id={rejectHint} className={css.inspectorMeta}>Write at least 5 characters to reject.</p>}
            </div>
          </div>
          {busy === "sign" && <p role="status" className={css.inspectorMeta}>Saving sign-off…</p>}
        </>
      ) : <p>Waiting for HR to send the packet. <button type="button" className={css.secondary} disabled={!!busy} onClick={() => void act()}>Check again</button></p>)}
      <p ref={outcome} role="status" tabIndex={-1}>{closed && (stage === "hired" ? (review?.appointment
        ? `Contract signing booked for ${new Date(review.appointment).toLocaleString("en-GB", { timeZone: "Asia/Bangkok", dateStyle: "medium", timeStyle: "short" })} (Bangkok).`
        : packet ? "Offer queued." : "There is no contract booking on record.") : `Application ${stage}.`)}</p>
      {saved && !signedStage && <p role="status">Saved.</p>}
      {error && !error.packetLoad && <div role="alert" className={css.errorText}>
        <p>{error.text}</p>
        {error.retry && <button type="button" className={css.secondary} disabled={!!busy} onClick={() => void act()}>Retry</button>}
      </div>}
    </section>
  );
}
