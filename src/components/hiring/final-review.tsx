"use client";

import { useCallback, useEffect, useId, useRef, useState, useSyncExternalStore } from "react";
import { contractTestAllowed } from "@/lib/hiring/model";
import { OFFER_LETTERS, type OfferType } from "@/lib/hiring/offer-letters";
import css from "./dashboard.module.css";

type Review = {
  access: { hr: boolean; gift: boolean };
  stage: string;
  callNotes: string;
  appointment: string | null;
  packet: { id: string; behavioral: string; offer: string; offerType?: OfferType | null } | null;
  /** null: the server could not check the packet just now. */
  packetValid: boolean | null;
};

export function reviewBlocks(writeGate: boolean, config: Parameters<typeof contractTestAllowed>[0], id: string) {
  const bothOff = !config.enabled && !config.deliveryEnabled;
  const paused = bothOff ? "Automation and Messages"
    : !config.enabled ? "Automation" : !config.deliveryEnabled ? "Messages" : undefined;
  const live = writeGate ? undefined : "Sign-off works only on the live site.";
  const testAllowed = contractTestAllowed(config, id);
  const pausedStatus = paused && !testAllowed ? `${paused} off` : undefined;
  const instruction = paused && (testAllowed ? `Ask Kevin to enable ${paused}.`
    : bothOff ? "Ask Kevin to enable both." : "Ask Kevin to enable it.");
  return { approveBlock: live ?? (testAllowed ? undefined : instruction), rejectBlock: live ?? instruction, pausedStatus };
}

type ReviewAction = { action: "submit"; behavioral: string; offerType: OfferType }
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

