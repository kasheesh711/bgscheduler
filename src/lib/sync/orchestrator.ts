import { eq, and, sql } from "drizzle-orm";
import { Database } from "@/lib/db";
import * as schema from "@/lib/db/schema";
import { WiseClient } from "@/lib/wise/client";
import {
  getWiseSessionTeacherUserId,
  getWiseTagName,
  getWiseTeacherDisplayName,
  getWiseTeacherUserId,
} from "@/lib/wise/types";
import { fetchAllTeachers, fetchTeacherFullAvailability, fetchAllFutureSessions } from "@/lib/wise/fetchers";
import { resolveIdentities, AliasMapping } from "@/lib/normalization/identity";
import { normalizeWorkingHours } from "@/lib/normalization/availability";
import { normalizeLeaves } from "@/lib/normalization/leaves";
import { normalizeSessions } from "@/lib/normalization/sessions";
import { normalizeTeacherTags } from "@/lib/normalization/qualifications";
import { deriveModality } from "@/lib/normalization/modality";

export interface SyncResult {
  success: boolean;
  syncRunId: string;
  snapshotId: string | null;
  promotedSnapshotId: string | null;
  teacherCount: number;
  groupCount: number;
  issueCount: number;
  errorSummary: string | null;
  durationMs: number;
}

const INSERT_CHUNK_SIZE = 250;

async function insertInChunks<T>(
  rows: T[],
  insertChunk: (chunk: T[]) => Promise<unknown>,
  chunkSize: number = INSERT_CHUNK_SIZE
) {
  for (let i = 0; i < rows.length; i += chunkSize) {
    await insertChunk(rows.slice(i, i + chunkSize));
  }
}

