"use client";

import { useMemo, useRef, useState, type KeyboardEvent } from "react";
import { formatInTimeZone } from "date-fns-tz";
import { RESUME_TYPES, SUBJECTS, ZONE, type Subject } from "@/lib/hiring/model";
import {
  NO_SEEK_FILTER,
  isFromSeek,
  matchesSeekFilter,
  seekCoverage,
  sendQueueRows,
  universityName,
  universityOptions,
  workRightsOptions,
  workRightsText,
  type SeekFilter,
} from "@/lib/hiring/seek-view";
import { preScreenNote, type CandidateExtras } from "@/lib/hiring/status";
import { AssessmentBlock, ResumeBody, SeekLinks, SourceTextBody, useResumeCheck, useSourceText } from "./candidate-inspector";
import type { HiringCandidate, HiringData } from "./dashboard";
import { PILL_CLASS } from "./pipeline-charts";
import css from "./dashboard.module.css";

type Holds = Map<string, { short: string; long: string[] }>;
const dateTime = (value: Date | string) => formatInTimeZone(new Date(value), ZONE, "d MMM, HH:mm");
const score = (value: number) => Math.round(value * 10) / 10;

export function SeekCoverage({ summary, workerAt, now }: { summary: HiringData["workerSummary"]; workerAt: HiringData["workerAt"]; now?: Date }) {
  const coverage = seekCoverage(summary, workerAt, now);
  if (!coverage)
    return <p className={css.coverageNote}>The worker has not read SEEK yet, so the folder counts are not available.</p>;
  return (
    <section className={css.coverage} aria-label="SEEK coverage">
      {coverage.rows.map((row) => (
        <div key={row.status} className={css.coverageCard}>
          <span className={css.coverageLabel}>{row.status}</span>
          {row.imported === null ? (
            <span className={css.num}>{row.count} in SEEK</span>
          ) : (
            <>
              <span className={css.coverageValue}>
                {row.imported} / {row.count}
              </span>
              <span className={row.waiting ? css.warnWord : css.coverageLabel}>{row.waiting} waiting</span>
            </>
          )}
        </div>
      ))}
      <div className={css.coverageCard}>
        <span className={css.coverageLabel}>Last SEEK read</span>
        <span className={css.coverageValue}>{workerAt ? dateTime(workerAt) : "Not yet"}</span>
        {coverage.stale && <span className={css.warnWord}>Over 1 hour old. Counts may have changed.</span>}
      </div>
    </section>
  );
}

function PickList({
  label,
  options,
  picked,
  setPicked,
}: {
  label: string;
  options: { name: string; count: number }[];
  picked: string[];
  setPicked: (value: string[]) => void;
}) {
  const [search, setSearch] = useState("");
  const needle = search.trim().toLowerCase();
  return (
    <details className={css.pick}>
      <summary>
        {label}: {picked.length ? `${picked.length} picked` : "all"}
      </summary>
      <div className={css.pickMenu}>
        <input
          className={css.search}
          type="search"
          placeholder="Search names"
          aria-label={`Search ${label.toLowerCase()} names`}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <ul>
          {options
            .filter((option) => option.name.toLowerCase().includes(needle))
            .map((option) => (
              <li key={option.name}>
                <label>
                  <input
                    type="checkbox"
                    checked={picked.includes(option.name)}
                    onChange={(e) =>
                      setPicked(e.target.checked ? [...picked, option.name] : picked.filter((name) => name !== option.name))
                    }
                  />
                  <span>{option.name}</span>
                  <span className={css.points}>{option.count}</span>
                </label>
              </li>
            ))}
        </ul>
      </div>
    </details>
  );
}