export function FinalReview({ id, signing = false, autoLoad = false, hideHeading = false, inline = false, signed, approveBlock, rejectBlock, pausedStatus, onChanged }: {
  id: string;
  /** Gift's Hiring screen: on a wide screen the packet opens at once beside her decision, so she reads and writes together
   * (Kevin, 24 Nov 2026). Opening it is still what unlocks sign-off. A phone keeps the full-screen reader. */
  inline?: boolean;
  signing?: boolean;
  autoLoad?: boolean;
  hideHeading?: boolean;
  approveBlock?: string;
  rejectBlock?: string;
  pausedStatus?: string;
  /** A review signed in this session that mounts again (a phone row that moved to Just finished) keeps its receipt. */
  signed?: "hired" | "rejected";
  onChanged?: (signed: "hired" | "rejected" | false) => Promise<void>;
}) {
  const url = `/api/hiring/review/${id}`;
  const controlId = useId();
  const readButton = useRef<HTMLButtonElement>(null);
  const approveButton = useRef<HTMLButtonElement>(null);
  const retryButton = useRef<HTMLButtonElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const packetDialog = useRef<HTMLDialogElement>(null);
  const outcome = useRef<HTMLParagraphElement>(null);
  const phone = useSyncExternalStore(subscribeToPhoneReader, () => window.matchMedia(phoneReader).matches, () => false);
  const [review, setReview] = useState<Review>();
  const [behavioral, setBehavioral] = useState("");
  const [offerType, setOfferType] = useState<OfferType | "">("");
  const [draftHtml, setDraftHtml] = useState<string>();
  const [reason, setReason] = useState("");
  const [packetPage, setPacketPage] = useState<{ id: string; html: string; name: string }>();
  const [viewedId, setViewedId] = useState<string>();
  const [busy, setBusy] = useState<"review" | "packet" | "sign" | null>(null);
  const [saved, setSaved] = useState(false);
  const [signedStage, setSignedStage] = useState<"hired" | "rejected" | undefined>(signed);
  const [error, setError] = useState<{ text: string; retry?: boolean; packetLoad?: boolean }>();
  const packet = review?.packet;
  const openPage = packetPage?.id === packet?.id ? packetPage : undefined;
  // A signed or closed review never shows the stale alert; the contract-signing card neither.
  const stale = !!packet && !signing && !["hired", "rejected", "stopped"].includes(review?.stage ?? "") && review?.packetValid !== true;
  const viewed = !!packet && !stale && packet.id === viewedId;
  const instruction = `${controlId}-instruction`;
  const pauseReason = !stale && pausedStatus ? `${controlId}-paused` : undefined;
  const sharedBlock = approveBlock === rejectBlock ? approveBlock : undefined;
  const approveReason = !sharedBlock && approveBlock ? `${controlId}-approve` : undefined;

  const load = useCallback(async (afterSave = false, previousPacket?: string) => {
    try {
      const data = await fetchReview(url);
      setReview(data);
      setViewedId((id) => data.packetValid && id === data.packet?.id ? id : undefined);
      if (!previousPacket || previousPacket !== data.packet?.id) {
        setBehavioral(data.packet?.behavioral ?? data.callNotes ?? "");
        setOfferType(data.packet?.offerType ?? "");
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
  // Also after a load, so a review that mounts again after sign-off puts focus on its receipt once it shows.
  useEffect(() => {
    if (signedStage) outcome.current?.focus();
  }, [signedStage, review]);
  const autoOpened = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (!openPage || !phone) return;
    packetDialog.current?.showModal();
    closeButton.current?.focus();
  }, [openPage, phone]);

  const refocus = useRef(false);
  const backTimer = useRef<number | undefined>(undefined);
  const stopBack = useRef<(() => void) | undefined>(undefined);
  useEffect(() => () => stopBack.current?.(), []);
  const [refocusTick, setRefocusTick] = useState(0);
  const closeReader = useCallback(() => {
    packetDialog.current?.close();
    setPacketPage(undefined);
    refocus.current = true;
  }, []);
  // After the reader is gone from the page: focus set while the modal dialog is still mounted is lost.
  useEffect(() => {
    if (openPage || !refocus.current) return;
    refocus.current = false;
    const approve = approveButton.current;
    if (viewed && approve && !approve.disabled) {
      approve.focus();
    } else if (readButton.current && !readButton.current.disabled) {
      readButton.current.focus();
    } else {
      // A stale packet disables Read. Check again is the way on.
      retryButton.current?.focus();
    }
  }, [openPage, viewed, refocusTick]);

  // An open reader leaves no stray history entry when the card unmounts.
  useEffect(() => () => {
    if (window.history.state?.hiringReviewPacket === controlId) window.history.back();
  }, [controlId]);

  const closePacket = useCallback(() => {
    if (!openPage) return;
    if (window.history.state?.hiringReviewPacket === controlId) {
      // The step back in history makes the browser drop focus, so set it again one tick after it.
      const onBack = () => {
        backTimer.current = window.setTimeout(() => {
          refocus.current = true;
          setRefocusTick((tick) => tick + 1);
        });
      };
      window.addEventListener("popstate", onBack, { once: true });
      stopBack.current = () => {
        window.removeEventListener("popstate", onBack);
        window.clearTimeout(backTimer.current);
      };
      window.history.back();
    }
    closeReader();
  }, [closeReader, controlId, openPage]);

  useEffect(() => {
    if (!openPage) return;
    function onKeyDown(event: KeyboardEvent) {
      if (!phone && !inline && event.key === "Escape" && !event.defaultPrevented) {
        event.preventDefault();
        closePacket();
      }
    }
    // The packet that opens by itself beside Gift's decision pushed no history entry, so Back does not close it.
    const onBack = inline && !phone ? undefined : closeReader;
    if (onBack) window.addEventListener("popstate", onBack);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      if (onBack) window.removeEventListener("popstate", onBack);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [openPage, phone, inline, closeReader, closePacket]);

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
              setOfferType(current.packet.offerType ?? "");
              setError({ text: "A new packet was sent. Read it again." });
            } else {
              setReview((previous) => previous && { ...previous, packetValid: current.packet?.id === body.packetId ? current.packetValid : false });
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
        setDraftHtml(undefined);
        if (body.action === "sign") setSignedStage(body.decision === "hire" ? "hired" : "rejected");
      }
      await load(!!body);
      if (body) await onChanged?.(body.action === "sign" && (body.decision === "hire" ? "hired" : "rejected")).catch(() => {
        setError((current) => current ?? { text: "Could not refresh the dashboard." });
      });
    } catch (error) {
      setError({ text: error instanceof Error ? error.message : "Could not save the review." });
    } finally {
      setBusy(null);
    }
  }

  async function readPacket(packetId: string, remember = true) {
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
      // In a srcdoc frame "#…" resolves against the outer page and empties the frame; about:srcdoc keeps it inside.
      // Beside Gift's decision the packet gets a shorter masthead (data-inline), so the score tiles fit on a laptop.
      // Beside the decision, a standard offer's terms already show by Approve, so the packet hides its copy (data-terms).
      const inFrame = html.replaceAll('href="#', 'href="about:srcdoc#').replace("<html ", remember ? "<html " : packet?.offerType ? "<html data-inline data-terms " : "<html data-inline ");
      const source = head.test(inFrame) ? inFrame.replace(head, `$&${base}`) : inFrame.replace(/<html\b[^>]*>/i, `$&<head>${base}`);
      if (source === inFrame) throw new Error();
      const titleTag = html.match(/<title>[^<]*<\/title>/i)?.[0] ?? "";
      const name = new DOMParser().parseFromString(titleTag, "text/html").title.replace(/^Hiring review \| /, "");
      // The Back button closes a reader the head opened; the packet that opens by itself in Gift's screen has no reader to close.
      if (remember) window.history.pushState({ hiringReviewPacket: controlId }, "");
      setPacketPage({ id: packetId, html: source, name: name || "candidate" });
    } catch (error) {
      setError({ text: (error instanceof Error && error.message) || "Could not open the packet. Try again.", packetLoad: true });
    } finally {
      setBusy(null);
    }
  }

  /** HR sees the packet with the draft text before Gift does. Nothing is saved. */
  async function previewDraft() {
    if (!offerType) return;
    setBusy("packet");
    setError(undefined);
    try {
      const response = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "preview", behavioral, offerType }) });
      if (!response.ok) throw new Error((await response.json().catch(() => null))?.error ?? "Could not open the preview. Try again.");
      // Without the tag, a file link opens inside the preview frame.
      setDraftHtml((await response.text()).replaceAll('href="#', 'href="about:srcdoc#').replace(/<head\b[^>]*>/i, '$&<base target="_blank">'));
    } catch (error) {
      setError({ text: (error instanceof Error && error.message) || "Could not open the preview. Try again." });
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
      if (current) setError({ text: "A new packet was sent. Read it again." });
    }
    setBusy(null);
  }

  const stage = signedStage ?? review?.stage;
  const closed = stage === "hired" || stage === "rejected" || stage === "stopped";
  const rejectReason = !sharedBlock && rejectBlock ? `${controlId}-reject` : undefined;
  const rejectHint = viewed && reason.trim().length < 5 ? `${controlId}-note` : undefined;
  const draftDisabled = behavioral.trim().length < 10 || !offerType;
  const signOffDisabled = !!busy || !viewed || !!error?.retry;
  const awaitingSignOff = !signing && review?.access.gift && !closed;
  // Announce readiness when the phone dialog closes and the page is no longer inert.
  const ready = viewed && !sharedBlock && !error?.retry && !(phone && openPage);
  const packetTitle = openPage && `Review packet for ${openPage.name}`;
  const besideDecision = inline && !phone;
  useEffect(() => {
    // In the head list the packet opens with the row: beside the decision, or full screen on a phone, where Back closes it.
    if (!inline || closed || !packet || stale || !review?.access.gift || openPage || busy || autoOpened.current === packet.id) return;
    autoOpened.current = packet.id;
    void readPacket(packet.id, !besideDecision);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- readPacket is a plain function; the guard runs it once per packet.
  }, [inline, besideDecision, closed, packet, stale, review, openPage, busy]);
  const packetFrame = openPage && (
    <iframe title={packetTitle} srcDoc={openPage.html}
      className={phone ? "block h-full min-h-0 w-full border-0" : undefined}
      sandbox="allow-popups allow-popups-to-escape-sandbox"
      onLoad={() => void checkPacket(openPage.id)} />
  );
  return (
    <section className={signing ? css.finalReview : `${css.inspectorSection} ${css.finalReview}`} id={`review-${id}`} aria-label={signing ? "Contract signing" : "Final hiring review"}
      data-inline={besideDecision ? "" : undefined}>
      {!signing && !hideHeading && <h3 className={css.inspectorHeading}>Final hiring review</h3>}
      {!review && !error && (autoLoad || busy
        ? <p className={css.inspectorMeta} role="status">Loading the review…</p>
        : <button type="button" className={css.secondary} onClick={() => void act()}>{signing ? "Check contract signing" : "Open final review"}</button>)}
      {(awaitingSignOff || stale) && packet && <>
        {pauseReason && <p id={pauseReason} className={css.reviewStatus}>{pausedStatus}</p>}
        <p id={ready ? undefined : instruction} className={ready ? css.reviewStatus : css.inspectorMeta} role="status">{stale ? (review?.packetValid === null ? "Could not check the packet just now." : "Evidence changed. Ask Kevin for a new packet.")
          : ready ? "Ready for sign-off." : sharedBlock ?? (viewed && error?.retry ? "Retry the review check to unlock sign-off." : "Read the packet to unlock sign-off.")}</p>
        {ready && <p id={instruction} className="sr-only">Approve, or write a note and reject.</p>}
        {stale && <button type="button" ref={retryButton} className={`${css.primary} mt-2.5 min-h-11 min-w-11`} disabled={!!busy} onClick={() => void act()}>Check again</button>}
      </>}
      {!signing && review && packet && (
        <div className={`${css.decisionActions} ${css.packetActions}`}>
          {besideDecision && openPage ? null : review.access.gift ? (
            <button type="button" className={viewed || closed ? css.secondary : css.primary} ref={readButton} disabled={stale && awaitingSignOff} aria-expanded={!!openPage} aria-disabled={!!busy || !!openPage || (stale && awaitingSignOff)}
              aria-controls={openPage ? `${controlId}-packet` : undefined}
              onClick={() => { if (!busy && !openPage) void readPacket(packet.id); }}>{viewed ? "Read packet again" : "Read review packet"}</button>
          ) : <a className={css.secondary} href={`${url}?file=html`} target="_blank" rel="noreferrer">Read review packet</a>}
          {busy === "packet" && <p role="status" className={css.inspectorMeta}>Opening packet…</p>}
          {error?.packetLoad && <p role="alert" className={css.errorText}>{error.text}</p>}
          {openPage && !besideDecision && (phone ? (
            <dialog ref={packetDialog} id={`${controlId}-packet`} aria-label={packetTitle}
              className="fixed inset-0 m-0 h-dvh max-h-none w-full max-w-none grid-rows-[auto_minmax(0,1fr)] overflow-hidden border-0 bg-white p-0 open:grid"
              onCancel={(event) => { event.preventDefault(); closePacket(); }}>
              <div className="flex justify-end border-b px-3 py-2">
                <button type="button" ref={closeButton} className={`${css.secondary} min-h-11 min-w-11 shrink-0`} onClick={closePacket}>Close packet</button>
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
            <button type="button" className={css.secondary} disabled aria-disabled="true" aria-label="Download files (packet and attachments)" aria-describedby={instruction}>Download files</button>
          ) : <a className={css.secondary} href={`${url}?file=zip`} aria-label="Download files (packet and attachments)">Download files</a>}
        </div>
      )}
      {!signing && review?.access.hr && !closed && (
        <>
          <label className={css.fieldLabel}>Behavioral assessment from the pre-screen call
            <textarea className={css.textarea} rows={5} maxLength={10000} value={behavioral} onChange={(event) => { setBehavioral(event.target.value); setDraftHtml(undefined); }} />
          </label>
          <label className={css.fieldLabel}>Offer letter
            <select className={css.textarea} value={offerType} onChange={(event) => { setOfferType(event.target.value as OfferType | ""); setDraftHtml(undefined); }}>
              <option value="">Select a standard letter</option>
              {Object.entries(OFFER_LETTERS).map(([type, { label }]) => <option key={type} value={type}>{label}</option>)}
            </select>
          </label>
          <p className={css.inspectorMeta}>Preview the packet to read the letter. Scheduling adds the contract booking link after approval.</p>
          <div className={`${css.decisionActions} mt-2`}>
            <button type="button" className={css.secondary} disabled={!!busy || draftDisabled} onClick={() => void previewDraft()}>Preview packet</button>
            <button type="button" className={awaitingSignOff && packet && !stale ? css.secondary : css.primary} disabled={!!busy || draftDisabled}
              onClick={() => { if (offerType) void act({ action: "submit", behavioral, offerType }); }}>Send to Gift</button>
          </div>
          {draftHtml && (
            <div className={css.packetPanel}>
              <button type="button" className={css.secondary} onClick={() => setDraftHtml(undefined)}>Close preview</button>
              <iframe title="Packet preview" srcDoc={draftHtml} sandbox="allow-popups allow-popups-to-escape-sandbox" />
            </div>
          )}
        </>
      )}
      {awaitingSignOff && (packet ? (
        <>
          {/* What Gift approves, beside the button: the letter's terms (Sol review, rounds 11–12). An older packet's letter is only in the packet. */}
          {packet.offerType && <p className={css.inspectorMeta}><strong>Proposed offer:</strong> {OFFER_LETTERS[packet.offerType].terms}</p>}
          <div className={css.signOffActions}>
            <div>
              <button type="button" ref={approveButton} className={css.primary} disabled={signOffDisabled || !!approveBlock} aria-describedby={[pauseReason, instruction, approveReason].filter(Boolean).join(" ")} onClick={() => {
                if (window.confirm("Approve this offer letter and send it to the candidate?"))
                  void act({ action: "sign", packetId: packet.id, decision: "hire", reason });
              }}>Approve and send offer</button>
              {approveReason && <p id={approveReason} className={css.inspectorMeta}>{approveBlock}</p>}
            </div>
            {/* The note belongs to Reject, so it sits with it, below Approve. */}
            <div className={css.rejectGroup}>
              <label className={css.fieldLabel}>
                <span id={rejectHint}>Rejection note (5+ characters)</span>
                <textarea className={css.textarea} rows={2} maxLength={2000} value={reason} readOnly={busy === "sign"} disabled={!viewed}
                  onChange={(event) => setReason(event.target.value)} />
              </label>
              <button type="button" className={css.secondary} disabled={signOffDisabled || reason.trim().length < 5 || !!rejectBlock} aria-describedby={[pauseReason, instruction, rejectReason, rejectHint].filter(Boolean).join(" ")} onClick={() => {
                if (window.confirm("Reject this application and inform the candidate?"))
                  void act({ action: "sign", packetId: packet.id, decision: "reject", reason });
              }}>Reject and inform candidate</button>
              {rejectReason && <p id={rejectReason} className={css.inspectorMeta}>{rejectBlock}</p>}
            </div>
          </div>
          {busy === "sign" && <p role="status" className={css.inspectorMeta}>Saving sign-off…</p>}
        </>
      ) : <p>Waiting for the packet. <button type="button" className={css.secondary} disabled={!!busy} onClick={() => void act()}>Check again</button></p>)}
      <p ref={outcome} role="status" tabIndex={-1}>{closed && (stage === "hired" ? (review?.appointment
        ? `Contract signing booked for ${new Date(review.appointment).toLocaleString("en-GB", { timeZone: "Asia/Bangkok", dateStyle: "medium", timeStyle: "short" })} (Bangkok).`
        : packet || signedStage ? (signedStage ? "Offer approved. The offer email is queued." : "Offer approved.") : "There is no contract booking on record.")
        : stage === "rejected" ? (signedStage ? "Application rejected. The email is queued." : "Application rejected.") : "Application stopped.")}</p>
      {saved && !signedStage && <p role="status">Saved.</p>}
      {error && !error.packetLoad && <div role="alert" className={css.errorText}>
        <p>{error.text}</p>
        {error.retry && <button type="button" className={css.secondary} disabled={!!busy} onClick={() => void act()}>Retry</button>}
      </div>}
      {/* After the decision in the reading and tab order; CSS puts it in the right column (critic review, round 13). */}
      {besideDecision && openPage && <div className={css.inlinePacket} id={`${controlId}-packet`}>{packetFrame}</div>}
    </section>
  );
}
