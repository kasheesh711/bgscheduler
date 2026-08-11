import { describe, expect, it } from "vitest";

import {
  ADMIN_HELP,
  adminAmbiguous,
  adminConfirmPrompt,
  adminEmptyMonth,
  adminMultipleContacts,
  adminNoVerifiedContact,
  adminNotFound,
  adminSent,
  formatBangkokDmy,
  formatThaiMonth,
  GROUP_HELP,
  groupConfirmModeSet,
  groupConfirmPrompt,
  groupEmptyMonth,
  groupNotExactCode,
  parentSchedulePushMessage,
  studentLabel,
  PUBLIC_PAGE_COPY,
} from "@/lib/line/schedule-bot-copy";

describe("formatThaiMonth", () => {
  it("renders Thai month names with a Gregorian year", () => {
    expect(formatThaiMonth("2026-01")).toBe("มกราคม 2026");
    expect(formatThaiMonth("2026-08")).toBe("สิงหาคม 2026");
    expect(formatThaiMonth("2026-12")).toBe("ธันวาคม 2026");
  });

  it("passes malformed keys through untouched", () => {
    expect(formatThaiMonth("2026-8")).toBe("2026-8");
    expect(formatThaiMonth("nope")).toBe("nope");
  });
});

describe("formatBangkokDmy", () => {
  it("formats D/M/YYYY in Bangkok, not UTC", () => {
    // 23:30 UTC on 3 Sep is already 4 Sep in Bangkok.
    expect(formatBangkokDmy(new Date("2026-09-03T23:30:00Z"))).toBe("4/9/2026");
    expect(formatBangkokDmy(new Date("2026-09-04T03:00:00Z"))).toBe("4/9/2026");
  });
});

describe("parentSchedulePushMessage", () => {
  const message = parentSchedulePushMessage({
    shortName: "Aadhu",
    monthKey: "2026-08",
    url: "https://bgscheduler.vercel.app/schedule/tok_abc",
    expiresAt: new Date("2026-09-04T03:00:00Z"),
  });

  it("leads in Thai and carries the link, month and expiry", () => {
    expect(message.startsWith("สวัสดีค่ะ")).toBe(true);
    expect(message).toContain("ตารางเรียนเดือนสิงหาคม 2026");
    expect(message).toContain("https://bgscheduler.vercel.app/schedule/tok_abc");
    expect(message).toContain("4/9/2026");
  });

  it("uses the nickname only — never a full name", () => {
    expect(message).toContain("น้องAadhu");
    const full = parentSchedulePushMessage({
      shortName: "Aadhu",
      monthKey: "2026-08",
      url: "https://x.test/schedule/t",
      expiresAt: new Date("2026-09-04T03:00:00Z"),
    });
    expect(full).not.toContain("Srisethi");
  });

  it("includes an English tail for international families", () => {
    expect(message).toContain("Here is Aadhu's class schedule for August 2026");
  });

  it("tells the parent the link stays current", () => {
    expect(message).toContain("อัปเดตให้อัตโนมัติ");
    expect(message).toContain("updates automatically");
  });
});

describe("adminConfirmPrompt", () => {
  const prompt = adminConfirmPrompt({
    studentName: "Aadhiya Srisethi",
    code: "Aadhu.Sr",
    monthKey: "2026-08",
    sessionCount: 12,
    recipientDisplayName: "Khun Nok",
    parentName: "Nok Srisethi",
    ttlMinutes: 5,
  });

  it("echoes all four fields so a wrong code is visible before sending", () => {
    expect(prompt).toContain("Aadhiya Srisethi (Aadhu.Sr)"); // student
    expect(prompt).toContain("August 2026");                 // month
    expect(prompt).toContain("12 classes");                  // count
    expect(prompt).toContain("Khun Nok");                    // recipient
  });

  it("states how to confirm and when it lapses", () => {
    expect(prompt).toContain("Reply YES to send");
    expect(prompt).toContain("Expires in 5 min");
  });

  it("singularises a one-class month", () => {
    const single = adminConfirmPrompt({
      studentName: "A", code: null, monthKey: "2026-08", sessionCount: 1,
      recipientDisplayName: "R", parentName: "", ttlMinutes: 5,
    });
    expect(single).toContain("1 class");
    expect(single).not.toContain("1 classes");
  });
});

