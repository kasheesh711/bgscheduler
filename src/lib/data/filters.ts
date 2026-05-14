import { cacheTag, cacheLife } from "next/cache";
import { eq } from "drizzle-orm";
import { getDb, type Database } from "@/lib/db";
import * as schema from "@/lib/db/schema";
import { getActiveSnapshotIdOrThrow } from "@/lib/data/active-snapshot";

export interface FilterOptions {
  subjects: string[];
  curriculums: string[];
  levels: string[];
}

interface QualificationFilterRow {
  subject: string;
  curriculum: string;
  level: string;
}

export function buildFilterOptions(qualifications: QualificationFilterRow[]): FilterOptions {
  const subjects = new Set<string>();
  const curriculums = new Set<string>();
  const levels = new Set<string>();

  for (const q of qualifications) {
    subjects.add(q.subject);
    curriculums.add(q.curriculum);
    levels.add(q.level);
  }

  return {
    subjects: [...subjects].sort(),
    curriculums: [...curriculums].sort(),
    levels: [...levels].sort(),
  };
}

export async function loadFilterOptions(db: Database): Promise<FilterOptions> {
  const snapshotId = await getActiveSnapshotIdOrThrow(db);
  const qualifications = await db
    .select({
      subject: schema.subjectLevelQualifications.subject,
      curriculum: schema.subjectLevelQualifications.curriculum,
      level: schema.subjectLevelQualifications.level,
    })
    .from(schema.subjectLevelQualifications)
    .where(eq(schema.subjectLevelQualifications.snapshotId, snapshotId));

  return buildFilterOptions(qualifications);
}

/** Cached server function for filter dropdown options, tagged with snapshot for invalidation. */
export async function getFilterOptions(): Promise<FilterOptions> {
  "use cache";
  cacheTag("snapshot");
  cacheLife("hours");

  return loadFilterOptions(getDb());
}
