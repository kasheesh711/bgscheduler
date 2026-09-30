import type { AutowriterReview } from "./review-data";

/**
 * The expansion gate as one sentence for the health rail's gate card (dashboard redesign, section 3.4), e.g.
 * "Gate blocked until 13 Oct: critical on 29 Sep." or "Head start: lower bound 72%, needs 80%.". Pure: safe to import
 * from client components. Dates are Bangkok dates, shown as "D Mon"; percentages are rounded down (`floorPercent`).
 */
export function gateSentence(gate: AutowriterReview["gate"]): string {
  void gate;
  throw new Error("not implemented");
}
