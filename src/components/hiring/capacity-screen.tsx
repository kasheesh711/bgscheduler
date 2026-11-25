"use client";

import { Fragment, useEffect, useRef, useState } from "react";
import { formatInTimeZone } from "date-fns-tz";
import {
  BUSY_BLOCKS,
  BUSY_TARGET,
  DEMAND_DAYS,
  needFullness,
  type CapacityHours,
  type CapacityReport,
  type CapacityTutor,
  type HiringNeed,
} from "@/lib/hiring/capacity";
import type { DemandSubject } from "@/lib/hiring/demand";
import { ZONE } from "@/lib/hiring/model";
import css from "./dashboard.module.css";
import { TabSkeleton } from "./tab-skeleton";

const hours = (value: number) => value.toFixed(1);
const percent = (value: number | null) => (value === null ? "–" : `${Math.round(value * 100)}%`);
const day = (date: string) => formatInTimeZone(new Date(`${date}T12:00:00Z`), ZONE, "d MMM");
const count = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
const blockLabel = (key: string) => BUSY_BLOCKS.find((b) => b.key === key)!.label;
const TARGET = Math.round(BUSY_TARGET * 100);
const TIGHT = 0.8;
const ISSUE: Record<string, string> = {
  alias: "Tutor identity not confirmed in Wise data",
  completeness: "Wise hours or leave did not load",
};
const STATUS = { hire: "Hire", watch: "Nearly full", enough: "Enough tutors", unknown: "Not known" } as const;

/** One sentence HR can read with no other number: which hours are full, and how many tutors carry them. */
export function needReason(need: HiringNeed) {
  const block = need.blocks.find((b) => b.key === need.tightest);
  const full = !need.tutors
    ? need.idle.length || need.review
      ? "No tutor with classes to measure"
      : "No tutor has this subject in Wise"
    : block
      ? `${blockLabel(block.key)}: ${percent(block.used)} full · ${count(need.tutors, "tutor")}`
      : `No busy hours in Wise · ${count(need.tutors, "tutor")}`;
  return [
    full,
    need.idle.length > 0 && `${need.idle.length} more with no classes: check first`,
    need.review > 0 && `${need.review} of ${need.tutors + need.idle.length + need.review} not loaded from Wise`,
    need.hire > 0 && !need.hiring && "Hiring is switched off in Rules and setup",
  ]
    .filter(Boolean)
    .join(" · ");
}

/** "rising" or "falling" when the last 30 days differ from the first 30 by a fifth or more. Too few students say nothing. */
export function demandTrend(d: Pick<DemandSubject, "started" | "months">) {
  const [first, , last] = d.months;
  if (d.started < 10) return "";
  if (first === last) return "steady";
  return last >= first * 1.2 ? "rising" : last <= first * 0.8 ? "falling" : "steady";
}

/** The start dates of the three 30-day blocks, oldest first, and the last day. */
function periods(to: string) {
  const at = (back: number) => {
    const d = new Date(`${to}T12:00:00Z`);
    d.setUTCDate(d.getUTCDate() - back);
    return d.toISOString().slice(0, 10);
  };
  return [0, 1, 2].map((i) => `${day(at(DEMAND_DAYS - 1 - 30 * i))} to ${day(at(DEMAND_DAYS - 30 * (i + 1)))}`);
}

/** New students as one bar to the scale of the largest subject, with the number and the three 30-day bars. */
function DemandBar({ demand: d, max }: { demand: DemandSubject | null; max: number }) {
  const started = d?.started ?? 0;
  const months = d?.months ?? [0, 0, 0];
  const top = Math.max(1, ...months);
  return (
    <span className={css.needDemand}>
      <span className={css.needNumber}>{started}</span>
      <span className={css.needTrack} aria-hidden="true">
        <span style={{ width: `${max > 0 ? (started / max) * 100 : 0}%` }} />
      </span>
      <span className={css.needSpark} aria-hidden="true">
        {months.map((n, i) => (
          <i key={i} style={{ height: `${Math.max(8, (n / top) * 100)}%` }} data-empty={n === 0} />
        ))}
      </span>
      <span className={css.needTrend}>{d ? demandTrend(d) : ""}</span>
    </span>
  );
}

