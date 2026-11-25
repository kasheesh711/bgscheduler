"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useEffect, useId, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { formatInTimeZone } from "date-fns-tz";
import { checkRubric, rubricNeedsCheck } from "@/lib/hiring/marking-sheet";
import { isDecided, localDate, shiftDate, ZONE, type Subject } from "@/lib/hiring/model";
import { buildRunSheet, headName, headVisits, pastVisits, upcoming, type RunSheetRow } from "@/lib/hiring/run-sheet";
import { dayTitle, headKeys, nickname, openHeadDecisions, weekCalls, type HeadDecisionRow } from "@/lib/hiring/role-views";
import { universityName } from "@/lib/hiring/seek-view";
import { offerAge, offerNext } from "@/lib/hiring/offer-rows";
import { OFFER_LETTERS, type OfferType } from "@/lib/hiring/offer-letters";
import { ContractTemplates, PrintContract, SignedContract, useContractTemplates } from "./contract-templates";
import { FinalReview, reviewBlocks } from "./final-review";
import { ResultUpload } from "./assessment-screen";
import { callCommand, callState, callSubjects, triesText } from "./calls-screen";
import { PhoneLink, ResumePeek, SeekApplicationReview } from "./candidate-inspector";
import type { Command, HiringCandidate, HiringData } from "./dashboard";
import r from "./role-screens.module.css";

// ─── The simple screens: one job each, big targets, no tables. They read the same payload as the full dashboard. ───

const shortDay = (date: string) =>
  new Date(`${date}T12:00:00Z`).toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" });

function Section({ title, count, children, controls, id, hideHeading }: { title: string; count?: number; children: ReactNode; controls?: ReactNode; id?: string; hideHeading?: boolean }) {
  return (
    <section className={r.section} id={id} tabIndex={id ? -1 : undefined}>
      <div className={hideHeading ? "sr-only" : r.sectionHead}>
        <h2 className={r.heading}>
          {title}
          {count !== undefined && <span className={r.count}>{count}</span>}
        </h2>
        {controls}
      </div>
      {children}
    </section>
  );
}

// ─── HR ───

function CallNotes({ candidate, command, busy, readOnly }: { candidate: HiringCandidate; command: Command; busy: boolean; readOnly: boolean }) {
  const notes = candidate.callReview?.notes;
  const [draft, setDraft] = useState<{ text: string; expected: string | null } | null>(null);
  const [status, setStatus] = useState<"saved" | "failed" | null>(null);
  return (
    <form className={r.notes} onSubmit={async (event) => {
      event.preventDefault();
      if (!draft || busy || readOnly) return;
      if (await command({ action: "call_notes", id: candidate.id, ...draft })) {
        setDraft(null);
        setStatus("saved");
      } else {
        setStatus("failed");
      }
    }}>
      <label>
        Call notes
        <textarea rows={7} maxLength={4000} value={draft?.text ?? notes?.text ?? ""} readOnly={readOnly || busy}
          onChange={(event) => {
            setStatus(null);
            setDraft({ text: event.target.value, expected: draft ? draft.expected : notes?.at ?? null });
          }} />
      </label>
      {!readOnly && <button type="submit" className={r.big} disabled={!draft || busy}>Save notes</button>}
      {status === "saved" && <p role="status">Notes saved.</p>}
      {status === "failed" && <p role="alert">Could not save notes. Your draft is still here.</p>}
    </form>
  );
}

export function TodayCalls({ data, command, busy, readOnly = false, children }: { data: HiringData; command: Command; busy: boolean; readOnly?: boolean; children?: ReactNode }) {
  const [today] = useState(() => localDate(new Date()));
  const [date, setDate] = useState(today);
  const dateField = useRef<HTMLInputElement>(null);
  const week = weekCalls(data.calls, data.candidates, new Date(`${date}T12:00:00+07:00`));
  const [open, setOpen] = useState<string | null>(null);
  const byId = new Map(data.candidates.map((candidate) => [candidate.id, candidate]));
  const rows = [
    ...data.calls.map((call) => ({ ...call, missed: false })),
    ...(data.missedCalls ?? []).map((call) => ({ ...call, missed: true })),
  ].filter((call) => localDate(new Date(call.start)) === date)
    .sort((a, b) => new Date(a.start).getTime() - new Date(b.start).getTime());
  return (
    <div className={r.callWorkspace}>
      <Section title={date === today ? "Today’s calls" : `Calls for ${shortDay(date)}`} count={rows.length} controls={
        <div className={r.dateTools}>
          <label className={r.date}>Date (Bangkok) <input ref={dateField} type="date" value={date} onChange={(event) => {
            if (event.target.value) setDate(event.target.value);
          }} /></label>
          {date !== today && <button type="button" className={r.ghost} onClick={() => setDate(today)}>Today</button>}
        </div>
      }>
        {!rows.length && <p className={r.quiet}>No calls for this date.</p>}
        <div className={r.agenda}>
          {rows.map((call) => {
            const candidate = byId.get(call.candidateId);
            const key = `${call.candidateId}:${call.start}`;
            const active = candidate && !call.missed && data.callOrder.includes(candidate.id);
            return (
              <article className={r.card} key={key}>
                <p className={r.time}>{formatInTimeZone(new Date(call.start), ZONE, "HH:mm")}</p>
                <div className={r.cardMain}>
                  <p className={r.name}>{candidate?.name ?? "Candidate record unavailable"}</p>
                  {candidate && <p className={r.meta}>{callSubjects(candidate, data.config.subjectPriority).main}</p>}
                  {candidate && (readOnly ? <p>{candidate.phone}</p> : <PhoneLink phone={candidate.phone} large />)}
                  {call.missed && <p className={r.meta}>No answer</p>}
                </div>
                {candidate && (
                  <div className={r.actions}>
                    <SeekApplicationReview candidate={candidate} config={data.config} />
                    <button type="button" className={r.ghost} aria-expanded={open === key}
                      onClick={() => setOpen(open === key ? null : key)}>Call notes</button>
                    {active && (["good", "no_answer", "bad"] as const).map((result, index) => (
                      <button key={result} type="button" className={r.big} data-tone={result === "good" ? "hire" : undefined} disabled={busy || readOnly} onClick={() => {
                        if (result === "bad" && !window.confirm(`Stop ${candidate.name}?`)) return;
                        void command(callCommand(candidate, result));
                      }}>{["Good call", "No answer", "Bad call"][index]}</button>
                    ))}
                  </div>
                )}
                {candidate && open === key && (
                  <CallNotes candidate={candidate} command={command} busy={busy} readOnly={readOnly} />
                )}
              </article>
            );
          })}
        </div>
      </Section>
      <aside className={r.callContext}>
        <Section title="Booked calls by day">
          <div className={r.week}>
            {week.map((day) => (
              <button key={day.date} type="button" className={r.day} aria-pressed={day.date === date}
                aria-label={`${shortDay(day.date)}, ${day.calls.length} booked calls`}
                onClick={() => {
                  setDate(day.date);
                  dateField.current?.scrollIntoView({ block: "nearest" });
                }}>
                <span>{shortDay(day.date)}</span>
                <span className={r.count}>{day.calls.length}</span>
              </button>
            ))}
          </div>
        </Section>
        {children}
      </aside>
    </div>
  );
}

