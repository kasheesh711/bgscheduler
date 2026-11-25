"use client";

import { useMemo, useState } from "react";
import { formatInTimeZone } from "date-fns-tz";
import { bookingKnownAt, buildFunnel, cohortWindow, CLOSED_STAGES, FUNNEL_STEPS, roundTo, STEP_TIMING, type FunnelReport, type FunnelStep, type GroupFunnel } from "@/lib/hiring/funnel";
import { buildGems, schoolStrength, type Gem, type GemKind } from "@/lib/hiring/gems";
import { buildNextEmails, type EmailKind, type NextEmail } from "@/lib/hiring/next-emails";
import { currentStageRows, OverviewPriorities } from "./overview-priorities";
import type { CapacityReport } from "@/lib/hiring/capacity";
import { ZONE } from "@/lib/hiring/model";
import { groupOptions, pickGroup } from "./funnel-panel";
import type { HiringData } from "./dashboard";
import css from "./overview-analytics.module.css";

/** Filters the candidate table below to these ids; `label` names them in the filter line. */
type Show = (ids: string[], label: string, opener?: HTMLElement, timingEvidence?: Record<string, string>) => void;
const pct = (v: number) => `${Math.round(v * 100)}%`;
const CLOSED = new Set<string>(CLOSED_STAGES);
const DAY = 86_400_000;
const dateLabel = (date: string) => formatInTimeZone(new Date(date), ZONE, "d MMM yyyy");

/**
 * The current decision and its evidence appear first. The detailed funnel, queues and candidate groups remain available.
 */
