"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { RESUME_TYPES } from "@/lib/hiring/model";
import { universityName } from "@/lib/hiring/seek-view";
import type { Command, HiringCandidate, HiringData } from "./dashboard";
import { PhoneLink, ResumeBody, SourceTextBody, useResumeCheck, useSourceText } from "./candidate-inspector";
import { callSubjects } from "./calls-screen";
import css from "./dashboard.module.css";

export type DeckChoice = "reject" | "keep";
export const RESUME_REJECT_REASON = "Rejected on the résumé before the pre-screen form.";
const KEPT_KEY = "hiring-resume-deck-kept";

/** A reject is the existing Stop, so its rules stay in one place. It sends nothing to the candidate. */
export function rejectCommand(candidate: Pick<HiringCandidate, "id" | "revision" | "subjects">) {
  return { action: "stop", id: candidate.id, revision: candidate.revision, subjects: candidate.subjects, reason: RESUME_REJECT_REASON };
}

const FLY_MS = 260;
/** Where a drag ends: left rejects, right keeps, a short drag does nothing. A fast flick (pixels per millisecond) needs less distance. */
export function swipeChoice(dx: number, width: number, speed = 0): DeckChoice | null {
  const limit = Math.abs(speed) > 0.6 && dx * speed > 0 ? 40 : Math.min(140, width * 0.25);
  return dx <= -limit ? "reject" : dx >= limit ? "keep" : null;
}

