import { afterEach, describe, expect, it, vi } from "vitest";
import { assignmentReadinessFindings, notificationForReport, readinessForFindings, resolveReadinessRoom, type ReadinessRow, type WeekendReport } from "../weekend-readiness";
import { buildWeekendEmail } from "../weekend-email";
import { isWeekendCheckDue, weekendDates, weekendAlertRecipient } from "../weekend-config";

const rooms = [{ name: "A", capacity: 2, hasTv: false, category: "standard" as const, active: true, sortOrder: 0 },
  { name: "B", capacity: 5, hasTv: true, category: "standard" as const, active: true, sortOrder: 1 },
  { name: "Online", capacity: 1, hasTv: false, category: "online_only" as const, active: true, sortOrder: 2 }];
const row = (id: string, overrides: Partial<ReadinessRow> = {}): ReadinessRow => ({ wiseSessionId: id, tutorDisplayName: id,
  status: "assigned", startMinute: 600, endMinute: 660, currentWiseLocation: "A", assignedRoom: "A", minCapacity: 1,
  needsTv: false, warnings: [], sessionType: "OFFLINE", ...overrides });
const findings = (rows: ReadinessRow[]) => assignmentReadinessFindings({ date: "2026-09-12", rows, rooms });
afterEach(() => vi.unstubAllEnvs());

describe("weekend classroom readiness", () => {
  it("reports missing rooms on either weekend date even when a run completed", () => {
    for (const date of ["2026-09-12", "2026-09-13"]) {
      const result = assignmentReadinessFindings({ date, rows: [row("blocked", { status: "no_room", assignedRoom: "NO_ROOM_AVAILABLE" })], rooms });
      expect(result).toEqual([expect.objectContaining({ date, kind: "no_room", tutor: "blocked", startMinute: 600 })]);
      expect(readinessForFindings(result)).toBe("attention");
    }
  });
  it("accepts back-to-back classes but flags overlapping room assignments", () => {
    expect(findings([row("one"), row("two", { startMinute: 660, endMinute: 720 })])).toEqual([]);
    expect(findings([row("one"), row("two", { startMinute: 630, endMinute: 690 })]).filter(f => f.kind === "conflict")).toHaveLength(2);
  });
  it("checks capacity, TVs, inactive rooms and onsite use of online-only rooms", () => {
    for (const overrides of [{ minCapacity: 3 }, { needsTv: true }, { assignedRoom: "Online" }, { assignedRoom: "missing" }]) {
      expect(findings([row("class", overrides)]).some(f => f.kind === "review")).toBe(true);
    }
    const result = assignmentReadinessFindings({ date: "2026-09-12", rows: [row("class")], rooms: rooms.map(r => ({ ...r, active: false })) });
    expect(readinessForFindings(result)).toBe("attention");
  });
  it("never lets an inactive legacy room shadow its active TV room, in either catalog order", () => {
    const old = { ...rooms[0], name: "Keep Going", active: false };
    const current = { ...rooms[1], name: "Keep Going (TV)" };
    for (const catalog of [[old, current], [current, old]]) {
      for (const location of ["Keep Going (TV)", " Keep Going "]) {
        expect(assignmentReadinessFindings({ date: "2026-09-12", rooms: catalog,
          rows: [row("valid", { currentWiseLocation: location, assignedRoom: location, needsTv: true })] })).toEqual([]);
      }
    }
  });
  it("prefers the exact active room and refuses ambiguous, inactive-only or missing aliases", () => {
    const plain = { ...rooms[0], name: "Iconic" };
    const tv = { ...rooms[1], name: "Iconic (TV)" };
    expect(resolveReadinessRoom([plain, tv], " ICONIC (TV) ")).toBe(tv);
    expect(resolveReadinessRoom([tv, plain], "Iconic")).toBe(plain);
    expect(resolveReadinessRoom([tv, { ...tv, name: " ICONIC (TV) " }], "Iconic")).toBeUndefined();
    expect(resolveReadinessRoom([{ ...tv, active: false }], "Iconic (TV)")).toBeUndefined();
    expect(resolveReadinessRoom([tv], "Other")).toBeUndefined();
    const result = assignmentReadinessFindings({ date: "2026-09-12", rooms: [plain, tv],
      rows: [row("invalid", { currentWiseLocation: "Iconic", assignedRoom: "Iconic", needsTv: true })] });
    expect(result.filter(finding => finding.kind === "review")).toHaveLength(2);
  });
  it("checks center-based online classes while excluding genuinely remote sessions", () => {
    expect(findings([row("remote", { status: "remote", sessionType: "SCHEDULED", assignedRoom: "REMOTE_NO_ROOM_NEEDED" })])).toEqual([]);
    expect(findings([row("center", { sessionType: "SCHEDULED", status: "no_room" })])[0].kind).toBe("no_room");
  });
  it("does not clear live conflicts just because the preview found a move", () => {
    const rows = [row("one"), row("two", { assignedRoom: "B" })];
    const result = assignmentReadinessFindings({ date: "2026-09-12", rows, rooms,
      liveRoomBlocks: rows.map(r => ({ ...r, location: "A", className: r.wiseSessionId })) });
    expect(result.filter(f => f.kind === "conflict")).toHaveLength(2);
    expect(result[0].message).toContain("still needs to be applied");
  });
  it("retains an incompatible live booking as a finding even if the proposed room fits", () => {
    const result = findings([row("group", { minCapacity: 4, assignedRoom: "B" })]);
    expect(result[0].message).toContain("existing Wise booking");
    expect(result[0].message).toContain("still needs to be applied");
  });
  it("cannot report clear when modality or capacity is unknown", () => {
    expect(readinessForFindings(findings([row("unknown", { sessionType: null })]))).toBe("unverified");
    expect(readinessForFindings(findings([row("unknown", { status: "needs_review", warnings: ["needs_review_missing_capacity"] })]))).toBe("attention");
  });
  it("labels search exhaustion as uncertainty, without inventing a numerical room deficit", () => {
    const result = findings([row("blocked", { status: "no_room", warnings: ["room_repair_search_exhausted"] })]);
    expect(result[0].message).toContain("search limit");
    expect(result[0].message).not.toContain("overbooked");
  });
  it("repeats warnings, resolves only a delivered warning, and leaves ordinary clear checks quiet", () => {
    expect(notificationForReport("attention", "warning")).toBe("warning");
    expect(notificationForReport("unverified", null)).toBe("warning");
    expect(notificationForReport("clear", "warning")).toBe("resolved");
    expect(notificationForReport("clear", "resolved")).toBeNull();
    expect(notificationForReport("clear", null)).toBeNull();
  });
});

