import { describe, it, expect } from "vitest";
import { getRecommendedSlots } from "../recommend";
import type { RangeSearchResponse, RangeGridRow, BlockingSessionInfo } from "../types";

// ─── Fixture helpers ──────────────────────────────────────────────────
//
// RangeGridRow.availability is `(true | BlockingSessionInfo[])[]` in
// src/lib/search/types.ts — recommend.ts gates on `=== true`, so for tests
// we use `true` to signal "available" and `[]` (empty BlockingSessionInfo
// array) to signal "unavailable".

const BLOCKED: BlockingSessionInfo[] = [];

function makeRow(
  id: string,
  availability: (true | BlockingSessionInfo[])[],
  supportedModes: string[] = ["online"],
): RangeGridRow {
  return {
    tutorGroupId: id,
    displayName: `Tutor ${id}`,
    supportedModes,
    qualifications: [{ subject: "Math", curriculum: "International", level: "Y7" }],
    availability,
  };
}

function makeResponse(
  subSlots: Array<{ start: string; end: string }>,
  grid: RangeGridRow[],
): RangeSearchResponse {
  return {
    snapshotMeta: { snapshotId: "test-snap", syncedAt: "2024-01-01T00:00:00.000Z", stale: false },
    subSlots,
    grid,
    needsReview: [],
    latencyMs: 1,
    warnings: [],
  };
}

