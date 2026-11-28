"use client";

import { useMemo, useState } from "react";
import { factorFit, linearFit, observations, type Observation, type Outcome, type Report } from "@/lib/hiring/ats-regression";
import { trialScore } from "@/lib/hiring/ats-trial";
import { MockBacktest } from "./ats-mock-backtest";
import s from "./ats-analysis.module.css";

const format = new Intl.NumberFormat("en", { maximumFractionDigits: 1 });
const signed = new Intl.NumberFormat("en", { maximumFractionDigits: 1, signDisplay: "exceptZero" });
const labels = { paper: "Subject paper", mock: "Mock teaching", decision: "Hiring decision" };
const ticks = [0, 25, 50, 75, 100];

function ScorePlot({ points, outcome, fit, cutoff }: { cutoff: number; points: Observation[]; outcome: Outcome; fit: ReturnType<typeof linearFit> }) {
  const [selected, setSelected] = useState("");
  const current = points.find(p => p.id === selected) ?? points[0];
  if (!current) return <p className={s.foot}>No candidates have both scores for this comparison yet.</p>;
  const groups = new Map<string, Observation[]>();
  for (const p of points) {
    const key = p.x + "/" + p.y;
    const members = groups.get(key);
    if (members) members.push(p); else groups.set(key, [p]);
  }
  const xs = points.map(p => p.x);
  const left = Math.min(...xs), right = Math.max(...xs);
  const yLabel = outcome === "decision" ? "Confirmed decision" : labels[outcome] + " score (%)";
  const result = outcome === "decision" ? current.positive ? "Hired" : "Rejected" : format.format(current.y) + "%";
  return <>
    <div className={s.key}>{yLabel} · {points.length} candidates{fit && " · Line shows the fitted trend"}</div>
    <div className={s.plot} role="group" aria-label={yLabel + " by ATS score"}>
      {(outcome === "decision" ? [0, 100] : ticks).map(t =>
        <span className={s.tickY} key={t} style={{ bottom:t+"%" }}>{outcome === "decision" ? t ? "Hire" : "Reject" : t}</span>)}
      {ticks.map(t => <span className={s.tickX} key={t} style={{ left:t+"%" }}>{t}</span>)}
      <span className={s.cutoff} style={{ left:cutoff+"%" }} aria-hidden="true"/>
      {fit && <svg viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
        <line x1={left} x2={right} y1={100-fit.intercept-fit.slope*left} y2={100-fit.intercept-fit.slope*right}
          stroke="#607780" strokeWidth="2" strokeDasharray="5 4" vectorEffect="non-scaling-stroke"/>
      </svg>}
      {[...groups.entries()].map(([key, group]) => {
        const p = group[0], index = group.findIndex(item => item.id === current.id);
        const next = group[(index + 1) % group.length];
        const inspect = group.length > 1 ? " · " + group.length + " at this point. Inspect " + next.name : " · " + p.name;
        const title = "ATS " + format.format(p.x) + " · " + (outcome === "decision" ? p.positive ? "Hired" : "Rejected" : format.format(p.y) + "%") + inspect;
        return <button key={key} type="button" className={s.dot} style={{ left:p.x+"%", bottom:p.y+"%" }}
          aria-label={title} title={title} aria-pressed={index >= 0} onClick={() => setSelected(next.id)}>{group.length > 1 && <b className={s.count}>{group.length}</b>}</button>;
      })}
    </div>
    <p className={s.axis}>ATS score (points) <span className={s.cutoffKey}>Saved cutoff {cutoff}</span></p>
    <div className={s.inspect}>
      <label>Inspect candidate <select value={current.id} onChange={e=>setSelected(e.target.value)}>
        {points.map(p => <option value={p.id} key={p.id}>{p.name}</option>)}</select></label>
      <span aria-live="polite"><strong>{result}</strong> · ATS {format.format(current.x)}{current.subjects.length ? " · " + current.subjects.join(", ") : ""}</span>
    </div>
  </>;
}

function CutoffBands({ points, outcome, cutoff }: { points: Observation[]; outcome: Outcome; cutoff: number }) {
  return <>
    <h3>{outcome === "mock" ? "Mean mock score" : outcome === "paper" ? "Paper pass rate" : "Share hired"} by cutoff</h3>
    {[false, true].map(above => {
      const band = points.filter(p => (p.x >= cutoff) === above && (outcome === "mock" || p.positive !== null));
      const passed = band.filter(p => p.positive).length;
      const value = band.length ? (outcome === "mock" ? band.reduce((sum,p) => sum + p.y, 0) : 100*passed) / band.length : null;
      return <div key={String(above)} className={s.band}>
        <span>{above ? "At or above " : "Below "}{cutoff}</span>
        <strong>{value === null ? "No observations" : outcome === "mock" ? format.format(value)+"% · n="+band.length : passed+" / "+band.length+" · "+format.format(value)+"%"}</strong>
        <span className={s.track} aria-hidden="true"><i className={s.fill} style={{ width:(value ?? 0)+"%" }}/></span>
      </div>;
    })}
  </>;
}

