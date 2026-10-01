"use client";
import { WorkforceTab } from "./workforce/dashboard";
import type { WorkforceReport } from "@/lib/tutor-offboarding/workforce/types";

import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type {
  AnalyticsCategory,
  AnalyticsCoverage,
  AnalyticsReport,
  TutorOffboardingAnalytics,
} from "@/lib/tutor-offboarding/analytics-types";
import { Disclosure, Panel, Tag, Upper } from "./atoms";
import { formatDayYear } from "./format";

export type AnalyticsScenario = "marked" | "marked_and_inferred";
const CATEGORY: Record<AnalyticsCategory, string> = {
  marked_no_upcoming: "Marked · no upcoming classes",
  marked_pending_classes: "Marked · pending classes",
  inferred_very_likely_unmarked: "Unmarked · very likely gone",
  likely_unmarked: "Unmarked · likely gone",
  unclear_unmarked: "Unmarked · unclear",
  retained: "Other tutors",
  staff: "Wise staff accounts",
};
const UNAVAILABLE = {
  not_set_up: "Analytics is not set up yet.",
  no_snapshot: "No current Wise snapshot is available for analytics.",
  load_failed: "Analytics could not load. Try refreshing.",
};
const number = (value: number) => value.toLocaleString("en-GB");
const remaining = (row: AnalyticsCoverage, scenario: AnalyticsScenario) =>
  scenario === "marked"
    ? row.remainingAfterMarked
    : row.remainingAfterMarkedAndInferred;
const affected = (row: AnalyticsCoverage, scenario: AnalyticsScenario) =>
  row.markedPeople.length > 0 ||
  (scenario === "marked_and_inferred" && row.inferredPeople.length > 0);
const departureKeys = (row: AnalyticsCoverage, scenario: AnalyticsScenario) => [
  ...new Set([
    ...row.markedPeople,
    ...(scenario === "marked_and_inferred" ? row.inferredPeople : []),
  ]),
];

/** Analytics makes one read. HTTP and malformed success responses stay visible to the user. */
export async function fetchAnalytics(
  fetcher: typeof fetch = fetch,
  signal?: AbortSignal,
): Promise<TutorOffboardingAnalytics> {
  const response = await fetcher("/api/tutor-offboarding/analytics", {
    method: "GET",
    cache: "no-store",
    signal,
  });
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok)
    throw new Error(
      body &&
        typeof body === "object" &&
        "error" in body &&
        typeof body.error === "string"
        ? body.error
        : "Analytics could not load.",
    );
  if (!body || typeof body !== "object" || !("available" in body))
    throw new Error("Analytics response was incomplete.");
  if (
    body.available === false &&
    "reason" in body &&
    typeof body.reason === "string" &&
    body.reason in UNAVAILABLE
  )
    return body as TutorOffboardingAnalytics;
  if (
    body.available !== true ||
    !["totals", "turnover", "freshness", "terminationSource"].every(
      (key) => key in body && body[key as keyof typeof body],
    ) ||
    !["people", "monthly", "coverage", "courses", "limitations"].every(
      (key) => key in body && Array.isArray(body[key as keyof typeof body]),
    )
  )
    throw new Error("Analytics response was incomplete.");
  return body as AnalyticsReport;
}

export function safeCsvCell(value: string | number): string {
  const text = String(value);
  const safe =
    /^[\s\uFEFF]*[=+@-]/u.test(text) || /^[\t\r\n]/u.test(text)
      ? `'${text}`
      : text;
  return `"${safe.replaceAll('"', '""')}"`;
}
const csv = (rows: Array<Array<string | number>>) =>
  rows.map((row) => row.map(safeCsvCell).join(",")).join("\r\n");
