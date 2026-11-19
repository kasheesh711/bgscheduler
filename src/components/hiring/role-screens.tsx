"use client";

import { useMemo, useState, type ReactNode } from "react";
import { formatInTimeZone } from "date-fns-tz";
import { localDate, RESUME_TYPES, ZONE, type Subject } from "@/lib/hiring/model";
import { buildRunSheet, headName, headVisits, pastVisits, upcoming, type RunSheetRow } from "@/lib/hiring/run-sheet";
import { dayTitle, openHeadDecisions, weekCalls } from "@/lib/hiring/role-views";
import { universityName } from "@/lib/hiring/seek-view";
import { FinalReview } from "./final-review";
import { ResultUpload } from "./assessment-screen";
import { callCommand, callState, callSubjects, triesText } from "./calls-screen";
import { PhoneLink, ResumeBody, SourceTextBody, useResumeCheck, useSourceText } from "./candidate-inspector";
import type { Command, HiringCandidate, HiringData } from "./dashboard";
import css from "./dashboard.module.css";
import r from "./role-screens.module.css";

// ─── The simple screens: one job each, big targets, no tables. They read the same payload as the full dashboard. ───

const shortDay = (date: string) =>
  new Date(`${date}T12:00:00Z`).toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" });

/** The résumé inside the card: the PDF, else the text read from the application. It loads only when opened. */
function ResumePeek({ candidate, months }: { candidate: HiringCandidate; months: number }) {
  const pdf = candidate.resumeState === "available" && candidate.resumeType === RESUME_TYPES.pdf;
  const check = useResumeCheck(candidate.id, true, candidate.resumeState === "available");
  const source = useSourceText(candidate.id, !pdf || check.status === "failed");
  return (
    <div className={r.resume}>
      <ResumeBody id={candidate.id} name={candidate.name} state={candidate.resumeState} type={candidate.resumeType} months={months} check={check} />
      {(!pdf || check.status === "failed") && (
        <div className={css.sourceText}>
          <SourceTextBody id={candidate.id} {...source} />
        </div>
      )}
    </div>
  );
}

function ResumeButton({ open, onToggle, name }: { open: boolean; onToggle: () => void; name: string }) {
  return (
    <button type="button" className={r.ghost} aria-expanded={open} aria-label={`${open ? "Hide" : "Show"} the résumé of ${name}`} onClick={onToggle}>
      {open ? "Hide résumé" : "Résumé"}
    </button>
  );
}

function Section({ title, count, children }: { title: string; count?: number; children: ReactNode }) {
  return (
    <section className={r.section}>
      <h2 className={r.heading}>
        {title}
        {count !== undefined && <span className={r.count}>{count}</span>}
      </h2>
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

export function TodayCalls({ data, command, busy, readOnly = false }: { data: HiringData; command: Command; busy: boolean; readOnly?: boolean }) {
  const [date, setDate] = useState(() => localDate(new Date()));
  const [open, setOpen] = useState<string | null>(null);
  const byId = new Map(data.candidates.map((candidate) => [candidate.id, candidate]));
  const rows = [
    ...data.calls.map((call) => ({ ...call, missed: false })),
    ...(data.missedCalls ?? []).map((call) => ({ ...call, missed: true })),
  ].filter((call) => localDate(new Date(call.start)) === date)
    .sort((a, b) => new Date(a.start).getTime() - new Date(b.start).getTime());
  return (
    <Section title="Today’s calls" count={rows.length}>
      <label className={r.date}>Date (Bangkok) <input type="date" value={date} onChange={(event) => {
        if (event.target.value) setDate(event.target.value);
      }} /></label>
      {!rows.length && <p className={r.quiet}>No calls for this date.</p>}
      <div className={r.cards}>
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
                  <button type="button" className={r.ghost} aria-expanded={open === key}
                    onClick={() => setOpen(open === key ? null : key)}>Résumé and notes</button>
                  {active && (["good", "no_answer", "bad"] as const).map((result, index) => (
                    <button key={result} type="button" className={r.big} disabled={busy || readOnly} onClick={() => {
                      if (result === "bad" && !window.confirm(`Stop ${candidate.name}?`)) return;
                      void command(callCommand(candidate, result));
                    }}>{["Good call", "No answer", "Bad call"][index]}</button>
                  ))}
                </div>
              )}
              {candidate && open === key && <div className={r.callDetail}>
                <ResumePeek candidate={candidate} months={data.config.resumeRetentionMonths} />
                <CallNotes candidate={candidate} command={command} busy={busy} readOnly={readOnly} />
              </div>}
            </article>
          );
        })}
      </div>
    </Section>
  );
}

