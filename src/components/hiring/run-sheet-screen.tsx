"use client";

import { useMemo, useState, type ReactNode } from "react";
import { localDate, shiftDate } from "@/lib/hiring/model";
import {
  adminPrintListMessage,
  buildRunSheet,
  headName,
  headUpcomingMessage,
  headVisits,
  NO_SUBJECT,
  pastVisits,
  printDays,
  staffGap,
  unrecordedVisits,
  upcoming,
  type RunSheetInput,
  type RunSheetRow,
} from "@/lib/hiring/run-sheet";
import { FirstUseHint } from "./first-use-hint";
import css from "./dashboard.module.css";

const TABS = {
  sheet: "Run sheet",
  print: "Aya: print list",
  heads: "Heads: upcoming mocks",
  previews: "Message previews",
};
export type RunSheetTab = keyof typeof TABS;

const dayLabel = (date: string) =>
  new Date(`${date}T12:00:00Z`).toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" });
const times = (r: RunSheetRow) =>
  [r.paperStart && `Paper ${r.paperStart}`, r.mockStart && `Mock ${r.mockStart}`].filter(Boolean).join(" · ");
const review = (reason: string | null) => <span className={css.warnWord}>{reason}</span>;

function Paper({ row }: { row: RunSheetRow }) {
  return (
    <>
      {row.paper ? (
        <a className={css.sourceLink} href={`/api/hiring/file/${encodeURIComponent(row.paper.id)}`} target="_blank" rel="noopener noreferrer">
          Print {row.paper.name}
        </a>
      ) : (
        review(row.paperReason)
      )}
      {row.issues.map((issue) => (
        <span key={issue} className={`${css.warnWord} ${css.errorText}`}>
          {issue}
        </span>
      ))}
    </>
  );
}
const head = (row: RunSheetRow) =>
  row.hod ? `${row.hod.name}${row.hod.source === "roster" ? " (only head for this subject)" : ""}` : review(row.hodReason ?? "Needs review: no head for this visit");
const candidate = (row: RunSheetRow) => `${row.candidateName}${row.status === "confirmed" ? "" : ` (${row.status.replace("_", " ")})`}`;

