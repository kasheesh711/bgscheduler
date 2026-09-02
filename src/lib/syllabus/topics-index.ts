import topicsIndexJson from "./data/topics-index.json";
import type { YearSummary } from "./types";

export const topicsIndex: YearSummary[] = topicsIndexJson.years;

export function getYearSummary(year: number): YearSummary | undefined {
  return topicsIndex.find((y) => y.year === year);
}