describe("getRecommendedSlots", () => {
  it("returns empty array for null/undefined response", () => {
    expect(getRecommendedSlots(undefined as unknown as RangeSearchResponse)).toEqual([]);
    expect(getRecommendedSlots(null as unknown as RangeSearchResponse)).toEqual([]);
  });

  it("returns empty array when subSlots is empty", () => {
    const resp = makeResponse([], [makeRow("A", [])]);
    expect(getRecommendedSlots(resp)).toEqual([]);
  });

  it("returns empty array when grid is empty", () => {
    const resp = makeResponse([{ start: "09:00", end: "10:30" }], []);
    expect(getRecommendedSlots(resp)).toEqual([]);
  });

  it("assigns Best/Strong/Good tiers to ranked slots in order", () => {
    // Three subSlots, three rows, all rows available in all three slots.
    // Counts tie at 3 per slot → tie-break by start time ASC.
    const resp = makeResponse(
      [
        { start: "09:00", end: "10:30" },
        { start: "10:00", end: "11:30" },
        { start: "11:00", end: "12:30" },
      ],
      [
        makeRow("A", [true, true, true]),
        makeRow("B", [true, true, true]),
        makeRow("C", [true, true, true]),
      ],
    );
    const result = getRecommendedSlots(resp);
    expect(result).toHaveLength(3);
    expect(result[0].confidence).toBe("Best fit");
    expect(result[1].confidence).toBe("Strong fit");
    expect(result[2].confidence).toBe("Good fit");
  });

  it("ranks by availableTutors count DESC", () => {
    // Slot 0 "09:00" → 1 tutor free
    // Slot 1 "10:00" → 3 tutors free
    // Slot 2 "11:00" → 2 tutors free
    // Expected order: 10:00 (3), 11:00 (2), 09:00 (1)
    const resp = makeResponse(
      [
        { start: "09:00", end: "10:30" },
        { start: "10:00", end: "11:30" },
        { start: "11:00", end: "12:30" },
      ],
      [
        makeRow("A", [true, true, true]),
        makeRow("B", [BLOCKED, true, true]),
        makeRow("C", [BLOCKED, true, BLOCKED]),
      ],
    );
    const result = getRecommendedSlots(resp);
    expect(result).toHaveLength(3);
    expect(result[0].start).toBe("10:00");
    expect(result[0].availableTutors).toHaveLength(3);
    expect(result[1].start).toBe("11:00");
    expect(result[1].availableTutors).toHaveLength(2);
    expect(result[2].start).toBe("09:00");
    expect(result[2].availableTutors).toHaveLength(1);
  });

  it("tie-breaks equal counts by start time ASC", () => {
    // Two subSlots each with 2 tutors free — tied on count.
    // Tie-break: earlier start time wins.
    const resp = makeResponse(
      [
        { start: "10:00", end: "11:30" },
        { start: "09:00", end: "10:30" },
      ],
      [
        makeRow("A", [true, true]),
        makeRow("B", [true, true]),
      ],
    );
    const result = getRecommendedSlots(resp);
    expect(result).toHaveLength(2);
    expect(result[0].start).toBe("09:00");
    expect(result[1].start).toBe("10:00");
  });

  it("filters out slots with zero available tutors", () => {
    // Three subSlots; slot 1 has no available tutors → dropped.
    const resp = makeResponse(
      [
        { start: "09:00", end: "10:30" },
        { start: "10:00", end: "11:30" },
        { start: "11:00", end: "12:30" },
      ],
      [
        makeRow("A", [true, BLOCKED, true]),
        makeRow("B", [true, BLOCKED, true]),
      ],
    );
    const result = getRecommendedSlots(resp);
    expect(result).toHaveLength(2);
    expect(result.some((r) => r.start === "10:00")).toBe(false);
    expect(result.map((r) => r.start).sort()).toEqual(["09:00", "11:00"]);
  });

  it("respects the limit parameter", () => {
    // Five qualifying subSlots; caller asks for top 2.
    const resp = makeResponse(
      [
        { start: "09:00", end: "10:30" },
        { start: "10:00", end: "11:30" },
        { start: "11:00", end: "12:30" },
        { start: "12:00", end: "13:30" },
        { start: "13:00", end: "14:30" },
      ],
      [makeRow("A", [true, true, true, true, true])],
    );
    const result = getRecommendedSlots(resp, 2);
    expect(result).toHaveLength(2);
    expect(result[0].confidence).toBe("Best fit");
    expect(result[1].confidence).toBe("Strong fit");
    expect(result.some((r) => r.confidence === "Good fit")).toBe(false);
  });

  it("modality reason: both online and onsite", () => {
    // Single slot; one row online, one row onsite → union has both modes.
    const resp = makeResponse(
      [{ start: "09:00", end: "10:30" }],
      [
        makeRow("A", [true], ["online"]),
        makeRow("B", [true], ["onsite"]),
      ],
    );
    const result = getRecommendedSlots(resp);
    expect(result).toHaveLength(1);
    expect(result[0].reasons).toContain("Online + onsite options");
    expect(result[0].reasons).not.toContain("Online only");
    expect(result[0].reasons).not.toContain("Onsite only");
  });

  it("modality reason: online only", () => {
    const resp = makeResponse(
      [{ start: "09:00", end: "10:30" }],
      [
        makeRow("A", [true], ["online"]),
        makeRow("B", [true], ["online"]),
      ],
    );
    const result = getRecommendedSlots(resp);
    expect(result).toHaveLength(1);
    expect(result[0].reasons).toContain("Online only");
    expect(result[0].reasons).not.toContain("Online + onsite options");
    expect(result[0].reasons).not.toContain("Onsite only");
  });

  it("modality reason: onsite only", () => {
    const resp = makeResponse(
      [{ start: "09:00", end: "10:30" }],
      [
        makeRow("A", [true], ["onsite"]),
        makeRow("B", [true], ["onsite"]),
      ],
    );
    const result = getRecommendedSlots(resp);
    expect(result).toHaveLength(1);
    expect(result[0].reasons).toContain("Onsite only");
    expect(result[0].reasons).not.toContain("Online + onsite options");
    expect(result[0].reasons).not.toContain("Online only");
  });

  it("pluralizes qualified-tutor count correctly", () => {
    // Single tutor: "1 qualified tutor free" (no "s")
    const oneTutor = makeResponse(
      [{ start: "09:00", end: "10:30" }],
      [makeRow("A", [true], ["online"])],
    );
    const oneResult = getRecommendedSlots(oneTutor);
    expect(oneResult[0].reasons).toContain("1 qualified tutor free");
    expect(oneResult[0].reasons.some((r) => r === "1 qualified tutors free")).toBe(false);

    // Two tutors: "2 qualified tutors free" (with "s")
    const twoTutors = makeResponse(
      [{ start: "09:00", end: "10:30" }],
      [
        makeRow("A", [true], ["online"]),
        makeRow("B", [true], ["online"]),
      ],
    );
    const twoResult = getRecommendedSlots(twoTutors);
    expect(twoResult[0].reasons).toContain("2 qualified tutors free");
  });

  it("adds Variety-to-offer-parent reason when 3+ tutors available", () => {
    // 3 tutors free → reason present
    const threeTutors = makeResponse(
      [{ start: "09:00", end: "10:30" }],
      [
        makeRow("A", [true], ["online"]),
        makeRow("B", [true], ["online"]),
        makeRow("C", [true], ["online"]),
      ],
    );
    const threeResult = getRecommendedSlots(threeTutors);
    expect(threeResult[0].reasons).toContain("Variety to offer parent");

    // 2 tutors free → reason absent
    const twoTutors = makeResponse(
      [{ start: "09:00", end: "10:30" }],
      [
        makeRow("A", [true], ["online"]),
        makeRow("B", [true], ["online"]),
      ],
    );
    const twoResult = getRecommendedSlots(twoTutors);
    expect(twoResult[0].reasons).not.toContain("Variety to offer parent");
  });
});
