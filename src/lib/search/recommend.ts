import type { RangeSearchResponse, RangeGridRow } from "./types";

export interface RecommendedSlot {
  id: string;
  subSlotIndex: number;
  start: string;
  end: string;
  availableTutors: RangeGridRow[];
  confidence: "Best fit" | "Strong fit" | "Good fit";
  reasons: string[];
}

/**
 * Derives the top recommended slots from a range search response.
 *
 * Ranks sub-slots by number of fully-available qualified tutors. Slots with
 * zero available tutors are dropped. Returns up to `limit` picks, tagged by
 * confidence tier for display.
 */
export function getRecommendedSlots(
  response: RangeSearchResponse,
  limit = 3,
): RecommendedSlot[] {
  if (!response || response.subSlots.length === 0 || response.grid.length === 0) {
    return [];
  }

  const ranked = response.subSlots
    .map((ss, i) => {
      const availableTutors = response.grid.filter((row) => row.availability[i] === true);
      return { subSlotIndex: i, start: ss.start, end: ss.end, availableTutors };
    })
    .filter((entry) => entry.availableTutors.length > 0)
    .sort((a, b) => {
      if (b.availableTutors.length !== a.availableTutors.length) {
        return b.availableTutors.length - a.availableTutors.length;
      }
      return a.start.localeCompare(b.start);
    })
    .slice(0, limit);

  return ranked.map((entry, i) => {
    const tutors = entry.availableTutors;
    const tier: RecommendedSlot["confidence"] = i === 0 ? "Best fit" : i === 1 ? "Strong fit" : "Good fit";

    const modes = new Set<string>();
    for (const t of tutors) for (const m of t.supportedModes) modes.add(m);

    const reasons: string[] = [];
    reasons.push(`${tutors.length} qualified tutor${tutors.length > 1 ? "s" : ""} free`);
    if (modes.has("online") && modes.has("onsite")) {
      reasons.push("Online + onsite options");
    } else if (modes.has("online")) {
      reasons.push("Online only");
    } else if (modes.has("onsite")) {
      reasons.push("Onsite only");
    }
    if (tutors.length >= 3) reasons.push("Variety to offer parent");

    return {
      id: `rec-${entry.subSlotIndex}`,
      subSlotIndex: entry.subSlotIndex,
      start: entry.start,
      end: entry.end,
      availableTutors: tutors,
      confidence: tier,
      reasons,
    };
  });
}

export function formatSlotTime(start: string, end: string): string {
  const fmt = (t: string) => {
    const [h, m] = t.split(":").map(Number);
    const suffix = h >= 12 ? "pm" : "am";
    const h12 = h === 0 ? 12 : h > 12 ? h - 12 : h;
    return m === 0 ? `${h12}${suffix}` : `${h12}:${String(m).padStart(2, "0")}${suffix}`;
  };
  return `${fmt(start)}–${fmt(end)}`;
}
