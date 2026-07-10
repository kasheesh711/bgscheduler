import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({ getDb: vi.fn() }));

import {
  admissionsAuditLog,
  admissionsCaseMeetings,
  admissionsCaseTasks,
} from "@/lib/db/schema";
import {
  ADMISSIONS_TASK_OWNERS,
  MEETING_ACTION_ITEM_PHASE,
  computeDaysSinceLastTouch,
  createMeeting,
  getDaysSinceLastTouch,
  getLastTouchMap,
  listMeetings,
  updateMeeting,
} from "@/lib/admissions/meetings";
import type { Database } from "@/lib/db";

const CASE_ID = "11111111-1111-4111-8111-111111111111";
// 2026-07-09 17:00 in Asia/Bangkok (UTC+7).
const NOW = new Date("2026-07-09T10:00:00Z");
const CREATED_AT = new Date("2026-07-01T00:00:00Z");

const EXISTING_MEETING = {
  id: "meeting-1",
  caseId: CASE_ID,
  meetingDate: "2026-07-01",
  mode: "zoom",
  attendees: ["Counselor"],
  notes: "old notes",
  nextMeetingDate: null,
  deletedAt: null,
  createdAt: CREATED_AT,
  updatedAt: CREATED_AT,
};

interface InsertCall {
  table: unknown;
  values: Record<string, unknown>;
}

interface UpdateCall {
  table: unknown;
  set: Record<string, unknown>;
}

/**
 * Mock write db whose transaction hands the callback a tx recording every
 * insert/update. Inserted rows come back from returning() with sequential
 * generated ids and fixed timestamps; select().limit() resolves the provided
 * existing row (or nothing).
 */
function makeWriteDb(existingRow?: Record<string, unknown>) {
  const inserts: InsertCall[] = [];
  const updates: UpdateCall[] = [];
  let idCounter = 0;

  const tx = {
    insert: (table: unknown) => ({
      values: (values: Record<string, unknown>) => {
        inserts.push({ table, values });
        const id = `id-${++idCounter}`;
        return {
          returning: async () => [
            { id, createdAt: CREATED_AT, updatedAt: CREATED_AT, deletedAt: null, ...values },
          ],
        };
      },
    }),
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () => (existingRow ? [existingRow] : []),
        }),
      }),
    }),
    update: (table: unknown) => ({
      set: (set: Record<string, unknown>) => {
        updates.push({ table, set });
        return {
          where: () => ({
            returning: async () => [{ ...(existingRow ?? {}), ...set }],
          }),
        };
      },
    }),
  };

  const transaction = vi.fn(async (cb: (t: unknown) => Promise<unknown>) => cb(tx));
  const db = { transaction } as unknown as Database;
  return { db, inserts, updates, transaction };
}

/** Mock read db: select().from().where() resolves rows and supports .orderBy(). */
function makeSelectDb(rows: Array<Record<string, unknown>>) {
  const select = vi.fn(() => ({
    from: () => ({
      where: () => Object.assign(Promise.resolve(rows), { orderBy: async () => rows }),
    }),
  }));
  const db = { select } as unknown as Database;
  return { db, select };
}

