"use client";

import { useLayoutEffect, useRef, useState, type MouseEvent } from "react";
import type { paperDistribution } from "@/lib/hiring/paper-distribution";

type Row = { subject: string; data: NonNullable<ReturnType<typeof paperDistribution>>; cutoffs: number[]; observations: { score: number; subject: string; maximum: number }[] };
const fmt = (value: number) => value.toFixed(1);

function SubjectChart({ subject, data, cutoffs, observations }: Row) {
  const { scores, mean, median, sd } = data;
  const official = cutoffs.length === 1 ? cutoffs[0] : 80;
  const [trialCutoff, setTrialCutoff] = useState<number | null>(null);
  const cutoff = trialCutoff ?? official;
  const cutoffName = trialCutoff !== null ? "trial cutoff" : cutoffs.length === 1 ? "official cutoff" : "reference cutoff";
  const showTrialLine = trialCutoff !== null && !cutoffs.includes(trialCutoff);
  const [comparing, setComparing] = useState(false);
  const [draft, setDraft] = useState(String(official));
  const trialInput = useRef<HTMLInputElement>(null);
  useLayoutEffect(() => {
    if (comparing) trialInput.current?.focus();
  }, [comparing]);
  const [selected, setSelected] = useState<number | null>(null);
  const [hover, setHover] = useState<number | null>(null);
  const inspected = hover ?? selected;
  const counts = new Map<number, number>();
  for (const score of scores) counts.set(score, (counts.get(score) ?? 0) + 1);
  function nearestScore(event: MouseEvent<HTMLDivElement>) {
    const bounds = event.currentTarget.getBoundingClientRect();
    const position = 100 * (event.clientX - bounds.left) / bounds.width;
    return scores.reduce((best, score) => Math.abs(score - position) < Math.abs(best - position) ? score : best);
  }
  const meets = scores.filter(score => score >= cutoff).length;
  const maxima = [...new Set(observations.map(o => o.maximum))].sort((a, b) => a - b);
  // Round SVG coordinates so server and browser math produce the same markup.
  const curve = [0, ...Array.from({ length: 129 }, (_, i) => mean + sd * (i - 64) / 12)
    .filter(score => score > 0 && score < 100), 100].map(score =>
    [score, 100 - 90 * Math.exp(-0.5 * ((score - mean) / (sd || 1)) ** 2)].map(value => value.toFixed(4)).join(",")).join(" ");
  const inspectText = inspected === null ? "Hover or select a score to inspect it." :
    `${fmt(inspected)}% · ${counts.get(inspected)} ${counts.get(inspected) === 1 ? "paper" : "papers"} · ${inspected === cutoff ? "at the " + cutoffName : fmt(Math.abs(inspected - cutoff)) + " points " + (inspected > cutoff ? "above" : "below") + " the " + cutoffName}`;
  return <article aria-label={subject + " distribution"} className="min-w-0 overflow-hidden rounded-xl border bg-card shadow-sm">
    <header className="flex flex-wrap items-baseline justify-between gap-1 border-b px-4 py-3 sm:px-6">
      <h3 className="text-xl font-semibold">{subject}</h3>
      <span className="text-sm text-muted-foreground">{scores.length} final {scores.length === 1 ? "paper" : "papers"}</span>
    </header>
    <div className="px-4 pb-2 pt-4 sm:px-6">
      <dl className="grid grid-cols-3 divide-x text-sm">
        {([["Mean", fmt(mean) + "%"], ["Median", fmt(median) + "%"], ["Std. deviation", fmt(sd) + " pp"]] as const).map(([label, value]) =>
          <div key={label} className="pl-3 first:pl-0"><dt className="text-muted-foreground">{label}</dt><dd className="text-lg font-semibold tabular-nums sm:text-2xl">{value}</dd></div>)}
      </dl>
      <div className="mt-4 rounded-lg border bg-muted/30 px-3 py-2">
        <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
          <output className="tabular-nums"><span className="capitalize">{cutoffName}</span> · <strong>{meets} of {scores.length}</strong> at or above {cutoff}%</output>
          <button type="button" aria-expanded={comparing} aria-controls="compare-cutoff" className="min-h-9 cursor-pointer rounded-sm px-1 font-medium text-primary hover:underline focus-visible:outline-2 focus-visible:outline-primary"
            onClick={event => {
              setComparing(!comparing);
              setDraft(String(official));
              if (comparing) {
                setTrialCutoff(null);
                event.currentTarget.focus();
              }
            }}>
            {comparing ? "Close comparison" : "Compare a cutoff"}
          </button>
        </div>
        {comparing && <form id="compare-cutoff" className="mt-3 flex flex-wrap items-end gap-2" onSubmit={e => {
          e.preventDefault();
          setTrialCutoff(Number(draft));
        }}>
          <label className="text-xs text-muted-foreground">Trial cutoff (%)
            <input ref={trialInput} aria-label="Trial cutoff (%)" type="number" inputMode="decimal" min="0" max="100" step="any" required
              className="mt-1 block w-20 rounded-md border bg-background px-2 py-1.5 text-sm text-foreground tabular-nums focus-visible:outline-2 focus-visible:outline-primary"
              value={draft} onChange={e => setDraft(e.target.value)} />
          </label>
          <button type="submit" className="cursor-pointer rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground">Apply trial cutoff</button>
        </form>}
      </div>
      <div className="mx-3 mb-8 mt-7 relative h-32 border-b border-foreground/40 sm:h-48" aria-label="Scores from zero to one hundred percent"
        onPointerMove={e => { if (e.pointerType === "mouse") setHover(nearestScore(e)); }}
        onPointerLeave={() => setHover(null)}
        onClick={e => { if (e.target instanceof Element && !e.target.closest("button")) setSelected(nearestScore(e)); }}>
        {[0, 25, 50, 75, 100].map(tick => <div key={tick} className="pointer-events-none absolute inset-y-0 border-l border-border" style={{ left: tick + "%" }}>
          <span className="absolute top-full mt-2 -translate-x-1/2 text-xs tabular-nums text-muted-foreground">{tick}%</span>
        </div>)}
        {sd > 0 && <svg viewBox="0 0 100 100" preserveAspectRatio="none" aria-label="Fitted normal curve" role="img" className="absolute inset-0 h-full w-full text-primary">
          <polygon points={`0,100 ${curve} 100,100`} fill="currentColor" opacity=".13" />
          <polyline points={curve} fill="none" stroke="currentColor" strokeWidth="2.5" vectorEffect="non-scaling-stroke" />
        </svg>}
        {cutoffs.map(value => <div key={value} className="pointer-events-none absolute inset-y-0 border-l-2 border-dashed border-[var(--chart-2)]" style={{ left: value + "%" }} />)}
        {showTrialLine && <div className="pointer-events-none absolute inset-y-0 border-l-2 border-[var(--chart-3)]" style={{ left: cutoff + "%" }} />}
        {inspected !== null && <div className="pointer-events-none absolute inset-y-0 border-l border-dotted border-primary" style={{ left: inspected + "%" }}>
          <span className="absolute top-0 rounded bg-primary px-1.5 py-0.5 text-xs font-semibold text-primary-foreground" style={{ transform: inspected > 85 ? "translateX(-100%)" : inspected < 15 ? "none" : "translateX(-50%)" }}>{fmt(inspected)}%</span>
        </div>}
        {[...counts].map(([score, n]) => <button key={score} type="button" aria-label={`Inspect ${fmt(score)} percent, ${n} ${n === 1 ? "paper" : "papers"}`}
          aria-pressed={selected === score} className="absolute bottom-0 grid size-8 -translate-x-1/2 translate-y-1/2 cursor-pointer place-items-center rounded-full focus-visible:outline-2 focus-visible:outline-primary"
          style={{ left: score + "%" }} onPointerEnter={e => { if (e.pointerType === "mouse") setHover(score); }} onPointerLeave={() => setHover(null)}
          onFocus={() => setHover(score)} onBlur={() => setHover(null)} onClick={() => setSelected(score)}>
          <span className={`rounded-full border-2 border-card bg-primary ${inspected === score ? "ring-2 ring-primary" : ""}`} style={{ width: Math.min(20, 10 + 2 * n), height: Math.min(20, 10 + 2 * n) }} />
        </button>)}
      </div>
      <label className="mb-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm font-medium">Inspect score
        <select aria-label="Inspect score" className="min-h-10 max-w-full rounded-md border bg-background px-2 text-sm font-normal focus-visible:outline-2 focus-visible:outline-primary"
          value={selected ?? ""} onChange={event => { setSelected(event.target.value === "" ? null : Number(event.target.value)); setHover(null); }}>
          <option value="">Choose a score</option>
          {[...counts].map(([score, n]) => <option key={score} value={score}>{fmt(score)}% · {n} {n === 1 ? "paper" : "papers"}</option>)}
        </select>
      </label>
      <p className="min-h-6 text-sm font-medium tabular-nums" role="status">{inspectText}</p>
      <p className="mb-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
        <span><span className="mr-1 inline-block w-4 align-middle border-t-2 border-dashed border-[var(--chart-2)]" />Hiring pass line {cutoffs.length ? cutoffs.join("% / ") + "%" : "unconfigured"}</span>
        {trialCutoff !== null && <span>{showTrialLine && <span className="mr-1 inline-block w-4 align-middle border-t-2 border-[var(--chart-3)]" />}Trial cutoff {cutoff}%</span>}
        <span>{sd > 0 ? "Fitted normal curve" : scores.length === 1 ? "One score available" : "All scores equal"}</span>
      </p>
      {inspected !== null && <p className="mb-2 text-xs text-muted-foreground">{observations.filter(o => o.score === inspected).map(o => "Teaching subject: " + o.subject + " · marked out of " + o.maximum).join(" / ")}</p>}
      {subject === "English Language" && <p className="mb-3 rounded-md border-l-2 border-[var(--chart-2)] bg-muted/50 px-3 py-2 text-xs leading-relaxed">Teachers applying for EFL/ESL, English Language or English Literature take the English Language paper. {maxima.length > 1 && <>Saved marking totals vary ({maxima.join(", ")} marks). The chart uses the recorded final percentages.</>}</p>}
    </div>
  </article>;
}

