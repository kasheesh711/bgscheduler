"use client";

import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import { formatInTimeZone } from "date-fns-tz";
import { checkRubric, rubricNeedsCheck } from "@/lib/hiring/marking-sheet";
import { isDecided, localDate, shiftDate, ZONE, type Subject } from "@/lib/hiring/model";
import { buildRunSheet, headName, headVisits, pastVisits, upcoming, type RunSheetRow } from "@/lib/hiring/run-sheet";
import { dayTitle, openHeadDecisions, weekCalls } from "@/lib/hiring/role-views";
import { universityName } from "@/lib/hiring/seek-view";
import { ContractTemplates, SignedContract } from "./contract-templates";
import { FinalReview, reviewBlocks } from "./final-review";
import { resultEmailState, ResultUpload } from "./assessment-screen";
import { callCommand, callState, callSubjects, triesText } from "./calls-screen";
import { PhoneLink, ResumePeek, SeekApplicationReview } from "./candidate-inspector";
import type { Command, HiringCandidate, HiringData } from "./dashboard";
import r from "./role-screens.module.css";

// ─── The simple screens: one job each, big targets, no tables. They read the same payload as the full dashboard. ───

const shortDay = (date: string) =>
  new Date(`${date}T12:00:00Z`).toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" });

function ResumeButton({ open, onToggle, name, panelId }: { open: boolean; onToggle: () => void; name: string; panelId: string }) {
  return (
    <button type="button" className={r.big} aria-expanded={open} aria-controls={panelId} aria-label={`${open ? "Hide" : "Show"} the résumé of ${name}`} onClick={(event) => {
      onToggle();
      if (open) event.currentTarget.focus();
    }}>
      {open ? "Hide résumé" : "Résumé"}
    </button>
  );
}

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

