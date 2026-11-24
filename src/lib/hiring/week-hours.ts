import { z } from "zod";

/**
 * The candidate's onsite teaching hours on the booking page: Monday to Sunday, 08:00–21:00, one-hour cells
 * (Kevin, 24 Nov 2026). A cell is named by its start hour, so 20 is 20:00–21:00.
 *
 * The answer is stored as text in `preScreen.availability`, in the Google Form's place, so the sheet import, the AI text
 * and every display keep one string format. The text keeps the words that the old option reader matched ("Weekdays",
 * "Weekend", a time after 15:00 in the weekday part), so a Mac worker that still runs the older code reads it correctly.
 */
export const WEEK_DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"] as const;
export const FIRST_HOUR = 8;
export const LAST_HOUR = 20;
export const GRID_HOURS = Array.from({ length: LAST_HOUR - FIRST_HOUR + 1 }, (_, i) => FIRST_HOUR + i);
/** Start hours per day, Monday first. */
export type WeekHours = number[][];

export const emptyWeek = (): WeekHours => WEEK_DAYS.map(() => []);

export const weekHoursSchema = z
  .array(z.array(z.number().int().min(FIRST_HOUR).max(LAST_HOUR)).max(GRID_HOURS.length))
  .length(WEEK_DAYS.length)
  .transform((days) => days.map((hours) => [...new Set(hours)].sort((a, b) => a - b)))
  .refine((days) => days.some((hours) => hours.length), "Choose at least one time that you can teach.");

const hh = (hour: number) => `${String(hour).padStart(2, "0")}:00`;

/** Runs of whole hours as "15:00-21:00", joined by " & ". */
export function hourRanges(hours: number[]) {
  const out: string[] = [];
  for (let i = 0; i < hours.length; ) {
    let j = i;
    while (j + 1 < hours.length && hours[j + 1] === hours[j] + 1) j++;
    out.push(`${hh(hours[i])}-${hh(hours[j] + 1)}`);
    i = j + 1;
  }
  return out.join(" & ");
}

/** "Weekdays: Mon 15:00-21:00; Wed 08:00-12:00 & 17:00-21:00, Weekend: Sat 09:00-17:00". Commas only between the two parts. */
export function weekHoursText(week: WeekHours): string {
  const part = (label: string, from: number, to: number) => {
    const days = WEEK_DAYS.slice(from, to)
      .map((day, i) => (week[from + i].length ? `${day} ${hourRanges(week[from + i])}` : ""))
      .filter(Boolean);
    return days.length ? `${label}: ${days.join("; ")}` : "";
  };
  return [part("Weekdays", 0, 5), part("Weekend", 5, 7)].filter(Boolean).join(", ");
}

/** The grid back from `weekHoursText`. Null for any other text, such as a Google Form answer. */
export function parseWeekHours(text: string): WeekHours | null {
  if (!/^(Weekdays|Weekend): /.test(text.trim())) return null;
  const week = emptyWeek();
  for (const part of text.split(",")) {
    const match = part.trim().match(/^(Weekdays|Weekend): (.+)$/);
    if (!match) return null;
    for (const entry of match[2].split(";")) {
      const day = entry.trim().match(/^(Mon|Tue|Wed|Thu|Fri|Sat|Sun) (.+)$/);
      if (!day) return null;
      const index = WEEK_DAYS.indexOf(day[1] as (typeof WEEK_DAYS)[number]);
      if ((index < 5) !== (match[1] === "Weekdays")) return null;
      for (const range of day[2].split("&")) {
        const r = range.trim().match(/^(\d{2}):00-(\d{2}):00$/);
        if (!r) return null;
        const [start, end] = [Number(r[1]), Number(r[2])];
        if (start < FIRST_HOUR || end > LAST_HOUR + 1 || end <= start) return null;
        for (let h = start; h < end; h++) week[index].push(h);
      }
    }
  }
  return week;
}

/** Whole hours chosen in the week. */
export const weekHoursCount = (week: WeekHours) => week.reduce((n, hours) => n + hours.length, 0);
