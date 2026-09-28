import { createWiseClient } from "@/lib/wise/client";
import { fetchWisePastSessionsByBangkokDate } from "@/lib/wise/fetchers";
import { getWiseSessionClassId, type WiseSession } from "@/lib/wise/types";
import { calculateFeedbackDeadline } from "./policy";
import { nightlyWindow } from "./nightly-reminder-model";
import { runPostClassFeedbackSync } from "./sync";
import type { PostClassSessionCandidate } from "./types";

export interface NightlyInventoryItem {
  wiseSessionId: string;
  wiseClassId: string;
  scheduledEndAt: Date;
  deadlineAt: Date;
  rawSession: Record<string, unknown> | null;
}

export interface NightlyInventory {
  items: NightlyInventoryItem[];
  checkedAt: Date;
  pages: number;
  startDate: string;
  endDate: string;
}

export function parseNightlyInventory(sessions: WiseSession[], date: string): NightlyInventoryItem[] {
  const window = nightlyWindow(date);
  return sessions.flatMap((session) => {
    const classId = getWiseSessionClassId(session);
    const end = new Date(session.scheduledEndTime);
    if (!classId || !session._id || !Number.isFinite(end.getTime()) || typeof session.meetingStatus !== "string") {
      throw new Error("Wise nightly discovery has an invalid class, time or status.");
    }
    // Wise date filters have historically been advisory. Filter locally too.
    if (end < window.start || end > window.cutoff) return [];
    return [{
      wiseSessionId: session._id, wiseClassId: classId, scheduledEndAt: end,
      deadlineAt: calculateFeedbackDeadline(end), rawSession: session as Record<string, unknown>,
    }];
  });
}

export async function discoverNightlyInventory(date: string): Promise<NightlyInventory> {
  const instituteId = process.env.WISE_INSTITUTE_ID?.trim();
  if (!instituteId) throw new Error("WISE_INSTITUTE_ID is not configured");
  const window = nightlyWindow(date);
  let pages = 0;
  const sessions = await fetchWisePastSessionsByBangkokDate(
    createWiseClient(), instituteId, window.startDate, window.endDate, 50,
    { strict: true, onPage: (page) => { pages = page; } },
  );
  return { items: parseNightlyInventory(sessions, date), pages, checkedAt: new Date(),
    startDate: window.startDate, endDate: window.endDate };
}

export async function refreshNightlyItems(items: NightlyInventoryItem[], now: Date): Promise<void> {
  const candidates: PostClassSessionCandidate[] = items.map((item) => ({
    sessionId: item.wiseSessionId, classId: item.wiseClassId,
    reason: "rolling_window", scheduledEndAt: item.scheduledEndAt,
    rawSession: item.rawSession, forceDetailRefresh: true,
  }));
  if (candidates.length) await runPostClassFeedbackSync({ reminderTargets: candidates, now, detailCap: 50 });
}
