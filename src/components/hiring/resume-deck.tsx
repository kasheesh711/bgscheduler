"use client";

import { useEffect, useRef, useState } from "react";
import { RESUME_TYPES } from "@/lib/hiring/model";
import { universityName } from "@/lib/hiring/seek-view";
import type { Command, HiringCandidate, HiringData } from "./dashboard";
import { ResumeBody, SourceTextBody, useResumeCheck, useSourceText } from "./candidate-inspector";
import { callSubjects } from "./calls-screen";
import css from "./dashboard.module.css";

export type DeckChoice = "reject" | "keep";
export const RESUME_REJECT_REASON = "Rejected on the résumé before the pre-screen form.";
const KEPT_KEY = "hiring-resume-deck-kept";

/** A reject is the existing Stop, so its rules stay in one place. It sends nothing to the candidate. */
export function rejectCommand(candidate: Pick<HiringCandidate, "id" | "revision" | "subjects">) {
  return { action: "stop", id: candidate.id, revision: candidate.revision, subjects: candidate.subjects, reason: RESUME_REJECT_REASON };
}

/** Where a drag ends: left rejects, right keeps, a short drag does nothing. */
export function swipeChoice(dx: number, width: number): DeckChoice | null {
  const limit = Math.min(140, width * 0.25);
  return dx <= -limit ? "reject" : dx >= limit ? "keep" : null;
}

/** The next card: the first candidate, in the Calls order, with no choice yet. */
export function nextCard<T extends { id: string }>(rows: T[], choices: ReadonlyMap<string, DeckChoice>) {
  return rows.find((row) => !choices.has(row.id));
}

// shortcut: kept marks live in this browser only, so another HR computer shows those cards again; move them to the
// candidate record when two people review the same list.
function readKept(): string[] {
  try {
    const value: unknown = JSON.parse(window.localStorage.getItem(KEPT_KEY) ?? "[]");
    return Array.isArray(value) ? value.filter((id): id is string => typeof id === "string") : [];
  } catch {
    return [];
  }
}
function writeKept(choices: ReadonlyMap<string, DeckChoice>) {
  try {
    window.localStorage.setItem(KEPT_KEY, JSON.stringify([...choices].filter(([, c]) => c === "keep").map(([id]) => id)));
  } catch {
    // Storage can be blocked. The deck still works for this visit.
  }
}

function ResumeCard({ candidate, data }: { candidate: HiringCandidate; data: HiringData }) {
  const pdf = candidate.resumeState === "available" && candidate.resumeType === RESUME_TYPES.pdf;
  const check = useResumeCheck(candidate.id, true, candidate.resumeState === "available");
  // A PDF is the card. Any other record shows the text that was read from the application.
  const source = useSourceText(candidate.id, !pdf || check.status === "failed");
  return (
    <div className={css.deckFile}>
      <ResumeBody
        id={candidate.id}
        name={candidate.name}
        state={candidate.resumeState}
        type={candidate.resumeType}
        months={data.config.resumeRetentionMonths}
        check={check}
      />
      {(!pdf || check.status === "failed") && (
        <div className={css.sourceText}>
          <SourceTextBody id={candidate.id} {...source} />
        </div>
      )}
    </div>
  );
}