export function coverageCsv(
  report: AnalyticsReport,
  scenario: AnalyticsScenario,
): string {
  const name = (keys: string[]) =>
    keys
      .map(
        (key) =>
          report.people.find((p) => p.canonicalKey === key)?.displayName ?? key,
      )
      .join("; ");
  return csv([
    [
      "Subject",
      "Curriculum",
      "Level",
      "Exam preparation",
      "Current qualified",
      "Departure scenario",
      "Qualified after scenario",
      "Remaining names",
      "Departing names",
      "Remaining taught last 30 days",
      "Remaining upcoming teaching",
    ],
    ...report.coverage.map((row) => {
      const left = remaining(row, scenario);
      return [
        row.subject,
        row.curriculum,
        row.level,
        row.examPrep ?? "",
        row.currentPeople.length,
        scenario,
        left.length,
        name(left),
        name(departureKeys(row, scenario)),
        left.filter((key) => row.recentTeachingPeople.includes(key)).length,
        left.filter((key) => row.upcomingTeachingPeople.includes(key)).length,
      ];
    }),
  ]);
}
export function peopleCsv(report: AnalyticsReport): string {
  return csv([
    [
      "Tutor",
      "Category",
      "Current roster",
      "Taught since 1 March",
      "Upcoming next 30 days",
      "All stored future classes",
      "Last taught",
    ],
    ...report.people.map((p) => [
      p.displayName,
      CATEGORY[p.category],
      p.currentRoster ? "Yes" : "No",
      p.taughtSinceMarch ? "Yes" : "No",
      p.upcomingSessions30Days,
      p.upcomingSessionsAllTime,
      p.lastTaughtAt ?? "",
    ]),
  ]);
}
function download(contents: string, filename: string) {
  const url = URL.createObjectURL(
    new Blob([`\uFEFF${contents}`], { type: "text/csv;charset=utf-8" }),
  );
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.style.display = "none";
  document.body.appendChild(link);
  try {
    link.click();
  } finally {
    link.remove();
    // Let the browser start reading the Blob before releasing its URL.
    window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
  }
}
function Metric({
  label,
  value,
  detail,
}: {
  label: string;
  value: string;
  detail: string;
}) {
  return (
    <Panel className="px-4 py-3">
      <Upper>{label}</Upper>
      <p className="mt-1 text-2xl font-semibold tabular-nums">{value}</p>
      <p className="mt-1 text-xs text-muted-foreground">{detail}</p>
    </Panel>
  );
}

