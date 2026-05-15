const BANGKOK_TIME_ZONE = "Asia/Bangkok";

function partsForBangkokDate(date: Date): { year: number; month: number; day: number } {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: BANGKOK_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const byType = new Map(parts.map((part) => [part.type, part.value]));
  return {
    year: Number(byType.get("year")),
    month: Number(byType.get("month")),
    day: Number(byType.get("day")),
  };
}

function toIsoDate(year: number, month: number, day: number): string {
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

export function bangkokDateKey(date: Date): string {
  const parts = partsForBangkokDate(date);
  return toIsoDate(parts.year, parts.month, parts.day);
}

export function todayBangkok(now = new Date()): string {
  return bangkokDateKey(now);
}

export function bangkokWeekday(date: string | Date): number {
  const instant = typeof date === "string" ? bangkokDateStartUtc(date) : date;
  const weekday = new Intl.DateTimeFormat("en-US", {
    timeZone: BANGKOK_TIME_ZONE,
    weekday: "short",
  }).format(instant);
  return ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(weekday);
}

export function weekdayName(weekday: number): string {
  return ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"][weekday] ?? "Unknown";
}

export function bangkokDateStartUtc(date: string): Date {
  const [year, month, day] = date.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day, -7, 0, 0, 0));
}

export function addBangkokDays(date: string, days: number): string {
  const start = bangkokDateStartUtc(date);
  start.setUTCDate(start.getUTCDate() + days);
  return bangkokDateKey(start);
}

export function datesBetweenBangkok(startDate: string, endDate: string): string[] {
  const dates: string[] = [];
  for (let cursor = startDate; cursor <= endDate; cursor = addBangkokDays(cursor, 1)) {
    dates.push(cursor);
  }
  return dates;
}

export function endOfBangkokMonth(date: string): string {
  const [year, month] = date.split("-").map(Number);
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return toIsoDate(year, month, lastDay);
}

export function defaultRoomCapacityRange(now = new Date()): { startDate: string; endDate: string } {
  const startDate = todayBangkok(now);
  return {
    startDate,
    endDate: endOfBangkokMonth(startDate),
  };
}

export function monthStart(date: string): string {
  return `${date.slice(0, 7)}-01`;
}

export function nextMonthStart(date: string): string {
  const [year, month] = date.split("-").map(Number);
  return toIsoDate(month === 12 ? year + 1 : year, month === 12 ? 1 : month + 1, 1);
}

export function minuteToTimeLabel(minute: number): string {
  const hours = Math.floor(minute / 60);
  const minutes = minute % 60;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
}
