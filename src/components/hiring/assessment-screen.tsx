"use client";

import { useMemo, useState } from "react";
import { formatInTimeZone } from "date-fns-tz";
import {
  ASSESSMENT_CHIPS,
  ASSESSMENT_RANGES,
  assessmentRows,
  hireBlockers,
  matchesChip,
  matchesRange,
  type AssessmentChip,
  type AssessmentRange,
  type AssessmentRow,
} from "@/lib/hiring/assessment-view";
import { RUBRIC, computeSheet, passRulesFor, rubricTotals, type LevelResult } from "@/lib/hiring/marking-sheet";
import { ZONE } from "@/lib/hiring/model";
import type { HiringCandidate, HiringData } from "./dashboard";
import { HeadSchedules } from "./head-schedules";
import css from "./dashboard.module.css";

type Paper = HiringData["papers"][number];
type Mock = HiringData["mocks"][number];
const when = (value: Date) => formatInTimeZone(value, ZONE, "EEE d MMM, HH:mm");
const clock = (value: Date) => formatInTimeZone(value, ZONE, "HH:mm");
const round = (n: number) => Math.round(n * 10) / 10;

const STATUS: Record<Paper["status"], { label: string; tone: string }> = {
  uploaded: { label: "Waiting to mark", tone: css.mutedCell },
  marking: { label: "Marking…", tone: css.warnWord },
  done: { label: "Done", tone: css.goodWord },
  needs_check: { label: "Needs check", tone: css.warnWord },
  failed: { label: "Failed", tone: css.errorText },
};
const LEVEL: Record<LevelResult, { label: string; tone: string }> = {
  passed: { label: "Passed", tone: css.goodWord },
  not_passed: { label: "Not passed", tone: css.errorText },
  not_done: { label: "Not done", tone: css.mutedCell },
  pass_mark_missing: { label: "Pass mark missing", tone: css.warnWord },
};

const byCandidate = <T extends { candidateId: string }>(rows: T[]) => {
  const map = new Map<string, T[]>();
  for (const row of rows) map.set(row.candidateId, [...(map.get(row.candidateId) ?? []), row]);
  return map;
};

/** One line for a table cell: the result, or what is happening to it. */
export function paperCell(paper: Paper, config: HiringData["config"]) {
  if (paper.history) return `${paper.subject}: ${paper.history.outcome || "Recorded"}`;
  if (paper.status !== "done" || !paper.marks) return `${paper.subject}: ${STATUS[paper.status].label}`;
  const sheet = computeSheet(paper.marks, passRulesFor(config, paper.subject));
  return `${paper.subject}: ${sheet.max ? Math.round((sheet.total / sheet.max) * 100) : 0}% · ${sheet.canTeachUpTo}`;
}
export function mockCell(mock: Mock) {
  if (mock.history) return mock.history.score === null ? mock.history.outcome || "Recorded" : `${mock.history.score} / 100`;
  if (mock.status !== "done" || !mock.rubric) return STATUS[mock.status].label;
  return `${rubricTotals(mock.rubric).total} / 100`;
}