function TutorRows({ rows, review }: { rows: CapacityTutor[]; review?: boolean }) {
  return rows.map((t) => {
    const subjects = t.subjects.join(", ") || "No subject tag";
    const notes = [
      ...(review ? t.issues.map((issue) => ISSUE[issue] ?? issue) : []),
      t.idle && "No classes",
      t.given === 0 && "No hours in Wise",
      t.leave > 0 && `${hours(t.leave)} h leave`,
      t.leaveUnknown && "Leave not known to the end",
    ]
      .filter(Boolean)
      .join(" · ");
    return (
      <tr key={t.key} className={css.capPlainRow}>
        <td>{t.name}</td>
        <td className={css.capSubjects} title={subjects}>{subjects}</td>
        <td className={css.num}>{hours(t.given)}</td>
        <td className={css.num}>{hours(t.booked)}</td>
        <td className={css.num}>{hours(t.remaining)}</td>
        <td className={`${css.num} ${css.wideOnly}`}>{t.outside > 0 ? hours(t.outside) : ""}</td>
        <td className={`${css.num} ${t.utilization !== null && t.utilization >= TIGHT ? css.capTight : ""}`}>
          {percent(t.utilization)}
        </td>
        <td className={css.capNotes} title={notes}>{notes}</td>
      </tr>
    );
  });
}

function TutorTable({ rows, review = [] }: { rows: CapacityTutor[]; review?: CapacityTutor[] }) {
  return (
    <div className={css.tableScroll}>
      <table className={css.table}>
        <thead>
          <tr>
            <th>Tutor</th>
            <th>Subjects</th>
            <th className={css.num}>Given</th>
            <th className={css.num}>Booked</th>
            <th className={css.num}>Free</th>
            <th className={`${css.num} ${css.wideOnly}`}>Outside hours</th>
            <th className={css.num}>Used</th>
            <th>Notes</th>
          </tr>
        </thead>
        <tbody>
          <TutorRows rows={rows} />
        </tbody>
        {review.length > 0 && (
          <tbody>
            <tr className={css.capPlainRow}>
              <th colSpan={8} scope="rowgroup" className={css.capGroup}>
                Needs review ({review.length}) · not counted
              </th>
            </tr>
            <TutorRows rows={review} review />
          </tbody>
        )}
      </table>
    </div>
  );
}

/** How full the tutors are in the block that decides, as a short bar with the limit marked. */
function FullMeter({ need }: { need: HiringNeed }) {
  const used = needFullness(need);
  return (
    <span className={css.needFull}>
      {/* The mark follows the limit in the code, not a copy of it in the stylesheet. */}
      <span className={css.needTrack} aria-hidden="true" data-limit style={{ "--limit": `${TARGET}%` } as React.CSSProperties}>
        <span data-over={need.hire > 0} style={{ width: `${Math.min(100, (need.tutors ? used : 0) * 100)}%` }} />
      </span>
      <span className={css.num}>{need.tutors ? percent(used) : "–"}</span>
    </span>
  );
}

