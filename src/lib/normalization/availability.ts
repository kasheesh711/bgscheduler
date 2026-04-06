import { WiseWorkingHourSlot } from "@/lib/wise/types";
import { parseTimeToMinutes } from "./timezone";

export interface RecurringWindow {
  weekday: number; // 0=Sunday..6=Saturday
  startMinute: number; // minutes since midnight, Asia/Bangkok
  endMinute: number;
}

/**
 * Normalize Wise workingHours slots into recurring availability windows.
 * Wise slots use day (0=Sun..6=Sat) and HH:mm format times.
 * Since workingHours are already in local time (Asia/Bangkok), no UTC conversion needed.
 */
export function normalizeWorkingHours(
  slots: WiseWorkingHourSlot[] | undefined
): RecurringWindow[] {
  if (!slots || slots.length === 0) return [];

  const windows: RecurringWindow[] = [];

  for (const slot of slots) {
    const startMinute = parseTimeToMinutes(slot.startTime);
    const endMinute = parseTimeToMinutes(slot.endTime);

    if (startMinute >= endMinute) continue; // Skip invalid/zero-length windows

    windows.push({
      weekday: slot.day,
      startMinute,
      endMinute,
    });
  }

  return deduplicateWindows(windows);
}

/**
 * De-duplicate and merge overlapping windows on the same weekday.
 */
export function deduplicateWindows(windows: RecurringWindow[]): RecurringWindow[] {
  // Group by weekday
  const byWeekday = new Map<number, RecurringWindow[]>();
  for (const w of windows) {
    if (!byWeekday.has(w.weekday)) {
      byWeekday.set(w.weekday, []);
    }
    byWeekday.get(w.weekday)!.push(w);
  }

  const result: RecurringWindow[] = [];

  for (const [weekday, dayWindows] of byWeekday) {
    // Sort by start time
    dayWindows.sort((a, b) => a.startMinute - b.startMinute);

    // Merge overlapping
    let current = { ...dayWindows[0] };
    for (let i = 1; i < dayWindows.length; i++) {
      if (dayWindows[i].startMinute <= current.endMinute) {
        current.endMinute = Math.max(current.endMinute, dayWindows[i].endMinute);
      } else {
        result.push(current);
        current = { ...dayWindows[i] };
      }
    }
    result.push({ weekday, startMinute: current.startMinute, endMinute: current.endMinute });
  }

  return result;
}
