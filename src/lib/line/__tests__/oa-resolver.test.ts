import { describe, expect, it } from "vitest";
import {
  buildLineOaResolverWorklist,
  parseLineOaChatUrl,
  preferredLineOaSearchCode,
} from "@/lib/line/oa-resolver";
import type { LineStudentDirectoryRow } from "@/lib/line/student-links";

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

describe("LINE OA resolver", () => {
  it("parses LINE OA chat URLs", () => {
    expect(parseLineOaChatUrl(
      "https://chat.line.biz/Ueebc1942ed1ed3bd52bb0c6e8d122565/chat/U9fdc5658d0c2cbfc02d0a2acc89fdb6d",
    )).toEqual({
      lineOaAccountId: "Ueebc1942ed1ed3bd52bb0c6e8d122565",
      lineUserId: "U9fdc5658d0c2cbfc02d0a2acc89fdb6d",
    });
  });

  it("rejects malformed or non-LINE OA URLs", () => {
    expect(parseLineOaChatUrl("https://example.com/Ueebc1942ed1ed3bd52bb0c6e8d122565/chat/U9fdc5658d0c2cbfc02d0a2acc89fdb6d")).toBeNull();
    expect(parseLineOaChatUrl("https://chat.line.biz/not-a-line-id/chat/U9fdc5658d0c2cbfc02d0a2acc89fdb6d")).toBeNull();
    expect(parseLineOaChatUrl("https://chat.line.biz/Ueebc1942ed1ed3bd52bb0c6e8d122565/profile/U9fdc5658d0c2cbfc02d0a2acc89fdb6d")).toBeNull();
  });

  it("prefers nickname codes in Wise names", () => {
    expect(preferredLineOaSearchCode(student({
      studentName: "Jidapa (Jasmine.Th) Thamprida",
      studentKey: "jidapa (jasmine.th) thamprida::kanokwan thamprida",
    }))).toEqual({
      code: "Jasmine.Th",
      matchedField: "nickname_code",
    });
  });

  it("builds current-snapshot worklist rows, including inactive students", () => {
    const rows = buildLineOaResolverWorklist([
      student({
        wiseStudentId: "wise-jasmine",
        studentName: "Jidapa (Jasmine.Th) Thamprida",
        studentKey: "jidapa (jasmine.th) thamprida::kanokwan",
        activated: true,
      }),
      student({
        wiseStudentId: "wise-corbin",
        studentName: "Corbin (Corbin.Wa) Warden",
        studentKey: "corbin (corbin.wa) warden::chinintorn",
        activated: false,
      }),
      student({
        wiseStudentId: "wise-no-code",
        studentName: "No Dotted Code",
        studentKey: "no-code::parent",
      }),
    ]);

    expect(rows.map((row) => ({
      wiseStudentId: row.wiseStudentId,
      searchCode: row.searchCode,
      status: row.status,
      activated: row.evidence.activated,
    }))).toEqual([
      {
        wiseStudentId: "wise-jasmine",
        searchCode: "Jasmine.Th",
        status: "pending",
        activated: true,
      },
      {
        wiseStudentId: "wise-corbin",
        searchCode: "Corbin.Wa",
        status: "pending",
        activated: false,
      },
      {
        wiseStudentId: "wise-no-code",
        searchCode: null,
        status: "needs_manual_code",
        activated: true,
      },
    ]);
  });
});