/** The working behind one subject's number: each busy block, the sum for the block that decides, and the tutors. */
export function NeedDetail({ need, report }: { need: HiringNeed; report: CapacityReport }) {
  // The block on the row. With a hire, it is the block that sets the number.
  const worst = need.hire > 0 ? need.blocks.find((b) => b.key === need.tightest) : undefined;
  const limit = worst ? BUSY_TARGET * worst.given : 0;
  const perTutor = worst ? (BUSY_TARGET * worst.given) / worst.givers : 0;
  const d = need.demand;
  const fullest = needFullness(need);
  const labels = report.demand ? periods(report.demand.to) : [];
  const top = Math.max(1, ...(d?.months ?? []));
  return (
    <div className={css.needDetail}>
      {d && report.demand && (
        <>
          <h3 className={css.needHead}>New students: {d.started} in the last {DEMAND_DAYS} days</h3>
          <div className={css.needChart}>
            {d.months.map((n, i) => (
              <div key={labels[i]} className={css.needColumn}>
                <span className={css.needColumnValue}>{n}</span>
                <span className={css.needColumnBar} aria-hidden="true">
                  <i style={{ height: `${(n / top) * 100}%` }} />
                </span>
                <span className={css.tileNote}>{labels[i]}</span>
              </div>
            ))}
            <div className={css.needLevels}>
              <p className={css.tileLabel}>By level</p>
              {d.levels.slice(0, 6).map((l) => (
                <p key={l.level} className={css.needLevel}>
                  <span>{l.level}</span>
                  <span className={css.needTrack} aria-hidden="true">
                    <span style={{ width: `${(l.started / d.levels[0].started) * 100}%` }} />
                  </span>
                  <span className={css.num}>{l.started}</span>
                </p>
              ))}
            </div>
          </div>
          <p className={css.needSum}>
            {count(d.active, "student")} had a {need.subject} class in the last 30 days. A new student is a student’s first
            class in a course of this subject: a new student, a new subject for a student, or a move to a new level.
            {need.tutors > 0 &&
              ` Place in the list: ${d.started} new students × ${percent(fullest)} full = ${Math.round(need.score)}.`}
          </p>
        </>
      )}
      <h3 className={css.needHead}>How full the tutors are</h3>
      <div className={css.needBlocks}>
        {need.blocks.map((b) => (
          <div key={b.key}>
            <p className={css.tileLabel}>{blockLabel(b.key)}</p>
            <p className={`${css.meterValue} ${b.hire > 0 ? css.capTight : ""}`}>
              {percent(b.used)}
              <span className={css.meterMax}> full</span>
            </p>
            <div className={css.meter} aria-hidden="true">
              <span data-full={b.hire > 0} style={{ width: `${Math.min(100, (b.used ?? 0) * 100)}%` }} />
            </div>
            <p className={css.tileNote}>
              {hours(b.booked)} of {hours(b.given)} h a week booked
            </p>
          </div>
        ))}
      </div>
      {worst && (
        <p className={css.needSum}>
          {blockLabel(worst.key)}: {hours(worst.booked)} h are booked. The limit is {TARGET}% of {hours(worst.given)} h ={" "}
          {hours(limit)} h, so {hours(worst.booked - limit)} h are over. One tutor gives about{" "}
          {hours(worst.given / worst.givers)} h in these hours, and {TARGET}% of that is {hours(perTutor)} h.{" "}
          {hours(worst.booked - limit)} ÷ {hours(perTutor)}, rounded up, makes {count(need.hire, "new tutor")}.
        </p>
      )}
      {need.idle.length > 0 && (
        <p className={css.needSum}>
          No classes in this period, so not counted: {need.idle.join(", ")}. Check that they still teach, or give them
          students before you hire.
        </p>
      )}
      {need.review > 0 && (
        <p className={css.needSum}>
          {count(need.review, "tutor")} of this subject did not load from Wise in the last sync and {need.review === 1 ? "is" : "are"} not
          counted. The number can change after the next sync.
        </p>
      )}
      <TutorTable rows={report.tutors.filter((t) => need.tutorKeys.includes(t.key))} />
    </div>
  );
}

function PoolBar({ row, here, max }: { row: CapacityHours; here: number; max: number }) {
  const part = (value: number) => ({ width: `${row.given > 0 ? (value / row.given) * 100 : 0}%` });
  return (
    <span className={css.capTrack} aria-hidden="true">
      <span className={css.capBar} style={{ width: `${max > 0 ? (row.given / max) * 100 : 0}%` }}>
        <span className={css.capHere} style={part(here)} />
        <span className={css.capOther} style={part(row.booked - here)} />
      </span>
    </span>
  );
}

function Numbers({ row }: { row: CapacityHours }) {
  return (
    <>
      <span className={`${css.num} ${css.capWide}`}>{hours(row.given)}</span>
      <span className={`${css.num} ${css.capWide}`}>{hours(row.booked)}</span>
      <span className={css.num}>{hours(row.remaining)}</span>
      <span className={`${css.num} ${row.utilization !== null && row.utilization >= TIGHT ? css.capTight : ""}`}>
        {percent(row.utilization)}
      </span>
    </>
  );
}

