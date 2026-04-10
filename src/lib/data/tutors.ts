import { cacheTag, cacheLife } from "next/cache";
import { getDb } from "@/lib/db";
import { ensureIndex } from "@/lib/search/index";

export interface TutorListItem {
  tutorGroupId: string;
  displayName: string;
  supportedModes: string[];
  subjects: string[];
}

/** Cached server function for tutor list, tagged with snapshot for invalidation. */
export async function getTutorList(): Promise<TutorListItem[]> {
  "use cache";
  cacheTag("snapshot");
  cacheLife("hours");

  const db = getDb();
  const index = await ensureIndex(db);

  const tutors: TutorListItem[] = index.tutorGroups.map((g) => ({
    tutorGroupId: g.id,
    displayName: g.displayName,
    supportedModes: g.supportedModes,
    subjects: [...new Set(g.qualifications.map((q) => q.subject))],
  }));

  tutors.sort((a, b) => a.displayName.localeCompare(b.displayName));
  return tutors;
}
