import { describe, expect, it } from "vitest";
import {
  matchLineStudentCodesToStudents,
  parseLineStudentCodes,
  resolveLineStudentCodeMatches,
  searchLineStudentRows,
  type LineStudentDirectoryRow,
} from "@/lib/line/student-links";

function student(overrides: Partial<LineStudentDirectoryRow>): LineStudentDirectoryRow {
  return {
    wiseStudentId: "wise-student",
    studentKey: "student::parent",
    studentName: "Student",
    parentName: "Parent",
    activated: true,
    hasFutureSessions: false,
    hasLivePackage: false,
    ...overrides,
  };
}

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
    expect(parseLineStudentCodes("𝓟☑️Jasmine/Copter.Th = jasmine.th and copter.th").map((code) => code.code)).toEqual([
      "Jasmine.Th",
      "Copter.Th",
    ]);
  });

  it("matches parsed codes against active Wise student rows", () => {
    const parsed = parseLineStudentCodes("Kin/Claire.Ak");
    const matches = matchLineStudentCodesToStudents(parsed, [
      student({
        wiseStudentId: "wise-kin",
        studentKey: "kin.ak::parent",
        studentName: "Kin.Ak",
        parentName: "Parent",
      }),
      student({
        wiseStudentId: "wise-claire",
        studentKey: "claire.ak::parent",
        studentName: "Claire.AK",
        parentName: "Parent",
      }),
      student({
        wiseStudentId: "wise-other",
        studentKey: "other::parent",
        studentName: "Other.Student",
        parentName: "Parent",
      }),
    ]);

    expect(matches.map((match) => match.student.wiseStudentId)).toEqual(["wise-kin", "wise-claire"]);
  });

  it("matches parent-facing nickname codes inside Wise student names and keys", () => {
    const parsed = parseLineStudentCodes("𝓟☑️Jasmine/Copter.Th = jasmine.th and copter.th");
    const matches = matchLineStudentCodesToStudents(parsed, [
      student({
        wiseStudentId: "wise-jasmine",
        studentKey: "jidapa (jasmine.th) thamprida::kanokwan thamprida",
        studentName: "Jidapa (Jasmine.Th) Thamprida",
        parentName: "Kanokwan Thamprida",
      }),
      student({
        wiseStudentId: "wise-copter",
        studentKey: "teethad (copter.th) thamprida::kanokwan thamprida",
        studentName: "Teethad (Copter.Th) Thamprida",
        parentName: "Kanokwan Thamprida",
      }),
    ]);

    expect(matches.map((match) => ({
      wiseStudentId: match.student.wiseStudentId,
      matchedCode: match.parsed.normalized,
      matchType: match.matchType,
    }))).toEqual([
      {
        wiseStudentId: "wise-jasmine",
        matchedCode: "jasmine.th",
        matchType: "nickname_code",
      },
      {
        wiseStudentId: "wise-copter",
        matchedCode: "copter.th",
        matchType: "nickname_code",
      },
    ]);
  });

  it("matches inactive current-snapshot students by nickname code", () => {
    const rows = [
      student({
        wiseStudentId: "wise-corbin",
        studentKey: "corbin (corbin.wa) warden::chinintorn nakhata",
        studentName: "Corbin (Corbin.Wa) Warden",
        parentName: "Chinintorn Nakhata",
        activated: false,
        hasFutureSessions: true,
        hasLivePackage: true,
      }),
    ];

    const matches = matchLineStudentCodesToStudents(parseLineStudentCodes("corbin.wa"), rows);

    expect(matches).toHaveLength(1);
    expect(matches[0].student.wiseStudentId).toBe("wise-corbin");
    expect(matches[0].student.activated).toBe(false);
    expect(matches[0].matchType).toBe("nickname_code");
  });

  it("falls back to explicit helper text after annotation when the LINE label has no match", () => {
    const result = resolveLineStudentCodeMatches("Pom Corbin = corbin.wa", [
      student({
        wiseStudentId: "wise-corbin",
        studentKey: "corbin (corbin.wa) warden::chinintorn nakhata",
        studentName: "Corbin (Corbin.Wa) Warden",
        parentName: "Chinintorn Nakhata",
        activated: false,
        hasFutureSessions: true,
        hasLivePackage: true,
      }),
    ]);

    expect(result.evidenceSource).toBe("admin_helper_text");
    expect(result.parsedCodes.map((code) => code.normalized)).toEqual(["corbin.wa"]);
    expect(result.matches.map((match) => match.student.wiseStudentId)).toEqual(["wise-corbin"]);
  });

  it("ranks exact inactive code matches ahead of broader active matches", () => {
    const results = searchLineStudentRows([
      student({
        wiseStudentId: "wise-active-parent",
        studentKey: "corbin.wa old label::parent",
        studentName: "Other Student",
        parentName: "Corbin Wa Parent",
        activated: true,
      }),
      student({
        wiseStudentId: "wise-corbin",
        studentKey: "corbin (corbin.wa) warden::chinintorn nakhata",
        studentName: "Corbin (Corbin.Wa) Warden",
        parentName: "Chinintorn Nakhata",
        activated: false,
        hasFutureSessions: true,
        hasLivePackage: true,
      }),
    ], "corbin.wa");

    expect(results.map((row) => row.wiseStudentId)).toEqual(["wise-corbin", "wise-active-parent"]);
    expect(results[0].matchType).toBe("exact_code");
    expect(results[0].activated).toBe(false);
  });
});
