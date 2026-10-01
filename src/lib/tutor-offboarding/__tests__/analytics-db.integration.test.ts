import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  startTestDb,
  stopTestDb,
  truncateAll,
} from "@/tests/integration/db-helper";
import type { Database } from "@/lib/db";
import * as s from "@/lib/db/schema";
import { loadAnalyticsEvidence } from "../analytics-db";
let handle: Awaited<ReturnType<typeof startTestDb>>;
let db: Database;
const NOW = new Date("2026-10-01T05:00:00Z");
beforeAll(async () => {
  handle = await startTestDb();
  db = handle.db as unknown as Database;
});
afterAll(async () => {
  if (handle) await stopTestDb(handle);
});
beforeEach(async () => {
  await truncateAll(handle.db);
});
describe("analytics SELECT loader", () => {
  it("returns no snapshot and rejects a rotated snapshot ID", async () => {
    expect(await loadAnalyticsEvidence(db)).toBeNull();
    const [snapshot] = await db
      .insert(s.snapshots)
      .values({ active: true, createdAt: NOW })
      .returning();
    expect(
      await loadAnalyticsEvidence(
        db,
        "00000000-0000-0000-0000-000000000000",
        NOW,
      ),
    ).toBeNull();
    expect(
      (await loadAnalyticsEvidence(db, snapshot.id, NOW))?.signals.snapshotId,
    ).toBe(snapshot.id);
  });
  it("deduplicates ENDED attendance, enriches course names, excludes past blocking schedules and preserves unknown course IDs", async () => {
    const [snapshot] = await db
      .insert(s.snapshots)
      .values({ active: true, createdAt: NOW })
      .returning();
    const [group] = await db
      .insert(s.tutorIdentityGroups)
      .values({ snapshotId: snapshot.id, canonicalKey: "A", displayName: "A" })
      .returning();
    await db
      .insert(s.tutorIdentityGroupMembers)
      .values({
        snapshotId: snapshot.id,
        groupId: group.id,
        wiseTeacherId: "tA",
        wiseUserId: "uA",
        wiseDisplayName: "A Tutor",
      });
    await db
      .insert(s.tutorWiseAccounts)
      .values({
        wiseTeacherId: "tA",
        wiseUserId: "uA",
        canonicalKey: "A",
        displayName: "A Tutor",
        isOnlineVariant: false,
        status: "active",
        wiseRelation: "TEACHER",
        lastSnapshotId: snapshot.id,
      });
    const qualification = {
      snapshotId: snapshot.id,
      groupId: group.id,
      subject: "English",
      curriculum: "International",
      level: "Y2-8",
      sourceTag: "English (Int.) Y2-8",
    };
    await db
      .insert(s.subjectLevelQualifications)
      .values([qualification, qualification]);
    const common = {
      enrollmentKey: "enrollment",
      wiseSessionId: "ended1",
      wiseClassId: "course1",
      studentKey: "student",
      studentName: "PRIVATE STUDENT",
      subject: "Y2-8",
      scheduledStartTime: new Date("2026-03-02T03:00:00Z"),
      meetingStatus: "ENDED",
      tutorCanonicalKey: "A",
    };
    await db.insert(s.progressTestAttendanceLedger).values([
      { ...common, wiseStudentId: "student1" },
      { ...common, wiseStudentId: "student2" },
      {
        ...common,
        wiseSessionId: "cancelled",
        wiseStudentId: "student1",
        meetingStatus: "CANCELLED",
      },
    ]);
    await db
      .insert(s.postClassSessions)
      .values({
        wiseSessionId: "ended1",
        wiseClassId: "course1",
        className: "English course",
        canonicalTutorKey: "A",
        scheduledStartAt: common.scheduledStartTime,
        scheduledEndAt: new Date("2026-03-02T04:00:00Z"),
        deadlineAt: new Date("2026-03-03T04:00:00Z"),
        finalStatus: "ENDED",
      });
    await db
      .insert(s.pastSessionBlocks)
      .values({
        groupCanonicalKey: "A",
        wiseTeacherId: "tA",
        wiseSessionId: "scheduled-only",
        startTime: new Date("2026-04-01T03:00:00Z"),
        endTime: new Date("2026-04-01T04:00:00Z"),
        weekday: 3,
        startMinute: 600,
        endMinute: 660,
        wiseStatus: "SCHEDULED",
        isBlocking: true,
      });
    await db
      .insert(s.futureSessionBlocks)
      .values({
        snapshotId: snapshot.id,
        groupId: group.id,
        wiseTeacherId: "tA",
        wiseSessionId: "future",
        startTime: new Date("2026-10-02T03:00:00Z"),
        endTime: new Date("2026-10-02T04:00:00Z"),
        weekday: 5,
        startMinute: 600,
        endMinute: 660,
        wiseStatus: "SCHEDULED",
        isBlocking: true,
        title: "English",
        subject: "Y2-8",
      });
    const result = await loadAnalyticsEvidence(db, snapshot.id, NOW);
    expect(result?.qualifications).toHaveLength(1);
    expect(result?.historyPeople).toEqual([
      {
        canonicalKey: "A",
        lastAt: "2026-03-02T03:00:00.000Z",
        months: [{ month: "2026-03", sessions: 1 }],
      },
    ]);
    expect(result?.historyCourses[0]).toMatchObject({
      wiseClassId: "course1",
      title: "English course",
      wiseCourseCategory: "Y2-8",
    });
    expect(result?.futureCourses[0]).toMatchObject({
      wiseClassId: null,
      key: "missing:future",
    });
    expect(JSON.stringify(result)).not.toContain("PRIVATE STUDENT");
    expect(await db.select().from(s.progressTestAttendanceLedger)).toHaveLength(
      3,
    );
  });
});
