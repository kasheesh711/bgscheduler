import { sql } from "drizzle-orm";
import { type Database, getDb } from "@/lib/db";
import { ensureIndex } from "@/lib/search/index";
import { buildCapacityReport, classSubject, DEMAND_DAYS, HIRING_SUBJECT, type CapacityReport, type HiringNeed } from "./capacity";
import { localDate, shiftDate, SUBJECTS, type HiringConfig, type Subject } from "./model";
import { fullPriority } from "./rules";

const DAY = 86_400_000;
/** Every Wise teacher tag. A class title is matched to one of them, as in `classSubject`. */
const WISE_TAGS = [
  "Biology", "Bus", "Chemistry", "ComSci", "EFL", "ESL", "Econ", "EnglishVR", "Geo", "History", "Literature",
  "Math", "MathVR", "NonVR", "Others", "Physics", "Psych", "Science", "Thai",
];
/** Titles of Hiring subjects that no Wise tag covers, and of subjects that are not on the Hiring list. */
const TITLE_SUBJECTS: [RegExp, string][] = [
  [/^french/, "French"],
  [/^(art|design)/, "Art & Design Technology"],
  [/^ict/, "ICT"],
  [/^ielts/, "IELTS"],
  [/^psyc/, "Psychology"],
];
/** A tag with no Hiring subject keeps a plain name, so the chart can still show its demand. */
const OTHER_LABEL: Record<string, string> = {
  Science: "Science (general)",
  MathVR: "11+ reasoning",
  NonVR: "11+ reasoning",
  EnglishVR: "11+ reasoning",
};
export const OTHER_SUBJECT = "Other or not known";

/** One student in one Wise class under one class title with one tutor: the first and last class that took place. */
export type EnrolmentRow = {
  student: string;
  classId: string;
  title: string;
  /** The Wise class's level band ("Y9-11 / G8-10 (Int.)"). Null when only the older history has the class. */
  level: string | null;
  /** The tutor's canonical key. It gives an untitled class a subject. */
  tutor: string | null;
  first: Date;
  last: Date;
};

/**
 * Every class that took place (Wise status ENDED), by student, Wise class and title.
 *
 * Two records are joined, because neither is enough alone:
 * - `post_class_sessions` is current (collected every 30 minutes) and has each student, but no class title.
 *   The title comes from any record of the same Wise session that has one.
 * - `workforce_session_versions` has every class from February 2026 with title and students, but stopped on
 *   10 October 2026. It is the look-back that tells a new enrolment from an old one.
 */
export async function loadEnrolmentRows(db: Database = getDb(), now = new Date()): Promise<EnrolmentRow[]> {
  const result = await db.execute(sql`
    with titles as (
      select wise_session_id, max(title) title from (
        select wise_session_id, title from classroom_assignment_rows where title is not null and title <> ''
        union all select wise_session_id, title from past_session_blocks where title is not null and title <> ''
        union all select f.wise_session_id, f.title from future_session_blocks f
          join snapshots sn on sn.id = f.snapshot_id and sn.active where f.title is not null and f.title <> ''
        union all select wise_session_id, payload->'session'->>'classTitle' from workforce_session_versions
          where payload->'session'->>'classTitle' is not null
      ) u group by 1
    ), taken as (
      select pp.wise_student_id student, p.wise_class_id class_id, coalesce(t.title, '') title,
        p.source_metadata->>'subject' level, p.canonical_tutor_key tutor,
        p.scheduled_start_at at
      from post_class_sessions p
        join post_class_session_participants pp on pp.session_id = p.id
        left join titles t on t.wise_session_id = p.wise_session_id
      where p.final_status = 'ENDED' and p.wise_deleted_at is null and p.scheduled_start_at < ${now}
        and pp.wise_student_id is not null
        -- A tutor's own online account is listed as a participant of the class. It is not a student.
        and lower(trim(pp.student_name)) not like '% online'
        and pp.wise_student_id not in (select wise_user_id from tutor_wise_accounts where wise_user_id is not null)
      union all
      select st.student, v.payload->'session'->>'wiseClassId', coalesce(v.payload->'session'->>'classTitle', ''),
        null, v.payload->'session'->'canonicalTutorKeys'->>0, v.start_at
      from (
        select distinct on (wise_session_id) start_at, payload from workforce_session_versions
        order by wise_session_id, observed_at desc, version_order desc
      ) v cross join lateral jsonb_array_elements_text(
        coalesce(v.payload->'session'->'historicalBookedStudentIds', '[]'::jsonb)) st(student)
      where v.payload->'session'->>'meetingStatus' = 'ENDED' and v.start_at < ${now}
        and v.payload->'session'->>'wiseClassId' is not null
        and st.student not in (select wise_user_id from tutor_wise_accounts where wise_user_id is not null)
        and st.student not in (
          select wise_student_id from post_class_session_participants where lower(trim(student_name)) like '% online')
    )
    select student, class_id, title, tutor, max(level) level, min(at) first, max(at) last
    from taken group by student, class_id, title, tutor
  `);
  const rows = ((result as { rows?: unknown[] }).rows ?? result) as {
    student: string;
    class_id: string;
    title: string;
    level: string | null;
    tutor: string | null;
    first: string;
    last: string;
  }[];
  return rows.map((r) => ({
    student: r.student,
    classId: r.class_id,
    title: r.title,
    level: r.level,
    tutor: r.tutor,
    first: new Date(r.first),
    last: new Date(r.last),
  }));
}

