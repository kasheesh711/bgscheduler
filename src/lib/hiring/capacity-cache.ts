import { cacheLife, cacheTag } from "next/cache";
import type { HiringConfig } from "./model";
import { hiringCapacity } from "./demand";

/**
 * The Capacity report, kept in the server's memory. The input is the saved subject order (plain data); auth and the
 * settings read stay in the route, outside the cache.
 *
 * Staleness: the "snapshot" tag clears it after each Wise sync (every 30 min). New students come from
 * post_class_sessions, which is collected every 30 min and does not clear the tag, so that part can be up to 30 min
 * behind (5 min fresh, then served once more while it refreshes). A failed demand read is also kept for up to 5 min.
 * On Vercel each instance has its own memory, so a cold instance still builds the report once.
 */
export async function cachedHiringCapacity(priority: HiringConfig["subjectPriority"]) {
  "use cache";
  cacheTag("snapshot");
  cacheLife({ stale: 300, revalidate: 300, expire: 1800 });
  return hiringCapacity(priority);
}