export function AnalyticsContent({
  report,
  initialScenario = "marked",
  contextOnly = false,
}: {
  report: AnalyticsReport;
  initialScenario?: AnalyticsScenario;
  contextOnly?: boolean;
}) {
  const [scenario, setScenario] = useState<AnalyticsScenario>(initialScenario);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState("affected");
  const [courseFilter, setCourseFilter] = useState("future");
  const [courseQuery, setCourseQuery] = useState("");
  const names = (keys: string[]) =>
    keys.map(
      (key) =>
        report.people.find((p) => p.canonicalKey === key)?.displayName ?? key,
    );
  const numerator =
    scenario === "marked"
      ? report.turnover.markedNumerator
      : report.turnover.markedAndInferredNumerator;
  const share = report.turnover.denominator
    ? ((numerator / report.turnover.denominator) * 100).toFixed(1) + "%"
    : "Unavailable";
  const affectedRows = report.coverage.filter((row) => affected(row, scenario));
  const zero = affectedRows.filter(
    (row) => remaining(row, scenario).length === 0,
  ).length;
  const one = affectedRows.filter(
    (row) => remaining(row, scenario).length === 1,
  ).length;
  const pending = report.people.filter(
    (p) => p.marked && p.category !== "staff" && p.upcomingSessionsAllTime > 0,
  );
  const courses = report.courses.filter(
    (row) =>
      row.markedPeople.length ||
      (scenario === "marked_and_inferred" && row.inferredPeople.length),
  );
  const coverage = report.coverage.filter(
    (row) =>
      `${row.subject} ${row.curriculum} ${row.level} ${row.examPrep ?? ""} ${names(row.currentPeople).join(" ")}`
        .toLowerCase()
        .includes(query.toLowerCase()) &&
      (filter === "all" ||
        (affected(row, scenario) &&
          (filter === "affected" ||
            remaining(row, scenario).length === (filter === "zero" ? 0 : 1)))),
  );
  const retainedCurrent = report.people.filter(
    (p) =>
      p.currentRoster &&
      p.category !== "staff" &&
      !p.marked &&
      !(
        scenario === "marked_and_inferred" &&
        p.category === "inferred_very_likely_unmarked"
      ),
  ).length;
  const checked = new Intl.DateTimeFormat("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "Asia/Bangkok",
  }).format(new Date(report.snapshotCreatedAt));
  const courseCounts = (course: AnalyticsReport["courses"][number]) => ({
    near:
      course.markedUpcomingSessions30Days +
      (scenario === "marked_and_inferred"
        ? course.inferredUpcomingSessions30Days
        : 0),
    all:
      course.markedUpcomingSessionsAllTime +
      (scenario === "marked_and_inferred"
        ? course.inferredUpcomingSessionsAllTime
        : 0),
  });
  const matchedCourses = courses.filter(
    (course) =>
      (courseFilter === "all" || courseCounts(course).all > 0) &&
      `${course.title ?? ""} ${course.wiseCourseCategory ?? ""} ${names(course.personKeys).join(" ")}`
        .toLowerCase()
        .includes(courseQuery.toLowerCase()),
  );
  const futureCourses = courses.filter(
    (course) => courseCounts(course).all > 0,
  );
  const courseTotalNear = courses.reduce(
    (sum, course) => sum + courseCounts(course).near,
    0,
  );
  const courseTotalAll = courses.reduce(
    (sum, course) => sum + courseCounts(course).all,
    0,
  );
  const maxMonthly = Math.max(
    1,
    ...report.monthly.map((month) => month.teachingPeople),
  );
  return (
    <div className="mt-4 space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold">
            {contextOnly
              ? "Departure planning context"
              : "Tutor and staff departures"}
          </h2>
          <p className="mt-1 text-xs text-muted-foreground">{`Teaching history since ${formatDayYear(report.historyStart)} · snapshot ${checked} Bangkok`}</p>
        </div>
        <label className="flex flex-col gap-1 text-xs font-medium">
          Departure scenario
          <select
            className="h-9 max-w-full rounded-md border bg-background px-2 text-sm"
            value={scenario}
            onChange={(e) => setScenario(e.target.value as AnalyticsScenario)}
          >
            <option value="marked">Sheet markings</option>
            <option value="marked_and_inferred">
              Sheet markings + unmarked very likely gone
            </option>
          </select>
        </label>
      </div>
      <p className="text-xs text-muted-foreground">{`${retainedCurrent} current roster tutors would remain in this scenario. This is a planning comparison; sheet markings may still be pending.`}</p>
      {!report.freshness.ok || report.terminationSource.status !== "ready" ? (
        <Panel className="border-amber-300 px-4 py-3 text-xs text-amber-800 dark:text-amber-200">
          {!report.freshness.ok ? "Some teaching data is out of date. " : ""}
          {report.terminationSource.status !== "ready"
            ? "Sheet markings are unavailable or out of date; treat the departure scenario as provisional."
            : "Treat this analysis as provisional."}
        </Panel>
      ) : null}
      {!contextOnly ? (
        <>
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            <Metric
              label="Current roster"
              value={number(report.totals.rosterTutors)}
              detail={`${number(report.totals.fullTimeTutors)} full-time tutors included; Wise staff counted separately`}
            />
            <Metric
              label="Demonstrated teaching"
              value={number(report.totals.historicalTeachingPeople)}
              detail={`Tutors with ended classes since 1 March; ${number(report.totals.historicalOffRosterPeople)} are off the current roster`}
            />
            <Metric
              label="Marked for termination"
              value={number(report.totals.markedTutors)}
              detail={`${number(report.totals.markedPendingClasses)} still have upcoming classes`}
            />
            <Metric
              label="Unmarked · very likely gone"
              value={number(report.totals.inferredVeryLikely)}
              detail="An inactivity estimate; departure has not been confirmed"
            />
          </div>
          <Panel className="px-4 py-4">
            <Upper>
              {scenario === "marked"
                ? "Teaching cohort marked for departure"
                : "Teaching cohort in expanded departure scenario"}
            </Upper>
            <div className="mt-2 flex flex-wrap items-baseline gap-3">
              <p className="text-2xl font-semibold tabular-nums">{share}</p>
              <p className="text-sm tabular-nums">{`${numerator} ÷ ${report.turnover.denominator} × 100 = ${share}`}</p>
            </div>
            <p className="mt-2 text-xs text-muted-foreground">
              Scenario tutors who taught since 1 March ÷ all tutors who taught
              in that period. This is a departure planning estimate. Sheet
              markings may be pending, and inactivity does not confirm an exit.
            </p>
            <p className="mt-2 text-xs">
              <strong>HR turnover rate is unavailable.</strong>
              {` ${report.turnover.unavailableReason}`}
            </p>
          </Panel>
          <Panel className="px-4 py-3">
            <Upper>Staff evidence</Upper>
            <p className="mt-2 text-sm">{`${report.totals.staff} current Wise staff accounts · ${report.people.filter((p) => p.category === "staff" && p.marked).length} marked for termination`}</p>
            <p className="mt-1 text-xs text-muted-foreground">
              Staff are separate from the tutor teaching cohort. Wise roles and
              sheet markings do not establish historical staffing levels or a
              staff turnover rate.
            </p>
          </Panel>
        </>
      ) : (
        <p className="text-xs text-muted-foreground">
          This original tutor-only departure scenario uses history since March
          and its own scenario selector. Workforce filters above do not apply
          here. Inactivity estimates do not establish a completed departure.
        </p>
      )}
      <Disclosure
        title="People by departure evidence"
        count={report.people.length}
      >
        <div className="grid gap-4 px-4 py-4 sm:grid-cols-2 lg:grid-cols-3">
          {(Object.keys(CATEGORY) as AnalyticsCategory[]).map((category) => {
            const people = report.people.filter((p) => p.category === category);
            return (
              <div key={category}>
                <p className="text-xs font-semibold">{`${CATEGORY[category]} · ${people.length}`}</p>
                <p className="mt-1 text-xs text-muted-foreground [overflow-wrap:anywhere]">
                  {people.length
                    ? people
                        .map(
                          (p) =>
                            `${p.displayName}${category === "staff" && p.marked ? " (marked for termination)" : ""}${p.fullTime ? " (full-time)" : ""}${p.currentRoster ? "" : " (off roster)"}`,
                        )
                        .join(", ")
                    : "None"}
                </p>
              </div>
            );
          })}
        </div>
      </Disclosure>
      {pending.length ? (
        <Panel className="px-4 py-4">
          <h3 className="text-sm font-semibold">
            Pending departures with classes
          </h3>
          <p className="mt-1 text-xs text-muted-foreground">
            These sheet markings still need a class handover. Counts show the
            next 30 days and all stored future dates.
          </p>
          <ul className="mt-3 divide-y">
            {pending.map((p) => (
              <li
                key={p.canonicalKey}
                className="flex flex-wrap items-center justify-between gap-2 py-2 text-xs"
              >
                <span className="font-medium [overflow-wrap:anywhere]">
                  {p.displayName}
                </span>
                <span className="tabular-nums">{`${number(p.upcomingSessions30Days)} next 30 days · ${number(p.upcomingSessionsAllTime)} all stored future`}</span>
              </li>
            ))}
          </ul>
        </Panel>
      ) : null}
      <Panel>
        <div className="border-b px-4 py-3">
          <h3 className="text-sm font-semibold">Tutors teaching each month</h3>
          <p className="mt-1 text-xs text-muted-foreground">
            Unique tutors with ended classes. Monthly counts show activity and
            do not measure hires or confirmed exits.
          </p>
        </div>
        <div className="space-y-2 px-4 py-3">
          {report.monthly.map((month) => (
            <div
              key={month.month}
              className="grid grid-cols-[4.5rem_1fr_2.5rem] items-center gap-2 text-xs"
            >
              <span>
                {new Intl.DateTimeFormat("en-GB", {
                  month: "short",
                  year: "2-digit",
                  timeZone: "Asia/Bangkok",
                }).format(new Date(`${month.month}-01T00:00:00Z`))}
              </span>
              <div className="min-w-0">
                <div className="h-2 rounded bg-muted">
                  <div
                    className="h-2 rounded bg-primary/70"
                    style={{
                      width: `${(month.teachingPeople / maxMonthly) * 100}%`,
                    }}
                  />
                </div>
                <p className="mt-1 text-[10px] text-muted-foreground">
                  {`${number(month.endedSessions)} ended classes`}
                  {month.partial ? " · Partial month" : ""}
                </p>
              </div>
              <strong className="text-right tabular-nums">
                {month.teachingPeople}
              </strong>
            </div>
          ))}
        </div>
      </Panel>
      <Panel>
        <div className="border-b px-4 py-3">
          <h3 className="text-sm font-semibold">
            Subject and level combinations
          </h3>
          <p className="mt-1 text-xs text-muted-foreground">{`${affectedRows.length} affected combinations · ${zero} with no recorded matches left · ${one} with one recorded match left`}</p>
          <p className="mt-2 text-xs text-muted-foreground">
            Qualifications do not establish availability. Teaching columns show
            any-subject activity by these tutors, rather than proof they taught
            this particular subject.
          </p>
          <p className="mt-2 text-xs text-amber-800 dark:text-amber-200">{`${report.totals.missingQualifications} current tutors have no mapped qualifications. Their subject coverage is unknown, so an empty match does not prove no tutor can teach it.`}</p>
        </div>
        <div className="flex flex-wrap gap-2 px-4 py-3">
          <Input
            className="min-w-0 flex-1 basis-52"
            aria-label="Filter qualifications by subject, level or tutor"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Subject, curriculum, level or tutor"
          />
          <select
            aria-label="Qualification coverage filter"
            className="h-9 rounded-md border bg-background px-2 text-xs"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
          >
            <option value="affected">Affected combinations</option>
            <option value="all">All qualifications</option>
            <option value="zero">No recorded matches left</option>
            <option value="one">One recorded match left</option>
          </select>
          <Button
            size="sm"
            variant="outline"
            onClick={() =>
              download(coverageCsv(report, scenario), "tutor-coverage.csv")
            }
          >
            Export coverage
          </Button>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[720px] table-fixed text-xs [&_td]:align-top">
            <thead className="border-y text-muted-foreground">
              <tr>
                {[
                  "Academic subject / level",
                  "Current qualified",
                  "Qualified after scenario",
                  "Any-subject teaching · last 30 days",
                  "Any-subject teaching · next 30 days",
                ].map((label, index) => (
                  <th
                    key={label}
                    className={`px-4 py-2 text-left font-medium ${index === 0 ? "w-[30%]" : ""}`}
                  >
                    {label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {coverage.map((row, index) => {
                const left = remaining(row, scenario);
                const recent = left.filter((key) =>
                  row.recentTeachingPeople.includes(key),
                );
                const upcoming = left.filter((key) =>
                  row.upcomingTeachingPeople.includes(key),
                );
                return (
                  <tr
                    key={`${row.subject}:${row.curriculum}:${row.level}:${row.examPrep}:${index}`}
                    className="border-b"
                  >
                    <td className="px-4 py-3 [overflow-wrap:anywhere]">
                      <p className="font-medium">{row.subject}</p>
                      <p className="mt-1 text-muted-foreground">{`${row.curriculum} · ${row.level}${row.examPrep ? ` · ${row.examPrep}` : ""}`}</p>
                      <details className="mt-2">
                        <summary className="cursor-pointer text-muted-foreground">
                          Tutor names
                        </summary>
                        <p className="mt-1">{`Departing: ${names(departureKeys(row, scenario)).join(", ") || "None"}`}</p>
                        <p className="mt-1">{`Remaining qualified: ${names(left).join(", ") || "None"}`}</p>
                        <p className="mt-1">{`Recent teaching: ${names(recent).join(", ") || "None"}`}</p>
                        <p className="mt-1">{`Upcoming teaching: ${names(upcoming).join(", ") || "None"}`}</p>
                      </details>
                    </td>
                    <td className="px-4 py-3 tabular-nums">
                      {row.currentPeople.length}
                    </td>
                    <td className="px-4 py-3">
                      <p className="font-semibold tabular-nums">
                        {left.length}
                      </p>
                      {left.length <= 1 ? (
                        <p className="mt-1 text-[10px] text-amber-800 dark:text-amber-200">
                          {left.length === 0
                            ? "No recorded qualification matches remain"
                            : "One recorded qualification match remains"}
                        </p>
                      ) : null}
                    </td>
                    <td className="px-4 py-3 tabular-nums">{recent.length}</td>
                    <td className="px-4 py-3 tabular-nums">
                      {upcoming.length}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        {coverage.length === 0 ? (
          <p className="px-4 py-4 text-sm text-muted-foreground">
            No qualifications match this filter.
          </p>
        ) : null}
      </Panel>
      <Panel>
        <div className="border-b px-4 py-3">
          <h3 className="text-sm font-semibold">
            Courses needing a departure review
          </h3>
          <p className="mt-1 text-sm">{`${new Set(futureCourses.flatMap((course) => (course.wiseClassId ? [course.wiseClassId] : []))).size} courses · ${number(courseTotalNear)} departing-assigned classes next 30 days · ${number(courseTotalAll)} all stored future`}</p>
          <p className="mt-1 text-xs text-muted-foreground">
            Actual stored classes linked to this scenario. Upcoming counts
            include only classes assigned to the selected departure scenario.
            Historical class counts include all tutors in the course. Wise
            course category describes a pricing/course group.
          </p>
          <p className="mt-1 text-xs text-muted-foreground">{`Classes through ${formatDayYear(report.upcomingWindowEnd)} are the next 30 days. All stored future dates extend to ${report.futureHorizonEnd ? formatDayYear(report.futureHorizonEnd) : "an unknown horizon"}.`}</p>
        </div>
        <div className="flex flex-wrap gap-2 border-b px-4 py-3">
          <Input
            aria-label="Search affected courses"
            className="min-w-0 flex-1 basis-48"
            value={courseQuery}
            onChange={(e) => setCourseQuery(e.target.value)}
            placeholder="Course title, category or tutor"
          />
          <select
            aria-label="Course evidence filter"
            className="h-9 rounded-md border bg-background px-2 text-xs"
            value={courseFilter}
            onChange={(e) => setCourseFilter(e.target.value)}
          >
            <option value="future">Upcoming classes needing review</option>
            <option value="all">Include historical courses</option>
          </select>
        </div>
        <div className="divide-y">
          {matchedCourses.map((course, index) => (
            <div
              key={`${course.wiseClassId}:${index}`}
              className="px-4 py-3 text-xs [overflow-wrap:anywhere]"
            >
              <p className="font-medium">
                {course.title ?? "Class title not recorded"}
              </p>
              <p className="mt-1 text-muted-foreground">{`Wise course category: ${course.wiseCourseCategory ?? "Not recorded"}`}</p>
              <p className="mt-1">{`Scenario tutors: ${names([...new Set([...course.markedPeople, ...(scenario === "marked_and_inferred" ? course.inferredPeople : [])])]).join(", ")}`}</p>
              <div className="mt-2 flex flex-wrap gap-2">
                <Tag>{`${number(courseCounts(course).near)} next 30 days`}</Tag>
                <Tag>{`${number(courseCounts(course).all)} All stored future`}</Tag>
                <Tag>{`${number(course.endedSessionsSinceMarch)} ended since March · all tutors`}</Tag>
              </div>
              <p className="mt-2 text-muted-foreground">{`Other historical teachers: ${names(course.otherHistoricalPeople).join(", ") || "None recorded"}. Historical teaching does not confirm a handover.`}</p>
            </div>
          ))}
        </div>
        {matchedCourses.length === 0 ? (
          <p className="px-4 py-4 text-sm text-muted-foreground">
            No stored courses match this departure scenario.
          </p>
        ) : null}
      </Panel>
      <Disclosure title="Data limits and evidence">
        <div className="space-y-2 px-4 py-4 text-xs text-muted-foreground">
          <p>{`${report.totals.missingQualifications} tutors without mapped qualifications · ${report.totals.identityConflicts} identity conflicts · ${report.totals.unresolvedHistoricalSessions} historical classes without a resolved tutor · ${report.totals.missingFutureCourseIds} future classes without a course ID · ${report.totals.conflictingSessionAssignments} conflicting class assignments`}</p>
          <ul className="list-disc space-y-1 pl-4">
            {report.limitations.map((text, i) => (
              <li key={i}>{text}</li>
            ))}
          </ul>
          <Button
            size="sm"
            variant="outline"
            onClick={() =>
              download(peopleCsv(report), "tutor-departure-evidence.csv")
            }
          >
            Export people and counts
          </Button>
        </div>
      </Disclosure>
    </div>
  );
}

export function AnalyticsTab({
  initial,
  initialError = null,
  initialWorkforce,
}: {
  initialWorkforce?: WorkforceReport;
  initial?: TutorOffboardingAnalytics;
  initialError?: string | null;
}) {
  const [report, setReport] = useState<TutorOffboardingAnalytics | null>(
    initial ?? null,
  );
  const [error, setError] = useState<string | null>(initialError);
  const [busy, setBusy] = useState(false);
  const load = useCallback(async (signal?: AbortSignal) => {
    setBusy(true);
    try {
      setReport(await fetchAnalytics(fetch, signal));
      setError(null);
    } catch (failure) {
      if (!signal?.aborted)
        setError(
          failure instanceof Error
            ? failure.message
            : "Analytics could not load.",
        );
    } finally {
      if (!signal?.aborted) setBusy(false);
    }
  }, []);
  useEffect(() => {
    if (initial !== undefined) return;
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [initial, load]);
  return (
    <section aria-label="Tutor offboarding analytics">
      <WorkforceTab initial={initialWorkforce} />
      <details className="mt-5 rounded-[10px] border bg-card p-4">
        <summary className="cursor-pointer text-sm font-semibold focus-visible:outline-2">
          Departure planning context and affected courses
        </summary>
        <div className="mt-4 flex justify-end">
          <Button
            variant="outline"
            size="sm"
            disabled={busy}
            onClick={() => void load()}
          >
            {busy ? "Loading analytics…" : "Refresh analytics"}
          </Button>
        </div>
        {error ? (
          <p role="alert" className="mt-3 text-sm text-conflict">
            {error}
          </p>
        ) : null}
        {!report && !error ? (
          <Panel className="mt-4 px-4 py-5 text-sm text-muted-foreground">
            Loading tutor and course evidence…
          </Panel>
        ) : null}
        {report?.available ? (
          <AnalyticsContent report={report} contextOnly />
        ) : report ? (
          <Panel className="mt-4 px-4 py-5 text-sm text-muted-foreground">
            {UNAVAILABLE[report.reason]}
          </Panel>
        ) : null}
      </details>
    </section>
  );
}
