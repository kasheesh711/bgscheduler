import { bangkokDateKey } from "@/lib/room-capacity/dates";
import { buildCalibrationCurve, HISTORY_START } from "./calibration";
import { evaluateFreshness, openDecisionsByKey } from "./data";
import { scorePerson } from "./score";
import {
  buildTerminationMatches,
  type TerminationSnapshot,
} from "./termination-source";
import type {
  DecisionRecord,
  FeedTimestamps,
  OffboardingSignals,
  PersonSignals,
} from "./types";
import type {
  AnalyticsCategory,
  AnalyticsCourseImpact,
  AnalyticsPerson,
  AnalyticsQualification,
  AnalyticsReport,
  AnalyticsSession,
} from "./analytics-types";

interface HistoryPerson {
  canonicalKey: string;
  lastAt: string;
  months: Array<{ month: string; sessions: number }>;
}
interface HistoryCourse {
  key: string;
  wiseClassId: string | null;
  title: string | null;
  wiseCourseCategory: string | null;
  people: Array<{ canonicalKey: string; sessions: number }>;
}
interface FutureCourse {
  key: string;
  wiseClassId: string | null;
  title: string | null;
  wiseCourseCategory: string | null;
  sessions: Array<{
    canonicalKey: string;
    startAt: string;
    endAt: string | null;
  }>;
}
export interface AnalyticsCompiledEvidence {
  signals: OffboardingSignals;
  catalog: PersonSignals[];
  qualifications: AnalyticsQualification[];
  historyPeople: HistoryPerson[];
  historyCourses: HistoryCourse[];
  futureCourses: FutureCourse[];
  unresolvedHistoricalSessions: number;
  conflictingSessionAssignments: number;
}
function distinctSessions(rows: AnalyticsSession[]): {
  sessions: AnalyticsSession[];
  unresolved: number;
  conflicts: number;
} {
  const byId = new Map<string, AnalyticsSession[]>();
  for (const row of rows) {
    const bucket = byId.get(row.wiseSessionId) ?? [];
    bucket.push(row);
    byId.set(row.wiseSessionId, bucket);
  }
  const sessions: AnalyticsSession[] = [];
  let unresolved = 0;
  let conflicts = 0;
  for (const bucket of byId.values()) {
    const keys = [
      ...new Set(
        bucket.flatMap((r) => (r.canonicalKey ? [r.canonicalKey] : [])),
      ),
    ];
    if (keys.length !== 1) {
      unresolved++;
      if (keys.length > 1) conflicts++;
      continue;
    }
    sessions.push({
      ...bucket[0],
      canonicalKey: keys[0],
      wiseClassId: bucket.find((r) => r.wiseClassId)?.wiseClassId ?? null,
      title: bucket.find((r) => r.title)?.title ?? null,
      wiseCourseCategory:
        bucket.find((r) => r.wiseCourseCategory)?.wiseCourseCategory ?? null,
    });
  }
  return { sessions, unresolved, conflicts };
}
/** Compact and deduplicate once per snapshot/feed watermark; this contains no student fields. */
export function compileAnalyticsEvidence(input: {
  signals: OffboardingSignals;
  catalog: PersonSignals[];
  qualifications: AnalyticsQualification[];
  history: AnalyticsSession[];
  upcoming: AnalyticsSession[];
}): AnalyticsCompiledEvidence {
  const history = distinctSessions(input.history);
  const future = distinctSessions(input.upcoming);
  const people = new Map<
    string,
    { lastAt: string; months: Map<string, number> }
  >();
  const courses = new Map<string, HistoryCourse>();
  const futureCourses = new Map<string, FutureCourse>();
  for (const session of history.sessions) {
    const key = session.canonicalKey!;
    const month = bangkokDateKey(new Date(session.startAt)).slice(0, 7);
    const person = people.get(key) ?? {
      lastAt: session.startAt,
      months: new Map(),
    };
    if (session.startAt > person.lastAt) person.lastAt = session.startAt;
    person.months.set(month, (person.months.get(month) ?? 0) + 1);
    people.set(key, person);
    const courseKey = session.wiseClassId ?? `missing:${session.wiseSessionId}`;
    const course = courses.get(courseKey) ?? {
      key: courseKey,
      wiseClassId: session.wiseClassId,
      title: session.title,
      wiseCourseCategory: session.wiseCourseCategory,
      people: [],
    };
    course.title ??= session.title;
    course.wiseCourseCategory ??= session.wiseCourseCategory;
    const teacher = course.people.find((p) => p.canonicalKey === key);
    if (teacher) teacher.sessions++;
    else course.people.push({ canonicalKey: key, sessions: 1 });
    courses.set(courseKey, course);
  }
  for (const session of future.sessions) {
    const key = session.wiseClassId ?? `missing:${session.wiseSessionId}`;
    const course = futureCourses.get(key) ?? {
      key,
      wiseClassId: session.wiseClassId,
      title: session.title,
      wiseCourseCategory: session.wiseCourseCategory,
      sessions: [],
    };
    course.title ??= session.title;
    course.wiseCourseCategory ??= session.wiseCourseCategory;
    course.sessions.push({
      canonicalKey: session.canonicalKey!,
      startAt: session.startAt,
      endAt: session.endAt,
    });
    futureCourses.set(key, course);
  }
  const qualifications = [
    ...new Map(
      input.qualifications.map((q) => [JSON.stringify(q), q]),
    ).values(),
  ];
  return {
    signals: input.signals,
    catalog: input.catalog,
    qualifications,
    historyPeople: [...people].map(([canonicalKey, p]) => ({
      canonicalKey,
      lastAt: p.lastAt,
      months: [...p.months].map(([month, sessions]) => ({ month, sessions })),
    })),
    historyCourses: [...courses.values()],
    futureCourses: [...futureCourses.values()],
    unresolvedHistoricalSessions: history.unresolved,
    conflictingSessionAssignments: history.conflicts + future.conflicts,
  };
}
const sorted = (keys: Iterable<string>) => [...new Set(keys)].sort();
export function buildTutorOffboardingAnalytics(input: {
  evidence: AnalyticsCompiledEvidence;
  feeds: FeedTimestamps;
  decisions: DecisionRecord[];
  terminationSnapshot: TerminationSnapshot;
  now: Date;
}): AnalyticsReport {
  const { evidence, now } = input;
  const { signals } = evidence;
  const windowEnd = new Date(now.getTime() + 30 * 86_400_000);
  const recentStart = new Date(now.getTime() - 30 * 86_400_000);
  const freshness = evaluateFreshness(input.feeds, now);
  if (signals.snapshotCreatedAt !== input.feeds.tutorSnapshot) {
    freshness.ok = false;
    freshness.feeds.find((f) => f.key === "tutorSnapshot")!.fresh = false;
  }
  const population = new Map(evidence.catalog.map((p) => [p.canonicalKey, p]));
  for (const p of signals.people) population.set(p.canonicalKey, p);
  const staff = new Set(
    [...population.values()]
      .filter((p) => p.accounts.some((a) => a.relation === "ADMIN"))
      .map((p) => p.canonicalKey),
  );
  const currentKeys = new Set(signals.people.map((p) => p.canonicalKey));
  const termination = buildTerminationMatches(
    [...population.values()],
    input.terminationSnapshot,
    now,
  );
  const allMarked = new Set(Object.keys(termination.byKey));
  const marked = new Set([...allMarked].filter((k) => !staff.has(k)));
  const taught = new Map(
    evidence.historyPeople
      .filter((p) => !staff.has(p.canonicalKey))
      .map((p) => [p.canonicalKey, p]),
  );
  const open = openDecisionsByKey(input.decisions, now);
  const curve = buildCalibrationCurve(
    new Map(Object.entries(signals.taughtDates)),
    bangkokDateKey(now),
  );
  const inferred = new Set<string>();
  const people: AnalyticsPerson[] = [];
  const futureSessions = evidence.futureCourses
    .flatMap((c) => c.sessions)
    .filter((s) => Date.parse(s.endAt ?? s.startAt) > now.getTime());
  const inWindow = (s: { startAt: string }) =>
    Date.parse(s.startAt) < windowEnd.getTime();
  for (const key of sorted([...population.keys(), ...taught.keys()])) {
    const person = population.get(key);
    const current = currentKeys.has(key);
    const score =
      person && current
        ? scorePerson(person, {
            now,
            curve,
            snoozedKeys: new Set(open.keys()),
            freshnessOk: freshness.ok,
          })
        : null;
    const upcoming = futureSessions.filter((s) => s.canonicalKey === key);
    const isMarked = allMarked.has(key);
    let category: AnalyticsCategory = "retained";
    if (staff.has(key)) category = "staff";
    else if (isMarked)
      category =
        upcoming.length || person?.upcomingSessions
          ? "marked_pending_classes"
          : "marked_no_upcoming";
    else if (score?.band === "very_likely_gone" && !score.exclusion) {
      category = "inferred_very_likely_unmarked";
      inferred.add(key);
    } else if (score?.band === "likely_gone" && !score.exclusion)
      category = "likely_unmarked";
    else if (score?.band === "unclear" && !score.exclusion)
      category = "unclear_unmarked";
    people.push({
      canonicalKey: key,
      displayName: person?.displayName ?? key,
      category,
      currentRoster: current,
      marked: isMarked,
      fullTime: person?.fullTime ?? false,
      likelihood: score?.likelihood ?? null,
      lastTaughtAt: taught.get(key)?.lastAt ?? null,
      taughtSinceMarch: taught.has(key),
      upcomingSessions30Days: upcoming.filter(inWindow).length,
      upcomingSessionsAllTime: upcoming.length,
      nextSessionAt: upcoming.map((s) => s.startAt).sort()[0] ?? null,
      capabilitiesKnown:
        current && evidence.qualifications.some((q) => q.canonicalKey === key),
      identityConflict:
        person?.accounts.some((a) => a.status === "identity_conflict") ?? false,
    });
  }
  const expanded = new Set([...marked, ...inferred]);
  const tutorPeople = people.filter((p) => p.category !== "staff");
  const monthly = [];
  const currentMonth = bangkokDateKey(now).slice(0, 7);
  for (let month = "2026-03"; month <= currentMonth; ) {
    const observed = [...taught.values()].filter((p) =>
      p.months.some((m) => m.month === month),
    );
    monthly.push({
      month,
      teachingPeople: observed.length,
      endedSessions: observed.reduce(
        (n, p) => n + (p.months.find((m) => m.month === month)?.sessions ?? 0),
        0,
      ),
      partial: month === currentMonth,
    });
    const [year, m] = month.split("-").map(Number);
    month =
      m === 12 ? `${year + 1}-01` : `${year}-${String(m + 1).padStart(2, "0")}`;
  }
  const cells = new Map<string, typeof evidence.qualifications>();
  for (const q of evidence.qualifications.filter(
    (q) => currentKeys.has(q.canonicalKey) && !staff.has(q.canonicalKey),
  )) {
    const key = JSON.stringify([q.subject, q.curriculum, q.level, q.examPrep]);
    const bucket = cells.get(key) ?? [];
    bucket.push(q);
    cells.set(key, bucket);
  }
  const coverage = [...cells.values()]
    .map((bucket) => {
      const q = bucket[0];
      const keys = sorted(bucket.map((q) => q.canonicalKey));
      return {
        subject: q.subject,
        curriculum: q.curriculum,
        level: q.level,
        examPrep: q.examPrep,
        currentPeople: keys,
        markedPeople: keys.filter((k) => marked.has(k)),
        inferredPeople: keys.filter((k) => inferred.has(k)),
        remainingAfterMarked: keys.filter((k) => !marked.has(k)),
        remainingAfterMarkedAndInferred: keys.filter((k) => !expanded.has(k)),
        recentTeachingPeople: keys.filter(
          (k) =>
            Date.parse(taught.get(k)?.lastAt ?? "") >= recentStart.getTime(),
        ),
        upcomingTeachingPeople: keys.filter((k) =>
          futureSessions.some((s) => s.canonicalKey === k && inWindow(s)),
        ),
      };
    })
    .sort(
      (a, b) =>
        a.subject.localeCompare(b.subject) ||
        a.curriculum.localeCompare(b.curriculum) ||
        a.level.localeCompare(b.level),
    );
  const courses: AnalyticsCourseImpact[] = [];
  const allCourseKeys = sorted([
    ...evidence.historyCourses.map((c) => c.key),
    ...evidence.futureCourses.map((c) => c.key),
  ]);
  for (const key of allCourseKeys) {
    const history = evidence.historyCourses.find((c) => c.key === key);
    const future = evidence.futureCourses.find((c) => c.key === key);
    const sessions = (future?.sessions ?? []).filter(
      (s) =>
        !staff.has(s.canonicalKey) &&
        Date.parse(s.endAt ?? s.startAt) > now.getTime(),
    );
    const keys = sorted(
      [
        ...(history?.people ?? []).map((p) => p.canonicalKey),
        ...sessions.map((s) => s.canonicalKey),
      ].filter((k) => !staff.has(k)),
    );
    if (!keys.some((k) => expanded.has(k))) continue;
    const affected = sessions.filter((s) => expanded.has(s.canonicalKey));
    const markedSessions = affected.filter((s) => marked.has(s.canonicalKey));
    const inferredSessions = affected.filter((s) =>
      inferred.has(s.canonicalKey),
    );
    const dates = affected.map((s) => s.startAt).sort();
    courses.push({
      wiseClassId: future?.wiseClassId ?? history?.wiseClassId ?? null,
      title: future?.title ?? history?.title ?? null,
      wiseCourseCategory:
        future?.wiseCourseCategory ?? history?.wiseCourseCategory ?? null,
      personKeys: keys,
      markedPeople: keys.filter((k) => marked.has(k)),
      inferredPeople: keys.filter((k) => inferred.has(k)),
      upcomingSessions30Days: affected.filter(inWindow).length,
      upcomingSessionsAllTime: affected.length,
      markedUpcomingSessions30Days: markedSessions.filter(inWindow).length,
      markedUpcomingSessionsAllTime: markedSessions.length,
      inferredUpcomingSessions30Days: inferredSessions.filter(inWindow).length,
      inferredUpcomingSessionsAllTime: inferredSessions.length,
      firstUpcomingAt: dates[0] ?? null,
      lastUpcomingAt: dates.at(-1) ?? null,
      endedSessionsSinceMarch: (history?.people ?? [])
        .filter((p) => !staff.has(p.canonicalKey))
        .reduce((n, p) => n + p.sessions, 0),
      otherHistoricalPeople: sorted(
        (history?.people ?? [])
          .map((p) => p.canonicalKey)
          .filter((k) => !staff.has(k) && !expanded.has(k)),
      ),
    });
  }
  courses.sort(
    (a, b) =>
      b.upcomingSessions30Days - a.upcomingSessions30Days ||
      b.endedSessionsSinceMarch - a.endedSessionsSinceMarch,
  );
  const markedNumerator = [...taught.keys()].filter((k) =>
    marked.has(k),
  ).length;
  const expandedNumerator = [...taught.keys()].filter((k) =>
    expanded.has(k),
  ).length;
  const limitations = [
    "Actual HR turnover is unavailable: effective separation dates and opening employment headcount are not recorded. Sheet marks and last teaching dates are not separation dates.",
    "Qualification counts describe current roster matches, not available teaching capacity. Missing qualifications are unknown, not zero capability; historical qualification snapshots are not retained since March.",
    "Monthly counts use confirmed ENDED sessions across stored history, deduplicated by Wise session ID. The current month is partial; teaching gaps can be seasonal.",
    "Course categories are Wise pricing bands, not academic subjects. Upcoming impact counts include only assignments to the selected departure cohort. Historical session totals describe the whole course; other historical tutors are not proven available replacements.",
  ];
  if (termination.source.status !== "ready")
    limitations.push(
      `Termination source is ${termination.source.status}; marked scenarios use the last saved evidence and require review.`,
    );
  if (!freshness.ok)
    limitations.push(
      "One or more feeds are stale or missing; current coverage and departure scenarios are provisional.",
    );
  if (tutorPeople.some((p) => p.identityConflict))
    limitations.push(
      "Identity conflicts remain in the roster match inventory and need review before interpreting coverage.",
    );
  if (
    [...population.values()].some((p) =>
      p.accounts.some((a) => a.relation === null),
    )
  )
    limitations.push(
      "Some Wise account roles are unknown; staff exclusion may be incomplete.",
    );
  return {
    available: true,
    servedAt: now.toISOString(),
    historyStart: HISTORY_START.toISOString(),
    snapshotCreatedAt: signals.snapshotCreatedAt,
    upcomingWindowEnd: windowEnd.toISOString(),
    futureHorizonEnd:
      futureSessions
        .map((s) => s.startAt)
        .sort()
        .at(-1) ?? null,
    freshness,
    terminationSource: termination.source,
    totals: {
      rosterTutors: tutorPeople.filter((p) => p.currentRoster).length,
      staff: people.filter((p) => p.currentRoster && p.category === "staff")
        .length,
      fullTimeTutors: tutorPeople.filter((p) => p.currentRoster && p.fullTime)
        .length,
      historicalTeachingPeople: taught.size,
      historicalOffRosterPeople: [...taught.keys()].filter(
        (k) => !currentKeys.has(k),
      ).length,
      markedTutors: tutorPeople.filter((p) => p.currentRoster && p.marked)
        .length,
      markedPendingClasses: tutorPeople.filter(
        (p) => p.currentRoster && p.category === "marked_pending_classes",
      ).length,
      inferredVeryLikely: inferred.size,
      missingQualifications: tutorPeople.filter(
        (p) => p.currentRoster && !p.capabilitiesKnown,
      ).length,
      identityConflicts: tutorPeople.filter(
        (p) => p.currentRoster && p.identityConflict,
      ).length,
      unresolvedHistoricalSessions: evidence.unresolvedHistoricalSessions,
      missingFutureCourseIds: evidence.futureCourses.filter(
        (c) => !c.wiseClassId,
      ).length,
      conflictingSessionAssignments: evidence.conflictingSessionAssignments,
    },
    turnover: {
      actualRate: null,
      unavailableReason:
        "Effective separation dates and opening employment headcount are unavailable.",
      denominator: taught.size,
      markedNumerator,
      markedShare: taught.size ? (100 * markedNumerator) / taught.size : null,
      markedAndInferredNumerator: expandedNumerator,
      markedAndInferredShare: taught.size
        ? (100 * expandedNumerator) / taught.size
        : null,
    },
    monthly,
    people,
    coverage,
    courses,
    limitations,
  };
}