/** The top card and the one below it: the first two candidates, in the Calls order, with no choice yet. */
export function nextCards<T extends { id: string }>(rows: T[], choices: ReadonlyMap<string, DeckChoice>) {
  return rows.filter((row) => !choices.has(row.id)).slice(0, 2);
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
  const [sending, setSending] = useState(false);
  const [failed, setFailed] = useState(0);
  // The revision of each card when HR rejected it. A record that changed since then is refused by the server.
  const [seen, setSeen] = useState<Map<string, number>>(new Map());
  const deck = useRef<HTMLDivElement>(null);
  const stage = useRef<HTMLDivElement>(null);
  // Two marks, about 60 ms apart, of where the pointer was: the speed at release is not one noisy sample.
  const gesture = useRef<{ x: number; y: number; active: boolean; markX: number; markT: number; oldX: number; oldT: number } | null>(null);
  // True from the moment a card starts to fly off until the next card is on top.
  const leaving = useRef(false);
  // The same fact as state: Undo, Confirm and the buttons wait until the flying card's choice is recorded.
  const [flying, setFlying] = useState(false);
  const swipe = useRef<(choice: DeckChoice) => void>(() => {});

  useEffect(() => deck.current?.focus(), []);

  // The card below shows as the top card moves, with its file already drawn.
  const upcoming = nextCards(rows, choices);
  const card = upcoming[0];
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
    leaving.current = false;
    setFlying(false);
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
  const locked = busy || sending || flying;

  /** The card follows the pointer through two CSS numbers, so a drag draws no React frame and no PDF again. */
  const move = (x: number, dragging = false) => {
    const el = stage.current;
    if (!el) return;
    el.style.setProperty("--x", String(x));
    el.style.setProperty("--p", String(Math.min(1, Math.abs(x) / 140)));
    el.toggleAttribute("data-dragging", dragging);
  };
  /** The card flies off its side, then the choice is recorded. Buttons, arrow keys and swipes all end here. */
  const fly = (choice: DeckChoice) => {
    if (!card || locked || leaving.current) return;
    leaving.current = true;
    setFlying(true);
    const id = card.id;
    move((choice === "keep" ? 1 : -1) * (window.innerWidth + 200));
    const still = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    window.setTimeout(() => choose(id, choice), still ? 0 : FLY_MS);
  };
  // Before the browser paints a new top card, the stage goes back to the centre.
  useLayoutEffect(() => {
    move(0);
  }, [card?.id]);
  // In the same step as the new card, so a trackpad swipe never reaches the card that just left.
  useLayoutEffect(() => {
    swipe.current = fly;
  });
  // A two-finger sideways swipe on a laptop trackpad moves the card, as a finger does on a phone.
  const hasCard = Boolean(card);
  useEffect(() => {
    const el = stage.current;
    if (!el) return;
    let x = 0;
    let quiet = 0;
    // shortcut: after a swipe, the trackpad's coasting is ignored until it stops, so a second swipe in the same
    // half second does nothing; read the wheel's acceleration if HR swipes faster than that.
    let spent = false;
    const onWheel = (e: WheelEvent) => {
      if (Math.abs(e.deltaX) <= Math.abs(e.deltaY)) return;
      // Without this, Safari and Chrome read the swipe as "go back a page".
      e.preventDefault();
      window.clearTimeout(quiet);
      quiet = window.setTimeout(() => {
        if (!spent && !leaving.current) move(0);
        x = 0;
        spent = false;
      }, 140);
      if (spent || leaving.current) return;
      x -= e.deltaX;
      move(x, true);
      const choice = swipeChoice(x, el.offsetWidth);
      if (!choice) return;
      spent = true;
      el.removeAttribute("data-dragging");
      swipe.current(choice);
      // A locked deck refuses the swipe, so the card goes back.
      if (!leaving.current) move(0);
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => {
      el.removeEventListener("wheel", onWheel);
      window.clearTimeout(quiet);
    };
  }, [hasCard]);
  const endDrag = (e: React.PointerEvent, cancelled: boolean) => {
    const g = gesture.current;
    gesture.current = null;
    if (!g?.active) return;
    if (cancelled) return move(0);
    // A pointer that stopped before the release has no speed, so only the distance counts.
    const fresh = e.timeStamp - g.markT < 30;
    const time = e.timeStamp - (fresh ? g.oldT : g.markT);
    const speed = time >= 16 && time < 200 ? (e.clientX - (fresh ? g.oldX : g.markX)) / time : 0;
    const choice = cancelled ? null : swipeChoice(e.clientX - g.x, stage.current?.offsetWidth ?? 0, speed);
    move(0);
    if (choice) fly(choice);
  };

  return (
    <div
      ref={deck}
      className={css.deck}
      tabIndex={-1}
      aria-label="Résumé cards"
      onKeyDown={(e) => {
        if (!card || locked || (e.target as HTMLElement).closest("input, textarea, select, a")) return;
        if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
        // A held key is one choice, not one for each card that comes up.
        if (e.repeat) return;
        // The key moves the card, not the page.
        e.preventDefault();
        fly(e.key === "ArrowLeft" ? "reject" : "keep");
      }}
    >
      <div className={css.deckBar}>
        <p className={css.inspectorMeta}>
          {rows.filter((c) => !choices.has(c.id)).length} left · {kept} kept · {rejected.length} to reject. Swipe a card left to reject, right to keep. The arrow keys do the same.
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

      {card ? (
        <div ref={stage} className={css.deckStage}>
          {upcoming.map((c, i) => {
            const top = i === 0;
            const subjects = callSubjects(c, data.config.subjectPriority);
            return (
              <article
                key={c.id}
                className={css.deckCard}
                data-pos={top ? "top" : "next"}
                // The card below is a picture of what comes next. Nobody can click or tab into it.
                inert={!top}
                aria-hidden={!top}
                onPointerDown={(e) => {
                  const target = e.target as HTMLElement;
                  gesture.current = null;
                  // A mouse drag on the application text selects it.
                  if (locked || leaving.current || e.button !== 0 || target.closest("a, button") || (e.pointerType === "mouse" && target.closest("pre"))) return;
                  gesture.current = { x: e.clientX, y: e.clientY, active: false, markX: e.clientX, markT: e.timeStamp, oldX: e.clientX, oldT: e.timeStamp };
                }}
                onPointerMove={(e) => {
                  const g = gesture.current;
                  if (!g) return;
                  // The button came up outside the card, so that press is over.
                  if (e.buttons === 0) return endDrag(e, true);
                  const dx = e.clientX - g.x;
                  const dy = e.clientY - g.y;
                  if (!g.active) {
                    if (Math.abs(dx) < 8 && Math.abs(dy) < 8) return;
                    // An up-and-down move reads the résumé. Only a sideways move takes the card.
                    if (Math.abs(dy) > Math.abs(dx)) {
                      gesture.current = null;
                      return;
                    }
                    g.active = true;
                    e.currentTarget.setPointerCapture(e.pointerId);
                  }
                  if (e.timeStamp - g.markT > 60) {
                    g.oldX = g.markX;
                    g.oldT = g.markT;
                    g.markX = e.clientX;
                    g.markT = e.timeStamp;
                  }
                  move(dx, true);
                }}
                onPointerUp={(e) => endDrag(e, false)}
                onPointerCancel={(e) => endDrag(e, true)}
              >
                {top && (
                  <>
                    <span className={css.deckStamp} data-choice="keep" aria-hidden>
                      Keep
                    </span>
                    <span className={css.deckStamp} data-choice="reject" aria-hidden>
                      Reject
                    </span>
                  </>
                )}
                <header className={css.deckHandle}>
                  <div>
                    <h2 className={css.deckName}>{c.name}</h2>
                    <PhoneLink phone={c.phone} large />
                    <p className={css.inspectorMeta}>
                      {subjects.main}
                      {subjects.other.length > 0 && `, also ${subjects.other.join(", ")}`} · {universityName(c)}
                    </p>
                    {c.profileAssessment?.briefSummary && <p className={css.inspectorMeta}>{c.profileAssessment.briefSummary}</p>}
                  </div>
                  <p className={css.inspectorScore}>
                    {c.profileScore === null ? "–" : Math.round(c.profileScore)}
                    <span>/100</span>
                  </p>
                </header>
                <ResumeCard candidate={c} data={data} />
                <footer className={css.deckActions}>
                  <button type="button" className={`${css.secondary} ${css.stopButton}`} disabled={locked} onClick={() => fly("reject")}>
                    ← Reject
                  </button>
                  <button type="button" className={css.primary} disabled={locked} onClick={() => fly("keep")}>
                    Keep →
                  </button>
                </footer>
              </article>
            );
          })}
        </div>
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
