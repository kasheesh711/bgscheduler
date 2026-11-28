"use client";

import { useEffect, useLayoutEffect, useRef, useState, type MouseEvent } from "react";
import type { paperDistribution } from "@/lib/hiring/paper-distribution";

export type PaperObservation = {
  score: number; subject: string; earned: number; maximum: number;
  candidateId: string; name: string; atsScore: number | null; university: string | null; experience: string | null; profileSummary: string;
};
type Row = { subject: string; data: NonNullable<ReturnType<typeof paperDistribution>>; cutoffs: number[]; observations: PaperObservation[] };
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
  const scoreEvidence = useRef<HTMLDivElement>(null);
  const [selected, setSelected] = useState<number | null>(null);
  const [hover, setHover] = useState<number | null>(null);
  const inspected = hover ?? selected;
  const candidates = new Map(observations.filter(o => o.score === inspected).map(o => [o.candidateId, o]));
  const bubbleOpen = inspected !== null;
  useEffect(() => {
    if (!bubbleOpen) return;
    const dismiss = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setHover(null);
        setSelected(null);
      }
    };
    document.addEventListener("keydown", dismiss);
    return () => document.removeEventListener("keydown", dismiss);
  }, [bubbleOpen]);
  const counts = new Map<number, number>();
  for (const score of scores) counts.set(score, (counts.get(score) ?? 0) + 1);
  const discreteScores = [...counts.keys()];
  const selectedIndex = selected === null ? -1 : discreteScores.indexOf(selected);
  function inspect(value: number | null) {
    setSelected(value);
    setHover(null);
    if (value !== null) requestAnimationFrame(() => scoreEvidence.current?.scrollIntoView({ block: "nearest" }));
  }
  function stepScore(direction: -1 | 1) {
    const index = selectedIndex < 0 && direction === -1 ? discreteScores.length : selectedIndex;
    const next = Math.max(0, Math.min(discreteScores.length - 1, index + direction));
    if (next !== selectedIndex) inspect(discreteScores[next]);
  }
  function nearestScore(event: MouseEvent<HTMLDivElement>) {
    const bounds = event.currentTarget.getBoundingClientRect();
    const position = 100 * (event.clientX - bounds.left) / bounds.width;
    return scores.reduce((best, score) => Math.abs(score - position) < Math.abs(best - position) ? score : best);
  }
  const meets = scores.filter(score => score >= cutoff).length;
  const exact = counts.get(cutoff) ?? 0;
  const officialMeets = trialCutoff === null ? meets : scores.filter(score => score >= official).length;
  const zeros = counts.get(0) ?? 0;
  const maxima = [...new Set(observations.map(o => o.maximum))].sort((a, b) => a - b);
  // Round SVG coordinates so server and browser math produce the same markup.
  const curve = [0, ...Array.from({ length: 129 }, (_, i) => mean + sd * (i - 64) / 12)
    .filter(score => score > 0 && score < 100), 100].map(score =>
    [score, 100 - 90 * Math.exp(-0.5 * ((score - mean) / (sd || 1)) ** 2)].map(value => value.toFixed(4)).join(",")).join(" ");
  const inspectText = selected === null ? "Choose a score to see its papers." :
    `${fmt(selected)}% · ${counts.get(selected)} ${counts.get(selected) === 1 ? "paper" : "papers"} · ${selected === cutoff ? "at the " + cutoffName : fmt(Math.abs(selected - cutoff)) + " points " + (selected > cutoff ? "above" : "below") + " the " + cutoffName}`;
  return <article aria-label={subject + " distribution"} className="min-w-0 overflow-hidden rounded-xl border bg-card shadow-sm">
    <header className="flex flex-wrap items-baseline justify-between gap-1 border-b px-4 py-3 sm:px-6">
      <h3 className="text-xl font-semibold" aria-live="polite">{subject}</h3>
      <span className="text-sm text-muted-foreground">{scores.length} final {scores.length === 1 ? "paper" : "papers"}</span>
    </header>
    <div className="px-4 pb-2 pt-4 sm:px-6">
      {scores.length === 1 ? <p className="text-sm font-medium">Recorded score <strong className="ml-2 text-lg tabular-nums">{fmt(scores[0])}%</strong> <span className="text-muted-foreground">· One final paper</span></p> : <>
      <p className="mb-2 text-xs font-medium text-muted-foreground">Statistics from {scores.length} final papers</p>
      <dl className="grid grid-cols-3 divide-x text-sm">
        {([["Mean", fmt(mean) + "%"], ["Median", fmt(median) + "%"], ["Std. deviation", fmt(sd) + " pp"]] as const).map(([label, value]) =>
          <div key={label} className="pl-3 first:pl-0"><dt className="text-muted-foreground">{label}</dt><dd className="text-lg font-semibold tabular-nums sm:text-2xl">{value}</dd></div>)}
      </dl>
      </>}
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
        <dl aria-label={cutoff + "% cutoff breakdown"} className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-xs tabular-nums">
          <div className="flex gap-1"><dt>Below {cutoff}%</dt><dd className="font-medium">{scores.length - meets}</dd></div>
          <div className="flex gap-1"><dt>Exactly {cutoff}%</dt><dd className="font-medium">{exact}</dd></div>
          <div className="flex gap-1"><dt>Above {cutoff}%</dt><dd className="font-medium">{meets - exact}</dd></div>
        </dl>
        {exact > 0 && <button type="button" className="min-h-10 text-sm text-primary underline underline-offset-4" onClick={() => inspect(cutoff)}>Inspect {cutoff}% papers</button>}
        {trialCutoff !== null && <p className="mt-1 text-xs text-muted-foreground">{cutoffs.length === 1 ? "Official" : "Reference"} {official}% · {officialMeets} of {scores.length} at or above</p>}
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
      <div ref={scoreEvidence} className="mt-4 scroll-mt-24 rounded-lg border px-3 py-2">
        <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
          <label className="flex min-w-0 flex-wrap items-center gap-x-2 text-sm font-medium">Inspect score
            <select aria-label="Inspect score" className="min-h-11 max-w-full rounded-md border bg-background px-2 text-sm font-normal focus-visible:outline-2 focus-visible:outline-primary"
              value={selected ?? ""} onChange={event => inspect(event.target.value === "" ? null : Number(event.target.value))}>
              <option value="">Choose a score</option>
              {[...counts].map(([score, n]) => <option key={score} value={score}>{fmt(score)}% · {n} {n === 1 ? "paper" : "papers"}</option>)}
            </select>
          </label>
          <div className="flex gap-1" role="group" aria-label="Step through recorded scores" onKeyDown={event => {
            if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
            event.preventDefault();
            stepScore(event.key === "ArrowLeft" ? -1 : 1);
          }}>
            <button type="button" aria-label="Previous score" aria-disabled={selectedIndex === 0}
              className="size-11 rounded-md border text-lg aria-disabled:opacity-45 focus-visible:outline-2 focus-visible:outline-primary"
              onClick={() => stepScore(-1)}>←</button>
            <button type="button" aria-label="Next score" aria-disabled={selectedIndex === discreteScores.length - 1}
              className="size-11 rounded-md border text-lg aria-disabled:opacity-45 focus-visible:outline-2 focus-visible:outline-primary"
              onClick={() => stepScore(1)}>→</button>
          </div>
        </div>
        <p className="mt-2 text-sm font-medium tabular-nums" role="status">{inspectText}</p>
        {selected !== null && <ul aria-label="Marks on the selected papers" className="mt-1 divide-y text-sm">
          {observations.filter(o => o.score === selected).map((o, index) => <li key={index} className="flex flex-wrap items-baseline justify-between gap-x-2 py-1">
            <span>{o.subject}</span><strong className="tabular-nums">{o.earned} / {o.maximum} marks</strong>
          </li>)}
        </ul>}
        {zeros > 0 && <button type="button" className="min-h-10 text-sm text-primary underline underline-offset-4"
          onClick={() => inspect(0)}>Inspect {zeros} final {zeros === 1 ? "paper" : "papers"} at 0%</button>}
      </div>
      <div className="mx-3 mb-8 mt-7 relative h-32 border-b border-foreground/40 sm:h-48" aria-label="Scores from zero to one hundred percent"
        onPointerMove={e => { if (e.pointerType === "mouse") setHover(nearestScore(e)); }}
        onPointerLeave={() => setHover(null)}
        onClick={event => {
          if (event.detail > 0) {
            inspect(nearestScore(event));
          }
        }}>
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
        </div>}
        {inspected !== null && <div key={inspected} id="paper-score-summary" role="tooltip" tabIndex={selected === inspected ? 0 : undefined}
          className="absolute bottom-4 z-10 max-h-64 sm:max-h-56 w-72 max-w-full overflow-y-auto overscroll-contain rounded-lg border bg-popover px-3 py-2 text-xs text-popover-foreground shadow-md [overflow-wrap:anywhere]"
          style={{ left: `clamp(0px, calc(${inspected}% - 9rem), max(0px, calc(100% - 18rem)))` }}
          onPointerMove={event => event.stopPropagation()} onClick={event => event.stopPropagation()}>
          <p className="font-semibold text-primary">Paper score {fmt(inspected)}%</p>
          {[...candidates.values()].map(candidate => <div key={candidate.candidateId} className="mt-1 border-t pt-1.5">
            <p className="font-semibold">{candidate.name}</p>
            <dl className="mt-1 grid grid-cols-[auto_1fr] gap-x-2 gap-y-0.5">
              <dt className="text-muted-foreground">ATS score</dt><dd>{candidate.atsScore === null ? "Not scored" : `${Number(fmt(candidate.atsScore))}/100`}</dd>
              <dt className="text-muted-foreground">University</dt><dd>{candidate.university || "Not recorded"}</dd>
              <dt className="text-muted-foreground">Teaching experience</dt><dd>{candidate.experience || "Not recorded"}</dd>
            </dl>
            <p className="mt-2 font-medium">Profile summary</p>
            <p className="leading-snug">{candidate.profileSummary}</p>
          </div>)}
        </div>}
        {[...counts].map(([score, n]) => <button key={score} type="button" aria-label={`Inspect ${fmt(score)} percent, ${n} ${n === 1 ? "paper" : "papers"}`}
          aria-describedby={inspected === score ? "paper-score-summary" : undefined} aria-pressed={selected === score} className="absolute bottom-0 grid size-8 -translate-x-1/2 translate-y-1/2 cursor-pointer place-items-center rounded-full focus-visible:outline-2 focus-visible:outline-primary"
          style={{ left: score + "%" }} onPointerEnter={e => { if (e.pointerType === "mouse") setHover(score); }}
          onFocus={() => setHover(score)} onBlur={() => setHover(null)} onClick={event => { if (event.detail === 0) inspect(score); }}>
          <span className={`rounded-full border-2 border-card bg-primary ${inspected === score ? "ring-2 ring-primary" : ""}`} style={{ width: Math.min(20, 10 + 2 * n), height: Math.min(20, 10 + 2 * n) }} />
        </button>)}
      </div>
      <p className="mb-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
        <span><span className="mr-1 inline-block w-4 align-middle border-t-2 border-dashed border-[var(--chart-2)]" />Hiring pass line {cutoffs.length ? cutoffs.join("% / ") + "%" : "unconfigured"}</span>
        {trialCutoff !== null && <span>{showTrialLine && <span className="mr-1 inline-block w-4 align-middle border-t-2 border-[var(--chart-3)]" />}Trial cutoff {cutoff}%</span>}
        <span>{sd > 0 ? "Fitted normal curve" : scores.length === 1 ? "One score available" : "All scores equal"}</span>
      </p>
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
        <p className="mb-2 text-sm font-medium lg:hidden">Test groups</p>
        <ul className="grid grid-cols-2 gap-2 lg:hidden">
          {rows.map(row => <li key={row.subject}><button type="button" aria-pressed={row.subject === active.subject}
            className="flex min-h-11 w-full flex-wrap items-center justify-between gap-x-2 rounded-md border px-2 py-1 text-left text-sm aria-pressed:border-primary aria-pressed:bg-primary/10"
            onClick={() => setSubject(row.subject)}><span>{row.subject}</span><span className="text-xs text-muted-foreground">{row.data.scores.length} {row.data.scores.length === 1 ? "paper" : "papers"}{row.subject === active.subject && " · Showing"}</span></button></li>)}
        </ul>
        <table className="w-full text-left text-xs tabular-nums max-lg:hidden">
          <caption className="sr-only">Select a subject to explore its final papers</caption>
          <thead className="text-muted-foreground"><tr>{["Test group", "Papers", "Mean", "Median", "SD (pp)"].map(label => <th scope="col" key={label} className="px-1 py-2 text-right first:text-left">{label}</th>)}</tr></thead>
          <tbody>{rows.map(row => <tr key={row.subject} className={`border-t ${row.subject === active.subject ? "bg-primary/10" : ""}`}>
            <th scope="row" className="text-left"><button type="button" className="w-full cursor-pointer px-1 py-3 text-left font-medium hover:underline" aria-pressed={row.subject === active.subject} onClick={() => setSubject(row.subject)}>{row.subject}{row.subject === active.subject && <span aria-hidden="true" className="block text-xs text-primary">Showing</span>}</button></th>
            {[row.data.scores.length, fmt(row.data.mean) + "%", fmt(row.data.median) + "%", fmt(row.data.sd)].map((v, i) => <td key={i} className="px-1 text-right">{v}</td>)}
          </tr>)}</tbody>
        </table>
      </div>
      <SubjectChart key={active.subject} {...active} />
    </div>
    <p className="mt-2 text-xs text-muted-foreground">Standard deviation uses all final papers in the test group and is shown in percentage points.</p>
  </section>;
}
