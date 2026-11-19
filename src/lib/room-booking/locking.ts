import { randomUUID } from "crypto";
import { and, eq, lt, sql } from "drizzle-orm";
import type { Database } from "@/lib/db";
import { withDatabaseTransaction } from "@/lib/db/transaction";
import { roomDayStates, roomTutorLinks } from "@/lib/db/schema";
import { RoomBookingError } from "./model";

const LEASE_MS = 15 * 60_000;

// Tutor mutations always lock identity before dates (in ascending order).
// Collectors and classroom writers only lock dates and never acquire tutor locks.
export async function lockRoomTutor(tx: Database, userId: string) {
  const [link] = await tx
    .select()
    .from(roomTutorLinks)
    .where(eq(roomTutorLinks.lineUserId, userId))
    .for("update");
  return link;
}

export async function lockRoomDay(tx: Database, date: string) {
  await tx.insert(roomDayStates).values({ date }).onConflictDoNothing();
  // Take over an expired lease. LEASE_MS (15m) is longer than any route's
  // maxDuration (800s), so its holder was stopped before its `finally` ran.
  // The row lock and the re-checked WHERE let only one caller clear it.
  // checkedAt resets because the holder's Wise writes have an unknown outcome.
  await tx
    .update(roomDayStates)
    .set({
      leaseOwner: null,
      leaseUntil: null,
      checkedAt: null,
      revision: sql`${roomDayStates.revision} + 1`,
    })
    .where(
      // App clock, like the clock that wrote leaseUntil.
      and(eq(roomDayStates.date, date), lt(roomDayStates.leaseUntil, new Date())),
    );
  const [state] = await tx
    .select()
    .from(roomDayStates)
    .where(eq(roomDayStates.date, date))
    .for("update");
  return state;
}
export function assertRoomDayIdle(state: typeof roomDayStates.$inferSelect) {
  if (state.leaseOwner) {
    // lockRoomDay has already cleared an expired lease, so this lease is live.
    throw new RoomBookingError(
      "ROOMS_UPDATING",
      "Rooms are being updated. Please try again shortly.",
    );
  }
}
/** Persisted exclusion across processes, without holding a transaction during Wise I/O. */
export async function withRoomDayOperation<T>(
  db: Database,
  date: string,
  work: () => Promise<T>,
): Promise<T> {
  const owner = randomUUID();
  await withDatabaseTransaction(db, async (tx) => {
    const state = await lockRoomDay(tx, date);
    assertRoomDayIdle(state);
    await tx
      .update(roomDayStates)
      .set({
        leaseOwner: owner,
        leaseUntil: new Date(Date.now() + LEASE_MS),
        revision: sql`${roomDayStates.revision} + 1`,
      })
      .where(eq(roomDayStates.date, date));
  });
  try {
    return await work();
  } finally {
    await db
      .update(roomDayStates)
      .set({
        leaseOwner: null,
        leaseUntil: null,
        checkedAt: null,
        revision: sql`${roomDayStates.revision} + 1`,
      })
      .where(
        and(eq(roomDayStates.date, date), eq(roomDayStates.leaseOwner, owner)),
      );
  }
}
