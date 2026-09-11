import { and, eq, gte } from "drizzle-orm";
import type { Database } from "@/lib/db";
import * as s from "@/lib/db/schema";
import { withDatabaseTransaction } from "@/lib/db/transaction";
import { lockRoomDay, lockRoomTutor } from "./locking";
import { endRoomReservation } from "./service";
import { roomDate, roomReservationUpcoming, RoomBookingError } from "./model";

export async function listRoomTutorLinks(db: Database) {
  const links = await db
    .select()
    .from(s.roomTutorLinks)
    .orderBy(s.roomTutorLinks.createdAt);
  const tutors = await db
    .select({
      canonicalKey: s.tutorIdentityGroups.canonicalKey,
      displayName: s.tutorIdentityGroups.displayName,
    })
    .from(s.tutorIdentityGroups)
    .innerJoin(
      s.snapshots,
      eq(s.snapshots.id, s.tutorIdentityGroups.snapshotId),
    )
    .where(eq(s.snapshots.active, true));
  return { links, tutors };
}
export async function reviewRoomTutorLink(
  db: Database,
  input: {
    lineUserId: string;
    status: "approved" | "rejected" | "revoked";
    canonicalKey?: string;
  },
  actorEmail: string,
) {
  return withDatabaseTransaction(db, async (tx) => {
    const link = await lockRoomTutor(tx, input.lineUserId);
    if (!link)
      throw new RoomBookingError(
        "NOT_FOUND",
        "Tutor access request not found.",
        404,
      );
    let displayName = link.displayName;
    if (input.status === "approved") {
      const matches = await tx
        .select({ name: s.tutorIdentityGroups.displayName })
        .from(s.tutorIdentityGroups)
        .innerJoin(
          s.snapshots,
          eq(s.snapshots.id, s.tutorIdentityGroups.snapshotId),
        )
        .where(
          and(
            eq(s.snapshots.active, true),
            eq(s.tutorIdentityGroups.canonicalKey, input.canonicalKey ?? ""),
          ),
        );
      if (matches.length !== 1)
        throw new RoomBookingError(
          "TUTOR_REVIEW",
          "Choose one unambiguous active tutor.",
          400,
        );
      displayName = matches[0].name;
      const [duplicate] = await tx
        .select()
        .from(s.roomTutorLinks)
        .where(
          and(
            eq(s.roomTutorLinks.status, "approved"),
            eq(s.roomTutorLinks.canonicalKey, input.canonicalKey!),
          ),
        );
      if (duplicate && duplicate.lineUserId !== input.lineUserId)
        throw new RoomBookingError(
          "ALREADY_LINKED",
          "Revoke the tutor’s existing LINE link first.",
        );
    }
    if (
      input.status !== "approved" ||
      link.canonicalKey !== input.canonicalKey
    ) {
      const reservations = await tx
        .select()
        .from(s.roomReservations)
        .where(
          and(
            eq(s.roomReservations.lineUserId, input.lineUserId),
            gte(s.roomReservations.date, roomDate()),
            eq(s.roomReservations.status, "confirmed"),
          ),
        );
      for (const date of [...new Set(reservations.map((r) => r.date))].sort())
        await lockRoomDay(tx, date);
      for (const r of reservations)
        if (roomReservationUpcoming(r.date, r.endMinute))
          await endRoomReservation(
            tx,
            r,
            "cancelled",
            "Tutor access was changed by an admin.",
            actorEmail,
            true,
          );
      await tx
        .delete(s.roomAccessGrants)
        .where(eq(s.roomAccessGrants.lineUserId, input.lineUserId));
      await tx
        .delete(s.roomActions)
        .where(eq(s.roomActions.lineUserId, input.lineUserId));
    }
    const [updated] = await tx
      .update(s.roomTutorLinks)
      .set({
        status: input.status,
        canonicalKey:
          input.status === "approved" ? input.canonicalKey : link.canonicalKey,
        displayName,
        reviewedBy: actorEmail,
        updatedAt: new Date(),
      })
      .where(eq(s.roomTutorLinks.lineUserId, input.lineUserId))
      .returning();
    return updated;
  });
}
