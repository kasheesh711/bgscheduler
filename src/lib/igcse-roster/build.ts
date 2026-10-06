import { resolveAcademicSubject } from "@/lib/tutor-offboarding/workforce/subject-mappings";
import type { ReviewedSubjectMapping } from "@/lib/tutor-offboarding/workforce/types";
import { isGenericScienceLabel, isIgcseBand, namedScienceSyllabi, scienceSyllabiFromTags, syllabiForAcademicSubject, trialSyllabi } from "./subjects";

export interface RosterPackageRow {
  wiseClassId: string;
  wiseStudentId: string;
  /** Wise class name. */
  packageName: string;
  /** Wise class subject band, e.g. "Y9-11 / G8-10 (Int.)". */
  subject: string;
  excludedReason: string | null;
}
export interface RosterStudentRow {
  wiseStudentId: string;
  studentName: string;
  email: string | null;
}
/** One row per distinct (class, title, teacher) in the active snapshot; `lastStart` is the latest session start. */
export interface RosterSessionRow {
  wiseClassId: string;
  title: string;
  wiseTeacherUserId: string | null;
  wiseTeacherId: string | null;
  lastStart: Date | string | null;
  /** Sessions in this group; defaults to 1. */
  sessionCount?: number;
}
export interface RosterAccountRow {
  wiseTeacherId: string;
  wiseUserId: string | null;
  canonicalKey: string;
  isOnlineVariant: boolean;
  email: string | null;
}
export interface RosterContactRow {
  canonicalKey: string;
  displayName: string;
  primaryEmail: string | null;
  onsiteEmail: string | null;
  onlineEmail: string | null;
  active: boolean;
}
/** Active-snapshot Wise qualification tag for a tutor (`subject_level_qualifications`). */
export interface RosterQualificationRow {
  canonicalKey: string;
  subject: string;
  curriculum: string;
  level: string;
}
export interface RosterBuildInput {
  packages: RosterPackageRow[];
  students: RosterStudentRow[];
  sessions: RosterSessionRow[];
  accounts: RosterAccountRow[];
  contacts: RosterContactRow[];
  mappings: ReviewedSubjectMapping[];
  qualifications: RosterQualificationRow[];
}

export interface RosterTutor { wiseUserId: string; email: string; name: string; syllabi: string[] }
export interface RosterStudent { wiseStudentId: string; email: string; name: string }
export interface RosterLink {
  wiseClassId: string;
  className: string;
  tutorWiseUserId: string;
  tutorEmail: string;
  studentWiseId: string;
  studentEmail: string;
  syllabus: string;
}
export interface RosterUnmapped {
  wiseClassId: string;
  className: string;
  sessionTitle: string | null;
  wiseStudentId?: string;
  reason: string;
  /** True when this class still produced at least one link, so the entry is a partial gap. */
  classLoaded: boolean;
}
export interface IgcseRoster {
  generatedAt: string;
  tutors: RosterTutor[];
  students: RosterStudent[];
  links: RosterLink[];
  unmapped: RosterUnmapped[];
}

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function normalizeEmail(value: string | null | undefined): string | null {
  const email = (value ?? "").trim().toLowerCase();
  return EMAIL_PATTERN.test(email) ? email : null;
}

interface TutorIdentity { key: string; wiseUserId: string; email: string; name: string }

