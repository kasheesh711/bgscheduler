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
  creditBalanceReply,
  creditDigestMessage,
  formatBangkokDmy,
  formatCredits,
  formatDataAge,
  formatThaiDayHeading,
  formatThaiMonth,
  GROUP_HELP,
  groupConfirmModeSet,
  groupConfirmPrompt,
  groupEmptyMonth,
  groupNotExactCode,
  parentSchedulePushMessage,
  REPORT_HELP,
  reportLinkReply,
  reportNotExact,
  studentLabel,
  PUBLIC_PAGE_COPY,
  THAI_WEEKDAY_INITIALS,
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

describe("formatThaiDayHeading", () => {
  it("renders the Thai weekday and day number for the agenda heading", () => {
    // August 2026: the 1st is a Saturday.
    expect(formatThaiDayHeading("2026-08-01")).toBe("วันเสาร์ที่ 1");
    expect(formatThaiDayHeading("2026-08-03")).toBe("วันจันทร์ที่ 3");
    expect(formatThaiDayHeading("2026-08-11")).toBe("วันอังคารที่ 11");
    expect(formatThaiDayHeading("2026-08-31")).toBe("วันจันทร์ที่ 31");
  });

  it("passes malformed keys through untouched", () => {
    expect(formatThaiDayHeading("2026-08")).toBe("2026-08");
    expect(formatThaiDayHeading("nope")).toBe("nope");
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
    expect(ADMIN_HELP).toContain("/report");
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

  it("labels the view toggle in Thai", () => {
    expect(PUBLIC_PAGE_COPY.viewAgenda).toBe("รายการ");
    expect(PUBLIC_PAGE_COPY.viewCalendar).toBe("ปฏิทิน");
    expect(PUBLIC_PAGE_COPY.viewToggleLabel.length).toBeGreaterThan(0);
  });

  it("names both modalities in Thai", () => {
    expect(PUBLIC_PAGE_COPY.modalityOnline).toBe("ออนไลน์");
    expect(PUBLIC_PAGE_COPY.modalityOnsite).toBe("ที่สถาบัน");
  });

  it("orders the dot-grid weekday initials Monday-first", () => {
    expect(THAI_WEEKDAY_INITIALS).toEqual(["จ", "อ", "พ", "พฤ", "ศ", "ส", "อา"]);
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

describe("report copy", () => {
  it("lists every family member, the labeled window, and the link — no caveat", () => {
    const text = reportLinkReply({
      students: [
        { studentName: "Teethad (Copter.Th) Thamprida" },
        { studentName: "Jidapa (Jasmine.Th) Thamprida" },
      ],
      from: "2026-07-06",
      to: "2026-08-05",
      days: 30,
      url: "https://example.test/student-report/report?student=a&from=2026-07-06&to=2026-08-05",
      truncatedCount: 0,
    });

    expect(text.indexOf("📄 Teethad (Copter.Th)")).toBeLessThan(
      text.indexOf("📄 Jidapa (Jasmine.Th)"),
    );
    expect(text).toContain("Report (last 30 days, 6/7/2026 – 5/8/2026):");
    expect(text).toContain("https://example.test/student-report/report");
    expect(text).not.toContain("first 8 students");
    expect(text).not.toContain("Data as of");
  });

  it("drops the last-N-days wording for an explicit range and notes truncation", () => {
    const text = reportLinkReply({
      students: [{ studentName: "A (A.Bb) C" }],
      from: "2026-08-01",
      to: "2026-08-20",
      days: null,
      url: "https://example.test/r",
      truncatedCount: 2,
    });

    expect(text).toContain("Report (1/8/2026 – 20/8/2026):");
    expect(text).not.toContain("last");
    expect(text).toContain("Report covers the first 8 students (+2 more).");
  });

  it("help shows all three command forms", () => {
    expect(REPORT_HELP).toContain("/report Aadhu.Sr —");
    expect(REPORT_HELP).toContain("/report Aadhu.Sr 60");
    expect(REPORT_HELP).toContain("/report Aadhu.Sr 2026-08-01 2026-08-28");
  });

  it("lists candidates for a non-exact code and a bare message for none", () => {
    const text = reportNotExact("Thamprida", [
      { code: "Copter.Th", studentName: "Teethad (Copter.Th) Thamprida" },
      { code: null, studentName: "Someone Codeless" },
    ]);
    expect(text).toContain("Try /report with the full code:");
    expect(text).toContain("• Copter.Th — Teethad (Copter.Th) Thamprida");
    expect(text).toContain("• Someone Codeless");

    expect(reportNotExact("zz", [])).toBe('No student matches "zz".');
  });
});

describe("credit copy", () => {
  const GENERATED_AT = new Date("2026-08-05T01:50:00Z"); // 08:50 Bangkok
  const NOW = new Date("2026-08-05T04:40:00Z"); // 2h 50m after the snapshot

  it("renders one block per sibling with per-package lines and the caveat", () => {
    const text = creditBalanceReply({
      students: [
        {
          studentName: "Teethad (Copter.Th) Thamprida",
          totalRemaining: 4.5,
          packages: [
            { subject: "Mathematics", packageName: "Maths 20", remainingCredits: 3.5 },
            { subject: "", packageName: "Physics 10", remainingCredits: 1 },
          ],
          archivedCount: 0,
        },
        { studentName: "Jidapa (Jasmine.Th) Thamprida", totalRemaining: 0, packages: [], archivedCount: 0 },
      ],
      url: "https://example.test/student-report/report?student=a&from=2026-07-06&to=2026-08-05",
      truncatedCount: 0,
      generatedAt: GENERATED_AT,
      now: NOW,
    });

    expect(text).toContain("💳 Teethad (Copter.Th) Thamprida — 4.5 credits left");
    expect(text).toContain("• Mathematics: 3.5");
    // Blank subject falls back to the package name.
    expect(text).toContain("• Physics 10: 1");
    expect(text).toContain("💳 Jidapa (Jasmine.Th) Thamprida — no active packages");
    expect(text).toContain("Report (last 30 days):");
    expect(text).toContain("https://example.test/student-report/report");
    expect(text).not.toContain("first 8 students");
    expect(text).toContain("Data as of 2h 50m ago (5 Aug 08:50 Wise sync).");
  });

  it("singularizes a 1-credit balance and notes a truncated link", () => {
    const text = creditBalanceReply({
      students: [{
        studentName: "A (A.Bb) C",
        totalRemaining: 1,
        packages: [{ subject: "Math", packageName: "M", remainingCredits: 1 }],
        archivedCount: 0,
      }],
      url: "https://example.test/r",
      truncatedCount: 2,
      generatedAt: GENERATED_AT,
    });

    expect(text).toContain("— 1 credit left");
    expect(text).toContain("Report covers the first 8 students (+2 more).");
  });

  it("appends the hidden-count line after the package bullets", () => {
    const text = creditBalanceReply({
      students: [{
        studentName: "A (A.Bb) C",
        totalRemaining: 5,
        packages: [{ subject: "Math", packageName: "M", remainingCredits: 5 }],
        archivedCount: 2,
      }],
      url: "https://example.test/r",
      truncatedCount: 0,
      generatedAt: GENERATED_AT,
    });

    const lines = text.split("\n");
    expect(lines.indexOf("🗂 2 finished packages hidden")).toBe(lines.indexOf("• Math: 5") + 1);
  });

  it("singularizes the hidden-count line and shows it under a fully-archived student", () => {
    const text = creditBalanceReply({
      students: [{
        studentName: "A (A.Bb) C",
        totalRemaining: 0,
        packages: [],
        archivedCount: 1,
      }],
      url: "https://example.test/r",
      truncatedCount: 0,
      generatedAt: GENERATED_AT,
    });

    expect(text).toContain("💳 A (A.Bb) C — no active packages");
    expect(text).toContain("🗂 1 finished package hidden");
  });

  // CRED-01: a clock time alone reads as "just now" at any age, which is what
  // made a carried-forward balance illegible mid-conversation.
  it("renders the data age as an age, not a clock time", () => {
    const at = new Date("2026-08-05T01:50:00Z");
    expect(formatDataAge(at, new Date("2026-08-05T01:50:30Z"))).toBe("just now");
    expect(formatDataAge(at, new Date("2026-08-05T02:02:00Z"))).toBe("12m");
    expect(formatDataAge(at, new Date("2026-08-05T03:50:00Z"))).toBe("2h");
    expect(formatDataAge(at, new Date("2026-08-05T04:40:00Z"))).toBe("2h 50m");
    expect(formatDataAge(at, new Date("2026-08-06T05:00:00Z"))).toBe("1d 3h");
    expect(formatDataAge(at, new Date("2026-08-06T01:50:00Z"))).toBe("1d");
    // A snapshot stamped ahead of the reader's clock never renders negative.
    expect(formatDataAge(at, new Date("2026-08-05T01:00:00Z"))).toBe("just now");
  });

  it("formats digest rows grouped by date with weekday and D/M dates", () => {
    const text = creditDigestMessage({
      digestDateBkk: "2026-08-05",
      runsOut: [
        { exhaustDateBkk: "2026-08-06", label: "Copter.Th", subject: "Physics", remainingCredits: 1.5, studentKey: "s-copter" },
        { exhaustDateBkk: "2026-08-06", label: "Mint.Ch", subject: "Chemistry", remainingCredits: 1, studentKey: "s-mint" },
        { exhaustDateBkk: "2026-08-08", label: "Ann.Bb", subject: "Biology", remainingCredits: 2, studentKey: "s-ann" },
      ],
      alreadyOut: [
        { label: "Zed.Aa", subject: "Maths", remainingCredits: -1.5, nextClassBkk: "2026-08-07", studentKey: "s-zed" },
      ],
      dashboardUrl: "https://example.test/credit-control",
      generatedAt: GENERATED_AT,
      now: NOW,
    });

    expect(text).toContain("⚠️ Credit runout — next 7 days (5/8/2026)");
    expect(text).toContain("Already out, classes still scheduled:");
    expect(text).toContain("• Zed.Aa — Maths (-1.5, next class 7/8)");
    expect(text).toContain("6/8 (Thu)");
    expect(text).toContain("• Copter.Th — Physics (1.5 left)");
    expect(text).toContain("8/8 (Sat)");
    expect(text).toContain("• Ann.Bb — Biology (2 left)");
    // The date header appears once for the two same-day students.
    expect(text.match(/6\/8 \(Thu\)/g)).toHaveLength(1);
    // No ownership map → everyone is unassigned → the solo section header is
    // suppressed and the output keeps the pre-grouping shape.
    expect(text).not.toContain("👤");
    expect(text).toContain("Dashboard: https://example.test/credit-control");
    expect(text).toContain("Data as of 2h 50m ago (5 Aug 08:50 Wise sync).");
  });

  it("sections the digest per assigned admin in registry order, Unassigned last", () => {
    const ownership = new Map([
      ["s-zed", { key: "kem", name: "Kem" }],
      ["s-copter", { key: "palm", name: "Palm" }],
      ["s-mint", { key: "kem", name: "Kem" }],
      // s-ann deliberately unmapped → Unassigned.
    ]);
    const text = creditDigestMessage({
      digestDateBkk: "2026-08-05",
      runsOut: [
        { exhaustDateBkk: "2026-08-06", label: "Copter.Th", subject: "Physics", remainingCredits: 1.5, studentKey: "s-copter" },
        { exhaustDateBkk: "2026-08-06", label: "Mint.Ch", subject: "Chemistry", remainingCredits: 1, studentKey: "s-mint" },
        { exhaustDateBkk: "2026-08-08", label: "Ann.Bb", subject: "Biology", remainingCredits: 2, studentKey: "s-ann" },
      ],
      alreadyOut: [
        { label: "Zed.Aa", subject: "Maths", remainingCredits: -1.5, nextClassBkk: "2026-08-07", studentKey: "s-zed" },
      ],
      dashboardUrl: "https://example.test/credit-control",
      generatedAt: GENERATED_AT,
      adminOwnership: ownership,
    });

    // Registry order: Palm before Kem; Unassigned trails.
    const palmAt = text.indexOf("👤 Palm");
    const kemAt = text.indexOf("👤 Kem");
    const unassignedAt = text.indexOf("👤 Unassigned");
    expect(palmAt).toBeGreaterThan(-1);
    expect(kemAt).toBeGreaterThan(palmAt);
    expect(unassignedAt).toBeGreaterThan(kemAt);

    // Inside Kem's section the already-out row leads the runs-out block.
    const kemSection = text.slice(kemAt, unassignedAt);
    expect(kemSection).toContain("Already out, classes still scheduled:");
    expect(kemSection).toContain("• Zed.Aa — Maths (-1.5, next class 7/8)");
    expect(kemSection.indexOf("Already out")).toBeLessThan(kemSection.indexOf("Runs out:"));
    expect(kemSection).toContain("• Mint.Ch — Chemistry (1 left)");

    // The same exhaust date is re-announced per section (Palm and Kem both
    // have a 6/8 student).
    expect(text.match(/6\/8 \(Thu\)/g)).toHaveLength(2);
    expect(text.slice(palmAt, kemAt)).toContain("• Copter.Th — Physics (1.5 left)");
    expect(text.slice(unassignedAt)).toContain("• Ann.Bb — Biology (2 left)");
  });

  it("sends a heartbeat line when nothing is running out", () => {
    const text = creditDigestMessage({
      digestDateBkk: "2026-08-05",
      runsOut: [],
      alreadyOut: [],
      dashboardUrl: "https://example.test/credit-control",
      generatedAt: GENERATED_AT,
    });

    expect(text).toContain("✅ Credit check (5/8/2026) — no students running out in the next 7 days.");
    expect(text).toContain("Dashboard:");
  });

  it("truncates a very long digest under the LINE cap with a +N more line", () => {
    const runsOut = Array.from({ length: 400 }, (_, index) => ({
      exhaustDateBkk: "2026-08-06",
      label: `Student${index}.Xx`,
      subject: "Some Fairly Long Subject Name",
      remainingCredits: 1.5,
      studentKey: `s-${index}`,
    }));

    const text = creditDigestMessage({
      digestDateBkk: "2026-08-05",
      runsOut,
      alreadyOut: [],
      dashboardUrl: "https://example.test/credit-control",
      generatedAt: GENERATED_AT,
    });

    expect(text.length).toBeLessThan(5000);
    expect(text).toMatch(/…\+\d+ more — see the dashboard\./);
    expect(text).toContain("Dashboard:"); // footer survives truncation
  });

  it("never strands an admin header whose rows were all truncated away", () => {
    // Palm's rows exhaust the budget; every Kem row is dropped, so the Kem
    // header must not render (a header may only appear above its own rows).
    const ownership = new Map<string, { key: string; name: string }>();
    const runsOut = Array.from({ length: 400 }, (_, index) => {
      const key = `s-${index}`;
      ownership.set(key, index < 200 ? { key: "palm", name: "Palm" } : { key: "kem", name: "Kem" });
      return {
        exhaustDateBkk: "2026-08-06",
        label: `Student${index}.Xx`,
        subject: "Some Fairly Long Subject Name",
        remainingCredits: 1.5,
        studentKey: key,
      };
    });

    const text = creditDigestMessage({
      digestDateBkk: "2026-08-05",
      runsOut,
      alreadyOut: [],
      dashboardUrl: "https://example.test/credit-control",
      generatedAt: GENERATED_AT,
      adminOwnership: ownership,
    });

    expect(text.length).toBeLessThan(5000);
    expect(text).toContain("👤 Palm");
    expect(text).not.toContain("👤 Kem");
    expect(text).toMatch(/…\+\d+ more — see the dashboard\./);
    // Dropped-row count covers every student row that did not render.
    const rendered = (text.match(/^• /gm) ?? []).length;
    const dropped = Number(/…\+(\d+) more/.exec(text)?.[1]);
    expect(rendered + dropped).toBe(400);
  });

  it("trims credit numbers without losing real decimals", () => {
    expect(formatCredits(4)).toBe("4");
    expect(formatCredits(4.5)).toBe("4.5");
    expect(formatCredits(4.29)).toBe("4.29");
    expect(formatCredits(-1.5)).toBe("-1.5");
    expect(formatCredits(12.857142)).toBe("12.86");
  });
});