function ScoreFactors({ report, paper, onTrial }: { report: Report; paper: Observation[]; onTrial: (from: string, to: string) => void }) {
  const fit = useMemo(() => factorFit(paper), [paper]);
  const [expanded, setExpanded] = useState<string | null>(null);
  const factors = [...report.dimensions, { name: "Work-rights deduction", weight: null }].map((d,i) => ({ ...d, index: i, ...fit?.factors[i] }))
    .sort((a,b) => Math.abs(b.value ?? 0) - Math.abs(a.value ?? 0));
  const largest = Math.max(1, ...factors.map(f => Math.abs(f.value ?? 0)));
  const positive = factors.filter(f => f.weight !== null && f.value !== undefined && f.value !== null && f.value > 0).sort((a,b) => b.value! - a.value!)[0];
  const donor = factors.find(f => f.weight !== null && f.weight >= 5 && f.value === null);
  const stable = positive && positive.low !== null && positive.low !== undefined && positive.low > 0 && positive.folds === paper.length;
  const trialCases = positive && donor ? report.cases.flatMap(c => c.ats && c.paper ? [{
    result: c.paper, before: c.ats.score >= report.threshold, after: trialScore(c.ats, donor.name, positive.name) >= report.threshold,
  }] : []) : [];
  const changed = trialCases.filter(c => c.before !== c.after);
  return <section id="factors" tabIndex={-1} className={s.surface} aria-labelledby="factor-title">
    <div className={s.factorHead}><h2 className={s.factorTitle} id="factor-title">Which factors track paper scores?</h2>
      <p className={s.caption}>All dimensions fitted together · {paper.length} candidates · ranked by the size of the association</p></div>
    <div className={s.factorGrid}><div className={s.factorList}>
      {factors.map(f => {
        const open = expanded === f.name;
        const levels = new Map<number, { total: number; n: number }>();
        if (open) for (const p of paper) {
          const value = p.factors[f.index];
          const level = levels.get(value) ?? { total: 0, n: 0 };
          level.total += p.y; level.n++;
          levels.set(value, level);
        }
        return <div key={f.name}>
          <button type="button" className={s.factor} aria-expanded={open} aria-controls={"factor-"+f.index}
            onClick={()=>setExpanded(open ? null : f.name)}>
            <span><strong>{f.name}</strong><small>{f.weight === null ? "Eligibility deduction" : f.weight+" ATS points"}</small></span>
            <span className={s.diverge} aria-hidden="true">{f.value != null && <span style={{ width: Math.abs(f.value)/largest*49+"%",
              ...(f.value < 0 ? { right:"50%",background:"var(--negative)" } : {left:"50%",background:"var(--teal)"}) }}/>}</span>
            <span className={s.estimate}>{!fit ? "No fit" : f.value == null ? "No variation" : signed.format(f.value)+" pts"} <b aria-hidden="true">{open ? "−" : "+"}</b></span>
          </button>
          <div id={"factor-"+f.index} hidden={!open} className={s.breakdown}>
            <strong>Observed paper scores by {f.weight === null ? "deduction" : "rubric credit"}</strong>
            {levels.size ? [...levels].sort(([a],[b])=>a-b).map(([v,level])=>
              <p key={v}>{f.weight === null ? format.format(v)+" points deducted" : format.format(v*100)+"% credit"} · {level.n} {level.n === 1 ? "candidate" : "candidates"} · mean paper {format.format(level.total/level.n)}%</p>)
              : <p>No paired paper scores yet.</p>}
          </div>
        </div>;
      })}
      <p className={s.caption}>Each value is the estimated change in paper percentage points for a one-standard-deviation increase in the factor, with the other factors held fixed. A positive value points toward higher scores.</p>
    </div>
    <aside className={s.aside}><h3>Paper-only comparison</h3>
      <p><strong>Check the paper model against a simple average.</strong> {fit ? <>The model missed held-out scores by <strong>{format.format(fit.mae)} points</strong> on average. The training mean alone missed by <strong>{format.format(fit.baseline)} points</strong>.</> : "Three paired candidates are needed to evaluate the model."}</p>
      {positive && <p>{positive.name} has the largest positive estimate ({signed.format(positive.value!)} pts). {stable ? "It stayed positive in each single-candidate omission." : "Its direction or availability changes when one candidate is omitted."}</p>}
      {fit && !positive && <p>No rubric dimension has a positive adjusted estimate in this sample.</p>}
      {positive && positive.weight && donor ? <><p>For a paper-only trial, move five points from {donor.name} to {positive.name}. {donor.name} gave every assessed candidate the same credit. In this replay, {changed.length} of {trialCases.length} scored candidates with settled verdicts cross {report.threshold} ({changed.filter(c=>c.result==="pass").length} paper passes). Record both scores before next month’s papers and compare missed passes.</p>
        <button type="button" className="min-h-11 self-start rounded-md border border-current px-3 font-semibold" onClick={()=>onTrial(donor.name,positive.name)}>Preview five-point transfer</button></>
        : <p>Keep scoring the next cohort under the saved rule. Record the scores before assessment and check the result again after marking.</p>}
    </aside></div>
    <details className={s.factorFoot}><summary className="min-h-11 cursor-pointer py-2 font-semibold">Model method and sensitivity</summary>
      <p>Ridge regression uses the seven rubric fractions and the work-rights deduction. Each fold standardizes the training candidates, fits an intercept and uses a fixed penalty of 1. Unknown rubric evidence receives the same zero credit as in the ATS. A factor shared by everyone has no measurable association. Correlated factors can share an association. These estimates do not establish causes.</p>
      {fit && <ul className="mt-2 grid gap-1">{factors.filter(f=>f.value != null).map(f=><li key={f.name}><strong>{f.name}</strong> · {f.low == null || f.high == null ? "Unavailable" : signed.format(f.low)+" to "+signed.format(f.high)+" pts"} · {f.folds} / {paper.length} omission fits</li>)}</ul>}
    </details>
  </section>;
}

