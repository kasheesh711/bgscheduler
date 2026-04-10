import { cacheTag, cacheLife } from "next/cache";
import { getDb } from "@/lib/db";
import { ensureIndex } from "@/lib/search/index";

export interface FilterOptions {
  subjects: string[];
  curriculums: string[];
  levels: string[];
}

/** Cached server function for filter dropdown options, tagged with snapshot for invalidation. */
export async function getFilterOptions(): Promise<FilterOptions> {
  "use cache";
  cacheTag("snapshot");
  cacheLife("hours");

  const db = getDb();
  const index = await ensureIndex(db);

  const subjects = new Set<string>();
  const curriculums = new Set<string>();
  const levels = new Set<string>();

  for (const group of index.tutorGroups) {
    for (const q of group.qualifications) {
      subjects.add(q.subject);
      curriculums.add(q.curriculum);
      levels.add(q.level);
    }
  }

  return {
    subjects: [...subjects].sort(),
    curriculums: [...curriculums].sort(),
    levels: [...levels].sort(),
  };
}
