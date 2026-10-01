import { describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { latestNightlyDate, nightlyDisposition, nightlyWindow, type NightlySessionState } from "../nightly-reminder-model";
import { parseNightlyInventory } from "../nightly-reminder-source";
import { fetchWisePastSessionsByBangkokDate } from "@/lib/wise/fetchers";
import type { WiseClient } from "@/lib/wise/client";
import type { WiseSession } from "@/lib/wise/types";

const now = new Date("2026-09-29T15:00:00Z");
const state: NightlySessionState = { eligible: true, enforcementMode: "live", sourceStatus: "ready",
  canonicalTutorKey: "Buzz", lastObservedAt: now, scheduledEndAt: new Date("2026-09-29T11:00:00Z"),
  deadlineAt: new Date("2026-10-01T16:59:59Z"), assessment: { sourceStatus: "ready", adjustedCompliant: false,
    combinedRawCharCount: 0, fieldFailures: ["combined_characters:0/300"], details: { policyApplies: true } } };

describe("nightly reminder boundaries", () => {
  it("starts at 22:00 Bangkok and retains the prior night across midnight", () => {
    const activated = new Date("2026-09-29T14:59:00Z");
    expect(latestNightlyDate(new Date("2026-09-29T14:59:59Z"), activated)).toBeNull();
    expect(latestNightlyDate(now, activated)).toBe("2026-09-29");
    expect(latestNightlyDate(new Date("2026-09-29T18:00:00Z"), activated)).toBe("2026-09-29");
    expect(latestNightlyDate(now, new Date("2026-09-29T15:01:00Z"))).toBeNull();
    expect(nightlyWindow("2026-10-01").startDate).toBe("2026-09-29");
    expect(nightlyWindow("2026-10-01").endDate).toBe("2026-10-02");
  });
  it("never treats missing, stale or unreadable feedback as a valid zero", () => {
    expect(nightlyDisposition(null, now, now).status).toBe("blocked_source");
    expect(nightlyDisposition({ ...state, lastObservedAt: new Date(now.getTime() - 21 * 60_000) }, now, now).status).toBe("blocked_source");
    expect(nightlyDisposition({ ...state, sourceStatus: "unavailable" }, now, now).status).toBe("blocked_source");
    expect(nightlyDisposition({ ...state, eligible: false, sourceStatus: "unavailable" }, now, now).status).toBe("blocked_source");
    expect(nightlyDisposition({ ...state, policyCurrent: false }, now, now).status).toBe("blocked_source");
    expect(nightlyDisposition({ ...state, deleted: true, lastObservedAt: new Date(0) }, now, now).status).toBe("excluded");
    expect(nightlyDisposition(state, now, now).status).toBe("ready");
  });
  it("excludes only freshly verified no-shows when identity is unresolved", () => {
    const noShow = { ...state, eligible: false, eligibilityReason: "missed_or_no_show", sourceStatus: "identity_review", canonicalTutorKey: null, policyCurrent: true };
    expect(nightlyDisposition(noShow, now, now).status).toBe("excluded");
    expect(nightlyDisposition({ ...noShow, policyCurrent: false }, now, now).status).toBe("blocked_source");
    expect(nightlyDisposition({ ...noShow, sourceStatus: "unavailable" }, now, now).status).toBe("blocked_source");
    expect(nightlyDisposition({ ...noShow, eligibilityReason: null }, now, now).status).toBe("blocked_source");
    expect(nightlyDisposition({ ...noShow, lastObservedAt: new Date(0) }, now, now).status).toBe("blocked_source");
  });
  it("rechecks completion, policy scope and deadline before dispatch", () => {
    expect(nightlyDisposition({ ...state, assessment: { ...state.assessment!, combinedRawCharCount: 350, fieldFailures: [] } }, now, now).status).toBe("excluded");
    expect(nightlyDisposition({ ...state, eligible: false }, now, now).status).toBe("excluded");
    expect(nightlyDisposition({ ...state, deadlineAt: now }, now, now).status).toBe("expired");
    expect(nightlyDisposition({ ...state, deadlineAt: now, assessment: { ...state.assessment!, adjustedCompliant: true } }, now, now).status).toBe("excluded");
    expect(nightlyDisposition({ ...state, scheduledEndAt: new Date(now.getTime() + 1) }, now, now).status).toBe("excluded");
  });
});

describe("verified Wise discovery", () => {
  it("handles more than 13,603 rows without a spreadsheet capacity bound", async () => {
    const total = 14_221;
    const get = vi.fn(async (_path, params) => {
      const page = Number(params.page_number);
      return { data: { page_count: Math.ceil(total / 50), sessions: Array.from({ length: Math.min(50, total - (page - 1) * 50) }, (_, i) => ({ _id: `s${(page - 1) * 50 + i}` })) } };
    });
    const result = await fetchWisePastSessionsByBangkokDate({ get } as unknown as WiseClient, "institute", "2026-09-27", "2026-09-30", 50, { strict: true });
    expect(result).toHaveLength(total);
    expect(get).toHaveBeenCalledTimes(285);
  });
  it("accepts a complete empty inventory, rejects missing data and truncated pagination", async () => {
    const run = (values: unknown[]) => {
      const get = vi.fn(); values.forEach((value) => get.mockResolvedValueOnce(value));
      return fetchWisePastSessionsByBangkokDate({ get } as unknown as WiseClient, "institute", "2026-09-27", "2026-09-30", 50, { strict: true });
    };
    await expect(run([{ data: { sessions: [], page_count: 0 } }])).resolves.toEqual([]);
    await expect(run([{}])).rejects.toThrow(/incomplete/);
    await expect(run([{ data: { sessions: [{ _id: "a" }], page_count: 2 } }, { data: { sessions: [], page_count: 2 } }])).rejects.toThrow(/incomplete/);
    await expect(run([{ data: { sessions: [{ _id: "a" }], page_count: 2 } }, { data: { sessions: [{ _id: "a" }], page_count: 2 } }])).rejects.toThrow(/duplicate/);
  });
  it("filters advisory date results and classes ending after the cutoff locally", () => {
    const sessions = ["2026-09-26T10:00:00Z", "2026-09-29T14:59:00Z", "2026-09-29T15:30:00Z"].map((end, i) => ({
      _id: `s${i}`, classId: "c", meetingStatus: "ENDED", scheduledEndTime: end,
    } as WiseSession));
    expect(parseNightlyInventory(sessions, "2026-09-29").map((row) => row.wiseSessionId)).toEqual(["s1"]);
  });
});