export function OverviewAnalytics({
  data,
  capacity,
  onShow,
  onOpen,
}: {
  data: HiringData;
  capacity: CapacityReport | null;
  onShow: Show;
  onOpen: (id: string) => void;
}) {
  // "now" moves with each load of the data, not with each render.
  const now = useMemo(() => new Date(), [data]); // eslint-disable-line react-hooks/exhaustive-deps
  const report = useMemo(() => buildFunnel(data, now), [data, now]);
  const stages = useMemo(() => currentStageRows(data, report, now), [data, report, now]);
  const [group, setGroup] = useState("all");
  const value = pickGroup(report, group);
  const g = report.groups[value];
  const cohort = cohortWindow(report, value);
  const period = value.startsWith("week:") ? "ISO week" : value.startsWith("month:") ? "month" : null;
  // Already moving, so never a gem: a visit or call ahead, or a place in a send queue.
  const busy = useMemo(
    () =>
      new Set([
        ...data.bookings.filter((b) => b.status === "confirmed" && bookingKnownAt(b, now) && new Date(b.startTime) > now).map((b) => b.candidateId),
        ...data.calls.filter((c) => new Date(c.start) > now).map((c) => c.candidateId),
        ...Object.keys(data.holds),
        ...data.callOrder,
        ...data.inviteOutbox.filter((o) => ["pending", "processing"].includes(o.status)).map((o) => o.key.split(":")[0]),
      ]),
    [data, now],
  );
  const gems = useMemo(() => buildGems(data.candidates, data.config, report.byCandidate, busy), [data, report, busy]);
  // The worker sleeps 15 minutes after each cycle (scripts/hiring-worker.ts), so its next run is about then.
  const nextRun = useMemo(
    () => new Date(Math.max(now.getTime(), data.workerAt ? new Date(data.workerAt).getTime() + 15 * 60_000 : now.getTime())),
    [data, now],
  );
  // A worker silent for over an hour (or never run) gives no time to promise.
  const workerLate = !data.workerAt || now.getTime() - new Date(data.workerAt).getTime() > 60 * 60_000;
  const emails = useMemo(() => buildNextEmails(data, now, nextRun), [data, now, nextRun]);
  const paused = !data.config.enabled || !data.config.deliveryEnabled;
  const scoreOf = useMemo(() => new Map(data.candidates.map((c) => [c.id, c.profileScore])), [data]);
  return (
    <div className={css.board}>
      <OverviewPriorities data={data} report={report} now={now} capacity={capacity} stages={stages} />
      <details className={css.moreDetails}>
      <summary>Pipeline details, send queues and candidate groups</summary>
      <div className={css.detailGrid}>
      <Pulse data={data} report={report} stages={stages} now={now} onShow={onShow} />
      <div className={`${css.col} ${css.colA}`}>
      <section className={`${css.card} ${css.stages}`} aria-labelledby="ov-stage-detail">
        <header className={css.head}>
          <h2 id="ov-stage-detail">Where they are now</h2>
          <Legend items={[[css.k_ok, "Other candidates"], [css.k_stuck, "Confirmed overdue"]]} />
        </header>
        <p className={css.basis}>Median is the middle wait in days among current candidates with a dated stage event and a wait limit. For Decision due, the clock starts at the visit. A dash means there is no measured median.</p>
        <Stages data={data} rows={stages} onShow={onShow} />
      </section>
      <section className={`${css.card} ${css.flow}`} aria-labelledby="ov-flow">
        <header className={css.head}>
          <h2 id="ov-flow">Funnel</h2>
          <select value={value} onChange={(e) => setGroup(e.target.value)} aria-label="Which candidates">
            {groupOptions(report, data.config.seekJobs).map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </header>
        {report.capped && (
          <p className={css.basis}>Counts can be low: the page reads only the most recently updated candidates.</p>
        )}
        <p className={css.basis}>
          First seen from {formatInTimeZone(cohort.from, ZONE, "d MMM yyyy, HH:mm")} up to {formatInTimeZone(cohort.until, ZONE, "d MMM yyyy, HH:mm")} Bangkok time (end excluded).
          {period ? ` ${cohort.clippedStart || cohort.clippedEnd ? "Partial" : "Complete"} ${period}.` : " The report covers eleven complete Bangkok weeks and the current week through the snapshot."}
          {cohort.clippedStart && " Coverage starts at the report boundary."}{cohort.clippedEnd && " Coverage ends at the current snapshot."}
        </p>
        <p className={css.basis}>First seen uses the earliest candidate creation or import, pre-screen reply, sent call invitation or sent pre-screen invitation. Steps describe this group at the {formatInTimeZone(now, ZONE, "d MMM yyyy, HH:mm")} Bangkok snapshot. Dated outcomes include events at that instant. Later timestamps are excluded. A future visit can have a recorded booking, but its scheduled start still lies ahead.</p>
        <p className={css.basis}><strong>Contacted.</strong> {g.documented.contacted} documented by a dated sent call invitation, sent pre-screen invitation or positive HR call review. {g.atLeast.contacted - g.documented.contacted} inferred from a pre-screen reply, a later step or the current status without one of those contact records.</p>
        <p className={css.basis}>Shares use the preceding step as the denominator. A share is unavailable if either count includes inferred records. A zero next-step count means there is no recorded move to that step. Waiting and left shares describe the open and closed records at the preceding step. Days use completed, dated moves. P90 is the 90th percentile of those durations.</p>
        <Flow g={g} onShow={onShow} />
      </section>
      <section className={`${css.card} ${css.gems}`} aria-labelledby="ov-gems">
        <header className={css.head}>
          <h2 id="ov-gems">Hidden gems</h2>
        </header>
        <Gems data={data} observedAt={report.now} gems={gems} onShow={onShow} onOpen={onOpen} />
      </section>
      </div>
      <div className={`${css.col} ${css.colB}`}>
      <section className={`${css.card} ${css.emails}`} aria-labelledby="ov-mail">
        <header className={css.head}>
          <h2 id="ov-mail">
            Next emails
            {paused ? (
              <span className={css.headline}>0 sending · {emails.length} if resumed</span>
            ) : (
              <b className={css.count}>{emails.length}</b>
            )}
          </h2>
          <span className={css.dim}>Bangkok time</span>
        </header>
        <Emails rows={emails} scoreOf={scoreOf} pass={data.config.profileThreshold} now={now} workerLate={workerLate} onOpen={onOpen} onShow={onShow} />
      </section>
      </div>
      </div>
      </details>
    </div>
  );
}

function Legend({ items }: { items: [string, string][] }) {
  return (
    <ul className={css.legend}>
      {items.map(([cls, label]) => (
        <li key={label}>
          <i className={cls} aria-hidden />
          {label}
        </li>
      ))}
    </ul>
  );
}

/** Headline counts, each with its denominator bar, and the system state in one strip. */
function Pulse({ data, report, stages, now, onShow }: { data: HiringData; report: FunnelReport; stages: ReturnType<typeof currentStageRows>; now: Date; onShow: Show }) {
  const all = data.candidates;
  const open = all.filter((c) => !CLOSED.has(c.stage));
  const scored = all.filter((c) => c.profileScore !== null);
  const pass = scored.filter((c) => (c.profileScore ?? 0) >= data.config.profileThreshold);
  // The pass pool not yet used up (Kevin, 25 Nov 2026): pass-score candidates still open, of all pass-score candidates.
  const passLeft = pass.filter((c) => !CLOSED.has(c.stage));
  const timedStages = stages.filter((stage) => stage.limit !== null);
  const overdue = timedStages.flatMap((stage) => stage.overdue);
  const undated = timedStages.reduce((total, stage) => total + stage.unknown, 0);
  const dated = timedStages.reduce((total, stage) => total + stage.ids.length, 0) - undated;
  const hired = all.filter((c) => c.stage === "hired");
  const problems = data.outbox.filter((j) => j.status === "failed" || j.status === "uncertain").length;
  const minutes = data.workerAt ? Math.round((now.getTime() - new Date(data.workerAt).getTime()) / 60000) : null;
  const items: { label: string; n: number; of: number; ids: string[]; tone?: string }[] = [
    { label: "Open", n: open.length, of: all.length, ids: open.map((c) => c.id) },
    { label: `Score ${data.config.profileThreshold}+`, n: pass.length, of: scored.length, ids: pass.map((c) => c.id) },
    { label: `Score ${data.config.profileThreshold}+ left`, n: passLeft.length, of: pass.length, ids: passLeft.map((c) => c.id) },
    { label: "Confirmed overdue", n: overdue.length, of: dated, ids: overdue, tone: css.warnBar },
    { label: "Offer stage", n: hired.length, of: all.length, ids: hired.map((c) => c.id), tone: css.goodBar },
  ];
  const state = (on: boolean, label: string) => (
    <span className={on ? css.on : css.off}>
      <i aria-hidden />
      {label} {on ? "on" : "paused"}
    </span>
  );
  return (
    <div className={css.pulse}>
      <div className={css.total}>
        <b>{all.length}</b> candidates <span className={css.dim}>· all campaigns{report.capped ? " · newest only, counts can be low" : ""}</span>
      </div>
      <p className={css.basis}>Counts use all loaded candidates at {dateLabel(report.now)}. Open and Offer stage use all candidates as the denominator. Score uses scored candidates. Score left counts open candidates out of those who met the threshold. Confirmed overdue uses candidates with a dated event and an active wait limit. {undated} have no dated event for that limit.</p>
      {items.map((item) => (
        <button key={item.label} type="button" className={css.stat} onClick={() => onShow(item.ids, item.label)}>
          <span className={css.statLabel}>{item.label}</span>
          <b>{item.n}</b>
          <span className={css.dim}>{item.of ? `/ ${item.of}` : "Rate unavailable"}</span>
          <span className={css.track} aria-hidden>
            <span className={item.tone ?? css.inkBar} style={{ width: pct(item.of ? item.n / item.of : 0) }} />
          </span>
        </button>
      ))}
      <div className={css.status}>
        {state(data.config.enabled, "Automation")}
        {state(data.config.deliveryEnabled, "Email")}
        <span className={minutes !== null && minutes <= 60 ? css.on : css.off}>
          <i aria-hidden />
          Worker {minutes === null ? "never ran" : minutes <= 60 ? `${minutes} min ago` : `${Math.round(minutes / 60)} h ago`}
        </span>
        <span className={problems ? css.off : css.on}>
          <i aria-hidden />
          {problems} send {problems === 1 ? "problem" : "problems"}
        </span>
      </div>
    </div>
  );
}

/**
 * One bar per step, 100% = people at the step before: moved on, still waiting there, left there. Same people at both
 * ends, so a share never passes 100%. Shares sit in the bar; each part opens its candidates. Days: median of completed
 * moves (dot, with n), line to p90.
 */
function Flow({ g, onShow }: { g: GroupFunnel; onShow: Show }) {
  const keys = FUNNEL_STEPS.map(([k]) => k);
  const rows = FUNNEL_STEPS.slice(1).map(([step, label], i) => {
    const key = step as Exclude<FunnelStep, "applied">;
    const prev = keys[i];
    return { key, label, prevLabel: i === 0 ? "First seen" : FUNNEL_STEPS[i][1], before: g.atLeast[prev], n: g.atLeast[key], dated: g.documented[key], measured: g.atLeast[key] === g.documented[key] && g.atLeast[prev] === g.documented[prev], stop: g.stopped[prev], t: key === "contacted" ? undefined : g.stepDays[STEP_TIMING[key]] };
  });
  const leftRate = (r: (typeof rows)[number]) => (r.before ? r.stop.closed.length / r.before : 0);
  const mostLeft = rows.reduce((a, b) => (b.stop.closed.length > a.stop.closed.length ? b : a));
  const worstRate = rows.reduce((a, b) => (leftRate(b) > leftRate(a) ? b : a));
  const queue = rows.reduce((a, b) => (b.stop.open.length > a.stop.open.length ? b : a));
  const timed = rows.filter(row => row.t);
  const slow = timed.length ? timed.reduce((a, b) => b.t!.median > a.t!.median ? b : a) : undefined;
  function showTiming(row: (typeof rows)[number], opener: HTMLElement) {
    if (!row.t) return;
    const source = row.key === "replied" ? "Pre-screen invitation sent" : row.prevLabel;
    const entries = Object.entries(row.t.moves).map(([id, move]) => {
      const from = formatInTimeZone(move.from, ZONE, "d MMM yyyy, HH:mm");
      const to = formatInTimeZone(move.to, ZONE, "d MMM yyyy, HH:mm");
      const days = roundTo((move.to - move.from) / DAY, 1);
      return [id, `${from} → ${to} · ${days} ${days === 1 ? "day" : "days"}`];
    });
    onShow(Object.keys(row.t.moves), `Timed moves from ${source} to ${row.label} (Bangkok time)`, opener, Object.fromEntries(entries));
  }
  const maxDays = Math.max(1, ...rows.map((s) => s.t?.p90 ?? 0));
  return (
    <>
      <div className={css.callouts}>
        <button type="button" className={css.callout} onClick={event => onShow(mostLeft.stop.closed, `Left at ${mostLeft.prevLabel}`, event.currentTarget)}>
          <i className={css.k_big} aria-hidden />
          Most left: <b>{mostLeft.stop.closed.length}</b> {mostLeft.stop.closed.length ? `at ${mostLeft.prevLabel}` : "exits in this cohort"}
        </button>
        {worstRate.measured && worstRate.stop.closed.length > 0 && worstRate.key !== mostLeft.key && (
          <button type="button" className={css.callout} onClick={event => onShow(worstRate.stop.closed, `Left at ${worstRate.prevLabel}`, event.currentTarget)}>
            <i className={css.k_big} aria-hidden />
            Worst rate: <b>{worstRate.stop.closed.length} of {worstRate.before} left ({pct(leftRate(worstRate))})</b> at {worstRate.prevLabel}
          </button>
        )}
        <button type="button" className={css.callout} onClick={event => onShow(queue.stop.open, `Waiting at ${queue.prevLabel}`, event.currentTarget)}>
          <i className={css.k_wait} aria-hidden />
          Biggest queue: <b>{queue.stop.open.length}</b> {queue.stop.open.length ? `at ${queue.prevLabel}` : "waiting in this cohort"}
        </button>
        {slow?.t ? (
          <button type="button" className={css.callout} onClick={event => showTiming(slow, event.currentTarget)}>
            <i className={css.k_slow} aria-hidden />
            Slowest: <b>{slow.t.median} d</b> to {slow.label} <span className={css.dim}>{slow.t.n} timed</span>
          </button>
        ) : <span className={css.dim}>No completed dated moves to compare.</span>}
      </div>
      <div className={css.flowGrid} role="table" aria-label="Funnel steps">
        <div className={css.flowHead} role="row">
          <span role="columnheader">Step</span>
          <span role="columnheader" className={css.num}>Count</span>
          <span role="columnheader">Of the step before</span>
          <span role="columnheader">Days</span>
        </div>
        <div className={css.flowRow} role="row">
          <span role="cell">First seen</span>
          <b role="cell" className={css.num}>{g.atLeast.applied}</b>
          <span role="cell" />
          <span role="cell" />
        </div>
        {rows.map((r) => {
          const open = r.stop.open.length;
          const left = r.stop.closed.length;
          const part = (n: number) => pct(r.before ? n / r.before : 0);
          const hot = r.key === mostLeft.key || r.key === worstRate.key;
          const movedLabel = `${r.n} of ${r.before} moved on (${part(r.n)})`;
          const waitingLabel = `${open} of ${r.before} waiting (${part(open)})`;
          const leftLabel = `${left} of ${r.before} left (${part(left)})`;
          return (
            <div key={r.key} className={css.flowRow} role="row">
              <span role="cell">{r.label}</span>
              <span role="cell" className={css.num}><b>{r.n}</b></span>
              {r.measured && r.before ? (
                <span role="cell" className={css.flowShares}>
                  {r.key === "contacted" && <span>{r.dated} documented</span>}
                  <span className={css.flowBar}>
                    {r.n > 0 && <span className={css.onPart} style={{ width: part(r.n) }} />}
                    {open > 0 && <label htmlFor={`hiring-funnel-${r.key}-waiting`} aria-hidden="true" className={css.waitPart} style={{ width: part(open) }} />}
                    {left > 0 && <label htmlFor={`hiring-funnel-${r.key}-left`} aria-hidden="true" className={hot ? css.leftBig : css.leftPart} style={{ width: part(left) }} />}
                  </span>
                  {r.n > 0 && <span>{movedLabel}</span>}
                  {open > 0 && <button type="button" id={`hiring-funnel-${r.key}-waiting`} aria-label={waitingLabel} onClick={() => onShow(r.stop.open, `Waiting at ${r.prevLabel}`)}>{waitingLabel}</button>}
                  {left > 0 && <button type="button" id={`hiring-funnel-${r.key}-left`} aria-label={leftLabel} onClick={() => onShow(r.stop.closed, `Left at ${r.prevLabel}`)}>{leftLabel}</button>}
                </span>
              ) : (
                <span role="cell" className={css.stepEvidence}>
                  {r.before > 0 ? <span>{r.dated} documented{r.n > r.dated && ` · ${r.n - r.dated} inferred`} · share unavailable</span> : "No previous step records"}
                  {open > 0 && <button type="button" onClick={() => onShow(r.stop.open, `Waiting at ${r.prevLabel}`)}>{open} waiting</button>}
                  {left > 0 && <button type="button" onClick={() => onShow(r.stop.closed, `Left at ${r.prevLabel}`)}>{left} left</button>}
                </span>
              )}
              <span role="cell" className={css.barCell}>
                {r.t ? (
                  <button type="button" className={css.timingButton} onClick={event => showTiming(r, event.currentTarget)}>
                    <svg className={css.whisker} viewBox="0 0 100 10" preserveAspectRatio="none" aria-hidden>
                      <line x1={(r.t.median / maxDays) * 100} x2={(r.t.p90 / maxDays) * 100} y1={5} y2={5} />
                      <circle cx={(r.t.median / maxDays) * 100} cy={5} r={3.5} className={r.key === slow?.key ? css.warnFill : undefined} />
                    </svg>
                    <span className={`${css.daysText} ${r.key === slow?.key ? css.warn : ""}`}>
                      Median {r.t.median}d<small>P90 {r.t.p90}d</small><small>{r.t.n} timed</small>
                    </span>
                  </button>
                ) : (
                  <span className={css.dim}>–</span>
                )}
              </span>
            </div>
          );
        })}
      </div>
      <Legend items={[[css.k_on, "Moved on"], [css.k_wait, "Waiting"], [css.k_left, "Left"], [css.k_big, "Most left"]]} />
    </>
  );
}

const KIND: Record<EmailKind, { label: string; cls: string }> = {
  form: { label: "Form", cls: css.k_form },
  call_link: { label: "Call link", cls: css.k_call },
  call_reminder: { label: "Call reminder", cls: css.k_call },
  form_reminder: { label: "Form reminder", cls: css.k_formReminder },
  visit_link: { label: "Visit link", cls: css.k_visit },
  visit_reminder: { label: "Visit reminder", cls: css.k_visitReminder },
};
const KINDS = Object.keys(KIND) as EmailKind[];
const LIMIT: Record<string, string> = { perDay: "daily limit", perWeek: "weekly limit", perSubject: "subject full", waiting: "waiting limit", unbooked: "not-booked limit" };

/** Bars per day (stacked by email kind, one scale) over the send list. A day bar filters the list. */
function Emails({ rows, scoreOf, pass, now, workerLate, onOpen, onShow }: { rows: NextEmail[]; scoreOf: Map<string, number | null>; pass: number; now: Date; workerLate: boolean; onOpen: (id: string) => void; onShow: Show }) {
  const [day, setDay] = useState<string | null>(null);
  const [all, setAll] = useState(false);
  const key = (d: Date) => formatInTimeZone(d, ZONE, "yyyy-MM-dd");
  const days = Array.from({ length: 7 }, (_, i) => key(new Date(now.getTime() + i * DAY)));
  const colOf = (r: NextEmail) => (!r.at ? "wait" : days.includes(key(r.at)) ? key(r.at) : "later");
  const cols = [
    ...days.map((d, i) => ({ key: d, label: i === 0 ? "Today" : formatInTimeZone(new Date(`${d}T12:00:00+07:00`), ZONE, "EEE") })),
    { key: "later", label: "Later" },
    { key: "wait", label: "No date" },
  ].map((c) => {
    const list = rows.filter((r) => colOf(r) === c.key);
    return { ...c, list, kinds: KINDS.map((k) => list.filter((r) => r.kind === k).length) };
  });
  const max = Math.max(1, ...cols.map((c) => c.list.length));
  // A reload can empty the chosen day: then show every row again.
  const picked = day && rows.some((r) => colOf(r) === day) ? day : null;
  const shown = picked ? rows.filter((r) => colOf(r) === picked) : rows;
  const list = all ? shown : shown.slice(0, 6);
  const why = (r: NextEmail) =>
    r.why === "sending" ? "written, not yet sent"
    : r.why === "retry" ? "failed, retrying"
    : r.why === "check" ? "may not have sent"
    : r.why === "next_run"
      ? r.kind === "visit_link" ? "form passed, next in queue" : `score ${scoreOf.get(r.id) ?? "?"} ≥ ${pass}${r.position ? `, queue #${r.position}` : ""}`
    : r.why === "due" ? (r.kind === "visit_reminder" ? "no visit booked yet" : "no form reply yet")
    : `#${r.position} · ${LIMIT[r.why] ?? r.why}`;
  const time = (d: Date) => `${key(d) === days[0] ? "" : `${formatInTimeZone(d, ZONE, "EEE d")} `}${formatInTimeZone(d, ZONE, "HH:mm")}`;
  const when = (r: NextEmail) =>
    r.why === "check" ? "Needs a look"
    : r.why === "retry" ? "Retrying"
    : !r.at ? "When a place opens"
    : workerLate && (r.why === "next_run" || r.why === "sending" || r.overdue) ? "When the worker runs"
    : r.overdue ? `Overdue · ${time(r.at)}`
    : r.why === "perDay" || r.why === "perWeek" ? `Earliest ${time(r.at)}`
    : time(r.at);
  return (
    <>
      <div className={css.dayStrip}>
        {cols.map((c) => (
          <button
            key={c.key}
            type="button"
            className={css.dayCol}
            aria-pressed={picked === c.key}
            aria-label={`${c.label}: ${c.list.length} emails`}
            onClick={() => setDay(picked === c.key ? null : c.key)}
            disabled={!c.list.length}
          >
            <span className={css.dayN}>{c.list.length || ""}</span>
            <span className={css.plot}>
              <span className={css.dayStack} style={{ height: `${(c.list.length / max) * 100}%` }}>
                {c.kinds.map((n, i) => (n ? <i key={i} className={KIND[KINDS[i]].cls} style={{ flexGrow: n }} /> : null))}
              </span>
            </span>
            <span className={css.dayLabel}>{c.label}</span>
          </button>
        ))}
      </div>
      <Legend items={KINDS.map((k) => [KIND[k].cls, KIND[k].label])} />
      <ol className={css.mailList}>
        {list.map((r) => (
          <li key={`${r.id}:${r.kind}`}>
            <i className={KIND[r.kind].cls} aria-hidden />
            <button type="button" className={css.link} onClick={() => onOpen(r.id)}>
              {r.name}
            </button>
            <span className={r.at ? css.when : css.whenWait}>{when(r)}</span>
            <span className={css.mailWhy}>
              {KIND[r.kind].label}
              {r.subject ? ` · ${r.subject}` : ""} · {why(r)}
            </span>
          </li>
        ))}
      </ol>
      <div className={css.mailFoot}>
        {shown.length > 6 && (
          <button type="button" className={css.more} onClick={() => setAll(!all)}>
            {all ? "Show fewer" : `Show all ${shown.length}`}
          </button>
        )}
        <button type="button" className={css.more} onClick={() => onShow([...new Set(shown.map((r) => r.id))], "Next emails")}>
          Open in table
        </button>
      </div>
    </>
  );
}

/** Current stage for every loaded candidate: count bar split into on time and stuck; each part opens those candidates. */
function Stages({ data, rows, onShow }: { data: HiringData; rows: ReturnType<typeof currentStageRows>; onShow: Show }) {
  const offer = data.candidates.filter((c) => c.stage === "hired");
  const parked = data.candidates.filter((c) => c.stage === "no_reply" || c.stage === "no_booking");
  const closed = data.candidates.filter((c) => c.stage === "stopped" || c.stage === "rejected");
  const soft = data.candidates.filter((c) => c.stage === "soft_rejected");
  const max = Math.max(1, ...rows.map((r) => r.ids.length));
  return (
    <div className={css.stageList} role="table" aria-label="Candidates by current stage">
      <div className={css.stageHead} role="row">
        <span role="columnheader">Stage</span>
        <span role="columnheader" />
        <span role="columnheader" className={css.num}>Now</span>
        <span role="columnheader" className={css.num}>Stuck</span>
        <span role="columnheader" className={css.num}>Median</span>
      </div>
      {rows.map(({ name, ids, overdue: stuck, median }) => (
        <div key={name} className={css.stageRow} role="row">
          <span role="cell" className={css.stageName}>{name}</span>
          <span role="cell" className={css.stageBar}>
            <button type="button" className={css.okPart} style={{ width: pct((ids.length - stuck.length) / max) }} aria-label={`${name}: ${ids.length} now`} onClick={() => onShow(ids, name)} />
            {stuck.length > 0 && (
              <button type="button" className={css.stuckPart} style={{ width: pct(stuck.length / max) }} aria-label={`${name}: ${stuck.length} stuck`} onClick={() => onShow(stuck, `Stuck in ${name}`)} />
            )}
          </span>
          <b role="cell" className={css.num}>{ids.length}</b>
          <span role="cell" className={`${css.num} ${stuck.length ? css.warn : css.dim}`}>{stuck.length || "–"}</span>
          <span role="cell" className={`${css.num} ${css.dim}`}>{median === null ? "–" : `${median}d`}</span>
        </div>
      ))}
      <div className={css.stageRow} role="row">
        <span role="cell" className={css.stageName}>Offer stage</span>
        <span role="cell" className={css.stageBar}>
          <button type="button" className={css.offerPart} style={{ width: pct(offer.length / max) }} aria-label={`Offer stage: ${offer.length}`} onClick={() => onShow(offer.map((c) => c.id), "Offer stage")} />
        </span>
        <b role="cell" className={css.num}>{offer.length}</b>
        <span role="cell" />
        <span role="cell" />
      </div>
      {(
        [
          ["Soft rejected (under pass)", soft],
          ["Parked (no reply or booking)", parked],
          ["Closed", closed],
        ] as const
      ).map(([label, list]) => (
        <div key={label} className={`${css.stageRow} ${css.dim}`} role="row">
          <span role="cell" className={css.stageName}>
            <button type="button" className={css.link} onClick={() => onShow(list.map((c) => c.id), label)}>{label}</button>
          </span>
          <span role="cell" />
          <b role="cell" className={css.num}>{list.length}</b>
          <span role="cell" />
          <span role="cell" />
        </div>
      ))}
    </div>
  );
}

const GEM: Record<GemKind, { label: string; cls: string }> = {
  blocker: { label: "One rule blocks", cls: css.g_blocker },
  idle: { label: "Strong, idle 14+ d", cls: css.g_idle },
  school: { label: "Strong school, under pass", cls: css.g_school },
};
const GEM_KINDS = Object.keys(GEM) as GemKind[];

/** Profile score against school strength. Gems are coloured by group; the shaded box is "strong school, under pass". */
function Gems({ data, observedAt, gems, onShow, onOpen }: { data: HiringData; observedAt: string; gems: Record<GemKind, Gem[]>; onShow: Show; onOpen: (id: string) => void }) {
  const pass = data.config.profileThreshold;
  const [showPoints, setShowPoints] = useState(false);
  const kindOf = new Map<string, GemKind>();
  for (const kind of GEM_KINDS) for (const gem of gems[kind]) kindOf.set(gem.id, kind);
  const dots = useMemo(
    () =>
      data.candidates
        // No school evidence is unknown, not 0%: those stay off the plot.
        .filter((c) => c.profileScore !== null && (c.universityAssessment?.name || c.universityAssessment?.fraction || c.profileAssessment?.schools?.some((school) => school.name.trim())))
        .map((c) => ({ id: c.id, name: c.name, score: c.profileScore!, school: schoolStrength(c, data.config) })),
    [data],
  );
  // Subjects the pipeline will likely not cover come first; the builder's order stays within them.
  const active = (k: GemKind) => gems[k].filter((g) => !g.closed);
  const stopped = (k: GemKind) => gems[k].filter((g) => g.closed);
  const plotted = new Set(dots.map((d) => d.id));
  const gemDots = GEM_KINDS.flatMap(active).filter((g) => plotted.has(g.id));
  const unknown = GEM_KINDS.flatMap(active).length - gemDots.length;
  const otherDots = dots.filter(d => !kindOf.has(d.id));
  const W = 320;
  const H = 210;
  const L = 28;
  const B = 24;
  const x = (v: number) => L + v * (W - L - 16);
  const y = (v: number) => H - B - (v / 100) * (H - B - 8);
  // A small fixed spread, so equal values do not hide each other.
  const jitter = (id: string) => (((id.charCodeAt(0) * 37 + id.charCodeAt(id.length - 1) * 11) % 9) - 4) / 120;
  // The spread never crosses the 75% school line.
  const cx = (d: { id: string; school: number }) => {
    const v = d.school + jitter(d.id);
    return x(d.school >= 0.75 ? Math.min(1, Math.max(0.75, v)) : Math.min(0.745, Math.max(0, v)));
  };
  return (
    <div className={css.gemGrid}>
      <div>
      <svg viewBox={`0 0 ${W} ${H}`} className={css.scatter} role="img" aria-label={`Profile score against school strength; ${gemDots.length} gems coloured by group.`}>
        <rect x={x(0.75)} y={y(pass)} width={x(1) - x(0.75)} height={y(0) - y(pass)} className={css.zone} />
        {[0, 50, 100].map((v) => (
          <text key={v} x={L - 4} y={y(v) + 3} textAnchor="end" className={css.axisText}>{v}</text>
        ))}
        {[0, 0.5, 1].map((v) => (
          <text key={v} x={x(v)} y={H - B + 12} textAnchor="middle" className={css.axisText}>{v * 100}%</text>
        ))}
        <text x={x(0.5)} y={H - 1} textAnchor="middle" className={css.axisLabel}>School strength →</text>
        <text x={L + 2} y={8} className={css.axisLabel}>Score ↑</text>
        <text x={x(0.75) + 3} y={y(0) - 4} className={css.axisText}>school ≥ 75%</text>
        <line x1={x(0)} x2={x(1)} y1={y(pass)} y2={y(pass)} className={css.passLine} />
        <text x={x(1)} y={y(pass) - 3} textAnchor="end" className={css.axisText}>pass {pass}</text>
        {otherDots.map(d => <circle key={d.id} cx={cx(d)} cy={y(d.score)} r={2} className={css.dot} />)}
        {gemDots.map((d) => (
          <circle key={d.id} cx={cx(d)} cy={y(d.score)} r={4} className={GEM[d.kind].cls} onClick={() => onOpen(d.id)}>
            <title>{`${d.name} · ${d.score}`}</title>
          </circle>
        ))}
      </svg>
      <p className={css.note}>Scored profiles on {dateLabel(observedAt)}. School strength uses the higher share of earned credit out of 1 full credit. University credit uses the stored country and ranking assessment (maximum {data.config.profileWeights.prestige} points). The best listed high school earns 1 credit at tier 1 or 0.5 at tier 2 (maximum {data.config.profileWeights.school} points). The strong-school line marks 0.75 of 1. A recorded school with no credit plots at zero. Profiles without school evidence are omitted.</p>
      <details className={css.plotValues} onToggle={event => setShowPoints(event.currentTarget.open)}>
        <summary>Inspect plotted profiles ({gemDots.length + otherDots.length})</summary>
        {showPoints && <ul>{[...gemDots, ...otherDots].map(point => {
          const kind = kindOf.get(point.id);
          return <li key={point.id}>
            <button type="button" className={css.link} onClick={() => onOpen(point.id)}>{point.name}</button>
            <span>Profile score {point.score} · School strength {Math.round(point.school * 100)}% · {kind ? GEM[kind].label : "Other scored profile"}</span>
          </li>;
        })}</ul>}
      </details>
      {unknown > 0 && <p className={css.note}>{unknown} gems with no school data are not plotted.</p>}
      </div>
      <div className={css.gemLists}>
        {GEM_KINDS.map((kind) => (
          <div key={kind} className={css.gemGroup}>
            <div className={css.gemHeadRow}>
              <button type="button" className={css.gemHead} onClick={() => onShow(active(kind).map((g) => g.id), GEM[kind].label)} disabled={!active(kind).length}>
                <i className={GEM[kind].cls} aria-hidden />
                <b>{active(kind).length}</b> {GEM[kind].label}
              </button>
              {stopped(kind).length > 0 && (
                <button type="button" className={css.more} onClick={() => onShow(stopped(kind).map((g) => g.id), `${GEM[kind].label}, stopped`)}>
                  +{stopped(kind).length} stopped
                </button>
              )}
            </div>
            {kind === "idle" && <p className={css.note}>Idle counts require a dated event in the current stage.</p>}
            <ul>
              {active(kind).slice(0, 3).map((gem) => (
                <li key={gem.id}>
                  <button type="button" className={css.link} onClick={() => onOpen(gem.id)}>
                    {gem.name}
                  </button>
                  <span className={css.dim}>
                    {gem.subject ? `${gem.subject} · ` : ""}
                    {gem.reason}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
    </div>
  );
}
