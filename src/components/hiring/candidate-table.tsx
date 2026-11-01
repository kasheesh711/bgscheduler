"use client";

import { useDeferredValue, useMemo, useState } from "react";
import { ACTIVE_STAGES, CRITERIA, RESULTS, STAGE_LABELS } from "@/lib/hiring/insights";
import type { HiringConfig, Stage } from "@/lib/hiring/model";
import { NO_FILTER, type CandidateFilter, type HiringCandidate } from "./dashboard";
import { CRITERION_LABELS, RESULT_CLASS, RESULT_LABELS, type Insights } from "./pipeline-charts";
import css from "./dashboard.module.css";

type SortKey = "name" | "stage" | "score" | "updated";
const STAGE_ORDER = [...ACTIVE_STAGES, "stopped"] as Stage[];
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

export function CandidateTable({
  candidates,
  insights,
  ready,
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
        (filter.stage === "all" ||
          (filter.stage === "ready" ? ready.has(c.id) : c.stage === filter.stage)) &&
        (filter.bucket === null ||
          (c.profileScore !== null && Math.min(Math.floor(c.profileScore / 10) * 10, 90) === filter.bucket)) &&
        (!filter.subject || c.subjects.includes(filter.subject)) &&
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
  }, [candidates, ready, filter, deferred, sort]);

  const counts = Object.fromEntries(insights.stages.map((s) => [s.stage, s.at]));
  const tabs: [CandidateFilter["stage"], string, number][] = [
    ["all", "All", insights.total],
    ["ready", "Ready", insights.ready],
    ...ACTIVE_STAGES.map((s): [Stage, string, number] => [s, STAGE_LABELS[s], counts[s]]),
    ["stopped", STAGE_LABELS.stopped, insights.stopped],
  ];
  const isFiltered = filter.bucket !== null || !!filter.subject || !!query;

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
      {isFiltered && (
        <p className={css.activeFilters}>
          {rows.length} shown
          {filter.bucket !== null && ` · Score ${filter.bucket}–${filter.bucket === 90 ? 100 : filter.bucket + 9}`}
          {filter.subject && ` · ${filter.subject}`}
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
              const flags = [
                c.previouslyContacted && "Contacted",
                !c.email && "No email",
                c.workRightsConfirmed !== true && "Rights unknown",
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
