import { randomUUID } from "crypto";
import { and, eq, isNull, sql } from "drizzle-orm";
import type { Database } from "@/lib/db";
import * as s from "@/lib/db/schema";
import { withDatabaseTransaction } from "@/lib/db/transaction";
import { createWiseClient, type WiseClient } from "@/lib/wise/client";
import {
  fetchAllFutureSessions,
  fetchWiseSessionDetail,
} from "@/lib/wise/fetchers";
import {
  getWiseSessionClassId,
  getWiseSessionTeacherUserId,
  type WiseSession,
  type WiseSessionsResponse,
} from "@/lib/wise/types";
import { isBlockingStatus } from "@/lib/normalization/sessions";
import { isOnlineSessionType } from "@/lib/classrooms/session-mode";
import { physicalRoom } from "@/lib/classrooms/room-policy";
import { pushLineTextMessage } from "@/lib/line/client";
import { addBangkokDays } from "@/lib/room-capacity/dates";
import { lockRoomDay, assertRoomDayIdle } from "./locking";
import { loadRoomDay, endRoomReservation } from "./service";
import {
  roomDate,
  roomMinute,
  overlaps,
  ROOM_OPEN,
  ROOM_CLOSE,
  type RoomEvidence,
  type RoomEvidenceBlock,
  RoomBookingError,
} from "./model";

