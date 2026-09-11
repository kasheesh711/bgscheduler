import {
  beforeAll,
  afterAll,
  beforeEach,
  afterEach,
  describe,
  it,
  expect,
  vi,
} from "vitest";
import { eq, sql } from "drizzle-orm";
import {
  startTestDb,
  stopTestDb,
  truncateAll,
} from "@/tests/integration/db-helper";
import type { Database } from "@/lib/db";
import * as s from "@/lib/db/schema";
import {
  createRoomReservation,
  cancelRoomReservation,
  mintRoomLink,
  resolveRoomLink,
  getRoomDayView,
  reservationRoomBlocks,
} from "../service";
import { withRoomDayOperation } from "../locking";
import {
  commitRoomEvidence,
  deliverRoomNotifications,
  refreshRoomOccupancy,
  runRoomRefresh,
} from "../refresh";
import type { WiseClient } from "@/lib/wise/client";
import { reviewRoomTutorLink } from "../admin";
import { ingestRoomEvents } from "../ingress";
import { processRoomEvent, routeRoomCommand } from "../bot";
import { sendLineRoomMessages, pushLineTextMessage } from "@/lib/line/client";
import { assignClassrooms } from "@/lib/classrooms/assignment-engine";
vi.mock("@/lib/line/client", () => ({
  sendLineRoomMessages: vi.fn().mockResolvedValue(undefined),
  pushLineTextMessage: vi.fn().mockResolvedValue({}),
  fetchLineProfile: vi.fn().mockResolvedValue({ displayName: "Alice LINE" }),
}));
let handle: Awaited<ReturnType<typeof startTestDb>>,
  db: Database,
  roomId: string,
  secondRoomId: string;
const now = new Date("2026-09-11T02:00:00Z"),
  date = "2026-09-11";
