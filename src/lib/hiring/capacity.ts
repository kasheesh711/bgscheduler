// ----------------------------------------------------------------------------
// Hiring capacity — tutor utilization for the next 4 weeks, from the current
// Wise snapshot (owner decisions, 17 November 2026):
//
//   CAP-01  Shared pool. A tutor's hours are one pool for all their subjects.
//           A Physics class also uses the Maths hour of a Maths-and-Physics
//           tutor. Subject rows overlap; they do not add up to the total.
//   CAP-02  Forward view. 28 Bangkok days from tomorrow, shown per week.
//           Today is left out: its past classes are not in the snapshot.
//   CAP-03  Separate numbers. This does not read the Tutor Offboarding
//           workforce history, so the two screens can differ.
//   CAP-04  Fail closed. A tutor with an identity or completeness issue is
//           listed for review and is not in any total.
// ----------------------------------------------------------------------------
import { type Database, getDb } from "@/lib/db";
import { ensureIndex, type IndexedTutorGroup } from "@/lib/search/index";
import {
  intersectIntervals,
  intervalMinutes,
  subtractIntervals,
  type Interval,
} from "@/lib/tutor-offboarding/workforce/intervals";
import { interpretSnapshotSessionInterval } from "@/lib/tutor-offboarding/workforce/snapshot-timezone";
import { indexIsStale } from "./availability";
import { instant, localDate, shiftDate, type HiringConfig, type Subject } from "./model";
import { fullPriority } from "./rules";

export const CAPACITY_WEEKS = 4;
const DAY = 86_400_000;
const MINUTE = 60_000;

/** Wise teacher-tag subject → the Hiring subject it recruits for. A tag with no entry has no Hiring subject. */
const HIRING_SUBJECT: Record<string, Subject> = {
  Math: "Mathematics",
  Physics: "Physics",
  Chemistry: "Chemistry",
  Biology: "Biology",
  ComSci: "Computer Science",
  EFL: "EFL/ESL",
  ESL: "EFL/ESL",
  Literature: "English Literature",
  Econ: "Economics",
  Bus: "Business Studies",
  Psych: "Psychology",
  Geo: "Geography",
  History: "History",
  Thai: "Thai",
};
/**
 * Class-title words that do not start with the tag, most specific first.
 * Generic "English" is EFL (owner decision, 1 October 2026).
 */
const TITLE_ALIASES: [string, string[]][] = [
  ["englishliterature", ["Literature"]],
  ["english", ["EFL", "ESL"]],
  ["engvr", ["EnglishVR"]],
  ["eng", ["EFL", "ESL"]],
  ["computerscience", ["ComSci"]],
  ["computing", ["ComSci"]],
  ["coding", ["ComSci"]],
  ["nvr", ["NonVR"]],
  ["nonverbal", ["NonVR"]],
];

/** All values are hours per week (the 4-week total divided by 4). */
export type CapacityHours = {
  /** Wise working hours minus leave. */
  given: number;
  /** Classes inside the given hours. */
  booked: number;
  /** Given minus booked. */
  remaining: number;
  /** Classes outside the given hours. Not part of the rate. */
  outside: number;
  /** Booked ÷ given, 0–1. Null when no hours are given. */
  utilization: number | null;
};
export type CapacityTutor = CapacityHours & {
  key: string;
  name: string;
  subjects: string[];
  leave: number;
  /** Leave is not known to the end of the period, so the given hours can be too high. */
  leaveUnknown: boolean;
  /** For a review row: why it is not in the totals. */
  issues: string[];
};
export type CapacityLevel = CapacityHours & { curriculum: string; level: string; tutors: number };
export type CapacitySubject = CapacityHours & {
  subject: string;
  hiringSubject: Subject | null;
  /** Null when the Wise subject has no Hiring subject. */
  hiring: boolean | null;
  /** 1 = top of the Hiring priority list. */
  rank: number | null;
  tutors: number;
  tutorKeys: string[];
  /** Part of `booked` whose class is in this subject. The rest is another subject or not identified. */
  bookedHere: number;
  levels: CapacityLevel[];
};
export type CapacityReport = {
  from: string;
  to: string;
  weeks: number;
  syncedAt: string;
  stale: boolean;
  totals: CapacityHours & { tutors: number };
  subjects: CapacitySubject[];
  tutors: CapacityTutor[];
  needsReview: CapacityTutor[];
  /** Booked hours of tutors with several subjects whose class title matched none of them. */
  unidentified: number;
};

const key = (text: string) => text.toLowerCase().replace(/[^a-z0-9]/g, "");

