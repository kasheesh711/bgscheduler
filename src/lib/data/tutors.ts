import { cacheTag, cacheLife } from "next/cache";
import { eq } from "drizzle-orm";
import { getDb, type Database } from "@/lib/db";
import * as schema from "@/lib/db/schema";
import { getActiveSnapshotIdOrThrow } from "@/lib/data/active-snapshot";

export interface TutorListItem {
  tutorGroupId: string;
  displayName: string;
  supportedModes: string[];
  subjects: string[];
}

interface TutorGroupRow {
  id: string;
  displayName: string;
  supportedModality: string;
}

interface TutorQualificationRow {
  groupId: string;
  subject: string;
}

export function supportedModesFromModality(modality: string): string[] {
  if (modality === "both") return ["online", "onsite"];
  if (modality === "unresolved") return [];
  return [modality];
}

export function buildTutorList(
  groups: TutorGroupRow[],
  qualifications: TutorQualificationRow[],
): TutorListItem[] {
  const subjectsByGroup = new Map<string, Set<string>>();

  for (const q of qualifications) {
    if (!subjectsByGroup.has(q.groupId)) {
      subjectsByGroup.set(q.groupId, new Set());
    }
    subjectsByGroup.get(q.groupId)!.add(q.subject);
  }

  const tutors = groups.map((group) => ({
    tutorGroupId: group.id,
    displayName: group.displayName,
    supportedModes: supportedModesFromModality(group.supportedModality),
    subjects: [...(subjectsByGroup.get(group.id) ?? new Set<string>())].sort(),
  }));

  tutors.sort((a, b) => a.displayName.localeCompare(b.displayName));
  return tutors;
}

export async function loadTutorList(db: Database): Promise<TutorListItem[]> {
  const snapshotId = await getActiveSnapshotIdOrThrow(db);

  const [groups, qualifications] = await Promise.all([
    db
      .select({
        id: schema.tutorIdentityGroups.id,
        displayName: schema.tutorIdentityGroups.displayName,
        supportedModality: schema.tutorIdentityGroups.supportedModality,
      })
      .from(schema.tutorIdentityGroups)
      .where(eq(schema.tutorIdentityGroups.snapshotId, snapshotId)),
    db
      .select({
        groupId: schema.subjectLevelQualifications.groupId,
        subject: schema.subjectLevelQualifications.subject,
      })
      .from(schema.subjectLevelQualifications)
      .where(eq(schema.subjectLevelQualifications.snapshotId, snapshotId)),
  ]);

  return buildTutorList(groups, qualifications);
}

/** Cached server function for tutor list, tagged with snapshot for invalidation. */
export async function getTutorList(): Promise<TutorListItem[]> {
  "use cache";
  cacheTag("snapshot");
  cacheLife("hours");

  return loadTutorList(getDb());
}
