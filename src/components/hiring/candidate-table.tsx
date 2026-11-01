"use client";

import { useDeferredValue, useMemo, useState } from "react";
import { ACTIVE_STAGES, CRITERIA, RESULTS, STAGE_LABELS } from "@/lib/hiring/insights";
import type { HiringConfig, Stage } from "@/lib/hiring/model";
import { preScreenNote, visitText, type CandidateExtras } from "@/lib/hiring/status";
import { NO_FILTER, type CandidateFilter, type HiringCandidate, type PreScreenFilter } from "./dashboard";
import { CRITERION_LABELS, PILL_CLASS, RESULT_CLASS, RESULT_LABELS, type Insights } from "./pipeline-charts";
import css from "./dashboard.module.css";

type SortKey = "name" | "stage" | "score" | "updated";
const STAGE_ORDER = [...ACTIVE_STAGES, "no_reply", "no_booking", "stopped"] as Stage[];
const shortDate = (value: unknown) =>
  new Date(String(value)).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    timeZone: "Asia/Bangkok",
  });
const COLUMNS: [SortKey, string][] = [
  ["name", "Candidate"],
  ["stage", "Stage"],
  ["score", "Score"],
];

const PRE_SCREEN_FILTERS: PreScreenFilter[] = ["all", "Queued", "Sent", "Replied", "No reply", "Visit booked"];
// The Sent button covers Sent and Reminded; the pill still tells them apart.
const matchesPreScreen = (extra: CandidateExtras | undefined, value: PreScreenFilter) =>
  value === "all" ||
  (value === "Visit booked"
    ? !!extra?.visit
    : value === "Sent"
      ? extra?.pre.status === "Sent" || extra?.pre.status === "Reminded"
      : extra?.pre.status === value);

/** The stage, score, subject and pre-screen filters. Search text stays inside the table. */
export const matchesFilter = (
  c: HiringCandidate,
  filter: CandidateFilter,
  ready: Set<string>,
  extras: Map<string, CandidateExtras>,
) =>
  matchesPreScreen(extras.get(c.id), filter.prescreen) &&
  (filter.stage === "all" || (filter.stage === "ready" ? ready.has(c.id) : c.stage === filter.stage)) &&
  (filter.bucket === null ||
    (c.profileScore !== null && Math.min(Math.floor(c.profileScore / 10) * 10, 90) === filter.bucket)) &&
  (!filter.subject || c.subjects.includes(filter.subject));