/**
 * The tutor's own subject a class belongs to. A tutor with one subject teaches that subject. Otherwise the
 * title must name one ("In-Person Session- Com sci" → ComSci). A title that starts with a tag takes the longest
 * such tag, so "MathVR" is not "Math". No match gives null: the class is booked time with no known subject.
 */
export function classSubject(title: string | undefined, subjects: string[]): string | null {
  if (subjects.length <= 1) return subjects[0] ?? null;
  // Same rule as titleSubject in the LINE feedback bot: the subject follows the word "Session".
  const text = key((title ?? "").replace(/^.*?session[\s-]*/i, "").replace(/\(cancell?ed\)\s*$/i, ""));
  if (text.length < 3) return null;
  const tags = subjects.map((s) => [s, key(s)] as const);
  const starts = tags.filter(([, tag]) => text.startsWith(tag)).sort((a, b) => b[1].length - a[1].length)[0];
  if (starts) return starts[0];
  for (const [word, names] of TITLE_ALIASES) {
    const found = text.startsWith(word) && names.find((name) => subjects.includes(name));
    if (found) return found;
  }
  return tags.find(([, tag]) => tag.startsWith(text) || text.includes(tag))?.[0] ?? null;
}

const zero = (): CapacityHours => ({ given: 0, booked: 0, remaining: 0, outside: 0, utilization: null });
function add<T extends CapacityHours>(sum: T, row: CapacityHours): T {
  sum.given += row.given;
  sum.booked += row.booked;
  sum.remaining += row.remaining;
  sum.outside += row.outside;
  sum.utilization = sum.given > 0 ? sum.booked / sum.given : null;
  return sum;
}