function SeekPanel({
  candidate,
  extra,
  hold,
  data,
  onClose,
  onOpenRecord,
}: {
  candidate: HiringCandidate;
  extra?: CandidateExtras;
  hold?: { short: string; long: string[] };
  data: HiringData;
  onClose: () => void;
  onOpenRecord: () => void;
}) {
  const hasFile = candidate.resumeState === "available";
  const pdf = hasFile && candidate.resumeType === RESUME_TYPES.pdf;
  const check = useResumeCheck(candidate.id, true, hasFile);
  // A PDF shows itself. Any other file, no file, or a file that will not open shows the extracted text in its place.
  const showText = !pdf || check.status === "failed";
  const text = useSourceText(candidate.id, showText);
  const university = candidate.universityAssessment;
  return (
    <aside className={`${css.inspector} ${css.seekPanel}`} aria-label={`Résumé and score of ${candidate.name}`}>
      <header className={css.inspectorHead}>
        <div>
          <h2 className={css.inspectorName}>{candidate.name}</h2>
          <p className={css.inspectorMeta}>{candidate.email || "Email needs review"}</p>
          <SeekLinks candidate={candidate} seekJobId={data.config.seekJobId} />
          <button type="button" className={css.inlineLink} onClick={onOpenRecord}>
            Open full record
          </button>
        </div>
        <button type="button" className={css.inlineLink} onClick={onClose}>
          Close
        </button>
      </header>
      <div className={css.inspectorBody}>
        <p className={css.inspectorScore}>
          {candidate.profileScore === null ? "Not scored" : score(candidate.profileScore)}
          {candidate.profileScore !== null && <span>/100 profile</span>}
        </p>
        <dl className={css.facts}>
          <div>
            <dt>Work rights</dt>
            <dd>
              {workRightsText(candidate)}
              {candidate.workRightsAnswer && (
                <span className={candidate.workRightsAccepted ? css.goodWord : css.warnWord}>
                  {" "}· {candidate.workRightsAccepted ? "Accepted" : "Not accepted"}
                </span>
              )}
            </dd>
          </div>
          <div>
            <dt>University</dt>
            <dd>{universityName(candidate)}</dd>
          </div>
          <div>
            <dt>Subjects</dt>
            <dd>{candidate.subjects.join(", ") || "None yet"}</dd>
          </div>
          {extra && (
            <div>
              <dt>Pre-screen</dt>
              <dd>{preScreenNote(extra.pre, true) || extra.pre.status}</dd>
            </div>
          )}
        </dl>
        {hold && (
          <section className={css.inspectorSection} aria-label="Why this is waiting">
            <h3 className={css.inspectorHeading}>Waiting to send</h3>
            <ul className={css.holdList}>
              {hold.long.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          </section>
        )}
        <section className={css.inspectorSection}>
          <h3 className={css.inspectorHeading}>Résumé</h3>
          <ResumeBody
            id={candidate.id}
            name={candidate.name}
            state={candidate.resumeState}
            type={candidate.resumeType}
            months={data.config.resumeRetentionMonths}
            check={check}
          />
          {showText && (
            <div className={css.sourceText}>
              <SourceTextBody id={candidate.id} {...text} />
            </div>
          )}
        </section>
        {candidate.profileAssessment && (
          <AssessmentBlock
            title="Why this score"
            score={candidate.profileScore}
            assessment={candidate.profileAssessment}
            weights={data.config.profileWeights}
          />
        )}
        {university && (
          <section className={css.inspectorSection}>
            <h3 className={css.inspectorHeading}>
              University points
              <span className={css.num}>
                {Math.round(university.fraction * data.config.profileWeights.prestige * 100) / 100}/{data.config.profileWeights.prestige}
              </span>
            </h3>
            <p className={css.inspectorText}>{university.reason}</p>
          </section>
        )}
      </div>
    </aside>
  );
}

export function SeekScreen({
  data,
  extras,
  holds,
  onOpenRecord,
  now,
}: {
  data: HiringData;
  extras: Map<string, CandidateExtras>;
  holds: Holds;
  onOpenRecord: (id: string) => void;
  now?: Date;
}) {
  const [filter, setFilter] = useState<SeekFilter>(NO_SEEK_FILTER);
  const [mode, setMode] = useState<"all" | "queue">("all");
  const [selected, setSelected] = useState<string | null>(null);
  const list = useRef<HTMLDivElement>(null);
  const threshold = data.config.profileThreshold;

  const pool = useMemo(() => data.candidates.filter(isFromSeek), [data.candidates]);
  const universities = useMemo(() => universityOptions(pool), [pool]);
  const answers = useMemo(() => workRightsOptions(pool), [pool]);
  const rows = useMemo(() => {
    const shown = pool.filter((c) => matchesSeekFilter(c, filter, threshold));
    const sent = new Map(
      shown.flatMap((c) => {
        const at = extras.get(c.id)?.pre.sentAt;
        return at ? [[c.id, at] as const] : [];
      }),
    );
    const queue = sendQueueRows(shown, data.preScreenOrder, sent);
    if (mode === "queue") return queue;
    const places = new Map(queue.map((row) => [row.candidate.id, row]));
    // Highest score first. Unscored people come last.
    return [...shown]
      .sort((a, b) => (b.profileScore ?? -1) - (a.profileScore ?? -1))
      .map((candidate) => places.get(candidate.id) ?? { candidate, place: null, sentAt: null });
  }, [pool, filter, threshold, extras, data.preScreenOrder, mode]);

  const candidate = pool.find((c) => c.id === selected);
  const focusRow = (id: string) => list.current?.querySelector<HTMLElement>(`[data-candidate="${CSS.escape(id)}"]`)?.focus();
  const onKeyDown = (e: KeyboardEvent) => {
    if ((e.key !== "ArrowDown" && e.key !== "ArrowUp") || !rows.length) return;
    e.preventDefault();
    // Each move opens a file, so a held key does not run through the list.
    if (e.repeat) return;
    const from = selected ?? (document.activeElement as HTMLElement | null)?.dataset.candidate;
    const at = rows.findIndex((row) => row.candidate.id === from);
    const step = e.key === "ArrowDown" ? 1 : -1;
    const next = rows[at === -1 ? 0 : Math.min(rows.length - 1, Math.max(0, at + step))].candidate.id;
    setSelected(next);
    focusRow(next);
  };
  const isFiltered = Object.values(filter).some((value) => value.length > 0);

  return (
    <div className={css.layout}>
      <div className={css.main}>
        <SeekCoverage summary={data.workerSummary} workerAt={data.workerAt} now={now} />
        <section className={css.tableSection} aria-label="Candidates from SEEK">
          <div className={css.tableTools}>
            <input
              className={css.search}
              type="search"
              placeholder="Search name or email"
              aria-label="Search candidates"
              value={filter.query}
              onChange={(e) => setFilter({ ...filter, query: e.target.value })}
            />
            <PickList
              label="University"
              options={universities}
              picked={filter.universities}
              setPicked={(value) => setFilter({ ...filter, universities: value })}
            />
            <label className={css.filterSelect}>
              Work rights
              <select value={filter.workRights} onChange={(e) => setFilter({ ...filter, workRights: e.target.value })}>
                <option value="">All</option>
                {answers.map((option) => (
                  <option key={option.name} value={option.name}>
                    {option.name} ({option.count})
                  </option>
                ))}
              </select>
            </label>
            <label className={css.filterSelect}>
              Subject
              <select value={filter.subject} onChange={(e) => setFilter({ ...filter, subject: e.target.value as Subject | "" })}>
                <option value="">All</option>
                {SUBJECTS.map((subject) => (
                  <option key={subject} value={subject}>
                    {subject}
                  </option>
                ))}
              </select>
            </label>
            <label className={css.filterSelect}>
              Score
              <select value={filter.score} onChange={(e) => setFilter({ ...filter, score: e.target.value as SeekFilter["score"] })}>
                <option value="">All</option>
                <option value="pass">At or above {threshold}</option>
                <option value="below">Below {threshold}</option>
                <option value="none">Not scored</option>
              </select>
            </label>
            <div className={css.tabs} role="group" aria-label="List order">
              {(
                [
                  ["all", "All candidates"],
                  ["queue", "Send queue"],
                ] as const
              ).map(([value, label]) => (
                <button key={value} type="button" aria-pressed={mode === value} onClick={() => setMode(value)}>
                  {label}
                </button>
              ))}
            </div>
          </div>
          <p className={css.activeFilters}>
            {rows.length} shown of {pool.length}
            {isFiltered && (
              <button type="button" className={css.inlineLink} onClick={() => setFilter(NO_SEEK_FILTER)}>
                Clear filters
              </button>
            )}
          </p>
          <div className={css.tableScroll} ref={list} onKeyDown={onKeyDown}>
            <table className={css.table}>
              <thead>
                <tr>
                  <th title="Place in the pre-screen send queue">#</th>
                  <th>Candidate</th>
                  <th>University</th>
                  <th>Work rights</th>
                  <th>Score</th>
                  <th>Pre-screen</th>
                </tr>
              </thead>
              <tbody>
                {rows.map(({ candidate: c, place, sentAt }) => {
                  const extra = extras.get(c.id);
                  const hold = holds.get(c.id);
                  return (
                    <tr
                      key={c.id}
                      data-selected={selected === c.id ? "" : undefined}
                      onClick={() => {
                        setSelected(c.id);
                        focusRow(c.id);
                      }}
                    >
                      <td className={css.num}>{place ?? (sentAt ? "Sent" : "–")}</td>
                      <td className={css.candidateCell}>
                        <button
                          type="button"
                          className={css.nameButton}
                          data-candidate={c.id}
                          onClick={(e) => {
                            e.stopPropagation();
                            setSelected(c.id);
                          }}
                        >
                          {c.name}
                        </button>
                        <span className={css.email}>{c.subjects.join(", ") || "No subject yet"}</span>
                      </td>
                      <td className={css.truncate} title={universityName(c)}>
                        {universityName(c)}
                      </td>
                      <td className={`${css.truncate} ${c.workRightsAnswer && c.workRightsAccepted ? "" : css.warnCell}`} title={workRightsText(c)}>
                        {workRightsText(c)}
                      </td>
                      <td>{c.profileScore === null ? <span className={css.mutedCell}>Not scored</span> : <span className={css.num}>{score(c.profileScore)}</span>}</td>
                      <td className={css.preCell}>
                        {extra && <span className={`${css.pill} ${PILL_CLASS[extra.pre.status]}`}>{extra.pre.status}</span>}
                        {extra && <span className={css.pillNote}>{preScreenNote(extra.pre)}</span>}
                        {hold && (
                          <span className={css.holdNote} title={hold.long.join(" ")}>
                            {hold.short}
                          </span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            {!rows.length && (
              <p className={css.empty}>{pool.length ? "No candidates match these filters." : "No candidates from SEEK yet."}</p>
            )}
          </div>
        </section>
      </div>
      {candidate && (
        <SeekPanel
          key={candidate.id}
          candidate={candidate}
          extra={extras.get(candidate.id)}
          hold={holds.get(candidate.id)}
          data={data}
          onClose={() => {
            focusRow(candidate.id);
            setSelected(null);
          }}
          onOpenRecord={() => onOpenRecord(candidate.id)}
        />
      )}
    </div>
  );
}
