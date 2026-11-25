"use client";

import { useMemo, useState } from "react";
import { formatInTimeZone } from "date-fns-tz";
import { AlertTriangle, Check, Clock, X } from "lucide-react";
import { arrivals, assessmentRows, bangkokDay, hireBlockers, LANES, laneOf, mockScore, paperScore, type AssessmentRow, type Lane, type PaperScore, type Verdict } from "@/lib/hiring/assessment-view";
import { FinalReview, reviewBlocks } from "./final-review";
import { RUBRIC, computeSheet, passRulesFor, rubricItems, rubricTotals, type LevelResult, type MockRubric, type RubricItem, type StressTicks } from "@/lib/hiring/marking-sheet";
import { STRESS_ELEMENTS } from "@/lib/hiring/rubric-guide";
import { isDecided, SUBJECTS, ZONE, type Subject } from "@/lib/hiring/model";
import { markAgain, runMarking, type ResultKind } from "./assessment-setup";
import type { Command, HiringCandidate, HiringData } from "./dashboard";
import { HeadSchedules } from "./head-schedules";
import css from "./dashboard.module.css";
import a from "./assessment.module.css";

type Paper = HiringData["papers"][number];
type Mock = HiringData["mocks"][number];
const when = (value: Date) => formatInTimeZone(value, ZONE, "EEE d MMM, HH:mm");
const clock = (value: Date) => formatInTimeZone(value, ZONE, "HH:mm");
const day = (value: Date) => formatInTimeZone(value, ZONE, "yyyy-MM-dd");
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
  not_passed: { label: "Below pass mark", tone: css.errorText },
  not_done: { label: "Not done", tone: css.mutedCell },
  pass_mark_missing: { label: "Pass mark missing", tone: css.warnWord },
};

const byCandidate = <T extends { candidateId: string }>(rows: T[]) => {
  const map = new Map<string, T[]>();
  for (const row of rows) map.set(row.candidateId, [...(map.get(row.candidateId) ?? []), row]);
  return map;
};

/** One line for a table cell: the result, or what is happening to it. */
type PaperCheck = HiringData["paperChecks"][number];
/** The check of this result: open, or done with the head's answer. */
export const checkOf = (paper: Pick<Paper, "id">, checks: HiringData["paperChecks"]) => checks.find((check) => check.resultId === paper.id);
const checkWords = (check: PaperCheck) => check.done
  ? `${check.done.head}'s check: ${check.done.percent}%, ${check.done.passed ? (check.done.override ? `pass by head override (${check.done.override})` : "pass") : "not passed"}`
  : `with ${check.headLabel ?? "a head"} for a check`;

export function mockCell(mock: Mock) {
  if (mock.history) return mock.history.score === null ? mock.history.outcome || "Recorded" : `${mock.history.score} / 100`;
  if (mock.status !== "done" || !mock.rubric) return STATUS[mock.status].label;
  const totals = rubricTotals(mock.rubric);
  return `${totals.total} / ${totals.max} · ${totals.percent}%`;
}
const LABELS = new Map<string, string>(RUBRIC.flatMap(({ items }) => items.map(([id, label]) => [id, label] as const)));
const isNewForm = (rubric: MockRubric) => rubricItems(rubric).length === LABELS.size;
const checksText = (rubric: MockRubric) => (rubric.checksDone === true ? "Yes" : rubric.checksDone === false ? "No" : "Not read");

type Reload = () => Promise<void>;

/** The file picker for a candidate's scan. It stays on the row or the panel while the upload and the marking run. */
/** The blank question paper from the paper library, for the person who prepares the visit. It opens as a PDF to print. */
export function PrintPaper({ library, subject, name }: { library: HiringData["library"]; subject: string; name?: string }) {
  const file = library.find((item) => item.subject === subject && item.kind === "question_paper");
  if (!file) return <span className={css.warnWord}>No paper to print. Add it in Rules and setup. </span>;
  return (
    <a className={css.sourceLink} href={`/api/hiring/file/${encodeURIComponent(file.id)}`} target="_blank" rel="noopener noreferrer" aria-label={name ? `Print the ${subject} paper for ${name}` : undefined} onClick={(e) => e.stopPropagation()}>
      Print paper
    </a>
  );
}

export function ResultUpload({ kind, candidateId, subject, reload, label, disabled, warning }: { kind: ResultKind; candidateId: string; subject: Subject; reload: Reload; label: string; disabled?: boolean; warning?: string }) {
  const [state, setState] = useState<"idle" | "working">("idle");
  const [error, setError] = useState("");
  async function choose(file: File | undefined) {
    if (!file || (warning && !window.confirm(warning))) return;
    setState("working");
    setError("");
    try {
      await runMarking(kind, candidateId, subject, file, reload);
    } catch (e) {
      setError(e instanceof Error ? e.message : "The upload failed.");
    } finally {
      setState("idle");
    }
  }
  if (state === "working") return <span role="status" className={css.warnWord}>Uploading and reading. This can take a few minutes.</span>;
  return (
    <span onClick={(e) => e.stopPropagation()}>
      <label className={css.uploadButton}>
        {label}
        <input
          className="sr-only"
          type="file"
          accept="application/pdf"
          disabled={disabled}
          aria-label={`${label} for ${kind === "paper" ? "the" : "the mock in"} ${subject}${kind === "paper" ? " paper" : ""}`}
          onChange={(e) => {
            void choose(e.target.files?.[0]);
            e.target.value = "";
          }}
        />
      </label>
      {error && <span role="alert" className={css.errorText}>{error}</span>}
    </span>
  );
}

function RetryMarking({ kind, id, reload }: { kind: ResultKind; id: string; reload: Reload }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  return (
    <>
      <button
        type="button"
        className={css.secondary}
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          setError("");
          try {
            await markAgain(kind, id, reload);
          } catch (e) {
            setError(e instanceof Error ? e.message : "Marking failed.");
          } finally {
            setBusy(false);
          }
        }}
      >
        {busy ? "Reading…" : "Run the AI again"}
      </button>
      {error && <p role="alert" className={css.errorText}>{error}</p>}
    </>
  );
}

/** For a scan stored under the wrong subject. The server moves the result, or removes it when the right subject already has one. */
export function ChangeSubject({ paper, taken, command, reload, busy }: { paper: Paper; taken: string[]; command: Command; reload: Reload; busy: boolean }) {
  const options = SUBJECTS.filter((subject) => subject !== paper.subject);
  const [subject, setSubject] = useState<Subject>(options[0]);
  const [error, setError] = useState("");
  const keep = taken.includes(subject);
  return (
    <details className={css.sourceText}>
      <summary>Wrong subject?</summary>
      <div className={css.decisionActions}>
        <label className={css.filterSelect}>
          Correct subject
          <select value={subject} onChange={(e) => setSubject(e.target.value as Subject)}>
            {options.map((value) => (
              <option key={value}>{value}</option>
            ))}
          </select>
        </label>
        <button
          type="button"
          className={css.secondary}
          disabled={busy}
          onClick={async () => {
            const warning = keep
              ? `${subject} already has a result. This removes the ${paper.subject} result and keeps the ${subject} one. Continue?`
              : `This moves the result to ${subject} and removes these marks. The AI then marks the scan again with the ${subject} paper. Continue?`;
            if (!window.confirm(warning)) return;
            setError("");
            if (!(await command({ action: "paper_subject", id: paper.id, updatedAt: new Date(paper.updatedAt).toISOString(), subject, expect: keep ? "remove" : "move" })) || keep) return;
            try {
              await markAgain("paper", paper.id, reload);
            } catch (e) {
              setError(e instanceof Error ? e.message : "Marking failed.");
            }
          }}
        >
          {keep ? `Remove this ${paper.subject} result` : `Change to ${subject}`}
        </button>
      </div>
      {error && <p role="alert" className={css.errorText}>{error}</p>}
    </details>
  );
}

