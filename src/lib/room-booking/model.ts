import { formatInTimeZone } from "date-fns-tz";
import { TIMEZONE } from "@/lib/normalization/timezone";
import { addBangkokDays } from "@/lib/room-capacity/dates";

export const ROOM_TIMEZONE = TIMEZONE;
export const ROOM_OPEN = 7 * 60;
export const ROOM_CLOSE = 21 * 60;
export const ROOM_FRESH_MS = 5 * 60_000;
export const roomWritesEnabled = () =>
  process.env.ROOM_BOOKING_WRITES_ENABLED === "true";
export const roomDate = (now = new Date()) =>
  formatInTimeZone(now, ROOM_TIMEZONE, "yyyy-MM-dd");
export const roomBookingDates = (now = new Date()) => [
  roomDate(now),
  addBangkokDays(roomDate(now), 1),
];
export function validateRoomDate(date: string, now = new Date()) {
  if (!roomBookingDates(now).includes(date))
    throw new RoomBookingError(
      "INVALID_DATE",
      "Choose today or tomorrow in Bangkok.",
      400,
    );
}
export function roomReservationUpcoming(
  date: string,
  endMinute: number,
  now = new Date(),
) {
  return (
    date > roomDate(now) ||
    (date === roomDate(now) && endMinute > roomMinute(now))
  );
}
export const roomMinute = (now = new Date()) =>
  Number(formatInTimeZone(now, ROOM_TIMEZONE, "H")) * 60 +
  Number(formatInTimeZone(now, ROOM_TIMEZONE, "m"));
export const formatRoomMinute = (minute: number) =>
  `${String(Math.floor(minute / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}`;
export const overlaps = (a: Interval, b: Interval) =>
  a.startMinute < b.endMinute && b.startMinute < a.endMinute;
export interface Interval {
  startMinute: number;
  endMinute: number;
}
export interface RoomEvidenceBlock extends Interval {
  sessionId: string;
  classId: string | null;
  room: string | null;
  roomSource?: "wise" | "classroom_plan";
  canonicalKey: string | null;
  remote: boolean;
  blocking: boolean;
  status: string;
}
export interface RoomEvidence {
  blocks: RoomEvidenceBlock[];
  uncertain: Interval[];
}
export interface RoomBotEvent {
  eventId: string;
  userId: string;
  scope: string;
  replyToken: string | null;
  text: string;
  params?: { time?: string };
  receivedAt: string;
}
export class RoomBookingError extends Error {
  constructor(
    public code: string,
    message: string,
    public status = 409,
  ) {
    super(message);
  }
}
export function parseRoomTime(value: string): number {
  if (!/^\d{2}:\d{2}$/.test(value))
    throw new RoomBookingError("INVALID_TIME", "Use times such as 14:00.", 400);
  const [h, m] = value.split(":").map(Number);
  if (h > 23 || m > 59)
    throw new RoomBookingError("INVALID_TIME", "Enter a valid time.", 400);
  return h * 60 + m;
}
export function validateRoomInterval(
  date: string,
  interval: Interval,
  now = new Date(),
  immediate = false,
) {
  validateRoomDate(date, now);
  if (immediate && date !== roomDate(now))
    throw new RoomBookingError(
      "INVALID_IMMEDIATE",
      "Start now is available for today only.",
      400,
    );
  const { startMinute: start, endMinute: end } = interval;
  if (
    ![start, end].every(Number.isInteger) ||
    start < ROOM_OPEN ||
    end > ROOM_CLOSE ||
    end - start < 15 ||
    (!immediate && start % 15 !== 0) ||
    end % 15 !== 0
  ) {
    throw new RoomBookingError(
      "INVALID_INTERVAL",
      "Choose at least 15 minutes, in 15-minute steps, between 07:00 and 21:00.",
      400,
    );
  }
  if (date === roomDate(now) && start < roomMinute(now))
    throw new RoomBookingError(
      "PAST_TIME",
      "That start time has passed. Choose a new time.",
    );
}
export function freeIntervals(
  blocks: Interval[],
  from = ROOM_OPEN,
  to = ROOM_CLOSE,
): Interval[] {
  const sorted = blocks
    .filter((b) => b.endMinute > from && b.startMinute < to)
    .sort((a, b) => a.startMinute - b.startMinute);
  const free: Interval[] = [];
  let cursor = from;
  for (const block of sorted) {
    if (block.startMinute > cursor)
      free.push({
        startMinute: cursor,
        endMinute: Math.min(block.startMinute, to),
      });
    cursor = Math.max(cursor, block.endMinute);
  }
  if (cursor < to) free.push({ startMinute: cursor, endMinute: to });
  return free;
}
