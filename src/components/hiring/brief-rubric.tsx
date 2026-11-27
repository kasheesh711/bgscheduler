import { useEffect, useRef, useState, type CSSProperties } from "react";
import { ITEM_MAX, RUBRIC, RUBRIC_ITEMS, stressSuggestion, type MockRubric, type RubricItem, type StressTicks } from "@/lib/hiring/marking-sheet";
import { BAND_LABELS, RUBRIC_GUIDE, STRESS_ELEMENTS } from "@/lib/hiring/rubric-guide";
import type { BriefPending } from "./brief";
import c from "./booking.module.css";
import b from "./brief.module.css";

const SCORES = Array.from({ length: ITEM_MAX }, (_, index) => index + 1);
// The printed levels are 1, 4, 7 and 10. A score between two levels takes the colour of the nearer one.
const band = (score: number) => (score >= 9 ? 3 : score >= 6 ? 2 : score >= 3 ? 1 : 0);
const LEVELS = BAND_LABELS.map((label, index) => ({ label, index })).reverse();
type Draft = { items: Partial<Record<RubricItem, number>>; comments: string; ticks: StressTicks };

/** The interviewer's score form for one mock. The server checks the scores again and calculates the total. */
export function BriefRubric({ saved, form, url, editCount, lastSent, decisionSent, pending, setPending, onEdit, onSent, onDiscard }: {
  saved: MockRubric | null;
  form: "wait" | "open" | "closed";
  url: string;
  editCount: number;
  lastSent: { total: number; max: number; editCount: number } | null;
  decisionSent: boolean;
  pending: BriefPending;
  setPending: (pending: BriefPending) => void;
  onEdit: () => void;
  onSent: (total: number) => void;
  onDiscard: () => void;
}) {
  const [items, setItems] = useState<Partial<Record<RubricItem, number>>>(() => Object.fromEntries(RUBRIC_ITEMS.flatMap((id) => (saved?.items[id] ? [[id, saved.items[id]]] : []))));
  const [comments, setComments] = useState(saved?.comments ?? "");
  const [ticks, setTicks] = useState<StressTicks>(() => saved?.stressTest ?? { listens: false, explains: false, plan: false });
  const [ticksUsed, setTicksUsed] = useState(() => !!saved?.stressTest && Object.values(saved.stressTest).some(Boolean));
  const [state, setState] = useState<"idle" | "sent">("idle");
  const [editing, setEditing] = useState(!lastSent);
  const [error, setError] = useState("");
  const [open, setOpen] = useState<RubricItem | null>(null);
  // Scores that are not sent yet stay in this browser, so a reload in the middle of a mock does not lose them.
  const draftKey = `hiring-brief-draft:${url}`;
  const restored = useRef(false);
  // Changes to scores already sent are kept for this tab only (sessionStorage), so opening another row and coming back
  // does not lose them, and no copy stays on a shared device (Sol and critic reviews, round 18).
  const editedAfterSend = lastSent !== null && lastSent.editCount !== editCount;
  const apply = (draft: Partial<Draft>) => {
    const score = (id: RubricItem) => Number(draft.items?.[id]);
    setItems(Object.fromEntries(RUBRIC_ITEMS.filter((id) => Number.isInteger(score(id)) && score(id) >= 1 && score(id) <= ITEM_MAX).map((id) => [id, score(id)])));
    setComments(typeof draft.comments === "string" ? draft.comments : "");
    const kept = { listens: !!draft.ticks?.listens, explains: !!draft.ticks?.explains, plan: !!draft.ticks?.plan };
    setTicks(kept);
    setTicksUsed(Object.values(kept).some(Boolean));
  };
  // Sent scores compared by value, whether they came from the server or from this form's own send.
  const baseOf = (sent: Partial<Draft> | null) => sent && JSON.stringify({ items: RUBRIC_ITEMS.map((id) => Number(sent.items?.[id]) || 0), comments: sent.comments ?? "" });
  // The scores last sent, so "Discard changes" can put them back.
  const sentCopy = useRef<Partial<Draft> | null>(saved ? { items: saved.items as Draft["items"], comments: saved.comments, ticks: saved.stressTest } : null);
  useEffect(() => {
    const read = (store: Storage) => {
      const draft = JSON.parse(store.getItem(draftKey) ?? "null") as (Partial<Draft> & { base?: string | null }) | null;
      return draft && typeof draft.items === "object" && draft.items ? draft : null;
    };
    try {
      // Sent scores come from the server. A copy left from an edit after a send must not stay on a shared device.
      if (saved) localStorage.removeItem(draftKey);
      if (!restored.current) {
        restored.current = true;
        const edit = read(sessionStorage);
        // Only over scores that were sent, and only while they can still change: with none on the server, a sent
        // recommendation or a closed form, the copy is stale (critic and code reviews, rounds 19–20). It must also have
        // been made over the scores the server has now, not over scores another device has since replaced (round 25).
        if (edit && lastSent && !decisionSent && form !== "closed" && edit.base === baseOf(sentCopy.current)) {
          apply(edit);
          setEditing(true);
          onEdit();
        } else if (edit) sessionStorage.removeItem(draftKey);
        if (!edit && !saved) {
          const draft = read(localStorage);
          if (draft) apply(draft);
        }
      } else if (state !== "sent") {
        if (editedAfterSend) sessionStorage.setItem(draftKey, JSON.stringify({ items, comments, ticks, base: baseOf(sentCopy.current) }));
        else if (!lastSent) localStorage.setItem(draftKey, JSON.stringify({ items, comments, ticks } satisfies Draft));
      }
    } catch {
      // Private mode or a full store: the form still works, without the copy.
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- onEdit is a new function each render; it runs once, on restore
  }, [draftKey, saved, state, items, comments, ticks, editedAfterSend, lastSent]);
  const feedback = useRef<HTMLParagraphElement>(null);
  const summary = useRef<HTMLDivElement>(null);
  const firstScore = useRef<HTMLInputElement>(null);
  const sendBar = useRef<HTMLDivElement>(null);
  const sentTotal = lastSent?.editCount === editCount ? lastSent.total : null;
  // After a change to sent scores: put the sent scores back and drop the tab copy (critic review, round 19).
  const discard = () => {
    // Not while scores are sending: the send would then show one total while the form holds another (code review, round 25).
    if (pending) return;
    if (sentCopy.current) apply(sentCopy.current);
    try {
      sessionStorage.removeItem(draftKey);
    } catch {
      // No store, so no copy to remove.
    }
    setEditing(false);
    setState("sent");
    onDiscard();
  };
  // Unscored sliders (value 0), read afresh on each click. The button shows while any score is blank and goes to the
  // first one in the form, so none is skipped, and focuses it (Sol review, rounds 15–18).
  const unscored = () => [...(sendBar.current?.closest("form")?.querySelectorAll<HTMLInputElement>('input[type="range"]') ?? [])]
    .filter((range) => range.value === "0");
  useEffect(() => {
    if (state !== "sent" && !error) {
      if (editing && sentTotal !== null) firstScore.current?.focus();
      return;
    }
    const message = summary.current ?? feedback.current;
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    // "nearest" keeps the header (with when to recommend) in view after a send during the mock (critic review, round 13).
    message?.scrollIntoView({ block: error ? "center" : "nearest", behavior: error && !reducedMotion ? "smooth" : "instant" });
    message?.focus({ preventScroll: true });
  }, [state, error, editing, sentTotal]);
  if (!decisionSent && form === "closed") return <p className={c.note}>Scores are recorded. Ask admin to edit scores.</p>;
  const scored = RUBRIC_ITEMS.filter((id) => items[id]).length;
  const complete = scored === RUBRIC_ITEMS.length;
  const disabled = !complete || !!pending || sentTotal !== null;
  // An old 10-item send is out of 100.
  const percent = (sent: { total: number; max: number }) => Math.round((sent.total / sent.max) * 100);
  const sentMessage = lastSent ? `Scores sent. ${lastSent.total}/${lastSent.max} (${percent(lastSent)}%).` : "";
  const saveError = error && <p ref={feedback} role="alert" className={c.alert} tabIndex={-1}>{error}</p>;
  function selectScore(id: RubricItem, score: number) {
    if (items[id] === score) return;
    setItems({ ...items, [id]: score });
    onEdit();
    if (state === "sent") setState("idle");
  }
  function changed() {
    onEdit();
    if (state === "sent") setState("idle");
  }
  async function send() {
    setPending("scores");
    setError("");
    try {
      const response = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ items, comments, stressTest: ticks }) });
      const body = (await response.json().catch(() => ({}))) as { total?: number; error?: string };
      if (!response.ok || typeof body.total !== "number") setError(body.error ?? "The scores were not saved. Try again.");
      else {
        sentCopy.current = { items, comments, ticks };
        try {
          localStorage.removeItem(draftKey);
          sessionStorage.removeItem(draftKey);
        } catch {
          // No store, so no copy to remove.
        }
        setEditing(false);
        setState("sent");
        // Back to the top of the brief, so its header (when to recommend) shows above the short receipt (critic review, round 14).
        sendBar.current?.closest("main")?.scrollTo({ top: 0 });
        onSent(body.total);
      }
    } catch {
      setError("The scores were not saved. Check your connection, then try again.");
    } finally {
      setPending(null);
    }
  }
  if (decisionSent || (!editing && sentTotal !== null)) {
    return (
      <div ref={summary} role="group" aria-label={sentMessage || undefined} className={c.scoreSummary} tabIndex={-1}>
        {lastSent && <p aria-hidden="true">
          {decisionSent ? <span className="sr-only">Scores sent </span> : "Scores sent · "}
          <strong>{lastSent.total}/{lastSent.max}</strong> · {percent(lastSent)}%
        </p>}
        {decisionSent ? <p className={c.note}>Ask admin to edit scores.</p> : <div className={c.scoreActions}>
          <button type="button" className={c.ghost} disabled={!!pending} onClick={() => {
            setEditing(true);
            setState("idle");
          }}>
            Edit scores
          </button>
        </div>}
        {saveError}
      </div>
    );
  }
  return (
    <form
      className={c.field}
      onFocus={(event) => {
        const bar = sendBar.current;
        if (!bar || bar.contains(event.target)) return;
        const row = event.target.closest(`.${b.row}, label`) ?? event.target;
        const bounds = row.getBoundingClientRect();
        const sticky = bar.getBoundingClientRect();
        // A browser can skip its focus scroll when a control is already in the viewport.
        if (bounds.bottom > sticky.top && bounds.top < sticky.bottom) {
          row.scrollIntoView({ block: "center", behavior: "instant" });
        }
      }}
      onSubmit={(event) => {
        event.preventDefault();
        if (!disabled) void send();
      }}
    >
      <div className={b.row} aria-hidden="true">
        {/* The numbers under each slider are not labels only; a click on one or a drag sets the score (Sol review, round 14). */}
        <span className={c.note}><span className={b.finePointer}>Click a number or drag</span><span className={b.coarsePointer}>Tap a number or drag</span></span>
        <div className={b.scale}>
          {LEVELS.map(({ label }) => <span key={label}>{label}</span>)}
        </div>
      </div>
      {RUBRIC.map(({ part, items: partItems }) => (
        <fieldset key={part} className={b.part} disabled={!!pending}>
          <legend>{part}</legend>
          {partItems.map(([id, label]) => {
            const selected = items[id] ?? 0;
            return (
              <div key={id}>
                <div className={b.row} data-score-row="">
                  <button type="button" className={b.item} aria-expanded={open === id} aria-label={`${label}: what each level means`} onClick={() => setOpen(open === id ? null : id)}>
                    {label}
                  </button>
                  <div className={b.barLine}>
                    {/* One slider per item (Kevin, 24 Nov 2026). Its first stop is "not scored", then 1–10 with the numbers under it. */}
                    <div className={b.slider} data-band={selected ? band(selected) : undefined} onClick={(event) => {
                      // iOS Safari moves a range input only by dragging the thumb. A tap (not a scroll) fires click.
                      // No change while a send is in flight; the fieldset disables only the input itself (code review, round 20).
                      if (pending || (event.target instanceof HTMLInputElement && event.detail === 0)) return;
                      const box = event.currentTarget.getBoundingClientRect();
                      selectScore(id, Math.max(0, Math.min(ITEM_MAX, Math.round(((event.clientX - box.left - 14) / (box.width - 28)) * ITEM_MAX))));
                    }}>
                      <input
                        type="range"
                        min={0}
                        max={ITEM_MAX}
                        step={1}
                        value={selected}
                        ref={id === RUBRIC_ITEMS[0] ? firstScore : undefined}
                        aria-label={label}
                        aria-valuetext={selected ? `${selected} of ${ITEM_MAX}` : "Not scored"}
                        style={{ "--fill": `${(selected / ITEM_MAX) * 100}%` } as CSSProperties}
                        // Safari does not focus a range input on a click, so the arrow keys would move nothing after it.
                        onPointerDown={(event) => event.currentTarget.focus({ preventScroll: true })}
                        onChange={(event) => selectScore(id, Number(event.target.value))}
                      />
                      <div className={b.sliderNumbers} aria-hidden="true">
                        <span>–</span>
                        {SCORES.map((score) => <span key={score} data-on={score === selected ? "" : undefined}>{score}</span>)}
                      </div>
                    </div>
                    {/* The slider already says its value to a screen reader; this number is for the eye. */}
                    <output className={b.value} aria-hidden="true">{selected || "–"}</output>
                  </div>
                  {id === "stress" && (
                    <div className={b.ticks}>
                      {STRESS_ELEMENTS.map(({ key, label: element }) => (
                        <label key={key}>
                          <input
                            type="checkbox"
                            checked={ticks[key]}
                            onChange={(event) => {
                              setTicks({ ...ticks, [key]: event.target.checked });
                              setTicksUsed(true);
                              changed();
                            }}
                          />
                          {element}
                        </label>
                      ))}
                      {/* Before the head uses the ticks, "Suggested score: 1" reads as advice. It stays once a box was touched, also when all are clear again. */}
                      <span className={c.note} aria-live="polite">
                        {ticksUsed && `Suggested score: ${stressSuggestion(ticks)}.`}
                      </span>
                    </div>
                  )}
                </div>
                {open === id && (
                  <dl className={b.levels}>
                    {LEVELS.map(({ label: level, index }) => (
                      <div key={level}>
                        <dt>{level}</dt>
                        <dd>{RUBRIC_GUIDE[id].bands[index]}</dd>
                      </div>
                    ))}
                    {RUBRIC_GUIDE[id].hint && <p className={c.note}><em>{RUBRIC_GUIDE[id].hint}</em></p>}
                  </dl>
                )}
              </div>
            );
          })}
        </fieldset>
      ))}
      <div className={b.extra}>
        <label className={c.field}>
          Comments
          <textarea
            className={c.input}
            rows={2}
            maxLength={4000}
            disabled={!!pending}
            value={comments}
            onChange={(event) => {
              setComments(event.target.value);
              onEdit();
              if (state === "sent") setState("idle");
            }}
          />
        </label>
      </div>
      {state === "sent" && <p ref={feedback} role="status" className={c.success} tabIndex={-1}>{sentMessage}</p>}
      {saveError}
      <div ref={sendBar} className={`${c.field} ${b.sendBar}`} data-sticky="">
        {sentTotal !== null ? (
          <>
            <button type="button" className={c.ghost} onClick={() => {
              try {
                sessionStorage.removeItem(draftKey);
              } catch {
                // No store, so no copy to remove.
              }
              setEditing(false);
              setState("sent");
            }}>
              Back to sent scores
            </button>
          </>
        ) : (
          <>
            <div className={c.field}>
              <div className={b.countRow}>
                <p role="status" className={lastSent ? undefined : c.note}>{lastSent ? "Score changes not sent."
                    : `${scored}/${RUBRIC_ITEMS.length} scored`}</p>
                {scored < RUBRIC_ITEMS.length && <button type="button" className={b.moreBelow} onClick={() => {
                  const next = unscored()[0];
                  if (!next) return;
                  (next.closest("[data-score-row]") ?? next).scrollIntoView({ block: "center" });
                  next.focus({ preventScroll: true });
                }}>Next unscored</button>}
                {lastSent && sentCopy.current && <button type="button" className={b.discard} disabled={!!pending} onClick={discard}>Discard changes</button>}
              </div>
              <progress className={c.scoreProgress} aria-label="Scores entered" value={scored} max={RUBRIC_ITEMS.length} />
            </div>
            <div className={b.sendEnd}>
              <span className={b.total} aria-label="Total so far">{RUBRIC_ITEMS.reduce((sum, id) => sum + (items[id] ?? 0), 0)}/{RUBRIC_ITEMS.length * ITEM_MAX}</span>
              <button type="submit" className={c.button} disabled={disabled}>
                {pending === "scores" ? "Sending…" : "Send scores"}
              </button>
            </div>
          </>
        )}
      </div>
    </form>
  );
}
