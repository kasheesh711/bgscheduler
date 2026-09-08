import { and, eq, inArray } from "drizzle-orm";
import type { Database } from "@/lib/db";
import * as s from "@/lib/db/schema";
import { batchUpdateGoogleSheetValues, fetchGoogleSheetRows, quoteGoogleSheetName } from "@/lib/sales-dashboard/sheets";
import { LEAVE_REQUESTS_SHEET_NAME, LEAVE_REQUESTS_SPREADSHEET_ID } from "./config";
import { humanStatus, normalizationInput, normalizationKey } from "./normalization";
import { parseLeaveRequestSheetRows } from "./parser";
import { familyComplete } from "./work-model";

/** Independent outbox. Failed writes never roll back an admin's checklist. */
export async function flushLeaveWritebacks(db: Database, email: string) {
  const pending = await db.select().from(s.leaveRequests).where(inArray(s.leaveRequests.sheetWriteStatus, ["pending", "failed"]));
  if (!pending.length) return 0;
  try {
    // Re-read before writing: preserve fresh human notes and detect sorted/deleted rows.
    const liveRows = parseLeaveRequestSheetRows(await fetchGoogleSheetRows(email, LEAVE_REQUESTS_SPREADSHEET_ID, LEAVE_REQUESTS_SHEET_NAME));
    const liveByRow = new Map(liveRows.map((r) => [r.sourceRowNumber, r]));
    const [classes, families] = await Promise.all([db.select().from(s.leaveClassTasks), db.select().from(s.leaveFamilyTasks)]);
    const writes: Array<{ id: string; key: string; text: string; range: string; updatedAt: Date }> = [];
    for (const request of pending) {
      if (request.normalizationStatus !== "ok" || !request.tutorCanonicalKey) continue;
      const live = liveByRow.get(request.sourceRowNumber);
      if (!live || normalizationKey(normalizationInput(live)) !== request.currentNormalizationKey) continue;
      const tasks = classes.filter((c) => c.active && c.sourceRequestIds.includes(request.id));
      const sessionIds = new Set(tasks.map((c) => c.wiseSessionId));
      const assignmentIds = new Set(tasks.map((c) => c.assignmentId));
      const familyTasks = families.filter((f) => f.active && assignmentIds.has(f.assignmentId) && f.coverage.some((c) => sessionIds.has(c.sessionId)));
      const byDate = new Map<string, typeof tasks>();
      for (const task of tasks) {
        const date = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Bangkok", year: "numeric", month: "2-digit", day: "2-digit" }).format(task.startTime);
        byDate.set(date, [...(byDate.get(date) ?? []), task]);
      }
      const days = [...byDate].sort(([a], [b]) => a.localeCompare(b)).map(([date, dayTasks]) => {
        const ids = new Set(dayTasks.map((c) => c.wiseSessionId));
        const fs = familyTasks.filter((f) => f.coverage.some((c) => ids.has(c.sessionId)));
        return `${date}: families ${fs.filter(familyComplete).length}/${fs.length}, Wise ${dayTasks.filter((c) => c.cancelled).length}/${dayTasks.length}`;
      });
      const text = [humanStatus(live.sourceSheetStatus), `[BGScheduler: ${days.join("; ") || "No current affected classes."}]`].filter(Boolean).join("\n");
      writes.push({ id: request.id, key: request.currentNormalizationKey!, text, range: `${quoteGoogleSheetName(request.sheetName)}!S${request.sourceRowNumber}`, updatedAt: request.updatedAt });
    }
    for (let offset = 0; offset < writes.length; offset += 50) {
      const batch = writes.slice(offset, offset + 50);
      await batchUpdateGoogleSheetValues(email, LEAVE_REQUESTS_SPREADSHEET_ID, batch.map((w) => ({ range: w.range, values: [[w.text]] })), "RAW");
      for (const write of batch) await db.update(s.leaveRequests).set({ sheetWriteStatus: "success", sheetWrittenAt: new Date(), sheetWriteError: null }).where(and(eq(s.leaveRequests.id, write.id), eq(s.leaveRequests.currentNormalizationKey, write.key), eq(s.leaveRequests.updatedAt, write.updatedAt)));
    }
    return writes.length;
  } catch (error) {
    await db.update(s.leaveRequests).set({ sheetWriteStatus: "failed", sheetWriteError: error instanceof Error ? error.message.slice(0, 1000) : "Sheet writeback failed." }).where(inArray(s.leaveRequests.id, pending.map((p) => p.id)));
    return 0;
  }
}
