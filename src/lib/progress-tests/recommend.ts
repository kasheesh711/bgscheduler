// Progress Tests — schedule-aware test-slot recommendations (pure).
//
// Given a student's upcoming classes + future room occupancy + the room catalog,
// proposes test slots over the next few class-days: right after the day's last
// class, plus any >=1h gap between same-day classes. Every proposed slot is
// room-verified (a physical room must be free) — critical on weekends when rooms
// are full. No DB/Next imports: callers pass pre-fetched data (see db.ts
// loadRecommendationData) so this stays unit-testable.

import { BANGKOK_TIME_ZONE } from "@/lib/bangkok-time";
import { PROGRESS_TEST_DEFAULT_DURATION_MINUTES } from "./config";
import type { RecommendedTestSlot } from "./types";

/** Number of upcoming class-days to draw recommendations from. */
export const RECOMMEND_CLASS_DAYS = 3;
/** Lookahead window (days) for loading the student's classes + room occupancy. */
export const RECOMMEND_WINDOW_DAYS = 14;
/** Minimum break (minutes) between two same-day classes to fit a test in the gap. */
export const RECOMMEND_MIN_GAP_MINUTES = 60;
/** Cap on the number of recommended slots returned. */
export const RECOMMEND_MAX_SLOTS = 6;

const TEST_MINUTES = PROGRESS_TEST_DEFAULT_DURATION_MINUTES;
const MS_PER_MIN = 60_000;

/** A future class interval for a student (real instants). */
export interface FutureClassInterval {
  start: Date;
  end: Date;
}

/** A future room occupancy block (room label as stored on the Wise session). */
export interface FutureRoomBlock {
  room: string;
  start: Date;
  end: Date;
}

/** Inputs for the per-student slot builder. */
export interface BuildRecommendedSlotsInput {
  classes: FutureClassInterval[];
  roomBlocks: FutureRoomBlock[];
  /** Usable physical room names (active, not online-only). */
  rooms: string[];
  now: Date;
}

/** Normalizes a room label for occupancy matching (lowercase, drop trailing "(TV)"). */
function normalizeRoom(name: string): string {
  return name.trim().toLowerCase().replace(/\s*\(tv\)\s*$/i, "");
}

/** Half-open interval overlap test. */
function overlaps(aStart: Date, aEnd: Date, bStart: Date, bEnd: Date): boolean {
  return aStart.getTime() < bEnd.getTime() && bStart.getTime() < aEnd.getTime();
}

/** Asia/Bangkok calendar day key (YYYY-MM-DD) for grouping classes by day. */
function bangkokDayKey(date: Date): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: BANGKOK_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const pick = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
  return `${pick("year")}-${pick("month")}-${pick("day")}`;
}

/** Human label like "Sat 14 Jun, 16:00–17:00 · Tesla" (Asia/Bangkok). */
function slotLabel(start: Date, end: Date, room: string): string {
  const day = new Intl.DateTimeFormat("en-GB", {
    timeZone: BANGKOK_TIME_ZONE,
    weekday: "short",
    day: "numeric",
    month: "short",
  }).format(start);
  const time = (date: Date) =>
    new Intl.DateTimeFormat("en-GB", {
      timeZone: BANGKOK_TIME_ZONE,
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).format(date);
  return `${day}, ${time(start)}–${time(end)} · ${room}`;
}

/** Finds the first usable room with no occupancy overlapping [start,end]. */
function findFreeRoom(
  start: Date,
  end: Date,
  rooms: { name: string; key: string }[],
  occupancyByRoom: Map<string, FutureRoomBlock[]>,
): string | null {
  for (const room of rooms) {
    const blocks = occupancyByRoom.get(room.key) ?? [];
    const busy = blocks.some((block) => overlaps(start, end, block.start, block.end));
    if (!busy) return room.name;
  }
  return null;
}

/**
 * Builds room-verified recommended test slots for one student.
 *
 * 1. Keep upcoming classes (start in the future), grouped by Asia/Bangkok day;
 *    take the next RECOMMEND_CLASS_DAYS days that have classes.
 * 2. Per day, propose: a slot in any >=60m gap between consecutive classes
 *    (starting right after the earlier class, fitting before the next), and a
 *    slot right after the day's last class. Each test is TEST_MINUTES long.
 * 3. Sort soonest-first; emit only slots that have a free physical room (skip the
 *    rest — important on weekends), capped at RECOMMEND_MAX_SLOTS.
 *
 * @returns the recommended slots (ISO start/end, room, kind, label); [] when the
 *   student has no upcoming classes or no slot has a free room.
 */
export function buildRecommendedSlots(input: BuildRecommendedSlotsInput): RecommendedTestSlot[] {
  const upcoming = input.classes
    .filter((cls) => cls.end && cls.start.getTime() > input.now.getTime())
    .sort((a, b) => a.start.getTime() - b.start.getTime());
  if (upcoming.length === 0) return [];

  const byDay = new Map<string, FutureClassInterval[]>();
  for (const cls of upcoming) {
    const day = bangkokDayKey(cls.start);
    const list = byDay.get(day);
    if (list) list.push(cls);
    else byDay.set(day, [cls]);
  }
  const days = [...byDay.keys()].sort().slice(0, RECOMMEND_CLASS_DAYS);

  const occupancyByRoom = new Map<string, FutureRoomBlock[]>();
  for (const block of input.roomBlocks) {
    const key = normalizeRoom(block.room);
    const list = occupancyByRoom.get(key);
    if (list) list.push(block);
    else occupancyByRoom.set(key, [block]);
  }
  const rooms = input.rooms.map((name) => ({ name, key: normalizeRoom(name) }));

  const candidates: { start: Date; end: Date; kind: "after_class" | "gap" }[] = [];
  for (const day of days) {
    const classes = (byDay.get(day) ?? []).slice().sort((a, b) => a.start.getTime() - b.start.getTime());
    if (classes.length === 0) continue;
    for (let i = 0; i < classes.length - 1; i += 1) {
      const gapMs = classes[i + 1].start.getTime() - classes[i].end.getTime();
      if (gapMs >= RECOMMEND_MIN_GAP_MINUTES * MS_PER_MIN) {
        const start = classes[i].end;
        const end = new Date(start.getTime() + TEST_MINUTES * MS_PER_MIN);
        if (end.getTime() <= classes[i + 1].start.getTime()) {
          candidates.push({ start, end, kind: "gap" });
        }
      }
    }
    const last = classes[classes.length - 1];
    const afterStart = last.end;
    candidates.push({
      start: afterStart,
      end: new Date(afterStart.getTime() + TEST_MINUTES * MS_PER_MIN),
      kind: "after_class",
    });
  }

  candidates.sort((a, b) => a.start.getTime() - b.start.getTime());

  const slots: RecommendedTestSlot[] = [];
  for (const candidate of candidates) {
    if (slots.length >= RECOMMEND_MAX_SLOTS) break;
    const room = findFreeRoom(candidate.start, candidate.end, rooms, occupancyByRoom);
    if (!room) continue;
    slots.push({
      start: candidate.start.toISOString(),
      end: candidate.end.toISOString(),
      room,
      kind: candidate.kind,
      label: slotLabel(candidate.start, candidate.end, room),
    });
  }
  return slots;
}
