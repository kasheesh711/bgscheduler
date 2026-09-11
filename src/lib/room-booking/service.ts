import { createHash, randomBytes } from "crypto";
import { and, desc, eq, gt } from "drizzle-orm";
import type { Database } from "@/lib/db";
import * as s from "@/lib/db/schema";
import { withDatabaseTransaction } from "@/lib/db/transaction";
import { physicalRoom } from "@/lib/classrooms/room-policy";
import { FLOOR_PLAN_ASSIGNABLE_ROOM_NAMES } from "@/lib/classrooms/floor-plan";
import { lockRoomDay, assertRoomDayIdle } from "./locking";
import {
  freeIntervals,
  overlaps,
  roomDate,
  roomMinute,
  ROOM_FRESH_MS,
  roomWritesEnabled,
  RoomBookingError,
  validateRoomInterval,
  type Interval,
} from "./model";

export async function approvedRoomTutor(db: Database, userId: string) {
  const [link] = await db
    .select()
    .from(s.roomTutorLinks)
    .where(
      and(
        eq(s.roomTutorLinks.lineUserId, userId),
        eq(s.roomTutorLinks.status, "approved"),
      ),
    );
  if (!link?.canonicalKey)
    throw new RoomBookingError(
      "TUTOR_ACCESS",
      "Ask an admin to approve your tutor account in Tutor Profiles.",
      403,
    );
  const groups = await db
    .select({ key: s.tutorIdentityGroups.canonicalKey })
    .from(s.tutorIdentityGroups)
    .innerJoin(
      s.snapshots,
      eq(s.snapshots.id, s.tutorIdentityGroups.snapshotId),
    )
    .where(
      and(
        eq(s.snapshots.active, true),
        eq(s.tutorIdentityGroups.canonicalKey, link.canonicalKey),
      ),
    );
  if (groups.length !== 1)
    throw new RoomBookingError(
      "TUTOR_REVIEW",
      "Your tutor identity needs admin review.",
      403,
    );
  return { ...link, canonicalKey: link.canonicalKey };
}

export async function loadRoomDay(db: Database, date = roomDate()) {
  const [state] = await db
    .select()
    .from(s.roomDayStates)
    .where(eq(s.roomDayStates.date, date));
  const rooms = (
    await db
      .select()
      .from(s.classroomRooms)
      .where(eq(s.classroomRooms.active, true))
      .orderBy(s.classroomRooms.sortOrder)
  ).filter((room) => FLOOR_PLAN_ASSIGNABLE_ROOM_NAMES.includes(room.name));
  const reservations = await db
    .select()
    .from(s.roomReservations)
    .where(eq(s.roomReservations.date, date));
  const [run] = await db
    .select()
    .from(s.classroomAssignmentRuns)
    .where(eq(s.classroomAssignmentRuns.assignmentDate, date))
    .orderBy(desc(s.classroomAssignmentRuns.createdAt))
    .limit(1);
  const rows = run
    ? await db
        .select()
        .from(s.classroomAssignmentRows)
        .where(eq(s.classroomAssignmentRows.runId, run.id))
    : [];
  const evidence = state?.evidence ?? { blocks: [], uncertain: [] };
  const bySession = new Map(evidence.blocks.map((b) => [b.sessionId, b]));
  const uncertain: Interval[] = [...evidence.uncertain];
  // Retain draft destinations only for a still-current class. Wise cancellation
  // or a verified time change supersedes the saved plan.
  const planned = rows.filter((row) => {
    const live = bySession.get(row.wiseSessionId);
    return (
      live &&
      live.blocking &&
      live.startMinute === row.startMinute &&
      live.endMinute === row.endMinute &&
      !live.remote &&
      (row.status === "assigned" || row.status === "needs_review")
    );
  });
  const occupancy = rooms.map((room) => {
    const blocks: Array<Interval & { kind: "class" | "reservation" }> = [
      ...evidence.blocks
        .filter(
          (b) =>
            b.blocking &&
            b.room &&
            physicalRoom(b.room) === physicalRoom(room.name),
        )
        .map((b) => ({
          startMinute: b.startMinute,
          endMinute: b.endMinute,
          kind: "class" as const,
        })),
      ...planned
        .filter(
          (row) => physicalRoom(row.assignedRoom) === physicalRoom(room.name),
        )
        .map((row) => ({
          startMinute: row.startMinute,
          endMinute: row.endMinute,
          kind: "class" as const,
        })),
      ...reservations
        .filter((r) => r.status === "confirmed" && r.roomId === room.id)
        .map((r) => ({
          startMinute: r.startMinute,
          endMinute: r.endMinute,
          kind: "reservation" as const,
        })),
    ];
    return {
      id: room.id,
      name: room.name,
      capacity: room.capacity,
      hasTv: room.hasTv,
      category: room.category,
      blocks,
      free: freeIntervals([...blocks, ...uncertain]),
    };
  });
  return {
    date,
    state,
    rooms: occupancy,
    reservations,
    rows,
    evidence,
    uncertain,
  };
}
export type RoomDay = Awaited<ReturnType<typeof loadRoomDay>>;
export function roomDayFresh(day: RoomDay, now = new Date()) {
  return Boolean(
    day.state?.checkedAt &&
    !day.state.leaseOwner &&
    now.getTime() >= day.state.checkedAt.getTime() &&
    now.getTime() - day.state.checkedAt.getTime() <= ROOM_FRESH_MS &&
    day.rooms.length,
  );
}
export async function getRoomDayView(
  db: Database,
  userId: string,
  now = new Date(),
) {
  const tutor = await approvedRoomTutor(db, userId);
  const day = await loadRoomDay(db, roomDate(now));
  const fresh = roomDayFresh(day, now);
  const classes = day.evidence.blocks
    .filter((b) => b.canonicalKey === tutor.canonicalKey)
    .map((block) => {
      const row = day.rows.find(
        (r) =>
          r.wiseSessionId === block.sessionId &&
          r.startMinute === block.startMinute &&
          r.endMinute === block.endMinute,
      );
      return {
        startMinute: block.startMinute,
        endMinute: block.endMinute,
        room: block.remote
          ? "Remote / no room needed"
          : (block.room ?? "Room TBC"),
        plannedRoom:
          row?.assignedRoom &&
          row.status === "assigned" &&
          physicalRoom(row.assignedRoom) !== physicalRoom(block.room ?? "")
            ? row.assignedRoom
            : null,
      };
    })
    .sort((a, b) => a.startMinute - b.startMinute);
  return {
    date: day.date,
    nowMinute: roomMinute(now),
    tutorName: tutor.displayName,
    fresh,
    checkedAt: day.state?.checkedAt?.toISOString() ?? null,
    writesEnabled: roomWritesEnabled(),
    rooms: day.rooms.map((room) => ({ ...room, free: fresh ? room.free : [] })),
    classes,
    reservations: day.reservations
      .filter((r) => r.lineUserId === userId)
      .map((r) => ({
        id: r.id,
        roomId: r.roomId,
        roomName:
          day.rooms.find((room) => room.id === r.roomId)?.name ??
          "Inactive room",
        startMinute: r.startMinute,
        endMinute: r.endMinute,
        status: r.status,
        reason: r.reason,
      })),
  };
}
export type RoomDayView = Awaited<ReturnType<typeof getRoomDayView>>;