describe("createMeeting", () => {
  const baseInput = {
    caseId: CASE_ID,
    actorEmail: "counselor@example.com",
    actorRole: "counselor" as const,
    meetingDate: "2026-07-09",
    mode: "zoom",
    attendees: ["Counselor", "Student"],
    notes: "Discussed essays",
    nextMeetingDate: "2026-07-16",
  };

  it("creates one admissions_case_tasks row per action item with phase custom and null itemKey", async () => {
    const { db, inserts } = makeWriteDb();

    const result = await createMeeting({
      ...baseInput,
      actionItems: [
        { title: "Draft main essay", owner: "student", dueDate: "2026-07-15" },
        { title: "Email recommender", owner: "counselor", dueDate: null },
      ],
    }, db);

    const taskInserts = inserts.filter((call) => call.table === admissionsCaseTasks);
    expect(taskInserts).toHaveLength(2);
    expect(taskInserts[0].values).toEqual({
      caseId: CASE_ID,
      itemKey: null,
      phase: MEETING_ACTION_ITEM_PHASE,
      title: "Draft main essay",
      owner: "student",
      dueDate: "2026-07-15",
      sortOrder: 0,
    });
    expect(taskInserts[0].values.phase).toBe("custom");
    expect(taskInserts[1].values).toEqual(expect.objectContaining({
      itemKey: null,
      phase: "custom",
      title: "Email recommender",
      owner: "counselor",
      dueDate: null,
      sortOrder: 1,
    }));
    // Meeting row inserted first (id-1); the two tasks follow.
    expect(result.createdTaskIds).toEqual(["id-2", "id-3"]);
  });

  it("writes one audit row linking the created task ids", async () => {
    const { db, inserts } = makeWriteDb();

    await createMeeting({
      ...baseInput,
      actionItems: [{ title: "Draft main essay", owner: "student", dueDate: null }],
    }, db);

    const auditInserts = inserts.filter((call) => call.table === admissionsAuditLog);
    expect(auditInserts).toHaveLength(1);
    expect(auditInserts[0].values).toEqual(expect.objectContaining({
      caseId: CASE_ID,
      actorEmail: "counselor@example.com",
      actorRole: "counselor",
      entityType: "meeting",
      entityId: "id-1",
      action: "create",
      diff: { actionItemTaskIds: { old: null, new: ["id-2"] } },
    }));
  });

  it("creates no tasks and audits a null diff when actionItems is omitted", async () => {
    const { db, inserts } = makeWriteDb();

    const result = await createMeeting(baseInput, db);

    expect(inserts.filter((call) => call.table === admissionsCaseTasks)).toHaveLength(0);
    const auditInsert = inserts.find((call) => call.table === admissionsAuditLog);
    expect(auditInsert?.values.diff).toBeNull();
    expect(result.createdTaskIds).toEqual([]);
  });

  it("returns the meeting DTO with exact keys and serialized timestamps", async () => {
    const { db, inserts } = makeWriteDb();

    const result = await createMeeting(baseInput, db);

    expect(inserts.filter((call) => call.table === admissionsCaseMeetings)).toHaveLength(1);
    expect(Object.keys(result.meeting).sort()).toEqual([
      "attendees",
      "caseId",
      "createdAt",
      "id",
      "meetingDate",
      "mode",
      "nextMeetingDate",
      "notes",
      "updatedAt",
    ]);
    expect(result.meeting).toEqual({
      id: "id-1",
      caseId: CASE_ID,
      meetingDate: "2026-07-09",
      mode: "zoom",
      attendees: ["Counselor", "Student"],
      notes: "Discussed essays",
      nextMeetingDate: "2026-07-16",
      createdAt: "2026-07-01T00:00:00.000Z",
      updatedAt: "2026-07-01T00:00:00.000Z",
    });
  });

  it("defaults optional fields (attendees [], nulls) on insert", async () => {
    const { db, inserts } = makeWriteDb();

    await createMeeting({
      caseId: CASE_ID,
      actorEmail: "counselor@example.com",
      actorRole: "counselor",
      meetingDate: "2026-07-09",
    }, db);

    const meetingInsert = inserts.find((call) => call.table === admissionsCaseMeetings);
    expect(meetingInsert?.values).toEqual({
      caseId: CASE_ID,
      meetingDate: "2026-07-09",
      mode: null,
      attendees: [],
      notes: null,
      nextMeetingDate: null,
    });
  });

  it("rejects an unknown action item owner before any write (fail-closed)", async () => {
    const { db, transaction } = makeWriteDb();

    await expect(createMeeting({
      ...baseInput,
      actionItems: [{ title: "Task", owner: "teacher" as never, dueDate: null }],
    }, db)).rejects.toThrow(/Invalid action item owner/);
    await expect(createMeeting({
      ...baseInput,
      actionItems: [{ title: "Task", owner: "parent", dueDate: null }],
    }, db)).rejects.toThrow(/Invalid action item owner/);
    expect(transaction).not.toHaveBeenCalled();
    expect(ADMISSIONS_TASK_OWNERS).toEqual(["student", "counselor", "parent"]);
  });

  it("rejects a malformed meetingDate before any write", async () => {
    const { db, transaction } = makeWriteDb();

    await expect(createMeeting({ ...baseInput, meetingDate: "07/09/2026" }, db))
      .rejects.toThrow(/Invalid meetingDate/);
    expect(transaction).not.toHaveBeenCalled();
  });

  it("rejects an empty action item title before any write", async () => {
    const { db, transaction } = makeWriteDb();

    await expect(createMeeting({
      ...baseInput,
      actionItems: [{ title: "   ", owner: "student", dueDate: null }],
    }, db)).rejects.toThrow(/title must not be empty/);
    expect(transaction).not.toHaveBeenCalled();
  });
});