function ReviewRecommendations({ data, onOpenResults, readOnly, reload, linkedReview }: {
  data: HiringData;
  onOpenResults: (id: string | null) => void;
  readOnly?: boolean;
  reload?: () => Promise<void>;
  linkedReview?: string;
}) {
  const byId = new Map(data.candidates.map((candidate) => [candidate.id, candidate]));
  const [signed, setSigned] = useState<string[]>([]);
  const decisions = openHeadDecisions(data.headDecisions, data.decisions.filter((decision) => !signed.includes(decision.candidateId)))
    .filter(({ candidateId }) => !reload || (candidateId && (
      signed.includes(candidateId) || !["hired", "rejected", "stopped"].includes(byId.get(candidateId)?.stage ?? "")
    )));
  const linkedHeading = useRef<HTMLHeadingElement>(null);
  const linked = decisions.find((decision) => decision.candidateId === linkedReview);
  const linkedId = linked?.candidateId;
  useEffect(() => {
    if (!linkedId) return;
    linkedHeading.current?.scrollIntoView({ block: "start" });
    linkedHeading.current?.focus({ preventScroll: true });
  }, [linkedId]);
  if (!decisions.length && !reload) return null;
  const waiting = decisions.filter(({ candidateId }) => candidateId && !signed.includes(candidateId)).length;
  const giftOnly = !!data.reviewAccess?.gift && !data.reviewAccess.hr;
  return (
    <Section title="Tutor recommendations" count={waiting} hideHeading={!!reload && giftOnly}>
      {!waiting && <p className={r.quiet}>No candidates are waiting for final review.</p>}
      <div className={r.cards}>
        {(linked && reload ? [linked, ...decisions.filter((d) => d !== linked)] : decisions).map((d) => (
          <article key={d.candidateId} className={reload ? `${r.card} ${r.reviewCard}` : r.card}>
            <div className={r.cardMain}>
              {reload || d === linked ? (
                <h3 className={r.name} ref={d === linked ? linkedHeading : undefined} tabIndex={d === linked ? -1 : undefined}>
                  {byId.get(d.candidateId!)?.name ?? "Candidate"}
                </h3>
              ) : <p className={r.name}>{byId.get(d.candidateId!)?.name ?? "Candidate"}</p>}
              <p className={r.meta}>
                <span className={r.tag} data-tone={d.decision}>
                  {d.decision === "hire" ? "Yes" : "No"}
                </span>
                {d.head} · {d.reason || "No reason given"}
              </p>
              {d.draftProblem && <p className={r.warn}>No email draft yet: {d.draftProblem}</p>}
            </div>
            <div className={reload && d.decision === "hire" ? r.reviewActions : r.actions}>
              {!readOnly && d.decision === "hire" && d.candidateId && (data.reviewAccess?.hr || data.reviewAccess?.gift)
                ? <FinalReview id={d.candidateId} autoLoad={giftOnly} hideHeading={!!reload && giftOnly}
                    {...reviewBlocks(data.writeGate, data.config, d.candidateId)} onChanged={reload && (async (didSign) => {
                      if (didSign && d.candidateId) {
                        const candidateId = d.candidateId;
                        setSigned((current) => [...current, candidateId]);
                      }
                      await reload();
                    })} />
                : <button type="button" className={r.big} disabled={readOnly} onClick={() => onOpenResults(d.candidateId)}>Open assessment</button>}
            </div>
          </article>
        ))}
      </div>
    </Section>
  );
}

export function HiringReviewScreen({ data, offers, onOpenResults, reload, linkedReview, onFinalReview, onOpenEmailLog }: {
  data: HiringData;
  offers: boolean;
  onOpenResults: (id: string | null) => void;
  reload: () => Promise<void>;
  linkedReview?: string;
  onFinalReview: () => void;
  onOpenEmailLog: (key: string | null) => void;
}) {
  if (!offers) return (
    <div className={r.screen} data-heads-review="">
      <ReviewRecommendations data={data} onOpenResults={onOpenResults} reload={reload} linkedReview={linkedReview} />
    </div>
  );

  return <OfferList data={data} reload={reload} onFinalReview={onFinalReview} onOpenEmailLog={onOpenEmailLog} />;
}

const OFFER_EMAIL = {
  pending: "Queued", processing: "Queued", sent: "Sent", failed: "Email failed",
  uncertain: "Delivery unconfirmed", cancelled: "Cancelled",
};