function MarksEditor({ paper, command, busy, onDone }: { paper: Paper; command: Command; busy: boolean; onDone: () => void }) {
  const [marks, setMarks] = useState<Record<string, string>>(() => Object.fromEntries(paper.marks!.questions.map((q) => [q.id, q.marks === null ? "" : String(q.marks)])));
  const [comment, setComment] = useState(paper.marks!.comment);
  const values = Object.fromEntries(Object.entries(marks).map(([id, text]) => [id, text.trim() === "" ? null : Number(text)]));
  const valid = paper.marks!.questions.every((q) => values[q.id] === null || (values[q.id]! >= 0 && values[q.id]! <= q.max));
  return (
    <form
      onSubmit={async (e) => {
        e.preventDefault();
        // Only what this person changed, so another person's change to a different question stays.
        const changed = Object.fromEntries(paper.marks!.questions.filter((q) => values[q.id] !== q.marks).map((q) => [q.id, values[q.id]]));
        if (await command({ action: "paper_edit", id: paper.id, updatedAt: new Date(paper.updatedAt).toISOString(), marks: changed, comment })) onDone();
      }}
    >
      <table className={css.sheetTable}>
        <tbody>
          {paper.marks!.questions.map((q) => (
            <tr key={q.id}>
              <td>{q.id}</td>
              <td>
                <input
                  className={css.numberInput}
                  type="number"
                  min={0}
                  max={q.max}
                  step="any"
                  aria-label={`Marks for question ${q.id}`}
                  value={marks[q.id]}
                  onChange={(e) => setMarks({ ...marks, [q.id]: e.target.value })}
                />{" "}
                / {q.max}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <label className={css.fieldLabel}>
        Marker comment
        <textarea className={css.textarea} rows={3} value={comment} onChange={(e) => setComment(e.target.value)} />
      </label>
      <div className={css.decisionActions}>
        <button type="submit" className={css.primary} disabled={!valid || busy}>
          Save marks
        </button>
        <button type="button" className={css.secondary} onClick={onDone}>
          Cancel
        </button>
      </div>
    </form>
  );
}

export function PaperSheetView({ paper, taken = [], config, command, reload, busy, check }: { paper: Paper; taken?: string[]; config: HiringData["config"]; command: Command; reload: Reload; busy: boolean; check?: PaperCheck }) {
  const stuck = paper.stuck;
  const sheet = paper.marks ? computeSheet(paper.marks, passRulesFor(config, paper.subject)) : null;
  const score = sheet ? paperScore(paper, config, check) : null;
  // One pass mark for every level is already in the summary, so the column only shows when levels differ.
  const passMarks = new Set(sheet?.levels.filter((l) => l.result !== "not_done").map((l) => l.passPercent));
  const onePassMark = passMarks.size <= 1;
  // Scan tools sit under the result once there is one, so the result is the first thing a person reads.
  const fileTools = (
    <>
        {paper.source === "ai" && paper.status !== "marking" && (
          <p>
            <ResultUpload
              kind="paper"
              candidateId={paper.candidateId}
              subject={paper.subject}
              reload={reload}
              label="Replace scan"
              warning={paper.marks ? "The new scan replaces these marks, including any change a person made. Continue?" : undefined}
            />
          </p>
        )}
        {paper.source === "ai" && paper.status !== "marking" && paper.fileId && <ChangeSubject key={String(paper.updatedAt)} paper={paper} taken={taken} command={command} reload={reload} busy={busy} />}
    </>
  );
  const [editing, setEditing] = useState(false);
  return (
    <section className={css.inspectorSection} aria-label={`Paper marking sheet for ${paper.subject}`}>
      <h3 className={css.inspectorHeading}>
        Paper: {paper.subject}
        <span className={STATUS[paper.status].tone}>{paper.history ? "From the tracker" : paper.status === "done" ? null : STATUS[paper.status].label}</span>
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
      {stuck && <p className={css.warnWord}>This run stopped before it finished.</p>}
      {(paper.status === "failed" || paper.status === "uploaded" || stuck) && <RetryMarking kind="paper" id={paper.id} reload={reload} />}
      {!sheet && fileTools}
      {paper.status === "needs_check" && (
        <p className={css.inspectorNote}>
          The AI could not read part of this paper, and an unreadable answer counts as no marks. Read it beside the scan, change any marks, then confirm.{" "}
          <button type="button" className={css.inlineLink} disabled={busy} onClick={() => void command({ action: "result_check", kind: "paper", id: paper.id })}>
            I have checked this
          </button>
        </p>
      )}
      {paper.source === "ai" && paper.markSchemeUsed === false && (
        <p className={css.warnWord}>Marked without a mark scheme, from the AI&apos;s own subject knowledge.</p>
      )}
      {paper.marks?.missingPages && <p className={css.warnWord}>Missing pages: {paper.marks.missingPages}</p>}
      {sheet && paper.marks && score && (
        <>
          <div className={a.hero} data-score-hero="">
            <div className={a.heroLine}>
              <VerdictWord verdict={score.verdict} big />
              <span className={a.heroPct}>{score.percent}%</span>
              <span className={a.heroNote}>
                {[levelWords(score), score.level && `${round(score.scored)}/${round(score.max)} marks`, score.passMark !== null && `pass mark ${score.passMark}%`].filter(Boolean).join(" · ")}
              </span>
            </div>
            <Meter percent={score.percent ?? 0} passMark={score.passMark} tone={VERDICT[score.verdict].tone} wide />
          </div>
          {check && (
            <p className={check.done ? css.inspectorNote : css.warnWord} data-paper-check="">
              {check.done ? (
                <>{checkWords(check)}. {check.done.passed ? "The candidate goes on to mock teaching." : "The rejection email was queued."}</>
              ) : (
                <>
                  {check.headLabel ? `With ${nick(check.headLabel)}${check.line ? " in LINE" : ". No LINE group is set up, so send the link yourself"}` : "No head covers this subject"}. Mock stays booked.{" "}
                  {check.path && <a className={css.inlineLink} href={check.path} target="_blank" rel="noopener noreferrer">View re-check status</a>}
                </>
              )}
            </p>
          )}
          <table className={`${css.sheetTable} ${a.levelTable}`}>
            <thead>
              <tr>
                <th>Level</th>
                <th>Score</th>
                {!onePassMark && <th>Pass mark</th>}
                <th>Result</th>
              </tr>
            </thead>
            <tbody>
              {sheet.levels.filter((level) => level.result !== "not_done").map((level) => (
                <tr key={level.level} data-sets={level.level === score.level ? "" : undefined}>
                  <td>
                    {level.level}
                    {level.level === score.level && <span className={a.setsTag}>{score.verdict === "pass" ? "Highest level passed" : "Best score"}</span>}
                  </td>
                  <td>
                    <span className={a.levelScore}>
                      {level.max ? `${Math.round((level.scored / level.max) * 1000) / 10}% (${round(level.scored)}/${round(level.max)})` : "–"}
                      {level.max > 0 && level.result !== "not_done" && <Meter percent={(level.scored / level.max) * 100} passMark={level.passPercent} tone={level.result === "passed" ? "good" : level.result === "not_passed" ? "bad" : "warn"} />}
                    </span>
                  </td>
                  {!onePassMark && <td>{level.passPercent === null || level.result === "not_done" ? "" : `${level.passPercent}%`}</td>}
                  <td><span className={LEVEL[level.result].tone}>{LEVEL[level.result].label}</span></td>
                </tr>
              ))}
            </tbody>
          </table>
          {sheet.levels.some((level) => level.result === "not_done") && (
            <p className={css.inspectorMeta}>Not answered: {sheet.levels.filter((level) => level.result === "not_done").map((level) => level.level).join(", ")}</p>
          )}
          <dl className={css.facts}>

            {/* The hero names the level; a missing pass mark is the one thing it cannot say. */}
            {sheet.canTeachUpTo.includes("pass mark missing") && (
              <div>
                <dt>Can teach up to</dt>
                <dd>{sheet.canTeachUpTo}</dd>
              </div>
            )}
            {paper.changedBy && (
              <div>
                <dt>Changed by</dt>
                <dd>{paper.changedBy}</dd>
              </div>
            )}
          </dl>
          <p className={css.inspectorText}>{paper.marks.comment}</p>
          {fileTools}
          {editing ? (
            <MarksEditor key={String(paper.updatedAt)} paper={paper} command={command} busy={busy} onDone={() => setEditing(false)} />
          ) : (
            <button type="button" className={css.inlineLink} onClick={() => setEditing(true)}>
              Change marks
            </button>
          )}
          <h4 className={css.inspectorHeading}>{paper.markSchemeUsed ? "Marking against the mark scheme" : "Marking, question by question"}</h4>
          {!paper.marks.questions.some((q) => q.points?.length) && (
            <p className={css.inspectorNote}>This paper was marked before the point-by-point marking. Use Replace scan with the same file to mark it again and see each mark scheme point.</p>
          )}
          <table className={css.sheetTable}>
            <thead>
              <tr>
                <th>Question</th>
                <th>Marks</th>
                <th>What the marks were given for</th>
              </tr>
            </thead>
            <tbody>
              {paper.marks.questions.map((q) => (
                <tr key={q.id}>
                  <td>
                    {q.id}
                    <span className={css.pillNote}>{q.level}</span>
                    {q.page ? <span className={css.pillNote}>Scan page {q.page}</span> : null}
                  </td>
                  <td className={css.num}>{q.marks === null ? <span className={css.warnWord}>Unreadable</span> : `${q.marks} / ${q.max}`}</td>
                  <td>
                    {q.points?.length ? (
                      <ul className={css.pointList}>
                        {q.points.slice(0, 40).map((point, index) => (
                          <li key={index} className={point.awarded > 0 ? css.pointGiven : css.pointMissed}>
                            <span className={css.num}>{point.awarded > 0 ? `+${point.awarded}` : "0"}</span> {point.point}
                          </li>
                        ))}
                      </ul>
                    ) : null}
                    {q.attempted ? q.reason : "Not tried"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {paper.fileId && (
            <details className={css.sourceText} open>
              <summary>The marked paper: the scan with the marking beside each page</summary>
              <div className={css.scanSplit}>
                <p className={css.inspectorMeta}>
                  <a className={css.sourceLink} href={`/api/hiring/marked/${encodeURIComponent(paper.id)}`} target="_blank" rel="noopener noreferrer">
                    Open the marked paper to print
                  </a>
                  {" · "}
                  <a className={css.sourceLink} href={`/api/hiring/file/${encodeURIComponent(paper.fileId)}`} target="_blank" rel="noopener noreferrer">
                    Open the scan with no marking
                  </a>
                </p>
                <p className={css.inspectorMeta}>A link in a file can open another site. Do not sign in on a page that opens from a file.</p>
                {/* The key makes the frame load again after a mark changes. */}
                <iframe key={String(paper.updatedAt)} loading="lazy" className={css.resumeFrame} src={`/api/hiring/marked/${encodeURIComponent(paper.id)}`} title={`Marked scan of the ${paper.subject} paper`} />
              </div>
            </details>
          )}
        </>
      )}
    </section>
  );
}

function RubricEditor({ mock, command, busy, onDone }: { mock: Mock; command: Command; busy: boolean; onDone: () => void }) {
  const [items, setItems] = useState<Record<string, string>>(() => Object.fromEntries(Object.entries(mock.rubric!.items).map(([id, value]) => [id, value === null ? "" : String(value)])));
  const [comments, setComments] = useState(mock.rubric!.comments);
  const newForm = isNewForm(mock.rubric!);
  const [ticks, setTicks] = useState<StressTicks>(mock.rubric!.stressTest ?? { listens: false, explains: false, plan: false });
  const [checks, setChecks] = useState(mock.rubric!.checksDone ?? null);
  const values = Object.fromEntries(Object.entries(items).map(([id, text]) => [id, text.trim() === "" ? null : Number(text)]));
  const valid = Object.values(values).every((value) => value === null || (Number.isInteger(value) && value >= 1 && value <= 10));
  return (
    <form
      onSubmit={async (e) => {
        e.preventDefault();
        const changed = Object.fromEntries(Object.entries(values).filter(([id, value]) => value !== mock.rubric!.items[id as RubricItem]));
        const saved = mock.rubric!;
        const ticksChanged = (Object.keys(ticks) as (keyof StressTicks)[]).some((key) => ticks[key] !== !!saved.stressTest?.[key]);
        const extra = newForm ? { ...(ticksChanged ? { stressTest: ticks } : {}), ...(checks === null || checks === saved.checksDone ? {} : { checksDone: checks }) } : {};
        if (await command({ action: "mock_edit", id: mock.id, updatedAt: new Date(mock.updatedAt).toISOString(), items: changed, comments, ...extra })) onDone();
      }}
    >
      <table className={css.sheetTable}>
        <tbody>
          {rubricItems(mock.rubric!).map((id) => [id, LABELS.get(id)!] as const).map(([id, label]) => (
            <tr key={id}>
              <td>{label}</td>
              <td>
                <input
                  className={css.numberInput}
                  type="number"
                  min={1}
                  max={10}
                  aria-label={`Score for ${label}`}
                  value={items[id]}
                  onChange={(e) => setItems({ ...items, [id]: e.target.value })}
                />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {newForm && (
        <fieldset className={css.fieldLabel}>
          <legend>Stress Test ticks</legend>
          {STRESS_ELEMENTS.map(({ key, label }) => (
            <label key={key}>
              <input type="checkbox" checked={ticks[key]} onChange={(e) => setTicks({ ...ticks, [key]: e.target.checked })} /> {label}
            </label>
          ))}
        </fieldset>
      )}
      {newForm && (
        <label className={css.fieldLabel}>
          School&apos;s required checks completed
          <select className={css.textarea} value={checks === null ? "" : String(checks)} onChange={(e) => setChecks(e.target.value === "" ? null : e.target.value === "true")}>
            <option value="" disabled>Not read</option>
            <option value="true">Yes</option>
            <option value="false">No</option>
          </select>
        </label>
      )}
      <label className={css.fieldLabel}>
        Other comments
        <textarea className={css.textarea} rows={3} value={comments} onChange={(e) => setComments(e.target.value)} />
      </label>
      <div className={css.decisionActions}>
        <button type="submit" className={css.primary} disabled={!valid || busy}>
          Save scores
        </button>
        <button type="button" className={css.secondary} onClick={onDone}>
          Cancel
        </button>
      </div>
    </form>
  );
}

export function MockView({ mock, command, reload, busy }: { mock: Mock; command: Command; reload: Reload; busy: boolean }) {
  const totals = mock.rubric ? rubricTotals(mock.rubric) : null;
  const [editing, setEditing] = useState(false);
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
      {mock.stuck && <p className={css.warnWord}>This run stopped before it finished.</p>}
      {(mock.status === "failed" || mock.status === "uploaded" || mock.stuck) && <RetryMarking kind="mock" id={mock.id} reload={reload} />}
      {mock.source === "ai" && mock.status !== "marking" && (
        <p>
          <ResultUpload
            kind="mock"
            candidateId={mock.candidateId}
            subject={mock.subject}
            reload={reload}
            label="Replace rubric"
            warning={mock.rubric ? "The new file replaces these scores, including any change a person made. Continue?" : undefined}
          />
        </p>
      )}
      {mock.status === "needs_check" && (
        <p className={css.inspectorNote}>
          The AI could not read a score on this form, and a blank score counts as no points. Read it beside the form, change any score, then confirm.{" "}
          <button type="button" className={css.inlineLink} disabled={busy} onClick={() => void command({ action: "result_check", kind: "mock", id: mock.id })}>
            I have checked this
          </button>
        </p>
      )}
      {totals && mock.rubric && (
        <>
          <div className={a.hero} data-score-hero="">
            <div className={a.heroLine}>
              <span className={a.heroPct}>{totals.total}<small className={a.heroNote}> / {totals.max}</small></span>
              <span className={a.heroNote}>{mock.status === "needs_check" ? "Blank scores count as 0 until checked" : "Mock teaching score"}</span>
            </div>
            <Meter percent={totals.percent} passMark={null} tone="ink" wide />
          </div>
          <table className={css.sheetTable}>
            <thead>
              <tr>
                <th>Part</th>
                <th>Score</th>
              </tr>
            </thead>
            <tbody>
              {totals.parts.map(({ part, scored, max }) => (
                <tr key={part}>
                  <td>
                    {part}
                    {RUBRIC.find((row) => row.part === part)!.items.map(([id, label]) => (
                      <span key={id} className={css.pillNote}>
                        {label}: {mock.rubric!.items[id] ?? <span className={css.warnWord}>Unreadable</span>}
                      </span>
                    ))}
                  </td>
                  <td className={css.num}>
                    {scored} / {max}
                  </td>
                </tr>
              ))}
              <tr>
                <td>Total</td>
                <td className={css.num}>{totals.total} / {totals.max} · {totals.percent}%</td>
              </tr>
              {isNewForm(mock.rubric) && (
                <tr>
                  <td>
                    School&apos;s required checks (not scored, needed to hire)
                    <span className={css.pillNote}>
                      Stress Test ticks: {STRESS_ELEMENTS.filter(({ key }) => mock.rubric!.stressTest?.[key]).map(({ label }) => label.slice(0, 1)).join(", ") || "none"}
                    </span>
                  </td>
                  <td className={mock.rubric.checksDone === true ? css.num : css.warnWord}>{checksText(mock.rubric)}</td>
                </tr>
              )}
            </tbody>
          </table>
          {mock.rubric.comments && <p className={css.inspectorText}>{mock.rubric.comments}</p>}
          {mock.changedBy && <p className={css.inspectorMeta}>Changed by {mock.changedBy}</p>}
          {editing ? (
            <RubricEditor key={String(mock.updatedAt)} mock={mock} command={command} busy={busy} onDone={() => setEditing(false)} />
          ) : (
            <button type="button" className={css.inlineLink} onClick={() => setEditing(true)}>
              Change scores
            </button>
          )}
          {mock.fileId && (
            <details className={css.sourceText}>
              <summary>The uploaded form</summary>
              <p className={css.inspectorMeta}>A link in a file can open another site. Do not sign in on a page that opens from a file.</p>
              <iframe className={css.resumeFrame} src={`/api/hiring/file/${encodeURIComponent(mock.fileId)}`} title="Scan of the mock rubric" />
            </details>
          )}
        </>
      )}
    </section>
  );
}

type DecisionRow = HiringData["decisions"][number];

/** A result email's state from the outbox, as on the Pre-screen screen: stage alone is not proof that it left. */
export function resultEmailState(key: string | null, outbox: HiringData["inviteOutbox"]) {
  const row = outbox.find((job) => job.key === key);
  if (!row) return { label: "Not found", tone: css.warnWord, error: null };
  if (row.status === "sent") return { label: row.sentAt ? `Sent ${when(new Date(row.sentAt))}` : "Sent", tone: css.goodWord, error: null };
  if (row.status === "failed") return { label: "Failed, will retry", tone: css.errorText, error: row.error };
  if (row.status === "uncertain") return { label: "May have sent. Check first", tone: css.errorText, error: row.error };
  if (row.status === "cancelled") return { label: "Cancelled", tone: css.mutedCell, error: null };
  return { label: "Queued", tone: css.warnWord, error: null };
}

function DecisionBox({ candidate, data, command, busy }: { candidate: HiringCandidate; data: HiringData; command: Command; busy: boolean }) {
  const mine = data.decisions.filter((row) => row.candidateId === candidate.id);
  const draft = mine.find((row) => row.status === "draft");
  const sent = mine.find((row) => row.status === "sent");
  const recommendation = data.headDecisions.find((row) => row.candidateId === candidate.id);
  const hasReview = recommendation?.decision === "hire";
  const [reason, setReason] = useState("");
  const blocked = !candidate.email;
  const email = sent ? resultEmailState(sent.outboxKey, data.inviteOutbox) : null;
  // A result that left or is on its way cannot be sent again. A failed one can.
  return (
    <section className={css.inspectorSection} aria-label="Decision">
      <h3 className={css.inspectorHeading}>Decision</h3>
      {sent && email && (
        <dl className={css.facts}>
          <div>
            <dt>{sent.decision === "hire" ? "Offer approved" : "Rejected"}</dt>
            <dd>{sent.decidedBy}</dd>
          </div>
          <div>
            <dt>Result email</dt>
            <dd className={email.tone}>{email.label}</dd>
          </div>
        </dl>
      )}
      {email?.error && <p className={css.errorText}>{email.error}</p>}
      {hasReview ? (data.reviewAccess?.hr || data.reviewAccess?.gift ? <FinalReview key={candidate.id} id={candidate.id}
        {...reviewBlocks(data.writeGate, data.config, candidate.id)} /> : !sent && <p>Waiting for the final review.</p>) : draft?.decision === "reject" && !sent ? (
        <DraftEditor key={draft.id} draft={draft} to={candidate.email} data={data} command={command} busy={busy} />
      ) : !sent && (
        <>
          {blocked && <p className={css.warnWord}>This candidate has no email address, so a result email cannot go. Use Stop in the full record.</p>}
          <label className={css.fieldLabel}>
            Reason
            <textarea className={css.textarea} rows={2} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Needed to reject. The candidate does not see it." />
          </label>
          <div className={css.decisionActions}>
            <button type="button" className={css.secondary} disabled={busy || blocked || reason.trim().length < 5} onClick={() => void command({ action: "decision_draft", id: candidate.id, decision: "reject", reason })}>
              Reject: preview email
            </button>
          </div>
        </>
      )}
    </section>
  );
}

function DraftEditor({ draft, to, data, command, busy }: { draft: DecisionRow; to: string | null; data: HiringData; command: Command; busy: boolean }) {
  const [subject, setSubject] = useState(draft.emailSubject);
  const [body, setBody] = useState(draft.emailBody);
  const off = !data.config.enabled || !data.config.deliveryEnabled;
  return (
    <>
      <p className={css.inspectorText}>
        {draft.decision === "hire" ? "Hire" : "Reject"}: read and edit the email. It goes only when you click Send, to this one candidate.
      </p>
      {off && <p className={css.warnWord}>Automation and Messages are off, so this cannot leave yet. Save your edits, and send later.</p>}
      <dl className={css.facts}>
        <div>
          <dt>To</dt>
          <dd>{to}</dd>
        </div>
      </dl>
      <label className={css.fieldLabel}>
        Email subject
        <input className={css.input} maxLength={200} value={subject} onChange={(e) => setSubject(e.target.value)} />
      </label>
      <label className={css.fieldLabel}>
        Email message
        <textarea className={css.textarea} rows={8} maxLength={10000} value={body} onChange={(e) => setBody(e.target.value)} />
      </label>
      <div className={css.decisionActions}>
        <button
          type="button"
          className={css.primary}
          disabled={busy || off || !subject.trim() || !body.trim()}
          onClick={() => void command({ action: "decision_send", id: draft.id, emailSubject: subject, emailBody: body })}
        >
          Send email
        </button>
        <button
          type="button"
          className={css.secondary}
          disabled={busy || !subject.trim() || !body.trim()}
          onClick={() => void command({ action: "decision_save", id: draft.id, emailSubject: subject, emailBody: body })}
        >
          Save draft
        </button>
        <button type="button" className={css.secondary} disabled={busy} onClick={() => void command({ action: "decision_discard", id: draft.id })}>
          Discard
        </button>
      </div>
    </>
  );
}

function AddPaper({ candidateId, first, taken, reload }: { candidateId: string; first: string; taken: string[]; reload: Reload }) {
  const open = SUBJECTS.filter((subject) => !taken.includes(subject));
  const [choice, setChoice] = useState(first as Subject);
  if (!open.length) return null;
  // After an upload the choice can be taken, and it must never reach the upload that way.
  const subject = open.includes(choice) ? choice : open[0];
  return (
    <section className={css.inspectorSection}>
      <h3 className={css.inspectorHeading}>Add a paper</h3>
      <div className={css.decisionActions}>
        <label className={css.filterSelect}>
          Subject
          <select value={subject} onChange={(e) => setChoice(e.target.value as Subject)}>
            {open.map((value) => (
              <option key={value}>{value}</option>
            ))}
          </select>
        </label>
        <ResultUpload kind="paper" candidateId={candidateId} subject={subject} reload={reload} label="Upload scanned PDF" />
      </div>
    </section>
  );
}

function AssessmentPanel({
  candidate,
  row,
  papers,
  mocks,
  data,
  command,
  reload,
  busy,
  onClose,
}: {
  candidate: HiringCandidate;
  row: AssessmentRow;
  papers: Paper[];
  mocks: Mock[];
  data: HiringData;
  command: Command;
  reload: Reload;
  busy: boolean;
  onClose: () => void;
}) {
  return (
    <aside className={`${css.inspector} ${css.seekPanel} ${a.panel}`} aria-label={`Assessment of ${candidate.name}`}>
      <header className={css.inspectorHead}>
        <div>
          <h2 className={css.inspectorName}>{candidate.name}</h2>
          <p className={css.inspectorMeta}>
            {row.at ? `Paper test ${when(row.at)}` : row.dateText || "Date not known"}{row.mockAt ? ` · Mock ${when(row.mockAt)}` : ""}
          </p>
        </div>
        <button type="button" className={css.inlineLink} onClick={onClose}>
          Close
        </button>
      </header>
      <div className={css.inspectorBody}>
        {!papers.length && <p className={css.inspectorText}>No paper result yet.</p>}
        {papers.map((paper) => (
          <PaperSheetView key={paper.id} paper={paper} taken={papers.filter((other) => other.id !== paper.id && other.source !== "tracker").map((other) => other.subject)} config={data.config} command={command} reload={reload} busy={busy} check={checkOf(paper, data.paperChecks)} />
        ))}
        {candidate.stage === "onsite_booked" && papers.some((paper) =>
          paper.subject === row.subject && paper.status === "done" && paper.fileId && paper.marks &&
          // A head's override passes a near miss too (Kevin, 25 Nov 2026).
          paperScore(paper, data.config, checkOf(paper, data.paperChecks)).verdict === "pass"
        ) && !data.bookings.some((booking) => booking.candidateId === candidate.id && booking.kind === "mock" && booking.status === "confirmed") && (
          <button type="button" className={css.primary} disabled={busy} onClick={() => {
            if (window.confirm("Confirm the paper pass and invite this candidate to mock teaching?"))
              void command({ action: "paper_pass", id: candidate.id, revision: candidate.revision, subjects: [row.subject as Subject], reason: "Confirmed graded paper pass." });
          }}>Confirm pass and invite to mock teaching</button>
        )}
        {!row.history && <AddPaper candidateId={candidate.id} first={row.subject} taken={papers.filter((paper) => paper.source !== "tracker").map((paper) => paper.subject)} reload={reload} />}
        {!mocks.some((mock) => mock.subject === row.subject && mock.source !== "tracker") && !row.history && (
          <section className={css.inspectorSection}>
            <h3 className={css.inspectorHeading}>Mock: {row.subject}</h3>
            <p className={css.inspectorText}>No mock result yet.</p>
            {row.subject && <ResultUpload kind="mock" candidateId={candidate.id} subject={row.subject as Subject} reload={reload} label="Upload rubric" />}
          </section>
        )}
        {mocks.map((mock) => (
          <MockView key={mock.id} mock={mock} command={command} reload={reload} busy={busy} />
        ))}
        {!row.history && <DecisionBox candidate={candidate} data={data} command={command} busy={busy} />}
      </div>
    </aside>
  );
}

const VERDICT: Record<Verdict, { label: string; tone: "good" | "bad" | "warn" | "quiet" }> = {
  pass: { label: "Pass", tone: "good" },
  fail: { label: "Not passed", tone: "bad" },
  checking: { label: "Head checking", tone: "warn" },
  needs_check: { label: "Needs check", tone: "warn" },
  marking: { label: "AI marking", tone: "quiet" },
  failed: { label: "Marking failed", tone: "bad" },
  missing_mark: { label: "No pass mark", tone: "warn" },
  recorded: { label: "Tracker", tone: "quiet" },
};
const ICON = { good: Check, bad: X, warn: AlertTriangle, quiet: Clock };
/** "Wanwisa (Gift) Montrikittiphant" reads as "Gift" where space is short; the full name stays in the title. */
const nick = (name: string) => /\(([^)]+)\)/.exec(name)?.[1] ?? name;

export function Meter({ percent, passMark, tone, wide }: { percent: number; passMark: number | null; tone: string; wide?: boolean }) {
  return (
    <span className={`${a.meter} ${wide ? a.meterWide : ""}`} data-tone={tone} role="img" aria-label={`${percent}%${passMark === null ? "" : ` against a pass mark of ${passMark}%`}`}>
      <span style={{ width: `${Math.min(100, percent)}%` }} />
      {passMark !== null && <i style={{ left: `${passMark}%` }} />}
    </span>
  );
}

function VerdictWord({ verdict, big }: { verdict: Verdict; big?: boolean }) {
  const { label, tone } = VERDICT[verdict];
  const Icon = ICON[tone];
  return (
    <span className={`${a.verdict} ${big ? a.verdictBig : ""}`} data-tone={tone}>
      <Icon aria-hidden size={big ? 16 : 13} strokeWidth={2.5} />
      {label}
    </span>
  );
}

/** "Passed IGCSE / GCSE" for a pass; otherwise the best try, which is the level a head checks. */
const levelWords = (score: PaperScore) => (score.level ? (score.verdict === "pass" ? `Can teach up to ${score.level}` : score.level) : null);

/** A paper result in one line: the verdict, the score against the pass mark, and the level it is for. */
export function PaperBadge({ score, subject, labelled }: { score: PaperScore; subject?: string; labelled?: boolean }) {
  const tone = VERDICT[score.verdict].tone;
  return (
    <span className={a.badge}>
      <span className={a.badgeTop}>
        <VerdictWord verdict={score.verdict} />
        {score.percent !== null && (
          <>
            <b className={a.pct}>{score.percent}%</b>
            <Meter percent={score.percent} passMark={score.passMark} tone={tone} />
          </>
        )}
      </span>
      <span className={a.badgeNote}>
        {[labelled ? "Paper" : null, subject, levelWords(score), score.passMark !== null ? `pass\u00a0mark\u00a0${score.passMark}%` : null, score.head ? `${score.verdict === "checking" ? "with" : "by"} ${nick(score.head)}` : null, score.note].filter(Boolean).join(" · ")}
      </span>
    </span>
  );
}

function MockBadge({ mock }: { mock: Mock }) {
  if (mock.history) return <span className={a.badge}><VerdictWord verdict="recorded" /><span className={a.badgeNote}>Mock {mockCell(mock)}</span></span>;
  if (mock.status !== "done" || !mock.rubric) {
    const verdict: Verdict = mock.status === "needs_check" ? "needs_check" : mock.status === "failed" ? "failed" : "marking";
    return <span className={a.badge}><VerdictWord verdict={verdict} /><span className={a.badgeNote}>Mock rubric</span></span>;
  }
  const score = mockScore(mock.rubric);
  return (
    <span className={a.badge}>
      <span className={a.badgeTop}>
        <span className={a.verdict} data-tone="quiet">Mock rubric</span>
        <b className={a.pct}>{score.total}<small> / {score.max}</small></b>
      </span>
    </span>
  );
}

const LANE_TITLE: Record<Exclude<Lane, "upcoming" | "finished">, string> = {
  late_scan: "Overdue scans · mock time passed",
  scan: "Overdue scans · mock still ahead",
  check: "Marks to check",
  rubric: "Overdue mock rubrics",
  decide: "Ready to decide",
  waiting: "Waiting on others",
};

export function AssessmentScreen({
  data,
  selectedVisit,
  onSelectVisit,
  onOpenRecord,
  command,
  reload,
  busy,
  now: fixedNow,
}: {
  data: HiringData;
  selectedVisit: string | null;
  onSelectVisit: (id: string | null) => void;
  onOpenRecord: (id: string) => void;
  command: Command;
  reload: Reload;
  busy: boolean;
  now?: Date;
}) {
  const [mode, setMode] = useState<"list" | "calendar">("list");
  const [head, setHead] = useState("");
  const now = fixedNow ?? new Date();

  const rows = useMemo(() => assessmentRows(data.bookings, data.papers, data.mocks, fixedNow), [data.bookings, data.papers, data.mocks, fixedNow]);
  const papers = useMemo(() => byCandidate(data.papers), [data.papers]);
  const mocks = useMemo(() => byCandidate(data.mocks), [data.mocks]);
  const names = useMemo(() => new Map(data.candidates.map((c) => [c.id, c])), [data.candidates]);
  const heads = useMemo(() => new Map(data.tutors.map((t) => [t.canonicalKey, t.name])), [data.tutors]);
  // A sent decision, or a closed record (stopped, hired, rejected), is not work any more.
  const decided = useMemo(() => new Set([...data.decisions.filter((d) => d.status === "sent").map((d) => d.candidateId), ...data.candidates.filter((c) => c.stage === "stopped" || isDecided(c.stage)).map((c) => c.id)]), [data.decisions, data.candidates]);
  const headName = (key: string | null) => (key ? (heads.get(key) ?? key) : null);

  // A row with a visit shows that visit's results. A past tracker result is in the panel.
  const rowPapers = (row: AssessmentRow) => (papers.get(row.candidateId) ?? []).filter((paper) => row.history || paper.source !== "tracker");
  // A person can hold a mock in another subject. A history row has no subject of its own to match.
  const rowMocks = (row: AssessmentRow) => (mocks.get(row.candidateId) ?? []).filter((mock) => row.history || (mock.subject === row.subject && mock.source !== "tracker"));
  const scored = rows
    .filter((row) => !head || row.headKey === head)
    .map((row) => {
      const ps = rowPapers(row).map((paper) => ({ paper, score: paperScore(paper, data.config, checkOf(paper, data.paperChecks)) }));
      const lane = laneOf(row, papers.get(row.candidateId) ?? [], mocks.get(row.candidateId) ?? [], ps.map((p) => p.score.verdict), decided.has(row.candidateId), now);
      return { row, ps, ms: rowMocks(row), lane };
    });
  const lanes = LANES.filter((lane): lane is Exclude<Lane, "upcoming" | "finished"> => lane !== "upcoming" && lane !== "finished")
    .map((lane) => ({
      lane,
      items: scored.filter((item) => item.lane === lane)
        // Oldest first: the longest wait is the most urgent. Waiting rows go by the next mock.
        // Scans: the next mock is the real deadline (the head needs the result), so the soonest mock goes first.
        .sort((x, y) => lane === "scan" || lane === "late_scan" ? (x.row.mockAt?.getTime() ?? x.row.at?.getTime() ?? 0) - (y.row.mockAt?.getTime() ?? y.row.at?.getTime() ?? 0) : lane === "waiting" ? (x.row.mockAt?.getTime() ?? Infinity) - (y.row.mockAt?.getTime() ?? Infinity) : (x.row.at?.getTime() ?? 0) - (y.row.at?.getTime() ?? 0)),
    }))
    .filter(({ items }) => items.length);
  const finished = scored.filter((item) => item.lane === "finished");
  // Booked beyond the week strip: still reachable, folded away.
  const horizon = bangkokDay(now).getTime() + 7 * 86400000;
  const later = scored.filter((item) => item.lane === "upcoming" && (item.row.at?.getTime() ?? 0) >= horizon).sort((x, y) => (x.row.at?.getTime() ?? 0) - (y.row.at?.getTime() ?? 0));
  const coming = arrivals(data.bookings, now).filter((b) => b.status !== "no_show" && (!head || b.head === head));
  const next = coming.find((b) => b.at > now);
  const week = Array.from({ length: 7 }, (_, i) => new Date(bangkokDay(now).getTime() + i * 86400000));
  const perDay = week.map((d) => ({ d, items: coming.filter((b) => day(b.at) === day(d)) }));
  const peak = Math.max(1, ...perDay.map(({ items }) => items.length));
  const open = rows.find((row) => row.key === selectedVisit);
  const candidate = open && names.get(open.candidateId);

  const action = ({ row, lane, ps }: (typeof scored)[number]) => {
    const subject = row.subject as Subject;
    if (lane === "scan" || lane === "late_scan") return <span className={lane === "late_scan" ? a.urgent : undefined}><ResultUpload kind="paper" candidateId={row.candidateId} subject={subject} reload={reload} label="Upload paper scan" /></span>;
    if (lane === "rubric") return <ResultUpload kind="mock" candidateId={row.candidateId} subject={subject} reload={reload} label="Upload rubric" />;
    if (lane === "check") return <button type="button" className={a.act} onClick={() => onSelectVisit(row.key)}>Check marks</button>;
    if (lane === "decide") return <button type="button" className={a.act} onClick={() => onSelectVisit(row.key)}>{ps.some((p) => p.score.verdict === "fail") && !ps.some((p) => p.score.verdict === "pass") ? "Make decision" : "Review for hire"}</button>;
    if (lane === "finished") {
      const sent = data.decisions.find((d) => d.candidateId === row.candidateId && d.status === "sent");
      const draft = data.decisions.find((d) => d.candidateId === row.candidateId && d.status === "draft");
      return <span className={a.quiet}>{sent ? (sent.decision === "hire" ? "Hired" : "Rejected") : row.status === "no_show" ? "No-show" : row.status === "cancelled" ? "Visit cancelled" : draft ? `Draft: ${draft.decision === "hire" ? "Hire" : "Reject"}` : "–"}</span>;
    }
    const checking = ps.find((p) => p.score.verdict === "checking");
    if (checking) return <span className={a.quiet}>Waiting for {nick(checking.score.head ?? "a head")}{row.mockAt && row.mockAt > now ? " · mock stays booked" : ""}</span>;
    if (ps.some((p) => p.score.verdict === "marking")) return null;
    if (row.mockAt && row.mockAt > now) return <span className={a.quiet}>Mock {when(row.mockAt)}</span>;
    // After the mock, say what still stops the decision (for example the school's required checks).
    const blocker = hireBlockers(papers.get(row.candidateId) ?? [], mocks.get(row.candidateId) ?? [])[0];
    return <span className={a.quiet}>{blocker ?? (row.mockAt ? "Nothing left to do" : "No mock booked")}</span>;
  };

  const item = (entry: (typeof scored)[number]) => {
    const { row, ps, ms, lane } = entry;
    const c = names.get(row.candidateId);
    const h = headName(row.headKey);
    return (
      <li key={row.key} className={a.row} data-lane={lane === "late_scan" ? "scan" : lane} data-selected={selectedVisit === row.key ? "" : undefined}>
        <span className={a.who}>
          <button type="button" className={a.name} onClick={() => onSelectVisit(row.key)}>{c?.name ?? "Unknown candidate"}</button>
          <span className={a.sub} title={h ?? undefined}>{[row.subject, h && nick(h)].filter(Boolean).join(" · ")}</span>
        </span>
        <span className={a.when}>
          {row.at ? `Test ${when(row.at)}` : row.dateText || "–"}
          {row.mockAt && (
            <span className={lane === "late_scan" ? a.late : a.sub}>
              Mock {when(row.mockAt)}
            </span>
          )}
        </span>
        {lane !== "scan" && lane !== "late_scan" && <span className={a.results}>
          {ps.map(({ paper, score }) => <PaperBadge key={paper.id} score={score} subject={paper.subject === row.subject ? undefined : paper.subject} labelled={ms.length > 0} />)}
          {ms.map((mock) => <MockBadge key={mock.id} mock={mock} />)}
          {!ps.length && !ms.length && <span className={a.quiet}>No results yet</span>}
        </span>}
        <span className={a.action}>{action(entry)}</span>
      </li>
    );
  };

  // An arrival row's quiet note when the paper is not simply passed: staff see why the mock may not go ahead.
  const paperNote = new Map(scored.flatMap(({ row, ps }) => {
    const v = ps.find((p) => ["checking", "fail", "needs_check"].includes(p.score.verdict))?.score;
    if (!v) return [];
    const score = [v.percent !== null && `${v.percent}%${v.level ? ` at ${v.level}` : ""}`, v.passMark !== null && `pass mark ${v.passMark}%`].filter(Boolean).join(" · ");
    const words = v.verdict === "checking" ? <>Head checking · {score}<br />Mock stays booked</> : v.verdict === "fail" ? `Paper not passed · ${score}` : "Paper needs a check";
    return [[row.candidateId, <span key="n" className={v.verdict === "fail" ? a.late : a.warnNote}>{words}</span>] as const];
  }));
  const checkLink = (candidateId: string) => {
    const path = data.paperChecks.find((c) => c.candidateId === candidateId && !c.done)?.path;
    return path ? <a className={css.sourceLink} href={path} target="_blank" rel="noopener noreferrer">View re-check status</a> : null;
  };
  const needsScan = new Set(scored.filter(({ lane }) => lane === "scan" || lane === "late_scan").map(({ row }) => row.candidateId));
  const weekStrip = (
    <div className={a.weekWrap}>
                  <div className={a.week} role="group" aria-label="Visits in the next 7 days">
                    {perDay.map(({ d, items }, i) => {
                      const tests = items.filter((b) => b.kind === "paper").length;
                      return (
                        <button key={day(d)} type="button" className={a.dayCol} data-today={i === 0 ? "" : undefined} disabled={!items.length}
                          aria-label={`${i === 0 ? "Today, " : ""}${formatInTimeZone(d, ZONE, "EEEE d MMMM")}: ${tests} paper tests, ${items.length - tests} mocks`}
                          onClick={() => document.getElementById(`day-${day(d)}`)?.scrollIntoView({ behavior: "smooth", block: "start" })}>
                          <span className={a.dayName}>{i === 0 ? "Today" : formatInTimeZone(d, ZONE, "EEE")}</span>
                          <span className={a.dayDate}>{formatInTimeZone(d, ZONE, formatInTimeZone(d, ZONE, "d") === "1" ? "d MMM" : "d")}</span>
                          <span className={a.stack} aria-hidden>
                            <span data-kind="mock" style={{ height: `${((items.length - tests) / peak) * 100}%` }} />
                            <span data-kind="paper" style={{ height: `${(tests / peak) * 100}%` }} />
                          </span>
                          <span className={a.daySplit} aria-hidden>
                            <span><i data-kind="paper" />P {tests}</span>
                            <span><i data-kind="mock" />M {items.length - tests}</span>
                          </span>
                        </button>
                      );
                    })}
                  </div>
                  <p className={a.legend} aria-hidden><span className={a.key}><i data-kind="paper" /> P = paper test</span><span className={a.key}><i data-kind="mock" /> M = mock</span><span className={a.legendNote}>Counts include earlier visits.</span></p>
    </div>
  );
  const slot = (b: (typeof coming)[number]) => {
    // The same key assessmentRows gives the row, so an old-flow booking opens its own row.
    const key = b.visitId ?? `${b.kind}:${b.candidateId}:${b.at.getTime()}`;
    const h = headName(b.head);
    return (
      <li key={`${b.candidateId}:${b.kind}:${b.at.getTime()}`} id={`slot-${b.kind}-${b.candidateId}-${b.at.getTime()}`} tabIndex={-1} className={a.slot}>
        <span className={a.time} data-kind={b.kind}>{clock(b.at)}</span>
        <span className={a.who}>
          <button type="button" className={a.name} onClick={() => onSelectVisit(key)}>{names.get(b.candidateId)?.name ?? "Unknown candidate"}</button>
          <span className={a.sub} title={h ?? undefined}><b className={a.kind}>{b.kind === "paper" ? "Paper test" : "Mock"}</b> · {b.subject} · {h ? (b.kind === "paper" ? `mock head ${nick(h)}` : `head ${nick(h)}`) : "No mock booked"}</span>
          {b.kind === "mock" && paperNote.get(b.candidateId)}
        </span>
        <span className={a.action}>{b.kind === "paper" && b.at > now && <PrintPaper library={data.library} subject={b.subject} name={names.get(b.candidateId)?.name} />}{b.kind === "mock" && checkLink(b.candidateId)}{b.kind === "mock" && !paperNote.has(b.candidateId) && (needsScan.has(b.candidateId)
          ? <ResultUpload kind="paper" candidateId={b.candidateId} subject={b.subject as Subject} reload={reload} label="Upload paper scan" />
          : <span className={a.quiet}>No action due</span>)}</span>
      </li>
    );
  };

  return (
    <div className={css.layout}>
      <div className={css.main}>
        <section className={css.tableSection} aria-label="Mock and paper">
          <div className={css.tableTools}>
            <div className={`${css.tabs} ${a.viewTabs}`} role="group" aria-label="View">
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
              <label className={`${css.filterSelect} ${a.headFilter}`}>
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
            )}
          </div>
          {mode === "calendar" ? (
            <HeadSchedules heads={data.configSaved ? data.config.interviewers : []} bookings={data.bookings} onOpenCandidate={onOpenRecord} />
          ) : (
            <div className={a.board}>
              <div className={a.cols}>
                <section className={a.block} aria-labelledby="todo-title">
                  <div className={a.titleRow}>
                    <h2 id="todo-title" className={a.blockTitle}>To do</h2>
                    <a className={a.jump} href={next ? `#slot-${next.kind}-${next.candidateId}-${next.at.getTime()}` : "#coming-title"}>{next ? `Next: ${when(next.at)} · ${names.get(next.candidateId)?.name ?? ""}` : "Coming up"} ↓</a>
                  </div>
                  {!lanes.some(({ lane }) => lane !== "waiting") && <p className={a.quiet}>Nothing waiting on you.</p>}
                  {lanes.map(({ lane, items }) => lane === "waiting" ? (
                    <details key={lane} className={a.lane} data-lane={lane}>
                      <summary className={a.laneTitle}>{LANE_TITLE.waiting} <span className={a.count}>{items.length}</span></summary>
                      <ul className={a.list}>{items.map(item)}</ul>
                    </details>
                  ) : (
                    <div key={lane} className={a.lane} data-lane={lane}>
                      <h3 className={a.laneTitle}>{LANE_TITLE[lane]} <span className={a.count}>{items.length}</span></h3>
                      <ul className={a.list}>{items.map(item)}</ul>
                    </div>
                  ))}
                  {!!later.length && (
                    <details className={a.lane} data-lane="finished">
                      <summary className={a.laneTitle}>Booked later <span className={a.count}>{later.length}</span></summary>
                      <ul className={a.list}>{later.map(item)}</ul>
                    </details>
                  )}
                  {!!finished.length && (
                    <details className={a.lane} data-lane="finished">
                      <summary className={a.laneTitle}>Finished <span className={a.count}>{finished.length}</span></summary>
                      <ul className={a.list}>{finished.sort((x, y) => (y.row.at?.getTime() ?? 0) - (x.row.at?.getTime() ?? 0)).map(item)}</ul>
                    </details>
                  )}
                </section>
                <section className={`${a.block} ${a.coming}`} aria-labelledby="coming-title">
                  <h2 id="coming-title" className={a.blockTitle}>Coming up</h2>
                  {weekStrip}

                  {perDay.filter(({ items }) => items.length).map(({ d, items }) => {
                    const today = day(d) === day(now);
                    // Earlier today is done or in the To do list; it folds away so the next arrival is on top.
                    const earlier = today ? items.filter((b) => b.at <= now) : [];
                    const later = items.filter((b) => !earlier.includes(b));
                    return (
                      <div key={day(d)} id={`day-${day(d)}`} className={a.lane}>
                        <h3 className={a.laneTitle} data-today={today ? "" : undefined}>{today ? "Today · " : ""}{formatInTimeZone(d, ZONE, "EEE d MMM")}{today && !later.length ? <span className={a.laneHint}>No visits left today</span> : <span className={a.count}>{today ? `${later.length} left` : items.length}</span>}</h3>
                        {!!later.length && <ul className={a.list}>{later.map(slot)}</ul>}
                        {!!earlier.length && (
                          <details className={a.earlier}>
                            <summary>Earlier today <span className={a.count}>{earlier.length}</span></summary>
                            <ul className={a.list}>{earlier.map(slot)}</ul>
                          </details>
                        )}
                      </div>
                    );
                  })}
                  {!coming.length && <p className={a.quiet}>No visits in the next 7 days.</p>}
                </section>
              </div>
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
          command={command}
          reload={reload}
          busy={busy}
          onClose={() => onSelectVisit(null)}
        />
      )}
    </div>
  );
}
