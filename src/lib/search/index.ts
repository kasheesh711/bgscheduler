import { eq } from "drizzle-orm";
import { Database } from "@/lib/db";
import * as schema from "@/lib/db/schema";

// ── Index data structures ───────────────────────────────────────────

export interface IndexedQualification {
  subject: string;
  curriculum: string;
  level: string;
  examPrep?: string;
}

export interface IndexedWiseRecord {
  wiseTeacherId: string;
  wiseDisplayName: string;
  isOnline: boolean;
}

export interface IndexedAvailabilityWindow {
  weekday: number;
  startMinute: number;
  endMinute: number;
  modality: string;
  wiseTeacherId: string;
}

export interface IndexedLeave {
  startTime: Date;
  endTime: Date;
}

export interface IndexedSessionBlock {
  startTime: Date;
  endTime: Date;
  weekday: number;
  startMinute: number;
  endMinute: number;
  isBlocking: boolean;
  wiseTeacherId: string;
  title?: string;
  studentName?: string;
  subject?: string;
  classType?: string;
  recurrenceId?: string;
  location?: string;
}

export interface IndexedDataIssue {
  type: string;
  message: string;
}

export interface IndexedTutorGroup {
  id: string;
  displayName: string;
  supportedModes: string[];
  qualifications: IndexedQualification[];
  wiseRecords: IndexedWiseRecord[];
  availabilityWindows: IndexedAvailabilityWindow[];
  leaves: IndexedLeave[];
  sessionBlocks: IndexedSessionBlock[];
  dataIssues: IndexedDataIssue[];
}

export interface SearchIndex {
  snapshotId: string;
  builtAt: Date;
  tutorGroups: IndexedTutorGroup[];
  byWeekday: Map<number, IndexedTutorGroup[]>;
}

// ── Module-level singleton ──────────────────────────────────────────

let currentIndex: SearchIndex | null = null;
let buildingPromise: Promise<SearchIndex> | null = null;

export function getSearchIndex(): SearchIndex | null {
  return currentIndex;
}

export function getActiveSnapshotId(): string | null {
  return currentIndex?.snapshotId ?? null;
}

/**
 * Build the search index from the active Postgres snapshot.
 */
