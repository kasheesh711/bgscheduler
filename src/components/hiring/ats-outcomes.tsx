"use client";

import { Fragment, useCallback, useEffect, useRef, useState } from "react";
import { HiringReportJump } from "@/components/hiring/hiring-report-nav";
import type { atsOutcomes } from "@/lib/hiring/ats-outcomes";
import { AtsAnalysis } from "./ats-analysis";
import { OwnerSelections } from "./owner-selections";
import { trialScore } from "@/lib/hiring/ats-trial";

type Report = Awaited<ReturnType<typeof atsOutcomes>>;
const fmt = new Intl.NumberFormat("en", { maximumFractionDigits: 2 });
const changeFmt = new Intl.NumberFormat("en", { maximumFractionDigits: 2, signDisplay: "exceptZero" });
const panel = "rounded-xl border bg-card p-4 sm:p-6";
const heading = "text-lg font-semibold tracking-tight";
const small = "text-sm text-muted-foreground";
const select = "mt-1 block min-h-11 w-full rounded-md border bg-background px-2 py-2 text-sm";
const table = "w-full text-left text-sm tabular-nums [&_td]:p-2 [&_th]:p-2 [&_tr]:border-b";

const clock = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Bangkok", year: "numeric", month: "short", day: "numeric",
  hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" });
function bangkokReadTime(iso: string) {
  const parts = Object.fromEntries(clock.formatToParts(new Date(iso)).map(p => [p.type, p.value]));
  return parts.day+" "+parts.month+" "+parts.year+" · "+parts.hour+":"+parts.minute+":"+parts.second;
}

export function AtsOutcomes({ initialReport }: { initialReport: Report }) {
  const [report, setReport] = useState(initialReport);
  const [state, setState] = useState<"ready" | "checking" | "stale" | "denied">("ready");
  const request = useRef<AbortController | null>(null);
  const rerun = useRef(false);
  const refresh = useCallback(async function read() {
    if (request.current || document.hidden) return;
    const controller = new AbortController();
    request.current = controller;
    setState("checking");
    const timeout = window.setTimeout(() => controller.abort(), 25000);
    try {
      const response = await fetch("/api/hiring/ats-outcomes", { cache: "no-store", signal: controller.signal });
      if (request.current !== controller) return;
      if (response.status === 401 || response.status === 403 || (response.redirected && new URL(response.url).pathname === "/login")) {
        rerun.current = false;
        setState("denied");
        return;
      }
      if (!response.ok) throw Error();
      const next = await response.json() as Report;
      if (request.current === controller) {
        setReport(next); setState("ready");
      }
    } catch {
      if (request.current === controller) setState("stale");
    } finally {
      window.clearTimeout(timeout);
      if (request.current === controller) {
        request.current = null;
        if (rerun.current) { rerun.current = false; void read(); }
      }
    }
  }, []);
  const denied = state === "denied";
  useEffect(() => {
    if (denied) return;
    const timer = window.setInterval(refresh, 60000);
    const onReturn = () => {
      if (document.hidden) return;
      if (request.current) rerun.current = true;
      else void refresh();
    };
    document.addEventListener("visibilitychange", onReturn);
    window.addEventListener("online", refresh);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onReturn);
      rerun.current = false;
      window.removeEventListener("online", refresh);
      request.current?.abort();
      request.current = null;
    };
  }, [refresh, denied]);
  if (denied) return <p role="alert">Hiring access is required. <a className="underline" href="/login?callbackUrl=%2Fhiring%2Fats-outcomes">Sign in again</a></p>;
  return <>
    <div className="flex flex-wrap items-center justify-between gap-x-4 rounded-lg border bg-card px-4 text-sm">
      <p role="status" className="py-2"><strong>{state === "stale" ? "Refresh failed" : state === "checking" ? "Checking for updates…" : "Updates every minute"}</strong>
        <span className="ml-2 inline-block text-muted-foreground">Last successful read · {bangkokReadTime(report.checkedAt)} Bangkok</span></p>
      <button className="min-h-11 cursor-pointer font-medium underline underline-offset-4" disabled={state === "checking"} onClick={refresh}>{state === "stale" ? "Retry refresh" : "Refresh now"}</button>
    </div>
    <ReportBody report={report} />
    <OwnerSelections picks={report.picks} />
  </>;
}

