"use client";

import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { Check, Circle, Plus } from "lucide-react";
import { GRID_HOURS, hourRanges, WEEK_DAYS, weekHoursCount, type WeekHours } from "@/lib/hiring/week-hours";
import s from "./candidate.module.css";

/** "Mon–Fri 17–21 · Sat 09–10, 11–12": days with the same hours next to each other are said once (Opus r4). */
export function readback(week: WeekHours) {
  const text = week.map((hours) => hourRanges(hours).replaceAll(":00", "").replace(/-/g, "–").replace(/ & /g, ", "));
  const out: string[] = [];
  for (let d = 0; d < 7; ) {
    let e = d;
    while (e + 1 < 7 && text[e + 1] === text[d]) e++;
    if (text[d]) out.push(`${WEEK_DAYS[d]}${e > d ? `–${WEEK_DAYS[e]}` : ""} ${text[d]}`);
    d = e + 1;
  }
  return out.join(" · ");
}

const DAY_NAMES = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
const HOLD_MS = 350;
const SLOP = 8;
const hh = (hour: number) => `${String(hour).padStart(2, "0")}:00`;
const range = (from: number, to: number) => Array.from({ length: to - from }, (_, i) => from + i);
// Quick fills (Mobbin: User Interviews working-hours presets). They only add hours.
const PRESETS = [
  { label: "After school", short: "Mon–Fri 15–17", days: [0, 1, 2, 3, 4], hours: range(15, 17), title: "Monday to Friday, 15:00 to 17:00" },
  { label: "Weeknights", short: "Mon–Fri 17–21", days: [0, 1, 2, 3, 4], hours: range(17, 21), title: "Monday to Friday, 17:00 to 21:00" },
  { label: "Weekends", short: "Sat–Sun 09–17", days: [5, 6], hours: range(9, 17), title: "Saturday and Sunday, 09:00 to 17:00" },
];

/**
 * The candidate's teaching hours: Monday to Sunday, 08:00–21:00, one-hour cells. Tap a cell, or drag across cells with a
 * mouse, a finger or a pen; the first cell decides whether the drag fills or clears. Arrow keys move, Space or Enter
 * switches the focused hour.
 */