export function CandidateTable({
  candidates,
  insights,
  ready,
  extras,
  holds,
  clashes,
  weights,
  threshold,
  filter,
  setFilter,
  selected,
  onSelect,
}: {
  candidates: HiringCandidate[];
  insights: Insights;
  ready: Set<string>;
  extras: Map<string, CandidateExtras>;
  /** Why a candidate has not been sent anything yet: queue place and limit, or the profile gate. */
  holds: Map<string, { short: string; long: string[] }>;
  /** Candidates whose booked mock overlaps a Wise class, leave or sit-in. */
  clashes: Set<string>;
  weights: HiringConfig["profileWeights"];
  threshold: number;
  filter: CandidateFilter;
  setFilter: (filter: CandidateFilter) => void;
  selected: string | null;
  onSelect: (id: string) => void;
}) {
  const [query, setQuery] = useState("");
  const deferred = useDeferredValue(query);
  const [sort, setSort] = useState<{ key: SortKey; descending: boolean }>({ key: "score", descending: true });
  const rows = useMemo(() => {
    const needle = deferred.trim().toLowerCase();
    const shown = candidates.filter(
      (c) =>
        matchesFilter(c, filter, ready, extras) &&
        (!needle ||
          `${c.name} ${c.email ?? ""} ${STAGE_LABELS[c.stage]}`.toLowerCase().includes(needle)),
    );
    const value = (c: HiringCandidate) =>
      sort.key === "name"
        ? c.name.toLowerCase()
        : sort.key === "stage"
          ? STAGE_ORDER.indexOf(c.stage)
          : sort.key === "score"
            ? c.profileScore
            : new Date(String(c.updatedAt)).getTime();
    return shown.sort((a, b) => {
      const [x, y] = [value(a), value(b)];
      // Unscored candidates stay last in either direction.
      if (x === null || y === null) return x === y ? 0 : x === null ? 1 : -1;
      return (x < y ? -1 : x > y ? 1 : 0) * (sort.descending ? -1 : 1);
    });
  }, [candidates, ready, extras, filter, deferred, sort]);

  const tabs: [CandidateFilter["stage"], string, number][] = [
    ["all", "All", insights.total],
    ["ready", "Ready", insights.ready],
    // No reply and No booking are stages too, so they filter like the rest.
    ...STAGE_ORDER.filter((s) => s !== "stopped").map((s): [Stage, string, number] => [s, STAGE_LABELS[s], insights.byStage[s]]),
    ["stopped", STAGE_LABELS.stopped, insights.stopped],
  ];
  const preCounts = PRE_SCREEN_FILTERS.map(
    (value) => candidates.filter((c) => matchesPreScreen(extras.get(c.id), value)).length,
  );
  const isFiltered = filter.bucket !== null || !!filter.subject || filter.prescreen !== "all" || !!query;

  return (
    <section className={css.tableSection} aria-label="Candidates">
      <div className={css.tableTools}>
        <div className={css.tabs} role="group" aria-label="Filter by stage">
          {tabs.map(([value, label, count]) => (
            <button
              key={value}
              type="button"
              aria-pressed={filter.stage === value}
              onClick={() => setFilter({ ...filter, stage: value })}
            >
              {label} <span className={css.tabCount}>{count}</span>
            </button>
          ))}
        </div>
        <input
          className={css.search}
          type="search"
          placeholder="Search name, email or stage"
          aria-label="Search candidates"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>
      <div className={css.tableTools}>
        <div className={css.tabs} role="group" aria-label="Filter by pre-screen status">
          {PRE_SCREEN_FILTERS.map((value, i) => (
            <button
              key={value}
              type="button"
              aria-pressed={filter.prescreen === value}
              onClick={() => setFilter({ ...filter, prescreen: value })}
            >
              {value === "all" ? "All pre-screen" : value} <span className={css.tabCount}>{preCounts[i]}</span>
            </button>
          ))}
        </div>
      </div>
      {isFiltered && (
        <p className={css.activeFilters}>
          {rows.length} shown
          {filter.bucket !== null && ` · Score ${filter.bucket}–${filter.bucket === 90 ? 100 : filter.bucket + 9}`}
          {filter.subject && ` · ${filter.subject}`}
          {filter.prescreen !== "all" && ` · ${filter.prescreen === "Visit booked" ? "Visit booked" : `Pre-screen ${filter.prescreen.toLowerCase()}`}`}
          <button
            type="button"
            className={css.inlineLink}
            onClick={() => {
              setFilter({ ...NO_FILTER, stage: filter.stage });
              setQuery("");
            }}
          >
            Clear filters
          </button>
        </p>
      )}
      <div className={css.tableScroll}>
        <table className={css.table}>
          <thead>
            <tr>
              {COLUMNS.map(([key, label]) => (
                <th
                  key={key}
                  aria-sort={sort.key === key ? (sort.descending ? "descending" : "ascending") : "none"}
                >
                  <button
                    type="button"
                    onClick={() =>
                      setSort({
                        key,
                        descending: sort.key === key ? !sort.descending : key === "score",
                      })
                    }
                  >
                    {label}
                    <span aria-hidden="true">{sort.key === key ? (sort.descending ? " ↓" : " ↑") : ""}</span>
                  </button>
                </th>
              ))}
              <th className={css.wideOnly}>Pre-screen</th>
              <th className={css.wideOnly}>Pre-screen score</th>
              <th className={css.wideOnly}>Visit</th>
              <th className={css.wideOnly} title="Degree, Subject, Curriculum, Teaching, English">
                <span className={css.evidenceHead}>
                  {CRITERIA.map((id) => (
                    <abbr key={id} title={CRITERION_LABELS[id]}>{CRITERION_LABELS[id][0]}</abbr>
                  ))}
                </span>
              </th>
              <th className={css.wideOnly}>University</th>
              <th className={css.wideOnly}>Subjects</th>
              <th className={css.wideOnly}>Flags</th>
              <th className={css.wideOnly} aria-sort={sort.key === "updated" ? (sort.descending ? "descending" : "ascending") : "none"}>
                <button
                  type="button"
                  onClick={() => setSort({ key: "updated", descending: sort.key === "updated" ? !sort.descending : true })}
                >
                  Updated
                  <span aria-hidden="true">{sort.key === "updated" ? (sort.descending ? " ↓" : " ↑") : ""}</span>
                </button>
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((c) => {
              const extra = extras.get(c.id);
              const flags = [
                c.previouslyContacted && "Contacted",
                !c.email && "No email",
                !c.workRightsAnswer ? "Rights unknown" : !c.workRightsAccepted && "Rights not accepted",
              ].filter(Boolean);
              return (
                <tr key={c.id} data-selected={selected === c.id ? "" : undefined} onClick={() => onSelect(c.id)}>
                  <td className={css.candidateCell}>
                    <button
                      type="button"
                      className={css.nameButton}
                      onClick={(e) => {
                        e.stopPropagation();
                        onSelect(c.id);
                      }}
                    >
                      {c.name}
                    </button>
                    <span className={css.email}>{c.email || "Email needs review"}</span>
                  </td>
                  <td className={c.stage === "stopped" ? css.mutedCell : undefined}>
                    {STAGE_LABELS[c.stage]}
                    {ready.has(c.id) && <span className={css.readyWord}>Ready</span>}
                    {/* The Visit column is hidden on a phone, so the marker sits here with the stage. */}
                    {clashes.has(c.id) && (
                      <span className={css.clashWord} title="The booked mock overlaps a Wise class, leave or sit-in. The app did not move the visit.">
                        Visit clash
                      </span>
                    )}
                    {/* The Pre-screen column is hidden on a phone, so its pill sits here. */}
                    {extra && (
                      <span className={`${css.pill} ${css.stagePill} ${PILL_CLASS[extra.pre.status]}`}>{extra.pre.status}</span>
                    )}
                    {holds.get(c.id) && <span className={`${css.holdNote} ${css.stageHold}`}>{holds.get(c.id)!.short}</span>}
                  </td>
                  <td>
                    {c.profileScore === null ? (
                      <span className={css.mutedCell}>Not scored</span>
                    ) : (
                      <span className={css.scoreCell}>
                        <span className={css.num}>{Math.round(c.profileScore * 10) / 10}</span>
                        <span className={css.scoreTrack} aria-hidden="true">
                          <span
                            className={c.profileScore >= threshold ? css.barPass : css.barBelow}
                            style={{ width: `${c.profileScore}%` }}
                          />
                          <i style={{ left: `${threshold}%` }} />
                        </span>
                      </span>
                    )}
                  </td>
                  <td className={`${css.wideOnly} ${css.preCell}`}>
                    {extra && (
                      <>
                        <span className={`${css.pill} ${PILL_CLASS[extra.pre.status]}`}>{extra.pre.status}</span>
                        <span className={css.pillNote}>{preScreenNote(extra.pre)}</span>
                      </>
                    )}
                    {holds.get(c.id) && (
                      <span className={css.holdNote} title={holds.get(c.id)!.long.join(" ")}>
                        {holds.get(c.id)!.short}
                      </span>
                    )}
                  </td>
                  <td className={css.wideOnly}>
                    {c.preScreenScore === null ? (
                      <span className={css.mutedCell}>–</span>
                    ) : (
                      <span className={css.num}>{Math.round(c.preScreenScore * 10) / 10}</span>
                    )}
                  </td>
                  <td className={`${css.wideOnly} ${extra?.visit ? "" : css.mutedCell}`}>
                    {extra?.visit ? visitText(extra.visit) : "–"}
                  </td>
                  <td className={css.wideOnly}>
                    {c.profileAssessment ? (
                      <span className={css.dots}>
                        {CRITERIA.map((id) => {
                          const result =
                            c.profileAssessment?.criteria.find((row) => row.id === id)?.result ?? RESULTS[3];
                          return (
                            <i
                              key={id}
                              className={RESULT_CLASS[result]}
                              role="img"
                              aria-label={`${CRITERION_LABELS[id]}: ${RESULT_LABELS[result]}`}
                              title={`${CRITERION_LABELS[id]}: ${RESULT_LABELS[result]}`}
                            />
                          );
                        })}
                      </span>
                    ) : (
                      <span className={css.mutedCell}>–</span>
                    )}
                  </td>
                  <td className={`${css.wideOnly} ${css.truncate}`} title={c.universityAssessment?.name ?? undefined}>
                    {c.universityAssessment ? (
                      <>
                        {c.universityAssessment.name ?? "Not confirmed"}
                        <span className={css.points}>
                          {Math.round(c.universityAssessment.fraction * weights.prestige * 10) / 10}/{weights.prestige}
                        </span>
                      </>
                    ) : (
                      <span className={css.mutedCell}>–</span>
                    )}
                  </td>
                  <td className={`${css.wideOnly} ${css.truncate}`} title={c.subjects.join(", ")}>
                    {c.subjects.slice(0, 2).join(", ") || <span className={css.mutedCell}>–</span>}
                    {c.subjects.length > 2 && <span className={css.points}>+{c.subjects.length - 2}</span>}
                  </td>
                  <td className={`${css.wideOnly} ${css.mutedCell} ${css.truncate}`}>{flags.join(", ")}</td>
                  <td className={`${css.wideOnly} ${css.mutedCell}`}>{shortDate(c.updatedAt)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {!rows.length && <p className={css.empty}>No candidates match these filters.</p>}
      </div>
    </section>
  );
}