function ReportBody({ report }: { report: Report }) {
  const { cases, threshold, accepted, rejected } = report;
  const [editedCutoff, setCutoff] = useState<number | null>(null);
  const cutoff = editedCutoff ?? threshold;
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [candidateName, setCandidateName] = useState("");
  const [openCohort, setOpenCohort] = useState<string | null>(null);
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
    { id: "paper-pass", label: "Paper passed", members: cases.filter(c => c.paper === "pass") },
    { id: "paper-fail", label: "Paper failed", members: cases.filter(c => c.paper === "fail") },
    { id: "accepted", label: "Accepted", members: cases.filter(c => c.decision === "Accepted") },
    { id: "rejected", label: "Rejected", members: cases.filter(c => c.decision === "Rejected") },
  ];
  const donor = criteria.find(p => p.name === from);
  const recipient = criteria.find(p => p.name === to);
  const trialActive = cutoff !== threshold || Boolean(donor && recipient);
  const nameQuery = candidateName.trim().toLowerCase();
  const evidence = cases.filter(c => c.name.toLowerCase().includes(nameQuery));
  function resetTrial(nextCutoff: number) {
    setCutoff(nextCutoff === threshold ? null : nextCutoff);
    setFrom("");
    setTo("");
  }
  return <>
    <AtsAnalysis report={report} onTrial={(fromName, toName) => {
      setCutoff(null); setFrom(fromName); setTo(toName); document.getElementById("ats-trial")?.focus();
    }} />
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
      <div className="mt-2 rounded-md bg-muted px-3 py-2 text-sm">
        <p><strong>Preview only.</strong> Trial settings apply to this report. Hiring uses the live cutoff of {threshold} and the current weights.</p>
        {(trialActive || from) && <a href="/hiring/ats-outcomes#ats-trial" target="_blank" rel="noopener" className="inline-flex min-h-11 items-center font-medium underline underline-offset-4">Open saved settings in a new tab</a>}
      </div>
      <div className="my-4 grid gap-3 sm:grid-cols-3">
        <div>
          <label htmlFor="ats-cutoff">Trial cutoff <strong>{cutoff}</strong></label>
          <div className="grid grid-cols-[44px_minmax(0,1fr)_44px] items-center gap-2">
            <button type="button" aria-label="Lower trial cutoff by one point" className="size-11 cursor-pointer rounded-md border hover:bg-muted disabled:opacity-50" disabled={cutoff === 0} onClick={() => setCutoff(Math.max(0, cutoff - 1))}>−</button>
            <input id="ats-cutoff" className="block h-11 w-full accent-primary" type="range" min="0" max="100" value={cutoff} onChange={e => setCutoff(Number(e.target.value))}/>
            <button type="button" aria-label="Raise trial cutoff by one point" className="size-11 cursor-pointer rounded-md border hover:bg-muted disabled:opacity-50" disabled={cutoff === 100} onClick={() => setCutoff(Math.min(100, cutoff + 1))}>+</button>
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
        <tbody>{outcomes.map(({ id, label, members }) => {
          const group = members.filter(person => person.ats !== null);
          const current = group.filter(person => person.ats && person.ats.score >= threshold).length;
          const trial = group.filter(person => (trialByCandidate.get(person.id) ?? -1) >= cutoff).length;
          const open = openCohort === id;
          const detailsId = "ats-cohort-" + id;
          return <Fragment key={id}>
            <tr><th scope="row" className="font-medium">
              {members.length ? <button type="button" aria-expanded={open} aria-controls={detailsId} aria-label={"Inspect " + label + " candidates"} className="min-h-11 cursor-pointer text-left underline underline-offset-4" onClick={() => setOpenCohort(open ? null : id)}>{label}</button> : label}
              <span className="block text-xs font-normal text-muted-foreground">{group.length} scored of {members.length}</span>
            </th>
            {group.length ? <><td>{current} / {group.length}</td><td>{trial} / {group.length}</td><td className="font-medium">{changeFmt.format(trial - current)}</td></> : <td colSpan={3} className={small}>No scored candidates</td>}</tr>
            {members.length > 0 && <tr id={detailsId} hidden={!open}><td colSpan={4}>
              {open && <ul aria-label={label + " cohort"} className="divide-y rounded-md bg-muted px-3">
                {members.map(person => {
                  const trialScore = trialByCandidate.get(person.id);
                  return <li key={person.id} className="break-words py-2">
                    <strong>{person.name}</strong>
                    {person.ats && trialScore !== undefined ? <span className="block text-sm">
                      Current {fmt.format(person.ats.score)} · {person.ats.score >= threshold ? "Meets cutoff" : "Below cutoff"}<br/>
                      Trial {fmt.format(trialScore)} · {trialScore >= cutoff ? "Meets cutoff" : "Below cutoff"}
                    </span> : <span className="block text-sm">ATS score missing</span>}
                  </li>;
                })}
              </ul>}
            </td></tr>}
          </Fragment>;
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
        <h2 id="candidate-evidence" tabIndex={-1} className={heading}>Candidate evidence</h2>
        <HiringReportJump id="ats-evidence-owner-link" fragment="owner-selections" className="inline-flex min-h-11 items-center text-sm underline underline-offset-4">Open owner selections</HiringReportJump>
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