export function HrScreen({ data, command, busy, onOpenResults, readOnly = false }: { data: HiringData; command: Command; busy: boolean; onOpenResults: () => void; readOnly?: boolean }) {
  const [resume, setResume] = useState<string | null>(null);
  // A new clock for each data load, so the week and the link states do not go stale.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const now = useMemo(() => new Date(), [data]);
  const byId = useMemo(() => new Map(data.candidates.map((c) => [c.id, c])), [data.candidates]);
  const rows = data.callOrder.flatMap((id) => byId.get(id) ?? []);
  const week = weekCalls(data.calls, data.candidates, now);
  const decisions = openHeadDecisions(data.headDecisions, data.decisions);
  const jump = (id: string) => document.getElementById(`call-${id}`)?.scrollIntoView({ behavior: "smooth", block: "center" });
  const act = (c: HiringCandidate, result: "good" | "no_answer" | "bad") => {
    if (result === "bad" && !window.confirm(`Stop ${c.name}? Nothing is sent to them, and they leave every queue.`)) return;
    void command(callCommand(c, result));
  };
  return (
    <div className={r.screen}>
      <TodayCalls data={data} command={command} busy={busy} readOnly={readOnly} />
      <Section title="My week: booked calls">
        <div className={r.week}>
          {week.map((day) => (
            <div key={day.date} className={r.day} data-today={day.today ? "" : undefined}>
              <p className={r.dayName}>
                {shortDay(day.date)}
                <span className={r.count}>{day.calls.length}</span>
              </p>
              {day.calls.map((call) => (
                <button key={`${call.candidateId}${call.time}`} type="button" className={r.slot} onClick={() => jump(call.candidateId)}>
                  <b>{call.time}</b> {call.name}
                </button>
              ))}
              {!day.calls.length && <p className={r.quiet}>No calls</p>}
            </div>
          ))}
        </div>
      </Section>

      {decisions.length > 0 && (
        <Section title="Tutor recommendations" count={decisions.length}>
          <div className={r.cards}>
            {decisions.map((d) => (
              <article key={d.candidateId} className={r.card} data-tone={d.decision}>
                <div className={r.cardMain}>
                  <p className={r.name}>{byId.get(d.candidateId!)?.name ?? "Candidate"}</p>
                  <p className={r.meta}>
                    <span className={r.tag} data-tone={d.decision}>
                      {d.decision === "hire" ? "Yes" : "No"}
                    </span>
                    {d.head} · {d.reason || "No reason given"}
                  </p>
                  {d.draftProblem && <p className={r.warn}>No email draft yet: {d.draftProblem}</p>}
                </div>
                <div className={r.actions}>
                  {!readOnly && d.decision === "hire" && d.candidateId && (data.reviewAccess?.hr || data.reviewAccess?.gift)
                    ? <FinalReview id={d.candidateId} />
                    : <button type="button" className={r.big} disabled={readOnly} onClick={onOpenResults}>Open assessment</button>}
                </div>
              </article>
            ))}
          </div>
        </Section>
      )}

      <Section title="To call" count={rows.length}>
        {!rows.length && <p className={r.quiet}>Nobody is waiting for a call.</p>}
        <div className={r.cards}>
          {rows.map((c, index) => {
            const subjects = callSubjects(c, data.config.subjectPriority);
            const state = callState(c.id, data.calls, data.inviteOutbox, now);
            return (
              <article key={c.id} id={`call-${c.id}`} className={r.card}>
                <div className={r.cardMain}>
                  <p className={r.name}>
                    <span className={r.order}>{index + 1}</span>
                    {c.name}
                    {c.profileScore !== null && <span className={r.score}>{Math.round(c.profileScore)}</span>}
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
                  <ResumeButton open={resume === c.id} onToggle={() => setResume(resume === c.id ? null : c.id)} name={c.name} />
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
                {resume === c.id && <ResumePeek candidate={c} months={data.config.resumeRetentionMonths} />}
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
    const time = formatInTimeZone(now, ZONE, "HH:mm");
    /** True when the mock has started, so the head can score it. */
    const started = (row: RunSheetRow) => !!row.mockStart && (row.date < today || (row.date === today && row.mockStart <= time));
    return { rows, today, started, coming: upcoming(rows, today), recent: pastVisits(rows, today) };
  }, [data]);
}
const clock = (row: RunSheetRow) => row.paperStart ?? row.mockStart ?? "";
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
              <AdminCard key={row.visitId} row={{ ...row, paper: null }} data={data} reload={reload} readOnly={readOnly} onOpenResults={onOpenResults} />
            ))}
          </div>
        </Section>
      )}
      {!coming.length && <p className={r.quiet}>No candidate visit is booked from today.</p>}
      {byDay(coming).map((day) => (
        <Section key={day.date} title={dayTitle(day.date, today)} count={day.rows.length}>
          <div className={r.cards}>
            {day.rows.map((row) => (
              <AdminCard key={row.visitId} row={row} data={data} reload={reload} readOnly={readOnly} onOpenResults={onOpenResults} />
            ))}
          </div>
        </Section>
      ))}
    </div>
  );
}

