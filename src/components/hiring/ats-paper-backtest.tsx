"use client";

import { replayWeights } from "@/lib/hiring/ats-paper-backtest";
import type { Report } from "@/lib/hiring/ats-regression";
import s from "./ats-analysis.module.css";

const correlation = (v: number | null) => v === null ? "Undefined" : v.toFixed(3);
const decimal = new Intl.NumberFormat("en", {maximumFractionDigits:1});

export function PaperBacktest({report, onPlot}: {report: Report; onPlot: (trial: boolean) => void}) {
  const b = report.backtest;
  const {fit} = b;
  const counts = b.pairs.length;
  const verdicts = new Map(report.cases.map(c => [c.id, c.paper]));
  const atCutoff = (trial: boolean) => b.pairs.filter(p => verdicts.get(p.id) && (trial && fit ? replayWeights(p,fit.weights) : p.saved) >= report.threshold);
  const savedAbove = atCutoff(false), trialAbove = atCutoff(true);
  return <section className={s.surface} id="paper-backtest" tabIndex={-1} aria-labelledby="backtest-heading">
    <div className={s.head}><div><h2 id="backtest-heading">Written paper backtest</h2>
      <p className={s.caption}>ATS score against written paper percentage · {counts} paired candidates</p></div></div>
    <div className={s.content}><div className={s.chart}>
      <h3>Weight decision for next month</h3>
      <p className={s.recommendation}>{fit?.mae != null && fit.savedMae != null && fit.mae > fit.savedMae
        ? "Keep the saved weights. The tuned rule had larger errors on held-out papers." : fit && fit.bestR > (fit.savedR ?? -2)+1e-9
        ? "Keep the saved weights live. Test the best paper-based mix in parallel." : "Keep the saved weights."}</p>
      {fit && <p className={s.caption}><strong>Trial weight changes</strong> · {report.dimensions.flatMap((d,i) =>
        d.weight===fit.weights[i] ? [] : [d.name+" "+d.weight+" → "+fit.weights[i]]).join(" · ") || "Keep all seven weights"}</p>}
      {fit ? <><div className={s.correlation}>
          {[{label:"Saved correlation",r:fit.savedR,trial:false},{label:"Best replay correlation",r:fit.bestR,trial:true}].map(item =>
            <button type="button" key={item.label} onClick={()=>onPlot(item.trial)} aria-label={"Inspect "+item.label.toLowerCase()+" on the score plot"}>
              <span>{item.label}</span><strong>{correlation(item.r)}</strong>
              <i className={s.diverge} aria-hidden="true">{item.r !== null && <span style={{width:Math.abs(item.r)*50+"%", ...(item.r<0?{right:"50%",background:"var(--negative)"}:{left:"50%",background:"var(--teal)"})}}/>}</i>
            </button>)}
        </div><p className={s.caption}>Correlation ranges from −1 to +1. Select a rule to inspect its score plot.</p>
        <p className={s.caption}>{fit.tried.toLocaleString("en-US")} allocations checked · {fit.ties.toLocaleString("en-US")} tied for best. Among ties, the trial keeps weights closest to the saved rule.</p>
        <p className={s.caption}><strong>At the saved cutoff of {report.threshold}</strong> · {savedAbove.filter(p=>verdicts.get(p.id)==="pass").length} passes among {savedAbove.length} meeting the saved rule. The tuned rule includes {trialAbove.filter(p=>verdicts.get(p.id)==="pass").length} passes among {trialAbove.length}.</p></>
        : <p>{counts<3?"At least three paper sitters need a settled written paper percentage and ATS dimensions.":"The available scores have too little variation to estimate a correlation."}</p>}
    </div>
    <aside className={s.aside}><h3>Can the result carry forward?</h3>
      {fit?.folds ? <p>After choosing weights again with each candidate left out, the mean error was <strong>{decimal.format(fit.mae!)} percentage points</strong>. The saved rule missed by <strong>{decimal.format(fit.savedMae!)} percentage points</strong> and the training mean by <strong>{decimal.format(fit.baseline!)} percentage points</strong> across {fit.folds} of {counts} folds. {fit.mae! > fit.savedMae! ? "The saved rule predicted these held-out marks more accurately." : fit.mae! < fit.savedMae! ? "The trial had smaller held-out errors on these candidates." : "Both rules had the same mean error."}</p>
        : <p>There are too few informative candidates for a held-out check. A close fit to these scores can disappear on the next written paper.</p>}
      <p>Record the saved and trial scores before each new written paper. Compare their correlations on the next cohort before changing invitations.</p>
    </aside></div>
    {fit && <details className={s.factorFoot}><summary className="min-h-11 cursor-pointer py-2 font-semibold">Inspect optimized weights and candidate replay</summary>
      <table className={s.replay}><caption>ATS points in the saved and trial rules</caption><thead><tr><th>Dimension</th><th>Saved</th><th>Trial</th><th>Change</th></tr></thead><tbody>
        {report.dimensions.map((d,i)=><tr key={d.name}><th scope="row">{d.name}</th><td>{d.weight}</td><td>{fit.weights[i]}</td><td>{fit.weights[i]>d.weight?"+":""}{fit.weights[i]-d.weight}</td></tr>)}
      </tbody></table>
      <table className={s.replay}><caption>One row per paper sitter with both scores</caption><thead><tr><th>Candidate</th><th>Saved ATS</th><th>Trial ATS</th><th>Paper (%)</th></tr></thead>
        <tbody>{b.pairs.map(p=><tr key={p.id}><th scope="row">{p.name}</th><td>{decimal.format(p.saved)}</td><td>{decimal.format(replayWeights(p,fit.weights))}</td><td>{decimal.format(p.mark)}</td></tr>)}</tbody></table>
    </details>}
    <div className={s.foot}><strong>Coverage</strong> · {b.paperCount} settled subject papers from {counts + b.missingAts} candidates · {counts} have ATS dimensions · {b.missingAts} have no ATS score.
      <p>Each person contributes their average settled subject paper percentage. Only candidates who reached testing have an observed mark. The search maximizes Pearson’s r across five-point allocations totaling 100, with the saved deduction and zero floor. It replays current résumé evidence. Actual scores used before the paper may differ.</p>
    </div>
  </section>;
}