describe("private weekend schedule and email", () => {
  it.each([
    ["2026-09-09T02:00:00Z", "2026-09-12", "2026-09-13"],
    ["2026-12-30T02:00:00Z", "2027-01-02", "2027-01-03"],
    ["2027-01-29T02:00:00Z", "2027-01-30", "2027-01-31"],
    ["2026-09-12T17:30:00Z", "2026-09-12", "2026-09-13"],
  ])("uses Bangkok weekend dates for %s", (now, saturday, sunday) => {
    expect(weekendDates(new Date(now))).toEqual([saturday, sunday]);
  });
  it("runs only after activation on Wednesday, Thursday and Friday", () => {
    vi.stubEnv("CLASSROOM_WEEKEND_ALERTS_ENABLED_AT", "2026-09-07T05:00:00Z");
    for (let day = 7; day <= 13; day++) expect(isWeekendCheckDue(new Date(`2026-09-${String(day).padStart(2, "0")}T02:00:00Z`))).toBe(day >= 9 && day <= 11);
    expect(isWeekendCheckDue(new Date("2026-09-04T02:00:00Z"))).toBe(false);
  });
  it("requires one explicit email address with no admin-list fallback", () => {
    vi.stubEnv("CLASSROOM_WEEKEND_ALERT_EMAIL", "kevhsh7@gmail.com");
    expect(weekendAlertRecipient()).toBe("kevhsh7@gmail.com");
    vi.stubEnv("CLASSROOM_WEEKEND_ALERT_EMAIL", "");
    expect(() => weekendAlertRecipient()).toThrow();
    vi.stubEnv("CLASSROOM_WEEKEND_ALERT_EMAIL", "one@example.com,two@example.com");
    expect(() => weekendAlertRecipient()).toThrow();
  });
  it("includes actionable dates, times, requirements, safe HTML and dated report links", () => {
    const report: WeekendReport = { checkedAt: "2026-09-09T02:03:00Z", dates: ["2026-09-12", "2026-09-13"], snapshotId: "snapshot", snapshotFinishedAt: "2026-09-09T02:01:00Z",
      readiness: "attention", days: [{ date: "2026-09-12", liveSessions: 23, plannedSessions: 23, noRoomCount: 1 }],
      findings: findings([row("<Teacher>", { status: "no_room", needsTv: true })]) };
    const email = buildWeekendEmail(report, "check-id", "warning");
    expect(email.subject).toContain("ACTION REQUIRED");
    expect(email.text).toContain("10:00–11:00");
    expect(email.text).toContain("1 seat(s) and a TV");
    expect(email.text).toContain("date=2026-09-13&weekendCheck=check-id");
    expect(email.html).toContain("&lt;Teacher&gt;");
    expect(email.html).not.toContain("<Teacher>");
  });
});
