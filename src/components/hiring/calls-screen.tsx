"use client";

import { useState } from "react";
import { formatInTimeZone } from "date-fns-tz";
import { ZONE, type HiringConfig } from "@/lib/hiring/model";
import { topHiringSubject } from "@/lib/hiring/scoring";
import { universityName } from "@/lib/hiring/seek-view";
import type { CandidateExtras } from "@/lib/hiring/status";
import type { Command, HiringCandidate, HiringData } from "./dashboard";
import { SeekLinks } from "./candidate-inspector";
import { SeekPanel } from "./seek-screen";
import css from "./dashboard.module.css";

type Holds = Map<string, { short: string; long: string[] }>;
type CallResult = "good" | "no_answer" | "bad";
const dateTime = (value: string) => formatInTimeZone(new Date(value), ZONE, "d MMM, HH:mm");
export const BAD_CALL_REASON = "Bad call before the pre-screen form.";

/** The request each button sends. A bad call is the existing Stop, so its rules stay in one place. */
export function callCommand(candidate: Pick<HiringCandidate, "id" | "revision" | "subjects">, result: CallResult) {
  return result === "bad"
    ? { action: "stop", id: candidate.id, revision: candidate.revision, subjects: candidate.subjects, reason: BAD_CALL_REASON }
    : { action: "call_result", id: candidate.id, result };
}

export function triesText(review: HiringCandidate["callReview"]) {
  const tries = review?.tries ?? [];
  if (!tries.length) return "Not called yet";
  return `${tries.length} no answer${tries.length > 1 ? "s" : ""} · last ${dateTime(tries.at(-1)!.at)}`;
}

/** The subject the form goes for after a good call (the gate's choice), then the other subjects the profile supports. */
export function callSubjects(
  candidate: { profileAssessment: { subjects: { subject: HiringCandidate["subjects"][number]; relevant: boolean }[] } | null },
  priority: HiringConfig["subjectPriority"],
) {
  const found = (candidate.profileAssessment?.subjects ?? []).filter((s) => s.relevant).map((s) => s.subject);
  const main = topHiringSubject(found, priority);
  return { main: main ?? "None found", other: found.filter((s) => s !== main) };
}

export function CallsScreen({
  data,
  extras,
  holds,
  onOpenRecord,
  command,
  busy,
}: {
  data: HiringData;
  extras: Map<string, CandidateExtras>;
  holds: Holds;
  onOpenRecord: (id: string) => void;
  command: Command;
  busy: boolean;
}) {
  const [selected, setSelected] = useState<string | null>(null);
  const byId = new Map(data.candidates.map((c) => [c.id, c]));
  const rows = data.callOrder.flatMap((id) => byId.get(id) ?? []);
  const candidate = selected ? byId.get(selected) : undefined;
  const act = (c: HiringCandidate, result: CallResult) => {
    if (result === "bad" && !window.confirm(`Stop ${c.name}? Nothing is sent to them, and they leave every queue.`)) return;
    void command(callCommand(c, result));
  };
  const threshold = data.config.callThreshold;

  return (
    <div className={css.layout}>
      <div className={css.main}>
        <section className={css.tableSection} aria-label="Candidates for HR to call">
          <p className={css.activeFilters}>
            {threshold === null
              ? "Calls are off. Set an HR call score in Rules and setup to use this list."
              : `${rows.length} to call. Highest SEEK score first. A candidate at or above ${threshold} gets the pre-screen form only after a good call.`}
          </p>
          <div className={css.tableScroll}>
            <table className={css.table}>
              <thead>
                <tr>
                  <th>#</th>
                  <th>Candidate</th>
                  <th>Subject</th>
                  <th>University</th>
                  <th>Score</th>
                  <th>Calls</th>
                  <th>SEEK</th>
                  <th>Result</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((c, index) => {
                  const subjects = callSubjects(c, data.config.subjectPriority);
                  return (
                    <tr key={c.id} data-selected={selected === c.id ? "" : undefined} onClick={() => setSelected(c.id)}>
                      <td className={css.num}>{index + 1}</td>
                      <td className={css.candidateCell}>
                        <button
                          type="button"
                          className={css.nameButton}
                          onClick={(e) => {
                            e.stopPropagation();
                            setSelected(c.id);
                          }}
                        >
                          {c.name}
                        </button>
                        {c.profileAssessment?.briefSummary && <span className={css.email}>{c.profileAssessment.briefSummary}</span>}
                      </td>
                      <td>
                        {subjects.main}
                        {subjects.other.length > 0 && <span className={css.email}>Also {subjects.other.join(", ")}</span>}
                      </td>
                      <td>{universityName(c)}</td>
                      <td className={css.num}>{c.profileScore === null ? "–" : Math.round(c.profileScore * 10) / 10}</td>
                      <td className={css.mutedCell}>{triesText(c.callReview)}</td>
                      <td onClick={(e) => e.stopPropagation()}>
                        <SeekLinks candidate={c} fallbackJobId={data.config.seekJobs[0].jobId} className={css.seekButton} />
                      </td>
                      <td>
                        <div className={`${css.decisionActions} ${css.callActions}`}>
                          {(
                            [
                              ["good", "Good call", css.primary],
                              ["no_answer", "No answer", css.secondary],
                              ["bad", "Bad call", css.stopButton],
                            ] as const
                          ).map(([result, label, style]) => (
                            <button
                              key={result}
                              type="button"
                              className={style}
                              disabled={busy}
                              onClick={(e) => {
                                e.stopPropagation();
                                act(c, result);
                              }}
                            >
                              {label}
                            </button>
                          ))}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            {!rows.length && <p className={css.empty}>Nobody is waiting for a call.</p>}
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
          onClose={() => setSelected(null)}
          onOpenRecord={() => onOpenRecord(candidate.id)}
        />
      )}
    </div>
  );
}
