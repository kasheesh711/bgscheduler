import { beforeEach, expect, it, vi } from "vitest";
import type { Database } from "@/lib/db";
import * as s from "@/lib/db/schema";
import { ensureIndex, type SearchIndex } from "@/lib/search/index";
import { loadSources } from "../sources";
vi.mock("@/lib/search/index", () => ({ ensureIndex: vi.fn() }));
const now = new Date("2026-09-30T00:00:00Z");
let data: Map<unknown, unknown[]>;
let db: Database;
beforeEach(() => {
  data = new Map<unknown, unknown[]>([
    [s.creditControlSnapshots, [{ id: "students", generatedAt: now }]],
    [s.creditControlSessions, []],
    [
      s.creditControlStudents,
      [
        {
          wiseStudentId: "wise-student",
          studentKey: "student",
          studentName: "Known learner",
          parentName: "Parent",
        },
      ],
    ],
    [
      s.tutorWiseAccounts,
      [{ canonicalKey: "tutor", wiseTeacherId: "teacher", wiseUserId: "user" }],
    ],
    [s.tutorContacts, [{ canonicalKey: "tutor", displayName: "Tutor" }]],
    [s.tutorSitInMappings, []],
    [
      s.futureSessionBlocks,
      [
        {
          wiseSessionId: "dated-1",
          wiseClassId: "class",
          groupId: "group",
          title: "Eng+VR",
          wiseStatus: "UPCOMING",
          startTime: new Date("2026-10-05T10:00:00Z"),
          startMinute: 600,
          endMinute: 660,
          sessionType: "OFFLINE",
          studentIds: ["wise-student"],
        },
        {
          wiseSessionId: "dated-2",
          wiseClassId: "class",
          groupId: "group",
          title: "Eng+VR",
          wiseStatus: "UPCOMING",
          startTime: new Date("2026-10-12T10:00:00Z"),
          startMinute: 600,
          endMinute: 660,
          sessionType: "OFFLINE",
          studentIds: null,
        },
      ],
    ],
  ]);
  db = {
    select: () => ({
      from: (table: unknown) => {
        const result = Promise.resolve(data.get(table) || []);
        const query = {
          where: () => query,
          limit: () => result,
          then: result.then.bind(result),
        };
        return query;
      },
    }),
  } as unknown as Database;
  vi.mocked(ensureIndex).mockResolvedValue({
    snapshotId: "core",
    syncedAt: now,
    tutorGroups: [{ id: "group", canonicalKey: "tutor", sessionBlocks: [] }],
  } as unknown as SearchIndex);
});
it("resolves dated Wise student IDs without credit/package rows, leaving only the unknown occurrence blocked", async () => {
  const source = await loadSources("2026-Q4", db, now);
  expect(source.lessons[0]).toMatchObject({
    start: "2026-10-05T03:00:00.000Z",
    scopes: ["iseb_english_vr"],
    participants: [
      { studentName: "Known learner", wiseStudentId: "wise-student" },
    ],
    issues: [],
  });
  expect(source.lessons[1]).toMatchObject({
    participants: [],
    issues: [{ category: "students" }],
  });
});
it("does not mistake a partial credit join for an authoritative full roster", async () => {
  const rows = data.get(s.futureSessionBlocks)! as Array<{
    studentIds: string[] | null;
  }>;
  rows[0].studentIds = ["wise-student", "unknown-student"];
  data.set(s.creditControlSessions, [
    {
      wiseSessionId: "dated-1",
      wiseClassId: "class",
      wiseTeacherId: "teacher",
      title: "Eng+VR",
      scheduledStartTime: new Date("2026-10-05T03:00:00Z"),
      scheduledEndTime: new Date("2026-10-05T04:00:00Z"),
      meetingStatus: "UPCOMING",
      wiseStudentId: "wise-student",
      studentKey: "student",
      studentName: "Known learner",
    },
  ]);
  const source = await loadSources("2026-Q4", db, now);
  expect(source.lessons[0].participants).toHaveLength(1);
  expect(source.lessons[0].issues).toMatchObject([{ code: "STUDENT_ROSTER" }]);
});
