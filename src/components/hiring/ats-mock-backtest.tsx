"use client";

import { useState } from "react";
import { replayWeights } from "@/lib/hiring/ats-mock-backtest";
import type { Report } from "@/lib/hiring/ats-regression";
import s from "./ats-analysis.module.css";

const correlation = (v: number | null) => v === null ? "Undefined" : v.toFixed(3);
const decimal = new Intl.NumberFormat("en", {maximumFractionDigits:1});

export function MockBacktest({report}: {report: Report}) {
  const [chosen, setChosen] = useState<string | null>(null);
  const eligible = report.backtests.filter(b=>b.fit);
  const preferred = eligible.find(b=>b.source==="website") ?? eligible[0] ?? report.backtests.find(b=>b.source==="tracker")!;
  const b = report.backtests.find(b=>b.source===chosen) ?? preferred;
  const {fit} = b;
  const tracker = b.source==="tracker";
  const counts = b.pairs.length;
  return <section className={s.surface} id="mock-backtest" tabIndex={-1} aria-labelledby="backtest-heading">
    <div className={s.head}><div><h2 id="backtest-heading">Mock performance backtest</h2>
      <p className={s.caption}>{tracker ? "Recruitment tracker · raw mock marks" : "Hiring website · completed mock rubric (%)"} · {counts} paired paper sitters</p></div>
      <div role="group" aria-label="Mock score source" className={s.tabs}>{report.backtests.map(item=>
        <button key={item.source} aria-pressed={item.source===b.source} onClick={()=>setChosen(item.source)}>{item.source==="tracker"?"Tracker marks":"Website rubrics"}</button>)}</div>
    </div>
    <div className={s.content}><div className={s.chart}>
      <h3>Weight decision for next month</h3>
      <p className={s.recommendation}>{!report.trackerAvailable && tracker ? "The tracker could not be read." : fit && fit.bestR > (fit.savedR ?? -2)+1e-9
        ? "Keep the saved weights live. Test the best mock-based mix in parallel." : "Keep the saved weights."}</p>
      {fit && <p className={s.caption}><strong>Trial weight changes</strong> · {report.dimensions.flatMap((d,i) =>
        d.weight===fit.weights[i] ? [] : [d.name+" "+d.weight+" → "+fit.weights[i]]).join(" · ") || "Keep all seven weights"}</p>}
      {fit ? <><div className={s.comparison}><div><small>Saved correlation</small><strong>{correlation(fit.savedR)}</strong></div><div><small>Best replay correlation</small><strong>{correlation(fit.bestR)}</strong></div></div>
        <p className={s.caption}>{fit.tried.toLocaleString("en-US")} allocations checked · {fit.ties.toLocaleString("en-US")} tied for best. Among ties, the trial keeps weights closest to the saved rule.</p></>
        : <p>{counts<3?"At least three paper sitters need a recorded mock mark and ATS dimensions.":"The available scores have too little variation to estimate a correlation."}</p>}
    </div>
    <aside className={s.aside}><h3>Can the result carry forward?</h3>
      {fit?.folds ? <p>After choosing weights again with each candidate left out, the mean error was <strong>{decimal.format(fit.mae!)} marks</strong>. The saved rule missed by <strong>{decimal.format(fit.savedMae!)} marks</strong> and the training mean by <strong>{decimal.format(fit.baseline!)} marks</strong> across {fit.folds} of {counts} folds. {fit.mae! > fit.savedMae! ? "The saved rule predicted these held-out marks more accurately." : fit.mae! < fit.savedMae! ? "The trial had smaller held-out errors on these candidates." : "Both rules had the same mean error."}</p>
        : <p>There are too few informative candidates for a held-out check. A close fit to these scores can disappear on the next mock.</p>}
      <p>Record the saved and trial scores before each new mock. Compare their correlations on the next cohort before changing invitations.</p>
    </aside></div>
    {fit && <details className={s.factorFoot}><summary className="min-h-11 cursor-pointer py-2 font-semibold">Inspect optimized weights and candidate replay</summary>
      <table className={s.replay}><caption>ATS points in the saved and trial rules</caption><thead><tr><th>Dimension</th><th>Saved</th><th>Trial</th><th>Change</th></tr></thead><tbody>
        {report.dimensions.map((d,i)=><tr key={d.name}><th scope="row">{d.name}</th><td>{d.weight}</td><td>{fit.weights[i]}</td><td>{fit.weights[i]>d.weight?"+":""}{fit.weights[i]-d.weight}</td></tr>)}
      </tbody></table>
      <table className={s.replay}><caption>One row per paper sitter with both scores</caption><thead><tr><th>Candidate</th><th>Saved ATS</th><th>Trial ATS</th><th>Mock mark</th></tr></thead>
        <tbody>{b.pairs.map(p=><tr key={p.id}><th scope="row">{p.name}</th><td>{decimal.format(p.saved)}</td><td>{decimal.format(replayWeights(p,fit.weights))}</td><td>{decimal.format(p.mark)}</td></tr>)}</tbody></table>
    </details>}
    <div className={s.foot}><strong>Coverage</strong> · {b.marks} matched marks from {b.people} people · {counts} paired · {b.missingAts} sitters missing ATS dimensions · {b.noPaper} without a confirmed paper attempt.{tracker && <> {report.unmatchedMarks} numeric marks could not be matched to one ATS identity.</>}
      <p>Each person contributes their average mock mark. The tracker and website use separate comparisons. The search maximizes Pearson’s r across five-point allocations totaling 100, with the saved deduction and zero floor. It replays current résumé evidence. No dated pre-mock score is assumed.</p>
    </div>
  </section>;
}
