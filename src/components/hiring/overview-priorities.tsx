"use client";

import { useMemo, useRef, useState } from "react";
import { formatInTimeZone } from "date-fns-tz";
import { BUSY_BLOCKS, type CapacityReport, type HiringNeed } from "@/lib/hiring/capacity";
import { bookingKnownAt, CLOSED_STAGES, PAYLOAD_ROW_CAP, percentile, roundTo, STUCK_RULES, type FunnelReport } from "@/lib/hiring/funnel";
import { STAGE_LABELS } from "@/lib/hiring/insights";
import { instant, localDate, shiftDate, weekStart, ZONE } from "@/lib/hiring/model";
import type { HiringData } from "./dashboard";
import css from "./overview-priorities.module.css";

const DAY = 86_400_000;
const dateLabel = (date: Date | string) => formatInTimeZone(new Date(date), ZONE, "d MMM");
const closed = new Set<string>(CLOSED_STAGES);
type Evidence = { title: string; description: string; ids: string[]; need?: HiringNeed; wait?: boolean };

export function currentStageRows(data: HiringData, report: FunnelReport, now: Date) {
  const confirmed = data.bookings.filter(b => b.status === "confirmed" && bookingKnownAt(b, now));
  const ahead = new Set(confirmed.filter(b => new Date(b.startTime) > now).map(b => b.candidateId));
  const visited = new Set(confirmed.filter(b => new Date(b.startTime) <= now).map(b => b.candidateId));
  return STUCK_RULES.filter(rule => !closed.has(rule.stage)).flatMap(rule => {
    const parts = rule.key === "onsite_booked"
      ? [{ name: "Visit ahead", test: (id: string) => ahead.has(id), limit: null },
         { name: "Decision due", test: (id: string) => !ahead.has(id) && visited.has(id), limit: rule.days },
         { name: "Onsite booked · date unknown", test: (id: string) => !ahead.has(id) && !visited.has(id), limit: rule.days }]
      : [{ name: rule.label, test: () => true, limit: rule.days }];
    return parts.flatMap(part => {
      const rows = data.candidates.filter(c => report.byCandidate[c.id]?.stageKey === rule.key && part.test(c.id));
      if (!rows.length) return [];
      const timed = part.limit !== null;
      const dated = rows.filter(c => timed && !report.byCandidate[c.id].importDateOnly && (rule.key !== "onsite_booked" || visited.has(c.id)));
      const overdue = dated.filter(c => report.byCandidate[c.id].stuck).map(c => c.id);
      const unknown = timed ? rows.length - dated.length : 0;
      const median = dated.length ? roundTo(percentile(dated.map(c => report.byCandidate[c.id].daysInStage), .5), 1) : null;
      return [{ name: part.name, ids: rows.map(c => c.id), overdue, unknown, median, limit: part.limit }];
    });
  }).sort((a,b) => b.overdue.length - a.overdue.length || b.ids.length - a.ids.length);
}

const count = (n: number, singular: string) => `${n} ${singular}${n === 1 ? "" : "s"}`;