export async function createRoomReservation(
  db: Database,
  userId: string,
  input: Interval & {
    roomId: string;
    date: string;
    idempotencyKey: string;
    source: string;
    immediate?: boolean;
  },
  now?: Date,
) {
  if (!input.idempotencyKey || input.idempotencyKey.length > 200)
    throw new RoomBookingError(
      "INVALID_REQUEST",
      "Invalid booking request.",
      400,
    );
  return withDatabaseTransaction(db, async (tx) => {
    const state = await lockRoomDay(tx, input.date);
    assertRoomDayIdle(state);
    const tutor = await approvedRoomTutor(tx, userId);
    const [existing] = await tx
      .select()
      .from(s.roomReservations)
      .where(
        and(
          eq(s.roomReservations.lineUserId, userId),
          eq(s.roomReservations.idempotencyKey, input.idempotencyKey),
        ),
      );
    if (existing) return existing;
    if (!roomWritesEnabled())
      throw new RoomBookingError(
        "BOOKING_DISABLED",
        "Room booking is not enabled yet.",
      );
    const day = await loadRoomDay(tx, input.date);
    const commitNow = now ?? new Date();
    const interval = {
      startMinute: input.immediate ? roomMinute(commitNow) : input.startMinute,
      endMinute: input.endMinute,
    };
    validateRoomInterval(input.date, interval, commitNow, input.immediate);
    if (!roomDayFresh(day, commitNow))
      throw new RoomBookingError(
        "STALE_ROOMS",
        "Availability unavailable. Please try again after the next room update.",
      );
    const room = day.rooms.find((r) => r.id === input.roomId);
    if (!room)
      throw new RoomBookingError(
        "ROOM_UNAVAILABLE",
        "This room is not available for booking.",
      );
    if (
      !room.free.some(
        (f) =>
          f.startMinute <= interval.startMinute &&
          f.endMinute >= interval.endMinute,
      )
    ) {
      throw new RoomBookingError(
        "ROOM_CONFLICT",
        "That room is no longer free for the whole interval. Choose another room or time.",
      );
    }
    if (
      day.reservations.some(
        (r) =>
          r.status === "confirmed" &&
          r.canonicalKey === tutor.canonicalKey &&
          overlaps(r, interval),
      )
    ) {
      throw new RoomBookingError(
        "TUTOR_CONFLICT",
        "You already have a room reservation during this time.",
      );
    }
    const [reservation] = await tx
      .insert(s.roomReservations)
      .values({
        date: input.date,
        roomId: room.id,
        lineUserId: userId,
        canonicalKey: tutor.canonicalKey,
        ...interval,
        idempotencyKey: input.idempotencyKey,
        source: input.source,
      })
      .returning();
    return reservation;
  });
}
export async function endRoomReservation(
  tx: Database,
  reservation: typeof s.roomReservations.$inferSelect,
  status: "cancelled" | "preempted",
  reason: string,
  changedBy: string,
  notify: boolean,
) {
  const [changed] = await tx
    .update(s.roomReservations)
    .set({ status, reason, changedBy, updatedAt: new Date() })
    .where(
      and(
        eq(s.roomReservations.id, reservation.id),
        eq(s.roomReservations.status, "confirmed"),
      ),
    )
    .returning();
  if (changed && notify)
    await tx
      .insert(s.roomNotifications)
      .values({
        reservationId: changed.id,
        lineUserId: changed.lineUserId,
        text: `Your room reservation ${changed.id} has been ${status}. ${reason} Use /room to see current alternatives.`,
      })
      .onConflictDoNothing();
  return changed ?? reservation;
}
export async function cancelRoomReservation(
  db: Database,
  id: string,
  actor: { userId?: string; adminEmail?: string },
  now = new Date(),
) {
  return withDatabaseTransaction(db, async (tx) => {
    const [reservation] = await tx
      .select()
      .from(s.roomReservations)
      .where(eq(s.roomReservations.id, id));
    if (!reservation)
      throw new RoomBookingError("NOT_FOUND", "Reservation not found.", 404);
    await lockRoomDay(tx, reservation.date);
    if (!actor.adminEmail) {
      await approvedRoomTutor(tx, actor.userId ?? "");
      if (reservation.lineUserId !== actor.userId)
        throw new RoomBookingError("NOT_FOUND", "Reservation not found.", 404);
    }
    if (reservation.status !== "confirmed") return reservation;
    if (
      reservation.date < roomDate(now) ||
      (reservation.date === roomDate(now) &&
        reservation.endMinute <= roomMinute(now))
    ) {
      throw new RoomBookingError(
        "ENDED",
        "This reservation has already ended.",
      );
    }
    const result = await endRoomReservation(
      tx,
      reservation,
      "cancelled",
      actor.adminEmail ? "Cancelled by an admin." : "Cancelled by you.",
      actor.adminEmail ?? actor.userId!,
      Boolean(actor.adminEmail),
    );
    return result;
  });
}
export async function reservationRoomBlocks(db: Database, date: string) {
  const rows = await db
    .select({ r: s.roomReservations, name: s.classroomRooms.name })
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
  return rows.map(({ r, name }) => ({
    wiseSessionId: `room-reservation:${r.id}`,
    location: name,
    className: "Tutor room reservation",
    startMinute: r.startMinute,
    endMinute: r.endMinute,
  }));
}
const hashToken = (token: string) =>
  createHash("sha256").update(token).digest("hex");
