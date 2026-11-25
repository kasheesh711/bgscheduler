"use client";

import { useMemo, useState } from "react";
import { formatInTimeZone } from "date-fns-tz";
import { buildFunnel, CLOSED_STAGES, FUNNEL_STEPS, percentile, roundTo, STEP_TIMING, STUCK_RULES, type FunnelReport, type FunnelStep, type GroupFunnel } from "@/lib/hiring/funnel";
import { buildGems, schoolStrength, type Gem, type GemKind } from "@/lib/hiring/gems";
import { buildNextEmails, type EmailKind, type NextEmail } from "@/lib/hiring/next-emails";
import { buildForecast, type ForecastRow } from "@/lib/hiring/forecast";
import type { CapacityReport } from "@/lib/hiring/capacity";
import { ZONE } from "@/lib/hiring/model";
import { groupOptions, pickGroup } from "./funnel-panel";
import type { HiringData } from "./dashboard";
import css from "./overview-analytics.module.css";

/** Filters the candidate table below to these ids; `label` names them in the filter line. */
type Show = (ids: string[], label: string) => void;
const pct = (v: number) => `${Math.round(v * 100)}%`;
const CLOSED = new Set<string>(CLOSED_STAGES);
const DAY = 86_400_000;

/**
 * The Overview (Kevin, 25 Nov 2026): charts first, little text. Top: where people are now and who gets mail next.
 * Then the forecast against need, then the funnel and the hidden gems. Every count opens the candidates behind it.
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
  const [group, setGroup] = useState("all");
  const value = pickGroup(report, group);
  const g = report.groups[value];
  // Already moving, so never a gem: a visit or call ahead, or a place in a send queue.
  const busy = useMemo(
    () =>
      new Set([
        ...data.bookings.filter((b) => b.status === "confirmed" && new Date(b.startTime) > now).map((b) => b.candidateId),
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
  const forecast = useMemo(
    () =>
      buildForecast(
        // Only people in the window the rates come from; months-old rows would count at today's rates.
        data.candidates.filter((c) => new Date(c.createdAt).getTime() >= new Date(report.windowStart).getTime()),
        report.groups.all,
        // A subject Capacity could not measure has no need, not a need of 0.
        capacity?.needs.filter((n) => n.status !== "unknown").map((n) => ({ subject: n.subject, hire: n.hire })) ?? null,
      ),
    [data, report, capacity],
  );
  // Subjects the pipeline is unlikely to cover: their gems come first.
  const short = useMemo(() => new Set(forecast.filter((r) => r.chance !== null && Math.round(r.chance * 100) < 30).map((r) => r.subject)), [forecast]);
  const scoreOf = useMemo(() => new Map(data.candidates.map((c) => [c.id, c.profileScore])), [data]);
  return (
    <div className={css.board}>
      <Pulse data={data} report={report} now={now} onShow={onShow} />
      <div className={`${css.col} ${css.colA}`}>
      <section className={`${css.card} ${css.stages}`} aria-labelledby="ov-now">
        <header className={css.head}>
          <h2 id="ov-now">Where they are now</h2>
          <Legend items={[[css.k_ok, "Within limit"], [css.k_stuck, "Stuck"]]} />
        </header>
        <Stages data={data} report={report} now={now} onShow={onShow} />
      </section>
      <section className={`${css.card} ${css.flow}`} aria-labelledby="ov-flow">
        <header className={css.head}>
          <h2 id="ov-flow">Funnel <span className={css.dim}>since {formatInTimeZone(new Date(report.windowStart), ZONE, "d MMM")}</span></h2>
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
        <Flow g={g} onShow={onShow} />
      </section>
      <section className={`${css.card} ${css.gems}`} aria-labelledby="ov-gems">
        <header className={css.head}>
          <h2 id="ov-gems">Hidden gems</h2>
        </header>
        <Gems data={data} gems={gems} short={short} onShow={onShow} onOpen={onOpen} />
      </section>
      </div>
      <div className={`${css.col} ${css.colB}`}>
      <section className={`${css.card} ${css.forecast}`} aria-labelledby="ov-forecast">
        <Forecast rows={forecast} capacity={capacity} offers={report.groups.all.atLeast.offer} onShow={onShow} />
      </section>
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
function Pulse({ data, report, now, onShow }: { data: HiringData; report: FunnelReport; now: Date; onShow: Show }) {
  const all = data.candidates;
  const open = all.filter((c) => !CLOSED.has(c.stage));
  const scored = all.filter((c) => c.profileScore !== null);
  const pass = scored.filter((c) => (c.profileScore ?? 0) >= data.config.profileThreshold);
  const stuck = open.filter((c) => report.byCandidate[c.id]?.stuck);
  // Stuck can only start after the first email, so its share is of the emailed open candidates.
  const emailed = open.filter((c) => c.stage !== "new" && c.stage !== "review");
  const hired = all.filter((c) => c.stage === "hired");
  const problems = data.outbox.filter((j) => j.status === "failed" || j.status === "uncertain").length;
  const minutes = data.workerAt ? Math.round((now.getTime() - new Date(data.workerAt).getTime()) / 60000) : null;
  const items: { label: string; n: number; of: number; ids: string[]; tone?: string }[] = [
    { label: "Open", n: open.length, of: all.length, ids: open.map((c) => c.id) },
    { label: `Score ${data.config.profileThreshold}+`, n: pass.length, of: scored.length, ids: pass.map((c) => c.id) },
    { label: "Stuck (emailed)", n: stuck.length, of: emailed.length, ids: stuck.map((c) => c.id), tone: css.warnBar },
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
      {items.map((item) => (
        <button key={item.label} type="button" className={css.stat} onClick={() => onShow(item.ids, item.label)}>
          <span className={css.statLabel}>{item.label}</span>
          <b>{item.n}</b>
          <span className={css.dim}>/ {item.of}</span>
          <span className={css.track} aria-hidden>
            <span className={item.tone ?? css.inkBar} style={{ width: pct(item.of ? item.n / item.of : 0) }} />
          </span>
        </button>
      ))}
      <button type="button" className={css.jump} onClick={() => document.getElementById("candidate-table")?.scrollIntoView({ behavior: "smooth" })}>
        Candidates ↓
      </button>
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
    return { key, label, prevLabel: FUNNEL_STEPS[i][1], before: g.atLeast[prev], n: g.atLeast[key], reached: g.reached[key], stop: g.stopped[prev], t: g.stepDays[STEP_TIMING[key]] };
  });
  const leftRate = (r: (typeof rows)[number]) => (r.before ? r.stop.closed.length / r.before : 0);
  const mostLeft = rows.reduce((a, b) => (b.stop.closed.length > a.stop.closed.length ? b : a));
  const worstRate = rows.reduce((a, b) => (leftRate(b) > leftRate(a) ? b : a));
  const queue = rows.reduce((a, b) => (b.stop.open.length > a.stop.open.length ? b : a));
  const slow = rows.reduce((a, b) => ((b.t?.median ?? 0) > (a.t?.median ?? 0) ? b : a));
  const maxDays = Math.max(1, ...rows.map((s) => s.t?.p90 ?? 0));
  const seg = (n: number, before: number) => (before && n / before >= 0.12 ? pct(n / before) : "");
  return (
    <>
      <div className={css.callouts}>
        <button type="button" className={css.callout} onClick={() => onShow(mostLeft.stop.closed, `Left at ${mostLeft.prevLabel}`)}>
          <i className={css.k_big} aria-hidden />
          Most left: <b>{mostLeft.stop.closed.length}</b> at {mostLeft.prevLabel}
        </button>
        {worstRate.key !== mostLeft.key && (
          <button type="button" className={css.callout} onClick={() => onShow(worstRate.stop.closed, `Left at ${worstRate.prevLabel}`)}>
            <i className={css.k_big} aria-hidden />
            Worst rate: <b>{pct(leftRate(worstRate))}</b> left at {worstRate.prevLabel}
          </button>
        )}
        <button type="button" className={css.callout} onClick={() => onShow(queue.stop.open, `Waiting at ${queue.prevLabel}`)}>
          <i className={css.k_wait} aria-hidden />
          Biggest queue: <b>{queue.stop.open.length}</b> at {queue.prevLabel}
        </button>
        {slow.t && (
          <span className={css.callout}>
            <i className={css.k_slow} aria-hidden />
            Slowest: <b>{slow.t.median} d</b> to {slow.label} <span className={css.dim}>n{slow.t.n}</span>
          </span>
        )}
      </div>
      <div className={css.flowGrid} role="table" aria-label="Funnel steps">
        <div className={css.flowHead} role="row">
          <span role="columnheader">Step</span>
          <span role="columnheader" className={css.num}>Count</span>
          <span role="columnheader">Of the step before</span>
          <span role="columnheader">Days</span>
        </div>
        <div className={css.flowRow} role="row">
          <span role="cell">Applied</span>
          <b role="cell" className={css.num}>{g.atLeast.applied}</b>
          <span role="cell" className={css.dim}>{Math.round(g.atLeast.applied / g.weeks)} a week</span>
          <span role="cell" />
        </div>
        {rows.map((r) => {
          const open = r.stop.open.length;
          const left = r.stop.closed.length;
          const part = (n: number) => pct(r.before ? n / r.before : 0);
          const hot = r.key === mostLeft.key || r.key === worstRate.key;
          return (
            <div key={r.key} className={css.flowRow} role="row">
              <span role="cell">{r.label}</span>
              <b role="cell" className={css.num} title={r.n > r.reached ? `${r.n - r.reached} inferred from a later step` : undefined}>
                {r.n}
                {r.n > r.reached && <sup className={css.dim}>*</sup>}
              </b>
              <span role="cell" className={css.flowBar}>
                <span className={css.onPart} style={{ width: part(r.n) }} title={`${r.n} moved on`}>{seg(r.n, r.before)}</span>
                {open > 0 && <button type="button" className={css.waitPart} style={{ width: part(open) }} aria-label={`${open} still waiting at ${r.prevLabel}`} title={`${open} waiting`} onClick={() => onShow(r.stop.open, `Waiting at ${r.prevLabel}`)}>{seg(open, r.before)}</button>}
                {left > 0 && <button type="button" className={hot ? css.leftBig : css.leftPart} style={{ width: part(left) }} aria-label={`${left} left at ${r.prevLabel}`} title={`${left} left`} onClick={() => onShow(r.stop.closed, `Left at ${r.prevLabel}`)}>{seg(left, r.before)}</button>}
              </span>
              <span role="cell" className={css.barCell}>
                {r.t ? (
                  <>
                    <svg className={css.whisker} viewBox="0 0 100 10" preserveAspectRatio="none" aria-hidden>
                      <line x1={(r.t.median / maxDays) * 100} x2={(r.t.p90 / maxDays) * 100} y1={5} y2={5} />
                      <circle cx={(r.t.median / maxDays) * 100} cy={5} r={3.5} className={r.key === slow.key ? css.warnFill : undefined} />
                    </svg>
                    <span className={`${css.daysText} ${r.key === slow.key ? css.warn : ""}`} title={`median of ${r.t.n}, p90 ${r.t.p90} d`}>
                      {r.t.median}d<small>n{r.t.n}</small>
                    </span>
                  </>
                ) : (
                  <span className={css.dim}>–</span>
                )}
              </span>
            </div>
          );
        })}
      </div>
      <Legend items={[[css.k_on, "Moved on"], [css.k_wait, "Waiting"], [css.k_left, "Left"], [css.k_big, "Most left"]]} />
      {rows.some((r) => r.n > r.reached) && <p className={css.note}>* includes people who skipped the step</p>}
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
function Stages({ data, report, now, onShow }: { data: HiringData; report: FunnelReport; now: Date; onShow: Show }) {
  // Onsite booked splits at the visit time: before it the visit is ahead; after it a decision is due.
  const ahead = new Set(data.bookings.filter((b) => b.status === "confirmed" && new Date(b.startTime) > now).map((b) => b.candidateId));
  // Every open stage. Before the first email (days null: New, In review) a row only counts; stuck and median start
  // at the first email (Kevin, 25 Nov 2026).
  const rules = STUCK_RULES.filter((r) => !CLOSED.has(r.stage)).flatMap((r) =>
    r.key === "onsite_booked"
      ? [
          { ...r, key: "visit_ahead", label: "Visit ahead", only: (id: string) => ahead.has(id) },
          { ...r, key: "decision_due", label: "Decision due", only: (id: string) => !ahead.has(id) },
        ]
      : [{ ...r, only: () => true }],
  );
  const rows = rules.flatMap((r) => {
    const list = data.candidates.filter((c) => report.byCandidate[c.id]?.stageKey === (r.key === "visit_ahead" || r.key === "decision_due" ? "onsite_booked" : r.key) && r.only(c.id));
    if (!list.length) return [];
    const stuck = list.filter((c) => report.byCandidate[c.id].stuck).map((c) => c.id);
    const median = r.days === null ? null : roundTo(percentile(list.map((c) => report.byCandidate[c.id].daysInStage), 0.5), 1);
    return [{ rule: r, ids: list.map((c) => c.id), stuck, median }];
  });
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
        <span role="columnheader" className={css.num} title="Median days in the stage, from the first email on">Median</span>
      </div>
      {rows.map(({ rule: r, ids, stuck, median }) => (
        <div key={r.key} className={css.stageRow} role="row">
          <span role="cell" className={css.stageName}>{r.label}</span>
          <span role="cell" className={css.stageBar}>
            <button type="button" className={css.okPart} style={{ width: pct((ids.length - stuck.length) / max) }} aria-label={`${r.label}: ${ids.length} now`} onClick={() => onShow(ids, r.label)} />
            {stuck.length > 0 && (
              <button type="button" className={css.stuckPart} style={{ width: pct(stuck.length / max) }} aria-label={`${r.label}: ${stuck.length} stuck`} onClick={() => onShow(stuck, `Stuck in ${r.label}`)} />
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
function Gems({ data, gems, short, onShow, onOpen }: { data: HiringData; gems: Record<GemKind, Gem[]>; short: Set<string>; onShow: Show; onOpen: (id: string) => void }) {
  const pass = data.config.profileThreshold;
  const kindOf = new Map<string, GemKind>();
  for (const kind of GEM_KINDS) for (const gem of gems[kind]) kindOf.set(gem.id, kind);
  const dots = useMemo(
    () =>
      data.candidates
        // No school evidence is unknown, not 0%: those stay off the plot.
        .filter((c) => c.profileScore !== null && (c.universityAssessment || c.profileAssessment?.schools?.length))
        .map((c) => ({ id: c.id, score: c.profileScore!, school: schoolStrength(c, data.config) })),
    [data],
  );
  // Subjects the pipeline will likely not cover come first; the builder's order stays within them.
  const active = (k: GemKind) => gems[k].filter((g) => !g.closed).sort((a, b) => Number(!short.has(a.subject ?? "")) - Number(!short.has(b.subject ?? "")));
  const stopped = (k: GemKind) => gems[k].filter((g) => g.closed);
  const plotted = new Set(dots.map((d) => d.id));
  const gemDots = GEM_KINDS.flatMap(active).filter((g) => plotted.has(g.id));
  const unknown = GEM_KINDS.flatMap(active).length - gemDots.length;
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
        {dots.map((d) => (kindOf.has(d.id) ? null : <circle key={d.id} cx={cx(d)} cy={y(d.score)} r={2} className={css.dot} />))}
        {gemDots.map((d) => (
          <circle key={d.id} cx={cx(d)} cy={y(d.score)} r={4} className={GEM[d.kind].cls} onClick={() => onOpen(d.id)}>
            <title>{`${d.name} · ${d.score}`}</title>
          </circle>
        ))}
      </svg>
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
            <ul>
              {active(kind).slice(0, 3).map((gem) => (
                <li key={gem.id}>
                  <button type="button" className={css.link} onClick={() => onOpen(gem.id)}>
                    {gem.name}
                  </button>
                  <span className={css.dim}>
                    {gem.subject && short.has(gem.subject) && <b className={css.danger}>short · </b>}
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

/**
 * Expected offers per subject (bar) with the 10th–90th percentile range (line) against Capacity's hire-now need
 * (tick), and the chance of at least that many offers. Subjects with a need come first; the rest open on request.
 */
