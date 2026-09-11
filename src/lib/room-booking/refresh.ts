import { randomUUID } from "crypto";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
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
  roomBookingDates,
  roomReservationUpcoming,
  overlaps,
  type RoomEvidence,
  type RoomEvidenceBlock,
  RoomBookingError,
} from "./model";

export function confirmsRoomSessionDeletion(
  error: unknown,
  hasDeletionEvent: boolean,
) {
  if (!hasDeletionEvent || !(error instanceof Error)) return false;
  const match = /^Wise API (?:400|404): (.+) \(https?:\/\/[^)]+\)$/.exec(
    error.message,
  );
  if (!match) return false;
  try {
    const payload = JSON.parse(match[1]);
    return (
      typeof payload.message === "string" &&
      /^Session not found!?$/i.test(payload.message.trim())
    );
  } catch {
    return false;
  }
}

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
    assignedRoom?: string;
    canonicalKey?: string | null;
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
    const wiseRoom = matching.length === 1 ? matching[0] : null;
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
    const sessionPlans = plans.filter((p) => p.wiseSessionId === session._id);
    const plan = sessionPlans.find(
      (p) =>
        p.wiseSessionId === session._id &&
        p.startMinute === startMinute &&
        p.endMinute === endMinute,
    );
    const plannedRoom =
      plan?.assignedRoom &&
      plan.status === "assigned" &&
      key &&
      plan.canonicalKey === key &&
      isOnlineSessionType(session.type) &&
      !session.location?.trim()
        ? (rooms.find(
            (name) => physicalRoom(name) === physicalRoom(plan.assignedRoom!),
          ) ?? null)
        : null;
    const room = wiseRoom ?? plannedRoom;
    const remote =
      !room &&
      !session.location?.trim() &&
      Boolean(key) &&
      isOnlineSessionType(session.type) &&
      (!sessionPlans.length ||
        (plan?.status === "remote" &&
          (!plan.canonicalKey || plan.canonicalKey === key))) &&
      [...chain].every((c) => isOnlineSessionType(c.session.type));
    const blocking = isBlockingStatus(session.meetingStatus);
    const block = {
      sessionId: session._id,
      classId: getWiseSessionClassId(session) ?? null,
      room,
      ...(room
        ? {
            roomSource: wiseRoom
              ? ("wise" as const)
              : ("classroom_plan" as const),
          }
        : {}),
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
      if (
        !roomReservationUpcoming(
          reservation.date,
          reservation.endMinute,
          checkedAt,
        )
      )
        continue;
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
          `A scheduled class now needs ${room} during your reservation.`,
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
  const dates = roomBookingDates(now);
  const owner = randomUUID();
  const startedAt = new Date();
  const deadlineAt = Date.now() + 210_000;
  // Claim both days before reading Wise, including across the midnight rollover.
  await withDatabaseTransaction(db, async (tx) => {
    for (const date of dates) {
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
    }
  });
  const results: Array<{
    date: string;
    ok: boolean;
    sessions?: number;
    uncertain?: number;
    error?: string;
  }> = [];
  try {
    const days = [];
    for (const date of dates) {
      try {
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
        if (!day.rooms.length)
          throw new Error("The active room catalog is empty");
        days.push(day);
      } catch (error) {
        results.push({
          date,
          ok: false,
          error: error instanceof Error ? error.message : "Room refresh failed",
        });
      }
    }
    if (days.length) {
      const institute =
        process.env.WISE_INSTITUTE_ID ?? "696e1f4d90102225641cc413";
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
        // One strict read shared by both days. Keep the age of the oldest read.
        const future = await fetchAllFutureSessions(client, institute, {
          strict: true,
          deadlineAt,
        });
        let past: WiseSession[] = [];
        let pastError: unknown;
        try {
          past = await pastToday(client, institute, dates[0], deadlineAt);
        } catch (error) {
          pastError = error;
        }
        const shared = new Map(future.map((session) => [session._id, session]));
        for (const day of days) {
          try {
            if (day.date === dates[0] && pastError) throw pastError;
            const sessions = new Map(
              day.date === dates[0]
                ? past.map((session) => [session._id, session])
                : [],
            );
            for (const [id, session] of shared) sessions.set(id, session);
            const expected = new Map([
              ...day.evidence.blocks.map(
                (block) => [block.sessionId, block.classId] as const,
              ),
              ...day.rows.map(
                (row) => [row.wiseSessionId, row.wiseClassId] as const,
              ),
            ]);
            const missingIds = [...expected.keys()].filter(
              (id) => !sessions.has(id),
            );
            const deletedIds = new Set(
              missingIds.length
                ? (
                    await db
                      .select({ id: s.wiseActivityEvents.sessionId })
                      .from(s.wiseActivityEvents)
                      .where(
                        and(
                          eq(
                            s.wiseActivityEvents.eventName,
                            "SessionDeletedEvent",
                          ),
                          inArray(s.wiseActivityEvents.sessionId, missingIds),
                        ),
                      )
                  ).map((row) => row.id)
                : [],
            );
            for (const [id, classId] of expected) {
              if (sessions.has(id)) continue;
              if (!classId)
                throw new Error(
                  "Cannot verify a missing Wise session without its class ID",
                );
              let detail;
              try {
                detail = await fetchWiseSessionDetail(client, classId, id, {
                  deadlineAt,
                });
              } catch (error) {
                if (confirmsRoomSessionDeletion(error, deletedIds.has(id)))
                  continue;
                throw error;
              }
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
              day.date,
              day.rooms.map((room) => room.name),
              identities,
              day.rows,
            );
            await commitRoomEvidence(
              db,
              day.date,
              day.state!.revision,
              evidence,
              startedAt,
            );
            results.push({
              date: day.date,
              ok: true,
              sessions: evidence.blocks.length,
              uncertain: evidence.uncertain.length,
            });
          } catch (error) {
            results.push({
              date: day.date,
              ok: false,
              error:
                error instanceof Error ? error.message : "Room refresh failed",
            });
          }
        }
      } catch (error) {
        for (const day of days)
          if (!results.some((result) => result.date === day.date))
            results.push({
              date: day.date,
              ok: false,
              error:
                error instanceof Error ? error.message : "Room refresh failed",
            });
      }
    }
    for (const result of results)
      if (!result.ok)
        await db
          .update(s.roomDayStates)
          .set({ lastError: result.error })
          .where(
            and(
              eq(s.roomDayStates.date, result.date),
              eq(s.roomDayStates.refreshOwner, owner),
            ),
          );
    const ok = results.every((result) => result.ok);
    return {
      ok,
      dates: results.sort((a, b) => a.date.localeCompare(b.date)),
      ...(!ok
        ? {
            errorSummary:
              "Room availability refresh incomplete; previous evidence retained for failed dates.",
          }
        : {}),
    };
  } finally {
    await db
      .update(s.roomDayStates)
      .set({ refreshOwner: null, refreshUntil: null })
      .where(eq(s.roomDayStates.refreshOwner, owner));
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
export async function runRoomRefresh(
  db: Database,
  now = new Date(),
  client?: WiseClient,
) {
  if (process.env.ROOM_BOOKING_COLLECTOR_ENABLED !== "true") {
    await deliverRoomNotifications(db);
    return { ok: true, skipped: true };
  }
  try {
    return await refreshRoomOccupancy(db, now, client);
  } finally {
    await deliverRoomNotifications(db);
  }
}