/** One identity per canonicalKey so a tutor's onsite and online Wise accounts merge. */
function buildTutorIdentities(accounts: RosterAccountRow[], contacts: RosterContactRow[]) {
  const contactByKey = new Map(contacts.map((contact) => [contact.canonicalKey, contact]));
  const accountsByKey = new Map<string, RosterAccountRow[]>();
  for (const account of accounts) {
    accountsByKey.set(account.canonicalKey, [...(accountsByKey.get(account.canonicalKey) ?? []), account]);
  }

  const identities = new Map<string, TutorIdentity | { key: string; problem: string }>();
  for (const [key, group] of accountsByKey) {
    const contact = contactByKey.get(key);
    if (!contact) { identities.set(key, { key, problem: "tutor_contact_missing" }); continue; }
    if (!contact.active) { identities.set(key, { key, problem: "tutor_inactive" }); continue; }
    const email = [contact.primaryEmail, contact.onsiteEmail, contact.onlineEmail, ...group.map((a) => a.email)]
      .map(normalizeEmail).find((value): value is string => value !== null);
    if (!email) { identities.set(key, { key, problem: "tutor_email_missing_or_invalid" }); continue; }
    // Prefer the onsite (non-online) account's Wise user id; stable order keeps it deterministic.
    const ordered = [...group].sort((a, b) =>
      Number(a.isOnlineVariant) - Number(b.isOnlineVariant) || a.wiseTeacherId.localeCompare(b.wiseTeacherId));
    const wiseUserId = ordered.map((a) => a.wiseUserId || a.wiseTeacherId).find(Boolean);
    if (!wiseUserId) { identities.set(key, { key, problem: "tutor_wise_id_missing" }); continue; }
    identities.set(key, { key, wiseUserId, email, name: contact.displayName.trim() });
  }
  return identities;
}

const time = (value: Date | string | null) => {
  const ms = value instanceof Date ? value.getTime() : value ? Date.parse(value) : NaN;
  return Number.isFinite(ms) ? ms : -Infinity;
};

/** Two teachers who each taught this many (non-cancelled) sessions of one subject in a class are both linked. */
export const CO_TEACHING_MIN_SESSIONS = 3;

const isCancelledTitle = (title: string) => /\((?:cancelled|canceled)\)\s*$/i.test(title.trim());

/** One (class, title, teacher) group with its resolved subject. */
interface SubjectCandidate {
  subjectKey: string;
  codes: string[];
  tutorKey: string | null;
  title: string;
  sessions: number;
  /** Sessions whose title is not "(Cancelled)". */
  liveSessions: number;
  lastStart: number;
}

/**
 * Picks the teacher(s) of one subject within one class from its candidate groups:
 *  - cancelled-only teachers are dropped when anyone has non-cancelled sessions;
 *  - an unresolved teacher only counts when no resolved teacher exists;
 *  - the teacher with the most recent session is linked, plus every teacher with
 *    at least CO_TEACHING_MIN_SESSIONS sessions when the latest teacher also has that many.
 */
function chooseTeachers(group: SubjectCandidate[]): Array<{ tutorKey: string | null; codes: string[]; title: string }> {
  const byTeacher = new Map<string, { tutorKey: string | null; codes: Set<string>; title: string; sessions: number; liveSessions: number; lastLive: number; lastAny: number }>();
  for (const c of group) {
    const id = c.tutorKey ?? "";
    const row = byTeacher.get(id) ?? { tutorKey: c.tutorKey, codes: new Set<string>(), title: c.title, sessions: 0, liveSessions: 0, lastLive: -Infinity, lastAny: -Infinity };
    c.codes.forEach((code) => row.codes.add(code));
    row.sessions += c.sessions;
    row.liveSessions += c.liveSessions;
    row.lastAny = Math.max(row.lastAny, c.lastStart);
    if (c.liveSessions > 0) row.lastLive = Math.max(row.lastLive, c.lastStart);
    if (c.liveSessions > 0 && isCancelledTitle(row.title)) row.title = c.title;
    byTeacher.set(id, row);
  }
  let teachers = [...byTeacher.values()].map((t) => ({ ...t, lastStart: t.liveSessions > 0 ? t.lastLive : t.lastAny }));
  if (teachers.some((t) => t.tutorKey)) teachers = teachers.filter((t) => t.tutorKey);
  if (teachers.some((t) => t.liveSessions > 0)) teachers = teachers.filter((t) => t.liveSessions > 0);

  teachers.sort((a, b) => b.lastStart - a.lastStart || (a.tutorKey ?? "").localeCompare(b.tutorKey ?? ""));
  const [latest] = teachers;
  const chosen = latest.liveSessions >= CO_TEACHING_MIN_SESSIONS
    ? teachers.filter((t) => t === latest || t.liveSessions >= CO_TEACHING_MIN_SESSIONS)
    : [latest];
  return chosen.map((t) => ({ tutorKey: t.tutorKey, codes: [...t.codes], title: t.title }));
}

