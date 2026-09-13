import { eq } from "drizzle-orm";
import { getDb, type Database } from "@/lib/db";
import { ptWorkspaceConfig } from "@/lib/db/schema";
import { WorkspaceError } from "./model";

export async function launchConfig(db: Database = getDb()): Promise<typeof ptWorkspaceConfig.$inferSelect | null> {
  const [row] = await db.select().from(ptWorkspaceConfig).where(eq(ptWorkspaceConfig.id, "launch")).limit(1);
  return row ?? null;
}
export async function assertLegacyActive(db: Database = getDb()) {
  if (await launchConfig(db)) throw new WorkspaceError(410, "This workflow has retired. Open the tutor Progress Tests workspace.");
}