export function OverviewPriorities({ data, capacity, report, now, stages }: {
  data: HiringData;
  capacity: CapacityReport | null;
  report: FunnelReport;
  now: Date;
  stages: ReturnType<typeof currentStageRows>;
}) {
  const [evidence, setEvidence] = useState<Evidence | null>(null);
  const [earlier, setEarlier] = useState(false);
  const [showStages, setShowStages] = useState(false);
  const [showSubjects, setShowSubjects] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null);
  const opener = useRef<HTMLButtonElement | null>(null);
  const candidates = useMemo(() => new Map(data.candidates.map(c => [c.id, c])), [data]);
  const subjects = useMemo(() => {
    const names = new Set([...data.candidates.flatMap(c => c.subjects), ...(capacity?.needs.map(n => n.subject) ?? [])]);
    return [...names].map(name => {
      const need = capacity?.needs.find(n => n.subject === name);
      const hire = need && !capacity?.stale && need.status !== "unknown" ? need.hire : null;
      const applicants = data.candidates.filter(c => c.subjects.includes(name)).map(c => c.id);
      const booked = [...new Set(data.bookings.filter(b => b.kind === "paper" && b.status === "confirmed" && bookingKnownAt(b, now) &&
        b.subjects.includes(name) && candidates.get(b.candidateId)?.stage === "onsite_booked").map(b => b.candidateId))];
      const gap = hire !== null && !report.capped && data.bookings.length < PAYLOAD_ROW_CAP ? Math.max(0, hire - booked.length) : null;
      return { name, need, hire, applicants, booked, gap };
    }).sort((a,b) => (b.gap ?? -1) - (a.gap ?? -1) || (b.hire ?? -1) - (a.hire ?? -1) || b.applicants.length - a.applicants.length || a.name.localeCompare(b.name));
  }, [data, capacity, candidates, report.capped, now]);
  const monday = weekStart(localDate(now));
  const end = earlier ? shiftDate(monday, -14) : monday;
  const weeks = [2, 1].map(back => {
    const first = shiftDate(end, -7 * back), after = shiftDate(first, 7);
    return { start: +instant(first, 0), end: +instant(after, 0), label: `${dateLabel(instant(first, 0))}–${dateLabel(instant(shiftDate(after, -1), 0))}`, ids: [] as string[] };
  });
  let covered = false;
  for (const row of data.inviteOutbox) {
    if (row.status !== "sent" || !row.sentAt || !row.key.endsWith(":pre-screen")) continue;
    const id = row.key.slice(0, -":pre-screen".length);
    if (!candidates.has(id)) continue;
    const sent = new Date(row.sentAt).getTime();
    if (sent < weeks[0].start) covered = true;
    const week = weeks.find(w => sent >= w.start && sent < w.end);
    if (week) week.ids.push(id);
  }
  const comparable = covered && !report.capped;
  const delta = weeks[1].ids.length - weeks[0].ids.length;
  const stalled = stages.find(s => s.overdue.length);
  const gap = subjects.find(s => s.gap !== null && s.gap > 0);
  const max = Math.max(1, ...stages.map(s => s.ids.length));
  const undated = stages.reduce((sum,s) => sum+s.unknown, 0);

  function inspect(next: Evidence, trigger: HTMLButtonElement) {
    opener.current = trigger;
    setEvidence(next);
    dialog.current?.showModal();
    dialog.current?.scrollTo(0, 0);
  }
  function inspectSubject(row: typeof subjects[number], trigger: HTMLButtonElement) {
    inspect({ title: `${row.name} staffing evidence`, description: `Applicants listing this subject: ${row.applicants.length}. A confirmed paper booking in Onsite booked links ${count(row.booked.length, "candidate")} to this subject.`, ids: row.booked, need: row.need }, trigger);
  }
  const demand = evidence?.need?.demand;
  const block = evidence?.need?.blocks.find(b => b.key === evidence.need?.tightest);
  return <section className={css.priorities} aria-label="Hiring priorities">
    <div className={css.hero}>
      <div className={css.finding}>
        <p className={css.eyebrow}>Pipeline follow-up</p>
        <h2 id="ov-now">{stalled ? `Review the ${stalled.name.toLowerCase()} queue` : gap ? `Check ${gap.name} staffing` : "No confirmed priority"}</h2>
        {stalled ? <>
          <p><strong>{stalled.overdue.length} {stalled.overdue.length === 1 ? "candidate has" : "candidates have"} waited over {stalled.limit} days.</strong> The median wait in this stage is {stalled.median} days among candidates with a dated event.</p>
          <button type="button" className={css.heroButton} onClick={event => inspect({ title: `Overdue in ${stalled.name}`, description: `Confirmed waits longer than ${stalled.limit} days in the current stage.`, ids: stalled.overdue, wait: true }, event.currentTarget)}>Inspect waiting candidates <span aria-hidden>→</span></button>
        </> : gap ? <>
          <p>Capacity calls for {count(gap.hire!, "tutor")}. {count(gap.applicants.length, "applicant")} {gap.applicants.length === 1 ? "lists" : "list"} the subject. Booked paper assessments cover {count(gap.booked.length, "candidate")}.</p>
          <button type="button" className={css.heroButton} onClick={event => inspectSubject(gap, event.currentTarget)}>Inspect subject evidence <span aria-hidden>→</span></button>
        </> : <p>{undated ? `${count(undated, "candidate")} ${undated === 1 ? "has" : "have"} no dated stage event to establish a wait. ` : "No dated wait exceeds its stage limit. "}{capacity && !capacity.stale && subjects.some(s => s.gap !== null) ? "Review the subject counts and staffing evidence below." : "Staffing evidence is insufficient to rank a subject."}</p>}
      </div>
      <div className={css.chart}>
        <h3>Open candidates by stage</h3>
        <p className={css.legend}><span><i />Open</span><span><i className={css.hatched} />Overdue</span><span><i className={css.undated} />Undated</span></p>
        {(showStages ? stages : stages.slice(0,4)).map(s => <div className={css.chartRow} key={s.name}>
          <button type="button" aria-label={`${s.name}: ${s.ids.length} now`} onClick={event => inspect({ title: s.name, description: "Loaded candidates currently in this stage.", ids: s.ids }, event.currentTarget)}>{s.name}</button>
          <div>
            <div className={css.track} aria-hidden><i style={{width:`${100*(s.ids.length-s.overdue.length-s.unknown)/max}%`}} /><i className={css.hatched} style={{width:`${100*s.overdue.length/max}%`}} /><i className={css.undated} style={{width:`${100*s.unknown/max}%`}} /></div>
          <span>{s.ids.length} open{s.limit !== null && <> · {s.overdue.length} overdue{s.unknown > 0 && ` · ${s.unknown} undated`}</>}</span>
          </div>
        </div>)}
        {stages.length > 4 && <button type="button" className={css.explain} onClick={() => setShowStages(!showStages)}>{showStages ? "Show fewer stages" : `Show all ${stages.length} stages`}</button>}
        <details><summary>How to read this chart</summary><p>Each bar counts the loaded candidates in one current stage. Stripes show waits beyond the existing stage limit. A grey segment has no dated event. An import date cannot establish stage entry. New and In review have no overdue limit. After a booked visit, the decision clock starts at the visit.</p></details>
      </div>
    </div>
    <div className={css.panels}>
      <section className={css.panel} aria-labelledby="subject-coverage">
        <h3 id="subject-coverage">Staffing by subject</h3>
        <p className={css.note}>{gap ? `${gap.name} has the largest measured gap: ${count(gap.hire!, "tutor")} needed and ${count(gap.booked.length, "candidate")} with a booked paper visit.` : !capacity || capacity.stale ? "Current capacity is unavailable. Applicant numbers alone cannot establish a shortage." : "Compare tutor need with candidates who have booked a paper visit."}</p>
        <table><thead><tr><th>Subject</th><th>Need</th><th>Applicants</th><th>Booked</th></tr></thead><tbody>
          {(showSubjects ? subjects : subjects.slice(0,5)).map(s => <tr key={s.name}>
            <th scope="row"><button type="button" onClick={event => inspectSubject(s, event.currentTarget)}>{s.name}</button></th>
            <td>{s.hire ?? "Unknown"}</td>
            <td><button type="button" aria-label={`${s.name}: ${s.applicants.length} applicants`} onClick={event => inspect({ title: `${s.name} applicants`, description: "Loaded candidates who list this subject, across all stages.", ids: s.applicants }, event.currentTarget)}>{s.applicants.length}</button></td>
            <td><button type="button" aria-label={`${s.name}: ${s.booked.length} booked candidates`} onClick={event => inspectSubject(s, event.currentTarget)}>{s.booked.length}</button></td>
          </tr>)}
        </tbody></table>
        {subjects.length > 5 && <button type="button" className={css.explain} onClick={() => setShowSubjects(!showSubjects)}>{showSubjects ? "Show fewer subjects" : `Show all ${subjects.length} subjects`}</button>}
        <details><summary>How need and supply are measured</summary><p>Need is the Capacity estimate for the next four weeks of busy teaching hours. Applicants list the subject. Booked candidates have a confirmed paper booking for it and are currently in Onsite booked. The gap is need minus booked candidates, down to zero. A booking still requires assessment. Subjects can overlap. A stale or unmeasured need is unknown.</p></details>
      </section>
      <section className={css.panel} aria-labelledby="weekly-sends">
        <h3 id="weekly-sends">Pre-screen invitations sent</h3>
        <label className={css.periodSelect}>Bangkok weeks <select value={earlier ? "earlier" : "recent"} onChange={event => setEarlier(event.target.value === "earlier")}><option value="recent">Last two complete weeks</option><option value="earlier">Previous two complete weeks</option></select></label>
        {comparable ? <>
          <div className={css.weekPair}>{weeks.map(w => <button key={w.start} type="button" onClick={event => inspect({ title: `Pre-screen invitations · ${w.label}`, description: "Candidates with a sent pre-screen invitation in this Bangkok week.", ids: w.ids }, event.currentTarget)}><span>{w.label}</span><strong>{w.ids.length}</strong></button>)}</div>
          <p className={css.change}>{delta > 0 ? `${delta} more` : delta < 0 ? `${-delta} fewer` : "The same number of"} {Math.abs(delta) === 1 ? "invitation" : "invitations"} in the later week.</p>
        </> : <p className={css.unavailable}><strong>Comparison unavailable</strong><br/>{report.capped ? "The candidate read reached its limit." : `There is no dated send before ${weeks[0].label.split("–")[0]} to establish the start of this history.`}</p>}
        <details><summary>What this comparison measures</summary><p>Each week counts the initial pre-screen invitations marked sent for loaded candidates. A send timestamp records activity. A bulk import records when a row entered the system. It cannot establish applications, conversions or waiting times for that week.</p></details>
      </section>
    </div>
    {report.capped && <p className={css.note}>The read reached its limit of {PAYLOAD_ROW_CAP} candidates. Counts cover only the loaded records.</p>}
    <dialog ref={dialog} aria-labelledby="hiring-evidence" className={css.dialog} onClose={() => opener.current?.focus()}
      onKeyDown={event => {
        if (event.key !== "Tab" || event.ctrlKey || event.metaKey) return;
        // Back is the only control. Page and arrow keys still scroll the evidence.
        event.preventDefault();
        event.currentTarget.querySelector("button")?.focus({ preventScroll: true });
      }}>
      <button className={css.back} type="button" onClick={() => dialog.current?.close()}>← Back to Overview</button>
      <h3 id="hiring-evidence">{evidence?.title}</h3><p>{evidence?.description}</p>
      {evidence?.need && capacity && <div className={css.source}>
        <strong>Capacity · {dateLabel(instant(capacity.from,0))}–{dateLabel(instant(capacity.to,0))}</strong>
        <p>{evidence.need.status === "unknown" || capacity.stale ? "Current tutor need is unknown." : `${count(evidence.need.hire, "tutor")} needed across the busy teaching periods.`} {block && <>{BUSY_BLOCKS.find(b => b.key === block.key)?.label} has {roundTo(block.booked,1)} of {roundTo(block.given,1)} available tutor hours booked per week.</>}</p>
        <p>{demand && capacity.demand ? `${count(demand.started, "student-course start")} from ${dateLabel(instant(capacity.demand.from,0))} to ${dateLabel(instant(capacity.demand.to,0))}.` : "Student demand history is unavailable."}</p>
      </div>}
      <ul>{evidence?.ids.map(id => {
        const c = candidates.get(id);
        if (!c) return null;
        const step=report.byCandidate[id];
        return <li key={id}><span><strong>{c.name}</strong> · {STAGE_LABELS[c.stage]}{evidence.wait && <small>{roundTo(step.daysInStage,1)} days · dated event {dateLabel(new Date(+now-step.daysInStage*DAY))}</small>}</span><code>{id}</code></li>;
      })}</ul>
      {evidence && !evidence.ids.length && <p>No candidate records match this selection.</p>}
    </dialog>
  </section>;
}