function OfferList({ data, reload, onFinalReview, onOpenEmailLog }: {
  data: HiringData;
  reload: () => Promise<void>;
  onFinalReview: () => void;
  onOpenEmailLog: (key: string | null) => void;
}) {
  const demo = useSearchParams().get("demo") === "1";
  const [files, setFiles] = useState<Record<string, string | null>>({});
  const [templatesOpen, setTemplatesOpen] = useState(false);
  const [missingPdfs, setMissingPdfs] = useState<Partial<Record<OfferType, { uploadedAt: string; decisionId: string }>>>({});
  const addTemplateFocus = useRef<string | null>(null);
  const [templateRetry, setTemplateRetry] = useState<{ decisionId?: string; status: "loading" | "loaded" | "failed" }>();
  const [refreshing, setRefreshing] = useState(false);
  const [refreshError, setRefreshError] = useState(false);
  useMinute();
  const now = new Date();
  const today = localDate(now);
  const tomorrow = shiftDate(today, 1);
  const rows = (data.offers ?? []).map((row) => {
    const uploadedAt = !row.uploadedAt && files[row.candidateId];
    const offer = uploadedAt ? { ...row, uploadedAt, unknown: { ...row.unknown, pdf: false } } : row;
    return { offer, next: offerNext(offer, now) };
  }).sort((a, b) => a.next.rank - b.next.rank ||
    (a.offer.booking?.start ?? a.offer.sentAt ?? "").localeCompare(b.offer.booking?.start ?? b.offer.sentAt ?? ""));
  const firstTemplateRow = rows.find(({ offer, next }) => offer.offerType && next.action === "print");
  const library = useContractTemplates(templatesOpen || !!firstTemplateRow);
  const retryRow = rows.find(({ offer, next }) => offer.offerType && next.action === "print"
    && offer.decisionId === templateRetry?.decisionId);
  const retrying = templateRetry?.status === "loading";
  const showPanelError = templatesOpen && (!retryRow || templateRetry?.status === "loaded");
  const failureRowId = showPanelError ? undefined : (retryRow ?? firstTemplateRow)?.offer.decisionId;

  async function retryTemplates(decisionId?: string) {
    setTemplateRetry({ decisionId, status: "loading" });
    const loaded = await library.reload();
    setTemplateRetry({ decisionId, status: loaded ? "loaded" : "failed" });
    return loaded;
  }

  function openTemplates(type: OfferType) {
    setTemplatesOpen(true);
    requestAnimationFrame(() => document.getElementById(`contract-template-${type}`)?.focus());
  }

  return (
    <div className={`${r.screen} ${r.offers}`}>
      <section id="approved-offers" aria-label="Approved offers" tabIndex={-1}>
        {!rows.length ? (
          <>
            <p>No approved offers.</p>
            <Link href="?view=review" className={r.offerControl} onClick={(event) => {
              if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
              event.preventDefault();
              onFinalReview();
            }}>Final review</Link>
          </>
        ) : (
          <table className={r.offerTable} role="table" aria-label="Offer status">
            <thead className={r.offerHead} role="rowgroup"><tr role="row">
              {["Tutor", "Offer email", "Signing", "Signed PDF", "Onboarding form", "Next"].map((label) => (
                <th key={label} role="columnheader" scope="col">{label}</th>
              ))}
            </tr></thead>
            <tbody role="rowgroup">
              {rows.map(({ offer, next }) => {
                const age = offerAge(offer.sentAt, now);
                const sentAge = offer.emailStatus === "sent" && !offer.booking && !offer.unknown.booking && age !== null
                  ? age === 0 ? "Sent today" : `Sent ${age} day${age === 1 ? "" : "s"} ago`
                  : null;
                const day = offer.booking ? localDate(new Date(offer.booking.start)) : null;
                const visitEnded = offer.booking && Date.parse(offer.booking.end) <= now.getTime();
                const signing = offer.booking
                  ? `${day === today ? "Today" : day === tomorrow ? "Tomorrow" : formatInTimeZone(offer.booking.start, ZONE, "d MMM")} ${formatInTimeZone(offer.booking.start, ZONE, "HH:mm")}`
                  : null;
                const type = offer.offerType;
                const pdf = library.templates?.find((file) => file.type === type && file.format === "pdf");
                const missingPdf = pdf && missingPdfs[pdf.type];
                const pdfMissing = !!pdf && missingPdf?.uploadedAt === pdf.uploadedAt;
                const word = library.templates?.some((file) => file.type === type && file.format === "docx");
                const rowRetry = retryRow?.offer.decisionId === offer.decisionId ? templateRetry?.status : undefined;
                const retryNote = rowRetry === "loading" ? "Loading templates…"
                  : rowRetry === "loaded" && library.templates ? "Templates loaded."
                  : library.templates === null && !retrying && failureRowId === offer.decisionId ? "Could not load templates."
                  : null;
                return (
                  <tr key={offer.decisionId} className={r.offerRow} role="row" data-state={next.state} data-sent-age={sentAge ? "" : undefined}>
                    <th className={r.offerTutor} role="rowheader" scope="row"
                      aria-label={offer.subject ? `${offer.name}, ${offer.subject}` : undefined}>
                      <span>{offer.name}</span>
                      {offer.subject && <span className={r.offerNote}>{offer.subject}</span>}
                    </th>
                    <td className={r.offerEmail} role="cell">
                      <span className={r.offerCaption} aria-hidden="true">Email </span>
                      <span data-tone={offer.emailStatus ?? "unknown"}>{sentAge ?? (offer.emailStatus ? OFFER_EMAIL[offer.emailStatus] : "Unknown")}</span>
                    </td>
                    <td className={r.offerSigning} role="cell"
                      aria-label={signing && visitEnded && !offer.uploadedAt ? `${signing}, visit ended` : undefined}>
                      {signing ? (
                        <><time dateTime={offer.booking?.start}>{signing}</time>
                          {visitEnded && !offer.uploadedAt && <span className={r.offerNote}>Visit ended</span>}</>
                      ) : offer.unknown.booking ? "Signing unknown" : "Unbooked"}
                    </td>
                    <td className={r.offerPdf} role="cell">
                      <span className={r.offerCaption} aria-hidden="true">PDF </span>
                      {offer.uploadedAt ? <time dateTime={offer.uploadedAt}>Filed {formatInTimeZone(offer.uploadedAt, ZONE, "d MMM")}</time>
                        : files[offer.candidateId] === null ? "Unconfirmed" : offer.unknown.pdf ? "Unknown" : "Due"}
                    </td>
                    <td className={r.offerForm} role="cell">
                      <span className={r.offerCaption} aria-hidden="true">Onboarding form </span>
                      {offer.submittedAt ? <time dateTime={offer.submittedAt}>Received {formatInTimeZone(offer.submittedAt, ZONE, "d MMM")}</time>
                        : offer.unknown.form ? "Unknown" : "Pending"}
                    </td>
                    <SignedContract candidateId={offer.candidateId} name={offer.name} canUpload={next.action === "upload"}
                      templateMissing={next.action === "print" && pdfMissing && missingPdf?.decisionId === offer.decisionId}
                      templateRetryNote={retryNote}
                      onUnverified={() => setFiles((saved) => ({ ...saved, [offer.candidateId]: null }))}
                      onVerified={async (date) => {
                        setFiles((saved) => ({ ...saved, [offer.candidateId]: date }));
                        await reload().catch(() => { /* Keep the verified date if the list cannot reload. */ });
                      }}>
                        {next.action === "print" ? (
                          !type ? <span>Ask Kevin for the contract type.</span>
                            : pdf && !pdfMissing ? <PrintContract type={type} onMissing={() => {
                              addTemplateFocus.current = offer.decisionId;
                              setMissingPdfs((missing) => ({ ...missing, [type]: { uploadedAt: pdf.uploadedAt, decisionId: offer.decisionId } }));
                            }} />
                            : word && !pdfMissing ? <a className={r.offerControl} href={`/api/hiring/contracts?type=${type}&format=docx`}>Download Word</a>
                            : library.templates === undefined ? <span role="status">Checking template…</span>
                            : library.templates === null ? <button type="button" className={r.offerControl}
                              aria-disabled={retrying || undefined} onClick={async (event) => {
                                if (retrying) return;
                                const button = event.currentTarget;
                                const cell = button.parentElement;
                                button.focus();
                                const loaded = await retryTemplates(offer.decisionId);
                                if (loaded && (document.activeElement === button || document.activeElement === document.body)) {
                                  requestAnimationFrame(() => {
                                    if (document.activeElement === document.body) cell?.querySelector<HTMLElement>("button, a")?.focus();
                                  });
                                }
                              }}>Retry templates</button>
                            : <><span className={r.offerNote}>{`No ${OFFER_LETTERS[type].label.toLowerCase()}${pdfMissing && word ? " PDF" : ""} template.`}</span>
                              <button type="button" className={r.offerControl} ref={(button) => {
                                if (button && addTemplateFocus.current === offer.decisionId) {
                                  addTemplateFocus.current = null;
                                  button.focus();
                                }
                              }} onClick={() => openTemplates(type)}>Add template</button></>
                        ) : next.state === "failed" ? (
                          <Link href={demo ? "?view=setup&demo=1#messages" : "?view=setup#messages"} className={r.offerControl} onClick={(event) => {
                            if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
                            event.preventDefault();
                            onOpenEmailLog(offer.outboxKey ?? null);
                          }}>Open email log</Link>
                        ) : next.action === "onboarding" ? (
                          // The onboarding page checks access itself; there is no HR team now (Kevin, 24 Nov 2026).
                          <Link href="/hiring/onboarding" className={r.offerControl} data-offer-next={offer.candidateId}>Onboarding</Link>
                        ) : next.action === "refresh" ? (
                          <button type="button" className={r.offerControl} data-offer-next={offer.candidateId}
                            aria-disabled={refreshing || undefined} onClick={async () => {
                            if (refreshing) return;
                            setRefreshing(true);
                            setRefreshError(false);
                            try {
                              await reload();
                            } catch {
                              setRefreshError(true);
                            } finally {
                              setRefreshing(false);
                            }
                          }}>{refreshing ? "Checking…" : next.label}</button>
                        ) : <span className={next.state === "chase" ? r.offerTag : undefined}
                          data-offer-next={next.state === "awaitForm" ? offer.candidateId : undefined}
                          tabIndex={next.state === "awaitForm" ? -1 : undefined}>{next.label}</span>}
                    </SignedContract>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
        {refreshError && <p className={r.offerNote} role="alert">Could not check offers. Try again.</p>}
      </section>
      <details className={r.offerTemplates} open={templatesOpen} onToggle={(event) => {
        const open = event.currentTarget.open;
        setTemplatesOpen(open);
        if (open) setTemplateRetry((retry) => retry?.status === "failed" ? undefined : retry);
      }}>
        <summary className={r.offerControl}>Templates</summary>
        {templatesOpen && <ContractTemplates reload={library.reload} showLoadError={showPanelError}
          retrying={retrying} onRetry={() => void retryTemplates()} templates={library.templates?.filter(
          (file) => file.format !== "pdf" || missingPdfs[file.type]?.uploadedAt !== file.uploadedAt,
        ) ?? library.templates} />}
      </details>
    </div>
  );
}

export function HrScreen({ data, command, busy, onOpenResults, readOnly = false, linkedReview }: { data: HiringData; command: Command; busy: boolean; onOpenResults: () => void; readOnly?: boolean; linkedReview?: string }) {
  // A new clock for each data load keeps the booking link states current.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const now = useMemo(() => new Date(), [data]);
  const byId = useMemo(() => new Map(data.candidates.map((c) => [c.id, c])), [data.candidates]);
  const rows = data.callOrder.flatMap((id) => byId.get(id) ?? []);
  const act = (c: HiringCandidate, result: "good" | "no_answer" | "bad") => {
    if (result === "bad" && !window.confirm(`Stop ${c.name}? Nothing is sent to them, and they leave every queue.`)) return;
    void command(callCommand(c, result));
  };
  // With HR calls off and no call on record, this screen is only the final review list (Kevin, 24 Nov 2026).
  if (data.config.callThreshold === null && !data.calls.length && !rows.length)
    return (
      <div className={`${r.screen} ${r.hrScreen}`}>
        <ReviewRecommendations data={data} onOpenResults={onOpenResults} readOnly={readOnly} linkedReview={linkedReview} />
      </div>
    );
  return (
    <div className={`${r.screen} ${r.hrScreen}`}>
      <TodayCalls data={data} command={command} busy={busy} readOnly={readOnly}>
        <ReviewRecommendations data={data} onOpenResults={onOpenResults} readOnly={readOnly} linkedReview={linkedReview} />
      </TodayCalls>

      <Section title="To call" count={rows.length}>
        {!rows.length && <p className={r.quiet}>Nobody is waiting for a call.</p>}
        <div className={`${r.cards} ${r.queue}`}>
          {rows.map((c, index) => {
            const subjects = callSubjects(c, data.config.subjectPriority);
            const state = callState(c.id, data.calls, data.inviteOutbox, now);
            return (
              <article key={c.id} className={r.card}>
                <div className={r.cardMain}>
                  <p className={r.name}>
                    <span className={r.order}>{index + 1}</span>
                    {c.name}
                  </p>
                  <p className={r.meta}>
                    {subjects.main}
                    {universityName(c) ? ` · ${universityName(c)}` : ""}
                  </p>
                  <p className={r.meta}>
                    <span className={r.tag} data-tone={state.startsWith("Booked") ? "hire" : undefined}>
                      {state}
                    </span>
                    {triesText(c.callReview)}
                  </p>
                  {readOnly ? <p>{c.phone}</p> : <PhoneLink phone={c.phone} large />}
                </div>
                <div className={r.actions}>
                  <SeekApplicationReview candidate={c} config={data.config} />
                  <button type="button" className={r.big} data-tone="hire" disabled={busy || readOnly} onClick={() => act(c, "good")}>
                    Good call
                  </button>
                  <button type="button" className={r.big} disabled={busy || readOnly} onClick={() => act(c, "no_answer")}>
                    No answer
                  </button>
                  <button type="button" className={r.big} data-tone="reject" disabled={busy || readOnly} onClick={() => act(c, "bad")}>
                    Bad call
                  </button>
                </div>
              </article>
            );
          })}
        </div>
      </Section>
    </div>
  );
}

// ─── Shared visit data ───

function useMinute() {
  const [minute, setMinute] = useState(() => Math.floor(Date.now() / 60000));
  useEffect(() => {
    // On the minute boundary, then every minute, so "Mock now" shows when the mock starts.
    const tick = () => setMinute(Math.floor(Date.now() / 60000));
    let timer = window.setTimeout(function next() {
      tick();
      timer = window.setTimeout(next, 60000 - (Date.now() % 60000));
    }, 60000 - (Date.now() % 60000));
    return () => window.clearTimeout(timer);
  }, []);
  return minute;
}

function useVisits(data: HiringData, minute = 0) {
  return useMemo(() => {
    // `minute` only makes the list count again each minute, so a mock that starts shows as "Mock now".
    void minute;
    const now = new Date();
    const rows = buildRunSheet({ ...data, now });
    const today = localDate(now);
    return { rows, now, today, coming: upcoming(rows, today), recent: pastVisits(rows, today) };
  }, [data, minute]);
}
const clock = (row: Pick<RunSheetRow, "paperStart" | "mockStart">) => row.paperStart ?? row.mockStart ?? "";
const parts = (row: RunSheetRow) => [row.paperStart && `Paper ${row.paperStart}`, row.mockStart && `Mock ${row.mockStart}`].filter(Boolean).join(" · ");
const byDay = (rows: RunSheetRow[]) => [...new Set(rows.map((row) => row.date))].map((date) => ({ date, rows: rows.filter((row) => row.date === date) }));

// ─── Admin ───

function AdminCard({ row, data, reload, readOnly, onOpenResults }: { row: RunSheetRow; data: HiringData; reload: () => Promise<void>; readOnly: boolean; onOpenResults?: (visitId: string) => void }) {
  // A past result from the tracker is not this visit's paper.
  const paper = data.papers.find((p) => p.candidateId === row.candidateId && p.subject === row.subject && p.source !== "tracker");
  return (
    <article className={r.card}>
      <p className={r.time}>{clock(row)}</p>
      <div className={r.cardMain}>
        <p className={r.name}>{row.candidateName}</p>
        <p className={r.meta}>
          {row.subject ?? "Subject not recorded"} · {parts(row)}
        </p>
        <p className={r.meta}>Head: {row.hod?.name ?? "not set"}</p>
        {[row.hodReason, row.paperReason, ...row.issues].filter(Boolean).map((text) => (
          <p key={text} className={r.warn}>
            {text}. Tell Kevin.
          </p>
        ))}
      </div>
      <div className={r.actions}>
        {row.paper && (
          <a className={r.big} href={`/api/hiring/file/${encodeURIComponent(row.paper.id)}`} target="_blank" rel="noopener noreferrer">
            Print the paper
          </a>
        )}
        {row.subject && row.paperStart && !paper && !readOnly && (
          <ResultUpload kind="paper" candidateId={row.candidateId} subject={row.subject as Subject} reload={reload} label="Upload the completed paper" />
        )}
        {paper && !readOnly && onOpenResults && (
          <button type="button" className={r.big} onClick={() => onOpenResults(row.visitId)}>Review paper grade</button>
        )}
      </div>
    </article>
  );
}

export function AdminScreen({ data, reload, readOnly = false, onOpenResults }: { data: HiringData; reload: () => Promise<void>; readOnly?: boolean; onOpenResults?: (visitId: string) => void }) {
  const { today, coming, recent } = useVisits(data);
  const waiting = recent.filter(
    (row) => row.subject && row.paperStart && data.candidates.some((candidate) => candidate.id === row.candidateId && candidate.stage === "onsite_booked"),
  );
  return (
    <div className={`${r.screen} ${r.uploads}`}>
      {waiting.length > 0 && (
        <Section title="Papers to upload or review" count={waiting.length}>
          <div className={r.cards}>
            {waiting.map((row) => (
              <AdminCard key={`${row.visitId}:${row.date}`} row={{ ...row, paper: null }} data={data} reload={reload} readOnly={readOnly} onOpenResults={onOpenResults} />
            ))}
          </div>
        </Section>
      )}
      {!coming.length && <p className={r.quiet}>No candidate visit is booked from today.</p>}
      {byDay(coming).map((day) => (
        <Section key={day.date} title={dayTitle(day.date, today)} count={day.rows.length}>
          <div className={r.cards}>
            {day.rows.map((row) => (
              <AdminCard key={`${row.visitId}:${row.date}`} row={row} data={data} reload={reload} readOnly={readOnly} onOpenResults={onOpenResults} />
            ))}
          </div>
        </Section>
      ))}
    </div>
  );
}

// ─── Heads ───
// Kevin, 24 Nov 2026: a head has two jobs, re-marking a near-miss paper and scoring a mock. Both are listed on the
// left and the chosen one is already open on the right, so nothing needs a click to open. A head sees only their list.

const HEAD_KEY = "hiring-head";
/** Wide enough for the list beside an open brief. Below this, a tap opens the brief or the paper check as its own page. */
const SPLIT = "(min-width: 1024px)";
function subscribeWide(change: () => void) {
  const query = window.matchMedia(SPLIT);
  query.addEventListener("change", change);
  return () => query.removeEventListener("change", change);
}
const isWide = () => window.matchMedia(SPLIT).matches;
const useWide = () => useSyncExternalStore(subscribeWide, isWide, () => false);

function headVisit(row: Pick<RunSheetRow, "visitId" | "candidateId" | "date" | "mockStart" | "paperStart" | "subject">,
  data: HiringData, now: Date, mock?: HiringData["bookings"][number]) {
  const confirmed = mock?.status === "confirmed" ? mock : undefined;
  const status = mock?.status === "cancelled" ? "Cancelled" : mock?.status === "no_show" ? "No-show" : undefined;
  const candidate = data.candidates.find((c) => c.id === row.candidateId);
  const active = !!candidate && candidate.stage !== "stopped" && !isDecided(candidate.stage);
  const path = confirmed ? data.briefPaths[confirmed.id] : undefined;
  const ended = !!mock && (!!status || new Date(mock.endTime) <= now);
  const decision = confirmed && data.headDecisions.find((d) => d.bookingId === confirmed.id);
  const uncertain = data.headDecisions.some((d) => d.candidateId === row.candidateId && d.bookingId === null);
  const subject = row.subject;
  const bookingResult = confirmed && data.mocks.find((m) => m.bookingId === confirmed.id && m.candidateId === row.candidateId && m.subject === subject && m.source !== "tracker");
  const otherResult = !!confirmed && !!subject && data.mocks.some((m) =>
    m.candidateId === row.candidateId && m.subject === subject && m.source !== "tracker" && m.bookingId !== confirmed.id);
  const checkingScores = bookingResult?.status === "uploaded" || bookingResult?.status === "marking";
  const rubric = bookingResult?.rubric;
  const scored = bookingResult?.status === "done" && !!rubric && !checkRubric(rubric).length && !rubricNeedsCheck(rubric);
  const needsCheck = otherResult || (!!bookingResult && !checkingScores && !scored);
  const draft = data.decisions.some((d) => d.candidateId === row.candidateId && d.status === "draft");
  const due = ended && !!path && active && !decision && !uncertain && !needsCheck && !!subject && (scored || (!bookingResult && !draft));
  const missingOutcome = ended && !!confirmed && active && !path && !decision && !uncertain && !needsCheck && (scored || (!bookingResult && !draft));
  const needsAction = due || missingOutcome || (active && (needsCheck || (!!bookingResult && !scored)));
  const end = mock ? formatInTimeZone(new Date(mock.endTime), ZONE, "HH:mm") : null;
  return { row, candidate, active, path, ended, decision, scored, checkingScores, needsCheck, due, missingOutcome, needsAction, status, end };
}

/** One line on the left and one page on the right: a mock, a paper visit, or a near-miss paper to re-mark. */
interface HeadItem {
  id: string;
  name: string;
  candidate?: HiringCandidate;
  /** The time (or the AI score of a paper) on top, the day under it. */
  time: string | null;
  day: string;
  detail: string;
  tags: { text: string; tone?: "hire" | "reject" }[];
  /** What the head must know or do. Empty when the open page says it. */
  note: string | null;
  /** The brief or the paper check, opened at the part that needs the head. */
  href: string | null;
  /** Gift signed this review here; the row keeps the result if its review mounts again. */
  signed?: "hired" | "rejected";
  task: string;
  /** The job in words on the row (Re-mark paper, Score mock…), for a row that needs the head now. */
  action?: string;
  /** Needs the head now: a paper to re-mark, a mock to score, a packet to sign. The first one is open on arrival. */
  urgent?: boolean;
  /** A final review: Gift's packet, opened in the pane, not as a page. */
  review?: HeadDecisionRow;
}

/** `owner`: Gift's own mock, which ends in her decision and the offer, not a recommendation (Kevin, 25 Nov 2026). */
function visitItem(visit: ReturnType<typeof headVisit>, today: string, live = false, owner = false): HeadItem {
  const { row, candidate, active, path, decision, scored, checkingScores, needsCheck, due, missingOutcome, status, end } = visit;
  const mock = !!row.mockStart;
  const open = path && active;
  return {
    id: row.visitId,
    name: candidate?.name ?? "Needs review: candidate record not found",
    candidate,
    // The whole appointment in one place: the time range and the calendar date (Sol review, rounds 13–14).
    time: row.mockStart && end ? `${row.mockStart}–${end}` : row.mockStart ?? row.paperStart,
    day: row.date === today ? "Today" : shortDay(row.date),
    // A no-break space keeps the dot with the subject when the line wraps.
    detail: `${row.subject ?? "Subject not recorded"}\u00a0· ${mock ? "Mock" : "Paper test"}`,
    tags: [
      ...(status ? [{ text: status }] : []),
      ...(scored && !decision && !due ? [{ text: "Scores sent", tone: "hire" as const }] : []),
      ...(decision ? [{ text: owner && candidate && isDecided(candidate.stage) ? `Decision: ${decision.decision === "hire" ? "Hire" : "Reject"}` : `Recommendation: ${decision.decision === "hire" ? "Yes" : "No"}`, tone: decision.decision }] : []),
    ],
    action: due && open ? (scored ? (owner ? "Decide" : "Recommend") : "Score mock") : live && open && !scored ? "Score mock"
      : checkingScores ? undefined
      : needsCheck ? "Ask admin: check scores"
      : mock && !path && !status && missingOutcome ? "Ask admin: outcome missing" : undefined,
    // The reason is in the action for Ask admin rows, so the row reads as one task.
    note: checkingScores ? "Admin checking scores"
      : needsCheck ? null
      : mock && !path && !status ? (missingOutcome ? null : "No brief yet")
      : path && !active ? "Brief closed"
      : candidate?.resumeState === "none" ? "No résumé"
      : candidate?.resumeState === "deleted" ? "Résumé deleted"
      : null,
    href: open ? (due ? `${path}#${scored ? "recommendation" : "scores"}` : path) : null,
    task: decision && !needsCheck && !checkingScores ? "View brief" : !due ? "Interview brief" : scored ? "Record recommendation" : "Score and recommend",
    urgent: !!open && (due || live),
  };
}

/** The open page inside the screen: `embed=1` drops the page's own header and its link back to this list. */
const hashOf = (href: string | null | undefined) => href?.split("#")[1] ?? "";
const embedded = (href: string) => {
  const [base, hash] = href.split("#");
  return `${base}${base.includes("?") ? "&" : "?"}embed=1${hash ? `#${hash}` : ""}`;
};

function ItemLink({ item, selected, onSelect, wide, readOnly, paneId }: { item: HeadItem; selected: boolean; onSelect: () => void; wide: boolean; readOnly: boolean; paneId: string }) {
  const body = (
    <>
      <span className="sr-only">{item.task}: </span>
      <span className={r.itemTime}>
        {item.time}
        <span>{item.day}</span>
        {/* The open row on a laptop says it is the one showing; "Open" read as a command (Sol review, round 16). */}
        {selected && wide && <span className={r.itemOpen} aria-hidden="true">Selected</span>}
      </span>
      <span className={r.itemMain}>
        <span className={r.itemName}>{item.name}</span>
        <span className={r.itemDetail}>{item.detail}</span>
        {item.action && <span className={r.itemAction}>{item.action}</span>}
        {(item.tags.length > 0 || item.note) && (
          <span className={r.itemNotes}>
            {item.tags.map((tag) => <span key={tag.text} className={r.tag} data-tone={tag.tone}>{tag.text}</span>)}
            {item.note && <span className={r.itemNote}>{item.note}</span>}
          </span>
        )}
      </span>
      {/* Every row opens something. */}
      {!(selected && wide) && <span className={r.itemGo} aria-hidden="true">›</span>}
    </>
  );
  // On a phone the list is the page, so the link opens the brief or the paper check itself.
  // A preview must never open the head's brief or paper check, where a send would count.
  return item.href && !readOnly ? (
    <a className={r.item} href={item.href} aria-current={selected ? "true" : undefined} data-urgent={item.urgent ? "" : undefined}
      onClick={(event) => {
        if (!wide || event.metaKey || event.ctrlKey || event.shiftKey) return;
        event.preventDefault();
        onSelect();
        // From the keyboard (no pointer), move on to the page that just opened.
        if (event.detail === 0) window.setTimeout(() => document.getElementById("open-item")?.focus());
      }}>
      {body}
    </a>
  ) : (
    <button type="button" className={r.item} aria-current={selected ? "true" : undefined} aria-expanded={wide ? undefined : selected}
      aria-controls={!wide && selected ? paneId : undefined} data-urgent={item.urgent ? "" : undefined} onClick={(event) => {
        onSelect();
        if (wide && event.detail === 0) window.setTimeout(() => document.getElementById("open-item")?.focus());
      }}>
      {body}
    </button>
  );
}

/** The right side: the real brief or paper check page, or the résumé when there is no page to open. */
function ItemPane({ item, data, readOnly, reload, onSigned }: { item: HeadItem; data: HiringData; readOnly: boolean; reload?: () => Promise<void>; onSigned?: (item: HeadItem, stage: "hired" | "rejected") => void }) {
  // The paper-check link is signed again on every list load. Keep the first address, so a list refresh never reloads
  // the open page and loses marks the head is typing (code review, 24 Nov 2026). The pane is keyed by the row.
  const [src] = useState(() => (item.href ? embedded(item.href) : null));
  const [loaded, setLoaded] = useState(false);
  // Only Gift signs. A preview or another account sees the facts and the résumé.
  if (item.review && data.reviewAccess?.gift && !readOnly) {
    return (
      <div className={r.paneFacts}>
        <div className={r.reviewMain}>
          <h2 className={r.paneName}>{item.name}</h2>
          {/* The open packet states the head's recommendation; a phone shows it here. */}
          <p className={`${r.meta} ${r.reviewWho}`}>{item.review.reason || "No reason given"}</p>
          {item.review.draftProblem && <p className={r.warn}>No email draft yet: {item.review.draftProblem}</p>}
          <FinalReview id={item.review.candidateId!} autoLoad hideHeading inline signed={item.signed} {...reviewBlocks(data.writeGate, data.config, item.review.candidateId!)}
            onChanged={async (stage) => {
              if (stage) onSigned?.(item, stage);
              await reload?.();
            }} />
        </div>
      </div>
    );
  }
  // A preview must not score or mark in the head's name, so it shows only the résumé.
  if (item.href && !readOnly) {
    return (
      <>
        {!loaded && <p role="status" className={`${r.quiet} ${r.opening}`}>Opening…</p>}
        {/* Hidden until it has loaded, so the page's own loading frame never shows in the pane. */}
        <iframe key={item.id} className={r.paneFrame} src={src ?? embedded(item.href)} title={`${item.task}: ${item.name}`} onLoad={() => setLoaded(true)}
          style={{ visibility: loaded ? "visible" : "hidden" }} />
      </>
    );
  }
  return (
    <div className={r.paneFacts}>
      <h2 className={r.paneName}>{item.name}</h2>
      <p className={r.meta}>{[item.day, item.time, item.detail].filter(Boolean).join(" · ")}</p>
      {item.note && <p className={r.meta}>{item.note}</p>}
      {readOnly && item.href && <p className={r.quiet}>Preview: the brief and the scores open only for the head.</p>}
      {item.review && <p className={r.quiet}>The packet and the sign-off open only for the final reviewer.</p>}
      {item.candidate && <ResumePeek candidate={item.candidate} months={data.config.resumeRetentionMonths} />}
    </div>
  );
}

/**
 * The Heads screen. `head` is the head who is signed in (or the one a preview shows): their list only, with no name to
 * choose. Without it (Kevin, or the Mock teaching tab), a menu picks the head and the browser remembers the choice.
 */
export function HeadsScreen({ data, readOnly = false, head: fixedHead, open, reload }: {
  data: HiringData;
  readOnly?: boolean;
  head?: string | null;
  /** A candidate id from Gift's review email link: that final review is open on arrival. */
  open?: string;
  reload?: () => Promise<void>;
}) {
  const heads = headKeys(data.config);
  const [chosen, setChosen] = useState<string | null>(() => {
    if (fixedHead || readOnly) return null;
    // ?head=Ek opens that head's screen as they see it (Kevin, 24 Nov 2026).
    const asked = new URLSearchParams(window.location.search).get("head");
    if (asked) return asked;
    try {
      return window.localStorage.getItem(HEAD_KEY);
    } catch {
      // Storage can be blocked. The menu still works for this visit.
      return null;
    }
  });
  // Staff choose a head first; nothing opens in a head's name before that.
  const key = fixedHead ?? (chosen && heads.includes(chosen) ? chosen : null);
  const [picked, setPicked] = useState<string | null>(open ? `review-${open}` : null);
  const [signedItems, setSignedItems] = useState<HeadItem[]>([]);
  const [paneRun, setPaneRun] = useState(0);
  const keepSigned = (item: HeadItem, stage: "hired" | "rejected") => {
    setPicked(item.id);
    setSignedItems((current) => [...current.filter((kept) => kept.id !== item.id),
      { ...item, urgent: false, action: undefined, time: "Signed", day: stage === "hired" ? "Offer queued" : "Rejection queued", tags: [], signed: stage }]);
  };
  const choose = (value: string) => {
    setChosen(value);
    setPicked(null);
    setShown(null);
    setSignedItems([]);
    setSavedFor(null);
    setAnnounce("");
    if (readOnly) return;
    try {
      window.localStorage.setItem(HEAD_KEY, value);
    } catch {
      // As above.
    }
  };
  const wide = useWide();
  // A score sent in the open page shows in the list when the head comes back to it (not more than once in 30 seconds).
  const loadedAt = useRef(0);
  // "Saved for …" stays under To do until another row opens, so the head sees the save where they started.
  const [savedFor, setSavedFor] = useState<{ id: string; text: string } | null>(null);
  const openNameRef = useRef<{ id: string; name: string } | null>(null);
  // What the one status line says after a save; emptied first, so the same words are read again (Sol review, round 22).
  const [announce, setAnnounce] = useState("");
  // The dashboard passes a new function on each render; the listeners use the latest one without subscribing again.
  const reloadRef = useRef(reload);
  useEffect(() => {
    reloadRef.current = reload;
  }, [reload]);
  const canReload = !!reload;
  useEffect(() => {
    const reload = reloadRef.current;
    if (!canReload || !reload) return;
    loadedAt.current = Date.now();
    const refresh = () => {
      if (Date.now() - loadedAt.current < 30_000) return;
      loadedAt.current = Date.now();
      void reloadRef.current?.().catch(() => {});
    };
    // A save in the open brief or paper check reloads the list at once, so the row leaves To do.
    const saved = (event: MessageEvent) => {
      // Only the open pane's own page may report a save.
      if (event.origin !== window.location.origin || event.data?.type !== "hiring-saved"
        || event.source !== document.querySelector<HTMLIFrameElement>("#open-item iframe")?.contentWindow) return;
      const open = openNameRef.current;
      const kind = event.data.kind;
      const text = open && `${kind === "marks" ? "Marks saved" : kind === "recommendation" ? "Recommendation saved" : kind === "scores" ? "Scores saved" : "Saved"} for ${open.name}`;
      setSavedFor(open && text ? { id: open.id, text } : null);
      setAnnounce("");
      if (text) window.setTimeout(() => setAnnounce(text), 100);
      loadedAt.current = Date.now();
      void reloadRef.current?.().catch(() => {});
    };
    window.addEventListener("focus", refresh);
    window.addEventListener("message", saved);
    return () => {
      window.removeEventListener("focus", refresh);
      window.removeEventListener("message", saved);
    };
  }, [canReload]);

  const minute = useMinute();
  const { rows, now, today } = useVisits(data, minute);
  const visits = key ? [
    ...data.bookings.filter((mock) => mock.kind === "mock" && mock.interviewerKey === key).map((mock) => {
      const start = new Date(mock.startTime);
      return headVisit({ visitId: mock.id, candidateId: mock.candidateId, date: localDate(start),
        mockStart: formatInTimeZone(start, ZONE, "HH:mm"), paperStart: null, subject: mock.subjects[0] ?? null }, data, now, mock);
    }),
    ...headVisits(rows, key, today).filter((row) => !row.mockStart).map((row) => headVisit(row, data, now)),
  ].sort((a, b) => (a.row.date + clock(a.row)).localeCompare(b.row.date + clock(b.row))) : [];
  const nextMock = visits.find((visit) => !visit.ended && visit.row.mockStart);
  const clockNow = formatInTimeZone(now, ZONE, "HH:mm");
  const upcomingVisits = visits.filter((visit) => !visit.ended && visit !== nextMock);
  const coming = upcomingVisits.filter((visit) => !!visit.row.mockStart);
  // Paper tests in the head's subjects need nothing from them, so they sit apart and closed (24 Nov 2026).
  const paperTests = upcomingVisits.filter((visit) => !visit.row.mockStart && (visit.row.date > today || (visit.row.paperStart ?? "") > clockNow));
  const mockNow = !!nextMock && nextMock.row.date === today && (nextMock.row.mockStart ?? "") <= clockNow;
  const since = shiftDate(today, -56);
  const ended = visits.filter(({ row, ended, missingOutcome, due, scored }) =>
    ended && (row.date >= since || missingOutcome || (due && scored))).reverse();
  const checks: HeadItem[] = key ? data.paperChecks.filter((check) => !check.done && check.head === key).map((check) => {
    const candidate = data.candidates.find((c) => c.id === check.candidateId);
    return { id: check.resultId, name: candidate?.name ?? "Needs review: candidate record not found", candidate, time: `${check.percent}%`, day: "AI score",
      detail: `${check.subject}\u00a0· Paper\u00a0check`, tags: [], note: null,
      href: check.path, task: "Re-mark paper", action: "Re-mark paper", urgent: !!check.path };
  }) : [];
  // Gift's final reviews: each newest Yes from a head that no sent result has closed. A ready packet comes first.
  const byId = new Map(data.candidates.map((candidate) => [candidate.id, candidate]));
  const packets = new Set(data.reviewPackets ?? []);
  const reviews: HeadItem[] = key && key === data.finalReviewer ? openHeadDecisions(data.headDecisions, data.decisions)
    .filter((d) => d.decision === "hire" && d.candidateId && !["hired", "rejected", "stopped"].includes(byId.get(d.candidateId)?.stage ?? ""))
    .map((d) => {
      const candidate = byId.get(d.candidateId!);
      const ready = packets.has(d.candidateId!);
      return { id: `review-${d.candidateId}`, name: candidate?.name ?? "Candidate", candidate, time: ready ? "Your decision" : "Packet",
        day: ready ? "" : "not ready", detail: `${candidate?.visitSubject ?? candidate?.subjects[0] ?? "Subject not recorded"}\u00a0· Yes from ${d.head.replace(/ /g, "\u00a0")}`,
        tags: [], note: d.draftProblem && "No email draft yet", href: null, task: "Final review",
        action: ready ? "Review packet" : undefined, urgent: ready, review: d };
    })
    : [];
  const reviewer = !!key && key === data.finalReviewer;
  const item = (visit: ReturnType<typeof headVisit>, live = false) => visitItem(visit, today, live, reviewer);
  // To do in the order of the work: papers to re-mark, then mocks to score; Gift's packets follow under Final review.
  const actionVisits = ended.filter((visit) => visit.needsAction && !visit.checkingScores).map((visit) => item(visit));
  const checking = ended.filter((visit) => visit.needsAction && visit.checkingScores).map((visit) => item(visit));
  // The next mock says what to do before it, where the head scans the list (Sol review, round 20).
  const nextRow = nextMock ? item(nextMock, mockNow) : undefined;
  const nextItem = nextRow && !mockNow && nextRow.href && !nextRow.note ? { ...nextRow, note: "Prepare" } : nextRow;
  // A signed review leaves Final review at once, before the reload drops it, and stays under Just finished for this visit.
  const signedIds = new Set(signedItems.map((item) => item.id));
  const unsigned = reviews.filter((item) => !signedIds.has(item.id));
  const stillSigned = signedItems;
  const ready = reviewer ? unsigned.filter((item) => item.urgent) : [];
  // Gift's sign-offs have their own heading under To do, so she sees at once whether a hire waits for her (Sol review, round 12).
  const groups: { title: string; label?: string; items: HeadItem[] }[] = [
    // Gift's ready packets have their own heading only while one waits; then her first heading says it is assessment work
    // (Sol and critic reviews, round 13). With nothing in either, one line covers both.
    { title: "To do", label: ready.length ? "Assessment tasks" : undefined, items: [...checks, ...actionVisits].sort((a, b) => Number(!!b.urgent) - Number(!!a.urgent)) },
    { title: "Final review", items: ready },
    { title: "Just finished", items: stillSigned },
    { title: mockNow ? "Mock now" : "Next mock", items: nextItem ? [nextItem] : [] },
    { title: "Coming up", items: coming.map((visit) => item(visit)) },
    // Rows where the head can only wait: admin is checking the scores, or the packet is not ready.
    { title: "Waiting", items: [...checking, ...unsigned.filter((item) => !item.urgent)] },
  ];
  // A mock in progress leads the list.
  if (mockNow) groups.unshift(...groups.splice(groups.findIndex((group) => group.title === "Mock now"), 1));
  const papers = paperTests.map((visit) => item(visit));
  const past = ended.filter((visit) => !visit.needsAction).slice(0, 6).map((visit) => item(visit));
  const all = [...groups.flatMap((group) => group.items), ...papers, ...past];
  // The most urgent page is already open: a paper to re-mark or a mock to score, else the next mock.
  // A save can take the open row off the list. Its page stays open, with its confirmation, until another row is chosen.
  const [shown, setShown] = useState<HeadItem | null>(null);
  const found = picked ? all.find((item) => item.id === picked) : undefined;
  const keep = shown && (!picked || picked === shown.id) ? all.find((item) => item.id === shown.id) ?? shown : undefined;
  // On arrival: a mock in progress (Kevin, 24 Nov 2026), else the first job that needs the head, else the next mock.
  // A mock that starts while the head has not chosen a row takes the pane; a row the head chose stays open. Paper marks and
  // mock scores are kept as drafts, so nothing typed is lost (Sol review, rounds 11–14).
  const selected = wide ? found ?? (mockNow && !picked ? nextItem : undefined) ?? keep ?? all.find((item) => item.urgent) ?? nextItem ?? all[0] : found;
  if ((selected?.id ?? null) !== (shown?.id ?? null)) setShown(selected ?? null);
  const selectedId = selected?.id;
  // Work in the open pane makes it the head's choice, so a mock that starts does not take it away. Focus inside a frame
  // reaches this page only as a window blur, so that is checked too (code and critic reviews, rounds 20–21).
  useEffect(() => {
    const claim = () => window.setTimeout(() => {
      if (document.activeElement?.closest("#open-item") && !picked && selectedId) setPicked(selectedId);
    });
    window.addEventListener("blur", claim);
    return () => window.removeEventListener("blur", claim);
  }, [picked, selectedId]);
  // A mock that starts while its brief is open: the brief fetches itself again, so its label reads "Mock now" (critic, round 18).
  const liveId = mockNow ? nextItem?.id : undefined;
  // A mock that starts ends the save receipt, so the status line says "mock now" even on the row just saved (critic, round 24).
  const [seenLive, setSeenLive] = useState(liveId);
  if (liveId !== seenLive) {
    setSeenLive(liveId);
    if (liveId) {
      setSavedFor(null);
      setAnnounce("");
    }
  }
  useEffect(() => {
    if (!liveId || !wide || selected?.id !== liveId) return;
    document.querySelector<HTMLIFrameElement>("#open-item iframe")?.contentWindow?.postMessage({ type: "hiring-refresh", part: "" }, window.location.origin);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only when the mock starts
  }, [liveId]);
  // "Saved for …" sits in the group that holds the saved row, or under To do once the row has left the list.
  // The part of the brief the open pane was loaded at, for a click on the open row.
  const paneKey = selected ? `${selected.id}:${paneRun}` : null;
  const [paneAt, setPaneAt] = useState<{ key: string; hash: string } | null>(null);
  if (paneKey && paneAt?.key !== paneKey) setPaneAt({ key: paneKey, hash: hashOf(selected!.href) });
  const savedIn = savedFor && selected?.id === savedFor.id
    ? groups.find((group) => group.items.some((item) => item.id === savedFor.id))?.title ?? "To do" : null;
  useEffect(() => {
    openNameRef.current = selected ? { id: selected.id, name: selected.name } : null;
  }, [selected]);
  const paneId = useId();
  // Gift's review link: on a phone the row may sit below the fold.
  useEffect(() => {
    if (open) document.getElementById(`row-review-${open}`)?.scrollIntoView({ block: "center" });
  }, [open]);
  const name = key ? headName(key, data.tutors) : null;
  // A head who only checks papers (Tito) has no "Next mock" line.
  const givesMocks = data.config.interviewers.some((h) => h.canonicalKey === key);
  const list = (items: HeadItem[]) => (
    <ul className={r.items}>
      {items.map((item) => (
        <li key={item.id} id={`row-${item.id}`}>
          <ItemLink item={item} wide={wide} readOnly={readOnly} paneId={`${paneId}-${item.id}`} selected={selected?.id === item.id}
            onSelect={() => {
              // Another row: the save receipt and its announcement belong to the row left behind (Sol review, round 23).
              if (selected?.id !== item.id) {
                setSavedFor(null);
                setAnnounce("");
              }
              // The open row that now points elsewhere (Recommend after the mock) asks its page to fetch itself again in
              // place, so the open tab and unsent edits stay; a page with no frame loads again (Sol review, rounds 15–17).
              if (wide && selected?.id === item.id && paneAt && hashOf(item.href) !== paneAt.hash) {
                const frame = document.querySelector<HTMLIFrameElement>("#open-item iframe")?.contentWindow;
                if (frame) frame.postMessage({ type: "hiring-refresh", part: hashOf(item.href) }, window.location.origin);
                else setPaneRun((run) => run + 1);
                setPaneAt({ key: paneAt.key, hash: hashOf(item.href) });
              }
              setPicked(!wide && picked === item.id ? null : item.id);
            }} />
          {!wide && picked === item.id && (!item.href || readOnly) && (
            <div id={`${paneId}-${item.id}`} className={r.inlinePane} role="region" aria-label={item.name}>
              <ItemPane item={item} data={data} readOnly={readOnly} reload={reload} onSigned={keepSigned} />
            </div>
          )}
        </li>
      ))}
    </ul>
  );
  return (
    <div className={r.workspace} data-heads-review="" data-empty={key && fixedHead && !all.length ? "" : undefined}>
      {/* The list is navigation at every width; on a phone the open row's form is a labelled region inside it. */}
      {/* One status that is always there and outside the list (which hides when empty on a laptop). While the saved row is
          open it holds the save, empty during the reset so a repeat is read; otherwise the schedule (reviews, rounds 21–23). */}
      <p className="sr-only" role="status">{savedIn ? announce : (name && `${name} · ${nextMock
          ? `${mockNow ? "mock now" : "next mock"} ${shortDay(nextMock.row.date)}, ${nextMock.row.mockStart}` : "no mock booked"}`)}</p>
      <nav id="hiring-list" tabIndex={-1} className={r.rail} aria-label={name ? `${nickname(name)}'s hiring list` : "Hiring list"}>
        {!fixedHead && (
          <label className={r.headMenu}>
            Head
            <select value={key ?? ""} onChange={(event) => choose(event.target.value)}>
              {!key && <option value="" disabled>Choose a head</option>}
              {heads.map((h) => <option key={h} value={h}>{headName(h, data.tutors)}</option>)}
            </select>
          </label>
        )}
        {wide && selected && (
          // Focus only: a hash change would drop the review link Gift came in on.
          <a className={r.skip} href="#open-item" onClick={(event) => {
            event.preventDefault();
            document.getElementById("open-item")?.focus();
          }}>Skip to open item</a>
        )}

        {groups.map((group) => (group.items.length > 0 || (group.title === "Next mock" && givesMocks) || (group.title === "To do" && (savedIn === "To do" || (!ready.length && !mockNow && (givesMocks || reviewer))))) && (
          <section key={group.title} className={r.group} data-tone={(group.title === "To do" || group.title === "Final review") && group.items.length ? "todo" : undefined}>
            <h2 className={r.groupTitle}>
              {group.label ?? group.title}
              {group.items.length > 1 && <span className={r.count}>{group.items.length}</span>}
            </h2>
            {group.title === savedIn && <p className={r.saved} aria-hidden="true">{savedFor?.text}</p>}
            {group.items.length ? list(group.items) : group.title === savedIn ? null : <p className={r.quiet}>{group.title === "To do" ? (reviewer ? (unsigned.length ? "No assessment tasks. No hires ready for approval." : "No assessment tasks. No hires to approve.") : nextItem?.note === "Prepare" ? "No marks or recommendations due." : "Nothing to do now.") : "No mock booked. New bookings also come by LINE."}</p>}
          </section>
        ))}
        {!heads.length ? <p className={r.quiet}>No heads are set up. Add interviewers in Rules and setup.</p>
          : !key ? <p className={r.quiet}>Choose a head to see their list.</p>
          : !all.length && !givesMocks && !wide && <p className={r.quiet}>Nothing to do. We send you a LINE message when a paper needs you.</p>}
        {papers.length > 0 && (
          <details className={r.group}>
            <summary className={r.groupTitle}>Paper tests, no action <span className={r.count}>{papers.length}</span></summary>
            {list(papers)}
          </details>
        )}
        {past.length > 0 && (
          <details className={r.group}>
            <summary className={r.groupTitle}>Past mocks <span className={r.count}>{past.length}</span></summary>
            {list(past)}
          </details>
        )}
      </nav>
      {wide && (
        <section id="open-item" tabIndex={-1} className={r.pane} onFocus={() => { if (!picked && selected) setPicked(selected.id); }} aria-label={selected ? `${selected.task}: ${selected.name}` : key && !all.length ? "Nothing to do" : "Nothing open"}>
          {selected ? <ItemPane key={paneKey!} item={selected} data={data} readOnly={readOnly || (!fixedHead && !chosen)} reload={reload} onSigned={keepSigned} />
            : key && !all.length ? <div className={r.paneFacts}><h2 className={r.paneName}>Nothing to do</h2>
              <p className={r.quiet}>{givesMocks ? "We send you a LINE message when a mock or a paper needs you." : "We send you a LINE message when a paper needs you."}</p></div>
            : null}
        </section>
      )}
    </div>
  );
}