export async function buildIndex(db: Database): Promise<SearchIndex> {
  // Find active snapshot
  const [activeSnapshot] = await db
    .select()
    .from(schema.snapshots)
    .where(eq(schema.snapshots.active, true))
    .limit(1);

  if (!activeSnapshot) {
    throw new Error("No active snapshot found");
  }

  const snapshotId = activeSnapshot.id;

  // Load all groups for this snapshot
  const groups = await db
    .select()
    .from(schema.tutorIdentityGroups)
    .where(eq(schema.tutorIdentityGroups.snapshotId, snapshotId));

  // Load all data in parallel
  const [members, qualifications, windows, leaves, sessions, issues] = await Promise.all([
    db
      .select()
      .from(schema.tutorIdentityGroupMembers)
      .where(eq(schema.tutorIdentityGroupMembers.snapshotId, snapshotId)),
    db
      .select()
      .from(schema.subjectLevelQualifications)
      .where(eq(schema.subjectLevelQualifications.snapshotId, snapshotId)),
    db
      .select()
      .from(schema.recurringAvailabilityWindows)
      .where(eq(schema.recurringAvailabilityWindows.snapshotId, snapshotId)),
    db
      .select()
      .from(schema.datedLeaves)
      .where(eq(schema.datedLeaves.snapshotId, snapshotId)),
    db
      .select()
      .from(schema.futureSessionBlocks)
      .where(eq(schema.futureSessionBlocks.snapshotId, snapshotId)),
    db
      .select()
      .from(schema.dataIssues)
      .where(eq(schema.dataIssues.snapshotId, snapshotId)),
  ]);

  // Index by groupId
  const membersByGroup = groupBy(members, (m) => m.groupId);
  const qualsByGroup = groupBy(qualifications, (q) => q.groupId);
  const windowsByGroup = groupBy(windows, (w) => w.groupId);
  const leavesByGroup = groupBy(leaves, (l) => l.groupId);
  const sessionsByGroup = groupBy(sessions, (s) => s.groupId);

  // Issues indexed by entity — match on group canonical key
  const issuesByGroup = new Map<string, typeof issues>();
  for (const issue of issues) {
    // Match issues to groups by entityId (canonical key) or entityName
    for (const group of groups) {
      if (
        issue.entityId === group.canonicalKey ||
        issue.entityId === group.id ||
        issue.entityName === group.displayName
      ) {
        if (!issuesByGroup.has(group.id)) {
          issuesByGroup.set(group.id, []);
        }
        issuesByGroup.get(group.id)!.push(issue);
      }
    }
  }

  // Build indexed tutor groups
  const tutorGroups: IndexedTutorGroup[] = groups.map((group) => {
    const gMembers = membersByGroup.get(group.id) ?? [];
    const gQuals = qualsByGroup.get(group.id) ?? [];
    const gWindows = windowsByGroup.get(group.id) ?? [];
    const gLeaves = leavesByGroup.get(group.id) ?? [];
    const gSessions = sessionsByGroup.get(group.id) ?? [];
    const gIssues = issuesByGroup.get(group.id) ?? [];

    return {
      id: group.id,
      displayName: group.displayName,
      supportedModes:
        group.supportedModality === "both"
          ? ["online", "onsite"]
          : group.supportedModality === "unresolved"
            ? []
            : [group.supportedModality],
      qualifications: gQuals.map((q) => ({
        subject: q.subject,
        curriculum: q.curriculum,
        level: q.level,
        examPrep: q.examPrep ?? undefined,
      })),
      wiseRecords: gMembers.map((m) => ({
        wiseTeacherId: m.wiseTeacherId,
        wiseDisplayName: m.wiseDisplayName,
        isOnline: m.isOnlineVariant,
      })),
      availabilityWindows: gWindows.map((w) => ({
        weekday: w.weekday,
        startMinute: w.startMinute,
        endMinute: w.endMinute,
        modality: w.modality,
        wiseTeacherId: w.wiseTeacherId,
      })),
      leaves: gLeaves.map((l) => ({
        startTime: new Date(l.startTime),
        endTime: new Date(l.endTime),
      })),
      sessionBlocks: gSessions.map((s) => ({
        startTime: new Date(s.startTime),
        endTime: new Date(s.endTime),
        weekday: s.weekday,
        startMinute: s.startMinute,
        endMinute: s.endMinute,
        isBlocking: s.isBlocking,
        wiseTeacherId: s.wiseTeacherId,
        title: s.title ?? undefined,
        studentName: s.studentName ?? undefined,
        subject: s.subject ?? undefined,
        classType: s.classType ?? undefined,
        recurrenceId: s.recurrenceId ?? undefined,
        location: s.location ?? undefined,
      })),
      dataIssues: gIssues.map((i) => ({
        type: i.type,
        message: i.message,
      })),
    };
  });

  // Build weekday lookup
  const byWeekday = new Map<number, IndexedTutorGroup[]>();
  for (const group of tutorGroups) {
    const weekdays = new Set(group.availabilityWindows.map((w) => w.weekday));
    for (const day of weekdays) {
      if (!byWeekday.has(day)) {
        byWeekday.set(day, []);
      }
      byWeekday.get(day)!.push(group);
    }
  }

  const index: SearchIndex = {
    snapshotId,
    builtAt: new Date(),
    tutorGroups,
    byWeekday,
  };

  currentIndex = index;
  return index;
}

/**
 * Ensure index is loaded and fresh. Rebuilds if stale.
 */
export async function ensureIndex(db: Database): Promise<SearchIndex> {
  if (currentIndex) {
    // Check if still the active snapshot
    const [activeSnapshot] = await db
      .select({ id: schema.snapshots.id })
      .from(schema.snapshots)
      .where(eq(schema.snapshots.active, true))
      .limit(1);

    if (activeSnapshot && activeSnapshot.id === currentIndex.snapshotId) {
      return currentIndex;
    }
  }

  // Need to rebuild
  if (!buildingPromise) {
    buildingPromise = buildIndex(db).finally(() => {
      buildingPromise = null;
    });
  }

  return buildingPromise;
}

// ── Helpers ─────────────────────────────────────────────────────────

function groupBy<T>(items: T[], keyFn: (item: T) => string): Map<string, T[]> {
  const map = new Map<string, T[]>();
  for (const item of items) {
    const key = keyFn(item);
    if (!map.has(key)) {
      map.set(key, []);
    }
    map.get(key)!.push(item);
  }
  return map;
}