/** Pure. `now` only sets the first day (tomorrow, Bangkok) and the stale flag. */
export function buildCapacityReport(input: {
  groups: IndexedTutorGroup[];
  syncedAt: Date;
  priority: HiringConfig["subjectPriority"];
  now: Date;
}): CapacityReport {
  const from = shiftDate(localDate(input.now), 1);
  const days = CAPACITY_WEEKS * 7;
  const period: Interval = { start: instant(from, 0).getTime(), end: instant(from, 0).getTime() + days * DAY };
  const perWeek = (intervals: Interval[]) => intervalMinutes(intervals) / 60 / CAPACITY_WEEKS;

  // The snapshot stores Bangkok wall-clock Dates, so their epoch depends on the writer's timezone. A class also
  // keeps its Bangkok weekday and minute, which fixes its real time. Leave has no such fields, so it takes the
  // shift of the first class that resolves. With no class at all, the writer is the UTC production sync.
  let shift = -7 * 3_600_000;
  search: for (const group of input.groups)
    for (const block of group.sessionBlocks) {
      const real = interpretSnapshotSessionInterval(block);
      if (!real) continue;
      shift = Date.parse(real.startAt) - block.startTime.getTime();
      break search;
    }

  const priority = fullPriority(input.priority);
  const tutors: CapacityTutor[] = [];
  const needsReview: CapacityTutor[] = [];
  const subjectRows = new Map<string, CapacitySubject>();
  const levelRows = new Map<string, Map<string, CapacityLevel>>();
  let unidentified = 0;

  for (const group of input.groups) {
    const offered: Interval[] = [];
    for (let d = 0; d < days; d++) {
      const date = shiftDate(from, d);
      const dayStart = instant(date, 0).getTime();
      const weekday = new Date(`${date}T12:00:00Z`).getUTCDay();
      for (const w of group.availabilityWindows)
        if (w.weekday === weekday && w.endMinute > w.startMinute)
          offered.push({ start: dayStart + w.startMinute * MINUTE, end: dayStart + w.endMinute * MINUTE });
    }
    // The union counts the online and onsite records of one person once.
    const leave = intersectIntervals(
      offered,
      group.leaves.flatMap((l) => {
        const start = l.startTime.getTime() + shift, end = l.endTime.getTime() + shift;
        return end > start ? [{ start, end }] : [];
      }),
    );
    const given = subtractIntervals(offered, leave);
    const subjects = [...new Set(group.qualifications.map((q) => q.subject))].sort();
    const classes: { interval: Interval; subject: string | null }[] = [];
    for (const block of group.sessionBlocks) {
      if (!block.isBlocking) continue;
      const real = interpretSnapshotSessionInterval(block);
      const start = real ? Date.parse(real.startAt) : block.startTime.getTime() + shift;
      const end = real ? Date.parse(real.endAt) : block.endTime.getTime() + shift;
      const [interval] = end > start ? intersectIntervals([{ start, end }], [period]) : [];
      if (interval) classes.push({ interval, subject: classSubject(block.title, subjects) });
    }
    const all = classes.map((c) => c.interval);
    const inside = intersectIntervals(all, given);
    // Active = has a class, or gives hours and has a subject tag. Hours with no tag and no class is a staff account.
    if (!all.length && (!offered.length || !subjects.length)) continue;

    const hours: CapacityHours = {
      given: perWeek(given),
      booked: perWeek(inside),
      remaining: perWeek(subtractIntervals(given, all)),
      outside: perWeek(subtractIntervals(all, given)),
      utilization: given.length ? intervalMinutes(inside) / intervalMinutes(given) : null,
    };
    const issues = [...new Set(group.dataIssues.filter((i) => i.type === "alias" || i.type === "completeness").map((i) => i.type))];
    const row: CapacityTutor = {
      ...hours,
      key: group.canonicalKey,
      name: group.displayName,
      subjects,
      leave: perWeek(leave),
      // A real instant, as in indexedSlotAvailable.
      leaveUnknown: !group.leavesCompleteThrough || group.leavesCompleteThrough.getTime() < period.end,
      issues,
    };
    if (issues.length) {
      needsReview.push(row);
      continue;
    }
    tutors.push(row);

    const here = (subject: string) =>
      perWeek(intersectIntervals(classes.filter((c) => c.subject === subject).map((c) => c.interval), given));
    if (subjects.length > 1)
      unidentified += perWeek(intersectIntervals(classes.filter((c) => !c.subject).map((c) => c.interval), given));
    for (const subject of subjects) {
      const hiringSubject = HIRING_SUBJECT[subject] ?? null;
      const index = hiringSubject ? priority.findIndex((p) => p.subject === hiringSubject) : -1;
      const pool = subjectRows.get(subject) ?? {
        ...zero(),
        subject,
        hiringSubject,
        hiring: index < 0 ? null : priority[index].hiring,
        rank: index < 0 ? null : index + 1,
        tutors: 0,
        tutorKeys: [],
        bookedHere: 0,
        levels: [],
      };
      add(pool, hours);
      pool.tutors++;
      pool.tutorKeys.push(group.canonicalKey);
      pool.bookedHere += here(subject);
      subjectRows.set(subject, pool);
    }
    const seen = new Set<string>();
    for (const q of group.qualifications) {
      const id = JSON.stringify([q.subject, q.curriculum, q.level]);
      if (seen.has(id)) continue; // A paired record repeats the same tag.
      seen.add(id);
      const levels = levelRows.get(q.subject) ?? new Map<string, CapacityLevel>();
      const level = levels.get(id) ?? { ...zero(), curriculum: q.curriculum, level: q.level, tutors: 0 };
      add(level, hours);
      level.tutors++;
      levels.set(id, level);
      levelRows.set(q.subject, levels);
    }
  }

  // Tightest first; a pool with no given hours has no rate and goes last.
  const tightest = (a: CapacityHours, b: CapacityHours) => (b.utilization ?? -1) - (a.utilization ?? -1);
  const subjects = [...subjectRows.values()]
    .map((row) => ({
      ...row,
      levels: [...(levelRows.get(row.subject)?.values() ?? [])].sort(
        (a, b) => a.curriculum.localeCompare(b.curriculum) || a.level.localeCompare(b.level, undefined, { numeric: true }),
      ),
    }))
    .sort((a, b) => tightest(a, b) || a.subject.localeCompare(b.subject));
  const byName = (a: CapacityTutor, b: CapacityTutor) => tightest(a, b) || a.name.localeCompare(b.name);
  return {
    from,
    to: shiftDate(from, days - 1),
    weeks: CAPACITY_WEEKS,
    syncedAt: input.syncedAt.toISOString(),
    stale: indexIsStale({ syncedAt: input.syncedAt }, input.now),
    totals: tutors.reduce((sum, row) => add(sum, row), { ...zero(), tutors: tutors.length }),
    subjects,
    tutors: tutors.sort(byName),
    needsReview: needsReview.sort(byName),
    unidentified,
  };
}

/** Reads the warm snapshot index only. No Wise call and no write. */
export async function capacityReport(
  priority: HiringConfig["subjectPriority"],
  db: Database = getDb(),
  now = new Date(),
): Promise<CapacityReport> {
  const index = await ensureIndex(db);
  return buildCapacityReport({ groups: index.tutorGroups, syncedAt: index.syncedAt, priority, now });
}
