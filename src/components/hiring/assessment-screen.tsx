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
import { RUBRIC, computeSheet, passRulesFor, rubricTotals, type LevelResult, type RubricItem } from "@/lib/hiring/marking-sheet";
import { SUBJECTS, ZONE, type Subject } from "@/lib/hiring/model";
import { markAgain, runMarking, type ResultKind } from "./assessment-setup";
import type { Command, HiringCandidate, HiringData } from "./dashboard";
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

type Reload = () => Promise<void>;

/** The file picker for a candidate's scan. It stays on the row or the panel while the upload and the marking run. */
/** The blank question paper from the paper library, for the person who prepares the visit. It opens as a PDF to print. */
export function PrintPaper({ library, subject }: { library: HiringData["library"]; subject: string }) {
  const file = library.find((item) => item.subject === subject && item.kind === "question_paper");
  if (!file) return <span className={css.warnWord}>No paper to print. Add it in Rules and setup. </span>;
  return (
    <a className={css.sourceLink} href={`/api/hiring/file/${encodeURIComponent(file.id)}`} target="_blank" rel="noopener noreferrer" onClick={(e) => e.stopPropagation()}>
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

export function PaperSheetView({ paper, taken = [], config, command, reload, busy }: { paper: Paper; taken?: string[]; config: HiringData["config"]; command: Command; reload: Reload; busy: boolean }) {
  const stuck = paper.stuck;
  const sheet = paper.marks ? computeSheet(paper.marks, passRulesFor(config, paper.subject)) : null;
  const [editing, setEditing] = useState(false);
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
      {stuck && <p className={css.warnWord}>This run stopped before it finished.</p>}
      {(paper.status === "failed" || paper.status === "uploaded" || stuck) && <RetryMarking kind="paper" id={paper.id} reload={reload} />}
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
          {editing ? (
            <MarksEditor key={String(paper.updatedAt)} paper={paper} command={command} busy={busy} onDone={() => setEditing(false)} />
          ) : (
            <button type="button" className={css.inlineLink} onClick={() => setEditing(true)}>
              Change marks
            </button>
          )}
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

function RubricEditor({ mock, command, busy, onDone }: { mock: Mock; command: Command; busy: boolean; onDone: () => void }) {
  const [items, setItems] = useState<Record<string, string>>(() => Object.fromEntries(Object.entries(mock.rubric!.items).map(([id, value]) => [id, value === null ? "" : String(value)])));
  const [comments, setComments] = useState(mock.rubric!.comments);
  const values = Object.fromEntries(Object.entries(items).map(([id, text]) => [id, text.trim() === "" ? null : Number(text)]));
  const valid = Object.values(values).every((value) => value === null || (Number.isInteger(value) && value >= 1 && value <= 10));
  return (
    <form
      onSubmit={async (e) => {
        e.preventDefault();
        const changed = Object.fromEntries(Object.entries(values).filter(([id, value]) => value !== mock.rubric!.items[id as RubricItem]));
        if (await command({ action: "mock_edit", id: mock.id, updatedAt: new Date(mock.updatedAt).toISOString(), items: changed, comments })) onDone();
      }}
    >
      <table className={css.sheetTable}>
        <tbody>
          {RUBRIC.flatMap(({ items: rows }) => [...rows] as (readonly [string, string])[]).map(([id, label]) => (
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
function resultEmailState(key: string | null, outbox: HiringData["inviteOutbox"]) {
  const row = outbox.find((job) => job.key === key);
  if (!row) return { label: "Not found", tone: css.warnWord, error: null };
  if (row.status === "sent") return { label: row.sentAt ? `Sent ${when(new Date(row.sentAt))}` : "Sent", tone: css.goodWord, error: null };
  if (row.status === "failed") return { label: "Failed, will retry", tone: css.errorText, error: row.error };
  if (row.status === "uncertain") return { label: "May have sent. Check first", tone: css.errorText, error: row.error };
  if (row.status === "cancelled") return { label: "Cancelled", tone: css.mutedCell, error: null };
  return { label: "Queued", tone: css.warnWord, error: null };
}

function DecisionBox({ candidate, papers, mocks, data, command, busy }: { candidate: HiringCandidate; papers: Paper[]; mocks: Mock[]; data: HiringData; command: Command; busy: boolean }) {
  const mine = data.decisions.filter((row) => row.candidateId === candidate.id);
  const draft = mine.find((row) => row.status === "draft");
  const sent = mine.find((row) => row.status === "sent");
  const blockers = hireBlockers(papers, mocks);
  const [reason, setReason] = useState("");
  const blocked = !candidate.email;
  const email = sent ? resultEmailState(sent.outboxKey, data.inviteOutbox) : null;
  // A result that left or is on its way cannot be sent again. A failed one can.
  const going = sent ? data.inviteOutbox.some((job) => job.key === sent.outboxKey && ["sent", "pending", "processing"].includes(job.status)) : false;
  return (
    <section className={css.inspectorSection} aria-label="Decision">
      <h3 className={css.inspectorHeading}>Decision</h3>
      {sent && email && (
        <dl className={css.facts}>
          <div>
            <dt>{sent.decision === "hire" ? "Hired" : "Rejected"}</dt>
            <dd>{sent.decidedBy}</dd>
          </div>
          <div>
            <dt>Result email</dt>
            <dd className={email.tone}>{email.label}</dd>
          </div>
        </dl>
      )}
      {email?.error && <p className={css.errorText}>{email.error}</p>}
      {draft ? (
        <DraftEditor key={draft.id} draft={draft} to={candidate.email} data={data} command={command} busy={busy} />
      ) : (
        <>
          {sent && <p className={css.inspectorMeta}>A new decision needs its own email. The email already sent is not recalled.</p>}
          {blocked && <p className={css.warnWord}>This candidate has no email address, so a result email cannot go. Use Stop in the full record.</p>}
          {blockers.length > 0 && (
            <ul className={css.holdList}>
              {blockers.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          )}
          <label className={css.fieldLabel}>
            Reason
            <textarea className={css.textarea} rows={2} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Needed to reject. The candidate does not see it." />
          </label>
          <div className={css.decisionActions}>
            <button type="button" className={css.primary} disabled={busy || blocked || blockers.length > 0 || (going && sent?.decision === "hire")} onClick={() => void command({ action: "decision_draft", id: candidate.id, decision: "hire", reason })}>
              Hire: preview email
            </button>
            <button type="button" className={css.secondary} disabled={busy || blocked || reason.trim().length < 5 || (going && sent?.decision === "reject")} onClick={() => void command({ action: "decision_draft", id: candidate.id, decision: "reject", reason })}>
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

function decisionCell(rows: DecisionRow[]) {
  const draft = rows.find((row) => row.status === "draft");
  const sent = rows.find((row) => row.status === "sent");
  if (!draft && !sent) return <span className={css.mutedCell}>–</span>;
  return (
    <>
      {sent && <span className={css.pillNote}>{sent.decision === "hire" ? "Hired" : "Rejected"}</span>}
      {draft && <span className={css.warnWord}>Draft: {draft.decision === "hire" ? "Hire" : "Reject"}</span>}
    </>
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
          <PaperSheetView key={paper.id} paper={paper} taken={papers.filter((other) => other.id !== paper.id && other.source !== "tracker").map((other) => other.subject)} config={data.config} command={command} reload={reload} busy={busy} />
        ))}
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
        {!row.history && <DecisionBox candidate={candidate} papers={papers} mocks={mocks} data={data} command={command} busy={busy} />}
      </div>
    </aside>
  );
}

export function AssessmentScreen({
  data,
  onOpenRecord,
  command,
  reload,
  busy,
  now,
}: {
  data: HiringData;
  onOpenRecord: (id: string) => void;
  command: Command;
  reload: Reload;
  busy: boolean;
  now?: Date;
}) {
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
                    // A row with a visit shows that visit's results. A past tracker result is in the panel.
                    const rowPapers = (papers.get(row.candidateId) ?? []).filter((paper) => row.history || paper.source !== "tracker");
                    // A person can hold a mock in another subject. A history row has no subject of its own to match.
                    const rowMocks = (mocks.get(row.candidateId) ?? []).filter((mock) => row.history || (mock.subject === row.subject && mock.source !== "tracker"));
                    return (
                      <tr key={row.key} data-selected={selected === row.key ? "" : undefined} onClick={() => setSelected(row.key)}>
                        <td>
                          {row.at ? when(row.at) : row.dateText || "–"}
                          {row.mockAt && <span className={css.pillNote}>Mock {clock(row.mockAt)}</span>}
                          {row.status === "no_show" && <span className={css.clashWord}>No-show</span>}
                          {row.status === "cancelled" && <span className={css.clashWord}>Visit cancelled</span>}
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
                          {rowPapers.length ? (
                            rowPapers.map((paper) => <span key={paper.id} className={css.pillNote}>{paperCell(paper, data.config)}</span>)
                          ) : row.kinds.includes("paper") && row.subject ? (
                            <>
                              <PrintPaper library={data.library} subject={row.subject} />
                              <ResultUpload kind="paper" candidateId={row.candidateId} subject={row.subject as Subject} reload={reload} label="Upload PDF" />
                            </>
                          ) : (
                            <span className={css.mutedCell}>–</span>
                          )}
                        </td>
                        <td>
                          {rowMocks.length ? (
                            rowMocks.map((mock) => <span key={mock.id} className={css.pillNote}>{mockCell(mock)}</span>)
                          ) : row.kinds.includes("mock") && row.subject ? (
                            <ResultUpload kind="mock" candidateId={row.candidateId} subject={row.subject as Subject} reload={reload} label="Upload rubric" />
                          ) : (
                            <span className={css.mutedCell}>–</span>
                          )}
                        </td>
                        <td>{decisionCell(data.decisions.filter((d) => d.candidateId === row.candidateId))}</td>
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
          command={command}
          reload={reload}
          busy={busy}
          onClose={() => setSelected(null)}
        />
      )}
    </div>
  );
}