function Table({ head: columns, rows, empty }: { head: string[]; rows: ReactNode[][]; empty: string }) {
  if (!rows.length) return <p className={css.empty}>{empty}</p>;
  return (
    <div className={css.tableScroll}>
      <table className={css.sheetTable}>
        <thead>
          <tr>
            {columns.map((c) => (
              <th key={c}>{c}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((cells, i) => (
            <tr key={i}>
              {cells.map((cell, j) => (
                <td key={j}>{cell}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Visit day: the run sheet and the role views built from it. Read only. Nothing is sent from here. */
export function RunSheetScreen({ data, now, initialTab = "sheet" }: { data: Omit<RunSheetInput, "now">; now?: Date; initialTab?: RunSheetTab }) {
  const [tab, setTab] = useState<RunSheetTab>(initialTab);
  const [showPast, setShowPast] = useState(false);
  // Re-read the clock on each data reload: the pane stays mounted, so a mount-time "today" goes stale after midnight.
  const { at, rows, unrecorded } = useMemo(() => {
    const at = now ?? new Date();
    return { at, rows: buildRunSheet({ ...data, now: at }), unrecorded: unrecordedVisits({ ...data, now: at }) };
  }, [data, now]);
  const today = localDate(at);
  const coming = upcoming(rows, today);
  const days = printDays(rows, today);
  const printRows = coming.filter((r) => r.date <= shiftDate(today, 8));
  const recent = pastVisits(rows, today);
  const heads = data.config.interviewers;

  const sheetRow = (r: RunSheetRow) => [
    `${dayLabel(r.date)} · ${times(r)}`,
    candidate(r),
    r.subject ?? review(NO_SUBJECT),
    head(r),
    <Paper key="p" row={r} />,
    review(r.roomReason),
  ];
  const sheetColumns = ["Time", "Candidate", "Subject", "Head", "Paper to print", "Room"];

  return (
    <section className={css.panel} aria-labelledby="visit-day-title">
      <h2 id="visit-day-title" className={css.panelTitle}>
        Visit day
      </h2>
      <div className={css.tabs} role="group" aria-label="Visit day views">
        {(Object.keys(TABS) as RunSheetTab[]).map((name) => (
          <button key={name} type="button" aria-pressed={tab === name} onClick={() => setTab(name)}>
            {TABS[name]}
          </button>
        ))}
      </div>

      {tab === "sheet" && (
        <>
          <FirstUseHint id="hr-run-sheet">
            This list shows every visit from today, first visit first. Old visits show under the list. &quot;Needs review&quot; tells you what is missing: tell
            Kevin. Full steps: the printed job aid.
          </FirstUseHint>
          {unrecorded.length > 0 && (
            <>
              <h3 className={css.panelTitle}>
                Needs review: {unrecorded.length} {unrecorded.length === 1 ? "candidate is" : "candidates are"} at a booked stage but no visit time is recorded
              </h3>
              <Table
                head={["Candidate", "Stage", "Subject", "Head", "Paper", "Owner"]}
                rows={unrecorded.map((u) => [
                  u.candidateName,
                  u.stage.replaceAll("_", " "),
                  u.subject ?? review(NO_SUBJECT),
                  u.head,
                  u.paper,
                  u.owner,
                ])}
                empty=""
              />
            </>
          )}
          <Table head={sheetColumns} rows={coming.map(sheetRow)} empty="No visits are booked from today." />
          {!coming.length && recent.length > 0 && (
            <>
              <h3 className={css.panelTitle}>Recent visits (last 8 weeks)</h3>
              <Table head={sheetColumns} rows={recent.map(sheetRow)} empty="" />
            </>
          )}
          {coming.length > 0 && (
            <label className={css.checkInline}>
              <input type="checkbox" checked={showPast} onChange={(e) => setShowPast(e.target.checked)} />
              Show past visits (last 8 weeks)
            </label>
          )}
          {coming.length > 0 && showPast && <Table head={sheetColumns} rows={recent.map(sheetRow)} empty="No visits in the last 8 weeks." />}
        </>
      )}

      {tab === "print" && (
        <>
          <FirstUseHint id="aya-print-list">
            Aya and Thea: under Tomorrow, click Print on each row and print the paper. With no visit ahead, read Last visit day. Tell Kevin about each &quot;Needs review&quot;
            row. Full steps: the printed Admin job aid.
          </FirstUseHint>
          <p role="status" className={printRows.some(staffGap) ? css.warnWord : undefined}>
            {printRows.filter(staffGap).length} of {printRows.length} visits from today to {dayLabel(shiftDate(today, 8))} miss a
            head or a paper. No visit has a room yet.
          </p>
          {!coming.length && recent.length > 0 && (
            <div>
              <h3 className={css.panelTitle}>Last visit day: {dayLabel(recent[0].date)}</h3>
              <Table
                head={["Time", "Candidate", "Subject", "Head", "Paper", "Room"]}
                rows={recent
                  .filter((r) => r.date === recent[0].date)
                  .map((r) => [times(r), r.candidateName, r.subject ?? review(NO_SUBJECT), head(r), <Paper key="p" row={r} />, review(r.roomReason)])}
                empty="No visits."
              />
            </div>
          )}
          {days.map((date) => (
            <div key={date}>
              <h3 className={css.panelTitle}>
                {date === today ? "Today" : date === shiftDate(today, 1) ? "Tomorrow" : ""} {dayLabel(date)}
              </h3>
              <Table
                head={["Time", "Candidate", "Subject", "Head", "Paper", "Room"]}
                rows={coming
                  .filter((r) => r.date === date)
                  .map((r) => [times(r), r.candidateName, r.subject ?? review(NO_SUBJECT), head(r), <Paper key="p" row={r} />, review(r.roomReason)])}
                empty="No visits."
              />
            </div>
          ))}
        </>
      )}

      {tab === "heads" && (
        <FirstUseHint id="hod-upcoming-mocks">
          Heads: find the block with your name. Read the first row for your next visit. &quot;You run the mock&quot; means you take
          the mock. Full steps: the printed Head of department job aid.
        </FirstUseHint>
      )}
      {tab === "heads" &&
        heads.map((h) => (
          <div key={h.canonicalKey}>
            <h3 className={css.panelTitle}>
              {headName(h.canonicalKey, data.tutors)} · {h.subjects.join(", ")}
            </h3>
            <Table
              head={["Time", "Candidate", "Subject", "Part"]}
              rows={headVisits(rows, h.canonicalKey, today).map((r) => [
                `${dayLabel(r.date)} · ${times(r)}`,
                r.candidateName,
                r.subject ?? review(NO_SUBJECT),
                r.mockStart ? "You run the mock" : "Paper only: no mock",
              ])}
              empty="No upcoming mocks or paper visits."
            />
            {!headVisits(rows, h.canonicalKey, today).length && (() => {
              // Same rule as headVisits: their mocks, and paper-only visits in their subjects.
              const past = recent.filter((r) => r.hod?.key === h.canonicalKey || (!r.mockStart && r.subjectHeads.includes(h.canonicalKey)));
              return past.length > 0 && (
                <>
                  <h3 className={css.panelTitle}>Recent visits (last 8 weeks)</h3>
                  <Table
                    head={["Time", "Candidate", "Subject", "Part"]}
                    rows={past.map((r) => [`${dayLabel(r.date)} · ${times(r)}`, r.candidateName, r.subject ?? review(NO_SUBJECT), r.mockStart ? "Ran the mock" : "Paper only"])}
                    empty=""
                  />
                </>
              );
            })()}
          </div>
        ))}

      {tab === "previews" && (
        <>
          <p role="note" className={css.warnWord}>
            Preview only. Nothing is sent.
          </p>
          {days.map((date) => (
            <div key={date} className={css.sourceText}>
              <h3 className={css.panelTitle}>Aya: print list, {dayLabel(date)}</h3>
              <pre>{adminPrintListMessage(rows, date)}</pre>
            </div>
          ))}
          {heads.map((h) => (
            <div key={h.canonicalKey} className={css.sourceText}>
              <h3 className={css.panelTitle}>Head: {headName(h.canonicalKey, data.tutors)}</h3>
              <pre>{headUpcomingMessage(rows, h.canonicalKey, today, data.tutors)}</pre>
            </div>
          ))}
        </>
      )}
    </section>
  );
}
