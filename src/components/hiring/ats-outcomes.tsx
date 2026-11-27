"use client";

import { useState } from "react";
import { HiringReportJump } from "@/components/hiring/hiring-report-nav";
import type { atsOutcomes } from "@/lib/hiring/ats-outcomes";
import { trialScore } from "@/lib/hiring/ats-trial";

type Report = Awaited<ReturnType<typeof atsOutcomes>>;
const fmt = new Intl.NumberFormat("en", { maximumFractionDigits: 2 });
const changeFmt = new Intl.NumberFormat("en", { maximumFractionDigits: 2, signDisplay: "exceptZero" });
const panel = "rounded-xl border bg-card p-4 sm:p-6";
const heading = "text-lg font-semibold tracking-tight";
const small = "text-sm text-muted-foreground";
const select = "mt-1 block min-h-11 w-full rounded-md border bg-background px-2 py-2 text-sm";
const table = "w-full text-left text-sm tabular-nums [&_td]:p-2 [&_th]:p-2 [&_tr]:border-b";

export function AtsOutcomes({ report }: { report: Report }) {
  const { cases, threshold, accepted, rejected } = report;
  const [cutoff, setCutoff] = useState(threshold);
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [candidateName, setCandidateName] = useState("");
  const criteria = cases.find(c => c.ats)?.ats?.parts ?? [];
  const scored = cases.flatMap(c => c.ats ? [{ ...c, ats: c.ats, trial: trialScore(c.ats, from, to) }] : []);
  const trialByCandidate = new Map(scored.map(c => [c.id, c.trial]));
  const passed = scored.filter(c => c.paper === "pass");
  const failed = scored.filter(c => c.paper === "fail");
  const tested = [...passed, ...failed];
  const above = tested.filter(c => c.ats.score >= threshold);
  const below = tested.filter(c => c.ats.score < threshold);
  const missed = below.filter(c => c.paper === "pass");
  const reviewFloor = missed.length ? Math.floor(Math.max(...missed.map(c => c.ats.score))) : null;
  const band = reviewFloor === null ? [] : below.filter(c => c.ats.score >= reviewFloor);
  const criteriaCounts = criteria.filter(p => p.max > 0).map(p => {
    const full = (group: typeof scored) => group.filter(c => c.ats.parts.some(part => part.name === p.name && part.earned === p.max)).length;
    return { ...p, pass: full(passed), fail: full(failed), reject: full(scored.filter(c => c.decision === "Rejected")), hire: full(scored.filter(c => c.decision === "Accepted")) };
  });
  const flat = criteriaCounts.filter(p => tested.length > 1 && passed.length && failed.length && p.pass + p.fail === tested.length);
  const crossed = scored.filter(c => (c.trial >= cutoff) !== (c.ats.score >= threshold));
  const outcomes = [
    { label: "Paper passed", group: passed, total: cases.filter(c => c.paper === "pass").length },
    { label: "Paper failed", group: failed, total: cases.filter(c => c.paper === "fail").length },
    { label: "Accepted", group: scored.filter(c => c.decision === "Accepted"), total: accepted.total },
    { label: "Rejected", group: scored.filter(c => c.decision === "Rejected"), total: rejected.total },
  ];
  const donor = criteria.find(p => p.name === from);
  const recipient = criteria.find(p => p.name === to);
  const trialActive = cutoff !== threshold || Boolean(donor && recipient);
  const nameQuery = candidateName.trim().toLowerCase();
  const evidence = cases.filter(c => c.name.toLowerCase().includes(nameQuery));
  function resetTrial(nextCutoff: number) {
    setCutoff(nextCutoff);
    setFrom("");
    setTo("");
  }
  return <>
    <section className="rounded-xl border-l-4 border-l-primary bg-primary/5 p-4 sm:p-6">
      <h2 className={heading}>What should we tune?</h2>
      {above.length ? <p className="mt-3"><strong>{above.filter(c => c.paper === "pass").length} of {above.length}</strong> assessed candidates at or above {threshold} passed a subject paper. {below.length ? <><strong>{below.filter(c => c.paper === "pass").length} of {below.length}</strong> below the cutoff also passed.</> : "There are no settled, scored paper results below the cutoff."}</p> : <p className="mt-3">There are no settled, scored paper results at or above {threshold} yet.</p>}
      {reviewFloor !== null && <div className="mt-3 rounded-lg border border-primary/20 bg-background p-3">
        <p><strong>Try manual review from {reviewFloor} to below {threshold}.</strong> In the scored paper sample, that band adds {band.filter(c => c.paper === "pass").length} who passed and {band.filter(c => c.paper === "fail").length} who failed. Count future results before widening invitations.</p>
        <button type="button" className="mt-1 min-h-11 cursor-pointer text-sm font-medium underline underline-offset-4" onClick={() => { resetTrial(reviewFloor); document.getElementById("ats-trial")?.focus(); }}>Preview cutoff {reviewFloor}</button>
      </div>}
      {flat.length > 0 && <p className="mt-2"><strong>Review the evidence for {flat.map(p => p.name).join(" and ")}.</strong> All {tested.length} assessed candidates received full credit on these criteria, including all {failed.length} who failed their papers. Check what earns full credit before changing the weights.</p>}
      <p className="mt-2">{accepted.scored === 0 ? "Keep the live cutoff for now. There are no scored hires to show whether a higher cutoff would screen out people BeGifted would hire." : "Compare hires that a trial would screen out with rejections it would screen out before choosing a cutoff."} Only candidates who reached assessment have test results.</p>
    </section>
    <section className={panel}>
      <div className="flex flex-wrap items-baseline justify-between gap-x-3">
        <h2 id="ats-trial" tabIndex={-1} className={heading}>Test a scoring change</h2>
        <button type="button" className="min-h-11 cursor-pointer rounded-md border px-3 text-sm font-medium hover:bg-muted" onClick={() => resetTrial(threshold)}>Reset trial</button>
      </div>
      <p className="mt-2 rounded-md bg-muted px-3 py-2 text-sm"><strong>Preview only.</strong> Trial settings apply to this report. Hiring uses the live cutoff of {threshold} and the current weights.</p>
      <div className="my-4 grid gap-3 sm:grid-cols-3">
        <div>
          <label htmlFor="ats-cutoff">Trial cutoff <strong>{cutoff}</strong></label>
          <div className="grid grid-cols-[44px_minmax(0,1fr)_44px] items-center gap-2">
            <button type="button" aria-label="Lower trial cutoff by one point" className="size-11 cursor-pointer rounded-md border hover:bg-muted disabled:opacity-50" disabled={cutoff === 0} onClick={() => setCutoff(value => Math.max(0, value - 1))}>−</button>
            <input id="ats-cutoff" className="block h-11 w-full accent-primary" type="range" min="0" max="100" value={cutoff} onChange={e => setCutoff(Number(e.target.value))}/>
            <button type="button" aria-label="Raise trial cutoff by one point" className="size-11 cursor-pointer rounded-md border hover:bg-muted disabled:opacity-50" disabled={cutoff === 100} onClick={() => setCutoff(value => Math.min(100, value + 1))}>+</button>
          </div>
        </div>
        <label>Move five points from<select className={select} value={from} onChange={e => {setFrom(e.target.value); setTo("");}}>
          <option value="">Keep current weights</option>{criteria.filter(p => p.max >= 5).map(p => <option key={p.name}>{p.name}</option>)}</select></label>
        <label>Move points to<select className={select} disabled={!from} value={to} onChange={e => setTo(e.target.value)}>
          <option value="">Choose criterion</option>{criteria.filter(p => p.max && p.name !== from).map(p => <option key={p.name}>{p.name}</option>)}</select></label>
      </div>
      {donor && recipient && <p className="mb-3 text-sm"><strong>Trial weights</strong> · {from} {donor.max} → {donor.max - 5} · {to} {recipient.max} → {recipient.max + 5}</p>}
      <table className={table + " max-sm:[&_td]:px-1 max-sm:[&_th]:px-1"}><caption className="mb-2 text-left font-medium">Candidates meeting the cutoff</caption>
        <thead><tr><th>Observed outcome</th><th>Current · {threshold}</th><th>Trial · {cutoff}</th><th>Change</th></tr></thead>
        <tbody>{outcomes.map(({ label, group, total }) => {
          const current = group.filter(c => c.ats.score >= threshold).length;
          const trial = group.filter(c => c.trial >= cutoff).length;
          return <tr key={label}><th scope="row" className="font-medium">{label}<span className="block text-xs font-normal text-muted-foreground">{group.length} scored of {total}</span></th>
            {group.length ? <><td>{current} / {group.length}</td><td>{trial} / {group.length}</td><td className="font-medium">{changeFmt.format(trial - current)}</td></> : <td colSpan={3} className={small}>No scored candidates</td>}</tr>;
        })}</tbody></table>
      <div className="mt-3 text-sm" aria-live="polite">{crossed.length ? <><strong>{crossed.length} crossed the cutoff.</strong> {crossed.map(c => c.name + (c.trial >= cutoff ? " (now above or at cutoff)" : " (now below)")).join(", ")}.</> : "No candidate in this sample crosses the cutoff in this trial."}</div>
    </section>
    <section className={panel}><h2 className={heading}>Which criteria awarded full points?</h2>
      <p className={small}>Read each column as candidates with full credit out of scored candidates with that outcome. A subject paper tests subject knowledge. The mock provides separate evidence of teaching ability.</p>
      {criteriaCounts.length ? <table className={table + " [&_td]:px-1 [&_th]:px-1 max-[360px]:text-xs max-[360px]:[&_td]:px-0.5 max-[360px]:[&_th]:px-0.5 sm:[&_td]:px-2 sm:[&_th]:px-2"}><thead><tr><th>Criterion</th><th>Paper pass</th><th>Paper fail</th><th>Hired</th><th>Rejected</th></tr></thead>
        <tbody>{criteriaCounts.map(p => <tr key={p.name}><th scope="row" className="font-normal">{p.name} <span className={small}>({p.max})</span></th><td>{passed.length ? p.pass + " / " + passed.length : "—"}</td><td>{failed.length ? p.fail + " / " + failed.length : "—"}</td><td>{accepted.scored ? p.hire + " / " + accepted.scored : "—"}</td><td>{rejected.scored ? p.reject + " / " + rejected.scored : "—"}</td></tr>)}</tbody></table> : <p>No scored assessments yet.</p>}
    </section>
    <section className={panel}>
      <div className="flex flex-wrap items-baseline justify-between gap-x-3">
        <HiringReportJump id="ats-evidence-owner-link" fragment="owner-selections" className="order-last inline-flex min-h-11 items-center text-sm underline underline-offset-4">Open owner selections</HiringReportJump>
        <h2 id="candidate-evidence" tabIndex={-1} className={heading}>Candidate evidence</h2>
      </div>
      <p className={small}>{accepted.total} confirmed hires · {rejected.total} confirmed rejections · {tested.length} scored candidates with settled paper results. Expand a name to check its scores.</p>
      <label className="mt-3 block text-sm font-medium">Find candidate by name<input type="search" value={candidateName} onChange={e => setCandidateName(e.target.value)} aria-controls="ats-candidate-list" className={select + " sm:max-w-xs"}/></label>
      <div role="status" className="mt-1 text-sm text-muted-foreground">{nameQuery && (evidence.length ? evidence.length + " of " + cases.length + " candidates" : "No candidates match this name.")}</div>
      <div id="ats-candidate-list">
      {evidence.map(c => {
        const trial = trialByCandidate.get(c.id);
        return <details key={c.id} className="border-b py-2"><summary className="min-h-11 cursor-pointer rounded-sm py-2 text-sm focus-visible:outline-2 focus-visible:outline-offset-2"><strong>{c.name}</strong> · ATS {c.ats ? fmt.format(c.ats.score) : "unscored"} · {c.decision ?? "No confirmed final decision"}{c.paper ? " · Paper " + c.paper : ""}</summary>
        <div className="grid gap-1 py-2 pl-3 text-sm">
          <p>{c.results.length ? c.results.map(r => r.subject + " paper · " + (r.verdict ? r.verdict + " (" + r.percent + "%)" : "no settled result")).join("; ") : "No current paper result."}</p>
          <p>{c.mock.length ? c.mock.map(r => r.subject + " mock · " + r.percent + "%").join("; ") : "No completed mock rubric."}</p>
          {c.ratings.map(r => <p key={r.id}><strong>{r.id === "teaching" ? "Teaching" : "English"} · {r.result}</strong> {r.evidence || r.reason}</p>)}
          {c.ats && <p><strong>Current score components</strong> · {c.ats.parts.map(p => p.name + " " + fmt.format(p.earned) + "/" + p.max).join(" · ")} · Work rights deduction {c.ats.penalty}</p>}
          {c.ats && trialActive && trial !== undefined && <p><strong>ATS score</strong> · Current {fmt.format(c.ats.score)} · Trial {fmt.format(trial)} · Change {changeFmt.format(trial - c.ats.score)}</p>}
        </div></details>;
      })}
      </div>
    </section>
    <p className={small}>This review applies today’s weights to the latest résumé assessments. Paper passes include current head overrides. A candidate counts once per outcome and can appear in both a paper and a final decision row. Final decisions require a matching Hire or Reject record. Excluded from the final comparison: {report.softRejected} automatic soft rejections and {report.stageOnly} stage-only records.</p>
  </>;
}
