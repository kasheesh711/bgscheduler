import { describe, expect, it } from "vitest";
import type { ReviewedSubjectMapping } from "@/lib/tutor-offboarding/workforce/types";
import { buildIgcseRoster, CO_TEACHING_MIN_SESSIONS, type RosterBuildInput, type RosterSessionRow } from "../build";
import { isIgcseBand, syllabiForAcademicSubject } from "../subjects";

const IGCSE_BAND = "Y9-11 / G8-10 (Int.)";
const ALEVEL_BAND = "Y12-13 / G11-12 (Int.)";
const NOW = new Date("2026-10-06T00:00:00.000Z");

const mapping = (classId: string, sourceValue: string, subject: string): ReviewedSubjectMapping => ({
  id: `m-${classId}-${sourceValue}`, classId, sourceValue, subject, curriculum: null, level: null,
  revision: 1, reviewedBy: "reviewer@example.test", reviewedAt: "2026-09-01T00:00:00.000Z",
});

function fixture(overrides: Partial<RosterBuildInput> = {}): RosterBuildInput {
  return {
    packages: [
      { wiseClassId: "c-bio", wiseStudentId: "s1", packageName: "Bio Class", subject: IGCSE_BAND, excludedReason: null },
      { wiseClassId: "c-bio", wiseStudentId: "s2", packageName: "Bio Class", subject: IGCSE_BAND, excludedReason: null },
      { wiseClassId: "c-math", wiseStudentId: "s1", packageName: "Math Class", subject: "(2-STU) Y9-11 / G8-10 (Int.)", excludedReason: null },
      { wiseClassId: "c-alevel", wiseStudentId: "s3", packageName: "A-level Physics", subject: ALEVEL_BAND, excludedReason: null },
      { wiseClassId: "c-econ", wiseStudentId: "s2", packageName: "Econ Class", subject: "IGCSE", excludedReason: null },
    ],
    students: [
      { wiseStudentId: "s1", studentName: "Student One", email: "  Student.One@Example.TEST " },
      { wiseStudentId: "s2", studentName: "Student Two", email: "not-an-email" },
      { wiseStudentId: "s3", studentName: "Student Three", email: "s3@example.test" },
    ],
    sessions: [
      { wiseClassId: "c-bio", title: "In-Person Session-Biology", wiseTeacherUserId: "u-onsite", wiseTeacherId: "t-onsite", lastStart: new Date("2026-10-01T00:00:00Z") },
      { wiseClassId: "c-math", title: "Live Session-Maths", wiseTeacherUserId: "u-online", wiseTeacherId: "t-online", lastStart: new Date("2026-10-02T00:00:00Z") },
      { wiseClassId: "c-alevel", title: "Physics A2", wiseTeacherUserId: "u-onsite", wiseTeacherId: "t-onsite", lastStart: null },
      { wiseClassId: "c-econ", title: "Live Session-Economics", wiseTeacherUserId: "u-onsite", wiseTeacherId: "t-onsite", lastStart: null },
    ],
    accounts: [
      { wiseTeacherId: "t-onsite", wiseUserId: "u-onsite", canonicalKey: "tutor-a", isOnlineVariant: false, email: "acct@example.test" },
      { wiseTeacherId: "t-online", wiseUserId: "u-online", canonicalKey: "tutor-a", isOnlineVariant: true, email: null },
    ],
    contacts: [
      { canonicalKey: "tutor-a", displayName: "Tutor A", primaryEmail: " Tutor.A@Example.test", onsiteEmail: "onsite@example.test", onlineEmail: null, active: true },
    ],
    mappings: [
      mapping("c-bio", "In-Person Session-Biology", "IGCSE Biology"),
      mapping("c-math", "Live Session-Maths", "Mathematics"),
      mapping("c-alevel", "Physics A2", "A-level Physics"),
      mapping("c-econ", "Live Session-Economics", "Economics"),
    ],
    qualifications: [],
    ...overrides,
  };
}

const tag = (subject: string, level = "Y9-11", curriculum = "International", canonicalKey = "tutor-a") =>
  ({ canonicalKey, subject, curriculum, level });