/** Every listed hour, by Wise subject tag and by tutor. For a person who wants to check the numbers. */
function AllHours({ report: r }: { report: CapacityReport }) {
  const [open, setOpen] = useState<string | null>(null);
  const pool = r.subjects.find((s) => s.subject === open);
  const tutors = pool ? r.tutors.filter((t) => pool.tutorKeys.includes(t.key)) : r.tutors;
  const max = Math.max(0, ...r.subjects.map((s) => s.given));
  return (
    <>
      <section className={css.kpis} aria-label="All listed hours">
        {(
          [
            ["Used, all hours", percent(r.totals.utilization), "Low, because tutors list long hours"],
            ["Tutors", String(r.totals.tutors), `${r.tutors.filter((t) => t.idle).length} have no classes`],
            ["Hours given", hours(r.totals.given), "Per week, after leave"],
            ["Hours booked", hours(r.totals.booked), "Per week, inside given hours"],
          ] as const
        ).map(([label, value, note]) => (
          <div key={label} className={css.tile}>
            <p className={css.tileLabel}>{label}</p>
            <p className={css.tileValue}>{value}</p>
            <p className={css.tileNote}>{note}</p>
          </div>
        ))}
      </section>
      <section className={css.panel}>
        <h3 className={css.panelTitle}>By Wise subject tag</h3>
        <p className={css.panelLede}>
          Hours per week, all hours. A tutor with two subjects is in both rows, and a class in one subject uses the hour in
          the other. Rows do not add up.
        </p>
        <div className={`${css.capRow} ${css.capHead}`} aria-hidden="true">
          <span>Subject</span>
          <span className={`${css.num} ${css.capWide}`}>Tutors</span>
          <span className={css.legend}>
            <span><i className={css.capHere} /> This subject</span>
            <span><i className={css.capOther} /> Other subjects</span>
            <span><i className={css.capFree} /> Free</span>
          </span>
          <span className={`${css.num} ${css.capWide}`}>Given</span>
          <span className={`${css.num} ${css.capWide}`}>Booked</span>
          <span className={css.num}>Free</span>
          <span className={css.num}>Used</span>
        </div>
        {r.subjects.map((s) => (
          <Fragment key={s.subject}>
            <button
              type="button"
              className={css.capRow}
              aria-expanded={open === s.subject}
              aria-label={`${s.subject}: ${count(s.tutors, "tutor")}, ${hours(s.given)} hours given, ${hours(s.remaining)} free, ${percent(s.utilization)} used`}
              onClick={() => setOpen(open === s.subject ? null : s.subject)}
            >
              <span className={css.subjectName}>{s.subject}</span>
              <span className={`${css.num} ${css.capWide}`}>{s.tutors}</span>
              <PoolBar row={s} here={s.bookedHere} max={max} />
              <Numbers row={s} />
            </button>
            {open === s.subject &&
              s.levels.map((l) => (
                <div key={`${l.curriculum} ${l.level}`} className={`${css.capRow} ${css.capLevel}`}>
                  <span>
                    {l.curriculum} · {l.level}
                  </span>
                  <span className={`${css.num} ${css.capWide}`}>{l.tutors}</span>
                  {/* A level row has no subject split: the whole bar is booked time. */}
                  <PoolBar row={l} here={0} max={max} />
                  <Numbers row={l} />
                </div>
              ))}
          </Fragment>
        ))}
      </section>
      <section className={css.tableSection}>
        <div className={css.tableTools}>
          <h3 className={css.panelTitle}>
            {pool ? `Tutors with the ${pool.subject} tag (${tutors.length})` : `All tutors (${tutors.length})`}
          </h3>
          {pool && (
            <button type="button" className={css.inlineLink} onClick={() => setOpen(null)}>
              Show all tutors
            </button>
          )}
        </div>
        <TutorTable rows={tutors} review={pool ? [] : r.needsReview} />
      </section>
      <p className={css.capFoot}>
        Given = Wise working hours minus leave. Booked = classes inside those hours. Used = booked ÷ given. A class outside
        the working hours is in “Outside hours”. {hours(r.unidentified)} h a week of classes have a title that names none
        of the tutor’s subjects; they count as booked, under “Other subjects”. Tutor Offboarding → Analytics uses recorded
        history, so its numbers differ.
      </p>
    </>
  );
}

