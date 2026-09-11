import { addBangkokDays, bangkokDateKey, todayBangkok } from "@/lib/room-capacity/dates";
import type { WiseClient } from "./client";
import type { WiseSession, WiseSessionsResponse } from "./types";

/** A complete day is required before callers may infer that a room is free. */
export async function fetchWiseSessionsForBangkokDates(
  client: Pick<WiseClient, "get">,
  instituteId: string,
  dates: string[],
  options: { now?: Date; deadlineAt?: number } = {},
): Promise<WiseSession[]> {
  const today = todayBangkok(options.now);
  const all: WiseSession[] = [];
  const seen = new Set<string>();
  for (const date of [...new Set(dates)].sort()) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(Date.parse(`${date}T00:00:00Z`))
      || new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) !== date) throw new Error("Invalid Wise calendar date");
    const statuses = date === today ? ["PAST", "FUTURE"] : [date < today ? "PAST" : "FUTURE"];
    for (const status of statuses) {
      let pageCount = 1;
      for (let page = 1; page <= pageCount; page++) {
        const remaining = (options.deadlineAt ?? Infinity) - Date.now();
        if (remaining <= 0) throw new DOMException("Wise day read time budget exceeded", "TimeoutError");
        const res = await client.get<WiseSessionsResponse>(`/institutes/${instituteId}/sessions`, {
          status, paginateBy: "DATE", startDate: date, endDate: addBangkokDays(date, 1),
          page_number: String(page), page_size: "100",
        }, { cache: "no-store", signal: AbortSignal.timeout(Math.min(30_000, remaining)) });
        const rows = res.data?.sessions;
        const pages = res.data?.page_count;
        if (!Array.isArray(rows) || !Number.isInteger(pages) || pages! < 0 || pages! > 1000
          || (page > 1 && pages !== pageCount) || (!rows.length && (page > 1 || pages! > 1))
          || (rows.length > 0 && pages === 0) || rows.length > 100
          || (page < pages! && rows.length !== 100)) {
          throw new Error(`Incomplete Wise day pagination for ${date} (${status}, page ${page})`);
        }
        for (const session of rows) {
          if (!session || typeof session._id !== "string" || !session._id.trim() || seen.has(session._id)
            || !Number.isFinite(Date.parse(session.scheduledStartTime))
            || !Number.isFinite(Date.parse(session.scheduledEndTime))
            || Date.parse(session.scheduledEndTime) <= Date.parse(session.scheduledStartTime)
            || bangkokDateKey(new Date(session.scheduledStartTime)) !== date) {
            throw new Error(`Invalid, duplicate or out-of-date Wise session for ${date}`);
          }
          seen.add(session._id);
          all.push(session);
        }
        pageCount = pages!;
      }
    }
  }
  return all;
}