describe("updateMeeting", () => {
  const actor = { actorEmail: "counselor@example.com", actorRole: "counselor" as const };

  it("throws NotFound when the meeting does not exist in this case", async () => {
    const { db } = makeWriteDb();

    await expect(updateMeeting({
      caseId: CASE_ID,
      meetingId: "meeting-x",
      ...actor,
      notes: "new",
    }, db)).rejects.toThrow("NotFound");
  });

  it("updates only the provided fields and audits the diff", async () => {
    const { db, inserts, updates } = makeWriteDb(EXISTING_MEETING);

    const result = await updateMeeting({
      caseId: CASE_ID,
      meetingId: "meeting-1",
      ...actor,
      notes: "new notes",
    }, db);

    expect(updates).toHaveLength(1);
    expect(updates[0].table).toBe(admissionsCaseMeetings);
    expect(Object.keys(updates[0].set).sort()).toEqual(["notes", "updatedAt"]);
    expect(updates[0].set.notes).toBe("new notes");
    expect(updates[0].set.updatedAt).toBeInstanceOf(Date);
    expect(result.notes).toBe("new notes");

    const auditInsert = inserts.find((call) => call.table === admissionsAuditLog);
    expect(auditInsert?.values).toEqual(expect.objectContaining({
      entityType: "meeting",
      entityId: "meeting-1",
      action: "update",
      diff: { notes: { old: "old notes", new: "new notes" } },
    }));
  });

  it("is a no-op (no update, no audit) when the provided values are unchanged", async () => {
    const { db, inserts, updates } = makeWriteDb(EXISTING_MEETING);

    const result = await updateMeeting({
      caseId: CASE_ID,
      meetingId: "meeting-1",
      ...actor,
      notes: "old notes",
      attendees: ["Counselor"],
    }, db);

    expect(updates).toHaveLength(0);
    expect(inserts).toHaveLength(0);
    expect(result.notes).toBe("old notes");
  });
});

describe("listMeetings", () => {
  it("maps rows to DTOs with serialized timestamps", async () => {
    const { db } = makeSelectDb([EXISTING_MEETING]);

    const meetings = await listMeetings(CASE_ID, db);

    expect(meetings).toEqual([{
      id: "meeting-1",
      caseId: CASE_ID,
      meetingDate: "2026-07-01",
      mode: "zoom",
      attendees: ["Counselor"],
      notes: "old notes",
      nextMeetingDate: null,
      createdAt: "2026-07-01T00:00:00.000Z",
      updatedAt: "2026-07-01T00:00:00.000Z",
    }]);
  });
});

describe("computeDaysSinceLastTouch", () => {
  it("returns null when there are no meetings", () => {
    expect(computeDaysSinceLastTouch([], NOW)).toBeNull();
  });

  it("returns 0 for a meeting logged today (Bangkok)", () => {
    expect(computeDaysSinceLastTouch(["2026-07-09"], NOW)).toBe(0);
  });

  it("counts whole days since the most recent past meeting", () => {
    expect(computeDaysSinceLastTouch(["2026-06-01", "2026-07-01"], NOW)).toBe(8);
  });

  it("ignores future meeting dates (a plan is not a touch)", () => {
    expect(computeDaysSinceLastTouch(["2026-07-01", "2026-08-01"], NOW)).toBe(8);
  });

  it("returns null when only future meetings exist", () => {
    expect(computeDaysSinceLastTouch(["2026-08-01"], NOW)).toBeNull();
  });

  it("uses the Bangkok calendar day, not UTC", () => {
    // 18:00 UTC = 01:00 next day in Bangkok, so "today" is already 2026-07-09.
    const lateUtc = new Date("2026-07-08T18:00:00Z");
    expect(computeDaysSinceLastTouch(["2026-07-08"], lateUtc)).toBe(1);
    expect(computeDaysSinceLastTouch(["2026-07-09"], lateUtc)).toBe(0);
  });

  it("skips malformed dates instead of guessing", () => {
    expect(computeDaysSinceLastTouch(["07/01/2026", "garbage"], NOW)).toBeNull();
    expect(computeDaysSinceLastTouch(["garbage", "2026-07-05"], NOW)).toBe(4);
  });
});

describe("getDaysSinceLastTouch", () => {
  it("computes days from the case's meeting dates", async () => {
    const { db } = makeSelectDb([
      { meetingDate: "2026-07-01" },
      { meetingDate: "2026-08-01" },
    ]);

    await expect(getDaysSinceLastTouch(CASE_ID, NOW, db)).resolves.toBe(8);
  });

  it("returns null when the case has no meetings", async () => {
    const { db } = makeSelectDb([]);

    await expect(getDaysSinceLastTouch(CASE_ID, NOW, db)).resolves.toBeNull();
  });
});

describe("getLastTouchMap", () => {
  it("returns an entry for every requested case, null when untouched", async () => {
    const { db } = makeSelectDb([
      { caseId: "case-a", meetingDate: "2026-07-05" },
      { caseId: "case-a", meetingDate: "2026-07-01" },
      { caseId: "case-c", meetingDate: "2026-08-01" },
    ]);

    const map = await getLastTouchMap(["case-a", "case-b", "case-c"], NOW, db);

    expect(map.size).toBe(3);
    expect(map.get("case-a")).toBe(4);
    expect(map.get("case-b")).toBeNull();
    expect(map.get("case-c")).toBeNull();
  });

  it("skips the query entirely for an empty caseIds list", async () => {
    const { db, select } = makeSelectDb([]);

    const map = await getLastTouchMap([], NOW, db);

    expect(map.size).toBe(0);
    expect(select).not.toHaveBeenCalled();
  });
});