describe("admin refusals", () => {
  it("points at the page that fixes each problem", () => {
    expect(adminNotFound("aadhu.sn")).toContain("/student-schedule");
    expect(adminNoVerifiedContact("Aadhiya Srisethi")).toContain("/line-review");
  });

  it("lists ambiguous candidates by code", () => {
    const text = adminAmbiguous("aadhu", [
      { code: "Aadhu.Sr", studentName: "Aadhiya Srisethi" },
      { code: null, studentName: "Aadhuwat Chai" },
    ]);
    expect(text).toContain("2 students match");
    expect(text).toContain("• Aadhu.Sr — Aadhiya Srisethi");
    expect(text).toContain("• Aadhuwat Chai");
  });

  it("numbers multiple verified contacts", () => {
    const text = adminMultipleContacts("Aadhiya Srisethi", [
      { displayName: "Khun Nok" },
      { displayName: "Khun Dad" },
    ]);
    expect(text).toContain("1. Khun Nok");
    expect(text).toContain("2. Khun Dad");
    expect(text).toContain("reply 1 or 2");
  });

  it("names the month when refusing an empty one", () => {
    expect(adminEmptyMonth("Aadhiya Srisethi", "2026-08"))
      .toBe("Aadhiya Srisethi has no classes in August 2026. Nothing sent.");
  });

  it("confirms a send with the recipient and expiry", () => {
    expect(adminSent("Khun Nok", new Date("2026-09-04T03:00:00Z")))
      .toBe("✅ Sent to Khun Nok. Link expires 4/9/2026.");
  });

  it("documents the grammar in help", () => {
    expect(ADMIN_HELP).toContain("Aadhu.Sr");
    expect(ADMIN_HELP).toContain("2026-09");
    expect(ADMIN_HELP).toContain("YES");
  });
});

describe("group replies", () => {
  it("names the student, month and class count before a first send", () => {
    const prompt = groupConfirmPrompt({
      studentName: "Aadhiya Srisethi",
      code: "Aadhu.Sr",
      monthKey: "2026-08",
      sessionCount: 12,
      ttlMinutes: 5,
    });
    expect(prompt).toContain("Aadhiya Srisethi (Aadhu.Sr)");
    expect(prompt).toContain("August 2026");
    expect(prompt).toContain("12 classes");
    expect(prompt).toContain("Reply YES within 5 min");
  });

  it("lists candidates for a near-miss code", () => {
    const text = groupNotExactCode("aadhu", [
      { code: "Aadhu.Sr", studentName: "Aadhiya Srisethi" },
      { code: "Aadhu.Vi", studentName: "Aadhuwat Vichai" },
    ]);
    expect(text).toContain("isn't an exact code");
    expect(text).toContain("• Aadhu.Sr — Aadhiya Srisethi");
  });

  it("says only that nothing matched when there are no candidates", () => {
    // A group contains parents, so an empty result must not hint at other families.
    expect(groupNotExactCode("aadhu.sn", [])).toBe('No student matches "aadhu.sn".');
  });

  it("keeps the empty-month notice free of internal wording", () => {
    expect(groupEmptyMonth("Aadhiya", "2026-08"))
      .toBe("Aadhiya has no classes in August 2026.");
  });

  it("warns about the lost checkpoint and names the way back when instant mode turns on", () => {
    const text = groupConfirmModeSet(true);
    expect(text).toContain("instant mode");
    expect(text).toContain("no YES needed");
    expect(text).toContain("/schedule setup confirm");
  });

  it("says the YES gate is back when instant mode turns off", () => {
    expect(groupConfirmModeSet(false)).toContain("YES");
  });

  it("advertises the instant-mode toggle in help", () => {
    expect(GROUP_HELP).toContain("/schedule setup instant");
    expect(GROUP_HELP).toContain("/schedule setup confirm");
  });
});

describe("public page copy", () => {
  it("gives one message for every failure mode", () => {
    expect(PUBLIC_PAGE_COPY.expired).toContain("หมดอายุ");
    expect(PUBLIC_PAGE_COPY.expired).toContain("This link has expired");
    // Must not hint at WHY it failed — no "not found" / "revoked" wording.
    expect(PUBLIC_PAGE_COPY.expired.toLowerCase()).not.toContain("not found");
    expect(PUBLIC_PAGE_COPY.expired.toLowerCase()).not.toContain("revoked");
    expect(PUBLIC_PAGE_COPY.expired.toLowerCase()).not.toContain("invalid");
  });
});

describe("studentLabel", () => {
  it("does not repeat a code the Wise name already carries", () => {
    // Regression seen in production: "Teethad (Copter.Th) Thamprida (Copter.Th)".
    expect(studentLabel("Teethad (Copter.Th) Thamprida", "Copter.Th"))
      .toBe("Teethad (Copter.Th) Thamprida");
  });

  it("appends the code when the name lacks it", () => {
    expect(studentLabel("Teethad Thamprida", "Copter.Th"))
      .toBe("Teethad Thamprida (Copter.Th)");
  });

  it("matches case-insensitively", () => {
    expect(studentLabel("Teethad (copter.th) Thamprida", "Copter.Th"))
      .toBe("Teethad (copter.th) Thamprida");
  });

  it("passes the name through when there is no code", () => {
    expect(studentLabel("Somchai Jaidee", null)).toBe("Somchai Jaidee");
  });
});