async function pastToday(
  client: WiseClient,
  institute: string,
  date: string,
  deadlineAt: number,
) {
  const sessions: WiseSession[] = [];
  const seen = new Set<string>();
  let count = 1;
  for (let page = 1; page <= count; page++) {
    if (Date.now() >= deadlineAt)
      throw new Error("Room refresh time budget exceeded");
    const res = await client.get<WiseSessionsResponse>(
      `/institutes/${institute}/sessions`,
      {
        status: "PAST",
        paginateBy: "DATE",
        startDate: date,
        endDate: addBangkokDays(date, 1),
        page_number: String(page),
        page_size: "50",
      },
      {
        signal: AbortSignal.timeout(Math.max(1, deadlineAt - Date.now())),
        cache: "no-store",
      },
    );
    const rows = res.data?.sessions;
    const pages = res.data?.page_count;
    if (
      !Array.isArray(rows) ||
      !Number.isInteger(pages) ||
      pages! < 0 ||
      (page > 1 && pages !== count) ||
      (!rows.length && pages! > 1) ||
      (rows.length > 0 && pages === 0)
    )
      throw new Error("Incomplete same-day Wise pagination");
    for (const row of rows) {
      if (
        !row._id ||
        seen.has(row._id) ||
        !Number.isFinite(Date.parse(row.scheduledStartTime)) ||
        !Number.isFinite(Date.parse(row.scheduledEndTime)) ||
        Date.parse(row.scheduledEndTime) <= Date.parse(row.scheduledStartTime)
      )
        throw new Error("Invalid same-day Wise session");
      seen.add(row._id);
      sessions.push(row);
    }
    count = pages!;
  }
  return sessions;
}
export function buildRoomEvidence(
  sessions: WiseSession[],
  date: string,
  rooms: string[],
  members: Map<string, string | null>,
  plans: Array<{
    wiseSessionId: string;
    startMinute: number;
    endMinute: number;
    status: string;
  }> = [],
): RoomEvidence {
  if (
    sessions.some(
      (session) =>
        !session._id ||
        !Number.isFinite(Date.parse(session.scheduledStartTime)) ||
        !Number.isFinite(Date.parse(session.scheduledEndTime)) ||
        Date.parse(session.scheduledEndTime) <=
          Date.parse(session.scheduledStartTime),
    )
  )
    throw new Error("Invalid Wise room evidence");
  const midnight = new Date(`${date}T00:00:00+07:00`).getTime();
  const day = sessions.filter(
    (session) =>
      Date.parse(session.scheduledStartTime) < midnight + 86400000 &&
      Date.parse(session.scheduledEndTime) > midnight &&
      !/^(CANCELLED|CANCELED)$/i.test(session.meetingStatus ?? ""),
  );
  const basics = day.map((session) => ({
    session,
    key: members.get(getWiseSessionTeacherUserId(session) ?? "") ?? null,
    startMinute: Math.max(
      0,
      Math.floor((Date.parse(session.scheduledStartTime) - midnight) / 60000),
    ),
    endMinute: Math.min(
      1440,
      Math.ceil((Date.parse(session.scheduledEndTime) - midnight) / 60000),
    ),
  }));
  const blocks: RoomEvidenceBlock[] = [];
  const uncertain: RoomEvidence["uncertain"] = [];
  for (const b of basics) {
    const { session, key, startMinute, endMinute } = b;
    const matching = rooms.filter(
      (name) => physicalRoom(name) === physicalRoom(session.location ?? ""),
    );
    const room = matching.length === 1 ? matching[0] : null;
    // Online sessions inherit an onsite requirement through transitive <60m chains.
    const chain = new Set([b]);
    let changed = true;
    while (changed && key) {
      changed = false;
      for (const other of basics)
        if (
          other.key === key &&
          !chain.has(other) &&
          [...chain].some(
            (c) =>
              other.startMinute - c.endMinute < 60 &&
              c.startMinute - other.endMinute < 60,
          )
        ) {
          chain.add(other);
          changed = true;
        }
    }
    const plan = plans.find(
      (p) =>
        p.wiseSessionId === session._id &&
        p.startMinute === startMinute &&
        p.endMinute === endMinute,
    );
    const remote =
      !room &&
      Boolean(key) &&
      isOnlineSessionType(session.type) &&
      (!plan || plan.status === "remote") &&
      [...chain].every((c) => isOnlineSessionType(c.session.type));
    const blocking = isBlockingStatus(session.meetingStatus);
    const block = {
      sessionId: session._id,
      classId: getWiseSessionClassId(session) ?? null,
      room,
      canonicalKey: key,
      remote,
      blocking,
      status: session.meetingStatus ?? "UNKNOWN",
      startMinute,
      endMinute,
    };
    blocks.push(block);
    if (blocking && !remote && !room)
      uncertain.push({ startMinute, endMinute });
  }
  return { blocks, uncertain };
}
export async function commitRoomEvidence(
  db: Database,
  date: string,
  revision: number,
  evidence: RoomEvidence,
  checkedAt: Date,
) {
  return withDatabaseTransaction(db, async (tx) => {
    const state = await lockRoomDay(tx, date);
    assertRoomDayIdle(state);
    if (state.revision !== revision)
      throw new RoomBookingError(
        "ROOMS_CHANGED",
        "Rooms changed during refresh; the next refresh will retry.",
      );
    const reservations = await tx
      .select({ reservation: s.roomReservations, room: s.classroomRooms.name })
      .from(s.roomReservations)
      .innerJoin(
        s.classroomRooms,
        eq(s.classroomRooms.id, s.roomReservations.roomId),
      )
      .where(
        and(
          eq(s.roomReservations.date, date),
          eq(s.roomReservations.status, "confirmed"),
        ),
      );
    for (const { reservation, room } of reservations) {
      if (reservation.endMinute <= roomMinute(checkedAt)) continue;
      if (
        evidence.blocks.some(
          (b) =>
            b.blocking &&
            b.room &&
            physicalRoom(b.room) === physicalRoom(room) &&
            overlaps(b, reservation),
        )
      ) {
        await endRoomReservation(
          tx,
          reservation,
          "preempted",
          `A Wise class now needs ${room} during your reservation.`,
          "wise-refresh",
          true,
        );
      }
    }
    await tx
      .update(s.roomDayStates)
      .set({
        evidence,
        checkedAt,
        lastError: null,
        revision: sql`${s.roomDayStates.revision} + 1`,
      })
      .where(eq(s.roomDayStates.date, date));
  });
}
export async function refreshRoomOccupancy(
  db: Database,
  now = new Date(),
  client = createWiseClient(),
) {
  const date = roomDate(now),
    owner = randomUUID();
  await withDatabaseTransaction(db, async (tx) => {
    const state = await lockRoomDay(tx, date);
    if (state.refreshUntil && state.refreshUntil.getTime() > Date.now())
      throw new RoomBookingError(
        "REFRESH_RUNNING",
        "Another room refresh is running.",
      );
    await tx
      .update(s.roomDayStates)
      .set({
        refreshOwner: owner,
        refreshUntil: new Date(Date.now() + 240_000),
      })
      .where(eq(s.roomDayStates.date, date));
  });
  try {
    return await refreshRoomOccupancyUnlocked(db, now, client);
  } finally {
    await db
      .update(s.roomDayStates)
      .set({ refreshOwner: null, refreshUntil: null })
      .where(
        and(
          eq(s.roomDayStates.date, date),
          eq(s.roomDayStates.refreshOwner, owner),
        ),
      );
  }
}
async function refreshRoomOccupancyUnlocked(
  db: Database,
  now: Date,
  client: WiseClient,
) {
  const date = roomDate(now);
  const startedAt = new Date();
  const deadlineAt = Date.now() + 210_000;
  // Clearing an abandoned writer invalidates all evidence before another reader
  // can book. Route writers are bounded to 800s; the lease is 900s.
  await withDatabaseTransaction(db, async (tx) => {
    const state = await lockRoomDay(tx, date);
    if (state.leaseUntil && state.leaseUntil.getTime() < Date.now()) {
      await tx
        .update(s.roomDayStates)
        .set({
          leaseOwner: null,
          leaseUntil: null,
          checkedAt: null,
          revision: sql`${s.roomDayStates.revision} + 1`,
        })
        .where(eq(s.roomDayStates.date, date));
    } else assertRoomDayIdle(state);
  });
  const day = await loadRoomDay(db, date);
  if (!day.rooms.length) throw new Error("The active room catalog is empty");
  const institute = process.env.WISE_INSTITUTE_ID ?? "696e1f4d90102225641cc413";
  try {
    const members = await db
      .select({
        userId: s.tutorIdentityGroupMembers.wiseUserId,
        teacherId: s.tutorIdentityGroupMembers.wiseTeacherId,
        key: s.tutorIdentityGroups.canonicalKey,
      })
      .from(s.tutorIdentityGroupMembers)
      .innerJoin(
        s.tutorIdentityGroups,
        eq(s.tutorIdentityGroups.id, s.tutorIdentityGroupMembers.groupId),
      )
      .innerJoin(
        s.snapshots,
        eq(s.snapshots.id, s.tutorIdentityGroups.snapshotId),
      )
      .where(eq(s.snapshots.active, true));
    const identities = new Map<string, string | null>();
    for (const m of members)
      for (const id of [m.userId, m.teacherId].filter(Boolean) as string[])
        identities.set(
          id,
          identities.has(id) && identities.get(id) !== m.key ? null : m.key,
        );
    const future = await fetchAllFutureSessions(client, institute, {
      strict: true,
      deadlineAt,
    });
    const past = await pastToday(client, institute, date, deadlineAt);
    const sessions = new Map(past.map((s) => [s._id, s]));
    for (const session of future) sessions.set(session._id, session);
    // Previously observed or planned sessions cannot disappear into an empty room.
    const expected = new Map([
      ...day.evidence.blocks.map((b) => [b.sessionId, b.classId] as const),
      ...day.rows.map((r) => [r.wiseSessionId, r.wiseClassId] as const),
    ]);
    for (const [id, classId] of expected)
      if (!sessions.has(id)) {
        if (!classId)
          throw new Error(
            "Cannot verify a missing Wise session without its class ID",
          );
        const detail = await fetchWiseSessionDetail(client, classId, id, {
          deadlineAt,
        });
        if (
          detail._id !== id ||
          !Number.isFinite(Date.parse(detail.scheduledStartTime)) ||
          !Number.isFinite(Date.parse(detail.scheduledEndTime))
        )
          throw new Error("Unable to verify a missing Wise session");
        sessions.set(id, detail);
      }
    const evidence = buildRoomEvidence(
      [...sessions.values()],
      date,
      day.rooms.map((r) => r.name),
      identities,
      day.rows,
    );
    await commitRoomEvidence(
      db,
      date,
      day.state!.revision,
      evidence,
      startedAt,
    );
    return {
      ok: true,
      date,
      sessions: evidence.blocks.length,
      uncertain: evidence.uncertain.length,
    };
  } catch (error) {
    await db
      .update(s.roomDayStates)
      .set({
        lastError:
          error instanceof Error ? error.message : "Room refresh failed",
      })
      .where(eq(s.roomDayStates.date, date));
    throw error;
  }
}
export async function deliverRoomNotifications(db: Database) {
  const rows = await db
    .select()
    .from(s.roomNotifications)
    .where(isNull(s.roomNotifications.sentAt))
    .limit(5);
  for (const row of rows) {
    try {
      await pushLineTextMessage({
        to: row.lineUserId,
        text: row.text,
        retryKey: row.id,
        signal: AbortSignal.timeout(5000),
      });
      await db
        .update(s.roomNotifications)
        .set({
          sentAt: new Date(),
          lastError: null,
          attempts: sql`${s.roomNotifications.attempts} + 1`,
        })
        .where(eq(s.roomNotifications.id, row.id));
    } catch {
      await db
        .update(s.roomNotifications)
        .set({
          lastError: "LINE delivery failed; will retry",
          attempts: sql`${s.roomNotifications.attempts} + 1`,
        })
        .where(eq(s.roomNotifications.id, row.id));
    }
  }
}
export async function runRoomRefresh(db: Database, now = new Date()) {
  if (
    process.env.ROOM_BOOKING_COLLECTOR_ENABLED !== "true" ||
    roomMinute(now) < ROOM_OPEN - 5 ||
    roomMinute(now) > ROOM_CLOSE + 5
  ) {
    await deliverRoomNotifications(db);
    return { ok: true, skipped: true };
  }
  try {
    return await refreshRoomOccupancy(db, now);
  } finally {
    await deliverRoomNotifications(db);
  }
}
