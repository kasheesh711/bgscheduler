import { randomUUID } from "crypto";
import { and, eq, sql } from "drizzle-orm";
import type { Database } from "@/lib/db";
import { withDatabaseTransaction } from "@/lib/db/transaction";
import { roomDayStates } from "@/lib/db/schema";
import { RoomBookingError } from "./model";

export async function lockRoomDay(tx: Database, date: string) {
  await tx.insert(roomDayStates).values({ date }).onConflictDoNothing();
  const [state] = await tx
    .select()
    .from(roomDayStates)
    .where(eq(roomDayStates.date, date))
    .for("update");
  return state;
}
export function assertRoomDayIdle(state: typeof roomDayStates.$inferSelect) {
  if (state.leaseOwner) {
    // Expiry is not permission to steal a Wise writer's lease. Its outcome may
    // be unknown. A subsequent refresh can clear an abandoned lease after 15m.
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
        leaseUntil: new Date(Date.now() + 15 * 60_000),
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
