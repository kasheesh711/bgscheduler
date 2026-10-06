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

    // Teacher: the one on the class's most recent session that resolves to a tutor.
    const latestFirst = [...sessions].sort((a, b) => time(b.lastStart) - time(a.lastStart));
    let tutorKey: string | null = null;
    for (const session of latestFirst) {
      const key = [session.wiseTeacherUserId, session.wiseTeacherId]
        .map((id) => (id ? keyByAccountId.get(id) : undefined)).find(Boolean);
      if (key) { tutorKey = key; break; }
    }
    const tutor = tutorKey ? tutorIdentities.get(tutorKey) : undefined;

    // Academic subject: reviewed mappings first; generic "Science" falls back to the tutor's Wise tags.
    const syllabi = new Set<string>();
    for (const title of [...new Set(sessions.map((s) => s.title))].sort()) {
      const resolution = resolveAcademicSubject({ classId: wiseClassId, sourceValue: title }, input.mappings);
      const resolved = resolution.subject && resolution.completeness === "complete" ? resolution.subject : null;

      if (resolved ? isGenericScienceLabel(resolved) : isGenericScienceLabel(title)) {
        const named = namedScienceSyllabi(resolved, title);
        const codes = named.length
          ? named
          : tutorKey ? scienceSyllabiFromTags(tagsByKey.get(tutorKey) ?? []) : [];
        if (!codes.length) {
          unmapped.push({ wiseClassId, className, sessionTitle: title || null, reason: tutorKey ? "science_no_tutor_tag" : "tutor_unresolved" });
        }
        codes.forEach((code) => syllabi.add(code));
        continue;
      }
      if (!resolved) {
        const trial = trialSyllabi(title);
        if (trial) {
          trial.forEach((code) => syllabi.add(code));
          continue;
        }
        unmapped.push({ wiseClassId, className, sessionTitle: title || null, reason: `subject_unresolved:${resolution.reasonCodes[0] ?? "UNKNOWN"}` });
        continue;
      }
      const codes = syllabiForAcademicSubject(resolved);
      if (!codes) {
        unmapped.push({ wiseClassId, className, sessionTitle: title, reason: `subject_not_in_bank:${resolved}` });
        continue;
      }
      codes.forEach((code) => syllabi.add(code));
    }
    if (!syllabi.size) continue;

    if (!tutor || "problem" in tutor) {
      unmapped.push({ wiseClassId, className, sessionTitle: null, reason: tutor ? tutor.problem : "tutor_unresolved" });
      continue;
    }

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
      for (const syllabus of [...syllabi].sort()) {
        links.push({ wiseClassId, className, tutorWiseUserId: tutor.wiseUserId, tutorEmail: tutor.email, studentWiseId: wiseStudentId, studentEmail: email, syllabus });
        tutorSyllabi.set(tutor.key, new Set([...(tutorSyllabi.get(tutor.key) ?? []), syllabus]));
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
