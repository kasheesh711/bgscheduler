export type ConfidenceBand = "high" | "medium" | "low";

// Bands are chosen so the false-negative threshold (0.75) sits inside "medium":
// anything not high-confidence still gets a human glance.
export function confidenceBand(value: number | null | undefined): ConfidenceBand | null {
  if (typeof value !== "number" || Number.isNaN(value)) return null;
  if (value >= 0.85) return "high";
  if (value >= 0.6) return "medium";
  return "low";
}