/**
 * The subject a class title stands for: a Hiring subject where there is one, else a plain name. An untitled
 * class takes the subject of its tutor when that tutor has one Hiring subject only.
 */
export function demandSubject(title: string, tutorTags: string[] = []): string {
  const text = title.replace(/^.*?session[\s-]*/i, "").replace(/\(cancell?ed\)\s*$/i, "").trim();
  if (!text) {
    const own = [...new Set(tutorTags.flatMap((tag) => HIRING_SUBJECT[tag] ?? []))];
    return own.length === 1 ? own[0] : OTHER_SUBJECT;
  }
  const direct = TITLE_SUBJECTS.find(([pattern]) => pattern.test(text.toLowerCase().replace(/^trial\s+/, "")));
  if (direct) return direct[1];
  const tag = classSubject(text.replace(/^trial\s+/i, ""), WISE_TAGS);
  return tag ? (HIRING_SUBJECT[tag] ?? OTHER_LABEL[tag] ?? OTHER_SUBJECT) : OTHER_SUBJECT;
}

export type DemandSubject = {
  /** A Hiring subject, or a plain name for a subject that is not on the Hiring list. */
  subject: string;
  onHiringList: boolean;
  /** Students who took a first class in a course of this subject in the last 90 days. */
  started: number;
  /** The same count for each 30 days, oldest first: 61–90 days ago, 31–60, last 30. */
  months: [number, number, number];
  /** Student-and-course pairs with a class in the last 30 days. */
  active: number;
  /** `started` by the course's level band, largest first. */
  levels: { level: string; started: number }[];
};
export type DemandReport = {
  from: string;
  to: string;
  subjects: DemandSubject[];
  /** All starts in the 90 days, each student-and-course pair counted for each of its subjects. */
  started: number;
  /** Starts whose subject could not be read from a title or a tutor. They are in "Other or not known". */
  unknown: number;
};

/**
 * Pure. A start is the first class a student ever took in one Wise class (one course at one level) in one
 * subject. A student who adds Physics to a course, or moves to a new level, is a new start.
 */
export function buildDemand(input: { rows: EnrolmentRow[]; tutorTags: Map<string, string[]>; now: Date }): DemandReport {
  const now = input.now.getTime();
  const untitled = (title: string) => !title.replace(/^.*?session[\s-]*/i, "").replace(/\(cancell?ed\)\s*$/i, "").trim();
  // An untitled class takes the subject this student has with this tutor in the same course, when there is one only.
  const withTutor = new Map<string, Set<string>>();
  for (const row of input.rows) {
    if (untitled(row.title)) continue;
    const id = JSON.stringify([row.student, row.classId, row.tutor]);
    withTutor.set(id, (withTutor.get(id) ?? new Set()).add(demandSubject(row.title)));
  }
  const pairs = new Map<string, { subject: string; level: string | null; first: number; last: number }>();
  for (const row of input.rows) {
    const known = untitled(row.title) ? withTutor.get(JSON.stringify([row.student, row.classId, row.tutor])) : undefined;
    const subject =
      known?.size === 1 ? [...known][0] : demandSubject(row.title, row.tutor ? input.tutorTags.get(row.tutor) : undefined);
    const id = JSON.stringify([row.student, row.classId, subject]);
    const pair = pairs.get(id);
    if (!pair) pairs.set(id, { subject, level: row.level, first: row.first.getTime(), last: row.last.getTime() });
    else {
      pair.first = Math.min(pair.first, row.first.getTime());
      pair.last = Math.max(pair.last, row.last.getTime());
      pair.level ??= row.level;
    }
  }
  const subjects = new Map<string, DemandSubject & { byLevel: Map<string, number> }>();
  let started = 0, unknown = 0;
  for (const pair of pairs.values()) {
    const age = Math.floor((now - pair.first) / DAY);
    const isStart = age >= 0 && age < DEMAND_DAYS;
    const isActive = now - pair.last < 30 * DAY;
    if (!isStart && !isActive) continue;
    const row = subjects.get(pair.subject) ?? {
      subject: pair.subject,
      onHiringList: (SUBJECTS as readonly string[]).includes(pair.subject),
      started: 0,
      months: [0, 0, 0] as [number, number, number],
      active: 0,
      levels: [],
      byLevel: new Map<string, number>(),
    };
    subjects.set(pair.subject, row);
    if (isActive) row.active++;
    if (!isStart) continue;
    row.started++;
    row.months[2 - Math.floor(age / 30)]++;
    const level = pair.level?.trim() || "Level not known";
    row.byLevel.set(level, (row.byLevel.get(level) ?? 0) + 1);
    started++;
    if (pair.subject === OTHER_SUBJECT) unknown++;
  }
  const today = localDate(input.now);
  return {
    from: shiftDate(today, -(DEMAND_DAYS - 1)),
    to: today,
    subjects: [...subjects.values()]
      .map(({ byLevel, ...row }) => ({
        ...row,
        levels: [...byLevel].map(([level, n]) => ({ level, started: n })).sort((a, b) => b.started - a.started || a.level.localeCompare(b.level)),
      }))
      .sort((a, b) => b.started - a.started || a.subject.localeCompare(b.subject)),
    started,
    unknown,
  };
}

