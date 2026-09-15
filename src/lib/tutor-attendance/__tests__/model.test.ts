import { describe, expect, it } from "vitest";
import {
  attendanceStatus,
  applicableSchedule,
  DEFAULT_WEEK,
  datesBetween,
  instant,
  localDate,
  requirementFor,
  weekSchema,
} from "../model";
import { clientAddress, networkRule, networkStatus } from "../network";

const date = "2026-09-14";
const required = { start: "10:00", end: "16:00", source: "schedule" };
describe("office attendance rules", () => {
  it("uses exact times with no grace period and includes normal breaks in the span", () => {
    expect(
      attendanceStatus(
        date,
        required,
        instant(date, "10:00"),
        instant(date, "16:00"),
        instant(date, "17:00"),
      ),
    ).toMatchObject({
      status: "complete",
      lateMinutes: 0,
      earlyMinutes: 0,
      spanMinutes: 360,
    });
    expect(
      attendanceStatus(
        date,
        required,
        new Date("2026-09-14T03:00:01Z"),
        instant(date, "15:59"),
        instant(date, "17:00"),
      ),
    ).toMatchObject({ lateMinutes: 1, earlyMinutes: 1, spanMinutes: 358 });
  });
  it("does not infer missing punches or completed hours", () => {
    expect(
      attendanceStatus(
        date,
        required,
        instant(date, "10:00"),
        null,
        instant("2026-09-15", "09:00"),
      ),
    ).toMatchObject({ status: "missing_out", spanMinutes: null });
    expect(
      attendanceStatus(
        date,
        required,
        null,
        instant(date, "16:00"),
        instant(date, "17:00"),
      ),
    ).toMatchObject({ status: "missing_in", spanMinutes: null });
    expect(
      attendanceStatus(date, required, null, null, instant(date, "17:00")),
    ).toMatchObject({ status: "missing", spanMinutes: null });
  });
  it("distinguishes upcoming, excused, and unscheduled visits", () => {
    expect(
      attendanceStatus(date, required, null, null, instant(date, "09:00"))
        .status,
    ).toBe("expected");
    expect(
      attendanceStatus(date, required, null, null, instant(date, "10:01"))
        .status,
    ).toBe("awaiting_arrival");
    expect(
      attendanceStatus(
        date,
        { excused: true, reason: "Leave" },
        null,
        null,
        instant(date, "18:00"),
      ).status,
    ).toBe("excused");
    expect(
      attendanceStatus(
        date,
        null,
        instant(date, "12:00"),
        instant(date, "13:00"),
        instant(date, "18:00"),
      ),
    ).toMatchObject({ status: "complete", lateMinutes: 0, spanMinutes: 60 });
  });
  it("preserves historical schedules and resolves explicit date overrides and closures", () => {
    const schedules = [
      {
        id: "old",
        canonicalKey: "a",
        effectiveFrom: date,
        week: DEFAULT_WEEK,
        revision: 1,
      },
      {
        id: "new",
        canonicalKey: "a",
        effectiveFrom: "2026-09-21",
        week: DEFAULT_WEEK.map((w) =>
          w ? { start: "11:00", end: "17:00" } : null,
        ),
        revision: 2,
      },
    ];
    expect(requirementFor(date, "a", schedules, [])).toEqual({
      ...required,
      source: "old",
    });
    expect(requirementFor("2026-09-21", "a", schedules, [])).toEqual({
      start: "11:00",
      end: "17:00",
      source: "new",
    });
    const revisedEarlier = { ...schedules[0], id: "old-revised", revision: 6 };
    expect(
      applicableSchedule("2026-09-21", "a", [...schedules, revisedEarlier])?.id,
    ).toBe("new");
    expect(
      applicableSchedule(date, "a", [...schedules, revisedEarlier])?.id,
    ).toBe("old-revised");
    const exception = {
      id: "override",
      canonicalKey: "a",
      date,
      kind: "hours",
      start: "12:00",
      end: "15:00",
      reason: "Agreed change",
      revision: 3,
    };
    expect(requirementFor(date, "a", schedules, [exception])).toMatchObject({
      start: "12:00",
      end: "15:00",
    });
    const closure = {
      ...exception,
      canonicalKey: null,
      kind: "excused",
      reason: "Office closed",
      revision: 4,
    };
    expect(requirementFor(date, "a", schedules, [exception, closure])).toEqual({
      excused: true,
      reason: "Office closed",
    });
    expect(
      requirementFor(date, "a", schedules, [
        exception,
        closure,
        { ...closure, kind: "reset", revision: 5 },
      ]),
    ).toMatchObject({ start: "12:00" });
  });
  it("handles Bangkok midnight, leap days, invalid dates and same-day windows", () => {
    expect(localDate(new Date("2026-09-14T17:00:00Z"))).toBe("2026-09-15");
    expect(datesBetween("2028-02-28", "2028-03-01")).toEqual([
      "2028-02-28",
      "2028-02-29",
      "2028-03-01",
    ]);
    expect(() => datesBetween("2026-02-30", "2026-03-01")).toThrow();
    expect(() => datesBetween("2025-01-01", "2026-12-31")).toThrow();
    expect(
      weekSchema.safeParse([
        { start: "16:00", end: "10:00" },
        ...Array(6).fill(null),
      ]).success,
    ).toBe(false);
  });
});
describe("office connection proof", () => {
  const networks = [
    { label: "Office IPv4", cidr: "8.8.8.8" },
    { label: "Office IPv6", cidr: "2001:4860:abcd::/64" },
  ];
  it("matches IPv4, mapped IPv4 and the registered IPv6 prefix", () => {
    for (const address of ["8.8.8.8", "::ffff:8.8.8.8", "2001:4860:abcd::99"])
      expect(networkStatus(address, networks).approved).toBe(true);
    for (const address of ["1.1.1.1", "2001:4860:abce::1", null])
      expect(networkStatus(address, networks).approved).toBe(false);
  });
  it("ignores client-controlled forwarding and missing platform context", () => {
    const headers = new Headers({
      "x-forwarded-for": "8.8.8.8",
      "x-real-ip": "8.8.8.8",
    });
    expect(clientAddress(headers, { VERCEL: "1" })).toBeNull();
    headers.set("x-vercel-forwarded-for", "8.8.8.8");
    expect(clientAddress(headers, {})).toBeNull();
    expect(clientAddress(headers, { VERCEL: "1" })).toBe("8.8.8.8");
    for (const value of [
      "8.8.8.8, 1.1.1.1",
      "8.8.8.8:443",
      "008.8.8.8",
      "invalid",
    ]) {
      headers.set("x-vercel-forwarded-for", value);
      expect(clientAddress(headers, { VERCEL: "1" })).toBeNull();
    }
  });
  it.each([
    "0.0.0.0/0",
    "::/0",
    "192.168.1.1",
    "127.0.0.1",
    "::1",
    "::ffff:192.168.1.1",
    "::ffff:8.8.8.8/64",
    "::8.8.8.8/64",
    "10.0.0.0/24",
    "8.8.8.8/",
    "8.8.8.8/33",
    "8.8.8.8/32/24",
    "2001:4860::/129",
  ])("rejects unsafe or malformed office rule %s", (cidr) => {
    expect(() => networkRule(cidr)).toThrow();
  });
});