export async function runFullSync(
  db: Database,
  client: WiseClient,
  instituteId: string
): Promise<SyncResult> {
  const startTime = Date.now();
  let syncRunId = "";
  let snapshotId = "";

  try {
    // 1. Create sync run
    const [syncRun] = await db
      .insert(schema.syncRuns)
      .values({ status: "running" })
      .returning({ id: schema.syncRuns.id });
    syncRunId = syncRun.id;

    // 2. Create candidate snapshot
    const [snapshot] = await db
      .insert(schema.snapshots)
      .values({ active: false })
      .returning({ id: schema.snapshots.id });
    snapshotId = snapshot.id;

    // Update sync run with snapshot reference
    await db
      .update(schema.syncRuns)
      .set({ snapshotId })
      .where(eq(schema.syncRuns.id, syncRunId));

    // 3. Fetch all teachers
    const wiseTeachers = await fetchAllTeachers(client, instituteId);

    // 4. Load aliases
    const aliasRows = await db.select().from(schema.tutorAliases);
    const aliases: AliasMapping[] = aliasRows.map((r) => ({
      fromKey: r.fromKey,
      toKey: r.toKey,
    }));

    // 5. Resolve identities
    const { groups, issues: identityIssues } = resolveIdentities(wiseTeachers, aliases);

    // Store identity issues
    const allIssues: typeof schema.dataIssues.$inferInsert[] = identityIssues.map((i) => ({
      snapshotId,
      type: i.type as "alias",
      severity: "critical" as const,
      entityType: i.entityType,
      entityId: i.entityId,
      entityName: i.entityName,
      message: i.message,
    }));

    // 6. Persist identity groups and members
    const groupIdMap = new Map<string, string>(); // canonicalKey → db group id
    const memberRows: typeof schema.tutorIdentityGroupMembers.$inferInsert[] = [];

    for (const group of groups) {
      const [dbGroup] = await db
        .insert(schema.tutorIdentityGroups)
        .values({
          snapshotId,
          canonicalKey: group.canonicalKey,
          displayName: group.displayName,
          supportedModality: "unresolved",
        })
        .returning({ id: schema.tutorIdentityGroups.id });

      groupIdMap.set(group.canonicalKey, dbGroup.id);

      // Queue members for batch insert
      for (const member of group.members) {
        memberRows.push({
          groupId: dbGroup.id,
          snapshotId,
          wiseTeacherId: member.wiseTeacherId,
          wiseUserId: member.wiseUserId,
          wiseDisplayName: member.wiseDisplayName,
          isOnlineVariant: member.isOnlineVariant,
        });
      }
    }

    await insertInChunks(memberRows, async (chunk) => {
      await db.insert(schema.tutorIdentityGroupMembers).values(chunk);
    });

    // 7. Fetch availability and leaves for each teacher
    const teacherToGroupId = new Map<string, string>();
    for (const group of groups) {
      const gId = groupIdMap.get(group.canonicalKey)!;
      for (const member of group.members) {
        teacherToGroupId.set(member.wiseTeacherId, gId);
      }
    }

    const recurringAvailabilityRows: typeof schema.recurringAvailabilityWindows.$inferInsert[] = [];
    const datedLeaveRows: typeof schema.datedLeaves.$inferInsert[] = [];
    const rawTagRows: typeof schema.rawTeacherTags.$inferInsert[] = [];
    const qualificationRows: typeof schema.subjectLevelQualifications.$inferInsert[] = [];

    // Process teachers with availability
    for (const teacher of wiseTeachers) {
      const groupId = teacherToGroupId.get(teacher._id);
      if (!groupId) continue;
      const teacherName = getWiseTeacherDisplayName(teacher);
      const teacherUserId = getWiseTeacherUserId(teacher);

      if (!teacherUserId) {
        allIssues.push({
          snapshotId,
          type: "completeness",
          severity: "high",
          entityType: "teacher",
          entityId: teacher._id,
          entityName: teacherName,
          message: `Failed to fetch availability for teacher "${teacherName}": missing Wise user id`,
        });
        continue;
      }

      try {
        const { workingHours, leaves } = await fetchTeacherFullAvailability(
          client,
          instituteId,
          teacherUserId
        );

        // Normalize and store working hours
        const windows = normalizeWorkingHours(workingHours?.slots);
        for (const w of windows) {
          recurringAvailabilityRows.push({
            snapshotId,
            groupId,
            wiseTeacherId: teacher._id,
            weekday: w.weekday,
            startMinute: w.startMinute,
            endMinute: w.endMinute,
            modality: "unresolved", // Set later
          });
        }

        // Normalize and store leaves
        const normalizedLeaves = normalizeLeaves(leaves ?? []);
        for (const l of normalizedLeaves) {
          datedLeaveRows.push({
            snapshotId,
            groupId,
            wiseTeacherId: teacher._id,
            startTime: l.startTime,
            endTime: l.endTime,
          });
        }

        // Store raw tags and normalize qualifications
        const tags = teacher.tags ?? [];
        for (const tag of tags) {
          rawTagRows.push({
            snapshotId,
            groupId,
            wiseTeacherId: teacher._id,
            tagValue: getWiseTagName(tag),
            tagRaw: tag,
          });
        }

        const { qualifications, issues: tagIssues } = normalizeTeacherTags(
          tags,
          teacher._id,
          teacherName
        );

        for (const q of qualifications) {
          qualificationRows.push({
            snapshotId,
            groupId,
            subject: q.subject,
            curriculum: q.curriculum,
            level: q.level,
            examPrep: q.examPrep,
            sourceTag: q.sourceTag,
          });
        }

        allIssues.push(
          ...tagIssues.map((i) => ({
            snapshotId,
            type: i.type as "tag",
            severity: "high" as const,
            entityType: i.entityType,
            entityId: i.entityId,
            entityName: i.entityName,
            message: i.message,
          }))
        );
      } catch (err) {
        allIssues.push({
          snapshotId,
          type: "completeness",
          severity: "high",
          entityType: "teacher",
          entityId: teacher._id,
          entityName: teacherName,
          message: `Failed to fetch availability for teacher "${teacherName}": ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    }

    // 8. Fetch and normalize future sessions
    const wiseSessions = await fetchAllFutureSessions(client, instituteId);
    const wiseUserIdToTeacherId = new Map<string, string>();
    for (const teacher of wiseTeachers) {
      const teacherUserId = getWiseTeacherUserId(teacher);
      if (teacherUserId) {
        wiseUserIdToTeacherId.set(teacherUserId, teacher._id);
      }
    }

    const sessionBlocks = normalizeSessions(wiseSessions, (session) => {
      const wiseUserId = getWiseSessionTeacherUserId(session);
      return wiseUserId ? (wiseUserIdToTeacherId.get(wiseUserId) ?? null) : null;
    });

    const futureSessionBlockRows: typeof schema.futureSessionBlocks.$inferInsert[] = [];
    for (const block of sessionBlocks) {
      const groupId = teacherToGroupId.get(block.wiseTeacherId);
      if (!groupId) continue;

      futureSessionBlockRows.push({
        snapshotId,
        groupId,
        wiseTeacherId: block.wiseTeacherId,
        wiseSessionId: block.wiseSessionId,
        startTime: block.startTime,
        endTime: block.endTime,
        weekday: block.weekday,
        startMinute: block.startMinute,
        endMinute: block.endMinute,
        wiseStatus: block.wiseStatus,
        isBlocking: block.isBlocking,
        title: block.title,
        sessionType: block.sessionType,
        location: block.location,
      });
    }

    // 9. Derive modality for each group
    const teacherModalities = new Map<string, typeof schema.modalityEnum.enumValues[number]>();
    const tutorRows: typeof schema.tutors.$inferInsert[] = [];

    for (const group of groups) {
      const gId = groupIdMap.get(group.canonicalKey)!;
      const groupSessions = sessionBlocks.filter((s) =>
        group.members.some((m) => m.wiseTeacherId === s.wiseTeacherId)
      );

      const { modality, issue } = deriveModality(group, groupSessions);

      await db
        .update(schema.tutorIdentityGroups)
        .set({ supportedModality: modality })
        .where(eq(schema.tutorIdentityGroups.id, gId));

      // Record per-teacher modality so windows can be inserted once with final values.
      for (const member of group.members) {
        teacherModalities.set(
          member.wiseTeacherId,
          member.isOnlineVariant ? "online" : modality === "both" ? "onsite" : modality
        );
      }

      if (issue) {
        allIssues.push({
          snapshotId,
          type: issue.type as "modality",
          severity: "high",
          entityType: issue.entityType,
          entityId: issue.entityId,
          entityName: issue.entityName,
          message: issue.message,
        });
      }

      // Create tutor record
      const modes: string[] = [];
      if (modality === "both") modes.push("online", "onsite");
      else if (modality !== "unresolved") modes.push(modality);

      tutorRows.push({
        snapshotId,
        groupId: gId,
        displayName: group.displayName,
        supportedModes: modes,
      });
    }

    for (const row of recurringAvailabilityRows) {
      row.modality = teacherModalities.get(row.wiseTeacherId) ?? "unresolved";
    }

    await Promise.all([
      insertInChunks(recurringAvailabilityRows, async (chunk) => {
        await db.insert(schema.recurringAvailabilityWindows).values(chunk);
      }),
      insertInChunks(datedLeaveRows, async (chunk) => {
        await db.insert(schema.datedLeaves).values(chunk);
      }),
      insertInChunks(rawTagRows, async (chunk) => {
        await db.insert(schema.rawTeacherTags).values(chunk);
      }),
      insertInChunks(qualificationRows, async (chunk) => {
        await db.insert(schema.subjectLevelQualifications).values(chunk);
      }),
      insertInChunks(futureSessionBlockRows, async (chunk) => {
        await db.insert(schema.futureSessionBlocks).values(chunk);
      }),
      insertInChunks(tutorRows, async (chunk) => {
        await db.insert(schema.tutors).values(chunk);
      }),
    ]);

    // 10. Store all issues
    if (allIssues.length > 0) {
      await insertInChunks(allIssues, async (chunk) => {
        await db.insert(schema.dataIssues).values(chunk);
      });
    }

    // 11. Compute and store snapshot stats
    const issuesByType: Record<string, number> = {};
    for (const issue of allIssues) {
      issuesByType[issue.type] = (issuesByType[issue.type] ?? 0) + 1;
    }

    await db.insert(schema.snapshotStats).values({
      snapshotId,
      totalWiseTeachers: wiseTeachers.length,
      totalIdentityGroups: groups.length,
      resolvedGroups: groups.filter((g) => !identityIssues.some((i) => i.entityId === g.canonicalKey)).length,
      unresolvedGroups: identityIssues.length,
      totalQualifications: qualificationRows.length,
      totalAvailabilityWindows: recurringAvailabilityRows.length,
      totalLeaves: datedLeaveRows.length,
      totalFutureSessions: sessionBlocks.length,
      totalDataIssues: allIssues.length,
      issuesByType,
    });

    // 12. Validate and promote
    const unresolvedRatio = identityIssues.length / Math.max(groups.length, 1);

    // Promote if not catastrophically broken (>50% unresolved = fail)
    const shouldPromote = unresolvedRatio < 0.5;

    let promotedSnapshotId: string | null = null;

    if (shouldPromote) {
      // Atomic promotion: deactivate old, activate new
      await db
        .update(schema.snapshots)
        .set({ active: false })
        .where(
          and(eq(schema.snapshots.active, true), sql`${schema.snapshots.id} != ${snapshotId}`)
        );

      await db
        .update(schema.snapshots)
        .set({ active: true })
        .where(eq(schema.snapshots.id, snapshotId));

      promotedSnapshotId = snapshotId;
    }

    // Update sync run
    await db
      .update(schema.syncRuns)
      .set({
        status: "success",
        finishedAt: new Date(),
        promotedSnapshotId,
        teacherCount: wiseTeachers.length,
      })
      .where(eq(schema.syncRuns.id, syncRunId));

    return {
      success: true,
      syncRunId,
      snapshotId,
      promotedSnapshotId,
      teacherCount: wiseTeachers.length,
      groupCount: groups.length,
      issueCount: allIssues.length,
      errorSummary: null,
      durationMs: Date.now() - startTime,
    };
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);

    if (syncRunId) {
      await db
        .update(schema.syncRuns)
        .set({
          status: "failed",
          finishedAt: new Date(),
          errorSummary: errorMessage,
        })
        .where(eq(schema.syncRuns.id, syncRunId))
        .catch(() => {}); // Don't throw on cleanup
    }

    return {
      success: false,
      syncRunId,
      snapshotId: snapshotId || null,
      promotedSnapshotId: null,
      teacherCount: 0,
      groupCount: 0,
      issueCount: 0,
      errorSummary: errorMessage,
      durationMs: Date.now() - startTime,
    };
  }
}