const input = (extra: Record<string, unknown> = {}) => ({
  date,
  roomId,
  startMinute: 600,
  endMinute: 660,
  idempotencyKey: crypto.randomUUID(),
  source: "test",
  ...extra,
});
beforeAll(async () => {
  handle = await startTestDb();
  db = handle.db as unknown as Database;
});
afterAll(async () => {
  if (handle) await stopTestDb(handle);
});
beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(now);
  vi.stubEnv("ROOM_BOOKING_WRITES_ENABLED", "true");
  vi.clearAllMocks();
  await truncateAll(handle.db);
  await db.execute(
    sql`TRUNCATE room_tutor_links,room_day_states,room_actions,room_command_events,room_booking_groups,line_group_settings,wise_activity_events CASCADE`,
  );
  const [snapshot] = await db
    .insert(s.snapshots)
    .values({ active: true })
    .returning();
  await db.insert(s.tutorIdentityGroups).values(
    ["alice", "bob"].map((name) => ({
      snapshotId: snapshot.id,
      canonicalKey: name,
      displayName: name,
    })),
  );
  await db.insert(s.roomTutorLinks).values(
    ["alice", "bob"].map((name) => ({
      lineUserId: name,
      canonicalKey: name,
      displayName: name,
      status: "approved" as const,
    })),
  );
  const rooms = await db
    .insert(s.classroomRooms)
    .values([
      { name: "Focus", capacity: 2, category: "standard" },
      { name: "Cool", capacity: 3, category: "standard" },
    ])
    .returning();
  [roomId, secondRoomId] = rooms.map((r) => r.id);
  await db.insert(s.roomDayStates).values(
    [date, "2026-09-12"].map((day) => ({
      date: day,
      checkedAt: now,
      evidence: { blocks: [], uncertain: [] },
    })),
  );
  const groups = await db.select().from(s.tutorIdentityGroups);
  await db.insert(s.tutorIdentityGroupMembers).values(
    groups.map((group) => ({
      groupId: group.id,
      snapshotId: group.snapshotId,
      wiseTeacherId: group.canonicalKey,
      wiseUserId: group.canonicalKey,
      wiseDisplayName: group.displayName,
    })),
  );
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});
describe("transactional room reservations", () => {
  it.each([false, true])(
    "retires missing Wise occupancy only with deletion evidence: %s",
    async (hasDeletion) => {
      const block = {
        sessionId: "deleted-wise-session",
        classId: "class-id",
        room: "Focus",
        canonicalKey: "alice",
        remote: false,
        blocking: true,
        status: "UPCOMING",
        startMinute: 600,
        endMinute: 660,
      };
      await db
        .update(s.roomDayStates)
        .set({ evidence: { blocks: [block], uncertain: [] } });
      if (hasDeletion)
        await db.insert(s.wiseActivityEvents).values({
          eventId: crypto.randomUUID(),
          eventName: "SessionDeletedEvent",
          eventTimestamp: now,
          sessionId: block.sessionId,
          classroomId: block.classId,
        });
      const missing = new Error(
        'Wise API 400: {"status":400,"message":"Session not found!"} (https://api.wiseapp.live/user/classes/class-id/sessions/deleted-wise-session)',
      );
      const client = {
        get: vi.fn(async (path: string) => {
          if (path.startsWith("/institutes/"))
            return { data: { sessions: [], page_count: 0 } };
          throw missing;
        }),
      } as unknown as WiseClient;
      if (hasDeletion) {
        await refreshRoomOccupancy(db, now, client);
        expect(
          (await db.select().from(s.roomDayStates)).find(
            (state) => state.date === date,
          )!.evidence.blocks,
        ).toEqual([]);
        await expect(
          createRoomReservation(db, "alice", input()),
        ).resolves.toMatchObject({ status: "confirmed" });
      } else {
        expect(await refreshRoomOccupancy(db, now, client)).toMatchObject({
          ok: false,
          dates: expect.arrayContaining([
            {
              date,
              ok: false,
              error: expect.stringContaining("Session not found"),
            },
          ]),
        });
        expect(
          (await db.select().from(s.roomDayStates)).find(
            (state) => state.date === date,
          )!.evidence.blocks,
        ).toEqual([block]);
        await expect(
          createRoomReservation(db, "alice", input()),
        ).rejects.toMatchObject({ code: "ROOM_CONFLICT" });
      }
    },
  );
  it("allows exactly one concurrent winner for the same room", async () => {
    const result = await Promise.allSettled([
      createRoomReservation(db, "alice", input()),
      createRoomReservation(db, "bob", input()),
    ]);
    expect(result.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(await db.select().from(s.roomReservations)).toHaveLength(1);
  });
  it("deduplicates simultaneous confirmations", async () => {
    const request = input();
    const results = await Promise.all([
      createRoomReservation(db, "alice", request),
      createRoomReservation(db, "alice", request),
    ]);
    expect(results[0].id).toBe(results[1].id);
  });
  it("rejects overlapping reservations by one tutor across different rooms", async () => {
    await createRoomReservation(db, "alice", input());
    await expect(
      createRoomReservation(db, "alice", input({ roomId: secondRoomId })),
    ).rejects.toMatchObject({ code: "TUTOR_CONFLICT" });
  });
  it("supports adjacent intervals and prevents another tutor cancelling", async () => {
    const a = await createRoomReservation(db, "alice", input());
    await createRoomReservation(
      db,
      "bob",
      input({ startMinute: 660, endMinute: 720 }),
    );
    await expect(
      cancelRoomReservation(db, a.id, { userId: "bob" }),
    ).rejects.toMatchObject({ status: 404 });
  });
  it("allows cancellation with stale evidence and blocks new bookings", async () => {
    const a = await createRoomReservation(db, "alice", input());
    await db
      .update(s.roomDayStates)
      .set({ checkedAt: new Date(now.getTime() - 300001) });
    await expect(
      createRoomReservation(db, "bob", input({ roomId: secondRoomId })),
    ).rejects.toMatchObject({ code: "STALE_ROOMS" });
    await cancelRoomReservation(db, a.id, { userId: "alice" });
  });
  it("blocks booking during a classroom write and invalidates the previous evidence after it", async () => {
    await withRoomDayOperation(db, date, async () => {
      await expect(
        createRoomReservation(db, "alice", input()),
      ).rejects.toMatchObject({ code: "ROOMS_UPDATING" });
    });
    await expect(
      createRoomReservation(db, "alice", input()),
    ).rejects.toMatchObject({ code: "STALE_ROOMS" });
  });
  it("revocation releases reservations and immediately invalidates access links", async () => {
    const a = await createRoomReservation(db, "alice", input());
    const token = await mintRoomLink(db, "alice");
    expect(await resolveRoomLink(db, token)).toBe("alice");
    await reviewRoomTutorLink(
      db,
      { lineUserId: "alice", status: "revoked" },
      "admin@example.test",
    );
    await expect(resolveRoomLink(db, token)).rejects.toMatchObject({
      status: 401,
    });
    const [row] = await db
      .select()
      .from(s.roomReservations)
      .where(eq(s.roomReservations.id, a.id));
    expect(row.status).toBe("cancelled");
  });
  it("expires private links after an hour and prevents duplicate tutor identity grants", async () => {
    const token = await mintRoomLink(db, "alice");
    await expect(
      resolveRoomLink(db, token, new Date(now.getTime() + 3600000)),
    ).rejects.toMatchObject({ status: 401 });
    await expect(
      reviewRoomTutorLink(
        db,
        { lineUserId: "bob", status: "approved", canonicalKey: "alice" },
        "admin@test",
      ),
    ).rejects.toMatchObject({ code: "ALREADY_LINKED" });
  });
  it("preempts once, preserves audit, and retries a failed private notification", async () => {
    // A booking can commit while Wise evidence is fetched. The collector must
    // reconcile the current reservations without discarding its fresh read.
    const state = (await db.select().from(s.roomDayStates)).find(
      (row) => row.date === date,
    )!;
    const a = await createRoomReservation(db, "alice", input());
    const evidence = {
      blocks: [
        {
          sessionId: "wise-1",
          classId: "class-1",
          room: "Focus",
          canonicalKey: null,
          remote: false,
          blocking: true,
          status: "UPCOMING",
          startMinute: 630,
          endMinute: 690,
        },
      ],
      uncertain: [],
    };
    await commitRoomEvidence(db, date, state.revision, evidence, now);
    expect((await db.select().from(s.roomReservations))[0].status).toBe(
      "preempted",
    );
    vi.mocked(pushLineTextMessage).mockRejectedValueOnce(new Error("offline"));
    await deliverRoomNotifications(db);
    expect((await db.select().from(s.roomNotifications))[0].sentAt).toBeNull();
    await deliverRoomNotifications(db);
    expect(
      (await db.select().from(s.roomNotifications))[0].sentAt,
    ).not.toBeNull();
    expect(await db.select().from(s.roomNotifications)).toHaveLength(1);
    expect(a.id).toBe(
      (await db.select().from(s.roomNotifications))[0].reservationId,
    );
  });
  it("rejects a refresh based on an obsolete classroom revision", async () => {
    await withRoomDayOperation(db, date, async () => undefined);
    await expect(
      commitRoomEvidence(db, date, 0, { blocks: [], uncertain: [] }, now),
    ).rejects.toMatchObject({ code: "ROOMS_CHANGED" });
  });
  it("does not leak another tutor's reservation or student names", async () => {
    await createRoomReservation(db, "alice", input());
    await db.update(s.roomDayStates).set({
      evidence: {
        blocks: [
          {
            sessionId: "private-wise-session",
            classId: "private-class",
            room: "Cool",
            canonicalKey: "alice",
            remote: false,
            blocking: true,
            status: "UPCOMING",
            startMinute: 600,
            endMinute: 660,
          },
        ],
        uncertain: [],
      },
    });
    const view = await getRoomDayView(db, "bob");
    expect(view.reservations).toEqual([]);
    expect(JSON.stringify(view.rooms)).not.toMatch(
      /alice|canonicalKey|sessionId/,
    );
  });
  it("passes reservations into the actual assignment engine as occupancy", async () => {
    await createRoomReservation(db, "alice", input());
    const blocks = await reservationRoomBlocks(db, date);
    expect(blocks[0].location).toBe("Focus");
    const session = {
      groupId: "bob",
      tutorDisplayName: "Bob",
      wiseTeacherId: "bob",
      wiseSessionId: "new-class",
      startTime: new Date("2026-09-11T03:00:00Z"),
      endTime: new Date("2026-09-11T04:00:00Z"),
      weekday: 5,
      startMinute: 600,
      endMinute: 660,
      wiseStatus: "UPCOMING",
      sessionType: "OFFLINE",
      studentCount: 1,
    };
    const rooms = [
      {
        name: "Focus",
        capacity: 5,
        hasTv: false,
        category: "standard" as const,
        active: true,
        sortOrder: 1,
      },
    ];
    expect(assignClassrooms([session], rooms).rows[0].assignedRoom).toBe(
      "Focus",
    );
    expect(
      assignClassrooms([session], rooms, new Map(), {
        externalRoomBlocks: blocks,
      }).rows[0].status,
    ).toBe("no_room");
  });
});
describe("next-day availability and lifecycle", () => {
  const tomorrow = "2026-09-12";
  it("books and cancels tomorrow morning after closing while stale reads still block new holds", async () => {
    vi.setSystemTime(new Date("2026-09-11T16:30:00Z"));
    await db.update(s.roomDayStates).set({ checkedAt: new Date() });
    const reservation = await createRoomReservation(
      db,
      "alice",
      input({ date: tomorrow, startMinute: 420, endMinute: 480 }),
    );
    expect(reservation.date).toBe(tomorrow);
    expect(
      await getRoomDayView(db, "alice", new Date(), tomorrow),
    ).toMatchObject({
      date: tomorrow,
      fresh: true,
      reservations: [
        expect.objectContaining({ date: tomorrow, status: "confirmed" }),
      ],
    });
    await db.update(s.roomDayStates).set({ checkedAt: null });
    await expect(
      createRoomReservation(
        db,
        "bob",
        input({ date: tomorrow, startMinute: 420, endMinute: 480 }),
      ),
    ).rejects.toMatchObject({ code: "STALE_ROOMS" });
    expect(
      (await cancelRoomReservation(db, reservation.id, { userId: "alice" }))
        .status,
    ).toBe("cancelled");
  });
  it("keeps tomorrow conflicts atomic across separate connections", async () => {
    const clients = await Promise.all([
      handle.pool.connect(),
      handle.pool.connect(),
    ]);
    const { drizzle } = await import("drizzle-orm/node-postgres");
    try {
      const databases = clients.map(
        (client) => drizzle(client, { schema: s }) as unknown as Database,
      );
      const results = await Promise.allSettled(
        databases.map((database, index) =>
          createRoomReservation(
            database,
            index ? "bob" : "alice",
            input({ date: tomorrow }),
          ),
        ),
      );
      expect(
        results.filter((result) => result.status === "fulfilled"),
      ).toHaveLength(1);
      expect(
        results.find((result) => result.status === "rejected"),
      ).toMatchObject({ reason: { code: "ROOM_CONFLICT" } });
    } finally {
      clients.forEach((client) => client.release());
    }
  });
  it("releases both dates and prevents a racing booking when tutor access is revoked", async () => {
    await createRoomReservation(db, "alice", input());
    await createRoomReservation(db, "alice", input({ date: tomorrow }));
    const results = await Promise.allSettled([
      reviewRoomTutorLink(
        db,
        { lineUserId: "alice", status: "revoked" },
        "admin@test",
      ),
      createRoomReservation(
        db,
        "alice",
        input({ date: tomorrow, startMinute: 720, endMinute: 780 }),
      ),
    ]);
    expect(results[0].status).toBe("fulfilled");
    expect(
      (await db.select().from(s.roomReservations)).filter(
        (row) => row.status === "confirmed",
      ),
    ).toEqual([]);
    await expect(
      createRoomReservation(db, "alice", input({ date: tomorrow })),
    ).rejects.toMatchObject({ code: "TUTOR_ACCESS" });
  });
  it("preempts tomorrow morning once even when today's clock is later", async () => {
    const reservation = await createRoomReservation(
      db,
      "alice",
      input({ date: tomorrow, startMinute: 420, endMinute: 480 }),
    );
    const evidence = {
      blocks: [
        {
          sessionId: "tomorrow-class",
          classId: "class",
          canonicalKey: "bob",
          room: "Focus",
          roomSource: "classroom_plan" as const,
          remote: false,
          blocking: true,
          status: "UPCOMING",
          startMinute: 420,
          endMinute: 480,
        },
      ],
      uncertain: [],
    };
    await commitRoomEvidence(db, tomorrow, 0, evidence, now);
    await commitRoomEvidence(db, tomorrow, 1, evidence, now);
    expect(
      (await db.select().from(s.roomReservations)).find(
        (row) => row.id === reservation.id,
      )?.status,
    ).toBe("preempted");
    const notifications = await db.select().from(s.roomNotifications);
    expect(notifications).toHaveLength(1);
    expect(notifications[0].text).toContain("2026-09-12, 07:00–08:00");
  });
  it("refreshes both dates with bounded reads and retains a blocked writer's date", async () => {
    const client = {
      get: vi.fn(async () => ({ data: { sessions: [], page_count: 0 } })),
    } as unknown as WiseClient;
    const result = await refreshRoomOccupancy(db, now, client);
    expect(result.dates).toEqual([
      expect.objectContaining({ date, ok: true }),
      expect.objectContaining({ date: tomorrow, ok: true }),
    ]);
    expect(
      vi
        .mocked(client.get)
        .mock.calls.filter((call) => call[1]?.status === "FUTURE"),
    ).toHaveLength(2);
    expect(vi.mocked(client.get).mock.calls.map((call) => call[1])).toEqual([
      expect.objectContaining({ status: "PAST", startDate: date, endDate: tomorrow }),
      expect.objectContaining({ status: "FUTURE", startDate: date, endDate: tomorrow }),
      expect.objectContaining({ status: "FUTURE", startDate: tomorrow, endDate: "2026-09-13" }),
    ]);
    await db
      .update(s.roomDayStates)
      .set({
        leaseOwner: "active-writer",
        leaseUntil: new Date(now.getTime() + 900000),
      })
      .where(eq(s.roomDayStates.date, tomorrow));
    expect(await refreshRoomOccupancy(db, now, client)).toMatchObject({
      ok: false,
      dates: [
        expect.objectContaining({ date, ok: true }),
        expect.objectContaining({ date: tomorrow, ok: false }),
      ],
    });
  });
  it("retains evidence and releases refresh claims on incomplete Wise reads", async () => {
    const client = {
      get: vi.fn(async () => ({ data: { sessions: [], page_count: 2 } })),
    } as unknown as WiseClient;
    const result = await refreshRoomOccupancy(db, now, client);
    expect(result.ok).toBe(false);
    expect(result.dates).toHaveLength(2);
    for (const state of await db.select().from(s.roomDayStates)) {
      expect(state.checkedAt).toEqual(now);
      expect(state.refreshOwner).toBeNull();
      expect(state.lastError).toBeTruthy();
    }
  });
  it("refreshes overnight when enabled and isolates today's past-list failures", async () => {
    vi.setSystemTime(new Date("2026-09-11T16:30:00Z"));
    vi.stubEnv("ROOM_BOOKING_COLLECTOR_ENABLED", "true");
    const client = {
      get: vi.fn(async (_path: string, params: Record<string, string>) => {
        if (params.status === "PAST")
          throw new Error("Past listing unavailable");
        return { data: { sessions: [], page_count: 0 } };
      }),
    } as unknown as WiseClient;
    const result = await runRoomRefresh(db, new Date(), client);
    expect(result).toMatchObject({
      ok: false,
      dates: [
        expect.objectContaining({ date, ok: false }),
        expect.objectContaining({ date: tomorrow, ok: true }),
      ],
    });
  });
  it("rejects tomorrow now, later dates, and stale confirmations across Bangkok midnight", async () => {
    await expect(
      createRoomReservation(
        db,
        "alice",
        input({ date: tomorrow, immediate: true }),
      ),
    ).rejects.toMatchObject({ code: "INVALID_IMMEDIATE" });
    await expect(
      createRoomReservation(db, "alice", input({ date: "2026-09-13" })),
    ).rejects.toMatchObject({ code: "INVALID_DATE" });
    vi.setSystemTime(new Date("2026-09-11T17:00:00Z"));
    await expect(
      createRoomReservation(db, "alice", input()),
    ).rejects.toMatchObject({ code: "INVALID_DATE" });
    await db.update(s.roomDayStates).set({ checkedAt: new Date() });
    expect(
      (
        await createRoomReservation(
          db,
          "alice",
          input({ date: tomorrow, startMinute: 420, endMinute: 480 }),
        )
      ).date,
    ).toBe(tomorrow);
  });
  it("does not depend on opening hours when the collector is disabled", async () => {
    vi.stubEnv("ROOM_BOOKING_COLLECTOR_ENABLED", "false");
    expect(
      await runRoomRefresh(db, new Date("2026-09-11T16:30:00Z")),
    ).toMatchObject({ skipped: true });
  });
  it("reproduces five blank online locations while preserving other free rooms", async () => {
    const group = (await db.select().from(s.tutorIdentityGroups)).find(
      (row) => row.canonicalKey === "alice",
    )!;
    const [run] = await db
      .insert(s.classroomAssignmentRuns)
      .values({ assignmentDate: date, snapshotId: group.snapshotId })
      .returning();
    const starts = [960, 960, 1020, 1080, 1140];
    const sessions = starts.map((start, index) => ({
      _id: `online-${index}`,
      classroomId: "class",
      userId: "alice",
      type: "SCHEDULED",
      location: "",
      meetingStatus: "UPCOMING",
      scheduledStartTime: `${date}T${String(Math.floor(start / 60)).padStart(2, "0")}:00:00+07:00`,
      scheduledEndTime: `${date}T${String(Math.floor(start / 60) + 1).padStart(2, "0")}:00:00+07:00`,
    }));
    await db.insert(s.classroomAssignmentRows).values(
      sessions.map((session, index) => ({
        runId: run.id,
        snapshotId: group.snapshotId,
        groupId: group.id,
        canonicalKey: "alice",
        tutorDisplayName: "Alice",
        wiseTeacherId: "alice",
        wiseSessionId: session._id,
        wiseClassId: "class",
        startTime: new Date(session.scheduledStartTime),
        endTime: new Date(session.scheduledEndTime),
        startMinute: starts[index],
        endMinute: starts[index] + 60,
        weekday: 5,
        wiseStatus: "UPCOMING",
        sessionType: "SCHEDULED",
        minCapacity: 1,
        assignedRoom: "Focus",
      })),
    );
    const client = {
      get: vi.fn(async (_path: string, params: Record<string, string>) => ({
        data: {
          sessions: params.status === "FUTURE" && params.startDate === date ? sessions : [],
          page_count: params.status === "FUTURE" && params.startDate === date ? 1 : 0,
        },
      })),
    } as unknown as WiseClient;
    expect((await refreshRoomOccupancy(db, now, client)).ok).toBe(true);
    const view = await getRoomDayView(db, "alice");
    expect(view.uncertain).toEqual([]);
    expect(view.classes).toHaveLength(5);
    expect(
      view.classes.every((row) => row.roomSource === "classroom_plan"),
    ).toBe(true);
    expect(view.rooms.find((room) => room.id === secondRoomId)?.free).toEqual([
      { startMinute: 420, endMinute: 1260 },
    ]);
    await expect(
      createRoomReservation(
        db,
        "bob",
        input({ startMinute: 960, endMinute: 1020 }),
      ),
    ).rejects.toMatchObject({ code: "ROOM_CONFLICT" });
    expect(
      (
        await createRoomReservation(
          db,
          "bob",
          input({ roomId: secondRoomId, startMinute: 960, endMinute: 1020 }),
        )
      ).status,
    ).toBe("confirmed");
  });
});
describe("LINE authorization and idempotency", () => {
  const event = (text: string, extra: Record<string, unknown> = {}) => ({
    eventId: crypto.randomUUID(),
    userId: "alice",
    scope: "dm",
    replyToken: "reply",
    text,
    receivedAt: now.toISOString(),
    ...extra,
  });
  it("persists one command and delivers one result for duplicate events", async () => {
    const e = event("/room");
    await ingestRoomEvents(db, [e, e]);
    await Promise.all([
      processRoomEvent(db, e.eventId),
      processRoomEvent(db, e.eventId),
    ]);
    expect(await db.select().from(s.roomCommandEvents)).toHaveLength(1);
    expect(sendLineRoomMessages).toHaveBeenCalledTimes(1);
  });
  it("stays silent in unregistered and family groups, including invalid buttons", async () => {
    await routeRoomCommand(db, event("/room", { scope: "family" }));
    await routeRoomCommand(db, event("room:invalid", { scope: "family" }));
    expect(sendLineRoomMessages).not.toHaveBeenCalled();
  });
  it("does not let another tutor reuse a confirmation", async () => {
    const [a] = await db
      .insert(s.roomActions)
      .values({
        lineUserId: "alice",
        scope: "dm",
        command: `reserve ${roomId} 10:00 11:00 ${date}`,
        expiresAt: new Date(now.getTime() + 300000),
      })
      .returning();
    await expect(
      routeRoomCommand(db, event(`/room confirm ${a.id}`, { userId: "bob" })),
    ).rejects.toMatchObject({ code: "BUTTON_EXPIRED" });
  });
  it("books through a native LINE confirmation button and deduplicates a second click", async () => {
    await routeRoomCommand(db, event("/room book Focus 10:00 11:00"));
    expect(await db.select().from(s.roomReservations)).toHaveLength(0);
    const actions = await db.select().from(s.roomActions);
    const confirmation = actions.find((a) => a.command.startsWith("confirm "))!;
    await routeRoomCommand(db, event(`room:${confirmation.id}`));
    await routeRoomCommand(db, event(`room:${confirmation.id}`));
    const reservations = await db.select().from(s.roomReservations);
    expect(reservations).toHaveLength(1);
    expect(reservations[0]).toMatchObject({
      roomId,
      lineUserId: "alice",
      startMinute: 600,
      endMinute: 660,
    });
  });
  it("keeps room pagination valid when availability changes or a page is out of range", async () => {
    await routeRoomCommand(db, event("/room free 10:00 11:00 999"));
    const message =
      vi.mocked(sendLineRoomMessages).mock.calls[0][0].messages[0];
    expect(message).toMatchObject({
      type: "flex",
      contents: { type: "carousel", contents: expect.any(Array) },
    });
    expect(
      message.type === "flex" ? message.contents.contents : undefined,
    ).toHaveLength(2);
  });
  it("carries tomorrow through native time pickers, room buttons, and confirmation", async () => {
    await routeRoomCommand(db, event("/room tomorrow choose"));
    let actions = await db.select().from(s.roomActions);
    const start = actions.find(
      (row) => row.command === "2026-09-12 choose-end",
    )!;
    await routeRoomCommand(
      db,
      event(`room:${start.id}`, { params: { time: "07:00" } }),
    );
    actions = await db.select().from(s.roomActions);
    const end = actions.find((row) => row.command === "2026-09-12 free 07:00")!;
    await routeRoomCommand(
      db,
      event(`room:${end.id}`, { params: { time: "08:00" } }),
    );
    actions = await db.select().from(s.roomActions);
    const book = actions.find(
      (row) => row.command === `2026-09-12 book ${roomId} 07:00 08:00`,
    )!;
    await routeRoomCommand(db, event(`room:${book.id}`));
    actions = await db.select().from(s.roomActions);
    const confirm = actions.find((row) => row.command.startsWith("confirm "))!;
    await routeRoomCommand(db, event(`room:${confirm.id}`));
    expect((await db.select().from(s.roomReservations))[0]).toMatchObject({
      date: "2026-09-12",
      startMinute: 420,
    });
    await routeRoomCommand(db, event("/room bookings"));
    expect(
      JSON.stringify(vi.mocked(sendLineRoomMessages).mock.lastCall),
    ).toContain("2026-09-12");
  });
  it("returns fresh alternatives after a competing teacher wins", async () => {
    await routeRoomCommand(db, event("/room tomorrow book Focus 07:00 08:00"));
    const confirm = (await db.select().from(s.roomActions)).find((row) =>
      row.command.startsWith("confirm "),
    )!;
    await createRoomReservation(
      db,
      "bob",
      input({ date: "2026-09-12", startMinute: 420, endMinute: 480 }),
    );
    await routeRoomCommand(db, event(`room:${confirm.id}`));
    const reply = JSON.stringify(vi.mocked(sendLineRoomMessages).mock.lastCall);
    expect(reply).toContain("taken before your confirmation");
    expect(reply).toContain("Cool");
    expect(await db.select().from(s.roomReservations)).toHaveLength(1);
  });
  it("DMs mobile links without putting credentials in the group response", async () => {
    await db.insert(s.lineGroupSettings).values({
      groupId: "staff",
      audience: "staff",
      setByLineUserId: "admin",
    });
    await db
      .insert(s.roomBookingGroups)
      .values({ groupId: "staff", enabled: true, updatedBy: "admin" });
    await routeRoomCommand(db, event("/room web", { scope: "staff" }));
    const calls = vi.mocked(sendLineRoomMessages).mock.calls.map((c) => c[0]);
    expect(calls.find((c) => c.to === "alice")?.messages[0]).toMatchObject({
      type: "text",
      text: expect.stringContaining("/room/"),
    });
    expect(JSON.stringify(calls.find((c) => c.to === "staff"))).not.toContain(
      "/room/",
    );
  });
});
