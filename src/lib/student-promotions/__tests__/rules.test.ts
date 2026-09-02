import { describe, expect, it } from "vitest";
import {
  COURSE_SUBJECT_TARGETS,
  GRADUATION_COURSE_SUBJECT_TARGETS,
  formatPromotedGrade,
  gradeActionTypeFor,
  isUnmappedRangeCourseSubject,
  parseWiseGrade,
} from "../rules";

describe("student promotion rules", () => {
  it("parses Wise year and grade labels", () => {
    expect(parseWiseGrade("Year 8")).toMatchObject({ kind: "year", currentYear: 8 });
    expect(parseWiseGrade("Y8")).toMatchObject({ kind: "year", currentYear: 8 });
    expect(parseWiseGrade("Y 11")).toMatchObject({ kind: "year", currentYear: 11 });
    expect(parseWiseGrade("Grade 8")).toMatchObject({ kind: "grade", currentYear: 9 });
    expect(parseWiseGrade("G10")).toMatchObject({ kind: "grade", currentYear: 11 });
    expect(parseWiseGrade("")).toMatchObject({ kind: "blank", currentYear: null });
    expect(parseWiseGrade("Uni")).toMatchObject({ kind: "unparsed", currentYear: null });
    expect(parseWiseGrade("11")).toMatchObject({ kind: "unparsed", currentYear: null });
  });

  it("formats the canonical promoted registration answer", () => {
    expect(formatPromotedGrade(8)).toBe("Year 9 / Grade 8");
    expect(formatPromotedGrade(11)).toBe("Year 12 / Grade 11");
  });

  it("maps exact range subjects and leaves the missing 3-student master target unmapped", () => {
    expect(COURSE_SUBJECT_TARGETS["Y2-8 / G1-7 (Int.)"].target).toBe("Y9-11 / G8-10 (Int.)");
    expect(COURSE_SUBJECT_TARGETS["(2-STU) Y9-11 / G8-10 (Int.)"].target).toBe("(2-STU) Y12-13 / G11-12 (Int.)");
    expect(COURSE_SUBJECT_TARGETS["(3-STU) Y2-8 / G1-7 (Int.) Master"].target).toBeNull();
  });

  it("maps exact Year 13 school-curriculum subjects to University variants", () => {
    expect(GRADUATION_COURSE_SUBJECT_TARGETS["Y12-13 / G11-12 (Int.)"].target).toBe("University");
    expect(GRADUATION_COURSE_SUBJECT_TARGETS["(2-STU) Y12-13 / G11-12 (Int.)"].target).toBe("(2-STU) University");
    expect(GRADUATION_COURSE_SUBJECT_TARGETS["(3-STU) Y12-13 / G11-12 (Int.) Master"].target).toBe("(3-STU) University Master");
  });

  it("does not silently accept spacing, receipt, or trial variants as exact course mappings", () => {
    expect(isUnmappedRangeCourseSubject("Y 2-8 / G1-7 (Int.)")).toBe(true);
    expect(isUnmappedRangeCourseSubject("(2-STU) Y9-11 / G8-10 (Int.) for receipt")).toBe(true);
    expect(isUnmappedRangeCourseSubject("Trial - Y9-11 / G8-10 (Int.)")).toBe(true);
  });

  it("only marks course-grade actions for students already in the matching source band", () => {
    expect(gradeActionTypeFor(8, ["Y2-8 / G1-7 (Int.)"])).toBe("year8_course_and_grade");
    expect(gradeActionTypeFor(11, ["Y9-11 / G8-10 (Int.)"])).toBe("year11_course_and_grade");
    expect(gradeActionTypeFor(13, ["Y12-13 / G11-12 (Int.)"])).toBe("graduation_review");
    expect(gradeActionTypeFor(8, ["Y9-11 / G8-10 (Int.)"])).toBe("grade_increment_only");
  });
});