/** Read-only. The first screen answers one question for HR: which subject to hire for now, and how many people. */
export function CapacityView({
  report: r,
  reload,
  busy,
  error,
}: {
  report: CapacityReport;
  reload: () => void;
  busy: boolean;
  error?: string;
}) {
  const [open, setOpen] = useState<string | null>(null);
  const idle = r.tutors.filter((t) => t.idle);
  // The top of the list, without subjects that have room.
  const first = r.needs.filter((n) => n.status !== "enough").slice(0, 3);
  const max = Math.max(1, ...r.needs.map((n) => n.demand?.started ?? 0), ...(r.demand?.subjects.map((d) => d.started) ?? []));
  return (
    <div className={css.main}>
      {error && (
        <p role="alert" className={css.alert}>
          Could not reload, so these are the earlier numbers. {error}
        </p>
      )}
      {r.stale && (
        <p role="alert" className={css.alert}>
          Wise data is old (last sync {formatInTimeZone(new Date(r.syncedAt), ZONE, "d MMM, HH:mm")}). These numbers can be wrong.
        </p>
      )}
      {!r.demand && (
        <p role="alert" className={css.alert}>
          The new-student numbers could not load. The list is in the order of need: people to hire, then how full the
          tutors are.
        </p>
      )}
      <section className={css.needHero} aria-label="Top priorities">
        <div>
          <p className={css.heroLabel}>Top priorities</p>
          <p className={css.heroValue}>{first.length ? first.map((n) => n.subject).join(" · ") : "No new tutor needed"}</p>
        </div>
        <button type="button" className={css.heroLink} onClick={reload} disabled={busy}>
          {busy ? "Loading…" : "Reload"}
        </button>
      </section>
      <section className={css.panel}>
        <p className={css.panelLede}>
          The list is in order of priority. A subject is high when it has many new students and its tutors are nearly
          full.{" "}
          {r.demand && (
            <>
              New students are counted from {day(r.demand.from)} to {day(r.demand.to)}.{" "}
            </>
          )}
          Tutors are full above {TARGET}% of the hours students come, from {day(r.from)} to {day(r.to)}. Click a subject
          to see why.
        </p>
        <p className={css.panelLede}>
          Hours that count: {BUSY_BLOCKS.map((b) => b.label).join(" · ")}. These are the hours most classes are booked;
          half of all class hours are at weekends, so quiet weekend hours are left out.
        </p>
        <div className={`${css.needRow} ${css.needHeadRow}`} aria-hidden="true">
          <span />
          <span>Subject</span>
          <span>New students, last {DEMAND_DAYS} days</span>
          <span>Tutors full</span>
          <span>What to do</span>
        </div>
        <ol className={css.needList}>
          {r.needs.map((need, i) => (
            <li key={need.subject}>
              <button
                type="button"
                className={css.needRow}
                aria-expanded={open === need.subject}
                aria-label={`${i + 1}. ${need.subject}: ${count(need.demand?.started ?? 0, "new student")}, ${need.hire > 0 ? `hire ${need.hire}` : STATUS[need.status]}. ${needReason(need)}`}
                onClick={() => setOpen(open === need.subject ? null : need.subject)}
              >
                <span className={css.needRank}>{i + 1}</span>
                <span className={css.needName}>{need.subject}</span>
                <DemandBar demand={need.demand} max={max} />
                <FullMeter need={need} />
                <span className={`${css.pill} ${css[`need_${need.status}`]}`}>
                  {need.hire > 0 ? `Hire ${need.hire}` : STATUS[need.status]}
                </span>
                <span className={css.needWhy}>{needReason(need)}</span>
              </button>
              {open === need.subject && <NeedDetail need={need} report={r} />}
            </li>
          ))}
        </ol>
        {!r.needs.length && <p className={css.panelLede}>No tutor in Wise has a subject that Hiring recruits for.</p>}
        <p className={css.needLegend}>
          <span className={css.needSpark} aria-hidden="true">
            <i style={{ height: "40%" }} />
            <i style={{ height: "70%" }} />
            <i style={{ height: "100%" }} />
          </span>
          The three small bars are new students in each 30 days, oldest first.
        </p>
      </section>
      {r.demand && r.demand.subjects.length > 0 && (
        <section className={css.panel}>
          <h2 className={css.panelTitle}>New students in subjects that are not on the Hiring list</h2>
          <p className={css.panelLede}>
            General science is taught by Physics, Chemistry and Biology tutors. “Other or not known” holds interview
            practice, tests, and classes whose title names no subject.
          </p>
          {r.demand.subjects.map((d) => (
            <div key={d.subject} className={`${css.needRow} ${css.needOther}`}>
              <span />
              <span className={css.needName}>{d.subject}</span>
              <DemandBar demand={d} max={max} />
            </div>
          ))}
        </section>
      )}

      <details className={css.capMore}>
        <summary>
          {count(idle.length, "tutor")} with no classes · {r.needsReview.length} not counted
        </summary>
        <p className={css.panelLede}>
          These tutors list hours in Wise and have no class from {day(r.from)} to {day(r.to)}. They are not counted as
          free hours above. Check that each one still teaches. The “not counted” tutors are at the end: Wise did not
          load their hours in the last sync, or their identity is not confirmed.
        </p>
        <TutorTable rows={idle} review={r.needsReview} />
      </details>
      <details className={css.capMore}>
        <summary>All hours and all tutors</summary>
        <AllHours report={r} />
      </details>
      <p className={css.capFoot}>
        How the number is made: for each block of busy hours, the hours over {TARGET}% ÷ {TARGET}% of the hours one
        tutor of the subject gives in that block, rounded up. The largest block decides. A class outside a tutor’s listed
        hours counts as a busy hour given and booked. Each value is the 4-week total ÷ 4. Wise makes future
        classes only some weeks ahead, so a later week can look more free than it will be. Wise data from{" "}
        {formatInTimeZone(new Date(r.syncedAt), ZONE, "d MMM, HH:mm")}.
      </p>
    </div>
  );
}