// ─── Heads ───

const HEAD_KEY = "hiring-head";

function HeadCard({ row, data, past, readOnly }: { row: RunSheetRow; data: HiringData; past: boolean; readOnly: boolean }) {
  const [resume, setResume] = useState(false);
  const candidate = data.candidates.find((c) => c.id === row.candidateId);
  const mock = data.bookings.find((b) => b.kind === "mock" && b.status === "confirmed" && (b.visitId ?? b.id) === row.visitId);
  const path = mock ? data.briefPaths[mock.id] : undefined;
  const scored = data.mocks.some((m) => m.candidateId === row.candidateId && m.source !== "tracker" && (m.status === "done" || m.status === "needs_check"));
  const decision = data.headDecisions.find((d) => d.candidateId === row.candidateId);
  return (
    <article className={r.card}>
      <p className={r.time}>
        {row.mockStart ?? row.paperStart}
        <span>{shortDay(row.date)}</span>
      </p>
      <div className={r.cardMain}>
        <p className={r.name}>{row.candidateName}</p>
        <p className={r.meta}>
          {row.subject ?? "Subject not recorded"} · {row.mockStart ? "You run the mock" : "Paper only: no mock"}
        </p>
        <p className={r.meta}>
          {scored && (
            <span className={r.tag} data-tone="hire">
              Scores sent
            </span>
          )}
          {decision && (
            <span className={r.tag} data-tone={decision.decision}>
              Decision: {decision.decision === "hire" ? "Hire" : "Do not hire"}
            </span>
          )}
        </p>
      </div>
      <div className={r.actions}>
        {candidate && <ResumeButton open={resume} onToggle={() => setResume(!resume)} name={row.candidateName} />}
        {path && !readOnly && (
          <a className={r.big} data-tone={past ? "hire" : undefined} href={path} target="_blank" rel="noopener noreferrer">
            {past ? "Score and decide" : "Open the candidate page"}
          </a>
        )}
      </div>
      {resume && candidate && <ResumePeek candidate={candidate} months={data.config.resumeRetentionMonths} />}
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
  const { rows, today, started, recent } = useVisits(data);
  const head = heads.find((h) => h.canonicalKey === key);
  // Started mocks first: they wait for scores and a decision. Same rule as headVisits for whose visit it is.
  const done = head ? recent.filter((row) => row.hod?.key === head.canonicalKey && row.mockStart).slice(0, 6) : [];
  const coming = head ? headVisits(rows, head.canonicalKey, today) : [];
  return (
    <div className={r.screen}>
      <div className={r.picker} role="group" aria-label="Choose your name">
        {heads.map((h) => (
          <button key={h.canonicalKey} type="button" aria-pressed={h.canonicalKey === key} onClick={() => choose(h.canonicalKey)}>
            {headName(h.canonicalKey, data.tutors)}
          </button>
        ))}
      </div>
      {!head ? (
        <p className={r.quiet}>Choose your name to see your candidates.</p>
      ) : (
        <>
          <Section title="Coming to you" count={coming.length}>
            {!coming.length && <p className={r.quiet}>No candidate is booked with you.</p>}
            <div className={r.cards}>
              {coming.map((row) => (
                <HeadCard key={row.visitId} row={row} data={data} past={started(row)} readOnly={readOnly} />
              ))}
            </div>
          </Section>
          {done.length > 0 && (
            <Section title="After the mock: score and decide" count={done.length}>
              <div className={r.cards}>
                {done.map((row) => (
                  <HeadCard key={row.visitId} row={row} data={data} past readOnly={readOnly} />
                ))}
              </div>
            </Section>
          )}
        </>
      )}
    </div>
  );
}
