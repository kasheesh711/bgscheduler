import { eq } from "drizzle-orm";
import type { Database } from "@/lib/db";
import * as schema from "@/lib/db/schema";

export async function getActiveSnapshotIdOrThrow(db: Database): Promise<string> {
  const [activeSnapshot] = await db
    .select({ id: schema.snapshots.id })
    .from(schema.snapshots)
    .where(eq(schema.snapshots.active, true))
    .limit(1);

  if (!activeSnapshot) {
    throw new Error("No active snapshot found");
  }

  return activeSnapshot.id;
}