export function HiringReviewScreen({ data, offers, onOpenResults, reload, linkedReview }: {
  data: HiringData;
  offers: boolean;
  onOpenResults: (id: string | null) => void;
  reload: () => Promise<void>;
  linkedReview?: string;
}) {
  if (!offers) return (
    <div className={r.screen} data-heads-review="">
      <ReviewRecommendations data={data} onOpenResults={onOpenResults} reload={reload} linkedReview={linkedReview} />
    </div>
  );

  const candidates = new Map(data.candidates.filter((candidate) => candidate.stage === "hired").map((candidate) => [candidate.id, candidate]));
  const approved = data.decisions.filter((decision) => decision.status === "sent" && decision.decision === "hire" && candidates.has(decision.candidateId));
  return (
    <div className={r.screen}>
      <Section title="Approved offers" count={approved.length}>
        {!approved.length && <p className={r.quiet}>There are no approved offers.</p>}
        <div className={r.cards}>
          {approved.map((decision) => {
            const email = resultEmailState(decision.outboxKey, data.inviteOutbox);
            return (
              <article key={decision.id} className={r.card}>
                <div className={r.cardMain}>
                  <p className={r.name}>{candidates.get(decision.candidateId)?.name}</p>
                  <p className={r.meta}>Offer email <strong>{email.label}</strong></p>
                </div>
                <div className={r.actions}>
                  <SignedContract candidateId={decision.candidateId} name={candidates.get(decision.candidateId)?.name ?? "the tutor"} />
                  {(data.reviewAccess?.hr || data.reviewAccess?.gift) && <FinalReview id={decision.candidateId} signing />}
                </div>
              </article>
            );
          })}
        </div>
      </Section>
      <Section title="Contract templates"><ContractTemplates /></Section>
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

function useVisits(data: HiringData) {
  return useMemo(() => {
    const now = new Date();
    const rows = buildRunSheet({ ...data, now });
    const today = localDate(now);
    return { rows, now, today, coming: upcoming(rows, today), recent: pastVisits(rows, today) };
  }, [data]);
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

const HEAD_KEY = "hiring-head";

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
  return { row, candidate, active, path, ended, decision, scored, checkingScores, needsCheck, due, missingOutcome, needsAction, status };
}

function HeadCard({ visit, data, readOnly }: { visit: ReturnType<typeof headVisit>; data: HiringData; readOnly: boolean }) {
  const { row, candidate, active, path, decision, scored, checkingScores, needsCheck, due, missingOutcome, status } = visit;
  const name = candidate?.name ?? "Needs review: candidate record not found";
  const [resume, setResume] = useState(false);
  const resumeId = useId();
  const briefLabel = decision && !needsCheck && !checkingScores ? "View brief" : !due ? "Open interview brief" : scored ? "Record recommendation" : "Score and recommend";
  return (
    <article className={`${r.card} ${r.headCard}`}>
      <p className={r.time}>
        {row.mockStart ?? row.paperStart}
        <span>{shortDay(row.date)}</span>
      </p>
      <div className={r.cardMain}>
        <p className={r.name}>{name}</p>
        <p className={r.meta}>
          {row.subject ?? "Subject not recorded"}{status && ` · ${status}`}
        </p>
        <p className={r.meta}>
          {scored && !decision && (
            <span className={r.tag} data-tone="hire">
              Scores sent
            </span>
          )}
          {decision && (
            <span className={r.tag} data-tone={decision.decision}>
              Recommendation: {decision.decision === "hire" ? "Yes" : "No"}
            </span>
          )}
        </p>
        {checkingScores ? <p className={r.meta}>Scores are being checked. Come back later.</p>
          : needsCheck && <p className={r.meta}>Ask admin to check scores.</p>}
        {row.mockStart && !path && !status && <p className={r.meta}>{missingOutcome
          ? (scored ? "Ask admin to record the recommendation" : "Ask admin to record the outcome")
          : "No brief yet."}</p>}
        {path && !active && <p className={r.meta}>The interview brief is closed.</p>}
        {candidate?.resumeState === "none" && <p className={r.meta}>No résumé file is stored.</p>}
        {candidate?.resumeState === "deleted" && <p className={r.meta}>The résumé file was deleted.</p>}
      </div>
      <div className={r.actions}>
        {path && active && !readOnly && (
          <a className={r.big} data-tone={due ? "primary" : undefined} href={due ? `${path}#${scored ? "recommendation" : "scores"}` : path} target="_blank" rel="noopener noreferrer" aria-label={`${briefLabel} for ${name}`}>
            {briefLabel}
          </a>
        )}
        {candidate && <ResumeButton open={resume} onToggle={() => setResume(!resume)} name={name} panelId={resumeId} />}
      </div>
      {candidate && (
        <div id={resumeId} className={r.resume} hidden={!resume}>
          {resume && <ResumePeek candidate={candidate} months={data.config.resumeRetentionMonths} />}
        </div>
      )}
    </article>
  );
}

export function HeadsScreen({ data, readOnly = false }: { data: HiringData; readOnly?: boolean }) {
  const heads = data.config.interviewers;
  // The browser remembers the head, so the next visit opens on their own list. This screen renders only in the browser, after the data loads.
  const [key, setKey] = useState<string | null>(() => {
    if (readOnly) return null;
    try {
      return window.localStorage.getItem(HEAD_KEY);
    } catch {
      // Storage can be blocked. The picker still works for this visit.
      return null;
    }
  });
  const choose = (value: string) => {
    setKey(value);
    if (readOnly) return;
    try {
      window.localStorage.setItem(HEAD_KEY, value);
    } catch {
      // As above.
    }
  };
  const { rows, now, today } = useVisits(data);
  const head = heads.find((h) => h.canonicalKey === key);
  const visits = head ? [
    ...data.bookings.filter((mock) => mock.kind === "mock" && mock.interviewerKey === head.canonicalKey).map((mock) => {
      const start = new Date(mock.startTime);
      return headVisit({ visitId: mock.id, candidateId: mock.candidateId, date: localDate(start),
        mockStart: formatInTimeZone(start, ZONE, "HH:mm"), paperStart: null, subject: mock.subjects[0] ?? null }, data, now, mock);
    }),
    ...headVisits(rows, head.canonicalKey, today).filter((row) => !row.mockStart).map((row) => headVisit(row, data, now)),
  ].sort((a, b) => (a.row.date + clock(a.row)).localeCompare(b.row.date + clock(b.row))) : [];
  const [nextMock, ...comingMocks] = visits.filter((visit) => !visit.ended && visit.row.mockStart);
  const paperVisits = visits.filter((visit) => !visit.ended && !visit.row.mockStart);
  const since = shiftDate(today, -56);
  const ended = visits.filter(({ row, ended, missingOutcome, due, scored }) =>
    ended && (row.date >= since || missingOutcome || (due && scored))).reverse();
  const needsAction = ended.filter((visit) => visit.needsAction);
  const done = ended.filter((visit) => !visit.needsAction).slice(0, 6);
  return (
    <div className={r.screen} data-heads-review="">
      <div className={r.section}>
        {!head && <p className={r.quiet}>Choose your name</p>}
        <div className={r.picker} role="group" aria-label="Choose your name">
          {heads.map((h) => (
            <button key={h.canonicalKey} type="button" aria-pressed={h.canonicalKey === key} onClick={() => choose(h.canonicalKey)}>
              {headName(h.canonicalKey, data.tutors)}
            </button>
          ))}
        </div>
        <p className="sr-only" role="status">{head && `${headName(head.canonicalKey, data.tutors)} · ${nextMock
          ? `next mock ${shortDay(nextMock.row.date)}, ${nextMock.row.mockStart}` : "no mock booked"}`}</p>
      </div>
      {head && (
        <>
          <Section title="Next mock" id="next-mock">
            {nextMock ? <HeadCard key={nextMock.row.visitId} visit={nextMock} data={data} readOnly={readOnly} /> : (
              <div className={r.card}>
                <div className={r.cardMain}>
                  <p>No mock booked yet.</p>
                  <p className={r.quiet}>New bookings also come by LINE.</p>
                </div>
              </div>
            )}
          </Section>
          {needsAction.length > 0 && (
            <Section title="Mocks that need action" count={needsAction.length}>
              <div className={r.cards}>
                {needsAction.map((visit) => (
                  <HeadCard key={visit.row.visitId} visit={visit} data={data} readOnly={readOnly} />
                ))}
              </div>
            </Section>
          )}
          {comingMocks.length > 0 && (
            <Section title="Coming to you" count={comingMocks.length}>
              <div className={r.cards}>
                {comingMocks.map((visit) => (
                  <HeadCard key={visit.row.visitId} visit={visit} data={data} readOnly={readOnly} />
                ))}
              </div>
            </Section>
          )}
          {paperVisits.length > 0 && (
            <Section title="Paper visits" count={paperVisits.length}>
              <div className={r.cards}>
                {paperVisits.map((visit) => (
                  <HeadCard key={visit.row.visitId} visit={visit} data={data} readOnly={readOnly} />
                ))}
              </div>
            </Section>
          )}
          {done.length > 0 && (
            <Section title="Past mocks" count={done.length}>
              <div className={r.cards}>
                {done.map((visit) => (
                  <HeadCard key={visit.row.visitId} visit={visit} data={data} readOnly={readOnly} />
                ))}
              </div>
            </Section>
          )}
        </>
      )}
    </div>
  );
}