/** How full the subject's tutors are in their fullest busy block, 0–1. With no tutor to measure, nobody can take a new student. */
const fullness = (need: HiringNeed) => (need.tutors ? Math.max(0, ...need.blocks.map((b) => b.used ?? 0)) : 1);

/**
 * CAP-06 (owner request, 17 November 2026): the order follows demand. Score = new starts in 90 days × how full
 * the tutors are. A full subject with no new students drops; a growing subject with tutors near the limit rises.
 * A Hiring subject with starts and no tutor tagged in Wise gets a row too.
 */
export function prioritise(
  needs: HiringNeed[],
  demand: DemandReport,
  priority: HiringConfig["subjectPriority"],
): HiringNeed[] {
  const full = fullPriority(priority);
  const bySubject = new Map(demand.subjects.map((d) => [d.subject, d]));
  const rows = [...needs];
  for (const d of demand.subjects) {
    if (!d.onHiringList || !d.started || needs.some((n) => n.subject === d.subject)) continue;
    const index = full.findIndex((p) => p.subject === d.subject);
    rows.push({
      subject: d.subject as Subject,
      wiseSubjects: [],
      hiring: full[index].hiring,
      rank: index + 1,
      tutors: 0,
      tutorKeys: [],
      idle: [],
      review: 0,
      blocks: needs[0]?.blocks.map((b) => ({ key: b.key, given: 0, booked: 0, used: null, givers: 0, hire: 0 })) ?? [],
      hire: 0,
      status: "unknown",
      tightest: null,
      demand: null,
      score: 0,
    });
  }
  return rows
    .map((need) => {
      const d = bySubject.get(need.subject) ?? null;
      return { ...need, demand: d, score: (d?.started ?? 0) * fullness(need) };
    })
    .sort((a, b) => b.score - a.score || b.hire - a.hire || fullness(b) - fullness(a) || a.rank - b.rank);
}

/**
 * The Capacity tab's data: tutor hours from the Wise snapshot, and demand from the classes that took place.
 * Read-only. If the demand read fails, the supply numbers still load and the order stays by need.
 */
export async function hiringCapacity(
  priority: HiringConfig["subjectPriority"],
  db: Database = getDb(),
  now = new Date(),
): Promise<CapacityReport> {
  const [index, rows] = await Promise.all([
    ensureIndex(db),
    loadEnrolmentRows(db, now).catch((error: unknown) => {
      console.error("[hiring-capacity] demand read failed", error instanceof Error ? error.name : "unknown");
      return null;
    }),
  ]);
  const report = buildCapacityReport({ groups: index.tutorGroups, syncedAt: index.syncedAt, priority, now });
  if (!rows) return report;
  const tutorTags = new Map(index.tutorGroups.map((g) => [g.canonicalKey, [...new Set(g.qualifications.map((q) => q.subject))]]));
  const demand = buildDemand({ rows, tutorTags, now });
  return {
    ...report,
    needs: prioritise(report.needs, demand, priority),
    demand: { ...demand, subjects: demand.subjects.filter((d) => !d.onHiringList) },
  };
}
