import "server-only";
import { sql } from "drizzle-orm";
import { getDb, type Database } from "@/lib/db";
import { postClassSettings } from "@/lib/db/schema";
import { PostClassValidationError } from "./errors";

/** Lock settings before connection rows, matching the activation transaction. */
export async function assertFeedbackConnectionPaused(db: Database = getDb(), lock = false) {
  if (lock) await db.execute(sql`select id from post_class_settings where id = 'default' for update`);
  const [settings] = await db.select({ mode: postClassSettings.reminderMode }).from(postClassSettings).limit(1);
  if (settings?.mode === "live") {
    throw new PostClassValidationError("Pause reminders before reconnecting or retesting delivery connections, then verify them and activate at the next 22:00 checkpoint.");
  }
}
