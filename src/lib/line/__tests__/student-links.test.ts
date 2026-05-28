import { describe, expect, it } from "vitest";
import {
  matchLineStudentCodesToStudents,
  parseLineStudentCodes,
} from "@/lib/line/student-links";

describe("LINE student link parsing", () => {
  it("expands shared suffixes in multi-student LINE labels", () => {
    expect(parseLineStudentCodes("𝓜 ✅ Kin/Claire.Ak").map((code) => code.code)).toEqual([
      "Kin.Ak",
      "Claire.Ak",
    ]);
  });

  it("keeps explicit suffixes and ignores visual prefixes", () => {
    expect(parseLineStudentCodes("𝓒 Ada.Li / Aya.Li").map((code) => code.code)).toEqual([
      "Ada.Li",
      "Aya.Li",
    ]);
    expect(parseLineStudentCodes("𝓟✅Jasmine/Copter.Th").map((code) => code.code)).toEqual([
      "Jasmine.Th",
      "Copter.Th",
    ]);
  });

  it("matches parsed codes against active Wise student rows", () => {
    const parsed = parseLineStudentCodes("Kin/Claire.Ak");
    const matches = matchLineStudentCodesToStudents(parsed, [
      {
        wiseStudentId: "wise-kin",
        studentKey: "kin.ak::parent",
        studentName: "Kin.Ak",
        parentName: "Parent",
      },
      {
        wiseStudentId: "wise-claire",
        studentKey: "claire.ak::parent",
        studentName: "Claire.AK",
        parentName: "Parent",
      },
      {
        wiseStudentId: "wise-other",
        studentKey: "other::parent",
        studentName: "Other.Student",
        parentName: "Parent",
      },
    ]);

    expect(matches.map((match) => match.student.wiseStudentId)).toEqual(["wise-kin", "wise-claire"]);
  });
});
