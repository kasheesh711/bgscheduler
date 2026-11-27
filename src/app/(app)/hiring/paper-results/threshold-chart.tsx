"use client";

import { useState } from "react";
import { allWrittenYears, englishWrittenAverage, syllabuses, writtenPairs } from "@/lib/hiring/cambridge-thresholds";

import writtenHistory from "@/lib/hiring/cambridge-0500-written-history.json";
import { grades } from "./grades";
const benchmark = 80;
const periods = [
  ["recent", "2022–26", "2022–2026 five-year reference"],
  ["current", "2021–26", "2021–2026 current format"],
  ["earlier", "2011–19", "2011–2019 earlier format"],
  ["all", "All years", "2011–2026 all 15 sittings"],
] as const;
const choiceStyle = "min-h-10 rounded-md border px-2 text-sm aria-pressed:border-primary aria-pressed:bg-primary/10 aria-pressed:font-semibold focus-visible:outline-2 focus-visible:outline-primary";
const selectStyle = "mt-1 block w-full rounded-md border bg-background px-2 py-2 text-sm font-normal";

export function ThresholdChart() {
  const [routeIndex, setRouteIndex] = useState(0);
  const [gradeIndex, setGradeIndex] = useState(0);
  const [period, setPeriod] = useState("recent");
  const [pinned, setPinned] = useState(2026);
  const [hover, setHover] = useState<number | null>(null);
  const route = syllabuses[routeIndex];
  const aggregate = route === englishWrittenAverage;
  const writtenEnglish = aggregate || route.code === "0500" && route.years[0].components === "12, 22";
  let years = route.years;
  if (writtenEnglish && period !== "recent") {
    years = (aggregate ? allWrittenYears : [...writtenHistory, ...years]).filter(row =>
      period === "all" || (period === "current" ? row.year >= 2021 : row.year <= 2019));
  }
  const series = years.map(year => {
    const mark = year.marks[gradeIndex];
    return { ...year, mark, percent: mark === null ? null : mark * 100 / year.max };
  });
  const available = series.flatMap(y => y.percent === null ? [] : [y.percent]);
  const average = available.length === series.length ? available.reduce((sum, n) => sum + n, 0) / series.length : null;
  const year = series.find(row => row.year === pinned) ?? series[series.length - 1];
  const yearIndex = series.indexOf(year);
  const pairs = aggregate ? Object.entries(writtenPairs[year.year]).filter(([, marks]) => marks[gradeIndex] !== null) : [];
  const pairMarks = pairs.map(([, marks]) => marks[gradeIndex]!);
  return <div className="my-4 rounded-xl border bg-card shadow-sm">
    <div className="grid gap-3 border-b px-4 py-3 min-w-0 sm:grid-cols-[minmax(0,1fr)_auto] sm:px-6">
      <label className="min-w-0 text-sm font-medium">Syllabus and entry route<select aria-label="Syllabus and entry route" className={selectStyle} value={routeIndex} onChange={e => setRouteIndex(Number(e.target.value))}>
        {syllabuses.map((s, i) => <option key={s.subject} value={i}>{s.subject} ({s.code})</option>)}</select></label>
      <fieldset className="min-w-0">
        <legend className="text-sm font-medium">Grade</legend>
        <div className="mt-1 flex flex-wrap gap-1">
          {grades.map((grade, i) => <button key={grade} type="button" aria-label={"Grade " + grade} aria-pressed={gradeIndex === i}
            className={choiceStyle + " min-w-10"} onClick={() => setGradeIndex(i)}>{grade}</button>)}
        </div>
      </fieldset>
    </div>
    <div className="min-w-0 px-4 py-4 sm:px-6">
      {writtenEnglish && <fieldset className="mb-4">
        <legend className="text-sm font-medium">June series</legend>
        <div className="mt-1 flex flex-wrap gap-1">
          {periods.map(([value, label, name]) => <button key={value} type="button" aria-label={name} aria-pressed={period === value}
            className={choiceStyle} onClick={() => setPeriod(value)}>{label}</button>)}
        </div>
      </fieldset>}
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h3 className="font-semibold">{series.length === 5 ? "Five-year" : series.length + "-sitting average"} {grades[gradeIndex]} threshold</h3><strong className="text-2xl tabular-nums text-primary">{average === null ? "Unavailable" : average.toFixed(1) + "%"}</strong>
        <span className="text-sm text-muted-foreground">{average === null ? "Published in " + available.length + " of " + series.length + " series" : average === benchmark ? "At the hiring benchmark" : Math.abs(average - benchmark).toFixed(1) + " points " + (average > benchmark ? "above" : "below") + " the hiring benchmark"}</span>
      </div>
      <div className="mt-3 rounded-lg border px-3 py-2" aria-label="Selected Cambridge year" role="group">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p role="status" className="text-sm tabular-nums"><strong>June {year.year} · Grade {grades[gradeIndex]}</strong> · {aggregate && year.percent !== null ? `${year.percent.toFixed(1)}% average across ${pairs.length} paper pairs` : year.percent === null ? "Grade unavailable for this route" : `${year.mark}/${year.max} weighted marks · ${year.percent.toFixed(1)}%`}{!aggregate && ` · Components ${year.components}`}</p>
          <div className="flex gap-1" role="group" aria-label="Step through June series">
            <button type="button" className={choiceStyle + " min-w-11 disabled:opacity-45"} aria-label="Previous year" disabled={yearIndex === 0}
              onClick={() => { setHover(null); setPinned(series[yearIndex - 1].year); }}>←</button>
            <button type="button" className={choiceStyle + " min-w-11 disabled:opacity-45"} aria-label="Next year" disabled={yearIndex === series.length - 1}
              onClick={() => { setHover(null); setPinned(series[yearIndex + 1].year); }}>→</button>
          </div>
        </div>
        {year.percent !== null && <p className="mt-2 text-xs tabular-nums text-muted-foreground">
          {aggregate ? `(${pairMarks.join(" + ")}) ÷ (${pairMarks.length} × ${year.max}) × 100 = ${year.percent.toFixed(1)}%` : `${year.mark} ÷ ${year.max} × 100 = ${year.percent.toFixed(1)}%`}
        </p>}
        {aggregate && <ul aria-label={`June ${year.year} paper pairs for grade ${grades[gradeIndex]}`} className="mt-2 grid gap-1 text-xs sm:grid-cols-3">
          {pairs.map(([components, marks]) => <li key={components} className="flex flex-wrap items-baseline justify-between gap-x-2 rounded border px-2 py-1">
            <span>Papers {components.replace(", ", " + ")}</span><strong className="tabular-nums">{marks[gradeIndex]}/{year.max}</strong>
          </li>)}
        </ul>}
        <a className="mt-1 inline-flex min-h-10 items-center text-sm text-primary underline underline-offset-4" href={year.source} target="_blank" rel="noreferrer">Open {year.year} Cambridge table <span className="ml-1 text-xs text-muted-foreground">(new tab)</span></a>
      </div>
      {route.code === "0500" && <p className="mt-2 text-sm text-muted-foreground">
        {aggregate ? "Each distinct pair of written exams counts once per June series. Before 2020, Core and Extended offered different grades. Only pairs that offered the selected grade count." : writtenEnglish && (period === "earlier" || period === "all") ? "The 2011–2019 written route used papers 22 and 32, worth 100 weighted marks. From 2021 the June exams used papers 12 and 22, worth 160." : route.years[0].components === "12, 22" ? "Paper 12 (Reading) and Paper 22 (Directed Writing and Composition)." : "Paper 12 (Reading) and Component 03 (Coursework Portfolio)."} The optional speaking test has a separate grade. <a className="underline underline-offset-4" href="https://www.cambridgeinternational.org/Images/635230-2024-2026-syllabus.pdf">0500 syllabus</a>
      </p>}
      {writtenEnglish && period === "all" && <p className="mt-1 text-xs text-muted-foreground">Each sitting has equal weight. Cambridge cancelled the <a className="underline" href="https://www.cambridgeinternational.org/news/news-details/view/update-from-cambridge-international-on-may-june-2020-exams-20200323/">June 2020 series</a>. The June 2010 table lists component thresholds only.</p>}
      <div className="overflow-x-auto">
      <div className="relative ml-9 mr-1 mb-7 mt-6 h-40 border-b sm:h-48" style={{ minWidth: series.length * 36 }}>
        {[0, 50, 100].map(value => <div key={value} className="absolute inset-x-0 border-t border-border" style={{ bottom: value + "%" }}>
          <span className="absolute right-full mr-2 -translate-y-1/2 text-xs text-muted-foreground">{value}%</span></div>)}
        <div className="absolute inset-0 grid" style={{ gridTemplateColumns: "repeat(" + series.length + ", minmax(0, 1fr))" }}>
          {series.map((s) => <button type="button" key={s.year} aria-pressed={year.year === s.year}
            aria-label={`Inspect June ${s.year}, grade ${grades[gradeIndex]}, ${s.percent === null ? "unavailable" : s.percent.toFixed(1) + " percent"}`}
            className="relative cursor-pointer rounded-t focus-visible:outline-2 focus-visible:outline-primary" onClick={() => setPinned(s.year)}
            onPointerEnter={e => { if (e.pointerType === "mouse") setHover(s.year); }} onPointerLeave={() => setHover(null)} onFocus={() => setHover(s.year)} onBlur={() => setHover(null)}>
            {s.percent !== null && <span className={`absolute inset-x-0 bottom-0 mx-auto w-3/5 max-w-20 rounded-t-sm ${(hover ?? year.year) === s.year ? "bg-primary" : "bg-primary/50"}`} style={{ height: s.percent + "%" }} />}
            <span className="absolute inset-x-0 top-full mt-1 text-center text-xs font-medium tabular-nums">{s.year}</span>
          </button>)}
        </div>
        <div className="pointer-events-none absolute inset-x-0 border-t-2 border-dashed border-[var(--chart-2)]" style={{ bottom: benchmark + "%" }}>
          <span className="absolute right-0 bottom-1 rounded-sm bg-card/95 px-1 text-xs font-medium">80% benchmark</span></div>
      </div>
      </div>
    </div>
  </div>;
}
