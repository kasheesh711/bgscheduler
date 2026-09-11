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
  await db
    .insert(s.roomDayStates)
    .values({ date, checkedAt: now, evidence: { blocks: [], uncertain: [] } });
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
        await db
          .insert(s.wiseActivityEvents)
          .values({
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
          (await db.select().from(s.roomDayStates))[0].evidence.blocks,
        ).toEqual([]);
        await expect(
          createRoomReservation(db, "alice", input()),
        ).resolves.toMatchObject({ status: "confirmed" });
      } else {
        await expect(refreshRoomOccupancy(db, now, client)).rejects.toThrow(
          "Session not found",
        );
        expect(
          (await db.select().from(s.roomDayStates))[0].evidence.blocks,
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
    const [state] = await db.select().from(s.roomDayStates);
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