function Forecast({ rows, capacity, offers, onShow }: { rows: ForecastRow[]; capacity: CapacityReport | null; offers: number; onShow: Show }) {
  const hasNeed = !!capacity;
  const [all, setAll] = useState(false);
  const targets = rows.filter((r) => r.need);
  // Colour and count use the shown (rounded) percent, so a "30%" is never red.
  const shownPct = (r: ForecastRow) => Math.round((r.chance ?? 0) * 100);
  const likelyShort = targets.filter((r) => shownPct(r) < 30);
  const shown = all || !targets.length ? rows : targets;
  const max = Math.max(1, ...shown.map((r) => Math.max(r.high, r.need ?? 0)));
  const tone = (r: ForecastRow) => (r.chance === null ? css.inkBar : shownPct(r) >= 70 ? css.goodBar : shownPct(r) >= 30 ? css.warnBar : css.dangerBar);
  const toneText = (r: ForecastRow) => (r.chance === null ? css.dim : shownPct(r) >= 70 ? css.good : shownPct(r) >= 30 ? css.warn : css.danger);
  return (
    <>
      <header className={css.head}>
        <h2 id="ov-forecast">
          Offer outlook by subject
          {hasNeed && targets.length > 0 && (
            <span className={likelyShort.length ? css.headline : css.headlineGood}>
              {likelyShort.length} of {targets.length} under 30% chance
            </span>
          )}
        </h2>
        <Legend items={[[css.k_good, "≥70%"], [css.k_warn, "30–70%"], [css.k_bad, "<30%"], [css.k_need, "Need"], [css.k_range, "Likely range"]]} />
      </header>
      <p className={css.basis}>
        From the pool today at the rates so far ({offers} {offers === 1 ? "offer" : "offers"}
        {offers < 10 ? ", few: rough" : ""}).
        {capacity && (
          <span className={capacity.stale ? css.warn : undefined}>
            {" "}Need from Capacity, {formatInTimeZone(new Date(capacity.syncedAt), ZONE, "d MMM")}
            {capacity.stale ? " (old)" : ""}.
          </span>
        )}
      </p>
      <div className={css.fcGrid} role="table" aria-label="Expected offers by subject">
        <div className={css.fcHead} role="row">
          <span role="columnheader">Subject</span>
          <span role="columnheader">Expected offers</span>
          <span role="columnheader" className={css.num}>/ need</span>
          <span role="columnheader" className={css.num} title="Chance of at least the needed number of offers">Chance</span>
          <span role="columnheader" className={css.num}>Pool</span>
        </div>
        {shown.map((r) => (
          <div key={r.subject} className={css.fcRow} role="row">
            <span role="cell" className={css.stageName}>
              <button type="button" className={css.link} onClick={() => onShow(r.ids, `${r.subject} pipeline`)}>{r.subject}</button>
            </span>
            <span role="cell" className={css.barCell}>
              <span className={css.track} title={`${r.expected.toFixed(1)} expected · likely ${r.low}–${r.high}`}>
                <span className={tone(r)} style={{ width: pct(r.expected / max) }} />
                <span className={css.range} style={{ left: pct(r.low / max), width: pct(Math.max(0.01, (r.high - r.low) / max)) }} />
                {r.need ? <span className={css.needTick} style={{ left: pct(r.need / max) }} /> : null}
              </span>
            </span>
            <span role="cell" className={css.num}>
              <b>{r.expected.toFixed(1)}</b>
              <span className={css.dim}> / {r.need ?? "–"}</span>
            </span>
            <b role="cell" className={`${css.num} ${toneText(r)}`}>{r.chance === null ? "–" : `${offers < 10 ? "~" : ""}${pct(r.chance)}`}</b>
            <span role="cell" className={`${css.num} ${css.dim}`}>{r.pipeline}</span>
          </div>
        ))}
      </div>
      <div className={css.mailFoot}>
        {targets.length > 0 && rows.length > targets.length && (
          <button type="button" className={css.more} onClick={() => setAll(!all)}>
            {all ? "Only subjects with a need" : `Show all ${rows.length} subjects`}
          </button>
        )}
        {!hasNeed && <span className={css.dim}>No need yet: open Capacity to load it.</span>}
      </div>
    </>
  );
}