export function PaperSheetView({ paper, config }: { paper: Paper; config: HiringData["config"] }) {
  const sheet = paper.marks ? computeSheet(paper.marks, passRulesFor(config, paper.subject)) : null;
  return (
    <section className={css.inspectorSection} aria-label={`Paper marking sheet for ${paper.subject}`}>
      <h3 className={css.inspectorHeading}>
        Paper: {paper.subject}
        <span className={STATUS[paper.status].tone}>{paper.history ? "From the tracker" : STATUS[paper.status].label}</span>
      </h3>
      {paper.history && (
        <dl className={css.facts}>
          <div>
            <dt>Outcome</dt>
            <dd>{paper.history.outcome || "–"}</dd>
          </div>
          <div>
            <dt>Passed subjects</dt>
            <dd>{paper.history.passedSubjects || "–"}</dd>
          </div>
          <div>
            <dt>Levels passed</dt>
            <dd>{paper.history.levels || "–"}</dd>
          </div>
          <div>
            <dt>Date</dt>
            <dd>{paper.history.date || "–"}</dd>
          </div>
        </dl>
      )}
      {paper.error && <p className={css.errorText}>{paper.error}</p>}
      {paper.source === "ai" && paper.markSchemeUsed === false && (
        <p className={css.warnWord}>Marked without a mark scheme, from the AI&apos;s own subject knowledge.</p>
      )}
      {paper.marks?.missingPages && <p className={css.warnWord}>Missing pages: {paper.marks.missingPages}</p>}
      {sheet && paper.marks && (
        <>
          <table className={css.sheetTable}>
            <thead>
              <tr>
                <th>Level</th>
                <th>Score</th>
                <th>Pass mark</th>
                <th>Result</th>
              </tr>
            </thead>
            <tbody>
              {sheet.levels.map((level) => (
                <tr key={level.level}>
                  <td>{level.level}</td>
                  <td className={css.num}>{level.max ? `${round(level.scored)} / ${round(level.max)}` : "–"}</td>
                  <td className={css.num}>{level.passPercent === null ? "–" : `${level.passPercent}%`}</td>
                  <td className={LEVEL[level.result].tone}>{LEVEL[level.result].label}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <dl className={css.facts}>
            <div>
              <dt>Paper score</dt>
              <dd className={css.num}>
                {round(sheet.total)} / {round(sheet.max)}
              </dd>
            </div>
            <div>
              <dt>Can teach up to</dt>
              <dd>{sheet.canTeachUpTo}</dd>
            </div>
            {paper.changedBy && (
              <div>
                <dt>Changed by</dt>
                <dd>{paper.changedBy}</dd>
              </div>
            )}
          </dl>
          <p className={css.inspectorText}>{paper.marks.comment}</p>
          <details className={css.sourceText}>
            <summary>Marks for each question, beside the scan</summary>
            <div className={css.scanSplit}>
              {paper.fileId && <p className={css.inspectorMeta}>A link in a file can open another site. Do not sign in on a page that opens from a file.</p>}
              {paper.fileId && <iframe className={css.resumeFrame} src={`/api/hiring/file/${encodeURIComponent(paper.fileId)}`} title={`Scan of the ${paper.subject} paper`} />}
              <table className={css.sheetTable}>
                <thead>
                  <tr>
                    <th>Question</th>
                    <th>Marks</th>
                    <th>Why</th>
                  </tr>
                </thead>
                <tbody>
                  {paper.marks.questions.map((q) => (
                    <tr key={q.id}>
                      <td>
                        {q.id}
                        <span className={css.pillNote}>{q.level}</span>
                      </td>
                      <td className={css.num}>{q.marks === null ? <span className={css.warnWord}>Unreadable</span> : `${q.marks} / ${q.max}`}</td>
                      <td>{q.attempted ? q.reason : "Not tried"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </details>
        </>
      )}
    </section>
  );
}

export function MockView({ mock }: { mock: Mock }) {
  const totals = mock.rubric ? rubricTotals(mock.rubric) : null;
  return (
    <section className={css.inspectorSection} aria-label="Mock rubric">
      <h3 className={css.inspectorHeading}>
        Mock: {mock.subject}
        <span className={STATUS[mock.status].tone}>{mock.history ? "From the tracker" : STATUS[mock.status].label}</span>
      </h3>
      {mock.history && (
        <dl className={css.facts}>
          <div>
            <dt>Score</dt>
            <dd className={css.num}>{mock.history.score ?? "–"}</dd>
          </div>
          <div>
            <dt>Outcome</dt>
            <dd>{mock.history.outcome || "–"}</dd>
          </div>
          <div>
            <dt>Head</dt>
            <dd>{mock.history.head || "–"}</dd>
          </div>
          <div>
            <dt>Date</dt>
            <dd>{mock.history.date || "–"}</dd>
          </div>
        </dl>
      )}
      {mock.history?.comment && <p className={css.inspectorText}>{mock.history.comment}</p>}
      {mock.error && <p className={css.errorText}>{mock.error}</p>}
      {totals && mock.rubric && (
        <>
          <table className={css.sheetTable}>
            <thead>
              <tr>
                <th>Part</th>
                <th>Score</th>
              </tr>
            </thead>
            <tbody>
              {RUBRIC.map(({ part, items }, index) => (
                <tr key={part}>
                  <td>
                    {part}
                    {items.map(([id, label]) => (
                      <span key={id} className={css.pillNote}>
                        {label}: {mock.rubric!.items[id] ?? <span className={css.warnWord}>Unreadable</span>}
                      </span>
                    ))}
                  </td>
                  <td className={css.num}>
                    {totals.parts[index].scored} / {totals.parts[index].max}
                  </td>
                </tr>
              ))}
              <tr>
                <td>Total</td>
                <td className={css.num}>{totals.total} / 100</td>
              </tr>
            </tbody>
          </table>
          {mock.rubric.comments && <p className={css.inspectorText}>{mock.rubric.comments}</p>}
          {mock.changedBy && <p className={css.inspectorMeta}>Changed by {mock.changedBy}</p>}
        </>
      )}
    </section>
  );
}

function AssessmentPanel({
  candidate,
  row,
  papers,
  mocks,
  data,
  onClose,
}: {
  candidate: HiringCandidate;
  row: AssessmentRow;
  papers: Paper[];
  mocks: Mock[];
  data: HiringData;
  onClose: () => void;
}) {
  const blockers = hireBlockers(papers, mocks);
  return (
    <aside className={`${css.inspector} ${css.seekPanel}`} aria-label={`Assessment of ${candidate.name}`}>
      <header className={css.inspectorHead}>
        <div>
          <h2 className={css.inspectorName}>{candidate.name}</h2>
          <p className={css.inspectorMeta}>
            {row.subject} · {row.at ? when(row.at) : row.dateText || "Date not known"}
          </p>
        </div>
        <button type="button" className={css.inlineLink} onClick={onClose}>
          Close
        </button>
      </header>
      <div className={css.inspectorBody}>
        {!papers.length && <p className={css.inspectorText}>No paper result yet.</p>}
        {papers.map((paper) => (
          <PaperSheetView key={paper.id} paper={paper} config={data.config} />
        ))}
        {!mocks.length && <p className={css.inspectorText}>No mock result yet.</p>}
        {mocks.map((mock) => (
          <MockView key={mock.id} mock={mock} />
        ))}
        {blockers.length > 0 && (
          <section className={css.inspectorSection}>
            <h3 className={css.inspectorHeading}>Before Hire</h3>
            <ul className={css.holdList}>
              {blockers.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          </section>
        )}
      </div>
    </aside>
  );
}

export function AssessmentScreen({ data, onOpenRecord, now }: { data: HiringData; onOpenRecord: (id: string) => void; now?: Date }) {
  const [mode, setMode] = useState<"list" | "calendar">("list");
  const [head, setHead] = useState("");
  const [range, setRange] = useState<AssessmentRange>("All dates");
  const [chip, setChip] = useState<AssessmentChip | null>(null);
  const [selected, setSelected] = useState<string | null>(null);

  const rows = useMemo(() => assessmentRows(data.bookings, data.papers, data.mocks, now), [data.bookings, data.papers, data.mocks, now]);
  const papers = useMemo(() => byCandidate(data.papers), [data.papers]);
  const mocks = useMemo(() => byCandidate(data.mocks), [data.mocks]);
  const names = useMemo(() => new Map(data.candidates.map((c) => [c.id, c])), [data.candidates]);
  const heads = useMemo(() => new Map(data.tutors.map((t) => [t.canonicalKey, t.name])), [data.tutors]);
  const decided = useMemo(() => new Set(data.decisions.filter((d) => d.status === "sent").map((d) => d.candidateId)), [data.decisions]);
  const chipMatch = (row: AssessmentRow, value: AssessmentChip | null) =>
    matchesChip(row, value, papers.get(row.candidateId) ?? [], mocks.get(row.candidateId) ?? [], decided.has(row.candidateId));
  const counts = ASSESSMENT_CHIPS.map((value) => rows.filter((row) => chipMatch(row, value)).length);
  const shown = rows.filter((row) => matchesRange(row, range, now) && (!head || row.headKey === head) && chipMatch(row, chip));
  const open = rows.find((row) => row.key === selected);
  const candidate = open && names.get(open.candidateId);

  return (
    <div className={css.layout}>
      <div className={css.main}>
        <section className={css.tableSection} aria-label="Mock and paper">
          <div className={css.tableTools}>
            <div className={css.tabs} role="group" aria-label="View">
              {(
                [
                  ["list", "List"],
                  ["calendar", "Calendar"],
                ] as const
              ).map(([value, label]) => (
                <button key={value} type="button" aria-pressed={mode === value} onClick={() => setMode(value)}>
                  {label}
                </button>
              ))}
            </div>
            {mode === "list" && (
              <>
                <label className={css.filterSelect}>
                  Head
                  <select value={head} onChange={(e) => setHead(e.target.value)}>
                    <option value="">All</option>
                    {data.config.interviewers.map((person) => (
                      <option key={person.canonicalKey} value={person.canonicalKey}>
                        {heads.get(person.canonicalKey) ?? person.canonicalKey}
                      </option>
                    ))}
                  </select>
                </label>
                <label className={css.filterSelect}>
                  Date
                  <select value={range} onChange={(e) => setRange(e.target.value as AssessmentRange)}>
                    {ASSESSMENT_RANGES.map((value) => (
                      <option key={value}>{value}</option>
                    ))}
                  </select>
                </label>
                <div className={`${css.tabs} ${css.tabsRow}`} role="group" aria-label="Filter visits">
                  {ASSESSMENT_CHIPS.map((value, index) => (
                    <button key={value} type="button" aria-pressed={chip === value} onClick={() => setChip(chip === value ? null : value)}>
                      {value} <span className={css.tabCount}>{counts[index]}</span>
                    </button>
                  ))}
                </div>
              </>
            )}
          </div>
          {mode === "calendar" ? (
            <HeadSchedules heads={data.configSaved ? data.config.interviewers : []} bookings={data.bookings} onOpenCandidate={onOpenRecord} />
          ) : (
            <div className={css.tableScroll}>
              <table className={css.table}>
                <thead>
                  <tr>
                    <th>Date</th>
                    <th>Candidate</th>
                    <th>Subject</th>
                    <th>Head</th>
                    <th>Paper</th>
                    <th>Mock</th>
                    <th>Decision</th>
                  </tr>
                </thead>
                <tbody>
                  {shown.map((row) => {
                    const c = names.get(row.candidateId);
                    const rowPapers = papers.get(row.candidateId) ?? [];
                    const rowMocks = mocks.get(row.candidateId) ?? [];
                    return (
                      <tr key={row.key} data-selected={selected === row.key ? "" : undefined} onClick={() => setSelected(row.key)}>
                        <td>
                          {row.at ? when(row.at) : row.dateText || "–"}
                          {row.mockAt && <span className={css.pillNote}>Mock {clock(row.mockAt)}</span>}
                          {row.status === "no_show" && <span className={css.clashWord}>No-show</span>}
                        </td>
                        <td className={css.candidateCell}>
                          <button
                            type="button"
                            className={css.nameButton}
                            onClick={(e) => {
                              e.stopPropagation();
                              setSelected(row.key);
                            }}
                          >
                            {c?.name ?? "Unknown candidate"}
                          </button>
                        </td>
                        <td>{row.subject}</td>
                        <td>{row.headKey ? (heads.get(row.headKey) ?? row.headKey) : "–"}</td>
                        <td className={css.preCell}>
                          {rowPapers.length ? rowPapers.map((paper) => <span key={paper.id} className={css.pillNote}>{paperCell(paper, data.config)}</span>) : <span className={css.mutedCell}>–</span>}
                        </td>
                        <td>{rowMocks.length ? rowMocks.map((mock) => <span key={mock.id} className={css.pillNote}>{mockCell(mock)}</span>) : <span className={css.mutedCell}>–</span>}</td>
                        <td>{decided.has(row.candidateId) ? data.decisions.find((d) => d.candidateId === row.candidateId && d.status === "sent")?.decision === "hire" ? "Hired" : "Rejected" : <span className={css.mutedCell}>–</span>}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              {!shown.length && <p className={css.empty}>{rows.length ? "No visits match these filters." : "No visits booked yet."}</p>}
            </div>
          )}
        </section>
      </div>
      {open && candidate && (
        <AssessmentPanel
          key={open.key}
          candidate={candidate}
          row={open}
          papers={papers.get(open.candidateId) ?? []}
          mocks={mocks.get(open.candidateId) ?? []}
          data={data}
          onClose={() => setSelected(null)}
        />
      )}
    </div>
  );
}
