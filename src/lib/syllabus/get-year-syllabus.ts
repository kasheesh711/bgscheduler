import "server-only";

import type { YearSyllabus } from "./types";

// Static import map so each year's JSON bundles into its own server chunk —
// the 4,981-skill dataset never reaches the client.
const loaders: Record<number, () => Promise<{ default: YearSyllabus }>> = {
  1: () => import("./data/year-01.json"),
  2: () => import("./data/year-02.json"),
  3: () => import("./data/year-03.json"),
  4: () => import("./data/year-04.json"),
  5: () => import("./data/year-05.json"),
  6: () => import("./data/year-06.json"),
  7: () => import("./data/year-07.json"),
  8: () => import("./data/year-08.json"),
  9: () => import("./data/year-09.json"),
  10: () => import("./data/year-10.json"),
  11: () => import("./data/year-11.json"),
  12: () => import("./data/year-12.json"),
  13: () => import("./data/year-13.json"),
};

export async function getYearSyllabus(year: number): Promise<YearSyllabus | null> {
  const loader = loaders[year];
  if (!loader) return null;
  const yearModule = await loader();
  return yearModule.default;
}
