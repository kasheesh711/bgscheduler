"use client";

import { useState } from "react";
import syllabuses from "@/lib/hiring/cambridge-igcse-thresholds.json";

import { grades } from "./grades";
const benchmark = 80;
const selectStyle = "mt-1 block w-full rounded-md border bg-background px-2 py-2 text-sm font-normal";

export function ThresholdChart() {
  const [routeIndex, setRouteIndex] = useState(0);
  const [gradeIndex, setGradeIndex] = useState(0);
  const [pinned, setPinned] = useState(4);
  const [hover, setHover] = useState<number | null>(null);
  const route = syllabuses[routeIndex];
  const series = route.years.map(year => {
    const mark = year.marks[gradeIndex];
    return { ...year, mark, percent: mark === null ? null : mark * 100 / year.max };
  });
  const available = series.flatMap(y => y.percent === null ? [] : [y.percent]);
  const average = available.length === 5 ? available.reduce((sum, n) => sum + n, 0) / 5 : null;
  const selected = hover ?? pinned;
  const year = series[selected];
  return <div className="my-4 rounded-xl border bg-card shadow-sm">
    <div className="grid gap-3 border-b px-4 py-3 sm:grid-cols-[minmax(0,1fr)_6rem] sm:px-6">
      <label className="min-w-0 text-sm font-medium">Syllabus and entry route<select aria-label="Syllabus and entry route" className={selectStyle} value={routeIndex} onChange={e => setRouteIndex(Number(e.target.value))}>
        {syllabuses.map((s, i) => <option key={s.subject} value={i}>{s.subject} ({s.code})</option>)}</select></label>
      <label className="text-sm font-medium">Grade<select aria-label="Grade" className={selectStyle} value={gradeIndex} onChange={e => setGradeIndex(Number(e.target.value))}>
        {grades.map((g, i) => <option key={g} value={i}>{g}</option>)}</select></label>
    </div>
    <div className="px-4 py-4 sm:px-6">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h3 className="font-semibold">Five-year {grades[gradeIndex]} threshold</h3><strong className="text-2xl tabular-nums text-primary">{average === null ? "Unavailable" : average.toFixed(1) + "%"}</strong>
        <span className="text-sm text-muted-foreground">{average === null ? "Published in " + available.length + " of 5 series" : average === benchmark ? "At the hiring benchmark" : Math.abs(average - benchmark).toFixed(1) + " points " + (average > benchmark ? "above" : "below") + " the hiring benchmark"}</span>
      </div>
      {route.code === "0500" && <p className="mt-2 text-sm text-muted-foreground">
        {route.years[0].components === "12, 22" ? "Paper 12 (Reading) and Paper 22 (Directed Writing and Composition)." : "Paper 12 (Reading) and Component 03 (Coursework Portfolio)."} The optional speaking test has a separate grade. <a className="underline underline-offset-4" href="https://www.cambridgeinternational.org/Images/635230-2024-2026-syllabus.pdf">0500 syllabus</a>
      </p>}
      <div className="relative ml-8 mr-1 mt-6 h-40 border-b sm:h-48">
        {[0, 50, 100].map(value => <div key={value} className="absolute inset-x-0 border-t border-border" style={{ bottom: value + "%" }}>
          <span className="absolute right-full mr-2 -translate-y-1/2 text-xs text-muted-foreground">{value}%</span></div>)}
        <div className="absolute inset-0 grid grid-cols-5 gap-3 sm:gap-6">
          {series.map((s, i) => <button type="button" key={s.year} aria-pressed={selected === i}
            aria-label={`Inspect June ${s.year}, grade ${grades[gradeIndex]}, ${s.percent === null ? "unavailable" : s.percent.toFixed(1) + " percent"}`}
            className="relative cursor-pointer rounded-t focus-visible:outline-2 focus-visible:outline-primary" onClick={() => setPinned(i)}
            onPointerEnter={e => { if (e.pointerType === "mouse") setHover(i); }} onPointerLeave={() => setHover(null)} onFocus={() => setHover(i)} onBlur={() => setHover(null)}>
            {s.percent !== null && <span className={`absolute inset-x-0 bottom-0 mx-auto w-3/5 max-w-20 rounded-t-sm ${selected === i ? "bg-primary" : "bg-primary/50"}`} style={{ height: s.percent + "%" }} />}
            <span className="absolute inset-x-0 top-full mt-1 text-center text-xs font-medium tabular-nums">{s.year}</span>
          </button>)}
        </div>
        <div className="pointer-events-none absolute inset-x-0 border-t-2 border-dashed border-[var(--chart-2)]" style={{ bottom: benchmark + "%" }}>
          <span className="absolute right-0 bottom-1 rounded-sm bg-card/95 px-1 text-xs font-medium">80% benchmark</span></div>
      </div>
      <div className="mt-8 flex flex-wrap items-center justify-between gap-2 border-t pt-3 text-sm">
        <p role="status" className="tabular-nums"><strong>June {year.year}</strong> · {year.percent === null ? "Grade unavailable for this route" : `${year.mark}/${year.max} weighted marks · ${year.percent.toFixed(1)}%`} · Components {year.components}</p>
        <a className="text-sm text-primary underline underline-offset-4" href={year.source}>Open {year.year} Cambridge table</a>
      </div>
    </div>
  </div>;
}