/** Loads the report once, when the tab opens or the page is idle after mount. It does not wait for the main Hiring load. */
export function CapacityScreen({ active, onReport }: { active: boolean; onReport?: (report: CapacityReport) => void }) {
  const [report, setReport] = useState<CapacityReport | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const asked = useRef(false);
  async function load() {
    setBusy(true);
    setError("");
    try {
      const response = await fetch("/api/hiring?capacity=1", { cache: "no-store" });
      const value = await response.json();
      if (!response.ok) throw new Error(value.error);
      setReport(value);
      onReport?.(value);
    } catch (e) {
      setError(e instanceof Error && e.message ? e.message : "Could not load capacity.");
    } finally {
      setBusy(false);
    }
  }
  // One fetch: the first of "tab opens" or "dashboard idle after mount" starts it, so the first switch shows data at once.
  useEffect(() => {
    if (!active || asked.current) return;
    asked.current = true;
    void load();
  }, [active]);
  useEffect(() => {
    const start = () => {
      if (asked.current) return;
      asked.current = true;
      void load();
    };
    const idle = typeof requestIdleCallback === "function" ? requestIdleCallback(start, { timeout: 2000 }) : undefined;
    const timer = idle === undefined ? setTimeout(start, 500) : undefined;
    return () => {
      if (idle !== undefined) cancelIdleCallback(idle);
      clearTimeout(timer);
    };
  }, []);
  if (report) return <CapacityView report={report} reload={load} busy={busy} error={error} />;
  return error ? (
    <p role="alert" className={css.alert}>
      {error}{" "}
      <button type="button" className={css.inlineLink} onClick={load}>
        Try again
      </button>
    </p>
  ) : (
    <TabSkeleton label="Loading capacity…" />
  );
}