export function ResumeDeck({
  data,
  rows,
  command,
  busy,
  onClose,
}: {
  data: HiringData;
  rows: HiringCandidate[];
  command: Command;
  busy: boolean;
  onClose: () => void;
}) {
  // The deck opens from a click, so it never renders on the server and can read the browser's kept marks at once.
  const [choices, setChoices] = useState<Map<string, DeckChoice>>(() => new Map(readKept().map((id) => [id, "keep" as const])));
  const [dx, setDx] = useState(0);
  const [sending, setSending] = useState(false);
  const [failed, setFailed] = useState(0);
  // The revision of each card when HR rejected it. A record that changed since then is refused by the server.
  const [seen, setSeen] = useState<Map<string, number>>(new Map());
  const [drag, setDrag] = useState<{ x: number; width: number } | null>(null);
  const deck = useRef<HTMLDivElement>(null);

  useEffect(() => deck.current?.focus(), []);

  const card = nextCard(rows, choices);
  const byId = new Map(rows.map((c) => [c.id, c]));
  const rejected = [...choices].flatMap(([id, choice]) => (choice === "reject" ? (byId.get(id) ?? []) : []));
  const kept = rows.filter((c) => choices.get(c.id) === "keep").length;

  const choose = (id: string, choice: DeckChoice | null) => {
    const next = new Map(choices);
    if (choice) next.set(id, choice);
    else next.delete(id);
    setChoices(next);
    writeKept(next);
    const revision = byId.get(id)?.revision;
    if (choice === "reject" && revision !== undefined) setSeen(new Map(seen).set(id, revision));
    setFailed(0);
    setDx(0);
    // A click moves focus to a button that then leaves the page; the arrow keys need the deck.
    deck.current?.focus();
  };
  const clearKept = () => {
    const next = new Map([...choices].filter(([, choice]) => choice === "reject"));
    setChoices(next);
    writeKept(next);
  };
  /** Stop has no undo, so nothing is written until HR confirms the list. A failed Stop keeps its row in the list. */
  const confirm = async () => {
    const list = rejected;
    if (!window.confirm(`Stop ${list.length} candidate${list.length === 1 ? "" : "s"}? Nothing is sent to them, they leave every queue, and a booked call is cancelled. This cannot be undone here.`)) return;
    setSending(true);
    const done = new Set<string>();
    for (const candidate of list)
      if (await command(rejectCommand({ ...candidate, revision: seen.get(candidate.id) ?? candidate.revision }))) done.add(candidate.id);
    // A refused Stop goes back to the cards, so HR sees the record as it is now before a new choice.
    setChoices((current) => new Map([...current].filter(([id, choice]) => choice === "keep" && !done.has(id))));
    setFailed(list.length - done.size);
    setSending(false);
  };
  const locked = busy || sending;
  const subjects = card ? callSubjects(card, data.config.subjectPriority) : null;
  const lean = card && drag ? swipeChoice(dx, drag.width) : null;

  return (
    <div
      ref={deck}
      className={css.deck}
      tabIndex={-1}
      aria-label="Résumé cards"
      onKeyDown={(e) => {
        if (!card || locked || (e.target as HTMLElement).closest("input, textarea, select, a")) return;
        if (e.key === "ArrowLeft") choose(card.id, "reject");
        if (e.key === "ArrowRight") choose(card.id, "keep");
      }}
    >
      <div className={css.deckBar}>
        <p className={css.inspectorMeta}>
          {rows.filter((c) => !choices.has(c.id)).length} left · {kept} kept · {rejected.length} to reject. Left arrow rejects, right arrow keeps.
        </p>
        <div className={css.decisionActions}>
          {kept > 0 && (
            <button type="button" className={css.secondary} disabled={locked} onClick={clearKept}>
              Show kept cards again
            </button>
          )}
          <button type="button" className={css.secondary} disabled={sending} onClick={onClose}>
            Back to the list
          </button>
        </div>
      </div>

      {card && subjects ? (
        <article
          className={css.deckCard}
          data-lean={lean ?? undefined}
          style={dx ? { transform: `translateX(${dx}px) rotate(${dx / 40}deg)`, transition: "none" } : undefined}
        >
          <header
            className={css.deckHandle}
            onPointerDown={(e) => {
              if (locked || e.button !== 0) return;
              setDrag({ x: e.clientX, width: e.currentTarget.offsetWidth });
              e.currentTarget.setPointerCapture(e.pointerId);
            }}
            onPointerMove={(e) => drag && setDx(e.clientX - drag.x)}
            onPointerUp={(e) => {
              if (!drag) return;
              const choice = swipeChoice(e.clientX - drag.x, drag.width);
              setDrag(null);
              if (choice) choose(card.id, choice);
              else setDx(0);
            }}
            onPointerCancel={() => {
              setDrag(null);
              setDx(0);
            }}
          >
            <div>
              <h2 className={css.deckName}>{card.name}</h2>
              <p className={css.inspectorMeta}>
                {subjects.main}
                {subjects.other.length > 0 && `, also ${subjects.other.join(", ")}`} · {universityName(card)}
              </p>
              {card.profileAssessment?.briefSummary && <p className={css.inspectorMeta}>{card.profileAssessment.briefSummary}</p>}
            </div>
            <p className={css.inspectorScore}>
              {card.profileScore === null ? "–" : Math.round(card.profileScore)}
              <span>/100</span>
            </p>
          </header>
          <ResumeCard key={card.id} candidate={card} data={data} />
          <footer className={css.deckActions}>
            <button type="button" className={`${css.secondary} ${css.stopButton}`} disabled={locked} onClick={() => choose(card.id, "reject")}>
              ← Reject
            </button>
            <button type="button" className={css.primary} disabled={locked} onClick={() => choose(card.id, "keep")}>
              Keep →
            </button>
          </footer>
        </article>
      ) : (
        <p className={css.empty}>
          {rows.length ? "No cards are left. Confirm the rejections below, or go back to the list." : "Nobody is waiting for a call."}
        </p>
      )}

      {failed > 0 && (
        <p role="alert" className={css.errorText}>
          {failed} candidate{failed === 1 ? " was" : "s were"} not stopped, because the record changed or has an appointment. {failed === 1 ? "The card is" : "The cards are"} back in the deck.
        </p>
      )}
      {rejected.length > 0 && (
        <section className={css.deckPending} aria-label="Candidates to reject">
          <div className={css.decisionActions}>
            <button type="button" className={css.primary} disabled={locked} onClick={() => void confirm()}>
              {sending ? "Stopping…" : `Confirm ${rejected.length} rejection${rejected.length === 1 ? "" : "s"}`}
            </button>
            <span className={css.inspectorMeta}>Nothing is written until you confirm. A stopped candidate gets no message.</span>
          </div>
          <ul>
            {rejected.map((c) => (
              <li key={c.id}>
                {c.name}
                <button type="button" className={css.sourceLink} disabled={locked} onClick={() => choose(c.id, null)}>
                  Undo
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