export async function mintRoomLink(
  db: Database,
  userId: string,
  now = new Date(),
) {
  await approvedRoomTutor(db, userId);
  const token = randomBytes(32).toString("base64url");
  const midnight =
    new Date(`${roomDate(now)}T00:00:00+07:00`).getTime() + 24 * 60 * 60_000;
  await db.insert(s.roomAccessGrants).values({
    tokenHash: hashToken(token),
    lineUserId: userId,
    expiresAt: new Date(Math.min(now.getTime() + 60 * 60_000, midnight)),
  });
  return token;
}
export async function resolveRoomLink(
  db: Database,
  token: string,
  now = new Date(),
) {
  if (!/^[\w-]{43}$/.test(token))
    throw new RoomBookingError(
      "LINK_EXPIRED",
      "This link has expired. Send /room web in LINE for a new link.",
      401,
    );
  const [grant] = await db
    .select()
    .from(s.roomAccessGrants)
    .where(
      and(
        eq(s.roomAccessGrants.tokenHash, hashToken(token)),
        gt(s.roomAccessGrants.expiresAt, now),
      ),
    );
  if (!grant)
    throw new RoomBookingError(
      "LINK_EXPIRED",
      "This link has expired. Send /room web in LINE for a new link.",
      401,
    );
  await approvedRoomTutor(db, grant.lineUserId);
  return grant.lineUserId;
}