/**
 * Pure roster builder: IGCSE class/student/tutor links with bank syllabus codes.
 * One link per (class, student, syllabus). Anything that cannot be linked is
 * reported in `unmapped` instead of being guessed or silently dropped.
 */
export function buildIgcseRoster(input: RosterBuildInput, now: Date = new Date()): IgcseRoster {
  const unmapped: Omit<RosterUnmapped, "classLoaded">[] = [];
  const studentById = new Map(input.students.map((student) => [student.wiseStudentId, student]));
  const tutorIdentities = buildTutorIdentities(input.accounts, input.contacts);
  const keyByAccountId = new Map<string, string>();
  for (const account of input.accounts) {
    keyByAccountId.set(account.wiseTeacherId, account.canonicalKey);
    if (account.wiseUserId) keyByAccountId.set(account.wiseUserId, account.canonicalKey);
  }

  const tagsByKey = new Map<string, RosterQualificationRow[]>();
  for (const tag of input.qualifications) {
    tagsByKey.set(tag.canonicalKey, [...(tagsByKey.get(tag.canonicalKey) ?? []), tag]);
  }

  // IGCSE classes -> their students (excluded packages are not live enrolments).
  const classes = new Map<string, { name: string; studentIds: Set<string> }>();
  for (const pkg of input.packages) {
    if (pkg.excludedReason || !isIgcseBand(pkg.subject)) continue;
    const entry = classes.get(pkg.wiseClassId) ?? { name: pkg.packageName, studentIds: new Set<string>() };
    entry.studentIds.add(pkg.wiseStudentId);
    classes.set(pkg.wiseClassId, entry);
  }

  // A student email shared by several Wise students cannot identify one sign-in.
  const studentsByEmail = new Map<string, Set<string>>();
  for (const student of input.students) {
    const email = normalizeEmail(student.email);
    if (email) studentsByEmail.set(email, new Set([...(studentsByEmail.get(email) ?? []), student.wiseStudentId]));
  }

  const sessionsByClass = new Map<string, RosterSessionRow[]>();
  for (const session of input.sessions) {
    if (classes.has(session.wiseClassId)) sessionsByClass.set(session.wiseClassId, [...(sessionsByClass.get(session.wiseClassId) ?? []), session]);
  }

  const links: RosterLink[] = [];
  const tutorSyllabi = new Map<string, Set<string>>();
  const usedStudents = new Map<string, RosterStudent>();

  for (const [wiseClassId, klass] of [...classes].sort(([a], [b]) => a.localeCompare(b))) {
    const className = klass.name;
    const sessions = sessionsByClass.get(wiseClassId) ?? [];
    if (!sessions.length) {
      unmapped.push({ wiseClassId, className, sessionTitle: null, reason: "no_sessions_in_snapshot" });
      continue;
    }

    // Wise classes here are per student and mix subjects taught by different tutors, so each
    // (title, teacher) group is resolved on its own: subject from the title, tutor from its teacher.
    const reported = new Set<string>();
    const report = (entry: Omit<RosterUnmapped, "classLoaded">) => {
      const key = JSON.stringify([entry.sessionTitle, entry.wiseStudentId ?? null, entry.reason]);
      if (reported.has(key)) return;
      reported.add(key);
      unmapped.push(entry);
    };
    const candidates: SubjectCandidate[] = [];
    for (const session of [...sessions].sort((a, b) => a.title.localeCompare(b.title))) {
      const title = session.title;
      const tutorKey = [session.wiseTeacherUserId, session.wiseTeacherId]
        .map((id) => (id ? keyByAccountId.get(id) : undefined)).find(Boolean) ?? null;
      const resolution = resolveAcademicSubject({ classId: wiseClassId, sourceValue: title }, input.mappings);
      const resolved = resolution.subject && resolution.completeness === "complete" ? resolution.subject : null;

      let subjectKey: string;
      let codes: string[];
      if (resolved ? isGenericScienceLabel(resolved) : isGenericScienceLabel(title)) {
        // Generic "Science": a named science wins, else this group's own teacher's Wise tags.
        subjectKey = "science";
        const named = namedScienceSyllabi(resolved, title);
        codes = named.length ? named : tutorKey ? scienceSyllabiFromTags(tagsByKey.get(tutorKey) ?? []) : [];
        if (!codes.length) {
          report({ wiseClassId, className, sessionTitle: title || null, reason: tutorKey ? "science_no_tutor_tag" : "tutor_unresolved" });
          continue;
        }
      } else if (!resolved) {
        const trial = trialSyllabi(title);
        if (!trial) {
          report({ wiseClassId, className, sessionTitle: title || null, reason: `subject_unresolved:${resolution.reasonCodes[0] ?? "UNKNOWN"}` });
          continue;
        }
        codes = trial;
        subjectKey = trial.join("+");
      } else {
        const mapped = syllabiForAcademicSubject(resolved);
        if (!mapped) {
          report({ wiseClassId, className, sessionTitle: title, reason: `subject_not_in_bank:${resolved}` });
          continue;
        }
        codes = mapped;
        subjectKey = mapped.join("+");
      }
      const count = session.sessionCount ?? 1;
      candidates.push({
        subjectKey, codes, tutorKey, title,
        sessions: count,
        liveSessions: isCancelledTitle(title) ? 0 : count,
        lastStart: time(session.lastStart),
      });
    }

    // Per subject in this class: which teacher(s) actually teach it.
    const assignments: Array<{ tutor: TutorIdentity; codes: string[] }> = [];
    const subjectKeys = [...new Set(candidates.map((c) => c.subjectKey))].sort();
    for (const subjectKey of subjectKeys) {
      for (const chosen of chooseTeachers(candidates.filter((c) => c.subjectKey === subjectKey))) {
        const tutor = chosen.tutorKey ? tutorIdentities.get(chosen.tutorKey) : undefined;
        if (!tutor || "problem" in tutor) {
          report({ wiseClassId, className, sessionTitle: chosen.title || null, reason: tutor ? tutor.problem : "tutor_unresolved" });
          continue;
        }
        assignments.push({ tutor, codes: chosen.codes });
      }
    }
    if (!assignments.length) continue;

    for (const wiseStudentId of [...klass.studentIds].sort()) {
      const student = studentById.get(wiseStudentId);
      const email = normalizeEmail(student?.email);
      if (!student || !email) {
        unmapped.push({ wiseClassId, className, sessionTitle: null, wiseStudentId, reason: student ? "student_email_missing_or_invalid" : "student_not_in_snapshot" });
        continue;
      }
      if ((studentsByEmail.get(email)?.size ?? 0) > 1) {
        unmapped.push({ wiseClassId, className, sessionTitle: null, wiseStudentId, reason: "student_email_shared" });
        continue;
      }
      usedStudents.set(wiseStudentId, { wiseStudentId, email, name: student.studentName.trim() });
      const seen = new Set<string>();
      for (const { tutor, codes } of assignments) {
        for (const syllabus of [...codes].sort()) {
          if (seen.has(`${tutor.key}|${syllabus}`)) continue;
          seen.add(`${tutor.key}|${syllabus}`);
          links.push({ wiseClassId, className, tutorWiseUserId: tutor.wiseUserId, tutorEmail: tutor.email, studentWiseId: wiseStudentId, studentEmail: email, syllabus });
          tutorSyllabi.set(tutor.key, new Set([...(tutorSyllabi.get(tutor.key) ?? []), syllabus]));
        }
      }
    }
  }

  const tutors: RosterTutor[] = [];
  for (const [key, set] of tutorSyllabi) {
    const identity = tutorIdentities.get(key);
    if (identity && !("problem" in identity)) {
      tutors.push({ wiseUserId: identity.wiseUserId, email: identity.email, name: identity.name, syllabi: [...set].sort() });
    }
  }
  tutors.sort((a, b) => a.wiseUserId.localeCompare(b.wiseUserId));

  const loadedClasses = new Set(links.map((link) => link.wiseClassId));

  return {
    generatedAt: now.toISOString(),
    tutors,
    students: [...usedStudents.values()].sort((a, b) => a.wiseStudentId.localeCompare(b.wiseStudentId)),
    links,
    unmapped: unmapped.map((entry) => ({ ...entry, classLoaded: loadedClasses.has(entry.wiseClassId) })),
  };
}
