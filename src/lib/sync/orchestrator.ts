import { eq, or, sql } from "drizzle-orm";
import { addDays } from "date-fns";
import { Database } from "@/lib/db";
import * as schema from "@/lib/db/schema";
import { topWisePaths, WiseClient } from "@/lib/wise/client";
import {
  getWiseSessionTeacherUserId,
  getWiseTagName,
  getWiseTeacherDisplayName,
  getWiseTeacherUserId,
  type WiseLeave,
} from "@/lib/wise/types";
import {
  fetchAllTeachers,
  fetchAllFutureSessions,
  fetchTeacherFarLeaves,
  fetchTeacherNearAvailability,
  NEAR_HORIZON_DAYS,
  resolveAvailabilityHorizonDays,
  resolveFarHorizonMaxAgeMinutes,
} from "@/lib/wise/fetchers";
import {
  isFarCacheFresh,
  loadFarLeaveCache,
  saveFarLeaveCache,
  type FarLeaveCacheUpsert,
} from "@/lib/wise/availability-cache";
import { resolveIdentities, AliasMapping } from "@/lib/normalization/identity";
import { normalizeWorkingHours } from "@/lib/normalization/availability";
import { normalizeLeaves } from "@/lib/normalization/leaves";
import { normalizeSessions } from "@/lib/normalization/sessions";
import { normalizeTeacherTags } from "@/lib/normalization/qualifications";
import { deriveModality } from "@/lib/normalization/modality";
import { detectSessionModalityConflict } from "@/lib/search/compare";
import { runPastSessionsDiffHook } from "@/lib/sync/past-sessions-diff-hook";
import { pruneOldSnapshots } from "@/lib/sync/snapshot-pruning";

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

