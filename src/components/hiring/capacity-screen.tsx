"use client";

import { Fragment, useEffect, useRef, useState } from "react";
import { formatInTimeZone } from "date-fns-tz";
import type { CapacityHours, CapacityReport, CapacityTutor } from "@/lib/hiring/capacity";
import { ZONE } from "@/lib/hiring/model";
import css from "./dashboard.module.css";

const hours = (value: number) => value.toFixed(1);
const percent = (value: number | null) => (value === null ? "–" : `${Math.round(value * 100)}%`);
const day = (date: string) => formatInTimeZone(new Date(`${date}T12:00:00Z`), ZONE, "d MMM");
const TIGHT = 0.8;
const ISSUE: Record<string, string> = {
  alias: "Tutor identity not confirmed in Wise data",
  completeness: "Wise data incomplete",
};

/** Booked in this subject, booked in other subjects, free. The track is the given hours, to the scale of the largest row. */
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

function TutorRows({ rows, review }: { rows: CapacityTutor[]; review?: boolean }) {
  return rows.map((t) => (
    <tr key={t.key} className={css.capPlainRow}>
      <td>{t.name}</td>
      <td className={css.capSubjects}>{t.subjects.join(", ") || "No subject tag"}</td>
      <td className={css.num}>{hours(t.given)}</td>
      <td className={css.num}>{hours(t.booked)}</td>
      <td className={css.num}>{hours(t.remaining)}</td>
      <td className={`${css.num} ${css.wideOnly}`}>{t.outside > 0 ? hours(t.outside) : ""}</td>
      <td className={`${css.num} ${t.utilization !== null && t.utilization >= TIGHT ? css.capTight : ""}`}>
        {percent(t.utilization)}
      </td>
      <td className={css.capNotes}>
        {[
          ...(review ? t.issues.map((issue) => ISSUE[issue] ?? issue) : []),
          t.given === 0 && "No hours in Wise",
          t.leave > 0 && `${hours(t.leave)} h leave`,
          t.leaveUnknown && "Leave not known to the end",
        ]
          .filter(Boolean)
          .join(" · ")}
      </td>
    </tr>
  ));
}

/** Read-only. Tutor hours for the next 4 weeks, from the current Wise snapshot. */
export function CapacityView({ report: r, reload, busy }: { report: CapacityReport; reload: () => void; busy: boolean }) {
  const [open, setOpen] = useState<string | null>(null);
  const pool = r.subjects.find((s) => s.subject === open);
  const tutors = pool ? r.tutors.filter((t) => pool.tutorKeys.includes(t.key)) : r.tutors;
  const max = Math.max(0, ...r.subjects.map((s) => s.given));
  return (
    <div>
      {r.stale && (
        <p role="alert" className={css.alert}>
          Wise data is old (last sync {formatInTimeZone(new Date(r.syncedAt), ZONE, "d MMM, HH:mm")}). These hours can be wrong.
        </p>
      )}
      <section className={css.kpis} aria-label="Company capacity">
        <div className={css.hero}>
          <p className={css.heroLabel}>
            Utilization · {day(r.from)} to {day(r.to)}
          </p>
          <p className={css.heroValue}>{percent(r.totals.utilization)}</p>
          <button type="button" className={css.heroLink} onClick={reload} disabled={busy}>
            {busy ? "Loading…" : "Reload"}
          </button>
        </div>
        {(
          [
            ["Active tutors", String(r.totals.tutors), r.needsReview.length ? `${r.needsReview.length} more need review` : "In the totals"],
            ["Hours given", hours(r.totals.given), "Per week, after leave"],
            ["Hours booked", hours(r.totals.booked), "Per week, inside given hours"],
            ["Hours remaining", hours(r.totals.remaining), `Per week · ${percent(r.totals.given > 0 ? r.totals.remaining / r.totals.given : null)} free`],
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
        <h2 className={css.panelTitle}>By subject</h2>
        <p className={css.panelLede}>
          Hours per week. A tutor with two subjects is in both rows, and a class in one subject uses the hour in the other.
          Rows do not add up to the company total.
        </p>
        <div className={`${css.capRow} ${css.capHead}`}>
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
              onClick={() => setOpen(open === s.subject ? null : s.subject)}
            >
              <span className={css.subjectLabel}>
                <span className={css.subjectName}>{s.subject}</span>
                {s.hiring !== null && (
                  <span className={`${css.pill} ${s.hiring ? css.pillReplied : css.pillNoReply}`}>
                    {s.hiring ? `Hiring · priority ${s.rank}` : "Not hiring"}
                  </span>
                )}
              </span>
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
                  <PoolBar row={l} here={0} max={max} />
                  <Numbers row={l} />
                </div>
              ))}
          </Fragment>
        ))}
        {!r.subjects.length && <p className={css.panelLede}>No active tutor has a subject tag in Wise.</p>}
      </section>

      <section className={css.tableSection}>
        <div className={css.tableTools}>
          <h2 className={css.panelTitle}>
            {pool ? `Tutors who can teach ${pool.subject} (${tutors.length})` : `By tutor (${tutors.length})`}
          </h2>
          {pool && (
            <button type="button" className={css.inlineLink} onClick={() => setOpen(null)}>
              Show all tutors
            </button>
          )}
        </div>
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
              <TutorRows rows={tutors} />
              {!pool && r.needsReview.length > 0 && (
                <>
                  <tr className={css.capPlainRow}>
                    <th colSpan={8} scope="rowgroup" className={css.capGroup}>
                      Needs review ({r.needsReview.length}) · not in the totals
                    </th>
                  </tr>
                  <TutorRows rows={r.needsReview} review />
                </>
              )}
            </tbody>
          </table>
        </div>
      </section>

      <p className={css.capFoot}>
        Given = Wise working hours minus leave. Booked = classes inside those hours. Free = given minus booked. Used = booked
        ÷ given. A class outside the working hours is in “Outside hours” and not in the rate. The period starts tomorrow and
        each value is the 4-week total ÷ 4. {hours(r.unidentified)} h a week of classes have a title that names none of the
        tutor’s subjects; they count as booked, under “Other subjects”. Wise makes future classes only some weeks ahead, so
        the later weeks can look more free than they will be. Tutor Offboarding → Analytics uses recorded history, so its
        numbers differ. Wise data from {formatInTimeZone(new Date(r.syncedAt), ZONE, "d MMM, HH:mm")}.
      </p>
    </div>
  );
}

/** Loads the report the first time the tab opens, so the main Hiring load stays as fast as before. */
export function CapacityScreen({ active }: { active: boolean }) {
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
    } catch (e) {
      setError(e instanceof Error && e.message ? e.message : "Could not load capacity.");
    } finally {
      setBusy(false);
    }
  }
  useEffect(() => {
    if (!active || asked.current) return;
    asked.current = true;
    void load();
  }, [active]);
  if (report) return <CapacityView report={report} reload={load} busy={busy} />;
  return error ? (
    <p role="alert" className={css.alert}>
      {error}{" "}
      <button type="button" className={css.inlineLink} onClick={load}>
        Try again
      </button>
    </p>
  ) : (
    <p role="status" className={css.loading}>
      Loading capacity…
    </p>
  );
}