export function WeekGrid({ value, onChange, disabled }: { value: WeekHours; onChange: (week: WeekHours) => void; disabled: boolean }) {
  // The latest week, so the many changes of one drag build on each other before React renders again.
  const current = useRef(value);
  useLayoutEffect(() => {
    current.current = value;
  }, [value]);
  // A drag fills or clears the rectangle from the first cell to the cell under the pointer (as in When2meet), on top of
  // the week as it was when the drag began.
  const drag = useRef<{ fill: boolean; from: [number, number]; before: WeekHours } | null>(null);
  const [focus, setFocus] = useState<[number, number]>([0, GRID_HOURS[0]]);
  // The week before the last Clear, for one Undo; any new choice forgets it.
  const [undo, setUndo] = useState<WeekHours | null>(null);
  const undoRef = useRef<HTMLButtonElement>(null);
  const clearRef = useRef<HTMLButtonElement>(null);

  const has = (week: WeekHours, d: number, h: number) => week[d].includes(h);
  function paint(cells: [number, number][], fill: boolean) {
    const next = current.current.map((hours, d) => {
      const set = new Set(hours);
      for (const [cd, ch] of cells) if (cd !== d) continue;
      else if (fill) set.add(ch);
      else set.delete(ch);
      return [...set].sort((a, b) => a - b);
    });
    current.current = next;
    setUndo(null);
    onChange(next);
  }
  const cellOf = (el: Element | null) => {
    const cell = el?.closest<HTMLElement>("[data-cell]");
    return cell ? (cell.dataset.cell!.split(",").map(Number) as [number, number]) : null;
  };
  // A finger first: a tap chooses one hour, a quick swipe scrolls the page (cells allow vertical panning), and a hold
  // starts a drag (code review r4: a full-width grid must not trap the page's scroll on a phone). A mouse or pen drags at once.
  const pending = useRef<{ cell: [number, number]; x: number; y: number; timer: ReturnType<typeof setTimeout> } | null>(null);
  // A pointer already changed the cell; the click the browser sends after it must not change it back (event time, ms).
  const lastPointer = useRef(0);
  function start(cell: [number, number], target: Element | null) {
    const fill = !has(current.current, ...cell);
    // The default focus of a pressed button can scroll the page; focus it without that.
    target?.closest<HTMLElement>("[data-cell]")?.focus({ preventScroll: true });
    drag.current = { fill, from: cell, before: current.current };
    setFocus(cell);
    paint([cell], fill);
  }
  function down(e: PointerEvent<HTMLDivElement>) {
    const cell = cellOf(e.target as Element);
    // One pointer at a time: a second finger never chooses hours on its own (code review r13).
    if (!cell || disabled || e.button > 0 || !e.isPrimary) return;
    if (pending.current) clearTimeout(pending.current.timer);
    // A finger or a pen waits for a hold; the cells let the page pan up and down meanwhile. A mouse drags at once.
    if (e.pointerType !== "mouse") {
      const target = e.target as Element;
      pending.current = {
        cell,
        x: e.clientX,
        y: e.clientY,
        timer: setTimeout(() => {
          pending.current = null;
          start(cell, target);
          navigator.vibrate?.(8);
        }, HOLD_MS),
      };
      return;
    }
    e.preventDefault();
    start(cell, e.target as Element);
    // Capture keeps a mouse drag that leaves the grid.
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {}
  }
  function move(e: PointerEvent<HTMLDivElement>) {
    if (!e.isPrimary) return;
    const wait = pending.current;
    if (wait) {
      // Moved before the hold: this is a scroll, not a choice.
      if (Math.hypot(e.clientX - wait.x, e.clientY - wait.y) > SLOP) cancel();
      return;
    }
    if (!drag.current) return;
    // A mouse released outside the window leaves no pointerup here.
    if (e.pointerType === "mouse" && e.buttons === 0) return up(e);
    const cell = cellOf(document.elementFromPoint(e.clientX, e.clientY));
    if (!cell) return;
    const { fill, from, before } = drag.current;
    const [d0, d1] = [Math.min(from[0], cell[0]), Math.max(from[0], cell[0])];
    const [h0, h1] = [Math.min(from[1], cell[1]), Math.max(from[1], cell[1])];
    const next = before.map((hours, d) => {
      const set = new Set(hours);
      if (d >= d0 && d <= d1)
        for (let h = h0; h <= h1; h++) {
          if (fill) set.add(h);
          else set.delete(h);
        }
      return [...set].sort((a, b) => a - b);
    });
    if (JSON.stringify(next) === JSON.stringify(current.current)) return;
    current.current = next;
    onChange(next);
  }
  function up(e?: PointerEvent<HTMLDivElement>) {
    if (e && !e.isPrimary) return;
    if (e) lastPointer.current = e.timeStamp;
    const wait = pending.current;
    if (wait) {
      // A tap: one hour on or off.
      clearTimeout(wait.timer);
      pending.current = null;
      setFocus(wait.cell);
      paint([wait.cell], !has(current.current, ...wait.cell));
      return;
    }
    drag.current = null;
  }
  function cancel() {
    if (pending.current) clearTimeout(pending.current.timer);
    pending.current = null;
    drag.current = null;
  }
  // While a held drag runs, the finger paints instead of scrolling the page.
  const gridRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const grid = gridRef.current;
    if (!grid) return;
    const stop = (e: TouchEvent) => {
      if (drag.current && e.cancelable) e.preventDefault();
    };
    grid.addEventListener("touchmove", stop, { passive: false });
    const hold = pending;
    return () => {
      grid.removeEventListener("touchmove", stop);
      // A hold still waiting when the questions close must not paint afterwards.
      if (hold.current) clearTimeout(hold.current.timer);
    };
  }, []);
  function key(e: KeyboardEvent<HTMLButtonElement>, d: number, h: number) {
    const moves: Record<string, [number, number]> = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
    const step = moves[e.key];
    if (!step) return;
    e.preventDefault();
    const nd = Math.min(6, Math.max(0, d + step[0]));
    const nh = Math.min(GRID_HOURS.at(-1)!, Math.max(GRID_HOURS[0], h + step[1]));
    setFocus([nd, nh]);
    e.currentTarget.closest("[data-week-grid]")?.querySelector<HTMLButtonElement>(`[data-cell="${nd},${nh}"]`)?.focus();
  }
  // A quick fill adds its hours; when all of them are in, a second tap removes them (Opus r10).
  function preset(p: (typeof PRESETS)[number]) {
    const cells = p.days.flatMap((d) => p.hours.map((h) => [d, h] as [number, number]));
    paint(cells, !cells.every((cell) => has(current.current, ...cell)));
  }
  const count = weekHoursCount(value);
  const weekend = value[5].length + value[6].length > 0;
  const late = value.slice(0, 5).some((hours) => hours.some((h) => h >= 15));
  return (
    <div className={s.week}>
      {/* The rule, fixed above the grid; the live ticks stay under it, where their changes move nothing (Sol r18). */}
      {/* The how-to waits behind a disclosure; the hours themselves are the cue (Sol r23). */}
      <div className={s.gridHead}>
        <p className={s.hint}>Bangkok time</p>
        <details className={s.how}>
          <summary>How to choose hours</summary>
          <p>Tap an hour. To fill a block, hold, then drag. Start on a chosen hour to clear.</p>
        </details>
      </div>
      <div className={s.presets} role="group" aria-label="Quick fill">
        {PRESETS.map((p) => {
          // Add only; a check once every hour of it is in the week (Sol r6).
          const full = p.days.every((d) => p.hours.every((h) => has(value, d, h)));
          return (
            <button
              key={p.label}
              type="button"
              className={s.preset}
              data-full={full || undefined}
              aria-pressed={full}
              aria-label={`${p.label}: ${p.title}`}
              title={p.title}
              disabled={disabled}
              onClick={() => preset(p)}
            >
              {full ? <Check aria-hidden size={14} /> : <Plus aria-hidden size={14} />}
              {p.label}
              {/* The hours it adds, before the tap (Sol r5). */}
              <small aria-hidden>{p.short}</small>
            </button>
          );
        })}
      </div>
      <div
        className={s.grid}
        data-week-grid=""
        role="group"
        aria-label="Hours you can teach onsite, Monday to Sunday"
        aria-describedby="week-grid-keys"
        aria-disabled={disabled || undefined}
        onPointerDown={down}
        onPointerMove={move}
        ref={gridRef}
        onPointerUp={up}
        onPointerCancel={cancel}
        onContextMenu={(e) => e.preventDefault()}
      >
        <span aria-hidden />
        {WEEK_DAYS.map((day, d) => (
          <span key={day} aria-hidden className={s.dayHead} data-weekend={d > 4 || undefined}>
            {day}
          </span>
        ))}
        {GRID_HOURS.map((h) => (
          <div key={h} className={s.row} data-hour={h}>
            <span aria-hidden className={s.hour}>
              {hh(h).slice(0, 2)}
            </span>
            {WEEK_DAYS.map((day, d) => (
              <button
                key={day}
                type="button"
                data-cell={`${d},${h}`}
                className={s.cell}
                data-weekend={d > 4 || undefined}
                // A line at 15:00 across the weekdays shows where the "weekday at or after 15:00" rule starts (Sol r20).
                data-from15={(d < 5 && h === 15) || undefined}
                aria-pressed={has(value, d, h)}
                aria-label={`${DAY_NAMES[d]} ${hh(h)} to ${hh(h + 1)}`}
                tabIndex={focus[0] === d && focus[1] === h ? 0 : -1}
                disabled={disabled}
                onKeyDown={(e) => key(e, d, h)}
                // Space, Enter, screen readers and switch access press a cell with a click (code review r23); a click
                // that follows a pointer tap or drag is skipped, because the pointer already changed the cell.
                onClick={(e) => {
                  // detail 0: a key or an assistive tool pressed the cell, never a pointer.
                  if (e.detail > 0 && e.timeStamp - lastPointer.current < 800) return;
                  setFocus([d, h]);
                  paint([[d, h]], !has(current.current, d, h));
                }}
                onFocus={() => setFocus([d, h])}
              />
            ))}
          </div>
        ))}
        {/* The end of the last hour, so "17–21" in the readback matches a label (Opus r5). */}
        <span aria-hidden className={s.hourEnd}>
          21
        </span>
      </div>
      {/* Below the grid: its height can change while a finger drags, and nothing below the finger may move. */}
      <div className={s.readback} aria-live="polite">
        {count > 0 && (
          <p className={s.readline}>
            <span>
              {readback(value)} · <b>{count} h</b>
            </span>
            <button
              ref={clearRef}
              type="button"
              className={s.clear}
              disabled={disabled}
              onClick={() => {
                setUndo(value);
                onChange(WEEK_DAYS.map(() => []));
                // The Clear button goes away: keyboard focus moves to Undo (Sol r6).
                requestAnimationFrame(() => undoRef.current?.focus());
              }}
            >
              Clear
            </button>
          </p>
        )}
        {/* The line is always there, so the grid below never moves when the first hour is chosen. */}
        {count === 0 && undo && (
          <p className={s.readline}>
            <span>Cleared.</span>
            <button
              ref={undoRef}
              type="button"
              className={s.clear}
              disabled={disabled}
              onClick={() => {
                onChange(undo);
                setUndo(null);
                requestAnimationFrame(() => clearRef.current?.focus());
              }}
            >
              Undo
            </button>
          </p>
        )}
        <p className={s.rules}>
          {/* What the booking asks for: a note to add, then a tick once the grid has it (Sol r2: not radio-like). */}
          {/* Says what to add until each rule is met, then a green tick (Sol r22); inside the live readback, so it is announced. */}
          <span data-ok={weekend || undefined}>
            {weekend ? <Check aria-hidden size={14} /> : <Circle aria-hidden size={14} />}
            {weekend ? "Weekend hour added" : "Add a weekend hour"}
          </span>
          <span data-ok={late || undefined}>
            {late ? <Check aria-hidden size={14} /> : <Circle aria-hidden size={14} />}
            {late ? "Weekday hour from 15:00 added" : "Add a weekday hour from 15:00"}
          </span>
        </p>
      </div>

      {/* Read by screen readers always; shown when the keyboard reaches the grid (Opus r13). */}
      <p id="week-grid-keys" className={s.keysHint}>
        Arrows move. Space chooses.
      </p>

    </div>
  );
}