/** One IGCSE science class (student s1) taught by tutor-a, with the given session title and tags. */
function scienceFixture(title: string, qualifications: RosterBuildInput["qualifications"], mapped: string | null = "Science") {
  const base = fixture();
  return fixture({
    packages: [{ wiseClassId: "c-sci", wiseStudentId: "s1", packageName: "Science Class", subject: IGCSE_BAND, excludedReason: null }],
    sessions: [{ wiseClassId: "c-sci", title, wiseTeacherUserId: "u-onsite", wiseTeacherId: "t-onsite", lastStart: null }],
    mappings: mapped ? [mapping("c-sci", title, mapped)] : [],
    qualifications,
    accounts: base.accounts,
  });
}

describe("isIgcseBand", () => {
  it("accepts every IGCSE band variant and the program names", () => {
    for (const value of [
      "Y9-11 / G8-10 (Int.)", "(2-STU) Y9-11 / G8-10 (Int.)", "(3-STU) Y9-11 / G8-10 (Int.)",
      "Y9-11 / G8-10 (Int.) Master", "(2-STU) Y9-11 / G8-10 (Int.) Master", "IGCSE", "igcse master (2 STU)", "Edexcel IGCSE",
    ]) expect(isIgcseBand(value), value).toBe(true);
  });
  it("rejects other bands", () => {
    for (const value of ["Y12-13 / G11-12 (Int.)", "(2-STU) Y12-13 / G11-12 (Int.)", "Y2-8 / G1-7 (Int.)", "", null]) {
      expect(isIgcseBand(value), String(value)).toBe(false);
    }
  });
});

describe("syllabiForAcademicSubject", () => {
  it("maps bank subjects", () => {
    expect(syllabiForAcademicSubject("IGCSE Biology")).toEqual(["0610"]);
    expect(syllabiForAcademicSubject("Chemistry")).toEqual(["0620"]);
    expect(syllabiForAcademicSubject("physics")).toEqual(["0625"]);
    expect(syllabiForAcademicSubject("Math")).toEqual(["0580", "0607"]);
    expect(syllabiForAcademicSubject("IGCSE Mathematics")).toEqual(["0580", "0607"]);
    expect(syllabiForAcademicSubject("Maths")).toEqual(["0580", "0607"]);
  });
  it("returns null for subjects outside the bank", () => {
    for (const value of ["Economics", "Further Maths", "Additional Mathematics", "Combined Science", "Physics and Chemistry", "", null]) {
      expect(syllabiForAcademicSubject(value), String(value)).toBeNull();
    }
  });
});