export function AtsAnalysis({ report, onTrial }: { report: Report; onTrial: (from: string, to: string) => void }) {
  const [outcome, setOutcome] = useState<Outcome>("paper");
  const paper = useMemo(() => observations(report, "paper"), [report]);
  const sample = useMemo(() => outcome === "paper" ? paper : observations(report, outcome), [report, outcome, paper]);
  const { points } = sample;
  const fit = outcome === "decision" ? null : linearFit(points);
  const hires = points.filter(p => p.positive), rejected = points.filter(p => p.positive === false);
  return <>
    <MockBacktest report={report}/>
    <section id="analysis" tabIndex={-1} className={s.surface} aria-labelledby="relationship-title">
      <div className={s.head}><div><h2 id="relationship-title">ATS score and outcomes</h2>
        <p className={s.caption}>{labels[outcome]} · {points.length} paired candidates</p></div>
        <div className={s.tabs} role="group" aria-label="Choose outcome">{(Object.keys(labels) as Outcome[]).map(kind =>
          <button key={kind} aria-pressed={kind===outcome} onClick={()=>setOutcome(kind)}>{labels[kind]}</button>)}</div></div>
      <div className={s.content}><div className={s.chart}><ScorePlot key={outcome} points={points} outcome={outcome} fit={fit} cutoff={report.threshold}/></div>
        <aside className={s.aside}>
          <h3>{outcome === "decision" ? "Confirmed decisions" : "For 10 more ATS points"}</h3>
          {outcome === "decision" ? <p><strong>{hires.length} scored hires · {rejected.length} scored rejections</strong>. {hires.length && rejected.length
            ? "Mean ATS score was "+format.format(hires.reduce((sum,p)=>sum+p.x,0)/hires.length)+" for hires and "+format.format(rejected.reduce((sum,p)=>sum+p.x,0)/rejected.length)+" for rejections."
            : "Both decision groups need scored candidates for a comparison."}</p>
          : fit ? <><div className={s.fact}><strong>{signed.format(fit.slope*10)}</strong> <small>{outcome === "paper" ? "paper" : "mock"} percentage points</small></div>
            <p className={s.caption}>{fit.r2 === null ? "All observed results are equal. R² is undefined." : "The fitted line accounts for "+format.format(fit.r2*100)+"% of the variation in this sample (R²)."} {fit.low !== null && fit.high !== null && <>Leaving one candidate out gives {signed.format(fit.low*10)} to {signed.format(fit.high*10)} points ({fit.folds}/{points.length} fits).</>}</p></>
          : <p>{points.length < 3 ? "A fitted trend needs at least three paired candidates." : "Every candidate has the same ATS score. A slope cannot be estimated."}</p>}
          <CutoffBands points={points} outcome={outcome} cutoff={report.threshold}/>
        </aside></div>
      <div className={s.foot}><strong>Sample coverage</strong> · {points.length} paired + {sample.noScore} with an outcome but no ATS score + {sample.noOutcome} without this outcome = {report.cases.length} in the report.
        <p>{outcome === "decision" ? "A confirmed hire or rejection requires a sent decision that matches the candidate’s stage." : outcome === "paper" ? "Each point averages one candidate’s settled subject scores. A subject uses its qualifying level or best attempted level, including applicable head checks. Pass rates use the settled candidate verdict." : "Each point averages one candidate’s completed subject rubrics. Each website rubric score is earned marks divided by available marks. Historical tracker marks appear in the mock backtest."} The report includes candidates with an assessment record or a final stage. Scores replay today’s weights. Candidates who never reached assessment have no observed test score. Results can differ by subject and test level.</p>
      </div>
    </section>
    <ScoreFactors report={report} paper={paper.points} onTrial={onTrial}/>
  </>;
}