export interface RunFullSyncOptions {
  syncRunId?: string;
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
  instituteId: string,
  options: RunFullSyncOptions = {},
): Promise<SyncResult> {
  const startTime = Date.now();
  let syncRunId = options.syncRunId ?? "";
  let snapshotId = "";

  try {
    // 1. Create sync run unless the caller already acquired a guard row.
    if (!syncRunId) {
      const [syncRun] = await db
        .insert(schema.syncRuns)
        .values({ status: "running" })
        .returning({ id: schema.syncRuns.id });
      syncRunId = syncRun.id;
    }

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

    // ── AVAIL-01 near/far leave tiering ──
    // The near tier (days 0..28) is fetched live for every teacher, every run.
    // The far tier (days 28..horizon) is 22 of the 26 Wise calls per teacher and
    // is reused from `wise_teacher_availability_cache` while fresh. A miss, a
    // stale row, or a cache read error always falls through to a live fetch —
    // never to an empty leave set (see availability-cache.ts for why).
    const nearHorizonDays = NEAR_HORIZON_DAYS;
    const farHorizonDays = resolveAvailabilityHorizonDays();
    const farCacheShape = { farHorizonDays, farWindowStartDay: nearHorizonDays };
    const farMaxAgeMinutes = resolveFarHorizonMaxAgeMinutes();
    // One instant for the whole loop: watermarks stay comparable across teachers,
    // and anchoring on run start rather than per-teacher time is the conservative
    // (earlier watermark) direction.
    const leaveFetchNow = new Date(startTime);

    const farLeaveCache = await loadFarLeaveCache(
      db,
      wiseTeachers
        .map((teacher) => getWiseTeacherUserId(teacher))
        .filter((userId): userId is string => Boolean(userId)),
    );
    const farCacheUpserts: FarLeaveCacheUpsert[] = [];
    let farTierFetched = 0;
    let farTierCacheHits = 0;

    // AVAIL-01 leave-completeness watermark, per identity group. A group is only
    // as complete as its LEAST-complete Wise teacher row: without the min, one
    // identity variant failing its fetch while the other succeeds leaves the
    // group searchable with a partial leave set — fail-open. A member we could
    // not fetch at all contributes `leaveFetchNow`, i.e. "nothing in the future
    // is proven", which routes the whole group to Needs Review.
    const groupLeavesCompleteThrough = new Map<string, Date>();
    function recordLeaveCompleteness(groupId: string, completeThrough: Date) {
      const existing = groupLeavesCompleteThrough.get(groupId);
      if (!existing || completeThrough.getTime() < existing.getTime()) {
        groupLeavesCompleteThrough.set(groupId, completeThrough);
      }
    }

    // Process teachers with availability
    for (const teacher of wiseTeachers) {
      const groupId = teacherToGroupId.get(teacher._id);
      if (!groupId) continue;
      const teacherName = getWiseTeacherDisplayName(teacher);
      const teacherUserId = getWiseTeacherUserId(teacher);

      if (!teacherUserId) {
        // AVAIL-01: no user id means no leaves were fetched for this member at
        // all, so the group's watermark collapses to "now".
        recordLeaveCompleteness(groupId, leaveFetchNow);
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
        const near = await fetchTeacherNearAvailability(
          client,
          instituteId,
          teacherUserId,
          nearHorizonDays,
          leaveFetchNow,
        );
        const workingHours = near.workingHours;

        // Far tier: reuse the cached leaves when fresh, else fetch live and
        // queue the row for the single batched upsert after this loop.
        const cachedFar = farLeaveCache.get(teacherUserId);
        let farLeaves: WiseLeave[];
        let farFetchedAt: Date;

        if (isFarCacheFresh(cachedFar, leaveFetchNow, farMaxAgeMinutes, farCacheShape)) {
          farLeaves = cachedFar!.farLeaves;
          farFetchedAt = cachedFar!.fetchedAt;
          farTierCacheHits += 1;
        } else {
          const far = await fetchTeacherFarLeaves(
            client,
            instituteId,
            teacherUserId,
            nearHorizonDays,
            farHorizonDays,
            leaveFetchNow,
          );
          farLeaves = far.leaves;
          farFetchedAt = leaveFetchNow;
          farTierFetched += 1;
          farCacheUpserts.push({
            teacherUserId,
            farLeaves,
            farHorizonDays,
            farWindowStartDay: nearHorizonDays,
            fetchedAt: leaveFetchNow,
            fetchError: null,
          });
        }

        // Both tiers landed. The far tier is anchored on the instant it was
        // actually OBSERVED (which for a cache hit is older than this run), so a
        // long WISE_FAR_HORIZON_MAX_AGE_MINUTES can never over-claim coverage.
        const nearCompleteThrough = addDays(leaveFetchNow, nearHorizonDays);
        const farCompleteThrough = addDays(farFetchedAt, farHorizonDays);
        recordLeaveCompleteness(
          groupId,
          farCompleteThrough > nearCompleteThrough ? farCompleteThrough : nearCompleteThrough,
        );

        // normalizeLeaves de-duplicates and merges touching intervals, so the
        // leave straddling the day-28 window boundary appearing in both tiers is
        // harmless.
        const leaves = [...near.leaves, ...farLeaves];

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
        // AVAIL-01: this member contributed no leaves, but a sibling identity
        // variant may still have supplied availability windows that keep the
        // group searchable. Collapse the group's watermark to "now" so those
        // slots route to Needs Review instead of Available.
        recordLeaveCompleteness(groupId, leaveFetchNow);
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

    // AVAIL-01: one batched upsert for every far tier fetched live this run.
    // saveFarLeaveCache swallows write failures — the sync has already produced
    // correct data, and a cache write must never fail a healthy run.
    await saveFarLeaveCache(db, farCacheUpserts);

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
        wiseTeacherUserId: block.wiseTeacherUserId,
        wiseSessionId: block.wiseSessionId,
        wiseClassId: block.wiseClassId,
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
        studentName: block.studentName,
        studentCount: block.studentCount,
        subject: block.subject,
        classType: block.classType,
        recurrenceId: block.recurrenceId,
      });
    }

    // 9. Derive modality for each group
    const teacherModalities = new Map<string, typeof schema.modalityEnum.enumValues[number]>();
    // Hoisted for the MOD-01 per-session contradiction loop below — read-only
    // lookup keyed by group.canonicalKey so the contradiction pass can resolve
    // the group's supportedModality from memory without a per-session SELECT.
    const groupSupportedModality = new Map<string, "online" | "onsite" | "both" | "unresolved">();
    const tutorRows: typeof schema.tutors.$inferInsert[] = [];

    for (const group of groups) {
      const gId = groupIdMap.get(group.canonicalKey)!;
      const groupSessions = sessionBlocks.filter((s) =>
        group.members.some((m) => m.wiseTeacherId === s.wiseTeacherId)
      );

      const { modality, issue } = deriveModality(group, groupSessions);

      // Hoist for Task 3's contradiction loop — avoids per-session SELECT.
      groupSupportedModality.set(group.canonicalKey, modality as "online" | "onsite" | "both" | "unresolved");

      await db
        .update(schema.tutorIdentityGroups)
        .set({
          supportedModality: modality,
          // AVAIL-01: min across the group's members, set in the same UPDATE that
          // already writes supportedModality. Null (no member recorded one) means
          // "completeness unknown" and the engine treats it as fail-closed.
          leavesCompleteThrough: groupLeavesCompleteThrough.get(gId) ?? null,
        })
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

    // MOD-01 (D-07/D-08): detect per-session modality contradictions and emit
    // `conflict_model` data_issues. Reads supportedModality from the
    // `groupSupportedModality` Map hoisted above — NO per-session DB SELECT.
    for (const group of groups) {
      const memberByTeacherId = new Map(group.members.map((m) => [m.wiseTeacherId, m]));
      const groupSessions = sessionBlocks.filter((s) => memberByTeacherId.has(s.wiseTeacherId));
      const supportedModality = groupSupportedModality.get(group.canonicalKey) ?? "unresolved";

      for (const session of groupSessions) {
        const member = memberByTeacherId.get(session.wiseTeacherId);
        if (!member) continue;
        const conflict = detectSessionModalityConflict({
          supportedModality,
          isOnlineVariant: member.isOnlineVariant,
          sessionType: session.sessionType,
          groupDisplayName: group.displayName,
        });
        if (conflict) {
          allIssues.push({
            snapshotId,
            type: "conflict_model",
            severity: "high",
            entityType: "future_session_block",
            entityId: session.wiseSessionId,
            entityName: group.displayName,
            message: conflict.message,
            metadata: {
              isOnlineVariant: conflict.isOnlineVariant,
              sessionType: conflict.sessionType,
              groupCanonicalKey: group.canonicalKey,
            },
          });
        }
      }
    }

    // ── 9.5. PAST-01 diff-hook ──
    // Capture sessions dropped from Wise FUTURE into past_session_blocks.
    // MUST run BEFORE atomic promotion (step 12) — the prior snapshot must
    // still be active=true when the hook reads it.
    //
    // Per-group errors emit completeness data_issues but do not abort the
    // sync (error-isolation matches the MOD-01 loop above).
    const diffHookResult = await runPastSessionsDiffHook(db, sessionBlocks, snapshotId);
    allIssues.push(
      ...diffHookResult.issues.map((i) => ({
        snapshotId: i.snapshotId,
        type: i.type,
        severity: i.severity,
        entityType: i.entityType,
        entityId: i.entityId,
        entityName: i.entityName,
        message: i.message,
      })),
    );

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
      // Atomic promotion via a single UPDATE: PostgreSQL MVCC + the row-level
      // lock held for the duration of one statement guarantee that concurrent
      // readers see either the prior-active row or the new-active row — never
      // a moment with zero matches on `active = true`. The bounded WHERE
      // restricts the rewrite to (a) the previous active row(s) and (b) the
      // candidate snapshot, avoiding a full-table rewrite per promote.
      // Replaces the prior two-UPDATE sequence (REL-01).
      await db
        .update(schema.snapshots)
        .set({
          active: sql`(${schema.snapshots.id} = ${snapshotId})`,
        })
        .where(
          or(
            eq(schema.snapshots.active, true),
            eq(schema.snapshots.id, snapshotId),
          ),
        );

      promotedSnapshotId = snapshotId;
    }

    // EFF-00: persist how long the run took and how much of it was Wise. The
    // duration was previously only ever returned to the caller, so a finished
    // run left no record of its own cost.
    const wiseStats = client.getStats();
    const successMetadata = {
      diffHookDurationMs: diffHookResult.durationMs,
      pastSessionsCapturedCount: diffHookResult.capturedCount,
      durationMs: Date.now() - startTime,
      wiseCallCount: wiseStats.requests,
      wiseTopPaths: topWisePaths(wiseStats),
      // AVAIL-01: the cache hit ratio is how you tell whether the tiering is
      // actually saving calls. farTierFetched * (farHorizonDays - nearHorizonDays)/7
      // is the Wise-call cost the cache did NOT avoid this run.
      farTierFetched,
      farTierCacheHits,
      nearHorizonDays,
      farHorizonDays,
    };

    // Update sync run
    await db
      .update(schema.syncRuns)
      .set({
        status: "success",
        finishedAt: new Date(),
        promotedSnapshotId,
        teacherCount: wiseTeachers.length,
        metadata: successMetadata,
      })
      .where(eq(schema.syncRuns.id, syncRunId));

    if (promotedSnapshotId) {
      let pruning:
        | Awaited<ReturnType<typeof pruneOldSnapshots>>
        | { attempted: true; failed: true; error: string };

      try {
        pruning = await pruneOldSnapshots(db);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(
          `[sync-orchestrator] snapshot pruning failed for syncRunId=${syncRunId}:`,
          message,
        );
        pruning = { attempted: true, failed: true, error: message };
      }

      try {
        await db
          .update(schema.syncRuns)
          .set({ metadata: { ...successMetadata, pruning } })
          .where(eq(schema.syncRuns.id, syncRunId));
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(
          `[sync-orchestrator] pruning metadata update failed for syncRunId=${syncRunId}:`,
          message,
        );
      }
    }

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
          metadata: {
            durationMs: Date.now() - startTime,
            wiseCallCount: client.getStats().requests,
          },
        })
        .where(eq(schema.syncRuns.id, syncRunId))
        .catch((cleanupErr) => {
          // REL-06: surface the cleanup failure in Vercel logs so an operator
          // can see WHY the sync_runs row is stuck in `running` state. We
          // still swallow (don't re-throw) because the primary errorMessage
          // is what matters for the SyncResult — masking it with a cleanup
          // error would be worse than the current behavior.
          const cleanupMsg =
            cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr);
          console.error(
            `[sync-orchestrator] cleanup failed for syncRunId=${syncRunId} after primary error "${errorMessage}":`,
            cleanupMsg,
          );
        });
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
