import { describe, expect, it } from "vitest";
import {
  findAutoResolvedProposalItemIds,
  isProposalActiveAt,
  proposalHoldBlocksSearchSlot,
  proposalSlotsOverlap,
} from "@/lib/proposals/overlap";
import type { ProposalHoldSummary } from "@/lib/proposals/types";

function hold(overrides: Partial<ProposalHoldSummary> = {}): ProposalHoldSummary {
  return {
    itemId: "item-1",
    bundleId: "bundle-1",
    studentLabel: "Beam",
    tutorCanonicalKey: "kevin",
    tutorDisplayName: "Kevin",
    scope: "recurring",
    weekday: 1,
    startMinute: 900,
    endMinute: 990,
    startTime: "15:00",
    endTime: "16:30",
    status: "pending",
    createdAt: "2026-05-15T00:00:00.000Z",
    expiresAt: "2026-05-17T00:00:00.000Z",
    ...overrides,
  };
}

describe("proposal overlap helpers", () => {
  it("keeps pending holds active only before expiry", () => {
    expect(isProposalActiveAt("pending", "2026-05-17T00:00:00.000Z", new Date("2026-05-16T23:59:00.000Z"))).toBe(true);
    expect(isProposalActiveAt("pending", "2026-05-17T00:00:00.000Z", new Date("2026-05-17T00:00:00.000Z"))).toBe(false);
    expect(isProposalActiveAt("confirmed", null, new Date("2026-05-20T00:00:00.000Z"))).toBe(true);
  });

  it("detects same-tutor overlapping recurring holds", () => {
    expect(proposalSlotsOverlap(hold(), hold({ itemId: "item-2", startMinute: 960, endMinute: 1020 }))).toBe(true);
    expect(proposalSlotsOverlap(hold(), hold({ itemId: "item-2", weekday: 2, startMinute: 960, endMinute: 1020 }))).toBe(false);
  });

  it("detects one-time overlaps only on the same date", () => {
    const base = hold({ scope: "one_time", date: "2026-05-18", weekday: 1 });
    expect(proposalSlotsOverlap(base, hold({ scope: "one_time", date: "2026-05-18", weekday: 1, startMinute: 960, endMinute: 1020 }))).toBe(true);
    expect(proposalSlotsOverlap(base, hold({ scope: "one_time", date: "2026-05-25", weekday: 1, startMinute: 960, endMinute: 1020 }))).toBe(false);
  });

  it("lets recurring holds block one-time searches on the same weekday", () => {
    expect(proposalHoldBlocksSearchSlot(hold(), {
      searchMode: "one_time",
      weekday: 1,
      date: "2026-05-18",
      startMinute: 960,
      endMinute: 1020,
    })).toBe(true);
  });

  it("does not let one-time holds block recurring searches forever", () => {
    expect(proposalHoldBlocksSearchSlot(hold({ scope: "one_time", date: "2026-05-18" }), {
      searchMode: "recurring",
      weekday: 1,
      startMinute: 960,
      endMinute: 1020,
    })).toBe(false);
  });

  it("auto-resolves confirmed holds when Wise has an overlapping session", () => {
    const ids = findAutoResolvedProposalItemIds(
      [hold({ status: "confirmed", expiresAt: undefined })],
      [{
        tutorCanonicalKey: "kevin",
        weekday: 1,
        startMinute: 930,
        endMinute: 990,
        date: "2026-05-18",
      }],
    );
    expect(ids).toEqual(["item-1"]);
  });
});
