"use client";

import { useLayoutEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { Check, Plus } from "lucide-react";
import { GRID_HOURS, hourRanges, WEEK_DAYS, weekHoursCount, type WeekHours } from "@/lib/hiring/week-hours";
import s from "./candidate.module.css";

const DAY_NAMES = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
const hh = (hour: number) => `${String(hour).padStart(2, "0")}:00`;
const range = (from: number, to: number) => Array.from({ length: to - from }, (_, i) => from + i);
// Quick fills (Mobbin: User Interviews working-hours presets). A second tap on a full preset clears it.
const PRESETS = [
  { label: "Weekday evenings", days: [0, 1, 2, 3, 4], hours: range(17, 21) },
  { label: "Weekday afternoons", days: [0, 1, 2, 3, 4], hours: range(15, 17) },
  { label: "Weekends", days: [5, 6], hours: range(9, 17) },
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
  const [focus, setFocus] = useState<[number, number]>([0, 0]);
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
    onChange(next);
  }
  const cellOf = (el: Element | null) => {
    const cell = el?.closest<HTMLElement>("[data-cell]");
    return cell ? (cell.dataset.cell!.split(",").map(Number) as [number, number]) : null;
  };
  function down(e: PointerEvent<HTMLDivElement>) {
    const cell = cellOf(e.target as Element);
    if (!cell || disabled || e.button > 0) return;
    e.preventDefault();
    const fill = !has(current.current, ...cell);
    // The default focus of a pressed button can scroll the page; focus it without that.
    (e.target as HTMLElement).closest<HTMLElement>("[data-cell]")?.focus({ preventScroll: true });
    drag.current = { fill, from: cell, before: current.current };
    setFocus(cell);
    paint([cell], fill);
    // Touch already sends the moves to this element; capture keeps a mouse drag that leaves the grid.
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {}
  }
  function move(e: PointerEvent<HTMLDivElement>) {
    if (!drag.current) return;
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
  const up = () => {
    drag.current = null;
  };
  function key(e: KeyboardEvent<HTMLButtonElement>, d: number, h: number) {
    const moves: Record<string, [number, number]> = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
    if (e.key === " " || e.key === "Enter") {
      e.preventDefault();
      if (!disabled) paint([[d, h]], !has(current.current, d, h));
      return;
    }
    const step = moves[e.key];
    if (!step) return;
    e.preventDefault();
    const nd = Math.min(6, Math.max(0, d + step[0]));
    const nh = Math.min(GRID_HOURS.at(-1)!, Math.max(GRID_HOURS[0], h + step[1]));
    setFocus([nd, nh]);
    e.currentTarget.closest("[data-week-grid]")?.querySelector<HTMLButtonElement>(`[data-cell="${nd},${nh}"]`)?.focus();
  }
  function preset(p: (typeof PRESETS)[number]) {
    const cells = p.days.flatMap((d) => p.hours.map((h) => [d, h] as [number, number]));
    paint(cells, !cells.every((c) => has(value, ...c)));
  }
  const count = weekHoursCount(value);
  const weekend = value[5].length + value[6].length > 0;
  const late = value.slice(0, 5).some((hours) => hours.some((h) => h >= 15));
  return (
    <div className={s.week}>
      <p className={s.hint}>Tap or drag to select. Start on a selected hour to clear.</p>
      <div className={s.presets} role="group" aria-label="Quick fill">
        {PRESETS.map((p) => {
          const on = p.days.every((d) => p.hours.every((h) => has(value, d, h)));
          return (
            <button key={p.label} type="button" className={s.preset} aria-pressed={on} disabled={disabled} onClick={() => preset(p)}>
              {on && <Check aria-hidden size={14} />}
              {p.label}
            </button>
          );
        })}
        {count > 0 && (
          <button type="button" className={s.clear} disabled={disabled} onClick={() => onChange(WEEK_DAYS.map(() => []))}>
            Clear
          </button>
        )}
      </div>
      <div
        className={s.grid}
        data-week-grid=""
        role="group"
        aria-label="Hours you can teach onsite, Monday to Sunday"
        aria-disabled={disabled || undefined}
        onPointerDown={down}
        onPointerMove={move}
        onPointerUp={up}
        onPointerCancel={up}
        onLostPointerCapture={up}
      >
        <span aria-hidden />
        {WEEK_DAYS.map((day, d) => (
          <span key={day} aria-hidden className={s.dayHead} data-weekend={d > 4 || undefined}>
            {day}
          </span>
        ))}
        {GRID_HOURS.map((h) => (
          <div key={h} className={s.row}>
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
                aria-pressed={has(value, d, h)}
                aria-label={`${DAY_NAMES[d]} ${hh(h)} to ${hh(h + 1)}`}
                tabIndex={focus[0] === d && focus[1] === h ? 0 : -1}
                disabled={disabled}
                onKeyDown={(e) => key(e, d, h)}
                onFocus={() => setFocus([d, h])}
              />
            ))}
          </div>
        ))}
      </div>
      <div className={s.readback} aria-live="polite">
        {count > 0 && (
          <p>{value.flatMap((hours, d) => (hours.length ? [`${WEEK_DAYS[d]} ${hourRanges(hours).replaceAll(":00", "").replace(/-/g, "–")}`] : [])).join(" · ")}</p>
        )}
        <p className={s.rules}>
          {/* What the booking asks for: a note to add, then a tick once the grid has it (Sol r2: not radio-like). */}
          <span data-ok={weekend || undefined}>
            {weekend ? <Check aria-hidden size={14} /> : <Plus aria-hidden size={14} />}
            {weekend ? "Saturday or Sunday" : "Add a Saturday or Sunday"}
          </span>
          <span data-ok={late || undefined}>
            {late ? <Check aria-hidden size={14} /> : <Plus aria-hidden size={14} />}
            {late ? "A weekday after 15:00" : "Add a weekday after 15:00"}
          </span>
          {count > 0 && <b>{count} hours a week</b>}
        </p>
      </div>
    </div>
  );
}
