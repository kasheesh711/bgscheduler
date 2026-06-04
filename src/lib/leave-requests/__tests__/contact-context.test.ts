import { describe, expect, it } from "vitest";
import {
  buildAffectedSessionStudentRosters,
  trustedLineChatUrlFromEvidence,
  type AffectedSessionContactRow,
} from "../data";

const OA_ID = `U${"a".repeat(32)}`;
const USER_ID = `U${"1".repeat(32)}`;
const TRUSTED_CHAT_URL = `https://chat.line.biz/${OA_ID}/chat/${USER_ID}`;

function contactRow(overrides: Partial<AffectedSessionContactRow> = {}): AffectedSessionContactRow {
  return {
    wiseSessionId: overrides.wiseSessionId ?? "session-1",
    wiseStudentId: overrides.wiseStudentId ?? "student-1",
    studentKey: overrides.studentKey ?? "ada li::parent li",
    sessionStudentName: overrides.sessionStudentName ?? "Ada Li",
    studentName: overrides.studentName === undefined ? "Ada Li" : overrides.studentName,
    parentName: overrides.parentName === undefined ? "Parent Li" : overrides.parentName,
    lineLinkId: overrides.lineLinkId === undefined ? "link-1" : overrides.lineLinkId,
    lineLinkStatus: overrides.lineLinkStatus === undefined ? "verified" : overrides.lineLinkStatus,
    lineEvidence: overrides.lineEvidence === undefined ? { originalUrl: TRUSTED_CHAT_URL } : overrides.lineEvidence,
    lineContactId: overrides.lineContactId === undefined ? "contact-1" : overrides.lineContactId,
    lineUserId: overrides.lineUserId === undefined ? USER_ID : overrides.lineUserId,
    lineDisplayName: overrides.lineDisplayName === undefined ? "Mom Ada" : overrides.lineDisplayName,
    linkedParentLabel: overrides.linkedParentLabel === undefined ? "Parent Li" : overrides.linkedParentLabel,
    linkedStudentLabel: overrides.linkedStudentLabel === undefined ? "Ada.Li" : overrides.linkedStudentLabel,
  };
}

describe("leave request affected-session contact context", () => {
  it("accepts only trusted LINE OA chat URLs", () => {
    expect(trustedLineChatUrlFromEvidence({ originalUrl: TRUSTED_CHAT_URL }, USER_ID)).toBe(TRUSTED_CHAT_URL);
    expect(trustedLineChatUrlFromEvidence({ originalUrl: TRUSTED_CHAT_URL }, `U${"2".repeat(32)}`)).toBeNull();
    expect(trustedLineChatUrlFromEvidence({ originalUrl: "https://example.com/chat" }, USER_ID)).toBeNull();
  });

  it("builds a single-student roster with verified LINE contact metadata", () => {
    const rosters = buildAffectedSessionStudentRosters([contactRow()]);
    expect(rosters.get("session-1")).toEqual([{
      wiseStudentId: "student-1",
      studentKey: "ada li::parent li",
      studentName: "Ada Li",
      parentName: "Parent Li",
      lineContacts: [{
        linkId: "link-1",
        contactId: "contact-1",
        lineUserId: USER_ID,
        displayName: "Mom Ada",
        linkedParentLabel: "Parent Li",
        linkedStudentLabel: "Ada.Li",
        lineChatUrl: TRUSTED_CHAT_URL,
      }],
    }]);
  });

  it("keeps group-class students distinct and ignores suggested LINE links", () => {
    const rosters = buildAffectedSessionStudentRosters([
      contactRow({ wiseStudentId: "student-2", studentKey: "ben li::parent li", studentName: "Ben Li", lineLinkId: null, lineContactId: null, lineUserId: null }),
      contactRow({ lineLinkStatus: "suggested" }),
    ]);

    expect(rosters.get("session-1")?.map((student) => student.studentName)).toEqual(["Ada Li", "Ben Li"]);
    expect(rosters.get("session-1")?.find((student) => student.studentName === "Ada Li")?.lineContacts).toEqual([]);
    expect(rosters.get("session-1")?.find((student) => student.studentName === "Ben Li")?.lineContacts).toEqual([]);
  });

  it("preserves parent-missing and verified-without-url states", () => {
    const rosters = buildAffectedSessionStudentRosters([
      contactRow({
        parentName: null,
        lineEvidence: { originalUrl: "https://example.com/not-line" },
      }),
    ]);

    const [student] = rosters.get("session-1") ?? [];
    expect(student.parentName).toBeNull();
    expect(student.lineContacts[0].lineChatUrl).toBeNull();
  });

  it("returns no roster when no credit-control session rows are available", () => {
    expect(buildAffectedSessionStudentRosters([]).size).toBe(0);
  });
});