describe("buildIgcseRoster", () => {
  it("builds links, merges onsite/online tutor accounts, and excludes non-IGCSE classes", () => {
    const roster = buildIgcseRoster(fixture(), NOW);

    expect(roster.generatedAt).toBe(NOW.toISOString());
    // A-level class is never linked and never reported (it is not IGCSE).
    expect(roster.links.every((l) => l.wiseClassId !== "c-alevel")).toBe(true);
    expect(roster.unmapped.some((u) => u.wiseClassId === "c-alevel")).toBe(false);
    expect(roster.students.map((s) => s.wiseStudentId)).not.toContain("s3");

    // Maths -> two syllabus codes; bio -> one. s2 has a bad email, so only s1 links.
    expect(roster.links.filter((l) => l.wiseClassId === "c-math").map((l) => l.syllabus)).toEqual(["0580", "0607"]);
    expect(roster.links.filter((l) => l.wiseClassId === "c-bio")).toEqual([{
      wiseClassId: "c-bio", className: "Bio Class", tutorWiseUserId: "u-onsite", tutorEmail: "tutor.a@example.test",
      studentWiseId: "s1", studentEmail: "student.one@example.test", syllabus: "0610",
    }]);

    // Onsite + online accounts merge into one tutor, with the union of syllabi and the onsite user id.
    expect(roster.tutors).toEqual([
      { wiseUserId: "u-onsite", email: "tutor.a@example.test", name: "Tutor A", syllabi: ["0580", "0607", "0610"] },
    ]);
    // Math class is taught on the online account but still links to the merged tutor.
    expect(new Set(roster.links.map((l) => l.tutorWiseUserId))).toEqual(new Set(["u-onsite"]));
    expect(roster.students).toEqual([{ wiseStudentId: "s1", email: "student.one@example.test", name: "Student One" }]);
  });

  it("reports unmapped subjects and skips those links", () => {
    const roster = buildIgcseRoster(fixture(), NOW);
    expect(roster.links.some((l) => l.wiseClassId === "c-econ")).toBe(false);
    expect(roster.unmapped).toContainEqual({
      wiseClassId: "c-econ", className: "Econ Class", sessionTitle: "Live Session-Economics", reason: "subject_not_in_bank:Economics", classLoaded: false,
    });
  });

  it("reports titles with no reviewed mapping", () => {
    const roster = buildIgcseRoster(fixture({ mappings: [] }), NOW);
    expect(roster.links).toEqual([]);
    expect(roster.tutors).toEqual([]);
    expect(roster.unmapped.find((u) => u.wiseClassId === "c-bio")).toMatchObject({
      sessionTitle: "In-Person Session-Biology", reason: "subject_unresolved:SUBJECT_MAPPING_UNMAPPED",
    });
  });

  it("skips students with a missing or invalid email and records them", () => {
    const roster = buildIgcseRoster(fixture(), NOW);
    expect(roster.unmapped).toContainEqual({
      wiseClassId: "c-bio", className: "Bio Class", sessionTitle: null, wiseStudentId: "s2", reason: "student_email_missing_or_invalid", classLoaded: true,
    });
    expect(roster.links.some((l) => l.studentWiseId === "s2")).toBe(false);

    const missing = buildIgcseRoster(fixture({ students: [{ wiseStudentId: "s1", studentName: "Student One", email: null }] }), NOW);
    expect(missing.unmapped.filter((u) => u.wiseStudentId === "s1").map((u) => u.reason)).toContain("student_email_missing_or_invalid");
    expect(missing.students).toEqual([]);
  });

  it("skips students that share one email", () => {
    const roster = buildIgcseRoster(fixture({
      students: [
        { wiseStudentId: "s1", studentName: "Sibling One", email: "family@example.test" },
        { wiseStudentId: "s2", studentName: "Sibling Two", email: "FAMILY@example.test" },
      ],
    }), NOW);
    expect(roster.links).toEqual([]);
    expect(roster.unmapped.filter((u) => u.reason === "student_email_shared").map((u) => u.wiseStudentId).sort()).toEqual(["s1", "s1", "s2"]);
  });

  it("skips links whose tutor has no valid email, is inactive, or cannot be resolved", () => {
    const base = fixture();
    const noEmail = buildIgcseRoster({ ...base, accounts: base.accounts.map((a) => ({ ...a, email: null })), contacts: [{ ...base.contacts[0], primaryEmail: "bad", onsiteEmail: null, onlineEmail: null }] }, NOW);
    expect(noEmail.links).toEqual([]);
    expect(noEmail.unmapped.map((u) => u.reason)).toContain("tutor_email_missing_or_invalid");

    const inactive = buildIgcseRoster({ ...base, contacts: [{ ...base.contacts[0], active: false }] }, NOW);
    expect(inactive.links).toEqual([]);
    expect(inactive.unmapped.map((u) => u.reason)).toContain("tutor_inactive");

    const unresolved = buildIgcseRoster({ ...base, accounts: [] }, NOW);
    expect(unresolved.unmapped.map((u) => u.reason)).toContain("tutor_unresolved");
  });

  it("falls back to the next tutor email source and ignores excluded packages", () => {
    const base = fixture();
    const roster = buildIgcseRoster({
      ...base,
      contacts: [{ ...base.contacts[0], primaryEmail: null, onsiteEmail: " ONSITE@example.test " }],
      packages: base.packages.map((p) => (p.wiseClassId === "c-math" ? { ...p, excludedReason: "trial" } : p)),
    }, NOW);
    expect(roster.tutors[0]).toMatchObject({ email: "onsite@example.test", syllabi: ["0610"] });
    expect(roster.links.some((l) => l.wiseClassId === "c-math")).toBe(false);
  });

  it("uses the teacher of the latest session", () => {
    const base = fixture();
    const roster = buildIgcseRoster({
      ...base,
      accounts: [
        ...base.accounts,
        { wiseTeacherId: "t-b", wiseUserId: "u-b", canonicalKey: "tutor-b", isOnlineVariant: false, email: "b@example.test" },
      ],
      contacts: [...base.contacts, { canonicalKey: "tutor-b", displayName: "Tutor B", primaryEmail: "b@example.test", onsiteEmail: null, onlineEmail: null, active: true }],
      sessions: [
        ...base.sessions,
        { wiseClassId: "c-bio", title: "In-Person Session-Biology", wiseTeacherUserId: "u-b", wiseTeacherId: "t-b", lastStart: new Date("2026-11-01T00:00:00Z") },
      ],
    }, NOW);
    expect(roster.links.find((l) => l.wiseClassId === "c-bio")?.tutorWiseUserId).toBe("u-b");
  });

  describe("generic Science classes", () => {
    const codes = (r: ReturnType<typeof buildIgcseRoster>) => r.links.map((l) => l.syllabus);

    it("uses the tutor's Y9-11 International Biology/Chemistry tags", () => {
      const roster = buildIgcseRoster(scienceFixture("Live Session-Science", [tag("Biology"), tag("Chemistry"), tag("Math")]), NOW);
      expect(codes(roster)).toEqual(["0610", "0620"]);
      expect(roster.tutors[0].syllabi).toEqual(["0610", "0620"]);
      expect(roster.unmapped).toEqual([]);
    });

    it("reports science_no_tutor_tag when the tutor only has a generic Science tag", () => {
      const roster = buildIgcseRoster(scienceFixture("Live Session-Science", [tag("Science"), tag("Math")]), NOW);
      expect(roster.links).toEqual([]);
      expect(roster.tutors).toEqual([]);
      expect(roster.unmapped).toContainEqual({ wiseClassId: "c-sci", className: "Science Class", sessionTitle: "Live Session-Science", reason: "science_no_tutor_tag", classLoaded: false });
    });

    it("uses the specific science named in the title regardless of tags", () => {
      const roster = buildIgcseRoster(scienceFixture("Live Session-Science (Chemistry)", [tag("Biology"), tag("Physics")]), NOW);
      expect(codes(roster)).toEqual(["0620"]);
      const noTags = buildIgcseRoster(scienceFixture("Live Session-Science (Chemistry)", []), NOW);
      expect(codes(noTags)).toEqual(["0620"]);
    });

    it("ignores tags outside International Y9-11 and other tutors' tags", () => {
      const roster = buildIgcseRoster(scienceFixture("Live Session-Science", [
        tag("Biology", "Y12-13"), tag("Chemistry", "Y9-11", "Thai"), tag("Physics", "Y9-11", "International", "tutor-other"),
      ]), NOW);
      expect(roster.links).toEqual([]);
      expect(roster.unmapped.map((u) => u.reason)).toEqual(["science_no_tutor_tag"]);
    });

    it("falls back to the title keyword when no mapping exists (Sci, Combined Science)", () => {
      for (const title of ["Live Session-Sci", "In-Person Session-Combined Science", "Live Session-Co-ordinated Science"]) {
        const roster = buildIgcseRoster(scienceFixture(title, [tag("Physics")], null), NOW);
        expect(codes(roster), title).toEqual(["0625"]);
      }
    });

    it("does not treat Com-Sci / Computer Science as science", () => {
      for (const title of ["Live Session-Com-Sci", "Live Session-Computer Science", "Live Session-Com Sci"]) {
        const roster = buildIgcseRoster(scienceFixture(title, [tag("Physics")], null), NOW);
        expect(roster.links, title).toEqual([]);
        expect(roster.unmapped[0].reason, title).toBe("subject_unresolved:SUBJECT_MAPPING_UNMAPPED");
      }
    });
  });

  describe("trial classes", () => {
    const run = (title: string, qualifications: RosterBuildInput["qualifications"] = []) =>
      buildIgcseRoster(scienceFixture(title, qualifications, null), NOW);
    const codes = (r: ReturnType<typeof buildIgcseRoster>) => r.links.map((l) => l.syllabus);

    it("maps trial titles with a bank subject keyword, in any position", () => {
      const cases: Array<[string, string[]]> = [
        ["Math Trial", ["0580", "0607"]],
        ["Live Session - Maths Trial", ["0580", "0607"]],
        ["In-Person Session-Trial Math", ["0580", "0607"]],
        ["Trial Physics", ["0625"]],
        ["Live Session - Chemistry Trial", ["0620"]],
        ["on-site session - biology TRIAL", ["0610"]],
      ];
      for (const [title, expected] of cases) expect(codes(run(title)), title).toEqual(expected);
    });

    it("drops trailing Thai booking notes before matching", () => {
      expect(codes(run("Live Session - Math Trial จองตาราง"))).toEqual(["0580", "0607"]);
      expect(codes(run("Physics Trial \u0e08\u0e2d\u0e07 Chemistry"))).toEqual(["0625"]);
    });

    it("sends a Science Trial through the tutor-tag rule", () => {
      expect(codes(run("Live Session - Science Trial", [tag("Biology")]))).toEqual(["0610"]);
      const none = run("Live Session - Science Trial");
      expect(none.links).toEqual([]);
      expect(none.unmapped.map((u) => u.reason)).toEqual(["science_no_tutor_tag"]);
    });

    it("leaves statistics, English, other-subject, ambiguous and non-trial titles unmapped", () => {
      for (const title of ["STAT Trial", "Math (Stat) Trial", "Live Session - Math Statics", "English Trial", "Economics Trial", "Physics Chemistry Trial", "Trial", "Further Maths Trial", "Live Session-Math"]) {
        const roster = run(title);
        expect(roster.links, title).toEqual([]);
        expect(roster.unmapped[0].reason, title).toBe("subject_unresolved:SUBJECT_MAPPING_UNMAPPED");
      }
    });

    it("does not override a reviewed mapping", () => {
      const roster = buildIgcseRoster(scienceFixture("Live Session - Math Trial", [], "Economics"), NOW);
      expect(roster.links).toEqual([]);
      expect(roster.unmapped[0].reason).toBe("subject_not_in_bank:Economics");
    });
  });

  it("flags classLoaded on unmapped entries by whether the class produced a link", () => {
    const base = fixture();
    const roster = buildIgcseRoster({
      ...base,
      sessions: [
        ...base.sessions,
        // c-bio gets a second, unmapped title: the class still loads via its Biology title.
        { wiseClassId: "c-bio", title: "Live Session-Mock Exam", wiseTeacherUserId: "u-onsite", wiseTeacherId: "t-onsite", lastStart: null },
      ],
    }, NOW);
    const partial = roster.unmapped.find((u) => u.sessionTitle === "Live Session-Mock Exam");
    expect(partial).toMatchObject({ wiseClassId: "c-bio", classLoaded: true });
    expect(roster.links.some((l) => l.wiseClassId === "c-bio")).toBe(true);
    // c-econ has no link at all.
    expect(roster.unmapped.find((u) => u.wiseClassId === "c-econ")).toMatchObject({ classLoaded: false });
    expect(roster.unmapped.every((u) => typeof u.classLoaded === "boolean")).toBe(true);
  });

  describe("per-subject tutors in a mixed class", () => {
    const tutorRows = (key: string, name: string, n: string) => ({
      account: { wiseTeacherId: `t-${n}`, wiseUserId: `u-${n}`, canonicalKey: key, isOnlineVariant: false, email: null },
      contact: { canonicalKey: key, displayName: name, primaryEmail: `${n}@example.test`, onsiteEmail: null, onlineEmail: null, active: true },
    });
    const rows = ["a", "b", "c"].map((n) => tutorRows(`tutor-${n}`, `Tutor ${n.toUpperCase()}`, n));
    const group = (title: string, teacher: string | null, sessionCount: number, day: number): RosterSessionRow => ({
      wiseClassId: "c-mix", title, wiseTeacherUserId: teacher && `u-${teacher}`, wiseTeacherId: teacher && `t-${teacher}`,
      sessionCount, lastStart: new Date(Date.UTC(2026, 9, day)),
    });
    function mixed(sessions: RosterSessionRow[], qualifications: RosterBuildInput["qualifications"] = []) {
      const titles = [...new Set(sessions.map((x) => x.title))];
      const subjectOf = (t: string) => (/math/i.test(t) ? "Math" : /physics/i.test(t) ? "Physics" : "Science");
      return buildIgcseRoster(fixture({
        packages: [{ wiseClassId: "c-mix", wiseStudentId: "s1", packageName: "Student One", subject: IGCSE_BAND, excludedReason: null }],
        sessions,
        accounts: rows.map((r) => r.account),
        contacts: rows.map((r) => r.contact),
        mappings: titles.map((t) => mapping("c-mix", t, subjectOf(t))),
        qualifications,
      }), NOW);
    }
    const linksOf = (r: ReturnType<typeof buildIgcseRoster>) =>
      r.links.map((l) => `${l.tutorWiseUserId}:${l.syllabus}`).sort();

    it("gives each tutor only the subjects they teach, with science from the science teacher's tags", () => {
      const roster = mixed([
        group("Live Session-Science", "b", 4, 5),
        group("Live Session-Math", "a", 6, 20), // latest session in the class belongs to the maths tutor
      ], [tag("Physics", "Y9-11", "International", "tutor-a"), tag("Biology", "Y9-11", "International", "tutor-b"), tag("Chemistry", "Y9-11", "International", "tutor-b")]);
      expect(linksOf(roster)).toEqual(["u-a:0580", "u-a:0607", "u-b:0610", "u-b:0620"]);
      expect(roster.tutors.map((t) => [t.wiseUserId, t.syllabi])).toEqual([
        ["u-a", ["0580", "0607"]], ["u-b", ["0610", "0620"]],
      ]);
    });

    it("never takes science tags from another subject's teacher", () => {
      const roster = mixed([
        group("Live Session-Science", "b", 4, 5),
        group("Live Session-Math", "a", 6, 20),
      ], [tag("Biology", "Y9-11", "International", "tutor-a")]);
      expect(linksOf(roster)).toEqual(["u-a:0580", "u-a:0607"]);
      expect(roster.unmapped).toContainEqual({
        wiseClassId: "c-mix", className: "Student One", sessionTitle: "Live Session-Science", reason: "science_no_tutor_tag", classLoaded: true,
      });
    });

    it("ignores a substitute with a single, older session", () => {
      const roster = mixed([group("Live Session-Math", "a", 8, 20), group("Live Session-Math", "c", 1, 3)]);
      expect(linksOf(roster)).toEqual(["u-a:0580", "u-a:0607"]);
    });

    it("links both teachers when each has at least the co-teaching threshold", () => {
      expect(CO_TEACHING_MIN_SESSIONS).toBe(3);
      const both = mixed([group("Live Session-Physics", "a", CO_TEACHING_MIN_SESSIONS, 20), group("Live Session-Physics", "b", CO_TEACHING_MIN_SESSIONS, 10)]);
      expect(linksOf(both)).toEqual(["u-a:0625", "u-b:0625"]);
      const one = mixed([group("Live Session-Physics", "a", CO_TEACHING_MIN_SESSIONS, 20), group("Live Session-Physics", "b", CO_TEACHING_MIN_SESSIONS - 1, 10)]);
      expect(linksOf(one)).toEqual(["u-a:0625"]);
    });

    it("counts sessions across a teacher's title variants (cancelled and live)", () => {
      const roster = mixed([
        group("Live Session-Physics", "a", 2, 20), group("Live Session-Physics (Cancelled)", "a", 1, 12),
        group("Live Session-Physics", "b", 3, 10),
      ]);
      // a has only 2 live sessions, so it is below the threshold: only the latest teacher (a) is linked.
      expect(linksOf(roster)).toEqual(["u-a:0625"]);
    });

    it("does not make a cancelled-only teacher the subject's tutor when another teacher has live sessions", () => {
      const roster = mixed([
        group("Live Session-Math", "a", 2, 5),
        group("Live Session-Math (Cancelled)", "c", 1, 25),
      ]);
      expect(linksOf(roster)).toEqual(["u-a:0580", "u-a:0607"]);
      // Cancelled titles still identify the subject when nobody else teaches it.
      const only = mixed([group("Live Session-Math (Cancelled)", "c", 1, 25)]);
      expect(linksOf(only)).toEqual(["u-c:0580", "u-c:0607"]);
    });

    it("reports a subject whose teacher cannot be resolved against the exact title", () => {
      const roster = mixed([group("Live Session-Math", "a", 3, 5), group("Live Session-Physics", null, 2, 6)]);
      expect(linksOf(roster)).toEqual(["u-a:0580", "u-a:0607"]);
      expect(roster.unmapped).toContainEqual({
        wiseClassId: "c-mix", className: "Student One", sessionTitle: "Live Session-Physics", reason: "tutor_unresolved", classLoaded: true,
      });
    });
  });

  it("reports an IGCSE class that has no sessions", () => {
    const roster = buildIgcseRoster(fixture({ sessions: [] }), NOW);
    expect(roster.links).toEqual([]);
    expect(roster.unmapped.filter((u) => u.reason === "no_sessions_in_snapshot").map((u) => u.wiseClassId).sort()).toEqual(["c-bio", "c-econ", "c-math"]);
  });
});
