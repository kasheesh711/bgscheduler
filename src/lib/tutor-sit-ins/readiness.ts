import {
  coverageScopes,
  type Lesson,
  type Participant,
  type ReadinessIssue,
} from "./model";

type Student = {
  wiseStudentId: string;
  studentKey: string;
  studentName: string;
  parentName: string;
};
export function datedRoster(
  ids: string[] | null,
  students: Map<string, Student>,
) {
  const participants: Participant[] = [];
  const issues: ReadinessIssue[] = [];
  if (!ids?.length || ids.some((id) => !students.has(id)))
    issues.push({
      code: "STUDENT_ROSTER",
      category: "students",
      message: "This lesson is awaiting student verification.",
      action:
        "Verify the dated lesson's student IDs in Wise, then refresh the source sync.",
      retryable: true,
    });
  for (const id of [...new Set(ids || [])]) {
    const student = students.get(id);
    if (!student) continue;
    const parentName = student.parentName.trim() || null;
    participants.push({
      wiseStudentId: id,
      studentKey: student.studentKey,
      studentName: student.studentName,
      parentName,
      familyKey:
        parentName?.normalize("NFKC").toLowerCase().replace(/\s+/g, " ") ||
        null,
    });
  }
  if (participants.some((p) => !p.familyKey))
    issues.push({
      code: "FAMILY_CONTACT",
      category: "family",
      message: "A family contact needs review.",
      action:
        "Operations must resolve the family before acknowledging communication.",
      retryable: false,
    });
  return { participants, issues };
}

/** Summaries describe all dated lessons; they never supply a roster to a lesson. */
export function classSummaries(lessons: Lesson[]) {
  const groups = Map.groupBy(lessons, (l) => l.classId);
  return [...groups].map(([classId, rows]) => {
    const scopes = [...new Set(rows.flatMap(coverageScopes))];
    const departments = [...new Set(rows.flatMap((l) => l.departments))];
    const students = [
      ...new Map(
        rows.flatMap((l) => l.participants).map((p) => [p.studentKey, p]),
      ).values(),
    ];
    const rosterPending = rows.filter(
      (l) =>
        !l.participants.length ||
        l.issues?.some((i) => i.category === "students"),
    ).length;
    return {
      classId,
      title: rows[0].title,
      tutorName: [...new Set(rows.map((l) => l.tutorName))].join(", "),
      scopes,
      departments,
      students,
      sessionCount: rows.length,
      rosterPending,
      familyPending: rows.filter((l) =>
        l.participants.some((p) => !p.familyKey),
      ).length,
      identityPending: rows.filter((l) => !l.tutorKey).length,
      // Mapping review is independent of participant readiness.
      unresolved: !scopes.length,
    };
  });
}