export function ScoreExplorer({ rows }: { rows: Row[] }) {
  const [subject, setSubject] = useState(rows.find(row => row.subject === "English Language")?.subject ?? rows[0].subject);
  const active = rows.find(row => row.subject === subject) ?? rows[0];
  return <section aria-labelledby="score-heading">
    <h2 id="score-heading" className="mb-3 text-xl font-semibold">Score distributions</h2>
    <div className="grid items-start gap-4 lg:grid-cols-[minmax(17rem,0.65fr)_minmax(0,1.35fr)]">
      <div className="rounded-xl border bg-card p-3">
        <label className="flex items-center justify-between gap-2 text-sm font-medium lg:hidden">Test group
          <select aria-label="Test group" className="min-w-0 rounded-md border bg-background p-2" value={active.subject} onChange={e => setSubject(e.target.value)}>{rows.map(row => <option key={row.subject}>{row.subject}</option>)}</select></label>
        <table className="w-full text-left text-xs tabular-nums max-lg:hidden">
          <caption className="sr-only">Select a subject to explore its final papers</caption>
          <thead className="text-muted-foreground"><tr>{["Test group", "N", "Mean", "Median", "SD (pp)"].map(label => <th scope="col" key={label} className="px-1 py-2 text-right first:text-left">{label}</th>)}</tr></thead>
          <tbody>{rows.map(row => <tr key={row.subject} className={`border-t ${row.subject === active.subject ? "bg-primary/10" : ""}`}>
            <th scope="row" className="text-left"><button type="button" className="w-full cursor-pointer px-1 py-3 text-left font-medium hover:underline" aria-pressed={row.subject === active.subject} onClick={() => setSubject(row.subject)}>{row.subject}</button></th>
            {[row.data.scores.length, fmt(row.data.mean) + "%", fmt(row.data.median) + "%", fmt(row.data.sd)].map((v, i) => <td key={i} className="px-1 text-right">{v}</td>)}
          </tr>)}</tbody>
        </table>
      </div>
      <SubjectChart key={active.subject} {...active} />
    </div>
    <p className="mt-2 text-xs text-muted-foreground">Standard deviation uses all final papers in the test group and is shown in percentage points.</p>
  </section>;
}
